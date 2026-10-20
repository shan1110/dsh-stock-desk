/**
 * 板块数据源：同花顺行业板块榜 + 涨停板块榜 + 板块成分股
 *
 * 为什么全部走同花顺、不用东财：
 * 2026-10-19 实测东财 push2 的 clist/get 与 kline/get 被按路径拦截（同域名下
 * stock/get、ulist.np/get 正常返回 200），板块榜与板块成分股都取不到，
 * 且当天一直没恢复。所以板块功能整体改用同花顺，不依赖东财。取证见
 * docs/东财不可达取证与板块可行性.md。
 *
 * 为什么板块宇宙也统一用同花顺，而不是拿腾讯的板块榜：
 * 腾讯 rank/pt/getRank 给 991 个板块且字段更全，但它的板块名与同花顺是两套分类
 * （实测全量名称重合率仅 31%，涨幅前 10 只有 1 个能在同花顺找到）。下钻要靠
 * 板块名去映射同花顺的成分股页，跨厂商匹配会让大多数格子点不下去。
 * 同花顺自己的行业榜既是涨跌幅榜又带板块代码，下钻天然对得上，故取同花顺。
 *
 * 页面是 GBK 编码，按 UTF-8 解中文全变乱码，必须 TextDecoder('gbk')。
 *
 * @author cai shan
 * @date 2026-10-19 16:45
 */

import { withRetry, DEFAULT_TIMEOUT_MS, describeError } from './cache.js';
import { boardOf } from './tencent.js';

/** 行情站点基址；行业榜与成分股详情都在 q 子域下 */
const Q_BASE = 'http://q.10jqka.com.cn';

/** 涨停板块榜的数据接口，与 lib/ths.js 同域但不同路径族 */
const DATA_BASE = 'https://data.10jqka.com.cn/dataapi/limit_up/';

