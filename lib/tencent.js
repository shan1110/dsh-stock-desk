/**
 * 腾讯行情数据源（腾讯财经 qt.gtimg.cn）
 *
 * 为什么这么写：接口返回 88 个 `~` 分隔字段且无官方字段表，字段号也不能跨接口复用。
 * 索引全部由 tools/probe-tencent.py 实测确认，见 docs/腾讯字段实测表.md。
 * 关键点：指数在 [38][39][46] 上返回的是「看似合理的假值」（0.69 / 16.24 / 0.00），
 * [47][48] 返回 -1。所以字段是否输出由品种白名单决定，不靠调用方自觉。
 *
 * @author cai shan
 * @date 2026-10-19 13:58
 */

/** 批量取价接口；一次请求多只，逗号分隔 */
const ENDPOINT = 'https://qt.gtimg.cn/q=';

/** 单次请求最大代码数。实测 800 只可全部返回，这里留足余量避免 URL 过长 */
const CHUNK = 200;

/** A 股/指数/ETF 的字段总数；港股是 78，不可按本表解析 */
const FIELD_COUNT = 88;

/** 字段索引（A 股 / 指数 / ETF 通用） */
const IDX = {
  NAME: 1,
  CODE: 2,
  PRICE: 3,
  PREV_CLOSE: 4,
  OPEN: 5,
  OUTER: 7,
  INNER: 8,
  BID_FROM: 9,
  ASK_FROM: 19,
  TIME: 30,
  CHANGE: 31,
  CHANGE_PCT: 32,
  HIGH: 33,
  LOW: 34,
  VOLUME: 36,
  AMOUNT: 37,
  TURNOVER: 38,
  PE: 39,
  AMPLITUDE: 43,
  FLOAT_CAP: 44,
  TOTAL_CAP: 45,
  PB: 46,
  LIMIT_UP: 47,
  LIMIT_DOWN: 48,
  VOL_RATIO: 49,
  ORDER_DIFF: 50,
  AVG_PRICE: 51,
  PE_DYN: 52,
  PE_STATIC: 53,
  KIND: 61,
  CURRENCY: 82,
};

/** 指数在该位置返回 -1，不能当价格用 */
const UNSET = -1;

/**
 * 字段规格表
 *
 * kinds 决定该字段对哪些品种输出。不在列表里的品种直接拿不到该字段，
 * 所以 UI 不可能显示「上证指数 市盈率 16.24」。
 * unit 只用于展示，单位换算交给调用方。
 */
