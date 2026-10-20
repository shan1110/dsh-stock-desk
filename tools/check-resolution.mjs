/**
 * 模块解析自检（开发用）
 *
 * 为什么需要这个文件：插件是被 pnpm 以软链接（符号链接）方式挂进 profile 的，
 * 而 Node 默认按真实路径解析。于是 E:\dsh-plugin\lib\tools.js 里的
 * `import { defineTool } from "@deepseek-ai/dsh-tools"` 会从 E:\dsh-plugin 往上找，
 * 而 harness 的包在 C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai —— 够不着。
 * 表现是插件只能注册 HTTP 接口却一个 agent 工具都注册不上，且错误藏在 loader 诊断里。
 *
 * 这个脚本直接在插件自己的目录下验证解析是否通，避免每次都要先装一遍才知道。
 *
 * 用法：node tools/check-resolution.mjs
 */
const SPECS = ["@deepseek-ai/dsh-tools", "@deepseek-ai/schemastery"];

let bad = 0;
for (const spec of SPECS) {
  try {
    const mod = await import(spec);
    const keys = Object.keys(mod).slice(0, 6).join(", ");
    console.log(`OK   ${spec.padEnd(30)} 导出 ${Object.keys(mod).length} 个（${keys}…）`);
  } catch (err) {
    bad++;
    console.log(`FAIL ${spec.padEnd(30)} ${err.code ?? err.message}`);
  }
}

// 单独确认 defineTool 真的在，而不是只解析到了包
try {
  const { defineTool } = await import("@deepseek-ai/dsh-tools");
  console.log(typeof defineTool === "function" ? "OK   defineTool 是函数" : `FAIL defineTool 类型 ${typeof defineTool}`);
  if (typeof defineTool !== "function") bad++;
} catch (err) {
  bad++;
  console.log(`FAIL 取 defineTool：${err.message}`);
}

console.log(bad === 0 ? "\n解析正常" : `\n${bad} 项失败`);
process.exitCode = bad === 0 ? 0 : 1;