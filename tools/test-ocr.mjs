/**
 * 图片识别股票自检（开发用）
 * 用法：node tools/test-ocr.mjs
 *
 * 分两段，因为两段的失败原因完全不同：
 * 1. 纯函数段（归一化、代码修复、候选匹配）在任何机器上都必须过，失败就是代码 bug；
 * 2. 真实 OCR 段依赖本机装了 Windows 中文 OCR 语言包，没装就整体跳过并明确说「跳过」——
 *    不能报成失败，否则换台机器一跑就红，久了就没人信这套自检了。
 *
 * 图片样本 tools/fixtures/ocr-light.png 是用 Pillow 造出来的模拟券商自选截图，
 * 内容固定（4 只股票 + 代码 + 价格），所以识别结果可以断言。
 *
 * 已知的识别缺陷（实测，写在这里免得以后当成 bug 反复查）：
 * - 中文是逐字分词输出，`贵 州 茅 台` 之间带空格，必须 compact 掉才能匹配；
 * - 数字会错认，600519 认成 600S19、300750 认成 3007S0，靠 CONFUSABLE 表修回来；
 * - 标点可能是全角，`．` `％`，靠全角转半角处理。
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compactText, createOcr, extractCodes, normalizeLine, pickCandidates,
} from '../lib/ocr.js';
import { createUniverse } from '../lib/universe.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, 'fixtures', 'ocr-light.png');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};
const skip = (name, why) => console.log('  SKIP  ' + name + (why ? '  → ' + why : ''));

// ---------- 一、归一化 ----------

console.log('\n[归一化]');
const halfWidth = normalizeLine('1328 ． 26');
check('全角句点转半角', halfWidth.includes('1328 . 26'), JSON.stringify(halfWidth));

const negative = normalizeLine('一 0 ． 06 ％');
check('「一」在数字前还原成负号', negative.trimStart().startsWith('-'), JSON.stringify(negative));
check('全角百分号转半角', negative.includes('%'), JSON.stringify(negative));

check('股票名里的「一」不动',
  normalizeLine('第一创业') === '第一创业', JSON.stringify(normalizeLine('第一创业')));

check('逐字分词的空格被压掉',
  compactText('贵 州 茅 台') === '贵州茅台', compactText('贵 州 茅 台'));
check('compact 连半角空格一起去掉',
  compactText('半 导 体 设 备 ETF') === '半导体设备ETF', compactText('半 导 体 设 备 ETF'));

// ---------- 二、代码修复 ----------

console.log('\n[代码修复]');
const POOL = new Set(['600519', '000001', '159558', '300750']);

check('S 修成 5（实测错认）',
  extractCodes('600S19', POOL).join(',') === '600519', extractCodes('600S19', POOL).join(','));
check('3007S0 修成 300750',
  extractCodes('3007S0', POOL).join(',') === '300750', extractCodes('3007S0', POOL).join(','));
check('正确的代码原样通过',
  extractCodes('000001', POOL).join(',') === '000001', extractCodes('000001', POOL).join(','));
check('池子里没有的 6 位数字不算命中',
  extractCodes('123456', POOL).length === 0, extractCodes('123456', POOL).join(','));
check('价格不会被当成代码',
  extractCodes('1328.26', POOL).length === 0, extractCodes('1328.26', POOL).join(','));
check('一段文本里的多个代码都能取出',
  extractCodes('600S19 3007S0', POOL).length === 2, extractCodes('600S19 3007S0', POOL).join(','));

// ---------- 三、候选匹配 ----------

console.log('\n[候选匹配]');
const MINI = [
  { code: 'sh600519', name: '贵州茅台', kind: 'stock' },
  { code: 'sz000001', name: '平安银行', kind: 'stock' },
  { code: 'sz300750', name: '宁德时代', kind: 'stock' },
  { code: 'sz159558', name: '半导体设备ETF易方达', kind: 'fund' },
];

const byName = pickCandidates(['贵 州 茅 台'], MINI);
check('按名称命中', byName.items.length === 1 && byName.items[0].code === 'sh600519',
  JSON.stringify(byName.items));
check('名称命中的 matchedBy 是 name', byName.items[0]?.matchedBy === 'name', byName.items[0]?.matchedBy);

const byCode = pickCandidates(['600S19'], MINI);
check('按代码命中（含错认修复）', byCode.items[0]?.code === 'sh600519', JSON.stringify(byCode.items));
check('代码命中的 matchedBy 是 code', byCode.items[0]?.matchedBy === 'code', byCode.items[0]?.matchedBy);

const both = pickCandidates(['贵州茅台 600519'], MINI);
check('名称与代码同时命中时只出一条（去重）', both.items.length === 1, JSON.stringify(both.items));
check('同时命中时以代码为准', both.items[0]?.matchedBy === 'code', both.items[0]?.matchedBy);

check('场内基金也能认出来（kind=fund）',
  pickCandidates(['159558'], MINI).items[0]?.kind === 'fund',
  JSON.stringify(pickCandidates(['159558'], MINI).items));

// 2 字名不参与「包含」匹配：否则「中信」这种名字在任意文本里都会刷出候选
const SHORT = [{ code: 'sh600030', name: '中信证券', kind: 'stock' }];
check('2 字片段不在反向匹配里乱攀关系',
  pickCandidates(['中信'], SHORT).items.length === 0,
  JSON.stringify(pickCandidates(['中信'], SHORT).items));

// 简称截断：正向匹配落空，反向匹配该救回来
check('简称截断能靠反向匹配救回',
  pickCandidates(['半导体设备ETF'], MINI).items[0]?.code === 'sz159558',
  JSON.stringify(pickCandidates(['半导体设备ETF'], MINI).items));

// 公共前缀歧义：8 只基金都以「半导体设备ETF」开头时不能乱猜
const AMBIG = [
  { code: 'sh560780', name: '半导体设备ETF广发', kind: 'fund' },
  { code: 'sh561980', name: '半导体设备ETF招商', kind: 'fund' },
  { code: 'sh562590', name: '半导体设备ETF华夏', kind: 'fund' },
  { code: 'sz159327', name: '半导体设备ETF万家', kind: 'fund' },
];
check('命中超过 3 只的公共前缀整组丢弃，不刷候选',
  pickCandidates(['半导体设备ETF'], AMBIG).items.length === 0,
  JSON.stringify(pickCandidates(['半导体设备ETF'], AMBIG).items));

check('价格行不算「没认出」',
  pickCandidates(['1328.26'], MINI).unmatched.length === 0,
  JSON.stringify(pickCandidates(['1328.26'], MINI).unmatched));
check('中文行没对上才报进 unmatched',
  pickCandidates(['我 的 自 选'], MINI).unmatched.length === 1,
  JSON.stringify(pickCandidates(['我 的 自 选'], MINI).unmatched));

check('结果条数受 limit 约束',
  pickCandidates(['贵州茅台 平安银行 宁德时代 159558'], MINI, { limit: 2 }).items.length === 2,
  String(pickCandidates(['贵州茅台 平安银行 宁德时代 159558'], MINI, { limit: 2 }).items.length));

// ---------- 四、真实 OCR ----------

console.log('\n[真实 OCR]');
const ocr = createOcr();
const probe = await ocr.probe();
console.log(`  探测：ok=${probe.ok} lang=${probe.lang} langs=${JSON.stringify(probe.langs)} err=${probe.error}`);

if (!probe.ok) {
  skip('真实识别', `本机没有可用 OCR（${probe.error || '未装中文语言包'}）`);
} else {
  check('探测报出中文能力', (probe.langs ?? []).includes('zh-Hans-CN') || probe.lang === 'zh-Hans-CN',
    JSON.stringify(probe.langs));

  const buf = await readFile(FIXTURE);
  const r = await ocr.recognize(buf);
  check('识别成功', r.ok, r.error);
  check('识别出多行文本', (r.lines ?? []).length >= 10, `${(r.lines ?? []).length} 行`);

  // 用真实代码池跑，验证「代码池 - 匹配」这条真实链路，而不只是小样本
  const catalog = await createUniverse().catalog();
  const picked = pickCandidates(r.lines ?? [], catalog);
  const got = new Set(picked.items.map((x) => x.code));
  const want = ['sh600519', 'sz000001', 'sz159558', 'sz300750'];
  const hit = want.filter((c) => got.has(c));
  check('4 只样本股全部认出来', hit.length === want.length,
    `认出 ${hit.length}/4：${hit.join(',')}；共 ${picked.items.length} 只候选`);
  check('没有凭空多出一大堆候选', picked.items.length <= 8, `${picked.items.length} 只`);
  check('「我的自选」这类标题行不算股票',
    picked.items.every((x) => !x.name.includes('自选')), JSON.stringify(picked.items.map((x) => x.name)));

  const empty = await ocr.recognize(Buffer.alloc(0));
  check('空图片如实报错而不是崩', empty.ok === false && Boolean(empty.error), empty.error);
}

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
