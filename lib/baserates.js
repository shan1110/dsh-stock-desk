/**
 * 历史条件频率（宿主侧，纯函数，不发请求）
 *
 * 这一层回答的是「这只票上，某个形态命中之后 h 期涨跌的历史分布」。
 * 它不预测未来，只把过去同样形状的那些时点找出来数一遍。
 *
 * 四条纪律写进了代码，不靠调用方自觉：
 * 1. 样本必须非重叠（§2.5 第 1 条）。连续 15 个交易日贴在 MA20 附近，事件只有 1 个，
 *    按天算会数出 11 个 5 日样本 —— 结论会从「没信号」翻成「33% 必跌」。
 *    所以命中点之间必须间隔 ≥ h 期，用一个贪心前扫实现。
 * 2. 必须给基准，而且基准与条件用同一段样本。两者样本不同时，比的不是同一批日子，
 *    差出来的 pp 就掺了窗口差异，不能算边缘。
 * 3. 条件事先定死（C1..C4），运行时不搜索、不挑最好看的。
 * 4. 样本量分三档：n ≥ 30 给百分比 + 区间；15 ≤ n < 30 给百分比但标小样本；
 *    n < 15 只说样本不足，不给百分比。
 *
 * 关于「上一段窗口」：周线 514 根覆盖 11.8 年，但这家公司 2023 年换过控股股东（推测）。
 * 所以同一套算法在「全历史」和「近 N 年」各跑一遍，两份并列，不做二选一 ——
 * 两边矛盾时由调用方按 §2.6 显示「口径相反」，不许挑一个支持自己的说法。
 *
 * @author cai shan
 * @date 2026-10-20 16:10
 */

/** 四个事先定死的条件。改这里等于改实验设计，必须同步改文档 §2.2 */
export const CONDITIONS = [
  {
    id: 'C1',
    name: '放量突破',
    rule: '收盘 > MA20，量 > 1.5×前 5 期均量，当期涨幅 > 2%',
    verify: (bar, ctx) => bar.close > ctx.ma20 && ctx.volRatio > 1.5 && ctx.chgPct > 2,
  },
  {
    id: 'C2',
    name: '缩量回踩',
    rule: '收盘在 MA20 ±2% 内，量 < 0.8×前 5 期均量',
    verify: (bar, ctx) => Math.abs((bar.close - ctx.ma20) / ctx.ma20) <= 0.02 && ctx.volRatio < 0.8,
  },
  {
    id: 'C3',
    name: '跌破 MA20',
    rule: '前一期收盘还在 MA20 上方，当期跌破',
    verify: (bar, ctx) => ctx.prevClose > ctx.prevMa20 && bar.close < ctx.ma20,
  },
  {
    id: 'C4',
    name: '超跌',
    rule: '日线：20 日跌幅 > 15%；周线：20 周跌幅 > 20%',
    verify: (bar, ctx) => ctx.chg20 < (ctx.period === 'week' ? -20 : -15),
  },
];

/** 每个周期看几个持有期。与文档 §2.2 的两张表一致 */
export const HORIZONS = { day: [1, 3, 5, 10], week: [1, 4, 8], month: [] };

/** MA20 预热：条件要 MA20，基准要用同一批起点，所以两边都从第 21 根（下标 20）开始 */
const MA_WARMUP = 20;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Wilson 比例置信区间。
 *
 * 为什么不用正态近似：n=8 时正态近似会算出负数下界，而二项比例不可能小于 0。
 * 小样本恰恰是最需要区间的场合（本仓库大量 n 在 8~30），所以这里必须用 score interval。
 *
 * @returns {[number, number]} 百分比下界与上界
 */
export function wilson(up, n, z = 1.96) {
  if (!(n > 0)) return null;
  const p = up / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, (center - half) * 100), Math.min(100, (center + half) * 100)];
}

