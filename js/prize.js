/* ============================================================
 * 中奖核对引擎 —— 纯函数，不碰 DOM，可以直接在 node 里单测
 *
 * 奖级依据官方现行规则：
 *   双色球：中彩官方规则（六等奖"中蓝球即得"；福运奖为特别规定期间加奖，不实现）
 *   大乐透：体彩现行规则（共 7 级；三~七等奖分「奖池 <8 亿 / ≥8 亿」两档）
 * 一、二等奖是浮动奖：只统计注数，不计算金额。
 *
 * 依赖：window.LC（lotto-core.js）
 * ========================================================== */
(function (root) {
  'use strict';

  var MAX_EXPAND = 50000;   // 展开注数上限：超过就不逐注判定，避免卡死页面

  function asc(a, b) { return a - b; }

  /* ---------------- 奖级表 ----------------
   * hit(m, s)：m = 主区命中个数，s = 特别区命中个数（按奖级从高到低排列）
   * fixed = 奖池 <8 亿档金额（双色球只有一档）
   * ge8   = 大乐透奖池 ≥8 亿档金额
   * float = 浮动奖
   */
  var RULES = {
    ssq: [
      { level: 1, name: '一等奖', cond: '6+1', float: true,
        hit: function (m, s) { return m === 6 && s === 1; } },
      { level: 2, name: '二等奖', cond: '6+0', float: true,
        hit: function (m, s) { return m === 6 && s === 0; } },
      { level: 3, name: '三等奖', cond: '5+1', fixed: 3000,
        hit: function (m, s) { return m === 5 && s === 1; } },
      { level: 4, name: '四等奖', cond: '5+0 或 4+1', fixed: 200,
        hit: function (m, s) { return (m === 5 && s === 0) || (m === 4 && s === 1); } },
      { level: 5, name: '五等奖', cond: '4+0 或 3+1', fixed: 10,
        hit: function (m, s) { return (m === 4 && s === 0) || (m === 3 && s === 1); } },
      { level: 6, name: '六等奖', cond: '中蓝球', fixed: 5,
        hit: function (m, s) { return s === 1 && m <= 2; } }
    ],
    dlt: [
      { level: 1, name: '一等奖', cond: '5+2', float: true,
        hit: function (m, s) { return m === 5 && s === 2; } },
      { level: 2, name: '二等奖', cond: '5+1', float: true,
        hit: function (m, s) { return m === 5 && s === 1; } },
      { level: 3, name: '三等奖', cond: '5+0 或 4+2', fixed: 5000, ge8: 6666,
        hit: function (m, s) { return (m === 5 && s === 0) || (m === 4 && s === 2); } },
      { level: 4, name: '四等奖', cond: '4+1', fixed: 300, ge8: 380,
        hit: function (m, s) { return m === 4 && s === 1; } },
      { level: 5, name: '五等奖', cond: '4+0 或 3+2', fixed: 150, ge8: 200,
        hit: function (m, s) { return (m === 4 && s === 0) || (m === 3 && s === 2); } },
      { level: 6, name: '六等奖', cond: '3+1 或 2+2', fixed: 15, ge8: 18,
        hit: function (m, s) { return (m === 3 && s === 1) || (m === 2 && s === 2); } },
      { level: 7, name: '七等奖', cond: '3+0 / 2+1 / 1+2 / 0+2', fixed: 5, ge8: 7,
        hit: function (m, s) {
          return (m === 3 && s === 0) || (m === 2 && s === 1) ||
            (m === 1 && s === 2) || (m === 0 && s === 2);
        } }
    ]
  };

  // 奖池档位：'lt8'（默认，奖池 <8 亿） / 'ge8'（奖池 ≥8 亿）
  function amountOf(rule, tier) {
    if (rule.float) return null;
    if (tier === 'ge8' && rule.ge8 != null) return rule.ge8;
    return rule.fixed;
  }

  function rulesOf(kind) { return RULES[kind] || []; }

  // 返回奖级编号，0 = 未中奖
  function levelOf(kind, mainHit, specHit) {
    var list = rulesOf(kind);
    for (var i = 0; i < list.length; i++) {
      if (list[i].hit(mainHit, specHit)) return list[i].level;
    }
    return 0;
  }

  function hitCount(nums, drawn) {
    var n = 0;
    for (var i = 0; i < nums.length; i++) {
      if (drawn.indexOf(nums[i]) >= 0) n++;
    }
    return n;
  }

  /* ---------------- 投注展开 ---------------- */

  // 枚举 arr 的 k 元子集（不截断，调用方先用 comb 判过上限）
  function kSubsets(arr, k) {
    var out = [], n = arr.length, cur = [];
    if (k < 0 || k > n) return out;
    if (k === 0) return [[]];
    (function rec(start) {
      if (cur.length === k) { out.push(cur.slice()); return; }
      for (var i = start; i < n; i++) {
        cur.push(arr[i]); rec(i + 1); cur.pop();
      }
    })(0);
    return out;
  }

  /* 把一张票展开成若干单式注 [{main, special}]
   * bet 结构（见 js/records.js）：
   *   单式    { type:'single',   tickets:[{main,special}] }
   *   复式    { type:'compound', main:[], special:[] }
   *   胆拖    { type:'dantuo',   main:[], special:[], dan:[], tuo:[], sDan:[], sTuo:[] }
   * 返回 { bets: [...] }；注数超过 MAX_EXPAND 时返回 { over:true, count:n }
   */
  function expand(bet, kind) {
    var LC = root.LC;
    var c = LC.cfg(kind);
    if (!bet) return { bets: [] };

    if (bet.type === 'single') {
      return {
        bets: (bet.tickets || []).map(function (t) {
          return { main: (t.main || []).slice(), special: (t.special || []).slice() };
        })
      };
    }

    var isDan = bet.type === 'dantuo';
    var mDan = isDan ? (bet.dan || []) : [];
    var sDan = isDan ? (bet.sDan || []) : [];
    // 某个区没设胆拖（dtForm = main / special）时，该区按复式展开
    var mainFrom = mDan.length ? (bet.tuo || []) : (bet.main || []);
    var specFrom = sDan.length ? (bet.sTuo || []) : (bet.special || []);
    var mainNeed = c.mainCount - mDan.length;
    var specNeed = c.specialCount - sDan.length;

    var total = LC.comb(mainFrom.length, mainNeed) * LC.comb(specFrom.length, specNeed);
    if (total > MAX_EXPAND) return { over: true, count: total };

    var ms = kSubsets(mainFrom, mainNeed);
    var ss = kSubsets(specFrom, specNeed);
    var bets = [];
    ms.forEach(function (m) {
      var mm = mDan.length ? mDan.concat(m).sort(asc) : m.slice();
      ss.forEach(function (s) {
        bets.push({
          main: mm.slice(),
          special: sDan.length ? sDan.concat(s).sort(asc) : s.slice()
        });
      });
    });
    return { bets: bets };
  }

  /* ---------------- 开奖期次 ---------------- */

  // 按日期找那一期（数据里 d 是 YYYY-MM-DD）
  function findDraw(kind, date) {
    if (!date) return null;
    var ds = root.LC.draws(kind) || [];
    for (var i = ds.length - 1; i >= 0; i--) {
      if (ds[i].d === date) return ds[i];
    }
    return null;
  }

  /* ---------------- 核对 ----------------
   * draw = { i, d, r:[], b:[] }
   * 返回：
   *   over       展开注数超限（不判定）
   *   bets       展开后的注数
   *   hit        是否至少中了一注
   *   levels     [{level, name, cond, count, per, sum, float}]（per/sum 为 null 即浮动奖）
   *   fixedTotal 固定奖合计
   *   perBet     单式时每一注的奖级（复式 / 胆拖为空数组）
   */
  function check(kind, bet, draw, opts) {
    opts = opts || {};
    var tier = opts.tier || 'lt8';
    var empty = {
      over: false, bets: 0, hit: false,
      levels: [], fixedTotal: 0, floatCounts: [], perBet: []
    };
    if (!draw) return empty;

    var ex = expand(bet, kind);
    if (ex.over) {
      return {
        over: true, count: ex.count, hit: false,
        levels: [], fixedTotal: 0, floatCounts: [], perBet: []
      };
    }

    var counts = {}, perBet = [];
    ex.bets.forEach(function (b) {
      var m = hitCount(b.main, draw.r || []);
      var s = hitCount(b.special, draw.b || []);
      var lv = levelOf(kind, m, s);
      perBet.push({ main: b.main, special: b.special, mainHit: m, specHit: s, level: lv });
      if (lv) counts[lv] = (counts[lv] || 0) + 1;
    });

    var levels = [], fixedTotal = 0, floatCounts = [];
    rulesOf(kind).forEach(function (r) {
      var n = counts[r.level] || 0;
      if (!n) return;
      var amt = amountOf(r, tier);
      levels.push({
        level: r.level, name: r.name, cond: r.cond, count: n,
        per: amt, sum: amt == null ? null : amt * n, float: !!r.float
      });
      if (amt == null) floatCounts.push({ level: r.level, name: r.name, count: n });
      else fixedTotal += amt * n;
    });

    return {
      over: false, bets: ex.bets.length, hit: levels.length > 0,
      levels: levels, fixedTotal: fixedTotal, floatCounts: floatCounts, perBet: perBet
    };
  }

  root.LP = {
    RULES: RULES,
    MAX_EXPAND: MAX_EXPAND,
    amountOf: amountOf,
    levelOf: levelOf,
    hitCount: hitCount,
    kSubsets: kSubsets,
    expand: expand,
    findDraw: findDraw,
    check: check
  };
})(window);
