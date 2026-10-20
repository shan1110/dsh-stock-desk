/**
 * 位置表与四条件自检（开发用）
 * 用法：node tools/test-levels.mjs
 *
 * 重点是四条件的**否决路径**：加仓位返回 null 的那几种情况必须逐条造出来。
 * 只测「全部成立时能给出位置」是不够的 —— 这个功能真正会出问题的地方，
 * 是某一条不成立时仍然硬给一个位置。
 */
import { createMarket } from '../lib/market.js';
import { analyze } from '../lib/indicators.js';
import {
  volumeBand, buildLevels, addPlan, exitPlan, triggerToday, holdPlan, MIN_RATIO, MIN_DISTANCE_ATR,
} from '../lib/levels.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

const K = (close, volume = 1000, low = null, high = null, i = 0) => ({
  date: `d${i}`, open: close, high: high ?? close, low: low ?? close, close, volume,
});
const series = (n, fn) => Array.from({ length: n }, (_, i) => {
  const v = fn(i);
  return typeof v === 'number' ? K(v, 1000, v, v, i) : { ...v, date: `d${i}` };
});

console.log('【1】成交密集带：量堆在哪一档就报哪一档');
{
  // 60 根里有 50 根的量集中在 10 元，10 根在 12 元
  const cs = series(60, (i) => (i < 50 ? K(10, 5000, 9.9, 10.1, i) : K(12, 200, 11.9, 12.1, i)));
  const band = volumeBand(cs, { close: 10.5, atr: 0.3 });
  check('报出量最大的那一档', Math.abs(band.price - 10) < 0.2, String(band.price));
  check('占比在 90% 以上', band.share > 0.9, band.share.toFixed(2));
  check('带宽自适应（ATR/3 ≈ 0.1）', Math.abs(band.width - 0.1) < 0.02, String(band.width));
}

console.log('\n【2】分箱宽度随价格与波动变，不用固定 0.1 元');
{
  const cheap = volumeBand(series(60, (i) => K(8, 1000, 7.9, 8.1, i)), { close: 8, atr: 0.25 });
  const dear = volumeBand(series(60, (i) => K(1300, 1000, 1290, 1310, i)), { close: 1300, atr: 21 });
  check('低价股的带宽约 0.08（ATR/3）', Math.abs(cheap.width - 0.08) < 0.02, String(cheap.width));
  check('高价股的带宽约 7（ATR/3）', Math.abs(dear.width - 7) < 0.5, String(dear.width));
  check('两者相差两个数量级', dear.width / cheap.width > 50, (dear.width / cheap.width).toFixed(0) + ' 倍');
}

console.log('\n【3】位置池：支撑/压力按现价现算');
{
  const cs = series(120, (i) => 10 + Math.sin(i / 5) * 0.8 + i * 0.01);
  const lv = buildLevels({ candles: cs, close: 11 });
  check('有支撑也有压力', lv.support.length > 0 && lv.resistance.length > 0,
    `${lv.support.length} / ${lv.resistance.length}`);
  check('支撑都低于现价', lv.support.every((x) => x.price < 11));
  check('压力都高于现价', lv.resistance.every((x) => x.price > 11));
  check('支撑按由近到远排序', lv.support.every((x, i) => i === 0 || lv.support[i - 1].price >= x.price));
  check('ATR 通道在池子里', lv.items.some((x) => x.id === 'S.atr1') && lv.items.some((x) => x.id === 'S.atr2'));
  check('每个位置都带 id 与距离', lv.items.every((x) => x.id && typeof x.distPct === 'number'));
}

console.log('\n【4】成本价只做参考位，不参与「够不够远」');
{
  const cs = series(120, (i) => 10 + Math.sin(i / 5) * 0.8);
  const lv = buildLevels({ candles: cs, close: 10, cost: 10.5 });
  check('P.cost 在池子里', lv.items.some((x) => x.id === 'P.cost'));
  check('P.cost 不在支撑列表里', !lv.support.some((x) => x.id === 'P.cost'));
  check('P.cost 不在压力列表里', !lv.resistance.some((x) => x.id === 'P.cost'));
  check('P.cost 被标成 personal', lv.items.find((x) => x.id === 'P.cost').personal === true);
}

console.log('\n【5】四条件：四条全成立才给加仓位');
{
  const levels = {
    close: 10,
    atr: 0.5,
    support: [
      { id: 'S.lo20', price: 9.0, distAtr: -2, distPct: -10 },
      { id: 'S.atr2', price: 9.0, distAtr: -2, distPct: -10 },
      { id: 'S.lo60', price: 8.0, distAtr: -4, distPct: -20 },
    ],
    resistance: [{ id: 'R.ma20', price: 11.5, distAtr: 3, distPct: 15 }],
  };
  const good = addPlan({ levels, edge: { judge: 'pos', condId: 'C2' }, trigger: true });
  check('四条全成立 → ok', good.ok === true);
  check('加仓位取最近的够远支撑', good.addZone === 9.0, String(good.addZone));
  check('止损取更下方的那个位置', good.stop === 8.0, String(good.stop));
  check('目标取最近的压力', good.target === 11.5, String(good.target));
  check('盈亏比 = (11.5-9)/(9-8) = 2.5', Math.abs(good.ratio - 2.5) < 1e-9, String(good.ratio));
  check('没有未过的条件', good.addWhy.length === 0, JSON.stringify(good.addWhy));
}

