/* ============================================================
 * model.js — 混合评分模型 + 滚动回测
 * 全局命名空间：window.LM
 * 依赖：LC
 *
 * 说明（2026）：出号已统一走「避拥挤」引擎（js/crowd.js），
 * 本模块不再负责生号，只保留两块仍被界面使用的能力：
 *   1. computeWeights   —— 滚动回测（「回测验证」面板）
 *   2. betOptions / dtFormLabel / combinationOdds —— 投注方式参数与概率参考
 *
 * 模型结构（供回测参考）
 *   单号因子（4 个）：
 *     freq        长期频率偏离（贝叶斯收缩后的 z 值）
 *     omission    遗漏回归（按历史遗漏分桶的经验出现率提升）
 *     hot         近期热度（指数加权移动平均的 z 值）
 *     transition  马尔可夫转移（以上期为条件的共现提升）
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

  var zscore = LC.zscore;                  // 通用实现见 lotto-core.js

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
    var f = null;

    for (var t = start; t < all.length; t++) {
      if (t - liftAnchor >= 50) {
        liftTable = buildOmissionLift(all, c, t, false);
        liftAnchor = t;
      }
      f = computeFactors(st, false, liftTable);
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
    computeWeights: computeWeights,
    betOptions: betOptions,
    dtFormLabel: dtFormLabel,
    combinationOdds: combinationOdds,
    OMIT_BUCKETS: OMIT_BUCKETS
  };
})(window);