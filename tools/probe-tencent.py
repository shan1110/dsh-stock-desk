#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
腾讯行情字段索引实测工具（开发用，不参与插件运行）

为什么需要它：腾讯 qt.gtimg.cn 接口返回 88 个 `~` 分隔字段，但没有任何官方字段表。
字段号不能跨接口复用，也不能靠记忆。这个脚本把每个索引的实际值和它对应的品种放在一起打印，
用来确认解析器读的下标是对的。

用法：python tools/probe-tencent.py
"""
import urllib.request
import sys

# 故意混入四种品种：个股 / 指数 / ETF / 港股
CODES = ["sh600519", "sh000001", "sh510300", "sz300750", "hk01810"]
URL = "https://qt.gtimg.cn/q=" + ",".join(CODES)


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://gu.qq.com/",
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode("gbk", errors="replace")


def main() -> int:
    raw = fetch(URL)
    lines = [ln for ln in raw.split(";") if "=" in ln]

    parsed = {}
    for ln in lines:
        code = ln.split("=")[0].strip().replace("v_", "")
        payload = ln.split('="', 1)[1].rstrip('"')
        parsed[code] = payload.split("~")

    widths = {c: len(f) for c, f in parsed.items()}
    print("字段个数：", widths)
    print()

    maxlen = max(widths.values())
    header = "idx | " + " | ".join(f"{c:>28}" for c in CODES)
    print(header)
    print("-" * len(header))
    for i in range(maxlen):
        cells = []
        for c in CODES:
            f = parsed.get(c) or []
            v = f[i] if i < len(f) else "<无此下标>"
            cells.append(f"{v[:28]:>28}")
        print(f"{i:>3} | " + " | ".join(cells))
    return 0


if __name__ == "__main__":
    sys.exit(main())
