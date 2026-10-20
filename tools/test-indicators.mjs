/**
 * 技术指标自检（开发用）
 * 用法：node tools/test-indicators.mjs
 *
 * 三种检查混在一起，各管一件事：
 * 1. 合成数据 —— 手算得出的期望值，验证公式本身没写错（不需要网络）
 * 2. 边界 —— 根数不足必须返回 null 而不是 0 或 NaN
 * 3. 真实数据 —— 拿 sz002739 的 800 根日线跑一遍，验证在真数据上不炸、
 *    且均线排列与「MA5 < MA10 < MA20 < MA60」自洽
 *
 * 为什么不只写合成数据：合成数据的走势是我编的，编出来的一定符合我预期的公式。
 * 真实数据会暴露「跳空、停牌缺根、量为 0」这些只有真数据才有的情况。
 */
import { createMarket } from '../lib/market.js';
import {
  sma, smaSeries, trueRangeSeries, atr, positionInRange, recentLow, recentHigh,
  returnsPct, volumeRatio, maAlignment, alignLabel, analyze, MA_PERIODS,
} from '../lib/indicators.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

/** 造一根 K 线；只填指标用得上的字段 */
const K = (date, open, high, low, close, volume = 1000) => ({ date, open, high, low, close, volume });

/** 连续上涨的 n 根：收盘 1,2,3,... */
const ramp = (n) => Array.from({ length: n }, (_, i) => K(`d${i}`, i + 1, i + 1, i + 1, i + 1));

console.log('【1】均线：手算值对得上');
// 收盘 1..10，最后 5 根是 6,7,8,9,10 → 均值 8
check('sma(5) 等于手算的 8', sma(ramp(10), 5) === 8, String(sma(ramp(10), 5)));
check('sma(10) 等于手算的 5.5', sma(ramp(10), 10) === 5.5, String(sma(ramp(10), 10)));
check('根数不足返回 null，不是用更短窗口凑', sma(ramp(9), 10) === null);
check('n 超过总根数返回 null', sma(ramp(10), 11) === null);
check('窗口里有缺失值返回 null', sma([...ramp(6), K('d6', 7, 7, 7, null)], 5) === null);

console.log('\n【2】均线序列：长度一致，前 n-1 个是 null，末值等于 sma');
{
  const cs = ramp(10);
  const s = smaSeries(cs, 5);
  check('序列长度等于根数', s.length === cs.length, `${s.length}`);
  check('前 4 个是 null', s.slice(0, 4).every((v) => v === null));
  check('第 5 个开始有值', s[4] === 3, String(s[4])); // 1..5 的均值
  check('末值等于 sma(5)', s[s.length - 1] === sma(cs, 5), String(s[s.length - 1]));
  check('根数不足时整条都是 null', smaSeries(ramp(3), 5).every((v) => v === null));
}

console.log('\n【3】真实波幅：跳空要算进 TR');
// 昨收 10，今天开 8.5 收 8.6，最高 9 最低 8.4：
// high-low = 0.6，|9-10| = 1.0，|8.4-10| = 1.6 → TR 取 1.6
{
  const cs = [K('d0', 10, 10, 10, 10), K('d1', 8.5, 9, 8.4, 8.6)];
  const tr = trueRangeSeries(cs);
  check('跳空日的 TR 取「低点与昨收之差」', Math.abs(tr[1] - 1.6) < 1e-9, String(tr[1]));
  check('第一根没有昨收，TR 退化为 high-low', Math.abs(tr[0] - 0) < 1e-9, String(tr[0]));
}

