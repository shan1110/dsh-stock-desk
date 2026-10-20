/**
 * 客户端半边加载自检
 *
 * 为什么需要这个文件：client.js 是浏览器模块，Node 直接 import 只会炸在没有 window 上，
 * 于是「它到底能不能加载、apply 到底注册上没有」在装完插件后完全看不到 ——
 * 而「插件是 active 的，界面上却什么都没有」是最难查的一种失败。
 * 这个脚本用最小桩件把 factory 真跑一遍，把静默失败变成一条可复现的命令。
 *
 * 覆盖：模块能否加载、apply 能否跑完、三个槽位的 name/id/key 两两是否自洽、
 *      每个 T("x") 是否都有词条、locale/*.json 的展示元数据是否中英齐全。
 * 不覆盖：渲染结果、hook 行为、真实浏览器里的 Slot 冲突 —— 那些只能在页面上看。
 *
 * 用法：node tools/test-client.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'client.js'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? `  → ${extra}` : ''}`); }
};

// ---- 桩件 ----------------------------------------------------------------
class Component {
  constructor(props) { this.props = props ?? {}; this.state = {}; }
  setState(partial) {
    this.state = { ...this.state, ...(typeof partial === 'function' ? partial(this.state) : partial) };
  }
}
const createElement = (type, props, ...children) => ({ type, props, children });

const React = {
  createElement,
  Fragment: Symbol('Fragment'),
      Component,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useSyncExternalStore: (_sub, get) => get(),
};

const styleTags = [];
globalThis.window = { __ModuleLoader__: { load: (entry) => { globalThis.__entry = entry; } } };
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild: (t) => styleTags.push(t) },
};
// createDesk 的轮询会真发请求；这里只验证 apply，不需要行情
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) });

// ---- 加载 -----------------------------------------------------------------
console.log('客户端半边加载自检\n');

await import(`file:///${join(ROOT, 'client.js').replace(/\\/g, '/')}`);
const entry = globalThis.__entry;

check('调用了 __ModuleLoader__.load', entry !== null && entry !== undefined);
// id 应当是包名：它只用于模块标识，与槽位 id 无关，所以在这里单独钉死
check('模块 id 是包名', entry?.id === 'dsh-stock-desk', `实际 ${entry?.id}`);
check('factory 是函数', typeof entry?.factory === 'function');

let mod = null;
let loadError = null;
try {
  mod = entry.factory((spec) => {
    if (spec === 'react') return React;
    throw new Error(`未预期的 require("${spec}")`);
  });
} catch (err) {
  loadError = err;
}
check('factory 执行不抛错', loadError === null, String(loadError?.stack ?? '').split('\n')[0]);
check('返回了 { inject, apply }', typeof mod?.apply === 'function');
check('inject 声明了 slots 与 locale',
  Array.isArray(mod?.inject) && mod.inject.includes('slots') && mod.inject.includes('locale'),
  JSON.stringify(mod?.inject));

// ---- apply ----------------------------------------------------------------
const effects = [];
const localeRegs = [];
const slotRegs = [];
let boundNs = null;

const ctx = {
  effect: (fn, label) => { effects.push(label); fn(); return () => {}; },
  locale: {
    register: (ns, dicts) => { localeRegs.push({ ns, dicts }); return () => {}; },
    bind: (ns) => {
      boundNs = ns;
      // 真实实现按当前语言查表；这里固定用 zh，验证的是「键能查到值」而不是语言切换
      const dict = localeRegs.at(-1)?.dicts?.zh ?? {};
      return (key) => dict[key] ?? key;
    },
  },
  slots: {
    inject: (slot, fn) => { fn(); return () => {}; },
    register: (reg, Component) => { slotRegs.push({ ...reg, Component }); return () => {}; },
  },
};

let applyError = null;
try { mod.apply(ctx); } catch (err) { applyError = err; }
check('apply 执行不抛错', applyError === null, String(applyError?.stack ?? '').split('\n')[0]);

check('注册了 1 次语言包', localeRegs.length === 1);
check('bind 的命名空间与 register 的一致', boundNs === localeRegs[0]?.ns,
  `bind=${boundNs} register=${localeRegs[0]?.ns}`);
check('语言包 zh/en 都有',
  Boolean(localeRegs[0]?.dicts?.zh && localeRegs[0]?.dicts?.en));
check('注册了内联样式 effect', effects.includes('dsh-stock-desk.client.styles'));
check('插入了 1 个 <style> 标签',
  styleTags.length === 1 && styleTags[0].dataset.pluginCss === 'dsh-stock-desk/client');

// 样式里有两条约定桩件永远验不出来，只能自己断言住：
// 1. 颜色一律走 --dsw-* 主题令牌，写死十六进制切主题就不跟随（方案 §8 第 8 条）。
// 2. shell.overlay 整层是 click-through，药丸必须自己打开指针事件，否则点不动、拖不动、关不掉。
const css = styleTags[0]?.textContent ?? '';
// 白名单只有一处：主按钮上的白字。令牌表里没有 on-brand / label-inverse 这类令牌，
// 而 brand-primary 是饱和色，白字在明暗两套主题下都成立。
const allowedHex = new Set(['#fff']);
const foundHex = [...new Set((css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((x) => x.toLowerCase()))];
const strayHex = foundHex.filter((x) => !allowedHex.has(x));
check('样式里没有写死的十六进制颜色（白名单只有主按钮白字）', strayHex.length === 0, strayHex.join(', '));
check('确实用上了主题令牌', css.includes('var(--dsw-alias-'), '一个都没用');
check('药丸显式打开了指针事件（shell.overlay 整层穿透）',
  /\.skd-pill\{[^}]*pointer-events:\s*auto/.test(css), '找不到 pointer-events:auto，药丸会点不动');

// ---- 三个槽位 --------------------------------------------------------------
const bySlot = (name) => slotRegs.filter((r) => r.name === name);
const panel = bySlot('sidebar.panellist')[0];
const main = bySlot('main')[0];

check('sidebar.panellist 注册 1 次', bySlot('sidebar.panellist').length === 1);
check('main 注册 1 次', bySlot('main').length === 1);
check('shell.overlay 注册 1 次', bySlot('shell.overlay').length === 1);
check('共注册 4 个槽位', slotRegs.length === 4, `实际 ${slotRegs.length}`);

// 崩溃兜底：面板里任何一个组件抛错，React 会卸载整棵子树 —— 用户看到的就是「一片黑」。
// 包一层错误边界之后至少能把错误显示出来，下一轮才有线索可查。
{
  const Boundary = mod.__test.DeskBoundary;
  const b = new Boundary({});
  b.state = { err: new Error('boom-test') };
  const txt = JSON.stringify(b.render()).slice(0, 400);
  check('错误边界：出错时渲染出错误信息而不是空白/黑屏', txt.includes('boom-test'), txt.slice(0, 140));
  const ok = new Boundary({});
  ok.state = { err: null };
  ok.props = { children: 'ok-child' };
  check('错误边界：正常时直接透传子节点', ok.render() === 'ok-child');
}
check('main 注册的是带错误边界的外壳 DeskSafe，不是裸面板',
  (() => { const m = slotRegs.find((x) => x.name === 'main'); return Boolean(m && m.Component && m.Component.name === 'DeskSafe'); })(),
  JSON.stringify(slotRegs.map((x) => `${x.name}:${x.Component?.name ?? '?'}`)));
check('三个注册点的组件都是函数', slotRegs.every((r) => typeof r.Component === 'function'));

// 这一条是整个客户端最要紧的不变量：侧边栏按钮的 id 必须等于 main 的 key，
// 否则点按钮打不开自己那一页，而且是静默失败
check('sidebar.panellist.id === main.key', panel?.id === main?.key,
  `id=${panel?.id} key=${main?.key}`);
// 再跨文件交叉验证：槽位 id 必须等于 HTTP 路由里的插件 slug，
// 否则「一个 slug 写歪」会在很远处才暴露
const apiSlug = SRC.match(/const API = "\/api\/([a-z0-9-]+)"/)?.[1];
check('槽位 id 与 API 前缀的 slug 一致', panel?.id === apiSlug,
  `槽位=${panel?.id} API=${apiSlug}`);
check('sidebar.panellist 有 order', typeof panel?.order === 'number');
// label 必须是 thunk：槽位目录写明它每次投影都重新读，传字符串则切语言后不会跟着变
check('label 是函数（切语言能跟着变）', typeof panel?.label === 'function',
  `实际 ${typeof panel?.label}`);
check('label() 解析成中文而不是 key', panel?.label?.() === localeRegs[0]?.dicts?.zh?.title,
  `实际 ${JSON.stringify(panel?.label?.())}`);

// ---- 词条完整性 ------------------------------------------------------------
const { zh, en } = localeRegs[0].dicts;
const missingEn = Object.keys(zh).filter((k) => !(k in en));
check('zh 与 en 词条一一对应', missingEn.length === 0, `en 缺少 ${missingEn.join(', ')}`);

const used = [...new Set([...SRC.matchAll(/T\("([a-zA-Z0-9_]+)"\)/g)].map((m) => m[1]))];
const undeclared = used.filter((k) => !(k in zh));
check(`${used.length} 个 T() 调用都有词条`, undeclared.length === 0, `缺 ${undeclared.join(', ')}`);

// 字面量扫不到的两处动态查表：交易时段 T(SESSION_LABEL[...])、五档两侧 T(side)
const dynSession = [...(SRC.match(/const SESSION_LABEL = \{([^}]*)\}/)?.[1] ?? '')
  .matchAll(/:\s*"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
const dynLevels = [...SRC.matchAll(/levels\("([a-zA-Z0-9_]+)"\)/g)].map((m) => m[1]);
// DETAIL_GROUPS 的字段名与分组标题也都是动态查表（T(k) / T(g.title)），要整块捞出来
const detailBlock = SRC.split('const DETAIL_GROUPS = [')[1]?.split('\n    ];')[0] ?? '';
const dynDetail = [...detailBlock.matchAll(/"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
// positionRows 返回的也是 [字段名, 文本] 对，同样要捞
const posBlock = SRC.split('function positionRows(q) {')[1]?.split('\n    }')[0] ?? '';
const dynPos = [...posBlock.matchAll(/\["([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
const dynamic = [...new Set([...dynSession, ...dynLevels, ...dynDetail, ...dynPos])];
check('收集到 4 个动态时段词条', dynSession.length === 4, `实际 ${dynSession.length}`);
check('收集到五档两侧的词条', dynLevels.includes('bids') && dynLevels.includes('asks'),
  dynLevels.join(', '));
check(`收集到明细的 ${dynDetail.length} 个动态字段`, dynDetail.length >= 22, `实际 ${dynDetail.length}`);
check(`收集到位置组的 ${dynPos.length} 个动态字段`, dynPos.length === 5, dynPos.join(', '));

// 同一个键在对象字面量里写两遍是合法 JS：不报错，后者静默覆盖前者。
// 这个坑踩过一次（替换本该删除的行，结果插了一个已存在的键），所以直接扫源码。
for (const lang of ['zh', 'en']) {
  const body = SRC.split(`const ${lang} = {`)[1]?.split('\n    };')[0] ?? '';
  const keys = [...body.matchAll(/^ {6}([a-zA-Z0-9_]+):/gm)].map((m) => m[1]);
  check(`${lang} 块解析出 ${Object.keys(lang === 'zh' ? zh : en).length} 个键`,
    keys.length === Object.keys(lang === 'zh' ? zh : en).length,
    `扫描到 ${keys.length}`);
  const dupes = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
  check(`${lang} 没有重复键`, dupes.length === 0, dupes.join(', '));
}

const unused = Object.keys(zh).filter((k) => !used.includes(k) && !dynamic.includes(k));
check('没有声明了却用不上的词条', unused.length === 0, `多 ${unused.join(', ')}`);

// ---- 展示元数据（locale/*.json，与代码内字典是两回事）-----------------------
for (const lang of ['zh', 'en']) {
  let meta = null;
  try { meta = JSON.parse(readFileSync(join(ROOT, 'locale', `${lang}.json`), 'utf8')); } catch { /* 下面按 fail 处理 */ }
  check(`locale/${lang}.json 可解析`, meta !== null);
  check(`locale/${lang}.json 有 meta.title`, typeof meta?.meta?.title === 'string' && meta.meta.title.length > 0);
  check(`locale/${lang}.json 有 meta.description`,
    typeof meta?.meta?.description === 'string' && meta.meta.description.length > 0);
}

// ---- package.json 声明的导出必须真的存在 -------------------------------------
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
check('dsh.bundle.patch 指向的文件存在',
  readFileSync(join(ROOT, pkg.dsh?.bundle?.patch ?? '__none__'), 'utf8').includes('dsh-stock-desk'));
check('main 指向的文件存在', readFileSync(join(ROOT, pkg.main), 'utf8').length > 0);
check('dsh.client.platform 是 web', pkg.dsh?.client?.platform === 'web');
check('代码池文件存在', readFileSync(join(ROOT, 'data', 'universe.json'), 'utf8').length > 0);

// ---- 明细视图：把 §8 的验尸标准变成机器判定 ------------------------------------
const { quoteDate, todayKey, nextRefreshSec, RefreshMeter, applyDraftEdit, QuoteDetail, QuoteTable, IndexStrip, fieldText, positionRows, rangeRatio, orderRatio, cashText, money, Holdings, MonitorBar, DeskBoundary,
  rowEditDraft, mergeEditDraft,
  BreadthBar, LimitGrid, BoardGrid, BoardDrill, Kline, klineChart, minuteChart, chartPick, chartYTicks, CH,
  DEFAULT_BARS, MIN_BARS, ZOOM_STEP, zoomWindow, panWindow,
  desk, DeskPage, DeskButton, Pill, SettingsTab } = mod.__test ?? {};
check('导出了自检入口 __test',
  Boolean(QuoteDetail && QuoteTable && IndexStrip && fieldText && positionRows
    && BreadthBar && LimitGrid && BoardGrid && BoardDrill && desk && DeskPage && DeskButton && Pill));
check('导出了逐行编辑的两个纯函数（草稿只装一行 / 按行合并）',
  Boolean(rowEditDraft && mergeEditDraft));

