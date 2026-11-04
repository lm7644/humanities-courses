#!/usr/bin/env node
// P0-1 符号字形门禁：功能图标必须是统一描边 SVG，禁止 emoji / 符号字形充当图标
// 扫描口径（重要）：只扫「可交付源码与数据」文本文件——
//   纳入：index.html、tools/*.js|mjs、data/*.json、dist/index.html（构建产物）、package.json、.github/*.yml
//   排除：docs/**/*.md 与根目录报告（文档中的勾叉记号属排版符号，不是 UI 图标）、validation/*.json（门禁产物）、
//        以及一切二进制（*.png 等）——历史上曾因把 PNG 当文本读而产生 300+ 假阳性
// 注意：本文件也在扫描范围内，注释里同样不得出现 emoji 或符号字形
// 退出码：命中即 1（ERROR），供 npm test 串联
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const PATTERN = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

const targets = [];
const push = relative => { if (fs.existsSync(path.join(root, relative))) targets.push(relative); };
push("index.html");
push("package.json");
push("dist/index.html");
for (const name of fs.readdirSync(path.join(root, "tools"))) if (/\.(js|mjs)$/.test(name)) push(`tools/${name}`);
for (const name of fs.readdirSync(path.join(root, "data"))) if (name.endsWith(".json") && !name.includes("schema")) push(`data/${name}`);
const workflowDir = path.join(root, ".github/workflows");
if (fs.existsSync(workflowDir)) for (const name of fs.readdirSync(workflowDir)) if (name.endsWith(".yml")) push(`.github/workflows/${name}`);

const errors = [];
let scanned = 0;
for (const relative of targets) {
  const text = fs.readFileSync(path.join(root, relative), "utf8");
  scanned++;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const hits = line.match(PATTERN);
    if (!hits) return;
    const codes = [...new Set(hits.map(ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`))];
    errors.push(`${relative}:${i + 1} 命中 ${codes.join(" ")}`);
  });
}

if (errors.length) {
  for (const error of errors) console.error(`ERROR P0-1 符号字形/emoji：${error}`);
  console.error(`扫描 ${scanned} 个文件，命中 ${errors.length} 处。功能图标必须改为统一描边 SVG（见 docs/visual-spec.md §3）。`);
  process.exit(1);
}
console.log(`P0-1 符号字形扫描通过：${scanned} 个文件 0 命中（文档与二进制产物不在扫描口径内）`);