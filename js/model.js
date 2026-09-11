/* ============================================================
 * model.js — 混合评分推荐模型 + 滚动回测
 * 全局命名空间：window.LM
 * 依赖：LC / LS
 *
 * 模型结构
 *   单号因子（4 个）：
 *     freq        长期频率偏离（贝叶斯收缩后的 z 值）
 *     omission    遗漏回归（按历史遗漏分桶的经验出现率提升）
 *     hot         近期热度（指数加权移动平均的 z 值）
 *     transition  马尔可夫转移（以上期为条件的共现提升）
 *   组合层：结构典型度评分（完全由历史分布定义）
 *   权重：由滚动回测中各因子的 Top-K 命中表现自适应学习
 * ============================================================ */
(function (root) {
  'use strict';
  var LC = root.LC;

  var OMIT_BUCKETS = [
    { label: '0 期', lo: 0, hi: 0 },
    { label: '1-2 期', lo: 1, hi: 2 },
    { label: '3-5 期', lo: 3, hi: 5 },
    { label: '6-10 期', lo: 6, hi: 10 },
    { label: '11-20 期', lo: 11, hi: 20 },
    { label: '21-40 期', lo: 21, hi: 40 },
    { label: '41 期以上', lo: 41, hi: Infinity }
  ];

  function zscore(arr) {
    var m = LC.mean(arr), s = LC.stdev(arr);
    if (s < 1e-9) return arr.map(function () { return 0; });
    return arr.map(function (x) { return (x - m) / s; });
  }

  /* 取末尾 n 条（n 为 0 或超过长度时返回全部） */
  function lastN(arr, n) {
    if (!n || n >= arr.length) return arr;
    return arr.slice(arr.length - n);
  }

  function relu(x) { return x > 0 ? x : 0; }

  /* ============================================================
   * 增量统计状态：一次遍历同时维护频率 / 遗漏 / EWMA / 转移矩阵
   * ========================================================== */
  function createState(c, halflife) {
    var pool = c.mainMax - c.mainMin + 1;
    var spool = c.specialMax - c.specialMin + 1;
    return {
      c: c, pool: pool, spool: spool,
      min: c.mainMin, smin: c.specialMin, pick: c.mainCount, spick: c.specialCount,
      n: 0,
      decay: Math.exp(-Math.log(2) / Math.max(halflife || 30, 1)),
      counts: new Array(pool).fill(0),
      lastSeen: new Array(pool).fill(-1),
      ewma: new Array(pool).fill(0),
      ewmaSum: 0,
      trans: (function () {
        var t = [];
        for (var i = 0; i < pool; i++) t.push(new Array(pool).fill(0));
        return t;
      })(),
      rowTotal: new Array(pool).fill(0),
      // 特别号
      sCounts: new Array(spool).fill(0),
      sLastSeen: new Array(spool).fill(-1),
      sEwma: new Array(spool).fill(0),
      sEwmaSum: 0,
      sTrans: (function () {
        var t = [];
        for (var i = 0; i < spool; i++) t.push(new Array(spool).fill(0));
        return t;
      })(),
      sRowTotal: new Array(spool).fill(0),
      prevMain: null,
      prevSpecial: null
    };
  }

  function update(state, draw) {
    var min = state.min, smin = state.smin, pool = state.pool, spool = state.spool;
    var decay = state.decay, i, j;

    for (i = 0; i < pool; i++) state.ewma[i] *= decay;
    state.ewmaSum *= decay;
    for (i = 0; i < spool; i++) state.sEwma[i] *= decay;
    state.sEwmaSum *= decay;

    var r = draw.r, b = draw.b;
    for (i = 0; i < r.length; i++) {
      var idx = r[i] - min;
      state.counts[idx]++;
      state.lastSeen[idx] = state.n;
      state.ewma[idx] += 1;
    }
    state.ewmaSum += r.length;

    for (i = 0; i < b.length; i++) {
      var sidx = b[i] - smin;
      state.sCounts[sidx]++;
      state.sLastSeen[sidx] = state.n;
      state.sEwma[sidx] += 1;
    }
    state.sEwmaSum += b.length;

    if (state.prevMain) {
      for (i = 0; i < state.prevMain.length; i++) {
        var a = state.prevMain[i] - min;
        state.rowTotal[a]++;
        for (j = 0; j < r.length; j++) state.trans[a][r[j] - min]++;
      }
    }
    if (state.prevSpecial) {
      for (i = 0; i < state.prevSpecial.length; i++) {
        var sa = state.prevSpecial[i] - smin;
        state.sRowTotal[sa]++;
        for (j = 0; j < b.length; j++) state.sTrans[sa][b[j] - smin]++;
      }
    }

    state.prevMain = r;
    state.prevSpecial = b;
    state.n++;
  }

  function buildState(c, draws, upto, halflife) {
    var st = createState(c, halflife);
    for (var i = 0; i < upto; i++) update(st, draws[i]);
    return st;
  }

  /* ============================================================
   * 遗漏分桶经验提升表（历史上"遗漏 N 期后"的实际出现率）
   * ========================================================== */
  function buildOmissionLift(draws, c, endIndex, isSpecial) {
    var min = isSpecial ? c.specialMin : c.mainMin;
    var max = isSpecial ? c.specialMax : c.mainMax;
    var pick = isSpecial ? c.specialCount : c.mainCount;
    var pool = max - min + 1;
    var lastSeen = new Array(pool).fill(-1);
    var buckets = OMIT_BUCKETS.map(function (b) {
      return { label: b.label, lo: b.lo, hi: b.hi, hit: 0, total: 0 };
    });

    for (var t = 0; t < endIndex; t++) {
      var arr = isSpecial ? draws[t].b : draws[t].r;
      var hitSet = {};
      for (var k = 0; k < arr.length; k++) hitSet[arr[k]] = 1;
      for (var n = min; n <= max; n++) {
        var idx = n - min;
        var om = lastSeen[idx] < 0 ? t : t - lastSeen[idx] - 1;
        for (var b2 = 0; b2 < buckets.length; b2++) {
          if (om >= buckets[b2].lo && om <= buckets[b2].hi) {
            buckets[b2].total++;
            if (hitSet[n]) buckets[b2].hit++;
            break;
          }
        }
      }
      for (var k2 = 0; k2 < arr.length; k2++) lastSeen[arr[k2] - min] = t;
    }

    var baseP = pick / pool;
    var table = {};
    buckets.forEach(function (b) {
      b.rate = b.total ? b.hit / b.total : baseP;
      b.lift = baseP ? b.rate / baseP : 1;
      b.baseP = baseP;
      if (b.total >= 30) table[b.lo] = b;
    });
    return { list: buckets.filter(function (b) { return b.total >= 30; }), baseP: baseP };
  }

  function omitLiftFor(liftTable, omission) {
    if (!liftTable) return 0;
    var list = liftTable.list;
    for (var i = 0; i < list.length; i++) {
      if (omission >= list[i].lo && omission <= list[i].hi) return list[i].lift - 1;
    }
    return 0;
  }

  /* ============================================================
   * 因子计算
   * 返回每个号码在各因子上的原始值
   * ========================================================== */
  function computeFactors(state, isSpecial, liftTable) {
    var c = state.c;
    var min = isSpecial ? state.smin : state.min;
    var pool = isSpecial ? state.spool : state.pool;
    var pick = isSpecial ? state.spick : state.pick;
    var counts = isSpecial ? state.sCounts : state.counts;
    var lastSeen = isSpecial ? state.sLastSeen : state.lastSeen;
    var ewma = isSpecial ? state.sEwma : state.ewma;
    var ewmaSum = isSpecial ? state.sEwmaSum : state.ewmaSum;
    var trans = isSpecial ? state.sTrans : state.trans;
    var rowTotal = isSpecial ? state.sRowTotal : state.rowTotal;
    var prev = isSpecial ? state.prevSpecial : state.prevMain;

    var n = state.n;
    var p = pick / pool;
    var i;

    // --- 频率因子 ---
    var expect = n * p;
    var sd = Math.sqrt(Math.max(expect * (1 - p), 1e-9));
    var freqRaw = [];
    for (i = 0; i < pool; i++) {
      var shrink = counts[i] / (counts[i] + 40);   // 贝叶斯收缩，抑制小样本噪声
      freqRaw.push(((counts[i] - expect) / sd) * shrink);
    }

    // --- 遗漏因子 ---
    var omitRaw = [];
    for (i = 0; i < pool; i++) {
      var om = lastSeen[i] < 0 ? n : n - 1 - lastSeen[i];
      omitRaw.push(omitLiftFor(liftTable, om));
    }

    // --- 热度因子 ---
    var eExpect = ewmaSum * p;
    var eSd = Math.sqrt(Math.max(ewmaSum * p * (1 - p), 1e-9));
    var hotRaw = [];
    for (i = 0; i < pool; i++) hotRaw.push((ewma[i] - eExpect) / eSd);

    // --- 转移因子 ---
    var transRaw = new Array(pool).fill(0);
    if (prev && prev.length) {
      var denom = 0;
      for (i = 0; i < prev.length; i++) denom += rowTotal[prev[i] - min];
      if (denom > 0) {
        for (var j = 0; j < pool; j++) {
          var acc = 0;
          for (i = 0; i < prev.length; i++) acc += trans[prev[i] - min][j];
          var condP = acc / denom;
          var base = n ? counts[j] / n : p;
          transRaw[j] = base > 0 ? Math.log(condP / base) : 0;
        }
      }
    }

    return {
      min: min, pool: pool,
      raw: { freq: freqRaw, omission: omitRaw, hot: hotRaw, transition: transRaw },
      z: {
        freq: zscore(freqRaw),
        omission: zscore(omitRaw),
        hot: zscore(hotRaw),
        transition: zscore(transRaw)
      }
    };
  }

  /* ============================================================
   * 结构典型度：完全由历史分布定义（经验概率）
   * ========================================================== */
  function buildStructureContext(draws, c) {
    var sums = draws.map(function (d) { return LC.sum(d.r); });
    var spans = draws.map(function (d) { return LC.span(d.r); });
    var odd = LC.tally(draws.map(function (d) { return LC.oddCount(d.r); }));
    var big = LC.tally(draws.map(function (d) { return LC.bigCount(d.r, c); }));
    var cons = LC.tally(draws.map(function (d) { return LC.consecutiveCount(d.r); }));
    var reps = [];
    for (var i = 1; i < draws.length; i++) reps.push(LC.repeatCount(draws[i].r, draws[i - 1].r));
    var repT = LC.tally(reps);
    var zone = {};
    draws.forEach(function (d) {
      var zd = LC.zoneDistribution(d.r, c, 3).join(':');
      zone[zd] = (zone[zd] || 0) + 1;
    });

    function toMap(list) {
      var m = {};
      list.forEach(function (x) { m[x.key] = x.ratio; });
      return m;
    }

    var maxSumRatio = Math.max.apply(null, LC.histogram(sums, 24).counts.map(function (x) { return x / sums.length; }));
    var maxSpanRatio = Math.max.apply(null, LC.histogram(spans, 12).counts.map(function (x) { return x / spans.length; }));
    var maxZone = Math.max.apply(null, Object.keys(zone).map(function (k) { return zone[k]; }));

    return {
      sumHist: LC.histogram(sums, 24), sumMax: maxSumRatio,
      spanHist: LC.histogram(spans, 12), spanMax: maxSpanRatio,
      oddMap: toMap(odd), oddMax: Math.max.apply(null, odd.map(function (x) { return x.ratio; })),
      bigMap: toMap(big), bigMax: Math.max.apply(null, big.map(function (x) { return x.ratio; })),
      consMap: toMap(cons), consMax: Math.max.apply(null, cons.map(function (x) { return x.ratio; })),
      repMap: toMap(repT), repMax: Math.max.apply(null, repT.map(function (x) { return x.ratio; })),
      zoneMap: zone, zoneMax: maxZone,
      sumMu: LC.mean(sums), sumSd: LC.stdev(sums),
      zoneCount: 3, c: c
    };
  }

  function histRatio(hist, v) {
    if (!hist.counts.length) return 0;
    var idx = Math.floor((v - hist.min) / hist.width);
    idx = Math.max(0, Math.min(hist.counts.length - 1, idx));
    var total = hist.counts.reduce(function (a, b) { return a + b; }, 0);
    return total ? hist.counts[idx] / total : 0;
  }

  // 返回 0~1 的结构典型度
  function scoreStructure(combo, ctx, prevMain) {
    var c = ctx.c;
    var sum = LC.sum(combo), sp = LC.span(combo);
    var odd = LC.oddCount(combo), big = LC.bigCount(combo, c);
    var cons = LC.consecutiveCount(combo);
    var rep = prevMain ? LC.repeatCount(combo, prevMain) : 0;
    var zoneKey = LC.zoneDistribution(combo, c, 3).join(':');

    var sSum = ctx.sumMax ? histRatio(ctx.sumHist, sum) / ctx.sumMax : 0;
    var sSpan = ctx.spanMax ? histRatio(ctx.spanHist, sp) / ctx.spanMax : 0;
    var sOdd = (ctx.oddMap[odd] || 0) / ctx.oddMax;
    var sBig = (ctx.bigMap[big] || 0) / ctx.bigMax;
    var sCons = (ctx.consMap[cons] || 0) / ctx.consMax;
    var sRep = (ctx.repMap[rep] || 0) / ctx.repMax;
    var sZone = (ctx.zoneMap[zoneKey] || 0) / ctx.zoneMax;

    var score = 0.20 * sSum + 0.12 * sSpan + 0.15 * sOdd + 0.15 * sBig
      + 0.08 * sCons + 0.07 * sRep + 0.23 * sZone;

    return {
      score: score,
      parts: {
        sum: sSum, span: sSpan, odd: sOdd, big: sBig,
        consecutive: sCons, repeat: sRep, zone: sZone
      },
      features: {
        sum: sum, span: sp, odd: odd, big: big,
        consecutive: cons, repeat: rep, zone: zoneKey
      }
    };
  }

  /* ============================================================
   * 加权无放回采样
   * ========================================================== */
  function weightedSample(weights, k, rnd) {
    var n = weights.length, j;
    var avail = weights.slice();
    var total = 0;
    for (j = 0; j < n; j++) total += avail[j];
    var picked = [];
    for (var i = 0; i < k; i++) {
      if (total <= 0) break;
      var r = rnd() * total, acc = 0, pick = -1;
      for (j = 0; j < n; j++) {
        acc += avail[j];
        if (acc >= r) { pick = j; break; }
      }
      if (pick < 0) { for (j = n - 1; j >= 0; j--) if (avail[j] > 0) { pick = j; break; } }
      picked.push(pick);
      total -= avail[pick];
      avail[pick] = 0;
    }
    return picked;
  }

  /* ============================================================
   * 权重学习：滚动回测中比较各因子 Top-K 命中表现
   * ========================================================== */
  function computeWeights(kind, opts) {
    opts = opts || {};
    var all = LC.draws(kind), c = LC.cfg(kind);
    var halflife = opts.halflife || 30;
    var periods = Math.min(opts.backtestPeriods || 300, Math.max(all.length - 200, 50));
    var start = Math.max(150, all.length - periods);
    var K = c.mainCount * 3;

    var st = buildState(c, all, start, halflife);
    var liftTable = null, liftAnchor = -999;

    var hits = { freq: 0, omission: 0, hot: 0, transition: 0, ensemble: 0 };
    var ensembleSeries = [];
    var trials = 0;
    var baselineHit = 0;

    var factorKeys = ['freq', 'omission', 'hot', 'transition'];
    var w = { freq: 0.25, omission: 0.25, hot: 0.25, transition: 0.25 };

    for (var t = start; t < all.length; t++) {
      if (t - liftAnchor >= 50) {
        liftTable = buildOmissionLift(all, c, t, false);
        liftAnchor = t;
      }
      var f = computeFactors(st, false, liftTable);
      var actual = all[t].r;
      var actualSet = {};
      actual.forEach(function (x) { actualSet[x] = 1; });

      var score = new Array(f.pool).fill(0);
      for (var k = 0; k < factorKeys.length; k++) {
        var key = factorKeys[k];
        var zk = f.z[key];
        for (var i = 0; i < f.pool; i++) score[i] += w[key] * zk[i];
      }

      // 各因子单独 Top-K
      for (var k2 = 0; k2 < factorKeys.length; k2++) {
        var key2 = factorKeys[k2];
        var arr = f.raw[key2].map(function (v, idx) { return { idx: idx, v: v }; })
          .sort(function (a, b) { return b.v - a.v; }).slice(0, K);
        var h = 0;
        arr.forEach(function (x) { if (actualSet[x.idx + f.min]) h++; });
        hits[key2] += h;
      }

      var top = score.map(function (v, idx) { return { idx: idx, v: v }; })
        .sort(function (a, b) { return b.v - a.v; }).slice(0, K);
      var he = 0;
      top.forEach(function (x) { if (actualSet[x.idx + f.min]) he++; });
      hits.ensemble += he;
      ensembleSeries.push(he);

      baselineHit += K * c.mainCount / f.pool;
      trials++;

      update(st, all[t]);
    }

    var avg = {};
    var excess = {};
    factorKeys.forEach(function (key) {
      avg[key] = trials ? hits[key] / trials : 0;
      excess[key] = avg[key] / K - c.mainCount / f.pool;
    });
    avg.ensemble = trials ? hits.ensemble / trials : 0;
    excess.ensemble = avg.ensemble / K - c.mainCount / f.pool;
    var baseHit = baselineHit / Math.max(trials, 1);

    // 自适应权重：只在因子确有超额表现时给予权重，并与等权先验做平滑
    var totalExcess = 0;
    factorKeys.forEach(function (key) { totalExcess += Math.max(excess[key], 0); });
    var learned = {}, prior = 1 / factorKeys.length;
    factorKeys.forEach(function (key) {
      var e = Math.max(excess[key], 0);
      learned[key] = totalExcess > 1e-6 ? e / totalExcess : prior;
      w[key] = 0.35 * prior + 0.65 * learned[key];
    });

    // 集成 Top-K 命中的 z 检验：单期命中数近似二项分布 B(K, pick/pool)
    var baseRate = c.mainCount / (c.mainMax - c.mainMin + 1);
    var expHit = K * baseRate;
    var sdHit = Math.sqrt(Math.max(trials * K * baseRate * (1 - baseRate), 1e-9));
    var z = (hits.ensemble - trials * expHit) / sdHit;

    return {
      trials: trials,
      K: K,
      baselineRate: baseRate,
      avgHits: avg,
      excess: excess,
      expectedHitRandom: expHit,
      expectedTotalRandom: baselineHit,
      z: z,
      p: LC.normalTwoTail(z),
      series: ensembleSeries,
      weights: w,
      learnedWeights: learned
    };
  }

  /* ============================================================
   * 投注方式：单式 / 复式 / 胆拖
   *
   * 规则（每注 2 元，金额 = 注数 × 2）：
   *   单式   主区 mainCount 个 + 特别区 specialCount 个
   *   复式   注数 = C(主区个数, mainCount) × C(特别区个数, specialCount)
   *           （双色球还细分红复 / 蓝复 / 全复，大乐透细分前区 / 后区 / 双区复式）
   *
   *   胆拖   胆码为每注必含的核心号，拖码用于补足剩余位置
   *           注数 = C(主区拖码个数, mainCount - 胆码个数)
   *                × C(特别区拖码个数, specialCount - 特别区胆码个数)
   *           官方要求"胆码 + 拖码 ≥ 基本号码数 + 1"，即拖码至少比单式多出 1 个号码。
   *
   *   特别区（蓝球 / 后区）能否胆拖，取决于该区每注取几个号码：
   *     - 每注只取 1 个（双色球蓝球）：胆码 1 个 + 拖码 n 个时，每注要从拖码里
   *       再补 specialCount - 1 = 0 个，组合数恒为 1，数学上退化成单式。
   *       官方规则也只写"蓝球号码可选 1 个或多个"，不设胆拖。
   *     - 每注取 2 个（大乐透后区）：官方明确支持，且细分三种胆拖形式——
   *         前区胆拖：前区 1~4 个胆码（胆+拖 ≥ 6 个），后区直接选满 2 个
   *         后区胆拖：前区直接选满 5 个，后区 1 个胆码 + 2 个及以上拖码
   *         双区胆拖：前区胆拖 + 后区胆拖
   * ========================================================== */

  // 可选范围：在官方规则上限内收一个便于操作的区间
  function betOptions(kind) {
    var c = LC.cfg(kind);
    var mainPool = c.mainMax - c.mainMin + 1;
    var specPool = c.specialMax - c.specialMin + 1;
    // 特别区每注多于 1 个号码时才存在官方认可的"特别区胆拖"
    var specDantuo = c.specialCount > 1;
    // 官方：胆码 + 拖码 ≥ 基本号码数 + 1，即拖码至少比单式多出 1 个号码
    var tuoExtraMin = 1;
    // 特别区胆码官方固定 1 个 → 后区拖码下限 = 2 + 1 - 1 = 2
    var specTuoMin = specDantuo ? Math.max(c.specialCount + tuoExtraMin - 1, 1) : 0;
    return {
      kind: kind,
      mainCount: c.mainCount,
      specialCount: c.specialCount,
      mainPool: mainPool,
      specPool: specPool,
      // 复式：主区至少多选 1 个，最多多选 4 个
      mainSelMin: c.mainCount + 1,
      mainSelMax: Math.min(c.mainCount + 4, mainPool),
      // 复式特别区：可保持单式（specialCount 个）或复选
      specialSelMin: c.specialCount,
      specialSelMax: Math.min(c.specialCount + 3, specPool),
      // 胆拖：胆码上限 = 基本号码数 - 1（双色球红胆≤5，大乐透前区胆≤4）
      danMin: 1,
      danMax: Math.max(c.mainCount - 1, 1),
      // 拖码下限的官方余量：胆码 + 拖码 ≥ 基本号码数 + tuoExtraMin
      tuoExtraMin: tuoExtraMin,
      // 特别区胆拖：官方固定 1 个胆码，拖码 2 个及以上（后区共 12 个号 → 拖码 ≤ 11）
      supportsSpecialDantuo: specDantuo,
      specDanMin: 1,
      specDanMax: 1,
      specTuoMin: specTuoMin,
      specTuoMax: specDantuo ? specPool - 1 : 0,
      yuanPerBet: 2
    };
  }

  // 胆拖形式的显示名：大乐透按官方叫法给"前区胆拖 / 后区胆拖 / 双区胆拖"
  function dtFormLabel(kind, form) {
    var c = LC.cfg(kind);
    if (!betOptions(kind).supportsSpecialDantuo) return '胆拖';
    if (form === 'special') return c.specialLabel + '胆拖';
    if (form === 'both') return '双区胆拖';
    return c.mainLabel + '胆拖';
  }

  function clampInt(v, lo, hi) {
    v = Number(v);
    if (v == null || isNaN(v)) return lo;
    return Math.min(Math.max(Math.round(v), lo), hi);
  }

  function takeTopN(poolScores, n) {
    return poolScores.slice(0, n).map(function (o) { return o.num; })
      .sort(function (a, b) { return a - b; });
  }

  function combosOf(arr, k) {
    var out = [];
    (function rec(start, cur) {
      if (cur.length === k) { out.push(cur.slice()); return; }
      for (var i = start; i < arr.length; i++) {
        cur.push(arr[i]); rec(i + 1, cur); cur.pop();
      }
    })(0, []);
    return out;
  }

  // 展开后组合的结构典型度均值（组合数过多时跳过，避免卡顿）
  function avgStructure(list, need, ctx, prevMain, prefix) {
    if (LC.comb(list.length, need) > 800) return null;
    var all = combosOf(list, need), s = 0;
    if (!all.length) return null;
    all.forEach(function (cmb) {
      var combo = prefix ? prefix.concat(cmb).sort(function (a, b) { return a - b; }) : cmb;
      s += scoreStructure(combo, ctx, prevMain).score;
    });
    return s / all.length;
  }

  function buildBet(type, bo, options, c, poolMain, poolSpec, ctx, prevMain) {
    var k = c.mainCount, sk = c.specialCount;

    if (type === 'compound') {
      var cMainSel = clampInt(options.mainSel, bo.mainSelMin, bo.mainSelMax);
      var cSpecSel = clampInt(options.specialSel, bo.specialSelMin, bo.specialSelMax);
      var cMain = takeTopN(poolMain, cMainSel);
      var cSpec = takeTopN(poolSpec, cSpecSel);
      var cCombos = LC.comb(cMainSel, k) * LC.comb(cSpecSel, sk);
      return {
        type: 'compound', label: '复式', dtForm: null,
        main: cMain, dan: null, tuo: null, special: cSpec,
        sDan: null, sTuo: null,
        mainSel: cMainSel, specialSel: cSpecSel,
        danCount: 0, tuoCount: 0, sDanCount: 0, sTuoCount: 0,
        combos: cCombos, cost: cCombos * bo.yuanPerBet, yuanPerBet: bo.yuanPerBet,
        structureAvg: avgStructure(cMain, k, ctx, prevMain),
        formula: 'C(' + cMainSel + ',' + k + ') × C(' + cSpecSel + ',' + sk + ')'
      };
    }

    // ---- 胆拖：主区胆拖 / 特别区胆拖 / 双区胆拖 ----
    var form = (bo.supportsSpecialDantuo && (options.dtForm === 'special' || options.dtForm === 'both'))
      ? options.dtForm : 'main';

    // 特别区部分
    var special, specialSel = 0, sDan = null, sTuo = null, sDanCount = 0, sTuoCount = 0;
    var specCombos;
    if (form === 'main') {
      specialSel = clampInt(options.specialSel, bo.specialSelMin, bo.specialSelMax);
      special = takeTopN(poolSpec, specialSel);
      specCombos = LC.comb(specialSel, sk);
    } else {
      // 特别区胆拖：胆码固定 1 个，拖码在胆码之外按评分顺序取
      sDanCount = clampInt(options.sDanCount, bo.specDanMin, bo.specDanMax);
      var sTuoMax = Math.max(bo.specTuoMin, Math.min(bo.specTuoMax, bo.specPool - sDanCount));
      sTuoCount = clampInt(options.sTuoCount, bo.specTuoMin, sTuoMax);
      sDan = takeTopN(poolSpec, sDanCount);
      sTuo = poolSpec.slice(sDanCount, sDanCount + sTuoCount)
        .map(function (o) { return o.num; }).sort(function (a, b) { return a - b; });
      special = sDan.concat(sTuo).sort(function (a, b) { return a - b; });
      specialSel = sDanCount + sTuoCount;
      specCombos = LC.comb(sTuoCount, sk - sDanCount);
    }

    // 主区部分
    var dan = null, tuo = null, danCount = 0, tuoCount = 0, main, mainSel, mainCombos;
    if (form === 'special') {
      // 主区不设胆拖，直接选满
      mainSel = k;
      main = takeTopN(poolMain, k);
      mainCombos = 1;
    } else {
      danCount = clampInt(options.danCount, bo.danMin, bo.danMax);
      var tuoMin = Math.max(k + bo.tuoExtraMin - danCount, 1);
      var tuoMax = Math.max(tuoMin, Math.min(bo.mainSelMax - danCount, bo.mainPool - danCount));
      tuoCount = clampInt(options.tuoCount, tuoMin, tuoMax);
      dan = takeTopN(poolMain, danCount);
      tuo = poolMain.slice(danCount, danCount + tuoCount)
        .map(function (o) { return o.num; }).sort(function (a, b) { return a - b; });
      main = dan.concat(tuo).sort(function (a, b) { return a - b; });
      mainSel = danCount + tuoCount;
      mainCombos = LC.comb(tuoCount, k - danCount);
    }

    var combos = mainCombos * specCombos;
    var mFormula = 'C(' + tuoCount + ',' + (k - danCount) + ')';
    var sFormula = 'C(' + sTuoCount + ',' + (sk - sDanCount) + ')';

    return {
      type: 'dantuo', dtForm: form, label: dtFormLabel(bo.kind, form),
      main: main, dan: dan, tuo: tuo, special: special,
      sDan: sDan, sTuo: sTuo,
      danCount: danCount, tuoCount: tuoCount,
      sDanCount: sDanCount, sTuoCount: sTuoCount,
      mainSel: mainSel, specialSel: specialSel,
      combos: combos, cost: combos * bo.yuanPerBet, yuanPerBet: bo.yuanPerBet,
      structureAvg: form === 'special'
        ? avgStructure(main, k, ctx, prevMain)
        : avgStructure(tuo, k - danCount, ctx, prevMain, dan),
      formula: form === 'special' ? sFormula : mFormula + ' × ' + sFormula
    };
  }

  /* ============================================================
   * 生成推荐号码
   * ========================================================== */
  function recommend(kind, options) {
    options = options || {};
    var all = LC.draws(kind), c = LC.cfg(kind);
    var halflife = options.halflife || 30;
    var samples = options.samples || 20000;
    var ticketCount = options.tickets || options.ticketCount || 5;
    var temperature = options.temperature || 1.0;
    var windowSize = options.window || 0;
    var seed = options.seed || (Date.now() & 0x7fffffff);
    var rnd = LC.mulberry32(seed);

    var drawsForContext = lastN(all, windowSize);
    var st = buildState(c, all, all.length, halflife);
    var liftMain = buildOmissionLift(all, c, all.length, false);
    var liftSpec = buildOmissionLift(all, c, all.length, true);

    var weights = options.weights || { freq: 0.25, omission: 0.25, hot: 0.25, transition: 0.25 };
    var factorKeys = ['freq', 'omission', 'hot', 'transition'];

    var fMain = computeFactors(st, false, liftMain);
    var fSpec = computeFactors(st, true, liftSpec);

    function combine(f) {
      var score = new Array(f.pool).fill(0);
      factorKeys.forEach(function (key) {
        var zk = f.z[key];
        for (var i = 0; i < f.pool; i++) score[i] += (weights[key] || 0) * zk[i];
      });
      return score;
    }

    var scoreMain = combine(fMain);
    var scoreSpec = combine(fSpec);

    var poolScoresMain = scoreMain.map(function (v, idx) {
      var o = { num: idx + fMain.min, score: v, factors: {} };
      factorKeys.forEach(function (key) { o.factors[key] = fMain.z[key][idx]; });
      return o;
    }).sort(function (a, b) { return b.score - a.score; });
    poolScoresMain.forEach(function (o, i) { o.rank = i + 1; });

    var poolScoresSpec = scoreSpec.map(function (v, idx) {
      var o = { num: idx + fSpec.min, score: v, factors: {} };
      factorKeys.forEach(function (key) { o.factors[key] = fSpec.z[key][idx]; });
      return o;
    }).sort(function (a, b) { return b.score - a.score; });
    poolScoresSpec.forEach(function (o, i) { o.rank = i + 1; });

    // 采样权重：softmax（保证任何号码都有非零概率，避免"排除法"的伪确定性）
    function samplingWeights(score) {
      var w = score.map(function (v) { return Math.exp(v * temperature); });
      var s = 0; w.forEach(function (x) { s += x; });
      return s > 0 ? w.map(function (x) { return x / s; }) : w.map(function () { return 1 / w.length; });
    }

    var ctx = buildStructureContext(drawsForContext, c);
    var prevMain = drawsForContext[drawsForContext.length - 1].r;
    var betType = options.betType || 'single';

    var base = {
      kind: kind, config: c,
      windowSize: drawsForContext.length,
      latest: all[all.length - 1],
      prevMain: prevMain,
      weights: weights,
      betType: betType,
      poolScores: poolScoresMain,
      specialScores: poolScoresSpec,
      liftMain: liftMain,
      liftSpec: liftSpec,
      structureContext: {
        sumMu: ctx.sumMu, sumSd: ctx.sumSd,
        sumRange: [ctx.sumHist.edges[Math.floor(ctx.sumHist.edges.length * 0.1)],
          ctx.sumHist.edges[Math.floor(ctx.sumHist.edges.length * 0.9)]]
      },
      seed: seed,
      samples: samples,
      tickets: [],
      candidateCount: 0
    };

    // 复式 / 胆拖：按号码综合评分取前 N 名，结果为确定性输出
    if (betType === 'compound' || betType === 'dantuo') {
      base.bet = buildBet(betType, betOptions(kind), options, c,
        poolScoresMain, poolScoresSpec, ctx, prevMain);
      return base;
    }

    var wMain = samplingWeights(scoreMain);
    var wSpec = samplingWeights(scoreSpec);

    var candidates = [];
    var maxZ = Math.max.apply(null, scoreMain);
    var minZ = Math.min.apply(null, scoreMain);
    var rangeZ = Math.max(maxZ - minZ, 1e-9);

    for (var s = 0; s < samples; s++) {
      var idxs = weightedSample(wMain, c.mainCount, rnd);
      if (idxs.length < c.mainCount) continue;
      var combo = idxs.map(function (i) { return i + fMain.min; })
        .sort(function (a, b) { return a - b; });
      var stc = scoreStructure(combo, ctx, prevMain);
      var factorScore = 0;
      idxs.forEach(function (i) { factorScore += (scoreMain[i] - minZ) / rangeZ; });
      factorScore /= c.mainCount;
      var total = 0.55 * factorScore + 0.45 * stc.score;
      candidates.push({
        main: combo, structureScore: stc.score, structure: stc.parts,
        features: stc.features, factorScore: factorScore, total: total
      });
    }

    candidates.sort(function (a, b) { return b.total - a.total; });

    // 多样性筛选：组合间重叠不超过 60%
    var picked = [];
    var maxOverlap = Math.round(c.mainCount * 0.6);
    for (var ci = 0; ci < candidates.length && picked.length < ticketCount * 6; ci++) {
      var cand = candidates[ci];
      var ok = true;
      for (var pi = 0; pi < picked.length; pi++) {
        var ov = 0;
        for (var a = 0; a < cand.main.length; a++)
          if (picked[pi].main.indexOf(cand.main[a]) >= 0) ov++;
        if (ov > maxOverlap) { ok = false; break; }
      }
      if (ok) picked.push(cand);
    }
    picked = picked.slice(0, ticketCount);

    // 特别号：按得分顺序轮转分配，保证高分号码被覆盖
    var specOrder = poolScoresSpec.map(function (o) { return o.num; });
    picked.forEach(function (t, i) {
      var spec = [];
      for (var k = 0; k < c.specialCount; k++) {
        spec.push(specOrder[(i * c.specialCount + k) % specOrder.length]);
      }
      t.special = spec.sort(function (a, b) { return a - b; });
      t.mainDetail = t.main.map(function (n) {
        var o = poolScoresMain.filter(function (x) { return x.num === n; })[0];
        return { num: n, score: o.score, rank: o.rank, factors: o.factors };
      });
      t.specialDetail = t.special.map(function (n) {
        var o = poolScoresSpec.filter(function (x) { return x.num === n; })[0];
        return { num: n, score: o.score, rank: o.rank, factors: o.factors };
      });
    });

    base.tickets = picked;
    base.candidateCount = candidates.length;
    base.bet = {
      type: 'single', label: '单式',
      combos: picked.length, cost: picked.length * 2, yuanPerBet: 2
    };
    return base;
  }

  /* ============================================================
   * 组合概率参考（用于让用户理解"概率有多小"）
   * ========================================================== */
  function combinationOdds(kind) {
    var c = LC.cfg(kind);
    var main = LC.comb(c.mainMax - c.mainMin + 1, c.mainCount);
    var spec = LC.comb(c.specialMax - c.specialMin + 1, c.specialCount);
    var total = main * spec;
    return {
      mainCombos: main, specialCombos: spec, totalCombos: total,
      mainOdds: '1 / ' + main.toLocaleString(),
      totalOdds: '1 / ' + total.toLocaleString(),
      totalOddsNumber: total
    };
  }

  root.LM = {
    createState: createState,
    update: update,
    buildState: buildState,
    buildOmissionLift: buildOmissionLift,
    computeFactors: computeFactors,
    buildStructureContext: buildStructureContext,
    scoreStructure: scoreStructure,
    computeWeights: computeWeights,
    recommend: recommend,
    betOptions: betOptions,
    dtFormLabel: dtFormLabel,
    combinationOdds: combinationOdds,
    OMIT_BUCKETS: OMIT_BUCKETS
  };
})(window);
