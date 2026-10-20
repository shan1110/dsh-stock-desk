/**
 * HTTP 契约测试：client.js 读到的每一条字段路径，都对着真实响应断言一次。
 *
 * <p>为什么单独建这个文件：第 1 轮出现过 6 处客户端与宿主对不上的问题 ——
 * {ok,data} 信封没拆、store.path 不存在、自选其实取自 config.groups[].items 等等。
 * 当时没有任何测试真正调过这些路由，全靠手写 PowerShell 探针，而探针本身我也会写错
 * （用 $_.price 去读嵌套在 .fields 里的价格，探针返回空，看起来像插件坏了）。
 *
 * <p>断言的值一律来自真实响应 dump，不来自记忆。这正是迁移那个 bug 的成因：
 * 用自己以为的形状当固定装置，测试全绿而缺陷照旧。
 *
 * <p>每条断言写成取值函数而不是路径字符串：路径字符串遇到 groups[0].id 这种下标
 * 没法统一处理，写错一次就是一片假失败。
 *
 * <p>需要 GUI 在跑；地址可用 STOCK_DESK_BASE 覆盖。只读，不发 POST，不改配置。
 *
 * @author cai shan
 * @date 2026-10-19 14:45
 */
const BASE = process.env.STOCK_DESK_BASE || 'http://127.0.0.1:8820/api/stock-desk';

// 未开盘时涨停池、梯队、板块涨停分布、全市场成交额本来就没有数据。
// 这些断言挂钟相关，未开盘应跳过 —— 否则每天早上都是红的。
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  → ${detail}` : ''}`); }
}

// 未开盘时涨停池、梯队、板块涨停分布、全市场成交额本来就没有数据。
// 这些断言依赖挂钟，未开盘应跳过 —— 否则每天早上跑都是红的，红久了没人看。
// 用 /dashboard 判断（/state 上没有 session 字段）。
const _dash = await (async () => {
  try { return (await (await fetch(BASE + '/dashboard')).json())?.data ?? {}; } catch { return {}; }
})();
const CLOSED = _dash?.session?.trading === false;
const SESSION_LABEL = _dash?.session?.label ?? '未知';
/**
 * 需要「今天已经开过盘」才有意义的断言。未开盘时记一次跳过（计入 pass）。
 */
const expectData = (name, cond, extra = '') => {
  if (CLOSED) { pass++; console.log('  SKIP  ' + name + '（' + SESSION_LABEL + '，今天还没有数据）'); return; }
  check(name, cond, extra);
};
const brief = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : (s.length > 64 ? `${s.slice(0, 64)}…` : s);
};

/** 取一个 GET 路由，返回 HTTP 状态与解析后的信封 */
async function get(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(90000) });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON 时留 null，由调用方断言 */ }
  return { status: res.status, body };
}

console.log(`\n【1】GET /state —— 自检与配置页读的就是它\n`);
const state = await get('/state');
check('HTTP 200', state.status === 200, String(state.status));
check('外层是 {ok, data} 信封（客户端读 data，不读 body 本身）',
  state.body?.ok === true && 'data' in (state.body ?? {}));
const S = state.body?.data ?? {};

