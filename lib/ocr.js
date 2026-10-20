/**
 * 图片识别股票
 *
 * 用户不想为了加一只自选去手打代码，而是直接贴一张券商截图。这件事不需要联网、
 * 也不需要视觉大模型：Windows 自带 Windows.Media.Ocr，装过中文语言包就能认中文。
 * 实测（2026-10-20，本机）：浅色底与深色底各造一张模拟截图，中文股票名 4/4 全对，
 * 深色底不需要反色预处理；数字则会错认（600519 认成 600S19、300750 认成 3007S0），
 * 所以别名匹配以股票名为主、代码只作辅助且必须落进代码池才算数。
 *
 * 为什么用 -EncodedCommand 而不是随包发一个 .ps1：
 * 一是 PowerShell 5.1 读无 BOM 的 UTF-8 脚本会按系统代码页解码，中文注释直接把语法搞坏
 * （实测报「Unexpected token ')'」，行号还会指着注释行）；二是 base64 的 UTF-16LE
 * 完全不经过文件编码与代码页，省掉一整类环境差异。
 *
 * 为什么 AsTask 的结果类型要显式传：WinRT 对象在 PowerShell 里是 __ComObject，
 * 反射拿不到泛型参数、也读不到 IAsyncOperation.Status，MakeGenericMethod 会收到 null。
 *
 * @author cai shan
 * @date 2026-10-20 10:44
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 中文识别语言。装不上就走用户配置语言，仍不行则如实报「没有 OCR」 */
const OCR_LANG = 'zh-Hans-CN';

/** 单张图片的识别超时。4K 截图实测 1 秒内出结果，20 秒足够且不会把宿主拖死 */
const TIMEOUT_MS = 20000;

/**
 * 单字母/单符号 → 数字 的错认对照表。
 *
 * 只收录实测或字形上几乎无法区分的：S→5 是实测（600519→600S19），O/l/I/Z/B/G 是字形。
 * 不做模糊替换（例如 E→3、T→7 之外的花样），否则正常文字会被改出假代码。
 */
const CONFUSABLE = {
  O: '0', o: '0', D: '0', Q: '0', U: '0',
  l: '1', I: '1', i: '1', '|': '1', '!': '1',
  Z: '2', z: '2',
  A: '4',
  S: '5', s: '5',
  G: '6', b: '6',
  T: '7',
  B: '8',
  g: '9', q: '9',
};

/** PowerShell 脚本里出现单引号会截断单引号字符串，按 PS 规则写成两个单引号 */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 包在 try/catch 外面、把结论写成 JSON 文件的公共尾部。
 *
 * 走文件不走 stdout：中文经控制台代码页会被打乱，而且 stdio:'ignore' 下 stdout 根本读不到。
 */
const PS_WRITE_RESULT = [
  '$json = $payload | ConvertTo-Json -Depth 4',
  '[System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding($false)))',
].join('\n');

/** 建 OcrEngine 的公共前置：投影 + 选语言引擎。probe 与 recognize 共用 */
const PS_ENGINE_SETUP = [
  '  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop',
  '  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]',
  '  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]',
  '  $engine = $null',
  '  try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($lang)) } catch { $engine = $null }',
  '  if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }',
].join('\n');

/**
 * 探测脚本：只报「这台机器能不能做中文 OCR」，不碰图片。
 *
 * 单独拆出来是因为「装好了但按钮点了没反应」最难查：先能一句话说清是缺语言包还是别的。
 */
