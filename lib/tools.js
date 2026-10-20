/**
 * agent 工具注册
 *
 * 为什么要有这一批工具：
 * 现状 dsh-stock-watch 没有任何 agent 工具（只 inject 了 webServer），
 * 却往提示词里注入了「每日复盘」「涨停分析」这类考卷，要求模型报出涨停家数、
 * 炸板率、连板高度、板块分布。模型手上没有这些数据，只能编。
 * 这批工具的职责就是「给课本」——让模型拿得到真数据，因此不必编。
 *
 * 设计原则：
 * 1. 每条输出都带取数时刻与数据源健康度，避免模型把收盘价当实时价讲。
 * 2. 拿不到就明确说拿不到，绝不返回编造的占位数字。
 * 3. render 里给的是人可读的完整文本——模型看到的就是这一段，结构化值只做内部传递。
 *
 * @author cai shan
 * @date 2026-10-19 15:26
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { INDEX_CODES, TTL } from './market.js';
import { analyze, alignLabel, MA_PERIODS } from './indicators.js';
import { condName } from './baserates.js';
import { collectAnalysis } from './analysis.js';
import {
  fmtPrice, fmtPct, fmtPctAbs, fmtByUnit, fmtTime, fmtApiTime, provenance, stalenessNote,
} from './format.js';

/** 字段展示顺序：按「看盘的先后顺序」排，而不是按接口字段号排 */
const FIELD_ORDER = [
  'open', 'prevClose', 'high', 'low',
  'volume', 'amount', 'avgPrice',
  'turnover', 'volRatio', 'amplitude',
  'pe', 'peDyn', 'peStatic', 'pb',
  'totalCap', 'floatCap',
  'limitUp', 'limitDown', 'orderDiff',
  'outer', 'inner',
];

/**
 * 字段单位表；与 lib/tencent.js 的 SPEC 一一对应，这里只用于格式化。
 *
 * 只有涨跌幅（changePct）用带符号的 'pct'。振幅与换手率恒非负，
 * 走 'pctAbs'，否则会输出「振幅 +2.08%」这种把正号当方向信息的多余写法。
 */
const FIELD_UNIT = {
  price: 'price', prevClose: 'price', open: 'price', high: 'price', low: 'price',
  change: 'price', changePct: 'pct', amplitude: 'pctAbs', amount: 'wan',
  totalCap: 'yi', floatCap: 'yi', volume: 'hand', avgPrice: 'price',
  volRatio: 'num', turnover: 'pctAbs', limitUp: 'price', limitDown: 'price',
  orderDiff: 'num', pe: 'num', peDyn: 'num', peStatic: 'num', pb: 'num',
  outer: 'num', inner: 'num',
};

/** 每种品种在详情文本里叫法不同，模型据此就知道这是只什么 */
const KIND_LABEL = { stock: '个股', index: '指数', etf: 'ETF', hk: '港股', unknown: '未知品种' };

const KIND_LABEL_EN = { stock: 'Stock', index: 'Index', etf: 'ETF', hk: 'HK equity', unknown: 'Unknown' };

/** 把一条报价渲染成文本块 */
function renderQuote(q) {
  const f = q.fields ?? {};
  const head = `${q.name} ${q.code}  [${KIND_LABEL[q.kind] ?? q.kind}]`;
  const lines = [head, `现价 ${fmtPrice(f.price, q.kind)}   涨跌 ${fmtPrice(f.change, q.kind)}  ${fmtPct(f.changePct)}`];

  const detail = [];
  for (const key of FIELD_ORDER) {
    if (!(key in f)) continue;
    detail.push(`${FIELD_LABELS_CN[key] ?? key} ${fmtByUnit(f[key], FIELD_UNIT[key], q.kind)}`);
  }
  if (detail.length) lines.push(detail.join('   '));

  if (q.limit) {
    const tags = [];
    if (q.limit.atLimitUp) tags.push('已涨停');
    if (q.limit.atLimitDown) tags.push('已跌停');
    if (q.limit.burst) tags.push('曾涨停现打开（炸板）');
    if (tags.length) lines.push(`状态 ${tags.join('、')}`);
  }

  if (q.ladder) {
    const fmt = (arr, tag) => arr.map((x) => `${tag}${x.volume}档 ${fmtPrice(x.price, q.kind)}×${x.volume}`).join('  ');
    lines.push('卖盘 ' + (q.ladder.asks.length ? [...q.ladder.asks].reverse().map((x, i) => `卖${5 - i} ${fmtPrice(x.price, q.kind)}×${x.volume}`).join('  ') : '无'));
    lines.push('买盘 ' + (q.ladder.bids.length ? q.ladder.bids.map((x, i) => `买${i + 1} ${fmtPrice(x.price, q.kind)}×${x.volume}`).join('  ') : '无'));
  } else if (q.kind === 'index') {
    lines.push('（指数没有五档盘口）');
  }

  lines.push(`行情时间 ${fmtApiTime(q.time)}`);
  return lines.join('\n');
}

