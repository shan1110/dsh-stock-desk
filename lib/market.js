/**
 * 上层组合：把三个数据源拼成「一次请求给出整页所需全部数据」
 *
 * 为什么要有这一层：
 * 1. 浏览器只发一个请求就拿到整页，避免前端对三个域各发一次、并各自处理失败。
 * 2. 逐源降级。任何一个源挂掉，页面其余部分照常显示，出问题的那块明确写「拿不到」——
 *    行情场景下显示陈旧数据比显示「拿不到」危险得多，所以绝不回填旧值。
 * 3. agent 工具与前端共用同一份缓存，同一个数据不会被打两次。
 *
 * @author cai shan
 * @date 2026-10-19 15:04
 */

import { createCache, SourceHealth } from './cache.js';
import { fetchQuotes, parseFull, parseBrief, normalizeCodes, fetchKline as fetchTencentKline, fetchMinute as fetchTencentMinute } from './tencent.js';
import { fetchOverview, fetchLadder, fetchLimitUpList, fetchBrokeList, fetchSectorTop , isNotOpenYet } from './ths.js';
import { fetchKline, fetchStockSectors } from './eastmoney.js';
import { fetchIndustryRank, fetchHotBoards, fetchBoardMap, fetchBoardStocks } from './boards.js';
import { resolveSession, pollIntervalMs } from './session.js';
import { createUniverse } from './universe.js';

/** 常用指数；顺序即展示顺序 */
export const INDEX_CODES = [
  { code: 'sh000001', name: '上证指数' },
  { code: 'sz399001', name: '深证成指' },
  { code: 'sz399006', name: '创业板指' },
  { code: 'sh000300', name: '沪深300' },
  { code: 'sh000688', name: '科创50' },
  { code: 'sh000905', name: '中证500' },
];

/** 各数据的缓存时长。盘中按需调小，收盘后可放大到分钟级 */
export const TTL = {
  quote: 3000,
  overview: 10000,
  ladder: 60000,
  sector: 60000,
  sectorHeat: 60000,
  /** 行业板块榜整页重扫一遍要 2 个请求，60 秒够用 */
  boardRank: 60000,
  /** 板块名→代码映射一天之内基本不变，6 小时刷新一次足够 */
  boardMap: 6 * 60 * 60 * 1000,
  /** 成分股分页，翻页时同一页可能在几秒内被重复点开 */
  boardStocks: 60000,
  kline: 60000,
  breadth: 30000,
  /** 个股的行业/概念归属几乎不变，跟 boardMap 一样 6 小时 */
  stockSector: 6 * 60 * 60 * 1000,
};

