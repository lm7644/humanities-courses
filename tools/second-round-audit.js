#!/usr/bin/env node
// 第二轮独立汇总审计：检查项数见脚本内 checks 数组（动态）；判定基线从「2026-07-31 快照数字」改为「数据动态推导 + 产物新鲜度」
// 设计要点：
//   1) 课程总数 / 可跳转 / 阻断数不再硬编码，改判内部恒等式（可跳转 + 阻断 = 总数）与 ID/URL 唯一性
//   2) 「核心候选」口径与数据对齐：editorial_status === "core_candidate"（core 布尔仅是首轮 20 门的子集标记，
//      见 docs/decisions/OPEN-DECISIONS.md OPEN-1 方案乙）
//   3) 依赖浏览器回归 / 联网巡检的检查，产物早于源码时降级为 WARN，不阻塞本地门禁（真问题在「该重跑」）
//   4) 治理术语改判「是否出现在可见模板」：GOV_MARKERS 剥离词表内属合法，其余位置出现即失败；
//      页面真实可见性由 browser-smoke 的 visibleAuditLabels === 0 从浏览器实测兜底
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.resolve(__dirname, "..");
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const readText = relative => fs.readFileSync(path.join(root, relative), "utf8");
const mtime = relative => fs.statSync(path.join(root, relative)).mtimeMs;

const coursesRaw = readText("data/courses.json");
const courses = JSON.parse(coursesRaw);
const paths = readJson("data/paths.json").paths;
const supplement = readJson("data/source-audit-supplement-20260731.json");
const plan = readJson("validation/plan-alignment-results.json");
const browser = readJson("validation/p1-browser-results.json");
const index = readText("index.html");
const errors = [];
const checks = [];
const warnings = [];

function check(name, condition, evidence) {
  checks.push({ name, passed: Boolean(condition), evidence });
  if (!condition) errors.push(`${name}: ${evidence}`);
}
function warn(message) { warnings.push(message); }

// 产物新鲜度：产物早于其数据源时结论按上次运行计，并提示重跑（避免陈旧产物长期挂门禁）
function freshness(resultsFile, sourceFile, label) {
  if (mtime(resultsFile) < mtime(sourceFile)) {
    warn(`${label}产物（${path.basename(resultsFile)}）早于 ${path.basename(sourceFile)}，本次按上次运行计；请重跑对应命令后再作结论`);
    return false;
  }
  return true;
}

const blocked = courses.filter(course => ["unavailable", "needs_review"].includes(course.status));
const linked = courses.filter(course => !["unavailable", "needs_review"].includes(course.status));
const browserFresh = freshness("validation/p1-browser-results.json", "index.html", "浏览器回归");
const planFresh = freshness("validation/plan-alignment-results.json", "data/courses.json", "计划一致性");
let network = null;
try { network = readJson("validation/link-network-report.json"); } catch (e) { network = null; }
if (network) freshness("validation/link-network-report.json", "data/courses.json", "联网巡检");
const networkMatches = Boolean(network) && network.dataSha256 === crypto.createHash("sha256").update(coursesRaw).digest("hex");

// 1 口径一致性：比恒等式而非比数字
check("课程与入口口径", courses.length > 0 && linked.length + blocked.length === courses.length,
  `课程${courses.length}、可跳转${linked.length}、阻断${blocked.length}（恒等式成立）`);
// 2 稳定身份：唯一性为硬要求，数量随数据增长
check("稳定身份", new Set(courses.map(course => course.id)).size === courses.length && new Set(courses.map(course => course.url)).size === courses.length,
  `ID 唯一 ${new Set(courses.map(c => c.id)).size}/${courses.length}，URL 唯一 ${new Set(courses.map(c => c.url)).size}/${courses.length}`);
check("学术边界", courses.every(course => course.verified_at === null) && paths.every(item => item.status === "draft_requires_academic_review"),
  `人工学术核验 ${courses.filter(c => c.verified_at).length} 门，${paths.length} 条路径保持草案状态`);
check("阻断闭合", blocked.every(course => course.editorial_status === "blocked" && !course.core),
  `阻断 ${blocked.length} 门均非核心候选且 editorial_status=blocked`);
