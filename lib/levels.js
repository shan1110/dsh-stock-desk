/**
 * 位置表与「能不能加仓」的四条件（宿主侧，纯函数）
 *
 * 这一层只回答「价位在哪里、这些价位够不够格」，不回答「该不该买」。
 * 按设计 §4.2，四条同时成立才有加仓位，任何一条不成立就返回 null ——
 * 如果强迫它必须给一个位置，它一定会编一个，这是整个功能最容易做歪的地方。
 *
 * 三条实现上的取舍：
 * 1. 所有位置都带 id（S.lo20、R.ma60…），输出给前端与模型时只传 id，价格由渲染层填。
 *    这样即使模型胡写，也写不出一个不存在的价格。
 * 2. 成交密集带的分箱宽度随价格与波动自适应，不用固定 0.1 元 ——
 *    0.1 元对 8 元的股票是 1.2%，对 1300 元的股票是 0.008%，同一个参数不是同一件事。
 * 3. 盈亏比的止损取「加仓位下方最近的那个位置」，没有就用加仓位减 1 个 ATR。
 *    不允许把止损设成「成本价」，那是心理价位不是技术价位。
 *
 * @author cai shan
 * @date 2026-10-20 17:05
 */

import { sma, atr as atrOf, recentLow, recentHigh } from './indicators.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** 位置在现价下方多少算「够远」：一个 ATR。太近了赚的钱不够手续费与滑点 */
export const MIN_DISTANCE_ATR = 1;

/** 加仓要求的盈亏比下限 */
export const MIN_RATIO = 2;

/**
 * 成交密集带：近 lookback 根的成交量按价格分箱，找量最大的那一档。
 *
 * 分批宽度 = max(ATR/3, 现价 × 0.2%)。下限 0.2% 是为了防止低价股出现空箱，
 * 上限由 ATR 保证「一档大致是一天正常波动的三分之一」。
 *
 * @returns {{price: number, share: number, from: number, to: number}|null}
 */
export function volumeBand(candles, { lookback = 60, close = null, atr = null } = {}) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const seg = candles.slice(-lookback);
  const c = isNum(close) ? close : seg[seg.length - 1]?.close;
  if (!isNum(c) || c <= 0) return null;
  const width = Math.max(isNum(atr) && atr > 0 ? atr / 3 : 0, c * 0.002);
  if (!(width > 0)) return null;

  const bins = new Map();
  let total = 0;
  for (const k of seg) {
    const vol = k?.volume;
    const low = k?.low;
    const high = k?.high;
    if (!isNum(vol) || !(vol > 0) || !isNum(low) || !isNum(high)) continue;
    // 用每根的量价中点归箱：一根 K 只投一次票，避免大振幅日被重复计入
    const mid = (low + high) / 2;
    const key = Math.round(mid / width);
    bins.set(key, (bins.get(key) ?? 0) + vol);
    total += vol;
  }
  if (bins.size === 0 || total <= 0) return null;

  let bestKey = null;
  let bestVal = -1;
  for (const [key, val] of bins) {
    if (val > bestVal) { bestVal = val; bestKey = key; }
  }
  const price = bestKey * width;
  return {
    price: round2(price),
    share: bestVal / total,
    from: round2(price - width / 2),
    to: round2(price + width / 2),
    width: round2(width),
    lookback: seg.length,
  };
}

/**
 * 位置候选池（§4.1）。
 *
 * 每个位置都带 side：低于现价是支撑，高于现价是压力。同一个均线在不同价位
 * 会换边，所以 side 必须按现价现算，不能在定义里写死。
 *
 * @param {object} input { candles, close, cost }
 * @returns {{items: Array, support: Array, resistance: Array}}
 */