export function createMarket(deps = {}) {
  const cache = deps.cache ?? createCache();
  const universe = deps.universe ?? createUniverse();

  const health = {
    tencent: new SourceHealth('腾讯行情'),
    ths: new SourceHealth('同花顺涨停池'),
    // 板块榜与成分股走同花顺的网页而不是 dataapi，失败模式不同（HTML 结构变了 vs JSON 报错），
    // 分开计健康度，否则一个挂掉会把另一个也熔断掉
    thsBoard: new SourceHealth('同花顺板块'),
    em: new SourceHealth('东方财富'),
  };

  /**
   * 给一次数据源调用套上健康度记录。
   *
   * 连续失败到阈值后直接快速失败，不再让每个请求先等满 5 秒超时；
   * 冷却期一过自动重试，接口偶发抖动不会变成长时间不可用。
   */
  function guarded(source, fn) {
    const h = health[source];
    return async (...args) => {
      if (!h.available()) {
        throw new Error(`${h.name} 连续失败 ${h.failures} 次，暂不可用：${h.lastError ?? '未知原因'}`);
      }
      try {
        const r = await fn(...args);
        h.ok();
        return r;
      } catch (err) {
        h.fail(err);
        throw err;
      }
    };
  }

  const rawQuotes = guarded('tencent', (codes, opts) => fetchQuotes(codes, opts));
  const rawOverview = guarded('ths', (opts) => fetchOverview(opts));
  const rawLadder = guarded('ths', (opts) => fetchLadder(opts));
  const rawSectorTop = guarded('ths', (opts) => fetchSectorTop(opts));
  const rawIndustryRank = guarded('thsBoard', (opts) => fetchIndustryRank(opts));
  const rawHotBoards = guarded('thsBoard', (opts) => fetchHotBoards(opts));
  const rawBoardMap = guarded('thsBoard', (opts) => fetchBoardMap(opts));
  const rawBoardStocks = guarded('thsBoard', (code, kind, opts) => fetchBoardStocks(code, kind, opts));

  /**
   * 成分股的容错外壳。
   *
   * 为什么要在这一层再兜一次：guarded() 的熔断器会自己抛「连续失败 N 次」，
   * 那个错误是在 fetchBoardStocks 内部的 try/catch 之外抛的，
   * 光靠 lib/boards.js 里的容错盖不住 —— 实测集合竞价期间 /board 仍然 500。
   * 熔断错误的消息里带着原始原因，交给 isNotOpenYet 判断即可。
   */
  async function boardStocksSafe(code, kind, opts) {
    try {
      return await rawBoardStocks(code, kind, opts);
    } catch (err) {
      if (isNotOpenYet(err)) {
        return { items: [], page: 1, totalPages: 0, totalInBoard: 0, truncated: false, code, kind, empty: true };
      }
      throw err;
    }
  }
  const rawKlineEm = guarded('em', (code, opts) => fetchKline(code, opts));
  const rawTencentKline = guarded('tencent', (code, opts) => fetchTencentKline(code, opts));
  const rawTencentMinute = guarded('tencent', (code, opts) => fetchTencentMinute(code, opts));

  /**
   * K 线双源：日/周/月走腾讯，分钟线走东财。
   *
   * 方案 §6 定的就是「K 线主源腾讯、东财后备」，但实现里只连了东财，
   * 于是东财一限流 K 线整个没有（2026-10-19 实测 /kline 直接 500）。
   * 两边能力正好互补：腾讯只给日/周/月，东财给分钟；腾讯不给成交额/换手率，
   * 东财给。所以先试腾讯，它不支持或失败再退东财 —— 谁挂了都还有图看。
   *
   * 腾讯失败时会记进 'tencent' 那个熔断器，与报价共用计数，
   * 不另开一路 —— 同一个域名，没必要分开退避。
   */
  async function rawKline(code, opts = {}) {
    const period = opts.period ?? 'day';
    const tencentCan = period === 'day' || period === 'week' || period === 'month';
    if (tencentCan) {
      try {
        return await rawTencentKline(code, opts);
      } catch (err) {
        // 腾讯这条挂了不该让整个请求失败，退到东财；东财也挂才把两次原因都报出来
        try {
          return await rawKlineEm(code, opts);
        } catch (emErr) {
          throw new Error(`腾讯：${err.message}；东财：${emErr.message}`);
        }
      }
    }
    return rawKlineEm(code, opts);
  }

  /**
   * 取一批报价，解析成带品种适配的完整对象。
   *
   * 请求不到或品种不认识的代码会出现在 missing 里如实返回，
   * 不伪造一行占位数据。
   *
   * @param {string[]} codes
   * @param {{signal?: AbortSignal, force?: boolean}} [opts]
   */
  async function quotes(codes, opts = {}) {
    /**
     * 先归一化再取数。
     *
     * 这里曾经直接拿调用方给的原始代码去查 fetchQuotes 返回的 Map，
     * 而那个 Map 是以**归一化后**的代码（sz300911）为键的 —— 于是裸 6 位代码永远查不到，
     * 全部落进 missing。自选股一直是带前缀的写法，所以这个 bug 藏了很久；
     * 板块成分股给的恰好是裸 6 位，表现就是「个股详情一直是空的 / 卡在正在取数」。
     *
     * 顺带：腾讯本身也不认裸 6 位（实测 q=300911 直接不返回这一条），
     * 所以归一化既是为了内部一致，也是请求能成功的前提。
     */
    const pairs = [];
    // 认不出来的写法要如实回报，不能悄悄丢掉 —— 调用方得知道「你给的这串我没认」。
    const invalid = [];
    for (const raw of codes ?? []) {
      if (typeof raw !== 'string' || !raw) { if (raw !== undefined && raw !== null && raw !== '') invalid.push(raw); continue; }
      const norm = normalizeCodes([raw])[0];
      if (norm) pairs.push({ raw, norm });
      else invalid.push(raw);
    }
    // 同一只票的多种写法只保留第一次出现的，避免重复请求与重复行
    const rawOf = new Map();
    for (const p of pairs) if (!rawOf.has(p.norm)) rawOf.set(p.norm, p.raw);
    const list = [...rawOf.keys()];
    if (list.length === 0) return { items: [], missing: invalid, at: Date.now() };

    const key = `q:${list.slice().sort().join(',')}`;
    const map = await cache.get(key, TTL.quote, (signal) => rawQuotes(list, { signal, ...opts }), opts);

    const items = [];
    const missing = [...invalid];
    for (const norm of list) {
      const f = map.get(norm);
      if (!f) { missing.push(rawOf.get(norm)); continue; }
      const parsed = parseFull(norm, f);
      if (!parsed) { missing.push(rawOf.get(norm)); continue; }
      // code 统一成归一化后的写法（下游取价/拼图都靠它）；
      // requested 保留调用方原本传的写法，前端拿它对回自己手里的字符串。
      items.push({ ...parsed, requested: rawOf.get(norm) });
    }
    // 保持调用方给的顺序，前端就不用再排一次
    const order = new Map(list.map((c, i) => [c, i]));
    items.sort((a, b) => order.get(a.code) - order.get(b.code));
    return { items, missing, at: Date.now() };
  }

  /** 涨跌停家数 + 交易状态（同花顺，1 个请求） */
  async function overview(opts = {}) {
    return cache.get('overview', TTL.overview, (signal) => rawOverview({ signal, ...opts }), opts);
  }

  /** 连板梯队 */
  async function ladder(opts = {}) {
    return cache.get('ladder', TTL.ladder, (signal) => rawLadder({ signal, ...opts }), opts);
  }

  /** 板块涨停分布（同花顺，含涨停家数与最高板） */
  async function sectorHeat(opts = {}) {
    return cache.get('sector-heat', TTL.sectorHeat, (signal) => rawSectorTop({ signal, ...opts }), opts);
  }

  /**
   * 行业板块涨跌幅榜（同花顺网页，90 个行业，已按涨跌幅降序）。
   *
   * 为什么不是东财：东财 clist/get 被按路径拦截，板块榜长期拿不到。
   * 为什么只有行业没有概念：同花顺的概念列表页（/gn/）是「概念新服」表，
   * 只有日期/驱动事件/龙头股/成分股数量，没有涨跌幅；行业列表页（/thshy/）
   * 才是涨跌幅榜。概念板块的行情没有可用的免费数据源，不编。
   *
   * @param {{signal?: AbortSignal, force?: boolean}} [opts]
   */
  async function industryRank(opts = {}) {
    return cache.get('board-industry', TTL.boardRank, (signal) => rawIndustryRank({ signal }), opts);
  }

  /** 涨停板块榜（同花顺 block_top，固定 20 个板块，按涨停家数降序） */
  async function hotBoards(opts = {}) {
    return cache.get('board-hot', TTL.boardRank, (signal) => rawHotBoards({ signal }), opts);
  }

  /** 板块名 → 同花顺代码 + 类别；下钻时用 */
  async function boardMap(opts = {}) {
    return cache.get('board-map', TTL.boardMap, (signal) => rawBoardMap({ signal }), opts);
  }

  /**
   * 板块格子要的两个维度，一次取齐。
   *
   * up / down 来自行业板块榜的两端，limit 来自涨停板块榜。
   * limit 里的每一项都带上同花顺代码与类别，前端点格子时可以直接下钻，
   * 不用再回宿主查一次映射。
   *
   * 某一维度失败不影响另一个：用 allSettled 分别收。
   *
   * @param {{limit?: number, signal?: AbortSignal, force?: boolean}} [opts]
   * @returns {Promise<{up: object[], down: object[], limit: object[], at: number}>}
   */
  async function boardRank(opts = {}) {
    const n = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const [rankR, hotR, mapR] = await Promise.allSettled([
      industryRank(opts), hotBoards(opts), boardMap(opts),
    ]);

    const out = { up: [], down: [], limit: [], at: Date.now() };
    const errors = {};
    if (rankR.status === 'fulfilled') {
      const items = rankR.value.items;
      out.up = items.slice(0, n);
      // 跌最狠取尾部并反转为「跌得最多在前」
      out.down = items.slice(-n).reverse();
    } else {
      errors.industry = reason(rankR.reason);
    }
    if (hotR.status === 'fulfilled') {
      const map = mapR.status === 'fulfilled' ? mapR.value : new Map();
      out.limit = hotR.value.slice(0, n).map((b) => {
        const t = map.get(b.name);
        // 映射不到就把 drillCode 留空，前端据此把格子画成不可点，
        // 而不是点下去弹一个空面板
        return { ...b, drillCode: t?.code ?? '', drillKind: t?.kind ?? '' };
      });
    } else {
      errors.hot = reason(hotR.reason);
    }
    return errors.industry || errors.hot ? { ...out, errors } : out;
  }

  /**
   * 某个板块的成分股，按涨跌幅降序，客户端指定 offset/size 分页。
   *
   * @param {string} code 同花顺板块代码（概念 30xxxx / 行业 881xxx）
   * @param {string} kind gn | thshy
   * @param {{offset?: number, size?: number, signal?: AbortSignal, force?: boolean}} [opts]
   */
  async function boardStocks(code, kind, opts = {}) {
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const size = Math.min(Math.max(Math.floor(opts.size ?? 20), 1), 100);
    return cache.get(`board-stocks:${code}:${offset}:${size}`, TTL.boardStocks,
      (signal) => boardStocksSafe(code, kind, { offset, size, signal }), opts);
  }

  /**
   * 板块涨跌幅榜（兼容旧签名）。
   *
   * 数据源已从东财换成同花顺行业榜，但仍按旧的字段形状返回，
   * 这样 agent 工具 sector_rank 不用改：
   * mainNetInflow 统一成「元」（同花顺给的是亿元），leader 统一成名称字符串。
   *
   * board='concept' 明确报错而不是偷偷返回行业数据 —— 概念板块没有可用的行情源，
   * 拿行业数据冒充会让 agent 得出错误结论。
   *
   * @param {{board?: 'industry'|'concept', direction?: 'up'|'down', limit?: number, signal?: AbortSignal}} [opts]
   */
  async function sectors(opts = {}) {
    const board = opts.board ?? 'industry';
    if (board === 'concept') {
      throw new Error('概念板块涨跌幅暂无可用的免费数据源：东财 clist 被按路径拦截，同花顺概念列表页不提供涨跌幅。只有行业板块可用（传 board=industry）');
    }
    const direction = opts.direction === 'down' ? 'down' : 'up';
    const limit = Math.min(Math.max(opts.limit ?? 12, 1), 90);
    const all = await industryRank(opts);
    const items = (direction === 'down' ? [...all.items].reverse() : all.items).slice(0, limit);
    return {
      board,
      direction,
      total: all.items.length,
      items: items.map((s) => ({
        code: s.code,
        name: s.name,
        changePct: s.changePct,
        // 同花顺给亿元，工具里按元除以 1e8 展示，这里换算回元保持口径一致
        mainNetInflow: Number.isFinite(s.netInflow) ? s.netInflow * 1e8 : null,
        upCount: s.upCount,
        downCount: s.downCount,
        leader: s.leader?.name ?? '',
        leaderPrice: s.leader?.price ?? null,
        leaderChangePct: s.leader?.changePct ?? null,
        amount: s.amount,
      })),
      at: all.at,
    };
  }

  /**
   * K 线。
   * @param {string} code
   * @param {{period?: string, limit?: number, signal?: AbortSignal}} [opts]
   */
  async function kline(code, opts = {}) {
    const period = opts.period ?? 'day';
    const limit = opts.limit ?? 60;
    return cache.get(`k:${code}:${period}:${limit}`, TTL.kline,
      (signal) => rawKline(code, { period, limit, signal }), opts);
  }

  /**
   * 当日分时。只有腾讯一个源 —— 东财的分时在 trends2 上，字段与口径都要另写一套，
   * 而腾讯这个接口个股和指数都实测可用，先不做第二源。
   * 真挂了会抛错，界面上显示「数据暂不可用」，不会静默给一张空图。
   *
   * 分时是当天的高频数据，缓存比 K 线短：60 秒会把盘中急涨急跌盖掉。
   *
   * @param {string} code
   * @param {{signal?: AbortSignal}} [opts]
   */
  async function minute(code, opts = {}) {
    return cache.get(`m:${code}`, 15000,
      (signal) => rawTencentMinute(code, { signal }), opts);
  }

  /**
   * 全市场扫描：涨跌家数、涨停/跌停/炸板家数。
   *
   * 为什么自己做而不找现成接口：市面上的涨跌家数接口要么要签名要么已停更。
   * 本机扫全市场只要 7 个请求（腾讯一次 800 只）、实测约 2.9 秒，
   * 且口径完全自主——涨停判定用接口给的涨停价，不用「涨幅 ≥ 9.9%」这种一刀切，
   * 所以 ST 的 5cm、创业板的 20cm、科创板的 20cm 都能判对。
   *
   * @param {{signal?: AbortSignal, force?: boolean}} [opts]
   */
  async function breadth(opts = {}) {
    const all = await universe.all();
    if (all.length === 0) throw new Error('代码池为空，无法扫描全市场');
    const codes = all.map((s) => s.code);
    const key = `breadth:${codes.length}`;
    const map = await cache.get(key, TTL.breadth, (signal) => rawQuotes(codes, { signal, timeoutMs: 20000 }), opts);

    let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0, burst = 0, counted = 0;
    // 全市场成交额累加（万元）。口径与涨跌家数完全一致 —— 用的是同一批个股，
    // 所以两个数字永远来自同一次扫描，不会出现「家数是一个时点、成交额是另一个时点」。
    let amountWan = 0;
    for (const [code, f] of map) {
      const b = parseBrief(code, f);
      // 只统计个股：代码池里本就没有指数与 ETF，这里再挡一道，
      // 避免以后改池子时把指数算进涨跌家数
      if (!b || b.kind !== 'stock') continue;
      counted++;
      amountWan += b.amount ?? 0;
      if (b.changePct > 0) up++;
      else if (b.changePct < 0) down++;
      else flat++;
      if (b.atLimitUp) limitUp++;
      if (b.atLimitDown) limitDown++;
      if (b.burst) burst++;
    }

    return {
      up, down, flat, limitUp, limitDown, burst,
      // 万元 → 元。腾讯的成交额字段单位是万元，这里统一成元再交给前端，
      // 免得每个消费方各自乘一次、各自乘错一次。
      amount: Math.round(amountWan * 10000),
      counted,
      total: codes.length,
      missing: codes.length - counted,
      at: Date.now(),
    };
  }

  /**
   * 涨停 / 跌停 / 炸板 三份名单，全部来自本地全市场扫描。
   *
   * 为什么跌停要自己扫：同花顺只有 limit_up_pool 与 open_limit_pool 两个池，
   * 跌停池试了 13 个候选路径名（limit_down_pool / down_limit_pool / limit_down / …）
   * 全部 404，没有数据源。
   *
   * 为什么涨停/炸板也用自扫描而不是同花顺的池：口径必须和格子上的数字一致。
   * 实测同一天同花顺 46/20、自扫描 50/24（同花顺的 filter=HS,GEM2STAR 不含 ST，
   * 而且会漏掉个别真实涨停如杰克科技）。跌停既然只能用自扫描，三个格子就统一口径，
   * 否则「跌停 27 家」配「同花顺口径」的另外两个数字，用户会以为插件算错了。
   *
   * 复用 breadth 的缓存键，与涨跌家数共用一次扫描，不额外发请求。
   *
   * @param {{signal?: AbortSignal, force?: boolean}} [opts]
   */
  async function limitLists(opts = {}) {
    const all = await universe.all();
    if (all.length === 0) throw new Error('代码池为空，无法扫描全市场');
    const codes = all.map((s) => s.code);
    const key = `breadth:${codes.length}`;
    const map = await cache.get(key, TTL.breadth, (signal) => rawQuotes(codes, { signal, timeoutMs: 20000 }), opts);

    const limitUp = [];
    const limitDown = [];
    const burst = [];
    for (const [code, f] of map) {
      const b = parseBrief(code, f);
      // 指数与 ETF 不进这三个池，与涨跌家数同一套筛选
      if (!b || b.kind !== 'stock') continue;
      const row = { code, name: b.name, price: b.price, changePct: b.changePct, board: b.board };
      if (b.atLimitUp) limitUp.push(row);
      if (b.atLimitDown) limitDown.push(row);
      if (b.burst) burst.push(row);
    }
    // 排序要稳定：同涨跌幅时按代码，否则每次刷新顺序会跳
    const byPctDesc = (a, b) => (b.changePct - a.changePct) || a.code.localeCompare(b.code);
    limitUp.sort(byPctDesc);
    limitDown.sort((a, b) => (a.changePct - b.changePct) || a.code.localeCompare(b.code));
    burst.sort(byPctDesc);
    return { limitUp, limitDown, burst, at: Date.now(), source: '本地全市场扫描（腾讯行情）' };
  }

  /** 三个池的家数。给格子用，不把整份名单塞进每次轮询的 dashboard */
  async function limitPools(opts = {}) {
    const r = await limitLists(opts);
    return {
      limitUp: r.limitUp.length,
      limitDown: r.limitDown.length,
      burst: r.burst.length,
      at: r.at,
      source: r.source,
    };
  }

  /**
   * 交易状态。优先用同花顺服务器自报的 trade_status；
   * 同花顺挂掉时回落本地时钟粗判，并标注来源，让用户知道这条是不是可信。
   */
  async function session(opts = {}) {
    try {
      const ov = await overview(opts);
      return resolveSession(ov.tradeStatus);
    } catch {
      return resolveSession(null);
    }
  }

  /**
   * 整页数据。
   *
   * 用 allSettled 而不是 all：一个源挂掉不该让整页空白。
   * 每个分块都带 ok 标志与错误原因，前端据此渲染「拿不到」而不是留白或补旧值。
   *
   * @param {{codes?: string[], groups?: object[], include?: object, signal?: AbortSignal, force?: boolean}} [opts]
   */
  async function dashboard(opts = {}) {
    const include = { breadth: false, limitPools: false, boardRank: true, sectorHeat: true, ladder: true, ...opts.include };
    const codes = opts.codes ?? [];

    const tasks = {
      session: session(opts),
      watchlist: codes.length ? quotes(codes, opts) : Promise.resolve({ items: [], missing: [], at: Date.now() }),
      indices: quotes(INDEX_CODES.map((i) => i.code), opts),
      overview: overview(opts),
    };
    if (include.ladder) tasks.ladder = ladder(opts);
    if (include.sectorHeat) tasks.sectorHeat = sectorHeat(opts);
    if (include.boardRank) tasks.boardRank = boardRank(opts);
    if (include.breadth) tasks.breadth = breadth(opts);
    // 三个池的家数：与 breadth 共用一次全市场扫描（同一个缓存键），不额外打上游。
    // 跌停的家数只能从这里来 —— 同花顺没有跌停池接口。
    if (include.limitPools) tasks.limitPools = limitPools(opts);

    const names = Object.keys(tasks);
    const settled = await Promise.allSettled(names.map((n) => tasks[n]));

    /** @type {Record<string, unknown>} */
    const parts = {};
    /** @type {Record<string, string>} */
    const errors = {};
    names.forEach((name, i) => {
      const r = settled[i];
      if (r.status === 'fulfilled') parts[name] = r.value;
      else errors[name] = reason(r.reason);
    });

    const sess = parts.session ?? resolveSession(null);
    return {
      at: Date.now(),
      session: sess,
      pollMs: pollIntervalMs(sess),
      indexCatalog: INDEX_CODES,
      parts,
      errors,
      sources: Object.values(health).map((h) => h.snapshot()),
      cache: cache.stats(),
    };
  }

  /**
   * 周均价与月均价。
   *
   * 口径：把周期内各交易日的「收盘价 × 成交量」加权平均，不是成交额加权。
   * 腾讯日 K 一行只有 [日期, 开, 收, 高, 低, 成交量]，没有逐日成交额（2026-10-20 实测），
   * 所以真 VWAP 做不出来；成交量加权已经能压住「缩量涨停那天把均值拉高」这件事，
   * 比算术平均更接近「均价」的本义。
   *
   * 日均价不在这里算：实时报价里的 avgPrice 就是精确的当日成交额加权均价。
   * 周期按自然周（周一起）与自然月，含最新那根 K 线 —— 口径跟着数据走而不是跟着
   * 本机时钟走，否则周一早上拿到上周五的数据会把「本周」算成空。
   *
   * @param {string[]} codes
   * @param {{signal?: AbortSignal, force?: boolean}} [opts]
   * @returns {Promise<Record<string, {week: number|null, month: number|null,
   *   weekFrom: string|null, monthFrom: string|null, bars: number}>>}
   */
  async function avgPrices(codes, opts = {}) {
    const list = [...new Set((codes ?? []).map((c) => String(c ?? '').trim()).filter(Boolean))];
    const out = {};
    // 一次取 40 根日 K：一个自然月最多 23 个交易日，留足余量，也够排掉长假。
    // 不再套一层自己的缓存：kline 自己就有 60 秒缓存，聚合只是几微秒的加法
    const job = async (code) => {
      try {
        const kl = await kline(code, { period: 'day', limit: 40, signal: opts.signal });
        out[code] = summarizeAvg(kl?.candles ?? []);
      } catch {
        // 某一只取不到不该让整张表的均价变成空白，那一只显示「—」即可
        out[code] = EMPTY_AVG;
      }
    };
    // 限 5 并发：一个自选页最多 10 只，全放出去等于对同一个域名开 10 条连接
    for (let i = 0; i < list.length; i += 5) await Promise.all(list.slice(i, i + 5).map(job));
    return out;
  }

  /**
   * 个股所属板块（行业 / 地域 / 概念）。
   *
   * 东财一个批量接口就能给出整张自选表的结果，所以缓存键取「排好序的代码表」：
   * 自选没增删时缓存直接命中，增删一只也就多一次百来字节的请求。
   * TTL 与 boardMap 同量级 —— 行业归属按季度调整，6 小时刷新只是防「改过一次永远不生效」。
   *
   * @param {string[]} codes
   * @param {{signal?: AbortSignal, force?: boolean}} [opts]
   * @returns {Promise<Record<string, {industry: string|null, area: string|null, concepts: string[]}>>}
   */
  async function stockSectors(codes, opts = {}) {
    const list = [...new Set((codes ?? []).map((c) => String(c ?? '').trim().toLowerCase()).filter(Boolean))];
    if (list.length === 0) return {};
    // 排序后再拼键：同样的一批票，调用方换个顺序不该打两次请求
    const key = `sectorOf:${[...list].sort().join(',')}`;
    return cache.get(key, TTL.stockSector, (signal) => fetchStockSectors(list, { signal }), opts);
  }

  return {
    quotes, overview, ladder, sectorHeat, sectors, kline, minute, breadth, session, dashboard,
    avgPrices, stockSectors,
    industryRank, hotBoards, boardMap, boardRank, boardStocks,
    limitLists, limitPools,
    limitUpList: (opts) => fetchLimitUpList(opts),
    brokeList: (opts) => fetchBrokeList(opts),
    universe,
    health: () => Object.values(health).map((h) => h.snapshot()),
    info: () => ({ ttl: TTL, indexes: INDEX_CODES, cache: cache.stats() }),
  };
}

