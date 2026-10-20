/**
 * HTTP 接口
 *
 * 为什么只注册一条 prefix 路由：webServer 对同一组 (kind, path) 重复注册会抛错，
 * 注册 7 条各自带 disposer 既啰嗦又容易在重载时漏掉清理。一条入口内部再分派，
 * 只有一个 disposer，卸载时不会留下半截路由。
 *
 * 为什么错误码要分开：前端据此决定「显示拿不到」还是「显示解析失败」，
 * 都塞 500 的话界面只能统一显示一句没用的「出错了」。
 *
 * @author cai shan
 * @date 2026-10-19 15:41
 */

import { WATCH_GROUP_ID, normalizeConfig } from './store.js';
import { collectAnalysis } from './analysis.js';
import { pickCandidates } from './ocr.js';

/** 接口前缀。前端与工具共用这一份，避免两边各写一遍写歪 */
export const API_PREFIX = '/api/stock-desk';

/**
 * 本插件的包名。
 *
 * 与 API_PREFIX 里的 slug 不同：slug 是给浏览器用的命名空间（stock-desk），
 * 包名是 boot graph 与 clientModules 认的键（dsh-stock-desk）。两者混用会静默查不到 entry。
 */
export const PKG_NAME = 'dsh-stock-desk';

/** POST 请求体上限；配置就几 KB，给 256 KB 足够且能挡住明显异常的大包 */
const MAX_BODY = 256 * 1024;

/**
 * 图片接口的请求体上限。
 *
 * 单独放宽的原因：一张手机截图 300~800 KB，base64 之后还要再涨三分之一，
 * 用 256 KB 的话正常截图会被当成异常大包直接掐断，而报错看起来像「手机截图不支持」。
 * 8 MB 足够覆盖 4K 截图，又不至于让人拿几十 MB 的图把宿主拖死。
 */
const MAX_IMAGE_BODY = 8 * 1024 * 1024;

/**
 * 允许的图片魔数。
 *
 * 先按字节判类型而不是信任 Content-Type：WinRT 的 BitmapDecoder 认不了的类型会在
 * PowerShell 里抛一句很含糊的异常，不如在这里直接说「这个格式不支持」。
 * 实测 png/jpeg 都可用；webp 是浏览器粘贴最常见的非 png/jpeg 来源，一律拒绝并提示另存。
 */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  return null;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // 行情数据没有缓存价值，让浏览器每次都问插件要
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 读请求体，超限直接断开 */
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 注册接口。
 *
 * @param {object} ctx Cordis 上下文
 * @param {object} deps
 * @param {object} deps.market 组合层
 * @param {object} deps.store 配置仓库
 * @returns {() => void} 卸载函数
 */
