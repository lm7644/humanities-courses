#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const courses = readJson("data/courses.json");
const pathsDoc = readJson("data/paths.json");
const courseSchema = readJson("data/course.schema.json");
const pathSchema = readJson("data/path.schema.json");
const sourceAudit = readJson("data/source-audit-20260729.json");
const sourceAuditSupplement = readJson("data/source-audit-supplement-20260731.json");
const sourceAuditBili = readJson("data/source-audit-bili-20260828.json");
const sourceAuditSchema = readJson("data/source-audit.schema.json");
const referenceAdoption = readJson("data/reference-adoption.json");
const referenceAdoptionSchema = readJson("data/reference-adoption.schema.json");
const errors = [];
const warnings = [];

function resolveRef(schemaRoot, ref) {
  if (!ref.startsWith("#/")) throw new Error(`仅支持本地 JSON Pointer：${ref}`);
  return ref.slice(2).split("/").reduce((value, key) => value[key.replace(/~1/g, "/").replace(/~0/g, "~")], schemaRoot);
}

function typeMatches(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

function validateSchema(schemaRoot, schema, value, location, output) {
  if (schema.$ref) return validateSchema(schemaRoot, resolveRef(schemaRoot, schema.$ref), value, location, output);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some(type => typeMatches(type, value))) {
    output.push(`${location}: 类型应为 ${types.join("/")}`);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) output.push(`${location}: 值必须为 ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) output.push(`${location}: 非法枚举值 ${JSON.stringify(value)}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) output.push(`${location}: 字符串过短`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) output.push(`${location}: 不符合格式 ${schema.pattern}`);
    if (schema.format === "uri") {
      try { new URL(value); } catch { output.push(`${location}: 不是有效 URI`); }
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) output.push(`${location}: 小于最小值 ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) output.push(`${location}: 项目数少于 ${schema.minItems}`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) output.push(`${location}: 数组项目必须唯一`);
    if (schema.items) value.forEach((item, index) => validateSchema(schemaRoot, schema.items, item, `${location}[${index}]`, output));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) output.push(`${location}.${key}: 缺失`);
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (key in value) validateSchema(schemaRoot, child, value[key], `${location}.${key}`, output);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) if (!allowed.has(key)) output.push(`${location}.${key}: 未声明字段`);
    }
  }
}

// —— Schema 关键字 fail-fast（M-06）——
// 背景：validateSchema 对不认识的校验关键字静默跳过，schema 一旦写成 maxLength/oneOf/anyOf
// 之类，会得到"校验通过"的假象。这里在真正校验前断言四个 schema 只使用校验器确实实现的
// 关键字子集；$schema/$id/title/description 为无校验语义的元数据，$defs 为定义容器
// （其内部同样递归检查，避免定义体里的未支持关键字被漏掉）。
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$ref", "type", "const", "enum", "minLength", "pattern", "format", "minimum",
  "minItems", "uniqueItems", "items", "required", "properties", "additionalProperties",
  "$schema", "$id", "title", "description", "$defs"
]);
function assertSchemaKeywords(schema, schemaName, location) {
  if (!schema || typeof schema !== "object") return;
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      errors.push(`${schemaName}${location}: 使用了不支持的校验关键字 ${key}（校验器拒绝静默跳过）`);
    }
    if (key === "properties" && value && typeof value === "object") {
      for (const [prop, child] of Object.entries(value)) assertSchemaKeywords(child, schemaName, `${location}.properties.${prop}`);
    }
    if (key === "items" && value && typeof value === "object") {
      assertSchemaKeywords(value, schemaName, `${location}.items`);
    }
    if (key === "$defs" && value && typeof value === "object") {
      for (const [def, child] of Object.entries(value)) assertSchemaKeywords(child, schemaName, `${location}.$defs.${def}`);
    }
  }
}
assertSchemaKeywords(courseSchema, "courseSchema", "");
assertSchemaKeywords(pathSchema, "pathSchema", "");
assertSchemaKeywords(sourceAuditSchema, "sourceAuditSchema", "");
assertSchemaKeywords(referenceAdoptionSchema, "referenceAdoptionSchema", "");

if (!Array.isArray(courses)) {
  errors.push("courses.json 顶层必须是数组");
} else {
  courses.forEach((course, index) => validateSchema(courseSchema, courseSchema, course, `courses[${index}]`, errors));
}
validateSchema(pathSchema, pathSchema, pathsDoc, "paths", errors);
validateSchema(sourceAuditSchema, sourceAuditSchema, sourceAudit, "sourceAudit", errors);
validateSchema(sourceAuditSchema, sourceAuditSchema, sourceAuditSupplement, "sourceAuditSupplement", errors);
validateSchema(sourceAuditSchema, sourceAuditSchema, sourceAuditBili, "sourceAuditBili", errors);
validateSchema(referenceAdoptionSchema, referenceAdoptionSchema, referenceAdoption, "referenceAdoption", errors);

const urls = new Map();
const ids = new Map();
const inflatedEditorialClaims = /(?:权威入门|入门首选|通识首选|最佳领路人|最正统|最硬(?:的梯子|的底子|核)|最省力|最顺|最对路|最地道|最厚实|最成体系|最清楚|最柔软|最切|最成理路|给得最全|给得起|播放破亿|现象级名师|胜读十年|只此一家|非.+莫属|活化石|入门标杆|入门的第一课|这课是钥匙|这门是地基|听.+是一种享受|就破防)/;
for (const [index, course] of (Array.isArray(courses) ? courses : []).entries()) {
  const label = `第 ${index + 1} 条 ${course.name || "<未命名>"}`;
  const idRecords = ids.get(course.id) || [];
  idRecords.push(label);
  ids.set(course.id, idRecords);
  const urlRecords = urls.get(course.url) || [];
  urlRecords.push(label);
  urls.set(course.url, urlRecords);

  if (["unavailable", "needs_review"].includes(course.status) && !/暂停|待核|不可用|不符/.test(course.schedule)) {
    errors.push(`${label}: ${course.status} 状态缺少明确暂停/待核说明`);
  }
  if (["unavailable", "needs_review"].includes(course.status) && course.editorial_status !== "blocked") {
    errors.push(`${label}: 暂停课程必须标为 blocked`);
  }
  if (course.editorial_status === "blocked" && course.core) errors.push(`${label}: blocked 课程不能进入核心候选`);
  // core 双档语义：core_candidate 分「已入库核心候选」(core=true) 与「扩展草案候选」(core=false，待学术审定晋升)。
  // 草案候选仅限扩展板块（国画/书法）的 bilibili_series 新课；其余课程 core_candidate 必须 core=true。
  if (course.editorial_status === "core_candidate" && !course.core) {
    const isExtensionDraft = (course.category === "国画" || course.category === "书法") && course.source_type === "bilibili_series";
    if (!isExtensionDraft) errors.push(`${label}: core_candidate 扩展草案档仅限国画/书法板块 bilibili_series 新课，须设置 core=true 或改标 catalog_candidate`);
  }
  if (course.core && !["core_candidate", "verified"].includes(course.editorial_status)) errors.push(`${label}: core=true 与编辑状态冲突`);
  if (course.status === "closed" && course.availability !== "course_closed") errors.push(`${label}: closed 必须对应 course_closed`);
  if (course.status === "needs_review" && course.availability !== "content_mismatch") errors.push(`${label}: needs_review 必须对应 content_mismatch`);
  if (course.status === "unavailable" && course.availability !== "unavailable") errors.push(`${label}: unavailable 状态不一致`);
  if (course.editorial_status === "verified" && !(course.verified_at && course.verified_by && course.verification_method)) {
    errors.push(`${label}: verified 缺少人工核验时间、人员或方法`);
  }
  // —— B 站系列视频扩展门禁（《竞品调研与功能扩展方案》2.2-C）——
  if (course.source_type === "bilibili_series") {
    if (course.platform_video === true) errors.push(`${label}: bilibili_series 与 platform_video 互斥`);
    const series = course.series;
    if (!series || typeof series !== "object") {
      errors.push(`${label}: bilibili_series 必须填写 series 结构`);
    } else {
      if (!(series.total_pages >= 12) && !(series.duration_seconds >= 10800)) {
        errors.push(`${label}: 系列视频未达收录门槛（需 ≥12 分P 或 ≥3h）`);
      }
      if (!series.collected_at) errors.push(`${label}: series 缺少 collected_at 采集日期`);
    }
    const evidence = Array.isArray(course.quality_evidence) ? course.quality_evidence.join(" ") : "";
    if (!/接口|API|返回/.test(evidence)) errors.push(`${label}: bilibili_series 的 quality_evidence 必须记录接口返回值`);
    const limits = Array.isArray(course.known_limits) ? course.known_limits.join(" ") : "";
    if (!/学术审定/.test(limits)) errors.push(`${label}: bilibili_series 的 known_limits 必须声明教学质量未经学术审定`);
  }
  if (inflatedEditorialClaims.test(`${course.intro || ""} ${course.review || ""}`)) {
    errors.push(`${label}: 编辑文案含无证据的绝对化推荐语`);
  }
  // —— 检索可用性门禁 ——
  // pinyin / _pinyinAbbr 是拼音与模糊检索的唯一输入（设计文档 2.1）。当前无 pinyin-pro
  // 构建期注入、字段靠数据维护，故在此设卡：缺字段即报错，避免新增或改名课程后
  // 检索质量静默退化而门禁毫无察觉。
  if (!course.pinyin || !course._pinyinAbbr) {
    errors.push(`${label}: 缺少拼音派生字段 pinyin/_pinyinAbbr，拼音与模糊检索会失效`);
  }
  const alt = Array.isArray(course.alternative_views) ? course.alternative_views : [];
  if (new Set(alt).size !== alt.length) errors.push(`${label}: alternative_views 含重复 ID`);
  if (alt.includes(course.id)) errors.push(`${label}: alternative_views 不得引用自身`);
}
for (const [id, records] of ids) if (records.length > 1) errors.push(`重复课程 ID: ${id} -> ${records.join("；")}`);
for (const [url, records] of urls) if (records.length > 1) errors.push(`重复 URL: ${url} -> ${records.join("；")}`);
const byId = new Map(courses.map(course => [course.id, course]));
for (const course of courses) {
  for (const otherId of course.alternative_views || []) {
    const other = byId.get(otherId);
    if (!other) {
      errors.push(`${course.id}: alternative_views 引用不存在课程 ${otherId}`);
      continue;
    }
    if (!(other.alternative_views || []).includes(course.id)) {
      errors.push(`${course.id} 与 ${otherId} 的 alternative_views 必须双向一致`);
    }
  }
}
function courseNameKey(name) {
  return String(name || "").replace(/[·・\s]/g, "");
}
const sameNameGroups = new Map();
for (const course of courses) {
  const key = `${course.teacher}::${courseNameKey(course.name)}`;
  const list = sameNameGroups.get(key) || [];
  list.push(course);
  sameNameGroups.set(key, list);
}
for (const list of sameNameGroups.values()) {
  if (list.length < 2) continue;
  const groupIds = new Set(list.map(course => course.id));
  for (const course of list) {
    const linked = new Set(course.alternative_views || []);
    const missing = [...groupIds].filter(id => id !== course.id && !linked.has(id));
    if (missing.length) warnings.push(`${course.id} 与同讲师同课名课程 ${missing.join("、")} 未建立 alternative_views 关联`);
  }
}
// 核心候选规模：P1 样板 20 门为底数；扩展板块（国画/书法）草案课程标 core_candidate 但不设 core，
// 待教师学术审定后晋升 core 并重建 core-candidates.json。账本必须覆盖全部 core=true 课程。
const coreCourses = courses.filter(course => course.core);
const coreCandidatesFile = readJson("data/core-candidates.json");
if (coreCourses.length < 20) errors.push(`核心候选课程不得少于 P1 样板期基准 20 门（当前 ${coreCourses.length}）`);
if (coreCandidatesFile && Array.isArray(coreCandidatesFile.candidates)) {
  const ledgerIds = new Set(coreCandidatesFile.candidates.map(item => item.id));
  for (const course of coreCourses) {
    if (!ledgerIds.has(course.id)) errors.push(`core=true 课程未登记进 core-candidates.json：${course.id}`);
  }
  for (const item of coreCandidatesFile.candidates) {
    const course = courses.find(c => c.id === item.id);
    if (!course) errors.push(`core-candidates.json 引用不存在课程：${item.id}`);
    else if (!course.core) errors.push(`core-candidates.json 登记了已非 core 的课程：${item.id}`);
  }
}
if (courses.some(course => course.availability === "needs_review")) errors.push("来源审核完成版不得残留 availability=needs_review");
if (sourceAudit.count !== sourceAudit.entries.length) errors.push("来源审核账本 count 与 entries 数量不一致");
if (new Set(sourceAudit.entries.map(entry => entry.id)).size !== sourceAudit.entries.length) errors.push("来源审核账本存在重复课程 ID");
for (const entry of sourceAudit.entries) {
  const course = courses.find(item => item.id === entry.id);
  if (!course) errors.push(`来源审核账本引用不存在课程：${entry.id}`);
  const supplement = sourceAuditSupplement.entries.find(item => item.id === entry.id);
  if (course && !supplement && course.availability !== entry.decision) errors.push(`来源审核账本与课程结论不一致：${entry.id}`);
}
// B 站系列收录账本：逐门登记，且必须覆盖全部 bilibili_series 课程
if (sourceAuditBili.count !== sourceAuditBili.entries.length) errors.push("B站系列审核账本 count 与 entries 数量不一致");
if (new Set(sourceAuditBili.entries.map(entry => entry.id)).size !== sourceAuditBili.entries.length) errors.push("B站系列审核账本存在重复课程 ID");
const biliLedgerIds = new Set(sourceAuditBili.entries.map(entry => entry.id));
for (const course of courses) {
  if (course.source_type === "bilibili_series" && !biliLedgerIds.has(course.id)) {
    errors.push(`bilibili_series 课程未登记进 B站系列审核账本：${course.id}`);
  }
}
for (const entry of sourceAuditBili.entries) {
  const course = courses.find(item => item.id === entry.id);
  if (!course) errors.push(`B站系列审核账本引用不存在课程：${entry.id}`);
  else if (course.availability !== entry.decision) errors.push(`B站系列审核账本与课程结论不一致：${entry.id}`);
  if (entry.academic_verification !== "not_completed") errors.push(`B站系列审核账本条目未如实标注未审定：${entry.id}`);
}
if (sourceAuditSupplement.count !== sourceAuditSupplement.entries.length) errors.push("补充来源审核账本 count 与 entries 数量不一致");
if (new Set(sourceAuditSupplement.entries.map(entry => entry.id)).size !== sourceAuditSupplement.entries.length) errors.push("补充来源审核账本存在重复课程 ID");
for (const entry of sourceAuditSupplement.entries) {
  const course = courses.find(item => item.id === entry.id);
  if (!course) errors.push(`补充来源审核账本引用不存在课程：${entry.id}`);
  else if (course.availability !== entry.decision) errors.push(`补充来源审核账本与课程结论不一致：${entry.id}`);
}

const requiredReferenceNames = [
  "OSSU Computer Science", "CS自学指南", "Hocbigg Literature", "Hocbigg Philosophy",
  "Open Learning Paths", "Class Central", "Open Culture", "OER Commons", "MIT OpenCourseWare",
  "Open Yale Courses", "Stanford Encyclopedia of Philosophy", "OpenStax"
];
const removedLowValueReferenceNames = [
  "Collecobrary", "MOOC Search", "清华大学图书馆开放课程系统", "网易公开课",
  "Patth", "Pathio", "Ornix", "Learnbase"
];
if (referenceAdoption.count !== referenceAdoption.entries.length) errors.push("外部参考纳入账本 count 与 entries 数量不一致");
if (new Set(referenceAdoption.entries.map(entry => entry.reference_id)).size !== referenceAdoption.entries.length) errors.push("外部参考纳入账本存在重复 reference_id");
for (const name of requiredReferenceNames) if (!referenceAdoption.entries.some(entry => entry.name === name)) errors.push(`外部参考对象未纳入计划：${name}`);
for (const name of removedLowValueReferenceNames) if (referenceAdoption.entries.some(entry => entry.name === name)) errors.push(`已删除的低价值对象不得重新进入活动计划：${name}`);
for (const entry of referenceAdoption.entries) {
  if (["deferred", "excluded", "blocked_pending_license_review"].includes(entry.current_status) && !entry.trigger_condition) errors.push(`${entry.name}: 后置/排除/阻断项目缺少触发条件`);
  if (entry.reference_type === "primary_resource" && !entry.license_or_terms_source && entry.current_status !== "blocked_pending_license_review") errors.push(`${entry.name}: 未记录许可来源时必须保持许可证阻断状态`);
  if (entry.adoption_mode === "method_only" && !/未复制|不复制/.test(entry.reuse_boundary)) errors.push(`${entry.name}: 方法借鉴未明确代码与资产复制边界`);
  if (!entry.engineering_location.length || !entry.acceptance_criteria.length) errors.push(`${entry.name}: 缺少工程落点或验收标准`);
}

if (pathsDoc && Array.isArray(pathsDoc.paths)) {
  // 路径规模：P1 样板 3 条为底数，扩展草案路径（国画/书法）status 必须保持 draft_requires_academic_review
  const P1_SAMPLE_PATH_IDS = new Set(["path-myth-from-story-to-study", "path-literary-theory-to-analysis", "path-classical-poetry-close-reading"]);
  if (pathsDoc.paths.length < 3) errors.push("样板路径不得少于 3 条");
  const missingP1 = [...P1_SAMPLE_PATH_IDS].filter(id => !pathsDoc.paths.some(p => p.id === id));
  if (missingP1.length) errors.push(`P1 样板路径缺失：${missingP1.join("、")}`);
  const pathIds = new Set();
  const nodeIds = new Set();
  for (const learningPath of pathsDoc.paths) {
    const label = `路径 ${learningPath.id || "<未命名>"}`;
    if (pathIds.has(learningPath.id)) errors.push(`${label}: 路径 ID 重复`);
    pathIds.add(learningPath.id);
    const isP1Sample = P1_SAMPLE_PATH_IDS.has(learningPath.id);
    if (!isP1Sample && learningPath.status !== "draft_requires_academic_review") {
      errors.push(`${label}: 扩展草案路径必须保持 draft_requires_academic_review 状态`);
    }
    if (learningPath.status !== "draft_requires_academic_review") warnings.push(`${label}: 已离开草案状态，请确认发布门禁已执行`);
    for (const node of learningPath.nodes || []) {
      if (nodeIds.has(node.id)) errors.push(`${label}: 节点 ID 重复 ${node.id}`);
      nodeIds.add(node.id);
      if (node.week > learningPath.duration_weeks) errors.push(`${label}/${node.id}: 周次超出路径时长`);
      if (node.type === "course" && !(node.course_ids || []).length) errors.push(`${label}/${node.id}: course 节点未引用课程`);
      for (const courseId of node.course_ids || []) {
        const course = courses.find(item => item.id === courseId);
        if (!course) errors.push(`${label}/${node.id}: 引用了不存在课程 ${courseId}`);
        else {
          if (course.editorial_status === "blocked") errors.push(`${label}/${node.id}: 引用了 blocked 课程 ${courseId}`);
          // P1 样板路径只引用核心候选；扩展草案路径允许引用 core_candidate（课程待教师审定后晋升 core）
          if (isP1Sample && !course.core) errors.push(`${label}/${node.id}: 样板路径引用了非核心候选课程 ${courseId}`);
          if (!isP1Sample && !course.core && course.editorial_status !== "core_candidate") {
            errors.push(`${label}/${node.id}: 扩展路径引用了非 core_candidate 课程 ${courseId}`);
          }
        }
      }
      if ((node.course_ids || []).length && node.scope_status === "not_applicable") errors.push(`${label}/${node.id}: 有课程引用却未标记范围核验状态`);
    }
  }
}

// —— 凭证与部署令牌门禁（M-05）——
// 禁止项按前缀/后缀规则匹配（与 tools/build-release.js 的发布扫描口径一致）：
// .edgeone、.env/.env.* 变体、auth.json、*.pem/*.key、id_rsa、.netrc、.npmrc
function isForbiddenRootEntry(name) {
  return name === ".edgeone"
    || /^\.env/.test(name)
    || name === "auth.json"
    || /\.(pem|key)$/.test(name)
    || name === "id_rsa"
    || name === ".netrc"
    || name === ".npmrc";
}
for (const entry of fs.readdirSync(root, { withFileTypes:true })) {
  if (isForbiddenRootEntry(entry.name)) errors.push(`项目根目录不得包含 ${entry.name}`);
}

// 源码树令牌扫描：build-release.js 只扫发布输出，令牌若已落在仓库源码里同样必须拦住。
// 覆盖 name="value"（单引号/双引号/反引号）与 name=value 两种字面量形态；
// 跳过版本库/依赖/构建产物四个目录，以及超过 1MB 与 .png/.jpg/.zip 二进制文件。
const tokenPattern = /EDGEONE_PAGES_API_TOKEN\s*["'`=:\s]+(?!["'`\s,}\]]|null\b)[A-Za-z0-9._-]{8,}/i;
const tokenPatternAlt = /EDGEONE_[A-Z_]*TOKEN\s*["'`=:\s]+(?!["'`\s,}\]]|null\b)[A-Za-z0-9._-]{8,}/i;
const SKIP_SCAN_DIRS = new Set([".git", "node_modules", "dist", "release"]);
const SKIP_SCAN_FILES = /\.(png|jpg|zip)$/i;
function scanSourceTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes:true })) {
    if (entry.isDirectory()) {
      if (!SKIP_SCAN_DIRS.has(entry.name)) scanSourceTree(path.join(directory, entry.name));
      continue;
    }
    if (SKIP_SCAN_FILES.test(entry.name)) continue;
    const full = path.join(directory, entry.name);
    try {
      if (!fs.statSync(full).isFile() || fs.statSync(full).size > 1024 * 1024) continue;
      const content = fs.readFileSync(full, "utf8");
      if (tokenPattern.test(content) || tokenPatternAlt.test(content)) {
        errors.push(`源码树疑似包含部署令牌：${path.relative(root, full)}`);
      }
    } catch {
      // 不可读或非文本文件跳过（二进制按 utf8 读取不会抛错，此处仅兜住权限等异常）
    }
  }
}
scanSourceTree(root);