/** 没有成交量的 K 线（停牌、指数缺量）算不出均价，返回这个形状而不是 undefined */
export const EMPTY_AVG = { week: null, month: null, weekFrom: null, monthFrom: null, bars: 0 };

/** "2026-10-20" → 那一周的周一 "2026-10-19"；用 UTC 算，避免本机时区把日期挪一天 */
export function weekStartOf(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y || !m || !d) return null;
  const t = Date.UTC(y, m - 1, d);
  const back = (new Date(t).getUTCDay() + 6) % 7; // 周一=0，周日=6
  return new Date(t - back * 86400000).toISOString().slice(0, 10);
}

/**
 * 把日 K 聚成周均价与月均价。
 *
 * 周期以「最新一根 K 线」为锚，不从本机时钟推：周一早上拿到的是上周五的 K 线，
 * 按本机时钟算「本周」会得到一段空区间，均价直接变成 null。
 *
 * @param {{date: string, close: number|null, volume: number|null}[]} candles 升序
 * @returns {{week: number|null, month: number|null, weekFrom: string|null,
 *   monthFrom: string|null, bars: number}}
 */
export function summarizeAvg(candles) {
  const rows = (candles ?? []).filter((c) => c && /^\d{4}-\d{2}-\d{2}$/.test(String(c.date))
    && Number.isFinite(Number(c.close)) && Number.isFinite(Number(c.volume)) && Number(c.volume) > 0);
  if (rows.length === 0) return { ...EMPTY_AVG };
  // 升序排一遍：接口偶尔会把当天那根放到末尾之外的位置
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last = rows[rows.length - 1];
  const weekFrom = weekStartOf(last.date);
  const monthFrom = String(last.date).slice(0, 8) + '01';

  const weighted = (from) => {
    let pv = 0;
    let vol = 0;
    for (const c of rows) {
      if (String(c.date) < from) continue;
      pv += Number(c.close) * Number(c.volume);
      vol += Number(c.volume);
    }
    // 不在宿主机四舍五入：ETF 的价格是 3 位小数（0.891），统一 round2 会把它抹平。
    // 精度交给客户端按品种决定，宿主机只给原始值
    return vol > 0 ? pv / vol : null;
  };

  return {
    week: weighted(weekFrom),
    month: weighted(monthFrom),
    weekFrom,
    monthFrom,
    bars: rows.filter((c) => String(c.date) >= weekFrom).length,
  };
}

/** 把任意的 rejection 原因转成给人看的短句，避免输出 "[object Object]" */
function reason(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}
