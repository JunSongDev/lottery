/* ============================================================
 * live.js — 首页加载完成后自动核对最新开奖
 * 全局命名空间：window.LCLive
 * 依赖：LC（lotto-core.js）
 *
 * 设计：
 *   · 只用"最近 30 期"这一个窗口去补齐 / 校正页面里的数据
 *     （窗口与 scripts/fetch_data.py 的交叉校验口径一致），
 *     全量历史仍然以离线数据文件 data-*.js 为准，脚本随时可离线重跑；
 *   · 双色球走中彩网开奖接口（实测：请求必须带 Referer，否则返回空 body；
 *     支持 callback，所以 http 打开时走 fetch 或 JSONP 都能取数），
 *     大乐透走中国体育彩票官网接口（开放 CORS，仅 fetch 可用）；
 *   · 因此用 http://localhost 打开时两个来源都能拿到；用 file:// 直接打开时
 *     浏览器不发 Referer、又拦跨域，两个来源都拿不到 —— 这种情况直接提示
 *     "用本地服务打开"，不做无谓重试（见下方 FILE_MODE）；
 *   · 任何一个来源失败 = "这次没核对上"，页面继续用本地数据，功能不受影响；
 *   · 首次加载必须把两个玩法都拿到：单个玩法失败会自动重试（最多 MAX_TRIES 次），
 *     只有重试全部失败才算"这次没核对上"（网络抖动、偶发超时都能自愈）；
 *   · 结果按玩法缓存 10 分钟（sessionStorage），避免每次刷新都打接口；
 *     只有"成功"的结果才进缓存，失败不会留下脏缓存，下次加载会重新拉；
 *   · 只补最新、只改与官方不一致的期，历史数据不会被"缩水"。
 * ============================================================ */
