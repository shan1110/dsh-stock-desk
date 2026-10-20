/**
 * lib/boards.js 的真实数据自检。
 *
 * 为什么要连真实站点跑：这个模块的全部逻辑都是「解析别人家的 HTML」，
 * 用假数据测只能证明我自己的正则和我自己的假数据自洽。
 *
 * 跑法：& $node tools/test-boards.mjs
 *
 * @author cai shan
 * @date 2026-10-19 16:50
 */

import {
  parseIndustryRank,
  parseConstituents,
  fetchIndustryRank,
  fetchHotBoards,
  fetchBoardMap,
  fetchBoardStocks,
} from '../lib/boards.js';

/** 现在是不是没开盘。板块数据未开盘时是残缺的，断言要跳过 */
async function isClosedNow() {
  try {
    const r = await fetch('http://127.0.0.1:8820/api/stock-desk/state');
    const j = await r.json();
    const s = j?.data?.session ?? j?.data?.config?.session;
    if (s && typeof s.trading === 'boolean') return !s.trading;
  } catch { /* 服务没起就从时钟判断 */ }
  const d = new Date();
  const hm = d.getHours() * 60 + d.getMinutes();
  return hm < 9 * 60 + 30 || hm >= 15 * 60;
}

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}

/** 解析器的纯函数部分：手工构造一段和真实页面同构的 HTML */
function selfTestParsers() {
  console.log('\n[1] 解析器纯函数自检');
  const industryHtml = `<tbody>
    <tr><td>1</td><td><a href="http://q.10jqka.com.cn/thshy/detail/code/881174/">厨卫电器</a></td>
    <td class="c-rise">2.80</td><td>120.30</td><td>14.72</td><td>0.42</td>
    <td class="c-rise">7</td><td class="c-fall">2</td><td>12.24</td>
    <td><a href="http://stockpage.10jqka.com.cn/300911/">亿田智能</a></td>
    <td class="c-rise">33.23</td><td class="c-rise">18.34</td></tr>
  </tbody><span class="page_info">1/2</span>`;
  const r = parseIndustryRank(industryHtml);
  check('行业榜解析出 1 行', r.items.length === 1, `实得 ${r.items.length}`);
  check('行业榜代码取自 detail/code 而非领涨股链接', r.items[0]?.code === '881174', `实得 ${r.items[0]?.code}`);
  check('行业榜涨跌幅是数字 2.8', r.items[0]?.changePct === 2.8, `实得 ${r.items[0]?.changePct}`);
  check('行业榜涨跌家数 7/2', r.items[0]?.upCount === 7 && r.items[0]?.downCount === 2,
    `实得 ${r.items[0]?.upCount}/${r.items[0]?.downCount}`);
  check('行业榜领涨股名称', r.items[0]?.leader?.name === '亿田智能', `实得 ${r.items[0]?.leader?.name}`);
  check('行业榜分页 1/2', r.page === 1 && r.totalPages === 2, `实得 ${r.page}/${r.totalPages}`);

  // 关键回归：成分股必须取「成分股涨跌排行榜」之后的那张表。
  // 之前直接取页面第一张表，遇到 300816 会抓到概念图谱那张，只出 1 行。
  const decoy = `<h2>概念图谱</h2><table><tbody>
      <tr><td>假</td><td>000000</td><td>干扰行</td><td>1</td><td>1</td><td>1</td></tr>
    </tbody></table>`;
  const real = `<h2>成分股涨跌排行榜</h2><table class="m-table"><tbody>
      <tr><td>1</td><td>301119</td><td>正强股份</td><td>34.31</td><td>20.01</td><td>5.72</td><td>0.00</td><td>21.83</td><td>2.51</td><td>20.51</td><td>23.13亿</td></tr>
      <tr><td>2</td><td>301313</td><td>凡拓数创</td><td>39.00</td><td>20.00</td><td>6.50</td><td>0.00</td><td>11.00</td><td>1.10</td><td>10.00</td><td>5.00亿</td></tr>
    </tbody></table><span class="page_info">1/123</span>`;
  const c = parseConstituents(decoy + real);
  check('成分股只取标题后那张表（不被概念图谱干扰）', c.items.length === 2, `实得 ${c.items.length}`);
  check('成分股首行代码 301119', c.items[0]?.code === '301119', `实得 ${c.items[0]?.code}`);
  check('成分股首行涨跌幅 20.01', c.items[0]?.changePct === 20.01, `实得 ${c.items[0]?.changePct}`);
  check('成分股分页 1/123', c.page === 1 && c.totalPages === 123, `实得 ${c.page}/${c.totalPages}`);
  check('没有标题时返回 found=false 而不是编数据', parseConstituents('<table><tbody></tbody></table>').found === false);

  // `--` 是空值占位，必须给 null，给 0 会被界面当成「涨跌 0%」
  const dashRow = `<h2>成分股涨跌排行榜</h2><table><tbody>
      <tr><td>1</td><td>600000</td><td>停牌股</td><td>--</td><td>--</td><td>--</td><td>--</td><td>--</td><td>--</td><td>--</td><td>--</td></tr>
    </tbody></table>`;
  const d = parseConstituents(dashRow);
  check('`--` 解析成 null 而不是 0', d.items[0]?.changePct === null && d.items[0]?.price === null,
    `实得 changePct=${d.items[0]?.changePct} price=${d.items[0]?.price}`);
}

