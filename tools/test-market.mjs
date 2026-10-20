/**
 * 组合层自检（开发用）
 * 用法：node tools/test-market.mjs
 */
import { createMarket, INDEX_CODES, summarizeAvg, weekStartOf } from '../lib/market.js';
import { createStore, normalizeConfig, defaultConfig } from '../lib/store.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

const m = createMarket();

// 开盘前很多接口本来就没有数据：涨停 0 家、分时还没生成、板块没有涨停分布。
// 这类断言依赖挂钟，未开盘时应跳过而不是判失败 ——
// 否则每天早上跑测试都是红的，红久了就没人看，真正的回归反而漏掉。
// 「今买」必须带日期：只存 true 的话昨天勾的今天还生效，
// 今日盈亏就永远退化成持仓盈亏，新的一天不会归零。
{
  const n1 = normalizeConfig({ positions: { sz159558: { cost: 0.905, shares: 1000, todayBuy: true } } });
  check('todayBuy=true 迁移成日期字符串',
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(n1.config.positions.sz159558.todayBuy),
    JSON.stringify(n1.config.positions.sz159558));
  const n2 = normalizeConfig({ positions: { sh600519: { cost: 1200, shares: 100, todayBuy: '2026-10-19' } } });
  check('todayBuy 是日期时原样保留', n2.config.positions.sh600519.todayBuy === '2026-10-19');
  const n3 = normalizeConfig({ positions: { sh600519: { cost: 1200, shares: 100, todayBuy: 'xxx' } } });
  check('todayBuy 是脏值时丢弃，不猜日期', n3.config.positions.sh600519.todayBuy === undefined,
    JSON.stringify(n3.config.positions.sh600519));

  // 持有标记：它是纯标记，与成本/份额互不依赖，但必须能穿过 pickPositions 的白名单 ——
  // 白名单漏一个字段的表现是「界面上勾了，保存后刷新又变回没勾」，且不报任何错。
  const h1 = normalizeConfig({ positions: { sz002739: { cost: 8.545, shares: 200, held: true } } });
  check('held=true 能被保存下来', h1.config.positions.sz002739.held === true,
    JSON.stringify(h1.config.positions.sz002739));
  check('带上 held 之后成本与份额仍在',
    h1.config.positions.sz002739.cost === 8.545 && h1.config.positions.sz002739.shares === 200,
    JSON.stringify(h1.config.positions.sz002739));
  const h2 = normalizeConfig({ positions: { sz002739: { cost: 8.545, shares: 200, held: false } } });
  check('held=false 不落盘（未标记就等于不持有，不留空壳）',
    h2.config.positions.sz002739.held === undefined && h2.config.positions.sz002739.cost === 8.545,
    JSON.stringify(h2.config.positions.sz002739));
  const h3 = normalizeConfig({ positions: { sz002739: { held: true } } });
  check('只标持有、不填成本也能单独存在', h3.config.positions.sz002739?.held === true,
    JSON.stringify(h3.config.positions.sz002739));
}

const SKIP_SESSION = await m.session();
const CLOSED = !SKIP_SESSION.trading;
/**
 * 需要一个「今天已经开过盘」才有意义的断言。
 * 未开盘时记一次跳过（计入 pass，但不冒充验证通过），开盘后照常断言。
 */
const expectData = (name, cond, extra = '') => {
  if (CLOSED) { pass++; console.log('  SKIP  ' + name + '（' + SKIP_SESSION.label + '，今天还没有数据）'); return; }
  check(name, cond, extra);
};

console.log('【1】代码池');
const uni = await m.universe.info();
check('代码池已加载', uni.count > 5000, `${uni.count} 只 / 生成于 ${uni.generatedAt} / ${JSON.stringify(uni.marketCount)}`);
check('代码池无加载错误', !uni.error, String(uni.error));
const found = await m.universe.search('茅台', 5);
check('按名称检索到贵州茅台', found.some((s) => s.code === 'sh600519'), found.map((s) => s.code + ' ' + s.name).join(' / '));
const found2 = await m.universe.search('300750', 5);
check('按代码检索到宁德时代', found2.some((s) => s.code === 'sz300750'), found2[0]?.code);

