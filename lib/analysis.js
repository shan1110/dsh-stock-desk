/**
 * 单股分析：把指标、历史频率、位置、四条件组装成一份结果
 *
 * 为什么单独一层：同一份结果有两个消费者 —— agent 工具（渲染成文本给模型）和
 * HTTP 接口（渲染成界面）。两边各写一遍组装逻辑，迟早会出现「工具说 C2 是负边缘、
 * 界面说它是无信号」这种自相矛盾，而用户无法判断该信哪个。
 *
 * 输出是纯 JSON 可序列化的：明细数组（returns / phases）在 slim 里被剥掉，
 * 因为一行的明细可能几百个数，40 行乘起来就是几十 KB，而界面一个都用不上。
 *
 * @author cai shan
 * @date 2026-10-20 16:20
 */

import { analyze } from './indicators.js';
import { buildTable, todayHits, HORIZONS } from './baserates.js';
import { buildLevels, addPlan, exitPlan, triggerToday, holdPlan } from './levels.js';

/** 剥掉只有统计内部才需要的明细数组 */
function slim(s) {
  if (!s || typeof s !== 'object') return s;
  const { returns, phases, ...rest } = s;
  return rest;
}

/** 至少多少根日线才够做形态统计：MA20 预热 21 根 + 一个持有期 */
export const MIN_BARS = 30;

/** 加仓要求的盈亏比，与 levels.js 的 MIN_RATIO 一致；这里另存一份是为了不改动 levels 的公开常量语义 */
const MIN_RATIO_FOR_UNLOCK = 2;

/**
 * @param {object} deps { market, store }
 * @param {string} code 股票代码
 * @param {object} [opts] { signal }
 * @returns {Promise<{ok: true, data: object}|{ok: false, error: string}>}
 */