const STATE_CHECKS = [
  ['config.version', (d) => typeof d.config?.version === 'number'],
  ['config.groups 是数组', (d) => Array.isArray(d.config?.groups)],
  ['config.groups[].id 非空', (d) => d.config?.groups?.every((g) => typeof g.id === 'string' && g.id.length > 0)],
  ['config.groups[].name', (d) => d.config?.groups?.every((g) => typeof g.name === 'string')],
  ['config.groups[].items 是数组', (d) => d.config?.groups?.every((g) => Array.isArray(g.items))],
  // 自选面板与药丸都按 id === 'watch' 去找它；迁移过来的配置也必须命中，否则两处一起落空
  ['有一组 id 是 watch', (d) => d.config?.groups?.some((g) => g.id === 'watch')],
  ['config.ui.colorScheme', (d) => typeof d.config?.ui?.colorScheme === 'string'],
  ['config.ui.density', (d) => typeof d.config?.ui?.density === 'string'],
  ['config.pill.enabled 是布尔', (d) => typeof d.config?.pill?.enabled === 'boolean'],
  ['config.pill.indexCode', (d) => typeof d.config?.pill?.indexCode === 'string'],
  ['store.path 非空', (d) => typeof d.store?.path === 'string' && d.store.path.length > 0],
  ['store.dir', (d) => typeof d.store?.dir === 'string'],
  ['store.rule 说明了落到哪', (d) => typeof d.store?.rule === 'string' && d.store.rule.length > 0],
  ['store.notes 是数组', (d) => Array.isArray(d.store?.notes)],
  ['universe.count 大于 0', (d) => typeof d.universe?.count === 'number' && d.universe.count > 0],
  ['universe.file', (d) => typeof d.universe?.file === 'string'],
  ['market.ttl.quote 是数字', (d) => typeof d.market?.ttl?.quote === 'number'],
  ['market.indexes 非空', (d) => Array.isArray(d.market?.indexes) && d.market.indexes.length > 0],
  ['market.cache.keys', (d) => typeof d.market?.cache?.keys === 'number'],
  ['sources 非空', (d) => Array.isArray(d.sources) && d.sources.length > 0],
  ['sources[].name', (d) => d.sources?.every((s) => typeof s.name === 'string')],
  ['sources[].healthy 是布尔', (d) => d.sources?.every((s) => typeof s.healthy === 'boolean')],
  ['sources[].failures 是数字', (d) => d.sources?.every((s) => typeof s.failures === 'number')],
  ['at 是取数时刻', (d) => typeof d.at === 'number' && d.at > 0],
];
for (const [label, ok] of STATE_CHECKS) {
  let good = false;
  let shown;
  try { good = ok(S) === true; shown = good ? '' : `${label} 处不满足`; } catch (e) { shown = e.message; }
  check(`/state 有 ${label}`, good, shown);
}

console.log(`\n【2】GET /dashboard —— 整页行情台的数据源\n`);
const dash = await get('/dashboard');
check('HTTP 200', dash.status === 200, String(dash.status));
check('外层是 {ok, data} 信封', dash.body?.ok === true && 'data' in (dash.body ?? {}));
const D = dash.body?.data ?? {};

