/**
 * 历史条件频率自检（开发用）
 * 用法：node tools/test-baserates.mjs
 *
 * 分两段：
 * 1. 合成数据 —— 手算得出来的期望值，锁住「非重叠」「相位」「判定阈值」这些规则
 * 2. 真实数据 —— 拿 sz002739 的 800 根日线 / 514 根周线跑一遍，只断言结构自洽
 *    （不断言具体百分比：数据每天都在变，锁死数字的测试第二天就红）
 *
 * 为什么合成数据要专门造「相位」的坑：基准的相位漂移是这套统计最大的隐性噪声，
 * 用普通随机序列测不出来，必须造一个「按 h 取模才有规律」的序列。
 */
import { createMarket } from '../lib/market.js';
import {
  CONDITIONS, HORIZONS, wilson, quantile, tier, buildContext, hitsAt, nonOverlap,
  forwardReturn, summarize, baselineStat, conditionStat, judge, buildTable,
  todayHits, isContradictory, condName,
} from '../lib/baserates.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

const K = (close, volume = 1000, i = 0) => ({
  date: `d${i}`, open: close, high: close, low: close, close, volume,
});
/** 收盘价由函数生成的序列 */
const series = (n, fn) => Array.from({ length: n }, (_, i) => K(fn(i), 1000, i));

console.log('【1】Wilson 区间：小样本不能算出负数下界');
{
  const [lo, hi] = wilson(20, 31);
  check('20/31 → 下沿约 47%', Math.abs(lo - 47) < 1, lo.toFixed(1));
  check('20/31 → 上沿约 79%', Math.abs(hi - 79) < 1, hi.toFixed(1));
  const [lo0] = wilson(0, 10);
  check('0/10 下界是 0，不是负数', lo0 === 0, String(lo0));
  const w10 = wilson(10, 10);
  check('10/10 上界是 100', w10[1] === 100, String(w10[1]));
  check('10/10 下界约 72%（Wilson 不会给出 100%~100%）', Math.abs(w10[0] - 72) < 1, w10[0].toFixed(1));
  check('n=0 返回 null', wilson(0, 0) === null);
}

console.log('\n【2】分位数与三档样本量');
{
  check('1..5 的中位数是 3', quantile([1, 2, 3, 4, 5], 50) === 3);
  check('线性插值：1..4 的中位数是 2.5', quantile([1, 2, 3, 4], 50) === 2.5, String(quantile([1, 2, 3, 4], 50)));
  check('空数组返回 null', quantile([], 50) === null);
  check('n=30 是「够用」', tier(30) === 'full');
  check('n=29 是「小样本」', tier(29) === 'small');
  check('n=15 仍是「小样本」', tier(15) === 'small');
  check('n=14 是「样本不足」', tier(14) === 'insufficient');
  check('n=0 是 none', tier(0) === 'none');
}

console.log('\n【3】非重叠抽样：连续命中只算一个');
{
  const hits = new Array(30).fill(false);
  hits[3] = hits[4] = hits[5] = true; // 连着三天命中
  hits[20] = true;
  const idx = nonOverlap(hits, 5, 0);
  check('连续命中只接受第一个', idx[0] === 3, JSON.stringify(idx));
  check('间隔够的第二个也被接受', idx.includes(20), JSON.stringify(idx));
  check('被挡住的那两个不在结果里', !idx.includes(4) && !idx.includes(5));
  const all = nonOverlap(new Array(20).fill(true), 5, 0);
  check('全命中时按 h 等距取', JSON.stringify(all) === '[0,5,10,15]', JSON.stringify(all));
  const fromTen = nonOverlap(new Array(20).fill(true), 5, 10);
  check('from 参数决定起点', fromTen[0] === 10, JSON.stringify(fromTen));
}

console.log('\n【4】上穿收益率：越界返回 null');
{
  const cs = series(5, (i) => 100 + i * 10);
  check('0 → 2 根涨 20%', Math.abs(forwardReturn(cs, 0, 2) - 20) < 1e-9, String(forwardReturn(cs, 0, 2)));
  check('越界返回 null', forwardReturn(cs, 3, 5) === null);
  check('起点为 0 返回 null', forwardReturn([K(0), K(5)], 0, 1) === null);
}

console.log('\n【5】汇总：全涨 / 全跌 / 一半');
{
  const up = series(10, (i) => 100 + i);
  const s = summarize(up, [0, 1, 2, 3], 1);
  check('全涨时上涨占比 100%', s.upPct === 100, String(s.upPct));
  check('n 等于样本数', s.n === 4);
  const down = series(10, (i) => 100 - i);
  check('全跌时上涨占比 0%', summarize(down, [0, 1], 1).upPct === 0);
  check('空样本返回 n=0 而不是 NaN', summarize(up, [], 1).n === 0);
}

console.log('\n【6】上下文：MA20 预热与量比');
{
  const cs = series(30, () => 10);
  const ctx = buildContext(cs);
  check('第 19 根还没有 MA20', ctx.ma20[18] === null);
  check('第 20 根（下标 19）有 MA20', Math.abs(ctx.ma20[19] - 10) < 1e-9);
  check('第 4 根没有量比', ctx.volRatio[4] === null);
  check('第 5 根有量比', ctx.volRatio[5] === 1, String(ctx.volRatio[5]));
}