// 单位写错不报错，只会安静地差几个数量级。下面两个数是真实接口取的：
//   贵州茅台 amount=450006（万元）→ 45.00 亿
//   贵州茅台 totalCap=16604.33（亿元）→ 1.66 万亿
// 本插件第一版对两个字段都用了同一个函数，成交额差 10000 倍
check('成交额按万元换算', fieldText?.('amount', 450006, null) === '45.00 亿',
  `实际 ${fieldText?.('amount', 450006, null)}`);
check('市值按亿元换算', fieldText?.('totalCap', 16604.33, null) === '1.66 万亿',
  `实际 ${fieldText?.('totalCap', 16604.33, null)}`);
check('字段缺失返回 null 而不是 0', fieldText?.('turnover', undefined, null) === null);
check('涨跌幅带百分号', fieldText?.('changePct', -0.06, null) === '-0.06%');

/** 把 React 元素树摊平成文本，用来断言界面上到底会不会出现某个词 */
const texts = (node) => {
  if (node === null || node === undefined || node === false || node === true) return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (typeof node === 'function') return [];
  return [...texts(node.children), ...texts(node.props?.children), ...texts(node.props?.title)];
};

/**
 * 把元素树里所有字符串值都收起来，props 也算。
 *
 * texts 只沿 children / title 往下走，而降级文案挂在 Msg 的 text 这个 prop 上，
 * 因为它是个函数组件 —— texts 不展开函数组件，于是「拿不到」三个字一个字都看不到，
 * 断言会误判成「渲染是空的」。
 */
const strings = (node, out = [], onErr = null) => {
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((x) => strings(x, out, onErr)); return out; }
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'function') return out;
  // 函数组件必须展开：文字在组件自己的 render 里，不在元素上。
  //
  // 不展开的后果是整页文字里只剩 props 上那几个字符串（分组名、代码、股票名），
  // 所有真正渲染出来的数字一个都看不到 —— 「整页里有指数点位」会红，
  // 而我看不出问题在哪：早先这个文件的 check 通过时不打印，
  // 一片空白既可能是没渲染，也可能只是没打印。这两件事必须能分开。
  //
  // 展开时抛错一律上报，不许静默吞掉：吞掉的是一整棵子树，
  // 表现是「这一段没渲染」，而真实原因是某个组件崩了 —— 两者必须能分开。
  if (node.type && typeof node.type === 'function') {
    // 桩件的 createElement 把子节点放在元素自己的字段上（{type, props, children}），
    // 而真实 React 是塞进 props.children 的。展开组件时必须把两者合并 ——
    // 不合并就丢掉全部子节点：组件照常返回、也不抛错，只是里面空了，
    // 表现和「这一段真的没渲染」一模一样，分不出来。
    const merged = Object.assign({}, node.props, { children: node.children });
    let sub;
    try { sub = node.type(merged); }
    catch (e) { if (onErr) onErr(node.type.name || '(匿名组件)', e); return out; }
    return strings(sub, out, onErr);
  }
  for (const v of Object.values(node)) strings(v, out, onErr);
  return out;
};

// ---- 降级渲染：拿不到数据时不能崩，也不能整块空着 --------------------------------
// 真实状态是整段缺失（不是给一个半截对象），这是实测到的服务降级形态。
// 契约测试只能验「响应形状对不对」，验不了「客户端遇到这个形状会不会白屏」。
// 板块格子（BoardGrid）带 hook，不能在这里直接当纯函数调，它的降级与交互
// 放到下面 【板块格子】 那一组用 mountLive 跑。
console.log('\n【降级渲染】\n');
const DEGRADED = [
  ['涨跌家数整段缺失', () => BreadthBar({ breadth: undefined })],
];
for (const [label, run] of DEGRADED) {
  let node = null;
  let err = null;
  try { node = run(); } catch (e) { err = e; }
  check(`${label}：不抛错`, err === null, err?.message);
  const got = err ? [] : strings(node);
  check(`${label}：渲染出了内容，而不是空白`, got.length > 0, got.join(' / ').slice(0, 72));
}

// 全市场成交额：A 股动辄上万亿，直接打印 1437336430000 没人读得下去。
// 分档写错过一次的单位问题（成交额差 10000 倍）就在本项目发生过，所以逐档断死。
check('金额格式化：上万亿按「万亿」', cashText(1437336430000) === '1.44 万亿', cashText(1437336430000));
check('金额格式化：上亿按「亿」', cashText(4500060000) === '45 亿', cashText(4500060000));
check('金额格式化：上万按「万」', cashText(45600000) === '4560 万', cashText(45600000));
check('金额格式化：空值给「—」而不是 0', cashText(null) === '—', cashText(null));

// 卡片真的把成交额与三个家数都渲染出来了（不只是数据里有）
const bb = strings(BreadthBar({ breadth: { up: 2202, down: 2861, flat: 510, amount: 1437336430000 } })).join(' ');
check('涨跌家数卡里出现了全市场成交额', bb.includes('全市场成交额') && bb.includes('1.44 万亿'), bb.slice(0, 100));
check('涨跌家数卡里三个家数都在', bb.includes('2202') && bb.includes('2861') && bb.includes('510'), bb.slice(0, 100));
check('涨跌家数卡不再渲染百分比图例（条本身已经表达了比例）', !/（\d+\.\d+%）/.test(bb), bb.slice(0, 100));

// 「有数据时到底渲染出了什么」——上面那组只测了缺失路径，结果漏掉一个真 bug：
// 涨停那张卡曾经读 overview.limitUp.num，而宿主给的是 limitUp.today.num，
// 少读一层 → 四个数字全取到 undefined → 界面上「涨停 / 炸板 / 跌停」齐刷刷显示「—」。
// 数据明明在。测试全绿，用户却看到空的 —— 因为没有任何一条断言在验「数字出来了」。
// 夹具的形状也得跟宿主一致，否则这类错误永远测不出来。
console.log('\n【有数据时的渲染：数字必须真的出来】\n');