const DASH_CHECKS = [
  ['at 是取数时刻', (d) => typeof d.at === 'number' && d.at > 0],
  ['session.id', (d) => typeof d.session?.id === 'string'],
  ['session.label 非空', (d) => typeof d.session?.label === 'string' && d.session.label.length > 0],
  ['session.trading 是布尔', (d) => typeof d.session?.trading === 'boolean'],
  ['pollMs 大于 0', (d) => typeof d.pollMs === 'number' && d.pollMs > 0],
  ['indexCatalog 非空', (d) => Array.isArray(d.indexCatalog) && d.indexCatalog.length > 0],
  ['indexCatalog[].code', (d) => d.indexCatalog?.every((x) => typeof x.code === 'string')],
  ['indexCatalog[].name', (d) => d.indexCatalog?.every((x) => typeof x.name === 'string')],
  ['parts.watchlist.items 是数组', (d) => Array.isArray(d.parts?.watchlist?.items)],
  ['parts.watchlist.missing 是数组', (d) => Array.isArray(d.parts?.watchlist?.missing)],
  ['parts.watchlist.at', (d) => typeof d.parts?.watchlist?.at === 'number'],
  ['parts.indices.items 非空', (d) => Array.isArray(d.parts?.indices?.items) && d.parts.indices.items.length > 0],
  ['parts.breadth.up', (d) => typeof d.parts?.breadth?.up === 'number'],
  ['parts.breadth.down', (d) => typeof d.parts?.breadth?.down === 'number'],
  ['parts.breadth.flat', (d) => typeof d.parts?.breadth?.flat === 'number'],
  ['parts.breadth.limitUp', (d) => typeof d.parts?.breadth?.limitUp === 'number'],
  ['parts.breadth.limitDown', (d) => typeof d.parts?.breadth?.limitDown === 'number'],
  ['parts.breadth.burst', (d) => typeof d.parts?.breadth?.burst === 'number'],
  ['parts.breadth.counted', (d) => typeof d.parts?.breadth?.counted === 'number'],
  // 全市场成交额（元）。它和涨跌家数来自同一次扫描，所以两个数字必然同一时点。
  // 断言 > 0 而不是断言具体量级：静悄悄的交易日可能只有几千亿，写死会变成天气报告。
  ...(CLOSED ? [] : [['parts.breadth.amount 是正数（元）', (d) => typeof d.parts?.breadth?.amount === 'number' && d.parts.breadth.amount > 0]]),
  ['parts.breadth.amount 与家数同源（统计只数一致时才有意义）',
    (d) => typeof d.parts?.breadth?.counted === 'number' && d.parts.breadth.counted > 0],
  ...(CLOSED ? [] : [['parts.overview.limitUp.today.num', (d) => typeof d.parts?.overview?.limitUp?.today?.num === 'number']]),
  ...(CLOSED ? [] : [['parts.overview.tradeStatus.name', (d) => typeof d.parts?.overview?.tradeStatus?.name === 'string']]),
  ['parts.ladder 是数组', (d) => Array.isArray(d.parts?.ladder)],
  ...(CLOSED ? [] : [['parts.sectorHeat 是数组', (d) => Array.isArray(d.parts?.sectorHeat)]]),
  // 板块格子要的三个维度。整段缺失是合法的降级形态（同花顺网页挂了就是没有），
  // 但只要它存在，形状就必须完整 —— 半截对象会让格子墙渲染成空白且不报错。
  ['parts.boardRank 要么是完整对象要么整段缺失', (d) => d.parts?.boardRank == null
    || (Array.isArray(d.parts.boardRank.up) && Array.isArray(d.parts.boardRank.down)
      && Array.isArray(d.parts.boardRank.limit))],
  ['parts.boardRank.up 的每一项都有板块代码与涨跌幅', (d) => (d.parts?.boardRank?.up ?? [])
    .every((x) => /^\d{6}$/.test(x.code) && typeof x.name === 'string'
      && (x.changePct === null || typeof x.changePct === 'number'))],
  ['parts.boardRank.limit 的每一项都带 drillCode/drillKind（前端点格子要用）',
    (d) => (d.parts?.boardRank?.limit ?? [])
      .every((x) => typeof x.drillCode === 'string' && typeof x.drillKind === 'string')],
  // 三个池的家数。跌停的家数只能从这里来 —— 同花顺没有跌停池接口。
  // 半截对象会让「跌停 N 家」显示成「—」，而点进去却有名单，比不显示更让人困惑。
  ['parts.limitPools 要么是完整对象要么整段缺失', (d) => d.parts?.limitPools == null
    || (typeof d.parts.limitPools.limitUp === 'number'
      && typeof d.parts.limitPools.limitDown === 'number'
      && typeof d.parts.limitPools.burst === 'number')],
  ['config.groups 是数组', (d) => Array.isArray(d.config?.groups)],
  ['sources 是数组', (d) => Array.isArray(d.sources)],
  ['cache.keys', (d) => typeof d.cache?.keys === 'number'],
  // errors 是给 agent 工具读的（lib/tools.js:189/200/214 读 dash.errors.indices 等），
  // 客户端读的是 sources（client.js:486 的 SourceBar，991 行传入）。
  // 两个消费者走两条路 —— 一开始我把它们混成一条，断言成数组，直接红了。
  ['errors 是按分块名索引的对象（不是数组）',
    (d) => d.errors !== null && typeof d.errors === 'object' && !Array.isArray(d.errors)],
  ['errors 里的键都是字符串', (d) => Object.keys(d.errors ?? {}).every((k) => typeof k === 'string')],
  ['errors 里没有 undefined 值',
    (d) => Object.values(d.errors ?? {}).every((v) => v !== undefined)],
  ['客户端依赖的 sources[].name 非空',
    (d) => d.sources?.every((s) => typeof s.name === 'string' && s.name.length > 0)],
];
for (const [label, ok] of DASH_CHECKS) {
  let good = false;
  let shown = '';
  try { good = ok(D) === true; } catch (e) { shown = e.message; }
  check(`/dashboard 有 ${label}`, good, shown);
}

// 板块格子走同花顺（行业板块榜 + 涨停板块榜），东财已整体退出这个功能。
// 同花顺这两个页面是抓 HTML 的，解析一旦跟不上站点改版就会整段缺失 ——
// 所以同样不能断言「一定拿得到」，只能断言两种状态各自合法。
const rank = D.parts?.boardRank;
if (rank == null) {
  console.log('  （同花顺板块榜当前拿不到，板块断言转为验降级）');
  check('板块榜拿不到时整段缺失，而不是给一个半截对象', rank == null, brief(rank));
  check('板块榜拿不到时 errors.boardRank 如实记了一笔',
    typeof D.errors?.boardRank === 'string' && D.errors.boardRank.length > 0,
    brief(D.errors?.boardRank));
} else {
  expectData('涨最狠与跌最狠各 10 个',
    rank.up?.length === 10 && rank.down?.length === 10,
    `${rank.up?.length} / ${rank.down?.length}`);
  // 排序方向反了在界面上同样是「有数字」，只能靠相邻比较锁住
  expectData('涨最狠首位涨幅 >= 次位', (rank.up?.[0]?.changePct ?? -999) >= (rank.up?.[1]?.changePct ?? 999),
    `${rank.up?.[0]?.name} ${rank.up?.[0]?.changePct}% vs ${rank.up?.[1]?.name} ${rank.up?.[1]?.changePct}%`);
  expectData('跌最狠首位跌幅 <= 次位', (rank.down?.[0]?.changePct ?? 999) <= (rank.down?.[1]?.changePct ?? -999),
    `${rank.down?.[0]?.name} ${rank.down?.[0]?.changePct}% vs ${rank.down?.[1]?.name} ${rank.down?.[1]?.changePct}%`);
  expectData('涨和跌不是同一个板块打头', rank.up?.[0]?.code !== rank.down?.[0]?.code,
    `${rank.up?.[0]?.name} / ${rank.down?.[0]?.name}`);
}

