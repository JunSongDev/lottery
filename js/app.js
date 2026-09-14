/* ============================================================
 * app.js — 界面逻辑
 * 依赖：LC / LS / LT / LM / Charts
 * ============================================================ */
(function () {
  'use strict';
  var LC = window.LC, LS = window.LS, LT = window.LT, LM = window.LM,
    LCrowd = window.LCrowd, Charts = window.Charts;

  var state = {
    kind: 'ssq',
    tab: 'recommend',
    window: 0,
    tickets: 5,
    betType: 'single',
    mainSel: null,
    specialSel: null,
    danCount: null,
    tuoCount: null,
    dtForm: 'main',      // 胆拖形式：main 主区胆拖 / special 特别区胆拖 / both 双区胆拖
    sTuoCount: null,     // 特别区（后区）拖码个数，胆码由官方规则固定为 1 个
    halflife: 30,
    seed: null,
    // 出号策略固定为「避拥挤」（对应 require.md），不再提供手动切换
    strategy: 'crowd',
    crowdMax: 60,        // 拥挤度上限，超过者不许输出
    hotPool: '',         // 热门号池（网络 + 手工双来源）
    luck: '',            // 运气源（每行一条，可带日期前缀）
    events: '',          // E2 实时事件数字（热搜 / 赛事比分 / 胜者编号）
    selfPick: '',        // P4 历史自买号码（自己以前买过的号）
    cache: {}
  };

  var BET_META = [
    { v: 'single', label: '单式' },
    { v: 'compound', label: '复式' },
    { v: 'dantuo', label: '胆拖' }
  ];

  var FACTOR_META = {
    freq: { name: '长期频率', color: '#6366f1', desc: '该号码在全历史中的出现次数偏离理论期望的程度' },
    omission: { name: '遗漏回归', color: '#f59e0b', desc: '按历史经验，处于当前遗漏期数区间的号码出现率提升' },
    hot: { name: '近期热度', color: '#ef4444', desc: '指数加权移动平均衡量的近期活跃度' },
    transition: { name: '转移关联', color: '#10b981', desc: '与上期开出号码的马尔可夫共现强度' }
  };

  // 组合拥挤度的五个维度（与 crowd.js 的 CROWD_WEIGHTS 一一对应）
  var CROWD_PART_META = {
    number: { name: '号码本身', color: '#6366f1', desc: '号码是否属于生日号 / 吉利尾 / 上期开出 / 长期热号' },
    pattern: { name: '形态扎堆', color: '#f59e0b', desc: '连号、同尾、等差、对称等"看起来有规律"的图形' },
    popular: { name: '大众偏好', color: '#ef4444', desc: '≤31 生日号扎堆、6/8/9 谐音凑堆、整体偏小号' },
    pool: { name: '热门池命中', color: '#db2777', desc: '与本期收录的热门号池（AI / 主播 / 热搜）重合程度' },
    history: { name: '历史重合', color: '#10b981', desc: '与近 30 期开出号码的平均重合度' }
  };

  // 单号拥挤度的六个来源
  var NUM_PART_META = {
    birthday: { name: '生日号偏好', color: '#f59e0b' },
    lucky: { name: '吉利尾数', color: '#ef4444' },
    small: { name: '小号偏好', color: '#a78bfa' },
    hot: { name: '长期热度', color: '#fb923c' },
    last: { name: '上期开出', color: '#db2777' },
    env: { name: '环境因子', color: '#06b6d4' }
  };

  var WINDOWS = [
    { v: 0, label: '全部' },
    { v: 1000, label: '近1000期' },
    { v: 500, label: '近500期' },
    { v: 300, label: '近300期' },
    { v: 100, label: '近100期' }
  ];

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function pct(x, d) { return (x * 100).toFixed(d == null ? 1 : d) + '%'; }

  function ballsHtml(nums, type) {
    return '<span class="balls">' + nums.map(function (n) {
      return '<i class="ball ball-' + type + '">' + pad2(n) + '</i>';
    }).join('') + '</span>';
  }

  function cacheKey(kind, extra) { return kind + '|' + state.window + '|' + (extra || ''); }

  function cached(kind, name, extra, factory) {
    var key = cacheKey(kind, name + '|' + (extra || ''));
    if (!state.cache[key]) state.cache[key] = factory();
    return state.cache[key];
  }

  /* ============================================================
   * 顶部：玩法切换 + 最新开奖
   * ========================================================== */

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // 顶部角标：玩法 · 期数 · 数据截止日期（鼠标悬停可看来源与最近一次联网核对）
  function renderBadge() {
    var c = LC.cfg(state.kind);
    var all = LC.draws(state.kind);
    var badge = $('#data-badge');
    if (!badge) return;
    var updated = c.updated || (all[all.length - 1] || {}).d || '—';
    badge.textContent = c.name + ' · ' + all.length + ' 期 · 数据至 ' + updated;

    var lines = [
      c.name + '：共 ' + all.length + ' 期',
      '数据截止：' + updated,
      '历史区间：' + (c.range || '—')
    ];
    if (c.source) lines.push('数据来源：' + c.source);
    var lv = window.LCLive && window.LCLive.last[state.kind];
    if (lv && lv.ok) {
      lines.push('最近核对：' + fmtTime(lv.at) + '（' + lv.label +
        (lv.fromCache ? ' · 会话缓存' : '') + '）');
    } else if (lv) {
      lines.push('最近核对：' + fmtTime(lv.at) + ' 失败（' + (lv.error || '未知') +
        '），仍使用本地数据');
    } else {
      lines.push('最近核对：进行中…');
    }
    badge.title = lines.join('\n');
  }

  function renderHero() {
    var c = LC.cfg(state.kind);
    var all = LC.draws(state.kind);
    var last = all[all.length - 1];
    var prev = all[all.length - 2];

    renderBadge();

    var sum = LC.sum(last.r);
    var odd = LC.oddCount(last.r), big = LC.bigCount(last.r, c);
    var span = LC.span(last.r);
    var repeat = LC.repeatCount(last.r, prev.r);

    $('#latest').innerHTML =
      '<div class="latest-head">' +
      '<span class="latest-issue">第 ' + last.i + ' 期</span>' +
      '<span class="latest-date">' + last.d + '</span>' +
      '</div>' +
      '<div class="latest-balls">' + ballsHtml(last.r, 'main') +
      '<span class="ball-sep">+</span>' + ballsHtml(last.b, 'special') + '</div>' +
      '<div class="latest-metrics">' +
      '<span>和值 <b>' + sum + '</b></span>' +
      '<span>跨度 <b>' + span + '</b></span>' +
      '<span>奇偶 <b>' + odd + ':' + (c.mainCount - odd) + '</b></span>' +
      '<span>大小 <b>' + big + ':' + (c.mainCount - big) + '</b></span>' +
      '<span>重号 <b>' + repeat + '</b></span>' +
      '</div>' +
      '<button class="latest-history-link" id="btn-history-2" type="button">' +
      '查询历史开奖记录（共 ' + all.length + ' 期）</button>';

    $('#btn-history-2').addEventListener('click', function () { showHistoryPage(); });
  }

  /* ============================================================
   * 面板 1：智能推荐
   * ========================================================== */
  function clampNum(v, lo, hi, dflt) {
    if (v == null || isNaN(Number(v))) return dflt;
    return Math.min(Math.max(Math.round(Number(v)), lo), hi);
  }

  // 单式的推荐注数：几个常用值做快捷芯片，其余用输入框自定义
  var TICKET_PRESETS = [3, 5, 10];
  var TICKET_MIN = 1;
  var TICKET_MAX = 50;
  var TICKET_DEFAULT = 5;

  function isPresetTickets(n) { return TICKET_PRESETS.indexOf(n) >= 0; }

  function betOpts() { return LM.betOptions(state.kind); }

  // 把 state 中的投注参数按当前玩法的可选范围钳制后返回
  function betParams() {
    var bo = betOpts();
    var p = { betType: state.betType };
    if (state.betType === 'compound') {
      p.mainSel = clampNum(state.mainSel, bo.mainSelMin, bo.mainSelMax, bo.mainSelMin);
      p.specialSel = clampNum(state.specialSel, bo.specialSelMin, bo.specialSelMax, bo.specialSelMin);
    } else if (state.betType === 'dantuo') {
      p.dtForm = (bo.supportsSpecialDantuo && (state.dtForm === 'special' || state.dtForm === 'both'))
        ? state.dtForm : 'main';
      if (p.dtForm === 'main') {
        p.specialSel = clampNum(state.specialSel, bo.specialSelMin, bo.specialSelMax, bo.specialSelMin);
      } else {
        // 特别区胆码由官方规则固定为 1 个，只让用户配拖码个数
        p.sDanCount = bo.specDanMin;
        p.sTuoCount = clampNum(state.sTuoCount, bo.specTuoMin, bo.specTuoMax, bo.specTuoMin);
      }
      if (p.dtForm !== 'special') {
        p.danCount = clampNum(state.danCount, bo.danMin, bo.danMax, bo.danMin);
        p.tuoCount = clampNum(state.tuoCount, tuoMinFor(p.danCount), tuoMaxFor(p.danCount),
          tuoMinFor(p.danCount));
      }
    } else {
      p.tickets = clampNum(state.tickets, TICKET_MIN, TICKET_MAX, TICKET_DEFAULT);
    }
    return p;
  }

  // 官方：胆码 + 拖码 ≥ 基本号码数 + 1（拖码至少比单式多出 1 个号码）
  function tuoMinFor(danCount) {
    var bo = betOpts();
    return Math.max(bo.mainCount + bo.tuoExtraMin - danCount, 1);
  }

  function tuoMaxFor(danCount) {
    var bo = betOpts();
    var tuoMin = tuoMinFor(danCount);
    return Math.max(tuoMin, Math.min(bo.mainSelMax - danCount, bo.mainPool - danCount));
  }

  function buildRecommendation(forceNewSeed) {
    if (forceNewSeed) state.seed = (Date.now() & 0x7fffffff);
    var seed = state.seed || (state.seed = (Date.now() & 0x7fffffff));
    var kind = state.kind;
    var params = betParams();
    // 「避拥挤」：单式走逐注抽样，复式 / 胆拖走号码池优化
    var useCrowd = state.strategy === 'crowd';
    var key = kind + '|' + state.window + '|' + state.halflife + '|' + state.strategy + '|' +
      [params.betType, params.dtForm, params.mainSel, params.specialSel,
        params.danCount, params.tuoCount, params.sDanCount, params.sTuoCount,
        params.tickets].join(',') +
      '|' + state.hotPool + '|' + state.events + '|' + state.selfPick +
      '|' + state.luck + '|' + crowdPlanKey() + '|' + state.crowdMax +
      '|' + ((useCrowd || params.betType === 'single') ? seed : 'det');
    if (forceNewSeed) delete state.cache[key];
    if (!state.cache[key]) {
      if (useCrowd && params.betType === 'single') {
        state.cache[key] = LCrowd.generate(kind, {
          window: state.window,
          seed: seed,
          hotPool: state.hotPool,
          events: state.events,
          selfPick: state.selfPick,
          luck: state.luck,
          tiers: crowdPlan(),
          crowdMax: state.crowdMax
        });
      } else if (useCrowd) {
        state.cache[key] = LCrowd.buildPool(kind, {
          window: state.window,
          seed: seed,
          hotPool: state.hotPool,
          events: state.events,
          selfPick: state.selfPick,
          luck: state.luck,
          crowdMax: state.crowdMax,
          betType: params.betType,
          mainSel: params.mainSel,
          specialSel: params.specialSel,
          dtForm: params.dtForm,
          danCount: params.danCount,
          tuoCount: params.tuoCount,
          sDanCount: params.sDanCount,
          sTuoCount: params.sTuoCount
        });
      } else {
        var opt = {
          window: state.window,
          halflife: state.halflife,
          samples: 20000,
          seed: seed,
          betType: params.betType
        };
        if (params.betType === 'single') {
          opt.tickets = params.tickets;
        } else {
          opt.mainSel = params.mainSel;
          opt.specialSel = params.specialSel;
          if (params.betType === 'dantuo') {
            opt.dtForm = params.dtForm;
            opt.danCount = params.danCount;
            opt.tuoCount = params.tuoCount;
            opt.sDanCount = params.sDanCount;
            opt.sTuoCount = params.sTuoCount;
          }
        }
        state.cache[key] = LM.recommend(kind, opt);
      }
    }
    return state.cache[key];
  }

  /* ---------- 避拥挤：出号分层（按总注数自适应均分） ---------- */

  var TIER_ORDER = ['full', 'sqrt', 'uniform'];
  var TIER_LABEL = { full: '全权重', sqrt: '权重开方', uniform: '近乎均匀' };

  // 把总注数自适应均分到三层：
  //   能被 3 整除 → 三等分（1:1:1）；
  //   否则先各取 ⌊n/3⌋，余下的 1~2 注依次补给 全权重 → 开方 → 均匀，
  //   保证三层份数最多相差 1 注，且合计恒等于总注数。
  function splitTiers(total) {
    var n = Math.max(1, clampNum(total, 1, 999, TICKET_DEFAULT));
    var base = Math.floor(n / TIER_ORDER.length);
    var plan = {};
    TIER_ORDER.forEach(function (k) { plan[k] = base; });
    for (var i = 0; i < n % TIER_ORDER.length; i++) plan[TIER_ORDER[i]]++;
    return plan;
  }

  // 分层注数完全由"推荐注数"派生，用户不再逐层选择
  function crowdPlan() { return splitTiers(betParams().tickets); }

  function crowdPlanKey() {
    var t = crowdPlan();
    return TIER_ORDER.map(function (k) { return t[k]; }).join(',');
  }

  function crowdTotal() {
    var t = crowdPlan();
    return TIER_ORDER.reduce(function (s, k) { return s + t[k]; }, 0);
  }

  // 「2 注全权重 · 2 注权重开方 · 1 注近乎均匀」
  function tierPlanText(plan) {
    return TIER_ORDER.filter(function (k) { return plan[k] > 0; })
      .map(function (k) { return plan[k] + ' 注' + TIER_LABEL[k]; })
      .join(' · ');
  }

  function tierAllocHint() {
    return '分层自动分配：' + tierPlanText(crowdPlan()) + '（共 ' + crowdTotal() + ' 注）。' +
      '注数能被 3 整除时三层等分，否则余数依次补给 全权重 → 开方 → 均匀，三层最多相差 1 注。';
  }

  /* ---------- 设置区：投注方式与参数 ---------- */

  function numChips(attr, from, to, active, unit) {
    var out = '';
    for (var n = from; n <= to; n++) {
      out += '<button class="chip' + (n === active ? ' active' : '') +
        '" data-' + attr + '="' + n + '">' + n + (unit || '') + '</button>';
    }
    return '<div class="chips">' + out + '</div>';
  }

  function betNote(c, bo, p) {
    if (p.betType === 'compound') {
      return '<p class="hint">在基本号码之外多选号，系统自动展开为多注。注数 = C(' +
        c.mainLabel + '个数, ' + c.mainCount + ') × C(' + c.specialLabel + '个数, ' +
        c.specialCount + ')，每注 ' + bo.yuanPerBet + ' 元。</p>';
    }
    if (p.betType === 'dantuo') {
      var risk = '<b>胆码一旦不中，可能整单落空。</b>';
      if (p.dtForm === 'special') {
        return '<p class="hint">' + c.mainLabel + '不设胆拖，直接选满 ' + c.mainCount +
          ' 个号码；' + c.specialLabel + '取 1 个胆码（官方规则固定 1 个）+ 若干拖码，' +
          '每注再从拖码中补足 ' + (c.specialCount - 1) + ' 个。注数 = C(' + c.specialLabel +
          '拖码个数, ' + (c.specialCount - 1) + ')，每注 ' + bo.yuanPerBet + ' 元。' + risk + '</p>';
      }
      var mPart = 'C(' + c.mainLabel + '拖码个数, ' + c.mainCount + ' − ' + c.mainLabel + '胆码个数)';
      var sPart;
      if (p.dtForm === 'both') {
        sPart = ' × C(' + c.specialLabel + '拖码个数, ' + (c.specialCount - 1) + ')';
      } else {
        sPart = ' × C(' + c.specialLabel + '个数, ' + c.specialCount + ')';
      }
      return '<p class="hint">胆码为每注都包含的核心号，拖码用于补足剩余位置（官方要求胆码 + ' +
        '拖码 ≥ ' + (c.mainCount + bo.tuoExtraMin) + ' 个）。注数 = ' + mPart + sPart +
        '，每注 ' + bo.yuanPerBet + ' 元。' + risk + '</p>';
    }
    return '<p class="hint">每注 ' + c.mainCount + ' 个' + c.mainLabel + ' + ' +
      c.specialCount + ' 个' + c.specialLabel + '，每注 ' + bo.yuanPerBet + ' 元。</p>';
  }

  function betPreview(c, bo, p) {
    var combos;
    if (p.betType === 'compound') {
      combos = LC.comb(p.mainSel, c.mainCount) * LC.comb(p.specialSel, c.specialCount);
    } else if (p.betType === 'dantuo') {
      var mainPart = p.dtForm === 'special'
        ? 1 : LC.comb(p.tuoCount, c.mainCount - p.danCount);
      var specPart = p.dtForm === 'main'
        ? LC.comb(p.specialSel, c.specialCount)
        : LC.comb(p.sTuoCount, c.specialCount - p.sDanCount);
      combos = mainPart * specPart;
    } else {
      // 避拥挤策略下注数由出号分层决定，与"推荐注数"无关
      combos = (state.strategy === 'crowd') ? Math.max(crowdTotal(), 1) : p.tickets;
    }
    return { combos: combos, cost: combos * bo.yuanPerBet };
  }

  function previewHtml(pv) {
    return '<div class="bet-preview" id="bet-preview"><span>预计</span><b>' +
      pv.combos.toLocaleString() + ' 注</b><span>·</span><b>' +
      pv.cost.toLocaleString() + ' 元</b></div>';
  }

  function betParamFields(c, bo, p) {
    var fields = '';
    if (p.betType === 'compound') {
      fields += '<div class="field"><label>' + c.mainLabel + '选号个数（基本 ' + c.mainCount + ' 个）</label>' +
        numChips('msel', bo.mainSelMin, bo.mainSelMax, p.mainSel, ' 个') + '</div>';
      fields += '<div class="field"><label>' + c.specialLabel + '选号个数（基本 ' + c.specialCount + ' 个）</label>' +
        numChips('ssel', bo.specialSelMin, bo.specialSelMax, p.specialSel, ' 个') + '</div>';
    } else if (p.betType === 'dantuo') {
      // 特别区只在"每注取 2 个及以上号码"时才存在官方认可的胆拖（大乐透后区）
      if (bo.supportsSpecialDantuo) {
        var formChips = ['main', 'special', 'both'].map(function (v) {
          return '<button class="chip' + (p.dtForm === v ? ' active' : '') +
            '" data-dtform="' + v + '">' + LM.dtFormLabel(state.kind, v) + '</button>';
        }).join('');
        fields += '<div class="field"><label>胆拖形式</label><div class="chips">' +
          formChips + '</div></div>';
      }
      if (p.dtForm !== 'special') {
        fields += '<div class="field"><label>' + c.mainLabel + '胆码个数（每注必含，上限 ' + bo.danMax + '）</label>' +
          numChips('dan', bo.danMin, bo.danMax, p.danCount, ' 胆') + '</div>';
        fields += '<div class="field"><label>' + c.mainLabel + '拖码个数（胆码 + 拖码 ≥ ' +
          (c.mainCount + bo.tuoExtraMin) + ' 个）</label>' +
          numChips('tuo', tuoMinFor(p.danCount), tuoMaxFor(p.danCount), p.tuoCount, ' 拖') + '</div>';
      }
      if (p.dtForm === 'main') {
        fields += '<div class="field"><label>' + c.specialLabel + '选号个数（基本 ' + c.specialCount + ' 个）</label>' +
          numChips('ssel', bo.specialSelMin, bo.specialSelMax, p.specialSel, ' 个') + '</div>';
      } else {
        fields += '<div class="field"><label>' + c.specialLabel + '拖码个数（胆码固定 ' + p.sDanCount +
          ' 个，每注再从拖码配 ' + (c.specialCount - p.sDanCount) + ' 个）</label>' +
          numChips('stuo', bo.specTuoMin, bo.specTuoMax, p.sTuoCount, ' 拖') + '</div>';
      }
    } else {
      fields += ticketFields(p, '推荐注数（' + TICKET_MIN + '–' + TICKET_MAX +
        ' 注，可在输入框里自定义）');
    }
    var pv = betPreview(c, bo, p);
    fields += previewHtml(pv);
    return fields;
  }

  /* ---------- 避拥挤策略：设置区字段 ---------- */

  // 单式的「推荐注数」：快捷芯片 + 自定义输入框（避拥挤下同时决定三层分层注数）
  function ticketFields(p, label) {
    var ticketChips = TICKET_PRESETS.map(function (n) {
      return '<button class="chip' + (p.tickets === n ? ' active' : '') +
        '" data-tickets="' + n + '">' + n + ' 注</button>';
    }).join('');
    return '<div class="field"><label>' + label + '</label>' +
      '<div class="chips">' + ticketChips +
      '<label class="chip-input' + (isPresetTickets(p.tickets) ? '' : ' active') +
      '" for="tickets-input">' +
      '<input id="tickets-input" type="number" inputmode="numeric" ' +
      'min="' + TICKET_MIN + '" max="' + TICKET_MAX + '" step="1" ' +
      'value="' + p.tickets + '" aria-label="自定义推荐注数">' +
      '<span class="chip-input-unit">注</span>' +
      '</label></div></div>';
  }

  function crowdTierFields(c, bo) {
    var p = betParams();
    return ticketFields(p, '推荐注数（' + TICKET_MIN + '–' + TICKET_MAX +
      ' 注，三层自适应均分）') +
      '<p class="hint" id="tier-alloc">' + tierAllocHint() + '</p>' +
      previewHtml(betPreview(c, bo, p));
  }

  function crowdThresholdField() {
    var opts = [45, 50, 55, 60];
    var chips = opts.map(function (n) {
      return '<button class="chip' + (state.crowdMax === n ? ' active' : '') +
        '" data-crowdmax="' + n + '">≤ ' + n + '</button>';
    }).join('');
    return '<div class="field"><label>拥挤度上限（超过即重新抽样，越低越保守）</label>' +
      '<div class="chips">' + chips + '</div></div>';
  }

  // 复式 / 胆拖下的说明：为什么换成"号码池"目标
  function crowdPoolHint() {
    return '<p class="hint">复式 / 胆拖买的是"一批号码"：一张票展开成多注，每注拥挤度各不相同，' +
      '票面没有单一拥挤度，也没法把其中某几注剔除。所以这里改为优化<b>号码池</b>——' +
      '池子大小由上面的选号个数决定，系统把池子展开后的全部组合一起评价，' +
      '让平均拥挤度最低、踩中 P0/P1 与形态要求的比例最小。</p>' +
      '<p class="hint">注意：展开后仍会有少量形态越界组合（无法逐注剔除），' +
      '结果页会标注实际比例，并把它们计入"池子代价"压到最低。</p>';
  }

  function crowdSourceFields() {
    return '<div class="field"><label>热门号池（AI 荐号 / 主播 / 群聊合买，空格或逗号分隔）</label>' +
      '<textarea id="hotpool-input" class="ta" rows="2" ' +
      'placeholder="例如：8 18 28 33">' + esc(state.hotPool) + '</textarea>' +
      '<p class="hint">P3 拥挤黑名单：命中 ≥5 个直接作废，命中越少拥挤度越低。</p></div>' +
      '<div class="field"><label>实时事件数字（热搜数字 / 赛事比分 / 胜者编号，空格或逗号分隔）</label>' +
      '<textarea id="events-input" class="ta" rows="2" ' +
      'placeholder="例如：3 比 1&#10;胜者 7 号球衣 39&#10;热搜 618">' + esc(state.events) + '</textarea>' +
      '<p class="hint">E2 实时事件：数字同样按七条映射落到号码池，与日历项（E1）一起构成环境项，' +
      '对单号拥挤度的调整封顶 ±10%（E4）。</p></div>' +
      '<div class="field"><label>历史自买号码（自己以前买过的号，空格或逗号分隔）</label>' +
      '<textarea id="selfpick-input" class="ta" rows="2" ' +
      'placeholder="例如：3 11 19 22 28 31 + 9">' + esc(state.selfPick) + '</textarea>' +
      '<p class="hint">P4 自我重复：与历史自买号码重合 ≥5 个直接作废，' +
      '本次各注之间也会限制重号数，避免"自己再撞自己"。</p></div>' +
      '<div class="field"><label>运气源（每行一条，可在行首写日期 YYYY-MM-DD）</label>' +
      '<textarea id="luck-input" class="ta" rows="3" ' +
      'placeholder="2026-09-12 大奖得主球衣 39 号&#10;暴涨代码 0.618&#10;锦鲤序号 88">' +
      esc(state.luck) + '</textarea>' +
      '<p class="hint">L 欧气因子：本体 · 数位 · 取模 · 数根 · 邻域 · 日期拆解 · 小数缩减 七条映射，' +
      '半衰期 7 天、单号封顶 +3.0，全来源叠加后用于加权抽样。</p></div>';
  }

  /* ---------- 单式注数：快捷芯片与自定义输入框的联动 ---------- */

  // 同步芯片高亮：命中预设值则点亮对应芯片，否则点亮输入框
  function syncTicketPicks(panel, n) {
    $$('.chip[data-tickets]', panel).forEach(function (b) {
      b.classList.toggle('active', Number(b.dataset.tickets) === n);
    });
    var box = $('.chip-input', panel);
    if (box) box.classList.toggle('active', !isPresetTickets(n));
  }

  // 即时刷新"预计 X 注 · Y 元"与分层分配文案（不重建 DOM，避免输入时丢焦点）
  function updateBetPreview(panel) {
    var box = $('#bet-preview', panel);
    if (box) {
      var pv = betPreview(LC.cfg(state.kind), betOpts(), betParams());
      box.innerHTML = '<span>预计</span><b>' + pv.combos.toLocaleString() +
        ' 注</b><span>·</span><b>' + pv.cost.toLocaleString() + ' 元</b>';
    }
    var alloc = $('#tier-alloc', panel);
    if (alloc) alloc.textContent = tierAllocHint();
  }

  // 输入非法（空值 / 越界 / 非数字）时给外框标红，失焦时再拉回合法区间
  function markTicketsInvalid(panel, on) {
    var box = $('.chip-input', panel);
    if (box) box.classList.toggle('invalid', !!on);
  }

  // 失焦 / 回车：把越界的输入就地拉回合法区间（清空则退回上一次的合法值）
  function normalizeTickets(panel, input) {
    var raw = String(input.value).trim();
    var n = raw === '' ? state.tickets : clampNum(raw, TICKET_MIN, TICKET_MAX, state.tickets);
    state.tickets = n;
    input.value = String(n);
    markTicketsInvalid(panel, false);
    syncTicketPicks(panel, n);
    updateBetPreview(panel);
  }

  function betLabel(type) {
    for (var i = 0; i < BET_META.length; i++) {
      if (BET_META[i].v === type) return BET_META[i].label;
    }
    return '';
  }

  /* ============================================================
   * 页面栈：二级页像 App / 小程序那样整页滑入滑出
   *   · 一级界面（hero + tabs + 面板）始终留在 DOM 中，
   *     返回时滚动位置、已选参数与事件绑定都原样保留；
   *   · 推入 / 返回接入 History API，手机侧滑返回、浏览器返回键、
   *     安卓物理返回键都能退回一级界面；
   *   · 支持从左边缘右滑跟手返回。
   * ========================================================== */
  var PAGE_DUR = 380;          // 与 CSS 的 --page-dur 保持一致
  var stack = [];              // 已打开的页面名（只支持一层）
  var mounted = {};            // 页面名 → 页面元素，避免动画期间重名冲突
  var unmountTimers = {};
  var historyPushed = false;   // 是否已压入一条历史记录，决定返回时能否用 history.back()
  var closing = false;         // 防止返回动画期间重复触发 history.back()
  var recTimer = null;
  var dragging = false;

  function activePage() { return stack.length ? stack[stack.length - 1] : null; }

  // 0 → 一级界面原样；1 → 二级页完全展开（由 --push 驱动视差）
  function setPush(v) {
    document.body.style.setProperty('--push', Math.max(0, Math.min(1, v)).toFixed(4));
  }

  function pushHistory(name) {
    if (!window.history || !window.history.pushState) return;
    try {
      window.history.pushState({ lottoPage: name }, '');
      historyPushed = true;
    } catch (e) { /* file:// 或隐私模式下可能受限，退化为纯动画 */ }
  }

  function mountPage(name, html) {
    var layer = $('#page-layer');
    if (!layer) return null;
    if (unmountTimers[name]) {         // 上一次出场动画未播完：先清掉旧节点
      clearTimeout(unmountTimers[name]);
      unmountTimers[name] = null;
      unmountPage(name);
    }
    var el = document.createElement('section');
    el.className = 'page';
    el.id = 'page-' + name;
    el.innerHTML = '<div class="page-view">' + html + '</div>';
    layer.appendChild(el);
    void el.offsetWidth;              // 先落位到 translateX(100%)，再触发过渡
    el.classList.add('is-active');
    document.body.classList.add('page-pushed');
    setPush(1);
    stack.push(name);
    mounted[name] = el;
    bindEdgeBack(el, name);
    return el;
  }

  function unmountPage(name) {
    var el = mounted[name];
    delete mounted[name];
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function popPage() {
    var name = activePage();
    if (!name) return;
    stack.pop();
    closing = false;
    if (recTimer) { clearTimeout(recTimer); recTimer = null; }
    var el = mounted[name];
    if (el) {
      el.classList.remove('is-active');
      unmountTimers[name] = setTimeout(function () {
        unmountTimers[name] = null;
        unmountPage(name);
      }, PAGE_DUR + 60);
    }
    document.body.classList.toggle('page-pushed', stack.length > 0);
    setPush(stack.length > 0 ? 1 : 0);
  }

  // 所有"返回"入口都走这里：优先 history.back()，让浏览器历史与页面栈保持一致
  function closePage() {
    var name = activePage();
    if (!name || closing) return;
    closing = true;
    if (historyPushed && window.history && window.history.back) {
      try { window.history.back(); } catch (e) { popPage(); }
      // 兜底：万一 popstate 没来（历史记录被外部替换），也要把页面收起来
      setTimeout(function () { if (activePage() === name) popPage(); }, 400);
      return;
    }
    popPage();
  }

  function openPage(name, html, opts) {
    if (activePage() === name) return null;
    var el = mountPage(name, html);
    if (!(opts && opts.noHistory)) pushHistory(name);
    return el;
  }

  // 从左边缘右滑返回：跟手位移，松手后按距离与速度决定返回或回弹
  function bindEdgeBack(el, name) {
    var view = el.firstChild;
    if (!view || !view.addEventListener || !window.PointerEvent) return;
    var w = 0, x0 = 0, y0 = 0, dx = 0, t0 = 0, tracking = false;

    function onDown(e) {
      if (activePage() !== name || e.clientX > 32) return;   // 只在左边缘起手
      if (e.target && e.target.closest && e.target.closest('.back-btn')) return;
      w = Math.max(window.innerWidth || 360, 1);
      x0 = e.clientX; y0 = e.clientY; t0 = Date.now();
      dx = 0; tracking = true;
    }

    function onMove(e) {
      if (!tracking) return;
      dx = e.clientX - x0;
      var dy = e.clientY - y0;
      // 纵向为主的滑动交还给页面滚动
      if (dx <= 0 || (!dragging && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10)) {
        if (Math.abs(dx) > 12 || Math.abs(dy) > 12) tracking = false;
        return;
      }
      if (!dragging) { dragging = true; document.body.classList.add('page-dragging'); }
      view.style.transform = 'translateX(' + Math.min(dx, w) + 'px)';
      setPush(1 - Math.min(dx / w, 1));
    }

    function finish() {
      if (!dragging) { tracking = false; return; }
      dragging = false;
      tracking = false;
      document.body.classList.remove('page-dragging');
      view.style.transform = '';
      // 滑过 30% 宽度即返回；距离不足时，只有"短促快甩"（≥48px 且够快）才返回
      var elapsed = Date.now() - t0;
      var speed = elapsed > 0 ? dx / elapsed : 0;
      if (dx > w * 0.3 || (speed > 0.6 && dx > 48)) closePage(); else setPush(1);
    }

    view.addEventListener('pointerdown', onDown);
    view.addEventListener('pointermove', onMove);
    view.addEventListener('pointerup', finish);
    view.addEventListener('pointercancel', finish);
  }

  // 浏览器 / 安卓返回键、手势返回
  if (window.addEventListener) {
    window.addEventListener('popstate', function (e) {
      var st = e.state || {};
      if (!st.lottoPage && activePage()) {
        historyPushed = false;                // 返回：收起二级页
        popPage();
      } else if (st.lottoPage && !activePage()) {
        // 前进：按历史记录里的页面名恢复对应的二级页
        historyPushed = true;
        if (st.lottoPage === 'draw-history') showHistoryPage({ noHistory: true });
        else showResultPage(null, { noHistory: true });
      }
    });
  }

  // 二级页标题：胆拖要区分主区 / 特别区 / 双区
  function recBetLabel(p) {
    if (state.strategy === 'crowd') {
      if (p.betType === 'single') return '避拥挤';
      return '避拥挤 · ' + (p.betType === 'dantuo'
        ? LM.dtFormLabel(state.kind, p.dtForm) : betLabel(p.betType));
    }
    if (p.betType === 'dantuo') return LM.dtFormLabel(state.kind, p.dtForm);
    return betLabel(p.betType);
  }

  /* ---------- 二级页：推荐号码 ---------- */
  function resultPageHtml(c, p, pv) {
    // 换一批：单式与避拥挤（单式 / 号码池）都由种子驱动，可复现
    var canRegen = state.betType === 'single' || state.strategy === 'crowd';
    return '<header class="page-nav">' +
      '<button class="back-btn" id="btn-back" aria-label="返回设置">‹</button>' +
      '<div class="page-nav-text">' +
      '<b>' + recBetLabel(p) + '推荐号码</b>' +
      '<span>' + c.name + ' · ' + pv.combos.toLocaleString() + ' 注 · ' +
      pv.cost.toLocaleString() + ' 元</span>' +
      '</div>' +
      '</header>' +
      // 操作栏常驻顶部：号码再多也不用滚到底部去找"换一批"
      '<div class="page-actions">' +
      '<div class="gen-actions' + (canRegen ? ' two' : '') + '">' +
      '<button class="btn-ghost" id="btn-back-2">返回修改设置</button>' +
      (canRegen ? '<button class="btn-primary" id="btn-regenerate">换一批号码</button>' : '') +
      '</div>' +
      '</div>' +
      '<div class="page-scroll">' +
      '<div id="rec-result"><div class="loading">正在计算推荐号码…</div></div>' +
      '</div>';
  }

  function showResultPage(forceNewSeed, opts) {
    var c = LC.cfg(state.kind);
    var p = betParams();
    var pv = betPreview(c, betOpts(), p);

    if (!openPage('rec-result', resultPageHtml(c, p, pv), opts)) return;

    $('#btn-back').addEventListener('click', closePage);
    $('#btn-back-2').addEventListener('click', closePage);
    var rg = $('#btn-regenerate');
    if (rg) {
      rg.addEventListener('click', function () {
        state.seed = (Date.now() & 0x7fffffff);
        renderRecommendTickets(true);
        // 操作栏钉在顶部，换号后把列表拉回开头，方便从头看新号码
        var sc = $('.page-scroll');
        if (sc && sc.scrollTo) {
          try { sc.scrollTo({ top: 0, behavior: 'smooth' }); }
          catch (e) { sc.scrollTop = 0; }
        }
      });
    }

    recTimer = setTimeout(function () {
      recTimer = null;
      renderRecommendTickets(forceNewSeed);
    }, 20);
  }

  /* ---------- 二级页：历史开奖记录 ---------- */

  var HIST_CHUNK = 40;                    // 每批渲染条数，避免一次性插入几千个节点
  var hist = { q: '', shown: 0, items: null };

  // 期号 / 日期关键词归一化：「第 2026105 期」「2026 09 10」都能查
  function histNorm(q) { return String(q || '').replace(/[第期\s]/g, ''); }

  // 按期号倒序取出开奖记录，并附带"上一期"（用于计算重号）
  function histItems(kind, q) {
    var all = LC.draws(kind);
    var s = histNorm(q);
    var out = [];
    for (var i = all.length - 1; i >= 0; i--) {
      var dr = all[i];
      if (s && String(dr.i).indexOf(s) < 0 && dr.d.indexOf(s) < 0) continue;
      out.push({ dr: dr, prev: i > 0 ? all[i - 1] : null });
    }
    return out;
  }

  function histRowHtml(c, dr, prev) {
    var sum = LC.sum(dr.r);
    var odd = LC.oddCount(dr.r);
    var big = LC.bigCount(dr.r, c);
    var repeat = prev ? LC.repeatCount(dr.r, prev.r) : 0;
    return '<div class="hist-row">' +
      '<div class="hist-row-head">' +
      '<span class="latest-issue">第 ' + dr.i + ' 期</span>' +
      '<span class="hist-date">' + dr.d + '</span>' +
      '</div>' +
      '<div class="latest-balls">' + ballsHtml(dr.r, 'main') +
      '<span class="ball-sep">+</span>' + ballsHtml(dr.b, 'special') + '</div>' +
      '<div class="latest-metrics">' +
      '<span>和值 <b>' + sum + '</b></span>' +
      '<span>跨度 <b>' + LC.span(dr.r) + '</b></span>' +
      '<span>奇偶 <b>' + odd + ':' + (c.mainCount - odd) + '</b></span>' +
      '<span>大小 <b>' + big + ':' + (c.mainCount - big) + '</b></span>' +
      '<span>重号 <b>' + repeat + '</b></span>' +
      '</div>' +
      '</div>';
  }

  function historyPageHtml(c) {
    var all = LC.draws(state.kind);
    return '<header class="page-nav">' +
      '<button class="back-btn" id="btn-back" aria-label="返回">‹</button>' +
      '<div class="page-nav-text">' +
      '<b>历史开奖记录</b>' +
      '<span>' + c.name + ' · 共 ' + all.length + ' 期 · ' +
      all[0].d + ' ~ ' + all[all.length - 1].d + '</span>' +
      '</div>' +
      '</header>' +
      '<div class="page-actions">' +
      '<div class="hist-search">' +
      '<input id="hist-input" type="search" class="search-input" ' +
      'placeholder="按期号或日期查询，如 2026105 / 2026-09-10">' +
      '<button class="btn-ghost" id="btn-hist-reset" type="button">清除</button>' +
      '</div>' +
      '</div>' +
      '<div class="page-scroll">' +
      '<div id="hist-summary"></div>' +
      '<div id="hist-list"></div>' +
      '<div class="hist-more" id="hist-more"></div>' +
      '</div>';
  }

  // reset=true 重新计算匹配结果并清空列表；否则继续渲染下一批
  function renderHistList(reset) {
    var box = $('#hist-list');
    if (!box) return;
    var c = LC.cfg(state.kind);

    if (reset) {
      var input = $('#hist-input');
      hist.q = input ? input.value : '';
      hist.items = histItems(state.kind, hist.q);
      hist.shown = 0;
      box.innerHTML = '';
    }

    var items = hist.items || [];
    var end = Math.min(items.length, hist.shown + HIST_CHUNK);
    if (end > hist.shown) {
      box.insertAdjacentHTML('beforeend', items.slice(hist.shown, end).map(function (it) {
        return histRowHtml(c, it.dr, it.prev);
      }).join(''));
      hist.shown = end;
    }

    var sum = $('#hist-summary');
    if (sum) {
      sum.innerHTML = items.length
        ? '<p class="hint">共匹配 <b>' + items.length + '</b> 期' +
        (histNorm(hist.q) ? '（关键词：' + esc(histNorm(hist.q)) + '）' : '') +
        '，已显示 ' + hist.shown + ' 期。' +
        (histNorm(hist.q) ? '' : '如期号、日期均为官方公布数据。') + '</p>'
        : '<p class="hint">没有找到匹配「' + esc(hist.q) + '」的开奖记录，' +
        '可尝试只输入年份（如 2026）或日期片段（如 09-10）。</p>';
    }

    var more = $('#hist-more');
    if (more) {
      more.innerHTML = end < items.length
        ? '<button class="btn-ghost" id="btn-hist-more" type="button">加载更多（剩余 ' +
        (items.length - end) + ' 期）</button>'
        : '';
      var btn = $('#btn-hist-more');
      if (btn) btn.addEventListener('click', function () {
        renderHistList(false);
        var sc = $('.page-scroll');
        if (sc && btn.parentNode) {
          // 加载后把视图滚到新内容起点，避免用户以为"没反应"
          try { sc.scrollTop = Math.min(sc.scrollTop, sc.scrollHeight); } catch (e) { /* 忽略 */ }
        }
      });
    }
  }

  function showHistoryPage(opts) {
    var c = LC.cfg(state.kind);
    if (!openPage('draw-history', historyPageHtml(c), opts)) return;

    $('#btn-back').addEventListener('click', closePage);

    var input = $('#hist-input');
    var timer = null;
    input.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; renderHistList(true); }, 180);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); renderHistList(true); }
    });
    $('#btn-hist-reset').addEventListener('click', function () {
      input.value = '';
      hist.shown = 0;
      renderHistList(true);
      input.focus();
    });

    renderHistList(true);
  }

  /* ---------- 一级界面：分析设置 ---------- */
  function renderRecommend() {
    var panel = $('#panel-recommend');
    var c = LC.cfg(state.kind);
    var bo = betOpts();
    var p = betParams();

    var winChips = WINDOWS.map(function (w) {
      return '<button class="chip' + (state.window === w.v ? ' active' : '') +
        '" data-window="' + w.v + '">' + w.label + '</button>';
    }).join('');

    var betChips = BET_META.map(function (b) {
      return '<button class="chip' + (state.betType === b.v ? ' active' : '') +
        '" data-bet="' + b.v + '">' + b.label + '</button>';
    }).join('');

    var pv = betPreview(c, bo, p);

    var setupBody =
      '<div class="field"><label>分析样本窗口</label><div class="chips">' + winChips + '</div></div>';

    // 投注方式可切换：单式走逐注抽样，复式 / 胆拖走号码池优化
    setupBody +=
      '<div class="field"><label>投注方式</label><div class="chips">' + betChips + '</div>' +
      betNote(c, bo, p) + '</div>';

    if (p.betType === 'single') {
      setupBody +=
        '<div class="sub-title">注数与出号分层</div>' + crowdTierFields(c, bo) +
        crowdThresholdField();
    } else {
      setupBody += betParamFields(c, bo, p) + crowdThresholdField() + crowdPoolHint();
    }

    setupBody += '<div class="sub-title">环境（E）与欧气（L）</div>' + crowdSourceFields();

    var hint = '避拥挤出号不做任何预测：开奖是独立随机事件，每注中奖概率恒等。' +
      (state.betType === 'single'
        ? '它只逐层筛掉大众扎堆的号码与形态，降低中奖后被分摊的人数。'
        : '复式 / 胆拖无法逐注剔除，改为优化号码池，让展开后的平均拥挤度最低。') +
      '全部 ' + LC.draws(state.kind).length +
      ' 期历史用于 P0 历史同源与形态统计口径。';

    var html =
      '<div class="card">' +
      '<div class="card-head"><h3>分析设置</h3></div>' +
      setupBody +
      '</div>' +
      '<div class="gen-bar">' +
      '<div class="gen-sum">本次将生成 <b>' + pv.combos.toLocaleString() + '</b> 注，' +
      '共 <b>' + pv.cost.toLocaleString() + '</b> 元</div>' +
      '<button class="btn-primary" id="btn-generate">生成推荐号码</button>' +
      '<p class="hint">' + hint + '</p>' +
      '</div>';

    panel.innerHTML = html;

    var genBtn = $('#btn-generate');
    if (genBtn) {
      genBtn.addEventListener('click', function () {
        state.seed = (Date.now() & 0x7fffffff);
        showResultPage();
      });
    }

    function rerenderSettings() {
      renderRecommend();
      if (state.tab === 'stats') renderStats();
      if (state.tab === 'tests') renderTests();
    }

    $$('.chips [data-window]', panel).forEach(function (b) {
      b.addEventListener('click', function () {
        state.window = Number(b.dataset.window);
        rerenderSettings();
      });
    });
    $$('.chips [data-bet]', panel).forEach(function (b) {
      b.addEventListener('click', function () {
        state.betType = b.dataset.bet;
        state.mainSel = null;
        state.specialSel = null;
        state.danCount = null;
        state.tuoCount = null;
        state.sTuoCount = null;
        renderRecommend();
      });
    });
    $$('.chips [data-crowdmax]', panel).forEach(function (b) {
      b.addEventListener('click', function () {
        state.crowdMax = Number(b.dataset.crowdmax);
        state.seed = (Date.now() & 0x7fffffff);
        renderRecommend();
      });
    });
    // 文本框在输入过程中只同步状态、不重建 DOM，避免丢焦点
    var hpInput = $('#hotpool-input', panel);
    if (hpInput) {
      hpInput.addEventListener('input', function () {
        state.hotPool = hpInput.value;
        state.seed = (Date.now() & 0x7fffffff);
      });
    }
    var luckInput = $('#luck-input', panel);
    if (luckInput) {
      luckInput.addEventListener('input', function () {
        state.luck = luckInput.value;
        state.seed = (Date.now() & 0x7fffffff);
      });
    }
    var evtInput = $('#events-input', panel);
    if (evtInput) {
      evtInput.addEventListener('input', function () {
        state.events = evtInput.value;
        state.seed = (Date.now() & 0x7fffffff);
      });
    }
    var selfInput = $('#selfpick-input', panel);
    if (selfInput) {
      selfInput.addEventListener('input', function () {
        state.selfPick = selfInput.value;
        state.seed = (Date.now() & 0x7fffffff);
      });
    }
    $$('.chips [data-msel]', panel).forEach(function (b) {
      b.addEventListener('click', function () {
        state.mainSel = Number(b.dataset.msel);
        renderRecommend();
      });
    });
    $$('.chips [data-ssel]', panel).forEach(function (b) {
      b.addEventListener('click', function () {
        state.specialSel = Number(b.dataset.ssel);
        renderRecommend();
      });
    });
    $$('.chips [data-dan]', panel).forEach(function (b) {
      b.addEventListener('click', function () {
        state.danCount = Number(b.dataset.dan);
        state.tuoCount = null;
        renderRecommend();
      });
    });
    $$('.chips [data-tuo]', panel).forEach(function (b) {
      b.addEventListener('click', function () {
        state.tuoCount = Number(b.dataset.tuo);
        renderRecommend();
      });
    });
    $$('.chips [data-dtform]', panel).forEach(function (b) {
      b.addEventListener('click', function () {
        state.dtForm = b.dataset.dtform;
        state.danCount = null;
        state.tuoCount = null;
        state.sTuoCount = null;
        renderRecommend();
      });
    });
    $$('.chips [data-stuo]', panel).forEach(function (b) {
      b.addEventListener('click', function () {
        state.sTuoCount = Number(b.dataset.stuo);
        renderRecommend();
      });
    });
    $$('.chips [data-tickets]', panel).forEach(function (b) {
      b.addEventListener('click', function () {
        state.tickets = Number(b.dataset.tickets);
        state.seed = (Date.now() & 0x7fffffff);
        renderRecommend();
      });
    });
    var ticketInput = $('#tickets-input', panel);
    if (ticketInput) {
      // 输入过程中不重建 DOM（否则会丢焦点、丢光标），只同步状态与预览
      ticketInput.addEventListener('input', function () {
        var raw = String(ticketInput.value).trim();
        var n = Number(raw);
        var valid = raw !== '' && isFinite(n) && n >= TICKET_MIN && n <= TICKET_MAX;
        markTicketsInvalid(panel, !valid);
        if (!valid) return;                       // 越界先只标红，失焦时再拉回
        state.tickets = Math.round(n);
        syncTicketPicks(panel, state.tickets);
        updateBetPreview(panel);
      });
      ticketInput.addEventListener('blur', function () { normalizeTickets(panel, ticketInput); });
      ticketInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); ticketInput.blur(); }
      });
    }
  }

  function factorBars(o) {
    return Object.keys(FACTOR_META).map(function (k) {
      var z = (o.factors && o.factors[k]) || 0;
      var w = Math.min(Math.abs(z) / 3, 1) * 50;
      var neg = z < 0;
      return '<div class="fbar-row">' +
        '<span class="fbar-name">' + FACTOR_META[k].name + '</span>' +
        '<span class="fbar-track"><i style="background:' + FACTOR_META[k].color +
        ';width:' + w.toFixed(1) + '%;' + (neg ? 'margin-left:' + (50 - w).toFixed(1) + '%' : 'margin-left:50%') + '"></i></span>' +
        '<span class="fbar-val">' + (z >= 0 ? '+' : '') + z.toFixed(2) + '</span>' +
        '</div>';
    }).join('');
  }

  // 复式 / 胆拖：号码分组卡片（含注数、金额、展开说明）
  function betCardHtml(rec) {
    var b = rec.bet, c = rec.config;
    var isDan = b.type === 'dantuo';
    var form = isDan ? (b.dtForm || 'main') : null;
    var specIsDan = form === 'special' || form === 'both';

    function group(label, nums, cls) {
      return '<div class="bet-group">' +
        '<span class="bet-group-label">' + label + '</span>' +
        '<span class="balls">' + nums.map(function (n) {
          return '<i class="ball ' + cls + '">' + pad2(n) + '</i>';
        }).join('') + '</span></div>';
    }

    var mainHtml;
    if (form === 'special') mainHtml = group(c.mainLabel, b.main, 'ball-main');
    else if (isDan) mainHtml = group('胆码', b.dan, 'ball-main') + group('拖码', b.tuo, 'ball-drag');
    else mainHtml = group(c.mainLabel, b.main, 'ball-main');

    var specHtml = specIsDan
      ? group(c.specialLabel + '胆码', b.sDan, 'ball-special') +
        group(c.specialLabel + '拖码', b.sTuo, 'ball-special-drag')
      : group(c.specialLabel, b.special, 'ball-special');

    var tag;
    if (form === 'special') {
      tag = c.mainLabel + ' ' + b.mainSel + ' 个 + ' + b.sDanCount + ' 个' + c.specialLabel +
        '胆 + ' + b.sTuoCount + ' 拖';
    } else if (form === 'both') {
      tag = b.danCount + ' 胆 + ' + b.tuoCount + ' 拖 + ' + b.sDanCount + ' 个' + c.specialLabel +
        '胆 + ' + b.sTuoCount + ' 拖';
    } else if (isDan) {
      tag = b.danCount + ' 胆 + ' + b.tuoCount + ' 拖 + ' + b.specialSel + ' 个' + c.specialLabel;
    } else {
      tag = b.mainSel + ' 个' + c.mainLabel + ' + ' + b.specialSel + ' 个' + c.specialLabel;
    }

    var detail = b.main.map(function (n) {
      var o = rec.poolScores.filter(function (x) { return x.num === n; })[0];
      var isDanNum = isDan && form !== 'special' && b.dan.indexOf(n) >= 0;
      var cls = isDanNum ? 'ball-main' : (isDan && form !== 'special' ? 'ball-drag' : 'ball-main');
      var name = isDan && form !== 'special' ? (isDanNum ? '胆码' : '拖码') : c.mainLabel;
      return '<div class="num-detail">' +
        '<div class="num-detail-head"><i class="ball ' + cls + '">' +
        pad2(n) + '</i><span>' + name +
        ' · 评分 ' + o.score.toFixed(2) + ' · 排名第 ' + o.rank + '</span></div>' +
        factorBars(o) + '</div>';
    }).join('');

    var specDetail = b.special.map(function (n) {
      var o = rec.specialScores.filter(function (x) { return x.num === n; })[0];
      var isSDan = specIsDan && b.sDan.indexOf(n) >= 0;
      var name = specIsDan ? (isSDan ? '胆码' : '拖码') : '';
      return '<div class="num-detail">' +
        '<div class="num-detail-head"><i class="ball ' + (isSDan ? 'ball-special' : 'ball-special-drag') +
        '">' + pad2(n) + '</i>' +
        '<span>' + c.specialLabel + (name ? '（' + name + '）' : '') +
        ' · 评分 ' + o.score.toFixed(2) + ' · 排名第 ' + o.rank +
        '</span></div>' + factorBars(o) + '</div>';
    }).join('');

    return '<div class="ticket bet-ticket">' +
      '<div class="ticket-head">' +
      '<span class="ticket-no">' + b.label + '投注 · ' + tag + '</span>' +
      '<span class="ticket-score">' + b.combos.toLocaleString() + ' 注 · ' +
      b.cost.toLocaleString() + ' 元</span>' +
      '</div>' +
      '<div class="bet-groups">' + mainHtml + specHtml + '</div>' +
      '<div class="bet-formula">展开：' + b.formula + ' = ' + b.combos.toLocaleString() + ' 注' +
      (b.structureAvg == null ? '' :
        ' · 组合结构典型度均值 ' + (b.structureAvg * 100).toFixed(0) + '%') + '</div>' +
      '<button class="link-btn" data-toggle="0">查看每个号码的依据 ▾</button>' +
      '<div class="ticket-detail" id="td-0">' + detail + specDetail + '</div>' +
      '</div>';
  }

  function recSummary(rec) {
    if (rec.bet && rec.bet.type !== 'single') {
      return '号码按综合评分由高到低选取，属于确定性输出，不涉及随机采样。';
    }
    return '从 ' + rec.candidateCount.toLocaleString() +
      ' 个经结构筛选的候选组合中排序输出 · 随机种子 ' + rec.seed;
  }

  /* ---------- 结果页：避拥挤出号 ---------- */

  function crowdColor(v) {
    if (v <= 30) return '#10b981';
    if (v <= 45) return '#22c55e';
    if (v <= 60) return '#f59e0b';
    return '#ef4444';
  }

  function crowdMeter(label, value) {
    return '<div class="ticket-bar"><span>' + label + '</span>' +
      '<span class="progress"><i style="width:' + Math.min(value, 100).toFixed(0) +
      '%;background:' + crowdColor(value) + '"></i></span>' +
      '<span class="muted">' + value.toFixed(1) + ' / 100</span></div>';
  }

  function numPartBars(parts) {
    return Object.keys(NUM_PART_META).map(function (k) {
      var v = parts[k] || 0;
      var w = Math.min(Math.abs(v) / 0.30, 1) * 100;
      return '<div class="fbar-row"><span class="fbar-name">' + NUM_PART_META[k].name +
        '</span><span class="fbar-track"><i style="background:' + NUM_PART_META[k].color +
        ';width:' + w.toFixed(0) + '%;margin-left:0"></i></span>' +
        '<span class="fbar-val">' + (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '</span></div>';
    }).join('');
  }

  function bindToggles(box) {
    $$('.link-btn', box).forEach(function (b) {
      b.addEventListener('click', function () {
        var d = $('#td-' + b.dataset.toggle, box);
        if (!d) return;
        var open = d.classList.toggle('open');
        b.textContent = open ? (b.dataset.close || '收起来源依据 ▴')
          : (b.dataset.open || '查看号码依据 ▾');
      });
    });
    $$('.subtab', box).forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.subtab', box).forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        var m = $('#pool-main', box), s = $('#pool-special', box);
        if (m) m.classList.toggle('hidden', b.dataset.sub !== 'main');
        if (s) s.classList.toggle('hidden', b.dataset.sub !== 'special');
      });
    });
  }

  function crowdTicketHtml(t, i, c, rec) {
    var f = t.features;
    var partBars = Object.keys(CROWD_PART_META).map(function (k) {
      var v = t.crowdParts[k] || 0;
      return '<div class="fbar-row"><span class="fbar-name">' + CROWD_PART_META[k].name +
        '</span><span class="fbar-track"><i style="background:' + CROWD_PART_META[k].color +
        ';width:' + Math.min(v * 100, 100).toFixed(0) + '%;margin-left:0"></i></span>' +
        '<span class="fbar-val">' + (v * 100).toFixed(0) + '</span></div>';
    }).join('');

    var checks = [
      ['P0', '历史同源', t.checks.P0, '与上期重号 ' + t.repeat + ' 个（要求 < 3）'],
      ['P1', '极端形态', t.checks.P1, '无 3 连号 / 全等差 / 对称 / 同尾≥3 / 全奇全偶 / 全大全小 / 挤同区'],
      ['P2', '大众偏好', true, '以拥挤度量化，不作硬排除'],
      ['P3', '拥挤黑名单', t.checks.P3, '热门号池命中 ' + t.checks.poolHits + ' 个（要求 < 5）'],
      ['P4', '自我重复', t.checks.P4,
        '本次各注之间重号 ≤ ' + (rec.maxOverlap - 1) + ' 个' +
        (rec.selfPick && rec.selfPick.count
          ? '；与历史自买重合 ' + t.checks.selfHits + ' 个（要求 < 5）'
          : '；未填写历史自买号码')],
      ['形态', '形态要求', t.checks.structure, '和值 / 跨度 / 奇偶 / 大小 / 区间 / 连号 全部达标']
    ].map(function (x) {
      return '<span class="check-chip ' + (x[2] ? 'ok' : 'bad') + '" title="' + esc(x[3]) + '">' +
        (x[2] ? '✓' : '✗') + ' ' + x[0] + ' · ' + x[1] + '</span>';
    }).join('');

    var mainDetail = t.mainDetail.map(function (d) {
      return '<div class="num-detail">' +
        '<div class="num-detail-head"><i class="ball ball-main">' + pad2(d.num) + '</i>' +
        '<span>拥挤度 ' + (d.crowd * 100).toFixed(0) + ' · 冷门排名第 ' + d.rank + '</span></div>' +
        numPartBars(d.parts) + '</div>';
    }).join('');
    var specDetail = t.specialDetail.map(function (d) {
      return '<div class="num-detail">' +
        '<div class="num-detail-head"><i class="ball ball-special">' + pad2(d.num) + '</i>' +
        '<span>拥挤度 ' + (d.crowd * 100).toFixed(0) + ' · 冷门排名第 ' + d.rank + '</span></div>' +
        '</div>';
    }).join('');

    return '<div class="ticket">' +
      '<div class="ticket-head">' +
      '<span class="ticket-no">方案 ' + (i + 1) +
      ' <em class="tier-tag tier-' + t.tier + '" title="' + esc(t.tierDesc) + '">' +
      t.tierLabel + '</em></span>' +
      '<span class="ticket-score">拥挤度 <b style="color:' + crowdColor(t.crowdScore) + '">' +
      t.crowdScore.toFixed(1) + '</b></span>' +
      '</div>' +
      '<div class="ticket-balls">' + ballsHtml(t.main, 'main') +
      '<span class="ball-sep">+</span>' + ballsHtml(t.special, 'special') + '</div>' +
      '<div class="ticket-metrics">' +
      '<span>和值 <b>' + f.sum + '</b></span>' +
      '<span>跨度 <b>' + f.span + '</b></span>' +
      '<span>奇偶 <b>' + f.odd + ':' + (c.mainCount - f.odd) + '</b></span>' +
      '<span>大小 <b>' + f.big + ':' + (c.mainCount - f.big) + '</b></span>' +
      '<span>区间 <b>' + f.zone + '</b></span>' +
      '<span>连号组 <b>' + f.consecutive + '</b></span>' +
      '<span>重号 <b>' + f.repeat + '</b></span>' +
      '</div>' +
      crowdMeter('拥挤度', t.crowdScore) +
      '<p class="crowd-why">' + esc(t.explanation) + '</p>' +
      '<button class="link-btn" data-toggle="' + i + '" data-open="查看筛选依据与号码拥挤度 ▾" ' +
      'data-close="收起筛选依据 ▴">查看筛选依据与号码拥挤度 ▾</button>' +
      '<div class="ticket-detail" id="td-' + i + '">' +
      '<div class="check-list">' + checks + '</div>' +
      '<div class="sub-title">拥挤度构成</div>' + partBars +
      '<div class="sub-title">主区号码拥挤度</div>' + mainDetail +
      '<div class="sub-title">' + c.specialLabel + '拥挤度</div>' + specDetail +
      '</div>' +
      '</div>';
  }

  // 五维图例：单式与号码池共用
  function crowdLegendHtml() {
    return '<div class="factor-legend">' + Object.keys(CROWD_PART_META).map(function (k) {
      return '<div class="legend-row"><i style="background:' + CROWD_PART_META[k].color +
        '"></i><b>' + CROWD_PART_META[k].name + '</b><span>' +
        CROWD_PART_META[k].desc + '</span></div>';
    }).join('') + '</div>';
  }

  // 号码拥挤度排行卡：单式与号码池共用
  function crowdPoolGridCard(rec) {
    var c = rec.config;
    function row(o, cls) {
      var v = o.crowd * 100;
      return '<div class="pool-row">' +
        '<i class="ball ' + cls + ' sm">' + pad2(o.num) + '</i>' +
        '<span class="pool-score">' + v.toFixed(0) + '</span>' +
        '<span class="crowd-track"><i style="width:' + Math.min(v, 100).toFixed(0) +
        '%;background:' + crowdColor(v) + '"></i></span>' +
        '</div>';
    }
    return '<div class="card">' +
      '<div class="card-head"><h3>号码拥挤度排行</h3><span class="badge">越靠前越冷门</span></div>' +
      '<p class="muted small">拥挤度 0–100：来自生日号偏好、谐音吉利尾、小号偏好、长期热度、上期开出，' +
      '以及日历 / 事件环境项（调整幅度封顶 ±10%）。</p>' +
      '<div class="subtabs">' +
      '<button class="subtab active" data-sub="main">' + c.mainLabel + '拥挤度</button>' +
      '<button class="subtab" data-sub="special">' + c.specialLabel + '拥挤度</button>' +
      '</div>' +
      '<div class="pool-grid" id="pool-main">' +
      rec.poolCrowd.map(function (o) { return row(o, 'ball-main'); }).join('') +
      '</div>' +
      '<div class="pool-grid hidden" id="pool-special">' +
      rec.specialCrowd.map(function (o) { return row(o, 'ball-special'); }).join('') +
      '</div>' +
      '</div>';
  }

  // 环境（E）与欧气（L）卡：单式与号码池共用
  function crowdEnvCard(rec) {
    var hotHtml = rec.hotPool.count
      ? '<span class="balls">' + rec.hotPool.list.map(function (n) {
        return '<i class="ball ball-hot sm">' + pad2(n) + '</i>';
      }).join('') + '</span>'
      : '<span class="muted small">未填写（可粘贴 AI / 主播荐号、群聊合买号或热搜数字）</span>';

    var evtNums = Object.keys(rec.events || {}).map(function (k) {
      return { num: Number(k), boost: rec.events[k] };
    }).sort(function (a, b) { return b.boost - a.boost; }).slice(0, 12);
    var evtHtml = evtNums.length
      ? '<div class="luck-list">' + evtNums.map(function (x) {
        return '<span class="luck-item"><i class="ball ball-event sm">' + pad2(x.num) +
          '</i><b>+' + x.boost.toFixed(2) + '</b></span>';
      }).join('') + '</div>'
      : '<span class="muted small">未填写实时事件数字（热搜 / 赛事比分 / 胜者编号）</span>';

    var selfList = (rec.selfPick && rec.selfPick.count)
      ? rec.selfPick.list.slice().sort(function (a, b) { return a - b; }) : [];
    var selfHtml = selfList.length
      ? '<span class="balls">' + selfList.map(function (n) {
        return '<i class="ball ball-self sm">' + pad2(n) + '</i>';
      }).join('') + '</span>' +
        '<span class="muted small"> 共 ' + selfList.length + ' 个号，新号与其重合 ≥5 个作废</span>'
      : '<span class="muted small">未填写历史自买号码（填了才会启用 P4 自我重复作废）</span>';

    var luckNums = Object.keys(rec.luck.main.map).map(function (k) {
      return { num: Number(k), boost: rec.luck.main.map[k] };
    }).sort(function (a, b) { return b.boost - a.boost; }).slice(0, 12);
    var luckHtml = luckNums.length
      ? luckNums.map(function (x) {
        return '<span class="luck-item"><i class="ball ball-luck sm">' + pad2(x.num) +
          '</i><b>+' + x.boost.toFixed(2) + '</b></span>';
      }).join('')
      : '<span class="muted small">未填写运气源</span>';

    var sourcesHtml = rec.luck.main.sources.length
      ? '<div class="source-list">' + rec.luck.main.sources.map(function (s) {
        return '<div class="source-row"><span class="source-label">' + esc(s.label) + '</span>' +
          '<span class="muted">' + esc(s.numbers) + ' · 衰减 ' + (s.decay * 100).toFixed(0) +
          '%（' + s.ageDays + ' 天前）</span></div>';
      }).join('') + '</div>'
      : '';

    var notesHtml = rec.notes.length
      ? '<ul class="crowd-notes">' + rec.notes.map(function (n) {
        return '<li>' + esc(n) + '</li>';
      }).join('') + '</ul>'
      : '';

    var weightHtml = Object.keys(CROWD_PART_META).map(function (k) {
      return '<span class="weight-item"><i style="background:' + CROWD_PART_META[k].color +
        '"></i>' + CROWD_PART_META[k].name + ' <b>' +
        ((LCrowd.CROWD_WEIGHTS[k] || 0) * 100).toFixed(0) + '%</b></span>';
    }).join('');

    return '<div class="card">' +
      '<div class="card-head"><h3>本期环境（E）与欧气（L）</h3></div>' +
      '<div class="sub-title">实时事件命中的号码（E2）</div>' + evtHtml +
      '<div class="sub-title">历史自买 · 自我重复（P4）</div>' + selfHtml +
      '<div class="sub-title">热门号池 · 拥挤黑名单（P3）</div>' + hotHtml +
      '<div class="sub-title">运气源命中的号码（加权值，封顶 +3.0）</div>' +
      '<div class="luck-list">' + luckHtml + '</div>' +
      sourcesHtml +
      (notesHtml ? '<div class="sub-title">环境提示</div>' + notesHtml : '') +
      '<div class="weight-list">' + weightHtml + '</div>' +
      '<p class="hint">环境因子（E）判断"别人会买什么"，欧气因子（L）给号码加权，' +
      '两者都只改变抽样概率，不改变中奖概率。奖池与派奖信息请以官方公告为准。</p>' +
      '</div>';
  }

  // 复式 / 胆拖：号码池方案（评价单元是"一张票"，展示池 + 展开统计）
  function poolFormula(c, rec) {
    var n = rec.counts;
    var mainPart = rec.dtForm === 'special'
      ? '1'
      : (rec.betType === 'dantuo'
        ? 'C(' + c.mainLabel + '拖码 ' + n.tuoCount + ', ' + (c.mainCount - n.danCount) + ')'
        : 'C(' + c.mainLabel + '选号 ' + n.mainSel + ', ' + c.mainCount + ')');
    var specPart = (rec.betType === 'dantuo' && rec.dtForm !== 'main')
      ? 'C(' + c.specialLabel + '拖码 ' + n.sTuoCount + ', ' + (c.specialCount - n.sDanCount) + ')'
      : 'C(' + c.specialLabel + '选号 ' + n.specialSel + ', ' + c.specialCount + ')';
    return mainPart + ' × ' + specPart;
  }

  function renderCrowdPoolResult(box, rec) {
    var c = rec.config;
    var e = rec.expanded;
    var b = rec.bet;
    var n = rec.counts;
    var isDan = rec.betType === 'dantuo';
    var form = rec.dtForm;
    var roleName = {
      dan: '胆码', tuo: '拖码', main: c.mainLabel,
      sDan: c.specialLabel + '胆码', sTuo: c.specialLabel + '拖码', special: c.specialLabel
    };
    var roleCls = {
      dan: 'ball-main', tuo: 'ball-drag', main: 'ball-main',
      sDan: 'ball-special', sTuo: 'ball-special-drag', special: 'ball-special'
    };

    function group(label, nums, role) {
      return '<div class="bet-group"><span class="bet-group-label">' + label + '</span>' +
        '<span class="balls">' + nums.map(function (x) {
          return '<i class="ball ' + roleCls[role] + '">' + pad2(x) + '</i>';
        }).join('') + '</span></div>';
    }

    var tag;
    if (isDan && form === 'special') {
      tag = c.mainLabel + ' ' + c.mainCount + ' 个 + ' + n.sDanCount + ' 个' +
        c.specialLabel + '胆 + ' + n.sTuoCount + ' 拖';
    } else if (isDan && form === 'both') {
      tag = n.danCount + ' 胆 + ' + n.tuoCount + ' 拖 + ' + n.sDanCount + ' 个' +
        c.specialLabel + '胆 + ' + n.sTuoCount + ' 拖';
    } else if (isDan) {
      tag = n.danCount + ' 胆 + ' + n.tuoCount + ' 拖 + ' + n.specialSel + ' 个' + c.specialLabel;
    } else {
      tag = n.mainSel + ' 个' + c.mainLabel + ' + ' + n.specialSel + ' 个' + c.specialLabel;
    }

    var mainHtml = form === 'special'
      ? group(c.mainLabel + '号码池', rec.pool.main, 'main')
      : (isDan
        ? group('胆码（每注必含）', rec.dan, 'dan') + group('拖码', rec.tuo, 'tuo')
        : group(c.mainLabel + '号码池', rec.pool.main, 'main'));
    var specHtml = (isDan && form !== 'main')
      ? group(c.specialLabel + '胆码', rec.sDan, 'sDan') +
        group(c.specialLabel + '拖码', rec.sTuo, 'sTuo')
      : group(c.specialLabel + '号码池', rec.pool.special, 'special');

    // 池内号码按拥挤度从冷到热排列，方便直接看出"池子为什么长这样"
    function detailHtml(list) {
      return list.slice().sort(function (x, y) { return x.crowd - y.crowd; }).map(function (d) {
        return '<div class="num-detail">' +
          '<div class="num-detail-head"><i class="ball ' + roleCls[d.role] + '">' + pad2(d.num) + '</i>' +
          '<span>' + roleName[d.role] + ' · 拥挤度 ' + (d.crowd * 100).toFixed(0) +
          ' · 冷门排名第 ' + d.rank + '</span></div>' + numPartBars(d.parts) + '</div>';
      }).join('');
    }

    var partBars = Object.keys(CROWD_PART_META).map(function (k) {
      var v = e.parts[k] || 0;
      return '<div class="fbar-row"><span class="fbar-name">' + CROWD_PART_META[k].name +
        '</span><span class="fbar-track"><i style="background:' + CROWD_PART_META[k].color +
        ';width:' + Math.min(v * 100, 100).toFixed(0) + '%;margin-left:0"></i></span>' +
        '<span class="fbar-val">' + (v * 100).toFixed(0) + '</span></div>';
    }).join('');

    var invalidRate = e.count ? ((e.hardInvalid + e.structInvalid) / e.count) * 100 : 0;

    box.innerHTML =
      '<div class="card">' +
      '<div class="card-head"><h3>避拥挤号码池方案</h3>' +
      '<span class="badge">拥挤度上限 ' + rec.threshold + '</span></div>' +
      '<p class="muted small">复式 / 胆拖买的是"一批号码"：这张票展开成 ' + e.count +
      ' 注（主区），每注拥挤度各不相同，票面没有单一拥挤度、也没法把其中某几注剔除。' +
      '所以改优化<b>号码池</b>——把池子展开后的全部组合一起评价，' +
      '让平均拥挤度最低、踩中 P0/P1 与形态要求的比例最小。</p>' +
      '<p class="hint">展开统计：平均拥挤度 ' + e.mean.toFixed(1) +
      (e.count > 1
        ? ' · 最低 ' + e.min.toFixed(1) + ' · 最高 ' + e.max.toFixed(1) +
          ' · 90 分位 ' + e.p90.toFixed(1)
        : ' · 主区固定选满，无展开') +
      ' · 超上限 ' + e.over + ' 注 · P0/P1/P4 作废 ' + e.hardInvalid +
      (e.selfInvalid ? ' 注（其中历史自买重合 ≥5 的 ' + e.selfInvalid + ' 注）' : ' 注') +
      ' · 形态越界 ' + e.structInvalid + ' 注（合计 ' + invalidRate.toFixed(1) + '%）· ' +
      '共评价 ' + rec.attempts.toLocaleString() + ' 次展开 · 随机种子 ' + rec.seed + '</p>' +
      crowdMeter('展开平均拥挤度', e.mean) +
      crowdMeter('形态越界比例', invalidRate) +
      '<div class="ticket bet-ticket">' +
      '<div class="ticket-head">' +
      '<span class="ticket-no">' +
      (isDan ? LM.dtFormLabel(rec.kind, form) : betLabel(rec.betType)) +
      '投注 · ' + tag + '</span>' +
      '<span class="ticket-score">' + b.combos.toLocaleString() + ' 注 · ' +
      (b.combos * b.yuanPerBet).toLocaleString() + ' 元</span>' +
      '</div>' +
      '<div class="bet-groups">' + mainHtml + specHtml + '</div>' +
      '<div class="bet-formula">展开：' + poolFormula(c, rec) + ' = ' +
      b.combos.toLocaleString() + ' 注 · 主区展开平均拥挤度 ' + e.mean.toFixed(1) + '</div>' +
      '<button class="link-btn" data-toggle="pool" data-open="查看池内每个号码的拥挤度 ▾" ' +
      'data-close="收起号码拥挤度 ▴">查看池内每个号码的拥挤度 ▾</button>' +
      '<div class="ticket-detail" id="td-pool">' +
      '<div class="sub-title">主区号码（按拥挤度从冷到热）</div>' + detailHtml(rec.mainDetail) +
      '<div class="sub-title">' + c.specialLabel + '号码</div>' + detailHtml(rec.specialDetail) +
      '<div class="sub-title">池内组合平均拥挤度构成</div>' + partBars +
      '</div>' +
      '</div>' +
      crowdLegendHtml() +
      '</div>' +
      crowdPoolGridCard(rec) +
      crowdEnvCard(rec);

    bindToggles(box);
  }

  function renderCrowdResult(box, rec) {
    var c = rec.config;
    var t = rec.plan;
    var tierText = tierPlanText(t);

    var ticketsHtml = rec.tickets.map(function (tk, i) {
      return crowdTicketHtml(tk, i, c, rec);
    }).join('') ||
      '<p class="muted small">在当前筛选条件下未能生成号码，请放宽拥挤度上限或清空热门号池后重试。</p>';

    box.innerHTML =
      '<div class="card">' +
      '<div class="card-head"><h3>避拥挤推荐方案</h3>' +
      '<span class="badge">拥挤度上限 ' + rec.threshold + '</span></div>' +
      '<p class="muted small">先按 P0–P4 逐层作废、再由【形态要求】筛掉越界组合，' +
      '最后按避拥挤权重加权随机抽样出号：' + tierText +
      '。共抽样 ' + rec.attempts + ' 次，随机种子 ' + rec.seed +
      '。拥挤度越低，说明这一注越"不像大多数人会买的号"。</p>' +
      '<p class="hint">淘汰统计：P0/P1/P4 作废 ' + rec.rejected.hard + ' 次 · ' +
      '形态要求越界 ' + rec.rejected.structure + ' 次 · 拥挤度超限 ' +
      rec.rejected.crowd + ' 次 · 注间撞号重抽 ' + rec.rejected.overlap + ' 次。</p>' +
      ticketsHtml +
      crowdLegendHtml() +
      '</div>' +

      crowdPoolGridCard(rec) +

      crowdEnvCard(rec);

    bindToggles(box);
  }

  function renderRecommendTickets(forceNewSeed) {
    var box = $('#rec-result');
    if (!box) return;
    var rec = buildRecommendation(forceNewSeed);
    var c = rec.config;
    var ticketsHtml;

    if (rec.strategy === 'crowd') {
      if (rec.mode === 'pool') renderCrowdPoolResult(box, rec);
      else renderCrowdResult(box, rec);
      return;
    }

    if (rec.bet && rec.bet.type !== 'single') {
      ticketsHtml = betCardHtml(rec);
    } else {
      ticketsHtml = rec.tickets.map(function (t, i) {
        var f = t.features;
        var detail = t.mainDetail.map(function (d) {
          return '<div class="num-detail">' +
            '<div class="num-detail-head"><i class="ball ball-main">' + pad2(d.num) + '</i>' +
            '<span>评分 ' + d.score.toFixed(2) + ' · 排名第 ' + d.rank + '</span></div>' +
            factorBars(d) + '</div>';
        }).join('');

        return '<div class="ticket">' +
          '<div class="ticket-head">' +
          '<span class="ticket-no">方案 ' + (i + 1) + '</span>' +
          '<span class="ticket-score">模型评分 ' + (t.total * 100).toFixed(1) + '</span>' +
          '</div>' +
          '<div class="ticket-balls">' + ballsHtml(t.main, 'main') +
          '<span class="ball-sep">+</span>' + ballsHtml(t.special, 'special') + '</div>' +
          '<div class="ticket-metrics">' +
          '<span>和值 <b>' + f.sum + '</b></span>' +
          '<span>跨度 <b>' + f.span + '</b></span>' +
          '<span>奇偶 <b>' + f.odd + ':' + (c.mainCount - f.odd) + '</b></span>' +
          '<span>大小 <b>' + f.big + ':' + (c.mainCount - f.big) + '</b></span>' +
          '<span>区间 <b>' + f.zone + '</b></span>' +
          '<span>连号 <b>' + f.consecutive + '</b></span>' +
          '<span>重号 <b>' + f.repeat + '</b></span>' +
          '</div>' +
          '<div class="ticket-bar">' +
          '<span>结构典型度</span><span class="progress"><i style="width:' +
          (t.structureScore * 100).toFixed(0) + '%"></i></span>' +
          '<span class="muted">' + (t.structureScore * 100).toFixed(0) + '%</span>' +
          '</div>' +
          '<button class="link-btn" data-toggle="' + i + '">查看号码依据 ▾</button>' +
          '<div class="ticket-detail" id="td-' + i + '">' + detail + '</div>' +
          '</div>';
      }).join('');
    }

    // 号码评分榜
    var poolRows = rec.poolScores.slice(0, 16).map(function (o) {
      return '<div class="pool-row">' +
        '<i class="ball ball-main sm">' + pad2(o.num) + '</i>' +
        '<span class="pool-score">' + o.score.toFixed(2) + '</span>' +
        '<span class="pool-tag">' + rankTag(o.rank) + '</span>' +
        '</div>';
    }).join('');

    var specRows = rec.specialScores.map(function (o) {
      return '<div class="pool-row">' +
        '<i class="ball ball-special sm">' + pad2(o.num) + '</i>' +
        '<span class="pool-score">' + o.score.toFixed(2) + '</span>' +
        '<span class="pool-tag">' + rankTag(o.rank) + '</span>' +
        '</div>';
    }).join('');

    var weightsText = Object.keys(FACTOR_META).map(function (k) {
      return '<span class="weight-item"><i style="background:' + FACTOR_META[k].color + '"></i>' +
        FACTOR_META[k].name + ' <b>' + ((rec.weights[k] || 0) * 100).toFixed(0) + '%</b></span>';
    }).join('');

    box.innerHTML =
      '<div class="card">' +
      '<div class="card-head"><h3>' + (rec.bet ? rec.bet.label : '') + '推荐方案</h3>' +
      '<span class="badge" id="weight-badge">权重自适应</span></div>' +
      '<p class="muted small">' + recSummary(rec) + '</p>' +
      ticketsHtml +
      '<div class="factor-legend">' + Object.keys(FACTOR_META).map(function (k) {
        return '<div class="legend-row"><i style="background:' + FACTOR_META[k].color + '"></i>' +
          '<b>' + FACTOR_META[k].name + '</b><span>' + FACTOR_META[k].desc + '</span></div>';
      }).join('') + '</div>' +
      '</div>' +
      '<div class="card">' +
      '<div class="card-head"><h3>号码评分排行</h3></div>' +
      '<p class="muted small">综合分 = 各因子 z 值的加权和（已标准化，0 表示处于平均水平）</p>' +
      '<div class="subtabs">' +
      '<button class="subtab active" data-sub="main">' + rec.config.mainLabel + '评分</button>' +
      '<button class="subtab" data-sub="special">' + rec.config.specialLabel + '评分</button>' +
      '</div>' +
      '<div class="pool-grid" id="pool-main">' + poolRows + '</div>' +
      '<div class="pool-grid hidden" id="pool-special">' + specRows + '</div>' +
      '</div>' +
      '<div class="card">' +
      '<div class="card-head"><h3>当前生效权重</h3></div>' +
      '<div class="weight-list">' + weightsText + '</div>' +
      '<p class="hint">权重由滚动回测自动学习：在 "回测验证" 中可以看到各因子的实际表现。' +
      '若某因子在历史上没有超出随机的表现，其权重会自动被压低。</p>' +
      '</div>';

    $$('.link-btn', box).forEach(function (b) {
      b.addEventListener('click', function () {
        var d = $('#td-' + b.dataset.toggle, box);
        var open = d.classList.toggle('open');
        b.textContent = open ? '收起来源依据 ▴' : '查看号码依据 ▾';
      });
    });
    $$('.subtab', box).forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.subtab', box).forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        $('#pool-main', box).classList.toggle('hidden', b.dataset.sub !== 'main');
        $('#pool-special', box).classList.toggle('hidden', b.dataset.sub !== 'special');
      });
    });
  }

  function rankTag(rank) {
    if (rank <= 5) return '强烈关注';
    if (rank <= 10) return '值得关注';
    return '一般';
  }

  /* ============================================================
   * 面板 2：统计分析
   * ========================================================== */
  function renderStats() {
    var panel = $('#panel-stats');
    var kind = state.kind;
    panel.innerHTML = '<div class="loading">正在统计…</div>';

    setTimeout(function () {
      var c = LC.cfg(kind);
      var st = cached(kind, 'stats', '', function () { return LS.computeAll(kind, { window: state.window }); });
      var html = '';

      // 数据概览
      html += '<div class="card"><div class="card-head"><h3>分析概览</h3></div>' +
        '<div class="kv-grid">' +
        kv('玩法', c.name) + kv('统计样本', st.windowSize + ' 期') +
        kv('数据区间', st.first.i + ' ~ ' + st.latest.i) +
        kv('时间跨度', st.first.d + ' ~ ' + st.latest.d) +
        '</div></div>';

      // 号码热力网格
      var fMain = st.main.freq;
      var heatItems = fMain.list.map(function (x) {
        return { label: pad2(x.num), value: x.count, ball: 'main', title: x.num + ' 号：' + x.count + ' 次（理论 ' + x.expect.toFixed(1) + '）' };
      });
      var fSpec = st.special.freq;
      var heatItemsS = fSpec.list.map(function (x) {
        return { label: pad2(x.num), value: x.count, ball: 'special', title: x.num + ' 号：' + x.count + ' 次' };
      });
      html += '<div class="card"><div class="card-head"><h3>' + c.mainLabel + '出现次数热力</h3>' +
        '<span class="badge">理论期望 ' + fMain.expect.toFixed(1) + ' 次</span></div>' +
        '<div id="heat-main"></div>' +
        '<div class="sub-title">' + c.specialLabel + '出现次数</div><div id="heat-special"></div>' +
        '</div>';

      // 遗漏分析
      var om = st.main.omission.list.slice().sort(function (a, b) { return b.current - a.current; });
      html += '<div class="card"><div class="card-head"><h3>遗漏排行（' + c.mainLabel + '）</h3>' +
        '<span class="badge">理论平均遗漏 ' + om[0].theoAvg.toFixed(1) + ' 期</span></div>' +
        '<p class="muted small">遗漏 = 距离上次开出已过的期数。历史上"冷号该出"的说法在统计上不成立。</p>' +
        '<div id="omit-chart"></div></div>';

      // 和值
      html += '<div class="card"><div class="card-head"><h3>和值分布</h3>' +
        '<span class="badge">均值 ' + st.sum.mean.toFixed(1) + ' ± ' + st.sum.sd.toFixed(1) + '</span></div>' +
        '<p class="muted small">80% 的历史和值落在 ' + st.sum.q10.toFixed(0) + ' ~ ' + st.sum.q90.toFixed(0) +
        ' 之间（P10~P90）。</p>' +
        '<div id="sum-chart"></div></div>';

      // 和值走势
      html += '<div class="card"><div class="card-head"><h3>和值走势（最近 ' + Math.min(120, st.windowSize) + ' 期）</h3></div>' +
        '<div id="sum-trend"></div></div>';

      // 形态分布
      html += '<div class="card"><div class="card-head"><h3>形态分布</h3></div>' +
        '<div class="sub-title">奇偶比</div><div id="odd-chart"></div>' +
        '<div class="sub-title">大小比（以 ' + Math.floor((c.mainMin + c.mainMax) / 2) + ' 为界）</div><div id="big-chart"></div>' +
        '<div class="sub-title">连号个数</div><div id="cons-chart"></div>' +
        '<div class="sub-title">与上期重号个数</div><div id="repeat-chart"></div>' +
        '</div>';

      // 分区
      html += '<div class="card"><div class="card-head"><h3>三区分布</h3></div>' +
        '<div id="zone-chart"></div>' +
        '<div class="sub-title">最常见区间模式</div>' +
        '<div class="pattern-list">' + st.zones3.patterns.slice(0, 8).map(function (p) {
          return '<div class="pattern-row"><span class="pattern-key">' + p.key.replace(/:/g, ' : ') + '</span>' +
            '<span class="progress"><i style="width:' + (p.ratio * 100 * 3).toFixed(0) + '%"></i></span>' +
            '<span class="muted">' + pct(p.ratio) + '</span></div>';
        }).join('') + '</div></div>';

      // 尾数
      html += '<div class="card"><div class="card-head"><h3>尾数分布</h3></div>' +
        '<p class="muted small">统计所有号码的个位数分布，理想情况下各尾数应接近 10%。</p>' +
        '<div id="tail-chart"></div></div>';

      // 走势矩阵
      var tm = LS.trendMatrix(LC.draws(kind), c, false, 40);
      html += '<div class="card"><div class="card-head"><h3>近 40 期走势图</h3></div>' +
        '<div class="trend-wrap"><div class="trend-grid" style="grid-template-columns:repeat(' +
        (c.mainMax - c.mainMin + 1) + ',1fr)">' +
        tm.rows.map(function (r) {
          return r.row.map(function (v) {
            return '<i class="trend-cell' + (v ? ' hit' : '') + '"></i>';
          }).join('');
        }).join('') + '</div>' +
        '<div class="trend-axis">' + (function () {
          var a = '';
          for (var n = tm.min; n <= tm.max; n++) a += '<span>' + n + '</span>';
          return a;
        })() + '</div></div></div>';

      panel.innerHTML = html;

      // 渲染图表
      Charts.heat($('#heat-main'), heatItems, { legend: true });
      Charts.heat($('#heat-special'), heatItemsS, {});
      Charts.hbars($('#omit-chart'), om.slice(0, 12).map(function (x) {
        return {
          label: pad2(x.num), value: x.current,
          display: x.current + ' 期', color: '#f59e0b',
          expectLine: x.theoAvg
        };
      }), {});

      Charts.vbars($('#sum-chart'), st.sum.hist.counts.map(function (n, i) {
        return { label: st.sum.hist.labels[i], value: n, color: 'linear-gradient(180deg,#f87171,#dc2626)' };
      }), { labelEvery: 3 });

      var recent = st.draws.slice(-120);
      Charts.line($('#sum-trend'), [{ name: '和值', values: recent.map(function (d) { return LC.sum(d.r); }), color: '#f97316' }], {
        height: 180, baseline: st.sum.mean, baselineLabel: '历史均值 ' + st.sum.mean.toFixed(1),
        xLabels: recent.map(function (d) { return d.i.slice(-3); })
      });

      Charts.vbars($('#odd-chart'), st.oddEven.map(function (x) {
        return { label: x.key + ':' + (c.mainCount - Number(x.key)), value: x.count, color: 'linear-gradient(180deg,#818cf8,#4f46e5)' };
      }), {});
      Charts.vbars($('#big-chart'), st.bigSmall.map(function (x) {
        return { label: x.key + ':' + (c.mainCount - Number(x.key)), value: x.count, color: 'linear-gradient(180deg,#67e8f9,#0891b2)' };
      }), {});
      Charts.vbars($('#cons-chart'), st.consecutive.map(function (x) {
        return { label: x.key + ' 组', value: x.count, color: 'linear-gradient(180deg,#86efac,#16a34a)' };
      }), {});
      Charts.vbars($('#repeat-chart'), st.repeat.map(function (x) {
        return { label: x.key + ' 个', value: x.count, color: 'linear-gradient(180deg,#fcd34d,#d97706)' };
      }), {});

      Charts.hbars($('#zone-chart'), st.zones3.zones.map(function (z) {
        return {
          label: z.label, value: z.ratio * 100, digits: 1, display: pct(z.ratio),
          color: 'linear-gradient(90deg,#a78bfa,#7c3aed)'
        };
      }), {});

      Charts.vbars($('#tail-chart'), st.main.tail.map(function (x) {
        return { label: String(x.num), value: x.ratio * 100, color: 'linear-gradient(180deg,#fbcfe8,#db2777)' };
      }), { digits: 1 });
    }, 20);
  }

  function kv(k, v) {
    return '<div class="kv"><span>' + k + '</span><b>' + esc(v) + '</b></div>';
  }

  /* ============================================================
   * 面板 3：规律检验
   * ========================================================== */
  function renderTests() {
    var panel = $('#panel-tests');
    var kind = state.kind;
    panel.innerHTML = '<div class="loading">正在执行统计检验…</div>';

    setTimeout(function () {
      var r = cached(kind, 'tests', '', function () { return LT.runAll(kind, { window: state.window }); });
      var html = '<div class="card conclusion-card">' +
        '<div class="card-head"><h3>检验结论</h3></div>' +
        '<p class="conclusion">' + esc(r.conclusion) + '</p>' +
        '<div class="kv-grid">' +
        kv('检验项目', r.tests.length + ' 项') +
        kv('样本期数', r.sampleSize + ' 期') +
        kv('显著项数（p<0.05）', r.significant + ' 项') +
        kv('随机预期假阳性', r.expectedFalsePositive.toFixed(1) + ' 项') +
        '</div>' +
        '<p class="hint">统计检验只能回答"数据是否偏离随机"，不能证明"存在可预测规律"。' +
        '真正的判据是样本外验证的稳定收益。</p>' +
        '</div>';

      r.tests.forEach(function (t, idx) {
        var sig = t.p < 0.05;
        html += '<div class="card test-card">' +
          '<div class="card-head"><h3>' + esc(t.name) + '</h3>' +
          '<span class="pill ' + (sig ? 'pill-warn' : 'pill-ok') + '">' +
          (sig ? '显著' : '不显著') + '</span></div>' +
          '<p class="hypo">' + esc(t.hypothesis) + '</p>' +
          '<div class="kv-grid">' +
          kv('检验统计量', typeof t.stat === 'number' ? t.stat.toFixed(2) : t.stat) +
          kv('自由度', t.df == null ? '—' : t.df) +
          kv('p 值', t.p < 0.0001 ? '< 0.0001' : t.p.toFixed(4)) +
          kv('显著性水平', 'α = 0.05') +
          '</div>' +
          '<p class="detail">' + esc(t.detail) + '</p>' +
          (t.extras ? '<p class="extras">' + esc(t.extras) + '</p>' : '') +
          '<div class="test-chart" id="test-chart-' + idx + '"></div>' +
          '<div class="plain ' + (sig ? 'plain-warn' : 'plain-ok') + '">' +
          '<b>结论：</b>' + esc(t.result.text) + '<br><b>解读：</b>' + esc(t.plain) + '</div>' +
          '</div>';
      });

      panel.innerHTML = html;

      // 为特定检验渲染图表
      r.tests.forEach(function (t, idx) {
        var box = $('#test-chart-' + idx);
        if (!box) return;
        if (t.id === 'omission') {
          Charts.hbars(box, t.buckets.map(function (b) {
            return {
              label: b.label, value: b.rate * 100, digits: 2,
              display: pct(b.rate, 2), color: 'linear-gradient(90deg,#fbbf24,#f59e0b)',
              expectLine: b.baseP * 100
            };
          }), { legend: [{ label: '实际出现率', color: '#f59e0b' }, { label: '理论概率（竖线）', color: '#94a3b8' }] });
        } else if (t.id === 'repeat') {
          Charts.vbars(box, t.rows.map(function (x) {
            return {
              label: x.key + ' 个', value: x.ratio * 100, color: 'linear-gradient(180deg,#34d399,#059669)',
              expect: x.expectRatio * 100
            };
          }), { legend: [{ label: '实际占比', color: '#10b981' }, { label: '理论值（横线）', color: '#94a3b8' }] });
        } else if (t.id === 'memory') {
          Charts.hbars(box, t.series.map(function (s) {
            return {
              label: 'Lag-' + s.lag, value: Math.abs(s.r) * 1000, digits: 3,
              display: 'r = ' + s.r.toFixed(4), color: s.p < 0.05 ? 'linear-gradient(90deg,#f87171,#dc2626)' : 'linear-gradient(90deg,#a5b4fc,#6366f1)'
            };
          }), {});
        } else if (t.id === 'stability') {
          Charts.hbars(box, t.segments.map(function (sgt, i) {
            return {
              label: '第 ' + (i + 1) + ' 段 ' + sgt.from.slice(0, 4) + '年',
              value: sgt.sumMean, digits: 1,
              display: sgt.sumMean.toFixed(1) + '（卡方 ' + sgt.chi2.toFixed(0) + '）',
              color: sgt.p < 0.05 ? 'linear-gradient(90deg,#f87171,#dc2626)'
                : 'linear-gradient(90deg,#a5b4fc,#6366f1)',
              expectLine: t.theoSum
            };
          }), { legend: [{ label: '各段和值均值', color: '#6366f1' },
            { label: '理论期望 ' + t.theoSum.toFixed(1) + '（竖线）', color: '#94a3b8' }] });
          var tbl = '<div class="table-wrap" style="margin-top:14px"><table class="data-table">' +
            '<thead><tr><th>时间段</th><th>期数</th><th>卡方</th><th>p 值</th><th>最高号</th><th>最低号</th><th>和值均值</th></tr></thead><tbody>' +
            t.segments.map(function (sgt) {
              return '<tr><td>' + sgt.label + '</td><td>' + sgt.n + '</td>' +
                '<td>' + sgt.chi2.toFixed(1) + '</td>' +
                '<td class="' + (sgt.p < 0.05 ? 'down' : '') + '">' + sgt.p.toFixed(4) + '</td>' +
                '<td>' + pad2(sgt.topNum) + '(' + sgt.topCount + ')</td>' +
                '<td>' + pad2(sgt.lowNum) + '(' + sgt.lowCount + ')</td>' +
                '<td>' + sgt.sumMean.toFixed(1) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
          box.insertAdjacentHTML('beforeend', tbl);
        } else if (t.id === 'persistence') {
          Charts.hbars(box, [
            {
              label: '训练期最热 ' + t.hotNumbers.length + ' 号',
              value: t.hotHits, digits: 1,
              display: t.hotHits + ' 次（均值 ' + (t.hotHits / t.hotNumbers.length).toFixed(1) + '）',
              color: 'linear-gradient(90deg,#fb923c,#ea580c)',
              expectLine: t.expHit
            },
            {
              label: '训练期最冷 ' + t.coldNumbers.length + ' 号',
              value: t.coldHits, digits: 1,
              display: t.coldHits + ' 次（均值 ' + (t.coldHits / t.coldNumbers.length).toFixed(1) + '）',
              color: 'linear-gradient(90deg,#60a5fa,#2563eb)',
              expectLine: t.expHit
            }
          ], { legend: [{ label: '验证期实际出现次数', color: '#ea580c' },
            { label: '随机期望 ' + t.expHit.toFixed(1) + ' 次（竖线）', color: '#94a3b8' }] });
          var nums = function (arr) {
            return arr.map(function (x) { return pad2(x.num); }).join(' ');
          };
          box.insertAdjacentHTML('beforeend',
            '<p class="muted small" style="margin-top:10px">训练期最热号码：' + nums(t.hotNumbers) +
            '<br>训练期最冷号码：' + nums(t.coldNumbers) +
            '<br>频率相关系数 r = ' + t.correlation.toFixed(4) +
            '，随机模拟 95% 区间 [' + t.nullLo.toFixed(4) + ', ' + t.nullHi.toFixed(4) + ']</p>');
        } else if (t.id === 'markov' && t.topPairs && t.topPairs.length) {
          box.innerHTML = '<div class="table-wrap"><table class="data-table">' +
            '<thead><tr><th>号码转移</th><th>条件概率</th><th>基准概率</th><th>提升</th><th>z 值</th></tr></thead><tbody>' +
            t.topPairs.map(function (p) {
              return '<tr><td>' + pad2(p.from) + ' → ' + pad2(p.to) + '</td>' +
                '<td>' + pct(p.condP, 2) + '</td><td>' + pct(p.baseP, 2) + '</td>' +
                '<td class="' + (p.condP > p.baseP ? 'up' : 'down') + '">' +
                (p.condP > p.baseP ? '+' : '') + ((p.condP / p.baseP - 1) * 100).toFixed(0) + '%</td>' +
                '<td>' + p.z.toFixed(2) + '</td></tr>';
            }).join('') + '</tbody></table></div>' +
            '<p class="muted small">这些"显著"号码对是在 ' + t.df + ' 次比较中挑出的最强者，' +
            '多重比较下属于正常现象，不可作为投注依据。</p>';
        }
      });
    }, 20);
  }

  /* ============================================================
   * 面板 4：回测验证
   * ========================================================== */
  function renderBacktest() {
    var panel = $('#panel-backtest');
    var kind = state.kind;
    panel.innerHTML = '<div class="loading">正在执行滚动回测（约需数秒）…</div>';

    setTimeout(function () {
      var c = LC.cfg(kind);
      var bt = cached(kind, 'backtest', '', function () {
        return LM.computeWeights(kind, { backtestPeriods: 400, halflife: state.halflife });
      });

      var sig = bt.p < 0.05 && bt.z > 0;
      var diff = bt.avgHits.ensemble - bt.expectedHitRandom;
      var diffPct = bt.expectedHitRandom ? (diff / bt.expectedHitRandom) * 100 : 0;

      var html = '<div class="card conclusion-card">' +
        '<div class="card-head"><h3>回测结论</h3>' +
        '<span class="pill ' + (sig ? 'pill-ok' : 'pill-warn') + '">' +
        (sig ? '模型显著优于随机' : '未跑赢随机基线') + '</span></div>' +
        '<p class="conclusion">' +
        (sig
          ? '模型 Top-' + bt.K + ' 号码的命中表现显著高于随机基线（p = ' + bt.p.toFixed(4) + '）。仍需在更长期、更多玩法上验证稳定性。'
          : '模型 Top-' + bt.K + ' 号码的平均命中数为 ' + bt.avgHits.ensemble.toFixed(3) + ' 个，随机基线期望为 ' +
          bt.expectedHitRandom.toFixed(3) + ' 个，差异 ' + (diff >= 0 ? '+' : '') + diff.toFixed(3) +
          ' 个（' + (diffPct >= 0 ? '+' : '') + diffPct.toFixed(2) + '%），p = ' + bt.p.toFixed(4) +
          '，未达到统计显著。这说明基于历史数据的因子没有捕获到可重复的预测信号——与随机性检验的结论一致。') +
        '</p>' +
        '<p class="hint">回测方式：滚动前向验证（walk-forward）。每一期只用该期之前的数据训练，' +
        '预测下一期，避免"用未来数据预测过去"的自欺。</p>' +
        '</div>';

      html += '<div class="card"><div class="card-head"><h3>命中表现对比</h3></div>' +
        '<div class="kv-grid">' +
        kv('回测期数', bt.trials + ' 期') +
        kv('预测号码池 Top-K', 'K = ' + bt.K) +
        kv('模型平均命中', bt.avgHits.ensemble.toFixed(3) + ' 个') +
        kv('随机基线期望', bt.expectedHitRandom.toFixed(3) + ' 个') +
        kv('超额', (diff >= 0 ? '+' : '') + diff.toFixed(3) + ' 个') +
        kv('z 值 / p 值', bt.z.toFixed(3) + ' / ' + bt.p.toFixed(4)) +
        '</div>' +
        '<div id="bt-chart"></div>' +
        '<p class="muted small">折线为每期模型 Top-K 的命中个数，虚线为随机基线。</p>' +
        '</div>';

      // 各因子表现
      var rows = ['freq', 'omission', 'hot', 'transition'].map(function (k) {
        var ex = bt.excess[k];
        return {
          label: FACTOR_META[k].name, value: Math.abs(ex) * 1000,
          display: bt.avgHits[k].toFixed(3) + ' 个（' + (ex >= 0 ? '+' : '') + ex.toFixed(4) + '）',
          color: ex > 0 ? 'linear-gradient(90deg,#34d399,#10b981)' : 'linear-gradient(90deg,#fca5a5,#ef4444)',
          raw: ex
        };
      });
      html += '<div class="card"><div class="card-head"><h3>各因子独立表现</h3></div>' +
        '<p class="muted small">每个因子单独取 Top-K 时的平均命中数，与随机基线 ' +
        bt.expectedHitRandom.toFixed(3) + ' 个对比。</p>' +
        '<div id="factor-chart"></div>' +
        '<div class="weight-list">' + ['freq', 'omission', 'hot', 'transition'].map(function (k) {
          return '<span class="weight-item"><i style="background:' + FACTOR_META[k].color + '"></i>' +
            FACTOR_META[k].name + ' <b>' + (bt.weights[k] * 100).toFixed(0) + '%</b></span>';
        }).join('') + '</div>' +
        '<p class="hint">权重 = 35% 等权先验 + 65% 回测表现。若所有因子都没有超额表现，' +
        '权重会收敛到接近等权，模型输出退化为"受结构约束的加权抽样"。</p>' +
        '</div>';

      // 概率参考
      var odds = LM.combinationOdds(kind);
      html += '<div class="card"><div class="card-head"><h3>概率参考</h3></div>' +
        '<div class="kv-grid">' +
        kv(c.mainLabel + '组合数', odds.mainCombos.toLocaleString()) +
        kv(c.specialLabel + '组合数', odds.specialCombos.toLocaleString()) +
        kv('全部组合数', odds.totalCombos.toLocaleString()) +
        kv('单注中头奖概率', odds.totalOdds) +
        '</div>' +
        '<p class="hint">' + c.name + '共有 ' + odds.totalCombos.toLocaleString() +
        ' 种组合。任何选号方法都无法改变单注的中奖概率，' +
        '模型的价值只在于让号码分布更"典型"，而不是提高中奖率。</p>' +
        '</div>';

      panel.innerHTML = html;

      Charts.line($('#bt-chart'), [
        { name: '模型 Top-K 命中数', values: bt.series.slice(-200), color: '#f97316' },
        {
          name: '随机基线', color: '#94a3b8', dash: '5 4',
          values: bt.series.slice(-200).map(function () { return bt.expectedHitRandom; })
        }
      ], { height: 180, dots: false, min: 0 });

      Charts.hbars($('#factor-chart'), rows.map(function (r) {
        return {
          label: r.label, value: r.value, display: r.display, color: r.color
        };
      }), { legend: [{ label: '高于随机', color: '#10b981' }, { label: '低于随机', color: '#ef4444' }] });
    }, 20);
  }

  /* ============================================================
   * 首页加载完成：自动核对最新开奖
   *   · 首次加载要把双色球 + 大乐透都拿到（live.js 内部失败会自动重试）；
   *   · 只补"最近 30 期"的缺口 / 修正与官方不一致的期（LC.patchDraws）；
   *   · 有新数据才重算并重渲染，失败就继续用本地数据，功能不受影响；
   *   · 全部成功时提示条自动收起，有玩法没拿到则常驻并提供"重试"，
   *     角标长期显示"数据至 某日"与每个玩法的最近核对时间。
   * ========================================================== */
  var noteTimer = null;

  function liveNote(html, cls, hideAfter) {
    var box = $('#live-note');
    if (!box) return;
    clearTimeout(noteTimer);
    box.classList.remove('fading');
    if (!html) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.className = 'live-note' + (cls ? ' ' + cls : '');
    box.innerHTML = '<i class="dot"></i>' + html;
    if (hideAfter) {
      noteTimer = setTimeout(function () {
        box.classList.add('fading');
        noteTimer = setTimeout(function () {
          box.hidden = true;
          box.innerHTML = '';
        }, 320);
      }, hideAfter);
    }
  }

  var LIVE_KINDS = ['ssq', 'dlt'];
  var liveBusy = false;                    // 一轮核对进行中，避免重复触发

  // 单个玩法的核对结果文案（始终用 res.kind，不跟随当前切换到的玩法）
  function liveResText(res) {
    var name = LC.cfg(res.kind).name;
    if (!res.ok) return '<b>' + name + '</b> 未取到';
    var d = res.latest && res.latest.date ? res.latest.date : '—';
    var tail = res.added ? '新增 ' + res.added + ' 期'
      : (res.fixed ? '修正 ' + res.fixed + ' 期' : '已是最新');
    // 标出这条数据是从哪条链路来的，便于判断"是不是走了本地代理"
    var via = res.via === 'proxy' ? '本地代理'
      : (res.via === 'jsonp' ? 'JSONP' : (res.fromCache ? '会话缓存' : '官方接口'));
    return '<b>' + name + '</b> ' + tail + '（数据至 ' + d + ' · ' + via + '）';
  }

  // 补齐 / 修正数据后，刷新所有"依赖全量数据"的视图：
  //   · 角标、最新开奖卡始终刷新；
  //   · 停在一级页 → 重渲染当前面板；
  //   · 停在历史开奖记录页 → 原地重算列表与计数（保留搜索词），
  //     否则用户翻的正是这一页却看不到新数据；
  //   · 推荐结果页保留用户已生成的结果，不动（下次重算自然用新数据）。
  function refreshAfterPatch(kind) {
    renderBadge();
    renderHero();
    if (kind !== state.kind) return;
    var page = stack.length ? activePage() : null;
    if (!page) { switchTab(state.tab); return; }
    if (page !== 'draw-history') return;

    var el = mounted['draw-history'];
    var all = LC.draws(state.kind);
    var span = el && el.querySelector('.page-nav-text span');
    if (span && all.length) {
      span.innerHTML = LC.cfg(state.kind).name + ' · 共 ' + all.length + ' 期 · ' +
        all[0].d + ' ~ ' + all[all.length - 1].d;
    }
    renderHistList(true);
  }

  // kinds 省略 = 双色球 + 大乐透一起核对。首次加载要保证两个玩法都拿到：
  //   · 谁先拿到就先把它用起来，不必等另一个（某个来源卡住也不会拖住整页）；
  //   · 都拿到 → 提示条数秒后自动收起；
  //   · 有玩法没拿到 → 提示常驻，并提供"只重试失败玩法"的入口。
  function syncLive(kinds) {
    if (!window.LCLive || liveBusy) return;
    var list = kinds && kinds.length ? kinds : LIVE_KINDS.slice();
    var results = [];
    liveBusy = true;

    function progressText() {
      return list.map(function (k) {
        var done = null;
        results.forEach(function (r) { if (r.kind === k) done = r; });
        return done ? liveResText(done) : '<b>' + LC.cfg(k).name + '</b> 核对中…';
      }).join(' · ');
    }

    function onOne(res) {
      results.push(res);
      if (res.ok && (res.added || res.fixed)) {
        state.cache = {};                  // 统计 / 推荐 / 回测都依赖全量数据，必须失效
        refreshAfterPatch(res.kind);
      } else {
        renderBadge();
      }

      if (results.length < list.length) {
        liveNote('正在核对最新开奖：' + progressText(), 'syncing');
        return;
      }

      liveBusy = false;                    // 这一轮结束，允许再次核对 / 重试
      var fails = results.filter(function (r) { return !r.ok; });
      var text = progressText();
      if (!fails.length) {
        liveNote('开奖核对完成：' + text, 'ok', 12000);
        return;
      }

      // 虽没核对上，但本地数据已经覆盖到最近一期开奖（静态托管常见：
      // 数据文件是发布/定时更新时最新的，只是页面联不上代理）→ 不必打扰用户
      var fresh = fails.every(function (r) {
        var need = window.LCLive.lastDrawDate ? window.LCLive.lastDrawDate(r.kind) : '';
        var d = LC.draws(r.kind).slice(-1)[0];
        return !need || !d || String(d.d || '') >= need;
      });
      if (fresh) {
        var stamps = fails.map(function (r) {
          var d = LC.draws(r.kind).slice(-1)[0];
          return '<b>' + LC.cfg(r.kind).name + '</b> 数据至 ' + (d ? d.d : '—');
        }).join(' · ');
        liveNote('本次没能联网核对（' + why + '），但数据已覆盖最近一期开奖：' + stamps +
          '，可正常使用。若希望每次打开都实时核对，请配置远端代理' +
          '（见 index.html 里的 <code>window.LIVE_PROXY</code>）。', 'warn', 15000);
        return;
      }

      // 有玩法没拿到：提示常驻（不自动收起），点"重试"只重试失败的玩法
      var fileMode = window.LCLive.fileMode ||
        (typeof location !== 'undefined' && location.protocol === 'file:');
      // 把底层原因摊开写（如"页面服务器没有 /api 代理（HTTP 404）"），避免只看到"未取到"
      var why = fails.map(function (r) {
        return (r.error || '未知错误') + (r.proxyError ? '（' + r.proxyError + '）' : '');
      }).join('；');
      // 按失败性质给不同指引：没有代理 / file:// / 跨域被拦，处理办法并不一样
      var noProxy = fails.some(function (r) { return r.errorKind === 'no-proxy'; });
      var host = (typeof location !== 'undefined' && location.hostname) || '';
      var isLocal = !host || /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(host);
      var remote = window.LCLive.remoteBase ? (window.LCLive.remoteBase() || '') : '';
      var remoteText = remote ? '（已配为 <code>' + esc(remote) + '</code>，请确认它可访问）' : '';
      // 本地开发：起本地服务即可；静态托管（OSS / COS / Pages / CDN）：
      // 服务器不会提供 /api，得靠远端代理（云函数）或定时重新生成数据文件
      var howTo = isLocal
        ? '请在项目目录运行 <code>python3 scripts/serve.py</code>' +
          '（或双击 <code>启动本地服务.command</code>），再访问 ' +
          '<a href="http://localhost:8000/index.html" target="_blank" rel="noopener">' +
          'http://localhost:8000</a>'
        : '当前是静态托管站点，服务器不会提供 <code>/api</code> 代理：请把 ' +
          '<code>scripts/proxy_wsgi.py</code> 部署成云函数（阿里云函数计算 FC 即可），' +
          '再在 index.html 里写 <code>window.LIVE_PROXY = \'https://你的函数域名\'</code>' +
          remoteText + '；或改用 <code>.github/workflows/update-data.yml</code> ' +
          '定时重新生成并上传数据文件（无需代理也能保持数据最新）。';
      var hint;
      if (noProxy) {
        hint = '　' + (isLocal ? '当前页面不是由本地服务提供的：' : '当前站点没有可用的开奖代理：') +
          '服务器没有 <code>/api</code>' + (remote ? '、远端代理也取不到数据' : '') +
          '，浏览器又无法跨域直连官方接口。' + howTo;
      } else if (fileMode) {
        hint = '　file:// 直接打开时浏览器不会发送 Referer，官方接口会拒绝取数。' + howTo;
      } else {
        hint = '　浏览器没能拿到官方接口的响应（跨域 / Referer 被拦）。可改用本地服务：' +
          howTo;
      }
      liveNote('开奖核对：' + text + '（' + why + '）' +
        ' <button type="button" id="live-retry" class="live-retry">重试</button>' + hint, 'fail');
      var btn = $('#live-retry');
      if (btn) btn.addEventListener('click', function () {
        syncLive(fails.map(function (r) { return r.kind; }));
      });
    }

    liveNote('正在核对最新开奖：' + progressText(), 'syncing');
    list.forEach(function (kind) { window.LCLive.sync(kind, onOne); });
  }

  /* ============================================================
   * Tab 切换与初始化
   * ========================================================== */
  function switchTab(tab) {
    state.tab = tab;
    $$('.tabs button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    ['recommend', 'stats', 'tests', 'backtest'].forEach(function (t) {
      $('#panel-' + t).classList.toggle('hidden', t !== tab);
    });
    if (tab === 'recommend') renderRecommend();
    if (tab === 'stats') renderStats();
    if (tab === 'tests') renderTests();
    if (tab === 'backtest') renderBacktest();
  }

  function switchKind(kind) {
    state.kind = kind;
    state.seed = (Date.now() & 0x7fffffff);
    // 投注参数回到该玩法的默认值
    state.mainSel = null;
    state.specialSel = null;
    state.danCount = null;
    state.tuoCount = null;
    state.dtForm = 'main';
    state.sTuoCount = null;
    $$('.kind-switch button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.kind === kind);
    });
    renderHero();
    switchTab(state.tab);
  }

  function init() {
    if (!window.LOTTO_DATA || !window.LOTTO_DATA.ssq || !window.LOTTO_DATA.dlt) {
      document.body.innerHTML = '<div class="fatal">未找到历史数据文件。<br>' +
        '请在项目目录执行 <code>python3 scripts/fetch_data.py</code> 生成数据后刷新页面。</div>';
      return;
    }
    $$('.kind-switch button').forEach(function (b) {
      b.addEventListener('click', function () { switchKind(b.dataset.kind); });
    });
    $$('.tabs button').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.tab); });
    });
    renderHero();
    switchTab('recommend');
    // 首页渲染完成后再去核对最新开奖：失败也只是"没更新"，不影响任何功能
    syncLive();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