/** 把组件树展开成元素数组，用于统计可点元素、找 svg 等。后面 K 线那组也在用它 */
const collectEls = (node, out = []) => {
  if (Array.isArray(node)) { node.forEach((x) => collectEls(x, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  if (typeof node.type === 'function') {
    collectEls(node.type(Object.assign({}, node.props, { children: node.children })), out);
    return out;
  }
  if (node.type) out.push(node);
  collectEls(node.children, out);
  collectEls(node.props?.children, out);
  return out;
};

const OVERVIEW_REAL = {
  source: '同花顺',
  date: '20261019',
  tradeStatus: { id: 'closed', name: '已收盘' },
  limitUp: { today: { num: 47, openNum: 19, historyNum: 66, rate: 0.7121 },
             yesterday: { num: 59, openNum: 49, historyNum: 108, rate: 0.5463 } },
  limitDown: { today: { num: 22, openNum: 9, historyNum: 31, rate: 0.7097 },
               yesterday: { num: 9, openNum: 5, historyNum: 14, rate: 0.6429 } },
};
const LADDER_REAL = [
  { height: 3, number: 2, stocks: [{ code: 'sz002889', name: '东方嘉盛' }] },
  { height: 2, number: 9, stocks: [{ code: 'sz000576', name: '甘化科工' }] },
];
// LimitGrid 带 hook，不能当纯函数直接调 —— 它的渲染与下钻断言
// 放到后面【涨停格子】那一组用 mountLive 跑（那时桩件运行时已经搭好了）。

// K 线：图最容易崩的地方不是「画得好不好看」，而是喂进去的数据不合预期时会不会抛。
// 所以按状态空间测：正常 120 根、只有 1 根、close 全缺、volume 全缺、空数组。
console.log('\n【K 线：喂各种形状都不许抛】\n');
const bar = (i, o, c, h, l, v) => ({ date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, open: o, close: c, high: h, low: l, volume: v });
const mk = (n) => Array.from({ length: n }, (_, i) => bar(i, 100 + i, 101 + i, 103 + i, 99 + i, 1000 + i * 10));
const KLINE_CASES = [
  ['正常 120 根', mk(120), 120],
  ['只有 1 根（均线全部不足期）', mk(1), 1],
  ['只有 2 根', mk(2), 2],
  ['空数组', [], 0],
];
for (const [label, cs, n] of KLINE_CASES) {
  let r = null, err = null;
  try { r = klineChart(cs, 'sh600519'); } catch (e) { err = e; }
  check(`K线 ${label}：不抛错`, err === null, err?.message);
  if (!r) continue;
  const segs = strings(r.svg);
  check(`K线 ${label}：画出了内容而不是空白`, segs.length > 0, `${segs.length} 段`);
  if (n > 0) check(`K线 ${label}：每根都有蜡烛`, segs.filter((s) => s === 'g').length === n, `${segs.filter((s) => s === 'g').length} 根 / 期望 ${n}`);
  // NaN 会静默画成空白（SVG 忽略非法坐标），断言必须显式查
  const nan = segs.filter((s) => typeof s === 'string' && s.includes('NaN')).length;
  check(`K线 ${label}：坐标里没有 NaN`, nan === 0, `${nan} 处 NaN`);
  check(`K线 ${label}：三条均线都在`, r.mas.length === 3, `${r.mas.length} 条`);
}
// 缺字段：腾讯的成交额/换手率就是 null，东财的分钟线又没有 date 之外的补齐
const sparse = mk(30).map((c) => ({ ...c, volume: null }));
let sparseErr = null;
try { klineChart(sparse, 'x'); } catch (e) { sparseErr = e; }
check('K线 volume 整列为 null 时不抛（腾讯不给成交额，成交量偶尔也缺）', sparseErr === null, sparseErr?.message);
const noClose = mk(30).map((c) => ({ ...c, close: null }));
let ncErr = null;
try { klineChart(noClose, 'x'); } catch (e) { ncErr = e; }
check('K线 close 整列为 null 时不抛', ncErr === null, ncErr?.message);
// 均线不足期时必须是 null 而不是拿前几根硬凑
check('K线 不足 20 根时 MA20 前几项是 null，不是硬凑的假值',
  klineChart(mk(10), 'x').mas[2].vals.every((v) => v === null), JSON.stringify(klineChart(mk(10), 'x').mas[2].vals));
check('K线 20 根时 MA20 最后一项有值',
  typeof klineChart(mk(20), 'x').lastMa(klineChart(mk(20), 'x').mas[2]) === 'number', '');

// 分时：同样按状态空间测。但分时有一条 K 线没有的性质必须单独锁住 ——
// 纵轴以昨收为中心上下对称。若照 K 线那样按最高最低铺满，涨 1% 和跌 1% 会被画成一样高，
// 「今天到底涨了还是跌了」这个最该一眼看出的信息就丢了。而且这种错不会抛异常，只会画歪。
console.log('\n【分时图】\n');
const mkMin = (n) => ({
  prevClose: 100,
  points: Array.from({ length: n }, (_, i) => ({
    time: String(930 + i).padStart(4, '0'),
    price: 100 + ((i % 11) - 5), volume: 10 + i, avg: 100 + ((i % 7) - 3),
  })),
});
for (const [label, mi] of [
  ['正常 242 点', mkMin(242)],
  ['只有 1 点', mkMin(1)],
  ['零点', { prevClose: 100, points: [] }],
  ['没有 prevClose', { points: mkMin(10).points }],
  ['points 不是数组', { prevClose: 100, points: null }],
]) {
  let r = null, err = null;
  try { r = minuteChart(mi, 'sh600519'); } catch (e) { err = e; }
  check(`分时 ${label}：不抛错`, err === null, err?.message);
  if (!r) continue;
  const segs = strings(r.svg);
  check(`分时 ${label}：画出了内容而不是空白`, segs.length > 0, `${segs.length} 段`);
  const nan = segs.filter((s) => typeof s === 'string' && s.includes('NaN')).length;
  check(`分时 ${label}：坐标里没有 NaN`, nan === 0, `${nan} 处 NaN`);
  check(`分时 ${label}：图例三条（价 / 均 / 昨收）齐`, r.legend.length === 3, String(r.legend.length));
}
{
  const r = minuteChart(mkMin(242), 'sh600519');
  const els = collectEls(r.svg, []);
  const baseEl = els.find((e) => e?.props?.className === 'skd-k-base');
  const baseY = Number(baseEl?.props?.y1);
  check('分时：昨收基准线画在纵轴正中',
    Number.isFinite(baseY) && Math.abs(baseY - (CH.MT + CH.PH / 2)) < 1.5,
    `y=${baseY} vs ${CH.MT + CH.PH / 2}`);
  // 顶部那条刻度原来是骑在 y=0 上的，11px 的文字有约 8px 伸到画布外被切掉半个字 ——
  // 用户说的「有一些被遮挡了」就是这个。MT 是给它留的头。
  check('图表：画布上方留了边距，顶部刻度不会被切掉', CH.MT >= 9, `MT=${CH.MT}`);
  const priceEl = els.find((e) => String(e?.props?.className ?? '').includes('mprice'));
  const ys = String(priceEl?.props?.points ?? '').split(' ').filter(Boolean).map((p) => Number(p.split(',')[1]));
  check('分时：价格线的点都解析出来了', ys.length === 242, `${ys.length} 个`);
  check('分时：价格线的上下幅度关于基准对称（涨跌不会被画成一样高）',
    Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - baseY) < 2,
    `中位 ${((Math.min(...ys) + Math.max(...ys)) / 2).toFixed(1)} vs 基准 ${baseY}`);
  const avgEl = els.find((e) => String(e?.props?.className ?? '').includes('mavg'));
  check('分时：均价线也画出来了', String(avgEl?.props?.points ?? '').length > 0, '');
  const vbars = els.filter((e) => /skd-k-vbar-(up|dn)/.test(String(e?.props?.className ?? '')));
  check('分时：每分钟一根量能柱', vbars.length === 242, `${vbars.length} 根`);
  check('分时：量能柱有涨有跌两种颜色，不是全一色',
    new Set(vbars.map((e) => e.props.className)).size === 2,
    [...new Set(vbars.map((e) => e.props.className))].join('/'));

  // ---- 这一轮加的东西：刻度 / 网格 / 面积 / 光标 ----
  // 上一版整张图上一个数字都没有，用户的原话是「看不懂」。刻度就是那次的修复，
  // 所以要锁住「刻度确实画出来了」，而不只是「没抛错」。
  const axis = els.filter((e) => e?.props?.className === 'skd-k-axis');
  // 桩件的 createElement 把子节点挂在 node.children 上，不是 props.children ——
  // 与真实 React 不同，取值要按桩件的来
  const txt = (e) => (Array.isArray(e?.children) ? e.children.join('') : String(e?.children ?? ''));
  const axisVals = axis.map(txt);
  check('分时：左右刻度都画了（5 行 × 2 列）', axis.length === 10, `${axis.length} 个`);
  check('分时：左刻度是价位，带两位小数', axisVals.filter((v) => /^\d+\.\d{2}$/.test(v)).length === 5,
    axisVals.slice(0, 6).join(' '));
  check('分时：右刻度是涨跌幅且带正负号', axisVals.filter((v) => /^[+-]\d+\.\d{2}%$/.test(v)).length === 5,
    axisVals.filter((v) => v.includes('%')).join(' '));
  // 昨收那一条右刻度必须是 0.00% —— 它同时校验了对称性和刻度换算
  check('分时：基准线那一行的右刻度是 +0.00%（纵轴对称的直接证据）',
    axisVals.includes('+0.00%'), axisVals.join(' '));
  check('分时：画了网格线', els.filter((e) => e?.props?.className === 'skd-k-grid').length === 5,
    String(els.filter((e) => e?.props?.className === 'skd-k-grid').length));
  check('分时：面积画了两块（基准线以上涨色、以下跌色）',
    els.filter((e) => /skd-k-area-(up|dn)/.test(String(e?.props?.className ?? ''))).length === 2, '');
  check('分时：两块面积各自挂了裁剪区，否则会互相盖住',
    new Set(els.filter((e) => /skd-k-area-/.test(String(e?.props?.className ?? '')))
      .map((e) => e.props.clipPath)).size === 2, '');
  check('分时：没悬停时有最新价的圆点', els.some((e) => e?.props?.className === 'skd-k-dot'), '');

  // 光标：hover 传下标就该出现十字线，不传就不该有
  const noHover = collectEls(minuteChart(mkMin(50), 'x', null).svg, []);
  const withHover = collectEls(minuteChart(mkMin(50), 'x', 10).svg, []);
  check('分时：没悬停时没有十字线', !noHover.some((e) => e?.props?.className === 'skd-k-cross'), '');
  check('分时：悬停时出现十字线', withHover.some((e) => e?.props?.className === 'skd-k-cross'), '');
  check('分时：悬停时圆点换成光标点，不会两个点同时出现',
    withHover.some((e) => e?.props?.className === 'skd-k-crossdot')
    && !withHover.some((e) => e?.props?.className === 'skd-k-dot'), '');
  // 图例要跟着光标走，否则光标移了读数还是最后一根的，等于白加
  const legText = (i) => strings(minuteChart(mkMin(50), 'x', i).legend).join(' ');
  check('分时：图例读数跟着光标走（首点与末点不同）', legText(0) !== legText(49), `${legText(0)} vs ${legText(49)}`);
  check('分时：光标在首点时读的是首点的价', legText(0).includes('95.00'), legText(0));
}

// ---- 能跑 hook 的运行时 ----------------------------------------------------
// 上面的桩件里 useState / useEffect 都是空实现，于是「交互层」在自检里完全不可见：
// 点了没反应、拖了没反应、滚了没反应，这类 bug 一个都测不出来。
// 而最近四个 bug（移除没反应、详情被遮挡、没滚动条、缩放没反应）全在这一层。
//
// 这里补一个最小可用的 hook 运行时：setState 会触发重渲染、effect 会真跑、
// ref 会挂到元素上、addEventListener 装得上。代价是它只支持函数组件和无 key 的
// 静态子树，够用就行。
{
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** 造一个带事件系统的元素。真实 DOM 有 addEventListener，桩件必须也有，否则测不到滚轮 */
  const createLive = (type, props, ...children) => {
    const el = { type, props: props ?? {}, children };
    el.listeners = {};
    // 记下 opts：passive:false 是滚轮能拦截页面的前提，不记就锁不住
    el.addEventListener = (n, fn, opts) => { (el.listeners[n] = el.listeners[n] ?? []).push({ fn, opts }); };
    el.removeEventListener = (n, fn) => {
      el.listeners[n] = (el.listeners[n] ?? []).filter((x) => x.fn !== fn);
    };
    // 固定 720 宽：与 viewBox 同宽，屏幕坐标等于 SVG 坐标，换算结果好断言
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 268 });
    return el;
  };

  /**
   * 挂载一个组件并跑到静止：渲染 → 跑 effect → 等 setState → 再渲染，最多 10 轮。
   *
   * @param {object} entry __ModuleLoader__ 收到的 entry
   * @param {string} name __test 里的组件名
   * @param {object} props 组件属性
   */
  async function mountLive(entry, name, props) {
    const rt = { hooks: [], cursor: 0, queue: [], dirty: false };
    let tree = null;

    const ReactLive = {
      createElement: createLive,
      Fragment: Symbol('Fragment'),
      Component,
      useState(init) {
        const i = rt.cursor++;
        if (!(i in rt.hooks)) rt.hooks[i] = typeof init === 'function' ? init() : init;
        return [rt.hooks[i], (v) => {
          const next = typeof v === 'function' ? v(rt.hooks[i]) : v;
          if (Object.is(next, rt.hooks[i])) return;
          rt.hooks[i] = next;
          rt.dirty = true;
        }];
      },
      useEffect(fn, deps) {
        const i = rt.cursor++;
        const prev = rt.hooks[i];
        const same = prev && deps && prev.deps
          && deps.length === prev.deps.length
          && deps.every((d, k) => Object.is(d, prev.deps[k]));
        if (same) return;
        rt.queue.push(() => {
          if (prev && typeof prev.cleanup === 'function') prev.cleanup();
          rt.hooks[i] = { deps, cleanup: fn() };
        });
      },
      useRef(v) {
        const i = rt.cursor++;
        if (!(i in rt.hooks)) rt.hooks[i] = { current: v };
        return rt.hooks[i];
      },
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
    };

    const Comp = entry.factory((s) => {
      if (s === 'react') return ReactLive;
      throw new Error(`未预期的 require("${s}")`);
    }).__test[name];

    // 词条是 apply 时注册进来的，不跑 apply 的话 T("kDay") 只会原样返回 "kDay"，
    // 于是「找不到日K页签」这种失败看起来像组件的问题，其实是测试环境没搭好
    let dicts = null;
    let mod2 = null;
    try {
      mod2 = entry.factory((s) => {
        if (s === 'react') return ReactLive;
        throw new Error(`未预期的 require("${s}")`);
      });
    } catch { /* 下面按 fail 处理 */ }
    const Comp2 = mod2?.__test?.[name] ?? Comp;
    try {
      mod2?.apply({
        effect: (fn) => { fn(); return () => {}; },
        locale: {
          register: (ns, d) => { dicts = d; return () => {}; },
          // 懒查表：bind 可能在 register 之前被调用，直接取值会拿到 null
          bind: () => (k) => dicts?.zh?.[k] ?? k,
        },
        slots: { inject: (s, fn) => { fn(); return () => {}; }, register: () => () => {} },
      });
    } catch { /* 词条缺失只影响文案断言，不该让整块挂掉 */ }

    /** React 在 effect 之前把 ref 挂上，这里照做，否则滚轮 effect 拿不到元素 */
    const attachRefs = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.props && node.props.ref && typeof node.props.ref === 'object') node.props.ref.current = node;
      for (const c of node.children ?? []) attachRefs(c);
      attachRefs(node.props?.children);
    };

    const paint = () => {
      rt.cursor = 0;
      rt.dirty = false;
      tree = Comp2(props);
      attachRefs(tree);
    };

    paint();
    for (let i = 0; i < 10; i += 1) {
      for (const job of rt.queue.splice(0)) job();
      await tick();
      if (rt.dirty) paint();
      else if (rt.queue.length === 0) break;
    }

    /**
     * 往树上找第一个满足条件的元素；函数组件会被展开。
     * 带 seen 集合：树里一旦出现回边（元素把自己挂进自己的 props）会无限递归，
     * 那会以 Maximum call stack size exceeded 的形式炸掉整个自检文件，
     * 把后面所有用例一起埋掉 —— 比断言失败难查得多。
     */
    let cycles = 0;
    const walk = (node, visit, seen) => {
      if (!node || typeof node !== 'object') return false;
      if (seen.has(node)) { cycles++; return false; }
      seen.add(node);
      if (visit(node)) return true;
      for (const c of node.children ?? []) if (walk(c, visit, seen)) return true;
      if (node.props && walk(node.props.children, visit, seen)) return true;
      return false;
    };
    const find = (pred, node = tree) => {
      const hit = { v: null };
      walk(node, (n) => { if (n.type && pred(n)) { hit.v = n; return true; } return false; }, new WeakSet());
      return hit.v;
    };
    const all = (pred, node = tree, out = []) => {
      walk(node, (n) => { if (n.type && pred(n)) out.push(n); return false; }, new WeakSet());
      return out;
    };
    const cycleCount = () => cycles;
    /** 派发事件后把重渲染跑完 */
    const fire = async (el, name, ev) => {
      for (const x of el.listeners[name] ?? []) x.fn(ev);
      for (let i = 0; i < 6; i += 1) {
        for (const job of rt.queue.splice(0)) job();
        await tick();
        if (rt.dirty) paint();
        else break;
      }
    };
    const click = async (el) => {
      const fn = el.props.onClick ?? el.props['onClick'];
      if (fn) fn({ preventDefault() {}, stopPropagation() {} });
      for (let i = 0; i < 6; i += 1) {
        for (const job of rt.queue.splice(0)) job();
        await tick();
        if (rt.dirty) paint();
        else break;
      }
    };

    return { rt, find, all, fire, click, cycleCount, get tree() { return tree; } };
  }
  globalThis.__mountLive = mountLive;

  // 真实数据形状：分时 242 点、K 线 250 根
  const SEQ = [];
  for (let i = 0; i < 250; i += 1) {
    const t = 100 + Math.sin(i / 9) * 8;
    SEQ.push({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: t, close: t + 1, high: t + 2, low: t - 2,
      volume: 1000 + i, changePct: i % 2 ? 0.5 : -0.5,
    });
  }
  const MIN_PTS = [];
  for (let i = 0; i < 242; i += 1) {
    const m = i < 120 ? 570 + i : 780 + (i - 120);
    MIN_PTS.push({
      time: `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`,
      price: 100 + Math.sin(i / 7) * 3, avg: 100 + Math.sin(i / 9) * 1.5, volume: 10 + i,
    });
  }
  // 板块下钻的假响应：20 只一页、共 3 页 —— 与宿主 /board 的真实形状一致
  const BOARD_ROWS = Array.from({ length: 20 }, (_, i) => ({
    code: `60${String(i).padStart(4, '0')}`, name: `成分股${i}`, price: 10 + i, changePct: 9 - i * 0.3,
  }));
  globalThis.fetch = async (url) => {
    const u = String(url);
    // code=999999 专门用来模拟「撞上同花顺免费上限」的那种响应
    const trunc = u.includes('code=999999');
    const body = u.includes('/kline')
      ? { ok: true, data: { code: 'sh600519', name: '测试', candles: SEQ } }
      : u.includes('/board')
        ? (() => {
            // 必须真的按 offset/size 切片：不切的话「一页渲染 10 只」永远失败不了，
            // 分页就成了摆设
            const sp = new URLSearchParams(u.split('?')[1] ?? '');
            const off = Number(sp.get('offset')) || 0;
            const sz = Number(sp.get('size')) || 20;
            return { ok: true, data: {
              items: BOARD_ROWS.slice(off, off + sz),
              page: Math.floor(off / sz) + 1,
              totalPages: Math.max(1, Math.ceil(BOARD_ROWS.length / sz)),
              offset: off, size: sz,
              ...(trunc ? { truncated: true, freeStocks: 100 } : {}) } };
          })()
        : u.includes('/quote')
          ? { ok: true, data: { items: [{ code: 'sh600519', name: '贵州茅台', kind: 'stock', board: '沪主板',
              fields: { price: 1328.26, changePct: -0.06, prevClose: 1329, open: 1322.5, high: 1348.6, low: 1321 },
              ladder: null, limit: null }], missing: [] } }
        : u.includes('/pool')
          ? { ok: true, data: { type: 'limitup', total: 12, source: '同花顺涨停池',
              // 12 条：正好能验「10 条一页、共 2 页」
              items: [
                { code: 'sz002889', name: '东方嘉盛', price: 12.5, changePct: 10.01, continueNum: 3, reason: '机器人' },
                { code: 'sz000576', name: '甘化科工', price: 8.8, changePct: 10.02, continueNum: 2, reason: '军工' },
                ...Array.from({ length: 10 }, (_, i) => ({
                  code: 'sh60' + String(1000 + i), name: '补位' + i, price: 10 + i, changePct: 10, continueNum: 1, reason: '测试',
                })),
              ] } }
          : { ok: true, data: { code: 'sh600519', name: '测试', prevClose: 100, points: MIN_PTS } };
    return { ok: true, json: async () => body };
  };

  const entry2 = globalThis.__entry;
  const bars = (hh) => hh.all((e) => e.type === 'rect'
    && /skd-k-vbar|skd-k-body/.test(String(e.props.className ?? ''))).length;
  const hint = (hh) => hh.all((e) => e.props?.className === 'skd-k-hint')
    .map((e) => (Array.isArray(e.children) ? e.children.join('') : ''))[0] ?? '';

  // ---- 默认页签（分时）必须能滚 ----
  // 这条就是用户踩的坑：默认落在分时，而缩放/平移当时只对 K 线生效，
  // 提示文字却无条件写着「Ctrl+滚轮缩放」—— 说得到、做不到。
  {
    const m = await mountLive(entry2, 'Kline', { code: 'sh600519' });
    const svg = m.find((e) => e.type === 'svg');
    check('交互：默认页签渲染出图（不是空壳）', svg !== null, String(!!svg));
    check('交互：svg 上装了滚轮监听', (svg?.listeners?.wheel ?? []).length === 1,
      String((svg?.listeners?.wheel ?? []).length));
    // passive 必须是 false：默认 passive 时 preventDefault 无效，图放大了整页也跟着滚
    check('交互：滚轮监听注册为 passive:false（否则拦不住页面滚动）',
      svg?.listeners?.wheel?.[0]?.opts?.passive === false,
      JSON.stringify(svg?.listeners?.wheel?.[0]?.opts));
    check('交互：svg 上装了按下与移动（拖动平移的入口）',
      typeof svg?.props?.onMouseDown === 'function' && typeof svg?.props?.onMouseMove === 'function',
      `${typeof svg?.props?.onMouseDown} / ${typeof svg?.props?.onMouseMove}`);
    check('交互：默认是分时，全天 242 点都画出来', bars(m) === 242, String(bars(m)));
    check('交互：分时也给出了缩放提示（提示与能力必须一致）',
      hint(m).includes('缩放'), JSON.stringify(hint(m)));

    // Ctrl + 向上滚 = 放大
    await m.fire(svg, 'wheel', { ctrlKey: true, deltaY: -1, clientX: 360, preventDefault() {} });
    const after = bars(m);
    check('交互：分时上 Ctrl+向上滚真的放大了（这就是用户说「没效果」的那一步）',
      after < 242 && after > 0, `242 → ${after}`);

    // 不按 Ctrl 时不能拦截滚轮，否则页面滚不动
    const pd = { called: false };
    await m.fire(svg, 'wheel', { ctrlKey: false, deltaY: -1, clientX: 360, preventDefault() { pd.called = true; } });
    check('交互：不按 Ctrl 时不拦截滚轮（页面该滚还得滚）', pd.called === false, String(pd.called));

    // 拖动平移：先按下滑动，视窗应该移动（根数不变，起止变了）
    const svg2 = m.find((e) => e.type === 'svg');
    await m.fire(svg2, 'mousedown', { clientX: 360, currentTarget: svg2 });
    const beforeDrag = bars(m);
    await m.fire(svg2, 'mousemove', { clientX: 60, currentTarget: svg2 });
    check('交互：按住拖动不改变根数（只有缩放才改根数）', bars(m) === beforeDrag,
      `${beforeDrag} → ${bars(m)}`);

    // 切到日K
    const tab = m.all((e) => e.props?.className === 'skd-tab'
      && String(e.children?.[0]) === '日K')[0];
    check('交互：能找到日K页签', tab !== undefined, String(!!tab));
    await m.click(tab);
    check('交互：切到日K后画的是 120 根（默认视窗）', bars(m) === 120, String(bars(m)));
    const svg3 = m.find((e) => e.type === 'svg');
    await m.fire(svg3, 'wheel', { ctrlKey: true, deltaY: -1, clientX: 360, preventDefault() {} });
    check('交互：日K 上 Ctrl+向上滚也能放大', bars(m) < 120, String(bars(m)));
  }
}
// ---- 板块格子：三个维度 + 可下钻 + 20 只/页 + 翻得动 ---------------------------
// 用户要的就是这三件事，所以断言必须落在「格子出来了 / 点得下去 / 翻得动」上，
// 而不是「组件返回了一个对象」。降级（rank 整段缺失）也在这里验，
// 因为 BoardGrid 带 hook，不能当纯函数直接调。
console.log('\n【板块格子】\n');
{
  const entry3 = globalThis.__entry;
  // mountLive 定义在上一块的块作用域里，靠 globalThis 暴露出来
  const mountLive = globalThis.__mountLive;
  const mk10 = (f) => Array.from({ length: 10 }, (_, i) => f(i));
  const RANK = {
    up: mk10((i) => ({
      code: `8811${String(i).padStart(2, '0')}`, name: `涨行业${i}`, changePct: 3 - i * 0.2,
      upCount: 10 + i, downCount: 5, leader: { name: `龙头${i}`, price: 10, changePct: 5 },
    })),
    down: mk10((i) => ({
      code: `8812${String(i).padStart(2, '0')}`, name: `跌行业${i}`, changePct: -3 + i * 0.2,
      upCount: 1, downCount: 20 + i, leader: { name: `抗跌${i}` },
    })),
    limit: mk10((i) => ({
      name: `概念${i}`, limitUpNum: 18 - i, continuousNum: 4, high: '3天3板',
      // 留最后一个没有 drillCode：映射不到同花顺代码时必须画成不可点，
      // 而不是让用户点下去看到一个空面板
      drillCode: i === 9 ? '' : `3015${String(i).padStart(2, '0')}`,
      drillKind: i === 9 ? '' : 'gn',
    })),
  };

  // 桩件的 walk 只遍历 children、不展开子组件，所以：
  // 找「子组件有没有被挂上」靠 type.name，「子组件渲染出了什么」要把子组件单独挂一遍。
  const comp = (m, name) => m.find((e) => typeof e.type === 'function' && e.type.name === name);

  // 降级：整段缺失不能白屏
  {
    const m = await mountLive(entry3, 'BoardGrid', { rank: undefined });
    const msg = comp(m, 'Msg');
    check('板块格子：rank 整段缺失时给出 Msg 提示而不是抛错',
      Boolean(msg) && String(msg.props?.text ?? '').length > 0, JSON.stringify(msg?.props?.text));
    check('板块格子：rank 整段缺失时不渲染格子',
      m.all((e) => String(e.props?.className ?? '').split(' ').includes('skd-bcell')).length === 0);
  }

  const m = await mountLive(entry3, 'BoardGrid', { rank: RANK, onPick: () => {} });
  const cells = () => m.all((e) => String(e.props?.className ?? '').split(' ').includes('skd-bcell'));
  const tabs = () => m.all((e) => e.props?.className === 'skd-btab');

  // 只有两个维度：涨最狠 / 跌最狠。
  // 「涨停最多」那个 tab 已经删掉 —— 它和上面那张涨停卡讲的是同一批股票，
  // 两个入口只会让人以为是两回事。
  check('板块格子：只有两个维度 tab（涨最狠 / 跌最狠）', tabs().length === 2, String(tabs().length));
  check('板块格子：不再有「涨停最多」tab',
    tabs().every((t) => String(t.children?.[0]) !== '涨停最多'),
    tabs().map((t) => String(t.children?.[0])).join(','));
  check('板块格子：默认维度渲染 10 个格子', cells().length === 10, String(cells().length));
  const cellText = (el) => (el?.children ?? []).map((c) => (c?.children ?? []).join?.('') ?? '').join('|');
  check('板块格子：格子里有板块名和涨跌幅',
    cellText(cells()[0]).includes('涨行业0') && cellText(cells()[0]).includes('3.00%'),
    cellText(cells()[0]).slice(0, 60));

  // data-d 的值域断言。这里曾经写成 dir(x.changePct)，而 dir() 返回的是 CSS 类名
  // "skd-up"，于是 data-d="skd-up" 与 [data-d="up"] 永不匹配 —— 格子一格底色都没有，
  // 浅色主题下一片白。用户报的现象是「点上去按钮变全白」。
  // 只断言「有 data-d 这个属性」是测不出来的，必须断言它取哪几个值。
  const dvals = () => cells().map((c) => String(c.props?.['data-d']));
  check('板块格子：data-d 只取 up/down/flat 三个纯值（不是 CSS 类名）',
    dvals().every((v) => ['up', 'down', 'flat'].includes(v)), dvals().slice(0, 4).join(','));
  check('板块格子：涨最狠维度第一个格子是 up（会画成红色底）',
    dvals()[0] === 'up', String(dvals()[0]));

  // 跌最狠维度必须是 down，不能也是 up —— 否则红绿反过来，用户会把跌看成涨
  const downTab = tabs().find((t) => String(t.children?.[0]) === '跌最狠');
  if (downTab) {
    await m.click(downTab);
    check('板块格子：跌最狠维度的格子是 down（会画成绿色底）',
      dvals()[0] === 'down', String(dvals()[0]));
  }

  // 回到涨最狠，点第一个格子下钻
  const upTab = tabs().find((t) => String(t.children?.[0]) === '涨最狠');
  if (upTab) await m.click(upTab);
  check('板块格子：点格子前没有挂上下钻面板', comp(m, 'BoardDrill') === null);
  await m.click(cells()[0]);
  const drilled = comp(m, 'BoardDrill');
  check('板块格子：点格子后把下钻面板挂上了', drilled !== null);
  check('板块格子：下钻的是被点的那个板块（不是第一个）',
    drilled?.props?.drill?.name === '涨行业0' && drilled?.props?.drill?.kind === 'thshy'
      && drilled?.props?.drill?.code === '881100',
    JSON.stringify(drilled?.props?.drill));

  // 再点一次同一个格子应收起
  await m.click(cells()[0]);
  check('板块格子：再点同一个格子会收起面板', comp(m, 'BoardDrill') === null);

  // ---- 下钻面板本身：单独挂载，验真的渲染出了什么 ----
  const d = await mountLive(entry3, 'BoardDrill', {
    drill: { code: '881100', kind: 'thshy', name: '涨行业0' },
    onPick: () => {},
    onClose: () => {},
  });

  const title = d.all((e) => e.props?.className === 'skd-bdrill-t')
    .map((e) => (Array.isArray(e.children) ? e.children.join('') : ''))[0] ?? '';
  check('板块下钻：标题写明是哪个板块的成分股', title.includes('涨行业0') && title.includes('成分股'),
    JSON.stringify(title).slice(0, 64));

  const trs = d.all((e) => e.type === 'tr').filter((r) => r.props?.key !== undefined);
  // 用户要求所有下钻明细统一 10 条一页
  check('板块下钻：一页渲染 10 只', trs.length === 10, String(trs.length));
  check('板块下钻：一页 10 行都带代码',
    d.all((e) => e.props?.className === 'skd-code').length === 10,
    String(d.all((e) => e.props?.className === 'skd-code').length));

  const pager = d.all((e) => e.props?.className === 'skd-pager')[0];
  const pbtns = pager ? d.all((e) => e.props?.className === 'skd-btn', pager) : [];
  check('板块下钻：有上一页/下一页两个按钮', pbtns.length === 2, String(pbtns.length));
  check('板块下钻：第 1 页时「上一页」不可点', pbtns[0]?.props?.disabled === true, String(pbtns[0]?.props?.disabled));
  check('板块下钻：第 1 页时「下一页」可点', pbtns[1]?.props?.disabled === false, String(pbtns[1]?.props?.disabled));

  // 页码标签必须带单位「页」：只写 `1 / 62` 会被误读成「62 只股票」——
  // 用户就是这么报的（「感觉总页数是股票数量」）。
  const pageLabel = () => d.all((e) => e.props?.className === 'skd-meta' && /\/ \d+/.test(String(e.children?.[0])))
    .map((e) => String(e.children?.[0])).find((s) => /^\d+ \/ \d+/.test(s)) ?? '';
  // 20 条数据、10 条一页 → 2 页
  check('板块下钻：页码显示 1 / 2 页（带单位，不会被读成只数）',
    pageLabel() === '1 / 2 页', JSON.stringify(pageLabel()));

  await d.click(pbtns[1]);
  check('板块下钻：点「下一页」后页码变成 2', pageLabel() === '2 / 2 页', JSON.stringify(pageLabel()));
  // 左右分栏：用户反馈「详情在下方出现，使用上还得滑动有点累」。
  // 断言点开股票后真的变成了两栏，而不是仍然堆在下面。
  check('板块下钻：没点开股票时是单栏（不凭空留一条空白列）',
    d.all((e) => e.props?.className === 'skd-split').length === 0);
  const nameBtn = d.all((e) => String(e.props?.className ?? '').includes('skd-name-btn'))[0];
  check('板块下钻：能点到股票名', Boolean(nameBtn));
  await d.click(nameBtn);
  check('板块下钻：点开股票后变成左右两栏',
    d.all((e) => e.props?.className === 'skd-split').length === 1,
    String(d.all((e) => e.props?.className === 'skd-split').length));
  check('板块下钻：左栏是名单、右栏是详情（两者同时存在）',
    d.all((e) => e.props?.className === 'skd-split-main').length === 1
    && d.all((e) => e.props?.className === 'skd-split-side').length === 1);
  // 右栏里必须真的挂着 StockPeek（明细 + K 线），而不是空栏。
  // 原来这条写的是 includes('skd-d') —— 那是假通过：skd-drill-body 里也含 'skd-d'。
  const side = d.all((e) => e.props?.className === 'skd-split-side')[0];
  check('板块下钻：右栏里挂的是 StockPeek（明细与 K 线），不是空栏',
    (side?.children ?? []).some((c) => typeof c?.type === 'function' && c.type.name === 'StockPeek'),
    (side?.children ?? []).map((c) => (typeof c?.type === 'function' ? c.type.name : String(c?.type))).join(','));

  check('板块下钻：翻到第 2 页后「上一页」变可点',
    d.all((e) => e.props?.className === 'skd-btn', d.all((e) => e.props?.className === 'skd-pager')[0])[0]
      ?.props?.disabled === false);

  // ---- 撞到同花顺免费上限时，必须明说「只开放前 5 页」----
  // 不说的话用户会一直点「下一页」，点到最后一片空白，以为插件坏了。
  const TRUNC = await mountLive(entry3, 'BoardDrill', {
    drill: { code: '999999', kind: 'thshy', name: '大板块' },
    onPick: () => {},
    onClose: () => {},
  });
  const metaText = TRUNC.all((e) => e.props?.className === 'skd-meta')
    .map((e) => String(e.children?.[0] ?? '')).join(' | ');
  check('板块下钻：上游还有更多页时明说「只开放前 5 页」',
    metaText.includes('前 5 页'), metaText.slice(0, 90));
}

