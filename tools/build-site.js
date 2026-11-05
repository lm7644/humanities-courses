#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist");
const files = [
  "index.html",
  "data/courses.js",
  "data/paths.js",
  "assets/og-cover.png"
];

execFileSync(process.execPath, [path.join(root, "tools", "build-data-script.js"), "--check"], { cwd:root, stdio:"inherit" });
execFileSync(process.execPath, [path.join(root, "tools", "build-core-candidates.js"), "--check"], { cwd:root, stdio:"inherit" });
execFileSync(process.execPath, [path.join(root, "tools", "validate-project.js")], { cwd:root, stdio:"inherit" });

fs.rmSync(output, { recursive:true, force:true });
for (const relative of files) {
  const source = path.join(root, relative);
  const target = path.join(output, relative);
  fs.mkdirSync(path.dirname(target), { recursive:true });
  fs.copyFileSync(source, target);
}

fs.writeFileSync(path.join(output, "_redirects"), "/* /index.html 200\n", "utf8");
fs.writeFileSync(path.join(output, ".nojekyll"), "", "utf8");
// 注意：_headers 在下方 CSP 计算之后写入——Content-Security-Policy 行必须使用
// 与 dist/index.html meta 完全一致的 hash-based 指令，避免两处口径漂移。

// ==================== SEO：结构化数据 / sitemap / noscript 目录 ====================
// 依据《可复刻项目借鉴与优化方案》§2.4（评测 3.1，P0）：
//   - JSON-LD 用 Google 官方 Course 结构化数据模板（ItemList + Course 单页 all-in-one 模式）
//   - 约束复确认：聚合站无课程富摘要资格，JSON-LD 照打但不期待卡片效果；
//     **只写页面上真实呈现的字段，绝不虚构**。
//   - sitemap.xml 零依赖手写；robots.txt 追加 Sitemap 行；补 <noscript> 课程目录。

const htmlPath = path.join(output, "index.html");
let html = fs.readFileSync(htmlPath, "utf8");

// —— 站点基址：优先取构建期参数 SITE_ORIGIN（测试域名/迁移域名时无需改 index.html），
//    否则以 index.html 的 canonical 为唯一来源，避免 URL 在多处硬编码 ——
const envOrigin = (process.env.SITE_ORIGIN || "").trim();
let siteUrl;
let siteUrlSource;
if (envOrigin) {
  if (!/^https?:\/\/[^\s]+$/.test(envOrigin)) {
    throw new Error("SITE_ORIGIN 必须是 http(s):// 开头的绝对地址，例如 https://courses.example.edu/");
  }
  siteUrl = envOrigin.replace(/\/+$/, "") + "/";
  siteUrlSource = "SITE_ORIGIN";
  html = html.replace(/<link\s+rel="canonical"\s+href="[^"]+"\s*\/?>/i, `<link rel="canonical" href="${siteUrl}" />`);
  // og:url 与 canonical 同源重写：社交分享卡片同样不得残留旧域名
  html = html.replace(/<meta\s+property="og:url"\s+content="[^"]*"\s*\/?>/i, `<meta property="og:url" content="${siteUrl}" />`);
} else {
  const canonicalMatch = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"\s*\/?>/i);
  if (!canonicalMatch) throw new Error("index.html 缺少 <link rel=\"canonical\">，无法确定站点基址");
  siteUrl = canonicalMatch[1].replace(/\/+$/, "") + "/";
  siteUrlSource = "index.html canonical";
}

// —— 可索引课程：仅未被阻断且有可用外部入口的（与页面 isCourseLinkEnabled 口径一致）——
const BLOCKED_STATUS = new Set(["unavailable", "needs_review"]);
const openCourses = JSON.parse(fs.readFileSync(path.join(root, "data", "courses.json"), "utf8"))
  .filter(c => !BLOCKED_STATUS.has(c.status) && c.url);

const escHtml = s => String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[m]));
const escXml = s => String(s == null ? "" : s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" }[m]));

// —— 1) JSON-LD：ItemList + Course ——
const itemList = openCourses.map((c, i) => {
  const item = { "@type": "Course", "name": c.name, "url": c.url };
  if (c.intro) item.description = c.intro;                                  // 编辑摘要
  if (c.school) item.provider = { "@type": "Organization", "name": c.school };
  if (c.teacher) item.instructor = { "@type": "Person", "name": c.teacher };
  return { "@type": "ListItem", "position": i + 1, "item": item };
});
// 内联 JSON 需转义 </ 与 <!--，避免提前闭合脚本块
const jsonldText = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "ItemList",
  "name": "人文学科公开课目录",
  "numberOfItems": itemList.length,
  "itemListElement": itemList
}).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");

if (!html.includes("</head>")) throw new Error("index.html 缺少 </head>，无法注入结构化数据");
html = html.replace("</head>", `  <script type="application/ld+json">${jsonldText}</script>\n</head>`);