const SPEC = [
  { key: 'price', label: '现价', idx: IDX.PRICE, kinds: ['stock', 'index', 'etf'], unit: 'price' },
  { key: 'prevClose', label: '昨收', idx: IDX.PREV_CLOSE, kinds: ['stock', 'index', 'etf'], unit: 'price' },
  { key: 'open', label: '今开', idx: IDX.OPEN, kinds: ['stock', 'index', 'etf'], unit: 'price' },
  { key: 'high', label: '最高', idx: IDX.HIGH, kinds: ['stock', 'index', 'etf'], unit: 'price' },
  { key: 'low', label: '最低', idx: IDX.LOW, kinds: ['stock', 'index', 'etf'], unit: 'price' },
  { key: 'change', label: '涨跌额', idx: IDX.CHANGE, kinds: ['stock', 'index', 'etf'], unit: 'price' },
  { key: 'changePct', label: '涨跌幅', idx: IDX.CHANGE_PCT, kinds: ['stock', 'index', 'etf'], unit: 'pct' },
  { key: 'amplitude', label: '振幅', idx: IDX.AMPLITUDE, kinds: ['stock', 'index', 'etf'], unit: 'pct' },
  { key: 'amount', label: '成交额', idx: IDX.AMOUNT, kinds: ['stock', 'index', 'etf'], unit: 'wan' },
  { key: 'totalCap', label: '总市值', idx: IDX.TOTAL_CAP, kinds: ['stock', 'index', 'etf'], unit: 'yi' },
  { key: 'floatCap', label: '流通市值', idx: IDX.FLOAT_CAP, kinds: ['stock', 'index', 'etf'], unit: 'yi' },
  // 以下字段对指数无意义（实测为假值或 -1），只对个股/ETF 输出
  { key: 'volume', label: '成交量', idx: IDX.VOLUME, kinds: ['stock', 'etf'], unit: 'hand' },
  { key: 'avgPrice', label: '均价', idx: IDX.AVG_PRICE, kinds: ['stock', 'etf'], unit: 'price' },
  { key: 'volRatio', label: '量比', idx: IDX.VOL_RATIO, kinds: ['stock', 'etf'], unit: 'num' },
  { key: 'turnover', label: '换手率', idx: IDX.TURNOVER, kinds: ['stock', 'etf'], unit: 'pct' },
  { key: 'limitUp', label: '涨停价', idx: IDX.LIMIT_UP, kinds: ['stock', 'etf'], unit: 'price' },
  { key: 'limitDown', label: '跌停价', idx: IDX.LIMIT_DOWN, kinds: ['stock', 'etf'], unit: 'price' },
  { key: 'orderDiff', label: '委差', idx: IDX.ORDER_DIFF, kinds: ['stock', 'etf'], unit: 'num' },
  // 估值只对个股输出：ETF 的 [39] 为空、[46] 为 0.00
  { key: 'pe', label: '市盈率(TTM)', idx: IDX.PE, kinds: ['stock'], unit: 'num' },
  { key: 'peDyn', label: '市盈率(动)', idx: IDX.PE_DYN, kinds: ['stock'], unit: 'num' },
  { key: 'peStatic', label: '市盈率(静)', idx: IDX.PE_STATIC, kinds: ['stock'], unit: 'num' },
  { key: 'pb', label: '市净率', idx: IDX.PB, kinds: ['stock'], unit: 'num' },
  // 内外盘指数恒为 0，不给指数
  { key: 'outer', label: '外盘', idx: IDX.OUTER, kinds: ['stock', 'etf'], unit: 'num' },
  { key: 'inner', label: '内盘', idx: IDX.INNER, kinds: ['stock', 'etf'], unit: 'num' },
];

/** 字段 key -> 中文标签，供工具与 UI 复用 */
export const FIELD_LABELS = Object.fromEntries(SPEC.map((s) => [s.key, s.label]));

const KIND_BY_FLAG = {
  'GP-A': 'stock',
  'GP-A-CYB': 'stock',
  'GP-A-KCB': 'stock',
  ZS: 'index',
  ETF: 'etf',
};

/**
 * 由代码前缀判断上市板块。
 *
 * 为什么要单独给这个：用户明确说过「我买不了创业板」，所以界面上必须一眼看出
 * 一只票是创业板（30x，20cm 限幅）还是沪深主板（60x/00x，10cm）。
 * 光看 6 位数字串分辨不出来 —— 300xxx 和 600xxx 在表格里一样长。
 *
 * 只给「有交易权限差异」的四类：沪主板 / 深主板 / 创业板 / 科创板 / 北交所。
 * 基金、B 股、指数不给板块名（它们不存在「哪个板」这回事），返回空串由调用方决定显不显示。
 *
 * @param {string} code 带市场前缀的代码，如 sz300750
 * @returns {string} 板块名，判不出来时为空串
 */
export function boardOf(code) {
  let c = String(code ?? '').toLowerCase();
  // 裸 6 位也要能用：板块成分股那份名单给的就是 301119 这种不带前缀的代码
  if (/^\d{6}$/.test(c)) c = (inferPrefix(c) ?? '') + c;
  const m = /^(sh|sz|bj)(\d{6})$/.exec(c);
  if (!m) return '';
  const [, mk, num] = m;
  if (mk === 'bj') return '北交所';
  // sh 只有 60x 与 68x 是个股；sh000001 / sh510300 这类是指数与基金，不给板块名
  if (mk === 'sh') return /^68/.test(num) ? '科创板' : /^60/.test(num) ? '沪主板' : '';
  // sz 只有 00x 与 30x 是个股；sz399001 这类指数不给板块名
  return /^30/.test(num) ? '创业板' : /^00/.test(num) ? '深主板' : '';
}

