/**
 * 东方财富数据源（push2 / push2his）
 *
 * 为什么选它：板块榜（行业 496 / 概念 516）和 K 线只有它好用，免 cookie/token/签名，
 * 且板块榜自带涨跌家数与领涨股。
 *
 * 实测踩到的坑：`stock/kline/get` **必须同时传 `beg` 和 `end`**。
 * 不传时接口返回 HTTP 200 但 `{rc:102, data:null}`——是静默空数据，不是报错。
 * 另外 `clist/get` 会偶发 `RemoteDisconnected`，同一 URL 上一轮还是 200，所以要重试。
 *
 * @author cai shan
 * @date 2026-10-19 14:26
 */

import { withRetry, DEFAULT_TIMEOUT_MS, describeError } from './cache.js';

const KLINE_BASE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';

/**
 * 板块榜的候选主机，按次轮换。
 *
 * 为什么只留两个：实测 push2 与 1.push2 在 Node 下回应最好，
 * 而 7./82.push2 与 push2delay 稳定报 UND_ERR_SOCKET（服务端关连接），列进来只会徒增请求。
 *
 * 为什么不靠「多主机」绕过限流：实测连续请求约 60 次之后，东财全部子域同时开始拒绝，
 * 连一直是好的 push2his 也一样，同一时刻 Python 侧同样复现 —— 这是 IP 级限流，换主机绕不过。
 * 所以这里的轮换只用来兜「单个连接偶发被关」；遇到系统性拒绝要靠 SourceHealth 的指数退避。
 */
const CLIST_HOSTS = [
  'push2.eastmoney.com',
  '1.push2.eastmoney.com',
];

const CLIST_PATH = '/api/qt/clist/get';

const HEADERS = {
  Referer: 'https://quote.eastmoney.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

/** 东财 secid 的市场号：沪=1，深/北=0 */
const MARKET_NO = { sh: 1, sz: 0, bj: 0 };

/** 周期名 -> 东财 klt 值 */
const KLT = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60, day: 101, week: 102, month: 103 };

/** 板块类型 -> 东财 fs 片段。t:2=行业板块，t:3=概念板块；f:!50 排除已退市成分 */
const BOARD_FS = { industry: 'm:90+t:2+f:!50', concept: 'm:90+t:3+f:!50' };

/**
 * 单次取 JSON，统一处理「HTTP 200 + rc 非 0」这种业务失败。
 */
