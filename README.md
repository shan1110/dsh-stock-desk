# dsh-stock-desk · A股行情台

DSH 插件。在 Harness Web UI 侧边栏加一个行情台整页，同时给 agent 挂 6 个只在需要时才占上下文的行情工具。

## 安装（使用者）

```powershell
# 在 DSH 里
plugin_manager(action: install_bundle, target: "dsh-stock-desk@0.1.0")

# 或走 CLI
dsh plugin --profile <你的 profile> add dsh-stock-desk@0.1.0
```

要求 Node >= 24。装完刷新浏览器页面即可，侧边栏会出现行情台图标。

## 它连哪些外部服务

插件运行时由**你自己的机器**直接请求下面这些公开行情接口，不经过任何中转服务器，也没有遥测：

| 域名 | 用途 |
|---|---|
| `qt.gtimg.cn` | 腾讯行情：实时报价、五档盘口、日/周/月 K 线、分时 |
| `data.10jqka.com.cn` / `basic.10jqka.com.cn` | 同花顺：涨停池、连板梯队、炸板池、行业板块榜与成分股 |
| `push2his.eastmoney.com` 等 | 东方财富：**仅**作为分钟线 K 线的兜底源 |

这些接口都是各站点网页在用的公开接口，不需要账号或 token。**它们不是官方 API，
随时可能改结构、限流或失效**；插件对这些失败的处理是降级并显式标注数据来源，
不会用陈旧数据冒充实时数据。

自选、持仓、提醒价格存在 `~/.dsh/stock-desk/config.json`，纯本地文件，不上传。

## 已知边界

- 只覆盖 A 股（沪深主板 / 创业板 / 科创板 / 北交所不在内），港股与美股不支持。
- 没有财务数据、新闻、公告、基本面。
- 数据源限流是真实的，连续高频请求会被临时拒绝，插件有递增冷却。
- 收盘后不刷新行情，界面会显示「已收盘」和快照时间。

## 开发：本地安装

以下步骤针对改这个仓库本身的场景，使用者不需要看。

```powershell
# 1) 解析路径：工作区目录是软链接安装，@deepseek-ai/* 必须能解析到，否则装上了也不会激活
node tools/check-resolution.mjs

# 2) 安装（path 指到本目录）
dsh plugin --profile desktop install E:\dsh-plugin
```

第 1 步不能跳。装载器对解析失败的报错藏在 warning 里，表现为「安装成功但 fiber 不 active」。
原理见 `docs/安装与激活实测.md` 第 2 节。

改完代码要重启插件（HMR 不热更已激活插件的文件改动）：

```
plugin_manager(set_plugin, target: "include:stock-desk", enabled: false)
plugin_manager(set_plugin, target: "include:stock-desk", enabled: true)
```

改完客户端代码还要**刷新浏览器页面** —— 客户端模块只在页面加载时取一次。

## 自检

```powershell
foreach ($t in @("test-tencent","test-sources","test-market","test-tools","test-client","test-contract")) {
  node "tools\$t.mjs"
}
```

前 5 个套件在当前时点实测 291 条断言（`test-sources` 在东财可用时多 3 条）；
`test-contract` 再 76 条，它要打活的 HTTP 接口，得先确保插件已装入并激活。
全部应退出码 0。**注意：盘口类断言写成多态** —— 实测收盘与尾盘竞价期间的盘口有四种形态
（满档 / `null` / 两侧空数组 / 只有买一侧），写死「一定有买一」会在每天 15:00 后准时变红，
更糟的是 `bids[0].price` 会抛 TypeError 把整个套件带崩，连跑了几条都不告诉你。
**修断言时不要只按这一次看到的形态改** —— 这个坑犯了五次。
改动数据源解析、工具输出、单位换算、或客户端槽位注册后跑一遍。

`test-client.mjs` 里那两组是**真渲染**，不是构造断言：它把 `desk` 喂上一份真实形状的
`/dashboard`，然后调 `DeskPage()` / `Pill()` / `DeskButton()` 看渲染出来的文字里
到底有没有指数点位、涨跌幅、涨跌家数。方案 §8 第 1 条与第 4 条因此不必靠肉眼。

两条纪律写在这个文件里，改它的时候别破：

1. **`catch` 一律不许静默。** 一个静默的 `catch` 会把「某个组件崩了」变成
   「这一段没渲染」，两者症状一样、成因完全不同。
2. **`check` 通过时也要打印。** 否则「一片空白」是没渲染还是没打印，一眼分不出来。
   本轮为此白走了三轮。

第 6 个套件 `test-contract.mjs` **要 GUI 在跑**，它直接打 HTTP 路由：

```powershell
node "tools\test-contract.mjs"      # 需 http://127.0.0.1:8820 在跑，只读不发 POST
```