console.log('\n【2】批量报价');
const q = await m.quotes(['sh600519', 'sh000001', 'sz300750', 'sh999999']);
check('取到 3 只', q.items.length === 3, q.items.map((i) => `${i.code} ${i.name} ${i.kind}`).join(' | '));
check('不存在的代码进 missing 而不是被伪造', q.missing.includes('sh999999'), JSON.stringify(q.missing));
const idx = q.items.find((i) => i.code === 'sh000001');
check('指数 orders 与个股共存', idx?.kind === 'index', idx?.kind);
check('指数无市盈率字段', !('pe' in (idx?.fields ?? {})));

console.log('\n【3】交易状态');
const s = await m.session();
check('拿到交易状态', typeof s.trading === 'boolean', `${s.id} / ${s.label} / 来源 ${s.origin}`);

console.log('\n【4】涨跌停概览 + 连板梯队');
const ov = await m.overview();
// 断言不能依赖挂钟：早上九点前确实一家涨停都没有。
// 真正的不变量是「家数是数字且不为负」，「>0」只在今天已经开过盘时才成立。
const numOf = (x) => x?.today?.num;
check('涨停/炸板/跌停家数是数字且不为负',
  Number.isFinite(numOf(ov.limitUp)) && numOf(ov.limitUp) >= 0 &&
  Number.isFinite(numOf(ov.limitDown)) && numOf(ov.limitDown) >= 0,
  `涨停 ${numOf(ov.limitUp)} 炸板 ${ov.limitUp?.today?.openNum} 跌停 ${numOf(ov.limitDown)}`);
const sess = await m.session();
if (sess.trading) {
  check('交易时段内涨停家数 > 0（否则数据源根本没在工作）', numOf(ov.limitUp) > 0, String(numOf(ov.limitUp)));
} else {
  check('非交易时段允许 0 家涨停（不再误报失败）', numOf(ov.limitUp) >= 0, `${sess.id} 涨停 ${numOf(ov.limitUp)}`);
}
const la = await m.ladder();
check('梯队是数组（非交易时段可以为空）', Array.isArray(la), la.map((r) => `${r.height}板${r.number}家`).join(' '));

console.log('\n【5】全市场扫描（7 个请求 / 约 3 秒）');
const t0 = Date.now();
const br = await m.breadth();
const ms = Date.now() - t0;
check('统计到 5000 只以上', br.counted > 5000, `${br.counted}/${br.total} 只，缺失 ${br.missing}，用时 ${ms}ms`);
check('涨跌家数相加合理', br.up + br.down + br.flat === br.counted, `涨 ${br.up} / 跌 ${br.down} / 平 ${br.flat}`);
expectData('涨停家数为正', br.limitUp > 0, `本机口径 涨停 ${br.limitUp} / 跌停 ${br.limitDown} / 炸板 ${br.burst}`);
console.log(`        同花顺口径 涨停 ${ov.limitUp?.today?.num} / 跌停 ${ov.limitDown?.today?.num} / 炸板 ${ov.limitUp?.today?.openNum}`);
expectData('两个口径量级一致（差异不应超过一倍）',
  Math.abs(br.limitUp - (ov.limitUp?.today?.num ?? br.limitUp)) <= Math.max(20, (ov.limitUp?.today?.num ?? 1)),
  `本机 ${br.limitUp} vs 同花顺 ${ov.limitUp?.today?.num}`);

/**
 * 开盘至今已经过的交易分钟数（午休不计，上限 242）。
 *
 * 分时是「每分钟一根」，点数必然随时间增长。原来两处写死 `> 200`，
 * 只有 14:00 之后才成立 —— 上午跑必红，于是这条红灯天天出现、也就被无视了。
 * 用时钟算出下限，收盘时照样能验完整性，10 点钟也不会误报。
 *
 * 时区换算不依赖宿主时区：先把时间戳推到 UTC+8，再读 UTC 字段。
 */
function elapsedTradingMinutes(now = new Date()) {
  const bj = new Date(now.getTime() + 8 * 3600e3);
  const m = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const OPEN = 9 * 60 + 30, MORNING_END = 11 * 60 + 30, AFTERNOON = 13 * 60, CLOSE = 15 * 60;
  if (m <= OPEN) return 0;
  if (m <= MORNING_END) return m - OPEN;
  if (m < AFTERNOON) return 120;              // 午休：上午累计 120 分钟
  if (m <= CLOSE) return 120 + (m - AFTERNOON);
  return 242;
}