// ---- 涨停格子：涨停/炸板/跌停/连板梯队 全部可点并下钻 -----------------------
// 用户的原话是「涨停、炸板、跌停、连板梯队搞成可以下钻的，也变成格子的形态」。
// 所以断言要落在「格子出来了 / 点得进去 / 点进去看到的是名单」上。
console.log('\n【涨停格子】\n');
{
  const entry4 = globalThis.__entry;
  const mountLive = globalThis.__mountLive;
  const comp = (m, name) => m.find((e) => typeof e.type === 'function' && e.type.name === name);

  // 降级：overview 整段缺失不能白屏
  {
    const m = await mountLive(entry4, 'LimitGrid', { overview: undefined, ladder: undefined, pools: undefined });
    check('涨停格子：overview 缺失时给 Msg 提示而不是抛错', Boolean(comp(m, 'Msg')));
    check('涨停格子：overview 缺失时不渲染格子',
      m.all((e) => String(e.props?.className ?? '').split(' ').includes('skd-bcell')).length === 0);
  }

  // pools 用本地扫描口径：跌停 27 家（同花顺口径是 22，两者必须分开用）
  const POOLS = { limitUp: 50, limitDown: 27, burst: 24, at: Date.now(), source: '本地全市场扫描（腾讯行情）' };
  const m = await mountLive(entry4, 'LimitGrid', {
    overview: OVERVIEW_REAL, ladder: LADDER_REAL, pools: POOLS, onPick: () => {},
  });
  const cells = () => m.all((e) => String(e.props?.className ?? '').split(' ').includes('skd-bcell'));
  const text = (el) => (el?.children ?? []).map((c) => (c?.children ?? []).join?.('') ?? '').join('|');
  const all = () => cells().map(text).join(' ‖ ');
  const panels = () => m.all((e) => e.props?.className === 'skd-bdrill');
  /** 递归取文本：面板是 table → tr → td 的嵌套结构，只取一层会得到一堆 [object Object] */
  const deepText = (node, out = []) => {
    if (node == null) return out;
    if (Array.isArray(node)) { node.forEach((x) => deepText(x, out)); return out; }
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
    if (typeof node === 'object') { deepText(node.children, out); deepText(node.props?.children, out); }
    return out;
  };
  const panelText = () => panels().map((x) => deepText(x).join(' ')).join(' ');

  // 数字必须真的出来 —— 这是当初「涨停/炸板/跌停 齐刷刷显示 —」那个 bug 的回归闸
  check('涨停格子：涨停家数 47 是真的数字', all().includes('47 家'), all().slice(0, 70));
  check('涨停格子：炸板家数 19 是真的数字', all().includes('19 家'), all().slice(0, 90));
  check('涨停格子：跌停取本地扫描的 27，不是同花顺的 22（数字必须等于列表条数）',
    all().includes('27 家') && !all().includes('22 家'), all().slice(0, 120));
  check('涨停格子：封板率与历史家数渲染出来了',
    all().includes('71.21') && all().includes('66'), all().slice(0, 140));
  check('涨停格子：连板高度也做成了格子',
    all().includes('3 最高板') && all().includes('2 最高板'), all().slice(-120));
  check('涨停格子：没有「— 家」漏出来', !/—\s*家/.test(all()), all().slice(0, 160));

  // 27 与行情软件的 22 不同，不标口径就会被当成算错
  check('涨停格子：跌停格子标了「本地扫描」口径', all().includes('本地扫描'), all().slice(0, 220));

  // 颜色必须由格子语义决定，不能从数量推。
  // 曾经写成 dirKey(count)，于是「跌停 27 家」因为 27 > 0 被判成「涨」涂成红色 ——
  // 用户一眼就看出来了（「但是他是红色的这个格子」）。
  // 断言每个格子的 data-d 取值，而不只是「格子存在」。
  const tileD = (label) => {
    const el = cells().find((c) => text(c).includes(label));
    return el ? String(el.props?.['data-d']) : '(找不到这个格子)';
  };
  check('涨停格子：涨停是 up（红）', tileD('涨停') === 'up', tileD('涨停'));
  check('涨停格子：跌停是 down（绿），不是红', tileD('跌停') === 'down', tileD('跌停'));
  check('涨停格子：炸板是 warn（警示色），不冒充涨跌',
    tileD('炸板') === 'warn', tileD('炸板'));
  check('涨停格子：首板是 flat（中性），推算值不该带方向',
    tileD('首板') === 'flat', tileD('首板'));

  // 首板是推算值，没有对应名单，所以不该做成可点按钮
  // 首板以前不可点（当时以为推算值没有名单）。实际可以：名单 = 涨停池 − 连板梯队，
  // 宿主 /pool?type=firstboard 算好了，实测 46 − 11 = 35 严丝合缝。
  const firstTile = cells().find((c) => text(c).includes('36 家'));
  check('涨停格子：首板也能点开（名单 = 涨停池 − 连板梯队）',
    firstTile?.type === 'button', String(firstTile?.type));

  // 术语后面的问号说明：用户问过「炸板是什么意思」，说明这些行话不是默认知识
  const hintEls = () => collectEls(m.tree).filter((n) => String(n.props?.className ?? '').includes('skd-hint'));
  check('涨停格子：每个格子都挂了问号', hintEls().length >= 5, String(hintEls().length));
  check('涨停格子：问号上的说明都不是空话（每条 > 10 字）',
    hintEls().every((n) => String(n.props?.title ?? '').length > 10),
    hintEls().map((n) => (n.props?.title ?? '').length).join(','));
  check('涨停格子：炸板的说明里解释了它是什么',
    hintEls().some((n) => /炸板/.test(String(n.props?.title ?? '')) && /没封住|未封住|打开/.test(String(n.props?.title ?? ''))),
    hintEls().map((n) => String(n.props?.title ?? '').slice(0, 18)).join(' | '));

  // 点连板高度 → 明细从 ladder 内存里取，不额外请求
  const h3 = cells().find((c) => text(c).includes('3 最高板'));
  check('涨停格子：连板高度格子是可点按钮', h3?.type === 'button', String(h3?.type));
  await m.click(h3);
  check('涨停格子：点连板高度后出现明细面板', panels().length === 1, String(panels().length));
  const ladderText = panelText();
  check('涨停格子：连板明细里是该高度的股票（东方嘉盛）',
    ladderText.includes('东方嘉盛'), ladderText.slice(0, 120));
  check('涨停格子：连板明细里没有别的板高的股票（甘化科工是 2 板）',
    !ladderText.includes('甘化科工'), ladderText.slice(0, 120));

  // 再点一次收起
  await m.click(h3);
  check('涨停格子：再点同一个格子会收起面板', panels().length === 0);

  // 点涨停 → 走 /pool 取名单
  const upTile = cells().find((c) => text(c).includes('47 家'));
  await m.click(upTile);
  check('涨停格子：点涨停后出现明细面板', panels().length === 1, String(panels().length));
  const poolText = panelText();
  check('涨停格子：涨停明细里拿到了股票（东方嘉盛 / 甘化科工）',
    poolText.includes('东方嘉盛') && poolText.includes('甘化科工'), poolText.slice(0, 140));
  // 池子明细也统一 10 条一页（mock 给了 12 条 → 2 页）
  const poolRows = panels()[0]
    ? collectEls(panels()[0]).filter((n) => n.type === 'tr' && n.props?.key !== undefined)
    : [];
  check('涨停格子：池子明细一页 10 条（12 条数据不该一次全铺出来）',
    poolRows.length === 10, String(poolRows.length));
  const poolPager = panels()[0]
    ? collectEls(panels()[0]).filter((n) => n.props?.className === 'skd-pager')
    : [];
  const poolPagerText = poolPager[0]
    ? collectEls(poolPager[0]).map((n) => (Array.isArray(n.children) ? n.children.join('') : '')).join(' ')
    : '';
  check('涨停格子：池子明细有分页，且显示 1 / 2 页',
    poolPagerText.includes('1 / 2'), poolPagerText.slice(0, 60));

  check('涨停格子：明细里标了数据来源（同花顺涨停池）',
    poolText.includes('同花顺涨停池'), poolText.slice(0, 140));
  // 用户明确说「连板这个列不需要展示」，所以列拿掉了；
  // 但连板高度是有用信息，挪到名称的 title 上，断言它还在。
  check('涨停格子：明细表回到三列（名称/现价/涨跌），不再有连板列',
    collectEls(panels()[0]).filter((n) => n.type === 'th').length === 3,
    String(collectEls(panels()[0]).filter((n) => n.type === 'th').length));
  check('涨停格子：连板高度保留在名称的 title 上（列没了但信息没丢）',
    collectEls(panels()[0]).some((n) => String(n.props?.title ?? '').includes('3 板')),
    collectEls(panels()[0]).map((n) => n.props?.title).filter(Boolean).slice(0, 3).join(' | '));
}

