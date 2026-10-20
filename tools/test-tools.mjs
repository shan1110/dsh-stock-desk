/**
 * agent 工具自检（开发用）
 * 用法：node tools/test-tools.mjs
 *
 * 为什么要在 DSH 之外跑：defineTool 来自 @deepseek-ai/dsh-tools，这个包只在 DSH 应用内部
 * 才能解析到（profile 的 node_modules 里没有），所以直接把 lib/tools.js import 进来会解析失败。
 * 这里的做法是把那一行 import 换成本地桩，写成临时模块再导入——其余代码原样执行，
 * 于是 execute 与 render 的真实产出可以在装机之前就检查到。
 * 桩只影响 registerStockTools，不影响被测的 buildToolDefs。
 */
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMarket } from '../lib/market.js';
import { createStore } from '../lib/store.js';
import { stalenessNote, provenance } from '../lib/format.js';

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const SRC = resolve(LIB, 'tools.js');
const PROBE = resolve(LIB, '__probe-tools.mjs');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

/** 被删掉的工具描述原文；用于量化「删实现细节」这一步省了多少 */
const REMOVED = [
  '价格数据有时效，输出里带取数时刻与交易状态；如果当前是收盘或休市，价格是当日快照，不会再变。',
  '涨跌家数由本机扫描全部 A 股（约 5500 只，7 个 HTTP 请求）得出，涨停判定用的是接口给的涨停价，',
  '因此 ST 的 5cm、创业板与科创板的 20cm 都能判对，不会把 20cm 的涨停漏掉。',
  '同时给出同花顺口径的涨停家数作为交叉验证——两个口径不一致时以同花顺为准。',
  '数据来自同花顺涨停池。连板梯队只列 2 板及以上；首板家数由「涨停总数 - 连板总数」推得，会明确标注是推算值。',
  '可选行业板块（共 496 个）或概念板块（共 516 个），涨幅榜或跌幅榜。',
  '每项含板块涨跌幅、主力净流入、板块内上涨/下跌家数、领涨股。',
  '输出包含区间涨跌幅、最高最低、均量，以及最近若干根明细。',
  '日线是前复权数据，除权日不会出现假跳空。',
  '自选股配置保存在宿主侧文件里，agent 因此能直接读到，不需要通过浏览器。输出会给出配置文件路径，便于用户核对。',
  '输出会给出配置文件路径，便于用户核对。',
];

/** 粗略 token 估算：中文字符约 1 token，ASCII 约 0.3 token */
function estTokens(s) {
  let cn = 0, other = 0;
  for (const ch of s) (ch.charCodeAt(0) > 0x2e80 ? cn++ : other++);
  return Math.round(cn + other * 0.3);
}

