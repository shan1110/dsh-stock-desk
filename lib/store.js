/**
 * 配置持久化（宿主侧）
 *
 * 为什么放宿主侧而不放浏览器 localStorage（现状做法）：
 * agent 工具要能读到用户的自选股。工具跑在宿主进程里，读不到浏览器的 localStorage，
 * 所以现状下「让 agent 分析我的自选」这件事根本做不到。
 *
 * 为什么不用宿主的 storageDomain 服务：它要求 defineDomain 与 zod 表定义，
 * 而 defineDomain 出自哪个包未能验证（@deepseek-ai/* 由 DSH 内部解析，
 * profile 的 node_modules 里没有这些包，无法从磁盘确认）。按「不猜」原则改用 node:fs 写 JSON，
 * 并把解析出的路径回传到 API 与工具输出里，使这个选择可审计而非隐式。
 *
 * @author cai shan
 * @date 2026-10-19 14:52
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 配置版本；结构不兼容变更时递增，并在 normalizeConfig 里做迁移 */
export const SCHEMA_VERSION = 1;

/** 数据目录名，落在 DSH profile 目录之下 */
const DIR_NAME = 'stock-desk';

/** 配置文件名 */
const FILE_NAME = 'config.json';

/**
 * 自选分组的固定 id。
 *
 * 单独导出而不是各处写字面量：界面的自选表、药丸的涨跌家数、agent 的 stock_watchlist
 * 都靠它定位同一组；任何一处写歪都会表现为「页面上有、工具里没有」这种最难查的错。
 */
export const WATCH_GROUP_ID = 'watch';

/**
 * 解析数据目录。
 *
 * 依次尝试三条规则，返回命中的那条，让「配置到底存哪了」永远可回答：
 * 1. `DSH_PROFILE_DIR`
 * 2. `~/.dsh/profiles/<DSH_PROFILE>/`
 * 3. `~/.dsh/`
 *
 * 实测（2026-10-19，desktop profile）：宿主插件进程里第 1、2 条都读不到 ——
 * `DSH_PROFILE_DIR` 与 `DSH_PROFILE` 只注入给 DSH 派生的子进程（pwsh 里能打印出来），
 * 不在宿主自己的 process.env 里。而 Host 现有服务中没有任何一个提供 profile 目录
 * （`profileContext` 只暴露 packageManager / startedBundles / overlays / telemetryDisabledEnv）。
 * 插件又是以软链接挂进 profile 的，真实路径在 E:\dsh-plugin，向上也走不到 profile。
 * 所以实际落到第 3 条：`~/.dsh/stock-desk/config.json`。
 * 它属于 DSH 家目录而非 profile 目录 —— 代价是与 profile 不同层，好处是换 profile 不丢自选。
 * info() 会原样带上 rule，界面上随时能看到命中的是哪条。
 *
 * @returns {{dir: string, rule: string}}
 */
export function resolveDataDir() {
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (profileDir && profileDir.trim()) {
    return { dir: join(profileDir, DIR_NAME), rule: 'env:DSH_PROFILE_DIR' };
  }
  const profile = process.env.DSH_PROFILE;
  if (profile && profile.trim()) {
    return { dir: join(homedir(), '.dsh', 'profiles', profile, DIR_NAME), rule: 'env:DSH_PROFILE' };
  }
  return { dir: join(homedir(), '.dsh', DIR_NAME), rule: 'fallback:dsh-home' };
}

/**
 * 出厂配置。
 *
 * 大盘指数放在独立分组而不是混在自选里：现状把指数当普通自选行处理，
 * 指数没有换手率/市盈率/涨跌停价，混排后同一条模板会渲染出「涨停价 -1」这类明显假值。
 */
