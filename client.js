/**
 * dsh-stock-desk —— A 股行情工作台（浏览器侧）
 *
 * 三个槽位各自承担一件事：
 * 1. sidebar.panellist 的 id 与 main 的 key 成对，侧边栏按钮点开就是那一整页 —— 这是本插件
 *    替代旧插件的关键：旧插件只挂 shell.overlay 一个浮动面板，宽度被 400px 卡死。
 * 2. main 出整页看盘。
 * 3. shell.overlay 出常驻药丸，不切页面也能看到上证点位。
 *
 * 数据一律走宿主 /api/stock-desk（lib/routes.js）。浏览器不直接打腾讯/东财/同花顺，
 * 这样界面与 agent 工具共用同一份缓存与健康度，也避免把上游的限流打到用户 IP 上。
 *
 * @author cai shan
 * @date 2026-10-19 16:48
 */
window.__ModuleLoader__.load({
  id: "dsh-stock-desk",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const NS = "stock-desk";
    const API = "/api/stock-desk";
    /** 旧插件把自选股存在这个 localStorage 键下，迁移时读它 */
    const LEGACY_KEY = "stocking.config.v1";

    //#region 语言包
    const zh = {
      title: "行情台",
      loading: "正在取数…",
      unavailable: "拿不到",
      unavailableHint: "该数据源暂时不可用，不会显示陈旧数据顶替。",
      watchlist: "自选",
      indices: "大盘指数",
      breadth: "涨跌家数",
      limitUp: "涨停",
      limitDown: "跌停",
      burst: "炸板",
      firstBoard: "首板",
      sectors: "板块",
      // 板块格子的三个维度。名字按「用户脑子里怎么问」写，不按数据源字段名写
      boardUp: "涨最狠",
      boardDown: "跌最狠",
      constituents: "成分股",
      drillHint: "点格子看该板块成分股",
      prevPage: "上一页",
      nextPage: "下一页",
      leader: "领涨",
      upDown: "涨/跌",
      boardNoDrill: "该板块没有可下钻的成分股数据",
      pages: "页",
      freeLimit: "同花顺免费只开放前 5 页，更多需登录",
      // 跌停池没有现成接口，走本地全市场扫描，口径与同花顺不同，必须标出来
      localScan: "本地扫描",
      estimated: "推算",
      // 每个术语后面那个小问号的说明。用大白话，不写行话
      hintLimitUp: "当日收盘价达到涨停价、并且封住的个股家数。",
      hintBroke: "炸板：盘中曾经触及涨停价、但到收盘又没封住的个股。这个数越大，说明当天的涨停越不牢靠，追高容易吃面。",
      hintLimitDown: "当日收盘价跌到跌停价的个股家数。",
      hintFirstBoard: "首板：今天涨停、但之前没有连续涨停的个股。首板 = 涨停家数 − 连板家数。",
      hintLadder: "连板梯队：连续多个交易日都涨停的个股，按连续天数分组。3 板 = 已经连续 3 个交易日涨停。",
      hintBoardUp: "今天涨幅最大的 10 个行业板块，按板块整体涨跌幅排序。",
      hintBoardDown: "今天跌幅最大的 10 个行业板块，按板块整体涨跌幅排序。",
      peekHint: "点开看明细与 K 线",
      timeout: "请求超时",
      retry: "重试",
      quoteMissing: "拿不到这只票的报价（可能腾讯不覆盖它的代码）",
      change: "涨跌额",
      changePct: "涨跌幅",
      // ——— 明细字段的问号说明 ———
      hintPrice: "最新成交价。收盘后是当日最后一笔成交价。",
      hintChange: "涨跌额 = 现价 − 昨收。",
      hintChangePct: "涨跌幅 = 涨跌额 ÷ 昨收。判断涨跌幅度用这个，不是用涨跌额。",
      hintPrevClose: "昨日收盘价，也是今天算涨跌幅的基准。",
      hintOpen: "今天第一笔成交价。",
      hintHigh: "今天出现过的最高成交价。",
      hintLow: "今天出现过的最低成交价。",
      hintAvgPrice: "成交额 ÷ 成交量，即当日成交加权平均价。现价高于它，说明今天买入的人整体是浮盈的。",
      hintAmplitude: "振幅 =（最高 − 最低）÷ 昨收。衡量当天波动大小，与涨跌方向无关。",
      hintVolume: "今天成交的股数，按手计（1 手 = 100 股）。",
      hintStockAmount: "今天成交的金额。要和成交量一起看，才知道是放量还是缩量。",
      hintVolRatio: "量比 = 当日每分钟平均成交量 ÷ 过去 5 日每分钟平均成交量。大于 1 说明今天在放量。",
      hintTurnover: "换手率 = 成交量 ÷ 流通股本。反映筹码换手有多活跃。",
      hintPe: "市盈率(TTM) = 股价 ÷ 最近 12 个月每股收益。",
      hintPeDyn: "市盈率(动) = 用当期利润年化算出的市盈率，比 TTM 更超前。",
      hintPeStatic: "市盈率(静) = 用上一年度利润算出的市盈率。",
      hintPb: "市净率 = 股价 ÷ 每股净资产。银行、地产这类重资产行业通常偏低。",
      hintTotalCap: "总市值 = 股价 × 总股本。",
      hintFloatCap: "流通市值 = 股价 × 可流通股本。实际能买卖的盘子看这个。",
      hintOrderDiff: "委差 = 委买前五档总量 − 委卖前五档总量。正数说明挂着的买盘更厚。",
      hintOuter: "外盘 = 主动买入的成交量，即买方吃掉卖单。",
      hintInner: "内盘 = 主动卖出的成交量，即卖方砸向买单。",
      hintLimitUpPrice: "今日涨停价。到达后一般无法再涨。",
      hintLimitDownPrice: "今日跌停价。到达后一般无法再跌。",
      hintFromHigh: "现价距当日最高价还差多少。负值表示已经低于最高。",
      hintFromLow: "现价高于当日最低价的幅度。",
      hintToLimitUp: "现价再涨多少才到涨停价。",
      hintToLimitDown: "现价再跌多少才到跌停价。",
      hintVsAvg: "现价相对当日均价的偏离。正数说明比今天的平均成本更高。",
      hintOrderRatio: "委比 =（委买 − 委卖）÷（委买 + 委卖），范围 -100% 到 +100%。",
      hintBids: "买五档：挂在那里的买价与委托量。量大的价位往往是支撑。",
      hintAsks: "卖五档：挂在那里的卖价与委托量。量大的价位往往是压力。",
      hintRange: "当日区间位置：现价在「最低—最高」之间的相对位置，0% 是最低、100% 是最高。",
      fundTag: "基金",
      searchHint: "可搜股票代码/名称，也可搜场内基金（ETF/LOF），例如 510300、创业板ETF。",
      fromImage: "图片解析股票",
      hintFromImage: "从截图里认股票：把券商的持仓/自选截图贴进来，自动认出代码与名称，勾选后加入自选，不用手打。持仓截图可以顺手把右边「持有」一起勾上。",
      imgDrop: "粘贴截图（Ctrl+V）、把图片拖到这里，或点这里选文件",
      imgBusy: "正在识别…",
      imgOff: "本机没有中文 OCR：识别用的是 Windows 自带 OCR，需要在系统设置里装中文（简体）语言包。",
      imgNone: "图里没认出股票。可以试试只截自选列表那一块，别带太多无关文字。",
      imgFound: "认出 {n} 只",
      imgUnmatched: "另有 {n} 行没对上股票",
      imgAdd: "加入自选（{n}）",
      imgAdding: "加入中…",
      imgAdded: "已加入 {n} 只",
      imgAddedHeld: "，其中 {n} 只标为持有",
      imgAllPresent: "这些已在自选里，只补了持有标记",
      imgClose: "收起",
      imgHintCode: "按代码命中",
      imgHintName: "按名称命中",
      cost: "成本价",
      shares: "份额",
      todayPnl: "今日盈亏",
      holdPnl: "持仓盈亏",
      alertLow: "低价提醒",
      alertHigh: "高价提醒",
      todayBuyShort: "今买",
      held: "持有",
      heldTag: "持",
      hintHeld: "标记这只股票当前是否持有。它只是给人看的标记，用来把已持仓的票和只观察的票分开；盈亏只按成本价和份额算，不受它影响。",
      staleTag: "昨收",
      hintStale: "这条行情还是上一个交易日的（今天还没开盘或该品种今天没成交），所以今日盈亏不显示 —— 免得把昨天的涨跌当成今天的。",
      nextRefresh: "刷新",
      hintMeter: "左边是距离下一次自动刷新的秒数；右边是从服务器取到这批数据的时间。数字在动就说明它是活的。",
      hintTodayBuy: "今天才买入的仓位勾上。勾了以后「今日盈亏」改用你的成本价当基准，而不是昨收 —— 否则会显示一笔按昨收算、其实没发生的亏损。",
      pollSec: "刷新间隔",
      seconds: "秒",
      hintPoll: "整页数据的自动刷新间隔。行情接口有缓存，设得比 3 秒还短没意义。",
      enableNotify: "开启电脑通知",
      notifyOn: "电脑通知已开启",
      notifyDenied: "通知被拒绝，需在浏览器地址栏左侧的站点设置里允许",
      notifyUnsupported: "这个环境不支持系统通知",
      holdingsHint: "点每一行末尾的「编辑」即可填成本价、份额、持有标记和价格提醒；填完点「保存」才生效，点「取消」全部丢弃。",
      notifyTitleLow: "跌破低价",
      notifyTitleHigh: "涨过高价",
      edit: "编辑",
      saveEdit: "保存",
      cancelEdit: "取消",
      holdingsEditing: "这一行正在编辑：改完点「保存」才生效，点「取消」全部丢弃。",
      crashTitle: "行情台渲染出错",
      crashHint: "把这段报错发给开发者即可定位。行情数据本身没问题，是界面这一层挂了。",

      pagePrev: "上一页",
      pageNext: "下一页",
      marketAmount: "全市场成交额",
      hintAmount: "全市场所有个股当日成交金额合计（只算个股，不含指数与 ETF）。\n用来判断市场整体是放量还是缩量。",
      hintBreadth: "全市场个股的涨跌家数分布。上涨家数远多于下跌说明普涨。",
      // 服务端只开放前 5 页的成分股表（第 6 页起跳登录），
      // 所以分页器不能承诺更多 —— 这里给用户一句实话
      kline: "K 线",
      minute: "分时",
      kMin: "分时",
      minPrice: "价",
      minAvg: "均",
      minBase: "昨收",
      minOpen: "开",
      minNoon: "午",
      minPm: "午后",
      minClose: "收",
      kOpen: "开",
      kHigh: "高",
      kLow: "低",
      kClose: "收",
      zoomHint: "Ctrl+滚轮缩放 · 按住拖动平移",
      kDay: "日K",
      kWeek: "周K",
      kMonth: "月K",
      trading: "交易中",
      closed: "已收盘",
      breakTime: "休市",
      preOpen: "未开盘",
      up: "上涨",
      down: "下跌",
      flat: "平盘",
      sources: "数据源",
      settings: "设置",
      empty: "还没有自选股，上面搜一个加进来。",
      colorScheme: "涨跌配色",
      auto: "跟随主题",
      redUp: "红涨绿跌",
      greenUp: "绿涨红跌",
      density: "行高",
      comfortable: "宽松",
      compact: "紧凑",
      pillIndex: "药丸显示指数",
      save: "保存",
      saved: "已保存",
      remove: "移除",
      migrate: "从旧插件迁移自选股",
      configPath: "配置文件",
      snapshot: "快照",
      height: "最高板",
      stale: "陈旧",
      stock: "名称",
      price: "现价",
      pct: "涨跌",
      turnover: "换手",
      amount: "成交额",
      volume: "成交量",
      prevClose: "昨收",
      open: "今开",
      high: "最高",
      low: "最低",
      avgPrice: "均价",
      amplitude: "振幅",
      volRatio: "量比",
      orderDiff: "委差",
      peDyn: "市盈率(动)",
      peStatic: "市盈率(静)",
      pb: "市净率",
      totalCap: "总市值",
      floatCap: "流通市值",
      outer: "外盘",
      inner: "内盘",
      gPrice: "价格",
      gVolume: "成交",
      gValuation: "估值",
      gOrderbook: "盘口",
      bids: "买五档",
      asks: "卖五档",
      gLimit: "涨跌停",
      close: "收起",
      pe: "市盈率(TTM)",
      gPosition: "位置",
      fromHigh: "距最高",
      fromLow: "距最低",
      toLimitUp: "距涨停",
      toLimitDown: "距跌停",
      vsAvg: "较均价",
      orderRatio: "委比",
    };
    const en = {
      title: "Quote Desk",
      loading: "Fetching…",
      unavailable: "Unavailable",
      unavailableHint: "This source is temporarily down; stale values are never shown in place of live ones.",
      watchlist: "Watchlist",
      indices: "Indices",
      breadth: "Advancers / decliners",
      limitUp: "Limit up",
      limitDown: "Limit down",
      burst: "Broke limit",
      firstBoard: "First board",
      sectors: "Sectors",
      boardUp: "Top gainers",
      boardDown: "Top losers",
      constituents: "Constituents",
      drillHint: "Click a tile to see that sector's constituents",
      prevPage: "Prev",
      nextPage: "Next",
      leader: "Leader",
      upDown: "Up/Down",
      boardNoDrill: "No constituent data available for this sector",
      pages: "pages",
      freeLimit: "THS exposes only the first 5 pages anonymously; sign in for the rest",
      localScan: "local scan",
      estimated: "est.",
      hintLimitUp: "Number of stocks that closed at their upper price limit and stayed sealed.",
      hintBroke: "Broke limit: stocks that touched the upper limit intraday but failed to close sealed. A larger number means limit-ups were weaker.",
      hintLimitDown: "Number of stocks that closed at their lower price limit.",
      hintFirstBoard: "First board: limit-up today with no preceding consecutive limit-up days. Equals limit-ups minus consecutive boards.",
      hintLadder: "Consecutive boards: limit-up stocks grouped by how many sessions in a row they have hit the limit. 3 boards = three consecutive sessions.",
      hintBoardUp: "The 10 industry sectors with the largest gains today, ranked by sector change.",
      hintBoardDown: "The 10 industry sectors with the largest losses today, ranked by sector change.",
      peekHint: "Open detail and chart",
      timeout: "Request timed out",
      retry: "Retry",
      quoteMissing: "No quote available for this stock (Tencent may not cover its code)",
      change: "Change",
      changePct: "Change %",
      hintPrice: "Latest traded price. After close, the last trade of the day.",
      hintChange: "Change = last − previous close.",
      hintChangePct: "Change % = change ÷ previous close. Use this, not the absolute change.",
      hintPrevClose: "Previous close, also the base for today's change percentage.",
      hintOpen: "First traded price today.",
      hintHigh: "Highest traded price today.",
      hintLow: "Lowest traded price today.",
      hintAvgPrice: "Amount ÷ volume: today's volume-weighted average price.",
      hintAmplitude: "Amplitude = (high − low) ÷ previous close. Measures intraday range, not direction.",
      hintVolume: "Shares traded today, in lots (1 lot = 100 shares).",
      hintStockAmount: "Value traded today. Read alongside volume.",
      hintVolRatio: "Volume ratio = today's per-minute volume ÷ the 5-day average per-minute volume. Above 1 means heavier volume.",
      hintTurnover: "Turnover = volume ÷ free float. How actively the float changed hands.",
      hintPe: "P/E (TTM) = price ÷ trailing twelve-month EPS.",
      hintPeDyn: "Forward P/E, annualized from current-period earnings.",
      hintPeStatic: "Static P/E, based on last year's earnings.",
      hintPb: "P/B = price ÷ book value per share.",
      hintTotalCap: "Total market cap = price × total shares.",
      hintFloatCap: "Float market cap = price × tradable shares.",
      hintOrderDiff: "Order imbalance = top-5 bid volume − top-5 ask volume.",
      hintOuter: "Outer volume: aggressive buys that hit the ask.",
      hintInner: "Inner volume: aggressive sells that hit the bid.",
      hintLimitUpPrice: "Today's upper price limit.",
      hintLimitDownPrice: "Today's lower price limit.",
      hintFromHigh: "How far the last price is below today's high.",
      hintFromLow: "How far the last price is above today's low.",
      hintToLimitUp: "How much more it must rise to reach the upper limit.",
      hintToLimitDown: "How much more it must fall to reach the lower limit.",
      hintVsAvg: "Last price relative to today's average price.",
      hintOrderRatio: "Order ratio = (bids − asks) ÷ (bids + asks), from -100% to +100%.",
      hintBids: "Top-5 bids: resting buy prices and sizes. Large sizes often act as support.",
      hintAsks: "Top-5 asks: resting sell prices and sizes. Large sizes often act as resistance.",
      hintRange: "Intraday position: where the last price sits between today's low (0%) and high (100%).",
      fundTag: "Fund",
      searchHint: "Search stocks by code or name, or on-exchange funds (ETF/LOF) such as 510300.",
      fromImage: "Read a screenshot",
      hintFromImage: "Read a broker screenshot: paste it in, get the codes and names back, tick the ones you want and add them without typing. For a holdings screenshot, tick 持有 on the right as well.",
      imgDrop: "Paste a screenshot (Ctrl+V), drop it here, or click to pick a file",
      imgBusy: "Reading the image…",
      imgOff: "No Chinese OCR on this machine: it uses the built-in Windows OCR, which needs the Chinese (Simplified) language pack.",
      imgNone: "No stocks found in that image. Try cropping to just the watchlist rows.",
      imgFound: "Found {n}",
      imgUnmatched: "{n} more lines matched nothing",
      imgAdd: "Add to watchlist ({n})",
      imgAdding: "Adding…",
      imgAdded: "Added {n}",
      imgAddedHeld: ", {n} marked as held",
      imgAllPresent: "Already in the watchlist; only the held mark was added",
      imgClose: "Hide",
      imgHintCode: "matched by code",
      imgHintName: "matched by name",
      cost: "Cost",
      shares: "Shares",
      todayPnl: "Today P/L",
      holdPnl: "Total P/L",
      alertLow: "Low alert",
      alertHigh: "High alert",
      todayBuyShort: "bought today",
      held: "Held",
      heldTag: "held",
      hintHeld: "Marks whether you currently hold this stock, to separate positions from names you only watch. P/L uses cost and shares only; this flag does not affect it.",
      staleTag: "prev close",
      hintStale: "This quote is from the previous trading day, so today's P/L is hidden instead of showing yesterday's move.",
      nextRefresh: "refresh",
      hintMeter: "Seconds until the next automatic refresh; the time on the right is when this data was fetched.",
      hintTodayBuy: "Tick if this position was opened today. Today's P/L will then be measured from your cost, not yesterday's close.",
      pollSec: "Refresh",
      seconds: "s",
      hintPoll: "Auto-refresh interval for the whole page.",
      enableNotify: "Enable desktop alerts",
      notifyOn: "Desktop alerts on",
      notifyDenied: "Notifications blocked; allow them in the site settings",
      notifyUnsupported: "This environment does not support notifications",
      holdingsHint: "Press Edit at the end of a row to fill cost, shares, the held flag and price alerts; nothing is saved until you press Save.",
      notifyTitleLow: "below low alert",
      notifyTitleHigh: "above high alert",
      edit: "Edit",
      saveEdit: "Save",
      cancelEdit: "Cancel",
      holdingsEditing: "Editing this row: nothing is saved until you press Save.",
      crashTitle: "Quote desk render error",
      crashHint: "Send this message to the developer. The data is fine; the UI layer failed.",

      pagePrev: "Prev",
      pageNext: "Next",
      marketAmount: "Market turnover",
      hintAmount: "Total traded value of all stocks today (stocks only, excluding indices and ETFs).",
      hintBreadth: "Distribution of advancing and declining stocks across the whole market.",
      kline: "Chart",
      minute: "Intraday",
      kMin: "Intraday",
      minPrice: "P",
      minAvg: "Avg",
      minBase: "Prev",
      minOpen: "Open",
      minNoon: "Noon",
      minPm: "PM",
      minClose: "Close",
      kOpen: "O",
      kHigh: "H",
      kLow: "L",
      kClose: "C",
      zoomHint: "Ctrl+wheel to zoom · drag to pan",
      kDay: "Daily",
      kWeek: "Weekly",
      kMonth: "Monthly",
      trading: "Trading",
      closed: "Closed",
      breakTime: "Market closed",
      preOpen: "Pre-open",
      up: "Up",
      down: "Down",
      flat: "Flat",
      sources: "Sources",
      settings: "Settings",
      empty: "No symbols yet — search above to add one.",
      colorScheme: "Up/down colors",
      auto: "Follow theme",
      redUp: "Red up",
      greenUp: "Green up",
      density: "Row height",
      comfortable: "Comfortable",
      compact: "Compact",
      pillIndex: "Pill index",
      save: "Save",
      saved: "Saved",
      remove: "Remove",
      migrate: "Import watchlist from the old plugin",
      configPath: "Config file",
      snapshot: "snapshot",
      height: "Top board",
      stale: "stale",
      stock: "Name",
      price: "Last",
      pct: "Chg",
      turnover: "Turn",
      amount: "Amount",
      volume: "Volume",
      prevClose: "Prev close",
      open: "Open",
      high: "High",
      low: "Low",
      avgPrice: "Avg",
      amplitude: "Amplitude",
      volRatio: "Vol ratio",
      orderDiff: "Order diff",
      peDyn: "P/E (dyn)",
      peStatic: "P/E (static)",
      pb: "P/B",
      totalCap: "Market cap",
      floatCap: "Float cap",
      outer: "Outer",
      inner: "Inner",
      gPrice: "Price",
      gVolume: "Turnover",
      gValuation: "Valuation",
      gOrderbook: "Order book",
      bids: "Bid 5",
      asks: "Ask 5",
      gLimit: "Limits",
      close: "Collapse",
      pe: "P/E (TTM)",
      gPosition: "Position",
      fromHigh: "From high",
      fromLow: "From low",
      toLimitUp: "To limit up",
      toLimitDown: "To limit down",
      vsAvg: "Vs avg",
      orderRatio: "Bid/ask ratio",
    };
    //#endregion

    //#region 样式
    // 只用 --dsw-alias-* 主题变量，不写字面色值：深浅色切换不需要用户手动操作。
    // 涨跌色是行情刚需（红涨绿跌是 A 股惯例），所以单列两个自定义属性，
    // 由 data-up 属性在根节点上切换，而不是散落在各处写死。
    const CSS = `
/* 涨跌色走 state 令牌而不是写死十六进制：写死的话切到深色主题会偏暗看不清。
   语义上红=error、绿=success 是凑巧对上，真正的好处是这两个令牌 requiresLightAndDark，
   由 DSH 按当前主题换值。A 股习惯红涨绿跌，所以默认 up 取 error、down 取 success。 */
.skd-root{--skd-dim:var(--dsw-alias-label-secondary);--skd-up:var(--dsw-alias-state-error-primary);--skd-down:var(--dsw-alias-state-success-primary);--skd-flat:var(--skd-dim);
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.skd-root[data-scheme="green-up"]{--skd-up:var(--dsw-alias-state-success-primary);--skd-down:var(--dsw-alias-state-error-primary)}
.skd-up{color:var(--skd-up)}.skd-down{color:var(--skd-down)}.skd-flat{color:var(--skd-flat)}
.skd-num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.skd-page{display:flex;flex-direction:column;gap:14px;padding:16px 18px 28px;min-width:0;
  height:100%;box-sizing:border-box;overflow-y:auto;overscroll-behavior:contain}
.skd-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.skd-h1{font-size:16px;font-weight:600;margin:0}
.skd-meta{font-size:12px;color:var(--skd-dim)}
.skd-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.skd-card-h{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.skd-card-b{padding:6px 0}
.skd-tbl{width:100%;border-collapse:collapse}
.skd-tbl th{font-weight:400;font-size:11px;color:var(--skd-dim);text-align:right;
  padding:4px 10px;white-space:nowrap}
.skd-tbl th:first-child{text-align:left}
.skd-tbl td{padding:5px 10px;text-align:right;white-space:nowrap;border-top:1px solid var(--dsw-alias-border-l1)}
.skd-tbl td:first-child{text-align:left}
.skd-tbl tbody tr:hover{background:var(--dsw-alias-bg-layer-2)}
.skd-root[data-density="compact"] .skd-tbl td{padding:2px 10px}
.skd-root[data-density="compact"] .skd-card-b{padding:2px 0}
.skd-name{display:flex;align-items:center;gap:6px;min-width:0}
.skd-code{font-size:11px;color:var(--skd-dim)}
.skd-tag{font-size:10px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);
  color:var(--skd-dim);line-height:16px}
/* 名称做成按钮：整行挂 onClick 键盘用户永远聚焦不到 */
.skd-name-btn{appearance:none;border:0;background:none;padding:0;font:inherit;color:inherit;
  cursor:pointer;text-align:left;border-radius:5px}
.skd-name-btn:hover{color:var(--dsw-alias-brand-primary)}
.skd-stock{padding:0 3px;font-size:inherit;font-weight:400;line-height:inherit}
.skd-d{margin:10px 10px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.skd-d-hd{display:flex;align-items:center;gap:8px;padding:9px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.skd-d-name{font-weight:600}
.skd-d-stamp{font-size:11px;color:var(--skd-dim);margin-left:auto}
.skd-d-groups{display:flex;flex-wrap:wrap}
.skd-d-g{flex:1 1 176px;min-width:176px;padding:9px 12px;
  border-right:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.skd-d-gt{font-size:11px;color:var(--skd-dim);margin-bottom:6px}
.skd-d-r{display:flex;justify-content:space-between;gap:10px;font-size:12px;line-height:19px}
.skd-d-k{color:var(--dsw-alias-label-secondary)}
.skd-d-board{padding:9px 12px}
.skd-d-ratio{display:flex;justify-content:space-between;gap:10px;font-size:12px;
  line-height:19px;margin-bottom:6px}
.skd-d-pos{padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
/* 位置条用品牌色而不是红绿：它表示「处在当日区间的哪个位置」，不表示涨跌 */
.skd-rng{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);margin:4px 0 8px;overflow:hidden}
.skd-rng-f{height:100%;background:var(--dsw-alias-brand-primary);border-radius:3px}
.skd-d-lv{display:inline-block;vertical-align:top;min-width:132px;margin-right:22px}
.skd-d-lvt{font-size:11px;color:var(--skd-dim);margin-bottom:5px}
.skd-d-lvr{display:flex;justify-content:space-between;gap:10px;font-size:12px;line-height:18px}
.skd-d-lvv{color:var(--dsw-alias-label-secondary)}
.skd-idx{display:flex;flex-wrap:wrap;gap:6px}
.skd-idx-i{flex:1 1 138px;min-width:138px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;
  padding:8px 11px;background:var(--dsw-alias-bg-layer-1);
  /* 它是一个 button：把这几个 UA 默认值复位，否则会出现灰底和居中文字 */
  appearance:none;font:inherit;text-align:left;color:inherit;cursor:pointer;min-width:138px}
.skd-idx-i:hover{border-color:var(--dsw-alias-brand-primary)}
.skd-idx-i:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.skd-idx-i[data-active="1"]{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset}
.skd-idx-n{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;justify-content:space-between;gap:8px}
.skd-idx-v{font-size:18px;font-weight:600;margin-top:2px}
.skd-idx-s{font-size:12px;margin-top:1px}
.skd-breadth{display:flex;flex-direction:column;gap:7px;padding:11px 12px}
.skd-bar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.skd-bar-u{background:var(--skd-up)}.skd-bar-d{background:var(--skd-down)}.skd-bar-f{background:var(--dsw-alias-state-idle-primary)}
.skd-legend{display:flex;gap:14px;font-size:12px;flex-wrap:wrap}
/* 涨跌家数 + 全市场成交额：两段，比原来省一行 */
.skd-breadth{padding:9px 12px;display:flex;flex-direction:column;gap:8px}
.skd-bar-slim{height:6px}
.skd-brow{display:flex;gap:12px;align-items:baseline;justify-content:space-between;flex-wrap:wrap;font-size:12px}
.skd-brow-h{white-space:nowrap}
.skd-brow-h b{font-weight:700;font-variant-numeric:tabular-nums}
.skd-bamt{white-space:nowrap;color:var(--dsw-alias-label-primary)}
.skd-bamt b{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;margin:0 1px}
/* 大盘指数 + 涨跌家数一行：左宽右窄 */
.skd-row2{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,300px);gap:14px;align-items:start}
/* 点开指数明细时切单列：K 线挤在左半边不如让它占满 */
.skd-row2[data-peek="1"]{grid-template-columns:minmax(0,1fr)}
@media (max-width:760px){.skd-row2{grid-template-columns:minmax(0,1fr)}}
.skd-rows{padding:8px 12px;display:flex;flex-direction:column;gap:6px}
.skd-row{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:baseline;font-size:12.5px}
.skd-row-r{text-align:right;white-space:nowrap}
/* 板块格子：一屏能看到十几个板块，强弱靠底色与数字大小直接读出来，不用逐行比数字 */
.skd-btabs{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px 12px 2px}
.skd-btab{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;
  background:var(--dsw-alias-bg-layer-1);color:var(--skd-dim);
  font:inherit;font-size:12px;padding:4px 11px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
/* 选中态刻意不用 brand-primary 填底 + #fff 文字：这个主题没有 on-brand 前景色令牌，
   而 brand-primary 在大面积填充时偏浅，白字压上去就是白底白字（用户报的「选谁谁白」）。
   跟 .skd-tab[data-on="1"] 一样，把强调色只用在描边上，文字仍取 label-primary。 */
.skd-btab[data-on="1"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-label-primary);font-weight:600}
.skd-btab:disabled{opacity:.45;cursor:not-allowed}
.skd-btab-n{font-size:10.5px;opacity:.75}
.skd-bhint{margin-left:auto;font-size:11px}
.skd-bgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;padding:10px 12px}
.skd-bcell{appearance:none;text-align:left;display:flex;flex-direction:column;gap:2px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 9px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font:inherit;cursor:pointer;min-width:0;overflow:hidden}
/* 底色只有浏览器支持 color-mix 时才生效，不支持就退回上面的 layer-1，不会变成透明块 */
/* 底色与数字颜色只依赖 data-d，取值必须是 up/down/flat 三个纯值（见 dirKey 的注释） */
.skd-bcell[data-d="up"]{background:color-mix(in srgb, var(--skd-up) 18%, var(--dsw-alias-bg-layer-1))}
.skd-bcell[data-d="down"]{background:color-mix(in srgb, var(--skd-down) 18%, var(--dsw-alias-bg-layer-1))}
/* 炸板既不是涨也不是跌：用警示色，别让人把它误读成红/绿 */
.skd-bcell[data-d="warn"]{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 15%, var(--dsw-alias-bg-layer-1))}
.skd-bcell[data-d="flat"]{background:var(--dsw-alias-bg-layer-2)}
.skd-bcell:hover{border-color:var(--dsw-alias-brand-primary)}
.skd-bcell:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.skd-bcell[data-active="1"]{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset}
.skd-bcell:disabled{cursor:not-allowed;opacity:.55}
.skd-bcell-n{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skd-bcell-v{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.15}
.skd-bcell[data-d="up"] .skd-bcell-v{color:var(--skd-up)}
.skd-bcell[data-d="down"] .skd-bcell-v{color:var(--skd-down)}
.skd-bcell[data-d="warn"] .skd-bcell-v{color:var(--dsw-alias-state-warn-primary)}
.skd-bcell-s{font-size:10.5px;color:var(--skd-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 上市板块标记。创业板用警示色描边：用户明确说过买不了创业板，必须第一眼分出来 */
.skd-mkt{display:inline-block;margin-left:5px;padding:0 4px;border-radius:3px;font-size:10px;line-height:1.5;
  border:1px solid var(--dsw-alias-border-l2);color:var(--skd-dim);vertical-align:1px;white-space:nowrap}
.skd-mkt[data-mkt="创业板"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.skd-mkt[data-mkt="科创板"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.skd-peek{margin:0 10px 10px}
/* 持仓表的可编辑单元格：窄一点，别把表撑爆 */
.skd-htbl .skd-hcell{width:86px;padding:2px 6px;font-size:12px;text-align:right}
.skd-hold-hint{padding:6px 12px}
.skd-htbl .skd-hval{display:inline-block;min-width:40px;color:var(--dsw-alias-label-primary)}
.skd-htbl td:empty::after{content:"—";color:var(--skd-dim)}
/* 成本价格子里附一个「今买」勾选框 */
.skd-costcell{display:inline-flex;align-items:center;gap:5px}
/* 持有标记列。窄列，不跟行情数字抢宽度 */
.skd-htbl .skd-heldcol{width:44px;text-align:center;padding:2px 4px}
/* 持有标记用品牌色描边而不是填充：填充色在这套主题里只能当描边用，
   填满再配白字正是之前「点上去按钮变全白」那个坑 */
.skd-tag-held{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.skd-heldedit{display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
/* 行尾操作：两个小按钮并排，编辑态换成保存/取消，宽度别跳动 */
.skd-htbl .skd-actcol{white-space:nowrap;text-align:right;padding:2px 4px}
.skd-actbtns{display:inline-flex;align-items:center;gap:4px;justify-content:flex-end}
/* 上一交易日的行情：标签变暗，别和今天的数据混在一起看 */
.skd-tag-stale{opacity:.62;border-style:dashed}
/* 刷新倒计时 */
.skd-meter{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--skd-dim);white-space:nowrap;font-variant-numeric:tabular-nums}
.skd-meter b{font-weight:600;color:var(--skd-fg)}
.skd-meter-at{opacity:.75}
.skd-dot{width:6px;height:6px;border-radius:50%;background:var(--skd-ok);display:inline-block;flex:none}
.skd-dot[data-wait="1"]{background:var(--skd-warn);animation:skd-pulse 1s ease-in-out infinite}
@keyframes skd-pulse{0%,100%{opacity:1}50%{opacity:.25}}
.skd-todaybuy{display:inline-flex;align-items:center;gap:2px;font-size:10px;color:var(--skd-dim);cursor:pointer;white-space:nowrap}
.skd-todaybuy input{margin:0;width:11px;height:11px;cursor:pointer}
/* 下钻面板的身体：左名单 + 右详情 */
.skd-drill-body{padding:0 10px 10px}
.skd-drill-err{display:flex;align-items:center;gap:10px;padding:0 10px}
.skd-drill-err .skd-msg{padding:6px 0}
/* 左列表 / 右详情：两边同时可见，右侧跟随滚动 */
.skd-split{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(300px,1fr);gap:12px;align-items:start}
.skd-split-main{min-width:0}
.skd-split-side{min-width:0;position:sticky;top:6px}
.skd-split-side .skd-d{margin:0}
@media (max-width:720px){.skd-split{grid-template-columns:1fr}.skd-split-side{position:static}}
/* 术语后面的小问号：鼠标一停看说明，不占版面 */
.skd-hint{display:inline-flex;align-items:center;justify-content:center;flex:0 0 13px;
  width:13px;height:13px;margin-left:4px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);
  font-size:9.5px;line-height:1;font-weight:700;color:var(--skd-dim);
  cursor:help;user-select:none;vertical-align:1px}
.skd-hint:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.skd-bdrill{margin:2px 12px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;
  background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.skd-bdrill-hd{display:flex;gap:8px;align-items:center;padding:8px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.skd-bdrill-t{font-size:12.5px;font-weight:600;margin-right:auto}
.skd-btbl{margin:0}.skd-btbl td,.skd-btbl th{padding-left:10px;padding-right:10px}
.skd-pager{display:flex;gap:9px;align-items:center;justify-content:center;padding:9px 10px}
.skd-msg{padding:14px 12px;font-size:12px;color:var(--skd-dim)}
.skd-err{color:var(--dsw-alias-state-error-primary)}
.skd-src{display:flex;flex-wrap:wrap;gap:8px;font-size:11.5px;color:var(--skd-dim);align-items:center}
.skd-dot{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:4px;background:var(--dsw-alias-state-success-primary)}
.skd-dot[data-bad="1"]{background:var(--dsw-alias-state-error-primary)}
.skd-dot[data-warn="1"]{background:var(--dsw-alias-state-warn-primary)}
.skd-src-i{display:inline-flex;align-items:center}
.skd-input,.skd-select{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;
  padding:5px 9px;min-width:0}
.skd-input:focus-visible,.skd-select:focus-visible,.skd-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.skd-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:5px 11px;cursor:pointer}
.skd-btn:hover{background:var(--dsw-alias-bg-layer-2)}
/* 主按钮：不用 brand-primary 填底 + #fff 文字（缺 on-brand 令牌，浅色下就是白底白字）。
   反过来用 label-primary 当底、bg-base 当字，浅色主题得到深底浅字、深色主题得到浅底深字，
   两种主题下对比度都成立。 */
.skd-btn[data-primary="1"]{border-color:transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
.skd-btn[data-xs="1"]{font-size:11px;padding:2px 7px;border-radius:5px}
/* 开关型按钮的按下态：例如自选卡头的「图片」。
   不拿 brand-primary 填底，理由同主按钮那条注释。 */
.skd-btn[data-on="1"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
/* 通用的工具条：允许换行。设置页那排按钮用它 */
.skd-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
/* 自选卡头右半区强行排成一行。
   倒计时 / 刷新间隔 / 通知是三个定宽小件，搜索框是唯一能伸缩的那个 ——
   空间不够时让搜索框变窄，而不是把这一行拆成两行。
   原先这里是 wrap + .skd-sr 的 min-width:170px，两者一叠加就必然换行；
   作用域限定在卡头内，设置页那排按钮仍用上面通用的 wrap。 */
.skd-card-h>.skd-tools{flex-wrap:nowrap;flex:1 1 auto;min-width:0;justify-content:flex-end}
/* 卡头里的按钮自己不许折行：它是定宽小件，空间不够时该让搜索框变窄。
   「图片解析股票」是六个字，不锁住会在窄窗口里断成两行把这一行撑高 */
.skd-card-h>.skd-tools>.skd-btn{flex:0 0 auto;white-space:nowrap}
/* 刷新相关的一组：nowrap 保证倒计时、刷新间隔、通知不会互相拆到两行去 */
.skd-toolgroup{display:flex;gap:8px;align-items:center;flex-wrap:nowrap;flex:0 0 auto}
.skd-sr{position:relative;flex:0 1 220px;min-width:90px}
/* 图片识别面板。长在自选表上方，用完即收 */
.skd-imgbox{display:flex;flex-direction:column;gap:8px;margin:0 10px 10px;padding:10px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.skd-imghead{display:flex;align-items:center;gap:8px}
.skd-imghint{flex:1 1 auto;min-width:0;font-size:12px;color:var(--skd-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skd-imgdrop{display:flex;align-items:center;justify-content:center;min-height:64px;padding:10px;
  border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;font-size:12.5px;color:var(--skd-dim);
  cursor:pointer;text-align:center}
.skd-imgdrop:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.skd-imglist{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow-y:auto}
.skd-imgrow{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;font-size:12.5px}
.skd-imgrow:hover{background:var(--dsw-alias-bg-layer-2)}
.skd-imgpick{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;cursor:pointer}
.skd-imgheld{display:flex;align-items:center;gap:4px;flex:0 0 auto;font-size:11.5px;
  color:var(--skd-dim);cursor:pointer}
.skd-imgheld input{cursor:pointer}
.skd-imgname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skd-imgfoot{display:flex;align-items:center;gap:10px}
.skd-imgfoot>.skd-meta{flex:1 1 auto;min-width:0}
.skd-sr-list{position:absolute;z-index:20;left:0;right:0;top:calc(100% + 4px);max-height:230px;overflow-y:auto;
  border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);
  box-shadow:0 8px 24px rgba(0,0,0,.18)}
.skd-sr-list[data-up="1"]{top:auto;bottom:calc(100% + 4px)}
.skd-k{margin-top:10px;border-top:1px solid var(--dsw-alias-border-l1);padding:8px 12px 10px}
.skd-k-hd{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.skd-k-tabs{display:flex;gap:2px}
.skd-k-lg{display:flex;gap:9px;font-size:11px;margin-left:auto;font-variant-numeric:tabular-nums}
.skd-k-svg{width:100%;height:auto;display:block;margin:6px 0 2px}
.skd-k-ft{display:flex;align-items:center;gap:10px;font-size:11px}
.skd-k-wick,.skd-k-body{stroke:none}
.skd-k-up .skd-k-wick,.skd-k-up .skd-k-body,.skd-k-up .skd-k-vol{fill:var(--skd-up)}
.skd-k-dn .skd-k-wick,.skd-k-dn .skd-k-body,.skd-k-dn .skd-k-vol{fill:var(--skd-down)}
.skd-k-vol{opacity:.5}
/* 均线走 currentColor，颜色在下面按类给 —— 一处改，线和图例同时跟着变 */
.skd-k-line{fill:none;stroke:currentColor;stroke-width:1.2;vector-effect:non-scaling-stroke}
.skd-k-ma.ma5{color:var(--dsw-alias-state-warn-primary)}
.skd-k-ma.ma10{color:var(--dsw-alias-brand-primary)}
.skd-k-ma.ma20{color:var(--dsw-alias-state-idle-primary)}
.skd-k-sep{stroke:var(--dsw-alias-border-l1);stroke-width:1;vector-effect:non-scaling-stroke}
.skd-k-line.mprice{color:var(--dsw-alias-brand-primary)}
.skd-k-line.mavg{color:var(--dsw-alias-state-warn-primary)}
/* 昨收基准是分时图的涨跌分界，用虚线是为了不跟价格线抢注意力 */
.skd-k-base{stroke:var(--dsw-alias-label-secondary);stroke-width:1;stroke-dasharray:3 3;vector-effect:non-scaling-stroke;opacity:.55}
.skd-k-vbar-up{fill:var(--skd-up);opacity:.5}
.skd-k-vbar-dn{fill:var(--skd-down);opacity:.5}
/* 刻度与网格。刻度是这张图从「看不懂」变「能读」的关键，别把字号压到 9px 以下 */
.skd-k-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1;vector-effect:non-scaling-stroke;opacity:.5}
.skd-k-axis{fill:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.skd-k-area-up{fill:var(--skd-up);opacity:.16}
.skd-k-area-dn{fill:var(--skd-down);opacity:.16}
.skd-k-cross{stroke:var(--dsw-alias-label-secondary);stroke-width:1;stroke-dasharray:2 3;vector-effect:non-scaling-stroke}
.skd-k-crossdot{fill:var(--dsw-alias-bg-base);stroke:var(--dsw-alias-label-primary);stroke-width:1.5;vector-effect:non-scaling-stroke}
.skd-k-dot{fill:var(--dsw-alias-brand-primary)}
.skd-k-cursor{color:var(--dsw-alias-brand-primary);font-weight:600}
.skd-k-lg .skd-k-ma{white-space:nowrap}
.skd-k-hint{color:var(--dsw-alias-label-secondary);font-size:11px;opacity:.75}
/* 能拖动的图给个抓手光标，否则用户根本不会想到可以按下去拖 */
.skd-k-svg{cursor:crosshair}
.skd-k-svg:active{cursor:grabbing}
.skd-sr-i{display:flex;justify-content:space-between;gap:8px;padding:5px 10px;cursor:pointer;font-size:12.5px}
.skd-sr-i:hover{background:var(--dsw-alias-bg-layer-2)}
.skd-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);padding:0 4px}
.skd-tab{appearance:none;border:0;background:none;font:inherit;font-size:12.5px;color:var(--skd-dim);
  padding:7px 10px;cursor:pointer;border-bottom:2px solid transparent}
.skd-tab[data-on="1"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.skd-set{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;padding:12px}
.skd-f{display:flex;flex-direction:column;gap:5px}
.skd-f-l{font-size:12px;color:var(--dsw-alias-label-secondary)}
.skd-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;
  color:var(--skd-dim);word-break:break-all}
/* 药丸：常驻在页面上，不挡内容，可拖动 */
/* shell.overlay 整层是 click-through，目录原文是 entries opt back into pointer events。
   不显式打开的话，药丸看得见但点不动、拖不动、也关不掉 —— 整层把指针事件全漏过去了。 */
.skd-pill{position:fixed;z-index:60;pointer-events:auto;right:18px;bottom:18px;display:flex;align-items:center;gap:9px;
  padding:6px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;
  background:var(--dsw-alias-bg-overlay);box-shadow:0 6px 20px rgba(0,0,0,.2);cursor:grab;
  font-size:12.5px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;user-select:none}
.skd-pill:active{cursor:grabbing}
.skd-pill-n{color:var(--skd-dim);font-size:11.5px}
.skd-pill-x{appearance:none;border:0;background:none;color:var(--skd-dim);cursor:pointer;
  font:inherit;font-size:13px;line-height:1;padding:0 1px}
.skd-s-btn{display:flex;align-items:center;gap:8px;width:100%;appearance:none;border:0;background:none;
  font:inherit;color:inherit;text-align:left;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px}
.skd-s-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.skd-s-btn[data-on="1"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.skd-s-ico{flex:none;width:16px;height:16px;display:block}
`;
    //#endregion

    //#region 数据客户端
    /**
     * 全局轮询器。
     *
     * 为什么做成单例而不是每个组件各自 useEffect：药丸、侧边栏按钮、整页三个组件同时挂载，
     * 各自轮询就会把同一份 /dashboard 打三遍。这里只留一个定时器，组件只订阅。
     */
    /** 单个接口的等待上限。超过就当它没回，而不是一直转圈 */
    const REQUEST_TIMEOUT_MS = 15000;

    /**
     * 调宿主接口。
     *
     * 宿主一律回 {ok, data} 信封（见 lib/routes.js），在这里统一拆封并抛错：
     * 拆封散在每个调用点的话，漏掉一处就会静默拿到 undefined —— 界面留白且不报错。
     */
    async function api(path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
      // 浏览器侧的 fetch 默认没有超时。连接被挂住（不是被拒绝，而是没人回）时，
      // 界面会永远停在「正在取数…」—— 用户报的就是这个。
      // 实测后端对同一个请求 1~3ms 就返回，所以挂住只可能是连接层面的问题；
      // 加超时至少能把它变成一条能读的报错，而不是无限转圈。
      //
      // 图片识别单独放宽：一次 OCR 是「上传几百 KB + 起 PowerShell + 认图」，
      // 15 秒的行情超时对它太紧，超时了报的还是「取数超时」，看不出是图片那一路。
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(API + path, body === undefined ? { signal: ctl.signal } : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
      } catch (err) {
        if (err?.name === "AbortError") {
          throw new Error(`${T("timeout")}（${timeoutMs / 1000}s）：${path.split("?")[0]}`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      return json.data;
    }

    function createDesk() {
      const subs = new Set();
      let snap = { phase: "loading", data: null, error: null };
      let timer = null;
      let alive = false;

      const emit = () => { for (const fn of subs) fn(snap); };

      async function pull() {
        try {
          const data = await api("/dashboard");
          snap = { phase: "ready", data, error: null };
        } catch (err) {
          // 保留上一次的 data 但标记 error，让界面明确显示「陈旧」，而不是假装它是最新的
          snap = { phase: snap.data ? "stale" : "failed", data: snap.data, error: String(err.message ?? err) };
        }
        emit();
        if (!alive) return;
        // 用户在界面上设了刷新间隔就以它为准（默认 10 秒）；
        // 没设才回落到宿主按交易时段给出的默认值（交易中 3 秒、休市 60 秒）。
        const sec = Number(snap.data?.config?.ui?.pollSec);
        const wait = Number.isFinite(sec) && sec > 0 ? sec * 1000 : (snap.data?.pollMs ?? 5000);
        timer = setTimeout(pull, snap.error ? Math.max(wait, 15000) : wait);
      }

      return {
        get: () => snap,
        start() {
          if (alive) return () => {};
          alive = true;
          pull();
          return () => { alive = false; clearTimeout(timer); };
        },
        subscribe(fn) {
          subs.add(fn);
          fn(snap);
          return () => subs.delete(fn);
        },
      };
    }

    const desk = createDesk();

    function useDesk() {
      const [s, set] = React.useState(desk.get());
      React.useEffect(() => {
        const off = desk.subscribe(set);
        const stop = desk.start();
        return () => { off(); stop(); };
      }, []);
      return s;
    }
    //#endregion

    //#region 取数工具
    let T = (k) => k;

    const nOr = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    /** 涨跌方向 -> class。0 与 null 都是「平」，不要把没有数据画成涨 */
    function dir(v) {
      const n = nOr(v);
      if (n === null || n === 0) return "skd-flat";
      return n > 0 ? "skd-up" : "skd-down";
    }

    /**
     * 涨跌方向，专供 DOM 属性（`data-d`）使用。
     *
     * 为什么不复用 dir()：那个返回的是 CSS 类名 `skd-up`/`skd-down`。
     * 把它塞进属性会得到 `data-d="skd-up"`，与 `[data-d="up"]` 永远匹配不上，
     * 而且是静默失效 —— 格子一格底色都没有，浅色主题下就是一片白，
     * 看起来像「按钮被点白了」，实际是颜色从来没生效过。踩过一次，故单列一个函数。
     */
    function dirKey(v) {
      const n = nOr(v);
      if (n === null || n === 0) return "flat";
      return n > 0 ? "up" : "down";
    }
    /**
     * 盈亏金额。
     *
     * 不用 cashText：那个会把 12800 显示成「1 万」，盈亏要精确到元；
     * 而且盈亏必须带正负号，不然「赚 800」和「亏 800」看起来一样。
     */
    /**
     * 词条里的 {n} 占位替换。
     *
     * ctx.locale 没有插值能力，硬拼字符串又会让中英文语序绑死在代码里，
     * 所以保留 {n} 占位、在这里补一个最小的替换。
     */
    function fill(text, n) {
      return String(text ?? "").replace("{n}", String(n));
    }

    function money(v) {
      const n = nOr(v);
      if (n === null) return "—";
      const abs = Math.abs(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return (n > 0 ? "+" : n < 0 ? "-" : "") + abs;
    }

    /** 金额（元）→ 中文单位。全市场成交额动辄上万亿，直接显示数字没人读得下去 */
    function cashText(v) {
      const n = nOr(v);
      if (n === null || n <= 0) return "—";
      if (n >= 1e12) return `${(n / 1e12).toFixed(2)} 万亿`;
      if (n >= 1e8) return `${(n / 1e8).toFixed(0)} 亿`;
      if (n >= 1e4) return `${(n / 1e4).toFixed(0)} 万`;
      return String(Math.round(n));
    }

    function pct(v, digits = 2) {
      const n = nOr(v);
      if (n === null) return "—";
      return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
    }
    function num(v, digits = 2) {
      const n = nOr(v);
      return n === null ? "—" : n.toFixed(digits);
    }
    function yi(v) {
      const n = nOr(v);
      if (n === null) return "—";
      if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(2)} 万亿`;
      return `${n.toFixed(2)} 亿`;
    }
    function hand(v) {
      const n = nOr(v);
      if (n === null) return "—";
      if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(2)} 万手`;
      return `${n.toFixed(0)} 手`;
    }

    /**
     * 字段 -> 单位。
     *
     * 为什么单位要跟着字段名走而不是跟着调用点走：单位写错不抛任何错，只会安静地差几个数量级。
     * 腾讯的成交额是万元、市值是亿元，两个字段在同一个表里挨着显示 ——
     * 用同一个函数格式化，必有一个错 10000 倍（本插件第一版就把茅台成交额写成了「45.00 万亿」）。
     */
    const F_UNIT = {
      amount: "wanYi",
      totalCap: "yi",
      floatCap: "yi",
      volume: "hand",
      outer: "hand",
      inner: "hand",
      orderDiff: "hand",
      turnover: "pct",
      amplitude: "pct",
      changePct: "pct",
    };

    /** 价格类字段：ETF 三位小数，其余两位 */
    const PRICE_KEYS = new Set(["price", "prevClose", "open", "high", "low", "avgPrice", "limitUp", "limitDown"]);

    /**
     * 按字段单位渲染一个值。
     *
     * @param {string} key 字段名
     * @param {*} v 原始值
     * @param {object} q 所属报价（只用它的 kind 决定小数位）
     * @returns {string|null} 渲染结果；字段不存在时返回 null，调用方据此整行跳过而不是显示 0
     */
    function fieldText(key, v, q) {
      const n = nOr(v);
      if (n === null) return null;
      switch (F_UNIT[key]) {
        case "wanYi": return yi(n / 10000);
        case "yi": return yi(n);
        case "hand": return hand(n);
        case "pct": return pct(n);
        default: return num(n, PRICE_KEYS.has(key) && q?.kind === "ETF" ? 3 : 2);
      }
    }
    function hhmmss(ms) {
      const n = nOr(ms);
      if (n === null || n === 0) return "—";
      const d = new Date(n + 8 * 3600 * 1000);
      const p = (x) => String(x).padStart(2, "0");
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    }
    const SESSION_LABEL = { trading: "trading", closed: "closed", break: "breakTime", pre_open: "preOpen" };
    //#endregion

    //#region 组件
    function Card({ title, extra, children }) {
      return h("section", { className: "skd-card" },
        h("header", { className: "skd-card-h" }, h("span", null, title), extra ?? null),
        h("div", { className: "skd-card-b" }, children));
    }

    function Msg({ text, err, hint }) {
      return h("div", { className: `skd-msg${err ? " skd-err" : ""}`, title: hint ?? "" }, text);
    }

    function SourceBar({ sources }) {
      const list = Array.isArray(sources) ? sources : [];
      if (list.length === 0) return null;
      return h("div", { className: "skd-src" },
        h("span", null, `${T("sources")}:`),
        ...list.map((s) => h("span", { key: s.name, className: "skd-src-i", title: s.lastError ?? "" },
          h("i", {
            className: "skd-dot",
            "data-bad": s.healthy ? "0" : "1",
            "data-warn": !s.healthy && (s.retryInMs ?? 0) > 0 ? "1" : "0",
          }),
          `${s.name}${s.healthy ? "" : `（${T("unavailable")}）`}`)));
    }

    /**
     * 取一条报价的数值段。
     *
     * 宿主把报价拆成两层：外层是身份（code / name / kind / kindFlag / currency / time），
     * 数值全在 `fields` 里。而且内层字段随品种变 —— 指数的 fields 里根本没有
     * turnover / pe / pb / limitUp / limitDown / orderDiff，指数也没有 ladder 与 limit。
     * 所以统一从这里进，组件里不要去摸 `q.price`，否则价格会整列渲染成 `—`。
     */
    const F = (q) => q?.fields ?? {};

    /**
     * 指数条。
     *
     * 为什么保持纯函数不自己管状态：它被自检直接当函数调用（strings(IndexStrip(...))），
     * 一旦引入 useState 就没法这么测了。展开哪一只由 DeskPage 管，这里只负责画按钮和回调。
     *
     * 点一下指数就能看它的 K 线 —— 和自选股、板块成分股、涨停名单里的股票是同一条路径
     * （都走 /quote → QuoteDetail → Kline）。实测 sh000001 / sz399006 / sh000688
     * 的 K 线与分时都能取到。
     */
    function IndexStrip({ catalog, quotes, onPick, active }) {
      const byCode = new Map((quotes ?? []).map((q) => [q.code, q]));
      const rows = (catalog ?? []).map((c) => c);
      if (rows.length === 0) return h(Msg, { text: T("loading") });
      return h("div", { className: "skd-idx" }, ...rows.map((c) => {
        const q = byCode.get(c.code);
        const f = F(q);
        return h("button", {
          className: "skd-idx-i", key: c.code, type: "button",
          "data-active": active === c.code ? "1" : "0",
          title: `${c.name} ${c.code} · ${T("peekHint")}`,
          onClick: () => onPick?.(active === c.code ? null : c.code),
        },
          h("div", { className: "skd-idx-n" }, h("span", null, c.name), h("span", { className: "skd-code" }, c.code)),
          h("div", { className: `skd-idx-v skd-num ${dir(f.changePct)}` }, q ? num(f.price) : "—"),
          h("div", { className: `skd-idx-s skd-num ${dir(f.changePct)}` },
            q ? `${f.change > 0 ? "+" : ""}${num(f.change)}  ${pct(f.changePct)}` : T("unavailable")));
      }));
    }

    /**
     * 涨跌家数 + 全市场成交额。
     *
     * 为什么重写：原来三段（细条 / 带百分比的图例 / 备注），图例在窄卡片里会换行，
     * 整块占的竖向空间比旁边那张涨停卡还多（用户反馈「占地太多」）。
     * 现在压成两段：一条细条 + 一行文字，百分比去掉（条本身已经表达了比例），
     * 空字符串的备注也不再占一行。
     *
     * 成交额与涨跌家数来自同一次全市场扫描，所以两个数字必然是同一时点，
     * 不会出现「家数是 10:00 的、成交额是 10:03 的」。
     */
    function BreadthBar({ breadth }) {
      if (!breadth) return h(Msg, { text: `${T("breadth")}：${T("unavailable")}` });
      const u = nOr(breadth.up) ?? 0;
      const d = nOr(breadth.down) ?? 0;
      const f = nOr(breadth.flat) ?? 0;
      const tot = u + d + f || 1;
      const w = (x) => `${(x / tot) * 100}%`;
      return h("div", { className: "skd-breadth" },
        h("div", { className: "skd-bar skd-bar-slim" },
          h("div", { className: "skd-bar-u", style: { width: w(u) } }),
          h("div", { className: "skd-bar-f", style: { width: w(f) } }),
          h("div", { className: "skd-bar-d", style: { width: w(d) } })),
        h("div", { className: "skd-brow" },
          h("span", { className: "skd-num skd-brow-h" },
            h("b", { className: "skd-up" }, String(u)), ` ${T("up")}  `,
            h("b", { className: "skd-flat" }, String(f)), ` ${T("flat")}  `,
            h("b", { className: "skd-down" }, String(d)), ` ${T("down")}`,
            h(Hint, { text: T("hintBreadth") })),
          h("span", { className: "skd-num skd-bamt" },
            T("marketAmount"), " ",
            h("b", null, cashText(breadth.amount)),
            h(Hint, { text: T("hintAmount") }))));
    }

    /**
     * 涨停与连板梯队。
     *
     * 真实形状（lib/ths.js 的 fetchOverview / fetchLadder）：overview.limitUp.today 才是当日家数，
     * yesterday 是昨日对照；ladder 是高度 ≥2 的数组。首板接口不给，只能「涨停总数 − 连板总数」推，
     * 所以那一行标注「推算」，免得被当成接口原值引用。
     *
     * 梯队里的股票名做成可点的（用户问「这些不能点击吗」）：点一下打开个股详情。
     * 它们本来就带 code，接上 onPick 即可 —— 之前只是当纯文本画出来，白白浪费了。
     */
    /**
     * 点一只股票，就地展开明细与 K 线。
     *
     * 为什么不复用整页的 pickAny：pickAny 把选中状态写到自选那张卡的详情面板里，
     * 而那个面板在页面最下方 —— 在下钻名单里点一下，视口里什么都不动，
     * 用户会以为「点了没反应」（反馈里就是问「能不能点击进去看到 K 线图」）。
     * 所以这里自带一份状态：点谁就在谁下面展开，复用同一个 QuoteDetail。
     */
    function StockPeek({ code, onClose }) {
      const [st, setSt] = React.useState({ phase: "loading", q: null, error: null });
      React.useEffect(() => {
        let alive = true;
        setSt({ phase: "loading", q: null, error: null });
        api(`/quote?codes=${encodeURIComponent(code)}`)
          .then((r) => { if (alive) setSt({ phase: "ready", q: (r?.items ?? [])[0] ?? null, error: null }); })
          .catch((e) => { if (alive) setSt({ phase: "failed", q: null, error: String(e?.message ?? e) }); });
        return () => { alive = false; };
      }, [code]);
      if (st.error) return h(Msg, { text: st.error, hint: T("unavailableHint") });
      // 这两个状态必须分开：以前都写成 !st.q，于是「接口返回空」（比如北交所代码腾讯不认）
      // 会被当成「还在加载」，永远停在「正在取数…」。用户报的就是这个。
      if (st.phase === "loading") return h(Msg, { text: T("loading") });
      if (!st.q) return h(Msg, { text: T("quoteMissing") });
      return h(QuoteDetail, { q: st.q, onClose });
    }

    /**
     * 左列表 / 右详情。
     *
     * 为什么需要：详情原来渲染在列表**下方**，点一只股票之后必须往下滚才能看到 K 线，
     * 看完再滚回来点下一只 —— 用户反馈「使用上还得滑动有点累」。
     * 改成左右分栏后列表与详情同时可见，右侧还能 sticky 跟随滚动。
     *
     * 没有 detail 时不改变原有布局：列表独占整行，不会凭空留出一条空白列。
     * 窄屏（<720px）退回上下堆叠 —— 硬并排会把两边都挤成一条缝。
     */
    function splitView(detail, children) {
      // 刻意写成普通函数而不是 React 组件：自检的 walk 只遍历 children、不展开子组件，
      // 一旦包成组件，.skd-split 就不会出现在被测树里，「到底有没有分栏」也就验不到。
      // 它不持有任何状态，直接返回元素反而更简单。
      //
      // children 必须展开（...）而不是整个数组当一格塞进去：React 会自己拍平，
      // 但自检的 walk 不会往数组里钻 —— 整块内容会从被测树里消失，
      // 表现为「一页渲染 0 只」，而界面上其实是好的。
      const list = Array.isArray(children) ? children : [children];
      if (!detail) return h(React.Fragment, null, ...list);
      return h("div", { className: "skd-split" },
        h("div", { className: "skd-split-main" }, ...list),
        h("div", { className: "skd-split-side" }, detail));
    }

    /**
     * 术语后面的小问号。
     *
     * 为什么需要：用户问「炸板是什么意思」，说明这些行话对他不是默认知识。
     * 说明文字挂在 title 上，鼠标一停就能看，不占版面，也不用点开。
     * 用 span 而不是 button：它不长在 Tab 序里，只是提示，
     * 键盘用户读 aria-label 就够了。
     */
    /**
     * 持仓卡右上角：刷新间隔 + 是否已开启电脑通知。
     *
     * 编辑 / 保存 / 取消不在这里 —— 已经下放到自选表的每个行尾。
     * 一次只编一只股票时，把那三个按钮留在卡片头上，会让人以为「保存」保存的是整张表。
     */
    function MonitorBar({ pollSec, onPoll, notify, onEnableNotify }) {
      // 返回 Fragment，不再自己套一层 .skd-tools。
      // 外面那一层已经是 flex 容器，这里再包一层会让「刷新间隔 / 通知」成为整体、
      // 一换行就双双挪到下一行，把卡头里的倒计时单独留在上一行。
      return h(React.Fragment, null,
        h("label", { className: "skd-meta", title: T("hintPoll") },
          T("pollSec"),
          h("select", {
            className: "skd-select", style: { marginLeft: "5px" },
            value: String(pollSec), onChange: (e) => onPoll(Number(e.target.value)),
          }, ...[3, 5, 10, 15, 30, 60].map((n) => h("option", { key: n, value: String(n) }, `${n} ${T("seconds")}`)))),
        notify === "granted"
          ? h("span", { className: "skd-meta" }, T("notifyOn"))
          : h("button", {
            className: "skd-btn", "data-xs": "1", type: "button",
            disabled: notify === "unsupported" || notify === "denied",
            title: notify === "denied" ? T("notifyDenied") : notify === "unsupported" ? T("notifyUnsupported") : "",
            onClick: onEnableNotify,
          }, notify === "denied" ? T("notifyDenied") : notify === "unsupported" ? T("notifyUnsupported") : T("enableNotify")));
    }

    /**
     * 刷新指示器：倒计时 + 上次取数时间。
     *
     * 用户的原话是「要不然我都不知道刷新没有」。纯静态页面看不出是不是活的，
     * 所以给一个每秒在动的数字 —— 数字在减说明定时器活着，
     * 右边的时间在跳说明真的取到了新数据。
     */
    function RefreshMeter({ remainSec, updatedAt }) {
      const waiting = remainSec !== null && remainSec >= 0;
      return h("span", { className: "skd-meter", title: T("hintMeter") },
        h("span", { className: "skd-dot", "data-wait": waiting ? "1" : "0" }),
        T("nextRefresh"),
        h("b", null, remainSec === null ? "—" : `${remainSec}s`),
        updatedAt ? h("span", { className: "skd-meter-at" }, ` · ${updatedAt}`) : null);
    }

    function Hint({ text }) {
      if (!text) return null;
      return h("span", {
        className: "skd-hint", title: text, "aria-label": text, role: "note",
      }, "?");
    }

    /** 板块标记。创业板要跳出来 —— 用户买不了它 */
    function BoardTag({ board }) {
      if (!board) return null;
      return h("span", { className: "skd-mkt", "data-mkt": board }, board);
    }

    /**
     * 涨停 / 炸板 / 跌停 / 连板梯队 —— 全部做成可点的格子。
     *
     * 为什么改成格子并加下钻：原来这四样只是四行数字，用户看到「涨停 46 家」之后
     * 必然想「哪 46 家」。数得出来却点不进去，等于只给了一半。
     *
     * 为什么每个格子的数字必须来自它自己的列表来源：
     * 涨停/炸板取同花顺 overview（它的池子条数就是这两个数），
     * 跌停取本地全市场扫描（同花顺没有跌停池接口，试了 13 个路径名全 404）。
     * 混着取会出现「格子写 22 家、点进去 27 条」——看起来就像插件算错了。
     *
     * 首板不给下钻：它是「涨停总数 - 连板总数」的推算值，本身没有一份对应名单。
     */
    function LimitGrid({ overview, ladder, pools, onPick }) {
      const [drill, setDrill] = React.useState(null);
      const [st, setSt] = React.useState({ phase: "idle", data: null, error: null });
      // 点开的股票代码：点谁就在明细表下面展开谁的 K 线
      const [peek, setPeek] = React.useState(null);
      // 明细表的页码。三个池与连板梯队都是先整份取回来再前端切页 ——
      // 它们最多几百条，一次取完比每翻一页打一次接口省事也更快。
      const [lp, setLp] = React.useState(0);
      // 点「重试」时自增，靠它把取数 effect 重新跑一遍
      const [tries, setTries] = React.useState(0);

      const lu = overview?.limitUp?.today;
      const rows = Array.isArray(ladder) ? ladder : [];
      // 池子类型；连板高度的下钻不需要取数（ladder 里已经有名单）
      const poolKind = drill && drill.kind !== "ladder" ? drill.kind : null;

      React.useEffect(() => {
        if (!poolKind) { setSt({ phase: "idle", data: null, error: null }); return undefined; }
        let alive = true;
        setSt({ phase: "loading", data: null, error: null });
        api(`/pool?type=${poolKind}&limit=300`)
          .then((d) => { if (alive) setSt({ phase: "ready", data: d, error: null }); })
          .catch((e) => { if (alive) setSt({ phase: "failed", data: null, error: String(e?.message ?? e) }); });
        return () => { alive = false; };
      }, [poolKind, tries]);

      // 所有 hook 必须在第一个 return 之前
      if (!lu) return h(Msg, { text: `${T("limitUp")}：${T("unavailable")}`, hint: T("unavailableHint") });

      const cont = rows.reduce((a, r) => a + (nOr(r.number) ?? 0), 0);
      const first = Math.max(0, (nOr(lu.num) ?? 0) - cont);
      // 跌停只认本地扫描的家数：它才是「点进去那些行」的条数
      const ldCount = nOr(pools?.limitDown);

      // 换池子 / 换板高时回到第 1 页，否则会拿着上一批的页码去切新名单
      React.useEffect(() => { setLp(0); }, [poolKind, drill?.height]);

      const toggle = (next) => {
        // 换池子/换板高时把展开的个股一并收起，否则会继续展示上一个池子里的那只票
        setPeek(null);
        setDrill((cur) => (cur && cur.key === next.key ? null : next));
      };

      /**
       * 三个池格子的统一样式。
       *
       * 方向必须由格子语义显式给定，不能从数量推 —— 曾经写成 dirKey(count)，
       * 结果「跌停 27 家」因为 27 > 0 被判成「涨」涂成红色（用户当场看出来了）。
       * 数量是正数不代表行情是涨的，这两件事没有关系。
       *
       * @param {string} tone up=涨停（红）| warn=炸板（警示色）| down=跌停（绿）
       */
      const poolTile = (key, label, count, sub, kind, tone, hint) => h("button", {
        key, className: "skd-bcell skd-lcell", type: "button",
        "data-d": tone,
        "data-active": drill?.key === key ? "1" : "0",
        disabled: nOr(count) === null,
        // 按钮自己的 title 只说「能点」；术语解释挂在问号上，两者不抢
        title: T("drillHint"),
        onClick: () => toggle({ key, kind, label }),
      },
        h("span", { className: "skd-bcell-n" }, label, h(Hint, { text: hint })),
        h("span", { className: "skd-bcell-v" }, nOr(count) === null ? "—" : `${count} 家`),
        h("span", { className: "skd-bcell-s" }, sub));

      /** 连板高度的格子：点下去看这一高度里的个股 */
      const ladderTile = (r) => h("button", {
        key: `h${r.height}`, className: "skd-bcell skd-lcell", type: "button",
        "data-d": "up",
        "data-active": drill?.key === `h${r.height}` ? "1" : "0",
        title: T("drillHint"),
        onClick: () => toggle({ key: `h${r.height}`, kind: "ladder", height: r.height, label: `${r.height} ${T("height")}` }),
      },
        h("span", { className: "skd-bcell-n" }, `${r.height} ${T("height")}`, h(Hint, { text: T("hintLadder") })),
        h("span", { className: "skd-bcell-v" }, `${r.number ?? "—"} 家`),
        h("span", { className: "skd-bcell-s" }, (r.stocks ?? []).slice(0, 3).map((s) => s.name).join(" ")));

      // 下钻明细：连板走内存里的 ladder，三个池走 /pool
      const ladderStocks = drill?.kind === "ladder"
        ? (rows.find((r) => r.height === drill.height)?.stocks ?? [])
        : null;
      const listRows = ladderStocks ?? (Array.isArray(st.data?.items) ? st.data.items : []);
      // 每页 10 条（与 BoardDrill 的 SIZE 保持一致）
      const PAGE = 10;
      const pageCount = Math.max(1, Math.ceil(listRows.length / PAGE));
      const safeLp = Math.min(lp, pageCount - 1);
      const pageRows = listRows.slice(safeLp * PAGE, safeLp * PAGE + PAGE);

      return h("div", null,
        h("div", { className: "skd-bgrid" },
          poolTile("limitup", T("limitUp"), nOr(lu.num), nOr(lu.rate) === null ? "" : `封板率 ${num(lu.rate * 100)}%`, "limitup", "up", T("hintLimitUp")),
          poolTile("broke", T("burst"), nOr(lu.openNum), `历史 ${lu.historyNum ?? "—"}`, "broke", "warn", T("hintBroke")),
          poolTile("limitdown", T("limitDown"), ldCount,
            nOr(pools?.limitDown) === null ? T("unavailable") : T("localScan"), "limitdown", "down", T("hintLimitDown")),
          // 首板也能下钻：名单 = 涨停池 − 连板梯队（宿主 /pool?type=firstboard 算好）
          poolTile("firstboard", T("firstBoard"), first, T("estimated"), "firstboard", "flat", T("hintFirstBoard")),
          ...rows.map(ladderTile)),

        drill
          ? h("div", { className: "skd-bdrill" },
            h("div", { className: "skd-bdrill-hd" },
              h("span", { className: "skd-bdrill-t" }, `${drill.label} · ${listRows.length} 家`),
              h("span", { className: "skd-meta" }, st.phase === "loading" ? T("loading")
                : st.data?.source ? st.data.source : ""),
              h("button", { className: "skd-btn", "data-xs": "1", type: "button",
                onClick: () => setDrill(null) }, T("close"))),

            st.error
              ? h("div", { className: "skd-drill-err" },
                h(Msg, { text: st.error, hint: T("unavailableHint") }),
                h("button", {
                  className: "skd-btn", "data-xs": "1", type: "button",
                  onClick: () => setTries((n) => n + 1),
                }, T("retry")))
              : null,
            // 左栏名单、右栏明细与 K 线。以前详情在下方，看完还得滚回去点下一只
            h("div", { className: "skd-drill-body" },
              splitView(peek ? h(StockPeek, { code: peek, onClose: () => setPeek(null) }) : null, [
            listRows.length > 0
              ? h("table", { className: "skd-tbl skd-btbl" },
                // 列只留三样：名称（带上市板块）、现价、涨跌幅。
                // 原来那列「连板」用户明确说不需要 —— 涨停的票本来就都是板，
                // 他要看的是幅度和价格。连板高度挪到名称的 title 里还留着。
                h("thead", null, h("tr", null,
                  // 表头是「名称」不是「自选」：这一列列的是涨停/成分股名单，
                  // 与自选表复用同一个词条会让读者以为这里也是自选股（曾如此）。
                  h("th", null, T("stock")),
                  h("th", null, T("price")),
                  h("th", null, T("pct")))),
                h("tbody", null, ...pageRows.map((r) => h("tr", { key: r.code },
                  h("td", null, h("button", {
                    className: "skd-name skd-name-btn", type: "button",
                    title: [
                      r.name,
                      r.code,
                      r.board,
                      nOr(r.continueNum) === null ? "" : `${r.continueNum} 板`,
                      r.reason ?? "",
                    ].filter(Boolean).join(" · "),
                    onClick: () => { setPeek((cur) => (cur === r.code ? null : r.code)); onPick?.(r.code); },
                  },
                    h("span", null, r.name || r.code),
                    h(BoardTag, { board: r.board }),
                    h("span", { className: "skd-code" }, r.code))),
                  h("td", { className: `skd-num ${dir(r.changePct)}` },
                    nOr(r.price) === null ? "—" : num(r.price)),
                  h("td", { className: `skd-num ${dir(r.changePct)}` },
                    nOr(r.changePct) === null ? "—" : pct(r.changePct))))))
              : null,

            // 分页：10 条一页。只在一页装不下时出现，不占无谓的版面
            listRows.length > PAGE
              ? h("div", { className: "skd-pager" },
                h("button", {
                  className: "skd-btn", "data-xs": "1", type: "button",
                  disabled: safeLp <= 0, onClick: () => setLp((p) => Math.max(0, p - 1)),
                }, T("pagePrev")),
                h("span", { className: "skd-meta" }, `${safeLp + 1} / ${pageCount} ${T("pages")}`),
                h("button", {
                  className: "skd-btn", "data-xs": "1", type: "button",
                  disabled: safeLp + 1 >= pageCount, onClick: () => setLp((p) => p + 1),
                }, T("pageNext")))
              : null,

            listRows.length === 0 && st.phase !== "loading" && !st.error
              ? h(Msg, { text: T("empty") }) : null])))
          : null);
    }

    /**
     * 板块格子。
     *
     * 为什么从列表改成格子：列表一行一个板块，一屏放不下几个，且「哪个最狠」
     * 要靠读数字比大小。格子把每个板块做成一块可点的方块，颜色直接编码强弱，
     * 一眼就能扫出头部；点进去就是该板块的成分股。
     *
     * 只有两个维度：涨最狠、跌最狠，都来自同花顺行业板块榜的两端。
     * 原本还有第三个「涨停最多」，已经删掉 —— 它和上面涨停那张卡讲的是同一批股票
     * （都是今天涨停的板块），两个入口只会让人以为是两回事。
     *
     * 概念板块没有可用的涨跌幅数据源（同花顺概念列表页不提供涨跌幅），
     * 所以这里只有行业 —— 这一点写进 title 提示，不假装覆盖了全部板块。
     */
    function BoardGrid({ rank, onPick }) {
      const [dim, setDim] = React.useState("up");
      const [drill, setDrill] = React.useState(null);

      const dims = [
        { id: "up", label: T("boardUp"), hint: T("hintBoardUp"), items: Array.isArray(rank?.up) ? rank.up : [] },
        { id: "down", label: T("boardDown"), hint: T("hintBoardDown"), items: Array.isArray(rank?.down) ? rank.down : [] },
      ];
      const cur = dims.find((d) => d.id === dim) ?? dims[0];

      // 两个维度都拿不到才算整块不可用；只挂一个就只少那一个 tab
      if (dims.every((d) => d.items.length === 0)) {
        return h(Msg, { text: `${T("sectors")}：${T("unavailable")}`, hint: T("unavailableHint") });
      }

      const closeDrill = () => setDrill(null);

      return h("div", null,
        h("div", { className: "skd-btabs" },
          ...dims.map((d) => h("button", {
            key: d.id, className: "skd-btab", type: "button",
            "data-on": d.id === dim ? "1" : "0",
            disabled: d.items.length === 0,
            onClick: () => { setDim(d.id); closeDrill(); },
          }, d.label, h("span", { className: "skd-btab-n" }, String(d.items.length)), h(Hint, { text: d.hint }))),
          h("span", { className: "skd-meta skd-bhint" }, T("drillHint"))),

        h("div", { className: "skd-bgrid" },
          ...cur.items.map((x) => {
            // 板块代码来自同花顺行业板块榜，成分股页认的就是这同一套 881xxx，
            // 所以永远能下钻；drillTarget 保留判空只为以后换源时不至于点出空面板
            const drillTarget = x.code ? { code: x.code, kind: "thshy", name: x.name } : null;
            const active = drill && drillTarget && drill.code === drillTarget.code;
            return h("button", {
              key: `i${x.code}`,
              className: "skd-bcell", type: "button",
              // 必须用 dirKey（给属性）而不是 dir（给 class），否则 data-d 拿到的是类名，
              // 所有 [data-d="..."] 规则全部静默失效
              "data-d": dirKey(x.changePct),
              "data-active": active ? "1" : "0",
              disabled: !drillTarget,
              title: drillTarget
                ? `${x.name} · ${pct(x.changePct)} · ${T("drillHint")}`
                : `${x.name} · ${T("boardNoDrill")}`,
              onClick: () => setDrill(active ? null : drillTarget),
            },
              h("span", { className: "skd-bcell-n" }, x.name),
              h("span", { className: "skd-bcell-v" }, pct(x.changePct)),
              h("span", { className: "skd-bcell-s" },
                `${T("upDown")} ${nOr(x.upCount) ?? "—"}/${nOr(x.downCount) ?? "—"} · ${T("leader")} ${x.leader?.name || "—"}`));
          })),

        drill
          ? h(BoardDrill, { drill, onPick, onClose: closeDrill })
          : null);
    }

    /**
     * 板块下钻：该板块的成分股，按涨跌幅降序，每页 20 只。
     *
     * 为什么页码用 offset 而不是服务端页码：概念板块服务端 10 只/页、行业 20 只/页，
     * 两种页宽不一样。这里对外统一 20 只/页，换算在宿主 market.boardStocks 里做掉，
     * 前端只按 (offset, size) 说话。
     */
    function BoardDrill({ drill, onPick, onClose }) {
      // 每页 10 条。服务端那套「概念 10 只/页、行业 20 只/页」的页宽在宿主里换算掉，
      // 这里只按 10 说话 —— 用户要求所有下钻明细统一 10 条一页。
      const SIZE = 10;
      const [page, setPage] = React.useState(0);
      const [st, setSt] = React.useState({ phase: "loading", data: null, error: null });
      // 点开的股票代码：点谁就在表格下面展开谁的 K 线，不必跑到页面底部的自选详情
      const [peek, setPeek] = React.useState(null);
      // 点「重试」时自增，靠它把取数 effect 重新跑一遍
      const [tries, setTries] = React.useState(0);

      // 换板块必须回到第 1 页，否则会拿上一个板块的页码去请求新板块
      React.useEffect(() => { setPage(0); setPeek(null); }, [drill.code, drill.kind]);

      React.useEffect(() => {
        let alive = true;
        setSt((p) => ({ phase: "loading", data: p.data, error: null }));
        api(`/board?code=${encodeURIComponent(drill.code)}&kind=${encodeURIComponent(drill.kind)}&offset=${page * SIZE}&size=${SIZE}`)
          .then((data) => { if (alive) setSt({ phase: "ready", data, error: null }); })
          .catch((err) => { if (alive) setSt({ phase: "failed", data: null, error: String(err?.message ?? err) }); });
        return () => { alive = false; };
      }, [drill.code, drill.kind, page, tries]);

      const d = st.data;
      const totalPages = Math.max(1, d?.totalPages ?? 1);
      const rows = Array.isArray(d?.items) ? d.items : [];

      return h("div", { className: "skd-bdrill" },
        h("div", { className: "skd-bdrill-hd" },
          h("span", { className: "skd-bdrill-t" }, `${drill.name} · ${T("constituents")}`),
          // 翻不到更多时把原因写在这里，而不是让用户一直点「下一页」点出一片空白
          h("span", { className: "skd-meta" }, st.phase === "loading"
            ? T("loading")
            : d?.truncated ? T("freeLimit") : ``),
          h("button", { className: "skd-btn", "data-xs": "1", type: "button", onClick: onClose }, T("close"))),

        st.error
          ? h("div", { className: "skd-drill-err" },
            h(Msg, { text: st.error, hint: T("unavailableHint") }),
            h("button", {
              className: "skd-btn", "data-xs": "1", type: "button",
              onClick: () => setTries((n) => n + 1),
            }, T("retry")))
          : null,

        // 左栏是名单与分页，右栏是点开那只股票的明细与 K 线。
        // 以前详情在下方，看完 K 线还得滚回去点下一只。
        h("div", { className: "skd-drill-body" },
          splitView(peek ? h(StockPeek, { code: peek, onClose: () => setPeek(null) }) : null, [
            rows.length === 0 && !st.error
              ? h(Msg, { text: st.phase === "loading" ? T("loading") : T("empty") })
              : null,

            rows.length > 0
              ? h("table", { className: "skd-tbl skd-btbl" },
                h("thead", null, h("tr", null,
                  // 表头是「名称」不是「自选」：这一列列的是涨停/成分股名单，
                  // 与自选表复用同一个词条会让读者以为这里也是自选股（曾如此）。
                  h("th", null, T("stock")),
                  h("th", null, T("price")),
                  h("th", null, T("pct")))),
                h("tbody", null, ...rows.map((r) => h("tr", { key: r.code },
                  h("td", null, h("button", {
                    className: "skd-name skd-name-btn", type: "button",
                    title: [r.name, r.code, r.board].filter(Boolean).join(" · "),
                    onClick: () => { setPeek((cur) => (cur === r.code ? null : r.code)); onPick?.(r.code); },
                  },
                    h("span", null, r.name || r.code),
                    h(BoardTag, { board: r.board }),
                    h("span", { className: "skd-code" }, r.code))),
                  h("td", { className: `skd-num ${dir(r.changePct)}` }, nOr(r.price) === null ? "—" : num(r.price)),
                  h("td", { className: `skd-num ${dir(r.changePct)}` }, pct(r.changePct))))))
              : null,

            h("div", { className: "skd-pager" },
              h("button", {
                className: "skd-btn", "data-xs": "1", type: "button",
                disabled: page <= 0, onClick: () => setPage((p) => Math.max(0, p - 1)),
              }, T("prevPage")),
              h("span", { className: "skd-meta" }, `${page + 1} / ${totalPages} ${T("pages")}`),
              h("button", {
                className: "skd-btn", "data-xs": "1", type: "button",
                disabled: page + 1 >= totalPages, onClick: () => setPage((p) => p + 1),
              }, T("nextPage")))])));
    }

    /**
     * 北京时区的今天，形如 2026-10-20。
     *
     * 为什么固定用北京时区：用户机器的时区可能不是东八区，
     * 一旦用本地时区判断「今天」，行情日期与本地日期会错位，今日盈亏就清不准。
     */
    function todayKey() {
      try {
        // en-CA 恰好输出 YYYY-MM-DD
        return new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date());
      } catch {
        return new Date().toISOString().slice(0, 10);
      }
    }

    /**
     * 从行情的 time 字段取出它属于哪一天。
     *
     * 腾讯给的是 20261019161439 这种紧凑格式；取前 8 位就是日期。
     * 取不到就返回 null —— 那种情况下不做「是不是旧数据」的判断，保持原行为。
     */
    function quoteDate(f) {
      const t = f?.time;
      if (typeof t !== "string" || t.length < 8 || !/^[0-9]{8}/.test(t)) return null;
      return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
    }

    /**
     * 距离下一次自动刷新还有几秒。
     *
     * 纯函数，方便测边界（刚取完数据 / 已经超时 / 从没取过）。
     *
     * @param {number} lastAt 这批数据到达的本地时间戳，0 表示还没取过
     * @param {number|string} pollSec 刷新间隔（秒）
     * @param {number} nowMs 当前时间戳
     * @returns {number|null} 剩余秒数；从没取过数据时返回 null
     */
    function nextRefreshSec(lastAt, pollSec, nowMs) {
      if (!lastAt) return null;
      const sec = Number(pollSec);
      const ms = (Number.isFinite(sec) && sec > 0 ? sec : 10) * 1000;
      // 超时了也返回 0 而不是负数：界面上出现「-3s」会让人以为坏了
      return Math.max(0, Math.ceil((ms - (nowMs - lastAt)) / 1000));
    }

    /** 把 ISO 时间格式成 09:09:31，用于显示「上次取数时间」 */
    function clockText(at) {
      if (!at) return "";
      const d = new Date(at);
      if (Number.isNaN(d.getTime())) return "";
      try {
        return new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        }).format(d);
      } catch {
        return d.toTimeString().slice(0, 8);
      }
    }

    /**
     * 就地编辑草稿：把某一格的新值合并进 positions / alerts。
     *
     * 抽成纯函数而不是写在 onCange 闭包里：它曾经埋在 DeskPage 里，
     * 于是「勾选框传布尔值 → 被当成非法数字 → 立刻删掉」这个 bug 测不到，
     * 只能靠用户点一遍才发现。
     *
     * @param {{positions?: object, alerts?: object}} draft 当前草稿
     * @param {"pos"|"alert"} kind 改的是持仓还是监控
     * @param {string} code 代码
     * @param {string} field 字段名
     * @param {string|boolean} raw 新值。勾选框给布尔，输入框给字符串
     * @returns {object} 新的草稿
     */
    function applyDraftEdit(draft, kind, code, field, raw) {
      if (!draft) return draft;
      const src = { ...(kind === "pos" ? draft.positions : draft.alerts) };
      const one = { ...(src[code] ?? {}) };
      if (typeof raw === "boolean") {
        // 布尔必须先分开处理：走 Number(String(true)) 会得到 NaN，
        // 被判成非法值后立刻删掉字段，表现是「勾永远打不上」
        if (raw) one[field] = true;
        else delete one[field];
      } else if (raw === "") {
        // 显式清空 = 删除该字段，不存 0
        delete one[field];
      } else {
        const n = Number(String(raw).trim());
        // 非法数字（比如粘贴了 "abc"）一律无视，保留已保存的值。
        // 原来是把字段删掉 —— 一次输错就把你之前填的成本抹了，太粗暴。
        if (Number.isFinite(n) && n > 0) one[field] = n;
      }
      if (Object.keys(one).length === 0) delete src[code]; else src[code] = one;
      return kind === "pos" ? { ...draft, positions: src } : { ...draft, alerts: src };
    }

    /**
     * 把「持有」标记一次性并进 positions。
     *
     * 为什么单独写一个而不是在提交时逐只调 applyDraftEdit：applyDraftEdit 收的是
     * 「某一格的新值」，而这里只可能知道「是否持有」这一件事 —— 走它的话，
     * 图片面板会顺带把用户已经填好的成本价与份额当成待改字段一起覆盖掉。
     *
     * 只加不删：没被勾的代码保持原样，`held` 已有的仍然保留。
     * 与 lib/store.js 的约定一致 —— held 只存 true，不存 false。
     *
     * @param {object} positions 现有的 positions
     * @param {string[]} codes 要标记为持有的代码
     * @returns {object} 新的 positions
     */
    function withHeld(positions, codes) {
      const src = { ...(positions ?? {}) };
      for (const code of codes ?? []) {
        if (!code) continue;
        src[code] = { ...(src[code] ?? {}), held: true };
      }
      return src;
    }

    /**
     * 进入某一行编辑时，把这行的持仓与监控拷成草稿。
     *
     * 为什么草稿只装一行：编辑入口挂在行尾，一次只编一只。整表草稿的写法下
     * 保存时必须整份提交，「保存」就天然带上了别的行 —— 编辑期间别处改过的行会被一起覆盖。
     *
     * @param {object} config 当前配置（含 positions / alerts）
     * @param {string} code 要编辑的代码
     * @returns {{positions: object, alerts: object}} 只含该代码的草稿
     */
    function rowEditDraft(config, code) {
      const p = config?.positions?.[code];
      const a = config?.alerts?.[code];
      return {
        positions: p ? { [code]: { ...p } } : {},
        alerts: a ? { [code]: { ...a } } : {},
      };
    }

    /**
     * 把逐行草稿并回整份配置，得到可以直接提交的完整对象。
     *
     * 必须显式传 code：applyDraftEdit 在该行字段被清空时会把 code 从草稿里整个删掉，
     * 于是「这一行被清空」和「这一行没动过」在草稿里长得一模一样。只有知道编的是谁，
     * 才能判断该覆盖还是该删除。
     *
     * @param {object} config 当前配置
     * @param {string} code 正在编辑的代码
     * @param {{positions?: object, alerts?: object}} draft 该行的草稿
     * @returns {{positions: object, alerts: object}} 完整配置片段，可直接交给 POST /config
     */
    function mergeEditDraft(config, code, draft) {
      const pos = { ...(config?.positions ?? {}) };
      const alerts = { ...(config?.alerts ?? {}) };
      const p = draft?.positions?.[code];
      const a = draft?.alerts?.[code];
      // 空对象等于「这行什么都不要了」—— 删掉，别留一个 {} 在配置里
      if (p && Object.keys(p).length > 0) pos[code] = p; else delete pos[code];
      if (a && Object.keys(a).length > 0) alerts[code] = a; else delete alerts[code];
      return { positions: pos, alerts };
    }

    /**
     * 自选表。持仓与价格监控**并进这张表**，不再另开一张。
     *
     * 为什么合并：成本、份额、盈亏、提醒本来就是「这一只自选股」的属性，
     * 分成两张表等于同一条信息要在两处各看一遍，还容易对不上行。
     * 用户的原话是「这应该是自选股票的一行吧」。
     *
     * 只读态的格是纯文本，编辑态的格才是输入框。
     *
     * 编辑改成**逐行**：入口挂到每个行尾，点谁编谁，保存 / 取消也只作用于这一行。
     * 原来那个按钮在卡片头上，一点就把 12 列同时变成输入框 —— 只想改一只股票，
     * 却要面对满屏输入框，别的行也没法继续看行情。
     *
     * 「持有」是纯标记列：只读时显示「持」，编辑时是勾选框。它不参与盈亏计算。
     *
     * @param {string|null} editingCode 正在编辑的行代码，null 表示整表只读
     */
    function QuoteTable({ list, watch, onRemove, onPick, config, editingCode, draft, onChange,
      onEdit, onSave, onCancel }) {
      if (!Array.isArray(list) || list.length === 0) return h(Msg, { text: T("empty") });
      // 表格渲染时取一次「今天」，整张表用同一个基准，避免逐行调用跨过零点
      const today = todayKey();
      /** 该行该读哪份数据：正在编辑的那一行读草稿，其余读已保存的配置 */
      const rowOf = (code, kind) => {
        const s = editingCode === code ? draft : config;
        return (kind === "pos" ? (s?.positions ?? {}) : (s?.alerts ?? {}))[code] ?? {};
      };
      /**
       * 「当日买入」判定。老数据是 true，新数据是日期字符串，
       * 只有等于行情所属日期才算数 —— 否则昨天勾的今天还生效。
       *
       * 勾选框的 checked 和今日盈亏的基准必须共用这一个判定：两边各写一份的话，
       * 刷新后会出现「勾是空的、盈亏却按成本算」这种自相矛盾的界面。
       */
      const isBoughtToday = (one, qd) => one?.todayBuy === true || (qd !== null && one?.todayBuy === qd);
      const cell = (code, kind, field, step) => {
        const one = rowOf(code, kind);
        return editingCode === code
          ? h("input", {
            className: "skd-input skd-num skd-hcell",
            type: "number", step, min: "0", inputMode: "decimal",
            value: one[field] ?? "",
            onChange: (e) => onChange?.(kind, code, field, e.target.value),
          })
          : h("span", { className: "skd-num skd-hval" },
            nOr(one[field]) === null ? "—" : String(nOr(one[field])));
      };

      return h("table", { className: "skd-tbl skd-htbl" },
        h("thead", null, h("tr", null,
          // 表头是「名称」不是「自选」：这一列列的是股票名字，而卡片本身已经叫自选了，
          // 再写一遍自选只是把标题重复进表头，占地方还答非所问。
          h("th", null, T("stock")),
          // 持有标记紧挨名称：它是这一行的属性，不是行情指标，别混进后面涨跌那一片
          watch ? h("th", { className: "skd-heldcol" }, T("held")) : null,
          h("th", null, T("price")),
          h("th", null, T("pct")),
          h("th", null, T("turnover")),
          h("th", null, T("amount")),
          // 以下五列只在自选表里出现（持仓 / 监控都属于自选股的属性）
          watch ? h("th", null, T("cost")) : null,
          watch ? h("th", null, T("shares")) : null,
          watch ? h("th", null, T("todayPnl")) : null,
          watch ? h("th", null, T("holdPnl")) : null,
          watch ? h("th", null, T("alertLow")) : null,
          watch ? h("th", null, T("alertHigh")) : null,
          watch ? h("th", null, "") : null)),
        h("tbody", null, ...list.map((q) => h("tr", { key: q.code },
          // 名称做成按钮而不是给整行挂 onClick：整行可点会把「点哪都能展开」这件事做进去，
          // 但键盘用户永远聚焦不到它
          h("td", null, h("button", {
            className: "skd-name skd-name-btn", type: "button",
            onClick: () => onPick?.(q.code),
          },
            h("span", null, q.name ?? q.code),
            q.kind ? h("span", { className: "skd-tag" }, q.kind) : null,
            h("span", { className: "skd-code" }, q.code),
            // 行情日期不是今天 → 明确标出来，别让昨天的涨幅冒充今天的盈亏
            (() => { const qd = quoteDate(F(q)); 
              return qd !== null && qd !== today
                ? h("span", { className: "skd-tag skd-tag-stale", title: T("hintStale") }, T("staleTag")) : null; })())),
          // 持有标记列。空着不画东西，让 td:empty::after 补「—」，
          // 免得「未持有」和「没填过」在视觉上一样。
          watch ? h("td", { key: "held", className: "skd-heldcol" },
            editingCode === q.code
              ? h("label", { className: "skd-heldedit", title: T("hintHeld") },
                h("input", {
                  type: "checkbox",
                  checked: rowOf(q.code, "pos").held === true,
                  onChange: (e) => onChange?.("pos", q.code, "held", e.target.checked),
                }))
              : (rowOf(q.code, "pos").held === true
                ? h("span", { className: "skd-tag skd-tag-held", title: T("hintHeld") }, T("heldTag"))
                : null)) : null,
          h("td", { className: `skd-num ${dir(F(q).changePct)}` }, fieldText("price", F(q).price, q)),
          h("td", { className: `skd-num ${dir(F(q).changePct)}` }, fieldText("changePct", F(q).changePct, q)),
          h("td", { className: "skd-num" }, nOr(F(q).turnover) === null ? "—" : `${num(F(q).turnover)}%`),
          h("td", { className: "skd-num" }, fieldText("amount", F(q).amount, q)),
          ...(watch ? (() => {
            const f = F(q);
            const price = nOr(f.price);
            const prev = nOr(f.prevClose);
            const one = rowOf(q.code, "pos");
            const cost = nOr(one.cost);
            const shares = nOr(one.shares);
            // 行情不是今天的 → 今日盈亏无从谈起，显示「—」并在名称旁标「昨收」。
            // 不这么做的话，未开盘时会把昨天收盘的涨幅当成今天的盈亏继续显示，
            // 用户看到的就是「新的一天了怎么还没清零」。
            const qd = quoteDate(f);
            const stale = qd !== null && qd !== today;
            // 今日买入的仓位用成本价当基准，否则才用昨收。
            // todayBuy 既可能是 true（旧数据），也可能是日期字符串（新数据）；
            // 是日期时只有等于行情所属日期才算「当日买入」—— 否则昨天勾的今天还生效，
            // 今日盈亏就退化成了持仓盈亏。
            const bought = isBoughtToday(one, qd);
            const base = bought ? cost : prev;
            const todayPnl = stale || shares === null || price === null || base === null
              ? null : (price - base) * shares;
            const holdPnl = shares !== null && price !== null && cost !== null ? (price - cost) * shares : null;
            const cls = (v) => "skd-num " + (v === null ? "" : v > 0 ? "skd-up" : v < 0 ? "skd-down" : "");
            return [
              h("td", { key: "cost" }, editingCode === q.code
                ? h("span", { className: "skd-costcell" },
                  cell(q.code, "pos", "cost", "0.001"),
                  h("label", { className: "skd-todaybuy", title: T("hintTodayBuy") },
                    h("input", {
                      type: "checkbox",
                      checked: bought,
                      onChange: (e) => onChange?.("pos", q.code, "todayBuy", e.target.checked),
                    }),
                    T("todayBuyShort")))
                : h("span", { className: "skd-costcell" },
                  cell(q.code, "pos", "cost", "0.001"),
                  bought ? h("span", { className: "skd-tag", title: T("hintTodayBuy") }, T("todayBuyShort")) : null)),
              h("td", { key: "shares" }, cell(q.code, "pos", "shares", "1")),
              h("td", { key: "tp", className: cls(todayPnl) }, money(todayPnl)),
              h("td", { key: "hp", className: cls(holdPnl) }, money(holdPnl)),
              h("td", { key: "lo" }, cell(q.code, "alert", "low", "0.001")),
              h("td", { key: "hi" }, cell(q.code, "alert", "high", "0.001")),
              // 行尾操作：只读时是「编辑 / 移除」，编辑这一行时换成「保存 / 取消」。
              // 编辑入口放行尾而不是卡片头，是为了让人一眼看出「我在改哪一只」——
              // 卡片头的按钮离具体的行太远，编辑态又整表生效，很容易改错行。
              h("td", { key: "rm", className: "skd-actcol" },
                editingCode === q.code
                  ? h("span", { className: "skd-actbtns" },
                    h("button", {
                      className: "skd-btn", "data-xs": "1", "data-primary": "1", type: "button",
                      onClick: () => onSave?.(q.code),
                    }, T("saveEdit")),
                    h("button", {
                      className: "skd-btn", "data-xs": "1", type: "button",
                      onClick: () => onCancel?.(q.code),
                    }, T("cancelEdit")))
                  : h("span", { className: "skd-actbtns" },
                    h("button", {
                      className: "skd-btn", "data-xs": "1", type: "button",
                      onClick: () => onEdit?.(q.code),
                    }, T("edit")),
                    h("button", {
                      className: "skd-btn", "data-xs": "1", type: "button",
                      onClick: () => onRemove?.(q.code),
                    }, T("remove")))),
            ];
          })() : [watch ? null : null].filter(Boolean)),
          watch ? null : null))));
    }

    /** 腾讯的 time 是 "20261019142003" 这种紧凑串，直接显示不好读 */
    function stampText(t) {
      const s = typeof t === "string" ? t : "";
      if (!/^\d{14}$/.test(s)) return null;
      return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
    }

    /**
     * 明细分组。
     *
     * 刻意按「字段是否存在」渲染，而不是写死一段模板：指数的 fields 里根本没有
     * turnover / pe / pb / limitUp / limitDown / orderDiff，而方案 §8 有一条验收标准
     * 正是「指数明细不得出现换手率 / 市盈率 / 市净率 / 涨跌停价 / 委比」。
     * 按存在性渲染，这条自动成立，且以后新增品种既不会漏字段也不会多出看着像真的假字段。
     */
    /**
     * 位置类指标。全部由已有字段算出来，不引入新的上游字段。
     *
     * 为什么算而不是取：方案 §5.2 把「位置」列为一组（区间位置、距涨停/跌停空间、相对均价强弱），
     * 但腾讯没有直接给这几个字段，取不到就只能自己算。用相对百分比而不是绝对价差 ——
     * 一百块的股票和一千块的股票同样差一毛，含义完全不同。
     *
     * @returns {Array<[string, string]>} 字段名与文本；算不出的整行不出现（指数没有涨跌停价）
     */
    function positionRows(q) {
      const f = F(q);
      const p = nOr(f.price);
      if (p === null || p === 0) return [];

      /** 现价到目标价还差多少。目标是上方的涨停价时才用这个 */
      const gapUpTo = (target) => {
        const n = nOr(target);
        if (n === null || n <= 0) return null;
        return pct(((n - p) / p) * 100);
      };
      /**
       * 现价离下方目标还有多少空间。
       *
       * 不能复用 gapUpTo：那个算的是 (目标 − 现价)，对跌停价会得出负数，
       * 而「距跌停还有多少空间」显然应该是正的。这是自检逮到的第二处符号错误。
       */
      const roomDownTo = (target) => {
        const n = nOr(target);
        if (n === null || n <= 0) return null;
        return pct(((p - n) / p) * 100);
      };
      /** 现价高于某个参考价多少 */
      const above = (base) => {
        const n = nOr(base);
        return n === null ? null : pct(((p - n) / p) * 100);
      };
      /** 现价高于均价多少。均价是分母，所以单独一个分支 */
      const vsAvg = () => {
        const n = nOr(f.avgPrice);
        if (n === null || n === 0) return null;
        return pct(((p - n) / n) * 100);
      };

      return [
        ["fromHigh", above(f.high)],
        ["fromLow", above(f.low)],
        ["toLimitUp", gapUpTo(f.limitUp)],
        ["toLimitDown", roomDownTo(f.limitDown)],
        ["vsAvg", vsAvg()],
      ].filter(([, text]) => text !== null);
    }

    /**
     * 现价在当日最高与最低之间的位置。0 = 贴着最低，1 = 贴着最高。
     *
     * @returns {number|null} 拿不到高低、或最高等于最低时返回 null，调用方据此不画这条
     */
    function rangeRatio(q) {
      const f = F(q);
      const p = nOr(f.price);
      const hi = nOr(f.high);
      const lo = nOr(f.low);
      if (p === null || hi === null || lo === null || hi <= lo) return null;
      return Math.min(1, Math.max(0, (p - lo) / (hi - lo)));
    }

    /**
     * 委比 =（委买量 − 委卖量）/（委买量 + 委卖量）。
     *
     * 为什么不直接取上游的委比字段：腾讯那个位置（[86]）在本项目的探针里从没被证实过，
     * 而买五档与卖五档的挂单量都在手上，按定义算出来是确定的。
     * 口径是「五档挂单量」，与行情软件上常见的委比一致。
     *
     * @returns {string|null} 百分比文本；没有盘口（指数）时返回 null
     */
    function orderRatio(q) {
      const sumVol = (side) => {
        const rows = Array.isArray(q?.ladder?.[side]) ? q.ladder[side] : [];
        const vals = rows.map((r) => nOr(r?.volume)).filter((v) => v !== null);
        return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
      };
      const b = sumVol("bids");
      const s = sumVol("asks");
      if (b === null || s === null || b + s === 0) return null;
      return pct(((b - s) / (b + s)) * 100);
    }

    const DETAIL_GROUPS = [
      { title: "gPrice", keys: ["price", "change", "changePct", "prevClose", "open", "high", "low", "avgPrice", "amplitude"] },
      { title: "gVolume", keys: ["volume", "amount", "volRatio", "turnover"] },
      { title: "gValuation", keys: ["pe", "peDyn", "peStatic", "pb", "totalCap", "floatCap"] },
      { title: "gOrderbook", keys: ["orderDiff", "outer", "inner"] },
      { title: "gLimit", keys: ["limitUp", "limitDown"] },
    ];

    /**
     * 明细字段的说明。键与 DETAIL_GROUPS / positionRows 里的字段名一一对应。
     *
     * 值写成 thunk 而不是 "hintPrice" 这样的字符串键：自检那条「声明了却用不上」的规则
     * 是静态扫 T("字面量") 的，写成字符串键它看不见，会把这些词条全报成多余的。
     * 与 KLINE_PERIODS 同一个约定。
     */
    const FIELD_HINT = {
      price: () => T("hintPrice"),
      change: () => T("hintChange"),
      changePct: () => T("hintChangePct"),
      prevClose: () => T("hintPrevClose"),
      open: () => T("hintOpen"),
      high: () => T("hintHigh"),
      low: () => T("hintLow"),
      avgPrice: () => T("hintAvgPrice"),
      amplitude: () => T("hintAmplitude"),
      volume: () => T("hintVolume"),
      amount: () => T("hintStockAmount"),
      volRatio: () => T("hintVolRatio"),
      turnover: () => T("hintTurnover"),
      pe: () => T("hintPe"),
      peDyn: () => T("hintPeDyn"),
      peStatic: () => T("hintPeStatic"),
      pb: () => T("hintPb"),
      totalCap: () => T("hintTotalCap"),
      floatCap: () => T("hintFloatCap"),
      orderDiff: () => T("hintOrderDiff"),
      outer: () => T("hintOuter"),
      inner: () => T("hintInner"),
      limitUp: () => T("hintLimitUpPrice"),
      limitDown: () => T("hintLimitDownPrice"),
      fromHigh: () => T("hintFromHigh"),
      fromLow: () => T("hintFromLow"),
      toLimitUp: () => T("hintToLimitUp"),
      toLimitDown: () => T("hintToLimitDown"),
      vsAvg: () => T("hintVsAvg"),
      orderRatio: () => T("hintOrderRatio"),
      bids: () => T("hintBids"),
      asks: () => T("hintAsks"),
    };

    function QuoteDetail({ q, onClose }) {
      if (!q) return null;
      const f = F(q);

      const groups = DETAIL_GROUPS.map((g) => ({
        title: g.title,
        rows: g.keys.map((k) => [k, fieldText(k, f[k], q)]).filter(([, text]) => text !== null),
      })).filter((g) => g.rows.length > 0);

      /** 五档的一侧。没有这一侧就整个不渲染，避免出现一排空白格 */
      const levels = (side) => {
        const rows = Array.isArray(q.ladder?.[side]) ? q.ladder[side] : [];
        if (rows.length === 0) return null;
        return h("div", { className: "skd-d-lv" },
          h("div", { className: "skd-d-lvt" }, T(side), h(Hint, { text: FIELD_HINT[side]?.() })),
          ...rows.map((r, i) => h("div", { className: "skd-d-lvr", key: i },
            h("span", { className: "skd-num" }, num(r?.price, q.kind === "ETF" ? 3 : 2)),
            h("span", { className: "skd-num skd-d-lvv" }, nOr(r?.volume) === null ? "—" : String(r.volume)))));
      };

      // 两侧都要取。写成 levels("bids") ?? levels("asks") 是错的：
      // ?? 只在左边为 null/undefined 时才评估右边，而 levels 返回的是元素对象（永远非空），
      // 于是卖五档一次都不会渲染 —— 本插件第一版就是这么错的，被自检逮住。
      const boardRows = [levels("bids"), levels("asks")].filter((x) => x !== null);
      const bidRatio = orderRatio(q);
      const board = boardRows.length === 0 && bidRatio === null ? null
        : h("div", { className: "skd-d-board" },
            h("div", { className: "skd-d-gt" }, T("gOrderbook")),
            // 委比与委差放在一起，和行情软件上盘口的位置一致
            bidRatio !== null ? h("div", { className: "skd-d-ratio" },
              h("span", { className: "skd-d-k" }, T("orderRatio"), h(Hint, { text: T("hintOrderRatio") })),
              h("span", { className: "skd-num" }, bidRatio)) : null,
            ...boardRows);

      const posRows = positionRows(q);
      const ratio = rangeRatio(q);
      const position = posRows.length === 0 && ratio === null ? null
        : h("div", { className: "skd-d-pos" },
            h("div", { className: "skd-d-gt" }, T("gPosition"), h(Hint, { text: T("hintRange") })),
            // 位置条只用品牌色，不用红绿：它表示「在当日区间里的哪个位置」而不是涨跌
            ratio !== null ? h("div", { className: "skd-rng" },
              h("div", { className: "skd-rng-f", style: { width: `${(ratio * 100).toFixed(1)}%` } })) : null,
            ...posRows.map(([k, text]) => h("div", { className: "skd-d-r", key: k },
              h("span", { className: "skd-d-k" }, T(k), h(Hint, { text: FIELD_HINT[k]?.() })),
              h("span", { className: "skd-num" }, text))));

      const stamp = stampText(q.time);

      return h("div", { className: "skd-d" },
        h("div", { className: "skd-d-hd" },
          h("span", { className: "skd-d-name" }, q.name ?? q.code),
          q.kind ? h("span", { className: "skd-tag" }, q.kind) : null,
          h("span", { className: "skd-code" }, q.code),
          stamp !== null ? h("span", { className: "skd-d-stamp" }, stamp) : null,
          h("button", { className: "skd-btn", type: "button", onClick: () => onClose?.() }, T("close"))),
        h("div", { className: "skd-d-groups" }, ...groups.map((g) => h("div", { className: "skd-d-g", key: g.title },
          h("div", { className: "skd-d-gt" }, T(g.title)),
          ...g.rows.map(([k, text]) => h("div", { className: "skd-d-r", key: k },
            h("span", { className: "skd-d-k" }, T(k), h(Hint, { text: FIELD_HINT[k]?.() })),
            h("span", { className: `skd-num ${dir(k === "change" || k === "changePct" ? f[k] : null)}` }, text)))))),
        position,
        board,
        // 图放在最后：先给数字（一眼看完），再给走势（要看细节时往下看）
        h(Kline, { code: q.code }));
    }

    /**
     * K 线周期。腾讯只给这三种，分钟线走东财（见 lib/market.js 的双源分工）。
     * 词条写成 thunk 而不是 `"kDay"` 这样的字符串键：自检里那条「声明了却用不上」的规则
     * 是静态扫 T("字面量") 的，写成字符串键它看不见，会误报成多余词条。
     */
    const KLINE_PERIODS = [
      ["min", () => T("kMin")], ["day", () => T("kDay")], ["week", () => T("kWeek")], ["month", () => T("kMonth")],
    ];

    /** 默认视窗根数。宿主一次给 250 根，全画出来一根只有 2.5px 宽，缩到看不出形状 */
    const DEFAULT_BARS = 120;
    /** 最少 20 根。再少就成折线了，K 线的开高低收没有意义 */
    const MIN_BARS = 20;
    /** 一格滚轮的缩放倍率。1.25 是手感阈值，再小要滚很多下才有变化 */
    const ZOOM_STEP = 1.25;

    /**
     * K 线与均线（MA5 / MA10 / MA20）。
     *
     * 为什么要有：方案 §5.2 写着「日/周/月 K + MA」，但这一块我一直没做 ——
     * 详情面板只有数字，看不到走势。宿主那边 /kline 早就是现成的。
     *
     * 为什么内联 SVG 而不是引图表库：插件没有构建步骤，client.js 是直接交给
     * __ModuleLoader__ 的，多一个依赖就多一条加载路径；K 线用柱 + 线就画完了。
     *
     * 数据没回来 / 失败 / 为空三种状态各渲染各的，不留白屏 ——
     * 这三条路上都栽过（见 docs/安装与激活实测.md）。
     */
    function Kline({ code }) {
      // 默认分时而不是日K：点开一只股票，最常想知道的是「它今天走得怎么样」
      const [period, setPeriod] = React.useState("min");
      const [st, setSt] = React.useState({ loading: true, err: null, candles: [], minute: null });
      const [hover, setHover] = React.useState(null);
      /**
       * 视图窗口。缩放和平移都只改这个窗口，不重新请求 ——
       * 每滚一下滑轮就发一次请求，既卡又浪费，而且拖动时根本跟不上。
       * end=0 表示「贴着最右」，取数据长度。
       */
      const [view, setView] = React.useState({ size: 0, end: 0 });
      const svgRef = React.useRef(null);
      const dragRef = React.useRef(null);
      // 换股票或换周期都要清掉光标：下标是位置，换了数据以后指向的已经不是同一根了
      React.useEffect(() => { setHover(null); setView({ size: 0, end: 0 }); }, [code, period]);
      React.useEffect(() => {
        if (!code) return undefined;
        let alive = true;
        setSt({ loading: true, err: null, candles: [], minute: null });
        const isMin = period === "min";
        const url = isMin
          ? `/minute?code=${encodeURIComponent(code)}`
          // 一次抓满：缩放只在本地切窗口，不再回服务器要数据
          : `/kline?code=${encodeURIComponent(code)}&period=${period}&limit=250`;
        api(url)
          .then((r) => {
            if (!alive) return;
            setSt({ loading: false, err: null, candles: r?.candles ?? [], minute: isMin ? r : null });
          })
          .catch((e) => {
            if (alive) setSt({ loading: false, err: e?.message ?? String(e), candles: [], minute: null });
          });
        return () => { alive = false; };
      }, [code, period]);

      const tabs = h("div", { className: "skd-k-tabs" },
        ...KLINE_PERIODS.map(([p, label]) => {
          const on = period === p;
          return h("button", {
            key: p, type: "button", className: "skd-tab", "data-on": on ? "1" : "0",
            onClick: () => setPeriod(p),
          }, label());
        }));

      /**
       * 视图窗口切片。必须在任何提前 return 之前算完 —— 下面要用到的几个
       * hook 得无条件调用，不能藏进分支里。
       *
       * 分时和 K 线共用同一套窗口机制，只是数据源不同：分时的一「根」是一分钟，
       * K 线的一根是一天/一周/一月。
       */
      const series = period === "min"
        ? (Array.isArray(st.minute?.points) ? st.minute.points : [])
        : (Array.isArray(st.candles) ? st.candles : []);
      const nAll = series.length;
      // 分时的默认视窗是全天（242 点），K 线才是 120 根 ——
      // 分时缩到 120 点等于默认就把上午砍掉一半
      const defBars = period === "min" ? nAll : DEFAULT_BARS;
      const vSize = Math.min(view.size || defBars, Math.max(nAll, 1));
      const vEnd = Math.min(view.end || nAll, nAll);
      const vStart = Math.max(0, vEnd - vSize);
      const win = series.slice(vStart, vEnd);
      const cs = period === "min" ? [] : win;
      const mPts = period === "min" ? win : [];

      /**
       * Ctrl + 滚轮缩放。必须用原生监听器并显式 passive:false ——
       * React 的 onWheel 挂在根节点上是 passive 的，里面调 preventDefault 不生效，
       * 结果是图放大了、整页也跟着滚了。
       *
       * 不按 Ctrl 时一律放行，页面该滚就滚，不抢滚轮。
       */
      React.useEffect(() => {
        const el = svgRef.current;
        if (!el || typeof el.addEventListener !== "function") return undefined;
        if (nAll === 0) return undefined;
        const onWheel = (ev) => {
          if (!ev.ctrlKey) return;
          ev.preventDefault();
          let frac = 0.5;
          try {
            const r = el.getBoundingClientRect();
            frac = Math.min(1, Math.max(0,
              (((ev.clientX - r.left) / (r.width || 1)) * CH.W - CH.ML) / CH.PW));
          } catch { frac = 0.5; }
          setView(zoomWindow({ size: vSize, end: vEnd }, ev.deltaY, frac, nAll));
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
      }, [period, nAll, vSize, vStart, vEnd]);
      if (st.err) return h("div", { className: "skd-k" }, tabs,
        h(Msg, { text: `${T(period === "min" ? "minute" : "kline")}：${T("unavailable")}`, hint: st.err }));

      /**
       * 光标事件。屏幕坐标要先换成 SVG 坐标 —— viewBox 宽 720，
       * 但元素被拉伸到容器宽度，两者不相等；直接按 720 算会整体偏移，
       * 而且窗口越宽偏得越多。所以必须用 getBoundingClientRect 实测。
       */
      const bind = (picker) => ({
        ref: svgRef,
        onMouseMove: (ev) => {
          try {
            const r = ev.currentTarget.getBoundingClientRect();
            const vbX = ((ev.clientX - r.left) / (r.width || 1)) * CH.W;
            // 按住拖动时走平移，不出光标 —— 否则一边拖一边闪读数，看不清拖到哪了
            const d = dragRef.current;
            if (d) {
              setView(panWindow({ size: vSize, end: d.end }, vbX - d.vbX, nAll));
              return;
            }
            setHover(picker(vbX));
          } catch { setHover(null); }
        },
        onMouseDown: (ev) => {
          // 没得平移就别进拖动状态，否则鼠标一按就变抓手光标、却什么都拖不动
          if (nAll <= vSize) return;
          try {
            const r = ev.currentTarget.getBoundingClientRect();
            dragRef.current = {
              vbX: ((ev.clientX - r.left) / (r.width || 1)) * CH.W, end: vEnd,
            };
          } catch { dragRef.current = null; }
        },
        onMouseUp: () => { dragRef.current = null; },
        onMouseLeave: () => { dragRef.current = null; setHover(null); },
      });

      if (period === "min") {
        if (!st.minute) return h("div", { className: "skd-k" }, tabs,
          h(Msg, { text: st.loading ? T("loading") : `${T("minute")}：${T("unavailable")}` }));
        const m = minuteChart(Object.assign({}, st.minute, { points: mPts }), code, hover, bind(chartPick(mPts.length)));
        const pt = hover === null ? null : mPts[hover];
        // 缩放后原来那四个固定时刻（开/午/午后/收）就不对了 —— 其中几个已经不在视窗里。
        // 改成标当前视窗的首末时刻，缩放到哪就说到哪。
        const ticks = vSize < nAll && mPts.length > 0
          ? [h("span", { key: "a", className: "skd-code" }, fmtHM(mPts[0].time)),
            h("span", { key: "b", className: "skd-code" }, "→"),
            h("span", { key: "c", className: "skd-code" }, fmtHM(mPts[mPts.length - 1].time))]
          : m.ticks;
        return h("div", { className: "skd-k" },
          h("div", { className: "skd-k-hd" }, tabs, h("span", { className: "skd-k-lg" }, ...m.legend)),
          m.svg,
          h("div", { className: "skd-k-ft" },
            ...(pt ? [h("span", { key: "t", className: "skd-code skd-k-cursor" }, fmtHM(pt.time))] : []),
            ...ticks,
            h("span", { className: "skd-k-hint" }, T("zoomHint")),
            h("span", { className: "skd-row-r skd-num" }, m.summary)));
      }

      if (cs.length === 0) return h("div", { className: "skd-k" }, tabs,
        h(Msg, { text: st.loading ? T("loading") : `${T("kline")}：${T("unavailable")}` }));

      const chart = klineChart(cs, code, hover, bind(chartPick(cs.length)));
      const last = cs[cs.length - 1];
      return h("div", { className: "skd-k" },
        h("div", { className: "skd-k-hd" }, tabs,
          // 悬停时报那一根的收与涨跌，否则报最后一根 —— 均线图例只在没悬停时占地方
          h("span", { className: "skd-k-lg" },
            ...(hover === null
              ? chart.mas.map((m) => h("span", { key: m.cls, className: `skd-k-ma ${m.cls}` },
                `MA${m.n} ${chart.lastMa(m) === null ? "—" : num(chart.lastMa(m))}`))
              : chart.readout))),
        chart.svg,
        h("div", { className: "skd-k-ft" },
          ...(hover === null ? [] : chart.readout),
          ...chart.ticks.map((i) => h("span", { key: i, className: "skd-code" }, cs[i].date)),
          // 缩放过才显示视窗范围：没缩放时说「120/250」是噪音
          ...(vSize < nAll
            ? [h("span", { key: "rg", className: "skd-code" }, `${vStart + 1}-${vEnd} / ${nAll}`)]
            : []),
          h("span", { className: "skd-k-hint" }, T("zoomHint")),
          h("span", { className: "skd-row-r skd-num" },
            `${cs.length} 根 · 最新 ${num(last.close)}`)));
    }

    /** "0930" → "09:30"；分时接口给的是紧凑四位，横轴和光标读数都按这个显示 */
    function fmtHM(hm) {
      const s = String(hm ?? "");
      return /^\d{4}$/.test(s) ? `${s.slice(0, 2)}:${s.slice(2)}` : s;
    }

    /** 图表实例计数，给 clipPath 生成唯一 id —— 同一页可能同时挂着好几张图
     */
    let chartSeq = 0;

    /**
     * 画图区的公共几何。左右留边距就是为了放刻度数字。
     *
     * 第一版整张图上一个数字都没有：一条曲线加一根均线，最高最低在哪、现价多少，
     * 全靠眼睛比划 —— 用户说「看不懂」主因就在这里。
     */
    const CH = { W: 720, MT: 12, ML: 46, MR: 54, PH: 190, VH: 46, GAP: 10 };
    CH.PW = CH.W - CH.ML - CH.MR;
    CH.H = CH.MT + CH.PH + CH.GAP + CH.VH;

    /**
     * 横向网格线 + 左右刻度文本。
     *
     * @param {number} y0 纵轴下端对应的数值
     * @param {number} y1 纵轴上端对应的数值
     * @param {Function} fmtL 左刻度格式化（价位）
     * @param {Function} [fmtR] 右刻度格式化（涨跌幅）；不传就只画左边
     * @returns {object[]}
     */
    function chartYTicks(y0, y1, fmtL, fmtR) {
      const span = (y1 - y0) || 1;
      const out = [];
      for (let i = 0; i <= 4; i += 1) {
        // 顶格那条线要压在 MT 上而不是 0 上：11px 的文字骑在 y=0 时
        // 有约 8px 伸到画布外，被 svg 直接切掉半个字 —— 就是「被遮挡」的来源
        const y = CH.MT + (CH.PH / 4) * i;
        const val = y0 + ((CH.PH - (y - CH.MT)) / CH.PH) * span;
        out.push(h("line", {
          key: `g${i}`, x1: CH.ML, x2: CH.ML + CH.PW, y1: y, y2: y, className: "skd-k-grid",
        }));
        out.push(h("text", {
          key: `l${i}`, x: CH.ML - 5, y: y + 3.5, textAnchor: "end", className: "skd-k-axis",
        }, fmtL(val)));
        if (fmtR) {
          out.push(h("text", {
            key: `r${i}`, x: CH.ML + CH.PW + 5, y: y + 3.5, textAnchor: "start", className: "skd-k-axis",
          }, fmtR(val)));
        }
      }
      return out;
    }

    /** 十字光标。没有光标就只能看个大概形状，「13:47 那一分钟多少钱」得靠眼睛比划 */
    function chartCross(x, y) {
      return [
        h("line", { key: "cl", x1: x, x2: x, y1: CH.MT, y2: CH.MT + CH.PH, className: "skd-k-cross" }),
        h("circle", { key: "cd", cx: x, cy: y, r: 3, className: "skd-k-crossdot" }),
      ];
    }

    /**
     * 缩放视窗。基准点取光标所在的屏幕比例 frac（0=最左，1=最右），
     * 缩放后让该比例处的那一根尽量停在原地 —— 否则每缩一次图都往一边跑，
     * 想放大看某根就得反复「缩一下、拖回去」。
     *
     * @param {{size: number, end: number}} cur 当前视窗，end 是开区间右端
     * @param {number} deltaY 滚轮方向，向上滚（负数）是放大
     * @param {number} frac 光标在绘图区里的横向比例，已夹到 0..1
     * @param {number} nAll 总根数
     * @returns {{size: number, end: number}}
     */
    function zoomWindow(cur, deltaY, frac, nAll) {
      const cap = Math.max(nAll, MIN_BARS);
      const size = Math.min(Math.max(cur.size || DEFAULT_BARS, MIN_BARS), cap);
      const end = Math.min(cur.end || nAll, nAll);
      const start = Math.max(0, end - size);
      // 放大 = 视窗根数变少（每根变宽），缩小 = 根数变多。
      // 方向写反过一次：向上滚写成 size *= ZOOM_STEP，等于每滚一次反而看得更多，
      // 而且默认已经全天的时候被上限夹住，表现就是「滚了没反应」。
      const raw = size / (deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
      const next = Math.round(Math.min(Math.max(raw, MIN_BARS), cap));
      const anchor = start + frac * size;
      const nStart = Math.round(anchor - frac * next);
      return { size: next, end: Math.min(nAll, Math.max(next, nStart + next)) };
    }

    /**
     * 平移视窗。dSvg 是拖过的 SVG 横向距离，向右为正 = 往回看更早的行情。
     *
     * @param {{size: number, end: number}} cur 当前视窗
     * @param {number} dSvg 横向位移（SVG 单位）
     * @param {number} nAll 总根数
     * @returns {{size: number, end: number}}
     */
    function panWindow(cur, dSvg, nAll) {
      const size = Math.min(cur.size || DEFAULT_BARS, Math.max(nAll, 1));
      const end = Math.min(cur.end || nAll, nAll);
      const shift = Math.round(dSvg / (CH.PW / Math.max(size, 1)));
      return { size, end: Math.min(nAll, Math.max(size, end - shift)) };
    }

    /**
     * 把 SVG 横坐标换算成下标，越界给 null。
     *
     * 单独抽出来是因为组件要在 mousemove 里反复用它 —— 若为了拿这个换算去调一次
     * 完整的图表函数，每动一下鼠标就要重建整棵元素树。
     *
     * @param {number} n 点数或根数
     * @returns {Function} (vbX) => number|null
     */
    function chartPick(n) {
      const bw = CH.PW / Math.max(n, 1);
      return (vbX) => {
        if (!n) return null;
        const i = Math.floor((vbX - CH.ML) / bw);
        return i >= 0 && i < n ? i : null;
      };
    }

    /**
     * 分时图：面积 + 价格线 + 均价线 + 昨收基准 + 每分钟量能柱 + 左右刻度 + 光标。
     *
     * 纵轴以昨收为中心上下对称取幅度 —— 这一条是分时图和 K 线图最大的不同。
     * 若照 K 线那样按最高最低铺满，涨 1% 和跌 1% 会被画成一样高，
     * 「今天到底涨了还是跌了」这个最该一眼看出来的信息反而丢了。
     *
     * 同样抽成纯函数是为了能测：组件里那条路要等 fetch 回来才走到。
     *
     * @param {{points?: object[], prevClose?: number, name?: string}} mi 宿主 /minute 的返回
     * @param {string} [code] 仅用于 aria-label
     * @param {number|null} [hover] 光标所在的下标，null 表示没悬停
     * @param {object} [svgProps] 附加到 svg 上的属性（组件用它挂鼠标事件）
     * @returns {{svg: object, legend: object[], ticks: object[], summary: string, pick: Function, n: number}}
     */
    function minuteChart(mi, code, hover = null, svgProps = null) {
      const pts = Array.isArray(mi?.points) ? mi.points : [];
      const prices = pts.map((p) => p.price).filter((v) => typeof v === "number");
      const avgs = pts.map((p) => p.avg).filter((v) => typeof v === "number");
      // 没有昨收就用第一个价当基准 —— 总比画不出来强
      const base = typeof mi?.prevClose === "number"
        ? mi.prevClose
        : (prices.length > 0 ? prices[0] : 0);
      // 末尾那个 0.01 是下限：一个点都没有时 Math.max() 会返回 -Infinity
      const dev = Math.max(
        ...prices.map((v) => Math.abs(v - base)),
        ...avgs.map((v) => Math.abs(v - base)),
        0.01);
      const y0 = base - dev * 1.05, y1 = base + dev * 1.05;
      const span = (y1 - y0) || 1;
      const Y = (v) => CH.MT + CH.PH - ((v - y0) / span) * CH.PH;
      const n = pts.length;
      const bw = CH.PW / Math.max(n, 1);
      const cx = (i) => CH.ML + i * bw + bw / 2;
      const vmax = Math.max(...pts.map((p) => (typeof p.volume === "number" ? p.volume : 0)), 1);
      const cw = Math.max(1, Math.min(bw * 0.7, 6));
      const baseY = Y(base);
      const pctOf = (v) => (base ? ((v - base) / base) * 100 : null);

      const pathOf = (key) => pts
        .map((p, i) => (typeof p[key] === "number" ? `${cx(i).toFixed(1)},${Y(p[key]).toFixed(1)}` : null))
        .filter(Boolean).join(" ");
      const line = (key, cls) => h("polyline", { className: `skd-k-line ${cls}`, points: pathOf(key) });

      // 面积：沿价格线走一圈再回到基准线闭合。同一个路径画两遍，
      // 分别用「基准线以上」和「以下」两个裁剪区 —— 一次就得到涨红跌绿两块
      const areaId = `skd-a${chartSeq += 1}`;
      const areaD = `M${CH.ML},${baseY.toFixed(1)} L${pathOf("price").split(" ").join(" L")} L${(CH.ML + CH.PW).toFixed(1)},${baseY.toFixed(1)} Z`;

      // 量能柱按当分钟价在昨收哪一侧上色，与价格线的红绿同一口径
      const bars = pts.map((p, i) => {
        const vh = Math.max(1, ((p.volume ?? 0) / vmax) * CH.VH);
        return h("rect", {
          key: p.time ?? i, x: cx(i) - cw / 2, y: CH.MT + CH.PH + CH.GAP + (CH.VH - vh), width: cw, height: vh,
          className: (p.price ?? base) >= base ? "skd-k-vbar-up" : "skd-k-vbar-dn",
        });
      });

      const grid = chartYTicks(y0, y1, (v) => num(v), (v) => {
        const q = pctOf(v);
        return q === null ? "" : `${q >= 0 ? "+" : ""}${q.toFixed(2)}%`;
      });

      const hi = typeof hover === "number" && hover >= 0 && hover < n ? hover : null;
      const cur = hi === null ? (n > 0 ? pts[n - 1] : null) : pts[hi];
      const curPrice = cur && typeof cur.price === "number" ? cur.price : null;
      const pct = curPrice === null ? null : pctOf(curPrice);

      const svg = h("svg", Object.assign({
        className: "skd-k-svg", viewBox: `0 0 ${CH.W} ${CH.H}`, role: "img",
        "aria-label": `${code ?? ""} ${T("minute")}`,
      }, svgProps ?? {}),
        h("defs", null,
          h("clipPath", { id: `${areaId}u` },
            h("rect", { x: CH.ML, y: CH.MT, width: CH.PW, height: Math.max(0, baseY - CH.MT) })),
          h("clipPath", { id: `${areaId}d` },
            h("rect", { x: CH.ML, y: baseY, width: CH.PW, height: Math.max(0, CH.MT + CH.PH - baseY) }))),
        ...grid,
        ...bars,
        h("path", { d: areaD, className: "skd-k-area-up", clipPath: `url(#${areaId}u)` }),
        h("path", { d: areaD, className: "skd-k-area-dn", clipPath: `url(#${areaId}d)` }),
        h("line", { x1: CH.ML, x2: CH.ML + CH.PW, y1: baseY, y2: baseY, className: "skd-k-base" }),
        line("price", "mprice"),
        line("avg", "mavg"),
        ...(hi === null ? [] : chartCross(cx(hi), Y(cur.price), 0)),
        // 最新价打一个点：收盘后一眼看到落在哪，不用顺着线找末端
        ...(n > 0 && hi === null && typeof pts[n - 1].price === "number"
          ? [h("circle", { key: "dot", cx: cx(n - 1), cy: Y(pts[n - 1].price), r: 2.5, className: "skd-k-dot" })]
          : []));

      const legend = [
        h("span", { key: "p", className: "skd-k-ma ma5" },
          `${T("minPrice")} ${curPrice === null ? "—" : num(curPrice)}`),
        h("span", { key: "a", className: "skd-k-ma ma20" },
          `${T("minAvg")} ${cur && typeof cur.avg === "number" ? num(cur.avg) : "—"}`),
        h("span", { key: "b", className: "skd-k-ma ma10" },
          `${T("minBase")} ${mi?.prevClose === null || mi?.prevClose === undefined ? "—" : num(base)}`),
      ];

      // 横轴两个断点都在图上标出来：中午休市那 90 分钟是接在一起画的，
      // 不标的话会把上午和下午看成连续的两段
      const ticks = [["0930", T("minOpen")], ["1130", T("minNoon")], ["1300", T("minPm")], ["1500", T("minClose")]]
        .map(([hm, label]) => h("span", { key: hm, className: "skd-code" }, `${label} ${hm.slice(0, 2)}:${hm.slice(2)}`));

      const summary = pct === null
        ? `${n} 点`
        : `${n} 点 · ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;

      /** 把 SVG 里的横坐标换算成下标；越界返回 null，交给调用方清掉光标 */
      const pick = (vbX) => {
        if (n === 0) return null;
        const i = Math.floor((vbX - CH.ML) / bw);
        return i >= 0 && i < n ? i : null;
      };
      return { svg, legend, ticks, summary, pick, n };
    }

    /**
     * 把 K 线序列画成 SVG。抽成纯函数是为了能测：
     * 组件里那条路要等 fetch 回来才走到，自检环境的桩件不会跑 effect ——
     * 图表最容易崩的地方（空数组、单根、缺字段）就永远测不到。
     * 现在可以把真实返回的 candles 直接喂进来。
     *
     * @param {object[]} cs 每根含 open/close/high/low/volume/date
     * @param {string} [code] 仅用于 aria-label
     * @param {number|null} [hover] 光标所在的下标
     * @param {object} [svgProps] 附加到 svg 上的属性
     * @returns {{svg: object, mas: object[], ticks: number[], lastMa: Function, pick: Function, readout: object[], n: number}}
     */
    function klineChart(cs, code, hover = null, svgProps = null) {
      const nums = (k) => cs.map((c) => c[k]).filter((v) => typeof v === "number");
      // 全部字段都缺失时 Math.min(...[]) 是 Infinity，会把坐标算成 NaN——
      // 那种情况下退回到 0..1 的空坐标系，图是平的但不炸
      const lows = nums("low"), highs = nums("high");
      const lo = lows.length > 0 ? Math.min(...lows) : 0;
      const hiP = highs.length > 0 ? Math.max(...highs) : 1;
      // 上下各留 5%：不留的话最高最低会贴着边缘，看着像被裁掉
      const padP = (hiP - lo) * 0.05 || Math.max(0.01, Math.abs(hiP) * 0.01);
      const y0 = lo - padP, y1 = hiP + padP;
      const span = (y1 - y0) || 1;
      const Y = (p) => CH.MT + CH.PH - ((p - y0) / span) * CH.PH;
      const n = cs.length;
      const bw = CH.PW / Math.max(n, 1);
      const cw = Math.max(1, Math.min(bw * 0.66, 14));
      const cx = (i) => CH.ML + i * bw + bw / 2;
      const vmax = Math.max(...cs.map((c) => (typeof c.volume === "number" ? c.volume : 0)), 1);

      /** n 期均线；不足 n 根时给 null，不拿前几根硬凑一个假值 */
      const maLine = (n2) => cs.map((_, i) => {
        if (i < n2 - 1) return null;
        let s = 0;
        for (let k = i - n2 + 1; k <= i; k += 1) s += cs[k].close;
        return s / n2;
      });
      const mas = [[5, "ma5"], [10, "ma10"], [20, "ma20"]]
        .map(([n2, cls]) => ({ n: n2, cls, vals: maLine(n2) }));
      const pts = (vals) => vals
        .map((v, i) => (v === null ? null : `${cx(i).toFixed(1)},${Y(v).toFixed(1)}`))
        .filter(Boolean).join(" ");

      // 阳线（收 >= 开）用涨色，与报价的红绿口径一致
      const body = cs.map((c, i) => {
        const o = Y(c.open), cl = Y(c.close);
        const top = Math.min(o, cl);
        const hgt = Math.max(1, Math.abs(cl - o));
        const vh = Math.max(1, ((c.volume ?? 0) / vmax) * CH.VH);
        return h("g", { key: c.date ?? i, className: (c.close ?? 0) >= (c.open ?? 0) ? "skd-k-up" : "skd-k-dn" },
          h("line", { x1: cx(i), x2: cx(i), y1: Y(c.high), y2: Y(c.low), className: "skd-k-wick" }),
          h("rect", { x: cx(i) - cw / 2, y: top, width: cw, height: hgt, className: "skd-k-body" }),
          h("rect", { x: cx(i) - cw / 2, y: CH.MT + CH.PH + CH.GAP + (CH.VH - vh), width: cw, height: vh, className: "skd-k-vol" }));
      });

      const grid = chartYTicks(y0, y1, (v) => num(v));
      const hi = typeof hover === "number" && hover >= 0 && hover < n ? hover : null;
      const cur = hi === null ? (n > 0 ? cs[n - 1] : null) : cs[hi];

      const svg = h("svg", Object.assign({
        className: "skd-k-svg", viewBox: `0 0 ${CH.W} ${CH.H}`, role: "img",
        "aria-label": `${code ?? ""} ${T("kline")}`,
      }, svgProps ?? {}),
        ...grid,
        ...body,
        ...mas.map((m) => h("polyline", { key: m.cls, className: `skd-k-line ${m.cls}`, points: pts(m.vals) })),
        h("line", { x1: CH.ML, x2: CH.ML + CH.PW, y1: CH.MT + CH.PH + CH.GAP, y2: CH.MT + CH.PH + CH.GAP, className: "skd-k-sep" }),
        ...(hi === null || cur === null ? [] : chartCross(cx(hi), Y(cur.close))));

      // 光标落在哪根就报哪根；没光标时报最后一根。K 线四价 + 涨跌幅 + 量
      const ro = cur === null ? [] : [
        h("span", { key: "d", className: "skd-code" }, String(cur.date ?? "")),
        h("span", { key: "o", className: "skd-k-ma ma10" }, `${T("kOpen")} ${num(cur.open)}`),
        h("span", { key: "h", className: "skd-k-ma ma5" }, `${T("kHigh")} ${num(cur.high)}`),
        h("span", { key: "l", className: "skd-k-ma ma20" }, `${T("kLow")} ${num(cur.low)}`),
        h("span", { key: "c", className: "skd-k-ma" }, `${T("kClose")} ${num(cur.close)}`),
        h("span", { key: "p", className: `skd-num ${dir(cur.changePct)}` },
          nOr(cur.changePct) === null ? "—" : `${cur.changePct >= 0 ? "+" : ""}${num(cur.changePct)}%`),
      ];

      // 日期只标首/中/尾三个，标满会糊成一片
      const ticks = [0, Math.floor(n / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i && v >= 0);
      const lastMa = (m) => (m.vals.length === 0 ? null : m.vals[m.vals.length - 1]);

      /** 把 SVG 横坐标换算成下标；越界返回 null */
      const pick = (vbX) => {
        if (n === 0) return null;
        const i = Math.floor((vbX - CH.ML) / bw);
        return i >= 0 && i < n ? i : null;
      };
      return { svg, mas, ticks, lastMa, pick, readout: ro, n };
    }

    function SearchBox({ onPick }) {
      const [q, setQ] = React.useState("");
      const [list, setList] = React.useState([]);
      const [dropUp, setDropUp] = React.useState(false);
      const boxRef = React.useRef(null);
      React.useEffect(() => {
        if (q.trim().length === 0) { setList([]); return undefined; }
        let alive = true;
        const id = setTimeout(async () => {
          try {
            const r = await api(`/search?q=${encodeURIComponent(q.trim())}`);
            if (alive) setList(r.items ?? []);
          } catch { if (alive) setList([]); }
        }, 180);
        return () => { alive = false; clearTimeout(id); };
      }, [q]);
      const open = list.length > 0;
      React.useEffect(() => {
        // 自选卡排在整页最下面（指数 / 涨跌家数 / 涨停 / 板块之后），下拉往下开 230px
        // 会直接开过视口底边被切掉一截 —— 用户反馈「有点被挡住」就是这个。
        // 所以按输入框在视口里的位置决定方向：下半屏往上开，上半屏照旧往下。
        // 量不到（自检环境里没有 window）就保持往下，与改动前行为一致，不会更糟。
        if (!open) return;
        try {
          const r = boxRef.current?.getBoundingClientRect?.();
          if (r) setDropUp(r.top > (window.innerHeight || 0) / 2);
        } catch { /* 量不到就往下开 */ }
      }, [open]);
      return h("div", { className: "skd-sr", ref: boxRef },
        h("input", {
          className: "skd-input", style: { width: "100%" }, value: q,
          placeholder: T("searchHint"), title: T("searchHint"),
          onChange: (e) => setQ(e.target.value),
        }),
        open ? h("div", { className: "skd-sr-list", "data-up": dropUp ? "1" : "0" }, ...list.map((it) => h("div", {
          key: it.code, className: "skd-sr-i",
          onClick: () => { onPick?.(it); setQ(""); setList([]); },
        },
          h("span", null, it.name),
          // 基金与股票在同一个列表里，不标出来用户分不清 510300 和 600519 是两种东西
          it.kind === "fund" ? h("span", { className: "skd-tag" }, T("fundTag")) : null,
          h("span", { className: "skd-code" }, it.code)))) : null);
    }

    /**
     * 从截图认股票。
     *
     * 为什么不做弹窗：自选卡本身就在整页最下面，弹窗还要额外处理遮罩层级和 Esc；
     * 这块面板是一次性的、用完就收，直接长在表格上方更省事，也不会盖住别的数据。
     *
     * 三个入口都给：粘贴（券商截图基本都在剪贴板里）、拖拽、点选文件。
     * 粘贴挂在 document 上，因为面板里的 div 拿不到焦点，Ctrl+V 的目标通常是 body。
     */
    function ImageImport({ onAdd, onClose, initial }) {
      const [busy, setBusy] = React.useState(false);
      const [adding, setAdding] = React.useState(false);
      const [err, setErr] = React.useState("");
      const [probe, setProbe] = React.useState(null);
      // initial 只给自检用：注入一份预置结果，免得为了断言候选列表去伪造 FileReader 与 fetch
      const [res, setRes] = React.useState(initial ?? null);
      const [pick, setPick] = React.useState(() => new Set((initial?.candidates ?? []).map((x) => x.code)));
      // 「持有」是与「要不要加」正交的一件事：截图里的持仓截图基本全是已持有的，
      // 加进自选后还要回表格逐行勾一遍，等于把省下的手工又还回去
      const [held, setHeld] = React.useState(() => new Set());
      const [done, setDone] = React.useState(null);
      const fileRef = React.useRef(null);

      // 先问一句本机能不能做中文 OCR：不同机器差的是系统语言包，
      // 不问的话用户要贴完图、等到失败，才知道这台机器做不了
      React.useEffect(() => {
        let alive = true;
        api("/ocr")
          .then((r) => { if (alive) setProbe(r?.probe ?? null); })
          .catch(() => { if (alive) setProbe(null); });
        return () => { alive = false; };
      }, []);

      /** 读一张图并交给宿主识别。图片走 dataURL，宿主侧再按 base64 解出来 */
      const readImage = (file) => {
        if (!file || busy) return;
        if (!/^image\//.test(file.type ?? "")) {
          setErr(`不是图片：${file.type || file.name || "未知类型"}`);
          return;
        }
        setErr(""); setRes(null); setDone(null); setPick(new Set()); setHeld(new Set()); setBusy(true);
        if (typeof FileReader === "undefined") {
          setBusy(false);
          setErr("这个环境读不了本地文件");
          return;
        }
        const fr = new FileReader();
        fr.onload = async () => {
          try {
            // 60 秒：上传几百 KB 再等宿主起 PowerShell 认图，用行情的 15 秒太紧
            const r = await api("/ocr", { image: String(fr.result) }, 60000);
            setRes(r);
            setPick(new Set((r?.candidates ?? []).map((x) => x.code)));
          } catch (e) {
            setErr(String(e?.message ?? e));
          } finally {
            setBusy(false);
          }
        };
        fr.onerror = () => { setBusy(false); setErr("这个文件读不出来"); };
        fr.readAsDataURL(file);
      };

      React.useEffect(() => {
        // 自检环境里的 document 是个只有几个方法的桩件，没有事件系统；
        // 不判一下，这个 effect 会在挂载时抛异常，把整块面板一起带崩
        const doc = typeof document === "undefined" ? null : document;
        if (typeof doc?.addEventListener !== "function") return undefined;
        const onPaste = (e) => {
          const items = e.clipboardData?.items ?? [];
          for (const it of items) {
            if (it.kind !== "file" || !/^image\//.test(it.type ?? "")) continue;
            const f = it.getAsFile();
            if (!f) continue;
            e.preventDefault();
            readImage(f);
            return;
          }
        };
        doc.addEventListener("paste", onPaste);
        return () => doc.removeEventListener("paste", onPaste);
        // readImage 只碰 setState（引用稳定），锁空依赖不会拿到过期闭包
      }, []);

      const cands = res?.candidates ?? [];
      const unmatched = res?.unmatched ?? [];
      const usable = probe?.ok !== false;

      const toggle = (code, on) => {
        setPick((s) => {
          const next = new Set(s);
          if (on) next.add(code); else next.delete(code);
          return next;
        });
        // 取消勾选要连持有标记一起撤掉：留着的话，一只没被选中的股票
        // 也会被写进 positions 标成持有，而它根本不在这次要加的名单里
        if (!on) setHeld((s) => {
          if (!s.has(code)) return s;
          const next = new Set(s);
          next.delete(code);
          return next;
        });
      };

      const toggleHeld = (code, on) => setHeld((s) => {
        const next = new Set(s);
        if (on) next.add(code); else next.delete(code);
        return next;
      });

      const submit = async () => {
        if (pick.size === 0 || adding) return;
        setAdding(true); setErr("");
        try {
          // 持有标记只报勾选中的那些：改了主意取消勾选的，不该在后台被标成持有
          const r = await onAdd([...pick], [...held].filter((c) => pick.has(c)));
          setDone({
            added: Number(r?.added) || 0,
            held: Number(r?.held) || 0,
          });
          setRes(null);
          setPick(new Set());
          setHeld(new Set());
        } catch (e) {
          setErr(String(e?.message ?? e));
        } finally {
          setAdding(false);
        }
      };

      /** 加完之后的说明。只报实际发生的事，不为凑一句好看的话去猜 */
      const doneText = () => {
        if (!done) return "";
        if (done.added > 0) {
          return fill(T("imgAdded"), done.added)
            + (done.held > 0 ? fill(T("imgAddedHeld"), done.held) : "");
        }
        // 一只都没新增说明这些本来就在自选里，此时唯一可能的改动就是持有标记
        return done.held > 0 ? T("imgAllPresent") : "";
      };

      const doneMsg = doneText();

      return h("div", { className: "skd-imgbox" },
        h("div", { className: "skd-imghead" },
          h("span", { className: "skd-imghint", title: T("hintFromImage") }, T("imgDrop")),
          h("button", { className: "skd-btn", type: "button", onClick: onClose }, T("imgClose"))),
        probe?.ok === false
          ? h(Msg, { text: T("imgOff"), err: true, hint: probe?.error ?? "" })
          : null,
        usable
          ? h("div", {
            className: "skd-imgdrop",
            onClick: () => fileRef.current?.click(),
            onDragOver: (e) => { e.preventDefault(); },
            onDrop: (e) => { e.preventDefault(); readImage(e.dataTransfer?.files?.[0]); },
          }, busy ? T("imgBusy") : T("imgDrop"))
          : null,
        h("input", {
          ref: fileRef, type: "file", accept: "image/png,image/jpeg,image/bmp,image/gif",
          style: { display: "none" },
          onChange: (e) => { readImage(e.target.files?.[0]); e.target.value = ""; },
        }),
        err ? h(Msg, { text: err, err: true }) : null,
        doneMsg ? h(Msg, { text: doneMsg }) : null,
        res ? (cands.length === 0
          ? h(Msg, { text: T("imgNone"), err: true, hint: (res.lines ?? []).join(" / ") })
          : h("div", { className: "skd-imglist" },
            // 一行两个勾选框，不能用外层 label 包：label 会把点击转给第一个 input，
            // 点「持有」会连带把「要不要加」也翻掉
            ...cands.map((c) => h("div", { key: c.code, className: "skd-imgrow" },
              h("label", { className: "skd-imgpick" },
                h("input", {
                  type: "checkbox", "data-pick": "1", checked: pick.has(c.code),
                  onChange: (e) => toggle(c.code, e.target.checked),
                }),
                h("span", { className: "skd-imgname" }, c.name || c.code),
                h("span", { className: "skd-code" }, c.code),
                c.kind === "fund" ? h("span", { className: "skd-tag" }, T("fundTag")) : null,
                h("span", {
                  className: "skd-tag",
                  title: c.matchedBy === "code" ? T("imgHintCode") : T("imgHintName"),
                }, c.matchedBy === "code" ? "代码" : "名称")),
              h("label", { className: "skd-imgheld", title: T("hintHeld") },
                h("input", {
                  type: "checkbox", "data-held": "1", checked: held.has(c.code),
                  onChange: (e) => toggleHeld(c.code, e.target.checked),
                }),
                h("span", null, T("held"))))))) : null,
        cands.length > 0
          ? h("div", { className: "skd-imgfoot" },
            h("span", { className: "skd-meta" },
              fill(T("imgFound"), cands.length),
              unmatched.length > 0 ? ` · ${fill(T("imgUnmatched"), unmatched.length)}` : ""),
            h("button", {
              className: "skd-btn", "data-primary": "1", type: "button",
              disabled: pick.size === 0 || adding, onClick: submit,
            }, adding ? T("imgAdding") : fill(T("imgAdd"), pick.size)))
          : null);
    }

    function Settings({ config, info, save, onMigrate }) {
      const [draft, setDraft] = React.useState(config);
      const [saved, setSaved] = React.useState(false);
      React.useEffect(() => setDraft(config), [config]);
      const setUi = (k, v) => setDraft((d) => ({ ...d, ui: { ...d.ui, [k]: v } }));
      const setPill = (k, v) => setDraft((d) => ({ ...d, pill: { ...d.pill, [k]: v } }));
      return h("div", { className: "skd-set" },
        h("label", { className: "skd-f" }, h("span", { className: "skd-f-l" }, T("colorScheme")),
          h("select", { className: "skd-select", value: draft.ui?.colorScheme ?? "auto",
            onChange: (e) => setUi("colorScheme", e.target.value) },
            h("option", { value: "auto" }, T("auto")),
            h("option", { value: "red-up" }, T("redUp")),
            h("option", { value: "green-up" }, T("greenUp")))),
        h("label", { className: "skd-f" }, h("span", { className: "skd-f-l" }, T("density")),
          h("select", { className: "skd-select", value: draft.ui?.density ?? "comfortable",
            onChange: (e) => setUi("density", e.target.value) },
            h("option", { value: "comfortable" }, T("comfortable")),
            h("option", { value: "compact" }, T("compact")))),
        h("div", { className: "skd-f" }, h("span", { className: "skd-f-l" }, T("pillIndex")),
          h("select", { className: "skd-select", value: draft.pill?.indexCode ?? "sh000001",
            onChange: (e) => setPill("indexCode", e.target.value) },
            ...(info?.indexCatalog ?? []).map((c) => h("option", { key: c.code, value: c.code }, `${c.name} ${c.code}`)))),
        h("div", { className: "skd-f" }, h("span", { className: "skd-f-l" }, T("configPath")),
          h("code", { className: "skd-path" }, info?.store?.path ?? "—")),
        h("div", { className: "skd-tools" },
          h("button", { className: "skd-btn", "data-primary": "1", type: "button",
            onClick: async () => { await save(draft); setSaved(true); setTimeout(() => setSaved(false), 1600); } },
            saved ? T("saved") : T("save")),
          h("button", { className: "skd-btn", type: "button", onClick: onMigrate }, T("migrate"))));
    }

    function DeskPage() {
      const { phase, data, error } = useDesk();
      const [tab, setTab] = React.useState("board");
      const [meta, setMeta] = React.useState(null);
      const [msg, setMsg] = React.useState("");
      // 图片识别面板开着没有。关掉就整个卸载，免得 document 上的粘贴监听一直挂着
      const [imgOpen, setImgOpen] = React.useState(false);
      // 只存代码，不存整条报价：存整条的话轮询刷新后明细会停在旧价格上，看起来像行情卡死了
      const [sel, setSel] = React.useState(null);
      /**
       * 临时拉回来的报价，给「点了不在自选里的股票」用。
       *
       * QuoteDetail 原本只在自选列表里按 code 找，找不到就渲染成空 ——
       * 而连板梯队里的股票绝大多数不在自选里，所以直接接 setSel 会点出一片空白。
       * 这里现拉一次 /quote，详情优先用它。
       *
       * 故意不用 useCallback：它要读当次渲染的 parts，锁成 [] 依赖会captured 第一帧的旧值。
       * 写成普通函数每次渲染重建，反而天然拿到最新的 parts。
       */
      const [picked, setPicked] = React.useState(null);
      // 指数条里展开了哪一只。指数不写进自选，所以它跟 sel/picked 是两条独立的展开路径
      const [idxPeek, setIdxPeek] = React.useState(null);
      const pickAny = async (code) => {
        if (!code) return;
        setSel(code);
        setPicked(null);
        // parts 在本函数下方才声明，但 pickAny 只在点击时执行，那时早就赋好值了
        if ((parts.watchlist?.items ?? []).some((x) => x.code === code)) return;
        try {
          const r = await api(`/quote?codes=${encodeURIComponent(code)}`);
          const q = (r?.items ?? [])[0] ?? null;
          setPicked(q);
          // 服务端会把裸 6 位归一化成 sz300911，sel 跟着用它，
          // 否则「点板块里的一只票」和「自选表里的代码」对不上，详情会找不到。
          if (q?.code) setSel(q.code);
        } catch { setPicked(null); /* 拉不到就退回空详情，不弹错 */ }
      };

      React.useEffect(() => {
        // 配置本身跟着 dashboard 一起来（宿主 handleDashboard 会附上 config），
        // 这里只单独取一次「配置存在哪、代码池多大」这类元信息，它几乎不变。
        api("/state").then(setMeta).catch(() => setMeta(null));
      }, []);

      // 顺序不能反。原先是 data?.config ?? meta?.config —— 但 save() 更新的是 meta.config，
      // 而 data 是轮询回来的快照（盘后 60 秒一轮），于是点「移除」后界面纹丝不动，
      // 看起来像没生效，其实早已落盘（实测 POST /config 立刻返回新列表、重新 GET 也是新的）。
      // meta.config 既来自 /state 也来自保存响应，永远是较新的那一份。
      const cur = meta?.config ?? data?.config ?? null;

      /**
       * 迁移旧插件的自选。
       *
       * 旧键里存的是旧插件自己的结构，宿主 normalizeConfig 认这个形状；
       * 解析失败就当没有 —— 一个坏掉的旧键不该把整页搞崩。
       */
      const migrate = React.useCallback(async () => { setMsg(await migrateLegacy()); }, []);

      React.useEffect(() => {
        let raw = null;
        try { raw = window.localStorage.getItem(LEGACY_KEY); } catch { raw = null; }
        // 只在首次进页面时自动跑一次，之后由设置页的按钮手动触发
        if (raw) migrate();
      }, []);

      const save = async (next) => {
        const r = await api("/config", { config: next });
        // 宿主回的是 {config, notes, store}，不是整份 state，所以只覆盖这几段
        setMeta((s) => ({ ...(s ?? {}), config: r.config, store: r.store }));
      };

      /**
       * 改配置的一个片段并保存。
       *
       * 持仓/监控的输入框失焦时走这里。失败要把原因显示出来 ——
       * 静默失败的话用户以为改好了，下次刷新又变回去。
       */
      const patchConfig = async (patch) => {
        if (!cur) return;
        try { await save({ ...cur, ...patch }); }
        catch (err) { setMsg(String(err?.message ?? err)); }
      };

      /** 自选分组；配置被改坏时退化成第一组，不让整块自选凭空消失 */
      const watchGroup = cur?.groups?.find((g) => g.id === "watch") ?? cur?.groups?.[0] ?? null;
      const withGroup = (fn) => {
        if (!cur || !watchGroup) return null;
        const groups = cur.groups.map((g) => (g.id === watchGroup.id ? { ...g, items: fn(g.items ?? []) } : g));
        return { ...cur, groups };
      };
      const addCode = async (it) => {
        if (!watchGroup || (watchGroup.items ?? []).includes(it.code)) return;
        const next = withGroup((items) => [...items, it.code]);
        if (next) await save(next);
      };
      /**
       * 一次加入多只（图片识别出来的候选）。
       *
       * 必须一次 POST 全部写进去：patchConfig 走的是整份配置覆盖，
       * 逐只保存会互相把对方冲掉，最后只剩最后一只。
       *
       * @param {string[]} codes 要加入自选的代码
       * @param {string[]} [heldCodes] 其中要同时标成「持有」的代码
       * @returns {Promise<{added: number, held: number}>} 新增只数与新增的持有标记数
       */
      const addCodes = async (codes, heldCodes = []) => {
        if (!watchGroup) return { added: 0, held: 0 };
        const have = new Set(watchGroup.items ?? []);
        const add = (codes ?? []).filter((c) => c && !have.has(c));
        const markHeld = (heldCodes ?? []).filter(Boolean);
        if (add.length === 0 && markHeld.length === 0) return { added: 0, held: 0 };
        let next = withGroup((items) => [...items, ...add]);
        if (!next) return { added: 0, held: 0 };
        // 持有标记与自选名单是两件事，必须并进同一份配置一起提交
        if (markHeld.length > 0) next = { ...next, positions: withHeld(next.positions, markHeld) };
        await save(next);
        return { added: add.length, held: markHeld.length };
      };
      const removeCode = async (code) => {
        const next = withGroup((items) => items.filter((x) => x !== code));
        if (!next) { setMsg(`${T("remove")}：${T("unavailable")}`); return; }
        try {
          await save(next);
        } catch (err) {
          // 存不上必须说出来。原先这里没有 catch，POST 失败会被静默吞掉，
          // 表现和「按钮坏了」一模一样 —— 用户没法区分是没生效还是没保存。
          setMsg(`${T("remove")}：${T("unavailable")} ${err?.message ?? err}`);
        }
      };

      const session = data?.session;
      const parts = data?.parts ?? {};
      /**
       * 自选表显示哪几只，以配置为准，不以轮询快照为准。
       *
       * 原先 list 直接取 parts.watchlist.items —— 那是 60 秒前的快照（盘后 60 秒一轮）。
       * 点「移除」后配置立刻就变了，表格却要等下一轮轮询才变，看起来就是「点了没反应」。
       * 上一轮我只改了 cur 的读取顺序，但表格根本不吃 cur，所以等于没修。
       *
       * 现在的分工：配置说了算「有哪几只」，快照只负责「数字是多少」。
       * 刚加进来还没轮询到的股票，先用代码占位，下一轮快照到了自然补上。
       */
      const quoteOf = new Map((parts.watchlist?.items ?? []).map((q) => [q.code, q]));
      const watchRows = (watchGroup?.items ?? []).map((code) => quoteOf.get(code) ?? { code, name: code });
      // 当前选中的那条报价。优先用刚拉回来的临时报价（点了不在自选里的股票），
      // 否则在 watchRows 里找 —— 注意不是 parts.watchlist，刚移除的那只在快照里还在。
      // 必须放在 watchRows 之后：放在前面会踩 TDZ（Cannot access before initialization），
      // 而且这种错误只在整页真的渲染时才炸，纯函数自检发现不了。
      const selQ = (picked?.code === sel ? picked : null) ?? watchRows.find((x) => x.code === sel) ?? null;

      // 电脑通知的权限状态。浏览器不支持时同步降级成 unsupported，按钮据此禁用并说明原因。
      /**
       * 逐行编辑状态。
       *
       * editCode = null 表示整表只读（输入框根本不存在，杜绝误触）；非 null 表示
       * 只有这一行变成输入框，改的是 editDraft —— 里面**只装这一行**。
       *
       * 为什么要拆成两个状态：草稿只含当前行，点「保存」时按行合并回整份配置，
       * 别的行即便在编辑期间被轮询刷新过也不会被这份草稿覆盖。
       *
       * 为什么不让输入框直接改 config：那样每敲一个字符就打一次保存接口，
       * 而且轮询回来会把正在编辑的值冲掉。
       */
      const [editCode, setEditCode] = React.useState(null);
      const [editDraft, setEditDraft] = React.useState(null);
      /** 进入某一行的编辑态：草稿只拷这一行的持仓与监控，别的行不参与 */
      const beginEdit = (code) => {
        setEditDraft(rowEditDraft(cur, code));
        setEditCode(code);
      };
      /** 保存这一行：按行并回整份配置再提交，队列里别的行原样不动 */
      const saveEdit = async (code) => {
        const target = code ?? editCode;
        if (!target) return;
        await patchConfig(mergeEditDraft(cur, target, editDraft));
        setEditCode(null);
        setEditDraft(null);
      };
      const cancelEdit = () => { setEditCode(null); setEditDraft(null); };
      // 每秒跳动一次，用来把「距下次刷新还有几秒」算出来。
      // 不用 setInterval 去改数据，只改一个时间戳 —— 重渲染代价很小。
      const [nowMs, setNowMs] = React.useState(() => Date.now());
      React.useEffect(() => {
        const id = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(id);
      }, []);
      // 客户端自己记「这一批数据是几点到的」，不用服务器的 at，
      // 免得两边时钟有偏差时倒计时一开始就是负数
      const [lastAt, setLastAt] = React.useState(0);
      const dataAt = data?.at;
      React.useEffect(() => { if (dataAt) setLastAt(Date.now()); }, [dataAt]);

      const [notifyPerm, setNotifyPerm] = React.useState(() => {
        // 某些上下文（非安全来源、被策略限制的 iframe）里，光是读 Notification.permission
        // 就会抛 SecurityError。它跑在 useState 的初始化函数里，一抛整个组件就没了 ——
        // 表现是「整个行情台一片黑」，而且没有任何提示。所以这里必须包起来。
        try {
          if (typeof Notification === "undefined") return "unsupported";
          return Notification.permission;
        } catch { return "unsupported"; }
      });
      const enableNotify = async () => {
        try {
          if (typeof Notification === "undefined") { setNotifyPerm("unsupported"); return; }
          setNotifyPerm(await Notification.requestPermission());
        } catch { setNotifyPerm("denied"); }
      };

      /**
       * 价格监控：只在「跨过阈值的那一刻」弹通知。
       *
       * 为什么不每轮都弹：价格停在阈值下方时，10 秒一轮会一直弹，用户第一件事就是关掉通知。
       * 所以记住每只票上一次的状态（low / high / null），只有状态变了才弹。
       * 状态放 ref 而不是 state：它不该触发重渲染，也不该被快照覆盖。
       */
      const alertMemo = React.useRef({});
      React.useEffect(() => {
        // 整个 effect 再包一层：effect 里抛出的异常会冒到错误边界，
        // 在浏览器里表现为整块面板消失。行情显示绝不该因为通知失败而消失。
        try {
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        const alerts = cur?.alerts ?? {};
        for (const q of parts.watchlist?.items ?? []) {
          const a = alerts[q.code];
          if (!a) continue;
          const price = nOr(F(q).price);
          if (price === null) continue;
          const was = alertMemo.current[q.code] ?? null;
          const now = a.low !== undefined && price <= a.low ? "low"
            : a.high !== undefined && price >= a.high ? "high" : null;
          if (now && now !== was) {
            try {
              // 写成两个字面量 T("…") 而不是三元：自检的「用了没声明」扫描只认字面量，
              // 三元里的键名它看不见，会把这两个词条误报成多余的
              const title = now === "low" ? T("notifyTitleLow") : T("notifyTitleHigh");
              new Notification(`${q.name ?? q.code} ${title}`, {
                body: `${T("price")} ${num(price)}`,
                tag: `stock-desk-${q.code}-${now}`,
              });
            } catch { /* 通知弹不出来不该影响行情显示 */ }
          }
          alertMemo.current[q.code] = now;
        }
        } catch { /* 通知这条链路无论怎么坏都不该影响行情渲染 */ }
      }, [data?.at]);
      const scheme = cur?.ui?.colorScheme ?? "auto";
      const density = cur?.ui?.density ?? "comfortable";

      return h("div", {
        className: "skd-root skd-page",
        "data-scheme": scheme === "auto" ? "" : scheme,
        "data-density": density,
      },
      h("header", { className: "skd-head" },
        h("h1", { className: "skd-h1" }, T("title")),
        h("span", { className: "skd-meta" },
          session ? T(SESSION_LABEL[session.id] ?? "trading") : "",
          data?.at ? ` · ${T("snapshot")} ${hhmmss(data.at)}` : "",
          phase === "stale" ? ` · ${T("stale")}` : ""),
        error ? h("span", { className: "skd-meta skd-err" }, error) : null,
        msg ? h("span", { className: "skd-meta" }, msg) : null),

      h("div", { className: "skd-tabs" },
        h("button", { className: "skd-tab", "data-on": tab === "board" ? "1" : "0", type: "button",
          onClick: () => setTab("board") }, T("title")),
        h("button", { className: "skd-tab", "data-on": tab === "set" ? "1" : "0", type: "button",
          onClick: () => setTab("set") }, T("settings"))),

      tab === "set"
        ? h(Card, { title: T("settings") },
          cur ? h(Settings, {
            config: cur,
            info: { store: meta?.store, universe: meta?.universe, indexCatalog: data?.indexCatalog },
            save,
            onMigrate: migrate,
          }) : h(Msg, { text: T("loading") }))
        : h(React.Fragment, null,
          // 大盘指数与涨跌家数并排一行：左边指数（要宽度铺 6 个格子），
          // 右边涨跌家数和成交额（本来就矮，给个窄列就够）。
          // 点开某个指数的明细时整行切成单列（data-peek="1"），
          // 否则 K 线挤在左半边只剩一半宽，还不如让它占满。
          h("div", { className: "skd-row2", "data-peek": idxPeek ? "1" : "0" },
            h(Card, { title: T("indices") },
              h(IndexStrip, {
                catalog: data?.indexCatalog, quotes: parts.indices?.items,
                onPick: setIdxPeek, active: idxPeek,
              }),
              // 点哪个指数就在指数条下面展开它的明细与 K 线
              idxPeek ? h("div", { className: "skd-peek" }, h(StockPeek, {
                code: idxPeek, onClose: () => setIdxPeek(null),
              })) : null),
            h(Card, { title: T("breadth") }, h(BreadthBar, { breadth: parts.breadth }))),
          h(Card, { title: T("limitUp") }, h(LimitGrid, {
            overview: parts.overview, ladder: parts.ladder, pools: parts.limitPools, onPick: pickAny,
          })),
          h(Card, { title: T("sectors") },
            h(BoardGrid, { rank: parts.boardRank, onPick: pickAny })),
          h(Card, {
            title: T("watchlist"),
            // 搜索 + 刷新间隔 + 通知 + 编辑开关，都挂在这一张卡上
            extra: h("div", { className: "skd-tools" },
              // 倒计时、刷新间隔、通知状态讲的是同一件事（这张表多久刷一次、刷了没有），
              // 裹进一个不换行的组：卡头空间不够时整组挪到下一行，而不是把倒计时挤走。
              h("div", { className: "skd-toolgroup" },
                h(RefreshMeter, {
                  remainSec: nextRefreshSec(lastAt, cur?.ui?.pollSec, nowMs),
                  updatedAt: clockText(data?.at),
                }),
                h(MonitorBar, {
                  pollSec: cur?.ui?.pollSec ?? 10,
                  onPoll: (n) => patchConfig({ ui: { ...(cur?.ui ?? {}), pollSec: n } }),
                  notify: notifyPerm,
                  onEnableNotify: enableNotify,
                })),
              h(SearchBox, { onPick: addCode }),
              // 图片入口排在搜索框右边：两者都是「往自选里加东西」，
              // 手打的路径在前、贴图的路径在后，符合「先试最简单的」的使用顺序
              h("button", {
                className: "skd-btn", type: "button", title: T("hintFromImage"),
                "data-on": imgOpen ? "1" : "0",
                // 自检要能在一堆带 data-on 的按钮里唯一定位到它，好断言它排在搜索框之后
                "data-img": "1",
                onClick: () => setImgOpen((v) => !v),
              }, T("fromImage"))),
          },
            imgOpen ? h(ImageImport, { onAdd: addCodes, onClose: () => setImgOpen(false) }) : null,
            // 自选表与详情也改成左右分栏：以前点一行，详情在表格下方长出来，
            // 看完 K 线还要滚回来点下一只。这里和板块/涨停下钻用的是同一个 SplitView。
            h("div", { className: "skd-drill-body", style: { paddingTop: 0 } },
              splitView(selQ ? h(QuoteDetail, {
                q: selQ,
                onClose: () => { setSel(null); setPicked(null); },
              }) : null, [
                // 编辑态 / 没填过持仓时各给一句提示，放在表格上方
                editCode
                  ? h("div", { className: "skd-meta skd-hold-hint" }, T("holdingsEditing"))
                  : (Object.keys(cur?.positions ?? {}).length === 0 && Object.keys(cur?.alerts ?? {}).length === 0
                    ? h("div", { className: "skd-meta skd-hold-hint" }, T("holdingsHint")) : null),
                h(QuoteTable, {
                  list: watchRows, watch: true, onRemove: removeCode, onPick: setSel,
                  config: cur, editingCode: editCode, draft: editDraft,
                  onChange: (kind, code, field, raw) =>
                    setEditDraft((d) => applyDraftEdit(d, kind, code, field, raw)),
                  onEdit: beginEdit, onSave: saveEdit, onCancel: cancelEdit,
                }),
              ]))),
          h(SourceBar, { sources: data?.sources })));
    }

    /**
     * 崩溃兜底。
     *
     * 为什么必须有：插件面板里任何一个组件抛错，React 会把整棵子树卸载掉 ——
     * 用户看到的是「整个行情台一片黑，啥也看不到」，既不能自愈，也没法告诉我哪里坏了。
     * 包一层之后至少能把错误信息显示出来，下一轮就有线索可查。
     *
     * 用 class 而不是函数组件：错误边界只能靠 getDerivedStateFromError 实现，没有 hook 版本。
     */
    class DeskBoundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null }; }
      static getDerivedStateFromError(err) { return { err }; }
      render() {
        if (this.state.err) {
          return h("div", { className: "skd-root skd-page" },
            h(Msg, {
              text: `${T("crashTitle")}：${String(this.state.err?.message ?? this.state.err)}`,
              err: true,
              hint: T("crashHint"),
            }));
        }
        return this.props.children;
      }
    }

    /** 面板入口：包一层错误边界，任何渲染异常都不会变成黑屏 */
    function DeskSafe(props) {
      return h(DeskBoundary, null, h(DeskPage, props));
    }

    function DeskButton({ active }) {
      useDesk();
      return h("button", { className: "skd-s-btn", "data-on": active ? "1" : "0", type: "button" },
        h("svg", { className: "skd-s-ico", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
          strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
          h("path", { d: "M2.6 20.4h18.8" }),
          h("path", { d: "M6.8 16.2v-5" }), h("rect", { x: "5", y: "11.2", width: "3.6", height: "3.4", rx: "0.8" }),
          h("path", { d: "M12 14.6V6.2" }), h("rect", { x: "10.2", y: "6.2", width: "3.6", height: "4.6", rx: "0.8" }),
          h("path", { d: "M17.2 11.4V3.6" }), h("rect", { x: "15.4", y: "3.6", width: "3.6", height: "5.4", rx: "0.8" })),
        h("span", null, T("title")));
    }

    /**
     * 常驻药丸。
     *
     * 位置写在 localStorage 里而不是宿主配置里：它属于「这台浏览器上的摆放」，
     * 换台机器不该跟着走，也不该污染 agent 会读的那份自选股配置。
     */
    function Pill() {
      const { data } = useDesk();
      const [pos, setPos] = React.useState(() => {
        try {
          const raw = window.localStorage.getItem("stock-desk.pill");
          return raw ? JSON.parse(raw) : null;
        } catch { return null; }
      });
      const [hidden, setHidden] = React.useState(() => {
        try { return window.localStorage.getItem("stock-desk.pill.hidden") === "1"; } catch { return false; }
      });
      const drag = React.useRef(null);

      if (hidden) return null;
      // 药丸显示哪个指数跟着配置走，没配置就取目录里的第一个
      const code = data?.config?.pill?.indexCode ?? data?.indexCatalog?.[0]?.code ?? "sh000001";
      const cat = (data?.indexCatalog ?? []).find((c) => c.code === code);
      const q = (data?.parts?.indices?.items ?? []).find((x) => x.code === code);
      const wl = data?.parts?.watchlist?.items ?? [];
      const up = wl.filter((x) => nOr(F(x).changePct) > 0).length;
      const dn = wl.filter((x) => nOr(F(x).changePct) < 0).length;

      const style = pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : undefined;

      const onDown = (e) => {
        if (e.target?.dataset?.role === "close") return;
        const box = e.currentTarget.getBoundingClientRect();
        drag.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      };
      const onMove = (e) => {
        if (!drag.current) return;
        const p = { x: `${e.clientX - drag.current.dx}px`, y: `${e.clientY - drag.current.dy}px` };
        setPos(p);
      };
      const onUp = () => {
        if (!drag.current) return;
        drag.current = null;
        try { window.localStorage.setItem("stock-desk.pill", JSON.stringify(pos)); } catch { /* 存不下就算了 */ }
      };

      return h("div", {
        className: "skd-root skd-pill", style,
        onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp,
        title: data?.at ? `${T("snapshot")} ${hhmmss(data.at)}` : "",
      },
      h("span", { className: "skd-pill-n" }, cat?.name ?? "—"),
      h("span", { className: `skd-up`, style: { fontWeight: 600 } }, q ? num(F(q).price) : "—"),
      h("span", { className: dir(F(q).changePct) }, q ? pct(F(q).changePct) : "—"),
      h("span", { className: "skd-pill-n" }, `↑${up} ↓${dn}`),
      h("button", {
        className: "skd-pill-x", "data-role": "close", type: "button", title: T("remove"),
        onClick: () => {
          setHidden(true);
          try { window.localStorage.setItem("stock-desk.pill.hidden", "1"); } catch { /* 同上 */ }
        },
      }, "\u00d7"));
    }
    //#endregion

    /**
     * 把旧插件留在 localStorage 里的自选搬到宿主，返回一句给用户看的话。
     *
     * 抽成模块级是因为有两个入口会触发它：整页里的设置页签，和 settings.plugins.tab
     * 那个独立配置页。两处各写一份的话，早晚有一处会忘记删掉旧键，于是每次进页面都重导一遍 ——
     * 而重导本身不报错，只是数据慢慢变脏，没人会发现。
     */
    async function migrateLegacy() {
      let raw = null;
      try { raw = window.localStorage.getItem(LEGACY_KEY); } catch { raw = null; }
      if (!raw) return `${T("migrate")}：0`;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return `${T("migrate")}：${T("unavailable")} 旧数据不是合法 JSON`; }
      try {
        const r = await api("/migrate", { legacy: parsed });
        // 迁移成功后删掉旧键，否则每次进页面都会重导一遍
        try { window.localStorage.removeItem(LEGACY_KEY); } catch { /* 隐私模式下删不掉，忽略 */ }
        return `${T("migrate")}：+${r?.found ?? 0}`;
      } catch (err) {
        return `${T("migrate")}：${T("unavailable")} ${err.message}`;
      }
    }

    /**
     * 设置 → 插件 → 行情台 那个页签里挂的配置页。
     *
     * 为什么不复用整页里那个设置页签：整页的配置来自 dashboard 随附回来的 config 字段，
     * 而设置页是另一个入口 —— 用户完全可能从没打开过行情台就直接进设置，
     * 那一刻 dashboard 还没拉过。所以这里必须自己把 /state 取回来，不能指望那边已经取好。
     */
    function SettingsTab() {
      const [meta, setMeta] = React.useState(null);
      const [msg, setMsg] = React.useState("");
      const [err, setErr] = React.useState("");
      const snap = useDesk();
      const data = snap.data;

      React.useEffect(() => {
        api("/state").then(setMeta).catch((e) => setErr(String(e?.message ?? e)));
      }, []);

      // 顺序不能反。原先是 data?.config ?? meta?.config —— 但 save() 更新的是 meta.config，
      // 而 data 是轮询回来的快照（盘后 60 秒一轮），于是点「移除」后界面纹丝不动，
      // 看起来像没生效，其实早已落盘（实测 POST /config 立刻返回新列表、重新 GET 也是新的）。
      // meta.config 既来自 /state 也来自保存响应，永远是较新的那一份。
      const cur = meta?.config ?? data?.config ?? null;
      const save = async (next) => {
        try {
          const r = await api("/config", { config: next });
          // 宿主回的是 {config, notes, store}，不是整份 state，所以只覆盖这几段
          setMeta((s) => ({ ...(s ?? {}), config: r.config, store: r.store }));
          setErr("");
        } catch (e) { setErr(String(e?.message ?? e)); }
      };

      if (!cur) return h(Msg, { text: err ? `${T("unavailable")} ${err}` : T("loading") });

      return h("div", { className: "skd-root skd-page" },
        msg ? h("div", { className: "skd-meta" }, msg) : null,
        err ? h("div", { className: "skd-meta skd-err" }, err) : null,
        h(Card, { title: T("settings") },
          h(Settings, {
            config: cur,
            info: { store: meta?.store, universe: meta?.universe, indexCatalog: data?.indexCatalog },
            save,
            onMigrate: async () => setMsg(await migrateLegacy()),
          })));
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-stock-desk.client.locale");
      ctx.effect(() => {
        if (document.querySelector('style[data-plugin-css="dsh-stock-desk/client"]') !== null) return () => {};
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-stock-desk";
        tag.dataset.pluginCss = "dsh-stock-desk/client";
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => tag.remove();
      }, "dsh-stock-desk.client.styles");

      // 必须先注册语言包再取翻译函数：bind 是惰性的，但注册前查不到自己的词条会原样显示 key
      T = ctx.locale.bind(NS);

      // 侧边栏条目的 id 要和 main 的 key 一致，点按钮才会打开自己那一页。
      // label 必须传函数而不是求值后的字符串：槽位目录写明 thunk 每次投影都会重新读，
      // 传字符串则切换语言后按钮文字会僵在旧语言上（实测过这个描述，见 docs）。
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
        // order 刻意用一个不常见的 77：它是构建标记。刷新后可以用 Slots Inspect 查实时注册表，
        // 读到的不是 77 就说明浏览器还在跑旧 bundle。这轮「卡在正在取数」就是靠它排除掉
        // 「缓存没刷新」这个可能性的 —— 浏览器报的正是 77，所以代码是新的，问题在别处。
        { name: "sidebar.panellist", id: NS, order: 78, label: () => T("title") }, DeskButton));
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: NS }, DeskSafe));
      // shell.overlay 也是 list 槽位，目录里把 id 标成 required。
      // 这条一开始漏了 id —— 本地桩件不做 schema 校验所以从没报错，
      // 真实运行时槽位注册会失败，表现就是药丸永远不出现，而且没有任何提示。
      ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: NS, order: 30 }, Pill));
      // 方案 §8 客户端清单第 ④ 条点名的就是 settings.plugins.tab。
      // 一开始做成了整页里的一个页签 —— 能用，但用户找插件设置时的第一反应是
      // 「设置 → 插件」，那里没有就会以为根本没做配置页。实测该槽位存在（内置占位者只有 all）。
      ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register(
        { name: "settings.plugins.tab", id: NS, order: 20, label: () => T("settings") }, SettingsTab));
    }

    // __test 只给自检用。槽位注册拿到的是 React 组件，其中带 hook 的（DeskPage / Pill）
    // 在 Node 里没法直接调；表格与明细是纯函数，挂在这里就能断言它们的输出 ——
    // 方案 §8 那条「指数明细不得出现换手率 / 市盈率 / 市净率 / 涨跌停价 / 委比」
    // 靠肉眼在浏览器里点两遍是靠不住的，必须能机器判定。
    return {
      inject: ["slots", "locale"],
      apply,
      __test: {
        QuoteTable, QuoteDetail, IndexStrip, fieldText, stampText,
        positionRows, rangeRatio, orderRatio, cashText, money,
        MonitorBar, DeskBoundary, DeskSafe, applyDraftEdit,
        // 逐行编辑的两个纯函数：草稿只装一行、保存按行合并。
        // 这两条逻辑埋在 DeskPage 闭包里就测不到，而它们决定「保存会不会顺手改掉别的行」。
        rowEditDraft, mergeEditDraft,
        RefreshMeter, nextRefreshSec, todayKey, quoteDate, clockText,
        // 降级分支也要能渲染出来才算数：某个板块维度整段缺失时不能把整块画成空白。
        // 光看源码里写了 Array.isArray(x) ? x : [] 不算验过。
        BreadthBar, LimitGrid,
        // 板块格子：BoardGrid 是三 tab + 一张格子墙，BoardDrill 是它下面的分页成分股表。
        // 两个都靠 useDesk / api 取数，所以断言走 mountLive 的桩件运行时。
        BoardGrid, BoardDrill,
        // K 线：klineChart 是纯函数，能拿真实返回的 candles 直接喂，
        // 不必等 fetch —— 空数组 / 单根 / 缺字段这些最容易崩的分支才测得到。
        Kline, klineChart, minuteChart, chartPick, chartYTicks, CH, DEFAULT_BARS, MIN_BARS, ZOOM_STEP,
        zoomWindow, panWindow,
        // desk 是为了让自检能先喂一份数据再渲染。useDesk 读的是 desk.get()，
        // 所以离开这个入口，「药丸显示上证点位 + 涨跌幅 + 涨跌家数」这条验收就只能靠肉眼。
        desk, DeskPage, DeskButton, Pill,
        // 配置页现在有两个入口，独立那个要能单独渲染出来才算数 ——
        // 它自己取 /state，跟整页那条路径不共享状态，整页绿了不代表它也绿。
        SettingsTab,
        // 图片识别面板：三个分支（能识别 / 本机没有 OCR / 认出候选）都得能渲染出来。
        // 「没装语言包时按钮点了没反应」这种故障，只靠肉眼点一次是碰不到的。
        ImageImport, fill,
        // 持有标记的合并：它只加 held、不动成本价与份额，
        // 走 applyDraftEdit 会把用户填好的数值当成待改字段一起覆盖 —— 这两条必须分开验
        withHeld,
      },
    };
  },
});
