#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
开奖数据代理（单文件、零第三方依赖、标准 WSGI）

为什么必须有它：
  页面要"一打开就自动核对最新开奖"，但福彩官网不返回 CORS 头，
  浏览器直连必然被拦（详见 js/live.js 顶部注释）。
  纯静态托管（阿里云 OSS / 腾讯云 COS / GitHub Pages / CDN）只发文件、没有 /api，
  于是把"去官方接口取数"搬到云函数上：由服务端带 UA 取官方数据，并给响应加 CORS 头。
  部署一次，之后每次打开页面都会自动核对 —— 用户不再需要本地起服务。

为什么是单文件：
  云函数控制台往往只能粘贴代码，打 zip 还得配入口、带依赖。
  本文件把抓取与解析都写在里面，不 import 同目录的 fetch_data.py，
  直接整份粘贴成 index.py 即可运行（入口填 index.app）。

部署（阿里云函数计算 FC，推荐，与 OSS 同账号、有免费额度）：
  选「Web 函数」，然后按控制台给的运行环境二选一，两种本文件都能跑：
  A) 自定义运行时（Linux / Debian，控制台默认选项，什么都不用改）
     · 代码粘进 app.py，启动命令保持 python3 app.py，监听端口保持 9000
       —— 本文件默认就监听 9000，所以默认值直接可用；
  B) 内置运行时 Python 3.10（如果下拉里能选到，更省事）
     · 代码粘进 app.py，函数入口填 app.app，不用填启动命令和监听端口；
  之后建 HTTP 触发器（认证方式选「无需认证」），拿到公网域名
  （形如 xxx.cn-hangzhou.fcapp.run），浏览器访问 https://<你的域名>/
  应返回 {"ok":true,...} 自检 JSON，再在 index.html 里写：
      window.LIVE_PROXY = 'https://<你的域名>'
  临时验证也可以直接在网址后加参数：index.html?proxy=https%3A%2F%2F<你的域名>
其他平台（腾讯云 SCF Web 函数 / 云托管 / gunicorn / uWSGI）同理，入口都是 app。

本地验证：
  python3 scripts/proxy_wsgi.py 8081
  curl -i http://127.0.0.1:8081/ssq

路由：
  GET /ssq、/dlt   → 最近 30 期开奖（同时兼容 /api/ssq、/api/dlt，以及带函数前缀的路径）
  GET /            → 服务自检
  OPTIONS *        → CORS 预检