const HEADERS = {
  Referer: 'http://q.10jqka.com.cn/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const GBK = new TextDecoder('gbk');

/**
 * 行业榜每页行数（服务端固定，实测 90 个行业分 2 页，第 1 页 50 行第 2 页 40 行）
 * 与「成分股每页只数」是两件事，不要混用。
 */
const INDUSTRY_LIST_PER_PAGE = 50;

/**
 * 成分股每页只数，按板块类型不同：
 * 概念（gn）10 只/页，行业（thshy）20 只/页。实测值，不是猜的。
 */
const CONSTITUENT_PER_PAGE = { gn: 10, thshy: 20 };

/**
 * 匿名可访问的服务端页数上限。
 *
 * 实测（2026-10-19）：`/gn/detail/code/301558/page/5/` 正常返回 73631 字节的成分股表，
 * `page/6/` 起一律只有 192 字节的存根，正文是
 * `<script>location.href="//upass.10jqka.com.cn/login?redir=..."</script>` —— 登录墙。
 * 加 Referer / Accept / 伪造 hexin-v cookie 都不改变（各试过一次，全是存根）。
 * 行业板块同样：881126 汽车零部件 page 5 正常、page 6 起跳登录。
 *
 * 后果：概念最多看前 50 只（5 × 10），行业最多看前 100 只（5 × 20）。
 * 这是上游的硬限制，不是本插件的 bug，所以既不能绕也不能假装没有 ——
 * 分页器只能承诺这 5 页，超出部分明确告诉用户去登录。
 */
const FREE_PAGE_LIMIT = 5;

/** 概念板块代码 → 详情页路径段。300816 与 301558 都是概念，路径族相同 */
const KIND_PATH = { gn: 'gn', thshy: 'thshy' };

/** 登录墙存根的特征。用它把「超出免费页数」与「板块没有成分股」区分开 */
function isLoginWall(html) {
  return /upass\.10jqka\.com\.cn\/login/.test(String(html ?? ''));
}

/**
 * 请求一个 HTML 页并按 GBK 解码。
 *
 * 不检查 HTTP 状态码以外的东西：同花顺对不存在的板块代码也返回 200，
 * 只是页面里没有成分股表格，交给出面的解析函数判空。
 */
async function fetchHtml(url, opts = {}) {
  return withRetry(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = () => ctl.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res;
      try {
        res = await fetch(url, { headers: HEADERS, signal: ctl.signal });
      } catch (err) {
        throw new Error(describeError(err));
      }
      if (!res.ok) throw new Error(`同花顺页面 HTTP ${res.status}：${url}`);
      return GBK.decode(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }, { signal: opts.signal });
}

/** 把一段 HTML 里所有 `<td>` 的纯文本取出来，顺带保留行内第一个链接 */
function cellsOf(rowHtml) {
  return [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => ({
    text: m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim(),
    href: (m[1].match(/href="([^"]+)"/) ?? [])[1] ?? '',
  }));
}

/** 数字兜底：`--`、空串、非数字一律 null，不拿 0 顶上（0 是有意义的值） */
function num(v) {
  const n = Number(String(v ?? '').replace(/[,%]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 从链接里抽 6 位板块代码。
 *
 * 行业榜的行内链接形如 http://q.10jqka.com.cn/thshy/detail/code/881174/
 * 同一个 `<tr>` 里还有领涨股的 stockpage 链接（6 位股票代码），
 * 所以只能从 detail/code 这段里取，不能对整行做 6 位数字匹配。
 */
function boardCodeFromHref(href) {
  return (String(href).match(/\/(?:gn|thshy)\/detail\/code\/(\d{6})\//) ?? [])[1] ?? '';
}

/**
 * 解析行业板块榜的一页。
 *
 * 页面表头实测为：
 * 序号 | 板块 | 涨跌幅(%) | 总成交量(万手) | 总成交额(亿元) | 净流入(亿元) |
 * 上涨家数 | 下跌家数 | 均价 | 领涨股 | 最新价 | 涨跌幅(%)
 *
 * 行内涨跌方向靠 class="c-rise"/"c-fall"，但涨跌幅列本身带正负号，
 * 所以直接用数值判断，不解析 class。
 *
 * @param {string} html 已按 GBK 解码的页面
 * @returns {{items: object[], page: number, totalPages: number}}
 */
export function parseIndustryRank(html) {
  const text = String(html ?? '');
  const ti = text.indexOf('<tbody');
  const tj = text.indexOf('</tbody>', ti);
  if (ti < 0 || tj < 0) return { items: [], page: 1, totalPages: 1 };

  const items = [];
  for (const tr of text.slice(ti, tj).matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const c = cellsOf(tr[1]);
    if (c.length < 6) continue;
    const code = boardCodeFromHref(c[1]?.href ?? '');
    const name = c[1]?.text ?? '';
    if (!code || !name) continue;
    items.push({
      code,
      name,
      changePct: num(c[2]?.text),
      volume: num(c[3]?.text),
      amount: num(c[4]?.text),
      netInflow: num(c[5]?.text),
      upCount: num(c[6]?.text),
      downCount: num(c[7]?.text),
      avgPrice: num(c[8]?.text),
      leader: {
        name: c[9]?.text ?? '',
        price: num(c[10]?.text),
        changePct: num(c[11]?.text),
      },
    });
  }

  const pageInfo = (text.match(/page_info">([^<]*)</) ?? [])[1] ?? '';
  const [, page, totalPages] = /(\d+)\s*\/\s*(\d+)/.exec(pageInfo) ?? [];
  return {
    items,
    page: page ? Number(page) : 1,
    totalPages: totalPages ? Number(totalPages) : 1,
  };
}

/**
 * 解析板块详情页里的「成分股涨跌排行榜」。
 *
 * 为什么必须先定位标题：板块详情页上不止一张表（板块简介、概念图谱、
 * 成分股涨跌排行榜、提示）。直接取页面第一张 table 会抓到「概念图谱」那张，
 * 实测 300816 因此只解析出 1 行，而正确的表在后面。所以先找标题再取其后第一张表。
 *
 * 列顺序实测：序号 | 代码 | 名称 | 现价 | 涨跌幅(%) | 涨跌 | 涨速 | 换手 | 量比 | 振幅 | ...
 * 默认排序就是涨跌幅降序（表头 `field="199112" order="desc" class="cur"`）。
 *
 * @param {string} html 已按 GBK 解码的页面
 * @returns {{items: object[], page: number, totalPages: number, found: boolean}}
 */
export function parseConstituents(html) {
  const text = String(html ?? '');
  const head = text.indexOf('成分股涨跌排行榜');
  // 超出免费页数时上游给的是跳登录的存根，不是「这个板块没有股票」。
  // 两者必须分开，否则界面上会把「看不到」说成「没有」。
  if (head < 0) return { items: [], page: 1, totalPages: 1, found: false, loginWall: isLoginWall(text) };

  const ti = text.indexOf('<tbody', head);
  const tj = text.indexOf('</tbody>', ti);
  if (ti < 0 || tj < 0) return { items: [], page: 1, totalPages: 1, found: false, loginWall: false };

  const items = [];
  for (const tr of text.slice(ti, tj).matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const c = cellsOf(tr[1]);
    if (c.length < 5) continue;
    // 代码可能是 6 位数字也可能带北交所前缀；只要不是 6 位就跳过，
    // 避免把序号列当成代码（序号列在 c[0] 且一定是 1、2、3…）
    const code = c[1]?.text ?? '';
    if (!/^\d{6}$/.test(code)) continue;
    items.push({
      code,
      name: c[2]?.text ?? '',
      // 上市板块：用户买不了创业板，界面上必须一眼看得出，不能靠数字串自己分辨
      board: boardOf(code),
      price: num(c[3]?.text),
      changePct: num(c[4]?.text),
      change: num(c[5]?.text),
      speed: num(c[6]?.text),
      turnover: num(c[7]?.text),
      volRatio: num(c[8]?.text),
      amplitude: num(c[9]?.text),
      amount: c[10]?.text ?? '',
    });
  }

  const pageInfo = (text.slice(head).match(/page_info">([^<]*)</) ?? [])[1] ?? '';
  const [, page, totalPages] = /(\d+)\s*\/\s*(\d+)/.exec(pageInfo) ?? [];
  return {
    items,
    page: page ? Number(page) : 1,
    totalPages: totalPages ? Number(totalPages) : 1,
    found: items.length > 0,
    loginWall: false,
  };
}

/**
 * 拉全部行业板块并按涨跌幅排序。
 *
 * 页面本身已按涨跌幅降序，但只保证单页内有序，跨页要靠合并后重排。
 * 取两页是因为 90 个行业分 2 页（50 + 40）——只取第一页会丢掉跌得最惨的那批。
 *
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{items: object[], at: number}>}
 */
export async function fetchIndustryRank(opts = {}) {
  const first = parseIndustryRank(await fetchHtml(`${Q_BASE}/thshy/`, opts));
  const pages = [first];
  for (let p = 2; p <= first.totalPages; p++) {
    pages.push(parseIndustryRank(await fetchHtml(`${Q_BASE}/thshy/index/page/${p}/`, opts)));
  }
  const seen = new Set();
  const items = [];
  for (const pg of pages) {
    for (const it of pg.items) {
      if (seen.has(it.code)) continue;
      seen.add(it.code);
      items.push(it);
    }
  }
  items.sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity));
  return { items, at: Date.now() };
}

/** 同花顺 dataapi 的 GET + JSON 解，status_code 非 0 视为业务失败 */
async function fetchData(path, params, opts = {}) {
  const url = DATA_BASE + path + (params ? `?${new URLSearchParams(params)}` : '');
  return withRetry(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = () => ctl.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res;
      try {
        res = await fetch(url, { headers: { ...HEADERS, Referer: 'https://data.10jqka.com.cn/', Accept: 'application/json, text/plain, */*' }, signal: ctl.signal });
      } catch (err) {
        throw new Error(describeError(err));
      }
      if (!res.ok) throw new Error(`同花顺 HTTP ${res.status}`);
      const json = await res.json();
      if (json?.status_code !== 0) {
        // 未开盘时这几个接口回 10003「尚未开盘」，属于正常状态。
        // 不区分的话整个板块榜会 500 —— 与涨停池、连板梯队是同一类问题。
        const err = new Error(`同花顺业务错误 status_code=${json?.status_code} ${json?.status_msg ?? ''}`);
        err.thsCode = json?.status_code;
        err.thsMsg = String(json?.status_msg ?? '');
        throw err;
      }
      return json.data;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }, { signal: opts.signal });
}

/**
 * 名称 → 同花顺板块代码。下钻要靠它把「涨停最多的板块」定位到成分股页。
 *
 * 为什么要单独拉两个列表页：涨停板块榜（block_top）给的是概念指数代码 885xxx，
 * 而成分股详情页只认 gn 的 30xxxx 与 thshy 的 881xxx 两套代码，两者不通用。
 * 板块名是唯一稳定的对应键（实测机器人概念 300816 的页面简介里就写着「机器人概念 885517」）。
 *
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<Map<string, {code: string, kind: string}>>}
 */
export async function fetchBoardMap(opts = {}) {
  const map = new Map();
  const pages = [
    { url: `${Q_BASE}/gn/`, kind: 'gn', re: /\/gn\/detail\/code\/(\d{6})\/"[^>]*>([^<]{1,24})</g },
    { url: `${Q_BASE}/thshy/`, kind: 'thshy', re: /\/thshy\/detail\/code\/(\d{6})\/"[^>]*>([^<]{1,24})</g },
  ];
  for (const pg of pages) {
    const html = await fetchHtml(pg.url, opts);
    for (const m of html.matchAll(pg.re)) {
      const name = m[2].trim();
      // 先登记的优先：gn 里可能混进与行业同名的条目，保留先出现的那个
      if (!map.has(name)) map.set(name, { code: m[1], kind: pg.kind });
    }
  }
  return map;
}

/**
 * 涨停最多的板块（同花顺 block_top）。
 *
 * 接口固定只返回 20 个板块，page/limit 参数被忽略（实测传 100 仍是 20），
 * 所以「涨停最多的 10 个」足够，但拿不到全市场板块排名。
 *
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<object[]>} 按涨停家数降序
 */
export async function fetchHotBoards(opts = {}) {
  const data = await fetchData('block_top', { filter: 'HS,GEM2STAR' }, opts);
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((r) => ({
      name: r?.name ?? '',
      thsCode: r?.code ?? '',
      limitUpNum: num(r?.limit_up_num),
      continuousNum: num(r?.continuous_plate_num),
      high: r?.high ?? '',
      days: num(r?.days),
    }))
    .filter((r) => r.name)
    .sort((a, b) => (b.limitUpNum ?? 0) - (a.limitUpNum ?? 0));
}

/**
 * 某个板块的成分股，按涨跌幅降序（页面原生排序）。
 *
 * 概念板块 10 只/页、行业板块 20 只/页，所以「一次要 20 只」在概念上要拉两页拼。
 * 页码换算在这一层做掉，调用方只按 (offset, size) 说话，不必关心两种页宽。
 *
 * @param {string} code 同花顺板块代码，如 300816（概念）或 881155（行业）
 * @param {string} kind gn | thshy
 * @param {{offset?: number, size?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<{items: object[], page: number, totalPages: number}>}
 */
export async function fetchBoardStocks(code, kind, opts = {}) {
  // 集合竞价期间同花顺板块页回 10003，成分股拿不到 —— 那不是故障。
  // 不兜住的话整个下钻接口 500，用户点进板块只能看到报错。
  try {
    return await fetchBoardStocksInner(code, kind, opts);
  } catch (err) {
    if (isNotOpenYet(err)) {
      return { items: [], page: 1, totalPages: 0, totalInBoard: 0, truncated: false, code, kind, empty: true };
    }
    throw err;
  }
}

async function fetchBoardStocksInner(code, kind, opts = {}) {
  const k = KIND_PATH[kind] ? kind : 'gn';
  const perPage = CONSTITUENT_PER_PAGE[k];
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const size = Math.min(Math.max(Math.floor(opts.size ?? 20), 1), 100);

  // 免费能翻到的最大客户端页数（概念 5×10/20=3 页，行业 5×20/20=5 页）。
  // 这个上限只与常量有关，不依赖板块真实大小，所以不需要先探上游总页数。
  const maxClientPages = Math.max(1, Math.ceil((FREE_PAGE_LIMIT * perPage) / size));
  const freeStocks = FREE_PAGE_LIMIT * perPage;

  // 目标区间 [offset, offset+size) 覆盖到的服务端页码
  const fromPage = Math.floor(offset / perPage) + 1;
  const toPage = Math.floor((offset + size - 1) / perPage) + 1;

  // 超出免费页数：不发请求（发了只会拿到登录墙存根，白跑一趟还可能被限流），
  // 直接如实返回「翻不到」。页码夹到最后一页，保证响应自身自洽 ——
  // 否则会出现 page=6 / totalPages=5 这种前端没法渲染的组合。
  if (fromPage > FREE_PAGE_LIMIT) {
    return {
      items: [],
      page: Math.min(Math.floor(offset / size) + 1, maxClientPages),
      totalPages: maxClientPages,
      truncated: true,
      freeStocks,
    };
  }

  // 只请求免费可访问的那几页
  const collected = [];
  let serverPages = 1;
  for (let p = fromPage; p <= Math.min(toPage, FREE_PAGE_LIMIT); p++) {
    const parsed = parseConstituents(await fetchHtml(`${Q_BASE}/${KIND_PATH[k]}/detail/code/${code}/page/${p}/`, opts));
    if (p === fromPage) serverPages = parsed.totalPages;
    // 撞到登录墙就当这一页没取到，不当作「板块没股票」
    if (parsed.loginWall) break;
    collected.push(...parsed.items);
  }

  // 拼页后要按目标区间裁掉前一页多出来、以及最后一页多出来的部分
  const startInCollected = offset - (fromPage - 1) * perPage;
  const items = collected.slice(startInCollected, startInCollected + size);

  const truncated = serverPages > FREE_PAGE_LIMIT;
  const reachablePages = Math.max(1, Math.ceil((Math.min(serverPages, FREE_PAGE_LIMIT) * perPage) / size));

  // 对外统一按「每页 size 条」报页码，不暴露服务端的 10/20 页宽。
  //
  // 刻意不报「板块内共多少只」：只有服务端单页时才能从当前页行数如实得出，
  // 多页时最后一页多半不满，`页数 × 每页只数` 会变成上界而不是真实数量。
  // 报一个偏大的数比不报更容易误导（实测厨卫电器只有 9 只，按页宽算会报 20）。
  return {
    items,
    page: Math.floor(offset / size) + 1,
    // 撞到登录墙时只能按免费上限报页数，不能把 123 页原样抛给前端 ——
    // 那样分页器会承诺 62 页、实际翻到第 3 页就没数据，用户看到的就是「数字不对」
    totalPages: truncated ? maxClientPages : reachablePages,
    ...(truncated ? { truncated: true, freeStocks } : {}),
    ...(serverPages === 1 ? { totalInBoard: items.length } : {}),
  };
}