async function liveTest() {
  // 未开盘时同花顺行业榜只渲染部分行、且涨跌幅全是 0 —— 断言 90 条会误报。
  // 实测 2026-10-20 09:20 未开盘：51 条且 changePct 全 0。
  const notTrading = await isClosedNow();
  if (notTrading) console.log('  SKIP  当前未开盘，行业榜的条数与涨跌幅不做断言');
  console.log('\n[2] 行业板块榜（真实站点）');
  const rank = await fetchIndustryRank();
  if (!notTrading) check('行业板块数量 = 90', rank.items.length === 90, `实得 ${rank.items.length}`);
  const pcts = rank.items.map((x) => x.changePct).filter((v) => v !== null);

  if (!notTrading) check('全部有涨跌幅', pcts.length === rank.items.length, `有值 ${pcts.length}/${rank.items.length}`);
  check('已按涨跌幅降序', pcts.every((v, i) => i === 0 || pcts[i - 1] >= v),
    `前 3 ${pcts.slice(0, 3).join(' ')} 后 3 ${pcts.slice(-3).join(' ')}`);
  check('每个板块都有 6 位代码', rank.items.every((x) => /^\d{6}$/.test(x.code)));
  console.log('  涨最狠 5：' + rank.items.slice(0, 5).map((x) => `${x.name} ${x.changePct}%`).join(' | '));
  console.log('  跌最狠 5：' + rank.items.slice(-5).reverse().map((x) => `${x.name} ${x.changePct}%`).join(' | '));

  console.log('\n[3] 涨停板块榜（同花顺 block_top）');
  const hot = await fetchHotBoards();
  check('热闹板块数量 > 0', hot.length > 0, `实得 ${hot.length}`);
  check('按涨停家数降序', hot.every((v, i) => i === 0 || (hot[i - 1].limitUpNum ?? 0) >= (v.limitUpNum ?? 0)),
    `前 3 ${hot.slice(0, 3).map((x) => x.name + ':' + x.limitUpNum).join(' ')}`);

  console.log('\n[4] 名称 → 板块代码映射');
  const map = await fetchBoardMap();
  check('映射条目 = 361(gn) + 90(thshy)', map.size === 451, `实得 ${map.size}`);
  // 维度② 的板块必须全部能定位到成分股页，否则格子点了没反应
  const miss = hot.filter((h) => !map.has(h.name));
  check('涨停板块榜的板块全部能映射', miss.length === 0,
    miss.length ? '缺：' + miss.map((x) => x.name).join(',') : '');
  for (const h of hot.slice(0, 3)) {
    const t = map.get(h.name);
    console.log(`  ${h.name.padEnd(12)} 涨停${String(h.limitUpNum).padStart(3)} → ${t ? t.code + '(' + t.kind + ')' : '未映射'}`);
  }

  console.log('\n[5] 成分股分页换算');
  // 行业：服务端 20 只/页，offset 0 size 20 应正好一页
  const bank = [...map.entries()].find(([n]) => n === '银行');
  check('映射里有「银行」', Boolean(bank), bank ? `${bank[1].code}(${bank[1].kind})` : '未找到');
  if (bank) {
    const p1 = await fetchBoardStocks(bank[1].code, bank[1].kind, { offset: 0, size: 20 });
    check('行业 offset0/size20 返回 20 只', p1.items.length === 20, `实得 ${p1.items.length}`);
    check('行业首条涨跌幅 >= 次条（页面原生降序）',
      (p1.items[0]?.changePct ?? -999) >= (p1.items[1]?.changePct ?? 999),
      `${p1.items[0]?.changePct} vs ${p1.items[1]?.changePct}`);
    const p2 = await fetchBoardStocks(bank[1].code, bank[1].kind, { offset: 20, size: 20 });
    check('行业第 2 页与第 1 页不重叠',
      p2.items.every((x) => !p1.items.some((y) => y.code === x.code)),
      `p1 首 ${p1.items[0]?.code} p2 首 ${p2.items[0]?.code}`);
    check('行业对外页码是 2', p2.page === 2, `实得 ${p2.page}`);
  }

  // 概念：服务端 10 只/页，offset 0 size 20 必须拉两页拼起来
  const concept = [...map.entries()].find(([, v]) => v.kind === 'gn');
  if (concept) {
    const c = await fetchBoardStocks(concept[1].code, concept[1].kind, { offset: 0, size: 20 });
    check(`概念 ${concept[0]} offset0/size20 拼出 20 只`, c.items.length === 20, `实得 ${c.items.length}`);
    check('概念拼页后无重复', new Set(c.items.map((x) => x.code)).size === c.items.length,
      `去重 ${new Set(c.items.map((x) => x.code)).size}/${c.items.length}`);
    check('概念拼页后仍按涨跌幅降序',
      c.items.every((v, i) => i === 0 || (c.items[i - 1].changePct ?? -999) >= (v.changePct ?? 999)),
      `前 3 ${c.items.slice(0, 3).map((x) => x.changePct).join(' ')}`);
    const c2 = await fetchBoardStocks(concept[1].code, concept[1].kind, { offset: 20, size: 20 });
    check('概念第 2 页与第 1 页不重叠',
      c2.items.every((x) => !c.items.some((y) => y.code === x.code)),
      `p1 首 ${c.items[0]?.code} p2 首 ${c2.items[0]?.code}`);
    console.log(`  概念样例 ${concept[0]}：` + c.items.slice(0, 3).map((x) => `${x.name} ${x.changePct}%`).join(' | '));
  }
  // ---- 免费页数上限：这是本次最重要的回归闸 ----
  // 同花顺匿名只开放前 5 页成分股（page 5 正常、page 6 起跳 upass 登录墙，实测）。
  // 所以大板块的 totalPages 必须被夹到免费上限，不能把上游的 123 页原样抛给前端 ——
  // 那样分页器会承诺 62 页，而实际翻到第 3 页就没数据，用户看到的就是「数字不对」。
  const bigInd = await fetchBoardStocks('881126', 'thshy', { offset: 0, size: 20 }); // 汽车零部件，上游 14 页
  check('大行业板块被夹到免费上限 5 页', bigInd.totalPages === 5, String(bigInd.totalPages));
  check('大行业板块标了 truncated', bigInd.truncated === true, String(bigInd.truncated));
  check('truncated 时给出免费只数上限（行业 5×20=100）', bigInd.freeStocks === 100, String(bigInd.freeStocks));

  const bigCon = await fetchBoardStocks('301558', 'gn', { offset: 0, size: 20 }); // 阿里巴巴概念，上游 35 页
  check('大概念板块被夹到免费上限 3 页', bigCon.totalPages === 3, String(bigCon.totalPages));
  check('概念免费只数上限是 5×10=50', bigCon.freeStocks === 50, String(bigCon.freeStocks));

  // 翻过免费上限时不能再发请求（发了只会拿到登录墙存根），要如实返回空 + truncated
  const overInd = await fetchBoardStocks('881126', 'thshy', { offset: 100, size: 20 });
  check('翻过免费上限时返回空，而不是返回上游的存根解析结果',
    overInd.items.length === 0 && overInd.truncated === true,
    `${overInd.items.length} 只 truncated=${overInd.truncated}`);
  check('翻过免费上限时页码仍被夹在合法范围内',
    overInd.page <= bigInd.totalPages && overInd.totalPages === 5,
    `page=${overInd.page} totalPages=${overInd.totalPages}`);
}

selfTestParsers();
await liveTest();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail > 0 ? 1 : 0;
