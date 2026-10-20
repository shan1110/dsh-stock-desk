/**
 * 全 A 股代码池与检索
 *
 * 代码池由 tools/build-universe.mjs 生成后随包分发，不在运行时联网拉取：
 * 实测东财 clist 有 100 条硬上限、拉全 5924 只要 60 个请求且会被限流；
 * 腾讯虽然稳定但要暴力枚举 15000 个候选号。两者都不适合放进运行路径。
 * 代码池变动很慢（每天最多几只新股），按需重新生成即可。
 *
 * @author cai shan
 * @date 2026-10-19 14:58
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 代码池文件路径：随包的 data/universe.json */
const DEFAULT_FILE = join(import.meta.dirname, '..', 'data', 'universe.json');

export function createUniverse(opts = {}) {
  const file = opts.file ?? DEFAULT_FILE;
  /** @type {{code: string, name: string}[]|null} */
  let list = null;
  /** 场内基金（ETF/LOF）。只进搜索，不进全市场扫描与涨跌家数 */
  let funds = [];
  /** @type {Map<string, string>|null} code -> name */
  let byCode = null;
  let meta = null;
  let loadError = null;

  async function ensure() {
    if (list) return list;
    try {
      const text = await readFile(file, 'utf8');
      const json = JSON.parse(text);
      const stocks = Array.isArray(json.stocks) ? json.stocks : [];
      list = stocks.filter((s) => typeof s?.code === 'string' && s.code);
      funds = (Array.isArray(json.funds) ? json.funds : [])
        .filter((f) => typeof f?.code === 'string' && f.code);
      // 名称表把基金也装进来：加自选时还没轮询到，占位要用名字而不是裸代码
      byCode = new Map([...list, ...funds].map((s) => [s.code, s.name ?? '']));
      meta = {
        generatedAt: json.generatedAt ?? '',
        count: list.length,
        fundCount: funds.length,
        marketCount: json.marketCount ?? {},
      };
    } catch (err) {
      loadError = err.message;
      list = [];
      funds = [];
      byCode = new Map();
      meta = { generatedAt: '', count: 0, fundCount: 0, marketCount: {} };
    }
    return list;
  }

  return {
    /**
     * 全部【股票】代码（不含北交所，也不含场外基金）。
     *
     * 这个池子专门喂全市场扫描（涨跌家数、涨停池）。刻意不掺基金 ——
     * ETF 不是个股，算进涨跌家数会把口径搞乱。
     * 搜索走 search()，那里是股票 + 基金。
     */
    async all() {
      return ensure();
    },

    async info() {
      await ensure();
      return { ...meta, file, error: loadError };
    },

    /** 代码 -> 名称；查不到返回 null，调用方据此回落到实时接口给的名称 */
    async nameOf(code) {
      await ensure();
      return byCode.get(code) ?? null;
    },

    /**
     * 股票 + 场内基金，每条带 kind。
     *
     * 给图片识别用：截图上的 ETF 与个股长得一样，只匹配股票会把 159558 漏掉。
     * 与 search() 的区别是这里不做查询过滤，只交出全量目录，由调用方自己匹配。
     */
    async catalog() {
      await ensure();
      return [
        ...list.map((s) => ({ code: s.code, name: s.name ?? '', kind: 'stock' })),
        ...funds.map((f) => ({ code: f.code, name: f.name ?? '', kind: 'fund' })),
      ];
    },

    /**
     * 按代码或名称检索，用于「添加自选」的输入框。
     *
     * 匹配规则：代码前缀命中优先级最高，其次是名称包含查询串。
     * 纯数字查询按名称匹配——用户输入 600519 时既想按代码找也想按名称找，
     * 但代码是精确的，所以先试代码。
     *
     * @param {string} query
     * @param {number} [limit]
     */
    async search(query, limit = 20) {
      await ensure();
      const q = String(query ?? '').trim();
      if (!q) return [];
      const lower = q.toLowerCase();

      // 股票与场内基金一起搜：用户会想加 ETF，只搜股票等于功能缺一半。
      // 每条带 kind，前端据此标出「基金」，免得 510300 和 600519 看起来一样。
      const byCodeHit = [];
      const byNameHit = [];
      const scan = (arr, kind) => {
        for (const s of arr) {
          if (s.code.includes(lower) || s.code.slice(2).startsWith(lower)) {
            byCodeHit.push({ ...s, kind });
          } else if (s.name && s.name.includes(q)) {
            byNameHit.push({ ...s, kind });
          }
        }
      };
      scan(list, 'stock');
      scan(funds, 'fund');
      // 代码前缀命中优先于名称包含：输入 510300 时用户要的是那只基金，不是名字里带这几个字的
      return [...byCodeHit, ...byNameHit].slice(0, limit);
    },
  };
}