console.log('\n【7】四个条件的判定（逐个造假数据试）');
{
  // C2：贴在 MA20 上且缩量
  const flat = series(30, (i) => (i === 29 ? 10 : 10));
  flat[29] = K(10.05, 500, 29);
  let ctx = buildContext(flat);
  check('C2 命中：收盘在 MA20 ±2% 内且缩量', hitsAt(flat, ctx, 'C2', 29) === true);
  check('C2 不命中：量放大', hitsAt(flat, buildContext([...flat.slice(0, 29), K(10.05, 5000, 29)]), 'C2', 29) === false);

  // C1：站上 MA20 + 放量 + 当期涨幅 > 2%
  const brk = series(30, (i) => (i < 29 ? 10 : 10.3));
  brk[29] = K(10.3, 3000, 29);
  ctx = buildContext(brk);
  check('C1 命中：突破 + 放量 + 涨幅 3%', hitsAt(brk, ctx, 'C1', 29) === true);
  const weak = [...brk.slice(0, 29), K(10.15, 3000, 29)];
  check('C1 不命中：涨幅不到 2%', hitsAt(weak, buildContext(weak), 'C1', 29) === false);

  // C3：前一期在均线上方、当期跌破。先抬高几根再砸下去，才能让「前一期收盘 > 前一期 MA20」成立
  const brkDown = series(30, (i) => (i >= 18 && i <= 28 ? 10.5 : 10));
  brkDown[29] = K(10, 1000, 29);
  ctx = buildContext(brkDown);
  check('C3 命中：从上方跌破 MA20', hitsAt(brkDown, ctx, 'C3', 29) === true);

  // C4：日线阈值 15%、周线阈值 20%
  const drop = series(30, (i) => (i < 9 ? 100 : 100 * (i >= 29 ? 0.82 : 1)));
  const dayCtx = buildContext(drop, 'day');
  const weekCtx = buildContext(drop, 'week');
  check('C4 日线：跌 18% 命中（阈值 15%）', hitsAt(drop, dayCtx, 'C4', 29) === true);
  check('C4 周线：跌 18% 不命中（阈值 20%）', hitsAt(drop, weekCtx, 'C4', 29) === false);
}

console.log('\n【8】基准的相位漂移：造一个「按 4 取模」的序列，用 h=3 去抽');
{
  // 周期 4 的价格、周期 3 的抽样 → 三个相位分别落在不同的取模残类上，结果必然不同。
  // 这是「相位」这个概念最干净的构造：同一个公式、同一段数据，换起点换个答案。
  const cs = series(60, (i) => 100 + (i % 4) * 5);
  const b = baselineStat(cs, 3, 'day');
  check('三个相位都被跑到', b.phases === 3, String(b.phases));
  check('相位区间宽度 > 0（说明确实敏感）', b.phaseSpread > 0, `${b.phaseRange?.[0]}~${b.phaseRange?.[1]}`);
  check('报的是均值而不是某一个相位', b.upPct > 0 && b.upPct < 100, b.upPct.toFixed(1));
  const one = baselineStat(cs, 1, 'day');
  check('h=1 只有一个相位，宽度为 0', one.phases === 1 && one.phaseSpread === 0);
}

console.log('\n【9】判定：区间必须整个越过基准的相位区间');
{
  const base = { upPct: 45, phaseRange: [42, 48] };
  check('区间下沿 50 > 48 → 正', judge({ n: 30, ci: [50, 70] }, base) === 'pos');
  check('区间上沿 40 < 42 → 负', judge({ n: 30, ci: [20, 40] }, base) === 'neg');
  check('区间跨过基准 → 无信号', judge({ n: 30, ci: [38, 60] }, base) === 'none');
  check('下沿刚好压在 48 上不算正（要严格大于）', judge({ n: 30, ci: [48, 70] }, base) === 'none');
  check('n<15 → unknown，不许给方向', judge({ n: 14, ci: [60, 90] }, base) === 'unknown');
  check('没有区间 → unknown', judge({ n: 30, ci: null }, base) === 'unknown');
  check('没有基准 → unknown', judge({ n: 30, ci: [50, 70] }, null) === 'unknown');
}

console.log('\n【10】口径矛盾：两窗口方向相反时必须能被识别');
{
  const rows = [
    { era: 'A', cond: 'C4', horizon: 4, judge: 'pos' },
    { era: 'B', cond: 'C4', horizon: 4, judge: 'neg' },
    { era: 'A', cond: 'C1', horizon: 4, judge: 'pos' },
    { era: 'B', cond: 'C1', horizon: 4, judge: 'none' },
  ];
  const c = isContradictory(rows);
  check('只报出方向相反的那一对', c.length === 1 && c[0].key === 'C4.4', JSON.stringify(c));
  check('一方无信号不算矛盾', !c.some((x) => x.key === 'C1.4'));
}

