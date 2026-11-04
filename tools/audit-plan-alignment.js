#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const workspace = path.resolve(root, "../../..");
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const readText = relative => fs.readFileSync(path.join(root, relative), "utf8");
const courses = readJson("data/courses.json");
const pathsDoc = readJson("data/paths.json");
const references = readJson("data/reference-adoption.json");
const index = readText("index.html");
const browserTest = readText("tools/browser-smoke.mjs");
const validator = readText("tools/validate-project.js");
const errors = [];
const evidence = [];

function assert(condition, message) {
  if (!condition) errors.push(message);
}
function record(reference, location, proof) {
  evidence.push({ reference, location, proof });
}

const courseIds = new Set(courses.map(course => course.id));
assert(courseIds.size === courses.length, "课程稳定 ID 必须唯一");
assert(courses.every(course => /^hc-\d{3}$/.test(course.id)), "课程稳定 ID 格式必须统一");
assert(courses.filter(course => course.core).length >= 20, "核心候选不得少于 P1 样板期基准 20 门");
assert(courses.every(course => course.verified_at === null), "教师学术审定为 0 时不得出现 verified_at");
assert(pathsDoc.paths.length >= 3, "样板路径不得少于 3 条");
assert(pathsDoc.paths.filter(item => ["path-myth-from-story-to-study","path-literary-theory-to-analysis","path-classical-poetry-close-reading"].includes(item.id)).length === 3, "P1 三条样板路径必须完整保留");
assert(pathsDoc.paths.every(item => item.status === "draft_requires_academic_review"), "全部路径必须继续标为待学术复核草案");
assert(pathsDoc.paths.every(item => item.nodes.every(node => node.week <= item.duration_weeks && node.instruction && node.evidence)), "路径节点应包含顺序、任务与学习证据");
assert(index.includes("hm-path-progress") && index.includes("sanitizePathProgress") && browserTest.includes("pathProgressSanitized"), "路径本地进度、坏存档清洗与回归证据缺失");
assert(index.includes("hm-favs") && index.includes("compareList") && index.includes("miniPlatform"), "目录收藏、对比与主要筛选机制缺失");
assert(validator.includes("removedLowValueReferenceNames"), "低价值参考对象回归门禁缺失");

const adoptedChecks = {
  "ref-ossu-cs": () => pathsDoc.paths.every(item => item.outcomes.length && item.nodes.some(node => ["practice", "reflection", "synthesis"].includes(node.type))),
  "ref-cs-self-learning": () => courseIds.size === courses.length && courses.some(course => course.editorial_status === "blocked") && validator.includes("blocked 课程不能进入核心候选"),
  "ref-hocbigg-literature": () => pathsDoc.paths.some(item => item.id === "path-classical-poetry-close-reading" && item.nodes.some(node => node.type === "primary_text") && item.nodes.some(node => node.type === "practice")),
  "ref-hocbigg-philosophy": () => pathsDoc.paths.some(item => item.id === "path-literary-theory-to-analysis" && item.nodes.some(node => node.type === "primary_text") && item.nodes.some(node => node.type === "reflection")),
  "ref-open-learning-paths": () => index.includes("renderPaths") && index.includes("focusCourseFromPath") && browserTest.includes("pathCourseFocusMatches"),
  "ref-class-central": () => courses.every(course => course.source_type && course.access_mode && "link_checked_at" in course && "availability" in course),
  "ref-open-culture": () => courses.every(course => course.rights_basis) && index.includes("本站只提供外部链接与编辑整理，不托管课程内容")
};

for (const entry of references.entries) {
  for (const location of entry.engineering_location) {
    assert(fs.existsSync(path.join(root, location)), `${entry.name}: 工程落点不存在 ${location}`);
  }
  if (entry.current_status === "adopted") {
    const check = adoptedChecks[entry.reference_id];
    assert(Boolean(check), `${entry.name}: 缺少采用机制的专项审计规则`);
    assert(check && check(), `${entry.name}: 声明已采用但未找到足够工程证据`);
    record(entry.name, entry.engineering_location.join("、"), "当前采用机制已在代码、数据和回归中找到对应证据");
  } else if (entry.current_status === "blocked_pending_license_review") {
    const serialized = JSON.stringify({ courses, paths: pathsDoc.paths });
    assert(!serialized.includes(entry.evidence_url), `${entry.name}: 许可阻断资源不应进入当前课程或路径数据`);
    assert(Boolean(entry.trigger_condition), `${entry.name}: 许可阻断项缺少后续触发条件`);
    record(entry.name, "data/reference-adoption.json", "保持许可阻断，未进入当前课程与路径正文");
  }
}

assert(references.entries.filter(entry => entry.current_status === "adopted").length === 7, "当前采用对象应为 7 项");
assert(references.entries.filter(entry => entry.current_status === "blocked_pending_license_review").length === 5, "许可阻断对象应为 5 项");

const report = {
  generated_at: new Date().toISOString(),
  phase_state: {
    p0_local_remediation: "complete_local_only",
    p1_engineering_and_source_entry_audit: "complete_one_round",
    p1_academic_verification: "not_started",
    p2_learning_paths: "draft_requires_academic_review",
    p3_user_pilot: "not_started"
  },
  reference_summary: {
    total: references.entries.length,
    adopted: references.entries.filter(entry => entry.current_status === "adopted").length,
    blocked_pending_license_review: references.entries.filter(entry => entry.current_status === "blocked_pending_license_review").length
  },
  evidence,
  errors
};
fs.mkdirSync(path.join(root, "validation"), { recursive: true });
fs.writeFileSync(path.join(root, "validation", "plan-alignment-results.json"), JSON.stringify(report, null, 2) + "\n");
if (errors.length) {
  errors.forEach(error => console.error(`ERROR ${error}`));
  process.exit(1);
}
console.log(`计划一致性通过：7项当前采用机制有工程证据，5项许可阻断保持边界，P2仍为草案，P3仍未开始`);