export function defaultConfig() {
  return {
    version: SCHEMA_VERSION,
    groups: [
      { id: 'index', name: '大盘指数', items: ['sh000001', 'sz399001', 'sz399006'] },
      { id: WATCH_GROUP_ID, name: '自选', items: ['sh600519', 'sz300750'] },
    ],
    ui: {
      /** auto: 跟随 DSH 主题令牌；red-up / green-up: 强制涨跌配色 */
      colorScheme: 'auto',
      density: 'comfortable',
      /** 客户端轮询间隔（秒）。10 秒是用户要求的默认值 */
      pollSec: 10,
    },
    /**
     * 持仓：{ 代码: { cost: 成本价, shares: 份额, held: 是否持有, todayBuy: 今日买入日期 } }。
     *
     * 为什么单独一张表而不是塞进 groups[].items：items 是 string[]，
     * 迁移、合并、agent 工具都按它当纯代码列表用。改成对象会一次性打断三处，
     * 而且旧配置全要迁移。单独一张 map 既能带附加信息，又完全向后兼容。
     *
     * held 是纯标记，与 cost / shares 互不依赖：可以只标「持有」不填成本
     * （记个仓位方向），也可以只填成本不标持有（模拟盘、观察仓）。
     * 盈亏计算只认 cost 与 shares，不读 held。
     */
    positions: {},
    /**
     * 价格监控：{ 代码: { low: 低价, high: 高价 } }。到价由客户端弹系统通知。
     * 只存阈值，不存「是否已通知过」—— 那是运行时状态，落盘会在重启后误判。
     */
    alerts: {},
    pill: {
      enabled: true,
      /** 药丸上显示的指数 */
      indexCode: 'sh000001',
    },
  };
}

/**
 * 把任意形状的输入规整成合法配置。
 *
 * 迁移动机：旧插件 dsh-stock-watch 把配置存在浏览器 localStorage 的 `stocking.config.v1`，
 * 里面是 6 位纯代码、没有市场前缀、且指数与自选混排。这里统一补前缀并分层。
 *
 * 原则：能救的字段都救，救不了的**列出来告诉用户**，不静默丢。
 *
 * @param {unknown} raw
 * @returns {{config: object, notes: string[]}}
 */
/**
 * 从分组名推一个 id。旧插件的分组只有 name、没有 id。
 *
 * 为什么不推就丢掉：id 只用于内部寻址与去重，界面上显示的是 name，
 * 所以推出来的 id 对用户没有任何观感影响；而丢掉整个分组会一路走到
 * 「恢复出厂分组」，用户的整个自选就没了 —— 代价完全不对等。
 *
 * @param {unknown} name 分组名，可能是 undefined
 * @param {Set<string>} seen 已占用的 id
 * @returns {string} 未被占用的 id
 */
function deriveGroupId(name, seen) {
  const base = String(name ?? '').trim().slice(0, 20) || 'g';
  let id = base;
  let n = 2;
  while (seen.has(id)) id = `${base}${n++}`;
  return id;
}

