#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
历史开奖数据抓取脚本（零第三方依赖）

数据源：
  - 双色球：500 彩票网历史开奖表格（2003 年首期至今）—— 主源
  - 大乐透：500 彩票网历史开奖表格（2007 年首期至今）—— 主源
  - 交叉校验（尽力而为）：中国福利彩票官网 / 中国体育彩票官网 最新 30 期。
    官网防火墙可能拦截境外机房 IP（实测 2026-11-11：cwl.gov.cn 对 Cloudflare
    出口返回 403），GitHub Actions 上官网不可达时自动跳过校验、只用 500 数据。

产物：
  - data/ssq.json, data/dlt.json           原始 JSON
  - data/ssq-head.json, data/dlt-head.json 最近 30 期轻量头文件（约 3KB），
                                           供页面经 jsDelivr 镜像核对（js/live.js）
  - js/data-ssq.js, js/data-dlt.js         供 H5 以 <script> 直接加载（支持 file:// 打开）

用法：
  python3 scripts/fetch_data.py
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def http_get(url, referer, tries=3, timeout=60):
    last = None
    for n in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Referer": referer,
                "Accept": "text/html,application/xhtml+xml,application/json,*/*",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "X-Requested-With": "XMLHttpRequest",
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (n + 1))
    raise RuntimeError("请求失败 %s: %s" % (url, last))


def decode(raw):
    """500 彩票网页面为 gb2312 编码"""
    for enc in ("gb18030", "gb2312", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("gb18030", errors="ignore")


def strip_tags(s):
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"<[^>]+>", "", s)
    return s.replace("&nbsp;", " ").strip()


