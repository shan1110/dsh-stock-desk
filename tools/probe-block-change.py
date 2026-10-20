#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
同花顺 block_top 的 change 字段单位判定（开发用）

疑点：block_top 返回 `change: -0.1227`。它是 -0.1227%（已经是百分数）
      还是 -12.27%（小数比例）？A 股板块单日不可能跌 12%，所以两种解读里
      只有一种成立，但必须用证据判，不能选一个看起来顺眼的。

判定方法：block_top 自带 stock_list（成分股）。取该板块成分股的实时涨跌幅，
          与 change 对比。若板块涨跌幅 ≈ 成分股涨跌幅的量级，则 change 已是百分数；
          若 ≈ 成分股涨跌幅 × 100，则 change 是小数比例。

用法：python tools/probe-block-change.py
"""
import json
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"


def get_json(url, referer):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8", errors="replace"))


def get_quotes(codes):
    """腾讯批量报价，返回 代码 -> (名称, 涨跌幅%)"""
    url = "https://qt.gtimg.cn/q=" + ",".join(codes)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://gu.qq.com/"})
    with urllib.request.urlopen(req, timeout=15) as r:
        text = r.read().decode("gbk", errors="replace")
    out = {}
    for seg in text.split(";"):
        if "=" not in seg:
            continue
        code = seg.split("=")[0].strip().replace("v_", "")
        f = seg.split('="', 1)[1].rstrip('"').split("~")
        if len(f) < 33:
            continue
        try:
            out[code] = (f[1], float(f[32]))
        except (ValueError, IndexError):
            pass
    return out


def main() -> int:
    data = get_json("https://data.10jqka.com.cn/dataapi/limit_up/block_top?filter=HS,GEM2STAR",
                    "https://data.10jqka.com.cn/")["data"]
    print(f"板块数 {len(data)}\n")

    for b in data[:4]:
        raw = b.get("change")
        stocks = b.get("stock_list") or []
        codes = []
        for s in stocks:
            mid = s.get("market_id")
            pre = {17: "sh", 33: "sz"}.get(mid)
            if pre and len(str(s.get("code", ""))) == 6:
                codes.append(pre + str(s["code"]))
        quotes = get_quotes(codes[:20]) if codes else {}

        pcts = [v[1] for v in quotes.values()]
        avg = sum(pcts) / len(pcts) if pcts else float("nan")
        print(f"板块 {b['name']}  涨停 {b.get('limit_up_num')}  成分 {len(stocks)}")
        print(f"    change 原值            = {raw}")
        print(f"    若已为百分数 -> 显示    = {raw}%")
        print(f"    若为小数比例 -> 显示    = {float(raw) * 100:.4f}%")
        print(f"    成分股实测涨跌幅         = {[f'{v[0]} {v[1]:+.2f}%' for v in list(quotes.values())[:6]]}")
        print(f"    成分股平均涨跌幅         = {avg:+.2f}%")
        print()

    print("判定：看 change 原值更接近「成分股平均涨跌幅」还是它的 1/100。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