console.log(`\n【3】GET /board —— 板块成分股分页（下钻）\n`);
// 银行：42 只，正好 3 页，用它验分页最稳
const bd = await get('/board?code=881155&kind=thshy&offset=0&size=20');
check('HTTP 200', bd.status === 200, String(bd.status));
check('外层是 {ok, data} 信封', bd.body?.ok === true && 'data' in (bd.body ?? {}));
const B = bd.body?.data ?? {};
expectData('一页 20 只（用户要的就是 20/页）', B.items?.length === 20, String(B.items?.length));
check('每行都有 6 位代码、名称与涨跌幅',
  (B.items ?? []).every((x) => /^\d{6}$/.test(x.code) && typeof x.name === 'string'
    && (x.changePct === null || typeof x.changePct === 'number')),
  brief(B.items?.[0]));
check('按涨跌幅降序（默认排序就是它）',
  (B.items ?? []).every((v, i) => i === 0 || (B.items[i - 1].changePct ?? -999) >= (v.changePct ?? 999)),
  (B.items ?? []).slice(0, 3).map((x) => `${x.name} ${x.changePct}%`).join(' | '));
expectData('totalPages 是数字且 >= 1', typeof B.totalPages === 'number' && B.totalPages >= 1, String(B.totalPages));
expectData('回显了分页参数（前端据此对齐页码）',
  B.code === '881155' && B.kind === 'thshy' && B.offset === 0 && B.size === 20,
  `${B.code}/${B.kind}/${B.offset}/${B.size}`);
expectData('带了 session（前端显示交易状态）', typeof B.session?.id === 'string', brief(B.session));

const bd2 = await get('/board?code=881155&kind=thshy&offset=20&size=20');
// 不能断言「零重叠」：成分股按涨跌幅排序，而两页是两次请求、各自的快照。
// 2026-10-20 14:05 实测青岛银行从第 1 页（-1.18%）掉到第 2 页（-1.35%），
// 边界上漂了 2 只 —— 这是上游排序在动，不是分页坏了。
// 真正要防的是「offset 被忽略、两页返回同一批」，那种情况重叠 20 只。
{
  const p2codes = (bd2.body?.data?.items ?? []).map((x) => x.code);
  const overlap = p2codes.filter((c) => (B.items ?? []).some((y) => y.code === c));
  check('第 2 页与第 1 页不是同一批（offset 没被忽略）',
    p2codes.length > 0 && overlap.length <= 3,
    `p1 首 ${B.items?.[0]?.code} p2 首 ${bd2.body?.data?.items?.[0]?.code} 重叠 ${overlap.length} 只：${overlap.join(',')}`);
}
expectData('第 2 页页码是 2', bd2.body?.data?.page === 2, String(bd2.body?.data?.page));

// 概念板块服务端 10 只/页，宿主必须拉两页拼成 20 —— 这条是本次改造最容易错的地方
const bc = await get('/board?code=301558&kind=gn&offset=0&size=20');
expectData('概念板块也能拼出 20 只（服务端只有 10 只/页）',
  bc.body?.data?.items?.length === 20, String(bc.body?.data?.items?.length));
check('概念板块拼页后无重复',
  new Set((bc.body?.data?.items ?? []).map((x) => x.code)).size
    === (bc.body?.data?.items ?? []).length);

check('缺 code 参数时 500 并带原因', (await get('/board')).status === 500);
check('非法 code 时 500 并带原因', (await get('/board?code=abc')).status === 500);

// 同花顺匿名只开放前 5 页成分股（page 5 正常、page 6 起跳 upass 登录墙，实测）。
// 所以大板块的 totalPages 必须被夹住：不能把上游的 123 页原样抛给前端，
// 否则分页器会承诺 62 页、实际翻到第 3 页就没数据 —— 用户报的就是这个
// 「总页数看着像股票数量」。
const bb = await get('/board?code=881126&kind=thshy&offset=0&size=20'); // 汽车零部件，上游 14 页
const BB = bb.body?.data ?? {};
expectData('大行业板块被夹到免费上限 5 页（不是上游的 14 页）',
  BB.totalPages === 5, String(BB.totalPages));
