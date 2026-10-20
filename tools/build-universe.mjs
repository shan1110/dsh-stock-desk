/**
 * 生成全 A 股代码池 data/universe.json（维护脚本，不参与插件运行）
 *
 * 为什么需要：
 * 1. 全市场扫描（算涨跌家数）要一份全部 A 股代码；
 * 2. 自选搜索要能搜到基金 —— 用户会想加 ETF，只搜股票等于功能缺一半。
 *
 * 为什么不用东财 clist 拉：实测它有 100 条硬上限（pz 调到 6000 也只回 100 条），
 * 而沪深京 A 股共 5924 只，要 60 个请求才能拉全；且实测该接口在连续请求下会开始限流，
 * 连 pz=10 都断连。所以改用腾讯批量接口暴力枚举代码空间——腾讯实测 15/15 稳定。
 *
 * 为什么可以暴力枚举：不存在的代码不会出现在腾讯响应里，直接丢掉即可，
 * 不需要事先知道哪些号段有人用。
 *
 * 用法：node tools/build-universe.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchQuotes, classifyKind } from '../lib/tencent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'data', 'universe.json');

/**
 * 要枚举的号段。
 *
 * 北交所（43xxxx / 83xxxx / 87xxxx / 88xxxx / 92xxxx）刻意不枚举：
 * 号段空间太大（十万量级），且同花顺涨停池的默认口径 `HS,GEM2STAR` 本就不含北交所，
 * 纳进来会让涨跌家数与涨停口径不一致。见 README 的已知限制。
 */
const RANGES = [
  ['sh', 600000, 605999], // 沪市主板 + 中小板
  ['sh', 688000, 689999], // 科创板 + 存托凭证
  ['sz', 1, 3999],        // 深市主板 + 中小板
  ['sz', 300000, 302999], // 创业板（上界给到 302999：创业板号段在持续推进，
                          // 卡在 301999 会漏掉新发；多扫 1000 个空号只多花一次请求）
];

/**
 * 场内基金（ETF/LOF）列表。
 *
 * 为什么不用暴力枚举号段：沪市 5xxxxx、深市 15xxxx/16xxxx 加起来十几万个号，
 * 枚举要上百个请求，很容易被限流。
 *
 * 改用腾讯自选股的基金榜接口。参数是一路试错试出来的（每一步的报错都点名下一个缺的参数）：
 *   fund_type=inner（场内）  board_type=ETF  sort_type=price  direct=down
 * 实测 total=1707，count 上限 200，所以 9 个请求拉全。
 */
const FUND_URL = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/fund/getList';
const FUND_PAGE = 200;
const FUND_HEADERS = {
  Referer: 'https://wzq.tenpay.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
};

async function fetchFunds() {
  const out = [];
  let total = Infinity;
  for (let offset = 0; offset < total && offset < 20000; offset += FUND_PAGE) {
    const url = `${FUND_URL}?fund_type=inner&board_type=ETF&sort_type=price&direct=down&offset=${offset}&count=${FUND_PAGE}`;
    let json;
    try {
      const res = await fetch(url, { headers: FUND_HEADERS, signal: AbortSignal.timeout(20000) });
      json = await res.json();
    } catch (err) {
      console.warn(`  基金第 ${offset / FUND_PAGE + 1} 页失败：${err.message}，跳过`);
      continue;
    }
    if (json?.code !== 0) { console.warn(`  基金接口返回 code=${json?.code} ${json?.msg ?? ''}，停止`); break; }
    const list = json.data?.rank_list ?? json.data?.list ?? [];
    total = Number(json.data?.total) || 0;
    if (list.length === 0) break;
    for (const it of list) {
      // code 已经是 sh511010 这种带前缀的写法，与个股一致
      if (typeof it?.code !== 'string' || !/^(sh|sz)\d{6}$/.test(it.code)) continue;
      out.push({ code: it.code, name: it.name || it.fund_name || '' });
    }
    await sleep(GAP_MS);
  }
  // 同名代码去重（接口翻页时偶有重叠）
  const seen = new Set();
  return out.filter((f) => (seen.has(f.code) ? false : (seen.add(f.code), true)));
}

/** 每批代码数；腾讯实测一次 800 只可全部返回，这里取 800 */
const BATCH = 800;

/** 批间停顿，避免把对方打限流 */
const GAP_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function* candidates() {
  for (const [prefix, from, to] of RANGES) {
    for (let n = from; n <= to; n++) yield prefix + String(n).padStart(6, '0');
  }
}

async function main() {
  const all = [...candidates()];
  console.log(`候选代码 ${all.length} 个，按每批 ${BATCH} 个请求，共 ${Math.ceil(all.length / BATCH)} 批`);

  const found = [];
  const t0 = Date.now();
  let batchNo = 0;

  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    batchNo++;
    let map;
    try {
      map = await fetchQuotes(batch, { timeoutMs: 20000 });
    } catch (err) {
      console.warn(`  第 ${batchNo} 批失败：${err.message}，跳过`);
      continue;
    }
    for (const [code, fields] of map) {
      // 只保留个股：指数（ZS）和 ETF 不进代码池，它们由固定清单单独维护
      if (classifyKind(fields[61]) !== 'stock') continue;
      found.push({ code, name: fields[1] ?? '' });
    }
    if (batchNo % 5 === 0 || i + BATCH >= all.length) {
      console.log(`  已扫 ${batchNo}/${Math.ceil(all.length / BATCH)} 批，累计命中 ${found.length} 只`);
    }
    await sleep(GAP_MS);
  }

  console.log('\n拉取场内基金列表…');
  const funds = await fetchFunds();
  console.log(`  场内基金 ${funds.length} 只`);

  found.sort((a, b) => a.code.localeCompare(b.code));
  funds.sort((a, b) => a.code.localeCompare(b.code));

  const marketCount = found.reduce((acc, s) => {
    const p = s.code.slice(0, 2);
    acc[p] = (acc[p] ?? 0) + 1;
    return acc;
  }, {});

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: '全 A 股代码池（不含北交所）+ 场内基金。由 tools/build-universe.mjs 生成，不要手改。',
    marketCount,
    stocks: found,
    funds,
  }, null, 0), 'utf8');

  console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`命中股票 ${found.length} 只，市场分布 ${JSON.stringify(marketCount)}`);
  console.log(`命中场内基金 ${funds.length} 只`);
  console.log(`已写入 ${OUT}`);
}

main().catch((err) => {
  console.error('生成失败：', err);
  process.exit(1);
});