/** 分位数（线性插值）。空数组返回 null */
export function quantile(arr, q) {
  const v = arr.filter(isNum).slice().sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0];
  const pos = ((v.length - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

/** 样本量三档，写成可判定的函数，界面与提示词都读它 */
export function tier(n) {
  if (!(n > 0)) return 'none';
  if (n >= 30) return 'full';
  if (n >= 15) return 'small';
  return 'insufficient';
}

/**
 * 逐根算出条件判定要用的上下文（MA20、量比、当期涨幅、20 期涨跌幅）。
 * 一次算完，避免每个条件各扫一遍。
 */
export function buildContext(candles, period = 'day') {
  const n = candles.length;
  const ma20 = new Array(n).fill(null);
  const volRatio = new Array(n).fill(null);
  const chgPct = new Array(n).fill(null);
  const chg20 = new Array(n).fill(null);

  let maSum = 0;
  let maBad = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i].close;
    if (isNum(c)) maSum += c; else maBad++;
    if (i >= 20) {
      const dropped = candles[i - 20].close;
      if (isNum(dropped)) maSum -= dropped; else maBad--;
    }
    if (i >= 19) ma20[i] = maBad === 0 ? maSum / 20 : null;
  }

  for (let i = 0; i < n; i++) {
    // 量比：当期量 ÷ 前 5 期均量。i<5 时无定义
    if (i >= 5) {
      let s = 0;
      let bad = false;
      for (let k = i - 5; k < i; k++) {
        if (!isNum(candles[k].volume)) { bad = true; break; }
        s += candles[k].volume;
      }
      const avg = bad ? null : s / 5;
      if (isNum(avg) && avg > 0 && isNum(candles[i].volume)) volRatio[i] = candles[i].volume / avg;
    }
    const prev = i > 0 ? candles[i - 1].close : null;
    if (isNum(prev) && prev > 0 && isNum(candles[i].close)) {
      chgPct[i] = ((candles[i].close - prev) / prev) * 100;
    }
    if (i >= 20) {
      const base = candles[i - 20].close;
      if (isNum(base) && base > 0 && isNum(candles[i].close)) {
        chg20[i] = ((candles[i].close - base) / base) * 100;
      }
    }
  }

  return { period, ma20, volRatio, chgPct, chg20 };
}

/** 某一根是否命中某条件；上下文缺失（未预热/停牌）一律算不命中，不猜 */
export function hitsAt(candles, ctx, condId, i) {
  const cond = CONDITIONS.find((c) => c.id === condId);
  if (!cond || i < 1 || i >= candles.length) return false;
  const bar = candles[i];
  const c = {
    period: ctx.period,
    ma20: ctx.ma20[i],
    prevMa20: ctx.ma20[i - 1],
    prevClose: candles[i - 1].close,
    volRatio: ctx.volRatio[i],
    chgPct: ctx.chgPct[i],
    chg20: ctx.chg20[i],
  };
  if (!isNum(c.ma20) || !isNum(bar.close)) return false;
  // 量比与 20 期涨跌幅缺失时，对应条件判不命中（而不是把缺失当 0 通过）
  if (condId === 'C1' && (!isNum(c.volRatio) || !isNum(c.chgPct))) return false;
  if (condId === 'C2' && !isNum(c.volRatio)) return false;
  if (condId === 'C3' && (!isNum(c.prevMa20) || !isNum(c.prevClose))) return false;
  if (condId === 'C4' && !isNum(c.chg20)) return false;
  return cond.verify(bar, c);
}

/**
 * 非重叠抽样：从前往后扫，接受了第 i 个点之后，下个候选必须 ≥ i+h。
 *
 * 为什么是贪心而不是「按 h 分块取第一个命中」：分块会把恰好跨块边界的命中丢掉，
 * 结果随起点平移而变。贪心是确定性的，且与「真实独立事件数」的直觉一致。
 *
 * @param {Array<boolean>} hits 逐根命中标记
 * @param {number} h 持有期
 * @param {number} from 从哪根开始
 * @returns {number[]} 被接受的命中下标
 */
export function nonOverlap(hits, h, from = 0) {
  const out = [];
  let last = -Infinity;
  for (let i = from; i < hits.length; i++) {
    if (!hits[i]) continue;
    if (i - last < h) continue;
    out.push(i);
    last = i;
  }
  return out;
}

/** 单期涨跌幅（百分比），i+h 越界返回 null */
export function forwardReturn(candles, i, h) {
  const a = candles[i]?.close;
  const b = candles[i + h]?.close;
  if (!isNum(a) || !isNum(b) || a <= 0) return null;
  return ((b - a) / a) * 100;
}

/**
 * 给定一批下标，统计持有 h 期的表现。
 *
 * 返回 up / n / 百分比 / 区间 / 中位 / p10~p90 / 明细。n 是被接受样本数，
 * 「候补次数」是命中但被重叠规则挡掉的次数 —— 两者一起才能说明重叠有多严重。
 */
export function summarize(candles, idxs, h) {
  const rets = [];
  for (const i of idxs) {
    const r = forwardReturn(candles, i, h);
    if (isNum(r)) rets.push(r);
  }
  const n = rets.length;
  if (n === 0) {
    return { n: 0, up: 0, upPct: null, ci: null, median: null, p10: null, p90: null, returns: [] };
  }
  const up = rets.filter((r) => r > 0).length;
  return {
    n,
    up,
    upPct: (up / n) * 100,
    ci: wilson(up, n),
    median: quantile(rets, 50),
    p10: quantile(rets, 10),
    p90: quantile(rets, 90),
    returns: rets,
  };
}