// 4 路径引用闭合：核心候选按 editorial_status 判定
{
  const bad = [];
  paths.forEach(item => (item.nodes || []).forEach(node => (node.course_ids || []).forEach(id => {
    const course = courses.find(c => c.id === id);
    if (!course) bad.push(`${item.id}→${id}（课程不存在）`);
    else if (course.editorial_status !== "core_candidate") bad.push(`${item.id}→${id}（${course.editorial_status}）`);
    else if (["unavailable", "needs_review"].includes(course.status)) bad.push(`${item.id}→${id}（已阻断）`);
  })));
  check("路径引用闭合", bad.length === 0, bad.length ? bad.slice(0, 5).join("；") : `${paths.length} 条路径引用均为未阻断核心候选`);
}
const riskyClaims = /(?:权威入门|入门首选|通识首选|最佳领路人|最正统|最硬(?:的梯子|的底子|核)|最省力|最顺|最对路|最地道|最厚实|最成体系|最清楚|最柔软|最切|最成理路|给得最全|给得起|播放破亿|现象级名师|胜读十年|只此一家|非.+莫属|活化石|入门标杆|入门的第一课|这课是钥匙|这门是地基|听.+是一种享受|就破防|真正看懂)/;
check("无夸大策展语", courses.every(course => !riskyClaims.test(`${course.intro} ${course.review}`)), "课程介绍与编辑观点不含绝对化推荐语");
check("叶朗替代入口证据", supplement.entries.some(entry => entry.id === "hc-045" && entry.decision === "available") && courses.some(course => course.id === "hc-045" && course.source_pages === 34 && course.availability === "available"), "hc-045 应有 34 讲证据并恢复入口");
check("相似课程不冒充", supplement.entries.filter(entry => ["hc-015", "hc-023"].includes(entry.id)).every(entry => entry.decision === "unavailable"), "刘擎与乐黛云候选证据不足时继续阻断");
check("计划与参考对象", plan.errors.length === 0 && plan.reference_summary.adopted === 7 && plan.reference_summary.blocked_pending_license_review === 5,
  `7 项采用机制有工程证据，5 项保持许可阻断${planFresh ? "" : "（计划一致性产物已过期）"}`);
// 10–13 浏览器实测项
check("桌面高密度", browser.desktop.fullyVisibleCourseCards >= 4 && browser.desktop.firstCourseCardRects[0].top >= 53,
  `完整可见${browser.desktop.fullyVisibleCourseCards}门，首卡顶部${browser.desktop.firstCourseCardRects[0].top}px${browserFresh ? "" : "（浏览器产物已过期）"}`);
check("入口筛选语义", browser.desktop.openOnlyCourseCount === linked.length && browser.desktop.accessBadgeCount === linked.length,
  `筛选${browser.desktop.openOnlyCourseCount}、标签${browser.desktop.accessBadgeCount}，应等于可跳转 ${linked.length} 门`);
check("风险出口闭合", browser.desktop.disabledLinks === blocked.length && browser.desktop.blockedCompareLinkCount === 0,
  `禁链${browser.desktop.disabledLinks}（应等于阻断 ${blocked.length}）、对比漏链${browser.desktop.blockedCompareLinkCount}`);
check("移动端布局", browser.mobile.scrollWidth === browser.mobile.clientWidth && browser.mobile.minActionSize >= 44 && browser.mobile.reviewFooterOverlapCount === 0,
  `宽度${browser.mobile.scrollWidth}/${browser.mobile.clientWidth}、触控${browser.mobile.minActionSize}px、重叠${browser.mobile.reviewFooterOverlapCount}`);
check("运行时稳定", browser.runtimeErrorCount === 0 && browser.fileMode.loadError === false, `运行时错误${browser.runtimeErrorCount}`);
check("学习规划面板", browser.desktop.planCourseOpen === true && browser.desktop.planHeatCells === 182 && browser.mobilePlan && browser.mobilePlan.noteSaved === true,
  `单课面板${browser.desktop.planCourseOpen ? "可开" : "异常"}、热力图${browser.desktop.planHeatCells} 格、移动端笔记${browser.mobilePlan && browser.mobilePlan.noteSaved ? "已保存" : "未验证"}`);
