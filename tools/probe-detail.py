#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
同花顺 / 东财 关键子结构完整 dump（开发用）

为什么需要：limit_up_count / continuous_limit_up / klines 的内部字段名必须逐个看到，
才能写对解析器；靠猜字段名会静默拿到 None。

用法：python tools/probe-detail.py
"""
import json
import sys
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
THS = "https://data.10jqka.com.cn/"
EM = "https://quote.eastmoney.com/"


def get(url: str, referer: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8", errors="replace"))


def dump(title: str, obj) -> None:
    print("=" * 78)
    print(title)
    print("=" * 78)
    print(json.dumps(obj, ensure_ascii=False, indent=2)[:2400])
    print()


def main() -> int:
    # 1. 涨跌停家数：一个请求全拿到
    pool = get(f"{THS}dataapi/limit_up/limit_up_pool?page=1&limit=1", THS)
    print("=== limit_up_pool 顶层键 ===")
    print(list(pool.get("data", {}).keys()))
    print()
    dump("涨跌停家数 limit_up_count / limit_down_count",
         {k: v for k, v in pool["data"].items() if "count" in k})
    dump("涨停池单条样本 info[0]", pool["data"]["info"][0])

    # 2. 连板梯队
    cont = get(f"{THS}dataapi/limit_up/continuous_limit_up?filter=HS,GEM2STAR", THS)
    dump("连板梯队 continuous_limit_up", cont)

    # 3. 炸板池计数
    brk = get(f"{THS}dataapi/limit_up/open_limit_pool?page=1&limit=1", THS)
    dump("炸板池顶层", {k: v for k, v in brk["data"].items() if k != "info"})
    dump("炸板样本 info[0]", brk["data"]["info"][0])

    # 4. 东财 K 线一行样本
    kl = get("https://push2his.eastmoney.com/api/qt/stock/kline/get"
             "?secid=1.600519&fields1=f1,f2,f3,f4,f5,f6"
             "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
             "&klt=101&fqt=1&beg=20261013&end=20261019&lmt=10", EM)
    print("=== 东财日K fields2 顺序：f51..f61 ===")
    for row in kl["data"]["klines"]:
        print("  ", row)
    print()

    # 5. 东财板块榜一条
    sec = get("https://push2.eastmoney.com/api/qt/clist/get"
              "?pn=1&pz=2&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2+f:!50"
              "&fields=f12,f14,f2,f3,f62,f104,f105,f128,f140,f141", EM)
    dump("东财行业板块 diff[0]", sec["data"]["diff"][0])
    return 0


if __name__ == "__main__":
    sys.exit(main())
