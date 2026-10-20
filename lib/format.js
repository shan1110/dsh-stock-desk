/**
 * 数字与单位格式化（宿主侧）
 *
 * 为什么单独一层：agent 工具的 render 要把原始数字变成人能读的文本，
 * 而原始数字的单位随字段变（成交额是万元、市值是亿、成交量是手）。
 * 让每个工具自己拼字符串迟早会拼错单位，所以统一到这里。
 *
 * @author cai shan
 * @date 2026-10-19 15:18
 */

/** 中国股市「红涨绿跌」，但这里只管数值格式，不管配色 */

/** 价格：ETF 报价是 3 位小数（如 4.265），个股与指数是 2 位 */
export function fmtPrice(v, kind) {
  if (!Number.isFinite(v)) return '—';
  return kind === 'etf' ? v.toFixed(3) : v.toFixed(2);
}

/** 带正负号，用于涨跌额与涨跌幅 */
export function fmtSigned(v, digits = 2, suffix = '') {
  if (!Number.isFinite(v)) return '—';
  const s = v.toFixed(digits);
  return (v > 0 ? '+' : '') + s + suffix;
}

/** 涨跌幅，带 % 与正负号 */
export function fmtPct(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return fmtSigned(v, digits, '%');
}

/**
 * 无符号百分比。
 *
 * 换手率、振幅、封板率都是恒非负的量，套 fmtPct 会输出「换手率 +0.25%」这种多余的正号。
 * 正号在行情语境里是「涨」的意思，挂在换手率上会被当成方向信息误读。
 */
export function fmtPctAbs(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)}%`;
}

/** 成交额：接口给的是万元 */
export function fmtAmountYi(wan) {
  if (!Number.isFinite(wan)) return '—';
  const yi = wan / 10000;
  if (yi >= 10000) return `${(yi / 10000).toFixed(2)} 万亿`;
  return `${yi.toFixed(2)} 亿`;
}

/** 市值：接口给的就是亿元 */
export function fmtCapYi(yi) {
  if (!Number.isFinite(yi)) return '—';
  if (yi >= 10000) return `${(yi / 10000).toFixed(2)} 万亿`;
  return `${yi.toFixed(2)} 亿`;
}

/** 成交量：接口给的是手 */
export function fmtHand(hand) {
  if (!Number.isFinite(hand)) return '—';
  if (hand >= 1e8) return `${(hand / 1e8).toFixed(2)} 亿手`;
  if (hand >= 1e4) return `${(hand / 1e4).toFixed(2)} 万手`;
  return `${hand} 手`;
}

/** 按字段的 unit 选择格式 */
export function fmtByUnit(v, unit, kind) {
  switch (unit) {
    case 'price': return fmtPrice(v, kind);
    case 'pct': return fmtPct(v);
    case 'pctAbs': return fmtPctAbs(v);
    case 'wan': return fmtAmountYi(v);
    case 'yi': return fmtCapYi(v);
    case 'hand': return fmtHand(v);
    default: return Number.isFinite(v) ? String(round(v)) : '—';
  }
}

function round(v) {
  return Math.abs(v) >= 100 ? Math.round(v * 100) / 100 : Math.round(v * 1000) / 1000;
}

/** 时间戳（毫秒）-> 北京时间 `YYYY-MM-DD HH:mm:ss` */
export function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 腾讯的时间字段 `YYYYMMDDHHMMSS` -> 可读文本；认不出来原样返回 */
export function fmtApiTime(raw) {
  const s = String(raw ?? '');
  if (/^\d{14}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
  }
  return s || '—';
}

/**
 * 数据来源与取数时刻声明。
 *
 * 每个工具的输出都必须带这一行。理由是行情数据有强时效性：
 * 模型若不知道手上这份数据是什么时候取的，就会把收盘价当成实时价讲给用户。
 */
export function provenance(session, at, sources) {
  const lines = [];
  const trade = session?.trading ? `交易中（${session.label}${session.origin === 'server' ? '，服务器自报' : '，本地时钟粗判'}）` : `未交易（${session?.label ?? '未知状态'}）`;
  lines.push(`取数时刻 ${fmtTime(at)} · ${trade}`);
  if (Array.isArray(sources) && sources.length) {
    lines.push(`数据源 ${sources.map((s) => `${s.name}${s.healthy ? '正常' : '异常'}`).join(' · ')}`);
  }
  return lines.join('\n');
}

/** 收盘提示：收盘后必须让模型知道「这个价格今天不会再变了」 */
export function stalenessNote(session, at) {
  if (session?.trading) return '';
  return `\n注意：当前${session?.label ?? '非交易时段'}，以上为 ${fmtTime(at)} 的快照，价格不会继续变动。`;
}
