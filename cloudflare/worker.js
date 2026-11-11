/**
 * 开奖数据代理（Cloudflare Workers 版 · 单文件 · 零依赖）
 *
 * 为什么必须有它：
 *   页面要"一打开就自动核对最新开奖"，但福彩官网不返回 CORS 头，
 *   浏览器直连必然被拦（详见 js/live.js 顶部注释）。
 *   GitHub Pages 只发静态文件、没有 /api，于是把"去官方接口取数"
 *   搬到 Workers 上：由服务端带 Referer / UA 取官方数据，
 *   并给响应加 CORS 头。部署一次，之后每次打开页面都会自动核对。
 *
 * 与 scripts/proxy_wsgi.py（阿里云 FC 版）行为一致：
 *   GET /ssq、/dlt → 最近 30 期开奖（兼容 /api/ssq 等带前缀的路径）
 *   GET /          → 服务自检
 *   OPTIONS *      → CORS 预检
 *
 * 部署（全程浏览器操作，无需命令行，免费套餐即可）：
 *   1. 注册 / 登录 https://dash.cloudflare.com（免费版不需要绑卡）
 *   2. 左侧菜单「Workers & Pages」→「Create」→ 选「Start with Hello World!」
 *   3. 名字填 lottery-proxy（可自定义），第一次会先让你选一个
 *      workers.dev 子域名（随意起个名字）→ 点 Deploy
 *   4. 部署完点「Edit code」，把模板代码全选删掉，整份粘贴本文件 → 右上「Deploy」
 *   5. 回到 Worker 概览页拿到你的地址，形如
 *      https://lottery-proxy.<你的子域>.workers.dev
 *   6. 自检（重要）：手机/电脑浏览器直接打开 https://<该地址>/ssq，
 *      应返回 {"ok":true,...,"rows":[...30 条...]}。
 *      ★ 大陆网络对 workers.dev 的可达性历史上不稳定（DNS 污染），
 *        这一步必须实测；打不开的话见 README.md「如果不通」。
 *   7. 可用后把地址写进 index.html：
 *      window.LIVE_PROXY = 'https://lottery-proxy.<你的子域>.workers.dev'
 *      临时验证也可以不改文件：index.html?proxy=https%3A%2F%2F<该地址>
 *
 * 免费额度：100,000 次请求/天。页面每次打开 = /ssq + /dlt 两次请求，
 * 且下方有 2 分钟的边缘缓存兜底，正常个人使用远远用不完。
 */

var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var ROWS = 30;            // 核对窗口：最近 30 期（与 js/live.js 的 WINDOW_ROWS 一致）
var TIMEOUT = 10000;      // 单次上游请求超时（毫秒）
var TRIES = 2;            // 上游尝试次数（与 proxy_wsgi.py 一致）
var CACHE_TTL = 120;      // 边缘缓存（秒）：开奖日之外不必频繁打扰官方接口

var SSQ_URL = 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice' +
  '?name=ssq&issueCount=' + ROWS + '&pageNo=1&pageSize=' + ROWS + '&systemType=PC';
var DLT_URL = 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry' +
  '?gameNo=85&provinceId=0&pageSize=' + ROWS + '&isVerify=1&pageNo=1';

/* ------------------------------------------------------------
 * 数据源：与 proxy_wsgi.py 相同的取数头与解析规则
 *   · 福彩官网靠 Referer 防盗链：不带 Referer 会返回 200 + 空 body，
 *     浏览器发不了跨域 Referer，所以必须由服务端带；
 *   · sporttery 的 Referer 与 UA 同样照官方页面带全，避免被 WAF 拦。
 * ---------------------------------------------------------- */
var SOURCES = {
  ssq: {
    label: '中国福利彩票官网',
    url: SSQ_URL,
    referer: 'https://www.cwl.gov.cn/',
    parse: parseSSQ,
  },
  dlt: {
    label: '中国体育彩票官网',
    url: DLT_URL,
    referer: 'https://static.sporttery.cn/',
    parse: parseDLT,
  },
};

function to7(issue) {
  var s = String(issue == null ? '' : issue).trim();
  return /^\d{5}$/.test(s) ? '20' + s : s;
}

// "1,2,3" / "1 2 3" / [1,2,3] -> [1,2,3]
function nums(v) {
  var m = String(v == null ? '' : v).match(/\d+/g) || [];
  return m.map(Number).filter(Number.isFinite);
}

function asc(a, b) { return a - b; }