export function registerRoutes(ctx, deps) {
  const { market, store, ocr } = deps;

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      json(res, 400, { ok: false, error: '请求地址无法解析' });
      return;
    }

    const path = url.pathname.slice(API_PREFIX.length) || '/';
    const q = url.searchParams;
    const method = (req.method ?? 'GET').toUpperCase();

    // 交易时段内行情每次都不一样，不该被缓存
    try {
      if (method === 'GET') {
        switch (path) {
          case '/state': return json(res, 200, { ok: true, data: await handleState() });
          case '/diag': return json(res, 200, { ok: true, data: await handleDiag() });
          case '/dashboard': return json(res, 200, { ok: true, data: await handleDashboard(q) });
          case '/quote': return json(res, 200, { ok: true, data: await handleQuote(q) });
          case '/kline': return json(res, 200, { ok: true, data: await handleKline(q) });
          case '/minute': return json(res, 200, { ok: true, data: await handleMinute(q) });
          case '/avg': return json(res, 200, { ok: true, data: await handleAvg(q) });
          case '/analysis': return json(res, 200, { ok: true, data: await handleAnalysis(q) });
      case '/sectors': return json(res, 200, { ok: true, data: await handleSectors(q) });
          case '/board': return json(res, 200, { ok: true, data: await handleBoard(q) });
          case '/pool': return json(res, 200, { ok: true, data: await handlePool(q) });
          case '/search': return json(res, 200, { ok: true, data: await handleSearch(q) });
          case '/ocr': return json(res, 200, { ok: true, data: await handleOcrInfo() });
          default: return json(res, 404, { ok: false, error: `没有这个接口：${path}` });
        }
      }
      if (method === 'POST') {
        // 图片必须用单独的上限读，否则正常截图会被 256 KB 的通用上限当成异常大包掐断
        if (path === '/ocr') {
          const rawImage = await readBody(req, MAX_IMAGE_BODY);
          let imageBody;
          try { imageBody = rawImage ? JSON.parse(rawImage) : {}; } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
          return json(res, 200, { ok: true, data: await handleOcr(imageBody) });
        }
        const raw = await readBody(req);
        let body;
        try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
        switch (path) {
          case '/config': {
            // 前端传的是 {config}，直接丢 body 进 store.save 会把这一层包装也存进配置里
            const saved = await store.save(body?.config ?? body);
            return json(res, 200, { ok: true, data: { config: saved.config, notes: saved.notes, store: store.info() } });
          }
          case '/migrate': return json(res, 200, { ok: true, data: await handleMigrate(body) });
          default: return json(res, 404, { ok: false, error: `没有这个接口：${path}` });
        }
      }
      json(res, 405, { ok: false, error: `不支持的方法：${method}` });
    } catch (err) {
      // 数据源失败与代码 bug 分开报，否则前端无从判断该重试还是该报错
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { ok: false, error: message });
    }
  }

  /**
   * 客户端半边有没有真的被接进启动图。
   *
   * 为什么需要这个接口：插件 fiber 是 active 只说明宿主那半边起来了；浏览器那半边
   * 要靠 boot graph 里的一条 entry 才会被加载，而这件事只有宿主问得到，浏览器里看不到。
   * 于是「装好了但界面不出现」以前只能靠猜。装完先 curl 一下这个接口再刷新页面。
   *
   * @returns {Promise<object>} 客户端 entry 的接入状态
   */
  async function handleDiag() {
    const cm = deps.clientModules;
    if (cm === undefined || cm === null) {
      return { available: false, note: '宿主没有 clientModules 服务，判断不了客户端半边是否接进启动图' };
    }

    let clientPath = null;
    let error = null;
    try {
      clientPath = cm.clientPath(PKG_NAME) ?? null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    let bootEntries = [];
    try {
      bootEntries = (cm.graph()?.entries ?? []).map((e) => e.id);
    } catch {
      // 启动图取不到不影响下面的结论，它只是用来对照的
    }

    const wired = clientPath !== null;
    return {
      available: true,
      packageName: PKG_NAME,
      clientPath,
      wired,
      bootEntries,
      note: wired
        ? '客户端 entry 已在启动图里：刷新浏览器页面即可加载'
        : '启动图里没有本插件的客户端 entry：刷新页面也没用，先查 package.json 的 dsh.client 声明',
      error,
    };
  }

  /** 插件的自我描述：配置存哪、代码池多大、有哪些数据源 */
  async function handleState() {
    const [config, uni] = await Promise.all([store.load(), market.universe.info()]);
    return {
      config,
      store: store.info(),
      universe: uni,
      market: market.info(),
      sources: market.health(),
      at: Date.now(),
    };
  }

  /**
   * 整页数据。
   *
   * 自选代码不从前端传，而是宿主侧读配置自己算——这样「页面显示的自选」
   * 与「agent 工具读到的自选」必然是同一份，不会出现两处不一致。
   */
  async function handleDashboard(q) {
    const config = await store.load();
    // 只取自选分组。指数有独立目录（INDEX_CODES）和自己的卡片，
    // 把全部分组拍平会让自选表里混进指数行，药丸的「自选涨跌家数」也会把指数算进去。
    const watchGroup = config.groups.find((g) => g.id === WATCH_GROUP_ID) ?? config.groups[0];
    const codes = q.get('codes')
      ? q.get('codes').split(',').map((s) => s.trim()).filter(Boolean)
      : (watchGroup?.items ?? []);
    const include = {
      breadth: q.get('breadth') !== '0',
      sectors: q.get('sectors') !== '0',
      sectorHeat: q.get('sectorHeat') !== '0',
      boardRank: q.get('boardRank') !== '0',
      limitPools: q.get('limitPools') !== '0',
      ladder: q.get('ladder') !== '0',
    };
    const dash = await market.dashboard({ codes, include, force: q.get('force') === '1' });
    return { ...dash, config };
  }

  async function handleQuote(q) {
    const codes = (q.get('codes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (codes.length === 0) throw new Error('缺少 codes 参数');
    if (codes.length > 200) throw new Error(`一次最多 200 个代码，收到 ${codes.length} 个`);
    return market.quotes(codes);
  }

  async function handleKline(q) {
    const code = q.get('code');
    if (!code) throw new Error('缺少 code 参数');
    const period = q.get('period') ?? 'day';
    const limit = Math.min(Math.max(Number(q.get('limit')) || 60, 1), 800);
    const [kl, sess] = await Promise.all([market.kline(code, { period, limit }), market.session()]);
    return { ...kl, session: sess };
  }

  /**
   * 单股分析。
   *
   * 与 agent 工具 `stock_analysis` 共用 `lib/analysis.js`：同一份组装逻辑，
   * 界面与模型看到的结论必须一致 —— 两边各算一遍的话，出现分歧时用户无从判断信哪个。
   *
   * 两个周期的 K 线各 800 根，加起来一次要跑几百次统计，所以这里给 15 秒超时，
   * 并且不做缓存：分析结论随当日收盘价变，缓存会把「昨天该加仓」留在今天的界面上。
   */
  async function handleAnalysis(q) {
    const code = (q.get('code') ?? '').trim();
    if (!code) throw new Error('缺少 code 参数');
    const got = await collectAnalysis({ market, store }, code, {});
    if (!got.ok) throw new Error(got.error);
    return got.data;
  }

  async function handleMinute(q) {
    const code = q.get('code');
    if (!code) throw new Error('缺少 code 参数');
    const [mi, sess] = await Promise.all([market.minute(code), market.session()]);
    return { ...mi, session: sess };
  }

  /**
   * 周/月均价。日均价不在这里：实时报价的 avgPrice 就是精确的当日均价，
   * 这张表只补「要额外算」的那两个。
   *
   * 一次最多 50 只：每只要一份日 K，50 只是这套免费接口还不至于被限流的上限。
   */
  async function handleAvg(q) {
    const codes = (q.get('codes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (codes.length === 0) throw new Error('缺少 codes 参数');
    if (codes.length > 50) throw new Error(`一次最多 50 个代码，收到 ${codes.length} 个`);
    const [avgs, sess] = await Promise.all([market.avgPrices(codes), market.session()]);
    return { avgs, session: sess };
  }

  /**
   * 自选股的所属板块（行业 / 地域 / 概念）。
   *
   * 单独一个路由而不是塞进 /dashboard：东财是一个外部站点，
   * 它挂了不该让整页行情跟着 500。前端拿不到就只是不标板块。
   */
  async function handleSectors(q) {
    const codes = (q.get('codes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (codes.length === 0) throw new Error('缺少 codes 参数');
    if (codes.length > 50) throw new Error(`一次最多 50 个代码，收到 ${codes.length} 个`);
    const [sectors, sess] = await Promise.all([market.stockSectors(codes), market.session()]);
    return { sectors, session: sess };
  }

  /**
   * 板块成分股分页。
   *
   * code/kind 由 dashboard 的 boardRank 直接给出（drillCode / drillKind），
   * 前端点格子时原样带回来，不用自己拼。
   * offset/size 是「任一页 size 条」的通用分页，服务端那套 10/20 的页宽在
   * market.boardStocks 里已经换算掉，这里只做参数校验。
   */
  async function handleBoard(q) {
    const code = q.get('code');
    if (!code) throw new Error('缺少 code 参数');
    if (!/^\d{6}$/.test(code)) throw new Error(`板块代码必须是 6 位数字，收到 ${code}`);
    const kind = q.get('kind') === 'thshy' ? 'thshy' : 'gn';
    const offset = Math.max(0, Number(q.get('offset')) || 0);
    const size = Math.min(Math.max(Number(q.get('size')) || 20, 1), 100);
    const [data, sess] = await Promise.all([
      market.boardStocks(code, kind, { offset, size }),
      market.session(),
    ]);
    return { ...data, code, kind, offset, size, session: sess };
  }

  /**
   * 涨停 / 炸板 / 跌停三个池的名单。格子点下去看的就是它们。
   *
   * 三个池的来源不同，所以各自带 source 字段如实标注：
   * 涨停与炸板走同花顺的池（字段更全：连板高度、首封时间、涨停原因），
   * 跌停没有现成接口，走本地全市场扫描。
   *
   * 注意每个格子的数字必须与它自己的列表条数一致，所以前端取数字时：
   * 涨停/炸板取 overview（同花顺口径），跌停取 limitPools（本地扫描口径）。
   * 混着取会出现「格子上 22 家、点进去 27 条」这种看起来像 bug 的偏差。
   */
  async function handlePool(q) {
    const type = q.get('type') ?? 'limitup';
    const limit = Math.min(Math.max(Number(q.get('limit')) || 300, 1), 800);

    /**
     * 给名单补上现价、涨跌幅、上市板块。
     *
     * 为什么要补：同花顺的池只给代码/名称/连板数/涨停原因，**没有价格**。
     * 前端硬摆「现价 / 涨跌」两列就只能显示一排「—」，用户反馈过这点
     * （「涨停什么的我怎么看不到幅度」）。所以在这里用腾讯批量行情补齐。
     *
     * 补不到不算失败：拿不到价格就照原样返回，让界面显示「—」而不是整块报错。
     */
    async function enrich(items) {
      const codes = items.map((x) => x.code).filter(Boolean);
      if (codes.length === 0) return items;
      let got;
      try {
        got = await market.quotes(codes);
      } catch {
        return items;
      }
      const byCode = new Map(got.items.map((x) => [x.code, x]));
      return items.map((x) => {
        const hit = byCode.get(x.code);
        if (!hit) return x;
        return {
          ...x,
          name: hit.name || x.name,
          price: hit.fields?.price ?? null,
          changePct: hit.fields?.changePct ?? null,
          board: hit.board ?? '',
        };
      });
    }

    if (type === 'limitup') {
      const r = await market.limitUpList({ limit });
      return { type, total: r.total, items: await enrich(r.items), source: '同花顺涨停池' };
    }
    if (type === 'broke') {
      const r = await market.brokeList({ limit });
      return { type, total: r.total, items: await enrich(r.items), source: '同花顺炸板池' };
    }
    if (type === 'limitdown') {
      const r = await market.limitLists();
      return { type, total: r.limitDown.length, items: r.limitDown, source: r.source };
    }
    /**
     * 首板：今天涨停、但之前没有连续涨停的个股。
     *
     * 为什么不直接读同花顺的 continue_num：它的 `field` 掩码里没带这个字段，
     * 实测 46 条全是 null。所以改用「涨停池 − 连板梯队」来推：
     * 连板梯队给的是所有连板个股的代码，从涨停池里剔掉它们，剩下的就是首板。
     * 实测两者严丝合缝：46 − 11 = 35，且 11 个连板代码全部出现在涨停池里。
     */
    if (type === 'firstboard') {
      const [pool, ladder] = await Promise.all([
        market.limitUpList({ limit }),
        market.ladder(),
      ]);
      const continued = new Set();
      for (const h of ladder) for (const s of h.stocks ?? []) continued.add(s.code);
      const items = pool.items.filter((x) => !continued.has(x.code));
      return { type, total: items.length, items: await enrich(items), source: '同花顺涨停池 − 连板梯队' };
    }
    throw new Error(`没有这个池：${type}（可用 limitup / broke / limitdown / firstboard）`);
  }

  async function handleSearch(q) {
    const query = q.get('q') ?? '';
    const limit = Math.min(Math.max(Number(q.get('limit')) || 20, 1), 50);
    const [items, uni] = await Promise.all([market.universe.search(query, limit), market.universe.info()]);
    return { items, universe: uni };
  }

  /**
   * 本机能不能做中文 OCR。
   *
   * 界面在打开图片入口前先问一次：这个能力取决于系统装没装中文 OCR 语言包，
   * 不先问的话用户点开面板、贴完图、等到失败，才知道这台机器根本做不了。
   */
  async function handleOcrInfo() {
    if (!ocr) return { probe: { ok: false, langs: [], error: '宿主没有装配 OCR 模块' } };
    return { probe: await ocr.probe() };
  }

  /**
   * 图片 → 候选股票。
   *
   * 只做识别与匹配，不落盘、不改配置：加不加自选由用户在界面上勾，
   * 这样识别错了顶多多一行候选，不会污染自选表。
   */
  async function handleOcr(body) {
    if (!ocr) throw new Error('宿主没有装配 OCR 模块');
    const raw = String(body?.image ?? '');
    if (!raw) throw new Error('缺少 image（dataURL 或 base64）');

    const comma = raw.indexOf(',');
    const b64 = (raw.startsWith('data:') && comma >= 0 ? raw.slice(comma + 1) : raw).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('image 不是合法的 base64');
    const buffer = Buffer.from(b64, 'base64');
    if (buffer.length === 0) throw new Error('image 解出来是空图片');

    const kind = sniffImage(buffer);
    if (!kind) throw new Error('图片格式不支持：只认 PNG / JPEG / BMP / GIF');

    const result = await ocr.recognize(buffer);
    if (!result.ok) throw new Error(`图片识别失败：${result.error}`);

    const [catalog, probe] = await Promise.all([market.universe.catalog(), ocr.probe()]);
    const picked = pickCandidates(result.lines, catalog);
    return {
      lang: result.lang,
      kind,
      bytes: buffer.length,
      lines: result.lines,
      candidates: picked.items,
      unmatched: picked.unmatched,
      catalogSize: catalog.length,
      probe,
    };
  }

  /**
   * 从旧插件迁移自选股。
   *
   * 旧插件 dsh-stock-watch 把配置存在浏览器 localStorage 的 `stocking.config.v1`，
   * 宿主进程读不到，所以只能由前端把读到的东西 POST 上来。
   * 这里直接并入并保存，返回并进了几只；前端据此给一句明确交代，而不是静默吞掉。
   */
  async function handleMigrate(body) {
    if (!body || typeof body !== 'object') throw new Error('请求体必须是对象');
    const raw = body.legacy ?? body;
    const { config: incoming, notes } = normalizeConfig(raw);
    const current = await store.load();
    const before = new Set(current.groups.flatMap((g) => g.items));
    const merged = mergeGroups(current, incoming);
    const saved = await store.save(merged);
    const found = merged.groups.flatMap((g) => g.items).filter((c) => !before.has(c)).length;
    return { found, config: saved.config, notes };
  }

  /**
   * 把迁移来的分组并进现有配置。
   *
   * 取并集而不是覆盖：用户可能已经用新插件加过自选，迁移只该补充，
   * 不该把他刚加的那几只冲掉。按代码去重，现有顺序保持在前。
   *
   * 配对既看 id 也看名字。旧插件的分组根本没有 id，规整时会按名字现推一个：
   * 旧组叫「自选」推出的 id 就是「自选」，而新插件里同义组的 id 是 watch，
   * 只按 id 配对就会把它当成新组推入，界面上于是出现两个「自选」。
   * 实测踩到过：用户刷新页面触发自动迁移后，4 只股票确实并进来了，却多出一个空的重名分组。
   */
  function mergeGroups(current, incoming) {
    const groups = current.groups.map((g) => ({ ...g, items: [...g.items] }));
    const byId = new Map(groups.map((g) => [g.id, g]));
    const byName = new Map(groups.map((g) => [g.name, g]));
    for (const g of incoming.groups) {
      const target = byId.get(g.id) ?? byName.get(g.name);
      if (target) {
        for (const code of g.items) if (!target.items.includes(code)) target.items.push(code);
      } else {
        const clone = { ...g, items: [...g.items] };
        groups.push(clone);
        byId.set(clone.id, clone);
        // 名字登记同样重要：旧插件的分组没有 id，配对只能靠名字，
        // 不登记的话同一批里第二个同义分组又会重复推入。
        byName.set(clone.name, clone);
      }
    }
    return { ...current, groups };
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler });
  return dispose;
}