console.log('\n【5.5】分时：个股与指数');
{
  // 接口偶尔滞后几分钟，留 8 分钟余量
  const elapsed = elapsedTradingMinutes();
  const minPts = Math.max(1, elapsed - 8);
  const st = await m.minute('sh600519');
  expectData('个股分时有数据', st.points.length >= minPts, `${st.points.length} 点，开盘约 ${elapsed} 分钟`);
  check('个股分时首点是 09:30', st.points[0].time === '0930', st.points[0].time);
  check('个股分时末点不晚于 15:00（盘后竞价不进分时图）',
    st.points[st.points.length - 1].time <= '1500', st.points[st.points.length - 1].time);
  check('个股分时带昨收', typeof st.prevClose === 'number' && st.prevClose > 0, String(st.prevClose));
  // 量能必须是「每分钟增量」。若误取累计列，序列会单调不减
  const vols = st.points.map((p) => p.volume).filter((v) => typeof v === 'number');
  expectData('分时量能是每分钟增量，不是累计值（累计值必然单调不减）',
    !vols.every((v, i) => i === 0 || v >= vols[i - 1]), `${vols.length} 个`);
  expectData('分时均价在现价附近（同一天的均价不该偏离太远）',
    Math.abs(st.points[st.points.length - 1].avg - st.points[st.points.length - 1].price)
      / st.points[st.points.length - 1].price < 0.05,
    `均价 ${st.points[st.points.length - 1].avg} vs 价 ${st.points[st.points.length - 1].price}`);

  // 指数这条是回归。原先均价用「累计额 ÷ 累计量」，对指数会得出「平均每股价格」——
  // 实测上证指数算出 16.44，而当时指数在 3730 一带，差了 200 多倍，
  // 画出来均价线会贴着坐标轴底部，但不会报任何错。
  const ix = await m.minute('sh000001');
  const ixLast = ix.points[ix.points.length - 1];
  expectData('指数分时有数据', ix.points.length >= minPts, `${ix.points.length} 点，开盘约 ${elapsed} 分钟`);
  expectData('指数分时的均价与点位同量级（额量法在此会算出个位数）',
    ixLast.avg > ixLast.price * 0.8 && ixLast.avg < ixLast.price * 1.2,
    `均价 ${ixLast.avg} vs 点位 ${ixLast.price}`);
}

console.log('\n【6】缓存命中：第二次扫描应显著更快');const t1 = Date.now();
await m.breadth();
check('第二次扫描 < 200ms', Date.now() - t1 < 200, `${Date.now() - t1}ms`);

