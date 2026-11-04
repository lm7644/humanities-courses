#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const checkOnly = process.argv.includes("--check");
const targets = [
  {
    source: path.join(root, "data", "courses.json"),
    output: path.join(root, "data", "courses.js"),
    globalName: "HUMANITIES_COURSES",
    validate: value => Array.isArray(value),
    error: "data/courses.json 顶层必须是数组"
  },
  {
    source: path.join(root, "data", "paths.json"),
    output: path.join(root, "data", "paths.js"),
    globalName: "HUMANITIES_PATHS",
    validate: value => value && value.schema_version === 1 && Array.isArray(value.paths),
    error: "data/paths.json 顶层结构错误"
  }
];

function build(target) {
  const value = JSON.parse(fs.readFileSync(target.source, "utf8"));
  if (!target.validate(value)) throw new Error(target.error);
  const sourceName = path.basename(target.source);
  return `/* 由 tools/build-data-script.js 从 ${sourceName} 生成，请勿手工修改。 */\nwindow.${target.globalName} = ${JSON.stringify(value, null, 2)};\n`;
}

let failed = false;
for (const target of targets) {
  const expected = build(target);
  const relativeOutput = path.relative(root, target.output);
  if (checkOnly) {
    const actual = fs.existsSync(target.output) ? fs.readFileSync(target.output, "utf8") : "";
    if (actual !== expected) {
      console.error(`${relativeOutput} 与 JSON 源不一致，请运行 npm run build:data`);
      failed = true;
    }
  } else {
    fs.writeFileSync(target.output, expected, "utf8");
    console.log(`已生成 ${relativeOutput}`);
  }
}
if (failed) process.exit(1);
if (checkOnly) console.log("课程与路径数据脚本均与 JSON 一致");