export function buildLevels({ candles, close, cost = null } = {}) {
  if (!Array.isArray(candles) || candles.length === 0) return { items: [], support: [], resistance: [] };
  const c = isNum(close) ? close : candles[candles.length - 1]?.close;
  if (!isNum(c) || c <= 0) return { items: [], support: [], resistance: [] };

  const atr = atrOf(candles);
  const items = [];
  const add = (id, price, note) => {
    if (!isNum(price) || price <= 0) return;
    items.push({
      id,
      price: round2(price),
      side: price < c ? 'support' : price > c ? 'resistance' : 'at',
      distPct: ((price - c) / c) * 100,
      distAtr: isNum(atr) && atr > 0 ? (price - c) / atr : null,
      note,
    });
  };
  // 均线与成交密集带会随现价换边，id 前缀也跟着换 —— 否则会出现 S.ma60 标着 resistance
  // 这种自相矛盾的条目，还会和 R.ma60 变成同一价位上的两条记录。
  const addSide = (base, price, note) => {
    if (!isNum(price) || price <= 0) return;
    add((price < c ? 'S.' : 'R.') + base, price, note);
  };

  add('S.lo20', recentLow(candles, 20), '20 期最低');
  add('S.lo60', recentLow(candles, 60), '60 期最低');
  addSide('ma60', sma(candles, 60), 'MA60');
  addSide('ma20', sma(candles, 20), 'MA20');
  add('R.hi60', recentHigh(candles, 60), '60 期最高');
  // ATR 通道：现价减 1 个 / 2 个 ATR。它们是「按波动算出来的心理位」，不是历史价
  if (isNum(atr)) {
    add('S.atr1', c - atr, '1 倍 ATR 通道');
    add('S.atr2', c - 2 * atr, '2 倍 ATR 通道');
  }
  // 成交密集带：在现价下方是支撑，上方是压力
  const band = volumeBand(candles, { close: c, atr });
  if (band) addSide('vp', band.price, `成交密集带 ${band.from}~${band.to}`);
  // 持仓成本只作为参考位，不参与「够不够远」的判定 —— 成本是你自己的数，不是市场的数
  if (isNum(cost) && cost > 0) {
    items.push({
      id: 'P.cost',
      price: round2(cost),
      side: cost < c ? 'support' : cost > c ? 'resistance' : 'at',
      distPct: ((cost - c) / c) * 100,
      distAtr: isNum(atr) && atr > 0 ? (cost - c) / atr : null,
      note: '你的成本',
      personal: true,
    });
  }

  const support = items.filter((x) => x.side === 'support' && !x.personal).sort((a, b) => b.price - a.price);
  const resistance = items.filter((x) => x.side === 'resistance' && !x.personal).sort((a, b) => a.price - b.price);
  return { items, support, resistance, close: c, atr };
}

/**
 * 四条件判定（§4.2）。
 *
 * 顺序有讲究：**先判边缘，再判位置**。位置对、形态错是最常见的亏钱路径 ——
 * 支撑位到处都有，但「在这只票的这个形态上」历史上并不赚钱。
 *
 * @param {object} input
 *   levels    buildLevels() 的返回
 *   edge      { judge: 'pos'|'neg'|'none'|'unknown', condId, row } 当前命中形态的边缘
 *   trigger   布尔，今天的触发条件是否成立（由调用方按时段判定后传入）
 *   cost      持仓成本
 * @returns {object} { addZone, stop, target, ratio, four, addWhy, ok }
 */
export function addPlan({ levels, edge, trigger = false, cost = null } = {}) {
  const close = levels?.close;
  const atr = levels?.atr;
  const support = levels?.support ?? [];
  const resistance = levels?.resistance ?? [];
  const four = { edge: false, pos: false, trigger: false, ratio: false };
  const addWhy = [];
  const detail = {};

  // 1. 形态有正边缘
  four.edge = edge?.judge === 'pos';
  detail.edge = {
    judge: edge?.judge ?? 'unknown',
    condId: edge?.condId ?? null,
    note: four.edge ? '这个形态在历史上显著好于基准' : edgeNote(edge?.judge),
  };
  if (!four.edge) addWhy.push('edge');

  // 2. 位置在下方且至少 1 个 ATR
  const need = isNum(atr) ? MIN_DISTANCE_ATR * atr : null;
  const candidate = isNum(need)
    ? support.find((x) => close - x.price >= need)
    : null;
  four.pos = Boolean(candidate);
  detail.pos = candidate
    ? { id: candidate.id, price: candidate.price, distAtr: candidate.distAtr, distPct: candidate.distPct, note: `${candidate.id} ${candidate.price}，距现价 ${candidate.distPct.toFixed(2)}%（${candidate.distAtr.toFixed(1)} 倍 ATR）` }
    : { need: need === null ? null : round2(need), note: isNum(need) ? '还没有跌到任何一个够远的支撑位' : 'ATR 算不出来，无法判断距离' };
  if (!four.pos) addWhy.push('pos');

  // 3. 有触发，不是挂死单
  four.trigger = Boolean(trigger);
  detail.trigger = { ok: four.trigger, note: four.trigger ? '今天的触发条件成立' : '今天没有触发（只是到了一个价位）' };
  if (!four.trigger) addWhy.push('trigger');

  // 4. 盈亏比 ≥ 2:1
  const target = resistance[0] ?? null;
  const below = candidate
    ? support.find((x) => x.price < candidate.price)
    : null;
  const stopPrice = candidate
    ? (below ? below.price : candidate.price - (isNum(atr) ? atr : candidate.price * 0.03))
    : null;
  let ratio = null;
  if (candidate && target && isNum(stopPrice) && candidate.price > stopPrice) {
    ratio = (target.price - candidate.price) / (candidate.price - stopPrice);
  }
  four.ratio = isNum(ratio) && ratio >= MIN_RATIO;
  detail.ratio = {
    value: isNum(ratio) ? Math.round(ratio * 100) / 100 : null,
    need: MIN_RATIO,
    targetId: target?.id ?? null,
    stopId: below?.id ?? (candidate ? 'ATR 缓冲' : null),
    note: isNum(ratio) ? (four.ratio ? '达到门槛' : `只有 ${Math.round(ratio * 100) / 100} 倍，不到 ${MIN_RATIO}:1`) : '缺少上方压力位或止损位，算不出来',
  };
  if (!four.ratio) addWhy.push('ratio');

  const ok = four.edge && four.pos && four.trigger && four.ratio;
  return {
    ok,
    addZone: ok ? candidate.price : null,
    addZoneId: ok ? candidate.id : null,
    stop: ok ? round2(stopPrice) : null,
    stopId: ok ? (below?.id ?? null) : null,
    target: ok ? target.price : null,
    targetId: ok ? target.id : null,
    ratio: isNum(ratio) ? Math.round(ratio * 100) / 100 : null,
    four,
    detail,
    addWhy,
    // 不成立时也要把「如果成立会是哪个价位」说清楚，用户要看到的是判断过程而不是一个空
    rejected: ok ? null : (candidate ? { id: candidate.id, price: candidate.price } : null),
    cost: isNum(cost) ? round2(cost) : null,
  };
}