console.log('\n【7】整页聚合 + 逐源降级');
const dash = await m.dashboard({ codes: ['sh600519', 'sz300750'], include: { breadth: true } });
check('整页拿到 session', Boolean(dash.session?.id), dash.session.label);
check('整页拿到 indices', (dash.parts.indices?.items?.length ?? 0) > 0, `${dash.parts.indices?.items?.length} 个指数`);
check('整页拿到 watchlist', dash.parts.watchlist?.items?.length === 2);
check('整页拿到 breadth', dash.parts.breadth?.counted > 5000);
// 板块格子走同花顺（行业板块榜 + 涨停板块榜），东财已整体退出这个功能 ——
// 2026-10-19 实测它的 clist/get 被按路径拦截，取证见 docs/东财不可达取证与板块可行性.md。
// 判据按结果分岔：拿到就验内容，没拿到就验降级是否得体，两条路都在断言真东西。
const rank = dash.parts.boardRank;
const rankGot = (rank?.up?.length ?? 0) > 0 && (rank?.down?.length ?? 0) > 0;
if (rankGot) {
  check('整页拿到涨最狠的 10 个板块', rank.up.length === 10, `${rank.up.length} 个`);
  check('整页拿到跌最狠的 10 个板块', rank.down.length === 10, `${rank.down.length} 个`);
  // 排序方向写反过一次（zoomWindow 那次），这类错误在界面上一样是「有数字」，
  // 只能靠比较相邻两条的大小来锁
  check('涨最狠按涨幅降序（首位 >= 次位）',
    (rank.up[0].changePct ?? -999) >= (rank.up[1].changePct ?? 999),
    `${rank.up[0].name} ${rank.up[0].changePct}% vs ${rank.up[1].name} ${rank.up[1].changePct}%`);
  check('跌最狠按跌幅降序（首位 <= 次位）',
    (rank.down[0].changePct ?? 999) <= (rank.down[1].changePct ?? -999),
    `${rank.down[0].name} ${rank.down[0].changePct}% vs ${rank.down[1].name} ${rank.down[1].changePct}%`);
  check('涨和跌不是同一个板块打头（取尾部反转时最容易错）',
    rank.up[0].code !== rank.down[0].code, `${rank.up[0].name} / ${rank.down[0].name}`);
  check('每个板块都带成分股所需的 6 位代码',
    rank.up.every((x) => /^\d{6}$/.test(x.code)) && rank.down.every((x) => /^\d{6}$/.test(x.code)));
} else {
  console.log('        （同花顺板块榜当前拿不到，板块断言转为验降级）');
  check('板块榜拿不到时如实标错，不是静默为空',
    Object.keys(rank?.errors ?? {}).length > 0, JSON.stringify(rank?.errors));
  check('板块榜拿不到不影响其余分块（指数/自选/涨跌家数）',
    (dash.parts.indices?.items?.length ?? 0) > 0 && dash.parts.watchlist?.items?.length === 2
      && dash.parts.breadth?.counted > 5000);
}
// 涨停维度的每个格子都要能点下去：drillCode 是 block_top 的 885xxx 映射到
// 成分股页认的 30xxxx/881xxx 之后的产物。映射不到就画成不可点，
// 所以这里断言的是「10 个全都映射到了」，而不是「字段存在」。
expectData('涨停板块榜 10 个，且全部能下钻到成分股',
  (rank?.limit?.length ?? 0) === 10 && rank.limit.every((x) => /^\d{6}$/.test(x.drillCode)),
  (rank?.limit ?? []).map((x) => x.name + (x.drillCode || '(不可下钻)')).join(','));
expectData('整页拿到板块涨停分布', (dash.parts.sectorHeat?.length ?? 0) > 0, dash.parts.sectorHeat?.[0]?.name);
check('轮询间隔 > 0', dash.pollMs > 0, `${dash.pollMs}ms`);
// 四个源：腾讯行情、同花顺涨停池、同花顺板块（网页，与 dataapi 失败模式不同故分开计）、东方财富
check('健康度快照齐全（4 个源）', dash.sources.length === 4,
  dash.sources.map((h) => `${h.name}:${h.healthy ? '正常' : '异常'}`).join(' '));
check('指数清单有 6 个', INDEX_CODES.length === 6);

console.log('\n【8】单源挂掉时其余分块仍可用（模拟：请求一个非法代码）');
const bad = await m.quotes(['not-a-code']);
check('非法代码不抛错，进 missing', bad.items.length === 0 && bad.missing.length === 1);

// 裸 6 位代码必须能查到 —— 这是一个藏了好几轮的 bug：
// fetchQuotes 返回的 Map 以【归一化后】的代码（sz300911）为键，
// 而 quotes() 却拿【原始】代码（300911）去取，于是全部落进 missing。
// 自选股一直是带前缀的写法，所以从没暴露；板块成分股给的正好是裸 6 位，
// 表现就是「点开个股详情一直停在正在取数」。
{
  const bare = await m.quotes(['300911', '002543']);
  check('裸 6 位代码能查到（板块成分股给的就是这种写法）',
    bare.items.length === 2, `${bare.items.length} 只, missing=${JSON.stringify(bare.missing)}`);
  check('返回的 code 是归一化后的写法（下游取价都靠它）',
    bare.items.every((x) => /^(sh|sz|bj)\d{6}$/.test(x.code)), bare.items.map((x) => x.code).join(','));
  check('requested 保留调用方原本的写法（前端要靠它对回手里的字符串）',
    bare.items.every((x) => /^\d{6}$/.test(x.requested ?? '')), bare.items.map((x) => x.requested).join(','));

  // 同一只票的两种写法不能变成两行
  const mixed = await m.quotes(['600519', 'sh600519']);
  check('同一只票的两种写法不会重复成两行', mixed.items.length === 1, `${mixed.items.length} 行`);
}

