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
import { buildLevels, addPlan, exitPlan, triggerToday } from './levels.js';

/** 剥掉只有统计内部才需要的明细数组 */
function slim(s) {
  if (!s || typeof s !== 'object') return s;
  const { returns, phases, ...rest } = s;
  return rest;
}

/** 至少多少根日线才够做形态统计：MA20 预热 21 根 + 一个持有期 */
export const MIN_BARS = 30;

/**
 * @param {object} deps { market, store }
 * @param {string} code 股票代码
 * @param {object} [opts] { signal }
 * @returns {Promise<{ok: true, data: object}|{ok: false, error: string}>}
 */
export async function collectAnalysis({ market, store }, code, opts = {}) {
  const { signal } = opts;
  const [dkl, wkl] = await Promise.all([
    market.kline(code, { period: 'day', limit: 800, signal }),
    market.kline(code, { period: 'week', limit: 800, signal }),
  ]);
  const day = dkl?.candles ?? [];
  const week = wkl?.candles ?? [];
  if (day.length < MIN_BARS) {
    return { ok: false, error: `${dkl?.name || code} 的日线只有 ${day.length} 根，不够做形态统计（至少要 ${MIN_BARS} 根）。` };
  }

  // 持仓成本只用来给参考位；取不到就留空，不拿一个默认值顶替
  let cost = null;
  try {
    const cfg = await store.load();
    const c = cfg?.positions?.[code]?.cost;
    cost = Number.isFinite(c) && c > 0 ? c : null;
  } catch { cost = null; }

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
  const exit = exitPlan({ levels, cost, ma10: ind.ma.ma10, ma20: ind.ma.ma20 });

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
      meta: table.meta,
    },
  };
}