function buildProbeScript(outPath, lang) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$outPath = ${psQuote(outPath)}`,
    `$lang = ${psQuote(lang)}`,
    'try {',
    PS_ENGINE_SETUP,
    '  $langs = @()',
    '  foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) { $langs += $l.LanguageTag }',
    '  if ($null -eq $engine) { throw "NO_OCR_ENGINE" }',
    '  $payload = [ordered]@{ ok = $true; lang = $engine.RecognizerLanguage.LanguageTag; langs = $langs; error = "" }',
    '} catch {',
    '  $payload = [ordered]@{ ok = $false; lang = ""; langs = @(); error = $_.Exception.Message }',
    '}',
    PS_WRITE_RESULT,
  ].join('\n');
}

/**
 * 识别脚本：图片 → 每行一条文本。
 *
 * 用的都是 WinRT 的异步方法，统一走 Await 同步化；结果类型必须由调用方给，
 * 因为 $op 是 __ComObject，反射不出泛型参数。
 */
function buildRecognizeScript(imagePath, outPath, lang) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$imagePath = ${psQuote(imagePath)}`,
    `$outPath = ${psQuote(outPath)}`,
    `$lang = ${psQuote(lang)}`,
    'try {',
    PS_ENGINE_SETUP,
    '  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]',
    '  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]',
    '  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]',
    '  try { $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage, ContentType = WindowsRuntime] }',
    '  catch { $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime] }',
    '  if ($null -eq $engine) { throw "NO_OCR_ENGINE" }',
    '  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
    '      $_.Name -eq "AsTask" -and',
    '      $_.GetParameters().Count -eq 1 -and',
    '      $_.GetParameters()[0].ParameterType.Name -like "IAsyncOperation*" -and',
    '      $_.GetParameters()[0].ParameterType.Name -notlike "*WithProgress*"',
    '    })[0]',
    '  if ($null -eq $asTask) { throw "NO_ASTASK" }',
    '  function Await($op, [Type]$resultType) {',
    '    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($op))',
    '    if (-not $task.Wait(15000)) { throw "ASYNC_TIMEOUT" }',
    '    return $task.Result',
    '  }',
    '  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])',
    '  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
    '  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
    '  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
    '  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
    '  $lines = @()',
    '  foreach ($line in $result.Lines) { $lines += $line.Text }',
    '  $payload = [ordered]@{ ok = $true; lang = $engine.RecognizerLanguage.LanguageTag; lines = $lines; error = "" }',
    '} catch {',
    '  $payload = [ordered]@{ ok = $false; lang = ""; lines = @(); error = $_.Exception.Message }',
    '}',
    PS_WRITE_RESULT,
  ].join('\n');
}

/** PowerShell 5.1 的绝对路径。不查 PATH：PATH 里更可能先撞上 pwsh 7，而 7 没有 WinRT 投影 */
function powershellExe() {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * 脚本交给 -EncodedCommand：base64 的 UTF-16LE，不经过文件编码与代码页。
 *
 * stdio 全 ignore —— 结论走 JSON 文件，管道只会多一类平台差异。
 */
function runScript(script, outPath, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let child;
    try {
      child = spawn(powershellExe(), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encoded,
      ], { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: `起不来 PowerShell：${err.message}` });
      return;
    }

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch { /* 已经退了 */ }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `PowerShell 启动失败：${err.message}` });
    });

    child.on('close', async () => {
      clearTimeout(timer);
      if (killed) {
        resolve({ ok: false, error: `OCR 超过 ${Math.round(timeoutMs / 1000)} 秒没结束` });
        return;
      }
      try {
        const text = await readFile(outPath, 'utf8');
        resolve({ ok: true, json: JSON.parse(text) });
      } catch (err) {
        // 脚本自己崩掉时不会有结果文件，这里必须把「没有产物」单独说清楚
        resolve({ ok: false, error: `OCR 没有产出结果（${err.code ?? err.message}）` });
      }
    });
  });
}

/** ConvertTo-Json 对单元素数组的处理随版本而变，统一在这里兜成数组 */
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

/**
 * 一行 OCR 文本的归一化。
 *
 * 全角转半角：实测标点会吐成 ．％；
 * 「一」→「−」只在紧跟数字时做：中文破折号与负号在字形上无法区分，
 * 但股票名里的「一」（如第一创业）后面跟的是汉字，不能动。
 */
export function normalizeLine(line) {
  if (typeof line !== 'string') return '';
  let s = line
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
  s = s.replace(/[\u4E00\u2010-\u2015](?=\s*[0-9])/g, '-');
  return s;
}

/**
 * 去掉全部空白。
 *
 * WinRT 对中文是逐字分词输出（「贵 州 茅 台」），不去空格就永远匹配不上股票名。
 * 代价是相邻两段文字会被粘在一起，但匹配用的是「包含」，粘连不影响结论。
 */
