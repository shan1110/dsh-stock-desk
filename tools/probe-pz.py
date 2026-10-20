#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
东财 clist 的 pz 上限探测（开发用）

上一版用 pz=6000 拉全 A 股池，两次都 RemoteDisconnected；而 pz=10 一直稳。
要区分「pz 太大被拒」和「接口本身偶发断连」，必须做 pz 扫描并重复取样。

用法：python tools/probe-pz.py
"""
import json
import time
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"


def attempt(pz: int) -> tuple:
    url = ("https://push2.eastmoney.com/api/qt/clist/get"
           f"?pn=1&pz={pz}&po=0&np=1&fltt=2&invt=2&fid=f12&fs={FS}&fields=f12,f13,f14")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            d = json.loads(r.read().decode("utf-8", errors="replace"))["data"]
            return True, d["total"], len(d["diff"])
    except Exception as e:  # noqa: BLE001
        return False, type(e).__name__, str(e)[:40]


def main() -> int:
    print(f"{'pz':>6}  第1次                  第2次")
    print("-" * 72)
    for pz in (10, 100, 200, 500, 1000, 2000, 6000):
        row = []
        for _ in range(2):
            ok, a, b = attempt(pz)
            row.append(f"total={a} 取={b}" if ok else f"{a}")
            time.sleep(0.4)
        print(f"{pz:>6}  {row[0]:<20}  {row[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