const src = await readFile(SRC, 'utf8');
const patched = src.replace(
  /import\s*\{\s*defineTool\s*\}\s*from\s*['"]@deepseek-ai\/dsh-tools['"];?/,
  'const defineTool = (x) => x; // 自检桩',
);
if (patched === src) {
  console.error('没找到 defineTool 的 import 行，自检桩没打上，测试无意义');
  process.exitCode = 2;
}
await writeFile(PROBE, patched, 'utf8');

let mod;
try {
  mod = await import('file://' + PROBE.replace(/\\/g, '/') + '?t=' + Date.now());
} finally {
  // 立刻删掉，避免被当成插件源码的一部分
  await unlink(PROBE).catch(() => {});
}

const market = createMarket();
const store = createStore();
const defs = mod.buildToolDefs(market, store);
const byName = new Map(defs.map((d) => [d.name, d]));

console.log('【1】定义本身的形状（defineTool 的契约在 DSH 里，这里只查我自己写的部分）');
check('共 7 个工具', defs.length === 7, defs.map((d) => d.name).join(', '));
check('每个都有 name / description / parameters / execute',
  defs.every((d) => typeof d.name === 'string' && typeof d.description === 'string'
    && d.parameters && typeof d.execute === 'function'));
check('每个都有 output.render', defs.every((d) => typeof d.output?.render === 'function'));
check('参数都带 description', defs.every((d) => Object.values(d.parameters).every((p) => typeof p.description === 'string' && p.description.length > 0)));
check('参数表中的 required 都是布尔', defs.every((d) => Object.values(d.parameters).every((p) => p.required === undefined || typeof p.required === 'boolean')));
check('没有重名', new Set(defs.map((d) => d.name)).size === defs.length);
check('必需参数不超过 1 个', defs.every((d) => Object.values(d.parameters).filter((p) => p.required).length <= 1));

const defSize = defs.reduce((a, d) => a + d.name.length + d.description.length
  + JSON.stringify(d.parameters).length, 0);
const removedSize = REMOVED.reduce((a, s) => a + s.length, 0);
console.log(`        定义总长 ${defSize} 字符 ≈ ${estTokens(defs.map((d) => d.name + d.description + JSON.stringify(d.parameters)).join(''))} tokens`);
console.log(`        本轮删掉的实现细节与输出描述 ${removedSize} 字符 ≈ ${estTokens(REMOVED.join(''))} tokens`);
check('定义精简后总长在 2000 字符以内', defSize < 2000, `${defSize} 字符`);

console.log('\n【2】逐个真跑（打真实接口）');
/**
 * @param {string} name
 * @param {object} args
 * @param {{expectTime?: boolean}} [opt] 有的工具在特定参数下本就不产出时间，别硬要求
 */
const run = async (name, args, opt = {}) => {
  const expectTime = opt.expectTime !== false;
  const d = byName.get(name);
  if (!d) { check(`${name} 存在`, false); return null; }
  try {
    const value = await d.execute(args, {});
    const blocks = d.output.render(args, value);
    const text = blocks.map((b) => b.text).join('\n');
    check(`${name} 返回文本块`, typeof text === 'string' && text.length > 0, `${text.length} 字符`);
    if (expectTime) {
      // 取到数就必须带取数时刻；取不到数则必须老实说「拿不到」。
      // 不写成「必须带取数时刻」是因为取不到时压根没有价格，也就没有「被误读成实时价」的风险；
      // 真正要防的是静默吐一段空文本，让模型拿它当数据用。
      const stamped = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text);
      check(`${name} 要么带取数时刻、要么明说拿不到`,
        stamped || /拿不到|无法|失败|异常/.test(text),
        text.split('\n').slice(0, 2).join(' / '));
    }
    return text;
  } catch (err) {
    check(`${name} 未抛异常`, false, err.message);
    return null;
  }
};

const tQuote = await run('stock_quote', { codes: 'sh600519,sh000001,sz300750' });
const tOverview = await run('market_overview', { breadth: true });
const tOverviewLight = await run('market_overview', { breadth: false });
const tBoard = await run('limit_up_board', { detail: true, full: false });
const tSector = await run('sector_rank', { board: 'industry', direction: 'up', limit: 5 });
const tKline = await run('stock_kline', { code: 'sh600519', period: 'day', limit: 20 });
const tAnalysis = await run('stock_analysis', { code: 'sz002739' });
const tWatch = await run('stock_watchlist', { include_quotes: false }, { expectTime: false });
const tWatchQ = await run('stock_watchlist', { include_quotes: true });

console.log('\n【3】内容抽查');
check('报价含茅台且标出品种', /贵州茅台.*\[个股\]/.test(tQuote ?? ''), (tQuote ?? '').split('\n')[0]);
// 从「上证指数」切到下一个品种，单独检查指数那一段
const idxBlock = (tQuote ?? '').split('上证指数')[1]?.split('宁德时代')[0] ?? '';
check('指数段落不含市盈率/换手率/涨停价/委差/量比',
  !/市盈率|换手率|涨停价|跌停价|委差|量比/.test(idxBlock), idxBlock.trim().slice(0, 70).replace(/\n/g, ' ⏎ '));