// —— 2) <noscript> 课程目录：无脚本环境下的可读清单 ——
const noscriptBlock = `
<noscript>
  <div style="padding:24px;max-width:960px;margin:0 auto;line-height:1.8">
    <h1>人文学科公开课目录（无脚本视图）</h1>
    <p>共 ${openCourses.length} 门课程提供外部入口。启用 JavaScript 后可使用检索、筛选、对比与学习路径。</p>
    <ol>
${openCourses.map(c => `      <li><a href="${escHtml(c.url)}" rel="noopener noreferrer">${escHtml(c.name)}</a> — ${escHtml(c.teacher || "主讲待补")}（${escHtml(c.school || "院校待补")} · ${escHtml(c.platform || "平台待补")}）</li>`).join("\n")}
    </ol>
  </div>
</noscript>`;
if (!html.includes("</body>")) throw new Error("index.html 缺少 </body>，无法注入 noscript 目录");
html = html.replace("</body>", `${noscriptBlock}\n</body>`);

// —— 5) Content-Security-Policy：script-src 收敛为 hash 白名单（M-07）——
// 在 JSON-LD / noscript 全部注入完成后再计算：哈希必须对最终内容求值，JSON-LD 脚本块也在内。
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const cspHash = value => "'sha256-" + crypto.createHash("sha256").update(value, "utf8").digest("base64") + "'";
// script-src 完全收敛：页面无运行时脚本注入、无 eval/new Function，内联脚本均为静态内容，
// 白名单之外的内联脚本（XSS 主通道）一律拒绝执行。已在真实浏览器实测零 script 违例。
const scriptSrc = ["'self'", ...new Set(inlineScripts.map(cspHash))].join(" ");
// style-src 保留 'unsafe-inline'（已知残余风险，非遗漏）：
//   本单文件应用大量使用内联 style 属性——静态标记（筛选行 gap:8px 等 5 处）与运行时模板
//   字面量（课程卡/分类区块的 --cat-color、路径进度条、空态等，实测 6121 处）；
//   CSP hash 只覆盖 <style> 元素、不覆盖 style 属性，静态托管（无服务端渲染）也无法使用 nonce。
//   注意：style-src 一旦列入 hash，浏览器会忽略同列的 'unsafe-inline'（规范行为，实测报错
//   "Applying inline style violates..."），全部内联样式会被拒并击穿「运行时错误为 0」门禁，
//   故此处只保留 'unsafe-inline'、不列 hash。残余风险限于 CSS 注入（数据外渗/界面伪装），
//   不构成脚本执行；待 index.html 将动态样式迁入 CSS 类/CSSOM 后可去掉 'unsafe-inline'。
const styleSrc = "'self' 'unsafe-inline'";
// meta 与 _headers 的指令集分工（沿用原设计，非疏漏）：
//   frame-ancestors 只能通过响应头下发，放进 <meta> 会被浏览器忽略并记一条 console error
//   （实测击穿「运行时错误为 0」门禁），故只进 _headers；object-src 原 meta 即有，保留在 meta 侧。
const cspBase = `default-src 'self'; script-src ${scriptSrc}; style-src ${styleSrc}; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
const cspHeaders = `${cspBase}; frame-ancestors 'none'`;
const cspMeta = `${cspBase}; object-src 'none'`;

// 用 meta 专用指令集重写 dist/index.html 的 meta（若不存在 meta 则不动，仅由 _headers 下发）
if (/<meta\s+http-equiv="Content-Security-Policy"/i.test(html)) {
  html = html.replace(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/?>/i,
    `<meta http-equiv="Content-Security-Policy" content="${cspMeta}" />`
  );
}
fs.writeFileSync(htmlPath, html, "utf8");

fs.writeFileSync(path.join(output, "_headers"), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: ${cspHeaders}

/data/*.js
  Cache-Control: public, max-age=300
`, "utf8");

// —— 3) sitemap.xml ——
// 说明：本站为单页应用，课程深链以 # 片段区分。片段不产生独立可索引页面，
// 此处按设计方案照常列出（Google 会自行归并到首页），价值在于显式声明全部课程入口。
const lastmod = c => (/^\d{4}-\d{2}-\d{2}$/.test(c.link_checked_at || "") ? c.link_checked_at : new Date().toISOString().slice(0, 10));
const homeLastmod = openCourses.reduce((acc, c) => (lastmod(c) > acc ? lastmod(c) : acc), "2026-01-01");
const urlEntries = [
  `  <url>\n    <loc>${escXml(siteUrl)}</loc>\n    <lastmod>${homeLastmod}</lastmod>\n    <priority>1.0</priority>\n  </url>`,
  ...openCourses.map(c =>
    `  <url>\n    <loc>${escXml(siteUrl + "#course=" + c.id)}</loc>\n    <lastmod>${lastmod(c)}</lastmod>\n    <priority>0.6</priority>\n  </url>`)
];
fs.writeFileSync(path.join(output, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries.join("\n")}\n</urlset>\n`, "utf8");

// —— 4) robots.txt 追加 Sitemap 引用 ——
fs.writeFileSync(path.join(output, "robots.txt"),
  `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}sitemap.xml\n`, "utf8");

console.log(`已生成平台无关静态站点：${path.relative(root, output)}；结构化数据 ${itemList.length} 门、sitemap ${urlEntries.length} 条、noscript 目录已注入；站点基址 ${siteUrl}（来源：${siteUrlSource}）`);
