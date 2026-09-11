/* ============================================================
 * stats.js — 统计分析引擎
 * 全局命名空间：window.LS
 * 依赖：LC
 * ============================================================ */
(function (root) {
  'use strict';
  var LC = root.LC;

  /* ---------- 基础筛选 ---------- */

  function last(draws, n) {
    if (!n || n >= draws.length) return draws;
    return draws.slice(draws.length - n);
  }

  /* ---------- 频率统计 ---------- */

  function frequency(draws, c, isSpecial) {
    var total = draws.length;
    var min = isSpecial ? c.specialMin : c.mainMin;
    var max = isSpecial ? c.specialMax : c.mainMax;
    var pick = isSpecial ? c.specialCount : c.mainCount;
    var pool = max - min + 1;
    var p = pick / pool;
    var expect = total * p;
    var counts = {};
    for (var n = min; n <= max; n++) counts[n] = 0;

    for (var i = 0; i < total; i++) {
      var arr = isSpecial ? draws[i].b : draws[i].r;
      for (var j = 0; j < arr.length; j++) counts[arr[j]]++;
    }

    var sd = Math.sqrt(Math.max(expect * (1 - p), 1e-9));
    var list = [];
    for (var k = min; k <= max; k++) {
      var c0 = counts[k];
      list.push({
        num: k, count: c0,
        ratio: total ? c0 / total : 0,
        expect: expect,
        deviation: c0 - expect,
        devPct: expect ? (c0 - expect) / expect : 0,
        z: (c0 - expect) / sd
      });
    }
    return { list: list, total: total, expect: expect, pool: pool, pick: pick };
  }

  /* ---------- 遗漏统计 ---------- */

  function omission(draws, c, isSpecial) {
    var total = draws.length;
    var min = isSpecial ? c.specialMin : c.mainMin;
    var max = isSpecial ? c.specialMax : c.mainMax;
    var pick = isSpecial ? c.specialCount : c.mainCount;
    var pool = max - min + 1;

    var pos = {};
    for (var n = min; n <= max; n++) pos[n] = [];

    for (var i = 0; i < total; i++) {
      var arr = isSpecial ? draws[i].b : draws[i].r;
      for (var j = 0; j < arr.length; j++) pos[arr[j]].push(i);
    }

    var list = [];
    for (var k = min; k <= max; k++) {
      var ps = pos[k];
      var cur = ps.length ? (total - 1 - ps[ps.length - 1]) : total;
      var maxGap = 0, sumGap = 0, gapCount = 0, curGap = 0;
      var prev = -1;
      for (var t = 0; t < ps.length; t++) {
        var gap = ps[t] - prev - 1;
        if (prev >= 0) { sumGap += gap; gapCount++; if (gap > maxGap) maxGap = gap; }
        prev = ps[t];
      }
      curGap = cur;
      if (curGap > maxGap) maxGap = curGap;
      list.push({
        num: k,
        current: cur,
        max: maxGap,
        avg: gapCount ? sumGap / gapCount : 0,
        theoAvg: pool / pick - 1,       // 几何分布理论平均遗漏
        count: ps.length
      });
    }
    return { list: list, total: total };
  }

  /* ---------- 指数加权近期热度 ---------- */

  function ewma(draws, c, isSpecial, halflife) {
    var total = draws.length;
    var min = isSpecial ? c.specialMin : c.mainMin;
    var max = isSpecial ? c.specialMax : c.mainMax;
    var score = {}, wsum = 0;
    for (var n = min; n <= max; n++) score[n] = 0;

    var lambda = Math.log(2) / Math.max(halflife, 1);
    for (var i = total - 1; i >= 0; i--) {
      var age = total - 1 - i;
      var w = Math.exp(-lambda * age);
      wsum += w;
      var arr = isSpecial ? draws[i].b : draws[i].r;
      for (var j = 0; j < arr.length; j++) score[arr[j]] += w;
    }

    var pick = isSpecial ? c.specialCount : c.mainCount;
    var pool = max - min + 1;
    var theo = wsum * pick / pool;
    var sd = Math.sqrt(Math.max(theo * (1 - pick / pool), 1e-9));

    var list = [];
    for (var k = min; k <= max; k++) {
      list.push({
        num: k, score: score[k],
        norm: theo ? score[k] / theo : 1,
        z: (score[k] - theo) / sd
      });
    }
    return { list: list, halflife: halflife };
  }

  /* ---------- 和值 / 跨度 ---------- */

  function valueStats(draws, c, fn) {
    var arr = draws.map(function (d) { return fn(d.r, c); });
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    return {
      series: arr, values: sorted,
      mean: LC.mean(arr), sd: LC.stdev(arr),
      min: sorted[0], max: sorted[sorted.length - 1],
      q10: LC.quantile(sorted, 0.10),
      q25: LC.quantile(sorted, 0.25),
      q50: LC.quantile(sorted, 0.50),
      q75: LC.quantile(sorted, 0.75),
      q90: LC.quantile(sorted, 0.90),
      hist: LC.histogram(arr, 18)
    };
  }

  /* ---------- 离散形态分布 ---------- */

  function shapeDistribution(draws, c, fn) {
    return LC.tally(draws.map(function (d) { return fn(d.r, d, c); }));
  }

  // 与上期重号个数分布（线性遍历，避免 indexOf 的 O(n²) 开销）
  function repeatDistribution(draws) {
    var vals = [];
    for (var i = 0; i < draws.length; i++) {
      vals.push(i > 0 ? LC.repeatCount(draws[i].r, draws[i - 1].r) : 0);
    }
    return LC.tally(vals);
  }

  function zoneDistribution(draws, c, zoneCount) {
    var counts = new Array(zoneCount).fill(0);
    var patterns = {};
    for (var i = 0; i < draws.length; i++) {
      var zd = LC.zoneDistribution(draws[i].r, c, zoneCount);
      for (var z = 0; z < zoneCount; z++) counts[z] += zd[z];
      var key = zd.join(':');
      patterns[key] = (patterns[key] || 0) + 1;
    }
    var patternList = Object.keys(patterns).map(function (k) {
      return { key: k, count: patterns[k], ratio: patterns[k] / draws.length };
    }).sort(function (a, b) { return b.count - a.count; });

    var totalBalls = draws.length * c.mainCount;
    return {
      zoneCount: zoneCount,
      zones: counts.map(function (n, idx) {
        var sz = (c.mainMax - c.mainMin + 1) / zoneCount;
        return {
          index: idx,
          label: Math.ceil(c.mainMin + sz * idx) + '-' + Math.floor(c.mainMin + sz * (idx + 1) - 1),
          count: n,
          ratio: totalBalls ? n / totalBalls : 0,
          expect: totalBalls / zoneCount
        };
      }),
      patterns: patternList.slice(0, 12)
    };
  }

  /* ---------- 尾数分布 ---------- */

  function tailDistribution(draws, c, isSpecial) {
    var counts = new Array(10).fill(0);
    var total = 0;
    for (var i = 0; i < draws.length; i++) {
      var arr = isSpecial ? draws[i].b : draws[i].r;
      for (var j = 0; j < arr.length; j++) { counts[arr[j] % 10]++; total++; }
    }
    return counts.map(function (n, idx) {
      return { num: idx, count: n, ratio: total ? n / total : 0, expect: total / 10 };
    });
  }

  /* ---------- 近期走势矩阵（热力图） ---------- */

  function trendMatrix(draws, c, isSpecial, lastN) {
    var d = last(draws, lastN);
    var min = isSpecial ? c.specialMin : c.mainMin;
    var max = isSpecial ? c.specialMax : c.mainMax;
    var rows = d.map(function (x) {
      var set = {};
      (isSpecial ? x.b : x.r).forEach(function (n) { set[n] = 1; });
      var row = [];
      for (var n = min; n <= max; n++) row.push(set[n] ? 1 : 0);
      return { issue: x.i, date: x.d, row: row };
    });
    return { min: min, max: max, rows: rows };
  }

  /* ---------- 汇总统计 ---------- */

  function computeAll(kind, opts) {
    opts = opts || {};
    var c = LC.cfg(kind);
    var all = LC.draws(kind);
    var windowSize = opts.window || 0;             // 0 = 全部
    var draws = last(all, windowSize);
    var halflife = opts.halflife || 30;

    var fMain = frequency(draws, c, false);
    var fSpec = frequency(draws, c, true);
    var oMain = omission(draws, c, false);
    var oSpec = omission(draws, c, true);
    var eMain = ewma(draws, c, false, halflife);
    var eSpec = ewma(draws, c, true, halflife);
    var sums = valueStats(draws, c, function (r) { return LC.sum(r); });
    var spans = valueStats(draws, c, function (r) { return LC.span(r); });
    var acs = valueStats(draws, c, function (r) { return LC.acValue(r); });

    var oddEven = shapeDistribution(draws, c, function (r) { return LC.oddCount(r); });
    var bigSmall = shapeDistribution(draws, c, function (r) { return LC.bigCount(r, c); });
    var consecutive = shapeDistribution(draws, c, function (r) { return LC.consecutiveCount(r); });
    var repeat = repeatDistribution(draws);

    var zones3 = zoneDistribution(draws, c, 3);
    var zones4 = zoneDistribution(draws, c, 4);

    return {
      config: c,
      windowSize: draws.length,
      totalAll: all.length,
      draws: draws,
      main: { freq: fMain, omission: oMain, ewma: eMain, tail: tailDistribution(draws, c, false) },
      special: { freq: fSpec, omission: oSpec, ewma: eSpec, tail: tailDistribution(draws, c, true) },
      sum: sums, span: spans, ac: acs,
      oddEven: oddEven, bigSmall: bigSmall,
      consecutive: consecutive, repeat: repeat,
      zones3: zones3, zones4: zones4,
      first: draws[0], latest: draws[draws.length - 1]
    };
  }

  root.LS = {
    last: last,
    frequency: frequency,
    omission: omission,
    ewma: ewma,
    valueStats: valueStats,
    shapeDistribution: shapeDistribution,
    zoneDistribution: zoneDistribution,
    tailDistribution: tailDistribution,
    trendMatrix: trendMatrix,
    computeAll: computeAll
  };
})(window);