expectData('大板块标了 truncated 并给出免费只数上限',
  BB.truncated === true && BB.freeStocks === 100,
  JSON.stringify({ truncated: BB.truncated, freeStocks: BB.freeStocks }));
expectData('压到免费上限时本页仍有数据（不是空表）', (BB.items?.length ?? 0) === 20, String(BB.items?.length));

const bcBig = await get('/board?code=301558&kind=gn&offset=0&size=20'); // 阿里巴巴概念，上游 35 页
expectData('大概念板块被夹到免费上限 3 页（5×10/20）',
  bcBig.body?.data?.totalPages === 3, String(bcBig.body?.data?.totalPages));

console.log(`\n【4】GET /pool —— 涨停 / 炸板 / 跌停 三个池（格子点下去看的就是它们）\n`);
// 三个池来源不同：涨停与炸板走同花顺的池（字段更全），跌停没有接口、走本地全市场扫描。
// 所以逐池验「响应自洽」：条数要和 total 对得上，否则格子上写着 N 家、点进去 N±1 条。
for (const [type, label] of [['limitup', '涨停'], ['broke', '炸板'], ['limitdown', '跌停'], ['firstboard', '首板']]) {
  const r = await get(`/pool?type=${type}&limit=300`);
  const P = r.body?.data ?? {};
  check(`/pool?type=${type}（${label}）HTTP 200`, r.status === 200, String(r.status));
  check(`${label}池 items 是数组`, Array.isArray(P.items), typeof P.items);
  check(`${label}池条数与 total 一致（格子上的数字 = 点进去的条数）`,
    P.items?.length === Math.min(P.total ?? 0, 300), `items=${P.items?.length} total=${P.total}`);
  check(`${label}池每行都有 6 位代码与名称`,
    // 池里的代码带市场前缀（sh600537），板块格子那套是裸 6 位 —— 两种写法 /quote 都认，
    // 但断言要按各自的真实形状写，否则红的是断言不是代码
    (P.items ?? []).every((x) => /^(sh|sz|bj)?\d{6}$/.test(x.code) && typeof x.name === 'string'),
    brief(P.items?.[0]));
  check(`${label}池标了来源（口径不同，必须能看出来）`,
    typeof P.source === 'string' && P.source.length > 0, P.source);
  check(`${label}池没有重复代码`,
    new Set((P.items ?? []).map((x) => x.code)).size === (P.items ?? []).length);
}
check('/pool 不认识的 type 返回 500 并说明可用值',
  (await get('/pool?type=nope')).status === 500);

// 首板名单 = 涨停池 − 连板梯队。实测 46 − 11 = 35，且 11 个连板代码全在涨停池里。
// 这条把「首板到底能不能下钻」锁死：以前它只是个不可点的推算数字。
if (typeof D.parts?.overview?.limitUp?.today?.num === 'number' && Array.isArray(D.parts?.ladder)) {
  const contCodes = new Set();
  for (const h of D.parts.ladder) for (const s of h.stocks ?? []) contCodes.add(s.code);
  const fb = await get('/pool?type=firstboard&limit=200');
  const fbItems = fb.body?.data?.items ?? [];
  const expect = D.parts.overview.limitUp.today.num - contCodes.size;
  check('首板名单条数 = 涨停家数 − 连板梯队个数',
    fbItems.length === expect,
    `实得 ${fbItems.length}，应为 ${expect}（涨停 ${D.parts.overview.limitUp.today.num} − 连板 ${contCodes.size}）`);
  check('首板名单里不含任何连板个股',
    fbItems.every((x) => !contCodes.has(x.code)));
  check('首板名单每行都补上了价格与上市板块',
    fbItems.every((x) => typeof x.price === 'number' && typeof x.board === 'string' && x.board.length > 0),
    brief(fbItems[0]));
}

// 跌停的家数必须与 dashboard 里 limitPools.limitDown 一致 —— 两处不走同一份数据的话，
// 会出现「格子上 22 家、点进去 27 条」这种看起来像算错的偏差。
const ldPool = await get('/pool?type=limitdown&limit=800');
const ldDash = D.parts?.limitPools?.limitDown;
if (typeof ldDash === 'number') {
  check('跌停池条数与 dashboard 的 limitPools.limitDown 一致',
    ldPool.body?.data?.items?.length === ldDash,
    `池 ${ldPool.body?.data?.items?.length} vs dash ${ldDash}`);
}

