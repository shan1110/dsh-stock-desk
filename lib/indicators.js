/**
 * 技术指标（宿主侧，纯函数，不发请求）
 *
 * 为什么单独一层：这些数以前只在 client.js 里算（K 线图描线用），浏览器里画得出来，
 * 宿主和 agent 工具却拿不到。分析要回答「现在是什么排列」「离均线多远」
 * 「这个位置在 250 日区间的百分之几」，都必须由代码算 —— 让模型看 12 根 K 线猜，
 * 猜出来的数字和真数字长得一模一样，事后分不出谁是谁。
 *
 * 两条贯穿全文的约定：
 * 1. 根数不够一律返回 null，不用更短的窗口凑。null 是「算不出来」，0 是「算出来等于 0」，
 *    这两件事在决策里差很远。
 * 2. 不修改入参。这里所有函数都是纯的，同一份 candles 反复算结果不变。
 *
 * @author cai shan
 * @date 2026-10-20 15:40
 */

/** 分析要用的均线周期；120 与 250 是「半年线」「年线」的中文语境对应 */
export const MA_PERIODS = [5, 10, 20, 60, 120, 250];

/** ATR 的周期。14 是 Wilder 的原始取值，也是绝大多数软件在用的口径 */
export const ATR_PERIOD = 14;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 取出某一根 K 线的字段，非数字当缺失 */
function fieldOf(k, field) {
  const v = k?.[field];
  return isNum(v) ? v : null;
}

/**
 * 简单移动平均：最后 n 根的均值。
 *
 * @param {Array<object>} candles K 线，按时间升序
 * @param {number} n 周期
 * @param {string} field 取哪个字段做平均，默认收盘价
 * @returns {number|null} 不足 n 根或有效值不足 n 个时返回 null
 */
export function sma(candles, n, field = 'close') {
  if (!Array.isArray(candles) || candles.length < n || n <= 0) return null;
  let sum = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const v = fieldOf(candles[i], field);
    if (v === null) return null;
    sum += v;
  }
  return sum / n;
}

/**
 * 整条均线序列，长度与入参一致，前 n-1 个是 null。
 *
 * 为什么不复用 sma() 循环调用：那样是 O(n·len)，而这里一次滑窗就够。
 * 序列本身留给画图与「均线拐头」这类后续判断。
 */
export function smaSeries(candles, n, field = 'close') {
  if (!Array.isArray(candles)) return [];
  const out = new Array(candles.length).fill(null);
  if (n <= 0 || candles.length < n) return out;
  let sum = 0;
  let bad = 0; // 窗口里缺失值的个数；缺失时整窗作废，而不是当成 0 拉低均值
  for (let i = 0; i < candles.length; i++) {
    const v = fieldOf(candles[i], field);
    if (v === null) bad++; else sum += v;
    if (i >= n) {
      const dropped = fieldOf(candles[i - n], field);
      if (dropped === null) bad--; else sum -= dropped;
    }
    if (i >= n - 1) out[i] = bad === 0 ? sum / n : null;
  }
  return out;
}

/**
 * 最近 n 根的真实波幅（True Range）序列。
 *
 * TR 取三个值里最大的那个，是为了处理跳空：只有 high-low 会漏掉「昨天收 10、今天开 8.5」
 * 这种不连续，而除权、涨停缺口在 A 股很常见。
 */
export function trueRangeSeries(candles) {
  if (!Array.isArray(candles)) return [];
  const out = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i];
    const high = fieldOf(k, 'high');
    const low = fieldOf(k, 'low');
    if (high === null || low === null) continue;
    const prevClose = i > 0 ? fieldOf(candles[i - 1], 'close') : null;
    const hl = high - low;
    if (prevClose === null) { out[i] = hl; continue; }
    out[i] = Math.max(hl, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return out;
}