async function fetchOnce(url, signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res;
    try {
      res = await fetch(url, { headers: HEADERS, signal: ctl.signal });
    } catch (err) {
      // undici 一律把网络失败包成 "fetch failed"，不拆 cause 链就分不清
      // 「服务端主动关闭连接（该退避）」和「网络抖了一下（该重试）」
      throw new Error(describeError(err));
    }
    if (!res.ok) throw new Error(`东财 HTTP ${res.status}`);
    const json = await res.json();
    if (json?.rc !== undefined && json.rc !== 0) throw new Error(`东财业务错误 rc=${json.rc}`);
    if (json?.data === null || json?.data === undefined) throw new Error('东财返回空数据');
    return json.data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 取 JSON。
 *
 * 传一个 URL 时就地重试。
 * 传一组 URL 时逐个换主机，每个只试一次——总尝试次数因此被钉死在「主机数」上，
 * 不会出现「重试次数 × 主机数」的时间放大：4 个主机各 5 秒超时也才 20 秒封顶，
 * 而正常情况下第一个主机就在 200ms 内返回。
 *
 * @param {string|string[]} urls
 * @param {AbortSignal} [signal]
 * @param {number} [timeoutMs]
 */
async function getJson(urls, signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (list.length === 0) throw new Error('东财没有可用的主机');
  if (list.length === 1) return withRetry(() => fetchOnce(list[0], signal, timeoutMs), { signal });

  let lastErr;
  for (const url of list) {
    if (signal?.aborted) throw signal.reason ?? new Error('已取消');
    try {
      return await fetchOnce(url, signal, timeoutMs);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('东财所有候选主机都失败');
}

/** 代码 -> secid；市场前缀不认识时返回 null，不猜 */
function toSecid(code) {
  const m = /^(sh|sz|bj)(\d{6})$/.exec(String(code ?? '').toLowerCase());
  if (!m) return null;
  return `${MARKET_NO[m[1]]}.${m[2]}`;
}

/** 把 Date 或时间戳格式化成东财要的 YYYYMMDD */
function ymd(v) {
  const d = v instanceof Date ? v : new Date(v);
  const cn = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${cn.getUTCFullYear()}${String(cn.getUTCMonth() + 1).padStart(2, '0')}${String(cn.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 日 K / 分钟 K。
 *
 * `beg`/`end` 必须显式给：不给会拿到 `rc:102 + data:null`，且是静默的。
 * 默认取最近 120 个自然日，足够覆盖 60 根日 K。
 *
 * @param {string} code 带市场前缀，如 sh600519
 * @param {{period?: keyof KLT, limit?: number, adjust?: 0|1|2, beg?: string|Date, end?: string|Date, signal?: AbortSignal}} [opts]
 * @returns {Promise<{code: string, name: string, period: string, candles: object[]}>}
 */
export async function fetchKline(code, opts = {}) {
  const secid = toSecid(code);
  if (!secid) throw new Error(`无法识别代码：${code}`);

  const period = opts.period ?? 'day';
  const klt = KLT[period];
  if (!klt) throw new Error(`不支持周期：${period}`);

  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 500);
  const isMinute = klt < 100;
  const end = ymd(opts.end ?? Date.now());
  const beg = isMinute
    ? end
    : (opts.beg ? ymd(opts.beg) : ymd(Date.now() - 120 * 86400000));

  const qs = new URLSearchParams({
    secid,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: String(klt),
    // fqt=1 前复权：不复权时除权日会出现跳空，与技术指标不一致
    fqt: String(opts.adjust ?? 1),
    beg,
    end,
    lmt: String(limit),
  });

  const d = await getJson(`${KLINE_BASE}?${qs}`, opts.signal);
  const rows = Array.isArray(d?.klines) ? d.klines : [];
  return {
    code,
    name: d?.name ?? '',
    period,
    candles: rows.map(parseCandle).filter(Boolean),
  };
}

/**
 * 单行 K 线。字段顺序固定为 f51..f61：
 * 日期,开,收,高,低,成交量(手),成交额(元),振幅%,涨跌幅%,涨跌额,换手率%
 * 分钟周期的时间字段形如 `2026-10-19 09:31`，日线为 `2026-10-19`。
 */
function parseCandle(row) {
  const p = String(row).split(',');
  if (p.length < 11) return null;
  const n = (i) => {
    const v = Number(p[i]);
    return Number.isFinite(v) ? v : null;
  };
  return {
    date: p[0],
    open: n(1),
    close: n(2),
    high: n(3),
    low: n(4),
    volume: n(5),
    amount: n(6),
    amplitude: n(7),
    changePct: n(8),
    change: n(9),
    turnover: n(10),
  };
}

/**
 * 板块榜。
 *
 * 东财的 `f3` 是涨跌幅、`f104`/`f105` 是板块内上涨/下跌家数。
 * 注意这两个字段号是 clist 的语义，**不能拿到 stock/get 去用**（那边 f104/f105 是财务项）。
 *
 * @param {{board?: 'industry'|'concept', direction?: 'up'|'down', limit?: number, signal?: AbortSignal}} [opts]
 */
export async function fetchSectors(opts = {}) {
  const board = opts.board ?? 'industry';
  const fs = BOARD_FS[board];
  if (!fs) throw new Error(`不支持的板块类型：${board}`);

  const qs = new URLSearchParams({
    pn: '1',
    pz: String(Math.min(Math.max(opts.limit ?? 12, 1), 100)),
    // po=1 降序、po=0 升序；fid=f3 表示按涨跌幅排
    po: opts.direction === 'down' ? '0' : '1',
    np: '1',
    fltt: '2',
    invt: '2',
    fid: 'f3',
    fs,
    fields: 'f12,f14,f2,f3,f62,f104,f105,f128',
  });

  const d = await getJson(CLIST_HOSTS.map((h) => `https://${h}${CLIST_PATH}?${qs}`), opts.signal);
  const diff = Array.isArray(d?.diff) ? d.diff : [];
  return {
    board,
    direction: opts.direction ?? 'up',
    total: Number.isFinite(Number(d?.total)) ? Number(d.total) : diff.length,
    items: diff.map((it) => ({
      code: it?.f12 ?? '',
      name: it?.f14 ?? '',
      changePct: numOrNull(it?.f3),
      mainNetInflow: numOrNull(it?.f62),
      upCount: numOrNull(it?.f104),
      downCount: numOrNull(it?.f105),
      leader: it?.f128 ?? '',
    })).filter((it) => it.name),
  };
}

/** 东财用 `-` 表示无数据，不能直接 Number（会得到 NaN） */
function numOrNull(v) {
  if (v === '-' || v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