/** 字段中文名；与 lib/tencent.js 的 FIELD_LABELS 同义，宿主侧单独维护一份避免循环依赖 */
const FIELD_LABELS_CN = {
  open: '今开', prevClose: '昨收', high: '最高', low: '最低',
  volume: '成交量', amount: '成交额', avgPrice: '均价',
  turnover: '换手率', volRatio: '量比', amplitude: '振幅',
  pe: '市盈率(TTM)', peDyn: '市盈率(动)', peStatic: '市盈率(静)', pb: '市净率',
  totalCap: '总市值', floatCap: '流通市值',
  limitUp: '涨停价', limitDown: '跌停价', orderDiff: '委差',
  outer: '外盘', inner: '内盘', change: '涨跌额', changePct: '涨跌幅',
};

/** 统一的空数据措辞。明确说「拿不到」，不给模型留编造空间 */
function unavailable(what, err) {
  return `${what} 拿不到。\n原因：${err instanceof Error ? err.message : String(err)}\n`
    + `不要据此推测数值；可以稍后重试，或改用其它工具。`;
}

/**
 * 构造工具定义数组。
 *
 * 与注册分离是为了能在 DSH 之外直接跑：defineTool 是 DSH 内部符号，外部 import 不到，
 * 但 execute 与 render 本身不依赖 ctx，脱离宿主就能测它们的文本产出。
 * 而工具的产出就是那段文本——只能等装完再从对话里瞟一眼的话，
 * 列宽错位、字段名写错这类问题会极难发现。
 *
 * @param {object} market 组合层
 * @param {object} store 配置仓库
 * @returns {object[]} 工具定义数组
 */