// 用户问「指数我能点进去看 K 线吗」。点进去之后真正拉的就是 /kline，
// 所以这里直接验接口：三个常用指数都要能拿到 K 线，否则界面上点了只会是一张空图。
for (const code of ['sh000001', 'sz399006', 'sh000688']) {
  const k = await get(`/kline?code=${code}&period=day&limit=20`);
  check(`指数 ${code} 能取到 K 线`,
    k.status === 200 && (k.body?.data?.candles?.length ?? 0) > 0,
    `candles=${k.body?.data?.candles?.length ?? '-'}`);
}

// limit 的上限是 800，不是 250。这条以前没有断言，于是 250 卡了很久没人发现：
// 数据源本身支持腾讯 800 根 / 东财 500 根，是路由自己把请求截断的。
// 用 002739（2015 年上市，日线足够长）验，若被截到 250 这条必红。
{
  const k = await get('/kline?code=sz002739&period=day&limit=800');
  const n = k.body?.data?.candles?.length ?? 0;
  check('/kline 的 limit 上限是 800 而不是 250', n > 250, `实得 ${n} 根`);
  const w = await get('/kline?code=sz002739&period=week&limit=800');
  const wn = w.body?.data?.candles?.length ?? 0;
  check('周线也能取到 250 根以上（覆盖十年股性）', wn > 250, `实得 ${wn} 根`);
}

console.log(`\n【4.4a2】GET /analysis —— 「能不能加仓」块\n`);
// 界面那块与 agent 工具 stock_analysis 共用 lib/analysis.js，所以这里验的是
// 「两条路拿到的是同一份结构」——分开写两份迟早出现互相矛盾的结论。
{
  const a = await get('/analysis?code=sz002739');
  const d = a.body?.data;
  check('/analysis 返回 ok', a.status === 200 && a.body?.ok === true, `status=${a.status}`);
  check('/analysis 带四条判定且都是布尔',
    ['edge', 'pos', 'trigger', 'ratio'].every((k) => typeof d?.plan?.four?.[k] === 'boolean'),
    JSON.stringify(d?.plan?.four));
  check('/analysis 的加仓位要么是数字要么是 null（不许空字符串）',
    d?.plan?.addZone === null || typeof d?.plan?.addZone === 'number', String(d?.plan?.addZone));
  check('/analysis 没通过时写明卡在哪几条',
    !d?.plan?.ok ? Array.isArray(d?.plan?.addWhy) && d.plan.addWhy.length > 0 : true,
    JSON.stringify(d?.plan?.addWhy));
  check('/analysis 带历史频率全表与基准',
    Array.isArray(d?.rows) && d.rows.length > 0 && Array.isArray(d?.baselines) && d.baselines.length > 0,
    `${d?.rows?.length} 行 / ${d?.baselines?.length} 个基准`);
  check('/analysis 每行都带区间或明确 null',
    (d?.rows ?? []).every((r) => r.ci === null || (Array.isArray(r.ci) && r.ci[0] <= r.ci[1])));
  check('/analysis 不把明细数组塞进 payload（界面用不上，白占体积）',
    (d?.rows ?? []).every((r) => r.returns === undefined && r.phases === undefined));
  check('/analysis 带位置表且每条都有编号',
    Array.isArray(d?.levels?.items) && d.levels.items.length > 0 && d.levels.items.every((x) => typeof x.id === 'string'));
  check('/analysis 缺 code 时 4xx 且给出原因',
    (await get('/analysis')).status >= 400);
  const bad = await get('/analysis?code=zzzzzz');
  check('/analysis 未知代码 4xx 而不是静默返回空表', bad.status >= 400, `status=${bad.status}`);
}
console.log(`\n【4.4b】GET /avg —— 自选表的周/月均价\n`);
// 自选表把换手、成交额换成了三条均价。日均价走实时报价的 avgPrice，
// 周/月走这个接口；它断了的话界面上那两列永远是「—」，而且不会有任何报错。
{
  const r = await get('/avg?codes=sh600519,sz300750');
  const avgs = r.body?.data?.avgs ?? {};
  check('/avg 两个代码都有结果',
    r.status === 200 && Object.keys(avgs).length === 2, Object.keys(avgs).join(','));
  check('/avg 周/月均价都是正数',
    ['sh600519', 'sz300750'].every((c) => Number(avgs[c]?.week) > 0 && Number(avgs[c]?.month) > 0),
    ['sh600519', 'sz300750'].map((c) => `${c}=${avgs[c]?.week ?? '-'}/${avgs[c]?.month ?? '-'}`).join(' '));
  // 周期锚在最新那根日 K 上，周起点必须是周一。写成断言是为了防止哪天改成按本机时钟算 ——
  // 那样周一早上拿到上周五的数据时，「本周」会是空区间，均价直接变 null
  check('/avg 的周起点是周一',
    /^\d{4}-\d{2}-\d{2}$/.test(avgs.sh600519?.weekFrom ?? '')
    && new Date(`${avgs.sh600519.weekFrom}T00:00:00Z`).getUTCDay() === 1,
    String(avgs.sh600519?.weekFrom));
  // 空 codes 必须明确报错：静默返回空对象的话，界面只会显示「—」，看不出是参数错了
  const empty = await get('/avg?codes=');
  check('/avg 缺 codes 时明确报错', empty.status !== 200 && Boolean(empty.body?.error),
    `${empty.status} ${empty.body?.error ?? ''}`);
}