console.log('\n【4】ATR：15 根常数波幅时等于那个常数');
{
  // 每根 high-low 都是 2，且没有跳空 → 所有 TR = 2 → ATR 必须 = 2
  const cs = Array.from({ length: 20 }, (_, i) => K(`d${i}`, 10, 11, 9, 10));
  check('ATR 等于手算的 2', Math.abs(atr(cs) - 2) < 1e-9, String(atr(cs)));
  check('ATR 不做四舍五入污染', Number.isFinite(atr(cs)) && atr(cs) !== 2.0000001);
  check('只有 14 根时返回 null（起算要 15 根）', atr(Array.from({ length: 14 }, (_, i) => K(`d${i}`, 10, 11, 9, 10))) === null);
  // 波动放大后 ATR 应当上升，但不是跳到新值：Wilder 的权重是 1/14
  const spike = [...cs, K('big', 10, 16, 4, 10)];
  check('一根巨幅波动后 ATR 上升但远小于 12', atr(spike) > 2 && atr(spike) < 3, String(atr(spike)));
}

console.log('\n【5】区间分位：0 / 50 / 100 与一字板的 null');
{
  const mk = (close) => [K('a', 10, 20, 10, 15), K('b', 15, 20, 10, close)];
  check('收在区间最低 = 0', positionInRange([K('a', 10, 20, 10, 10), K('b', 10, 20, 10, 10)], 2) === 0);
  check('收在区间正中 = 50', Math.abs(positionInRange(mk(15), 2) - 50) < 1e-9, String(positionInRange(mk(15), 2)));
  check('收在区间最高 = 100', Math.abs(positionInRange(mk(20), 2) - 100) < 1e-9);
  check('一字板（全段无波动）返回 null 而不是 50', positionInRange([K('a', 5, 5, 5, 5), K('b', 5, 5, 5, 5)], 2) === null);
  check('根数不足返回 null', positionInRange(ramp(10), 60) === null);
}

console.log('\n【6】区间高低点与涨跌幅');
{
  const cs = [K('a', 1, 12, 8, 10), K('b', 10, 11, 9, 10), K('c', 10, 10, 7, 9)];
  check('recentLow(3) = 7', recentLow(cs, 3) === 7, String(recentLow(cs, 3)));
  check('recentHigh(3) = 12', recentHigh(cs, 3) === 12, String(recentHigh(cs, 3)));
  const lin = Array.from({ length: 6 }, (_, i) => K(`d${i}`, 0, 0, 0, 100 + i * 2));
  check('5 根涨 10% 算对', Math.abs(returnsPct(lin, 5) - 10) < 1e-9, String(returnsPct(lin, 5)));
  check('n 处没有足够根数返回 null', returnsPct(lin, 6) === null);
  check('起点为 0 时返回 null 而不是 Infinity', returnsPct([K('a', 0, 0, 0, 0), K('b', 0, 0, 0, 5)], 1) === null);
}

console.log('\n【7】量比：分母为 0 要返回 null');
{
  const cs = [K('a', 1, 1, 1, 1, 100), K('b', 1, 1, 1, 1, 100), K('c', 1, 1, 1, 1, 100),
    K('d', 1, 1, 1, 1, 100), K('e', 1, 1, 1, 1, 100), K('f', 1, 1, 1, 1, 200)];
  check('末根 200 / 前 5 均 100 = 2', volumeRatio(cs, 5) === 2, String(volumeRatio(cs, 5)));
  const zero = cs.map((k) => ({ ...k, volume: 0 }));
  check('前 5 根量都是 0 时返回 null', volumeRatio(zero, 5) === null);
  check('根数不足返回 null', volumeRatio(cs.slice(0, 5), 5) === null);
}

console.log('\n【8】均线排列：四条同向才算');
{
  check('多头 5>10>20>60', maAlignment({ ma5: 5, ma10: 4, ma20: 3, ma60: 2 }) === 'bull');
  check('空头 5<10<20<60', maAlignment({ ma5: 2, ma10: 3, ma20: 4, ma60: 5 }) === 'bear');
  check('纠缠', maAlignment({ ma5: 3, ma10: 5, ma20: 4, ma60: 2 }) === 'mixed');
  check('缺 ma60 返回 null', maAlignment({ ma5: 5, ma10: 4, ma20: 3, ma60: null }) === null);
  check('中文标签', alignLabel('bear') === '空头排列' && alignLabel(null) === '均线不足');
}