/**
 * 由品种标记 [61] 判断品种。
 *
 * 为什么用标记而不是代码前缀：前缀规则要维护各板块号段，而接口已经直接给了品种。
 * 未知标记归为 unknown，调用方据此拒绝返回错位数据。
 *
 * @param {string} flag 字段 [61] 的原始值
 * @returns {string} stock | index | etf | hk | unknown
 */
export function classifyKind(flag) {
  const v = String(flag ?? '').trim();
  if (KIND_BY_FLAG[v]) return KIND_BY_FLAG[v];
  if (v.startsWith('GP')) return 'stock';
  if (v.startsWith('hk') || v === 'HS' || v === 'HK') return 'hk';
  return 'unknown';
}

/**
 * 解析单只股票的完整字段。
 *
 * @param {string} code 带市场前缀的代码，如 sh600519
 * @param {string[]} f 按 `~` 切分后的字段数组
 * @returns {object|null} 品种未知或字段缺失时返回 null
 */
export function parseFull(code, f) {
  if (!Array.isArray(f) || f.length < IDX.LIMIT_DOWN) return null;
  const kind = classifyKind(f[IDX.KIND]);
  if (kind === 'unknown') return null;

  const fields = {};
  for (const s of SPEC) {
    if (!s.kinds.includes(kind)) continue;
    const raw = f[s.idx];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    // 指数以外的品种不该出现 -1；出现即视为该品种无此字段
    if (n === UNSET) continue;
    fields[s.key] = n;
  }

  return {
    code,
    name: f[IDX.NAME] ?? code,
    kind,
    kindFlag: f[IDX.KIND] ?? '',
    // 上市板块（沪主板/深主板/创业板/科创板/北交所）；指数与基金为空串
    board: kind === 'stock' ? boardOf(code) : '',
    currency: f[IDX.CURRENCY] ?? '',
    time: f[IDX.TIME] ?? '',
    fields,
    ladder: kind === 'index' ? null : parseLadder(f),
    limit: parseLimit(fields),
  };
}

/** 五档盘口：买五档在前、卖五档在后，每档 价,量 相邻 */
function parseLadder(f) {
  const pick = (from) => {
    const out = [];
    for (let i = 0; i < 5; i++) {
      const p = Number(f[from + i * 2]);
      const v = Number(f[from + i * 2 + 1]);
      if (!Number.isFinite(p) || p <= 0) continue;
      out.push({ price: p, volume: Number.isFinite(v) ? v : 0 });
    }
    return out;
  };
  const bids = pick(IDX.BID_FROM);
  const asks = pick(IDX.ASK_FROM);
  if (bids.length === 0 && asks.length === 0) return null;
  return { bids, asks };
}

/**
 * 涨跌停判定。
 *
 * 为什么不看涨幅：ST 是 5cm、创业板/科创板 20cm、北交所 30cm，
 * 用「涨幅 >= 9.9%」会同时漏报和误报。接口给的涨停价自带正确上限。
 */
function parseLimit(fields) {
  const { price, high, limitUp, limitDown } = fields;
  if (limitUp === undefined) return null;
  const atLimitUp = price !== undefined && price >= limitUp;
  const atLimitDown = limitDown !== undefined && price !== undefined && price <= limitDown;
  // 炸板 = 盘中最高触及涨停，但现价没封住
  const burst = !atLimitUp && high !== undefined && high >= limitUp;
  return { atLimitUp, atLimitDown, burst };
}

/**
 * 只解析算涨跌家数/情绪所需的少数字段，用于全市场扫描。
 *
 * 与 parseFull 分开是为了全市场 5500 只时不构造 30 个字段的对象。
 */
