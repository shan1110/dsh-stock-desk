/**
 * 同花顺涨停池数据源（data.10jqka.com.cn/dataapi/limit_up）
 *
 * 为什么选它：涨跌停家数、炸板数、连板梯队、板块涨停分布全在这一个域下，
 * 免 cookie/token/签名，且 `limit_up_pool?page=1&limit=1` 一个请求就把
 * 涨停/跌停/炸板家数和交易状态全返回。
 *
 * 字段名全部实测确认，见 docs/数据源实测.md。
 *
 * @author cai shan
 * @date 2026-10-19 14:20
 */

import { withRetry, DEFAULT_TIMEOUT_MS, describeError } from './cache.js';

const BASE = 'https://data.10jqka.com.cn/dataapi/limit_up/';

const HEADERS = {
  Referer: 'https://data.10jqka.com.cn/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

/** 沪深默认只取主板/中小创，与行情软件默认口径一致 */
const DEFAULT_FILTER = 'HS,GEM2STAR';

/** 同花顺 market_id -> 代码前缀。17=沪市 33=深市；其余（如北交所）暂不映射，不猜 */
const MARKET_PREFIX = { 17: 'sh', 33: 'sz' };

const FIELD_LIMIT_UP = '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004';

/**
 * GET 一个同花顺 dataapi 路径并解 JSON。
 *
 * status_code 非 0 视为业务失败——接口用 HTTP 200 承载错误，只看状态码会漏判。
 */
async function get(path, params, signal) {
  const url = BASE + path + (params ? `?${new URLSearchParams(params)}` : '');
  return withRetry(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res;
      try {
        res = await fetch(url, { headers: HEADERS, signal: ctl.signal });
      } catch (err) {
        // 同腾讯：undici 的 "fetch failed" 必须拆 cause 才看得出到底是哪一层断的
        throw new Error(describeError(err));
      }
      if (!res.ok) throw new Error(`同花顺 HTTP ${res.status}`);
      const json = await res.json();
      if (json?.status_code !== 0) {
        const err = new Error(`同花顺业务错误 status_code=${json?.status_code} ${json?.status_msg ?? ''}`);
        // 把状态码挂到错误对象上：上层要能区分「接口坏了」和「今天还没开盘」
        err.thsCode = json?.status_code;
        err.thsMsg = String(json?.status_msg ?? '');
        throw err;
      }
      return json.data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }, { signal });
}

/**
 * 这个错误是不是「今天还没开盘」。
 *
 * 开盘前调连板梯队、涨停池，同花顺会返回 status_code=10003「尚未开盘」。
 * 那是正常状态，不是故障 —— 必须返回空集合，不能让接口 500。
 * 实测：2026-10-20 09:09 未开盘时 /ladder 会把整个请求打成 500。
 */
export function isNotOpenYet(err) {
  if (err?.thsCode === 10003) return true;
  const msg = String(err?.thsMsg ?? err?.message ?? '');
  // 「集合竞价期间无实际成交，数据暂不刷新」也是同一种状态：
  // 09:15-09:30 之间调板块/涨停池都会拿到这个，不能当故障。
  return /尚未开盘|非交易日|暂无数据|集合竞价/.test(msg);
}

/** 同花顺把代码和市场分开给，拼成带前缀代码；市场未知时返回 null（宁可丢也不猜） */
function toCode(item) {
  const p = MARKET_PREFIX[item?.market_id];
  const code = String(item?.code ?? '');
  if (!p || !/^\d{6}$/.test(code)) return null;
  return p + code;
}