// ---- 点击坐标换算成下标 --------------------------------------------------------
{
  const n = 242;
  const pick = chartPick(n);
  const bw = CH.PW / n;
  const mid = (i) => CH.ML + i * bw + bw / 2;
  check('换算：第 0 格中心 → 下标 0', pick(mid(0)) === 0, String(pick(mid(0))));
  check('换算：第 100 格中心 → 下标 100', pick(mid(100)) === 100, String(pick(mid(100))));
  check('换算：最后一格中心 → 下标 241', pick(mid(241)) === 241, String(pick(mid(241))));
  check('换算：落在左边界外 → null（不能让光标卡在第 0 格）', pick(CH.ML - 1) === null, String(pick(CH.ML - 1)));
  check('换算：落在右边界外 → null', pick(CH.ML + CH.PW + 1) === null, String(pick(CH.ML + CH.PW + 1)));
  check('换算：负数坐标 → null', pick(-500) === null, String(pick(-500)));
  check('换算：0 个点时任何坐标都给 null（不能返回 0 或 NaN）',
    chartPick(0)(100) === null, String(chartPick(0)(100)));
}

// 缩放与平移。这两个是纯函数，所以「滚一格到底变几根」「拖出去会不会拖丢」
// 都能在这里锁死，不用等用户拿鼠标试。
{
  const N = 250;
  const w = (size, end) => ({ size, end });
  // 实际显示根数：起点是 max(0, end - size)，所以是 min(size, end)，不是 end - size
  const span = (v) => Math.min(v.size, v.end);

  // 方向：向上滚 = 放大 = 根数变少。第一版写成向上滚根数变多（缩小），
  // 而测试跟着这个错误假设一起写并 PASS —— 测试成了代码的镜像，什么都没锁住。
  const up = zoomWindow(w(120, N), -1, 0.5, N);
  check('缩放：向上滚一格是放大，根数变少到 96（120 ÷ 1.25）', up.size === 96, String(up.size));
  const dn = zoomWindow(w(120, N), 1, 0.5, N);
  check('缩放：向下滚一格是缩小，根数变多到 150（120 × 1.25）', dn.size === 150, String(dn.size));
  check('缩放：向下滚回去能回到原样（放大再缩小不漂移）',
    zoomWindow(up, 1, 0.5, N).size === 120, String(zoomWindow(up, 1, 0.5, N).size));

  // 到下限要向上滚（放大）才会撞上：20 ÷ 1.25 = 16，夹回 20
  check('缩放：放大到顶不会少于最少根数', zoomWindow(w(MIN_BARS, N), -1, 0.5, N).size === MIN_BARS,
    String(zoomWindow(w(MIN_BARS, N), -1, 0.5, N).size));
  const maxed = zoomWindow(w(240, N), 1, 0.5, N);
  check('缩放：缩小到顶不超过总根数', maxed.size === N && maxed.end === N, JSON.stringify(maxed));
  check('缩放：视窗永远落在 [0, nAll] 内，不会切出负数起点',
    [zoomWindow(w(120, N), -1, 0, N), zoomWindow(w(120, N), 1, 1, N)]
      .every((v) => v.end - v.size >= 0 && v.end <= N), '');

  // 「默认已经全天后还能不能放大」——这就是用户遇到的场景：分时默认 242 点，
  // 若方向写反，向上滚被上限夹住，表现就是「滚了没反应」
  const full0 = zoomWindow(w(N, N), -1, 0.5, N);
  check('缩放：视窗已经全天时，向上滚仍能放大（这是分时的默认状态）',
    full0.size < N, `${N} → ${full0.size}`);

  // 锚点：光标停在最右边时放大，右端应该贴住最新一根不动
  const rightUp = zoomWindow(w(120, N), -1, 1, N);
  check('缩放：锚在最右时放大，右端仍贴住最新一根',
    rightUp.end === N && rightUp.size < 120, JSON.stringify(rightUp));
  const leftUp = zoomWindow(w(120, N), -1, 0, N);
  check('缩放：锚在最左时放大，看的是更早的行情（右端往前走）',
    leftUp.end < N && leftUp.size < 120, JSON.stringify(leftUp));

  // 平移
  const per = CH.PW / 120;
  const right = panWindow(w(120, N), per * 10, N);
  check('平移：向右拖 10 根，窗口往回走 10 根', right.end === N - 10 && span(right) === 120,
    JSON.stringify(right));
  check('平移：拖动不改变窗口大小（只有缩放才改）', span(panWindow(w(120, N), 999, N)) === 120,
    JSON.stringify(panWindow(w(120, N), 999, N)));
  check('平移：拖到最右端不会越过最新一根', panWindow(w(120, N), -99999, N).end === N,
    JSON.stringify(panWindow(w(120, N), -99999, N)));
  check('平移：拖到最左端不会把起点拖成负数', panWindow(w(120, N), 99999, N).end === 120,
    JSON.stringify(panWindow(w(120, N), 99999, N)));
  check('平移：向左拖是看更新的行情（方向不能反）',
    panWindow(w(120, 150), -per * 5, N).end === 155, String(panWindow(w(120, 150), -per * 5, N).end));
}

