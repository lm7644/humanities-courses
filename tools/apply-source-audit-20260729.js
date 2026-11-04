#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
// 迁移熔断：本迁移会无条件覆写 courses.json 与来源审核账本，已执行过则跳过。
// 强制重跑请先删除 data/.migrations.json 中的对应条目。
const markerPath = path.join(root, "data", ".migrations.json");
const migrations = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, "utf8")) : {};
const migrationId = "apply-source-audit-20260729";
if (migrations[migrationId]) {
  console.log(`迁移 ${migrationId} 已于 ${migrations[migrationId]} 执行过，跳过（强制重跑请先删除 data/.migrations.json 中对应条目）`);
  process.exit(0);
}
const coursesPath = path.join(root, "data", "courses.json");
const auditPath = path.join(root, "data", "source-audit-20260729.json");
const courses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));

const mismatchIds = new Set(["hc-010", "hc-052", "hc-053"]);
const unavailableIds = new Set(["hc-036"]);
const paidIds = new Set(["hc-014", "hc-058", "hc-059", "hc-060", "hc-062"]);
const freeIds = new Set([
  "hc-001", "hc-002", "hc-009", "hc-040", "hc-049", "hc-050", "hc-051", "hc-054", "hc-055",
  "hc-056", "hc-057", "hc-061", "hc-063", "hc-066", "hc-067", "hc-068", "hc-069", "hc-070",
  "hc-071", "hc-072", "hc-073", "hc-074", "hc-075", "hc-076", "hc-079"
]);
const loginIds = new Set(["hc-025", "hc-028", "hc-032"]);
const unknownAccessIds = new Set(["hc-064", "hc-065", "hc-077", "hc-078"]);