export function normalizeConfig(raw) {
  const notes = [];
  const base = defaultConfig();
  if (!raw || typeof raw !== 'object') {
    return { config: base, notes: ['没有已保存的配置，使用出厂配置'] };
  }

  const src = /** @type {any} */ (raw);

  if (Number(src.version) > SCHEMA_VERSION) {
    notes.push(`已保存的配置版本 ${src.version} 高于本插件支持的 ${SCHEMA_VERSION}，未知字段被忽略`);
  }

  const groups = [];
  const seenGroupIds = new Set();
  const rawGroups = Array.isArray(src.groups) ? src.groups : [];

  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue;
    // 旧插件的分组只有 name、没有 id（实测旧 client.js:161），
    // 所以这里不能判「没有 id 就是坏数据」——那会把用户每一个分组都丢掉。
    const id = String(g.id ?? '').trim() || deriveGroupId(g.name, seenGroupIds);
    if (seenGroupIds.has(id)) { notes.push(`丢弃了重复的分组 id：${id}`); continue; }
    seenGroupIds.add(id);
    // 旧插件的键是 symbols 而不是 items，且元素是对象而非字符串（实测旧 client.js:161）：
    //   { name: "分组1", symbols: [{ code: "sh000001" }, { code: "sz399300" }] }
    // 只认 items 会把用户的整个自选静默迁成空分组。
    const rawList = Array.isArray(g.items) ? g.items : (Array.isArray(g.symbols) ? g.symbols : []);
    const { codes, dropped } = normalizeCodes(rawList);
    if (dropped.length) notes.push(`分组「${g.name ?? id}」丢弃了 ${dropped.length} 个无法识别的代码：${dropped.slice(0, 5).join('、')}${dropped.length > 5 ? ' 等' : ''}`);
    // 旧格式的买卖目标价在本插件的 P0 里不做（方案 §8 把它列在 P2）。
    // 但必须说一声：静默丢掉目标价，用户会以为迁移失败或者自己记错了
    const withTarget = rawList.filter((x) => x && typeof x === 'object'
      && (x.buyPrice !== undefined || x.sellPrice !== undefined)).length;
    if (withTarget) notes.push(`分组「${g.name ?? id}」有 ${withTarget} 个代码带买卖目标价：代码已保留，目标价本插件暂不支持`);
    groups.push({ id, name: String(g.name ?? id).slice(0, 20), items: codes });
  }

  // 重名分组：实测迁移后出现过两个都叫「自选」的分组，一个空、一个装着 4 只股票。
  //
  // 根因在 lib/routes.js 的 mergeGroups —— 它只按 id 配对，而旧插件的分组没有 id，
  // 规整时是按名字现推一个（推出「自选」），对不上我这边同义组的 id（watch），
  // 于是被当成新组推入。根因那边已修；这里负责把已经落盘的那个收拾掉，下次保存即自愈。
  //
  // 只动「重名且为空」的：有内容的一律不碰。而且必须留一条 note ——
  // 用户看不见的删除等同于数据丢失。
  const nameGroups = new Map();
  for (const g of groups) {
    if (!nameGroups.has(g.name)) nameGroups.set(g.name, []);
    nameGroups.get(g.name).push(g);
  }
  const doomed = new Set();
  for (const list of nameGroups.values()) {
    if (list.length < 2) continue;
    const withItems = list.filter((g) => g.items.length > 0);
    // 有内容的优先留；若全都空，就留第一个
    for (const g of (withItems.length > 0 ? list.filter((g) => g.items.length === 0) : list.slice(1))) {
      doomed.add(g);
      notes.push(`丢掉了和「${g.name}」重名的那一个（它${g.items.length === 0 ? '是空的' : '有 ' + g.items.length + ' 个代码'}）`);
    }
  }
  if (doomed.size > 0) {
    const kept = groups.filter((g) => !doomed.has(g));
    groups.length = 0;
    groups.push(...kept);
  }

  // 旧格式兼容：直接给了 items 或 symbols 而没有 groups
  if (groups.length === 0) {
    const legacy = Array.isArray(src.items) ? src.items : (Array.isArray(src.symbols) ? src.symbols : null);
    if (legacy) {
      const { codes, dropped } = normalizeCodes(legacy);
      // 与分组分支保持同样的详细程度：列出具体是什么被丢了，
      // 只报「丢了 1 个」用户没法判断要不要管
      if (dropped.length) notes.push(`从旧格式迁移时丢弃了 ${dropped.length} 个无法识别的代码：${dropped.slice(0, 5).join('、')}${dropped.length > 5 ? ' 等' : ''}`);
      groups.push(...base.groups.filter((g) => g.id === 'index'));
      // 旧格式是扁平一列，分不出指数与个股，所以整体进自选；
      // 指数分组另给出厂值，用户可在界面上自行挪
      groups.push({ id: WATCH_GROUP_ID, name: '自选', items: codes });
      notes.push(`已从旧格式迁移 ${codes.length} 个自选代码`);
    }
  }

  // 自选面板与药丸都按 id 去找自选分组。从旧格式迁过来的分组 id 是推出来的，未必叫 watch，
  // 与其让两处各自 fallback 到 groups[0]，不如在这里就把这件事定下来 —— 行为只在一个地方决定。
  if (!groups.some((g) => g.id === WATCH_GROUP_ID)) {
    const target = groups.find((g) => g.id !== 'index');
    if (target) {
      notes.push(`分组「${target.name}」已作为自选分组`);
      target.id = WATCH_GROUP_ID;
    }
  }

  if (groups.length === 0) {
    notes.push('配置里没有任何可用分组，已恢复出厂分组');
    groups.push(...base.groups);
  }

  const ui = { ...base.ui, ...(src.ui && typeof src.ui === 'object' ? pickUi(src.ui) : {}) };
  const pill = {
    enabled: typeof src.pill?.enabled === 'boolean' ? src.pill.enabled : base.pill.enabled,
    indexCode: normalizeOne(src.pill?.indexCode) ?? base.pill.indexCode,
  };

  const positions = pickPositions(src.positions);
  const alerts = pickAlerts(src.alerts, notes);

  return { config: { version: SCHEMA_VERSION, groups, ui, pill, positions, alerts }, notes };
}

