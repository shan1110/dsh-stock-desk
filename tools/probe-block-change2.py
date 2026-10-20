#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
同花顺 block_top 的 change 字段定标（开发用，第二版）

上一版的判定方法本身是错的：block_top 的 stock_list 是该板块**当日涨停的个股**，
不是全部成分股。拿它当「板块整体涨跌幅」的代理，等于用涨停股去证明板块涨幅，循环论证。

这一版换独立参照物：东财概念板块的 f3 涨跌幅（已验证是真实百分数，
因为 东财 行业「其他数字媒体 +13.01%、涨跌家数 2/0」能对上）。
按名称把同花顺的板块和东财的概念板块对齐，比较数值。

用法：python tools/probe-block-change2.py
"""
import json
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"


def get_json(url, referer):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8", errors="replace"))


def main() -> int:
    # 1. 同花顺 block_top：先看清每条到底有哪些字段
    ths = get_json("https://data.10jqka.com.cn/dataapi/limit_up/block_top?filter=HS,GEM2STAR",
                   "https://data.10jqka.com.cn/")["data"]
    print("=== 同花顺 block_top 单条全部字段（把 stock_list 缩掉） ===")
    first = dict(ths[0])
    first["stock_list"] = f"<{len(ths[0].get('stock_list') or [])} 只>"
    print(json.dumps(first, ensure_ascii=False, indent=2))
    print("字段名集合：", sorted({k for b in ths for k in b}))
    print()

    # 2. 东财概念板块全量，按名称建索引
    em = get_json("https://push2.eastmoney.com/api/qt/clist/get"
                  "?pn=1&pz=600&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:3+f:!50&fields=f12,f14,f3",
                  "https://quote.eastmoney.com/")["data"]
    by_name = {it["f14"]: it["f3"] for it in em["diff"]}
    print(f"东财概念板块 {len(by_name)} 个\n")

    # 3. 逐条对齐比较
    print(f"{'同花顺板块':<16}{'change原值':>12}{'×100':>12}{'东财f3':>12}   结论")
    print("-" * 76)
    hits = 0
    for b in ths:
        name = b["name"]
        em_v = by_name.get(name)
        if em_v is None or em_v == "-":
            continue
        hits += 1
        raw = float(b["change"])
        x100 = raw * 100
        em_f = float(em_v)
        verdict = "原值即百分数" if abs(raw - em_f) <= abs(x100 - em_f) else "原值是小数比例"
        print(f"{name:<16}{raw:>12.4f}{x100:>12.4f}{em_f:>12.2f}   {verdict}")
    print("-" * 76)
    print(f"可对齐板块数：{hits}")
    if hits == 0:
        print("对齐不上，需要换参照物。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