export function parseBrief(code, f) {
  if (!Array.isArray(f) || f.length < IDX.LIMIT_DOWN) return null;
  const kind = classifyKind(f[IDX.KIND]);
  const price = Number(f[IDX.PRICE]);
  const prevClose = Number(f[IDX.PREV_CLOSE]);
  if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose <= 0) return null;
  const limitUp = Number(f[IDX.LIMIT_UP]);
  const limitDown = Number(f[IDX.LIMIT_DOWN]);
  const high = Number(f[IDX.HIGH]);
  const hasLimit = Number.isFinite(limitUp) && limitUp > 0;
  return {
    code,
    name: f[IDX.NAME] ?? code,
    kind,
    // 涨停/跌停名单里每一行都要能看出是哪个板，所以扫描路径也带上
    board: kind === 'stock' ? boardOf(code) : '',
    price,
    prevClose,
    // 成交额（万元）。全市场扫描要把它累加成总成交额，所以必须在这里取，
    // 不能等到界面上再逐只查一遍。
    amount: Number.isFinite(Number(f[IDX.AMOUNT])) ? Number(f[IDX.AMOUNT]) : 0,
    prevClose,
    changePct: Number.isFinite(Number(f[IDX.CHANGE_PCT])) ? Number(f[IDX.CHANGE_PCT]) : ((price - prevClose) / prevClose) * 100,
    atLimitUp: hasLimit && price >= limitUp,
    atLimitDown: Number.isFinite(limitDown) && limitDown > 0 && price <= limitDown,
    burst: hasLimit && price < limitUp && Number.isFinite(high) && high >= limitUp,
  };
}

/**
 * 把腾讯原始响应文本切成 代码 -> 字段数组。
 *
 * 不存在的代码不会出现在响应里（不是返回空），所以调用方要按缺失处理。
 * @param {string} text GBK 解码后的响应体
 * @returns {Map<string, string[]>}
 */
export function splitResponse(text) {
  const out = new Map();
  for (const seg of String(text).split(';')) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const name = seg.slice(0, eq).trim();
    if (!name.startsWith('v_')) continue;
    const code = name.slice(2);
    const quoted = seg.slice(eq + 1).trim().replace(/^"/, '').replace(/"$/, '');
    if (!quoted) continue;
    const f = quoted.split('~');
    if (f.length < FIELD_COUNT - 30) continue;
    out.set(code, f);
  }
  return out;
}

/** 响应是 GBK；按 UTF-8 解会让中文名称变乱码。Node full-icu 下可用 */
const DECODER = new TextDecoder('gbk');

/**
 * 批量拉取原始响应文本。
 *
 * 编码必须是 GBK：名称字段是中文，按 UTF-8 解会得到乱码。
 * @param {string[]} codes
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
 * @returns {Promise<Map<string, string[]>>}
 */
export async function fetchQuotes(codes, opts = {}) {
  const uniq = [...new Set(normalizeCodes(codes))];
  if (uniq.length === 0) return new Map();

  const merged = new Map();

  for (let i = 0; i < uniq.length; i += CHUNK) {
    const batch = uniq.slice(i, i + CHUNK);
    const text = await request(ENDPOINT + batch.join(','), opts);
    for (const [k, v] of splitResponse(text)) merged.set(k, v);
  }
  return merged;
}

/**
 * 归一化代码：接受 `sh600519`、`600519.SH`、`600519` 三种写法。
 *
 * 纯 6 位数字按号段补市场前缀（沪 60/68/9/11/13/5xx、深 00/30/12/15/16/18/39、北 4/8/92）。
 * 补不出来的直接丢弃，不发出去让接口返回空。
 */
export function normalizeCodes(codes) {
  const out = [];
  for (const raw of codes ?? []) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim().toLowerCase();
    let m = /^(sh|sz|bj)(\d{6})$/.exec(s);
    if (m) { out.push(s); continue; }
    m = /^(\d{6})\.(sh|sz|bj)$/.exec(s);
    if (m) { out.push(m[2] + m[1]); continue; }
    m = /^(\d{6})$/.exec(s);
    if (m) {
      const p = inferPrefix(m[1]);
      if (p) out.push(p + m[1]);
    }
  }
  return out;
}