console.log('\n【11】表结构：周期、持有期、口径切分');
{
  const day = series(400, (i) => 100 + Math.sin(i / 7) * 5 + i * 0.02);
  const week = series(300, (i) => 100 + Math.sin(i / 11) * 8 + i * 0.05);
  const t = buildTable({ day, week });
  const dayH = [...new Set(t.rows.filter((r) => r.period === 'day').map((r) => r.horizon))].sort((a, b) => a - b);
  const weekH = [...new Set(t.rows.filter((r) => r.period === 'week').map((r) => r.horizon))].sort((a, b) => a - b);
  check('日线持有期是 1/3/5/10', JSON.stringify(dayH) === JSON.stringify(HORIZONS.day), JSON.stringify(dayH));
  check('周线持有期是 1/4/8', JSON.stringify(weekH) === JSON.stringify(HORIZONS.week), JSON.stringify(weekH));
  check('周线做了口径切分（A/B 都有）',
    ['A', 'B'].every((e) => t.rows.some((r) => r.period === 'week' && r.era === e)));
  check('日线不切口径（只有一段）', t.rows.filter((r) => r.period === 'day').every((r) => r.era === null));
  check('周线 B 段比 A 段短',
    t.base['BASE.4w.B'].n < t.base['BASE.4w.A'].n,
    `${t.base['BASE.4w.B'].n} < ${t.base['BASE.4w.A'].n}`);
  check('每个条件都有中文名', CONDITIONS.every((c) => condName(c.id) === c.name));
  check('行 id 带周期后缀', t.rows.every((r) => /\.\d+[dw](\.A|\.B)?$/.test(r.id)), t.rows[0].id);
  check('行里带噪声地板', t.rows.every((r) => r.noisePp === null || typeof r.noisePp === 'number'));
  check('空输入不炸', buildTable({}).rows.length === 0);
}

console.log('\n【12】真实数据：sz002739（需要网络）');
try {
  const market = createMarket();
  const day = (await market.kline('sz002739', { period: 'day', limit: 800 })).candles;
  const week = (await market.kline('sz002739', { period: 'week', limit: 800 })).candles;
  const t = buildTable({ day, week });
  const f = (v, d = 0) => (v === null || v === undefined ? '—' : v.toFixed(d));

  console.log(`  日线 ${day.length} 根（${day[0].date} → ${day.at(-1).date}）  周线 ${week.length} 根`);
  console.log('\n  基准（相位区间 = 噪声地板）：');
  for (const b of Object.values(t.base)) {
    console.log(`    ${b.id.padEnd(12)} n=${String(b.n).padStart(3)}  均值 ${f(b.upPct)}%  相位 [${b.phaseRange?.[0]},${b.phaseRange?.[1]}] 宽 ${b.phaseSpread}pp`);
  }
  console.log('\n  有方向的格子：');
  const judged = t.rows.filter((r) => r.judge === 'pos' || r.judge === 'neg');
  for (const r of judged) {
    console.log(`    ${r.id.padEnd(10)} ${condName(r.cond)} ${r.horizon}${r.period === 'week' ? '周' : '日'}  n=${r.n}  涨 ${f(r.upPct)}%  区间 [${f(r.ci?.[0])},${f(r.ci?.[1])}]%  基准 ${f(r.base)}%  ${r.judge === 'pos' ? '正边缘' : '负边缘'}`);
  }
  console.log(`\n  今日命中：日线 ${JSON.stringify(todayHits(day, 'day'))}  周线 ${JSON.stringify(todayHits(week, 'week'))}`);
  console.log(`  检验次数 ${t.meta.tests}  口径矛盾 ${JSON.stringify(isContradictory(t.rows))}`);

  check('日线取到 800 根', day.length === 800, String(day.length));
  check('周线取到 500 根以上', week.length > 500, String(week.length));
  check('每行都带区间或明确 null', t.rows.every((r) => r.ci === null || (Array.isArray(r.ci) && r.ci[0] <= r.ci[1])));
  check('n<15 的行一律 unknown', t.rows.filter((r) => r.n > 0 && r.n < 15).every((r) => r.judge === 'unknown'));
  check('n>=15 的行都有方向判定', t.rows.filter((r) => r.n >= 15).every((r) => ['pos', 'neg', 'none'].includes(r.judge)));
  check('基准的相位宽度随持有期变大', t.base['BASE.10d'].phaseSpread >= t.base['BASE.1d'].phaseSpread,
    `${t.base['BASE.10d'].phaseSpread} >= ${t.base['BASE.1d'].phaseSpread}`);
  // 今天日线命中 C2 时，C2 在 1 日口径上不应该被判成正边缘（这正是「今天没有买点」的依据）
  const today = todayHits(day, 'day');
  if (today.includes('C2')) {
    const row = t.rows.find((r) => r.cond === 'C2' && r.horizon === 1 && r.period === 'day');
    check('今日 C2 命中，但 C2.1d 不是正边缘', row.judge !== 'pos', `${row.judge}  涨${f(row.upPct)}%`);
  }
} catch (err) {
  console.log(`  SKIP  取不到真实数据（${err.message}），合成数据部分仍有效`);
}

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