/**
 * ATR：平均真实波幅，用 Wilder 的平滑（不是简单均值）。
 *
 * 为什么用 Wilder 而不是简单均值：简单均值会让 ATR 在「一次大阴线」之后立刻跳上去、
 * 又立刻掉回来，看不出波动率是在扩大还是收缩。Wilder 的递归平滑给新数据 1/14 的权重，
 * 恰好是主流软件的口径 —— 和用户在其他地方看到的 ATR 对得上，比「更先进」重要。
 *
 * @returns {number|null} 不足 ATR_PERIOD+1 根时返回 null
 */
export function atr(candles, period = ATR_PERIOD) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const tr = trueRangeSeries(candles);
  // 起算窗口里必须全有效，否则均值会被 NaN 污染，之后再平滑也回不来
  for (let i = 1; i <= period; i++) if (!isNum(tr[i])) return null;
  // 第一根 ATR 用前 period 个 TR 的简单均值，之后逐根平滑
  let acc = 0;
  for (let i = 1; i <= period; i++) acc += tr[i];
  let value = acc / period;
  for (let i = period + 1; i < tr.length; i++) {
    if (!isNum(tr[i])) continue;
    value = (value * (period - 1) + tr[i]) / period;
  }
  return value;
}

/**
 * 收盘价在最近 n 根区间里的位置，0 = 区间最低，100 = 区间最高。
 *
 * 这是「贵不贵」的相对说法：250 日区间的 11% 位置，意思是过去一年只有 11% 的时间
 * 比现在更便宜。区间上下沿取的是最高价与最低价，不是收盘价的极值 ——
 * 盘中插过的针也是真实成交过的价格，用收盘价会把区间算窄。
 */
export function positionInRange(candles, n) {
  if (!Array.isArray(candles) || candles.length < n || n <= 0) return null;
  const seg = candles.slice(-n);
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of seg) {
    const l = fieldOf(k, 'low');
    const h = fieldOf(k, 'high');
    if (l !== null && l < lo) lo = l;
    if (h !== null && h > hi) hi = h;
  }
  const close = fieldOf(seg[seg.length - 1], 'close');
  if (close === null || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  // 一字板：整段没有波动，位置无定义。返回 null 而不是硬塞 50，
  // 否则「今天一字涨停」会被讲成「区间中位」。
  if (hi - lo <= 0) return null;
  return ((close - lo) / (hi - lo)) * 100;
}

/** 最近 n 根的最低价（支撑位候选） */
export function recentLow(candles, n) {
  if (!Array.isArray(candles) || candles.length < n || n <= 0) return null;
  const vals = candles.slice(-n).map((k) => fieldOf(k, 'low')).filter(isNum);
  return vals.length ? Math.min(...vals) : null;
}

/** 最近 n 根的最高价（压力位候选） */
export function recentHigh(candles, n) {
  if (!Array.isArray(candles) || candles.length < n || n <= 0) return null;
  const vals = candles.slice(-n).map((k) => fieldOf(k, 'high')).filter(isNum);
  return vals.length ? Math.max(...vals) : null;
}

/**
 * 区间涨跌幅：最新收盘相对 n 根之前那根收盘的变化百分比。
 *
 * 分三种情况，因为「n 根之前的收盘」在边界上容易算错：
 * 取 candles[len-1-n].close 作为起点，意味着 n=5 量的是最近 5 个交易日的涨跌。
 */
export function returnsPct(candles, n) {
  if (!Array.isArray(candles) || candles.length < n + 1 || n < 0) return null;
  const base = fieldOf(candles[candles.length - 1 - n], 'close');
  const last = fieldOf(candles[candles.length - 1], 'close');
  if (base === null || last === null || base <= 0) return null;
  return ((last - base) / base) * 100;
}

