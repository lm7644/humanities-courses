#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const replica = fs.mkdtempSync(path.join(os.tmpdir(), "humanities-courses-replica-"));
const whitelist = [
  "index.html", "README.md", "package.json",
  "data/course.schema.json", "data/path.schema.json", "data/source-audit.schema.json", "data/reference-adoption.schema.json",
  "data/courses.json", "data/courses.js", "data/paths.json", "data/paths.js",
  "data/core-candidates.json", "data/source-audit-20260729.json", "data/source-audit-supplement-20260731.json",
  "data/source-audit-bili-20260828.json", "data/reference-adoption.json",
  "data/templates/course.example.json", "data/templates/path.example.json",
  "docs/P1数据字段字典.md", "docs/P1目标用户与验证假设.md", "docs/P1内容治理与教师共建规则.md",
  "docs/P1部署与域名方案.md", "docs/P1初版使用说明.md", "docs/P1.3高密度课程卡与滚动导航验收记录_20260729.md",
  "docs/P1.4课程识别与计划闭环验收记录_20260730.md", "docs/P1.5课程题签与精简计划验收记录_20260730.md",
  "docs/P1.6双轮审计与公网发布验收记录_20260731.md", "docs/当前进度与新方案一致性审计_20260730.md",
  "docs/项目复刻与可借鉴方案.md",
  "tools/audit-links.js", "tools/audit-plan-alignment.js", "tools/browser-smoke.mjs", "tools/build-core-candidates.js",
  "tools/build-data-script.js", "tools/build-site.js", "tools/replica-smoke.js", "tools/second-round-audit.js", "tools/validate-project.js"
];

function copy(relative) {
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) throw new Error(`复刻白名单缺少：${relative}`);
  const target = path.join(replica, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function scanForbidden(directory) {
  const forbidden = new Set([".edgeone", ".env", "auth.json"]);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (forbidden.has(entry.name)) throw new Error(`复刻副本含禁止项：${entry.name}`);
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) scanForbidden(full);
  }
}

try {
  whitelist.forEach(copy);
  scanForbidden(replica);
  execFileSync(process.execPath, ["tools/build-data-script.js", "--check"], { cwd: replica, stdio: "inherit" });
  execFileSync(process.execPath, ["tools/build-core-candidates.js", "--check"], { cwd: replica, stdio: "inherit" });
  execFileSync(process.execPath, ["tools/validate-project.js"], { cwd: replica, stdio: "inherit" });
  execFileSync(process.execPath, ["tools/build-site.js"], { cwd: replica, stdio: "inherit" });
  execFileSync(process.execPath, ["tools/browser-smoke.mjs", "--site-root", "dist"], { cwd: replica, stdio: "inherit" });
  scanForbidden(path.join(replica, "dist"));
  console.log(`空目录复刻演练通过：${replica}`);
} finally {
  fs.rmSync(replica, { recursive: true, force: true });
}
