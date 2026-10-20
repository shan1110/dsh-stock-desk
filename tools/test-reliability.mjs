/**
 * 数据源稳定性实测（开发用）
 *
 * 动机：东财 clist 在开发过程中两次抛 RemoteDisconnected，而 kline 一直稳。
 * 「偶发」不能靠感觉，要跑连续请求看失败率，再决定重试次数和降级策略。
 *
 * 用法：node tools/test-reliability.mjs
 */
const N = Number(process.argv[2] ?? 12);

const CASES = [
  ['腾讯 批量报价(50只)', async () => {
    const codes = Array.from({ length: 50 }, (_, i) => `sh600${String(500 + i).padStart(3, '0')}`).join(',');
    const r = await fetch(`https://qt.gtimg.cn/q=${codes}`, {
      headers: { Referer: 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0' },
    });
    const b = await r.arrayBuffer();
    return new TextDecoder('gbk').decode(b).length;
  }],
  ['东财 日K(sh600519)', async () => {
    const r = await fetch('https://push2his.eastmoney.com/api/qt/stock/kline/get'
      + '?secid=1.600519&fields1=f1,f2&fields2=f51,f52,f53&klt=101&fqt=1'
      + '&beg=20261001&end=20261019&lmt=10',
      { headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } });
    return (await r.json())?.rc;
  }],
  ['东财 行业板块榜(pz=10)', async () => {
    const r = await fetch('https://push2.eastmoney.com/api/qt/clist/get'
      + '?pn=1&pz=10&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2+f:!50&fields=f12,f14,f3',
      { headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } });
    return (await r.json())?.rc;
  }],
  ['同花顺 涨停概览', async () => {
    const r = await fetch('https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool?page=1&limit=1',
      { headers: { Referer: 'https://data.10jqka.com.cn/', 'User-Agent': 'Mozilla/5.0' } });
    return (await r.json())?.status_code;
  }],
];

console.log(`每个接口连续请求 ${N} 次\n`);
for (const [name, fn] of CASES) {
  let ok = 0;
  const times = [];
  const errors = new Map();
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    try {
      await fn();
      ok++;
      times.push(Date.now() - t0);
    } catch (e) {
      const key = e?.cause?.code ?? e?.code ?? e?.message ?? String(e);
      errors.set(key, (errors.get(key) ?? 0) + 1);
    }
  }
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  const max = times.length ? Math.max(...times) : 0;
  const detail = [...errors].map(([k, v]) => `${k}×${v}`).join(', ');
  console.log(`${name.padEnd(22)} ${String(ok).padStart(2)}/${N} 成功   平均 ${String(avg).padStart(4)}ms  最慢 ${String(max).padStart(4)}ms   ${detail}`);
}