/**
 * 涨跌停概览：一个请求拿到涨停/跌停/炸板家数与交易状态。
 *
 * `num` 是当前涨停家数，`open_num` 是炸板家数，`history_num` 是当日曾经涨停家数。
 * `rate` 是封板率（同花顺口径），直接用，不自己算。
 *
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function fetchOverview(opts = {}) {
  const d = await get('limit_up_pool', { page: 1, limit: 1 }, opts.signal);
  return {
    source: '同花顺',
    date: d?.date ?? '',
    tradeStatus: d?.trade_status ?? null,
    limitUp: normalizeCount(d?.limit_up_count),
    limitDown: normalizeCount(d?.limit_down_count),
  };
}

function normalizeCount(raw) {
  if (!raw) return null;
  const pick = (o) => (o ? {
    num: num(o.num),
    openNum: num(o.open_num),
    historyNum: num(o.history_num),
    rate: Number.isFinite(Number(o.rate)) ? Number(o.rate) : null,
  } : null);
  return { today: pick(raw.today), yesterday: pick(raw.yesterday) };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * 连板梯队。
 *
 * 返回按高度降序的数组；`height` 是连板数，`codeList` 是该高度的个股。
 * 只有高度 ≥ 2 的会在接口里出现——首板需要调用方用「涨停总数 - 连板总数」推。
 *
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function fetchLadder(opts = {}) {
  let data;
  try {
    data = await get('continuous_limit_up', { filter: DEFAULT_FILTER }, opts.signal);
  } catch (err) {
    // 开盘前没有梯队是完全正常的，返回空数组而不是抛错
    if (isNotOpenYet(err)) return [];
    throw err;
  }
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((r) => ({
      height: num(r.height) ?? 0,
      number: num(r.number) ?? (Array.isArray(r.code_list) ? r.code_list.length : 0),
      stocks: (Array.isArray(r.code_list) ? r.code_list : [])
        .map((s) => ({ code: toCode(s), name: s?.name ?? '', continueNum: num(s?.continue_num) }))
        .filter((s) => s.code),
    }))
    .filter((r) => r.height >= 2)
    .sort((a, b) => b.height - a.height);
}

/**
 * 涨停池明细。
 *
 * `change_tag` 是本条的性质：`FIRST_LIMIT` 首板、`LIMIT_FAILED` 炸板。
 * @param {{page?: number, limit?: number, signal?: AbortSignal}} [opts]
 */
export async function fetchLimitUpList(opts = {}) {
  return fetchPool('limit_up_pool', opts);
}

/**
 * 炸板池明细（当日曾涨停、现在没封住的）。
 * @param {{page?: number, limit?: number, signal?: AbortSignal}} [opts]
 */
export async function fetchBrokeList(opts = {}) {
  return fetchPool('open_limit_pool', opts);
}

async function fetchPool(path, opts = {}) {
  // limit 上限是 200：实测传 300 会回 status_code=-1 且 msg 是
  // `limitmust be less than or equal to 200`（连空格都没有，是拼出来的报错）。
  // 夹在这一层而不是调用方 —— 否则换个调用方又要踩一次。
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  let d;
  try {
    d = await get(path, {
      page: opts.page ?? 1,
      limit,
      field: FIELD_LIMIT_UP,
      filter: DEFAULT_FILTER,
      order_field: '330324',
      order_type: 0,
    }, opts.signal);
  } catch (err) {
    // 开盘前涨停池本来就是空的，不能把整个 /pool 打成 500。
    // 实测 2026-10-20 09:20 未开盘时 /pool?type=firstboard 会 500。
    if (isNotOpenYet(err)) return { total: 0, items: [], empty: true };
    throw err;
  }
  const info = Array.isArray(d?.info) ? d.info : [];
  return {
    total: num(d?.page?.total) ?? info.length,
    items: info.map((it) => ({
      code: toCode(it),
      name: it?.name ?? '',
      tag: it?.change_tag ?? '',
      firstLimitUpTime: it?.first_limit_up_time ?? '',
      lastLimitUpTime: it?.last_limit_up_time ?? '',
      continueNum: num(it?.continue_num),
      reason: it?.reason_type ?? it?.reason ?? '',
    })).filter((it) => it.code),
  };
}

/**
 * 板块涨停分布（同花顺按涨停家数排序的板块榜）。
 *
 * 与东财板块涨幅榜互补：东财给涨跌幅，这里给「几个涨停、几连板」。
 *
 * 刻意不暴露 `change` 字段：它既不是百分数也不是小数比例，
 * 实测与东财同名概念板块对不上（机器人概念 change=0.0501，同期该板块 16 只全部涨停），
 * 同花顺也未提供字段文档。用「不猜」原则处理——不展示无法验证语义的数字。
 * 板块涨跌幅改用语义已验证的东财 fetchSectors。见 docs/数据源实测.md。
 *
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function fetchSectorTop(opts = {}) {
  const data = await get('block_top', { filter: DEFAULT_FILTER }, opts.signal);
  const rows = Array.isArray(data) ? data : [];
  return rows.map((r) => ({
    code: r?.code ?? '',
    name: r?.name ?? '',
    /** 该板块当日涨停家数 */
    limitUpNum: num(r?.limit_up_num),
    /** 该板块处于连板状态的个股数 */
    continuousNum: num(r?.continuous_plate_num),
    /** 最高板，形如 `3天3板`，是字符串不是数字，原样透传 */
    high: r?.high ?? '',
    days: num(r?.days),
    stocks: (Array.isArray(r?.stock_list) ? r.stock_list : []).slice(0, 8).map((s) => ({
      code: toCode(s),
      name: s?.name ?? '',
    })).filter((s) => s.code),
  })).filter((r) => r.name);
}
