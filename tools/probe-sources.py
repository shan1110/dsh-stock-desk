#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
东财 / 同花顺 数据源探测（开发用）

为什么需要：这两个接口的 URL 参数组合不在任何文档里，只能实测。
这个脚本把每个候选 URL 的状态码和响应前若干字符打出来，用来确认参数是否有效。

用法：python tools/probe-sources.py
"""
import json
import urllib.request
import urllib.error

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"

CASES = [
    # ---- 同花顺 涨停池系 ----
    ("THS 涨停池(全参)", "https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool"
     "?page=1&limit=200&field=199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004"
     "&filter=HS,GEM2STAR&order_field=330324&order_type=0", "ths"),
    ("THS 涨停池(仅分页)", "https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool?page=1&limit=50", "ths"),
    ("THS 连板梯队", "https://data.10jqka.com.cn/dataapi/limit_up/continuous_limit_up?filter=HS,GEM2STAR", "ths"),
    ("THS 炸板池", "https://data.10jqka.com.cn/dataapi/limit_up/open_limit_pool"
     "?page=1&limit=100&field=199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004"
     "&filter=HS,GEM2STAR&order_field=330324&order_type=0", "ths"),
    ("THS 跌停池", "https://data.10jqka.com.cn/dataapi/limit_up/low_limit_pool"
     "?page=1&limit=100&filter=HS,GEM2STAR", "ths"),
    ("THS 板块涨停数", "https://data.10jqka.com.cn/dataapi/limit_up/block_top?filter=HS,GEM2STAR", "ths"),

    # ---- 东财 ----
    ("EM 日K", "https://push2his.eastmoney.com/api/qt/stock/kline/get"
     "?secid=1.600519&fields1=f1,f2,f3,f4,f5,f6"
     "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
     "&klt=101&fqt=1&beg=20260901&end=20261019&lmt=60", "em"),
    ("EM 日K(缺 beg/end)", "https://push2his.eastmoney.com/api/qt/stock/kline/get"
     "?secid=1.600519&fields1=f1,f2&fields2=f51,f52,f53&klt=101&fqt=1", "em"),
    ("EM 行业板块榜", "https://push2.eastmoney.com/api/qt/clist/get"
     "?pn=1&pz=10&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2+f:!50"
     "&fields=f12,f14,f2,f3,f62,f104,f105,f128,f140,f141", "em"),
    ("EM 概念板块榜", "https://push2.eastmoney.com/api/qt/clist/get"
     "?pn=1&pz=10&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:3+f:!50"
     "&fields=f12,f14,f2,f3,f62,f104,f105", "em"),
    ("EM 分钟K", "https://push2his.eastmoney.com/api/qt/stock/kline/get"
     "?secid=1.600519&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57"
     "&klt=1&fqt=1&beg=20261019&end=20261019&lmt=300", "em"),
]


def fetch(url: str, referer: str) -> tuple:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": referer,
        "Accept": "application/json, text/plain, */*",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read().decode("utf-8", errors="replace")
            return r.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")[:300]
    except Exception as e:  # noqa: BLE001
        return -1, f"{type(e).__name__}: {e}"


def summarize(body: str, limit: int = 260) -> str:
    try:
        obj = json.loads(body)
    except Exception:  # noqa: BLE001
        return body[:limit].replace("\n", " ")
    # 只打印骨架，避免刷屏
    def shape(o, depth=0):
        if depth > 3:
            return "…"
        if isinstance(o, dict):
            return "{" + ", ".join(f"{k}:{shape(v, depth+1)}" for k, v in list(o.items())[:12]) + "}"
        if isinstance(o, list):
            return f"[{len(o)}]" + (shape(o[0], depth+1) if o else "")
        s = str(o)
        return s if len(s) <= 40 else s[:40] + "…"
    return json.dumps(shape(obj), ensure_ascii=False)[:limit]


def main() -> int:
    for name, url, kind in CASES:
        referer = "https://data.10jqka.com.cn/" if kind == "ths" else "https://quote.eastmoney.com/"
        status, body = fetch(url, referer)
        print(f"[{status}] {name}  ({len(body)} 字节)")
        print("      " + summarize(body))
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