76 条断言，逐个核对 `client.js` 读到的每一条字段路径。它存在的理由很具体：第 1 轮
有 6 处客户端与宿主对不上的问题（`{ok,data}` 信封没拆、`store.path` 不存在、
自选实际取自 `config.groups[].items`），当时没有任何测试真正调过这些路由 ——
全靠手写 PowerShell 探针，而探针本身我也写错过好几次
（用 `$_.price` 去读嵌套在 `.fields` 里的价格，探针返回空，看起来像插件坏了）。

断言值一律来自真实响应 dump，不来自记忆。这正是迁移那个 bug 的成因：
拿自己以为的形状当固定装置，测试全绿而缺陷照旧。

`test-client.mjs` 里包含方案 §8 那条验收标准的机器判定版本：**指数明细不得出现
换手率 / 市盈率 / 市净率 / 涨跌停价 / 委差 / 盘口**。它靠的是「按字段是否存在渲染」这一设计，
而不是靠肉眼在浏览器里点两遍。

同一个文件还守着三类**桩件验不出来**的约定，它们的共同点是「框架保证、桩件不校验」：

1. 槽位注册的必填字段（`shell.overlay` 的 `id` 漏过一次，药丸永远不出现且不报错）。
2. `sidebar.panellist.id` 必须等于 `main.key`（不等则点按钮没反应，同样不报错）。
3. `shell.overlay` 整层是 click-through，药丸必须自己 `pointer-events:auto`（漏过一次，药丸点不动）。
4. 颜色一律走 `--dsw-*` 令牌，写死十六进制切主题不跟随（白名单只留主按钮的 `#fff`）。

装完先问一次客户端半边有没有接进启动图，再去刷新页面：

```powershell
(Invoke-RestMethod http://127.0.0.1:8820/api/stock-desk/diag).data
```

`wired: true` 表示刷新一定有用；`wired: false` 表示刷新多少次都没用，问题在 `package.json`
的 `dsh.client` 声明。这两种情况排查方向完全不同。

## 结构

```
index.js             宿主入口：inject webServer + tools，建 cache/store/market 三个单例
cordis.patch.yml     把插件插进 profile 的 Cordis 组合
client.js            浏览器半边：整页 + 侧边栏按钮 + 药丸，无构建步骤，故用 React.createElement
locale/{zh,en}.json  插件管理页里的展示元数据（与 client.js 内的界面词条是两回事）

lib/tencent.js       腾讯行情：88 字段解析、五档、涨跌停判定
lib/ths.js           同花顺涨停池：连板梯队、板块涨停分布
lib/eastmoney.js     东方财富：板块涨跌与主力净流入、日K
lib/market.js        三个源的编排、TTL 缓存、降级
lib/routes.js        HTTP 接口，全部返回 { ok, data }
lib/store.js         自选与界面配置的读写
lib/tools.js         6 个 agent 工具（defineTool）
lib/universe.js      全市场代码池（data/universe.json，5575 只）
lib/cache.js         请求缓存、数据源健康度、递增冷却
lib/session.js       交易时段判定（竞价/交易中/午休/已收盘）
lib/format.js        数字格式化与数据来源标注

data/universe.json   全市场代码池，构建脚本 tools/build-universe.mjs
docs/                实测记录
tools/               探针、构建脚本、自检套件
```

## 界面

侧边栏一个图标 → 整页。页面上：指数条、涨跌家数、涨停梯队、板块涨停分布、自选表、数据源健康度。
对话页右下角一个药丸，常态显示上证点位与自选涨跌家数。

## agent 工具

`stock_quote` `market_overview` `limit_up_board` `sector_rank` `stock_kline` `stock_watchlist`

工具定义全部注册，但模型只在真正需要时才读它们的 schema —— 6 个定义合计约 1287 字符。
`stock_watchlist` 读的就是界面上那份自选，两边不会不一致。

## 已知边界

- **港股不在范围内。** 腾讯港股只有 78 个字段且与 A 股错位（第 46 位是名称不是市值）。
  `normalizeCodes` 会丢掉 `hk` 前缀的代码。
- **北交所请求会被拒。** 代码池不含 `bj` 前缀。
- **收盘后不刷新行情。** 工具会明确报「已收盘」并给出快照时间，不用陈旧数据顶替。
- **数据源限流是真实的。** 东财被我们自己高频探测打到过连续 `UND_ERR_SOCKET`；
  现在有 30 秒起步、上限 600 秒的递增冷却，见 `docs/数据源实测.md`。

## 配置

落在 `~/.dsh/stock-desk/config.json`。

宿主进程里读不到 `DSH_PROFILE_DIR` / `DSH_PROFILE`（这两个变量只注入给子进程），
Host 也没有任何服务提供 profile 目录，所以走的是 DSH 家目录这条兜底路径。
好处是换 profile 不丢自选。当前命中的规则会由 `store.info().rule` 带出来，界面上能看到。