/**
 * 量比的自算口径：最后一根的成交量 ÷ 之前 n 根的均量。
 *
 * 注意它和行情接口给的「量比」不是同一个数 —— 接口那个是按分钟折算到全天的，
 * 盘中就能用；这个只用已收盘的整根量，盘中和收盘后都稳。两个数都要给的时候
 * 必须标清是哪个，否则「量比 0.78」和「量比 0.60」会被当成同一个指标打架。
 */
export function volumeRatio(candles, n = 5) {
  if (!Array.isArray(candles) || candles.length < n + 1 || n <= 0) return null;
  const last = fieldOf(candles[candles.length - 1], 'volume');
  if (last === null) return null;
  let sum = 0;
  for (let i = candles.length - 1 - n; i < candles.length - 1; i++) {
    const v = fieldOf(candles[i], 'volume');
    if (v === null) return null;
    sum += v;
  }
  const avg = sum / n;
  if (!(avg > 0)) return null;
  return last / avg;
}

/**
 * 均线排列。
 *
 * 只用 5/10/20/60 四条判定，因为 120 与 250 在刚上市不久或数据不够的标的上经常是 null，
 * 一缺就永远判不出来。返回 'bull'（多头排练：短期在长期上方）、'bear'、'mixed'，
 * 任一条缺失返回 null。
 *
 * @param {Record<string, number|null>} ma 形如 { ma5, ma10, ma20, ma60 }
 */
export function maAlignment(ma) {
  const seq = [ma?.ma5, ma?.ma10, ma?.ma20, ma?.ma60];
  if (!seq.every(isNum)) return null;
  let desc = true; // 5 > 10 > 20 > 60，短期在上
  let asc = true; // 5 < 10 < 20 < 60，短期在下
  for (let i = 1; i < seq.length; i++) {
    if (!(seq[i - 1] > seq[i])) desc = false;
    if (!(seq[i - 1] < seq[i])) asc = false;
  }
  if (desc) return 'bull';
  if (asc) return 'bear';
  return 'mixed';
}

/**
 * 一次算齐分析要用的全部指标。
 *
 * 返回值里的每个键都可能是 null（样本不够），调用方必须自己判 null 再展示 ——
 * 这里是全库唯一「缺就是缺」的约定，不做任何补零或兜底。
 *
 * @param {Array<object>} candles 日/周/月 K 线，按时间升序
 * @returns {object|null} 空数组返回 null
 */
export function analyze(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const close = fieldOf(last, 'close');

  const ma = {};
  for (const n of MA_PERIODS) ma[`ma${n}`] = sma(candles, n);

  // 距均线：百分比，正数表示现价在均线上方。除零与时序缺失都返回 null
  const distMa = {};
  for (const n of MA_PERIODS) {
    const v = ma[`ma${n}`];
    distMa[`ma${n}`] = isNum(v) && isNum(close) && v > 0 ? ((close - v) / v) * 100 : null;
  }

  const atrValue = atr(candles);

  return {
    bars: candles.length,
    date: last?.date ?? null,
    close,
    ma,
    distMa,
    align: maAlignment(ma),
    atr: atrValue,
    atrPct: isNum(atrValue) && isNum(close) && close > 0 ? (atrValue / close) * 100 : null,
    volRatio5: volumeRatio(candles, 5),
    pos: {
      d60: positionInRange(candles, 60),
      d120: positionInRange(candles, 120),
      d250: positionInRange(candles, 250),
    },
    range: {
      low20: recentLow(candles, 20),
      low60: recentLow(candles, 60),
      high60: recentHigh(candles, 60),
    },
    returns: {
      d5: returnsPct(candles, 5),
      d20: returnsPct(candles, 20),
      d60: returnsPct(candles, 60),
      d120: returnsPct(candles, 120),
      d250: returnsPct(candles, 250),
    },
  };
}

/** 排列的中文说法；null 时说明为什么没有 */
export function alignLabel(align) {
  switch (align) {
    case 'bull': return '多头排列';
    case 'bear': return '空头排列';
    case 'mixed': return '均线纠缠';
    default: return '均线不足';
  }
}
