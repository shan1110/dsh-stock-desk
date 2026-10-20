#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
东财 clist 备用主机探测（开发用）

背景：tools/test-tools.mjs 里 sector_rank 报 "fetch failed"，
而同一个东财域名下的 kline 接口正常。两者主机不同：
  kline  push2his.eastmoney.com   正常
  clist  push2.eastmoney.com      失败
东财对 clist 有一组编号镜像主机 1.push2 ~ 99.push2，若可用即可做失败转移。

用法：python tools/probe-em-hosts.py
"""
import json
import time
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
FS = "m:90+t:2+f:!50"
FIELDS = "f12,f14,f3,f62,f104,f105,f128"

HOSTS = [
    "push2.eastmoney.com",
    "push2delay.eastmoney.com",
    "1.push2.eastmoney.com",
    "7.push2.eastmoney.com",
    "82.push2.eastmoney.com",
]


def probe(host: str) -> str:
    url = (f"https://{host}/api/qt/clist/get"
           f"?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f3&fs={FS}&fields={FIELDS}")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"})
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            d = json.loads(r.read().decode("utf-8", errors="replace")).get("data")
            if not d:
                return "data 为空"
            return f"total={d['total']} 首条={d['diff'][0]['f14']} {d['diff'][0]['f3']}"
    except Exception as e:  # noqa: BLE001
        return f"{type(e).__name__}: {str(e)[:50]}"


def main() -> int:
    for host in HOSTS:
        results = [probe(host) for _ in range(2)]
        time.sleep(0.3)
        print(f"{host:<28} {results[0]}")
        if results[1] != results[0]:
            print(f"{'':<28} 第二次 {results[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
