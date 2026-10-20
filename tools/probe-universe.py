#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
东财全 A 股代码池探测（开发用）

动机：全市场扫描（算涨跌家数、涨停家数）需要一份全部 A 股代码。
如果能把这份名单从东财直接拉下来并缓存到磁盘，就不用随包附一份 5549 行的静态名单，
而且新上市的股票会自动进池。

用法：python tools/probe-universe.py
"""
import json
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"

# 东财「沪深京 A 股」板块选择器：沪主板 + 科创 + 深主板 + 创业 + 北交所
FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"

CASES = [
    ("沪深京A股 全量", FS, 6000),
    ("仅沪深主板", "m:0+t:6,m:1+t:2", 6000),
]


def main() -> int:
    for name, fs, pz in CASES:
        url = ("https://push2.eastmoney.com/api/qt/clist/get"
               f"?pn=1&pz={pz}&po=0&np=1&fltt=2&invt=2&fid=f12&fs={fs}"
               "&fields=f12,f13,f14")
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"})
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                d = json.loads(r.read().decode("utf-8", errors="replace"))["data"]
        except Exception as e:  # noqa: BLE001
            print(f"{name}: 失败 {type(e).__name__}: {e}")
            continue

        diff = d["diff"]
        print(f"{name}: total={d['total']}  实取={len(diff)}")
        # f13 是市场号：0=深 1=沪
        mkt = {}
        for it in diff:
            mkt[it["f13"]] = mkt.get(it["f13"], 0) + 1
        samples = [f"{it['f12']}({it['f13']}) {it['f14']}" for it in diff[:3]]
        print(f"    f13 分布 {mkt}")
        print(f"    样本 {samples}")
        if d["total"] > len(diff):
            print(f"    ⚠️ total {d['total']} > 实取 {len(diff)}，说明一次拉不完，必须分页")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
