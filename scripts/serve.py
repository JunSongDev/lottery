#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地预览服务（零第三方依赖）

为什么需要它：
  · 双色球接口（jc.zhcw.com/port/client_json.php）强制校验 Referer ——
    请求不带 Referer 时它返回 200 + 空 body，且不返回 CORS 头，
    浏览器侧就表现为"请求失败"；而 Referer 是 forbidden header，
    页面里的 JS 无法伪造，file:// 直接打开时浏览器根本不发 Referer。
  · 大乐透接口（体彩官网）虽然开放 CORS，但同样依赖浏览器发得出跨域请求。

  本服务做两件事：
    1. 静态托管项目目录（index.html / js / css / data ...）；
    2. 提供同源代理 /api/ssq、/api/dlt：由服务端带 Referer 去官方接口取数，
       页面只跟本服务通信，因此不存在跨域、也不依赖浏览器的 Referer 策略。

用法：
  python3 scripts/serve.py [端口]      # 默认 8000
  然后浏览器访问 http://localhost:8000/index.html（不要用 file:// 直接打开）
"""

import json
import os
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import fetch_data as fd  # noqa: E402  （同目录，复用抓取与解析逻辑；已把 HERE 加入 sys.path）

ROWS = 30                      # 核对窗口：最近 30 期（与 live.js 保持一致）
API_TIMEOUT = 12               # 单次抓官方接口的超时（秒）
API_TRIES = 2                  # 抓官方接口的尝试次数

SOURCES = {
    "ssq": ("中国福利彩票官网", lambda: fd.fetch_cwl_latest(tries=API_TRIES, timeout=API_TIMEOUT)),
    "dlt": ("中国体育彩票官网", lambda: fd.fetch_sporttery_latest(tries=API_TRIES, timeout=API_TIMEOUT)),
}


class Handler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---------- 路由：/api/* 走代理，其余走静态文件 ----------

    def do_GET(self):                                   # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/")
        if path.startswith("/api/"):
            self.handle_api(path[len("/api/"):])
            return
        # 忽略条件请求：否则刷新时会命中 304 拿回旧的 data-*.js
        for h in ("If-Modified-Since", "If-None-Match"):
            if h in self.headers:
                del self.headers[h]
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def handle_api(self, kind):
        item = SOURCES.get(kind)
        if item is None:
            self.send_json(404, {"ok": False, "error": "未知玩法：%s" % kind})
            return
        label, loader = item
        try:
            rows = loader()[:ROWS]
        except Exception as exc:                        # noqa: BLE001
            self.send_json(502, {"ok": False, "error": "%s 取数失败：%s" % (label, exc)})
            return
        if not rows:
            self.send_json(502, {"ok": False, "error": "%s 未返回数据" % label})
            return
        self.send_json(200, {
            "ok": True, "kind": kind, "src": label,
            "at": int(time.time() * 1000), "rows": rows,
        })

    def send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):                  # noqa: A002（与基类同名参数保持一致）
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), format % args))


def bind(port, tries=10):
    """端口被占用时顺延，保证双击启动也能起来"""
    for p in range(port, port + tries):
        try:
            return ThreadingHTTPServer(("127.0.0.1", p), Handler), p
        except OSError:
            continue
    raise SystemExit("端口 %d~%d 都被占用，请换一个端口：python3 scripts/serve.py 8123"
                     % (port, port + tries - 1))


def main(argv):
    start = 8000
    for arg in argv[1:]:
        if arg.isdigit():
            start = int(arg)
    server, port = bind(start)
    print("本地服务已启动：http://localhost:%d/index.html" % port)
    print("  · 静态目录：%s" % ROOT)
    print("  · 开奖核对走同源代理 /api/ssq、/api/dlt（服务端带 Referer），")
    print("    不受浏览器 Referer / 跨域策略限制。")
    print("按 Ctrl+C 停止。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
