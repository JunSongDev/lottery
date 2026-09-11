/* ============================================================
 * app.js — 界面逻辑
 * 依赖：LC / LS / LT / LM / Charts
 * ============================================================ */
(function () {
  'use strict';
  var LC = window.LC, LS = window.LS, LT = window.LT, LM = window.LM, Charts = window.Charts;

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
  function renderHero() {
    var c = LC.cfg(state.kind);
    var all = LC.draws(state.kind);
    var last = all[all.length - 1];
    var prev = all[all.length - 2];

    $('#data-badge').textContent = c.name + ' · ' + all.length + ' 期';

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
      '</div>';
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
    // 复式/胆拖是确定性输出，不随种子变化
    var key = kind + '|' + state.window + '|' + state.halflife + '|' +
      [params.betType, params.dtForm, params.mainSel, params.specialSel,
        params.danCount, params.tuoCount, params.sDanCount, params.sTuoCount,
        params.tickets].join(',') +
      '|' + (params.betType === 'single' ? seed : 'det');
    if (forceNewSeed) delete state.cache[key];
    if (!state.cache[key]) {
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
    return state.cache[key];
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
      combos = p.tickets;
    }
    return { combos: combos, cost: combos * bo.yuanPerBet };
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
      var ticketChips = TICKET_PRESETS.map(function (n) {
        return '<button class="chip' + (p.tickets === n ? ' active' : '') +
          '" data-tickets="' + n + '">' + n + ' 注</button>';
      }).join('');
      fields += '<div class="field"><label>推荐注数（' + TICKET_MIN + '–' + TICKET_MAX +
        ' 注，可在输入框里自定义）</label>' +
        '<div class="chips">' + ticketChips +
        '<label class="chip-input' + (isPresetTickets(p.tickets) ? '' : ' active') +
        '" for="tickets-input">' +
        '<input id="tickets-input" type="number" inputmode="numeric" ' +
        'min="' + TICKET_MIN + '" max="' + TICKET_MAX + '" step="1" ' +
        'value="' + p.tickets + '" aria-label="自定义推荐注数">' +
        '<span class="chip-input-unit">注</span>' +
        '</label>' +
        '</div></div>';
    }
    var pv = betPreview(c, bo, p);
    fields += '<div class="bet-preview" id="bet-preview"><span>预计</span><b>' +
      pv.combos.toLocaleString() + ' 注</b><span>·</span><b>' +
      pv.cost.toLocaleString() + ' 元</b></div>';
    return fields;
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

  // 即时刷新"预计 X 注 · Y 元"（不重建 DOM，避免输入时丢焦点）
  function updateBetPreview(panel) {
    var box = $('#bet-preview', panel);
    if (!box) return;
    var pv = betPreview(LC.cfg(state.kind), betOpts(), betParams());
    box.innerHTML = '<span>预计</span><b>' + pv.combos.toLocaleString() +
      ' 注</b><span>·</span><b>' + pv.cost.toLocaleString() + ' 元</b>';
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
      if (st.lottoPage === 'rec-result' && !activePage()) {
        historyPushed = true;                 // 前进：恢复二级页
        showResultPage(null, { noHistory: true });
      } else if (!st.lottoPage && activePage()) {
        historyPushed = false;                // 返回：收起二级页
        popPage();
      }
    });
  }

  // 二级页标题：胆拖要区分主区 / 特别区 / 双区
  function recBetLabel(p) {
    if (p.betType === 'dantuo') return LM.dtFormLabel(state.kind, p.dtForm);
    return betLabel(p.betType);
  }

  /* ---------- 二级页：推荐号码 ---------- */
  function resultPageHtml(c, p, pv) {
    var canRegen = state.betType === 'single';
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

    var html =
      '<div class="card">' +
      '<div class="card-head"><h3>分析设置</h3></div>' +
      '<div class="field"><label>分析样本窗口</label><div class="chips">' + winChips + '</div></div>' +
      '<div class="field"><label>投注方式</label><div class="chips">' + betChips + '</div>' +
      betNote(c, bo, p) + '</div>' +
      betParamFields(c, bo, p) +
      '</div>' +
      '<div class="gen-bar">' +
      '<div class="gen-sum">本次将生成 <b>' + pv.combos.toLocaleString() + '</b> 注，' +
      '共 <b>' + pv.cost.toLocaleString() + '</b> 元</div>' +
      '<button class="btn-primary" id="btn-generate">生成推荐号码</button>' +
      '<p class="hint">模型使用全部 ' + LC.draws(state.kind).length +
      ' 期历史数据训练，窗口仅影响结构典型度的统计口径。' +
      (state.betType === 'single' ? '' :
        '复式与胆拖按号码综合评分取前 N 名，属于确定性输出。') +
      '</p>' +
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

  function renderRecommendTickets(forceNewSeed) {
    var box = $('#rec-result');
    if (!box) return;
    var rec = buildRecommendation(forceNewSeed);
    var c = rec.config;
    var ticketsHtml;

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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