const round4 = (v) => Math.round(v * 10000) / 10000;

/**
 * 持仓规整。
 *
 * 只认正的有限数：成本价填 0 或负数没有意义，份额为 0 等于没持仓。
 * 认不出的直接丢，不编默认值 —— 编了之后界面上会出现「成本 0 元、盈利 100%」这种假数字。
 */
/** 北京时区的今天，YYYY-MM-DD。与 client 的 todayKey 保持同一口径 */
function todayKey() {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function pickPositions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const code = normalizeOne(k);
    if (!code || !v || typeof v !== 'object') continue;
    const item = {};
    const cost = Number(v.cost);
    const shares = Number(v.shares);
    if (Number.isFinite(cost) && cost > 0) item.cost = round4(cost);
    if (Number.isFinite(shares) && shares > 0) item.shares = round4(shares);
    /**
     * 今天买入的标记。
     *
     * 为什么需要：今日盈亏的自然定义是 (现价 − 昨收) × 份额，
     * 但那只在「昨天收盘就持有这些份额」时成立。今天才买的仓位，
     * 基准应该是自己的成本价 —— 否则一只跌了 5% 的票会让你看到
     * 一笔根本没发生过的亏损（实测：昨收 0.936 / 成本 0.905 / 现价 0.89，
     * 按昨收算是 −46，实际只亏 −15）。
     * 我们没有昨仓/今仓的拆分，只能让用户显式标一下。
     */
    // 今天买入的标记要带日期，不能只是个 true。
    // 只存 true 的话，昨天勾的今天还生效，「今日盈亏」就永远退化成「持仓盈亏」，
    // 新的一天也不会归零。旧数据（true）在这里一次性迁移成当天日期。
    if (v.todayBuy === true) item.todayBuy = todayKey();
    else if (typeof v.todayBuy === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.todayBuy)) item.todayBuy = v.todayBuy;
    /**
     * 持有标记。
     *
     * 只接受 true，不存 false：未标记本身就等于「不持有」，存 false 会让这张 map
     * 里堆满空壳，而且下面那句 Object.keys(item).length 会因此认为这一行有内容，
     * 取消持有之后该行会留着一个 `{}` 永远删不掉。
     */
    if (v.held === true) item.held = true;
    if (Object.keys(item).length > 0) out[code] = item;
  }
  return out;
}

/**
 * 价格监控规整。
 *
 * 低价 >= 高价 是明显填反了。这里**保留用户填的值**（不静默改），
 * 由调用方补一条 note 提醒 —— 悄悄「修正」用户输入比报错更糟。
 */
function pickAlerts(raw, notes) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const code = normalizeOne(k);
    if (!code || !v || typeof v !== 'object') continue;
    const item = {};
    const low = Number(v.low);
    const high = Number(v.high);
    if (Number.isFinite(low) && low > 0) item.low = round4(low);
    if (Number.isFinite(high) && high > 0) item.high = round4(high);
    if (item.low === undefined && item.high === undefined) continue;
    if (item.low !== undefined && item.high !== undefined && item.low >= item.high) {
      notes.push(`监控「${code}」的低价 ${item.low} 不小于高价 ${item.high}，这两条不会按预期触发`);
    }
    out[code] = item;
  }
  return out;
}

function pickUi(ui) {
  const out = {};
  if (['auto', 'red-up', 'green-up'].includes(ui.colorScheme)) out.colorScheme = ui.colorScheme;
  if (['comfortable', 'compact'].includes(ui.density)) out.density = ui.density;
  // 只认白名单里的秒数：任意数字会让客户端每秒打一次接口
  const sec = Number(ui.pollSec);
  if ([3, 5, 10, 15, 30, 60].includes(sec)) out.pollSec = sec;
  return out;
}

