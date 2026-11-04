#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const coursesPath = path.join(root, "data", "courses.json");
const pathsPath = path.join(root, "data", "paths.json");
const outputPath = path.join(root, "data", "core-candidates.json");
const checkOnly = process.argv.includes("--check");
const courses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));
const pathsDoc = JSON.parse(fs.readFileSync(pathsPath, "utf8"));

const references = new Map();
for (const learningPath of pathsDoc.paths) {
  for (const node of learningPath.nodes) {
    for (const courseId of node.course_ids) {
      const record = references.get(courseId) || { path_ids:new Set(), node_ids:new Set() };
      record.path_ids.add(learningPath.id);
      record.node_ids.add(node.id);
      references.set(courseId, record);
    }
  }
}

const candidates = courses.filter(course => course.core).map(course => {
  const ref = references.get(course.id);
  return {
    id: course.id,
    name: course.name,
    category: course.category,
    teacher: course.teacher,
    school: course.school,
    platform: course.platform,
    url: course.url,
    status: course.status,
    availability: course.availability,
    source_type: course.source_type,
    source_title: course.source_title,
    source_author: course.source_author,
    access_mode: course.access_mode,
    rights_basis: course.rights_basis,
    verified_at: course.verified_at,
    verified_by: course.verified_by,
    editorial_status: course.editorial_status,
    path_ids: ref ? [...ref.path_ids] : [],
    node_ids: ref ? [...ref.node_ids] : []
  };
});

const output = {
  schema_version: 1,
  generated_from: ["data/courses.json", "data/paths.json"],
  count: candidates.length,
  disclaimer: "核心候选不等于已核验或推荐发布；verified_at 为空时必须完成人工复核。",
  review_gate: [
    "原平台标题与本站标题匹配",
    "讲师、机构与课程范围可证明",
    "访问条件与免费边界已实测",
    "版权与转载边界已记录",
    "路径引用已精确到讲次或原始材料",
    "推荐理由、适用对象与已知局限已由学科教师复核"
  ],
  candidates
};
const expected = JSON.stringify(output, null, 2) + "\n";
if (checkOnly) {
  const actual = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (actual !== expected) {
    console.error("data/core-candidates.json 与课程/路径源不一致，请运行 npm run build:core");
    process.exit(1);
  }
  console.log(`核心候选清单一致：${candidates.length} 门`);
} else {
  fs.writeFileSync(outputPath, expected, "utf8");
  console.log(`已生成 ${path.relative(root, outputPath)}：${candidates.length} 门`);
}