(function (root) {
  'use strict';
  var LC = root.LC;

  var WINDOW_ROWS = 30;                 // 核对窗口：最近 30 期
  var TIMEOUT = 8000;                   // 单次请求超时（毫秒）
  var MAX_TRIES = 3;                    // 单个玩法最多尝试次数（首次 + 2 次重试）
  var RETRY_DELAY = [600, 1800];        // 第 2、3 次尝试前的等待（毫秒）
  // 以 file:// 直接打开时：浏览器不发 Referer（中彩网要 Referer 才返数据），
  // 又会拦截跨域（体彩接口只允许 fetch 不允许 JSONP），两个来源都拿不到，
  // 这时只尝试一次，把"需要本地服务"这件事尽快反馈给用户。
  var FILE_MODE = !!(root.location && root.location.protocol === 'file:');
  function tryLimit() { return FILE_MODE ? 1 : MAX_TRIES; }
  var CACHE_KEY = 'lotto-live-v1';      // sessionStorage 键名
  var CACHE_TTL = 10 * 60 * 1000;       // 会话内缓存 10 分钟

  function asc(a, b) { return a - b; }

  // 期号统一成 7 位：26106 -> 2026106
  function to7(issue) {
    var s = String(issue == null ? '' : issue).trim();
    return /^\d{5}$/.test(s) ? '20' + s : s;
  }

  // "02 04 13" / "2,4,13" / "08" -> [2,4,13]
  function nums(v) {
    var m = String(v == null ? '' : v).match(/\d+/g) || [];
    return m.map(Number).filter(function (n) { return isFinite(n); });
  }

  function uniqSorted(arr) {
    var seen = {}, out = [];
    arr.map(Number).sort(asc).forEach(function (n) {
      if (!isFinite(n) || seen[n]) return;
      seen[n] = 1;
      out.push(n);
    });
    return out;
  }

  /* ============================================================
   * 数据源：每个玩法一个"最近 N 期"接口
   * ========================================================== */
  var SOURCES = {
    ssq: {
      label: '中彩网',
      url: function () {
        return 'https://jc.zhcw.com/port/client_json.php' +
          '?transactionType=10001001&lotteryId=1&issueCount=' + WINDOW_ROWS +
          '&type=0&pageNum=1&pageSize=' + WINDOW_ROWS + '&tt=' + Date.now();
      },
      jsonp: true,          // 支持 callback，file:// 打开时也能取数
      parse: function (json) {
        return ((json && json.data) || []).map(function (x) {
          return {
            i: to7(x.issue),
            d: String(x.openTime || '').slice(0, 10),
            r: nums(x.frontWinningNum),
            b: nums(x.backWinningNum)
          };
        });
      }
    },
    dlt: {
      label: '中国体育彩票官网',
      url: function () {
        return 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry' +
          '?gameNo=85&provinceId=0&pageSize=' + WINDOW_ROWS + '&isVerify=1&pageNo=1';
      },
      jsonp: false,         // 该接口不支持 callback，只能 fetch
      parse: function (json) {
        var list = (json && json.value && json.value.list) || [];
        return list.map(function (x) {
          var all = nums(x.lotteryDrawResult);         // 前区 5 + 后区 2
          return {
            i: to7(x.lotteryDrawNum),
            d: String(x.lotteryDrawTime || '').slice(0, 10),
            r: all.slice(0, 5),
            b: all.slice(5)
          };
        });
      }
    }
  };

  // 只保留"期号合法 + 号码个数与取值区间都对"的行，脏数据一律丢弃
  function normalize(kind, rows) {
    var c = LC.cfg(kind);
    var out = [];
    (rows || []).forEach(function (r) {
      var i = to7(r && r.i);
      if (!/^\d{7}$/.test(i)) return;
      var rn = uniqSorted(r.r || []), bn = uniqSorted(r.b || []);
      if (rn.length !== c.mainCount || bn.length !== c.specialCount) return;
      if (rn[0] < c.mainMin || rn[rn.length - 1] > c.mainMax) return;
      if (bn[0] < c.specialMin || bn[bn.length - 1] > c.specialMax) return;
      out.push({ i: i, d: String(r.d || ''), r: rn, b: bn });
    });
    return out;
  }

  /* ============================================================
   * 两种取数方式
   * ========================================================== */

  function getJson(url, timeout) {
    return new Promise(function (resolve, reject) {
      if (!root.fetch) { reject(new Error('当前浏览器不支持 fetch')); return; }
      var ctrl = root.AbortController ? new root.AbortController() : null;
      var timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('请求超时'));
      }, timeout);
      root.fetch(url, {
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (json) {
        clearTimeout(timer);
        resolve(json);
      }, function (err) {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function jsonp(url, timeout) {
    return new Promise(function (resolve, reject) {
      var name = '__lclive_cb' + Math.floor(Math.random() * 1e9);
      var script = document.createElement('script');
      var timer = setTimeout(function () { cleanup(); reject(new Error('请求超时')); }, timeout);
      function cleanup() {
        clearTimeout(timer);
        try { delete root[name]; } catch (e) { root[name] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      root[name] = function (data) { cleanup(); resolve(data); };
      script.onerror = function () { cleanup(); reject(new Error('网络错误')); };
      script.src = url + '&callback=' + name;
      document.head.appendChild(script);
    });
  }

  // 先 fetch（更干净），失败再退回 JSONP（file:// / 部分隐私设置下只有它能用）
  function pull(src) {
    return getJson(src.url(), TIMEOUT).then(null, function (err) {
      if (!src.jsonp) throw err;
      return jsonp(src.url(), TIMEOUT);
    });
  }

  // 取数 + 校验，失败自动重试：首次加载要尽量保证"两个玩法都拿到"
  function fetchRows(kind, src) {
    var tries = 0;
    function next() {
      tries++;
      return pull(src).then(function (json) {
        var rows = normalize(kind, src.parse(json));
        if (!rows.length) throw new Error('接口未返回可用数据');
        return { rows: rows, tries: tries };
      }, function (err) {
        if (tries >= tryLimit()) throw err;
        var wait = RETRY_DELAY[Math.min(tries - 1, RETRY_DELAY.length - 1)];
        return new Promise(function (resolve, reject) {
          setTimeout(function () { next().then(resolve, reject); }, wait);
        });
      });
    }
    return next();
  }

  /* ============================================================
   * 会话内缓存
   * ========================================================== */

  function store() {
    try { return root.sessionStorage; } catch (e) { return null; }
  }

  function cacheGet(kind) {
    var st = store();
    if (!st) return null;
    try {
      var all = JSON.parse(st.getItem(CACHE_KEY) || '{}');
      var row = all[kind];
      if (!row || !row.rows || !row.rows.length) return null;
      if (Date.now() - row.at > CACHE_TTL) return null;
      return row;
    } catch (e) { return null; }
  }

  function cacheSet(kind, row) {
    var st = store();
    if (!st) return;
    try {
      var all = JSON.parse(st.getItem(CACHE_KEY) || '{}');
      all[kind] = row;
      st.setItem(CACHE_KEY, JSON.stringify(all));
    } catch (e) { /* 隐私模式 / 存储满：静默忽略 */ }
  }

  /* ============================================================
   * 对外接口
   * ========================================================== */

  var last = {};      // 每个玩法最近一次核对结果，供界面展示

  function latestOf(kind) {
    var all = LC.draws(kind);
    var d = all[all.length - 1];
    return d ? { issue: d.i, date: d.d, total: all.length } : null;
  }

  function sync(kind, done) {
    var src = SOURCES[kind];
    function finish(res) {
      last[kind] = res;
      if (done) done(res);
    }
    if (!LC || !src) {
      finish({ ok: false, kind: kind, error: '缺少数据模块', at: Date.now() });
      return;
    }

    var hit = cacheGet(kind);
    if (hit) {
      var r0 = LC.patchDraws(kind, hit.rows);
      finish({
        ok: true, kind: kind, label: src.label, fromCache: true, at: hit.at,
        tries: 0, added: r0.added, fixed: r0.fixed, latest: latestOf(kind)
      });
      return;
    }

    fetchRows(kind, src).then(function (out) {
      cacheSet(kind, { at: Date.now(), rows: out.rows });
      var r = LC.patchDraws(kind, out.rows);
      finish({
        ok: true, kind: kind, label: src.label, fromCache: false, at: Date.now(),
        tries: out.tries, added: r.added, fixed: r.fixed, latest: latestOf(kind)
      });
    }, function (err) {
      finish({
        ok: false, kind: kind, label: src.label, tries: tryLimit(),
        error: (err && err.message) || '未知错误', at: Date.now()
      });
    });
  }

  function syncAll(kinds, done) {
    var list = kinds && kinds.length ? kinds : Object.keys(SOURCES);
    var left = list.length, out = [];
    list.forEach(function (kind) {
      sync(kind, function (res) {
        out.push(res);
        if (--left === 0 && done) done(out);
      });
    });
  }

  root.LCLive = {
    sync: sync,
    syncAll: syncAll,
    last: last,
    sources: SOURCES,
    WINDOW_ROWS: WINDOW_ROWS,
    MAX_TRIES: MAX_TRIES,
    fileMode: FILE_MODE
  };
})(window);
