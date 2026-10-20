/**
 * A 股交易时段判断
 *
 * 为什么不用服务器时间：本机时钟可能与交易所不一致，且周末/节假日无法从时钟推出。
 * 所以这里只做**本地粗判**，用于决定「要不要按秒轮询」；
 * 真正的交易状态优先采用同花顺 `limit_up_pool` 返回的 `trade_status`（服务器自报）。
 *
 * 时区处理：中国不实行夏令时，UTC+8 是固定偏移。用固定偏移换算比依赖
 * Intl 时区数据库更稳，也不会因运行环境缺 tzdata 而出错。
 *
 * @author cai shan
 * @date 2026-10-19 14:14
 */

/** 中国市场固定偏移：UTC+8 */
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 取中国市场「墙上时间」的各字段。
 *
 * 做法是把 UTC 时间平移 8 小时后读 UTC 字段，得到的就是北京时间的年月日时分秒。
 * @param {number} [atMs]
 */
export function cnParts(atMs = Date.now()) {
  const d = new Date(atMs + CN_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    /** 0=周日 … 6=周六 */
    weekday: d.getUTCDay(),
    stamp: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`,
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** 把分钟数换算成当天第几分钟，便于区间比较 */
const at = (p) => p.hour * 60 + p.minute;

/** A 股连续竞价时段（不含集合竞价） */
const SEGMENTS = [
  { id: 'morning', label: '上午交易', from: 9 * 60 + 30, to: 11 * 60 + 30 },
  { id: 'afternoon', label: '午后交易', from: 13 * 60, to: 15 * 60 },
];

/**
 * 本地粗判的交易阶段。
 *
 * @param {number} [atMs]
 * @returns {{id: string, label: string, trading: boolean}}
 */
export function localSession(atMs = Date.now()) {
  const p = cnParts(atMs);
  if (p.weekday === 0 || p.weekday === 6) {
    return { id: 'weekend', label: '休市（周末）', trading: false };
  }
  const m = at(p);
  if (m < 9 * 60 + 15) return { id: 'pre_open', label: '未开盘', trading: false };
  if (m < 9 * 60 + 30) return { id: 'auction', label: '集合竞价', trading: false };

  for (const s of SEGMENTS) {
    if (m >= s.from && m < s.to) return { id: s.id, label: s.label, trading: true };
  }
  if (m >= 11 * 60 + 30 && m < 13 * 60) return { id: 'noon', label: '午间休市', trading: false };
  if (m >= 15 * 60) return { id: 'closed', label: '已收盘', trading: false };
  return { id: 'closed', label: '已收盘', trading: false };
}

/**
 * 同花顺 `trade_status.id` -> 本插件统一阶段。
 *
 * 服务器自报比本地时钟可靠（它知道节假日），但字段名是对方定义的，
 * 未知 id 一律回落到本地粗判，避免对方改字段后我们误判成「交易中」。
 */
const TRADE_STATUS_MAP = {
  before_trading: { id: 'pre_open', label: '未开盘', trading: false },
  call_auction: { id: 'auction', label: '集合竞价', trading: false },
  morning_trade: { id: 'morning', label: '上午交易', trading: true },
  noon_break: { id: 'noon', label: '午间休市', trading: false },
  afternoon_trade: { id: 'afternoon', label: '午后交易', trading: true },
  after_trading: { id: 'closed', label: '已收盘', trading: false },
};

/**
 * 合成交易状态：优先用服务器自报，缺失或未知则回落本地。
 *
 * @param {{id?: string, name?: string} | null | undefined} tradeStatus 同花顺返回的 trade_status
 * @param {number} [atMs]
 * @param {{source?: string}} [meta]
 */
export function resolveSession(tradeStatus, atMs = Date.now(), meta = {}) {
  const local = localSession(atMs);
  const mapped = tradeStatus?.id ? TRADE_STATUS_MAP[tradeStatus.id] : null;
  if (mapped) {
    return { ...mapped, origin: 'server', serverLabel: tradeStatus.name ?? '', local: local.id };
  }
  return { ...local, origin: 'local', serverLabel: '', local: local.id };
}

/**
 * 轮询间隔建议。
 *
 * 盘中按秒、非盘中按分钟——非交易时段还按秒轮询既是浪费也会被接口限流。
 * @param {{trading: boolean}} session
 */
export function pollIntervalMs(session) {
  return session.trading ? 3000 : 60000;
}