"""

import json
import os
import threading
import time
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

SSQ_URL = ("https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice"
           "?name=ssq&issueCount=30&pageNo=1&pageSize=30&systemType=PC")
DLT_URL = ("https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry"
           "?gameNo=85&provinceId=0&pageSize=30&isVerify=1&pageNo=1")

ROWS = 30            # 核对窗口：最近 30 期（与 js/live.js 的 WINDOW_ROWS 一致）
API_TIMEOUT = 10     # 单次请求超时（秒）
API_TRIES = 2        # 尝试次数（云函数有执行时限，不宜太多）
CACHE_TTL = 60       # 结果缓存（秒）：开奖日之外不必频繁打扰官方接口

_lock = threading.Lock()
_cache = {}          # kind -> (时间戳, rows)


def _http_get(url, referer, tries=API_TRIES, timeout=API_TIMEOUT):
    last = None
    for n in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Referer": referer,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-CN,zh;q=0.9",
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", "ignore")
        except Exception as exc:                       # noqa: BLE001
            last = exc
            if n + 1 < tries:
                time.sleep(1.0 * (n + 1))
    raise RuntimeError("%s" % last)


def _to7(issue):
    """期号统一成 7 位：26106 -> 2026106"""
    s = str(issue).strip()
    return "20" + s if (len(s) == 5 and s.isdigit()) else s


def _fetch_ssq():
    """中国福利彩票官网：最近 30 期双色球"""
    data = json.loads(_http_get(SSQ_URL, "https://www.cwl.gov.cn/"))
    rows = []
    for it in data.get("result", []):
        rows.append({
            "i": _to7(it["code"]),
            "d": str(it.get("date", ""))[:10],
            "r": sorted(int(x) for x in str(it["red"]).split(",")),
            "b": [int(it["blue"])],
        })
    return rows


def _fetch_dlt():
    """中国体育彩票官网：最近 30 期大乐透"""
    data = json.loads(_http_get(DLT_URL, "https://static.sporttery.cn/"))
    rows = []
    for it in (data.get("value") or {}).get("list", []):
        nums = [int(x) for x in str(it["lotteryDrawResult"]).split()]
        rows.append({
            "i": _to7(it["lotteryDrawNum"]),
            "d": str(it.get("lotteryDrawTime", ""))[:10],
            "r": sorted(nums[:5]),
            "b": sorted(nums[5:]),
        })
    return rows


SOURCES = {
    "ssq": ("中国福利彩票官网", _fetch_ssq),
    "dlt": ("中国体育彩票官网", _fetch_dlt),
}


def rows_for(kind):
    """带 TTL 缓存取数（云函数实例会被复用，缓存能显著降低延迟与官方压力）"""
    now = time.time()
    with _lock:
        hit = _cache.get(kind)
        if hit and now - hit[0] < CACHE_TTL:
            return hit[1], True
    label, loader = SOURCES[kind]
    rows = sorted(loader(), key=lambda x: x["i"])[-ROWS:]
    if not rows:
        raise RuntimeError("%s 未返回数据" % label)
    with _lock:
        _cache[kind] = (time.time(), rows)
    return rows, False


_STATUS = {
    200: "200 OK",
    204: "204 No Content",
    404: "404 Not Found",
    502: "502 Bad Gateway",
}
_CORS_HEADERS = ("Access-Control-Allow-Origin", "Access-Control-Allow-Methods",
                 "Access-Control-Allow-Headers", "Access-Control-Max-Age")


def _json(start_response, code, payload, origin):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    start_response(_STATUS[code], [
        ("Content-Type", "application/json; charset=utf-8"),
        ("Content-Length", str(len(body))),
        ("Access-Control-Allow-Origin", origin),
        ("Access-Control-Allow-Methods", "GET, OPTIONS"),
        ("Access-Control-Max-Age", "86400"),
        ("Cache-Control", "no-store, no-cache, must-revalidate"),
    ])
    return [body]


def app(environ, start_response):
    method = (environ.get("REQUEST_METHOD") or "GET").upper()
    # 只取路径最后一段作为玩法名：这样 /ssq、/api/ssq、
    # 以及云函数常见的 /2023-03-30/f-name/ssq 前缀都能正确识别
    segs = [p for p in (environ.get("PATH_INFO") or "/").split("/") if p]
    if "api" in segs:
        segs = segs[segs.index("api") + 1:]
    kind = (segs[-1] if segs else "").lower()

    # 回显 Origin 比写死 * 更稳，能配合带凭证的请求
    origin = environ.get("HTTP_ORIGIN") or "*"

    if method == "OPTIONS":
        start_response(_STATUS[204], [
            ("Access-Control-Allow-Origin", origin),
            ("Access-Control-Allow-Methods", "GET, OPTIONS"),
            ("Access-Control-Allow-Headers", "Content-Type"),
            ("Access-Control-Max-Age", "86400"),
            ("Content-Length", "0"),
        ])
        return [b""]

    if method != "GET":
        return _json(start_response, 404, {"ok": False, "error": "只支持 GET"}, origin)

    if kind in ("", "health", "healthz"):
        return _json(start_response, 200, {
            "ok": True,
            "service": "lottery-live-proxy",
            "endpoints": sorted(SOURCES.keys()),
            "hint": "用法：/ssq、/dlt",
        }, origin)

    item = SOURCES.get(kind)
    if item is None:
        return _json(start_response, 404, {
            "ok": False,
            "error": "未知玩法：%s（可用：%s）" % (kind, "、".join(sorted(SOURCES))),
        }, origin)

    t0 = time.time()
    try:
        rows, cached = rows_for(kind)
    except Exception as exc:                           # noqa: BLE001
        return _json(start_response, 502, {
            "ok": False,
            "error": "%s 取数失败：%s" % (item[0], exc),
        }, origin)

    return _json(start_response, 200, {
        "ok": True,
        "kind": kind,
        "src": item[0],
        "cached": cached,
        "ms": int((time.time() - t0) * 1000),
        "at": int(time.time() * 1000),
        "rows": rows,
    }, origin)


DEFAULT_PORT = 9000        # 云函数自定义运行时的约定监听端口（阿里云 FC / 腾讯云 SCF）


def _port(argv):
    """端口优先级：命令行参数 > 平台注入的环境变量 > 9000（云函数默认值）"""
    if len(argv) > 1 and argv[1].isdigit():
        return int(argv[1])
    for name in ("FC_SERVER_PORT", "SERVER_PORT", "PORT", "SCF_SERVER_PORT"):
        val = (os.environ.get(name) or "").strip()
        if val.isdigit():
            return int(val)
    return DEFAULT_PORT


def main(argv):
    import socketserver
    from wsgiref.simple_server import WSGIServer, make_server

    # 云函数会并发打请求，wsgiref 默认单线程容易排队，这里加上线程池
    class _Server(socketserver.ThreadingMixIn, WSGIServer):
        daemon_threads = True

    port = _port(argv)
    print("远端代理已启动：http://0.0.0.0:%d/ssq" % port, flush=True)
    print("  自检：http://0.0.0.0:%d/    本地验证示例：python3 proxy_wsgi.py 8081" % port,
          flush=True)
    make_server("0.0.0.0", port, app, server_class=_Server).serve_forever()
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv))
