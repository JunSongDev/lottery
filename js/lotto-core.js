/* ============================================================
 * lotto-core.js — 数据访问与数学工具
 * 全局命名空间：window.LC
 * ============================================================ */
(function (root) {
  'use strict';

  /* ---------------- 数学基础 ---------------- */

  // 伽马函数对数（Lanczos 近似）
  function gammaln(x) {
    var cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    var y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    var ser = 1.000000000190015;
    for (var j = 0; j < 6; j++) ser += cof[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }

  // 正则化下不完全伽马函数 P(a, x)
  function gammaP(a, x) {
    if (x < 0 || a <= 0) return NaN;
    if (x === 0) return 0;
    var i, del;
    if (x < a + 1) {
      var ap = a, sum = 1 / a;
      del = sum;
      for (i = 1; i <= 300; i++) {
        ap++; del *= x / ap; sum += del;
        if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
      }
      return sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
    }
    var FPMIN = 1e-300;
    var b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
    for (i = 1; i <= 300; i++) {
      var an = -i * (i - a);
      b += 2;
      d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      del = d * c; h *= del;
      if (Math.abs(del - 1) < 1e-14) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
  }

  // 卡方分布上尾概率 P(X > x)
  function chi2SF(x, df) {
    if (x <= 0) return 1;
    return 1 - gammaP(df / 2, x / 2);
  }

  // 标准正态分布 CDF
  function normalCDF(z) {
    return 0.5 * (1 + erf(z / Math.SQRT2));
  }

  function erf(x) {
    var sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    var a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
      a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    var t = 1 / (1 + p * x);
    var y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }

  // 双尾正态 p 值
  function normalTwoTail(z) {
    return 2 * (1 - normalCDF(Math.abs(z)));
  }

  // 组合数（大数安全，返回对数再取指数会丢精度，这里用递推保证整数精度）
  function comb(n, k) {
    if (k < 0 || k > n) return 0;
    k = Math.min(k, n - k);
    var r = 1;
    for (var i = 1; i <= k; i++) r = r * (n - k + i) / i;
    return Math.round(r);
  }

  // 超几何分布概率：N 个球中 K 个中奖，抽 n 个命中 k 个
  function hypergeom(k, N, K, n) {
    return comb(K, k) * comb(N - K, n - k) / comb(N, n);
  }

  function mean(arr) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return arr.length ? s / arr.length : 0;
  }

  function stdev(arr) {
    if (arr.length < 2) return 0;
    var m = mean(arr), s = 0;
    for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(s / (arr.length - 1));
  }

  function pearson(a, b) {
    var n = Math.min(a.length, b.length);
    if (!n) return 0;
    var ma = 0, mb = 0, i;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var num = 0, da = 0, db = 0;
    for (i = 0; i < n; i++) {
      var x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return (da > 0 && db > 0) ? num / Math.sqrt(da * db) : 0;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    var pos = (sorted.length - 1) * q;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // 数组 z 值标准化（标准差过小时返回全 0）
  function zscore(arr) {
    var m = mean(arr), s = stdev(arr);
    if (s < 1e-9) return arr.map(function () { return 0; });
    return arr.map(function (x) { return (x - m) / s; });
  }

  // 加权无放回采样：按 weights 抽 k 个下标（配 mulberry32 使用，结果可复现）
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
      if (pick < 0) break;
      picked.push(pick);
      total -= avail[pick];
      avail[pick] = 0;
    }
    return picked;
  }

  /* ---------------- 伪随机（可复现） ---------------- */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ---------------- 数据访问 ---------------- */

  var CACHE = {};

  function meta(kind) {
    var d = root.LOTTO_DATA && root.LOTTO_DATA[kind];
    if (!d) throw new Error('缺少数据：' + kind);
    return d;
  }

  // 返回按期号升序的开奖数组 [{i,d,r:[],b:[]}]
  // 数据文件使用紧凑数组 [期号, 日期, [主号], [特别号]] 存储以减小体积
  function draws(kind) {
    if (!CACHE[kind]) {
      CACHE[kind] = meta(kind).draws.map(function (a) {
        return { i: a[0], d: a[1], r: a[2], b: a[3] };
      });
    }
    return CACHE[kind];
  }

  function cfg(kind) {
    var m = meta(kind);
    return {
      key: kind,
      name: m.name,
      mainMin: m.mainMin, mainMax: m.mainMax, mainCount: m.mainCount,
      specialMin: m.specialMin, specialMax: m.specialMax, specialCount: m.specialCount,
      mainLabel: m.mainLabel, specialLabel: m.specialLabel,
      updated: m.updated, range: m.range, source: m.source
    };
  }

  // 主号码区间列表
  function mainRange(c) {
    var a = [];
    for (var i = c.mainMin; i <= c.mainMax; i++) a.push(i);
    return a;
  }

  function specialRange(c) {
    var a = [];
    for (var i = c.specialMin; i <= c.specialMax; i++) a.push(i);
    return a;
  }

  /* ---------------- 开奖记录属性 ---------------- */

  function sum(nums) { var s = 0; for (var i = 0; i < nums.length; i++) s += nums[i]; return s; }
  function span(nums) { return Math.max.apply(null, nums) - Math.min.apply(null, nums); }

  function oddCount(nums) {
    var c = 0; for (var i = 0; i < nums.length; i++) if (nums[i] % 2) c++;
    return c;
  }

  // 大小比：以区间中位为界
  function bigCount(nums, c) {
    var mid = Math.floor((c.mainMin + c.mainMax) / 2);
    var n = 0;
    for (var i = 0; i < nums.length; i++) if (nums[i] > mid) n++;
    return n;
  }

  // 连号：排序后相邻差为 1 的对数
  function consecutiveCount(nums) {
    var s = nums.slice().sort(function (a, b) { return a - b; }), n = 0;
    for (var i = 1; i < s.length; i++) if (s[i] - s[i - 1] === 1) n++;
    return n;
  }

  // AC 值：不同正差值的个数 - (号码个数 - 1)
  function acValue(nums) {
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var set = {};
    for (var i = 0; i < s.length; i++)
      for (var j = i + 1; j < s.length; j++) set[s[j] - s[i]] = 1;
    var d = Object.keys(set).length;
    return d - (s.length - 1);
  }

  // 与上一期重号个数
  function repeatCount(cur, prev) {
    var set = {};
    for (var i = 0; i < prev.length; i++) set[prev[i]] = 1;
    var n = 0;
    for (var j = 0; j < cur.length; j++) if (set[cur[j]]) n++;
    return n;
  }

  function tails(nums) {
    return nums.map(function (x) { return x % 10; });
  }

  // 分区（按号码值等分为 zoneCount 个区间）
  function zoneIndex(num, c, zoneCount) {
    var size = (c.mainMax - c.mainMin + 1) / zoneCount;
    var idx = Math.floor((num - c.mainMin) / size);
    return Math.min(zoneCount - 1, Math.max(0, idx));
  }

  function zoneDistribution(nums, c, zoneCount) {
    var arr = new Array(zoneCount).fill(0);
    for (var i = 0; i < nums.length; i++) arr[zoneIndex(nums[i], c, zoneCount)]++;
    return arr;
  }

  /* ---------------- 直方图工具 ---------------- */

  // 把数值序列分桶，返回 {labels, counts, edges}
  function histogram(values, binCount) {
    if (!values.length) return { labels: [], counts: [], edges: [] };
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    if (min === max) { max = min + 1; }
    var width = (max - min) / binCount;
    var counts = new Array(binCount).fill(0);
    for (var i = 0; i < values.length; i++) {
      var idx = Math.floor((values[i] - min) / width);
      if (idx >= binCount) idx = binCount - 1;
      counts[idx]++;
    }
    var labels = [], edges = [];
    for (var j = 0; j < binCount; j++) {
      var lo = min + width * j;
      edges.push(lo);
      labels.push(Math.round(lo) + '~' + Math.round(lo + width));
    }
    edges.push(max);
    return { labels: labels, counts: counts, edges: edges, min: min, max: max, width: width };
  }

  // 离散值频次表（用于奇偶比等）
  function tally(values) {
    var map = {}, order = [];
    for (var i = 0; i < values.length; i++) {
      var k = String(values[i]);
      if (!(k in map)) { map[k] = 0; order.push(k); }
      map[k]++;
    }
    order.sort(function (a, b) {
      var na = parseFloat(a), nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a < b ? -1 : 1;
    });
    return order.map(function (k) { return { key: k, count: map[k], ratio: map[k] / values.length }; });
  }

  /* ---------------- 运行时数据补齐 ---------------- */

  // 用刚刚拉到的官方最新开奖补齐 / 校正内存数据：
  //   · 期号去重，同一期以传入的（官方）数据为准；
  //   · 只增不减，本地全量历史不会被覆盖成"最近几期"；
  //   · 同步刷新 updated / range 元信息，并清空派生缓存（统计、评分都依赖全量数组）。
  // rows: [{i:'2026106', d:'2026-09-13', r:[2,5,...], b:[7]}]
  function patchDraws(kind, rows) {
    var m = meta(kind);
    var map = {};
    (m.draws || []).forEach(function (a) { map[a[0]] = a; });
    var added = 0, fixed = 0;
    (rows || []).forEach(function (r) {
      if (!r || r.i == null || !r.r || !r.b) return;
      var i = String(r.i);
      var fresh = [i, String(r.d == null ? '' : r.d), r.r.slice(), r.b.slice()];
      var old = map[i];
      if (!old) {
        map[i] = fresh;
        added++;
        return;
      }
      var sameNums = String(old[2]) === String(fresh[2]) && String(old[3]) === String(fresh[3]);
      if (sameNums) {
        if (!old[1] && fresh[1]) { old[1] = fresh[1]; fixed++; }
        return;
      }
      map[i] = fresh;            // 号码不一致：以官方数据为准
      fixed++;
    });
    var arr = Object.keys(map).sort().map(function (k) { return map[k]; });
    if (arr.length) {
      m.draws = arr;
      m.updated = arr[arr.length - 1][1] || m.updated;
      m.range = arr[0][0] + ' ~ ' + arr[arr.length - 1][0];
    }
    delete CACHE[kind];
    return { added: added, fixed: fixed, total: arr.length };
  }

  root.LC = {
    gammaln: gammaln, gammaP: gammaP, chi2SF: chi2SF,
    normalCDF: normalCDF, normalTwoTail: normalTwoTail,
    comb: comb, hypergeom: hypergeom,
    mean: mean, stdev: stdev, quantile: quantile, pearson: pearson,
    zscore: zscore, weightedSample: weightedSample,
    mulberry32: mulberry32,
    meta: meta, draws: draws, cfg: cfg, patchDraws: patchDraws,
    mainRange: mainRange, specialRange: specialRange,
    sum: sum, span: span, oddCount: oddCount, bigCount: bigCount,
    consecutiveCount: consecutiveCount, acValue: acValue, repeatCount: repeatCount,
    tails: tails, zoneIndex: zoneIndex, zoneDistribution: zoneDistribution,
    histogram: histogram, tally: tally
  };
})(window);