/**
 * 基准：任意一根都算样本，同样按 h 非重叠抽样。
 *
 * **这里有一个必须说清的口径问题：非重叠抽样是「系统抽样」，它挑中哪一天取决于起点。**
 * 实测 sz002739 日线 10 日口径：起点取第 1 根时上涨占比 38%，起点往后挪一根就变成 45% ——
 * 同一段数据、同一个公式，差 7 个百分点。原因是 10 日窗口彼此高度自相关，
 * 换一组抽样格子等于换了一批日子。
 *
 * 所以基准不能只报一个数：从 MA_WARMUP 起，把 h 个相位各跑一遍，报**均值**与**相位区间**。
 * 相位区间的宽度就是这套统计的噪声地板 —— 比它小的 pp 差值不值得拿来说事。
 *
 * 起点仍与条件对齐（都从 MA20 预热之后），否则两者比的不是同一段日子。
 */
export function baselineStat(candles, h, period = 'day') {
  const flags = new Array(candles.length).fill(true);
  const phases = [];
  for (let p = 0; p < h; p++) {
    const idxs = nonOverlap(flags, h, MA_WARMUP + p);
    const s = summarize(candles, idxs, h);
    if (s.n > 0) phases.push(s);
  }
  if (phases.length === 0) {
    return { n: 0, up: 0, upPct: null, ci: null, median: null, p10: null, p90: null, returns: [], phaseRange: null, phaseSpread: null };
  }
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const upPct = mean(phases.map((s) => s.upPct));
  const n = Math.round(mean(phases.map((s) => s.n)));
  const lo = Math.round(Math.min(...phases.map((s) => s.upPct)));
  const hi = Math.round(Math.max(...phases.map((s) => s.upPct)));
  return {
    n,
    up: Math.round((upPct * n) / 100),
    upPct,
    // 区间按均值比例算：相位之间不是独立样本，不能把它们合并起来加大 n
    ci: wilson(Math.round((upPct * n) / 100), n),
    median: phases[0].median,
    p10: phases[0].p10,
    p90: phases[0].p90,
    returns: phases[0].returns,
    phaseRange: [lo, hi],
    phaseSpread: hi - lo,
    phases: phases.length,
  };
}

/**
 * 单个条件在某周期上的统计。
 *
 * @returns {{n, up, upPct, ci, median, p10, p90, candidates, hitBars}}
 */
export function conditionStat(candles, ctx, condId, h) {
  const hits = new Array(candles.length).fill(false);
  let hitBars = 0;
  for (let i = MA_WARMUP; i < candles.length; i++) {
    if (hitsAt(candles, ctx, condId, i)) { hits[i] = true; hitBars++; }
  }
  const idxs = nonOverlap(hits, h, MA_WARMUP);
  const s = summarize(candles, idxs, h);
  s.candidates = idxs.length;
  s.hitBars = hitBars;
  return s;
}

/**
 * 边缘判定：区间与基准比。
 *
 * **基准本身有不确定性**（§baselineStat 的相位漂移），所以不能只跟一个均值比 ——
 * 那只比了「基准的运气好一点的那种切法」。这里的口径是：条件的区间必须整个落在
 * 基准的**相位区间之外**才算边缘：
 * - 'pos'（正）：区间下沿 > 基准相位区间的上沿
 * - 'neg'（负）：区间上沿 < 基准相位区间的下沿
 * - 'none'（无信号）：两者有重叠，统计上分不开
 *
 * 这个口径比「跟均值比」严，也更诚实：实测 C4 4 周那个 +23pp，区间下沿 47% 只比
 * 基准最不利相位（46%）高 1pp —— 所以文档里写「有迹象」，不写「确定」。
 *
 * n < 15 或区间算不出来时返回 'unknown'，调用方只能说「样本不足」。
 */
export function judge(stat, base) {
  if (!stat || !base || !stat.ci) return 'unknown';
  if (stat.n < 15) return 'unknown';
  const range = base.phaseRange;
  const lo = Array.isArray(range) ? range[0] : base.upPct;
  const hi = Array.isArray(range) ? range[1] : base.upPct;
  if (!isNum(lo) || !isNum(hi)) return 'unknown';
  if (stat.ci[0] > hi) return 'pos';
  if (stat.ci[1] < lo) return 'neg';
  return 'none';
}

/**
 * 完整的一张表：两个周期、每个条件、每个持有期，外加基准。
 *
 * @param {object} input { day, week } 两个周期的 K 线数组
 * @param {object} [opts] { eraBars = 172 }「近 N 年」按周线根数算，172 周 ≈ 3.3 年
 * @returns {object} { rows, base, meta }
 */