export function compactText(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

/** 把单个字符按错认表还原成数字；本来就是数字的原样返回 */
function repairChar(ch) {
  if (/[0-9]/.test(ch)) return ch;
  return CONFUSABLE[ch] ?? ch;
}

/**
 * 从一段文本里找出所有「修完之后能在代码池里查到」的 6 位代码。
 *
 * 必须落进代码池才算命中：OCR 会产出大量形似 6 位数字的片段（价格、时间、金额），
 * 不校验的话一张截图能认出几十个不存在的代码。
 *
 * @param {string} text 已 compact 的文本
 * @param {Set<string>} codeSet 6 位代码集合
 * @returns {string[]} 命中的 6 位代码
 */
export function extractCodes(text, codeSet) {
  const out = [];
  const runs = String(text ?? '').match(/[0-9A-Za-z|!]{6,}/g) ?? [];
  for (const run of runs) {
    for (let i = 0; i + 6 <= run.length; i += 1) {
      const repaired = Array.from(run.slice(i, i + 6), repairChar).join('');
      if (/^[0-9]{6}$/.test(repaired) && codeSet.has(repaired) && !out.includes(repaired)) {
        out.push(repaired);
      }
    }
  }
  return out;
}

/**
 * 把 OCR 文本行对到代码池上，产出候选。
 *
 * 名称优先、代码辅助：实测名称 4/4 全对，而代码会错认（5→S），
 * 所以名称命中的条目排在代码命中之前只是一种稳定性排序，两者都保留。
 *
 * 2 字名称一律不参与「包含」匹配：像「中信」「上海」这种短名在任意长文本里都会命中，
 * 一张截图能刷出一屏假候选。宁可漏掉极少数 2 字名，也不给用户一屏噪音。
 *
 * @param {string[]} lines OCR 文本行
 * @param {{code: string, name: string, kind?: string}[]} catalog 代码池（股票 + 场内基金）
 * @param {{limit?: number, minNameLen?: number}} [opts]
 * @returns {{items: object[], unmatched: string[]}}
 */
export function pickCandidates(lines, catalog, opts = {}) {
  const limit = opts.limit ?? 30;
  const minNameLen = opts.minNameLen ?? 3;
  const list = Array.isArray(catalog) ? catalog : [];

  const bySix = new Map();
  for (const entry of list) {
    const six = String(entry?.code ?? '').slice(-6);
    if (/^[0-9]{6}$/.test(six) && !bySix.has(six)) bySix.set(six, entry);
  }
  const codeSet = new Set(bySix.keys());
  const nameEntries = list.filter((x) => x?.name && x.name.length >= minNameLen);

  /** @type {Map<string, {code: string, name: string, kind: string, matchedBy: string, nameLen: number}>} */
  const hits = new Map();
  const unmatched = [];

  const add = (entry, matchedBy) => {
    const code = String(entry.code);
    const prev = hits.get(code);
    // 同一个代码被「名称包含」和「代码精确」同时命中时，代码更可信
    if (prev && (prev.matchedBy === 'code' || matchedBy === 'name')) return;
    hits.set(code, {
      code,
      name: entry.name ?? '',
      kind: entry.kind ?? 'stock',
      matchedBy,
      nameLen: (entry.name ?? '').length,
    });
  };

  for (const raw of asArray(lines)) {
    const compact = compactText(normalizeLine(raw));
    if (!compact) continue;
    let found = 0;
    for (const six of extractCodes(compact, codeSet)) {
      add(bySix.get(six), 'code');
      found += 1;
    }
    for (const entry of nameEntries) {
      if (compact.includes(entry.name)) {
        add(entry, 'name');
        found += 1;
      }
    }
    // 反向包含：券商截图普遍只显示简称，OCR 认出来的是「半导体设备ETF」，
    // 而代码池里的全名是「半导体设备ETF易方达」，正向匹配必然落空。
    // 长度上限 12 是防呆：长句子里随便一个片段都可能是某只股票名的一部分。
    if (compact.length >= 3 && compact.length <= 12 && /[\u4E00-\u9FFF]/.test(compact)) {
      const reverse = [];
      for (const entry of nameEntries) {
        if (!entry.name.includes(compact)) continue;
        reverse.push(entry);
        // 已经超过阈值就不用再往下收了，反正这组会被整组丢掉
        if (reverse.length > 3) break;
      }
      // 命中超过 3 只 = 这个片段是一堆产品的公共前缀（实测「半导体设备ETF」命中 8 只），
      // 猜哪一只是错的概率远大于对。这种情况下只保留代码命中的那条，不乱加候选。
      if (reverse.length <= 3) {
        for (const entry of reverse) {
          add(entry, 'name');
          found += 1;
        }
      }
    }
    // 只把「看起来本来该是股票名」的行报成未匹配：价格、涨跌幅那类行对上才奇怪，
    // 混进未匹配里会让「有 10 行没认出」看起来像识别质量很差
    if (found === 0 && /[\u4E00-\u9FFF]/.test(compact)) unmatched.push(raw);
  }

  const items = [...hits.values()]
    .sort((a, b) => {
      if (a.matchedBy !== b.matchedBy) return a.matchedBy === 'code' ? -1 : 1;
      return b.nameLen - a.nameLen;
    })
    .slice(0, limit)
    .map(({ nameLen, ...rest }) => rest);

  return { items, unmatched };
}

/**
 * OCR 客户端。
 *
 * probe 与 recognize 都走「写临时目录 → 起 PowerShell → 读 JSON → 清目录」，
 * 失败一律返回结构化结果而不是抛错：识别失败要能在界面上说清是缺语言包、格式不支持还是超时。
 *
 * @param {{timeoutMs?: number, lang?: string}} [opts]
 */
export function createOcr(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const lang = opts.lang ?? OCR_LANG;
  /** 探测结果缓存。它只跟系统装没装语言包有关，一次进程内不必反复问 */
  let probed = null;

  async function withTempDir(fn) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-stock-desk-ocr-'));
    try {
      return await fn(dir);
    } finally {
      // 清理失败不能盖掉真正的结论：超时后子进程可能还占着文件，此时 rm 会抛，
      // 一抛就把「OCR 超过 20 秒没结束」换成一句莫名其妙的 EPERM / EBUSY
      try { await rm(dir, { recursive: true, force: true }); } catch { /* 系统临时目录自会回收 */ }
    }
  }

  return {
    /** 本机能不能做中文 OCR。拿到明确答案后缓存，环境抖动则下次再试 */
    async probe() {
      if (probed) return probed;
      let settled = false;
      const result = await withTempDir(async (dir) => {
        const outPath = join(dir, 'probe.json');
        const r = await runScript(buildProbeScript(outPath, lang), outPath, timeoutMs);
        if (!r.ok) return { ok: false, lang: '', langs: [], error: r.error };
        // 脚本跑起来了，答案就是确定的（有语言包还是没有），可以缓存
        settled = true;
        return {
          ok: r.json?.ok === true,
          lang: r.json?.lang ?? '',
          langs: asArray(r.json?.langs),
          error: r.json?.error ?? '',
        };
      });
      // 起不来 PowerShell 属于环境抖动（路径、策略、超时），不该一次失败就永久禁用这个功能
      if (settled) probed = result;
      return result;
    },

    /**
     * 识别一张图片。
     *
     * @param {Buffer} buffer 图片字节
     * @returns {Promise<{ok: boolean, lang: string, lines: string[], error: string}>}
     */
    async recognize(buffer) {
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return { ok: false, lang: '', lines: [], error: '图片是空的' };
      }
      return withTempDir(async (dir) => {
        const imagePath = join(dir, 'input.png');
        const outPath = join(dir, 'ocr.json');
        await writeFile(imagePath, buffer);
        const r = await runScript(buildRecognizeScript(imagePath, outPath, lang), outPath, timeoutMs);
        if (!r.ok) return { ok: false, lang: '', lines: [], error: r.error };
        return {
          ok: r.json?.ok === true,
          lang: r.json?.lang ?? '',
          lines: asArray(r.json?.lines),
          error: r.json?.error ?? '',
        };
      });
    },
  };
}
