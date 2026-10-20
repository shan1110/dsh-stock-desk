/**
 * 腾讯数据源自检（开发用）
 * 用法：node tools/test-tencent.mjs
 */
import { fetchQuotes, parseFull, parseBrief, normalizeCodes, classifyKind } from '../lib/tencent.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('【1】代码归一化');
const norm = normalizeCodes(['sh600519', '000001.SZ', '300750', '510300', 'hk01810', 'garbage', '688981']);
check('sh600519 原样保留', norm.includes('sh600519'));
check('000001.SZ 归一为 sz000001', norm.includes('sz000001'), norm.join(','));
check('300750 补 sz', norm.includes('sz300750'));
check('510300 补 sh', norm.includes('sh510300'));
check('688981 补 sh（科创板）', norm.includes('sh688981'));
check('hk01810 被丢弃（P0 不支持港股）', !norm.some((c) => c.startsWith('hk')));
check('garbage 被丢弃', !norm.includes('garbage'));

console.log('\n【2】真实取数');
const codes = ['sh600519', 'sh000001', 'sh510300', 'sz300750'];
const map = await fetchQuotes(codes);
check('4 个代码全部返回', map.size === 4, '实际 ' + map.size);

const moutai = parseFull('sh600519', map.get('sh600519'));
const index = parseFull('sh000001', map.get('sh000001'));
const etf = parseFull('sh510300', map.get('sh510300'));
const catl = parseFull('sz300750', map.get('sz300750'));

console.log('\n【3】品种识别（用 [61] 而非代码前缀）');
check('sh600519 → stock', moutai.kind === 'stock', moutai.kind + ' / ' + moutai.kindFlag);
check('sh000001 → index', index.kind === 'index', index.kind + ' / ' + index.kindFlag);
check('sh510300 → etf', etf.kind === 'etf', etf.kind + ' / ' + etf.kindFlag);
check('sz300750 → stock', catl.kind === 'stock', catl.kind + ' / ' + catl.kindFlag);

console.log('\n【4】品种适配硬约束（复现方案里的「指数显示市盈率 16.24」缺陷）');
for (const k of ['pe', 'peDyn', 'peStatic', 'pb', 'turnover', 'limitUp', 'limitDown', 'volRatio', 'avgPrice', 'volume', 'outer']) {
  check('指数不含字段 ' + k, !(k in index.fields));
}
check('个股含 市盈率', 'pe' in moutai.fields, String(moutai.fields.pe));
check('ETF 含 涨停价', 'limitUp' in etf.fields, String(etf.fields.limitUp));
check('ETF 不含 市盈率', !('pe' in etf.fields));

console.log('\n【5】涨跌停判定用接口给的涨停价，不用涨幅阈值');
const lu = moutai.fields.limitUp, pc = moutai.fields.prevClose;
check('茅台 涨停价 = 昨收×1.1', Math.abs(lu - pc * 1.1) < 0.011, `${lu} vs ${(pc * 1.1).toFixed(2)}`);
const luEtf = etf.fields.limitUp, pcEtf = etf.fields.prevClose;
check('ETF 涨停价 = 昨收×1.1', Math.abs(luEtf - pcEtf * 1.1) < 0.0011, `${luEtf} vs ${(pcEtf * 1.1).toFixed(4)}`);
const luCatl = catl.fields.limitUp, pcCatl = catl.fields.prevClose;
check('创业板 涨停价 = 昨收×1.2（20cm）', Math.abs(luCatl - pcCatl * 1.2) < 0.011, `${luCatl} vs ${(pcCatl * 1.2).toFixed(2)}`);
check('指数 不参与涨跌停判定', index.limit === null, String(index.limit));

console.log('\n【6】五档盘口');
// 收盘（15:00 起）与尾盘竞价（14:57-15:00）期间交易所会清盘口。实测下来有三种形态：
//   ① 满档；② ladder 为显式 null；③ ladder 是个对象但 bids/asks 是空数组。
// 这个坑犯了五次 —— 每次我都只按当时看到的那一种形态改断言，下一次换个形态又红，
// 而且第 ③ 种还会让 bids[0].price 直接抛 TypeError 把整个套件带崩。
// 所以这里不再猜形态：先判「有没有真的盘口」，再把三种形态一起覆盖。
check('指数无五档（实测全 0）', index.ladder === null);
const book = moutai.ladder;
const twoSided = Array.isArray(book?.bids) && Array.isArray(book?.asks);
check('盘口字段本身在（null 或对象），不是把键删掉', book === null || typeof book === 'object', String(book));
if (!twoSided || book.bids.length === 0 || book.asks.length === 0) {
  check('非盘中时盘口为空，但两侧仍是数组而不是 undefined',
    book === null || twoSided,
    `ladder=${book === null ? 'null' : `bids:${book.bids?.length} asks:${book.asks?.length}`}`);
} else {
  const b = book.bids[0], a = book.asks[0];
  console.log(`        买一 ${b.price}×${b.volume}   卖一 ${a.price}×${a.volume}`);
  check('茅台有五档', true);
  check('买一价 <= 卖一价', b.price <= a.price, `${b.price} <= ${a.price}`);
}

console.log('\n【7】精简解析（全市场扫描用）');
const brief = parseBrief('sh600519', map.get('sh600519'));
check('brief 有现价', brief.price > 0, String(brief.price));
check('brief 不带字段对象（省内存）', brief.fields === undefined);
check('brief 保留涨停判定', brief.atLimitUp === false && String(brief.burst) !== 'undefined');

console.log('\n【8】名称是中文且未乱码');
check('茅台名称正确', moutai.name === '贵州茅台', moutai.name);
check('指数名称正确', index.name === '上证指数', index.name);

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;