/** 由号段推市场前缀；判不出来返回 null（不猜） */
function inferPrefix(code) {
  if (/^(60|68|90|11|13|5[0-8])/.test(code)) return 'sh';
  if (/^(00|30|12|15|16|18|39|2[0-9])/.test(code)) return 'sz';
  if (/^(4|8|92)/.test(code)) return 'bj';
  return null;
}

/** K 线基址。路径里带 appstock 与 fqkline，是腾讯行情前端自己在用的那个接口 */
const KLINE_BASE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

/** 腾讯只提供日/周/月三种周期；分钟线走东财，见 market.js 的双源分工 */
const KLINE_PERIODS = { day: 1, week: 1, month: 1 };

/**
 * 腾讯 K 线。
 *
 * 为什么要这个函数：方案 §6 把 K 线的主源定为腾讯、东财做后备，
 * 但实现里 kline 只连了东财（market.js 的 guarded('em', ...)）——
 * 结果是东财一限流 K 线就整个没有，而且没有任何降级路径。
 * 实测 2026-10-19 东财限流当天，/kline 直接 500，指北与个股都取不到图。
 *
 * 返回形状与 eastmoney.fetchKline 对齐（date/open/close/high/low/volume + 若干派生字段），
 * 两个源才能互换。腾讯一行只有 6 个字段，成交额/振幅/换手率它不给，一律置 null 而不是编一个；
 * 涨跌幅与涨跌额可以从前一根收盘价推出来，标为派生值。
 *
 * 复权：个股用 qfq（前复权，与东财 fqt=1 一致），指数没有除权概念，腾讯对指数返回的键
 * 就是 `day` 而不是 `qfqday` —— 所以取键时要按「qfq + 周期」再退回「周期」两段找。
 *
 * @param {string} code 带市场前缀，如 sh600519
 * @param {{period?: string, limit?: number, signal?: AbortSignal, timeoutMs?: number}} [opts]
 * @returns {Promise<{code: string, name: string, period: string, candles: object[]}>}
 */
export async function fetchKline(code, opts = {}) {
  const period = opts.period ?? 'day';
  if (!KLINE_PERIODS[period]) throw new Error(`腾讯不支持周期：${period}`);
  const full = /^(sh|sz|bj)/.test(code) ? code : `${inferPrefix(code) ?? 'sh'}${code}`;
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 800);

  const url = `${KLINE_BASE}?param=${full},${period},,,${limit},qfq`;
  const text = await request(url, opts);
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('腾讯 K 线返回的不是 JSON'); }
  if (d?.code !== 0) throw new Error(`腾讯 K 线返回 code=${d?.code} ${d?.msg ?? ''}`);

  const node = d?.data?.[full];
  // 指数用 `day`，个股用 `qfqday`；两个都试，顺序不能反（个股也可能同时给两者，qfq 才是复权后的）
  const rows = node?.[`qfq${period}`] ?? node?.[period] ?? [];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`腾讯 K 线没有数据：${full} ${period}`);

  const candles = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const open = num(r[1]);
    const close = num(r[2]);
    const high = num(r[3]);
    const low = num(r[4]);
    if (open === null || close === null) continue;
    const prev = candles.length > 0 ? candles[candles.length - 1].close : null;
    // 涨跌额/涨跌幅是派生的，不是接口原值 —— 首根没有前收，只能置 null
    const change = prev === null ? null : round2(close - prev);
    const changePct = prev === null || prev === 0 ? null : round2(((close - prev) / prev) * 100);
    candles.push({
      date: String(r[0]),
      open, close, high, low,
      volume: num(r[5]),
      // 腾讯 fqkline 只给这 6 列，以下三样它不给，置 null 而不是拿别的顶上
      amount: null,
      amplitude: null,
      turnover: null,
      change, changePct,
    });
  }
  if (candles.length === 0) throw new Error(`腾讯 K 线解析后为空：${full} ${period}`);

  // 接口会多给一根（要 6 给 7）。先全部算完涨跌幅再截到 limit：
  // 多出来的那根正好给第一根当昨收，否则每张图的头一根涨跌幅都是 null。
  return { code: full, name: node?.qt?.[full]?.[1] ?? '', period, candles: candles.slice(-limit) };
}

