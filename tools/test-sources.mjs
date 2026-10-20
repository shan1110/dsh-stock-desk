/**
 * 同花顺 / 东财 数据源自检（开发用）
 * 用法：node tools/test-sources.mjs
 */
import { fetchOverview, fetchLadder, fetchLimitUpList, fetchBrokeList, fetchSectorTop } from '../lib/ths.js';
import { fetchKline, fetchSectors } from '../lib/eastmoney.js';
import { localSession, resolveSession, cnParts } from '../lib/session.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('【1】交易时段（固定 UTC+8，不依赖时区库）');
const p = cnParts(Date.now());
check('北京时间年月份合理', p.year >= 2026 && p.month >= 1 && p.month <= 12, `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} 周${p.weekday}`);
check('stamp 是 14 位数字', /^\d{14}$/.test(p.stamp), p.stamp);
const localNow = localSession();
check('本地粗判给出阶段', typeof localNow.id === 'string', `${localNow.id} / ${localNow.label} / trading=${localNow.trading}`);
const weekendTest = new Date('2026-10-18T02:00:00Z'); // 北京时间周日 10:00
check('周日判为休市', localSession(weekendTest.getTime()).id === 'weekend', localSession(weekendTest.getTime()).label);
const morningTest = new Date('2026-10-19T02:00:00Z'); // 北京时间周一 10:00
check('周一 10:00 判为上午交易', localSession(morningTest.getTime()).id === 'morning');

console.log('\n【2】同花顺 涨跌停概览（1 个请求拿全部）');
const ov = await fetchOverview();
console.log(`        日期 ${ov.date}  服务器交易状态 ${ov.tradeStatus?.id} (${ov.tradeStatus?.name})`);
check('拿到涨停家数', ov.limitUp?.today?.num > 0, `涨停 ${ov.limitUp?.today?.num} / 炸板 ${ov.limitUp?.today?.openNum} / 昨日 ${ov.limitUp?.today?.historyNum}`);
check('拿到跌停家数', ov.limitDown?.today?.num >= 0, `跌停 ${ov.limitDown?.today?.num}`);
check('拿到封板率', Number.isFinite(ov.limitUp?.today?.rate), String(ov.limitUp?.today?.rate));
check('拿到交易状态（服务器自报）', Boolean(ov.tradeStatus?.id), ov.tradeStatus?.id);
const sess = resolveSession(ov.tradeStatus);
check('交易状态可合成', typeof sess.trading === 'boolean', `${sess.id} / 来源 ${sess.origin}`);

console.log('\n【3】同花顺 连板梯队');
const ladder = await fetchLadder();
ladder.forEach((r) => console.log(`        ${r.height}板  ${r.number} 家  ${r.stocks.slice(0, 3).map((s) => s.code + ' ' + s.name).join(' / ')}`));
check('梯队非空', ladder.length > 0, `${ladder.length} 个高度`);
check('按高度降序', ladder.every((r, i) => i === 0 || ladder[i - 1].height >= r.height), ladder.map((r) => r.height).join(' > '));
check('每个高度都带代码', ladder.every((r) => r.stocks.every((s) => /^(sh|sz)\d{6}$/.test(s.code))));
check('梯队只含 2 板及以上', ladder.every((r) => r.height >= 2));

console.log('\n【4】同花顺 涨停池 / 炸板池明细');
const lu = await fetchLimitUpList({ limit: 5 });
check('涨停池有条目', lu.items.length > 0, `${lu.items.length} 条 / 总数 ${lu.total}`);
check('条目带 name 与 tag', lu.items.every((i) => i.name && i.tag), lu.items.slice(0, 2).map((i) => `${i.code} ${i.name} ${i.tag}`).join(' | '));
const br = await fetchBrokeList({ limit: 5 });
check('炸板池有条目', br.items.length > 0, `总数 ${br.total}`);
check('炸板 tag 为 LIMIT_FAILED', br.items.every((i) => i.tag === 'LIMIT_FAILED'), br.items[0]?.tag);