const overrides = {
  "hc-001": {
    name: "戴建业·走近大诗人",
    duration: "合集94分P（标题称陶渊明、李白、杜甫合75讲）",
    source_title: "【华中师范大学】走近大诗人（陶渊明｜李白｜杜甫｜合75讲）戴建业",
    evidence: "B站公开API返回合集标题、发布账号、94个分P和总时长；策展名由“唐诗宋词”改为与来源相符的“走近大诗人”。"
  },
  "hc-002": { evidence: "B站公开API返回合集标题、发布账号、201个分P和总时长；标题198讲与201分P的差异保留说明。" },
  "hc-009": {
    name: "叶嘉莹·中华诗词之美",
    duration: "合集154分P（源标题称145集）",
    evidence: "B站公开API显示源内容为《中华诗词之美》合集，非《唐宋词十七讲》；已按来源纠正策展名。"
  },
  "hc-010": { evidence: "B站公开API显示仅1个分P，实际标题为许子东讲现当代文学巴金、老舍部分，与“鲁迅与现当代”策展名和约20讲不符。" },
  "hc-014": {
    source_title: "【上新5折】千古文人侠客梦：北大陈平原讲武侠",
    source_author: "陈平原讲文学／活字文化",
    source_pages: 13,
    duration: "13课时（付费，含部分试看）",
    evidence: "B站课堂原页明确显示已完结、13课时、付费内容、券后90元起，发布者为陈平原讲文学与活字文化。"
  },
  "hc-025": {
    url: "https://mooc1.chaoxing.com/course/200242474.html",
    school: "中国社会科学院（课程页标注）",
    title: "中国社会科学院研究员（课程页标注）",
    source_title: "文学人类学概说",
    source_author: "叶舒宪",
    duration: "31学时（课程页标注）",
    evidence: "超星课程索引页显示课程名、主讲叶舒宪、中国社会科学院和31学时；学习内容可能要求平台登录。"
  },
  "hc-028": {
    url: "https://www.xuetangx.com/course/zzut05011002230",
    source_title: "神话传说故事与中国文化",
    source_author: "郑州工程技术学院",
    evidence: "学堂在线官方检索结果确认课程名、学校和课程简介；改用不含运行批次的稳定课程URL。"
  },
  "hc-032": {
    url: "https://www.xuetangx.com/course/THU05011001130",
    teacher: "祁海鹰",
    source_title: "行云流水——工科的中文写作",
    source_author: "清华大学",
    evidence: "学堂在线官方检索结果确认课程名、清华大学及课程定位；补正主讲教师为祁海鹰，改用稳定课程URL。"
  },
  "hc-036": { evidence: "原超星课程URL本轮返回403，搜索未取得足以确认课程身份的官方页面；为避免错链，入口转为不可用并阻断。" },
  "hc-040": { duration: "合集101分P", evidence: "B站公开API确认源标题为邵永海教授《古代汉语》，合集101分P。" },
  "hc-049": {
    url: "https://open.163.com/newview/movie/free?pid=OH79J31RP&mid=OH79K2HAG",
    category: "哲学与思想",
    source_title: "康德专题研究",
    source_author: "网易公开课用户上传页",
    source_pages: 53,
    duration: "页面选集53项",
    evidence: "网易公开课页面显示“康德专题研究”选集53项；原链接指向第30项，已改为第一讲。页面声明为网络用户上传。"
  },
  "hc-050": { evidence: "B站公开API确认《北京大学：中国哲学史（全41讲）杨立华》，共41分P。" },
  "hc-051": { duration: "4分P专题讲座", evidence: "B站公开API确认《哲学与时代问题的解决》仅4分P，已纠正原“约12讲”。" },
  "hc-052": { evidence: "B站公开API显示实际为单条视频《“逃”回小城市，一切就会变好吗？》，与“影片赏析／选10讲”不符。" },
  "hc-053": { evidence: "B站公开API显示实际为单条《大众文化改变着整个中国》讲座，与“影视批评（北大公开课）／全20讲”不符。" },
  "hc-054": { evidence: "B站公开API确认杨宁账号发布《文学理论课程全集 第一季》，共32讲。" },
  "hc-055": { evidence: "B站公开API确认上海大学葛红兵《成为作家——文学创作五讲》，共5分P。" },
  "hc-056": { evidence: "B站公开API确认尼尔·盖曼《讲故事的艺术》大师课，共19分P；上传授权未证明。" },
  "hc-057": { duration: "合集69分P", evidence: "B站公开API确认《四川师范大学-写作学（国家级精品课）》共69分P，已纠正原“全30讲”。" },
  "hc-058": { source_title: "马瑞芳品读《红楼梦》", source_author: "喜马拉雅专辑", evidence: "喜马拉雅公开专辑API确认标题、公开状态和付费属性；本轮价格129元。" },
  "hc-059": { source_title: "鲍鹏山品读水浒传", source_author: "喜马拉雅专辑", evidence: "喜马拉雅公开专辑API确认标题、公开状态和付费属性；本轮价格69.90元。" },
  "hc-060": { name: "曲黎敏·《诗经》之美", source_title: "曲黎敏：《诗经》之美", source_author: "喜马拉雅专辑", evidence: "喜马拉雅公开专辑API确认标题、公开状态和付费属性；本轮价格199元。" },
  "hc-061": { name: "陈凤山·古文观止评话", source_title: "古文观止评话", source_author: "陈凤山的保险频道", evidence: "喜马拉雅公开专辑API确认《古文观止评话》为公开非付费专辑；策展名按来源纠正。" },
  "hc-062": { name: "傅佩荣·《论语三百讲》第二季", source_title: "傅佩荣《论语三百讲》第二季", source_author: "喜马拉雅专辑", evidence: "喜马拉雅公开专辑API确认该URL仅对应第二季且为付费专辑；策展名补上“第二季”，本轮价格50元。" },
  "hc-063": {
    source_title: "Modern & Contemporary American Poetry (“ModPo”)",
    source_author: "Al Filreis／University of Pennsylvania",
    duration: "15模块；页面建议2个月、每周10小时",
    access_mode: "free",
    evidence: "Coursera官方页确认课程名、宾夕法尼亚大学、Al Filreis、15模块、英语授课；课程说明明确标注FREE。"
  },
  "hc-064": {
    url: "https://www.edx.org/learn/poetry/harvard-university-poetry-in-america-whitman",
    source_title: "Poetry in America: Whitman",
    source_author: "HarvardX／Elisa New",
    evidence: "edX当前官方课程URL与搜索索引确认课程名和HarvardX身份；免费旁听范围本轮未从课程页确认。"
  },
  "hc-065": {
    url: "https://www.edx.org/learn/poetry/georgetown-university-the-divine-comedy-dante-s-journey-to-freedom",
    teacher: "Frank Ambrosio 等",
    school: "乔治城大学",
    title: "GeorgetownX · 哲学与文学",
    source_title: "The Divine Comedy: Dante's Journey to Freedom",
    source_author: "GeorgetownX／Frank Ambrosio",
    evidence: "edX当前官方URL及乔治城大学课程站确认课程由Georgetown University提供、Frank Ambrosio主讲；纠正原哈佛归属。"
  },
  "hc-066": { evidence: "B站公开API确认戴锦华《影视批评》北大公开课，12分P。" },
  "hc-067": { duration: "43分P", evidence: "B站公开API确认北京大学陈旭光《电影鉴赏》公开课，共43分P。" },
  "hc-068": { duration: "5分P", evidence: "B站公开API确认《北京大学公开课系列002：影片赏析》，共5分P。" },
  "hc-069": { evidence: "B站公开API确认华中师范大学胡亚敏《比较文学》，共30讲。" },
  "hc-070": { duration: "标题称48讲，合集49分P", evidence: "B站公开API确认四川大学曹顺庆《比较文学》，源标题称48讲、合集49分P。" },
  "hc-071": { duration: "标题称47讲，合集46分P", evidence: "B站公开API确认陈汝东《修辞学研究专题》，源标题称47讲、合集46分P。" },
  "hc-072": { duration: "41分P", evidence: "B站公开API确认北京大学《汉语修辞学（国家精品课）》，共41分P。" },
  "hc-073": { evidence: "B站公开API确认上海外国语大学谭晶华《日本近代文学家名著导读》，共7讲。" },
  "hc-074": { duration: "25分P", evidence: "B站公开API确认台湾大学《日本文化史》，共25分P。" },
  "hc-075": { evidence: "B站公开API确认主标题为张志伟《西方哲学史》全64讲，合集131分P并附《德国哲学选读》。" },
  "hc-076": { evidence: "B站公开API确认武汉大学赵林《西方哲学史》，共108讲。" },
  "hc-077": {
    teacher: "Godefroid de Callataÿ、Pau Castell Granados 等",
    title: "Universitat de Barcelona · 中世纪研究",
    source_title: "Magic in the Middle Ages",
    source_author: "Universitat de Barcelona",
    duration: "5模块；约9小时",
    evidence: "Coursera官方页确认课程名、巴塞罗那大学、教师团队、5模块、约9小时和英语授课；具体免费范围因账户选项而异。"
  },
  "hc-078": {
    teacher: "Bruce Holsinger",
    title: "University of Virginia · 历史小说",
    source_title: "Plagues, Witches, and War: The Worlds of Historical Fiction",
    source_author: "University of Virginia／Bruce Holsinger",
    duration: "12模块；页面建议2周、每周10小时",
    evidence: "Coursera官方页确认课程名、弗吉尼亚大学、Bruce Holsinger、12模块和英语授课；具体免费范围因账户选项而异。"
  },
  "hc-079": {
    source_title: "Art history | Arts and humanities",
    source_author: "Khan Academy／Smarthistory",
    access_mode: "free",
    evidence: "可汗学院官方索引及可读取的具体艺术史课程页确认该课程集合存在；根入口在本轮网络环境出现客户端组件加载提示。"
  }
};