// ---- 整页与药丸的渲染：先喂一份数据，再渲染 --------------------------------------
// useDesk 读的是 desk.get()，所以只要先让 desk 真拉一次，桩件里就能渲染出「有数据」的样子。
// 这是方案 §8 第 4 条（药丸显示上证点位 + 涨跌幅 + 自选涨跌家数）唯一能自己验的路径 ——
// 否则那条验收只能靠肉眼在浏览器右下角看。
//
// 固定装置按真实 /dashboard 响应的形状写（不是按记忆），字段路径与 lib/routes.js 一致。
const DASH_FIXTURE = {
  at: 1792392256809,
  session: { id: 'afternoon', label: '午后交易', trading: true, origin: 'server', serverLabel: '交易中', local: 'afternoon' },
  pollMs: 3000,
  indexCatalog: [{ code: 'sh000001', name: '上证指数' }],
  parts: {
    watchlist: {
      items: [
        { code: 'sh600519', name: '贵州茅台', kind: 'stock', kindFlag: 'GP-A', time: '20261019142003',
          fields: { price: 1324.52, changePct: 1.23, amount: 450006, totalCap: 16604.33 }, ladder: null, limit: null },
        { code: 'sz300750', name: '宁德时代', kind: 'stock', kindFlag: 'GP-A', time: '20261019142003',
          fields: { price: 233.1, changePct: -0.85 }, ladder: null, limit: null },
      ],
      missing: [], at: 1792392256806,
    },
    indices: {
      items: [{ code: 'sh000001', name: '上证指数', kind: 'index', kindFlag: 'ZS', time: '20261019142003',
        fields: { price: 3734.33, changePct: 0.49 }, ladder: null, limit: null }],
      missing: [], at: 1792392256806,
    },
    breadth: { up: 2327, down: 2745, flat: 501, limitUp: 48, limitDown: 23, burst: 24, counted: 5573, total: 5575, missing: 2 },
    overview: { source: '同花顺', limitUp: { today: { num: 48 } }, limitDown: { today: { num: 23 } }, tradeStatus: { name: '交易中' } },
    ladder: [{ height: 3, number: 2, stocks: [] }],
    sectorHeat: [],
    sectorsUp: { board: 'industry', direction: 'up', total: 496, items: [] },
    sectorsDown: { board: 'industry', direction: 'down', total: 496, items: [] },
  },
  sources: [{ name: '腾讯行情', healthy: true, failures: 0, retryInMs: 0 }],
  cache: { keys: 8 },
  errors: {},
  config: {
    pill: { indexCode: 'sh000001', enabled: true },
    // groups 必须有：自选表「显示哪几只」是以配置为准的（parts.watchlist 只是数字来源）。
    // 原来这份夹具没写 groups，watchGroup 一直是 null，自选表压根没被测到。
    groups: [
      { id: 'index', name: '大盘指数', items: ['sh000001'] },
      { id: 'watch', name: '自选', items: ['sh600519', 'sz300750'] },
    ],
  },
};

console.log('\n【整页与药丸渲染】\n');
globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => (String(url).includes('/dashboard')
    ? { ok: true, data: DASH_FIXTURE }
    : { ok: true, data: {} }),
});
const stopPoll = desk?.start?.();
await new Promise((r) => setTimeout(r, 60));
stopPoll?.();
const snap = desk?.get?.();
check('desk 真的拉到了数据（桩件的 fetch 喂得进去）', snap?.phase === 'ready', String(snap?.phase));
check('快照用的是那份固定装置', snap?.data?.parts?.indices?.items?.[0]?.name === '上证指数');

const renderErrors = [];
const pageText = strings(DeskPage?.() ?? null, [], (name, e) => renderErrors.push(`${name}: ${e.message}`));
check('整页渲染时没有任何组件抛错', renderErrors.length === 0, renderErrors.join(' / '));
check('整页渲染出非空内容', pageText.length > 0, `${pageText.length} 段文字`);
check('整页里有指数名', pageText.includes('上证指数'), pageText.slice(0, 8).join(' / '));
check('整页里有自选股名', pageText.includes('贵州茅台'), '');
check('整页里有指数点位', pageText.includes('3734.33'), '');
check('整页里有连板梯队那一段', pageText.some((t) => t.includes('3')), '');

// 布局：大盘指数与涨跌家数并排在同一行（用户要求「把涨跌家数往上提」）。
// 断言两者的 Card 是同一个 .skd-row2 的两个直接子元素，而不是散在页面里。
const pageEls = collectEls(DeskPage?.() ?? null, []);
const row2 = pageEls.find((e) => e.props?.className === 'skd-row2');
check('大盘指数与涨跌家数在同一行（.skd-row2）', Boolean(row2));
if (row2) {
  const titles = (row2.children ?? []).map((c) => String(c?.props?.title ?? ''));
  check('这一行里正好是「大盘指数」和「涨跌家数」两张卡',
    titles.length === 2 && titles[0] === '大盘指数' && titles[1] === '涨跌家数',
    JSON.stringify(titles));
  check('这一行默认是左右两栏（data-peek=0）',
    row2.props?.['data-peek'] === '0', String(row2.props?.['data-peek']));
}

// 「移除没反应」的回归测试。
// 关键是造出错位：配置里已经删掉了，但轮询快照里还留着 —— 这正是用户点完移除后那一瞬间的真实状态。
// 表必须以配置为准。原先它直接渲染 parts.watchlist，于是点完看起来毫无反应，
// 得等下一轮轮询（盘后 60 秒）才变，用户就以为按钮坏了。
DASH_FIXTURE.config.groups = [
  { id: 'index', name: '大盘指数', items: ['sh000001'] },
  { id: 'watch', name: '自选', items: ['sz300750'] },
];
const afterRemove = strings(DeskPage?.() ?? null, [], (n, e) => renderErrors.push(`移除后/${n}: ${e.message}`));
check('配置里删掉一只后，表格立刻不再显示它（快照里其实还留着）',
  !afterRemove.includes('贵州茅台'),
  afterRemove.filter((t) => t.includes('茅台')).join('/') || '茅台已从表里消失');
check('同一轮里保留下来的那只仍在', afterRemove.includes('宁德时代'), '');
check('快照里那两只确实还在（否则上一条就是空过的，测不出东西）',
  DASH_FIXTURE.parts.watchlist.items.length === 2,
  String(DASH_FIXTURE.parts.watchlist.items.length));
// 还原，免得影响后面的用例
DASH_FIXTURE.config.groups = [
  { id: 'index', name: '大盘指数', items: ['sh000001'] },
  { id: 'watch', name: '自选', items: ['sh600519', 'sz300750'] },
];

const pillText = strings(Pill?.() ?? null);
check('药丸渲染出非空内容', pillText.length > 0, pillText.join(' / ').slice(0, 60));
check('药丸显示指数名', pillText.includes('上证指数'), pillText.join(' / '));
check('药丸显示点位', pillText.some((t) => t.includes('3734.33')), '');
check('药丸显示涨跌幅', pillText.some((t) => t.includes('0.49')), '');
// 自选两只：茅台 +1.23%、宁德 -0.85% —— 一涨一跌，家数应当是 ↑1 ↓1
check('药丸显示自选涨跌家数 ↑1 ↓1',
  pillText.some((t) => /↑\s*1/.test(t) && /↓\s*1/.test(t)), pillText.join(' / '));
check('药丸没把自己隐藏掉（没有 localStorage 桩件时也不该消失）', pillText.length > 0);

const btnText = strings(DeskButton?.({ active: false }) ?? null);
check('侧边栏按钮能渲染且带标题', btnText.includes('行情台'), btnText.join(' / '));

// 配置页（settings.plugins.tab）走的是另一条取数路径：它自己拉 /state，
// 不依赖整页那边已经把 dashboard 取好 —— 用户完全可能从没打开过行情台就先进设置。
// 所以整页绿了不代表它绿，必须单独渲染一次。
// 导出到 __test 却不验渲染等于没验，上面 DeskPage 那一课就是这么来的。
const setText = strings(SettingsTab?.() ?? null, [], (name, e) => renderErrors.push(`SettingsTab/${name}: ${e.message}`));
check('配置页能渲染出非空内容，不是白屏', setText.length > 0, `${setText.length} 段文字`);
check('配置页把当前分组名显示出来了（改配置时得看得见现状）',
  setText.some((s) => typeof s === 'string' && (s.includes('自选') || s.includes('大盘指数'))),
  setText.slice(0, 14).join(' / '));

// 两个真实响应片段（2026-10-19 14:20 实测）
const QUOTE_INDEX = {
  code: 'sh000001', name: '上证指数', kind: 'index', kindFlag: 'ZS', currency: 'CNY', time: '20261019142006',
  fields: { price: 3737.23, prevClose: 3716.28, open: 3694.12, high: 3743.8, low: 3692.29,
    change: 20.95, changePct: 0.56, amplitude: 1.39, amount: 59827381, totalCap: 652512.58, floatCap: 584597.78 },
  ladder: null, limit: null,
};
const QUOTE_STOCK = {
  code: 'sh600519', name: '贵州茅台', kind: 'stock', kindFlag: 'GP-A', currency: 'CNY', time: '20261019142003',
  fields: { price: 1328.26, prevClose: 1329, open: 1322.5, high: 1348.6, low: 1321, change: -0.74,
    changePct: -0.06, amplitude: 2.08, amount: 450006, totalCap: 16604.33, floatCap: 16604.33,
    volume: 33625, avgPrice: 1338.31, volRatio: 1.13, turnover: 0.27, limitUp: 1461.9, limitDown: 1196.1,
    orderDiff: -19, pe: 20.39, peDyn: 18.65, peStatic: 20.17, pb: 6.61, outer: 19680, inner: 13934 },
  ladder: { bids: [{ price: 1328.25, volume: 1 }, { price: 1328.24, volume: 2 }],
    asks: [{ price: 1328.27, volume: 11 }, { price: 1328.29, volume: 2 }] },
  limit: { atLimitUp: false, atLimitDown: false, burst: false },
};

// 方案 §8 的硬性验收项：指数的 fields 里根本没有这些字段，明细里就不该出现这些词
const idxText = texts(QuoteDetail({ q: QUOTE_INDEX })).join('|');
for (const forbidden of ['换手', '市盈率', '市净率', '涨停', '跌停', '委差', '盘口', '买五档']) {
  check(`指数明细不得出现「${forbidden}」`, !idxText.includes(forbidden), idxText.slice(0, 160));
}
check('指数明细确实渲染了内容', idxText.includes('上证指数') && idxText.includes('3737.23'));
check('指数明细带了时间戳', idxText.includes('2026-10-19 14:20:06'));

const stkText = texts(QuoteDetail({ q: QUOTE_STOCK })).join('|');
for (const required of ['换手', '市盈率(动)', '市净率', '涨停', '跌停', '委差', '买五档', '卖五档', '成交量', '量比']) {
  check(`个股明细出现「${required}」`, stkText.includes(required), stkText.slice(0, 160));
}
// 字段名必须真的翻译过。用户贴过来的明细里出现了裸键名 `change` / `changePct` ——
// 因为 DETAIL_GROUPS 用了这两个字段，而 zh 词条里没有它们，T() 就把键原样返回了。
check('个股明细里「涨跌额 / 涨跌幅」是译好的，不是裸键名',
  stkText.includes('涨跌额') && stkText.includes('涨跌幅')
  && !/\bchange\b/.test(stkText) && !stkText.includes('changePct'),
  stkText.slice(0, 200));

// 明细字段也挂问号（用户要求「这些明细的字段也应该有描述」）
{
  const hintOf = (q) => collectEls(QuoteDetail({ q }), [])
    .filter((n) => String(n.props?.className ?? '').includes('skd-hint'))
    .map((n) => String(n.props?.title ?? ''));
  const sh = hintOf(QUOTE_STOCK);
  check('个股明细的字段挂了问号（至少 20 条）', sh.length >= 20, String(sh.length));
  check('每条说明都不是空话（> 8 字）', sh.every((x) => x.length > 8), sh.map((x) => x.length).join(','));
  check('换手率的说明解释了它是什么（含「成交量」或「流通股本」）',
    sh.some((x) => /换手率/.test(x) && /流通股本|成交量/.test(x)),
    sh.filter((x) => /换手/.test(x)).join(' | ').slice(0, 80));
  check('量比的说明解释了它是什么（含「5 日」或「每分钟」）',
    sh.some((x) => /量比/.test(x) && /5 日|每分钟/.test(x)),
    sh.filter((x) => /量比/.test(x)).join(' | ').slice(0, 80));
}

check('明细 q 为空时不渲染', QuoteDetail({ q: null }) === null);

