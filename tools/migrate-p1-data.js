#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
// 迁移熔断：本迁移会无条件覆写 courses.json 的人工核验进度，已执行过则跳过。
// 强制重跑请先删除 data/.migrations.json 中的对应条目。
const markerPath = path.join(root, "data", ".migrations.json");
const migrations = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, "utf8")) : {};
const migrationId = "migrate-p1-data";
if (migrations[migrationId]) {
  console.log(`迁移 ${migrationId} 已于 ${migrations[migrationId]} 执行过，跳过（强制重跑请先删除 data/.migrations.json 中对应条目）`);
  process.exit(0);
}
const coursesPath = path.join(root, "data", "courses.json");
const reportPath = path.join(root, "link-report.json");
const courses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));
const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : { results: [] };
const auditByUrl = new Map((report.results || []).map(item => [item.url, item]));

const coreKeys = new Set([
  "戴建业·唐诗宋词|https://www.bilibili.com/video/BV14y4y1i7CA/",
  "欧丽娟·红楼梦|https://www.bilibili.com/video/BV1hp4y1t7zq/",
  "叶嘉莹·唐宋词十七讲|https://www.bilibili.com/video/BV1BT4y1U7fL/",
  "叶嘉莹·中华诗词之美|https://www.chinaooc.com.cn/course/67089347cd415282f9362e3e",
  "北大《中国当代文学》|https://www.icourse163.org/course/PKU-1205722813",
  "钱理群·现代文学|https://www.bilibili.com/cheese/play/ep10724",
  "北师大《文学概论》|https://www.icourse163.org/course/detail.htm?cid=1003543127",
  "北大《文学原理》|https://www.icourse163.org/learn/PKU-1207039817",
  "童庆炳·文学理论|https://www.163.com/opencourse/detail/video-UHK6VCDCO-WHK6VCF91",
  "西方文论|https://www.icourse163.org/course/detail.htm?cid=1451160165",
  "西方文论经典导读|https://higher.smartedu.cn/course/67b90b37225d72705e4f4110",
  "曹顺庆·比较文学|https://www.icourse163.org/course/SCU-1472839182",
  "上外《中国神话》|https://www.icourse163.org/course/SHISU-1470419180?tid=1471858474",
  "北大《神话与神话研究》|https://higher.smartedu.cn/course/62354d669906eace0490420d",
  "学堂在线《神话传说故事与中国文化》|https://www.xuetangx.com/course/zzut05011002230/29593964",
  "暨南《汉语修辞学》|https://www.icourse163.org/course/detail.htm?cid=1206630835",
  "湘潭《语言表达的修辞解码》|https://higher.smartedu.cn/course/62cf4905cdf86a768ef93033",
  "浙大《大学写作基础模块》|https://www.icourse163.org/learn/ZJU-1471166176",
  "张志伟·西方哲学史|https://www.bilibili.com/video/BV1y64y1r7Mt/",
  "Khan Academy · Art History|https://www.khanacademy.org/humanities/art-history"
]);

function sourceType(platform) {
  if (platform === "B站") return "platform_video";
  if (platform === "喜马拉雅") return "platform_audio";
  return "platform_course_page";
}

function availability(course) {
  if (course.status === "unavailable") return "unavailable";
  if (course.status === "needs_review") return "content_mismatch";
  if (course.status === "closed") return "course_closed";
  if (course.status === "upcoming") return "upcoming";
  if (course.status === "open") return "available";
  return "needs_review";
}

let nextId = courses.reduce((max, course) => {
  const match = String(course.id || "").match(/^hc-(\d{3})$/);
  return match ? Math.max(max, Number(match[1])) : max;
}, 0) + 1;

for (const course of courses) {
  if (!course.id) course.id = `hc-${String(nextId++).padStart(3, "0")}`;
  const audit = auditByUrl.get(course.url) || {};
  const blocked = ["unavailable", "needs_review"].includes(course.status);
  const core = coreKeys.has(`${course.name}|${course.url}`) && !blocked;
  Object.assign(course, {
    source_type: course.source_type || sourceType(course.platform),
    source_title: course.source_title ?? audit.sourceTitle ?? null,
    source_author: course.source_author ?? audit.sourceOwner ?? null,
    source_duration_seconds: course.source_duration_seconds ?? audit.sourceDurationSeconds ?? null,
    source_pages: course.source_pages ?? audit.sourcePages ?? null,
    access_mode: course.access_mode || "unknown",
    availability: course.availability || availability(course),
    link_checked_at: course.link_checked_at || (report.generatedAt ? report.generatedAt.slice(0, 10) : null),
    verified_at: course.verified_at ?? null,
    verified_by: course.verified_by ?? null,
    verification_method: course.verification_method ?? audit.method ?? null,
    rights_basis: course.rights_basis || "link_only",
    license_note: course.license_note || "授权与平台条款尚未完成人工核验",
    language: course.language || (course.category === "英语文学" ? "en" : "zh"),
    subtitles: course.subtitles || "unknown",
    materials: course.materials || "unknown",
    certificate: course.certificate || "unknown",
    effort_hours: course.effort_hours ?? null,
    prerequisites: course.prerequisites || [],
    outcomes: course.outcomes || [],
    tags: course.tags || [],
    quality_evidence: course.quality_evidence || [],
    perspective: course.perspective || [],
    known_limits: course.known_limits || [],
    alternative_views: course.alternative_views || [],
    editorial_status: blocked ? "blocked" : (core ? "core_candidate" : "catalog_candidate"),
    core
  });
}

const coreCount = courses.filter(course => course.core).length;
if (coreCount !== 20) throw new Error(`核心候选应为 20 门，实际 ${coreCount}`);
fs.writeFileSync(coursesPath, JSON.stringify(courses, null, 2) + "\n", "utf8");
migrations[migrationId] = new Date().toISOString();
fs.writeFileSync(markerPath, JSON.stringify(migrations, null, 2) + "\n", "utf8");
console.log(`P1 数据迁移完成：${courses.length} 门，核心候选 ${coreCount} 门`);
