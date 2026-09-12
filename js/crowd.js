/* ============================================================
 * crowd.js — 「避开拥挤」出号引擎（对应 require.md）
 * 全局命名空间：window.LCrowd
 * 依赖：LC
 *
 * 声明：本模块仅用于数字生成演示，纯娱乐，不存在任何预测功能。
 *
 * 设计前提（与 require.md 完全一致）：
 *   彩票开奖是完全独立的随机事件，任何号码中奖概率恒等，谁都预测不了。
 *   一、二等奖为浮动奖，奖金按中奖注数平分。所以唯一可以被数学影响的量
 *   不是"中奖概率"，而是"中奖后被分摊的人数"——即号码的【拥挤度】。
 *   本模块的全部目标：避开大众偏好的号码与形态，降低拥挤度。
 *
 * 模块结构（严格对应 require.md 的逐层筛）：
 *   P 概率因子
 *     P0 历史同源：与历史任一期完全相同 / 与上期重号≥3      → 硬作废
 *     P1 极端形态：3连号 / 全等差 / 完全对称 / 同尾≥3 /
 *                  全奇全偶 / 全大全小 / 挤同区            → 硬作废
 *     P2 大众偏好：生日号、≤31扎堆、6/8/9谐音凑堆            → 计入拥挤度
 *     P3 拥挤黑名单：热门号池命中数（≥5 硬作废，<5 计入拥挤度）
 *     P4 自我重复：历史自买撞≥5 作废 / 本次注间撞≥4 重抽
 *   E 环境因子
 *     E1 日历热点：公历节日 · 生肖年 · 当期日期拆解
 *     E2 实时事件：热搜数字 / 赛事比分 / 胜者编号（手工录入）
 *     E3 荐号池：AI / 主播 / 群聊合买号（手工录入，即热门号池）
 *     E4 区域扰动：环境项对拥挤度的调整幅度封顶 ±10%
 *     E5 奖池派奖：仅作为提示输出，交给纪律模块
 *   L 欧气因子（进攻）
 *     L1 运气源 / L2 提数字 / L3 七条映射 / L4 权重合成
 *       半衰期 7 天 · 单号封顶 +3.0 · 不取最高（叠加）· 加权抽样
 *   出号
 *     单式：加权随机抽样 → 三层自适应均分：能整除则 1:1:1，余数补给 全权重 → 开方 → 均匀
 *     复式 / 胆拖：优化【号码池】——让池子展开后的所有组合平均拥挤度最低、
 *                 踩中 P0/P1 与形态要求的比例最小
 * ============================================================ */