// 持仓与监控已并入自选表（用户：这应该是自选股票的一行吧）。
{
  const ROWS = [{ code: 'sh600519', name: '贵州茅台', kind: 'stock',
    fields: { price: 1328.26, prevClose: 1329, changePct: -0.06, turnover: 0.27, amount: 450006 } }];
  const CFG = { positions: { sh600519: { cost: 1200, shares: 100 } },
    alerts: { sh600519: { low: 1200, high: 1400 } } };
  const base = { list: ROWS, watch: true, onRemove: () => {}, onPick: () => {}, config: CFG };

  const ro = QuoteTable({ ...base, editingCode: null, draft: null });
  const rot = texts(ro).join('|');
  check('自选表里带出了成本与份额', rot.includes('1200') && rot.includes('100'), rot.slice(0, 240));
  check('自选表算出今日盈亏 −74.00', rot.includes('-74.00'), rot.slice(0, 240));
  check('自选表算出持仓盈亏 +12,826.00', rot.includes('+12,826.00'), rot.slice(0, 260));
  check('只读态没有输入框（要先点「编辑」）',
    collectEls(ro, []).filter((n) => n.type === 'input').length === 0);

  const DRAFT = { positions: { sh600519: { cost: 1200, shares: 100 } },
    alerts: { sh600519: { low: 1200, high: 1400 } } };
  const ed = QuoteTable({ ...base, editingCode: 'sh600519', draft: DRAFT, onChange: () => {} });
  const allIns = collectEls(ed, []).filter((n) => n.type === 'input');
  const ins = allIns.filter((n) => n.props?.type === 'number');
  check('编辑态出现成本/份额/低价/高价四个数字输入框', ins.length === 4, String(ins.length));
  check('输入框带出草稿的值（成本,份额,低价,高价）',
    ins.map((x) => x.props?.value).join(',') === '1200,100,1200,1400',
    ins.map((x) => x.props?.value).join(','));
  check('另有两个勾选框：今买 + 持有', allIns.filter((n) => n.props?.type === 'checkbox').length === 2,
    String(allIns.filter((n) => n.props?.type === 'checkbox').length));

  // ---- 旧行情不能冒充今天的盈亏 ----
  // 用户实测：2026-10-20 早 9:09 未开盘时，腾讯仍返回 10-19 的快照，
  // 于是 (8.27−8.14)×200=+26 被当成「今天的盈亏」继续显示，看起来就是没清零。
  {
    check('quoteDate 解析腾讯的 time 字段', quoteDate({ time: '20261019161439' }) === '2026-10-19',
      String(quoteDate({ time: '20261019161439' })));
    check('quoteDate 对缺失/脏值返回 null 而不是瞎猜',
      quoteDate({}) === null && quoteDate({ time: 'abc' }) === null && quoteDate(null) === null);
    check('todayKey 是 YYYY-MM-DD 且按北京时区', /^\d{4}-\d{2}-\d{2}$/.test(todayKey()), todayKey());

    const yRows = [{ code: 'sz159558', name: '半导体设备ETF', kind: 'fund',
      fields: { price: 0.89, prevClose: 0.936, changePct: -4.92, turnover: 7.75, amount: 133700,
        time: '20261019161439' } }];
    const yCfg = { positions: { sz159558: { cost: 0.905, shares: 1000 } }, alerts: {} };
    const ytxt = texts(QuoteTable({ list: yRows, watch: true, onPick: () => {}, config: yCfg,
      editingCode: null, draft: null })).join('|');
    check('昨天的行情：今日盈亏显示「—」，不冒充今天的', !ytxt.includes('-46.00'), ytxt.slice(0, 240));
    check('昨天的行情：名称旁标出「昨收」', ytxt.includes('昨收'), ytxt.slice(0, 200));
    check('昨天的行情：持仓盈亏照常算（-15.00 是真实盈亏）', ytxt.includes('-15.00'), ytxt.slice(0, 240));

    // 今天的行情（time 是今天）→ 今日盈亏正常算
    const tKey = todayKey().replace(/-/g, '');
    const tRows = [{ code: 'sz159558', name: '半导体设备ETF', kind: 'fund',
      fields: { price: 0.89, prevClose: 0.936, changePct: -4.92, turnover: 7.75, amount: 133700,
        time: tKey + '101500' } }];
    const ttxt = texts(QuoteTable({ list: tRows, watch: true, onPick: () => {}, config: yCfg,
      editingCode: null, draft: null })).join('|');
    check('今天的行情：今日盈亏按昨收算出来（-46.00）', ttxt.includes('-46.00'), ttxt.slice(0, 240));
    check('今天的行情：不再标「昨收」', !ttxt.includes('昨收'), ttxt.slice(0, 200));

    // 今买带日期 → 只有等于行情所属日期才改基准，昨天勾的今天自动失效
    const yesCfg = { positions: { sz159558: { cost: 0.905, shares: 1000, todayBuy: tKey.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') } }, alerts: {} };
    const ytxt2 = texts(QuoteTable({ list: yRows, watch: true, onPick: () => {}, config: yesCfg,
      editingCode: null, draft: null })).join('|');
    check('今买是昨天勾的 → 对昨天的行情不生效（今日盈亏仍是「—」）', !ytxt2.includes('-15.00') || ytxt2.includes('—'), ytxt2.slice(0, 240));
    const ttxt2 = texts(QuoteTable({ list: tRows, watch: true, onPick: () => {}, config: yesCfg,
      editingCode: null, draft: null })).join('|');
    check('今买是今天勾的 → 对今天的行情生效（今日盈亏 = 持仓盈亏 = -15.00）',
      ttxt2.includes('-15.00'), ttxt2.slice(0, 240));
  }

  // ---- 刷新倒计时 ----
  {
    check('倒计时：刚取完数据 = 完整间隔', nextRefreshSec(1000, 10, 1000) === 10, String(nextRefreshSec(1000, 10, 1000)));
    check('倒计时：过了 4 秒 = 还剩 6 秒', nextRefreshSec(1000, 10, 5000) === 6, String(nextRefreshSec(1000, 10, 5000)));
    check('倒计时：超时后是 0，不是负数（界面上出现 -3s 会让人以为坏了）',
      nextRefreshSec(1000, 10, 999999) === 0, String(nextRefreshSec(1000, 10, 999999)));
    check('倒计时：还没取过数据返回 null', nextRefreshSec(0, 10, 1000) === null);
    check('倒计时：间隔非法时退回 10 秒', nextRefreshSec(1000, 0, 1000) === 10 && nextRefreshSec(1000, undefined, 1000) === 10);
    const mt = texts(RefreshMeter({ remainSec: 7, updatedAt: '09:09:31' })).join('|');
    check('倒计时显示秒数与上次取数时间', mt.includes('7s') && mt.includes('09:09:31'), mt);
    check('倒计时没有数据时显示「—」而不是 NaN',
      texts(RefreshMeter({ remainSec: null, updatedAt: '' })).join('|').includes('—'));
  }

  // 「点不了今买」的回归闸：勾选框传的是布尔值，不能走数字那条路。
  // 之前它埋在 DeskPage 的闭包里测不到，用户点了一遍才发现勾永远打不上。
  {
    const d0 = { positions: { sh600519: { cost: 1320, shares: 100 } }, alerts: {} };
    const on = applyDraftEdit(d0, 'pos', 'sh600519', 'todayBuy', true);
    check('勾上今买：草稿里真的写进了 todayBuy=true',
      on.positions.sh600519.todayBuy === true, JSON.stringify(on.positions));
    check('勾上今买：原有的成本与份额没被弄丢',
      on.positions.sh600519.cost === 1320 && on.positions.sh600519.shares === 100,
      JSON.stringify(on.positions));
    const off = applyDraftEdit(on, 'pos', 'sh600519', 'todayBuy', false);
    check('取消勾选：todayBuy 被删掉而不是存成 false',
      off.positions.sh600519.todayBuy === undefined, JSON.stringify(off.positions));
    // 数字那条路仍然要正常
    const num = applyDraftEdit(d0, 'pos', 'sh600519', 'cost', '1500');
    check('数字输入仍然正常写入', num.positions.sh600519.cost === 1500, JSON.stringify(num.positions));
    const cleared = applyDraftEdit(num, 'pos', 'sh600519', 'cost', '');
    check('清空数字会删掉该字段而不是存 0', cleared.positions.sh600519.cost === undefined, JSON.stringify(cleared.positions));
    const bad = applyDraftEdit(d0, 'pos', 'sh600519', 'shares', 'abc');
    check('非法数字被忽略（保留原值）', bad.positions.sh600519.shares === 100, JSON.stringify(bad.positions));
  }

  // 今天买的仓位：今日盈亏必须用成本价当基准，而不是昨收 ——
  // 否则今天刚买的票会显示一笔按昨收算、其实没发生的亏损
  // （实测：昨收 0.936 / 成本 0.905 / 现价 0.89 / 1000 份 → 按昨收 −46，实际 −15）
  const TODAY = { positions: { sh600519: { cost: 1320, shares: 100, todayBuy: true } }, alerts: {} };
  const tdays = texts(QuoteTable({ list: ROWS, watch: true, onPick: () => {}, config: TODAY, editingCode: null, draft: null })).join('|');
  // (1328.26 − 1320) × 100 = +826.00
  check('今买的仓位：今日盈亏按成本价算（+826.00），不是按昨收（−74.00）',
    tdays.includes('+826.00') && !tdays.includes('-74.00'), tdays.slice(0, 260));
  const tdaysTag = tdays.includes('今买');
  check('今买的仓位在成本价旁标「今买」', tdaysTag, tdays.slice(0, 200));

  const calls = [];
  const ed2 = QuoteTable({ ...base, editingCode: 'sh600519', draft: DRAFT, onChange: (...a) => calls.push(a) });
  // 按类型找成本价那个输入框，不要用 inputs[0]：持有勾选框插在成本之前，
  // 按下标取会拿到勾选框，断言就会变成「改成本价传了 held」这种假失败。
  const costInput = collectEls(ed2, []).find((n) => n.type === 'input' && n.props?.type === 'number');
  costInput.props.onChange({ target: { value: '1500' } });
  check('改成本价只是把新值交给上层改草稿，不直接保存',
    calls[0]?.[0] === 'pos' && calls[0]?.[1] === 'sh600519' && calls[0]?.[2] === 'cost' && calls[0]?.[3] === '1500',
    JSON.stringify(calls[0]));

  const none = texts(QuoteTable({ ...base, config: {}, editingCode: null, draft: null })).join('|');
  check('没填持仓时那几列显示「—」', none.includes('—'), none.slice(0, 200));

  const noWatch = texts(QuoteTable({ list: ROWS, watch: false, onPick: () => {}, config: CFG, editingCode: null, draft: null })).join('|');
  check('非自选表（watch=false）不渲染持仓列', !/成本价/.test(noWatch), noWatch.slice(0, 160));

  // 编辑入口已经完全移到行尾（用户：编辑按钮放到每一行后）。
  // 卡片头上再留一个「编辑」会让两处各有一个入口，且卡片头那个是整表生效的。
  const bar = texts(MonitorBar({
    pollSec: 10, onPoll: () => {}, notify: 'granted', onEnableNotify: () => {},
  })).join('|');
  check('卡片头上不再有「编辑 / 保存 / 取消」',
    !bar.includes('编辑') && !bar.includes('保存') && !bar.includes('取消'), bar);
  check('卡片头仍然保留刷新间隔', bar.includes('刷新间隔') || /秒/.test(bar), bar);

  // ---- 持有标记（用户：自选能不能再加一个持有标记） ----
  {
    const HELD = { positions: { sh600519: { cost: 1200, shares: 100, held: true } }, alerts: {} };
    const heldTree = QuoteTable({ ...base, config: HELD, editingCode: null, draft: null });
    const heldTxt = texts(heldTree).join('|');
    check('持有标记：表头有「持有」列', heldTxt.includes('持有'), heldTxt.slice(0, 200));
    // 用类名找标签而不是找「持」字 —— 表头的「持有」也含「持」，用字面判断会永远为真
    const heldTags = collectEls(heldTree, []).filter((n) => String(n.props?.className ?? '').includes('skd-tag-held'));
    check('持有标记：标记过的行渲染出一个「持」标签', heldTags.length === 1, String(heldTags.length));

    const notHeldTree = QuoteTable({ ...base, config: { positions: { sh600519: { cost: 1200, shares: 100 } }, alerts: {} },
      editingCode: null, draft: null });
    check('持有标记：没标记的行不渲染「持」标签',
      collectEls(notHeldTree, []).filter((n) => String(n.props?.className ?? '').includes('skd-tag-held')).length === 0);

    // 只读态不能有勾选框（避免误触）
    check('持有标记在只读态是纯文本，不是勾选框',
      collectEls(heldTree, []).filter((n) => n.type === 'input').length === 0);

    // held 与 cost / shares 互不依赖：只标持有、不填成本也要能存下来
    const onlyHeld = rowEditDraft({ positions: { sh600519: { held: true } }, alerts: {} }, 'sh600519');
    check('可以只标持有而不填成本', onlyHeld.positions.sh600519.held === true
      && onlyHeld.positions.sh600519.cost === undefined, JSON.stringify(onlyHeld.positions));

    // 勾选框走布尔分支，不能被当成非法数字删掉（今买踩过这个坑）
    const onHeld = applyDraftEdit(rowEditDraft(CFG, 'sh600519'), 'pos', 'sh600519', 'held', true);
    check('勾持有：草稿里写进 held=true', onHeld.positions.sh600519.held === true, JSON.stringify(onHeld.positions));
    check('勾持有：成本与份额没被弄丢',
      onHeld.positions.sh600519.cost === 1200 && onHeld.positions.sh600519.shares === 100,
      JSON.stringify(onHeld.positions));
    const offHeld = applyDraftEdit(onHeld, 'pos', 'sh600519', 'held', false);
    check('取消持有：held 被删掉而不是存成 false',
      offHeld.positions.sh600519.held === undefined, JSON.stringify(offHeld.positions));
  }

  // ---- 逐行编辑：草稿只装一行，保存按行合并 ----
  {
    const CFG2 = { positions: { sh600519: { cost: 1200, shares: 100 }, sz000001: { cost: 10, shares: 500 } },
      alerts: { sh600519: { low: 1200, high: 1400 } } };
    const D = rowEditDraft(CFG2, 'sz000001');
    check('草稿只装当前这一行',
      Object.keys(D.positions).length === 1 && D.positions.sz000001.cost === 10, JSON.stringify(D.positions));
    check('草稿里不会带上别的行', D.positions.sh600519 === undefined, JSON.stringify(D.positions));
    check('草稿里不会带上别的行的提醒', D.alerts.sh600519 === undefined, JSON.stringify(D.alerts));

    const merged = mergeEditDraft(CFG2, 'sz000001',
      { positions: { sz000001: { cost: 11, shares: 500, held: true } }, alerts: {} });
    check('按行合并：改的是这一行',
      merged.positions.sz000001.cost === 11 && merged.positions.sz000001.held === true,
      JSON.stringify(merged.positions));
    check('按行合并：别的行的持仓原样保留', merged.positions.sh600519?.cost === 1200, JSON.stringify(merged.positions));
    check('按行合并：别的行的提醒原样保留', merged.alerts.sh600519?.low === 1200, JSON.stringify(merged.alerts));
    check('按行合并：本来没有提醒的行不会凭空多出空对象',
      merged.alerts.sz000001 === undefined, JSON.stringify(merged.alerts));

    // 整行清空 → 该行从配置里删除，而不是留一个 {}
    const emptied = mergeEditDraft(CFG2, 'sz000001', { positions: {}, alerts: {} });
    check('清空整行后该行被删除，不留空壳',
      emptied.positions.sz000001 === undefined, JSON.stringify(emptied.positions));
    check('清空整行后别的行不受影响',
      emptied.positions.sh600519?.shares === 100, JSON.stringify(emptied.positions));
  }

  // ---- 行尾按钮与只编辑一行 ----
  {
    const rowTxt = texts(QuoteTable({ ...base, editingCode: null, draft: null })).join('|');
    check('只读态每行行尾有「编辑」按钮', rowTxt.includes('编辑'), rowTxt.slice(0, 240));
    check('只读态行尾仍然有「移除」', rowTxt.includes('移除'), rowTxt.slice(0, 240));
    check('只读态行尾没有「保存」', !rowTxt.includes('保存'), rowTxt.slice(0, 240));

    const TWO = [
      { code: 'sh600519', name: '贵州茅台', kind: 'stock',
        fields: { price: 1328.26, prevClose: 1329, changePct: -0.06, turnover: 0.27, amount: 450006 } },
      { code: 'sz000001', name: '平安银行', kind: 'stock',
        fields: { price: 11.2, prevClose: 11.1, changePct: 0.9, turnover: 0.5, amount: 1000 } }];
    const CFG3 = { positions: { sh600519: { cost: 1200, shares: 100 }, sz000001: { cost: 10, shares: 500 } }, alerts: {} };
    const oneEditing = QuoteTable({ list: TWO, watch: true, onPick: () => {}, config: CFG3,
      editingCode: 'sz000001', draft: rowEditDraft(CFG3, 'sz000001'), onChange: () => {},
      onEdit: () => {}, onSave: () => {}, onCancel: () => {} });
    const numIns = collectEls(oneEditing, []).filter((n) => n.type === 'input' && n.props?.type === 'number');
    check('逐行编辑：只有当前行变成输入框（成本/份额/低价/高价 4 个）', numIns.length === 4, String(numIns.length));
    check('逐行编辑：输入框带的是当前这一行的值',
      numIns.map((x) => x.props?.value).join(',') === '10,500,,',
      numIns.map((x) => x.props?.value).join(','));
    const editTxt = texts(oneEditing).join('|');
    check('逐行编辑：当前行显示「保存 / 取消」',
      editTxt.includes('保存') && editTxt.includes('取消'), editTxt.slice(0, 240));
    check('逐行编辑：另一行仍是只读文本，成本照常显示', editTxt.includes('1200'), editTxt.slice(0, 300));
  }

  // ---- 今买勾选状态的回归闸 ----
  // store.js 把 todayBuy 落成日期字符串，勾选框原来写的是 === true，
  // 于是刷新后勾是空的、今日盈亏却按成本算 —— 界面自相矛盾。
  {
    const tKey2 = todayKey().replace(/-/g, '');
    const dateCfg = { positions: { sz159558: { cost: 0.905, shares: 1000,
      todayBuy: todayKey() } }, alerts: {} };
    const dateRows = [{ code: 'sz159558', name: '半导体设备ETF', kind: 'fund',
      fields: { price: 0.89, prevClose: 0.936, changePct: -4.92, turnover: 7.75, amount: 133700,
        time: tKey2 + '101500' } }];
    const dEd = QuoteTable({ list: dateRows, watch: true, onPick: () => {}, config: dateCfg,
      editingCode: 'sz159558', draft: rowEditDraft(dateCfg, 'sz159558'), onChange: () => {} });
    const boxes = collectEls(dEd, []).filter((n) => n.type === 'input' && n.props?.type === 'checkbox');
    check('今买存的是日期字符串时，勾选框仍显示为已勾',
      boxes.some((x) => x.props?.checked === true), JSON.stringify(boxes.map((x) => x.props?.checked)));
  }
}


// 自选表的成交额列：这条正是差 10000 倍的那个位置
const tblText = texts(QuoteTable({ list: [QUOTE_STOCK], watch: false })).join('|');
check('自选表成交额不差数量级', tblText.includes('45.00 亿'), tblText.slice(0, 200));

const stripText = texts(IndexStrip({ catalog: [{ code: 'sh000001', name: '上证指数' }], quotes: [QUOTE_INDEX] })).join('|');
check('指数条渲染点位与涨跌幅',
  stripText.includes('3737.23') && stripText.includes('+0.56%'), stripText.slice(0, 200));

// 指数条能不能点 —— 用户问「指数我能点进去看 k 线吗」。
// IndexStrip 保持纯函数（不带 hook），所以这里可以直接调它验回调与选中态。
{
  const CATALOG = [{ code: 'sh000001', name: '上证指数' }, { code: 'sz399006', name: '创业板指' }];
  const QUOTES = [
    { code: 'sh000001', kind: 'index', fields: { price: 3737.23, change: 20.95, changePct: 0.56 } },
    { code: 'sz399006', kind: 'index', fields: { price: 2411.5, change: -13.2, changePct: -0.54 } },
  ];
  const got = [];
  const node = IndexStrip({ catalog: CATALOG, quotes: QUOTES, onPick: (c) => got.push(c), active: null });
  const btns = collectEls(node).filter((n) => n.type === 'button');
  check('指数条每一项都是可点的按钮（以前是纯文本 div）', btns.length === 2, String(btns.length));
  for (const b of btns) b.props.onClick();
  check('点指数交出去的是指数代码，不是名字', got.join(',') === 'sh000001,sz399006', got.join(','));

  const onNode = IndexStrip({ catalog: CATALOG, quotes: QUOTES, onPick: () => {}, active: 'sh000001' });
  const onBtns = collectEls(onNode).filter((n) => n.type === 'button');
  check('选中那只指数带 data-active=1（点了知道自己在看哪个）',
    onBtns[0]?.props?.['data-active'] === '1' && onBtns[1]?.props?.['data-active'] === '0',
    JSON.stringify(onBtns.map((b) => b.props?.['data-active'])));

  // 再点一次同一只要能收起（传 null）
  const got2 = [];
  const again = IndexStrip({ catalog: CATALOG, quotes: QUOTES, onPick: (c) => got2.push(c), active: 'sh000001' });
  collectEls(again).filter((n) => n.type === 'button')[0].props.onClick();
  check('再点同一只指数传 null（据此收起面板）', got2[0] === null, JSON.stringify(got2));
}

// 方案 §8 第 2 条要求「展示 §5.2 中可得性 ✅ 的全部字段」，其中一组是「位置」
// （区间位置条、距涨停/距跌停空间、相对均价强弱）—— 这些都是算出来的，逐个钉死
const posStk = positionRows(QUOTE_STOCK);
const posIdx = positionRows(QUOTE_INDEX);
check('个股位置组有 5 行', posStk.length === 5, JSON.stringify(posStk));
// 指数的 fields 里本来就没有 avgPrice，所以「较均价」这一行整行不出现（真实响应已证实）
check('指数位置组只有 2 行（没有涨跌停价也没有均价）', posIdx.length === 2, JSON.stringify(posIdx));
check('个股算出了距涨停 +10.06%', posStk.some(([k, v]) => k === 'toLimitUp' && v === '+10.06%'),
  JSON.stringify(posStk));
// 「距跌停」是「离跌停还有多少空间」，必须是正数 —— 复用距涨停的公式会得出 -9.95%
check('个股算出了距跌停 +9.95%（不是负数）', posStk.some(([k, v]) => k === 'toLimitDown' && v === '+9.95%'),
  JSON.stringify(posStk));
check('个股算出了较均价 -0.75%', posStk.some(([k, v]) => k === 'vsAvg' && v === '-0.75%'),
  JSON.stringify(posStk));
check('指数不出现涨跌停相关行',
  !posIdx.some(([k]) => k === 'toLimitUp' || k === 'toLimitDown'), JSON.stringify(posIdx));

// 区间位置：0 = 贴着当日最低，1 = 贴着当日最高
check('个股区间位置约 0.263', Math.abs(rangeRatio(QUOTE_STOCK) - 0.263) < 0.002,
  String(rangeRatio(QUOTE_STOCK)));
check('指数区间位置约 0.872', Math.abs(rangeRatio(QUOTE_INDEX) - 0.872) < 0.002,
  String(rangeRatio(QUOTE_INDEX)));
check('最高等于最低时位置条不画',
  rangeRatio({ fields: { price: 10, high: 10, low: 10 } }) === null);

// 委比是算出来的，不是取上游那个从没被证实过的字段位
check('个股委比 = (3-13)/16 = -62.50%', orderRatio(QUOTE_STOCK) === '-62.50%',
  String(orderRatio(QUOTE_STOCK)));
check('指数没有盘口所以没有委比', orderRatio(QUOTE_INDEX) === null);

// 上面两点必须在真的渲染里体现出来，不然只是「函数算对了、界面没接上」
check('个股明细接上了位置组', stkText.includes('位置') && stkText.includes('距涨停'));
check('个股明细接上了委比', stkText.includes('委比') && stkText.includes('-62.50%'));
check('个股明细接上了市盈率(TTM)', stkText.includes('市盈率(TTM)'));
check('指数明细也接了位置组', idxText.includes('位置') && idxText.includes('距最高'));
check('指数明细不出现委比', !idxText.includes('委比'));

// 槽位目录对 id / key 的 required 标记必须逐条满足。
//
// 桩件不做 schema 校验，所以漏字段在本地永远不会报错；而真实运行时槽位注册会失败，
// 表现是那块 UI 永远不出现、且没有任何提示。shell.overlay 那条一开始就漏了 id。
// 这类「桩件比真实环境宽松」的漏洞没法靠跑测试发现，只能对着目录逐条核。
const slotByName = new Map(slotRegs.map((r) => [r.name, r]));
const filled = (v) => typeof v === 'string' && v.length > 0;
for (const name of ['sidebar.panellist', 'main', 'shell.overlay', 'settings.plugins.tab']) {
  check(`注册了 ${name}`, slotByName.has(name), [...slotByName.keys()].join(', '));
}
check('settings.plugins.tab 带 id（方案 §8 客户端第 ④ 条点名的槽位）',
  filled(slotByName.get('settings.plugins.tab')?.id), String(slotByName.get('settings.plugins.tab')?.id));
check('settings.plugins.tab 的 label 是 thunk，切语言后页签名要跟着变',
  typeof slotByName.get('settings.plugins.tab')?.label === 'function',
  typeof slotByName.get('settings.plugins.tab')?.label);
check('sidebar.panellist 带 id（目录里标成 required）',
  filled(slotByName.get('sidebar.panellist')?.id), String(slotByName.get('sidebar.panellist')?.id));
check('main 带 key（目录里标成 required）',
  filled(slotByName.get('main')?.key), String(slotByName.get('main')?.key));
check('shell.overlay 带 id（目录里标成 required，漏了药丸就不出现）',
  filled(slotByName.get('shell.overlay')?.id), String(slotByName.get('shell.overlay')?.id));
check('侧边栏 id 与 main key 一致，点按钮才打得开自己那一页',
  slotByName.get('sidebar.panellist')?.id === slotByName.get('main')?.key,
  `${slotByName.get('sidebar.panellist')?.id} vs ${slotByName.get('main')?.key}`);

// ---- 主题令牌白名单 ---------------------------------------------------------
// 白名单来自 cordis_inspect_query(client / Theme / listTokens) 的实测输出：
// 共 14 个令牌，全部 requiresLightAndDark —— 用它们就等于自动跟随明暗主题，
// 这正是方案 §6「删掉明暗开关」能成立的前提。
//
// 要命的地方在于：写一个不存在的令牌不会报错。浏览器只是把那条属性丢弃、
// 回落到继承色，控制台一声不吭。实测踩到过 15 处 --dsw-alias-label-tertiary
// （设计系统里根本没有这个令牌），表现是所有次要文字跟主数据一样重、层级被压平。
// 这条断言是给那一类错误设的闸。
const THEME_TOKENS = new Set([
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
]);
const clientSrc = (await import('node:fs')).readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const usedTokens = [...new Set([...clientSrc.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))].sort();
const bogus = usedTokens.filter((t) => !THEME_TOKENS.has(t));
check('确实用到了主题令牌（否则下一条会空过）', usedTokens.length >= 8, `${usedTokens.length} 个`);
check('用到的 --dsw-* 令牌都真实存在，没有写错名字静默失效',
  bogus.length === 0, bogus.join(', ') || `${usedTokens.length} 个全部在白名单内`);

// 对比度回归：这个主题没有 on-brand 前景色令牌（只有 14 个），所以
// 「brand-primary 填底 + #fff 文字」在浅色主题下就是白底白字。
// 用户报的原话是「涨最狠、跌最狠这几个按钮，选谁谁白」。
// 下面三条把整类写法堵死：不许硬编码 #fff，主按钮必须靠反色而不是靠品牌色。
// 浏览器 fetch 默认没有超时：连接被挂住时界面会永远停在「正在取数…」。
// 后端对同一个请求实测 1~3ms 就返回，所以挂住一定是连接层面的问题 ——
// 至少要把它变成一条能读的报错，并且给得出重试。
check('api() 带 AbortController 超时（否则挂住就永远转圈）',
  /const ctl = new AbortController\(\);/.test(clientSrc) && /REQUEST_TIMEOUT_MS/.test(clientSrc));
check('超时错误用词条而不是硬编码文案', /T\("timeout"\)/.test(clientSrc));
check('取数失败时给了重试按钮', /T\("retry"\)/.test(clientSrc));
check('重试会真的重跑 effect（tries 进依赖数组）',
  /\[drill\.code, drill\.kind, page, tries\]/.test(clientSrc) && /\[poolKind, tries\]/.test(clientSrc));

const cssOnly = clientSrc.split('/*').map((s) => s.split('*/').slice(1).join('')).join('');
check('样式里不硬编码 #fff / #ffffff（缺 on-brand 令牌，硬编码必在某一主题下白底白字）',
  !/#fff(?:fff)?\b/i.test(cssOnly),
  (cssOnly.match(/[^\n]*#fff[^\n]*/g) ?? []).join(' | ').slice(0, 100) || '无');
const tabOnRule = clientSrc.match(/\.skd-btab\[data-on="1"\]\{([^}]*)\}/)?.[1] ?? '';
check('选中的维度 tab 存在，且文字色取 label-primary（任何主题下都读得清）',
  tabOnRule.length > 0 && tabOnRule.includes('--dsw-alias-label-primary'), tabOnRule.slice(0, 90));
check('选中的维度 tab 不拿 brand-primary 填底（它只该用于描边）',
  !/background:[^;]*brand-primary/.test(tabOnRule), tabOnRule.slice(0, 90));
const primaryBtn = clientSrc.match(/\.skd-btn\[data-primary="1"\]\{([^}]*)\}/)?.[1] ?? '';
check('主按钮靠 label-primary/bg-base 反色取对比度，不靠品牌色填底',
  primaryBtn.includes('--dsw-alias-label-primary') && primaryBtn.includes('--dsw-alias-bg-base'),
  primaryBtn.slice(0, 110));

// 用户反馈的两条布局问题，各留一条回归闸。这类问题在 Node 里测不了「画出来什么样」，
// 但至少能锁住「那个修复有没有被谁删掉」——删掉时这两条会红。
// 涨跌家数单独占一行、涨停卡拿整行宽度（用户要求「这样子涨停就宽一点了」）。
// 一旦有人把它们又塞回并排网格，这条会红。
check('涨跌家数与涨停卡不再并排挤在网格里（涨停要整行宽度）',
  !/className: "skd-grid2"/.test(clientSrc) && !/\.skd-grid2\{/.test(clientSrc),
  '');

check('整页容器自己可滚：外层 main 不给滚动条，超出视口的内容全靠它才够得着',
  /\.skd-page\{[^}]*overflow-y:auto/.test(clientSrc), '');
check('详情面板与卡片边框之间留了横向间距（.skd-card-b 横向 padding 是 0）',
  /\.skd-d\{[^}]*margin:10px 10px/.test(clientSrc), '');

// ---- 结论 -----------------------------------------------------------------
console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;