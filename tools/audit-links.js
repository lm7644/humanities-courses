#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.resolve(__dirname, "..");
const dataPath = path.join(root, "data", "courses.json");
const network = process.argv.includes("--network");
const offline = process.argv.includes("--offline") || !network;
const reportPath = network
  ? path.join(root, "validation", "link-network-report.json")
  : path.join(root, "link-report.json");
const timeoutMs = 15000;
const concurrency = 6;
const staleAfterDays = 90;

const raw = fs.readFileSync(dataPath, "utf8");
const courses = JSON.parse(raw);
const dataSha256 = crypto.createHash("sha256").update(raw).digest("hex");

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

function normalizeTitle(value) {
  return String(value || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function titleSimilarity(left, right) {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) return null;
  if (a === b || a.includes(b) || b.includes(a)) return 1;
  const bigrams = value => {
    const result = [];
    for (let index = 0; index < value.length - 1; index++) result.push(value.slice(index, index + 2));
    return result;
  };
  const aa = bigrams(a);
  const bb = bigrams(b);
  const counts = new Map();
  aa.forEach(item => counts.set(item, (counts.get(item) || 0) + 1));
  let overlap = 0;
  bb.forEach(item => {
    const count = counts.get(item) || 0;
    if (count) { overlap++; counts.set(item, count - 1); }
  });
  return aa.length + bb.length ? (2 * overlap) / (aa.length + bb.length) : 0;
}

function ageInDays(dateValue) {
  if (!dateValue) return null;
  const time = Date.parse(`${dateValue}T00:00:00Z`);
  return Number.isFinite(time) ? Math.floor((Date.now() - time) / 86400000) : null;
}

function extractBilibiliId(url) {
  const match = url.match(/\/video\/(BV[0-9A-Za-z]+|av(\d+))/i);
  if (!match) return null;
  return match[1].toLowerCase().startsWith("av")
    ? { type: "aid", value: match[2] }
    : { type: "bvid", value: match[1] };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 humanities-courses-audit/0.1" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  return { response, json: await response.json() };
}

async function auditBilibili(course) {
  const id = extractBilibiliId(course.url);
  if (!id) return null;
  const api = `https://api.bilibili.com/x/web-interface/view?${id.type}=${encodeURIComponent(id.value)}`;
  try {
    const { response, json } = await fetchJson(api);
    const ok = response.ok && json.code === 0 && json.data;
    return {
      method: "bilibili-api",
      reachable: Boolean(ok),
      assessment: ok ? "reachable" : "unreachable",
      httpCode: response.status,
      apiCode: json.code,
      sourceTitle: ok ? json.data.title : null,
      sourceOwner: ok ? json.data.owner && json.data.owner.name : null,
      sourceDurationSeconds: ok ? json.data.duration : null,
      sourcePages: ok && Array.isArray(json.data.pages) ? json.data.pages.length : null,
      manualReviewRequired: true,
      note: ok ? "API 可读；标题、课程范围、授权与策展描述仍需人工比对" : (json.message || "B站 API 未返回有效视频")
    };
  } catch (error) {
    return { method: "bilibili-api", reachable: null, assessment: "inconclusive", httpCode: 0, apiCode: null, manualReviewRequired: true, note: error.name || error.message };
  }
}

// SSRF 控制：课程数据中的 URL 会被直接 fetch，需先阻断内网/回环/链路本地等非公网目标
// （覆盖 IPv4 私网与保留段、IPv6 回环与 ULA/链路本地、.local/.internal 后缀）。
// 注意：redirect:"follow" 保留，重定向目标仍可能跳向内网——残余风险在报告与部署文档中说明。
function isPublicHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  if (!h || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || /^0\./.test(h)) return false;
  if (h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return false;
  return true;
}

async function auditHttp(course) {
  let parsed;
  try { parsed = new URL(course.url); }
  catch { return { method:"http-get", reachable:null, assessment:"inconclusive", httpCode:0, manualReviewRequired:true, note:"URL 无法解析，跳过" }; }
  if (!/^https?:$/.test(parsed.protocol) || !isPublicHost(parsed.hostname)) {
    return { method:"http-get", reachable:null, assessment:"inconclusive", httpCode:0, manualReviewRequired:true, note:"非 http(s) 或内网/回环地址，已跳过" };
  }
  try {
    const response = await fetch(course.url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 humanities-courses-audit/0.1", range: "bytes=0-2048" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.body) await response.body.cancel();
    const blocked = [401, 403, 429].includes(response.status);
    return {
      method: "http-get",
      reachable: blocked ? null : (response.status >= 200 && response.status < 400),
      assessment: blocked ? "inconclusive" : ((response.status >= 200 && response.status < 400) ? "reachable" : "unreachable"),
      httpCode: response.status,
      finalUrl: response.url,
      manualReviewRequired: true,
      note: blocked
        ? "站点拒绝自动请求，不能据此判定页面失效，需真实浏览器人工核验"
        : "HTTP 状态只代表页面可达；内容、免费范围、登录条件与授权需人工确认"
    };
  } catch (error) {
    return { method: "http-get", reachable: null, assessment: "inconclusive", httpCode: 0, manualReviewRequired: true, note: error.name || error.message };
  }
}

function validateOffline() {
  const errors = [];
  const duplicates = [];
  const seen = new Map();
  courses.forEach((course, index) => {
    if (!course || typeof course !== "object") {
      errors.push({ index, error: "课程记录不是对象" });
      return;
    }
    try { new URL(course.url); } catch { errors.push({ index, name: course.name, error: "URL 无效" }); }
    const list = seen.get(course.url) || [];
    list.push({ index, name: course.name, category: course.category });
    seen.set(course.url, list);
  });
  for (const [url, records] of seen) if (records.length > 1) duplicates.push({ url, records });
  return { errors, duplicates };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function run() {
  const local = validateOffline();
  const report = {
    schemaVersion: 2,
    auditVersion: "0.2.0-p1",
    generatedAt: new Date().toISOString(),
    mode: network ? "network" : "offline",
    dataFile: "data/courses.json",
    dataSha256,
    summary: {
      total: courses.length,
      uniqueUrls: new Set(courses.map(course => course.url)).size,
      localErrors: local.errors.length,
      duplicateUrls: local.duplicates.length
    },
    localErrors: local.errors,
    duplicateUrls: local.duplicates
  };

  if (network) {
    report.results = await mapLimit(courses, concurrency, async (course, index) => {
      let result = null;
      if (hostOf(course.url) === "bilibili.com") result = await auditBilibili(course);
      if (!result) result = await auditHttp(course);
      const tag = result.reachable === true ? "OK" : (result.reachable === null ? "CHECK" : "FAIL");
      process.stdout.write(`${String(index + 1).padStart(2, "0")}/${courses.length} ${tag} ${course.name}\n`);
      const similarity = titleSimilarity(course.source_title, result.sourceTitle);
      const checkedAgeDays = ageInDays(course.link_checked_at);
      return {
        id: course.id, index, name: course.name, category: course.category, platform: course.platform, url: course.url,
        expectedSourceTitle: course.source_title,
        sourceTitleSimilarity: similarity == null ? null : Number(similarity.toFixed(3)),
        titleDrift: similarity == null ? null : similarity < 0.62,
        checkedAgeDays,
        staleBeforeAudit: checkedAgeDays == null ? true : checkedAgeDays > staleAfterDays,
        ...result
      };
    });
    report.summary.reachable = report.results.filter(item => item.reachable === true).length;
    report.summary.unreachable = report.results.filter(item => item.reachable === false).length;
    report.summary.inconclusive = report.results.filter(item => item.reachable === null).length;
    report.summary.manualReviewRequired = report.results.filter(item => item.manualReviewRequired).length;
    report.summary.titleDrift = report.results.filter(item => item.titleDrift === true).length;
    report.summary.staleBeforeAudit = report.results.filter(item => item.staleBeforeAudit).length;
    report.summary.availableUnreachable = report.results.filter(item => item.reachable === false && courses[item.index].availability === "available").length;
  } else {
    report.summary.staleRecords = courses.filter(course => {
      const age = ageInDays(course.link_checked_at);
      return age == null || age > staleAfterDays;
    }).length;
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`审计完成：${report.summary.total} 条，唯一 URL ${report.summary.uniqueUrls}，本地错误 ${report.summary.localErrors}，重复 URL ${report.summary.duplicateUrls}`);
  if (offline) {
    console.log("离线模式未判断课程内容真实性与当前可达性");
    if (report.summary.staleRecords) console.warn(`WARN ${report.summary.staleRecords} 条课程入口核验已超过 ${staleAfterDays} 天或缺少日期`);
  }
  if (network && report.summary.titleDrift) console.warn(`WARN ${report.summary.titleDrift} 条来源标题可能漂移，需人工复核`);
  if (local.errors.length || local.duplicates.length || (network && report.summary.availableUnreachable)) process.exitCode = 1;
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