export function buildToolDefs(market, store) {
  /** 由 exec 推出一个可取消的 signal */
  const sig = (exec) => exec?.signal;

  return [
  // ---------------------------------------------------------------- 报价
  {
    name: 'stock_quote',
    description:
      '取 A 股个股 / 指数 / ETF 的实时报价快照，含五档盘口与涨跌停价。'
      + '返回的字段按品种过滤过：指数不会有市盈率、换手率、涨跌停价。',
    parameters: {
      codes: {
        type: 'string',
        required: true,
        description: '代码，多个用英文逗号分隔。支持 sh600519、600519、600519.SH 三种写法。一次最多 20 个。',
      },
    },
    output: { schema: OUT_SCHEMA, render: (_a, v) => v.blocks },
    async execute(args, exec) {
      const list = String(args.codes ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
      if (list.length === 0) return fail('没有给出任何代码。');
      try {
        const [res, sess] = await Promise.all([market.quotes(list, { signal: sig(exec) }), market.session({ signal: sig(exec) })]);
        if (res.items.length === 0) {
          return fail(`这些代码都取不到行情：${list.join('、')}。\n`
            + `可能原因：代码不存在、已退市、或属于暂不支持的品种（如港股）。`);
        }
        const body = res.items.map(renderQuote).join('\n\n');
        const missingLine = res.missing.length ? `\n\n以下代码取不到：${res.missing.join('、')}` : '';
        const text = `${provenance(sess, res.at, market.health())}\n\n${body}${missingLine}${stalenessNote(sess, res.at)}`;
        return { blocks: [{ type: 'text', text }], count: res.items.length, missing: res.missing };
      } catch (err) {
        return fail(unavailable('行情', err));
      }
    },
  },

  // ---------------------------------------------------------------- 大盘总览
  {
    name: 'market_overview',
    description:
      'A 股大盘与市场情绪总览：主要指数、全市场涨跌家数、涨停/跌停/炸板家数、封板率、交易状态。'
      + '同时给出两个口径的涨停家数；两者不一致时以同花顺口径为准。',
    parameters: {
      breadth: {
        type: 'boolean',
        description: '是否扫描全市场统计涨跌家数。默认 true；只要指数和涨停概览时可以设为 false 以加快返回。',
      },
    },
    output: { schema: OUT_SCHEMA, render: (_a, v) => v.blocks },
    async execute(args, exec) {
      const wantBreadth = args.breadth !== false;
      const dash = await market.dashboard({
        codes: [],
        include: { breadth: wantBreadth, sectors: false, sectorHeat: false, ladder: false },
        signal: sig(exec),
      });
      const at = dash.at;
      const sess = dash.session;
      const lines = [provenance(sess, at, dash.sources), ''];

      const idx = dash.parts.indices;
      if (idx?.items?.length) {
        lines.push('【主要指数】');
        for (const q of idx.items) {
          const f = q.fields ?? {};
          lines.push(`  ${pad(q.name, 10)} ${fmtPrice(f.price, q.kind).padStart(10)}  ${fmtPct(f.changePct).padStart(8)}   `
            + `今开 ${fmtPrice(f.open, q.kind)}  最高 ${fmtPrice(f.high, q.kind)}  最低 ${fmtPrice(f.low, q.kind)}`);
        }
      } else {
        lines.push(`【主要指数】${dash.errors.indices ?? '拿不到'}`);
      }
      lines.push('');

      const br = dash.parts.breadth;
      if (wantBreadth && br) {
        lines.push('【涨跌家数】本机扫描腾讯行情，覆盖全市场');
        lines.push(`  上涨 ${br.up} · 下跌 ${br.down} · 平盘 ${br.flat}   共统计 ${br.counted} 只`
          + (br.missing > 0 ? `（${br.missing} 只未取到）` : ''));
        lines.push(`  涨停 ${br.limitUp} · 跌停 ${br.limitDown} · 炸板 ${br.burst}`);
      } else if (wantBreadth) {
        lines.push(`【涨跌家数】${dash.errors.breadth ?? '拿不到'}`);
      } else {
        lines.push('【涨跌家数】本次未扫描（breadth=false）');
      }
      lines.push('');

      const ov = dash.parts.overview;
      if (ov) {
        const lt = ov.limitUp?.today, ld = ov.limitDown?.today;
        lines.push(`【同花顺口径】${ov.date || ''}`);
        lines.push(`  涨停 ${lt?.num ?? '—'} 家 · 炸板 ${lt?.openNum ?? '—'} 家 · 封板率 ${fmtPctAbs((lt?.rate ?? 0) * 100)}`
          + `   （昨日涨停 ${ov.limitUp?.yesterday?.num ?? '—'} 家）`);
        lines.push(`  跌停 ${ld?.num ?? '—'} 家`);
      } else {
        lines.push(`【同花顺口径】${dash.errors.overview ?? '拿不到'}`);
      }

      lines.push('', `轮询建议间隔 ${dash.pollMs} ms（盘中 3 秒，非盘中 60 秒）`);
      lines.push(stalenessNote(sess, at));
      return { blocks: [{ type: 'text', text: lines.join('\n') }], count: idx?.items?.length ?? 0 };
    },
  },

  // ---------------------------------------------------------------- 涨停
  {
    name: 'limit_up_board',
    description: 'A 股涨停与连板梯队：涨停/跌停/炸板家数、封板率、各高度的连板个股名单，以及板块涨停分布。',
    parameters: {
      detail: {
        type: 'boolean',
        description: '是否列出炸板池明细与板块涨停分布。默认 true。',
      },
      full: {
        type: 'boolean',
        description: '是否列出梯队、炸板池与板块榜的全部个股，而不是只列前若干个。默认 false。',
      },
    },
    output: { schema: OUT_SCHEMA, render: (_a, v) => v.blocks },
    async execute(args, exec) {
      const wantDetail = args.detail !== false;
      const full = args.full === true;
      try {
        const r = await Promise.allSettled([
          market.overview({ signal: sig(exec) }),
          market.ladder({ signal: sig(exec) }),
          wantDetail ? market.brokeList({ limit: full ? 100 : 40, signal: sig(exec) }) : Promise.resolve(null),
          wantDetail ? market.sectorHeat({ signal: sig(exec) }) : Promise.resolve(null),
          market.session({ signal: sig(exec) }),
        ]);
        const [ovR, laR, brR, secR, sessR] = r;
        const sess = sessR.status === 'fulfilled' ? sessR.value : null;
        const at = Date.now();
        const lines = [provenance(sess, at, market.health()), ''];

        if (ovR.status === 'fulfilled') {
          const lt = ovR.value.limitUp?.today, ld = ovR.value.limitDown?.today;
          lines.push('【涨跌停概览】');
          lines.push(`  涨停 ${lt?.num ?? '—'} 家 · 历史涨停 ${lt?.historyNum ?? '—'} 家 · 炸板 ${lt?.openNum ?? '—'} 家 · 封板率 ${fmtPctAbs((lt?.rate ?? 0) * 100)}`);
          lines.push(`  跌停 ${ld?.num ?? '—'} 家 · 昨日涨停 ${ovR.value.limitUp?.yesterday?.num ?? '—'} 家   数据日期 ${ovR.value.date || '—'}`);
        } else {
          lines.push(`【涨跌停概览】${ovR.reason?.message ?? '拿不到'}`);
        }
        lines.push('');

        if (laR.status === 'fulfilled') {
          const ladder = laR.value;
          lines.push('【连板梯队】');
          if (ladder.length === 0) {
            lines.push('  今日没有 2 板及以上的连板个股。');
          } else {
            const totalCont = ladder.reduce((a, r) => a + r.number, 0);
            lines.push(`  最高 ${ladder[0].height} 板 · 连板共 ${totalCont} 家`);
            for (const r of ladder) {
              const cap = full ? r.stocks.length : 12;
              const names = r.stocks.slice(0, cap).map((s) => `${s.code.slice(2)} ${s.name}`).join(' · ');
              lines.push(`  ${r.height} 板（${r.number} 家）：${names}`
                + (r.stocks.length > cap ? ` … 另有 ${r.stocks.length - cap} 家，加 full=true 可取回` : ''));
            }
            if (ovR.status === 'fulfilled' && Number.isFinite(ovR.value.limitUp?.today?.num)) {
              const first = ovR.value.limitUp.today.num - totalCont;
              lines.push(`  首板：${first} 家（推算值 = 涨停总数 ${ovR.value.limitUp.today.num} - 连板 ${totalCont}）`);
            }
          }
        } else {
          lines.push(`【连板梯队】${laR.reason?.message ?? '拿不到'}`);
        }
        lines.push('');

        if (wantDetail) {
          if (brR.status === 'fulfilled' && brR.value) {
            lines.push(`【炸板池】共 ${brR.value.total} 家（当日曾涨停、收盘前未封住）`);
            const cap = full ? brR.value.items.length : 20;
            const items = brR.value.items.slice(0, cap);
            lines.push('  ' + items.map((i) => `${i.code.slice(2)} ${i.name}`).join(' · ')
              + (brR.value.items.length > cap ? ` … 另有 ${brR.value.items.length - cap} 家，加 full=true 可取回` : ''));
            lines.push('');
          } else if (brR.status === 'rejected') {
            lines.push(`【炸板池】${brR.reason?.message ?? '拿不到'}`, '');
          }

          if (secR.status === 'fulfilled' && secR.value) {
            lines.push('【板块涨停分布】按板块内涨停家数排序');
            const cap = full ? secR.value.length : 12;
            for (const s of secR.value.slice(0, cap)) {
              lines.push(`  ${pad(s.name, 14)} 涨停 ${String(s.limitUpNum ?? '—').padStart(3)} 家 · 连板 ${String(s.continuousNum ?? '—').padStart(2)} 家 · 最高 ${s.high || '—'}`);
            }
            if (secR.value.length > cap) lines.push(`  … 另有 ${secR.value.length - cap} 个板块，加 full=true 可取回`);
          } else if (secR.status === 'rejected') {
            lines.push(`【板块涨停分布】${secR.reason?.message ?? '拿不到'}`);
          }
        }

        return { blocks: [{ type: 'text', text: lines.join('\n') }], ok: true };
      } catch (err) {
        return fail(unavailable('涨停数据', err));
      }
    },
  },

  // ---------------------------------------------------------------- 板块
  {
    name: 'sector_rank',
    description:
      '板块涨跌幅排行榜，含板块涨跌幅、主力净流入、板块内涨跌家数、领涨股。'
      + '板块涨跌幅与个股涨跌幅不是同一套计算口径，不要混着排序。',
    parameters: {
      board: {
        type: 'string',
        description: 'industry = 行业板块（默认），concept = 概念板块。',
      },
      direction: {
        type: 'string',
        description: 'up = 涨幅榜（默认），down = 跌幅榜。',
      },
      limit: {
        type: 'number',
        description: '返回条数，默认 12，最大 50。',
      },
    },
    output: { schema: OUT_SCHEMA, render: (_a, v) => v.blocks },
    async execute(args, exec) {
      const board = args.board === 'concept' ? 'concept' : 'industry';
      const direction = args.direction === 'down' ? 'down' : 'up';
      const limit = Math.min(Math.max(Number(args.limit) || 12, 1), 50);
      try {
        const [res, sess] = await Promise.all([
          market.sectors({ board, direction, limit, signal: sig(exec) }),
          market.session({ signal: sig(exec) }),
        ]);
        const at = Date.now();
        const lines = [provenance(sess, at, market.health()), ''];
        lines.push(`【${board === 'industry' ? '行业' : '概念'}板块${direction === 'up' ? '涨幅' : '跌幅'}榜】共 ${res.total} 个板块，下列 ${res.items.length} 个`);
        for (const s of res.items) {
          const inflow = Number.isFinite(s.mainNetInflow) ? `${(s.mainNetInflow / 1e8).toFixed(2)} 亿` : '—';
          lines.push(`  ${pad(s.name, 16)} ${fmtPct(s.changePct).padStart(9)}   主力 ${inflow.padStart(10)}   `
            + `涨/跌 ${s.upCount ?? '—'}/${s.downCount ?? '—'}   领涨 ${s.leader || '—'}`);
        }
        return { blocks: [{ type: 'text', text: lines.join('\n') }], total: res.total };
      } catch (err) {
        return fail(unavailable('板块榜', err));
      }
    },
  },

  // ---------------------------------------------------------------- K 线
  {
    name: 'stock_kline',
    description: '取个股 / 指数 / ETF 的 K 线，含区间统计与最近若干根明细。',
    parameters: {
      code: { type: 'string', required: true, description: '代码，如 sh600519 或 600519。' },
      period: { type: 'string', description: 'day（默认）/ week / month / 1m / 5m / 15m / 30m / 60m' },
      limit: { type: 'number', description: '根数，默认 60，最大 800（日 / 周 / 月；分钟线另有上限）。' },
    },
    output: { schema: OUT_SCHEMA, render: (_a, v) => v.blocks },
    async execute(args, exec) {
      const code = String(args.code ?? '').trim();
      if (!code) return fail('没有给出代码。');
      const period = String(args.period ?? 'day');
      const limit = Math.min(Math.max(Number(args.limit) || 60, 1), 800);
      try {
        const [kl, sess] = await Promise.all([
          market.kline(code, { period, limit, signal: sig(exec) }),
          market.session({ signal: sig(exec) }),
        ]);
        if (kl.candles.length === 0) {
          return fail(`${code} 取不到 K 线数据。\n可能原因：代码不存在、已退市，或该周期无成交。`);
        }
        const at = Date.now();
        const c = kl.candles;
        const first = c[0], last = c[c.length - 1];
        const highs = c.map((x) => x.high).filter(Number.isFinite);
        const lows = c.map((x) => x.low).filter(Number.isFinite);
        const vols = c.map((x) => x.volume).filter(Number.isFinite);
        const totalChg = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : null;
        const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;

        const lines = [provenance(sess, at, market.health()), ''];
        lines.push(`【${kl.name || code} ${code}】${period === 'day' ? '日线' : period === 'week' ? '周线' : period === 'month' ? '月线' : period} · ${c.length} 根 · 前复权`);
        lines.push(`  区间 ${first.date} → ${last.date}`);
        lines.push(`  区间开盘 ${first.open} → 最新收盘 ${last.close}   区间涨跌 ${fmtPct(totalChg)}`);
        lines.push(`  区间最高 ${Math.max(...highs)}   区间最低 ${Math.min(...lows)}   均量 ${Number.isFinite(avgVol) ? Math.round(avgVol) : '—'} 手`);
        // 分钟线的 ATR / MA250 没有分析意义（250 根 1 分钟 K 只有半天），所以只给日/周/月。
        // 这一段的价值在于「排列、位置、波动」由代码算好，模型不必自己看图估。
        if (period === 'day' || period === 'week' || period === 'month') {
          const ind = analyze(c);
          if (ind) {
            const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
            lines.push('');
            lines.push('  技术指标');
            lines.push(`    均线 ${MA_PERIODS.map((n) => `MA${n} ${f2(ind.ma[`ma${n}`])}`).join('  ')}`);
            lines.push(`    距均线 ${MA_PERIODS.map((n) => `MA${n} ${fmtPct(ind.distMa[`ma${n}`])}`).join('  ')}`);
            lines.push(`    排列 ${alignLabel(ind.align)}   ATR14 ${f2(ind.atr)}（${f2(ind.atrPct)}%）   量比 ${f2(ind.volRatio5)}（末根量 ÷ 前 5 根均量）`);
            lines.push(`    区间位置 60根 ${f2(ind.pos.d60)}%   120根 ${f2(ind.pos.d120)}%   250根 ${f2(ind.pos.d250)}%`);
          }
        }
        lines.push('');
        lines.push('  最近 12 根（日期 开 高 低 收 涨跌幅 成交量/手）');
        for (const k of c.slice(-12)) {
          lines.push(`    ${k.date}  ${pad(String(k.open), 9)} ${pad(String(k.high), 9)} ${pad(String(k.low), 9)} ${pad(String(k.close), 9)}  ${fmtPct(k.changePct).padStart(8)}  ${k.volume ?? '—'}`);
        }
        return { blocks: [{ type: 'text', text: lines.join('\n') }], count: c.length };
      } catch (err) {
        return fail(unavailable('K 线', err));
      }
    },
  },

  // ---------------------------------------------------------------- 单股分析
  {
    name: 'stock_analysis',
    description:
      '单只股票的事实表：技术指标、历史形态频率（含非重叠样本量、基准、95% 区间）、'
      + '位置表、四条判定（形态边缘 / 位置 / 触发 / 盈亏比）、加仓位与止损止盈。'
      + '所有数字与判定都由代码给出；引用时只写编号与已有数字，不要自行加减或改判方向。',
    parameters: {
      code: { type: 'string', required: true, description: '代码，如 sz002739 或 002739。' },
    },
    output: { schema: OUT_SCHEMA, render: (_a, v) => v.blocks },
    async execute(args, exec) {
      const code = String(args.code ?? '').trim();
      if (!code) return fail('没有给出代码。');
      try {
        // 组装逻辑在 lib/analysis.js：agent 工具与 HTTP 接口共用同一份，
        // 否则两边迟早给出互相矛盾的结论（谁是负边缘、谁是「无信号」）
        const got = await collectAnalysis({ market, store }, code, { signal: sig(exec) });
        if (!got.ok) return fail(got.error);
        const A = got.data;
        const sess = A.session;
        const { ind, levels, plan, exit } = A;
        const hitsDay = A.hits.day;
        const hitsWeek = A.hits.week;
        const primaryCond = A.primary;
        const trig = A.trigger;
        // 渲染沿用「按 id 查基准」的写法，这里把数组还原成同形的表
        const table = { rows: A.rows, meta: A.meta, base: Object.fromEntries(A.baselines.map((b) => [b.id, b])) };

        const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
        const pct0 = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : '—');
        const at = Date.now();
        const L = [provenance(sess, at, market.health()), ''];

        L.push(`【${A.name} ${code}】日线 ${A.bars} 根（${A.from} → ${A.to}）  现价 ${f2(ind.close)}`);
        L.push(`  均线 MA5 ${f2(ind.ma.ma5)}  MA10 ${f2(ind.ma.ma10)}  MA20 ${f2(ind.ma.ma20)}  MA60 ${f2(ind.ma.ma60)}  MA120 ${f2(ind.ma.ma120)}  MA250 ${f2(ind.ma.ma250)}`);
        L.push(`  排列 ${alignLabel(ind.align)}   距均线 MA20 ${fmtPct(ind.distMa.ma20)}  MA60 ${fmtPct(ind.distMa.ma60)}  MA250 ${fmtPct(ind.distMa.ma250)}`);
        // 盘中的量按已成交算，必须说明，否则「量比 0.3」会被当成缩量
        const volTag = A.partialDay ? '，盘中未走完，偏低' : '';
        L.push(`  ATR14 ${f2(ind.atr)}（${f2(ind.atrPct)}%）   量比 ${f2(ind.volRatio5)}（末根量 ÷ 前 5 根均量${volTag}）`);
        L.push(`  区间位置 60根 ${f2(ind.pos.d60)}%   120根 ${f2(ind.pos.d120)}%   250根 ${f2(ind.pos.d250)}%`);
        L.push('');

        // ---- 历史频率：只列有方向的格子 + 今日命中形态的所有持有期
        L.push('【历史形态频率】区间为 95% Wilson 区间；n 为非重叠样本；基准与条件用同一段样本');
        const baseLines = Object.values(table.base)
          .filter((b) => b.n > 0)
          .map((b) => `${b.id} ${pct0(b.upPct)}（相位 ${b.phaseRange?.[0]}~${b.phaseRange?.[1]}%）`);
        L.push(`  基准：${baseLines.join('   ')}`);
        L.push('  id          条件      口径      胜率   n     区间        基准   判定');
        const showRows = table.rows.filter((r) => r.judge === 'pos' || r.judge === 'neg'
          || (primaryCond && r.cond === primaryCond));
        if (showRows.length === 0) L.push('  （没有任何一个格子的区间越过基准；也就是说这套形态在这只票上没有可用的边缘）');
        for (const r of showRows) {
          const unit = r.period === 'week' ? '周' : '日';
          L.push(`  ${pad(r.id, 12)}${pad(condName(r.cond), 10)}${pad(`${r.horizon}${unit}`, 9)}${pad(pct0(r.upPct), 6)}${pad(r.n, 7)}${pad(r.ci ? `${Math.round(r.ci[0])}~${Math.round(r.ci[1])}%` : '—', 13)}${pad(pct0(r.base), 7)}${judgeLabel(r.judge)}`);
        }
        if (showRows.length > 0 && showRows.length < table.rows.length) {
          L.push(`  （其余 ${table.rows.length - showRows.length} 个格子的区间都跨过基准，判为无信号，未列出）`);
        }
        const hitTag = A.partialDay ? '（盘中，收盘前会变）' : '';
        L.push(`  今日命中：日线 ${hitsDay.length ? hitsDay.map(condName).join('、') : '无'}；周线 ${hitsWeek.length ? hitsWeek.map(condName).join('、') : '无'}${hitTag}`);
        L.push(`  检验次数 ${table.meta.tests}（条件事先定死，不做事后挑选；多重检验后只能说「有迹象」）`);
        L.push('');

        // ---- 位置表
        L.push('【位置表】现价下方的支撑与上方的压力，都带编号，引用时写编号');
        for (const x of levels.items) {
          L.push(`  ${pad(x.id, 10)}${pad(f2(x.price), 9)}${pad(x.side === 'support' ? '支撑' : x.side === 'resistance' ? '压力' : '持平', 6)}距现价 ${fmtPct(x.distPct)}${Number.isFinite(x.distAtr) ? `（${x.distAtr.toFixed(1)} 倍 ATR）` : ''}  ${x.note}`);
        }
        L.push('');

        // ---- 四条判定
        L.push('【能不能加仓】四条同时成立才给加仓位，否则不给');
        const fourLines = [
          ['形态边缘', plan.four.edge, plan.detail.edge.note],
          ['位置', plan.four.pos, plan.detail.pos.note],
          ['触发', plan.four.trigger, plan.detail.trigger.note],
          ['盈亏比', plan.four.ratio, plan.detail.ratio.note],
        ];
        fourLines.forEach(([name, ok, note], i) => {
          L.push(`  ${i + 1}) ${pad(name, 10)}${ok ? '成立' : '不成立'}  ${note}`);
        });
        L.push(plan.ok
          ? `  → 加仓位 ${f2(plan.addZone)}（${plan.addZoneId}）  止损 ${f2(plan.stop)}  止盈 ${f2(plan.target)}  盈亏比 ${plan.ratio}:1`
          : `  → 当前没有符合条件的加仓位（卡在：${plan.addWhy.map(whyLabel).join('、')}）`);
        L.push('');

        // ---- 止损与止盈
        L.push('【止损与止盈】');
        if (exit.stop !== null) L.push(`  止损 ${f2(exit.stop)}（依据 ${exit.stopId ?? 'ATR 缓冲'}，${exit.stopNote}）`);
        if (exit.target1 !== null) L.push(`  止盈一 ${f2(exit.target1)}（${exit.target1Id}）  止盈二 ${f2(exit.target2)}（${exit.target2Id}）`);
        if (exit.trail) L.push(`  移动止盈：收盘跌破 MA10 ${f2(exit.trail.ma10)} 减半，跌破 MA20 ${f2(exit.trail.ma20)} 清仓`);
        L.push('');
        L.push('【读法】历史频率不等于未来概率；区间跨过基准的格子等于没有信号。'
          + '未覆盖：财报、资金流、龙虎榜、公告。');

        return {
          blocks: [{ type: 'text', text: L.join('\n') }],
          table,
          levels,
          plan,
          exit,
          hits: { day: hitsDay, week: hitsWeek },
        };
      } catch (err) {
        return fail(unavailable('单股分析', err));
      }
    },
  },

  // ---------------------------------------------------------------- 自选股
  {
    name: 'stock_watchlist',
    description: '读取用户的自选股分组。只读，不会修改用户的自选股。',
    parameters: {
      include_quotes: {
        type: 'boolean',
        description: '是否同时取这些自选股的实时报价。默认 false，只看分组时可以不开。',
      },
    },
    output: { schema: OUT_SCHEMA, render: (_a, v) => v.blocks },
    async execute(args, exec) {
      try {
        const cfg = await store.load();
        const info = store.info();
        const all = cfg.groups.flatMap((g) => g.items);
        const lines = [`配置文件 ${info.path}（解析规则 ${info.rule}）`];
        if (info.notes.length) lines.push(...info.notes.map((n) => `  · ${n}`));
        lines.push('');
        for (const g of cfg.groups) {
          lines.push(`【${g.name}】${g.items.length} 只`);
          lines.push('  ' + (g.items.join(' · ') || '（空）'));
        }
        lines.push('', `共 ${all.length} 只自选`);

        if (args.include_quotes && all.length) {
          const [res, sess] = await Promise.all([
            market.quotes(all, { signal: sig(exec) }),
            market.session({ signal: sig(exec) }),
          ]);
          lines.push('', provenance(sess, res.at, market.health()), '');
          for (const q of res.items) {
            const f = q.fields ?? {};
            lines.push(`  ${pad(q.name, 10)} ${pad(q.code, 9)} ${fmtPrice(f.price, q.kind).padStart(10)}  ${fmtPct(f.changePct).padStart(8)}`);
          }
          if (res.missing.length) lines.push(`  取不到：${res.missing.join('、')}`);
        }
        return { blocks: [{ type: 'text', text: lines.join('\n') }], groups: cfg.groups.length, path: info.path };
      } catch (err) {
        return fail(unavailable('自选股配置', err));
      }
    },
  },

  ];
}