check('指数段落说明没有五档盘口', /指数没有五档盘口/.test(idxBlock));
check('总览含涨跌家数', /上涨 \d+ · 下跌 \d+/.test(tOverview ?? ''));
check('breadth=false 时如实说明未扫描', /本次未扫描/.test(tOverviewLight ?? ''));
// 换手率/振幅/封板率恒非负，带正号会被当成「涨」的信息误读
check('非负的百分比不带正号（换手率/振幅/封板率/量比）',
  !/(换手率|振幅|封板率)\s*\+/.test(tQuote ?? '') && !/(换手率|振幅|封板率)\s*\+/.test(tBoard ?? '') && !/(换手率|振幅|封板率)\s*\+/.test(tOverview ?? ''));
check('涨跌幅仍带正负号', /涨跌 [+-]/.test(tQuote ?? ''), (tQuote ?? '').split('\n')[2]);
check('涨停榜含连板梯队', /【连板梯队】/.test(tBoard ?? ''));
check('涨停榜截断处给了取回路径', /full=true 可取回/.test(tBoard ?? '') || !/另有/.test(tBoard ?? ''));
// 板块榜走东方财富。它抖动时工具会如实说「拿不到」——那是正确行为，不该报红。
// 判据不用 sources[].healthy：那是三振熔断，要连挂 3 次才翻，比现实滞后。
// 按结果分岔：拿到正文就验正文，没拿到就验「有没有老实说拿不到」。
const sectorGot = ((tSector ?? '').match(/^ {2}\S/gm) ?? []).length > 0;
if (sectorGot) {
  check('板块榜行数等于请求数', ((tSector ?? '').match(/^ {2}\S/gm) ?? []).length === 5,
    ((tSector ?? '').match(/^ {2}\S.*/gm) ?? []).map((l) => l.slice(0, 30)).join(' | '));
} else {
  console.log('        （东方财富板块榜当前拿不到，板块断言转为验降级）');
  check('拿不到板块榜时明说拿不到，而不是编一份',
    /拿不到|无法|失败|异常/.test(tSector ?? ''), (tSector ?? '').split('\n').slice(0, 3).join(' / '));
}
check('K 线含区间统计', /区间 .* → .*/.test(tKline ?? ''));
// 单股分析：四段必须都在。少一段说明渲染分支断了，而模型拿到残缺的表会自己补
check('单股分析含技术指标与排列', /排列 .+/.test(tAnalysis ?? ''), (tAnalysis ?? '').split('\n')[1]);
check('单股分析含历史频率表与基准', /【历史形态频率】/.test(tAnalysis ?? '') && /基准：/.test(tAnalysis ?? ''));
check('单股分析含位置表', /【位置表】/.test(tAnalysis ?? '') && /S\.lo20|R\.ma20/.test(tAnalysis ?? ''));
check('单股分析含四条判定', /【能不能加仓】/.test(tAnalysis ?? '') && /四条/.test(tAnalysis ?? ''));
check('单股分析的四条判定逐条给了成立/不成立与原因',
  (tAnalysis ?? '').match(/\d\)\s+\S+\s*(成立|不成立)\s+\S/g)?.length === 4,
  String((tAnalysis ?? '').match(/\d\)\s+\S+\s+(成立|不成立)/g)?.length));
check('单股分析不给结论性指令，只给判定位与编号',
  /加仓位|没有符合条件的加仓位/.test(tAnalysis ?? '') && !/建议买入|应该买|立即买/.test(tAnalysis ?? ''));
check('单股分析写明历史频率不等于未来概率', /历史频率不等于未来概率/.test(tAnalysis ?? ''));
check('自选工具给出配置文件路径', /配置文件 .*config\.json/.test(tWatch ?? ''));
check('自选工具不带报价时不编时间', !/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(tWatch ?? ''));
check('自选工具带报价时有时间', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(tWatchQ ?? ''));

console.log('\n【4】失败路径必须说「拿不到」，且劝阻编造');
const dq = byName.get('stock_quote');
const bad = await dq.execute({ codes: 'zzzzzz' }, {});
const badText = dq.output.render({}, bad).map((b) => b.text).join('\n');
check('未知代码明确说取不到', /取不到/.test(badText), badText.split('\n')[0]);
check('未知代码给出可能原因', /可能原因/.test(badText));

