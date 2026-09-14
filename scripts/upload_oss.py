#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把数据文件上传到阿里云 OSS（零第三方依赖，只用标准库 urllib + hmac）

用途：
  静态托管在 OSS 的页面，数据是随 js/data-*.js 一起发布的。
  本脚本在抓取脚本跑完后把最新数据文件传上去，用于"定时更新"这条兜底路线
  （配合 .github/workflows/update-data.yml，每天自动跑，页面永远是最新的）。

  若站点同时启用了 CDN，数据文件会带 Cache-Control: no-cache，
  这样每次访问都会回源校验，上传后不必额外刷新缓存。

用法：
  python3 scripts/upload_oss.py \
      --bucket my-bucket --endpoint oss-cn-hangzhou.aliyuncs.com \
      --id <AccessKeyId> --secret <AccessKeySecret> \
      [--prefix h5/] [--files js/data-ssq.js js/data-dlt.js] [--dry-run]

  也可全部走环境变量（CI 里推荐用 Secrets）：
      OSS_BUCKET / OSS_ENDPOINT / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_PREFIX

  不传 --files 时，默认上传：js/data-ssq.js、js/data-dlt.js、data/ssq.json、data/dlt.json
"""

import argparse
import email.utils
import hashlib
import hmac
import base64
import mimetypes
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOAD_TIMEOUT = 60

DEFAULT_FILES = [
    "js/data-ssq.js",
    "js/data-dlt.js",
    "data/ssq.json",
    "data/dlt.json",
]

CONTENT_TYPES = {
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}


def content_type(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in CONTENT_TYPES:
        return CONTENT_TYPES[ext]
    guess = mimetypes.guess_type(path)[0]
    return (guess + "; charset=utf-8") if (guess and guess.startswith("text/")) \
        else (guess or "application/octet-stream")


def cache_control(path):
    # 数据文件必须每次回源校验，否则 CDN 会一直发旧数据
    name = os.path.basename(path)
    if name.startswith("data-") or path.startswith("data/") or name in ("ssq.json", "dlt.json"):
        return "no-cache, must-revalidate"
    return "public, max-age=3600"


def quote_key(key):
    """OSS 要求 CanonicalizedResource 与请求路径里的中文/特殊字符做 URL 编码（/ 保留）"""
    return urllib.request.quote(key, safe="/")


def sign(verb, content_md5, content_type, date, canon_res, secret, oss_headers=None):
    canon_oss = ""
    for k, v in sorted(((k.lower(), str(v).strip()) for k, v in (oss_headers or {}).items())):
        canon_oss += "%s:%s\n" % (k, v)
    string_to_sign = "\n".join([verb, content_md5, content_type, date, canon_oss + canon_res])
    digest = hmac.new(secret.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha1).digest()
    return base64.b64encode(digest).decode("ascii")


def put_object(bucket, endpoint, key_id, key_secret, key, body, content_type_, cache_control_):
    host = "%s.%s" % (bucket, endpoint)
    url = "https://%s/%s" % (host, quote_key(key))
    date = email.utils.formatdate(usegmt=True)      # 例：Mon, 14 Sep 2026 03:20:00 GMT
    canon_res = "/%s/%s" % (bucket, quote_key(key))
    auth = "OSS %s:%s" % (key_id, sign("PUT", "", content_type_, date, canon_res, key_secret))
    req = urllib.request.Request(url, data=body, method="PUT", headers={
        "Host": host,
        "Date": date,
        "Content-Type": content_type_,
        "Content-Length": str(len(body)),
        "Cache-Control": cache_control_,
        "Authorization": auth,
        "User-Agent": "lottery-upload-oss/1.0",
    })
    with urllib.request.urlopen(req, timeout=UPLOAD_TIMEOUT) as resp:
        return resp.status


def main(argv):
    p = argparse.ArgumentParser(description="上传开奖数据文件到阿里云 OSS")
    p.add_argument("--bucket", default=os.environ.get("OSS_BUCKET", ""))
    p.add_argument("--endpoint", default=os.environ.get("OSS_ENDPOINT", ""))
    p.add_argument("--id", default=os.environ.get("OSS_ACCESS_KEY_ID", ""))
    p.add_argument("--secret", default=os.environ.get("OSS_ACCESS_KEY_SECRET", ""))
    p.add_argument("--prefix", default=os.environ.get("OSS_PREFIX", ""))
    p.add_argument("--files", nargs="*", default=None)
    p.add_argument("--dry-run", action="store_true", help="只打印将要做什么，不真正上传")
    args = p.parse_args(argv[1:])

    missing = [n for n, v in (("--bucket", args.bucket), ("--endpoint", args.endpoint),
                              ("--id", args.id), ("--secret", args.secret)) if not v]
    if missing and not args.dry_run:
        p.error("缺少参数：%s（也可通过 OSS_BUCKET / OSS_ENDPOINT / "
                "OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET 环境变量提供）" % "、".join(missing))

    files = args.files if args.files else DEFAULT_FILES
    prefix = args.prefix.strip("/")
    ok = fail = 0

    for rel in files:
        local = rel if os.path.isabs(rel) else os.path.join(ROOT, rel)
        if not os.path.isfile(local):
            print("× 跳过（本地不存在）：%s" % rel)
            fail += 1
            continue
        key = "/".join([prefix, rel]) if prefix else rel
        with open(local, "rb") as fh:
            body = fh.read()
        ct, cc = content_type(rel), cache_control(rel)
        if args.dry_run:
            print("· 将上传 %s → oss://%s/%s（%d 字节，%s）" % (rel, args.bucket or "<bucket>", key, len(body), cc))
            ok += 1
            continue
        try:
            put_object(args.bucket, args.endpoint, args.id, args.secret, key, body, ct, cc)
        except urllib.error.HTTPError as exc:
            print("× 上传失败 %s → HTTP %s %s\n  %s" % (rel, exc.code, exc.reason, exc.read()[:300]))
            fail += 1
            continue
        except Exception as exc:                      # noqa: BLE001
            print("× 上传失败 %s → %s" % (rel, exc))
            fail += 1
            continue
        print("√ 已上传 %s → oss://%s/%s（%d 字节）" % (rel, args.bucket, key, len(body)))
        ok += 1

    print("完成：成功 %d 个，失败 %d 个" % (ok, fail))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