(function (root) {
  'use strict';
  var LC = root.LC;

  /* ============================================================
   * 0. 常量与先验
   * ========================================================== */

  // P2 大众偏好：谐音吉利尾数（6 顺 · 8 发 · 9 久）
  var LUCKY_TAIL = { 6: 0.85, 8: 1.0, 9: 0.85 };

  // P2 大众偏好：生日号上界。绝大多数人选号落在 1–31（日期范围），
  // 其中 1–12 既像月份又像日期，拥挤程度最高。
  var BIRTHDAY_MAX = 31;
  var MONTH_MAX = 12;

  // 生日号先验（平滑衰减，避免 32/33 等"非生日号"被过度追捧而变成新的扎堆）
  function birthdayPrior(n) {
    if (n <= MONTH_MAX) return 1.0;
    if (n <= BIRTHDAY_MAX) return 0.72;
    return Math.max(0.30, 0.72 - (n - BIRTHDAY_MAX) * 0.12);
  }

  // E1 日历热点：常见的"数字感"公历节日（不含任何时政内容）
  var FESTIVALS = [
    { m: 1, d: 1, name: '元旦', nums: [1, 11] },
    { m: 2, d: 14, name: '情人节', nums: [2, 14] },
    { m: 3, d: 8, name: '妇女节', nums: [3, 8] },
    { m: 5, d: 1, name: '劳动节', nums: [5, 1] },
    { m: 6, d: 1, name: '儿童节', nums: [6, 1] },
    { m: 9, d: 10, name: '教师节', nums: [9, 10] },
    { m: 11, d: 11, name: '双十一', nums: [11, 1] },
    { m: 12, d: 25, name: '圣诞节', nums: [12, 25] },
    { m: 12, d: 31, name: '跨年', nums: [12, 31] }
  ];

  // 生肖序（鼠 = 1 … 猪 = 12），仅作为"年生肖=几号"的趣味映射
  var ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

  // 形态硬约束中"和值窗口"的标准差倍数（require.md：均值 ±1.5 倍标准差）
  var SUM_SIGMA = 1.5;
  // 最小跨度
  var MIN_SPAN = 15;

  // 权重合成封顶（require.md：L4 封顶 +3.0）
  var LUCK_CAP = 3.0;
  // 运气源半衰期（天）
  var LUCK_HALFLIFE_DAYS = 7;
  // E4 环境项对单号拥挤度的调整幅度上限
  var ENV_CAP = 0.10;

  /* ============================================================
   * 1. 通用工具
   * ========================================================== */

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  function zscore(arr) {
    var m = LC.mean(arr), s = LC.stdev(arr);
    if (s < 1e-9) return arr.map(function () { return 0; });
    return arr.map(function (x) { return (x - m) / s; });
  }

  // 最长连号长度：相邻差为 1 的连续段长度（无连号返回 1）
  function longestRun(nums) {
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var best = 1, cur = 1;
    for (var i = 1; i < s.length; i++) {
      if (s[i] - s[i - 1] === 1) { cur++; if (cur > best) best = cur; }
      else cur = 1;
    }
    return best;
  }

  // 出现次数最多的尾数及其出现次数
  function maxSameTail(nums) {
    var cnt = {}, best = 0;
    for (var i = 0; i < nums.length; i++) {
      var t = nums[i] % 10;
      cnt[t] = (cnt[t] || 0) + 1;
      if (cnt[t] > best) best = cnt[t];
    }
    return best;
  }

  // 等差数列：排序后相邻差全部相等
  function isArithmetic(nums) {
    var s = nums.slice().sort(function (a, b) { return a - b; });
    if (s.length < 3) return false;
    var d = s[1] - s[0];
    for (var i = 2; i < s.length; i++) if (s[i] - s[i - 1] !== d) return false;
    return true;
  }

  // 完全对称：排序后首尾成对之和恒定
  function isSymmetric(nums) {
    var s = nums.slice().sort(function (a, b) { return a - b; });
    if (s.length < 3) return false;
    var target = s[0] + s[s.length - 1];
    for (var i = 0; i < Math.floor(s.length / 2); i++) {
      if (s[i] + s[s.length - 1 - i] !== target) return false;
    }
    return true;
  }

  function digitalRoot(n) {
    n = Math.abs(Math.round(n));
    if (!n) return 0;
    return 1 + (n - 1) % 9;
  }

  // 取模映射到号码区间：[mainMin, mainMax]
  function modIntoPool(n, c) {
    var pool = c.mainMax - c.mainMin + 1;
    var v = ((Math.abs(Math.round(n)) - 1) % pool + pool) % pool;
    return c.mainMin + v;
  }

  // 加权无放回采样（返回下标数组）
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

  /* ---------- 文本 → 数字（L2 提数字） ---------- */

  // 从自由文本中抽取数字，同时做"小数缩减"（0.618 → 618）
  function extractNumbers(text) {
    if (!text) return [];
    var out = [];
    var re = /\d+(?:\.\d+)?/g, m;
    while ((m = re.exec(text))) {
      var raw = m[0];
      out.push({ text: raw, value: Number(raw), scaled: raw.indexOf('.') >= 0 });
      if (raw.indexOf('.') >= 0) {
        // 小数缩减：取小数部分作为新的数字源
        var frac = raw.split('.')[1];
        out.push({ text: frac, value: Number(frac), scaled: true });
      }
    }
    return out;
  }

  // 解析"每行一个运气源"，行首可选日期（YYYY-MM-DD）用于半衰期衰减
  function parseSources(text) {
    if (!text) return [];
    var now = new Date();
    var lines = String(text).split(/\r?\n/);
    var out = [];
    lines.forEach(function (line) {
      var s = line.trim();
      if (!s) return;
      var dm = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*/.exec(s);
      var when = now, label = s;
      if (dm) {
        when = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
        label = s.slice(dm[0].length).trim() || s;
      }
      var nums = extractNumbers(s);
      if (!nums.length) return;
      var ageDays = Math.max(0, (now - when) / 86400000);
      out.push({ label: label, ageDays: ageDays, nums: nums });
    });
    return out;
  }

  /* ============================================================
   * 3. L 欧气因子：L3 七条映射 → L4 权重合成
   * ========================================================== */

  // 七条映射：本体 · 数位 · 取模 · 数根 · 邻域 · 日期拆解 · 小数缩减
  function mapSourceToPool(numText, value, min, max) {
    var pool = max - min + 1;
    var acc = {};      // num → 贡献
    function add(n, w) {
      n = Math.round(n);
      if (n >= min && n <= max) acc[n] = (acc[n] || 0) + w;
    }
    // ① 本体
    add(value, 1.0);
    // ② 数位（各位数字 + 数位和）
    var digits = String(numText).split('').filter(function (ch) { return /\d/.test(ch); })
      .map(Number);
    var dsum = 0;
    digits.forEach(function (d) { dsum += d; add(d, 0.30); });
    add(dsum, 0.55);
    // ③ 取模：把数值折叠回号码区间
    add(((Math.abs(Math.round(value)) - 1) % pool + pool) % pool + min, 0.50);
    // ④ 数根
    add(digitalRoot(value), 0.40);
    // ⑤ 邻域：±1
    add(value - 1, 0.25);
    add(value + 1, 0.25);
    // ⑥ 日期拆解：像年份（1900–2100）时拆成后两位与各位
    if (value >= 1900 && value <= 2100) {
      add(value % 100, 0.40);
      var ys = String(Math.round(value)).split('').map(Number);
      ys.forEach(function (d) { add(d, 0.18); });
    }
    // 四位数字视为 MMDD / DDMM 的候选拆解
    if (digits.length === 4) {
      add(Number(String(digits[0]) + String(digits[1])), 0.22);
      add(Number(String(digits[2]) + String(digits[3])), 0.22);
    }
    return acc;
  }

  // 汇总所有运气源 → 单号加权值（半衰期 7 天 · 封顶 +3.0）
  function luckBoost(kind, text, min, max) {
    var c = LC.cfg(kind);
    var lo = min == null ? c.mainMin : min;
    var hi = max == null ? c.mainMax : max;
    var sources = parseSources(text);
    var boost = {}, detail = [];
    var lambda = Math.log(2) / LUCK_HALFLIFE_DAYS;

    sources.forEach(function (src) {
      var decay = Math.exp(-lambda * src.ageDays);      // L4 半衰期衰减
      if (decay < 0.02) return;
      var perNum = {}, touched = 0;
      src.nums.forEach(function (item) {
        var mapped = mapSourceToPool(item.text, item.value, lo, hi);
        Object.keys(mapped).forEach(function (k) {
          perNum[k] = (perNum[k] || 0) + mapped[k];
          touched++;
        });
      });
      Object.keys(perNum).forEach(function (k) {
        var n = Number(k);
        var w = perNum[k] * decay * 0.6;
        boost[n] = (boost[n] || 0) + w;
      });
      detail.push({
        label: src.label,
        ageDays: Math.round(src.ageDays),
        decay: decay,
        numbers: src.nums.map(function (x) { return x.text; }).join(' '),
        count: touched
      });
    });

    // L4 封顶 +3.0（不取最高：各来源叠加后再封顶）
    Object.keys(boost).forEach(function (k) {
      boost[k] = Math.min(boost[k], LUCK_CAP);
    });
    return { map: boost, sources: detail };
  }

  /* ============================================================
   * 4. E 环境因子：E1 日历 · E2 事件 · E3 荐号池
   * ========================================================== */

  // E1 日历热点：当期日期拆解 + 节日 + 生肖年
  function calendarCrowd(c, date) {
    var d = date || new Date();
    var out = {}, notes = [];
    function add(n, w, why) {
      n = Math.round(n);
      if (n < c.mainMin || n > c.mainMax) return;
      out[n] = (out[n] || 0) + w;
      if (why && notes.indexOf(why) < 0) notes.push(why);
    }
    var mm = d.getMonth() + 1, dd = d.getDate(), yy = d.getFullYear();

    // 日期本体与拆解：9 月 12 日 → 9、12、912 取模
    add(mm, 0.30, '当日月份 ' + mm + ' 号被当作幸运月');
    add(dd, 0.30, '当日期号 ' + dd + ' 号被大量生日党使用');
    add(Number(String(mm) + String(dd < 10 ? '0' + dd : dd)), 0.20, '日期连写被当作吉利串');
    add(modIntoPool(yy % 1000, c), 0.18, '年份数字折叠成号');
    // 生肖年（鼠 1 … 猪 12）
    var idx = ((yy - 2020) % 12 + 12) % 12;   // 2020 = 鼠年
    add(idx + 1, 0.22, yy + ' 年为' + ZODIAC[idx] + '年，序号 ' + (idx + 1) + ' 号');

    FESTIVALS.forEach(function (f) {
      if (f.m === mm && f.d === dd) {
        f.nums.forEach(function (n) { add(n, 0.35, f.name + '的数字偏好'); });
      }
    });
    return { map: out, notes: notes, date: d };
  }

  // E2 实时事件 + E3 荐号池：手工录入的数字，统一转成"拥挤"来源
  function eventCrowd(kind, text) {
    var c = LC.cfg(kind);
    var nums = extractNumbers(text);
    var map = {};
    nums.forEach(function (item) {
      var mapped = mapSourceToPool(item.text, item.value, c.mainMin, c.mainMax);
      Object.keys(mapped).forEach(function (k) {
        map[k] = (map[k] || 0) + mapped[k];
      });
    });
    return map;
  }

  // 热门号池（E3 / P3）：既用于硬过滤，也用于拥挤度加分
  function parseHotPool(kind, text) {
    var c = LC.cfg(kind);
    var items = extractNumbers(text);
    var set = {}, list = [];
    items.forEach(function (it) {
      var v = Math.round(it.value);
      if (v < c.mainMin || v > c.mainMax) {
        // 也接受"带单位的整串"（如 0815）→ 取模折叠
        v = modIntoPool(v, c);
      }
      if (v >= c.mainMin && v <= c.mainMax && !set[v]) { set[v] = 1; list.push(v); }
    });
    list.sort(function (a, b) { return a - b; });
    return { set: set, list: list, count: list.length };
  }

  /* ============================================================
   * 5. 单号拥挤度 C(n) ∈ [0,1]
   *
   *   C(n) = 0.30·生日号 + 0.24·吉利尾 + 0.12·小号偏好
   *        + 0.18·长期热度 + 0.16·上期开出   （+ E 环境项，封顶 ±10%）
   * ========================================================== */

  function buildNumberCrowd(kind, opts) {
    opts = opts || {};
    var c = LC.cfg(kind);
    var all = LC.draws(kind);
    var min = c.mainMin, max = c.mainMax, pool = max - min + 1;
    var lastDraw = all[all.length - 1];
    var lastSet = {};
    (lastDraw ? lastDraw.r : []).forEach(function (n) { lastSet[n] = 1; });

    // 长期频率 → z 值（用于"长期热号被追捧"）
    var counts = new Array(pool).fill(0);
    var span = opts.window || 0;
    var use = span && span < all.length ? all.slice(all.length - span) : all;
    use.forEach(function (d) {
      d.r.forEach(function (n) { counts[n - min]++; });
    });
    var z = zscore(counts);

    // E1 日历 + E2 事件
    var cal = calendarCrowd(c, opts.date);
    var evt = eventCrowd(kind, opts.events);

    var list = [], parts = [];
    var i;
    for (i = 0; i < pool; i++) {
      var n = min + i;
      var birthday = birthdayPrior(n);
      var lucky = LUCKY_TAIL[n % 10] || 0;
      var small = 1 - i / (pool - 1 || 1);
      var hot = clamp(z[i] / 2.5, 0, 1);
      var last = lastSet[n] ? 1 : 0;

      var base = 0.30 * birthday + 0.24 * lucky + 0.12 * small
        + 0.18 * hot + 0.16 * last;

      // E4 区域扰动：环境项带来的调整幅度封顶 ±10%
      var envRaw = (cal.map[n] || 0) * 0.35 + (evt[n] || 0) * 0.30;
      var env = clamp(envRaw, -ENV_CAP, ENV_CAP);

      var crowd = clamp(base + env, 0, 1);
      var item = {
        num: n, crowd: crowd,
        parts: {
          birthday: birthday * 0.30,
          lucky: lucky * 0.24,
          small: small * 0.12,
          hot: hot * 0.18,
          last: last * 0.16,
          env: env
        },
        envRaw: envRaw,
        rank: 0
      };
      list.push(item);
      parts.push(item);
    }
    list.sort(function (a, b) { return a.crowd - b.crowd; });
    list.forEach(function (o, idx) { o.rank = idx + 1; });

    return {
      list: list,
      map: (function () {
        var m = {};
        list.forEach(function (o) { m[o.num] = o.crowd; });
        return m;
      })(),
      calendar: cal,
      events: evt,
      c: c
    };
  }

  // 特别号（蓝球 / 后区）拥挤度：号码池小，生日偏好更集中
  function buildSpecialCrowd(kind, opts) {
    opts = opts || {};
    var c = LC.cfg(kind);
    var all = LC.draws(kind);
    var min = c.specialMin, max = c.specialMax, pool = max - min + 1;
    var lastDraw = all[all.length - 1];
    var lastSet = {};
    (lastDraw ? lastDraw.b : []).forEach(function (n) { lastSet[n] = 1; });
    var cal = calendarCrowd(c, opts.date);

    var list = [];
    for (var i = 0; i < pool; i++) {
      var n = min + i;
      var birthday = birthdayPrior(n);
      var lucky = LUCKY_TAIL[n % 10] || 0;
      var small = 1 - i / (pool - 1 || 1);
      var last = lastSet[n] ? 1 : 0;
      var base = 0.34 * birthday + 0.26 * lucky + 0.14 * small + 0.26 * last;
      var env = clamp((cal.map[n] || 0) * 0.35, -ENV_CAP, ENV_CAP);
      list.push({
        num: n, crowd: clamp(base + env, 0, 1),
        parts: {
          birthday: birthday * 0.34, lucky: lucky * 0.26,
          small: small * 0.14, last: last * 0.26, env: env
        }
      });
    }
    list.sort(function (a, b) { return a.crowd - b.crowd; });
    list.forEach(function (o, idx) { o.rank = idx + 1; });
    return { list: list, c: c };
  }

  /* ============================================================
   * 6. P 概率因子：组合级过滤与形态要求
   * ========================================================== */

  // 建立过滤上下文（历史键集合 / 上期号码 / 和值分布）
  function buildContext(kind, opts) {
    opts = opts || {};
    var c = LC.cfg(kind);
    var all = LC.draws(kind);
    var recentN = opts.recentDraws || 30;
    var recent = opts.window && opts.window < all.length
      ? all.slice(all.length - opts.window)
      : all;
    var windowed = recent;

    // P0：历史全部组合的键集合（用于"与历史任一期完全相同"）
    var histSet = {};
    all.forEach(function (d) { histSet[d.r.join(',')] = 1; });

    // 和值分布（用于形态要求"均值 ±1.5σ"）
    var sums = windowed.map(function (d) { return LC.sum(d.r); });

    return {
      c: c,
      all: all,
      recentDraws: all.slice(Math.max(0, all.length - recentN)),
      histSet: histSet,
      prevMain: all.length ? all[all.length - 1].r : null,
      sumMu: LC.mean(sums),
      sumSd: LC.stdev(sums),
      windowSize: windowed.length
    };
  }

  // P0 + P1 硬过滤（返回 {pass, fails:[{code,name,detail}]}）
  function hardFilters(combo, ctx) {
    var c = ctx.c, fails = [];
    var key = combo.join(',');

    // P0-a 与历史任一期完全相同
    if (ctx.histSet[key]) {
      fails.push({ code: 'P0', name: '历史同源', detail: '与历史某一期号码完全相同' });
    }
    // P0-b 与上期重号 ≥ 3
    var rep = ctx.prevMain ? LC.repeatCount(combo, ctx.prevMain) : 0;
    if (rep >= 3) {
      fails.push({ code: 'P0', name: '历史同源', detail: '与上期重号 ' + rep + ' 个（≥3）' });
    }

    // P1 极端形态
    var run = longestRun(combo);
    if (run >= 3) fails.push({ code: 'P1', name: '极端形态', detail: run + ' 连号' });
    if (isArithmetic(combo)) fails.push({ code: 'P1', name: '极端形态', detail: '全等差' });
    if (isSymmetric(combo)) fails.push({ code: 'P1', name: '极端形态', detail: '完全对称' });
    var tailMax = maxSameTail(combo);
    if (tailMax >= 3) fails.push({ code: 'P1', name: '极端形态', detail: '同尾 ' + tailMax + ' 个（≥3）' });
    var odd = LC.oddCount(combo);
    if (odd === 0 || odd === combo.length) {
      fails.push({ code: 'P1', name: '极端形态', detail: odd === 0 ? '全偶' : '全奇' });
    }
    var big = LC.bigCount(combo, c);
    if (big === 0 || big === combo.length) {
      fails.push({ code: 'P1', name: '极端形态', detail: big === 0 ? '全小' : '全大' });
    }
    var zd = LC.zoneDistribution(combo, c, 3);
    if (zd.filter(function (x) { return x > 0; }).length <= 1) {
      fails.push({ code: 'P1', name: '极端形态', detail: '号码挤在同一区间' });
    }

    return { pass: fails.length === 0, fails: fails, repeat: rep, run: run, tailMax: tailMax };
  }

  // 形态要求（require.md【形态要求】），全部满足才输出
  function structureFilters(combo, ctx) {
    var c = ctx.c, fails = [];
    var sum = LC.sum(combo), span = LC.span(combo);
    var lo = ctx.sumMu - SUM_SIGMA * ctx.sumSd;
    var hi = ctx.sumMu + SUM_SIGMA * ctx.sumSd;

    if (sum < lo || sum > hi) {
      fails.push({ code: '形态', name: '和值越界', detail: '和值 ' + sum + ' 不在 ' + Math.round(lo) + '~' + Math.round(hi) });
    }
    if (span < MIN_SPAN) {
      fails.push({ code: '形态', name: '跨度不足', detail: '跨度 ' + span + '（<15）' });
    }
    var odd = LC.oddCount(combo);
    if (odd === 0 || odd === combo.length) {
      fails.push({ code: '形态', name: '奇偶极端', detail: '奇偶比 ' + odd + ':' + (combo.length - odd) });
    }
    var big = LC.bigCount(combo, c);
    if (big === 0 || big === combo.length) {
      fails.push({ code: '形态', name: '大小极端', detail: '大小比 ' + big + ':' + (combo.length - big) });
    }
    var zd = LC.zoneDistribution(combo, c, 3);
    if (zd.filter(function (x) { return x > 0; }).length < 3) {
      fails.push({ code: '形态', name: '区间不全', detail: '三区分布 ' + zd.join(':') });
    }
    var run = longestRun(combo);
    if (run >= 3) {
      fails.push({ code: '形态', name: '连号过多', detail: run + ' 连号（最多一组 2 连号）' });
    }
    return { pass: fails.length === 0, fails: fails, run: run };
  }

  // P3 拥挤黑名单：热门号池命中数
  function poolHit(combo, hotPool) {
    var h = 0;
    combo.forEach(function (n) { if (hotPool.set[n]) h++; });
    return h;
  }

  /* ============================================================
   * 7. 组合拥挤度评分（0–100，越低越好，> 阈值不许输出）
   * ========================================================== */

  function patternCrowd(combo, ctx) {
    var c = ctx.c;
    var run = longestRun(combo);
    var tail = maxSameTail(combo);
    var s = 0;
    if (run >= 3) s += 0.80;
    else if (run === 2) s += 0.22;            // 单组 2 连号：大众也爱用，略加
    if (tail >= 3) s += 0.60;
    else if (tail === 2) s += 0.18;
    if (isArithmetic(combo)) s += 0.70;
    if (isSymmetric(combo)) s += 0.50;
    var zd = LC.zoneDistribution(combo, c, 3);
    var zoned = zd.filter(function (x) { return x > 0; }).length;
    if (zoned <= 2) s += 0.35;
    return clamp(s, 0, 1);
  }

  function popularCrowd(combo) {
    var k = combo.length;
    var birthday = 0, lucky = 0, low = 0;
    combo.forEach(function (n) {
      if (n <= BIRTHDAY_MAX) birthday++;
      if (LUCKY_TAIL[n % 10]) lucky++;
      if (n <= MONTH_MAX) low++;
    });
    var s = 0;
    s += clamp((birthday / k - 0.55) * 1.6, 0, 0.6);   // ≤31 扎堆
    s += clamp((lucky / k - 0.28) * 1.4, 0, 0.6);      // 6/8/9 凑一堆
    s += clamp((low / k - 0.35) * 0.9, 0, 0.4);        // 全挤在小号
    return clamp(s, 0, 1);
  }

  function poolCrowd(combo, hotPool) {
    if (!hotPool.count) return 0;
    var hits = poolHit(combo, hotPool);
    var k = combo.length;
    return clamp(hits / Math.max(3, Math.round(k * 0.6)), 0, 1);
  }

  function historyCrowd(combo, ctx) {
    var recent = ctx.recentDraws;
    if (!recent.length) return 0;
    var acc = 0;
    recent.forEach(function (d) { acc += LC.repeatCount(combo, d.r); });
    var avgOverlap = acc / recent.length / combo.length;
    return clamp(avgOverlap * 2.2, 0, 1);
  }

  var CROWD_WEIGHTS = {
    number: 0.42, pattern: 0.18, popular: 0.16, pool: 0.18, history: 0.06
  };

  function crowdScore(combo, ctx, numCrowd, hotPool) {
    var k = combo.length, acc = 0;
    combo.forEach(function (n) { acc += (numCrowd[n] || 0); });
    var parts = {
      number: acc / k,
      pattern: patternCrowd(combo, ctx),
      popular: popularCrowd(combo),
      pool: poolCrowd(combo, hotPool),
      history: historyCrowd(combo, ctx)
    };
    var score = 0;
    Object.keys(CROWD_WEIGHTS).forEach(function (key) {
      score += CROWD_WEIGHTS[key] * parts[key];
    });
    return { score: clamp(score, 0, 1) * 100, parts: parts };
  }

  /* ---------- 「它为什么不拥挤」说明 ---------- */
  function explain(combo, ctx, parts, hotPool, selfSet) {
    var c = ctx.c, reasons = [];
    var coldHigh = combo.filter(function (n) { return n > BIRTHDAY_MAX; }).length;
    if (coldHigh >= 1) reasons.push(coldHigh + ' 个号码落在 ' + (BIRTHDAY_MAX + 1) + '+ 的非生日段');
    var lucky = combo.filter(function (n) { return LUCKY_TAIL[n % 10]; }).length;
    if (lucky === 0) reasons.push('不含 6/8/9 谐音吉利尾');
    var hits = poolHit(combo, hotPool);
    if (hits === 0) reasons.push('与本期热门号池零命中');
    else if (hits <= 1) reasons.push('仅 ' + hits + ' 个号与热门池重合');
    if (selfSet && selfSet.count && poolHit(combo, selfSet) === 0) {
      reasons.push('与自己填的历史自买号零重合');
    }
    var run = longestRun(combo);
    if (run < 2) reasons.push('无连号');
    if (maxSameTail(combo) < 2) reasons.push('无同尾号');
    if (!isArithmetic(combo) && !isSymmetric(combo)) reasons.push('不构成等差/对称等直觉图形');
    if (parts.history < 0.35) reasons.push('与近 ' + ctx.recentDraws.length + ' 期重合度低');
    if (!reasons.length) reasons.push('各维度拥挤度均处于低位');
    return '它不拥挤：' + reasons.slice(0, 4).join('；') + '。';
  }

  /* ============================================================
   * 8. 出号：加权随机抽样 → 分层
   *   按总注数自适应均分：能整除则 1:1:1，余数补给 全权重 → 开方 → 均匀
   * ========================================================== */

  var TIERS = [
    { key: 'full', label: '全权重', desc: '完全按避拥挤权重抽样' },
    { key: 'sqrt', label: '权重开方', desc: '压低强弱差距，覆盖面更宽' },
    { key: 'uniform', label: '近乎均匀', desc: '接近均匀抽样，兜底防扎堆' }
  ];

  // 总注数自适应均分到三层：能整除则三等分，余数依次补给 全权重 → 开方 → 均匀
  function splitEven(total) {
    var n = Math.max(1, total | 0);
    var base = Math.floor(n / TIERS.length);
    var plan = {};
    TIERS.forEach(function (t) { plan[t.key] = base; });
    for (var i = 0; i < n % TIERS.length; i++) plan[TIERS[i].key]++;
    return plan;
  }

  // 归一化
  function normalize(w) {
    var s = 0;
    w.forEach(function (x) { s += x; });
    return s > 0 ? w.map(function (x) { return x / s; }) : w.map(function () { return 1 / w.length; });
  }

  // 各层的避拥挤指数：
  //   全权重   γ        —— 完全按避拥挤权重
  //   权重开方 γ/2      —— w^0.5，压低强弱差距
  //   近乎均匀 0.15     —— 近似均匀，仅保留极弱倾向
  // 注：用"改变指数"实现分层，而不是在候选里挑拥挤度最低者——
  //     后者会把每一注都收敛到同一批最冷号，反而制造新的扎堆。
  var CROWD_EXP = { uniform: 0.15 };

  function tierWeights(nc, luckMap, tier, gamma) {
    var expo = CROWD_EXP[tier] == null ? (tier === 'sqrt' ? gamma / 2 : gamma) : CROWD_EXP[tier];
    var w = nc.list.map(function (o) {
      return Math.exp(-expo * o.crowd) * (1 + (luckMap[o.num] || 0));
    });
    return { weights: normalize(w), exponent: expo };
  }

  function overlapOf(a, b) {
    var n = 0;
    for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) n++;
    return n;
  }

  /**
   * 生成推荐号码
   * opts: {
   *   seed, halflife, window,
   *   hotPool (text), luck (text), events (text), date,
   *   tiers: {full, sqrt, uniform}（缺省时按 tickets 自适应均分）, tickets, crowdMax,
   *   recentDraws, avoid (避拥挤强度 gamma), maxOverlap
   * }
   */
  function generate(kind, opts) {
    opts = opts || {};
    var c = LC.cfg(kind);
    var all = LC.draws(kind);
    var seed = opts.seed || (Date.now() & 0x7fffffff);
    var rnd = LC.mulberry32(seed);
    var gamma = opts.avoid == null ? 3 : opts.avoid;

    // 分层配比：优先用调用方给定的 tiers，否则按 tickets 自适应均分（缺省 5 注 → 2 / 2 / 1）
    var fallback = splitEven(opts.tickets == null ? 5 : opts.tickets);
    var plan = {
      full: opts.tiers && opts.tiers.full != null ? Math.max(0, opts.tiers.full | 0) : fallback.full,
      sqrt: opts.tiers && opts.tiers.sqrt != null ? Math.max(0, opts.tiers.sqrt | 0) : fallback.sqrt,
      uniform: opts.tiers && opts.tiers.uniform != null ? Math.max(0, opts.tiers.uniform | 0) : fallback.uniform
    };
    var totalTickets = plan.full + plan.sqrt + plan.uniform;
    if (totalTickets <= 0) { plan.full = 1; totalTickets = 1; }

    var threshold = opts.crowdMax == null ? 60 : opts.crowdMax;
    var maxOverlap = opts.maxOverlap == null ? Math.max(3, c.mainCount - 2) : opts.maxOverlap;

    // 上下文与拥挤度
    var ctx = buildContext(kind, opts);
    var nc = buildNumberCrowd(kind, opts);
    var sc = buildSpecialCrowd(kind, opts);
    var hotPool = parseHotPool(kind, opts.hotPool);

    // P4 自我重复：历史自买（手工录入）
    var selfSet = parseHotPool(kind, opts.selfPick);

    // L 运气源：主区 / 特别区
    var luckMain = luckBoost(kind, opts.luck, c.mainMin, c.mainMax);
    var luckSpec = luckBoost(kind, opts.luck, c.specialMin, c.specialMax);

    var tickets = [];
    var attempts = 0;
    var maxAttempts = totalTickets * 9000 + 30000;
    var rejected = { hard: 0, structure: 0, crowd: 0, overlap: 0 };

    var order = TIERS.filter(function (t) { return plan[t.key] > 0; });
    var remaining = plan;

    function accept(combo) {
      // P4 / 注入层：与已生成注之间撞 ≥ maxOverlap 重抽
      for (var i = 0; i < tickets.length; i++) {
        if (overlapOf(combo, tickets[i].main) >= maxOverlap) return false;
      }
      return true;
    }

    // 抽一个通过【硬过滤 + 形态要求 + 拥挤阈值】的候选
    function drawCandidate(w) {
      attempts++;
      var idxs = weightedSample(w, c.mainCount, rnd);
      if (idxs.length < c.mainCount) return null;
      var combo = idxs.map(function (i) { return nc.list[i].num; })
        .sort(function (a, b) { return a - b; });

      var hf = hardFilters(combo, ctx);
      if (!hf.pass) { rejected.hard++; return null; }
      // P4 历史自买撞 ≥5 作废
      if (selfSet.count && poolHit(combo, selfSet) >= 5) { rejected.hard++; return null; }

      var sf = structureFilters(combo, ctx);
      if (!sf.pass) { rejected.structure++; return null; }

      var cs = crowdScore(combo, ctx, nc.map, hotPool);
      if (cs.score > threshold) { rejected.crowd++; return null; }

      return { combo: combo, hf: hf, sf: sf, cs: cs };
    }

    function materialize(cand, tier) {
      var feat = featuresOf(cand.combo, ctx, cand.hf);
      return {
        main: cand.combo,
        special: [],
        tier: tier.key,
        tierLabel: tier.label,
        tierDesc: tier.desc,
        crowdScore: cand.cs.score,
        crowdParts: cand.cs.parts,
        structure: feat,
        features: feat,
        repeat: cand.hf.repeat,
        explanation: explain(cand.combo, ctx, cand.cs.parts, hotPool, selfSet),
        checks: buildChecks(cand.combo, cand.hf, cand.sf, hotPool, selfSet)
      };
    }

    order.forEach(function (tier) {
      var need = remaining[tier.key];
      var w = tierWeights(nc, luckMain.map, tier.key, gamma).weights;
      var produced = 0;
      while (produced < need && attempts < maxAttempts) {
        var cand = drawCandidate(w);
        if (!cand) continue;
        if (!accept(cand.combo)) { rejected.overlap++; continue; }
        tickets.push(materialize(cand, tier));
        produced++;
      }
    });

    // 特别号：按拥挤度从低到高轮转分配（避免与已用重复）
    var specOrder = sc.list.map(function (o) { return o.num; });
    var used = {};
    tickets.forEach(function (t, i) {
      var spec = [];
      for (var k = 0; k < c.specialCount; k++) {
        for (var s = 0; s < specOrder.length; s++) {
          var idx = (i * c.specialCount + k + s) % specOrder.length;
          var n = specOrder[idx];
          if (spec.indexOf(n) < 0 && (!used[n] || tickets.length > specOrder.length)) {
            spec.push(n); break;
          }
        }
      }
      while (spec.length < c.specialCount) {
        var n2 = specOrder[(i + spec.length) % specOrder.length];
        if (spec.indexOf(n2) < 0) spec.push(n2); else break;
      }
      t.special = spec.sort(function (a, b) { return a - b; });
      spec.forEach(function (n) { used[n] = 1; });
      t.mainDetail = t.main.map(function (n) {
        var o = nc.list.filter(function (x) { return x.num === n; })[0];
        return { num: n, crowd: o.crowd, parts: o.parts, rank: o.rank };
      });
      t.specialDetail = t.special.map(function (n) {
        var o = sc.list.filter(function (x) { return x.num === n; })[0];
        return { num: n, crowd: o.crowd, parts: o.parts, rank: o.rank };
      });
    });

    // E5 奖池派奖：仅作为提示交给"纪律模块"
    var notes = [];
    nc.calendar.notes.forEach(function (x) { notes.push(x); });
    var evtCount = Object.keys(nc.events).length;
    if (evtCount) notes.push('实时事件（E2）命中 ' + evtCount + ' 个号，与日历项叠加后调整拥挤度封顶 ±10%');
    if (hotPool.count) notes.push('热门号池收录 ' + hotPool.count + ' 个号（网络 + 手工双来源）');
    if (selfSet.count) notes.push('历史自买（P4）' + selfSet.count + ' 个号：新号与其重合 ≥5 个作废');
    if (luckMain.sources.length) {
      notes.push('运气源 ' + luckMain.sources.length + ' 条，按半衰期 ' +
        LUCK_HALFLIFE_DAYS + ' 天衰减、单号封顶 +' + LUCK_CAP.toFixed(1));
    }

    return {
      strategy: 'crowd',
      kind: kind,
      config: c,
      seed: seed,
      windowSize: nc.list.length,
      latest: all[all.length - 1],
      prevMain: ctx.prevMain,
      tickets: tickets,
      plan: plan,
      threshold: threshold,
      avoid: gamma,
      maxOverlap: maxOverlap,
      attempts: attempts,
      rejected: rejected,
      poolCrowd: nc.list,                 // 拥挤度从低到高
      specialCrowd: sc.list,
      hotPool: hotPool,
      selfPick: selfSet,
      luck: { main: luckMain, special: luckSpec },
      calendar: nc.calendar,
      events: nc.events,
      notes: notes,
      sumMu: ctx.sumMu,
      sumSd: ctx.sumSd
    };
  }

  function featuresOf(combo, ctx, hf) {
    var c = ctx.c;
    return {
      sum: LC.sum(combo),
      span: LC.span(combo),
      odd: LC.oddCount(combo),
      big: LC.bigCount(combo, c),
      zone: LC.zoneDistribution(combo, c, 3).join(':'),
      consecutive: longestRun(combo) >= 2 ? longestRun(combo) - 1 : 0,
      repeat: hf ? hf.repeat : 0
    };
  }

  function buildChecks(combo, hf, sf, hotPool, selfSet) {
    var hits = poolHit(combo, hotPool);
    var selfHits = (selfSet && selfSet.count) ? poolHit(combo, selfSet) : 0;
    return {
      P0: hf.repeat < 3,
      P1: hf.pass,
      P2: true,                                  // P2 以拥挤度体现，不作硬排除
      P3: hits < 5,                              // 热门池撞 ≥5 才作废
      P4: selfHits < 5,                          // 历史自买撞 ≥5 才作废（未填写时恒成立）
      structure: sf.pass,
      repeat: hf.repeat,
      run: hf.run,
      tailMax: hf.tailMax,
      poolHits: hits,
      selfHits: selfHits
    };
  }

  /* ============================================================
   * 9. 号码池：复式 / 胆拖
   *
   *   单式的评价单元是"一注"，所以能逐注硬作废、用注间撞号拉开距离。
   *   复式 / 胆拖买的是"一批号码"：一张复式票展开成 C(m,k) 注，每注拥挤度
   *   各不相同，票面没有单一拥挤度，也没法把其中某几注剔除。于是换一个
   *   目标函数 —— 优化【号码池】，让池子展开后的所有组合
   *     ① 平均拥挤度最低；
   *     ② 踩中 P0/P1 与【形态要求】的比例最小。
   *   搜索方式：从"低拥挤号加权抽样"出发做局部搜索（换号，胆拖再加胆拖换位），
   *   以展开组合的平均代价为唯一判据；随机种子只决定起点，
   *   因此同一套参数下"换一批"结果可复现。
   * ========================================================== */

  // 展开后某一注的代价 = 拥挤度 + 作废惩罚（单位与拥挤度一致，0–100+）
  //   实测（双色球主区 10 个号 / 展开 210 注）：
  //     无惩罚 → 最冷 10 号池 100% 全大硬作废
  //     22/10 → 平均拥挤度 28.0~31.5，形态越界 11~17%
  //     40/18 → 平均拥挤度 28.1~31.6，形态越界 12~14%（更稳定）
  //     100/50 → 平均拥挤度 29.7~32.9，形态越界 9~10%（收益递减）
  //   取 40/18：拥挤度代价仅 +0.1~0.7，换来更低的越界率与更小的方差。
  var POOL_PENALTY = { hard: 40, structure: 18 };
  // 局部搜索预算：单次搜索的毫秒上限与最大轮数，保证面板不卡顿
  var POOL_BUDGET_MS = 320;
  var POOL_PASSES = 8;
  var POOL_SUBSET_CAP = 6000;

  function ascNum(a, b) { return a - b; }

  function intOr(v, dflt) {
    if (v == null || v === '') return dflt;
    var n = Math.round(Number(v));
    return isFinite(n) ? n : dflt;
  }

  // 枚举 arr 的 k 元子集（arr 升序 → 结果升序），超出上限即截断
  function kSubsets(arr, k) {
    var out = [], n = arr.length;
    if (k < 0 || k > n) return out;
    if (k === 0) return [[]];
    var idx = new Array(k);
    (function rec(start, depth) {
      if (out.length >= POOL_SUBSET_CAP) return;
      if (depth === k) { out.push(idx.map(function (i) { return arr[i]; })); return; }
      for (var i = start; i <= n - (k - depth); i++) {
        idx[depth] = i;
        rec(i + 1, depth + 1);
        if (out.length >= POOL_SUBSET_CAP) return;
      }
    })(0, 0);
    return out;
  }

  // 池子展开后的统一口径统计
  function poolStats(rows, threshold) {
    var n = rows.length, sum = 0, min = Infinity, max = -Infinity;
    var over = 0, hard = 0, struct = 0, selfBad = 0, scores = [];
    var parts = { number: 0, pattern: 0, popular: 0, pool: 0, history: 0 };
    rows.forEach(function (r) {
      sum += r.score;
      scores.push(r.score);
      if (r.score < min) min = r.score;
      if (r.score > max) max = r.score;
      if (r.score > threshold) over++;
      if (!r.hard) hard++;
      else if (!r.struct) struct++;
      if (r.selfBad) selfBad++;
      Object.keys(parts).forEach(function (k) { parts[k] += (r.parts[k] || 0); });
    });
    scores.sort(ascNum);
    Object.keys(parts).forEach(function (k) { parts[k] = n ? parts[k] / n : 0; });
    return {
      count: n,
      combos: n,                     // 主区展开注数（不含特别区展开）
      mean: n ? sum / n : 0,
      min: n ? min : 0,
      max: n ? max : 0,
      p90: n ? scores[Math.min(n - 1, Math.floor(n * 0.9))] : 0,
      over: over,
      hardInvalid: hard,
      structInvalid: struct,
      selfInvalid: selfBad,          // 因 P4 历史自买重合 ≥5 而作废的注数
      passRate: n ? 1 - (hard + struct) / n : 0,
      parts: parts
    };
  }

  // 展开后某一注的代价：拥挤度 + 作废惩罚（可顺便采集明细）
  //   P4 历史自买（selfSet）与 P0/P1 一样按"硬作废"处理，计入 hard 惩罚
  function poolRow(combo, ctx, nc, hotPool, selfSet) {
    var cs = crowdScore(combo, ctx, nc.map, hotPool);
    var hf = hardFilters(combo, ctx);
    var selfHits = (selfSet && selfSet.count) ? poolHit(combo, selfSet) : 0;
    var selfBad = selfHits >= 5;
    var okHard = hf.pass && !selfBad;
    var okStruct = okHard ? structureFilters(combo, ctx).pass : false;
    var cost = cs.score;
    if (!okHard) cost += POOL_PENALTY.hard;
    else if (!okStruct) cost += POOL_PENALTY.structure;
    return {
      cost: cost, score: cs.score, parts: cs.parts,
      hard: okHard, struct: okStruct, selfBad: selfBad, selfHits: selfHits
    };
  }

  // 造一个"选号集合 → 展开组合平均代价"的求值器
  //   sel = { dan: [...], tuo: [...] }；复式时 dan 为空，tuo 即号码池
  //   need = 每注要从拖码里取几个（复式 = mainCount；胆拖 = mainCount - 胆码数）
  function makePoolEvaluator(ctx, nc, hotPool, need, selfSet) {
    var evals = 0;
    function combosOf(sel) {
      return kSubsets(sel.tuo, need).map(function (t) {
        return sel.dan.length ? sel.dan.concat(t).sort(ascNum) : t;
      });
    }
    function evaluate(sel, collect) {
      var combos = combosOf(sel);
      var total = 0, rows = collect ? [] : null;
      for (var i = 0; i < combos.length; i++) {
        var r = poolRow(combos[i], ctx, nc, hotPool, selfSet);
        total += r.cost;
        evals++;
        if (rows) rows.push(r);
      }
      return { mean: combos.length ? total / combos.length : 0, rows: rows, n: combos.length };
    }
    return {
      evaluate: evaluate,
      combosOf: combosOf,
      evals: function () { return evals; }
    };
  }

  // 局部搜索：换号（+ 胆拖换位），最小化展开组合的平均代价
  function searchPool(numPool, start, ev) {
    var cur = { dan: start.dan.slice(), tuo: start.tuo.slice() };
    var curEval = ev.evaluate(cur, false);
    var best = cur, bestEval = curEval;
    var t0 = Date.now();
    var passes = 0;

    function inSet(sel, n) {
      return sel.dan.indexOf(n) >= 0 || sel.tuo.indexOf(n) >= 0;
    }
    function outOfBudget() { return Date.now() - t0 > POOL_BUDGET_MS; }

    while (passes < POOL_PASSES) {
      passes++;
      var improved = false;
      // ① 换号：池内某个号 → 池外某个号
      var keys = cur.dan.length ? ['dan', 'tuo'] : ['tuo'];
      for (var ki = 0; ki < keys.length; ki++) {
        var key = keys[ki];
        for (var oi = 0; oi < cur[key].length; oi++) {
          for (var ni = 0; ni < numPool.length; ni++) {
            var cand = numPool[ni];
            if (inSet(cur, cand)) continue;
            var trial = { dan: cur.dan.slice(), tuo: cur.tuo.slice() };
            trial[key][oi] = cand;
            var r = ev.evaluate(trial, false);
            if (r.mean < curEval.mean - 1e-9) {
              cur = trial; curEval = r; improved = true;
              if (r.mean < bestEval.mean) { best = trial; bestEval = r; }
            }
            if (outOfBudget()) return { sel: best, ev: bestEval };
          }
        }
      }
      // ② 胆拖换位：胆码进每一注，位置比拖码"贵"，换位往往能显著降代价
      if (cur.dan.length && cur.tuo.length) {
        for (var di = 0; di < cur.dan.length; di++) {
          for (var ti = 0; ti < cur.tuo.length; ti++) {
            var sw = { dan: cur.dan.slice(), tuo: cur.tuo.slice() };
            var tmp = sw.dan[di]; sw.dan[di] = sw.tuo[ti]; sw.tuo[ti] = tmp;
            var rs = ev.evaluate(sw, false);
            if (rs.mean < curEval.mean - 1e-9) {
              cur = sw; curEval = rs; improved = true;
              if (rs.mean < bestEval.mean) { best = sw; bestEval = rs; }
            }
            if (outOfBudget()) return { sel: best, ev: bestEval };
          }
        }
      }
      if (!improved) break;
    }
    return { sel: best, ev: bestEval };
  }

  // 初始池：按避拥挤权重（低拥挤优先）做一次可复现的加权无放回抽样
  function samplePool(nc, luckMap, gamma, m, rnd) {
    var w = nc.list.map(function (o) {
      return Math.exp(-gamma * o.crowd) * (1 + (luckMap[o.num] || 0));
    });
    return weightedSample(w, m, rnd)
      .map(function (i) { return nc.list[i].num; })
      .sort(ascNum);
  }

  /**
   * 生成避拥挤【号码池】（复式 / 胆拖）
   * opts: {
   *   seed, window, halflife, date, hotPool, luck, events,
   *   crowdMax, avoid,
   *   betType: 'compound' | 'dantuo',
   *   mainSel, specialSel,                       // 复式：选号个数
   *   dtForm, danCount, tuoCount, sDanCount, sTuoCount   // 胆拖
   * }
   */
  function buildPool(kind, opts) {
    opts = opts || {};
    var c = LC.cfg(kind);
    var all = LC.draws(kind);
    var seed = opts.seed || (Date.now() & 0x7fffffff);
    var rnd = LC.mulberry32(seed);
    var gamma = opts.avoid == null ? 3 : opts.avoid;
    var threshold = opts.crowdMax == null ? 60 : opts.crowdMax;
    var mainPoolSize = c.mainMax - c.mainMin + 1;
    var specPoolSize = c.specialMax - c.specialMin + 1;
    var k = c.mainCount, sk = c.specialCount;

    var ctx = buildContext(kind, opts);
    var nc = buildNumberCrowd(kind, opts);
    var sc = buildSpecialCrowd(kind, opts);
    var hotPool = parseHotPool(kind, opts.hotPool);
    var selfSet = parseHotPool(kind, opts.selfPick);
    var luckMain = luckBoost(kind, opts.luck, c.mainMin, c.mainMax);
    var luckSpec = luckBoost(kind, opts.luck, c.specialMin, c.specialMax);

    var betType = opts.betType === 'dantuo' ? 'dantuo' : 'compound';
    var form = betType === 'dantuo'
      ? (opts.dtForm === 'special' || opts.dtForm === 'both' ? opts.dtForm : 'main')
      : null;

    // 组号方式：与 model.js/betOptions 的口径一致，这里只做安全钳制
    var mainSel = clamp(intOr(opts.mainSel, k + 1), k, Math.min(k + 4, mainPoolSize));
    var specialSel = clamp(intOr(opts.specialSel, sk), sk, Math.min(sk + 3, specPoolSize));
    var danCount = 0, tuoCount = 0;
    if (betType === 'dantuo' && form !== 'special') {
      danCount = clamp(intOr(opts.danCount, 1), 1, Math.max(k - 1, 1));
      var tuoMin = Math.max(k + 1 - danCount, 1);      // 官方：胆 + 拖 ≥ 基本号码数 + 1
      tuoCount = clamp(intOr(opts.tuoCount, tuoMin), tuoMin, mainPoolSize - danCount);
    }
    var sDanCount = 0, sTuoCount = 0;
    if (betType === 'dantuo' && form !== 'main') {
      sDanCount = 1;                                   // 官方固定 1 个特别区胆码
      sTuoCount = clamp(intOr(opts.sTuoCount, sk), sk, specPoolSize - sDanCount);
    }

    // 主区：池子多大、每注要从拖码里补几个
    var poolSize, need;
    if (form === 'special') {
      poolSize = k; need = k; danCount = 0; tuoCount = k;   // 主区不设胆拖，直接选满
    } else if (betType === 'dantuo') {
      poolSize = danCount + tuoCount; need = k - danCount;
    } else {
      poolSize = mainSel; need = k; danCount = 0; tuoCount = mainSel;
    }

    // 起点：低拥挤加权抽样；胆拖时把池里最冷的 danCount 个放进胆码
    var startNums = samplePool(nc, luckMain.map, gamma, poolSize, rnd);
    var start = { dan: [], tuo: startNums };
    if (danCount) {
      var byCrowd = startNums.slice().sort(function (a, b) {
        return (nc.map[a] || 0) - (nc.map[b] || 0);
      });
      start.dan = byCrowd.slice(0, danCount).sort(ascNum);
      start.tuo = byCrowd.slice(danCount).sort(ascNum);
    }

    var ev = makePoolEvaluator(ctx, nc, hotPool, need, selfSet);
    var numPool = nc.list.map(function (o) { return o.num; });   // 按拥挤度升序
    var found = searchPool(numPool, start, ev);
    var finalSel = found.sel;
    var finEval = ev.evaluate(finalSel, true);
    var stats = poolStats(finEval.rows, threshold);

    // 特别区：每个号在各注中出现次数相同，取最冷的若干个即为最优解
    var specialCount = (!form || form === 'main') ? specialSel : (sDanCount + sTuoCount);
    var specialNums = sc.list.slice(0, specialCount).map(function (o) { return o.num; }).sort(ascNum);
    var sDan = sDanCount ? specialNums.slice(0, sDanCount).sort(ascNum) : [];
    var sTuo = sDanCount ? specialNums.slice(sDanCount).sort(ascNum) : [];

    // 注数：与 app 的 betPreview 口径一致
    var mainCombos, specCombos;
    if (betType === 'compound') {
      mainCombos = LC.comb(mainSel, k);
      specCombos = LC.comb(specialSel, sk);
    } else if (form === 'special') {
      mainCombos = 1;
      specCombos = LC.comb(sTuoCount, sk - sDanCount);
    } else if (form === 'both') {
      mainCombos = LC.comb(tuoCount, k - danCount);
      specCombos = LC.comb(sTuoCount, sk - sDanCount);
    } else {
      mainCombos = LC.comb(tuoCount, k - danCount);
      specCombos = LC.comb(specialSel, sk);
    }
    var combos = mainCombos * specCombos;

    var mainNums = finalSel.dan.concat(finalSel.tuo).sort(ascNum);
    function detailOf(nums, roleOf) {
      return nums.map(function (n) {
        var o = nc.list.filter(function (x) { return x.num === n; })[0];
        return {
          num: n, crowd: o.crowd, parts: o.parts, rank: o.rank, role: roleOf(n)
        };
      });
    }
    var mainDetail = detailOf(mainNums, function (n) {
      if (finalSel.dan.indexOf(n) >= 0) return 'dan';
      return danCount ? 'tuo' : 'main';
    });
    var specialDetail = specialNums.map(function (n) {
      var o = sc.list.filter(function (x) { return x.num === n; })[0];
      return {
        num: n, crowd: o.crowd, parts: o.parts, rank: o.rank,
        role: sDan.indexOf(n) >= 0 ? 'sDan' : (sDanCount ? 'sTuo' : 'special')
      };
    });

    // E5 奖池派奖：与单式一致，仅作为提示交给"纪律模块"
    var notes = [];
    nc.calendar.notes.forEach(function (x) { notes.push(x); });
    var evtCount = Object.keys(nc.events).length;
    if (evtCount) notes.push('实时事件（E2）命中 ' + evtCount + ' 个号，与日历项叠加后调整拥挤度封顶 ±10%');
    if (hotPool.count) notes.push('热门号池收录 ' + hotPool.count + ' 个号（网络 + 手工双来源）');
    if (selfSet.count) {
      notes.push('历史自买（P4）' + selfSet.count +
        ' 个号：池内展开后有 ' + stats.selfInvalid + ' 注与其重合 ≥5 个，已按硬作废计入代价');
    }
    if (luckMain.sources.length) {
      notes.push('运气源 ' + luckMain.sources.length + ' 条，按半衰期 ' +
        LUCK_HALFLIFE_DAYS + ' 天衰减、单号封顶 +' + LUCK_CAP.toFixed(1));
    }
    notes.push('复式 / 胆拖无法逐注剔除，池内目标是"展开后的平均拥挤度最低、作废比例最小"');

    return {
      strategy: 'crowd',
      mode: 'pool',
      kind: kind,
      config: c,
      seed: seed,
      threshold: threshold,
      avoid: gamma,
      betType: betType,
      dtForm: form,
      counts: {
        mainSel: mainSel, specialSel: specialSel,
        danCount: danCount, tuoCount: tuoCount,
        sDanCount: sDanCount, sTuoCount: sTuoCount
      },
      pool: { main: mainNums, special: specialNums },
      dan: finalSel.dan.slice().sort(ascNum),
      tuo: finalSel.tuo.slice().sort(ascNum),
      sDan: sDan, sTuo: sTuo,
      mainDetail: mainDetail,
      specialDetail: specialDetail,
      need: need,
      bet: { combos: combos, mainCombos: mainCombos, specCombos: specCombos, yuanPerBet: 2 },
      expanded: stats,
      poolCrowd: nc.list,                 // 拥挤度从低到高
      specialCrowd: sc.list,
      hotPool: hotPool,
      selfPick: selfSet,
      luck: { main: luckMain, special: luckSpec },
      calendar: nc.calendar,
      events: nc.events,
      notes: notes,
      attempts: ev.evals(),
      windowSize: nc.list.length,
      latest: all[all.length - 1],
      prevMain: ctx.prevMain,
      sumMu: ctx.sumMu,
      sumSd: ctx.sumSd
    };
  }

  /* ============================================================
   * 10. 对外接口
   * ========================================================== */
  root.LCrowd = {
    generate: generate,
    buildPool: buildPool,
    buildNumberCrowd: buildNumberCrowd,
    buildSpecialCrowd: buildSpecialCrowd,
    buildContext: buildContext,
    hardFilters: hardFilters,
    structureFilters: structureFilters,
    crowdScore: crowdScore,
    luckBoost: luckBoost,
    parseHotPool: parseHotPool,
    parseSources: parseSources,
    extractNumbers: extractNumbers,
    calendarCrowd: calendarCrowd,
    longestRun: longestRun,
    maxSameTail: maxSameTail,
    isArithmetic: isArithmetic,
    isSymmetric: isSymmetric,
    CROWD_WEIGHTS: CROWD_WEIGHTS,
    POOL_PENALTY: POOL_PENALTY,
    TIERS: TIERS
  };
})(window);
