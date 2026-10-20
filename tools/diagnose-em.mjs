/**
 * 东财 clist 在 Node 侧失败原因排查（开发用）
 * 用法：node tools/diagnose-em.mjs
 *
 * 背景：Python urllib 访问同一组主机全部成功，而 Node fetch 报 "fetch failed"。
 * "fetch failed" 是 undici 的外层包装，真因在 err.cause 链上，必须拆开看。
 */
const HOSTS = [
  'push2.eastmoney.com',
  'push2his.eastmoney.com',
  '1.push2.eastmoney.com',
  '7.push2.eastmoney.com',
  '82.push2.eastmoney.com',
  'push2delay.eastmoney.com',
];

/** 每个主机重复次数。单次取样会被误导——Python 探测时 82/push2delay 也是成功的 */
const ROUNDS = 8;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const FS = 'm:90+t:2+f:!50';

/** 把 cause 链拆成一行 */
function chain(err) {
  const parts = [];
  let cur = err;
  let depth = 0;
  while (cur && depth < 5) {
    const code = cur.code ?? cur.errno ?? '';
    parts.push(`${cur.constructor?.name ?? typeof cur}${code ? '(' + code + ')' : ''}: ${cur.message ?? cur}`);
    cur = cur.cause;
    depth++;
  }
  return parts.join('  ←  ');
}

for (const host of HOSTS) {
  const url = `https://${host}/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${FS}&fields=f12,f14,f3`;
  let ok = 0;
  const times = [];
  const errs = new Map();
  let sample = '';
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': UA } });
      const json = await res.json();
      times.push(Date.now() - t0);
      if (json?.data?.total) { ok++; sample = `total=${json.data.total} 首条=${json.data.diff?.[0]?.f14} ${json.data.diff?.[0]?.f3}`; }
      else { const k = 'data 为空'; errs.set(k, (errs.get(k) ?? 0) + 1); }
    } catch (err) {
      times.push(Date.now() - t0);
      const k = chain(err).slice(0, 90);
      errs.set(k, (errs.get(k) ?? 0) + 1);
    }
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log(`${host.padEnd(28)} ${ok}/${ROUNDS} 成功  平均 ${String(avg).padStart(4)}ms   ${sample}`);
  for (const [k, n] of errs) console.log(`      ×${n}  ${k}`);
}