export function buildTable(input, opts = {}) {
  const eraBars = opts.eraBars ?? 172;
  const rows = [];
  const base = {};

  const push = (period, era, label, condId, h, stat, baseStat) => {
    const unit = period === 'week' ? 'w' : 'd';
    const id = era ? `${condId}.${h}${unit}.${era}` : `${condId}.${h}${unit}`;
    const t = tier(stat.n);
    rows.push({
      id,
      period,
      era: era ?? null,
      eraLabel: label,
      cond: condId,
      horizon: h,
      ...stat,
      base: baseStat ? baseStat.upPct : null,
      deltaPp: baseStat && isNum(stat.upPct) && isNum(baseStat.upPct)
        ? stat.upPct - baseStat.upPct : null,
      tier: t,
      judge: judge(stat, baseStat),
      baseN: baseStat ? baseStat.n : null,
      // 噪声地板：基准自己在不同抽样相位下的漂移幅度。
      // marginPp 是「条件区间下沿 - 基准最不利相位」，为正才算真的越过噪声
      noisePp: baseStat ? baseStat.phaseSpread : null,
      marginPp: stat.ci && baseStat && baseStat.phaseRange
        ? stat.ci[0] - baseStat.phaseRange[1] : null,
    });
  };

  for (const period of ['day', 'week']) {
    const candles = input[period];
    if (!Array.isArray(candles) || candles.length < MA_WARMUP + 2) continue;
    const horizons = HORIZONS[period] ?? [];
    const ctx = buildContext(candles, period);

    // 周线做口径切分（11.8 年里跨过一次易主）；日线本身只有 3.3 年，切了也是同一段
    const eras = [];
    const all = { id: null, label: '全历史', candles };
    if (period === 'week' && candles.length > eraBars * 1.3) {
      eras.push({ id: 'A', label: `全历史 ${(candles.length / 52).toFixed(1)} 年`, candles });
      eras.push({ id: 'B', label: `近 ${(eraBars / 52).toFixed(1)} 年`, candles: candles.slice(-eraBars) });
    } else {
      eras.push(all);
    }

    for (const era of eras) {
      const cs = era.candles;
      const ec = buildContext(cs, period);
      for (const h of horizons) {
        const b = baselineStat(cs, h, period);
        const bid = era.id ? `BASE.${h}${period === 'week' ? 'w' : 'd'}.${era.id}` : `BASE.${h}${period === 'week' ? 'w' : 'd'}`;
        base[bid] = {
          id: bid, period, era: era.id, eraLabel: era.label, horizon: h, ...b,
          tier: tier(b.n), judge: 'base',
        };
        for (const cond of CONDITIONS) {
          const stat = conditionStat(cs, ec, cond.id, h);
          push(period, era.id, era.label, cond.id, h, stat, b);
        }
      }
    }
  }

  return {
    rows,
    base,
    meta: {
      eraBars,
      maWarmup: MA_WARMUP,
      conditions: CONDITIONS.map((c) => ({ id: c.id, name: c.name, rule: c.rule })),
      // 4 个条件 × 3 个持有期（周线）+ 日线，是多重检验的基数；调用方要据此给「有迹象」而不是「确定」
      tests: rows.length,
    },
  };
}

/** 最后一根命中了哪些条件（今天的信号） */
export function todayHits(candles, period = 'day') {
  if (!Array.isArray(candles) || candles.length < MA_WARMUP + 2) return [];
  const ctx = buildContext(candles, period);
  const i = candles.length - 1;
  return CONDITIONS.filter((c) => hitsAt(candles, ctx, c.id, i)).map((c) => c.id);
}

/** 条件的中文名 */
export function condName(id) {
  return CONDITIONS.find((c) => c.id === id)?.name ?? id;
}

/**
 * 口径是否矛盾：同一个条件在两个口径下都判定成立，但方向相反。
 *
 * 这是 §2.6 那条「不许挑好看的」的实现。调用方看到矛盾必须显示「两口径相反」，
 * 不得自己挑一个 —— 所以判定放在这里，不放在渲染层。
 */
export function isContradictory(rows) {
  const byCond = new Map();
  for (const r of rows) {
    if (!r.era) continue;
    const key = `${r.cond}.${r.horizon}`;
    if (!byCond.has(key)) byCond.set(key, {});
    byCond.get(key)[r.era] = r.judge;
  }
  const out = [];
  for (const [key, v] of byCond) {
    if (v.A && v.B && v.A !== v.B && (v.A === 'pos' || v.A === 'neg') && (v.B === 'pos' || v.B === 'neg')) {
      out.push({ key, A: v.A, B: v.B });
    }
  }
  return out;
}