// 用假 market 制造数据源故障。这是确定性的，不靠「碰巧某个接口挂了」来测
const brokenMarket = {
  ...market,
  quotes: async () => { throw new Error('模拟数据源故障'); },
  kline: async () => { throw new Error('模拟数据源故障'); },
  session: async () => ({ trading: true, label: '模拟' }),
  health: () => [],
};
const brokenDefs = mod.buildToolDefs(brokenMarket, store);
const bq = brokenDefs.find((d) => d.name === 'stock_quote');
const bv = await bq.execute({ codes: 'sh600519' }, {});
const bt = bq.output.render({}, bv).map((b) => b.text).join('\n');
check('数据源故障时说「拿不到」', /拿不到/.test(bt), bt.split('\n')[0]);
check('数据源故障时给出原因', /原因：模拟数据源故障/.test(bt));
check('数据源故障时劝阻编造', /不要据此推测/.test(bt));

const dk = byName.get('stock_kline');
const emptyK = await dk.execute({ code: 'sh999999' }, {});
const emptyKText = dk.output.render({}, emptyK).map((b) => b.text).join('\n');
check('无 K 线时明确说拿不到', /K 线\s*拿不到|取不到 K 线/.test(emptyKText), emptyKText.split('\n')[0]);

console.log('\n【5】列宽对齐：中文按 2 列宽计');
for (const [label, text] of [['板块榜', tSector], ['总览指数', tOverview]]) {
  const rows = (text ?? '').split('\n').filter((l) => /^\s{2}\S/.test(l));
  check(`${label} 行首缩进一致`, rows.every((l) => l.startsWith('  ')), `${rows.length} 行`);
}

console.log('\n──────────────── 以下为各工具产出的真实文本 ────────────────');
for (const [n, t] of [['stock_quote', tQuote], ['market_overview', tOverview], ['limit_up_board', tBoard], ['sector_rank', tSector], ['stock_kline', tKline], ['stock_analysis', tAnalysis], ['stock_watchlist', tWatch]]) {
  console.log(`\n===== ${n} =====\n${t}`);
}

// 方案 §8 第 6 条：收盘后调用同一工具，返回「已收盘 + 数据快照时刻」，而不是假装实时。
//
// 这条以前一条测试都没有。它不是「不重要」，而是没法顺手测到 —— 想手测必须等到 15:00 之后。
// 但收盘与否只取决于 session 对象，直接喂一个收盘时段进去就行，不需要真等到收盘。
const AT = new Date('2026-10-19T15:05:00+08:00');
const CLOSED = { id: 'closed', label: '已收盘', trading: false };
const TRADING = { id: 'afternoon', label: '午后交易', trading: true };

const closedNote = stalenessNote(CLOSED, AT);
check('收盘提示写明「已收盘」', closedNote.includes('已收盘'), closedNote);
check('收盘提示写明这是快照', closedNote.includes('快照'), closedNote);
check('收盘提示写明价格不再变动', closedNote.includes('不会继续变动'), closedNote);
check('交易中不加收盘提示', stalenessNote(TRADING, AT) === '', `"${stalenessNote(TRADING, AT)}"`);
check('拿不到 session 时按非交易处理，宁可多说一句',
  stalenessNote(null, AT).includes('快照'), stalenessNote(null, AT));

check('provenance 在收盘时写明未交易',
  provenance(CLOSED, AT, []).includes('未交易') && provenance(CLOSED, AT, []).includes('已收盘'),
  provenance(CLOSED, AT, []));
check('provenance 在交易中写明交易中',
  provenance(TRADING, AT, []).includes('交易中'), provenance(TRADING, AT, []));
check('provenance 带上了交易状态而非只有时刻',
  provenance(TRADING, AT, [{ name: '腾讯行情', healthy: true }]).includes('腾讯行情正常'),
  provenance(TRADING, AT, [{ name: '腾讯行情', healthy: true }]));

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;