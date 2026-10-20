/**
 * dsh-stock-desk —— A 股行情工作台（宿主侧）
 *
 * 这个插件替代 dsh-stock-watch。替代的理由不是界面好不好看，而是三件具体的事：
 * 1. 旧插件往提示词里注入「每日复盘」「涨停分析」这类考卷，要求模型报出涨停家数、
 *    炸板率、连板高度，却一个 agent 工具都没注册 —— 模型手上没有数据，只能编。
 *    本插件注册 7 个工具（lib/tools.js），把课本给到模型。
 * 2. 旧插件把配置存在浏览器 localStorage，宿主读不到，于是「让 agent 分析我的自选」
 *    这件事结构上做不到。本插件把配置挪到 profile 目录下的 JSON（lib/store.js）。
 * 3. 旧插件只注册 shell.overlay 一个槽位，信息量被 400px 面板卡死。
 *    本插件用 sidebar.panellist + main 出一整页（client.js）。
 *
 * @author cai shan
 * @date 2026-10-19 16:24
 */

import { createCache } from './lib/cache.js';
import { createMarket } from './lib/market.js';
import { createOcr } from './lib/ocr.js';
import { createStore } from './lib/store.js';
import { registerRoutes } from './lib/routes.js';
import { registerStockTools } from './lib/tools.js';

/**
 * 依赖的宿主服务。
 *
 * webServer 注册 HTTP 接口，tools 注册 agent 工具。两个都声明，
 * 缺任何一个都不激活 —— 半激活的行情插件会让界面显示空数据，比不激活更难查。
 */
export const inject = ['webServer', 'tools'];

// 刻意不声明 Config。
// 本插件的配置存在 profile 目录下的 config.json（见 lib/store.js 的 resolveDataDir），
// 不写进 Cordis 的行配置。声明一个自己都不读的 schema，只是给激活多添一个失败点。

/**
 * @param {object} ctx Cordis 上下文
 */
export function apply(ctx) {
  const cache = createCache();
  const store = createStore();
  // 接口与工具共用同一份缓存与健康度：agent 刚问过的行情，界面刷新时不会重复打一次上游
  const market = createMarket({ cache });
  // OCR 只被 HTTP 接口用到，不进 market：它不联网、也不参与行情缓存
  const ocr = createOcr();

  ctx.effect(() => registerRoutes(ctx, {
    market,
    store,
    ocr,
    // 可选依赖：问得到就顺带回一句「客户端半边有没有接进启动图」，
    // 问不到（宿主没这个服务）不影响任何正事，所以用 get 而不是写进 inject
    clientModules: ctx.get('clientModules'),
  }), 'dsh-stock-desk.routes');
  ctx.effect(() => registerStockTools(ctx, market, store), 'dsh-stock-desk.tools');
}