console.log('\n【6】四条件：任何一条不成立都必须返回 null');
{
  const levels = {
    close: 10,
    atr: 0.5,
    support: [{ id: 'S.lo20', price: 9.0, distAtr: -2, distPct: -10 }],
    resistance: [{ id: 'R.ma20', price: 11.5, distAtr: 3, distPct: 15 }],
  };
  const noEdge = addPlan({ levels, edge: { judge: 'neg', condId: 'C2' }, trigger: true });
  check('边缘为负 → 不给位置', noEdge.addZone === null && noEdge.ok === false);
  check('原因里说清是 edge', noEdge.addWhy.includes('edge'), JSON.stringify(noEdge.addWhy));
  check('给出为什么（形态历史上差于基准）', /显著差于基准/.test(noEdge.detail.edge.note));

  const noTrigger = addPlan({ levels, edge: { judge: 'pos', condId: 'C2' }, trigger: false });
  check('没有触发 → 不给位置', noTrigger.addZone === null);
  check('原因里说清是 trigger', noTrigger.addWhy.includes('trigger'));

  // 支撑离现价太近（< 1 ATR）
  const tooClose = addPlan({
    levels: { ...levels, support: [{ id: 'S.lo20', price: 9.8, distAtr: -0.4, distPct: -2 }] },
    edge: { judge: 'pos', condId: 'C2' }, trigger: true,
  });
  check('支撑太近（距现价 < 1 ATR）→ 不给位置', tooClose.addZone === null);
  check('原因里说清是 pos', tooClose.addWhy.includes('pos'), JSON.stringify(tooClose.addWhy));

  // 盈亏比不足：目标离加仓位近、止损离得远
  const badRatio = addPlan({
    levels: {
      close: 10, atr: 0.5,
      support: [
        { id: 'S.lo20', price: 9.0, distAtr: -2, distPct: -10 },
        { id: 'S.lo60', price: 8.2, distAtr: -3.6, distPct: -18 },
      ],
      resistance: [{ id: 'R.ma20', price: 10.4, distAtr: 0.8, distPct: 4 }],
    },
    edge: { judge: 'pos', condId: 'C2' }, trigger: true,
  });
  check('盈亏比 (10.4-9)/(9-8.2)=1.75 < 2 → 不给位置', badRatio.addZone === null, String(badRatio.ratio));
  check('原因里说清是 ratio', badRatio.addWhy.includes('ratio'));
  check('被否决时仍报出候选价位（不打哑谜）', badRatio.rejected?.price === 9.0, JSON.stringify(badRatio.rejected));
}

console.log('\n【7】ATR 缺失时不猜距离');
{
  const lv = { close: 10, atr: null, support: [{ id: 'S.lo20', price: 9, distAtr: null, distPct: -10 }], resistance: [] };
  const p = addPlan({ levels: lv, edge: { judge: 'pos', condId: 'C2' }, trigger: true });
  check('没有 ATR → 位置条件不成立', p.four.pos === false);
  check('说明原因而不是静默', /ATR 算不出来/.test(p.detail.pos.note), p.detail.pos.note);
}

console.log('\n【8】卖出三档');
{
  const levels = buildLevels({ candles: series(120, (i) => 10 + Math.sin(i / 5) * 0.8), close: 10.2, cost: 10.5 });
  const ex = exitPlan({ levels, cost: 10.5, ma10: 10.3, ma20: 10.1 });
  check('止损在现价下方', ex.stop < 10.2, String(ex.stop));
  check('止损带 id 说明依据', Boolean(ex.stopId), ex.stopId);
  check('止损写清距现价幅度', /距现价 -?[\d.]+%/.test(ex.stopNote ?? ''), ex.stopNote);
  check('移动止盈给出两条均线', ex.trail?.ma10 === 10.3 && ex.trail?.ma20 === 10.1);
  const noCost = exitPlan({ levels, cost: null });
  check('没有成本价也能给出止损', noCost.stop !== null, String(noCost.stop));
}

console.log('\n【8b】持仓三态：止损优先，移动止盈只管浮盈');
{
  const levels = { close: 8.31, atr: 0.26, items: [], support: [], resistance: [] };
  const exit = { stop: 7.69, stopId: 'S.lo20', trail: { ma10: 8.30, ma20: 8.38 } };
  // 没破止损 → 拿着
  const hold = holdPlan({ levels, exit, cost: 8.545, close: 8.31, floatPct: -2.75 });
  check('没破止损 → 拿着不动', hold.state === 'hold', hold.state);
  check('拿着时也报出止损位，让人知道线在哪', hold.stop === 7.69, String(hold.stop));
  // 破止损 → 该走了，且不看形态
  const stop = holdPlan({ levels, exit, cost: 8.545, close: 7.5, floatPct: -12.2 });
  check('跌破止损 → 该走了（不再看别的）', stop.state === 'stop', stop.state);
  // 浮盈 + 破 MA10 → 减半
  const trim = holdPlan({ levels, exit, cost: 8.0, close: 8.25, floatPct: 3.12 });
  check('浮盈且破 MA10 → 减半', trim.state === 'trim', trim.state);
  // 浮亏 + 破 MA10 → 仍然拿着：同一句规则对浮亏仓位不成立
  const lossNoTrim = holdPlan({ levels, exit, cost: 9.0, close: 8.25, floatPct: -8.3 });
  check('浮亏且破 MA10 → 不减半（那不是止盈是割肉）', lossNoTrim.state === 'hold', lossNoTrim.state);
  check('缺成本时不猜浮盈方向', holdPlan({ levels, exit, close: 8.25, floatPct: null }).inProfit === null);
}