function edgeNote(judge) {
  switch (judge) {
    case 'neg': return '这个形态在历史上显著差于基准，不该在它身上加仓';
    case 'none': return '区间跨过基准，这个形态跟随便哪天买分不开';
    case 'unknown': return '样本不足，给不出方向';
    default: return '没有命中的形态';
  }
}

/**
 * 卖出三档（§4.3）。
 *
 * 止损取「20 期低点」与「成本价下浮 5%」里更靠上的那个，再留一个 ATR 的缓冲：
 * 先被破的那个才是有意义的止损，设得比它还低等于没设。
 * 止盈分两级，第二级用 60 期最高 —— 不给「目标价 10 元」这种没有依据的数。
 */
export function exitPlan({ levels, cost = null, ma10 = null, ma20 = null } = {}) {
  const close = levels?.close;
  const atr = levels?.atr;
  const items = levels?.items ?? [];
  const find = (id) => items.find((x) => x.id === id) ?? null;

  const lo20 = find('S.lo20');
  const hi60 = find('R.hi60');
  const ma60 = find('S.ma60') ?? find('R.ma60');

  const candidates = [];
  if (lo20) candidates.push({ id: 'S.lo20', price: lo20.price });
  if (isNum(cost) && cost > 0) candidates.push({ id: 'cost×0.95', price: cost * 0.95 });
  // 取更靠上的那个：先被破的才是真止损
  candidates.sort((a, b) => b.price - a.price);
  const base = candidates[0] ?? null;
  const stop = base && isNum(atr) ? round2(base.price - atr) : null;

  return {
    stop: stop,
    stopId: base?.id ?? null,
    stopNote: stop && isNum(close) ? `距现价 ${((stop - close) / close * 100).toFixed(2)}%` : null,
    target1: ma60 ? ma60.price : null,
    target1Id: ma60?.id ?? null,
    target2: hi60 ? hi60.price : null,
    target2Id: hi60?.id ?? null,
    trail: isNum(ma10) && isNum(ma20)
      ? { ma10: round2(ma10), ma20: round2(ma20), rule: '收盘破 MA10 减半，破 MA20 清仓' }
      : null,
  };
}

/**
 * 今天有没有触发（§4.2 第 3 条）。
 *
 * 两种形态的触发条件不一样，不能共用一个：
 * - 回踩型（C2 缩量回踩）：要求「守住 + 继续缩量」，量放大说明是破位不是回踩
 * - 突破型（C1 放量突破）：要求「站回 MA20 + 放量」，没量的突破是假突破
 * C3/C4 不给触发条件 —— 它们本身是下跌形态，没有「可以进」的那一步。
 */
export function triggerToday({ candles, condId, ma20, atr }) {
  if (!Array.isArray(candles) || candles.length < 6) return { ok: false, why: '根数不足' };
  const i = candles.length - 1;
  const last = candles[i];
  const closes = candles.slice(i - 5, i).map((k) => k.close).filter(isNum);
  const vols = candles.slice(i - 5, i).map((k) => k.volume).filter(isNum);
  const avgVol = vols.length === 5 ? vols.reduce((a, b) => a + b, 0) / 5 : null;
  const volRatio = isNum(avgVol) && avgVol > 0 && isNum(last.volume) ? last.volume / avgVol : null;
  const prevClose = candles[i - 1]?.close;

  if (condId === 'C2') {
    const hold = isNum(prevClose) && isNum(last.close) ? last.close >= prevClose : false;
    const shrink = isNum(volRatio) ? volRatio < 0.8 : false;
    return {
      ok: hold && shrink,
      why: hold && shrink ? '守住且继续缩量' : !hold ? '没有守住（收盘低于前一期）' : '量没有缩小',
      volRatio,
    };
  }
  if (condId === 'C1') {
    const backAbove = isNum(ma20) && isNum(last.close) ? last.close > ma20 : false;
    const expand = isNum(volRatio) ? volRatio > 1.5 : false;
    return {
      ok: backAbove && expand,
      why: backAbove && expand ? '站回 MA20 且放量' : !backAbove ? '没收在 MA20 上方' : '量没有放大',
      volRatio,
    };
  }
  return { ok: false, why: `${condId} 是下跌形态，没有可进的触发条件` };
}