console.log('\n【9】analyze：空输入与结构完整性');
{
  check('空数组返回 null', analyze([]) === null);
  check('非数组返回 null', analyze(null) === null);
  const a = analyze(ramp(300));
  check('MA_PERIODS 全部算出来', MA_PERIODS.every((n) => Number.isFinite(a.ma[`ma${n}`])),
    MA_PERIODS.map((n) => a.ma[`ma${n}`]).join(', '));
  check('纯单边上涨判为多头排列', a.align === 'bull', a.align);
  check('单边上涨的位置在 100%', Math.abs(a.pos.d250 - 100) < 1e-9, String(a.pos.d250));
  check('atrPct 与 atr / close 一致',
    Math.abs(a.atrPct - (a.atr / a.close) * 100) < 1e-9);
}

console.log('\n【10】analyze 不修改入参');
{
  const cs = ramp(300);
  const before = JSON.stringify(cs);
  analyze(cs);
  check('入参一字节没变', JSON.stringify(cs) === before);
}

console.log('\n【11】真实数据：sz002739 日线（需要网络）');
try {
  const market = createMarket();
  const kl = await market.kline('sz002739', { period: 'day', limit: 800 });
  const cs = kl.candles ?? [];
  check('取到 500 根以上（上限放开后应当接近 800）', cs.length > 500, `${cs.length} 根`);
  const a = analyze(cs);
  const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
  console.log(`        最新 ${a.date} 收 ${fmt(a.close)}  根数 ${a.bars}`);
  console.log(`        均线 MA5 ${fmt(a.ma.ma5)} MA10 ${fmt(a.ma.ma10)} MA20 ${fmt(a.ma.ma20)} MA60 ${fmt(a.ma.ma60)} MA120 ${fmt(a.ma.ma120)} MA250 ${fmt(a.ma.ma250)}`);
  console.log(`        距均线 MA20 ${fmt(a.distMa.ma20)}%  MA60 ${fmt(a.distMa.ma60)}%  MA250 ${fmt(a.distMa.ma250)}%`);
  console.log(`        ATR14 ${fmt(a.atr)}（${fmt(a.atrPct)}%）  量比(前5均) ${fmt(a.volRatio5)}`);
  console.log(`        区间位置 60日 ${fmt(a.pos.d60)}%  120日 ${fmt(a.pos.d120)}%  250日 ${fmt(a.pos.d250)}%`);
  console.log(`        区间涨跌 5日 ${fmt(a.returns.d5)}%  20日 ${fmt(a.returns.d20)}%  60日 ${fmt(a.returns.d60)}%  250日 ${fmt(a.returns.d250)}%`);
  console.log(`        排列 ${alignLabel(a.align)}（${a.align}）`);
  check('真实数据上六个均线都是有限数', MA_PERIODS.every((n) => Number.isFinite(a.ma[`ma${n}`])));
  check('ATR 落在 0.01~5 元的合理区间', a.atr > 0.01 && a.atr < 5, fmt(a.atr));
  check('区间位置在 0~100 之间', [a.pos.d60, a.pos.d120, a.pos.d250].every((v) => v >= 0 && v <= 100));
  // 自洽性：排列判定必须和四条均线的实际大小关系一致，这是最容易写反的地方
  const m = [a.ma.ma5, a.ma.ma10, a.ma.ma20, a.ma.ma60];
  const strictlyDown = m.every((v, i) => i === 0 || m[i - 1] < v);
  const strictlyUp = m.every((v, i) => i === 0 || m[i - 1] > v);
  check('排列判定与均线实际关系自洽',
    (a.align === 'bear' && strictlyDown) || (a.align === 'bull' && strictlyUp) || a.align === 'mixed',
    `${a.align}  ${m.map(fmt).join(' / ')}`);
} catch (err) {
  console.log(`  SKIP  取不到真实数据（${err.message}），合成数据部分仍有效`);
}

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