for (const requiredFile of [
  "data/course.schema.json", "data/path.schema.json", "data/core-candidates.json",
  "data/source-audit-20260729.json", "data/source-audit-supplement-20260731.json", "data/source-audit.schema.json",
  "data/reference-adoption.json", "data/reference-adoption.schema.json",
  "data/templates/course.example.json", "data/templates/path.example.json",
  "docs/P1数据字段字典.md", "docs/P1目标用户与验证假设.md", "docs/P1内容治理与教师共建规则.md",
  "docs/P1部署与域名方案.md", "docs/P1初版使用说明.md", "docs/P1.3高密度课程卡与滚动导航验收记录_20260729.md",
  "docs/P1.4课程识别与计划闭环验收记录_20260730.md", "docs/P1.5课程题签与精简计划验收记录_20260730.md",
  "docs/P1.6双轮审计与公网发布验收记录_20260731.md", "docs/当前进度与新方案一致性审计_20260730.md",
  "docs/项目复刻与可借鉴方案.md", "tools/build-site.js", "tools/replica-smoke.js",
  "tools/audit-plan-alignment.js", "tools/second-round-audit.js"
]) {
  if (!fs.existsSync(path.join(root, requiredFile))) errors.push(`缺少 ${requiredFile}`);
}
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
for (const forbidden of ["课程、讲师与封面均为真实公开内容", "●永久开放", "含鉴权参数", "REC_URLS", "data-url", "dataset.url", "哈佛导读但丁"]) {
  if (index.includes(forbidden)) errors.push(`index.html 仍含高风险或旧主键内容：${forbidden}`);
}
for (const requiredScript of ["data/courses.js", "data/paths.js"]) if (!index.includes(requiredScript)) errors.push(`index.html 未加载 ${requiredScript}`);