const reviewedIds = Object.keys(overrides).sort();
const pendingIds = courses.filter(course => course.availability === "needs_review").map(course => course.id).sort();
if (pendingIds.length && JSON.stringify(pendingIds) !== JSON.stringify(reviewedIds)) {
  const missing = pendingIds.filter(id => !reviewedIds.includes(id));
  const extra = reviewedIds.filter(id => !pendingIds.includes(id));
  throw new Error(`审核覆盖不完整：missing=${missing.join(",")} extra=${extra.join(",")}`);
}
for (const id of reviewedIds) if (!courses.some(course => course.id === id)) throw new Error(`审核课程不存在：${id}`);

const auditEntries = [];
for (const course of courses) {
  const change = overrides[course.id];
  if (!change) continue;
  Object.assign(course, change);
  delete course.evidence;
  course.link_checked_at = "2026-07-29";
  course.verified_at = null;
  course.verified_by = null;
  course.license_note = "仅链接到外部平台；来源身份已核，授权、长期可用性与教学质量仍未完成人工学术审定";

  if (mismatchIds.has(course.id)) {
    course.status = "needs_review";
    course.availability = "content_mismatch";
    course.editorial_status = "blocked";
    course.core = false;
    course.schedule = "源内容与策展名称/规模不符 · 已审核并暂停跳转";
  } else if (unavailableIds.has(course.id)) {
    course.status = "unavailable";
    course.availability = "unavailable";
    course.editorial_status = "blocked";
    course.core = false;
    course.schedule = "本次审核无法确认有效课程入口 · 已暂停跳转";
  } else {
    course.status = "open";
    course.availability = "available";
    course.schedule = paidIds.has(course.id)
      ? "来源已核 · 当前为付费内容"
      : loginIds.has(course.id)
        ? "来源已核 · 学习内容可能需要平台登录"
        : unknownAccessIds.has(course.id)
          ? "来源已核 · 具体访问范围以平台账户页面为准"
          : "来源已核 · 本次可访问";
  }

  if (paidIds.has(course.id)) course.access_mode = "paid";
  else if (freeIds.has(course.id)) course.access_mode = "free";
  else if (loginIds.has(course.id)) course.access_mode = "login_required";
  else if (unknownAccessIds.has(course.id)) course.access_mode = "unknown";
  if (mismatchIds.has(course.id) || unavailableIds.has(course.id)) course.access_mode = "unknown";

  const method = course.platform === "B站"
    ? (course.id === "hc-014" ? "bilibili-cheese-page" : "bilibili-public-api")
    : course.platform === "喜马拉雅"
      ? "ximalaya-public-album-api"
      : ["Coursera", "edX", "可汗学院", "学堂在线", "超星尔雅", "网易公开课"].includes(course.platform)
        ? "official-page-and-search"
        : "source-page-review";
  course.verification_method = method;
  course.quality_evidence = [...new Set([...(course.quality_evidence || []), change.evidence])];
  course.known_limits = [...new Set([...(course.known_limits || []), "本轮只完成来源身份与入口状态核查；未替代教师学术审定，也未证明转载授权或长期可用。"] )];

  auditEntries.push({
    id: course.id,
    decision: course.availability,
    source_title: course.source_title,
    source_author: course.source_author,
    access_mode: course.access_mode,
    method,
    checked_at: course.link_checked_at,
    evidence: change.evidence,
    academic_verification: "not_completed"
  });
}

fs.writeFileSync(coursesPath, JSON.stringify(courses, null, 2) + "\n");
fs.writeFileSync(auditPath, JSON.stringify({
  schema_version: 1,
  checked_at: "2026-07-29",
  scope: "原 availability=needs_review 的全部41门课程",
  count: auditEntries.length,
  boundaries: [
    "来源身份核查不等于教师学术审定",
    "可访问不等于免费、获得转载授权或长期稳定",
    "无法确认身份或入口的课程一律阻断，不以推测填空"
  ],
  entries: auditEntries
}, null, 2) + "\n");
// 两处写盘（courses.json 与审核账本）均完成后登记迁移标记
migrations[migrationId] = new Date().toISOString();
fs.writeFileSync(markerPath, JSON.stringify(migrations, null, 2) + "\n", "utf8");
console.log(`已应用来源审核：${auditEntries.length}门；账本=${path.relative(root, auditPath)}`);