/**
 * 注册全部工具到宿主。
 *
 * @param {object} ctx Cordis 上下文
 * @param {object} market 组合层
 * @param {object} store 配置仓库
 * @returns {() => void} 卸载函数
 */
export function registerStockTools(ctx, market, store) {
  const disposers = buildToolDefs(market, store).map((d) => ctx.tools.register(defineTool(d)));
  return () => { for (const d of disposers) d(); };
}

/**
 * 输出 schema。
 *
 * 刻意写得宽松：这些工具的价值在 render 产出的文本里，结构化值只是内部传递。
 * 把 schema 收紧成 required 全部字段，只会让某个分支少返回一个字段就整条工具报错，
 * 那是拿可用性换一个模型根本看不到的校验。
 */
const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    blocks: {
      type: 'array',
      description: '给模型看的文本块',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: { type: { type: 'string' }, text: { type: 'string' } },
      },
    },
  },
};

/** 统一的失败返回：同样走 blocks，模型能看到原因，不会以为工具没被调用 */
function fail(text) {
  return { blocks: [{ type: 'text', text }] };
}

/** 四条件的英文键 -> 人话。给用户看的东西不写 edge / ratio 这种键名 */
const WHY_LABEL = { edge: '形态边缘', pos: '位置', trigger: '触发', ratio: '盈亏比' };
function whyLabel(k) { return WHY_LABEL[k] ?? k; }

/** 边缘判定的中文说法。与 baserates.judge 的四个返回值一一对应 */
function judgeLabel(j) {
  switch (j) {
    case 'pos': return '正边缘';
    case 'neg': return '负边缘';
    case 'none': return '无信号';
    default: return '样本不足';
  }
}

/** 按显示宽度右侧补空格。中文按 2 列算，否则列对不齐 */
function pad(s, width) {
  const str = String(s ?? '');
  let w = 0;
  for (const ch of str) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return str + ' '.repeat(Math.max(0, width - w));
}

export const TOOL_NAMES = ['stock_quote', 'market_overview', 'limit_up_board', 'sector_rank', 'stock_kline', 'stock_analysis', 'stock_watchlist'];
export { INDEX_CODES, TTL };
export const KIND_LABELS = KIND_LABEL_EN;