console.log(`\n【4.4c】GET /sectors —— 自选股的所属板块\n`);
// 名称后面那行小字来自这里。它断了不会报错，只是全表不再标板块，
// 所以契约层必须有断言盯着「字段名」和「ETF 落空」这两件事。
{
  const r = await get('/sectors?codes=sh600519,sz000002,sh510300');
  const sec = r.body?.data?.sectors ?? {};
  check('/sectors 三个代码都有结果',
    r.status === 200 && Object.keys(sec).length === 3, Object.keys(sec).join(','));
  // 字段名是 f100/f102/f103 解码后的 industry/area/concepts，改名等于前端整块失效
  check('/sectors 个股给出 industry 与 area',
    'industry' in (sec.sh600519 ?? {}) && 'area' in (sec.sh600519 ?? {})
    && Boolean(sec.sh600519?.industry) && Boolean(sec.sh600519?.area),
    JSON.stringify(sec.sh600519 ?? null));
  check('/sectors 的概念是字符串数组',
    Array.isArray(sec.sz000002?.concepts) && sec.sz000002.concepts.every((s) => typeof s === 'string'),
    JSON.stringify(sec.sz000002?.concepts ?? null));
  // ETF 没有行业归属：必须是 null 而不是 "-" 或空字符串，否则界面会画出一个小标签
  check('/sectors 的 ETF 没有行业，且是 null 不是 "-"',
    sec.sh510300?.industry === null && Array.isArray(sec.sh510300.concepts)
    && sec.sh510300.concepts.length === 0, JSON.stringify(sec.sh510300 ?? null));
  const empty = await get('/sectors?codes=');
  check('/sectors 缺 codes 时明确报错', empty.status !== 200 && Boolean(empty.body?.error),
    `${empty.status} ${empty.body?.error ?? ''}`);
}