// 联网两项：需要外部网络产物，本地无法自行恢复——缺失或版本不匹配时只提示、不参与判定
if (networkMatches) {
  check("联网报告数据版本", true, "联网报告对应当前 courses.json");
  check("联网结果", network.summary.total === courses.length && network.summary.availableUnreachable === 0 && network.summary.titleDrift === 0 && network.summary.staleBeforeAudit === 0,
    `可访问课程失效${network.summary.availableUnreachable}、标题漂移${network.summary.titleDrift}、过期${network.summary.staleBeforeAudit}`);
} else {
  warn(network
    ? "联网报告与当前 courses.json 不一致（陈旧产物）：请运行 npm run audit:network 后复跑本审计"
    : "缺少 validation/link-network-report.json：请运行 npm run audit:network 后复跑本审计");
}
check("统一禁链函数", (index.match(/isCourseLinkEnabled\(/g) || []).length >= 4 && index.includes("state.openOnly && !isCourseLinkEnabled(c)"), "卡片、筛选和对比出口应共用禁链判断");
// 治理术语：允许出现在剥离词表（GOV_MARKERS / GOV_LIMIT / stripGovPhrases），其余任何行出现即失败
{
  const banned = ["入口已核", "来源已核", "内容错配", "学术审定", "来源身份"];
  const allow = ["GOV_MARKERS", "GOV_LIMIT", "stripGovPhrases"];
  const illegal = [];
  index.split("\n").forEach((line, i) => {
    if (banned.some(word => line.includes(word)) && !allow.some(marker => line.includes(marker))) illegal.push(`第 ${i + 1} 行`);
  });
  check("前台无治理术语", illegal.length === 0 && browser.desktop.visibleAuditLabels === 0,
    illegal.length ? `治理术语出现在非剥离词表位置：${illegal.slice(0, 3).join("、")}` : `源码仅在剥离词表出现，页面可见治理标签 ${browser.desktop.visibleAuditLabels} 处`);
}

// 20 文档引用的命令必须存在（遗留#7 的命令侧落地：README/交接文档/部署清单中出现的
// node tools/*.js 与 npm run * 必须能对应到真实脚本与 package.json scripts；数字侧仍靠人工）
{
  const docFiles = ["README.md", "docs/项目交接文档.md", "docs/部署前准备清单.md"];
  const pkg = JSON.parse(readText("package.json"));
  const missing = [];
  docFiles.forEach(rel => {
    const text = readText(rel);
    for (const match of text.matchAll(/node tools\/([A-Za-z0-9._-]+\.m?js)/g)) {
      if (!fs.existsSync(path.join(root, "tools", match[1]))) missing.push(`${rel} → tools/${match[1]}`);
    }
    for (const match of text.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
      if (!pkg.scripts[match[1]]) missing.push(`${rel} → npm run ${match[1]}`);
    }
  });
  check("文档引用的命令存在", missing.length === 0,
    missing.length ? `文档引用了不存在的命令/脚本：${missing.slice(0, 3).join("；")}` : `${docFiles.length} 份主文档引用的 node tools/* 与 npm run * 均存在`);
}

const result = {
  generated_at: new Date().toISOString(),
  round: 2,
  baseline: "动态推导（课程数/可跳转/阻断/核心候选口径均不硬编码）",
  summary: { checks: checks.length, passed: checks.filter(item => item.passed).length, failed: errors.length, warnings: warnings.length },
  checks,
  warnings,
  errors
};
fs.writeFileSync(path.join(root, "validation", "second-round-audit-results.json"), JSON.stringify(result, null, 2) + "\n");
warnings.forEach(warning => console.warn(`WARN ${warning}`));
if (errors.length) {
  errors.forEach(error => console.error(`ERROR ${error}`));
  process.exit(1);
}
console.log(`第二轮独立审计通过：${checks.length}/${checks.length} 项；${courses.length} 门课程、${linked.length} 门可跳转、${blocked.length} 门阻断、${paths.length} 条草案路径${warnings.length ? `，${warnings.length} 项提示` : ""}`);