def parse_500_table(html, main_count, special_count, min_issue_len):
    """解析 500 彩票网历史开奖表格，返回按期号升序的记录列表"""
    out = {}
    for tr in re.findall(r'<tr class="t_tr1">(.*?)</tr>', html, re.S):
        tr = re.sub(r"<!--.*?-->", "", tr, flags=re.S)
        tds = [strip_tags(x) for x in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
        if len(tds) < 1 + main_count + special_count:
            continue
        issue = tds[0]
        if not re.fullmatch(r"\d{%d,}" % min_issue_len, issue):
            continue
        issue = to7(issue)
        try:
            main = [int(x) for x in tds[1:1 + main_count]]
            special = [int(x) for x in tds[1 + main_count:1 + main_count + special_count]]
        except ValueError:
            continue
        # 开奖日期位于行尾
        date = ""
        for cell in reversed(tds):
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", cell):
                date = cell
                break
        if len(main) != main_count or len(special) != special_count:
            continue
        if len(set(main)) != main_count or len(set(special)) != special_count:
            continue
        if main != sorted(main):
            main = sorted(main)
        out[issue] = {"i": issue, "d": date, "r": main, "b": sorted(special)}
    return sorted(out.values(), key=lambda x: x["i"])


def to7(issue):
    """统一期号格式为 7 位：YYNNN -> 20YYNNN，如 03001 -> 2003001"""
    issue = issue.strip()
    if len(issue) == 5 and issue.isdigit():
        return "20" + issue
    return issue


def fetch_full(kind, end="29999"):
    """抓取 500 彩票网全量历史。

    end 直接传一个足够大的期号即可：history.php 返回 start~end 之间实际
    存在的所有期，因此无需先问官方接口"最新一期是多少"——官方接口在境外
    机房（GitHub Actions）可能被防火墙拦截，不能作为流程的前置依赖。
    """
    if kind == "ssq":
        url = ("https://datachart.500.com/ssq/history/newinc/history.php"
               "?start=03001&end=%s" % end)
        referer = "https://datachart.500.com/ssq/history/history.shtml"
        main_count, special_count, min_len = 6, 1, 5
    else:
        url = ("https://datachart.500.com/dlt/history/newinc/history.php"
               "?start=07001&end=%s" % end)
        referer = "https://datachart.500.com/dlt/history/history.shtml"
        main_count, special_count, min_len = 5, 2, 5
    html = decode(http_get(url, referer))
    rows = parse_500_table(html, main_count, special_count, min_len)
    return rows


def fetch_cwl_latest(tries=3, timeout=60):
    """中国福利彩票官网：最新双色球（用于交叉校验）"""
    url = ("https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice"
           "?name=ssq&issueCount=30&pageNo=1&pageSize=30&systemType=PC")
    data = json.loads(decode(http_get(url, "https://www.cwl.gov.cn/", tries, timeout)))
    rows = []
    for item in data.get("result", []):
        rows.append({
            "i": to7(item["code"]),
            "d": item["date"][:10],
            "r": sorted(int(x) for x in item["red"].split(",")),
            "b": [int(item["blue"])],
        })
    return rows


def fetch_sporttery_latest(tries=3, timeout=60):
    """中国体育彩票官网：最新大乐透（用于交叉校验）"""
    url = ("https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry"
           "?gameNo=85&provinceId=0&pageSize=30&isVerify=1&pageNo=1")
    data = json.loads(decode(http_get(url, "https://static.sporttery.cn/", tries, timeout)))
    rows = []
    for item in data["value"]["list"]:
        nums = [int(x) for x in item["lotteryDrawResult"].split()]
        rows.append({
            "i": to7(item["lotteryDrawNum"]),
            "d": item["lotteryDrawTime"][:10],
            "r": sorted(nums[:5]),
            "b": sorted(nums[5:]),
        })
    return rows


def try_latest(fn, label, tries=2, timeout=30):
    """官方接口只做交叉校验，拿不到就跳过——境外机房（GitHub Actions）的 IP
    可能被官网防火墙拦截（实测 cwl.gov.cn 对 Cloudflare 出口返回 403），
    500 彩票网才是主源，官网不可达不应让整个任务失败。"""
    try:
        return fn(tries=tries, timeout=timeout)
    except Exception as e:  # noqa: BLE001
        print("  [警告] %s 不可达（%s），跳过官方交叉校验" % (label, e))
        return None


def merge(rows, latest, label):
    by_issue = {r["i"]: r for r in rows}
    added, fixed = 0, 0
    for r in latest:
        old = by_issue.get(r["i"])
        if old is None:
            by_issue[r["i"]] = r
            added += 1
        elif old["r"] != r["r"] or old["b"] != r["b"]:
            print("  [校验] %s 期号 %s 数据不一致，采用官方数据" % (label, r["i"]))
            by_issue[r["i"]] = r
            fixed += 1
    print("  [校验] %s 补充 %d 期，修正 %d 期" % (label, added, fixed))
    return sorted(by_issue.values(), key=lambda x: x["i"])


def write_outputs(kind, meta, draws):
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "js"), exist_ok=True)

    payload = dict(meta)
    payload["draws"] = draws

    with open(os.path.join(ROOT, "data", kind + ".json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    # 轻量头文件：GitHub Pages 打开页面时经 jsDelivr（开放 CORS）拉取它做
    # "数据镜像"核对。只放最近 30 期（约 3KB），每页访问的流量开销可忽略；
    # jsDelivr 的 12 小时边缘缓存由工作流在提交后主动 purge 刷新。
    with open(os.path.join(ROOT, "data", kind + "-head.json"), "w", encoding="utf-8") as f:
        json.dump({"kind": kind, "updated": draws[-1]["d"], "draws": draws[-30:]},
                  f, ensure_ascii=False, separators=(",", ":"))

    compact = ",".join(
        '["%s","%s",[%s],[%s]]' % (d["i"], d["d"], ",".join(map(str, d["r"])), ",".join(map(str, d["b"])))
        for d in draws
    )
    js = (
        "/* 自动生成，请勿手工编辑。来源：500彩票网 + 官方接口校验。"
        "运行 python3 scripts/fetch_data.py 更新 */\n"
        "window.LOTTO_DATA = window.LOTTO_DATA || {};\n"
        "window.LOTTO_DATA.%s = {name:\"%s\",mainMin:%d,mainMax:%d,mainCount:%d,"
        "specialMin:%d,specialMax:%d,specialCount:%d,mainLabel:\"%s\",specialLabel:\"%s\","
        "updated:\"%s\",range:\"%s ~ %s\",draws:[%s]};\n"
    ) % (kind, meta["name"], meta["mainMin"], meta["mainMax"], meta["mainCount"],
         meta["specialMin"], meta["specialMax"], meta["specialCount"],
         meta["mainLabel"], meta["specialLabel"], meta["updated"],
         draws[0]["i"], draws[-1]["i"], compact)

    with open(os.path.join(ROOT, "js", "data-%s.js" % kind), "w", encoding="utf-8") as f:
        f.write(js)

    size = os.path.getsize(os.path.join(ROOT, "data", kind + ".json"))
    print("  已写入 %d 期（%s ~ %s），JSON %.0f KB"
          % (len(draws), draws[0]["i"], draws[-1]["i"], size / 1024.0))


def main():
    print("开始抓取历史开奖数据 ...")

    print("[1/2] 双色球")
    ssq = fetch_full("ssq")
    print("  500彩票网返回 %d 期" % len(ssq))
    cwl = try_latest(fetch_cwl_latest, "福彩官网")
    if cwl:
        print("  官网最新期号 %s" % cwl[0]["i"])
        ssq = merge(ssq, cwl, "双色球")
    write_outputs("ssq", {
        "name": "双色球", "mainMin": 1, "mainMax": 33, "mainCount": 6,
        "specialMin": 1, "specialMax": 16, "specialCount": 1,
        "mainLabel": "红球", "specialLabel": "蓝球",
        "updated": ssq[-1]["d"], "source": "500彩票网 + 中国福利彩票官网",
    }, ssq)

    print("[2/2] 大乐透")
    dlt = fetch_full("dlt")
    print("  500彩票网返回 %d 期" % len(dlt))
    sport = try_latest(fetch_sporttery_latest, "体彩官网")
    if sport:
        print("  官网最新期号 %s" % sport[0]["i"])
        dlt = merge(dlt, sport, "大乐透")
    write_outputs("dlt", {
        "name": "超级大乐透", "mainMin": 1, "mainMax": 35, "mainCount": 5,
        "specialMin": 1, "specialMax": 12, "specialCount": 2,
        "mainLabel": "前区", "specialLabel": "后区",
        "updated": dlt[-1]["d"], "source": "500彩票网 + 中国体育彩票官网",
    }, dlt)

    print("数据抓取完成。")


if __name__ == "__main__":
    sys.exit(main())