console.log(`\n【4.4d】POST /config —— 药丸换指数靠这条写回去\n`);
// 药丸的左右切换会把新指数写进 config.pill.indexCode。这条路径断了的表现是
// 「当场切了、刷新又变回上证指数」，而不会有任何报错。
// 这里用「原值写回」验：既证明写路径认 pill.indexCode，也证明它不会顺手把 positions 抹掉。
{
  const before = S.config ?? {};
  const same = { ...before, pill: { ...(before.pill ?? {}), indexCode: before.pill?.indexCode ?? 'sh000001' } };
  const res = await fetch(`${BASE}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: same }),
    signal: AbortSignal.timeout(90000),
  });
  const body = await res.json().catch(() => null);
  check('POST /config 原值写回成功', res.status === 200 && body?.ok === true, `${res.status} ${body?.error ?? ''}`);
  check('写回后 pill.indexCode 还在（没有被 normalize 丢掉）',
    typeof body?.data?.config?.pill?.indexCode === 'string',
    String(body?.data?.config?.pill?.indexCode));
  check('写回后持仓没有被抹掉',
    JSON.stringify(body?.data?.config?.positions ?? null) === JSON.stringify(before.positions ?? null),
    brief(body?.data?.config?.positions));
}

console.log(`\n【4.5】GET /search —— 股票和场内基金都要能搜到\n`);
{
  const byCode = await get('/search?q=510300');
  const items = byCode.body?.data?.items ?? [];
  check('/search 搜代码命中场内基金', items.some((x) => x.code === 'sh510300' && x.kind === 'fund'),
    items.map((x) => `${x.code}/${x.kind}`).join(','));
  check('/search 返回的每条都带 kind（前端要据此标「基金」）',
    items.every((x) => x.kind === 'stock' || x.kind === 'fund'), '');
  const byName = await get('/search?q=' + encodeURIComponent('创业板ETF'));
  check('/search 搜名称命中基金', (byName.body?.data?.items ?? []).some((x) => x.kind === 'fund'),
    (byName.body?.data?.items ?? []).map((x) => x.name).join(','));
  const stock = await get('/search?q=' + encodeURIComponent('茅台'));
  check('/search 股票没被基金挤掉', (stock.body?.data?.items ?? []).some((x) => x.code === 'sh600519'), '');
  const uni = (await get('/state')).body?.data?.universe ?? {};
  check('/state 报出了 fundCount', typeof uni.fundCount === 'number' && uni.fundCount > 1000, String(uni.fundCount));
}

console.log(`\n【4.6】GET /ocr —— 图片识别能不能用要先问得到\n`);
{
  const r = await get('/ocr');
  check('HTTP 200', r.status === 200, String(r.status));
  const probe = r.body?.data?.probe ?? {};
  check('/ocr 返回 probe', typeof probe === 'object' && probe !== null, JSON.stringify(probe));
  check('probe.ok 是布尔', typeof probe.ok === 'boolean', String(probe.ok));
  check('probe.langs 是数组（界面不依赖具体值，但形状要定）', Array.isArray(probe.langs),
    JSON.stringify(probe.langs));
  check('probe.error 是字符串（没装语言包时界面要能显示原因）', typeof probe.error === 'string',
    String(probe.error));
}

console.log(`\n【5】报价形状 —— 个股与指数必须是两套（方案 §8 第 2、3 条）\n`);
const q = await get('/quote?codes=sh600519,sh000001');
check('HTTP 200', q.status === 200, String(q.status));
const items = q.body?.data?.items ?? q.body?.data?.quotes ?? [];
check('返回了 2 条报价', items.length === 2, `拿到 ${items.length} 条`);
const stock = items.find((x) => x.code === 'sh600519');
const index = items.find((x) => x.code === 'sh000001');
check('个股与指数都在', Boolean(stock && index));

if (stock && index) {
  // 报价是两层结构：数值全在 fields 里，不在顶层。
  // 顶层直接读 price 会得到 undefined，而界面会把它渲染成「—」而不是报错。
  check('个股名字对得上', stock.name === '贵州茅台', stock.name);
  check('个股 fields.price 是数字', typeof stock.fields?.price === 'number', String(stock.fields?.price));
  // 盘口在尾盘竞价（14:57-15:00）期间会被交易所清掉，时段内时有时无 —— 实测踩到过。
  // 所以这里不能断言「一定有」，只能断言两种状态各自合法。同一个错这是第三次：
  // 依赖实时行情的断言，红了的往往是断言本身，不是插件。
  if (stock.ladder == null) {
    check('盘口缺失时是显式 null，而不是整个键消失（客户端靠它走兜底）',
      'ladder' in stock && stock.ladder === null, JSON.stringify(stock.ladder));
  } else {
    check('个股有盘口 ladder', typeof stock.ladder === 'object', brief(stock.ladder)?.slice(0, 50));
    check('盘口买卖两侧都是数组',
      Array.isArray(stock.ladder.bids) && Array.isArray(stock.ladder.asks),
      Object.keys(stock.ladder).join(','));
  }
  check('个股有涨跌停价 limit', stock.limit != null && typeof stock.limit === 'object', brief(stock.limit));
  check('个股 fields 里没有 price 以外的顶层价格',
    stock.price === undefined, String(stock.price));

  // 上游腾讯的指数 fields 本来就只有 11 个键，没有 turnover / pe / pb / limitUp / limitDown；
  // 这里断言的是「我们没把这些字段补上去」。
  const FORBIDDEN = ['turnover', 'pe', 'peDyn', 'peStatic', 'pb', 'limitUp', 'limitDown', 'orderDiff'];
  const leaked = FORBIDDEN.filter((k) => index.fields?.[k] !== undefined);
  check('指数没混进个股字段', leaked.length === 0, leaked.join(', ') || '无');
  check('指数没有盘口', index.ladder == null, brief(index.ladder));
  check('指数报的是点位而不是股价',
    typeof index.fields?.price === 'number' && index.fields.price > 100, String(index.fields?.price));
  check('指数有涨跌幅', typeof index.fields?.changePct === 'number', String(index.fields?.changePct));
  check('两条是不同品种', stock.kind !== index.kind, `${stock.kind} / ${index.kind}`);
}

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;