export async function collectAnalysis({ market, store }, code, opts = {}) {
  const { signal } = opts;
  const [dkl, wkl, sess] = await Promise.all([
    market.kline(code, { period: 'day', limit: 800, signal }),
    market.kline(code, { period: 'week', limit: 800, signal }),
    market.session({ signal }).catch(() => null),
  ]);
  const day = dkl?.candles ?? [];
  const week = wkl?.candles ?? [];
  if (day.length < MIN_BARS) {
    return { ok: false, error: `${dkl?.name || code} 的日线只有 ${day.length} 根，不够做形态统计（至少要 ${MIN_BARS} 根）。` };
  }

  // 持仓成本只用来给参考位；取不到就留空，不拿一个默认值顶替。
  // 顺手把两个口径开关读出来 —— 它们会改变结论，所以必须能被看到、能被改。
  let cost = null;
  let settings = { trailMode: 'profit', stopBase: 'cost' };
  try {
    const cfg = await store.load();
    const c = cfg?.positions?.[code]?.cost;
    cost = Number.isFinite(c) && c > 0 ? c : null;
    if (cfg?.analysis) settings = { trailMode: cfg.analysis.trailMode, stopBase: cfg.analysis.stopBase };
  } catch { /* 用默认口径 */ }

  const ind = analyze(day);
  const table = buildTable({ day, week });
  const levels = buildLevels({ candles: day, close: ind.close, cost });

  const hits = { day: todayHits(day, 'day'), week: todayHits(week, 'week') };
  const primary = hits.day[0] ?? hits.week[0] ?? null;
  const primaryPeriod = hits.day.length ? 'day' : (hits.week.length ? 'week' : null);
  const h0 = primaryPeriod ? (HORIZONS[primaryPeriod] ?? [1])[0] : null;
  // 边缘取命中的那个条件在「最短持有期」上的那一格：持有期越长样本越少，
  // 而第 1 条问的只是「这个形态本身有没有优势」，不该用 8 周的稀疏样本去答。
  const edgeRow = primary
    ? table.rows.find((r) => r.cond === primary && r.period === primaryPeriod && r.horizon === h0
      && (primaryPeriod === 'week' ? r.era === 'A' : r.era === null))
    : null;
  const trigger = primary
    ? triggerToday({ candles: day, condId: primary, ma20: ind.ma.ma20, atr: ind.atr })
    : { ok: false, why: '今天没有命中任何形态' };

  const plan = addPlan({
    levels,
    edge: edgeRow ? { judge: edgeRow.judge, condId: primary, row: edgeRow } : { judge: 'unknown', condId: null },
    trigger: trigger.ok,
    cost,
  });
  const exit = exitPlan({ levels, cost, ma10: ind.ma.ma10, ma20: ind.ma.ma20, stopBase: settings.stopBase });
  const floatPct = Number.isFinite(cost) && cost > 0 && Number.isFinite(ind.close)
    ? ((ind.close - cost) / cost) * 100 : null;
  const hold = holdPlan({ levels, exit, cost, close: ind.close, floatPct, trailMode: settings.trailMode });

  /**
   * 「什么条件下才能加」：把每条没过的门槛翻成可观察的条件，并做一次反事实检查 ——
   * 补齐这一条之后，另外三条现在成不成立。
   *
   * 为什么需要反事实：只说「等形态变成放量突破」是不够的 —— 换过去之后可能盈亏比
   * 又不达标，用户白等。逐条算出来，才不会给一个单看成立、合起来无解的条件。
   */
  const unlock = plan.ok ? [] : plan.addWhy.map((gateId) => {
    if (gateId === 'edge') {
      // 四个形态里，哪个在「今天这种口径」下是正边缘？只报有依据的，没有就说没有
      const posConds = ['C1', 'C2', 'C3', 'C4'].filter((cid) => {
        const r = table.rows.find((x) => x.cond === cid && x.period === 'day' && x.horizon === (HORIZONS.day[0]) && x.era === null);
        return r?.judge === 'pos';
      });
      return {
        gate: gateId,
        need: 'day',
        candidates: posConds,
        note: posConds.length
          ? `日线口径下历史上是正边缘的形态：${posConds.join('、')}`
          : '日线口径下没有任何一个形态是正边缘，这条只能等，不能凑',
      };
    }
    if (gateId === 'pos') {
      const first = levels.support?.[0] ?? null;
      return {
        gate: gateId,
        need: first ? first.price : null,
        note: first ? `跌到 ${first.price}（${first.id}）以下，且距离现价超过 1 个 ATR` : '现价下方没有任何支撑位',
      };
    }
    if (gateId === 'trigger') {
      return {
        gate: gateId,
        need: 'close-and-volume',
        note: primary === 'C1' ? '收盘站回 MA20 且量放大到 1.5 倍以上' : '收盘守住且量缩到 0.8 倍以下',
      };
    }
    const r = plan.detail?.ratio;
    return {
      gate: gateId,
      need: MIN_RATIO_FOR_UNLOCK,
      note: Number.isFinite(r?.value)
        ? `现在是 ${r.value}:1，要到 ${MIN_RATIO_FOR_UNLOCK}:1（要么加仓位更低，要么上方阻力更高）`
        : `算不出来：缺少上方压力位或止损位`,
    };
  });

  return {
    ok: true,
    data: {
      code,
      name: dkl?.name || code,
      bars: day.length,
      from: day[0]?.date ?? null,
      to: day.at(-1)?.date ?? null,
      close: ind.close,
      ind,
      hits,
      primary,
      primaryPeriod,
      edgeRow: slim(edgeRow),
      trigger,
      // 不排序：Object 的字符串键按插入顺序遍历，正好是「1日 3日 5日 10日 周线 A…」的阅读顺序
      baselines: Object.values(table.base).map(slim),
      rows: table.rows.map(slim),
      levels: {
        items: levels.items,
        support: levels.support,
        resistance: levels.resistance,
        close: levels.close,
        atr: levels.atr,
      },
      plan,
      exit,
      hold,
      unlock,
      floatPct: floatPct === null ? null : Math.round(floatPct * 100) / 100,
      // 盘中：日线与周线的最新一根都还没走完。历史频率不受影响（最后一根没有未来收益，
      // 本来就不进统计），但「今天命中什么形态」和量比会失真 —— 量按已成交算，
      // 上午十点的 0.3 倍放到收盘可能是 1.5 倍。这个标记必须传下去，界面要据此提醒。
      session: sess ? { label: sess.label, trading: Boolean(sess.trading), origin: sess.origin ?? null } : null,
      partialDay: Boolean(sess?.trading),
      // 界面要显示「当前用的是哪套口径」，否则用户看到的结论取决于一个看不见的开关
      settings,
      meta: table.meta,
    },
  };
}