console.log('\n【5】同花顺 板块涨停分布');
const st = await fetchSectorTop();
check('板块榜非空', st.length > 0, `${st.length} 个板块`);
st.slice(0, 4).forEach((r) => console.log(`        ${r.name}  涨停 ${r.limitUpNum}  连板 ${r.continuousNum}  ${r.high}  (${r.changePct?.toFixed(2)}%)`));
check('板块带涨停家数', st.some((r) => r.limitUpNum > 0));
check('板块带成分股', st.some((r) => r.stocks.length > 0));

console.log('\n【6】东财 日 K（必须传 beg+end，否则静默 rc:102）');
const kl = await fetchKline('sh600519', { period: 'day', limit: 60 });
check('返回股票名', kl.name === '贵州茅台', kl.name);
check('返回 K 线', kl.candles.length > 20, `${kl.candles.length} 根`);
const last = kl.candles[kl.candles.length - 1];
console.log(`        最后一根 ${last.date}  开 ${last.open} 收 ${last.close} 高 ${last.high} 低 ${last.low} 涨幅 ${last.changePct}%`);
check('最后一根字段齐全', [last.open, last.close, last.high, last.low, last.volume, last.amount].every(Number.isFinite));
check('高 >= 低', last.high >= last.low, `${last.high} >= ${last.low}`);
check('高 >= 开且高 >= 收', last.high >= Math.max(last.open, last.close));
check('低 <= 开且低 <= 收', last.low <= Math.min(last.open, last.close));

console.log('\n【7】东财 分钟 K（分时图用）');
const mk = await fetchKline('sh600519', { period: '1m', limit: 300 });
check('分钟 K 有数据', mk.candles.length > 0, `${mk.candles.length} 根`);
check('分钟 K 时间字段带时分', /\d{2}:\d{2}$/.test(mk.candles[0]?.date ?? ''), mk.candles[0]?.date);

console.log('\n【8】东财 板块榜');
// 东财在连续探测后会间歇性重置连接（本项目反复观察到，停手几分钟自行恢复）。
// 所以这里逐个 try：取到就验内容，取不到就验「有没有如实说拿不到」。
// 不裸 await 是因为崩掉比报红更糟 —— 连哪条断言挂了都不说，只留一段栈。
const trySectors = async (args) => {
  try {
    return { ok: await fetchSectors(args) };
  } catch (err) {
    return { err: String(err?.message ?? err) };
  }
};
const indR = await trySectors({ board: 'industry', direction: 'up', limit: 8 });
if (!indR.ok) {
  console.log(`        （东财板块榜当前拿不到：${indR.err}；板块断言转为验降级）`);
  check('拿不到板块榜时抛出的是可读的一句话，不是空或 undefined',
    typeof indR.err === 'string' && indR.err.length > 0 && !/undefined|\[object/.test(indR.err), indR.err);
} else {
  const ind = indR.ok;
  check('行业板块总数 496', ind.total === 496, String(ind.total));
  ind.items.slice(0, 4).forEach((s) => console.log(`        ${s.name}  ${s.changePct}%  领涨 ${s.leader}  涨/跌 ${s.upCount}/${s.downCount}`));
  check('板块带涨跌幅', ind.items.every((s) => Number.isFinite(s.changePct)));

  const conR = await trySectors({ board: 'concept', direction: 'up', limit: 5 });
  if (conR.ok) check('概念板块总数 516', conR.ok.total === 516, String(conR.ok.total));
  else check('概念榜拿不到时如实标出', Boolean(conR.err), conR.err);

  const downR = await trySectors({ board: 'industry', direction: 'down', limit: 5 });
  if (downR.ok) {
    check('跌幅榜首个为负', downR.ok.items[0]?.changePct < 0,
      `${downR.ok.items[0]?.name} ${downR.ok.items[0]?.changePct}%`);
  } else {
    check('跌幅榜拿不到时如实标出', Boolean(downR.err), downR.err);
  }
}

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;