/**
 * 代码规整：补市场前缀，去重，保持原顺序。
 *
 * 补前缀的号段规则与 lib/tencent.js 的 normalizeCodes 保持一致；
 * 这里额外返回被丢弃的原始值，好让上层能如实告诉用户丢了什么。
 */
/**
 * 报「丢了什么」时给一个可读的值。
 *
 * 直接 String 对象会得到一串 [object Object]，用户看了等于没看 ——
 * 而这个提示的全部意义就是让他知道是哪几个代码没迁过来。
 *
 * @param {unknown} raw 被丢弃的原始元素
 * @returns {string} 可读描述
 */
function describeDropped(raw) {
  if (raw && typeof raw === 'object') {
    if (raw.code !== undefined) return String(raw.code);
    try {
      return JSON.stringify(raw).slice(0, 40);
    } catch {
      return '[无法序列化的对象]';
    }
  }
  return String(raw);
}

function normalizeCodes(list) {
  const codes = [];
  const dropped = [];
  const seen = new Set();
  for (const raw of list) {
    // 旧插件的元素是对象而不是字符串（{code, buyPrice, sellPrice}，见旧 client.js:161）。
    // 不 unwrap 的话，用户整份自选都会以「[object Object] 无法识别」被丢掉，且不报错。
    const text = raw && typeof raw === 'object' ? raw.code : raw;
    const code = normalizeOne(text);
    if (!code) { dropped.push(describeDropped(raw)); continue; }
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return { codes, dropped };
}

/** 单个代码规整；认不出来返回 null（不猜） */
function normalizeOne(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  let m = /^(sh|sz|bj)(\d{6})$/.exec(s);
  if (m) return s;
  m = /^(\d{6})\.(sh|sz|bj)$/.exec(s);
  if (m) return m[2] + m[1];
  m = /^(\d{6})$/.exec(s);
  if (m) {
    const c = m[1];
    if (/^(60|68|90|11|13|5[0-8])/.test(c)) return 'sh' + c;
    if (/^(00|30|12|15|16|18|39|2[0-9])/.test(c)) return 'sz' + c;
    if (/^(4|8|92)/.test(c)) return 'bj' + c;
  }
  return null;
}

/**
 * 配置仓库：读一次进内存，写时原子替换。
 *
 * 为什么原子写：进程被强杀时若正在写，直接覆盖会留下半截 JSON，
 * 下次启动整份配置就废了。先写临时文件再 rename，rename 在同一分区上是原子的。
 */
export function createStore() {
  const { dir, rule } = resolveDataDir();
  const file = join(dir, FILE_NAME);
  /** @type {object|null} */
  let cached = null;
  /** @type {string[]} */
  let lastNotes = [];
  let lastSavedAt = null;
  let lastError = null;

  /** 读盘；任何异常都退回出厂配置，并把原因记下来 */
  async function load() {
    if (cached) return cached;
    try {
      const text = await readFile(file, 'utf8');
      const { config, notes } = normalizeConfig(JSON.parse(text));
      cached = config;
      lastNotes = notes;
    } catch (err) {
      if (err.code === 'ENOENT') {
        cached = defaultConfig();
        lastNotes = ['首次运行，尚未写入配置文件'];
      } else {
        cached = defaultConfig();
        lastNotes = [`读取配置失败（${err.message}），已回退出厂配置`];
        lastError = err.message;
      }
    }
    return cached;
  }

  /**
   * 覆盖保存。返回值里带 path，使「配置存哪了」随每次写入都可见。
   * @param {object} next
   */
  async function save(next) {
    const { config, notes } = normalizeConfig(next);
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
    await rename(tmp, file);
    cached = config;
    lastNotes = notes;
    lastSavedAt = Date.now();
    return { config, notes, path: file };
  }

  /**
   * 局部更新。
   * @param {(current: object) => object} mutate
   */
  async function update(mutate) {
    const current = await load();
    return save(mutate(structuredClone(current)));
  }

  return {
    load,
    save,
    update,
    /** 让下次 load 重新读盘 */
    invalidate() { cached = null; },
    info() {
      return { path: file, dir, rule, savedAt: lastSavedAt, notes: lastNotes, error: lastError };
    },
  };
}