console.log('\n【9】代码池：基金能搜到，但不进全市场扫描');
{
  const uni = await m.universe.info();
  check('代码池装了场内基金', (uni.fundCount ?? 0) > 1000, `fundCount=${uni.fundCount}`);
  // 这条是核心不变量：ETF 不是个股，混进 all() 会把涨跌家数的口径搞乱
  const all = await m.universe.all();
  check('全市场扫描池仍然只有股票（基金不掺进来）',
    all.length === uni.count, `all=${all.length} count=${uni.count}`);
  check('代码池里一条基金都没有',
    all.every((x) => !/^(sh5|sz1[5-8])/.test(x.code)), '');
  const byCode = await m.universe.search('510300', 5);
  check('搜 510300 命中基金且带 kind', byCode.some((x) => x.code === 'sh510300' && x.kind === 'fund'),
    byCode.map((x) => x.code + '/' + x.kind).join(','));
  const byName = await m.universe.search('创业板ETF', 5);
  check('搜名称也能命中基金', byName.length > 0 && byName.every((x) => x.kind === 'fund'),
    byName.map((x) => x.name).join(','));
  const stock = await m.universe.search('茅台', 3);
  check('股票仍然搜得到，且 kind 标成 stock',
    stock.some((x) => x.code === 'sh600519' && x.kind === 'stock'), JSON.stringify(stock[0]));
}

console.log('\n【9】配置规整与迁移');
const cfg = defaultConfig();
check('出厂配置有 2 个分组', cfg.groups.length === 2, cfg.groups.map((g) => g.name).join(' / '));
// 这一段用的是旧插件 localStorage 的真实形状，抄自旧 client.js:864 与 :161：
//   localStorage['stocking.config.v1'] = { groups: [{ name, symbols: [{code, buyPrice?, sellPrice?}] }], updatedAt }
// 注意两处都跟本插件的格式不同：键叫 symbols 而不是 items；分组只有 name 而没有 id。
// 之前这组测试用的是我自己写的 {items: [...]}，正好绕开了真实形状 —— 等于没测。
const REAL_OLD = {
  groups: [
    { name: '我的自选', symbols: [{ code: 'sh600519' }, { code: 'sz300750', buyPrice: 180, sellPrice: 260 }] },
    { name: '宽基', symbols: [{ code: 'sh000001' }, { code: 'not-a-code' }] },
  ],
  updatedAt: 1760000000000,
};
const real = normalizeConfig(REAL_OLD);
const realTotal = real.config.groups.reduce((a, g) => a + g.items.length, 0);
check('真实旧格式的代码全都迁过来了（不是空分组）', realTotal === 3,
  `${realTotal} 个：${JSON.stringify(real.config.groups)}`);
check('没有 id 的旧分组靠 name 推 id，两个都留下', real.config.groups.length === 2,
  JSON.stringify(real.config.groups.map((g) => g.id)));
check('第一个可当自选的分组被定为 watch，药丸与自选面板才找得到它',
  real.config.groups.some((g) => g.id === 'watch'), real.config.groups.map((g) => g.id).join(','));
check('名称被保留，用户还认得出来', real.config.groups.some((g) => g.name === '我的自选'),
  real.config.groups.map((g) => g.name).join(','));
check('带买卖目标价时明确告知目标价没迁（代码保留）',
  real.notes.some((n) => n.includes('目标价')), real.notes.join(' | '));
check('真实旧格式里那个非法代码被点名',
  real.notes.some((n) => n.includes('not-a-code')), real.notes.join(' | '));

const legacy = normalizeConfig({ items: ['600519', '300750', 'sh000001', 'garbage', '600519'] });
check('旧格式 items 被迁移', legacy.config.groups.some((g) => g.id === 'watch'), legacy.notes.join(' | '));
check('迁移时补市场前缀', legacy.config.groups.find((g) => g.id === 'watch')?.items.includes('sh600519'));
// 旧格式是扁平一列，分不出指数与个股，三个可识别代码都应进自选；重复的 600519 只留一个
check('迁移时去重（600519 出现两次只留一个）',
  legacy.config.groups.find((g) => g.id === 'watch')?.items.length === 3,
  JSON.stringify(legacy.config.groups.find((g) => g.id === 'watch')?.items));