function parseSSQ(text) {
  var data = JSON.parse(text);
  return (data.result || []).map(function (it) {
    return {
      i: to7(it.code),
      d: String(it.date || '').slice(0, 10),
      r: nums(it.red).sort(asc),
      b: [Number(it.blue)],
    };
  });
}

function parseDLT(text) {
  var data = JSON.parse(text);
  var list = (data.value || {}).list || [];
  return list.map(function (it) {
    var all = nums(it.lotteryDrawResult);            // 前区 5 + 后区 2
    return {
      i: to7(it.lotteryDrawNum),
      d: String(it.lotteryDrawTime || '').slice(0, 10),
      r: all.slice(0, 5).sort(asc),
      b: all.slice(5).sort(asc),
    };
  });
}

/* ------------------------------------------------------------
 * 上游取数（带超时 + 一次重试）
 * ---------------------------------------------------------- */
function httpGet(url, referer) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Referer': referer,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: ctrl.signal,
  }).then(function (resp) {
    clearTimeout(timer);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.text();
  }, function (err) {
    clearTimeout(timer);
    throw err;
  });
}

/* ------------------------------------------------------------
 * 边缘缓存：Workers 的内存变量在实例间不共享也不持久，
 * 所以用 Cache API + "时间桶"键实现固定 TTL
 * （键按 CACHE_TTL 取整，桶变了自然过期，桶内命中直接回）
 * ---------------------------------------------------------- */
function getRows(kind, src) {
  var bucket = Math.floor(Date.now() / (CACHE_TTL * 1000));
  var cacheKey = new Request('https://cache.internal/' + kind + '?bucket=' + bucket);
  var cache = caches.default;

  function fromUpstream() {
    var lastErr = null;
    function attempt(n) {
      return httpGet(src.url, src.referer).then(function (text) {
        var rows = src.parse(text).sort(function (a, b) {
          return a.i < b.i ? -1 : a.i > b.i ? 1 : 0;
        }).slice(-ROWS);
        if (!rows.length) throw new Error('未返回数据');
        // 行数据是纯 JSON 数组，缓存一份供本桶内后续请求直接命中
        return cache.put(cacheKey, new Response(JSON.stringify(rows), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })).then(function () { return { rows: rows, cached: false }; });
      }, function (err) {
        lastErr = err;
        if (n + 1 >= TRIES) throw lastErr;
        return new Promise(function (r) { setTimeout(r, 800 * (n + 1)); })
          .then(function () { return attempt(n + 1); });
      });
    }
    return attempt(0);
  }

  return cache.match(cacheKey).then(function (hit) {
    if (hit) return hit.json().then(function (rows) { return { rows: rows, cached: true }; });
    return fromUpstream();
  });
}

/* ------------------------------------------------------------
 * 响应与 CORS
 * ---------------------------------------------------------- */
function corsHeaders(origin) {
  // 回显 Origin 比写死 * 更稳，能配合带凭证的请求
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  };
}

function json(data, origin, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: corsHeaders(origin),
  });
}

export default {
  async fetch(request) {
    var url = new URL(request.url);
    // 只取路径最后一段作为玩法名：/ssq、/api/ssq、带函数前缀的路径都能识别
    var segs = url.pathname.split('/').filter(Boolean);
    var apiIdx = segs.indexOf('api');
    if (apiIdx !== -1) segs = segs.slice(apiIdx + 1);
    var kind = (segs[segs.length - 1] || '').toLowerCase();
    var origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    if (request.method !== 'GET') {
      return json({ ok: false, error: '只支持 GET' }, origin, 404);
    }
    if (kind === '' || kind === 'health' || kind === 'healthz') {
      return json({
        ok: true,
        service: 'lottery-live-proxy',
        runtime: 'cloudflare-workers',
        endpoints: ['dlt', 'ssq'],
        hint: '用法：/ssq、/dlt',
      }, origin);
    }

    var src = SOURCES[kind];
    if (!src) {
      return json({ ok: false, error: '未知玩法：' + kind + '（可用：dlt、ssq）' }, origin, 404);
    }

    var t0 = Date.now();
    try {
      var out = await getRows(kind, src);
      return json({
        ok: true,
        kind: kind,
        src: src.label,
        cached: out.cached,
        ms: Date.now() - t0,
        at: Date.now(),
        rows: out.rows,
      }, origin);
    } catch (err) {
      return json({
        ok: false,
        error: src.label + ' 取数失败：' + ((err && err.message) || err),
      }, origin, 502);
    }
  },
};
