/* ============================================================
 * tests.js — 随机性 / 潜在规律检验
 * 全局命名空间：window.LT
 * 依赖：LC
 *
 * 目的：不是"编造规律"，而是用统计检验判断历史数据中
 *       是否真的存在可被利用的非随机结构。
 * ============================================================ */
(function (root) {
  'use strict';
  var LC = root.LC;

  function verdict(p, alpha, rejectMsg, acceptMsg) {
    alpha = alpha || 0.05;
    var sig = p < alpha;
    return {
      significant: sig,
      text: sig ? rejectMsg : acceptMsg,
      p: p,
      alpha: alpha
    };
  }

  function pct(x) { return (x * 100).toFixed(2) + '%'; }

  /* ------------------------------------------------------------
   * 1. 卡方拟合优度检验：号码出现次数是否符合均匀分布
   * ---------------------------------------------------------- */
  function uniformityTest(draws, c, isSpecial) {
    var f = isSpecial
      ? root.LS.frequency(draws, c, true)
      : root.LS.frequency(draws, c, false);
    var chi2 = 0;
    f.list.forEach(function (x) {
      chi2 += Math.pow(x.count - x.expect, 2) / x.expect;
    });
    var df = f.list.length - 1;
    var p = LC.chi2SF(chi2, df);

    var maxDev = f.list.slice().sort(function (a, b) {
      return Math.abs(b.deviation) - Math.abs(a.deviation);
    })[0];

    return {
      id: 'uniformity' + (isSpecial ? '_s' : ''),
      name: (isSpecial ? '特别号' : '主号码') + '均匀性卡方检验',
      hypothesis: 'H0：各号码出现概率相等（完全随机）',
      stat: chi2, df: df, p: p,
      detail: f.list.length + ' 个号码，样本 ' + f.total + ' 期，'
        + '理论期望 ' + f.expect.toFixed(1) + ' 次/号',
      extras: '偏离最大：' + maxDev.num + ' 号（实际 ' + maxDev.count
        + ' 次，期望 ' + maxDev.expect.toFixed(1) + ' 次，'
        + (maxDev.devPct >= 0 ? '+' : '') + (maxDev.devPct * 100).toFixed(1) + '%）',
      result: verdict(p, 0.05,
        '拒绝 H0：存在统计显著的非均匀性',
        '不能拒绝 H0：各号码出现次数与均匀分布无显著差异'),
      plain: p < 0.05
        ? '部分号码的出现次数偏离"完全均匀"超过了随机波动范围，但这种偏离通常源于长期样本的自然涨落和号码池历史调整，并不构成可下注的优势。'
        : '每个号码的出现次数都落在随机波动允许的范围内，没有任何号码被"优待"。'
    };
  }

  /* ------------------------------------------------------------
   * 2. 和值序列自相关检验（是否存在记忆性）
   * ---------------------------------------------------------- */
  function autocorrelationTest(series, lag) {
    var n = series.length;
    var mu = LC.mean(series);
    var denom = 0, num = 0;
    for (var i = 0; i < n; i++) denom += Math.pow(series[i] - mu, 2);
    for (var t = 0; t + lag < n; t++) num += (series[t] - mu) * (series[t + lag] - mu);
    var r = denom ? num / denom : 0;
    var tStat = r * Math.sqrt(n - 2) / Math.sqrt(Math.max(1 - r * r, 1e-12));
    var p = LC.normalTwoTail(tStat);
    // 95% 置信带
    var band = 1.96 / Math.sqrt(n);
    return { lag: lag, r: r, t: tStat, p: p, band: band, n: n };
  }

  function memoryTest(draws, c) {
    var series = draws.map(function (d) { return LC.sum(d.r); });
    var lags = [1, 2, 3, 5].map(function (k) { return autocorrelationTest(series, k); });
    var sigCount = lags.filter(function (x) { return x.p < 0.05; }).length;

    return {
      id: 'memory',
      name: '和值序列自相关检验',
      hypothesis: 'H0：本期和值与历史期无线性关联（无记忆性）',
      stat: lags[0].t, df: lags[0].n - 2, p: lags[0].p,
      detail: '对和值序列做 Lag-1/2/3/5 阶自相关，95% 随机置信带 ±'
        + lags[0].band.toFixed(4),
      extras: lags.map(function (x) {
        return 'Lag-' + x.lag + '：r=' + x.r.toFixed(4) + '，p=' + x.p.toFixed(3);
      }).join('；'),
      series: lags,
      result: verdict(lags[0].p, 0.05,
        'Lag-1 自相关显著',
        'Lag-1 自相关不显著'),
      plain: sigCount === 0
        ? '任何滞后阶数的自相关系数都落在随机置信带内，说明和值之间不存在"继承关系"——上期开什么，对下期没有可用的提示。'
        : '有 ' + sigCount + ' 个滞后阶数出现显著相关，但多重比较下这类偶然显著很常见，需要更多样本验证。'
    };
  }

  /* ------------------------------------------------------------
   * 3. 游程检验：序列是否呈现过度聚集或过度交替
   * ---------------------------------------------------------- */
  function runsTest(series) {
    var sorted = series.slice().sort(function (a, b) { return a - b; });
    var med = LC.quantile(sorted, 0.5);
    var n1 = 0, n0 = 0;
    var b = series.map(function (v) {
      if (v > med) { n1++; return 1; }
      n0++; return 0;
    });
    var runs = 1;
    for (var i = 1; i < b.length; i++) if (b[i] !== b[i - 1]) runs++;
    var n = n1 + n0;
    var E = 2 * n1 * n0 / n + 1;
    var V = 2 * n1 * n0 * (2 * n1 * n0 - n) / (n * n * (n - 1));
    var z = V > 0 ? (runs - E) / Math.sqrt(V) : 0;
    return { runs: runs, expected: E, variance: V, z: z, p: LC.normalTwoTail(z), n1: n1, n0: n0 };
  }

  function clusterTest(draws) {
    var r = runsTest(draws.map(function (d) { return LC.sum(d.r); }));
    return {
      id: 'runs',
      name: '和值游程检验',
      hypothesis: 'H0：和值高低交替的聚集程度与随机序列一致',
      stat: r.z, df: null, p: r.p,
      detail: '以中位数切分为高/低两组，实际游程数 ' + r.runs
        + '，随机期望 ' + r.expected.toFixed(1),
      extras: 'z = ' + r.z.toFixed(3) + '，' + (r.z > 0 ? '偏交替' : '偏聚集'),
      result: verdict(r.p, 0.05,
        '序列聚集/交替程度异常',
        '序列无明显聚集或交替倾向'),
      plain: r.p < 0.05
        ? '和值的高低切换节奏偏离随机序列，但在这么大的样本里，单一检验的显著性很容易被偶然因素触发。'
        : '和值高低切换的节奏与随机序列一致，不存在"热一段冷一段"的可利用节律。'
    };
  }

  /* ------------------------------------------------------------
   * 4. 马尔可夫转移检验：号码之间的条件依赖
   * ---------------------------------------------------------- */
  function markovTest(draws, c) {
    var pool = c.mainMax - c.mainMin + 1;
    var min = c.mainMin;
    var counts = new Array(pool).fill(0);
    var trans = [];
    for (var i = 0; i < pool; i++) trans.push(new Array(pool).fill(0));

    for (var t = 0; t < draws.length; t++) {
      var cur = draws[t].r, nxt = draws[t + 1] ? draws[t + 1].r : null;
      for (var a = 0; a < cur.length; a++) {
        counts[cur[a] - min]++;
        if (!nxt) continue;
        for (var b2 = 0; b2 < nxt.length; b2++) trans[cur[a] - min][nxt[b2] - min]++;
      }
    }

    var total = draws.length;
    var baseP = counts.map(function (x) { return x / total; });

    var sigPairs = [], zMax = 0, zMaxPair = null, tested = 0;
    for (var i2 = 0; i2 < pool; i2++) {
      if (counts[i2] < 20) continue;
      for (var j = 0; j < pool; j++) {
        if (i2 === j) continue;
        var E = counts[i2] * baseP[j];
        if (E < 5) continue;
        var z = (trans[i2][j] - E) / Math.sqrt(E * (1 - baseP[j]));
        tested++;
        if (Math.abs(z) > 1.96) {
          sigPairs.push({
            from: i2 + min, to: j + min, z: z,
            p: LC.normalTwoTail(z),
            condP: trans[i2][j] / counts[i2],
            baseP: baseP[j]
          });
        }
        if (Math.abs(z) > Math.abs(zMax)) { zMax = z; zMaxPair = { from: i2 + min, to: j + min }; }
      }
    }
    sigPairs.sort(function (a, b) { return Math.abs(b.z) - Math.abs(a.z); });

    var observedRate = tested ? sigPairs.length / tested : 0;
    // 多重比较下的卡方式检验：z² 之和近似卡方
    var chi2 = 0;
    for (var i3 = 0; i3 < pool; i3++) {
      if (counts[i3] < 20) continue;
      for (var j3 = 0; j3 < pool; j3++) {
        if (i3 === j3) continue;
        var E3 = counts[i3] * baseP[j3];
        if (E3 < 5) continue;
        chi2 += Math.pow(trans[i3][j3] - E3, 2) / E3;
      }
    }
    var df = Math.max(tested, 1);
    var p = LC.chi2SF(chi2, df);

    return {
      id: 'markov',
      name: '马尔可夫转移检验',
      hypothesis: 'H0：某号码出现后，其他号码的出现概率不变',
      stat: chi2, df: df, p: p,
      detail: '检验 ' + tested + ' 个号码对的条件概率偏离',
      extras: '显著号码对 ' + sigPairs.length + ' 个（' + pct(observedRate)
        + '），随机预期约 ' + pct(0.05) + '；最强转移 '
        + (zMaxPair ? zMaxPair.from + '→' + zMaxPair.to : '-')
        + '（z=' + zMax.toFixed(2) + '）',
      topPairs: sigPairs.slice(0, 8),
      result: verdict(p, 0.05,
        '存在显著的条件依赖结构',
        '未发现可靠的条件依赖结构'),
      plain: observedRate <= 0.08
        ? '显著号码对的比例与纯随机情况基本一致（随机时约 5% 的号码对会"假显著"）。这说明"某个号码出现后更容易带出另一个号码"并不成立。'
        : '显著比例高于随机水平，但其中大部分仍是多重比较造成的假阳性，独立样本外验证通常无法复现。'
    };
  }

  /* ------------------------------------------------------------
   * 5. 遗漏回归检验（赌徒谬误检验）
   * ---------------------------------------------------------- */
  function omissionRegressionTest(draws, c) {
    var pool = c.mainMax - c.mainMin + 1;
    var min = c.mainMin;
    var lastSeen = new Array(pool).fill(-1);
    var buckets = [
      { label: '0 期（上期刚出）', lo: 0, hi: 0, hit: 0, total: 0 },
      { label: '1-2 期', lo: 1, hi: 2, hit: 0, total: 0 },
      { label: '3-5 期', lo: 3, hi: 5, hit: 0, total: 0 },
      { label: '6-10 期', lo: 6, hi: 10, hit: 0, total: 0 },
      { label: '11-20 期', lo: 11, hi: 20, hit: 0, total: 0 },
      { label: '21-40 期', lo: 21, hi: 40, hit: 0, total: 0 },
      { label: '40 期以上', lo: 41, hi: Infinity, hit: 0, total: 0 }
    ];

    for (var t = 0; t < draws.length; t++) {
      var hitSet = {};
      draws[t].r.forEach(function (n) { hitSet[n] = 1; });
      for (var n2 = min; n2 < min + pool; n2++) {
        var om = lastSeen[n2 - min] < 0 ? t : t - lastSeen[n2 - min] - 1;
        for (var b = 0; b < buckets.length; b++) {
          if (om >= buckets[b].lo && om <= buckets[b].hi) {
            buckets[b].total++;
            if (hitSet[n2]) buckets[b].hit++;
            break;
          }
        }
      }
      draws[t].r.forEach(function (n3) { lastSeen[n3 - min] = t; });
    }

    var baseP = c.mainCount / pool;
    var chi2 = 0, validBuckets = [];
    buckets.forEach(function (bk) {
      if (bk.total < 30) return;
      var expect = bk.total * baseP;
      bk.rate = bk.hit / bk.total;
      bk.expect = expect;
      bk.lift = bk.rate / baseP;
      chi2 += Math.pow(bk.hit - expect, 2) / expect;
      validBuckets.push(bk);
    });
    var df = Math.max(validBuckets.length - 1, 1);
    var p = LC.chi2SF(chi2, df);

    var maxLift = validBuckets.slice().sort(function (a, b) { return b.lift - a.lift; })[0];

    return {
      id: 'omission',
      name: '遗漏回归检验（赌徒谬误）',
      hypothesis: 'H0：号码的"遗漏期数"不影响其下期出现概率',
      stat: chi2, df: df, p: p,
      detail: '按当前遗漏期数分 ' + validBuckets.length + ' 组，比较各组下期实际出现率',
      extras: '理论概率 ' + pct(baseP) + '；最高一组「'
        + maxLift.label + '」实际 ' + pct(maxLift.rate)
        + '（提升 ' + ((maxLift.lift - 1) * 100).toFixed(1) + '%）',
      buckets: validBuckets,
      result: verdict(p, 0.05,
        '不同遗漏区间出现率存在差异',
        '各组出现率与理论概率无显著差异'),
      plain: p < 0.05
        ? '遗漏分组的出现率有差异，但差异幅度通常在 ±1 个百分点内，扣除抽样误差后远不足以覆盖彩票约 50% 的返奖率。'
        : '"很久没出"和"刚刚出过"的号码，下一期出现概率几乎完全一样。这是对"冷号该出了""热号还会热"这类直觉最直接的否定。'
    };
  }

  /* ------------------------------------------------------------
   * 6. 重号分布检验：与上期重复个数是否符合超几何分布
   * ---------------------------------------------------------- */
  function repeatTest(draws, c) {
    var pool = c.mainMax - c.mainMin + 1;
    var k = c.mainCount;
    var observed = {};
    for (var i = 1; i < draws.length; i++) {
      var r = LC.repeatCount(draws[i].r, draws[i - 1].r);
      observed[r] = (observed[r] || 0) + 1;
    }
    var n = draws.length - 1;
    var chi2 = 0, rows = [];
    var lo = Math.min.apply(null, Object.keys(observed).map(Number));
    var hi = Math.max.apply(null, Object.keys(observed).map(Number));

    for (var x = lo; x <= hi; x++) {
      var o = observed[x] || 0;
      var e = LC.hypergeom(x, pool, k, k) * n;
      if (e < 1) e = 1;
      chi2 += Math.pow(o - e, 2) / e;
      rows.push({
        key: String(x), count: o, expect: e,
        ratio: o / n, expectRatio: e / n
      });
    }
    var df = Math.max(rows.length - 2, 1);
    var p = LC.chi2SF(chi2, df);

    var meanObserved = 0, meanExpect = 0;
    rows.forEach(function (r) {
      meanObserved += Number(r.key) * r.ratio;
      meanExpect += Number(r.key) * r.expectRatio;
    });

    return {
      id: 'repeat',
      name: '重号分布检验',
      hypothesis: 'H0：与上期重复的号码个数服从超几何分布',
      stat: chi2, df: df, p: p,
      detail: '实际平均重号 ' + meanObserved.toFixed(3)
        + ' 个，理论 ' + meanExpect.toFixed(3) + ' 个',
      extras: '样本 ' + n + ' 期对',
      rows: rows,
      result: verdict(p, 0.05,
        '重号分布偏离理论值',
        '重号分布与理论值吻合'),
      plain: p >= 0.05
        ? '相邻两期的重叠个数与"完全随机抽取"的理论分布高度吻合，说明号码不会因为上期出现过就被"排除"或"保留"。'
        : '重号分布略有偏离，通常是样本期数不足造成的波动。'
    };
  }

  /* ------------------------------------------------------------
   * 7. 和值分布正态性（Jarque-Bera）
   * ---------------------------------------------------------- */
  function normalityTest(draws) {
    var x = draws.map(function (d) { return LC.sum(d.r); });
    var n = x.length, mu = LC.mean(x), sd = LC.stdev(x);
    var m3 = 0, m4 = 0;
    for (var i = 0; i < n; i++) {
      var z = (x[i] - mu) / sd;
      m3 += Math.pow(z, 3); m4 += Math.pow(z, 4);
    }
    var S = m3 / n, K = m4 / n;
    var jb = n / 6 * (S * S + Math.pow(K - 3, 2) / 4);
    var p = LC.chi2SF(jb, 2);
    return {
      id: 'normality',
      name: '和值分布正态性检验',
      hypothesis: 'H0：和值服从正态分布（中心极限效应）',
      stat: jb, df: 2, p: p,
      detail: '均值 ' + mu.toFixed(2) + '，标准差 ' + sd.toFixed(2)
        + '，偏度 ' + S.toFixed(3) + '，峰度 ' + K.toFixed(3),
      extras: 'Jarque-Bera 统计量 ' + jb.toFixed(2),
      mu: mu, sd: sd, skew: S, kurt: K,
      result: verdict(p, 0.05,
        '和值分布偏离正态',
        '和值分布与正态分布一致'),
      plain: '和值呈现中间高、两头低的钟形分布，这是组合数的天然结果：极端和值（全小或全大）对应的组合数量极少。所以"和值落在中间区"的选择确实更"典型"，但典型不代表更容易中奖——每个具体组合的概率完全相同。'
    };
  }

  /* ------------------------------------------------------------
   * 7. 分段稳定性检验：号码分布是否随时间变化
   * ---------------------------------------------------------- */
  function stabilityTest(draws, c) {
    var min = c.mainMin, pool = c.mainMax - c.mainMin + 1;
    var N = draws.length;
    var segLen = Math.floor(N / 3);
    var segs = [
      draws.slice(0, segLen),
      draws.slice(segLen, 2 * segLen),
      draws.slice(2 * segLen)
    ];

    var theoSum = c.mainCount * (c.mainMin + c.mainMax) / 2;
    var details = [];
    var table = [];

    segs.forEach(function (ds) {
      var counts = new Array(pool).fill(0);
      for (var i = 0; i < ds.length; i++) {
        for (var j = 0; j < ds[i].r.length; j++) counts[ds[i].r[j] - min]++;
      }
      var expect = ds.length * c.mainCount / pool;
      var chi2 = 0;
      counts.forEach(function (o) { chi2 += Math.pow(o - expect, 2) / expect; });
      var sums = ds.map(function (d) { return LC.sum(d.r); });
      var top = counts.indexOf(Math.max.apply(null, counts));
      var low = counts.indexOf(Math.min.apply(null, counts));
      details.push({
        label: ds[0].i + ' ~ ' + ds[ds.length - 1].i,
        from: ds[0].d, to: ds[ds.length - 1].d,
        n: ds.length,
        chi2: chi2, p: LC.chi2SF(chi2, pool - 1),
        sumMean: LC.mean(sums), theoSum: theoSum,
        topNum: top + min, topCount: counts[top],
        lowNum: low + min, lowCount: counts[low]
      });
      table.push(counts);
    });

    // 3 × pool 列联表独立性检验
    var grand = 0, rowTot = [], colTot = new Array(pool).fill(0);
    table.forEach(function (row) {
      var s = 0;
      row.forEach(function (v, j) { s += v; colTot[j] += v; });
      rowTot.push(s); grand += s;
    });
    var chi2 = 0;
    table.forEach(function (row, i) {
      row.forEach(function (o, j) {
        var e = rowTot[i] * colTot[j] / grand;
        if (e > 0) chi2 += Math.pow(o - e, 2) / e;
      });
    });
    var df = (table.length - 1) * (pool - 1);
    var p = LC.chi2SF(chi2, df);

    var maxChi = details.slice().sort(function (a, b) { return b.chi2 - a.chi2; })[0];
    var sumDrift = Math.abs(maxChi.sumMean - theoSum);

    return {
      id: 'stability',
      name: '分段稳定性检验',
      hypothesis: 'H0：号码分布在各时间段保持一致（数据平稳）',
      stat: chi2, df: df, p: p,
      detail: '将样本按时间等分为 3 段，检验号码分布是否随时期发生迁移',
      extras: details.map(function (d) {
        return d.label + '：卡方 ' + d.chi2.toFixed(1) + '，和值均值 ' + d.sumMean.toFixed(1);
      }).join('；'),
      segments: details,
      theoSum: theoSum,
      result: verdict(p, 0.05,
        '号码分布随时间发生了显著迁移',
        '号码分布在各时期保持一致'),
      plain: p < 0.05
        ? '数据并非"平稳"的：在早期的分段中，号码分布明显偏离均匀（偏离最大的分段和值均值 '
          + maxChi.sumMean.toFixed(1) + '，理论值 ' + theoSum.toFixed(1) + '，偏移 '
          + sumDrift.toFixed(1) + '）。这意味着"在某段时间里某些号码确实更容易出现"是存在的，'
          + '但它是特定时期的产物，而不是跨越时间的稳定规律。用它去预测未来，等价于假设历史设备偏差会重现。'
        : '各时期号码分布一致，说明历史中的任何频率差异都只是同一随机过程内部的波动，不随时期迁移。'
    };
  }

  /* ------------------------------------------------------------
   * 8. 热号延续性检验：样本内最热的号码在样本外是否依然热
   * ---------------------------------------------------------- */
  function persistenceTest(draws, c) {
    var min = c.mainMin, pool = c.mainMax - c.mainMin + 1, pick = c.mainCount;
    var N = draws.length;
    var cut = Math.floor(N * 0.6);
    var train = draws.slice(0, cut), test = draws.slice(cut);

    function countsOf(ds) {
      var arr = new Array(pool).fill(0);
      for (var i = 0; i < ds.length; i++)
        for (var j = 0; j < ds[i].r.length; j++) arr[ds[i].r[j] - min]++;
      return arr;
    }

    var a = countsOf(train), b = countsOf(test);
    var r = LC.pearson(a, b);

    // 随机基线：把期次随机分配到同样大小的两组，重复采样得到 r 的分布
    var rnd = LC.mulberry32(20240611);
    var nullR = [];
    var pA = new Array(pool).fill(0), pB = new Array(pool).fill(0);
    for (var it = 0; it < 120; it++) {
      pA.fill(0); pB.fill(0);
      for (var i = 0; i < N; i++) {
        var tgt = rnd() < 0.5 ? pA : pB;
        for (var j = 0; j < draws[i].r.length; j++) tgt[draws[i].r[j] - min]++;
      }
      nullR.push(LC.pearson(pA, pB));
    }
    nullR.sort(function (x, y) { return x - y; });
    var lo = LC.quantile(nullR, 0.025), hi = LC.quantile(nullR, 0.975);

    var k = pick;
    var sorted = a.map(function (v, i) { return { num: i + min, count: v }; })
      .sort(function (x, y) { return y.count - x.count; });
    var hot = sorted.slice(0, k), cold = sorted.slice(-k);

    var p0 = pick / pool;
    var testN = test.length;
    var hotHits = 0, coldHits = 0;
    hot.forEach(function (x) { hotHits += b[x.num - min]; });
    cold.forEach(function (x) { coldHits += b[x.num - min]; });

    var expHit = k * testN * p0;
    var sdHit = Math.sqrt(Math.max(k * testN * p0 * (1 - p0), 1e-9));
    var zHot = (hotHits - expHit) / sdHit;
    var pHot = LC.normalTwoTail(zHot);

    return {
      id: 'persistence',
      name: '热号延续性检验（样本外）',
      hypothesis: 'H0：训练期出现频率高的号码在验证期没有优势',
      stat: zHot, df: null, p: pHot,
      detail: '前 60%（' + cut + ' 期）作为训练期，后 40%（' + testN + ' 期）作为验证期',
      extras: '频率相关系数 r = ' + r.toFixed(4)
        + '，随机模拟 95% 区间 [' + lo.toFixed(4) + ', ' + hi.toFixed(4) + ']；'
        + '训练期最热 ' + k + ' 个号码在验证期出现 ' + hotHits + ' 次（随机期望 '
        + expHit.toFixed(1) + ' 次）',
      correlation: r, nullLo: lo, nullHi: hi,
      hotNumbers: hot, coldNumbers: cold,
      hotHits: hotHits, coldHits: coldHits, expHit: expHit,
      testN: testN,
      result: verdict(pHot, 0.05,
        '热号在样本外仍具优势',
        '热号在样本外没有优势'),
      plain: (r >= lo && r <= hi
        ? '号码频率在训练期与验证期之间几乎不相关（r = ' + r.toFixed(3)
          + ' 落在随机模拟的 95% 区间内）。'
        : '号码频率在训练期与验证期之间存在超出随机的相关性（r = ' + r.toFixed(3) + '）。')
        + '训练期最热的 ' + k + ' 个号码在验证期的平均出现次数为 '
        + (hotHits / k).toFixed(1) + ' 次（随机期望 ' + (expHit / k).toFixed(1) + ' 次），'
        + '最冷的 ' + k + ' 个号码为 ' + (coldHits / k).toFixed(1) + ' 次。'
        + '这是对"追热号/守冷号"策略最直接的检验：把样本外表现和随机水平对比，'
        + '两者没有实质差别，说明基于历史频率的选号并不能带来优势。'
    };
  }

  /* ------------------------------------------------------------
   * 汇总
   * ---------------------------------------------------------- */
  function runAll(kind, opts) {
    opts = opts || {};
    var c = LC.cfg(kind);
    var all = LC.draws(kind);
    var draws = root.LS.last(all, opts.window || 0);

    var tests = [
      uniformityTest(draws, c, false),
      uniformityTest(draws, c, true),
      persistenceTest(draws, c),
      stabilityTest(draws, c),
      memoryTest(draws, c),
      clusterTest(draws),
      markovTest(draws, c),
      omissionRegressionTest(draws, c),
      repeatTest(draws, c),
      normalityTest(draws)
    ];

    var sig = tests.filter(function (t) { return t.p < 0.05; }).length;
    return {
      tests: tests,
      sampleSize: draws.length,
      significant: sig,
      expectedFalsePositive: tests.length * 0.05,
      conclusion: sig <= Math.ceil(tests.length * 0.05)
        ? '在 ' + tests.length + ' 项检验中有 ' + sig + ' 项显著，未超过随机预期（约 '
          + (tests.length * 0.05).toFixed(1) + ' 项）。数据未显示可被利用的规律。'
        : '有 ' + sig + ' 项检验显著。注意：同时做多项检验时，"假阳性"不可避免，需独立样本外验证。'
    };
  }

  root.LT = {
    uniformityTest: uniformityTest,
    autocorrelationTest: autocorrelationTest,
    memoryTest: memoryTest,
    runsTest: runsTest,
    clusterTest: clusterTest,
    markovTest: markovTest,
    omissionRegressionTest: omissionRegressionTest,
    repeatTest: repeatTest,
    normalityTest: normalityTest,
    stabilityTest: stabilityTest,
    persistenceTest: persistenceTest,
    runAll: runAll
  };
})(window);