// —— 中性色 Token 对比度门禁：次要文字在页面底/卡片底/次级底三档均须达 WCAG AA（4.5:1）——
// 背景取自 :root 与 [data-theme="light"] 各自声明的 --bg/--surface/--surface-2；改动 Token 后此门禁会拦住回退
{
  const luminance = hex => {
    const channel = value => {
      const c = parseInt(value, 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(hex.slice(0, 2)) + 0.7152 * channel(hex.slice(2, 4)) + 0.0722 * channel(hex.slice(4, 6));
  };
  const ratio = (a, b) => {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const tokensOf = body => {
    const pick = name => (String(body).match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1];
    return { muted: pick("muted"), bg: pick("bg"), surface: pick("surface"), surface2: pick("surface-2") };
  };
  const darkBody = (index.match(/:root\{([\s\S]*?)\n  \}/) || [])[1];
  const lightBody = (index.match(/\[data-theme="light"\]\{([\s\S]*?)\n  \}/) || [])[1];
  const themes = [["暗色", darkBody], ["亮色", lightBody]];
  for (const [label, body] of themes) {
    if (!body) { errors.push(`index.html 未能解析${label}主题 Token 块`); continue; }
    const tokens = tokensOf(body);
    if (!tokens.muted || !tokens.bg || !tokens.surface || !tokens.surface2) {
      errors.push(`${label}主题缺少 --muted/--bg/--surface/--surface-2 之一，无法执行对比度门禁`);
      continue;
    }
    const ratios = [tokens.bg, tokens.surface, tokens.surface2].map(bg => ratio(tokens.muted.slice(1), bg.slice(1)));
    const min = Math.min(...ratios);
    if (min < 4.5) errors.push(`${label}主题 --muted ${tokens.muted} 对比度不足 4.5:1（实测 ${min.toFixed(2)}:1）`);
    else console.log(`  中性色 ${label}主题 --muted ${tokens.muted}：${ratios.map(r => r.toFixed(2)).join(" / ")}:1（底/卡/次级底）`);
  }
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exit(1);
}
console.log(`校验通过：${courses.length} 门课程，${ids.size} 个唯一 ID，${urls.size} 个唯一 URL，${pathsDoc.paths.length} 条路径，${referenceAdoption.entries.length} 个外部参考对象，Schema 与业务门禁均通过`);