check('无法识别的代码被如实报告（且列出具体值）', legacy.notes.some((n) => n.includes('garbage')), legacy.notes.join(' | '));
const bad2 = normalizeConfig({ groups: [{ id: 'a', name: 'A', items: ['x'] }, { id: 'a', name: 'B', items: [] }] });
check('重复分组 id 被丢弃并告知', bad2.notes.some((n) => n.includes('重复的分组')), bad2.notes.join(' | '));
const store = createStore();
const info = store.info();
console.log(`        配置将写入 ${info.path}  (规则 ${info.rule})`);
// 持仓与价格监控：只认正的有限数，脏值不能编成默认值
{
  const r = normalizeConfig({
    groups: [{ id: 'watch', name: '自选', items: ['sh600519'] }],
    positions: { sh600519: { cost: 1200.5, shares: 100 }, sz300750: { cost: -1, shares: 0 } },
    alerts: { sh600519: { low: 1200, high: 1400 } },
    ui: { pollSec: 10 },
  });
  check('持仓被规整并保留（成本 1200.5 / 份额 100）',
    r.config.positions?.sh600519?.cost === 1200.5 && r.config.positions?.sh600519?.shares === 100,
    JSON.stringify(r.config.positions));
  check('成本为负、份额为 0 的脏数据被丢弃（不编默认值）',
    r.config.positions?.sz300750 === undefined, JSON.stringify(r.config.positions));
  check('监控阈值被保留', r.config.alerts?.sh600519?.low === 1200 && r.config.alerts?.sh600519?.high === 1400,
    JSON.stringify(r.config.alerts));
  check('刷新间隔按白名单接受 10 秒', r.config.ui?.pollSec === 10, String(r.config.ui?.pollSec));

  const bad = normalizeConfig({
    groups: [{ id: 'watch', name: '自选', items: ['sh600519'] }],
    alerts: { sh600519: { low: 1500, high: 1400 } }, ui: { pollSec: 2 },
  });
  check('低价 >= 高价时保留用户填的值但如实报警',
    bad.config.alerts?.sh600519?.low === 1500 && bad.notes.some((n) => n.includes('不小于')),
    JSON.stringify(bad.notes));
  check('刷新间隔不在白名单时回落到 10 秒', bad.config.ui?.pollSec === 10, String(bad.config.ui?.pollSec));
}

check('配置路径已解析', info.path.endsWith('config.json'));

// 周/月均价：一段固定的日 K，算出来的数可以直接对账
{
  const bar = (date, close, volume) => ({ date, close, volume });
  const bars = [
    bar('2026-10-12', 100, 10), bar('2026-10-16', 110, 10),
    bar('2026-10-19', 120, 30), bar('2026-10-20', 130, 10),
  ];
  const s = summarizeAvg(bars);
  // 本周（10-19 起）= (120×30 + 130×10) / 40
  check('周均价按成交量加权：本周只有两天', Math.abs(s.week - 122.5) < 1e-9, String(s.week));
  // 本月（10-01 起）= (100×10 + 110×10 + 120×30 + 130×10) / 60
  check('月均价按成交量加权：整月四天',
    Math.abs(s.month - 7000 / 60) < 1e-9, String(s.month));
  check('周起点是周一', s.weekFrom === '2026-10-19' && s.monthFrom === '2026-10-01',
    `${s.weekFrom} / ${s.monthFrom}`);
  // 周期锚在最新一根 K 线上，不是本机时钟：周一早上拿到的是上周五的数据，
  // 按挂钟算「本周」会得到空区间，均价直接变 null
  const stale = summarizeAvg([bar('2026-10-16', 110, 10)]);
  check('数据停在周五：周均价仍按那一周算出来，不是 null',
    stale.week === 110 && stale.weekFrom === '2026-10-12', JSON.stringify(stale));

  check('空数组给出四个 null，不是 0',
    JSON.stringify(summarizeAvg([])) === JSON.stringify({ week: null, month: null, weekFrom: null, monthFrom: null, bars: 0 }),
    JSON.stringify(summarizeAvg([])));
  check('成交量为 0 或缺失的 K 线不参与加权（停牌日不该把均价拉向自己）',
    summarizeAvg([bar('2026-10-19', 120, 0), bar('2026-10-20', 130, 10)]).week === 130,
    String(summarizeAvg([bar('2026-10-19', 120, 0), bar('2026-10-20', 130, 10)]).week));
  check('周起点跨月也按周一对齐（2026-11-01 是周日 → 10-26）',
    weekStartOf('2026-11-01') === '2026-10-26', weekStartOf('2026-11-01'));
}

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;