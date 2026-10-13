/* ============================================================
 * live.js — 首页加载完成后自动核对最新开奖
 * 全局命名空间：window.LCLive
 * 依赖：LC（lotto-core.js）
 *
 * 取数链路（按"最稳 → 最快"依次尝试）：
 *   ① 同源代理 /api/<kind> —— 本地执行 python3 scripts/serve.py 时可用，
 *      由服务端去官方接口取数，彻底不受浏览器 Referer / 跨域策略影响；
 *   ② 远端代理 <LIVE_PROXY>/<kind> —— 静态托管（阿里云 OSS / COS / Pages / CDN）
 *      必备：这类站点只发文件、没有 /api，得把代理放到云函数上，
 *      靠它返回的 CORS 头取数（见 scripts/proxy_wsgi.py）；
 *   ③ 直连官方接口 fetch —— 仅在接口愿意返回 CORS 头时才可能成功
 *      （目前只有大乐透的 webapi.sporttery.cn 开放，双色球不行）。
 *
 * 实测（2026-09）：
 *   · 中彩网 jc.zhcw.com/port/client_json.php 已彻底不可用（带不带 Referer 都返回
 *     200 + 0 字节 body），双色球直连源已改为中国福利彩票官网 cwl.gov.cn；
 *   · 福彩官网与 500 彩票网都不返回 Access-Control-Allow-Origin，大乐透的
 *     webapi.sporttery.cn 则开放 CORS（*）；
 *   · 浏览器端无法伪造 Referer，跨域响应没有 CORS 头就拿不到正文。
 *   所以"页面自动核对"一定要走代理：本地开发用 ①，线上静态托管用 ②。
 *
 * 设计：
 *   · 只用"最近 30 期"这一个窗口去补齐 / 校正页面里的数据
 *     （窗口与 scripts/fetch_data.py 的交叉校验口径一致），
 *     全量历史仍然以离线数据文件 data-*.js 为准，脚本随时可离线重跑；
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

  /* ------------------------------------------------------------
   * 远端代理基址 —— 静态托管（OSS / COS / Pages / CDN）用
   * 这类站点只发静态文件，服务器上没有 /api 代理，浏览器又直连不了官方接口，
   * 于是把"取数"搬到云函数上（scripts/proxy_wsgi.py），页面改去请求它。
   * 值是一个基址，页面会请求 <基址>/ssq、<基址>/dlt。
   * 三种配置方式，优先级从高到低：
   *   ① URL 参数   ?proxy=https%3A%2F%2Fxxx.fcapp.run     （临时验收最方便）
   *   ② index.html window.LIVE_PROXY = 'https://xxx.fcapp.run'
   *   ③ 浏览器本地 localStorage.setItem('lotto-proxy', '...')
   * ---------------------------------------------------------- */
  function remoteBase() {
    try {
      var m = String((root.location && root.location.search) || '').match(/[?&]proxy=([^&]+)/);
      if (m) return decodeURIComponent(m[1]).replace(/\/+$/, '');
    } catch (e) { /* 解析失败就按没配置处理 */ }
    try {
      if (root.LIVE_PROXY) return String(root.LIVE_PROXY).replace(/\/+$/, '');
    } catch (e) { /* 同上 */ }
    try {
      var v = root.localStorage && root.localStorage.getItem('lotto-proxy');
      if (v) return String(v).replace(/\/+$/, '');
    } catch (e) { /* 隐私模式下不可读 */ }
    return '';
  }

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
      label: '中国福利彩票官网',
      proxy: '/api/ssq',    // 本地 serve.py 的同源代理（服务端取数，无跨域问题）
      // 直连源：接口本身有效，但不返回 CORS 头，浏览器 fetch 会被拦，
      // 所以实际只有同源代理这条路走得通（保留直连是为了 http(s) 部署时也能尝试）
      url: function () {
        return 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice' +
          '?name=ssq&issueCount=' + WINDOW_ROWS + '&pageNo=1&pageSize=' +
          WINDOW_ROWS + '&systemType=PC';
      },
      jsonp: false,         // 不支持 callback，只能 fetch
      parse: function (json) {
        return ((json && json.result) || []).map(function (x) {
          return {
            i: to7(x.code),
            d: String(x.date || '').slice(0, 10),
            r: nums(x.red),
            b: nums(x.blue)
          };
        });
      }
    },
    dlt: {
      label: '中国体育彩票官网',
      proxy: '/api/dlt',    // 本地 serve.py 的同源代理
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
      function fail(err) {
        clearTimeout(timer);
        var msg = (err && err.message) || '请求失败';
        // 浏览器跨域拦截只会给一个笼统的 "Failed to fetch"，
        // 换成能解释清楚的说明，提示条才有据可写
        if (/failed to fetch|fetch failed|networkerror|load failed|network request failed/i.test(msg)) {
          var e = new Error('直连被浏览器拦截（接口未返回 CORS 头）');
          e.cors = true;
          reject(e);
          return;
        }
        reject(err);
      }
      root.fetch(url, {
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      }).then(function (txt) {
        clearTimeout(timer);
        // 双色球接口缺少 Referer 时返回 200 + 空 body（也没有 CORS 头），
        // 直接给出能自解释的原因，方便提示条告诉用户该怎么办
        if (!txt) { reject(new Error('空响应（该接口要求 Referer）')); return; }
        var json;
        try { json = JSON.parse(txt); }
        catch (e) { reject(new Error('响应不是合法 JSON')); return; }
        resolve(json);
      }, fail);
    });
  }

  // 代理取数，两种形态：
  //   · 同源 /api/<kind>（scripts/serve.py 提供）：页面跟自己人通信，
  //     不受浏览器 Referer / 跨域策略影响；
  //   · 远端代理 <LIVE_PROXY>/<kind>（scripts/proxy_wsgi.py 部署到云函数）：
  //     静态托管（OSS 等）页面的主通路，靠它返回的 CORS 头拿到数据。
  function proxyRows(url, remote) {
    var what = remote ? '远端代理' : '本地代理';
    return new Promise(function (resolve, reject) {
      if (!url) { reject(new Error(remote ? '未配置远端代理' : '该来源没有本地代理')); return; }
      if (!root.fetch) { reject(new Error('当前浏览器不支持 fetch')); return; }
      var ctrl = root.AbortController ? new root.AbortController() : null;
      var timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error(what + '请求超时'));
      }, TIMEOUT);
      function fail(err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') { reject(new Error(what + '请求超时')); return; }
        // 代理不可达（file:// 打开、域名不通、被 CORS 拦）：
        // 环境问题，重试不会有不同结果 —— 标出来，别再空重试
        var e = new Error((err && err.message) || (what + '不可达'));
        e.noProxy = true;
        reject(e);
      }
      root.fetch(url, {
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        // 页面不是由 scripts/serve.py 提供时（普通静态服务器 / 静态托管等），
        // /api/* 只会返回 404 —— 一眼可判的环境问题
        if (res.status === 404 || res.status === 405 || res.status === 501) {
          var e = new Error((remote ? '远端代理未部署' : '页面服务器没有 /api 代理') +
            '（HTTP ' + res.status + '）');
          e.noProxy = true;
          throw e;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      }).then(function (txt) {
        clearTimeout(timer);
        var json;
        try { json = JSON.parse(txt); }
        catch (e) {
          // 静态托管常把找不到的路径回落成 index.html / 错误页（200 + HTML）
          var e2 = new Error(what + '返回的是 HTML 页面而不是 JSON' +
            (remote ? '' : '（该站点没有 /api 代理）'));
          e2.noProxy = true;
          reject(e2);
          return;
        }
        if (!json || !json.ok || !json.rows) {
          reject(new Error((json && json.error) || (what + '未返回可用数据')));
          return;
        }
        resolve({
          rows: json.rows,
          via: remote ? 'remote' : 'proxy',
          label: json.src || what
        });
      }, fail);
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

  // 依次尝试一串取数方式，全失败才 reject（抛出最后一个错误）
  function firstOf(queue, note) {
    var i = 0;
    function step(prev) {
      if (i >= queue.length) return Promise.reject(prev || new Error('未知错误'));
      return queue[i++]().then(null, function (err) {
        if (note) note(err);
        return step(err);
      });
    }
    return step();
  }

  // 取数：同源代理 → 远端代理 → 直连 fetch →（可选）JSONP
  function pull(kind, src) {
    var base = remoteBase();
    var noProxy = null;                 // 记住"代理根本不可用"这个更根本的原因
    // 配了远端代理就先试它：静态托管上同源 /api 必然是 404，先试只是白等一次
    var queue = [];
    if (base) queue.push(function () { return proxyRows(base + '/' + kind, true); });
    queue.push(function () { return proxyRows(src.proxy, false); });
    queue.push(function () {
      return getJson(src.url(), TIMEOUT).then(function (json) {
        return { json: json, via: 'direct' };
      });
    });
    // file:// 下浏览器不发 Referer，JSONP（script 标签）同样拿不到数据，
    // 没必要再空等一次 8 秒超时
    if (src.jsonp && !FILE_MODE) {
      queue.push(function () {
        return jsonp(src.url(), TIMEOUT).then(function (json) {
          return { json: json, via: 'jsonp' };
        });
      });
    }
    return firstOf(queue, function (err) {
      if (!err) return;
      if (err.noProxy) noProxy = err;
      // 直连被浏览器拦 + 前面根本没有可用代理 = 纯环境问题，
      // 重试不会有不同结果，提示条才能给出准确指引而不是只说"请求失败"
      if (err.cors && noProxy) {
        err.noProxy = true;
        err.fatal = true;
        err.proxyError = noProxy.message;
      }
    });
  }

  // 取数 + 校验，失败自动重试：首次加载要尽量保证"两个玩法都拿到"
  function fetchRows(kind, src) {
    var tries = 0;
    function once() {
      tries++;
      return pull(kind, src).then(function (out) {
        // 代理返回的已是规范化行；直连 / JSONP 返回原始 JSON，交给各自的 parse
        var rows = normalize(kind, out.rows || src.parse(out.json));
        if (!rows.length) throw new Error('接口未返回可用数据');
        return { rows: rows, tries: tries, via: out.via, label: out.label };
      });
    }
    function next() {
      return once().then(null, function (err) {
        if (err) err.tries = tries;           // 记录实际尝试次数，供提示条如实说明
        if (err && err.fatal) throw err;      // 环境问题（无代理 / 被拦），重试没意义
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

  /* ------------------------------------------------------------
   * 各玩法的开奖日（0 = 周日）：双色球 周二/四/日，大乐透 周一/三/六
   * 用来判断"本地数据是否已经覆盖到最近一期开奖"——
   * 静态托管站点常常联不上代理，但只要数据没过期，就不该打扰用户。
   * ---------------------------------------------------------- */
  var DRAW_DAYS = { ssq: [0, 2, 4], dlt: [1, 3, 6] };
  var DRAW_READY_HOUR = 21, DRAW_READY_MIN = 45;   // 21:15 / 21:25 开奖，稍留余量

  function ymd(t) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
  }

  // 该玩法"最近一个应该已经开奖"的日期（YYYY-MM-DD，按浏览器本地时区）
  function lastDrawDate(kind, now) {
    var days = DRAW_DAYS[kind];
    if (!days) return '';
    var base = now || new Date();
    var t = new Date(base.getTime());
    for (var i = 0; i < 8; i++) {
      if (days.indexOf(t.getDay()) >= 0) {
        // 当天开奖但还没到开奖时间 → 顺延到上一个开奖日
        if (i === 0) {
          var ready = new Date(t.getFullYear(), t.getMonth(), t.getDate(),
            DRAW_READY_HOUR, DRAW_READY_MIN);
          if (base < ready) { t.setDate(t.getDate() - 1); continue; }
        }
        return ymd(t);
      }
      t.setDate(t.getDate() - 1);
    }
    return '';
  }

  // 该玩法"下一个开奖日"（YYYY-MM-DD）：推荐记录用它推算这一注对的是哪一期。
  // 今天正好是开奖日且还没到开奖时间 → 就是今天；否则向后找最近的开奖日。
  function nextDrawDate(kind, now) {
    var days = DRAW_DAYS[kind];
    if (!days) return '';
    var base = now || new Date();
    var t = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    for (var i = 0; i < 8; i++) {
      if (days.indexOf(t.getDay()) >= 0) {
        if (i === 0) {
          var ready = new Date(t.getFullYear(), t.getMonth(), t.getDate(),
            DRAW_READY_HOUR, DRAW_READY_MIN);
          // 今天已经开过了 → 这一注只能对下一期
          if (base >= ready) { t.setDate(t.getDate() + 1); continue; }
        }
        return ymd(t);
      }
      t.setDate(t.getDate() + 1);
    }
    return '';
  }

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
        ok: true, kind: kind, label: src.label, fromCache: true, via: 'cache', at: hit.at,
        tries: 0, added: r0.added, fixed: r0.fixed, latest: latestOf(kind)
      });
      return;
    }

    fetchRows(kind, src).then(function (out) {
      cacheSet(kind, { at: Date.now(), rows: out.rows });
      var r = LC.patchDraws(kind, out.rows);
      finish({
        ok: true, kind: kind, label: out.label || src.label, fromCache: false,
        via: out.via, at: Date.now(),
        tries: out.tries, added: r.added, fixed: r.fixed, latest: latestOf(kind)
      });
    }, function (err) {
      finish({
        ok: false, kind: kind, label: src.label, via: null,
        tries: (err && err.tries) || tryLimit(),
        error: (err && err.message) || '未知错误',
        // 代理本身为什么不可用（HTTP 404 / 未部署 …），供提示条如实说明
        proxyError: (err && err.proxyError) || null,
        // no-proxy：没有可用代理；cors：浏览器拦掉了跨域响应
        errorKind: err && err.noProxy ? 'no-proxy' : (err && err.cors ? 'cors' : 'other'),
        at: Date.now()
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
    remoteBase: remoteBase,      // 当前生效的远端代理基址（静态托管用），未配置时为空串
    lastDrawDate: lastDrawDate,  // 该玩法最近一个"应该已开奖"的日期 YYYY-MM-DD
    nextDrawDate: nextDrawDate,  // 该玩法"下一个开奖日" YYYY-MM-DD（推荐记录用它推算目标期）
    WINDOW_ROWS: WINDOW_ROWS,
    MAX_TRIES: MAX_TRIES,
    fileMode: FILE_MODE
  };
})(window);