console.log('\n【9】今日触发：两种形态两种条件');
{
  // 缩量回踩：守住且量缩
  const hold = [...series(10, (i) => K(10, 1000, 10, 10, i)).slice(0, 9), K(10.05, 500, 10, 10.1, 9)];
  check('C2 守住 + 缩量 → 触发', triggerToday({ candles: hold, condId: 'C2', ma20: 10 }).ok === true);
  const broke = [...series(10, (i) => K(10, 1000, 10, 10, i)).slice(0, 9), K(9.9, 500, 9.8, 10, 9)];
  const t2 = triggerToday({ candles: broke, condId: 'C2', ma20: 10 });
  check('C2 没守住 → 不触发', t2.ok === false, t2.why);

  // 放量突破：站上 MA20 且放量
  const up = [...series(10, (i) => K(10, 1000, 10, 10, i)).slice(0, 9), K(10.5, 3000, 10.4, 10.6, 9)];
  check('C1 站回 MA20 + 放量 → 触发', triggerToday({ candles: up, condId: 'C1', ma20: 10 }).ok === true);
  const noVol = [...series(10, (i) => K(10, 1000, 10, 10, i)).slice(0, 9), K(10.5, 1000, 10.4, 10.6, 9)];
  check('C1 没量 → 不触发', triggerToday({ candles: noVol, condId: 'C1', ma20: 10 }).ok === false);

  // C3/C4 是下跌形态，本来就没有「可以进」的那一步
  check('C3 不给触发条件', triggerToday({ candles: hold, condId: 'C3', ma20: 10 }).ok === false);
  check('C4 不给触发条件', triggerToday({ candles: hold, condId: 'C4', ma20: 10 }).ok === false);
}

console.log('\n【10】真实数据：sz002739（需要网络）');
try {
  const market = createMarket();
  const day = (await market.kline('sz002739', { period: 'day', limit: 800 })).candles;
  const ind = analyze(day);
  const lv = buildLevels({ candles: day, close: ind.close, cost: 8.545 });
  console.log(`  现价 ${ind.close}  ATR14 ${ind.atr.toFixed(3)}`);
  for (const x of lv.items) {
    console.log(`    ${x.id.padEnd(8)} ${String(x.price).padStart(8)}  ${x.side.padEnd(10)} 距现价 ${x.distPct.toFixed(2)}%  ${x.note}`);
  }
  const trigger = triggerToday({ candles: day, condId: 'C2', ma20: ind.ma.ma20 });
  const plan = addPlan({ levels: lv, edge: { judge: 'none', condId: 'C2' }, trigger: trigger.ok, cost: 8.545 });
  console.log(`  触发：${trigger.ok ? '成立' : '不成立'}（${trigger.why}，量比 ${trigger.volRatio?.toFixed(2)}）`);
  console.log(`  四条件：边缘 ${plan.four.edge} / 位置 ${plan.four.pos} / 触发 ${plan.four.trigger} / 盈亏比 ${plan.four.ratio}  未过 ${JSON.stringify(plan.addWhy)}`);
  console.log(`  加仓位 ${plan.addZone ?? 'null'}  盈亏比 ${plan.ratio ?? '—'}`);
  const ex = exitPlan({ levels: lv, cost: 8.545, ma10: ind.ma.ma10, ma20: ind.ma.ma20 });
  console.log(`  卖出：止损 ${ex.stop}（${ex.stopNote}）  目标一 ${ex.target1}  目标二 ${ex.target2}`);

  check('支撑低于现价、压力高于现价',
    lv.support.every((x) => x.price < ind.close) && lv.resistance.every((x) => x.price > ind.close));
  check('20 期低点落在现价下方', lv.items.find((x) => x.id === 'S.lo20').price < ind.close);
  check('四条件的四项都是布尔', ['edge', 'pos', 'trigger', 'ratio'].every((k) => typeof plan.four[k] === 'boolean'));
  check('没通过的条件都写进了 addWhy', plan.addWhy.every((k) => plan.four[k] === false), JSON.stringify(plan.addWhy));
  check('未通过时有明确原因文本', Object.values(plan.detail).every((d) => typeof d.note === 'string' && d.note.length > 0));
  check('阈值常量没被改', MIN_DISTANCE_ATR === 1 && MIN_RATIO === 2);
} catch (err) {
  console.log(`  SKIP  取不到真实数据（${err.message}）`);
}

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