/** 数字兜底；腾讯偶尔把停牌日的量写成字符串 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** 分时基址。与 fqkline 不同的路径：minute/query */
const MINUTE_BASE = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query';

/**
 * 腾讯分时（当日逐分钟）。
 *
 * 一行的四个字段是「HHMM 价格 累计成交量(手) 累计成交额(元)」——
 * 注意后两个都是累计值，不是当分钟的增量，所以量能柱要用相邻两行相减，
 * 直接把第 3 列当分钟量画出来会是一条单调上升的斜线。
 *
 * 均价用「价格 × 分钟量」逐分钟累加求加权平均，而不是「累计额 ÷ 累计量」。
 * 后者只对个股成立，对指数会算出离谱的值：实测上证指数按额量法得 16.44，
 * 而当时指数在 3730 一带 —— 因为指数的成交额/成交量得到的是「平均每股价格」，
 * 不是指数点位。两种算法在个股上几乎一致（实测 1336.47 vs 1336.29，差 0.18），
 * 所以统一用量价加权，个股和指数都对，也不必再判品种。
 *
 * 只取到 15:00。接口在收盘后会多给盘后竞价那一段（实测个股 267 行 vs 指数 242 行），
 * 但行情软件的分时图一律画到 15:00，多出来的部分会把横轴拉长、图形挤扁。
 *
 * @param {string} code 带市场前缀，如 sh600519
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
 * @returns {Promise<{code: string, name: string, date: string, prevClose: number|null, points: object[]}>}
 */
export async function fetchMinute(code, opts = {}) {
  const full = /^(sh|sz|bj)/.test(code) ? code : `${inferPrefix(code) ?? 'sh'}${code}`;
  const text = await request(`${MINUTE_BASE}?code=${full}`, opts);
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('腾讯分时返回的不是 JSON'); }
  if (d?.code !== 0) throw new Error(`腾讯分时返回 code=${d?.code} ${d?.msg ?? ''}`);

  const node = d?.data?.[full];
  const rows = node?.data?.data;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`腾讯分时没有数据：${full}`);

  // qt 是标准腾讯报价数组：[3] 现价 [4] 昨收 [5] 今开。分时图的基准线要用昨收
  const qt = node?.qt?.[full] ?? [];
  const prevClose = num(qt[4]);

  const points = [];
  let lastCum = 0;
  let pvSum = 0;   // Σ 分钟价 × 分钟量
  let volSum = 0;  // Σ 分钟量
  for (const line of rows) {
    const p = String(line).split(' ');
    if (p.length < 4) continue;
    const hm = p[0];
    // 只要连续竞价的 09:30–15:00；盘后竞价那一段不进分时图
    if (!/^\d{4}$/.test(hm) || hm > '1500') continue;
    const price = num(p[1]);
    if (price === null) continue;
    const cumVol = num(p[2]);
    const volume = cumVol === null ? null : Math.max(0, cumVol - lastCum);
    if (cumVol !== null) lastCum = cumVol;
    if (volume !== null && volume > 0) { pvSum += price * volume; volSum += volume; }
    points.push({ time: hm, price, volume, avg: volSum > 0 ? round2(pvSum / volSum) : null });
  }
  if (points.length === 0) throw new Error(`腾讯分时解析后为空：${full}`);

  return {
    code: full,
    name: qt[1] ?? '',
    date: node?.data?.date ?? '',
    prevClose,
    points,
  };
}

/** 取一次，带超时与 Referer；Referer 缺失时部分 CDN 节点会拒绝 */
async function request(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 5000);
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res;
    try {
      res = await fetch(url, {
        signal: ctl.signal,
        headers: {
          Referer: 'https://gu.qq.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
      });
    } catch (err) {
      // 不拆 cause 链的话，所有网络失败都长成 "fetch failed"，分不清该退避还是该重试
      throw new Error(describeError(err));
    }
    if (!res.ok) throw new Error(`腾讯接口 HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return DECODER.decode(buf);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
