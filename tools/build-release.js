#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const releaseRoot = path.join(root, "release");
const output = path.join(releaseRoot, "humanities-courses-p1");
const files = [
  "index.html",
  "README.md",
  "LICENSE",
  "P1工程底座与验收报告.md",
  "link-report.json",
  "package.json",
  "data/course.schema.json",
  "data/path.schema.json",
  "data/source-audit.schema.json",
  "data/reference-adoption.schema.json",
  "data/reference-adoption.json",
  "data/courses.json",
  "data/courses.js",
  "data/paths.json",
  "data/paths.js",
  "data/core-candidates.json",
  "data/source-audit-20260729.json",
  "data/source-audit-supplement-20260731.json",
  "data/templates/course.example.json",
  "data/templates/path.example.json",
  "dist/index.html",
  "dist/data/courses.js",
  "dist/data/paths.js",
  "dist/_headers",
  "dist/_redirects",
  "dist/robots.txt",
  "dist/sitemap.xml",
  "dist/.nojekyll",
  "docs/P1数据字段字典.md",
  "docs/P1目标用户与验证假设.md",
  "docs/P1内容治理与教师共建规则.md",
  "docs/P1部署与域名方案.md",
  "docs/P1初版使用说明.md",
  "docs/P1.2来源审核与视觉验收记录_20260729.md",
  "docs/P1.3高密度课程卡与滚动导航验收记录_20260729.md",
  "docs/P1.4课程识别与计划闭环验收记录_20260730.md",
  "docs/P1.5课程题签与精简计划验收记录_20260730.md",
  "docs/P1.6双轮审计与公网发布验收记录_20260731.md",
  "docs/当前进度与新方案一致性审计_20260730.md",
  "docs/项目复刻与可借鉴方案.md",
  "validation/p1-browser-results.json",
  "validation/plan-alignment-results.json",
  "validation/link-network-report.json",
  "validation/second-round-audit-results.json",
  "validation/p1-desktop-top.png",
  "validation/p1-desktop.png",
  "validation/p1-desktop-long-title.png",
  "validation/p1-mobile.png",
  "validation/p1-mobile-courses.png",
  "tools/apply-source-audit-20260729.js",
  "tools/audit-links.js",
  "tools/audit-plan-alignment.js",
  "tools/audit-symbols.js",
  "tools/browser-smoke.mjs",
  "tools/build-core-candidates.js",
  "tools/build-site.js",
  "tools/build-data-script.js",
  "tools/build-release.js",
  "tools/migrate-p1-data.js",
  "tools/public-smoke.mjs",
  "tools/replica-smoke.js",
  "tools/second-round-audit.js",
  "tools/validate-project.js"
];

function run(relative, args = []) {
  execFileSync(process.execPath, [path.join(root, relative), ...args], { cwd:root, stdio:"inherit" });
}

run("tools/build-data-script.js", ["--check"]);
run("tools/build-core-candidates.js", ["--check"]);
run("tools/validate-project.js");
run("tools/audit-links.js", ["--offline"]);
run("tools/audit-plan-alignment.js");
run("tools/browser-smoke.mjs");
// 保证 dist/ 为当前源码的新鲜产物：白名单含 dist/sitemap.xml 等构建产物，
// 若不在链路中构建，陈旧 dist 会直接通过存在性检查混入发布包
run("tools/build-site.js");
run("tools/second-round-audit.js");

for (const relative of files) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`发布白名单文件不存在：${relative}`);
}

if (!output.startsWith(releaseRoot + path.sep)) throw new Error("发布输出路径越界");
fs.mkdirSync(releaseRoot, { recursive:true });
fs.rmSync(output, { recursive:true, force:true });
for (const relative of files) {
  const source = path.join(root, relative);
  const target = path.join(output, relative);
  fs.mkdirSync(path.dirname(target), { recursive:true });
  fs.copyFileSync(source, target);
}

// 禁止项按前缀/后缀规则匹配：.env / .env.* 变体（.env.local 等）与常见凭证文件名一并拦截
function isForbiddenName(name) {
  return name === ".edgeone"
    || /^\.env/.test(name)
    || name === "auth.json"
    || /\.(pem|key)$/.test(name)
    || name === "id_rsa"
    || name === ".netrc"
    || name === ".npmrc";
}
// 令牌检测覆盖三种字面量形态：name="value"（单引号/双引号/反引号）与 name=value；
// 模板字符串与裸 token 过去会被漏过。负向断言排除占位符（空串、null、代码符号）
const tokenPattern = /EDGEONE_PAGES_API_TOKEN\s*["'`=:\s]+(?!["'`\s,}\]]|null\b)[A-Za-z0-9._-]{8,}/i;
const tokenPatternAlt = /EDGEONE_[A-Z_]*TOKEN\s*["'`=:\s]+(?!["'`\s,}\]]|null\b)[A-Za-z0-9._-]{8,}/i;
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes:true })) {
    if (isForbiddenName(entry.name)) throw new Error(`发布目录含禁止项：${entry.name}`);
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) scan(full);
    else {
      const content = fs.readFileSync(full).toString("utf8");
      if (tokenPattern.test(content) || tokenPatternAlt.test(content)) {
        throw new Error(`发布目录疑似包含非空部署令牌：${path.relative(output, full)}`);
      }
    }
  }
}
scan(output);
console.log(`已生成并复核 P1.6 白名单发布目录：${path.relative(root, output)}`);
