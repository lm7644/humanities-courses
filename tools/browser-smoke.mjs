#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRootIndex = process.argv.indexOf("--site-root");
const siteRoot = siteRootIndex >= 0 ? path.resolve(root, process.argv[siteRootIndex + 1]) : root;
if (!fs.existsSync(path.join(siteRoot, "index.html"))) throw new Error(`站点目录缺少 index.html：${siteRoot}`);
const sourceCourses = JSON.parse(fs.readFileSync(path.join(root, "data", "courses.json"), "utf8"));
const expectedDisabledLinks = sourceCourses.filter(course => ["unavailable", "needs_review"].includes(course.status)).length;
const expectedCourseCount = sourceCourses.length;
const expectedAltIds = sourceCourses.filter(course => Array.isArray(course.alternative_views) && course.alternative_views.length).map(course => course.id).sort();
const sourcePaths = JSON.parse(fs.readFileSync(path.join(root, "data", "paths.json"), "utf8"));
const expectedPathCount = sourcePaths.paths.length;
const expectedCoreCount = sourceCourses.filter(course => course.core).length;
const techniqueCourses = sourceCourses.filter(course => Array.isArray(course.technique) && course.technique.length);
const expectedTechniqueSample = techniqueCourses.length ? techniqueCourses[techniqueCourses.length - 1].technique[0] : null;
const validationDir = path.join(root, "validation");
fs.mkdirSync(validationDir, { recursive: true });

// Chrome/Chromium 可执行文件定位：先查常见安装路径（含 Windows），再用 where/which 兜底。
// Windows 下 spawnSync("which") 必然不存在，返回的 error 必须显式跳过，否则 .stdout 为 undefined 会崩溃。
function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Chromium\\Application\\chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  for (const command of ["google-chrome", "chromium", "chromium-browser", "chrome", "msedge"]) {
    const probe = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(probe, [command], { encoding: "utf8" });
    if (result.error) continue;
    const found = (result.stdout || "").trim().split(/\r?\n/)[0].trim();
    if (found && fs.existsSync(found)) return found;
  }
  throw new Error("未找到 Chrome/Chromium；可通过 CHROME_PATH 指定");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".json":"application/json; charset=utf-8", ".css":"text/css; charset=utf-8", ".png":"image/png" })[ext] || "application/octet-stream";
}

function staticServer() {
  return http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(siteRoot, relative);
    if (!file.startsWith(siteRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": contentType(file), "cache-control":"no-store" });
    fs.createReadStream(file).pipe(response);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.sequence = 0;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.runtimeErrors = [];
    ws.addEventListener("message", event => this.onMessage(JSON.parse(event.data)));
  }
  onMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      this.pending.get(message.id)(message);
      this.pending.delete(message.id);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") this.runtimeErrors.push({ type:"exception", detail:message.params });
    if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") this.runtimeErrors.push({ type:"log", detail:message.params.entry });
    const waiterIndex = this.waiters.findIndex(waiter => waiter.method === message.method);
    if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1)[0].resolve(message);
    else this.events.push(message);
  }
  call(method, params = {}) {
    const id = ++this.sequence;
    // 大型页面内检测脚本（desktop 全量断言）随课程数增长变慢，evaluate 单独给更宽的超时窗口；
    // 其余 CDP 调用维持 15s——真实卡死仍会被捕获
    const limit = method === "Runtime.evaluate" ? 45000 : 15000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)); }, limit);
      this.pending.set(id, message => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else resolve(message.result || {});
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  waitFor(method) {
    const existing = this.events.findIndex(event => event.method === method);
    if (existing >= 0) return Promise.resolve(this.events.splice(existing, 1)[0]);
    const register = () => new Promise((resolve, reject) => {
      const waiter = { method, resolve: value => { clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => {
        // 超时先把 waiter 摘除，避免残留项拦截后续同名事件
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`${method} 事件超时`));
      }, 15000);
      this.waiters.push(waiter);
    });
    // 事件等待幂等，超时重试一次（CDP 15s 偶发假失败）；仍超时则原样抛出
    return register().catch(() => register());
  }
  async navigate(url) {
    this.events = [];
    await this.call("Page.navigate", { url });
    await this.waitFor("Page.loadEventFired");
    await this.waitReady();
  }
  async waitReady() {
    for (let index = 0; index < 60; index++) {
      const value = await this.evaluate("document.querySelectorAll('.card').length");
      if (value === expectedCourseCount) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`页面未在 6 秒内渲染 ${expectedCourseCount} 门课程`);
  }
  async evaluate(expression, awaitPromise = false) {
    const result = await this.call("Runtime.evaluate", { expression, returnByValue:true, awaitPromise });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "页面脚本执行失败");
    return result.result?.value;
  }
  async screenshot(filename) {
    const result = await this.call("Page.captureScreenshot", { format:"png", captureBeyondViewport:false });
    fs.writeFileSync(path.join(validationDir, filename), Buffer.from(result.data, "base64"));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`验收失败：${message}`);
}

// 轮询等待页面侧条件成立（过渡态采样防假失败）；超时返回 false，由调用方决定断言或回退。
// 只用于无副作用的只读表达式；带点击等状态变更的 evaluate 不做重试，避免重复触发。
async function eventually(cdp, expression, timeoutMs = 2000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function connectWebSocket(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once:true });
    ws.addEventListener("error", reject, { once:true });
  });
  return ws;
}

async function waitDevtools(port) {
  for (let index = 0; index < 200; index++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Chrome DevTools 未启动");
}

const server = staticServer();
const serverPort = await freePort();
const devtoolsPort = await freePort();
const profile = path.join(os.tmpdir(), `humanities-browser-smoke-${process.pid}`);
let chrome;
let ws;
// 成功标志：仅全部断言通过后置位，用于 finally 决定是否主动退出进程（失败路径让异常自然传播，保证非零退出与栈输出）
let ok = false;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(serverPort, "127.0.0.1", resolve);
  });
  chrome = spawn(chromePath(), [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--no-first-run",
    `--remote-debugging-port=${devtoolsPort}`, `--user-data-dir=${profile}`, "about:blank"
  ], { stdio:"ignore" });
  await waitDevtools(devtoolsPort);
  const targetResponse = await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, { method:"PUT" });
  const target = await targetResponse.json();
  ws = await connectWebSocket(target.webSocketDebuggerUrl);
  const cdp = new CDP(ws);
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Log.enable");

  await cdp.call("Emulation.setDeviceMetricsOverride", { width:1440, height:900, deviceScaleFactor:1, mobile:false });
  const httpUrl = `http://127.0.0.1:${serverPort}/?token=must-not-share#private`;
  await cdp.navigate(httpUrl);
  const knownLegacyUrl = "https://www.bilibili.com/video/BV14y4y1i7CA/";
  const unknownLegacyUrl = "https://legacy.invalid/removed-course";
  await cdp.evaluate(`localStorage.setItem('hm-favs', JSON.stringify([${JSON.stringify(knownLegacyUrl)}, ${JSON.stringify(unknownLegacyUrl)}])); location.reload();`);
  await cdp.waitFor("Page.loadEventFired");
  await cdp.waitReady();
  const legacyArrayMigration = await cdp.evaluate("JSON.parse(localStorage.getItem('hm-favs'))");
  assert(legacyArrayMigration?.ids?.includes("hc-001"), "旧数组 URL 收藏迁移为 ID");
  assert(legacyArrayMigration?.unresolved?.includes(unknownLegacyUrl), "旧数组未匹配收藏得到保留");

  const unknownObjectRef = "https://legacy.invalid/object-course";
  await cdp.evaluate(`
    localStorage.setItem('hm-favs', JSON.stringify({ids:['hc-002'],urls:[${JSON.stringify(knownLegacyUrl)}],unresolved:[${JSON.stringify(unknownObjectRef)}]}));
    localStorage.setItem('hm-path-progress', JSON.stringify({version:1,currentPathId:'removed-path',completed:{'path-myth-from-story-to-study':['ghost-node'],'removed-path':['ghost-node']}}));
    location.reload();
  `);
  await cdp.waitFor("Page.loadEventFired");
  await cdp.waitReady();
  await new Promise(resolve => setTimeout(resolve, 1100));
  await cdp.screenshot("p1-desktop-top.png");
  const desktop = await cdp.evaluate(`(async () => {
    await document.fonts.ready; // 字体回退会让长标题瞬时多折一行，密度测量必须等真实字体（遗留#4 同源的抖动源）
    const result = {};
    result.courses = document.querySelectorAll('.card').length;
    result.altBadgeCount=document.querySelectorAll('#content .alt-badge').length;
    result.altCardIds=[...document.querySelectorAll('#content .alt-badge')].map(el=>el.closest('.card')?.dataset.id).sort();
    const altSample=document.querySelector('#content .card .alt-badge')?.closest('.card');
    if(altSample){
      const btn=altSample.querySelector('.detail-btn');
      btn.click();
      result.altJumpVisible=!!altSample.querySelector('.alt-jump');
      result.altJumpId=altSample.querySelector('.alt-jump')?.getAttribute('data-alt-id')||null;
      btn.click();
    }
    const anyCard=document.querySelector('#content .card');
    const studyBtn=anyCard?.querySelector('.study-btn');
    if(studyBtn){
      studyBtn.click();
      // study-badge 由 render() 生成：切换「已学」筛选触发重渲染后逐一断言
      document.getElementById('studyToggle').click();
      await new Promise(r=>setTimeout(r,60));
      const studiedCards=document.querySelectorAll('#content .card');
      result.studyBadgeAfterClick=studiedCards.length>0 && [...studiedCards].every(c=>!!c.querySelector('.study-badge'));
      document.getElementById('studyToggle').click();
      studyBtn.click();
      await new Promise(r=>setTimeout(r,20));
    } else { result.studyBadgeAfterClick=false; }
    const teacherCard=document.querySelector('#content .card .teacher-link');
    if(teacherCard){
      teacherCard.click();
      await new Promise(r=>setTimeout(r,230));
      const shown=document.querySelectorAll('#content .card');
      const teacherName=teacherCard.textContent.trim();
      result.teacherFilterWorks=shown.length>0 && shown.length<${expectedCourseCount} && [...shown].every(c=>{
        const course=window.HUMANITIES_COURSES.find(x=>x.id===c.dataset.id);
        return course && course.teacher===teacherName;
      });
      document.getElementById('searchInput').value='';
      document.getElementById('searchInput').dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,220));
    } else { result.teacherFilterWorks=false; }
    result.paths = document.querySelectorAll('.path-item').length;
    // 平台多选 + 访问条件筛选 + 一键重置 + 深链往返（含旧单值链接兼容）
    {
      const platBtns=[...document.querySelectorAll('#platformFilters button')];
      const accessBtns=[...document.querySelectorAll('#accessFilters button')];
      result.accessFilterRowExists=accessBtns.length===5;
      result.resetDisabledAtStart=document.getElementById('resetFilters').disabled;
      const target=platBtns.find(b=>b.textContent==='B站');
      const target2=platBtns.find(b=>b.textContent==='中国大学MOOC');
      target.click();
      result.afterFirstPlatform=document.querySelectorAll('#content .card').length;
      result.hashAfterFirst=location.hash.includes('plat=');
      target2.click();
      const afterTwo=[...document.querySelectorAll('#content .card')].length;
      const twoPlatforms=window.HUMANITIES_COURSES.filter(c=>['B站','中国大学MOOC'].includes(c.platform)).length;
      result.afterTwo=afterTwo;
      result.twoPlatformsExpected=twoPlatforms;
      result.multiSelectUnion=afterTwo===twoPlatforms;
      result.bothPillsActive=[...document.querySelectorAll('#platformFilters button.active')].map(b=>b.textContent).join(',')==='B站,中国大学MOOC';
      // 先重置到干净态，再单独验证「访问条件」维度（避免与平台多选叠加导致口径混淆）
      document.getElementById('resetFilters').click();
      result.resetRestoresFull=document.querySelectorAll('#content .card').length;
      accessBtns.find(b=>b.textContent==='免费').click();
      result.freeOnlyCount=document.querySelectorAll('#content .card').length;
      result.freeOnlyMatches=result.freeOnlyCount===window.HUMANITIES_COURSES.filter(c=>c.access_mode==='free').length;
      result.resetEnabledAfterFilter=!document.getElementById('resetFilters').disabled;
      // 深链往返：当前状态编码后再解码应等价
      const encoded=encodeState(state);
      const decoded=decodeState(encoded);
      result.hashRoundTrip=JSON.stringify(decoded.filters.access)===JSON.stringify(state.access)
        &&JSON.stringify(decoded.filters.platforms||[])===JSON.stringify(state.platforms);
      // 注意 encodeState 会 URL 编码内部 query，需解码后再查键
      result.hashHasAccess=new URLSearchParams(decodeURIComponent(encoded.replace(/^f=/,''))).get('acc')==='free';
      // 旧单值链接（plat=B站）应被兼容解析
      result.legacyHashParsed=JSON.stringify(decodeState('#f='+encodeURIComponent(new URLSearchParams({plat:'B站'}).toString())).filters.platforms)===JSON.stringify(['B站']);
      // 一键重置（此时生效条件为「访问：免费」）
      document.getElementById('resetFilters').click();
      result.afterResetAll=document.querySelectorAll('#content .card').length;
      result.resetDisabledAfter=document.getElementById('resetFilters').disabled;
      result.hashClearedAfterReset=!location.hash.includes('plat=')&&!location.hash.includes('acc=');
    }
    result.pathNodes = document.querySelectorAll('.path-item')[0].querySelectorAll('.path-node').length;
    // 空态：条件回显与一键清除
    {
      const search=document.getElementById('searchInput');
      search.value='不存在的课程ZZZ'; search.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,260));
      result.emptyStateShown=!!document.querySelector('#content .empty');
      result.emptyCondCount=document.querySelectorAll('#content .empty-cond .cond').length;
      result.emptyClearPresent=!!document.getElementById('emptyClear');
      document.getElementById('emptyClear').click();
      await new Promise(r=>setTimeout(r,260));
      result.emptyClearRestores=document.querySelectorAll('#content .card').length;
      result.emptySearchReset=document.getElementById('searchInput').value==='';
    }
    result.pathDraftLabels = document.querySelectorAll('.path-status').length;
    result.footerPathCount = Number((document.getElementById('pathCountNote')||{}).textContent||0);
    result.heroPathCount = Number((document.getElementById('heroPathCount')||{}).textContent||0);
    result.cardsWithIds = document.querySelectorAll('.card[data-id]').length;
    result.bannerCount=document.querySelectorAll('#content .course-banner').length;
    result.bannerIdentityMatches=[...document.querySelectorAll('#content .card')].every(card=>{
      const course=window.HUMANITIES_COURSES.find(c=>c.id===card.dataset.id);
      return course&&card.querySelector('.banner-teacher strong')?.textContent.trim()===course.teacher&&card.querySelector('.banner-name')?.textContent.trim()===displayCourseName(course)&&card.querySelector('.banner-category')?.textContent.trim()===course.category;
    });
    result.bannerTeacherFont=parseFloat(getComputedStyle(document.querySelector('#content .banner-teacher strong')).fontSize);
    result.bannerNameFont=parseFloat(getComputedStyle(document.querySelector('#content .banner-name')).fontSize);
    result.bannerCategoryCount=document.querySelectorAll('#content .banner-category').length;
    result.bannerStatusCount=document.querySelectorAll('#content .banner-status').length;
    result.visibleAuditLabels=[...document.querySelectorAll('body *')].filter(el=>el.children.length===0&&['入口已核','来源已核','内容错配'].some(text=>el.textContent.includes(text))&&getComputedStyle(el).display!=='none').length;
    const cardIds = [...document.querySelectorAll('#content .card')].map(card => card.dataset.id);
    result.uniqueCardIds = new Set(cardIds).size;
    result.invalidCardIds = cardIds.filter(id => !/^hc-\\d{3}$/.test(id)).length;
    result.unknownCardIds = cardIds.filter(id => !window.HUMANITIES_COURSES.some(course => course.id === id)).length;
    // 路径引用双档规则（与 tools/validate-project.js 一致）：
    // P1 样板路径只引用核心候选；国画/书法扩展草案路径允许引用待审定的 core_candidate 课程。
    const P1_SAMPLE_IDS = ["path-myth-from-story-to-study","path-literary-theory-to-analysis","path-classical-poetry-close-reading"];
    result.pathReferencesValid = window.HUMANITIES_PATHS.paths.every(path => {
      const isSample = P1_SAMPLE_IDS.includes(path.id);
      return path.nodes.every(node => (node.course_ids || []).every(id => {
        const course = window.HUMANITIES_COURSES.find(item => item.id === id);
        if (!course) return false;
        if (course.editorial_status === 'blocked') return false;
        return isSample ? course.core === true : (course.core === true || course.editorial_status === 'core_candidate');
      }));
    });
    const sanitizedProgress=JSON.parse(localStorage.getItem('hm-path-progress'));
    result.pathProgressSanitized=sanitizedProgress.currentPathId===null&&!('removed-path' in sanitizedProgress.completed)&&(sanitizedProgress.completed['path-myth-from-story-to-study']||[]).length===0;
    const pathBox = document.querySelector('.path-node-check');
    const pathId = pathBox.dataset.pathId;
    const nodeId = pathBox.dataset.nodeId;
    pathBox.click();
    await new Promise(r=>setTimeout(r,20));
    result.pathProgressAfterCheck = JSON.parse(localStorage.getItem('hm-path-progress'));
    result.pathChecked = result.pathProgressAfterCheck.completed[pathId].includes(nodeId);
    const courseRef = document.querySelector('.path-course-ref');
    const courseRefId = courseRef.dataset.courseId;
    courseRef.click();
    for(let attempt=0; attempt<100 && !document.querySelector('.card.path-focus'); attempt++){
      await new Promise(r=>setTimeout(r,20));
    }
    result.pathCourseFocusId = document.querySelector('.card.path-focus')?.dataset.id || null;
    result.pathCourseFocusMatches = result.pathCourseFocusId === courseRefId;
    result.favoriteCount = document.getElementById('favToggle').textContent;
    result.favoriteStorage = JSON.parse(localStorage.getItem('hm-favs'));
    result.platformButtonsInitial = document.querySelectorAll('#platformFilters button').length;
    result.difficultyButtonsInitial = document.querySelectorAll('#difficultyFilters button').length;
    for(let i=0;i<4;i++) document.querySelectorAll('#platformFilters button')[1].click();
    for(let i=0;i<4;i++) document.querySelectorAll('#difficultyFilters button')[1].click();
    result.platformButtonsAfterClicks = document.querySelectorAll('#platformFilters button').length;
    result.difficultyButtonsAfterClicks = document.querySelectorAll('#difficultyFilters button').length;
    document.querySelectorAll('#platformFilters button')[0].click();
    document.querySelectorAll('#difficultyFilters button')[0].click();
    const search = document.getElementById('searchInput');
    // 搜索已改为 150ms 防抖（设计文档 2.1），读取结果前必须等其落定
    search.value='神话'; search.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,220));
    result.searchMyth=document.querySelectorAll('.card').length;
    // 相关度：命中课程名的应排在仅命中摘要/观点的前面
    result.relevanceTopNameMatch=(()=>{
      const first=document.querySelector('#content .card');
      if(!first) return false;
      const course=window.HUMANITIES_COURSES.find(x=>x.id===first.dataset.id);
      return course ? String(course.name).includes('神话') : false;
    })();
    search.value=''; search.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,220));
    result.searchReset=document.querySelectorAll('.card').length;
    // 防抖：派发后立即读取应仍是旧结果，等待 150ms 后才落定
    search.value='神话'; search.dispatchEvent(new Event('input',{bubbles:true}));
    result.debounceImmediate=document.querySelectorAll('#content .card').length;
    await new Promise(r=>setTimeout(r,220));
    result.debounceSettled=document.querySelectorAll('#content .card').length;
    search.value=''; search.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,220));
    // 多词 AND：两个词都必须命中（此前整串单子串匹配会恒为 0 结果）。
    // 用例取自真实数据：hc-001「戴建业·走近大诗人」的摘要含"陶渊明"，两词分属不同字段，
    // 旧逻辑（整串 "戴建业 陶渊明" 作单一子串）命中 0 门，AND 逻辑命中 1 门，可明确区分。
    search.value='戴建业 陶渊明'; search.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,220));
    result.multiWordCount=document.querySelectorAll('#content .card').length;
    result.multiWordAllMatch=[...document.querySelectorAll('#content .card')].every(card=>{
      const course=window.HUMANITIES_COURSES.find(c=>c.id===card.dataset.id);
      if(!course) return false;
      const hay=[course.name,course.teacher,course.review,course.intro,course.category,course.platform,course.school,course.pinyin,course._pinyinAbbr].filter(Boolean).join(' ').toLowerCase();
      return hay.includes('戴建业') && hay.includes('陶渊明');
    });
    search.value=''; search.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,220));
    result.searchReset2=document.querySelectorAll('#content .card').length;
    if(${JSON.stringify(expectedTechniqueSample)}){
      const techRow=document.getElementById('techniqueRow');
      result.techniqueRowVisible=!techRow.hidden;
      const techBtns=[...document.querySelectorAll('#techniqueFilters button')];
      const target=techBtns.find(b=>b.textContent.trim()===${JSON.stringify(expectedTechniqueSample)});
      if(target){
        target.click();
        await new Promise(r=>setTimeout(r,20));
        result.techniqueFilterCount=document.querySelectorAll('.card').length;
        result.techniqueFilterSampleOk=[...document.querySelectorAll('#content .card')].every(card=>{
          const course=window.HUMANITIES_COURSES.find(c=>c.id===card.dataset.id);
          return course && Array.isArray(course.technique) && course.technique.includes(${JSON.stringify(expectedTechniqueSample)});
        });
        techBtns.find(b=>b.textContent.trim()==='全部').click();
        await new Promise(r=>setTimeout(r,20));
      } else { result.techniqueFilterSampleOk=false; }
    }
    result.disabledLinks=document.querySelectorAll('.go.disabled').length;
    result.accessBadgeCount=document.querySelectorAll('#content .access-badge').length;
    result.accessBadgeLabels=[...new Set([...document.querySelectorAll('#content .access-badge')].map(el=>el.textContent.trim()))];
    document.getElementById('recsToggle').click();
    const recIds=[...document.querySelectorAll('#recsPanel .card')].map(card=>card.dataset.id);
    result.recommendationCount=recIds.length;
    result.uniqueRecommendationIds=new Set(recIds).size;
    result.recommendationCategoryCount=new Set(recIds.map(id=>window.HUMANITIES_COURSES.find(c=>c.id===id)?.category)).size;
    result.recommendationsAllCore=recIds.every(id=>window.HUMANITIES_COURSES.some(course=>course.id===id&&course.core));
    const cmp=[...document.querySelectorAll('#content .cmp-btn')]; cmp[0].click(); cmp[1].click();
    const trigger=document.getElementById('ctCompare'); trigger.focus(); trigger.click();
    result.modalOpen=!document.getElementById('compareModal').hidden;
    result.modalRole=document.getElementById('compareModal').getAttribute('role');
    result.modalFocus=document.activeElement.id;
    document.getElementById('modalClose').click();
    result.focusReturned=document.activeElement.id;
    document.getElementById('ctClear').click();
    const blockedCourse=window.HUMANITIES_COURSES.find(course=>['unavailable','needs_review'].includes(course.status));
    const enabledCourse=window.HUMANITIES_COURSES.find(course=>!['unavailable','needs_review'].includes(course.status));
    document.querySelector('#content .card[data-id="'+blockedCourse.id+'"] .cmp-btn').click();
    document.querySelector('#content .card[data-id="'+enabledCourse.id+'"] .cmp-btn').click();
    document.getElementById('ctCompare').click();
    result.blockedCompareLinkCount=[...document.querySelectorAll('#modalBody a')].filter(link=>link.href===blockedCourse.url).length;
    result.blockedCompareShowsDisabled=document.getElementById('modalBody').textContent.includes('暂无可用链接');
    document.getElementById('modalClose').click();
    document.getElementById('ctClear').click();
    let copied=null;
    Object.defineProperty(navigator,'clipboard',{value:{writeText:v=>{copied=v;return Promise.resolve();}},configurable:true});
    document.getElementById('shareBtn').click(); await new Promise(r=>setTimeout(r,20));
    result.sharedUrl=copied; result.shareLeakedToken=!!(copied&&copied.includes('must-not-share'));
    result.shareLeakedFragment=!!(copied&&copied.includes('#'));
    result.oldClaimsPresent=document.body.innerText.includes('永久开放')||document.body.innerText.includes('课程、讲师与封面均为真实公开内容');
    result.scrollWidth=document.documentElement.scrollWidth; result.clientWidth=document.documentElement.clientWidth;
    result.heroHeight=Math.round(document.querySelector('.hero').getBoundingClientRect().height);
    const wrap=document.querySelector('.wrap');
    const wrapStyle=getComputedStyle(wrap);
    result.wrapWidth=Math.round(wrap.getBoundingClientRect().width);
    result.wrapInnerWidth=Math.round(wrap.clientWidth-parseFloat(wrapStyle.paddingLeft)-parseFloat(wrapStyle.paddingRight));
    result.mainWidth=Math.round(document.querySelector('.wrap-main').getBoundingClientRect().width);
    result.navPosition=getComputedStyle(document.querySelector('.cat-nav')).position;
    result.minCardWidth=Math.round(Math.min(...[...document.querySelectorAll('#content .card')].map(card=>card.getBoundingClientRect().width)));
    // 卡片高度分两类统计：阻断卡需展示「暂停原因」（P1 核验信息模块），信息量天然更大
    {
      const all=[...document.querySelectorAll('#content .card')];
      const h=c=>Math.round(c.getBoundingClientRect().height);
      const blocked=all.filter(c=>c.querySelector('.blocked-note'));
      const normal=all.filter(c=>!c.querySelector('.blocked-note'));
      result.maxCollapsedCardHeight=Math.round(Math.max(...all.map(h)));
      result.maxNormalCardHeight=normal.length?Math.round(Math.max(...normal.map(h))):0;
      result.blockedCardCount=blocked.length;
      result.tallNormalIds=normal.filter(c=>h(c)>390).map(c=>{const dEl=c.querySelector('.card-detail');const dcs=dEl?getComputedStyle(dEl):null;return {id:c.dataset.id,h:h(c),detail:Math.round((dEl||{}).getBoundingClientRect?.().height??-1),expanded:c.classList.contains('is-expanded'),maxH:dcs?dcs.maxHeight:null,disp:dcs?dcs.display:null}}).sort((a,b)=>b.h-a.h).slice(0,4);
    }
    await new Promise(r=>setTimeout(r,1200));
    const firstCourseCard=document.querySelector('#content .card');
    document.documentElement.style.scrollBehavior='auto';
    document.documentElement.style.overflowAnchor='none';
    document.body.style.overflowAnchor='none';
    const scrollNavHeight=document.getElementById('scrollNav').getBoundingClientRect().height;
    const desiredCardTop=scrollNavHeight+2;
    const absoluteCardTop=firstCourseCard.getBoundingClientRect().top+scrollY;
    const requestedScrollY=Math.max(0,absoluteCardTop-desiredCardTop);
    document.activeElement?.blur();
    scrollTo(0,requestedScrollY);
    await new Promise(r=>setTimeout(r,180));
    for(let attempt=0;attempt<3;attempt++){
      const delta=firstCourseCard.getBoundingClientRect().top-desiredCardTop;
      if(Math.abs(delta)<=1) break;
      scrollBy(0,delta);
      await new Promise(r=>setTimeout(r,100));
    }
    result.scrollNavHeight=Math.round(scrollNavHeight);
    result.courseViewportDiagnostic={scrollNavHeight,desiredCardTop,absoluteCardTop,requestedScrollY,actualScrollY:scrollY,innerHeight,scrollHeight:document.documentElement.scrollHeight};
    const visibleCardRects=[...document.querySelectorAll('#content .card')].map(card=>{
      const r=card.getBoundingClientRect(); return {id:card.dataset.id,top:Math.round(r.top),bottom:Math.round(r.bottom),height:Math.round(r.height)};
    });
    const visibleTop=scrollNavHeight-1;
    result.fullyVisibleCourseCards=visibleCardRects.filter(r=>r.top>=visibleTop&&r.bottom<=innerHeight).length;
    // 阻断卡因展示「暂停原因」而更高，一屏门数会被其拉低；分别统计以区分密度回归与功能增强
    {
      const blockedIds=new Set([...document.querySelectorAll('#content .card')]
        .filter(c=>c.querySelector('.blocked-note')).map(c=>c.dataset.id));
      const normalRects=visibleCardRects.filter(r=>!blockedIds.has(r.id));
      result.fullyVisibleNormalCards=normalRects.filter(r=>r.top>=visibleTop&&r.bottom<=innerHeight).length;
    }
    result.firstCourseCardRects=visibleCardRects.slice(0,6);
    result.scrollNavVisible=getComputedStyle(document.getElementById('scrollNav')).opacity==='1';
    result.topNavControls=['miniPlatform','miniDifficulty','miniOpenOnly','miniFav','miniSort','miniSearch','scrollTop'].filter(id=>document.getElementById(id)&&getComputedStyle(document.getElementById(id)).display!=='none').length;
    result.miniPlatformOptions=document.getElementById('miniPlatform').options.length;
    const miniPlatform=document.getElementById('miniPlatform');
    miniPlatform.value=miniPlatform.options[1].value; miniPlatform.dispatchEvent(new Event('change',{bubbles:true}));
    result.miniPlatformSynced=[...document.querySelectorAll('#platformFilters button')].some(b=>b.classList.contains('active')&&b.textContent===miniPlatform.value);
    miniPlatform.value='全部'; miniPlatform.dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('miniDifficulty').value='进阶'; document.getElementById('miniDifficulty').dispatchEvent(new Event('change',{bubbles:true}));
    result.miniDifficultySynced=[...document.querySelectorAll('#difficultyFilters button')].some(b=>b.classList.contains('active')&&b.textContent==='进阶');
    document.getElementById('miniDifficulty').value='全部'; document.getElementById('miniDifficulty').dispatchEvent(new Event('change',{bubbles:true}));
    const favBefore=document.getElementById('miniFav').getAttribute('aria-pressed'); document.getElementById('miniFav').click(); const favDuring=document.getElementById('miniFav').getAttribute('aria-pressed'); document.getElementById('miniFav').click();
    result.miniFavSynced=favBefore!==favDuring&&document.getElementById('miniFav').getAttribute('aria-pressed')===favBefore;
    document.getElementById('miniOpenOnly').click(); const openDuring=document.getElementById('openOnlyToggle').getAttribute('aria-pressed'); result.openOnlyCourseCount=document.querySelectorAll('#content .card').length; document.getElementById('miniOpenOnly').click();
    result.miniOpenSynced=openDuring==='true'&&document.getElementById('openOnlyToggle').getAttribute('aria-pressed')==='false';
    document.getElementById('miniSort').value='status'; document.getElementById('miniSort').dispatchEvent(new Event('change',{bubbles:true})); const sortDuring=document.getElementById('sortSelect').value; document.getElementById('miniSort').value='default'; document.getElementById('miniSort').dispatchEvent(new Event('change',{bubbles:true}));
    result.miniSortSynced=sortDuring==='status'&&document.getElementById('sortSelect').value==='default';
    result.leftNavWidth=Math.round(document.querySelector('.cat-nav').getBoundingClientRect().width);
    result.detailButtonCount=document.querySelectorAll('#content .detail-btn').length;
    const firstDetail=document.querySelector('#content .detail-btn');
    firstDetail.click();
    result.detailExpanded=firstDetail.closest('.card').classList.contains('is-expanded')&&firstDetail.getAttribute('aria-expanded')==='true';
    result.expandedIntroVisible=getComputedStyle(firstDetail.closest('.card').querySelector('.intro')).display!=='none';
    firstDetail.click();
    result.detailCollapsed=!firstDetail.closest('.card').classList.contains('is-expanded');
    result.coverTitleOverlaps=[...document.querySelectorAll('#content .cover-svg')].filter(svg=>{
      const texts=svg.querySelectorAll('text');
      if(texts.length<4) return true;
      if(getComputedStyle(texts[2]).display==='none' || getComputedStyle(texts[3]).display==='none') return false;
      const title=texts[2].getBBox();
      const footer=texts[3].getBBox();
      return title.y + title.height + 14 > footer.y;
    }).length;
    document.getElementById('ctClear').click();
    // 学习规划：单课笔记保存 + 打卡 + .ics 入口 + 概览热力图/统计
    {
      const nb=document.querySelector('#content .card .note-btn'); nb.click();
      result.planCourseOpen=!document.getElementById('planModal').hidden;
      result.planModalAria=document.getElementById('planModal').getAttribute('aria-modal');
      const noteCardId=nb.closest('.card').dataset.id;
      const ta=document.getElementById('planNoteText'); ta.value='结构清晰，适合入门';
      document.getElementById('planSaveNote').click();
      const planStore=JSON.parse(localStorage.getItem('hm-plan'));
      result.planNoteSaved=!!(planStore.notes&&planStore.notes[noteCardId]&&planStore.notes[noteCardId].text==='结构清晰，适合入门');
      result.planNoteBtnActive=document.querySelector('#content .card .note-btn').classList.contains('active');
      document.getElementById('planCheckin').click();
      const planStore2=JSON.parse(localStorage.getItem('hm-plan'));
      result.planCheckinRecorded=Object.values(planStore2.activity||{}).reduce((a,b)=>a+(Number(b)||0),0)>=1;
      result.planCheckinOnce=document.getElementById('planCheckin').disabled;
      result.planIcsReady=(document.getElementById('planIcs').textContent||'').includes('.ics');
      document.getElementById('planClose').click();
      result.planClosed=document.getElementById('planModal').hidden;
      document.getElementById('planToggle').click();
      result.planHeatCells=document.querySelectorAll('#planBody .hm-cell').length;
      result.planStatCount=document.querySelectorAll('#planBody .plan-stat').length;
      result.planRecentNoteShown=!!document.querySelector('#planBody .plan-notes li');
      result.planOverviewText=/学习热力图/.test(document.getElementById('planBody').textContent)&&/连续天数/.test(document.getElementById('planBody').textContent);
      // 学习数据可移植性：导出结构、导入合并、孤儿清理
      let captured=null;
      const realCreate=URL.createObjectURL;
      URL.createObjectURL=function(blob){ captured=blob; return realCreate.call(URL,blob); };
      document.getElementById('planExport').click();
      URL.createObjectURL=realCreate;
      const exported=JSON.parse(await captured.text());
      result.planExportShape=exported.type==='hm-plan'&&Array.isArray(exported.studyIds)&&!!exported.notes&&!!exported.checkins&&!!exported.activity;
      // 造一份含失效课程 id 的导入文件：合并有效项、清理孤儿
      const probeId=document.querySelector('#content .card').dataset.id;
      const studyBefore=(JSON.parse(localStorage.getItem('hm-study')||'{"ids":[]}').ids||[]).includes(probeId);
      const payload={type:'hm-plan',version:1,studyIds:[probeId,'hc-does-not-exist'],
        notes:{[probeId]:{text:'导入合并验证',updatedAt:'2099-01-01'},'hc-does-not-exist':{text:'孤儿记录',updatedAt:'2099-01-01'}},
        checkins:{[probeId]:['2099-02-02']},activity:{'2099-02-02':4},studyDates:{[probeId]:'2099-01-01'}};
      const file=new File([JSON.stringify(payload)],'plan.json',{type:'application/json'});
      const input=document.getElementById('planImportFile');
      Object.defineProperty(input,'files',{value:[file],configurable:true});
      input.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(r=>setTimeout(r,320));
      const merged=JSON.parse(localStorage.getItem('hm-plan'));
      result.planImportMerged=!!(merged.notes[probeId]&&merged.notes[probeId].text==='导入合并验证'&&Array.isArray(merged.checkins[probeId])&&merged.checkins[probeId].includes('2099-02-02'));
      result.planOrphanPruned=!merged.notes['hc-does-not-exist']&&!merged.checkins['hc-does-not-exist']&&!merged.studyDates['hc-does-not-exist'];
      // 已学名单存在 hm-study（不随 hm-plan 落库），导入只应接受真实课程 id
      const studyAfter=JSON.parse(localStorage.getItem('hm-study')||'{"ids":[]}').ids||[];
      result.planUnknownCourseIgnored=!studyAfter.includes('hc-does-not-exist');
      // 还原：同时清掉 localStorage 与内存态 plan，否则面板仍显示探针数据（截图会带污染）
      delete merged.notes[probeId]; delete merged.checkins[probeId]; delete merged.studyDates[probeId];
      delete merged.activity['2099-02-02'];
      localStorage.setItem('hm-plan',JSON.stringify(merged));
      delete plan.notes[probeId]; delete plan.checkins[probeId]; delete plan.studyDates[probeId];
      delete plan.activity['2099-02-02'];
      if(!studyBefore){
        const keep=studyAfter.filter(id=>id!==probeId);
        studySet.clear(); keep.forEach(id=>studySet.add(id));
        localStorage.setItem('hm-study',JSON.stringify({type:'hm-study',version:1,ids:keep}));
        updateStudyToggle();
      }
      renderPlanBody();
      document.getElementById('planClose').click();
    }
    return result;
  })()`, true);
  // scrollNav 淡入存在 CSS 过渡，页面内单次采样可能落在过渡中途（遗留#4 假失败源）：
  // 返回后按需轮询 2s，仅允许假→真翻转；超时仍为假则维持原值，由下方断言报错
  if (!desktop.scrollNavVisible) {
    desktop.scrollNavVisible = await eventually(cdp,
      "getComputedStyle(document.getElementById('scrollNav')).opacity==='1'", 2000);
  }
  await new Promise(resolve => setTimeout(resolve, 1100));
  await cdp.screenshot("p1-desktop.png");
  await cdp.evaluate(`(() => {
    const search=document.getElementById('searchInput');
    search.value='Dante'; search.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('#content .card')?.scrollIntoView({block:'center'});
  })()`);
  await new Promise(resolve => setTimeout(resolve, 500));
  await cdp.screenshot("p1-desktop-long-title.png");
  await cdp.evaluate(`(() => {
    const search=document.getElementById('searchInput');
    search.value=''; search.dispatchEvent(new Event('input',{bubbles:true}));
    scrollTo(0,0);
  })()`);
  await new Promise(resolve => setTimeout(resolve, 300));

  // 学习规划概览面板截图（热力图 + 统计 + 最近笔记）
  await cdp.evaluate(`(() => { document.getElementById('planToggle').click(); })()`);
  await new Promise(resolve => setTimeout(resolve, 300));
  await cdp.screenshot("p1-planner.png");
  await cdp.evaluate(`(() => { document.getElementById('planClose').click(); })()`);

  // 多选筛选截图：平台多选 + 访问条件（供人工复核 pill 高亮与重置按钮可用态）
  await cdp.evaluate(`(() => {
    document.querySelector('#platformFilters button:nth-child(2)').click();
    document.querySelector('#platformFilters button:nth-child(3)').click();
    document.querySelector('#accessFilters button:nth-child(2)').click();
    document.getElementById('platformFilters').scrollIntoView({block:'center'});
  })()`);
  await new Promise(resolve => setTimeout(resolve, 320));
  await cdp.screenshot("p1-multi-filter.png");
  await cdp.evaluate(`(() => { document.getElementById('resetFilters').click(); })()`);
  await new Promise(resolve => setTimeout(resolve, 260));

// 空态截图：条件 chip 回显 + 一键清除按钮
  await cdp.evaluate(`(() => {
    const search=document.getElementById('searchInput');
    search.value='不存在的课程ZZZ'; search.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await new Promise(resolve => setTimeout(resolve, 320));
  await cdp.evaluate(`(() => { document.getElementById('content').scrollIntoView({block:'center'}); })()`);
  await new Promise(resolve => setTimeout(resolve, 260));
  await cdp.screenshot("p1-empty-state.png");
  await cdp.evaluate(`(() => { document.getElementById('emptyClear').click(); })()`);
  await new Promise(resolve => setTimeout(resolve, 260));
  await cdp.evaluate(`(() => { scrollTo(0,0); })()`);
  await new Promise(resolve => setTimeout(resolve, 200));

  assert(desktop.courses === expectedCourseCount, `桌面课程数（期望 ${expectedCourseCount}）`);
  assert(desktop.altBadgeCount === expectedAltIds.length, `同课关联角标数量（期望 ${expectedAltIds.length}，实际 ${desktop.altBadgeCount}）`);
  assert(JSON.stringify(desktop.altCardIds) === JSON.stringify(expectedAltIds), "同课关联角标挂在正确课程卡上");
  assert(desktop.altJumpVisible && expectedAltIds.includes(desktop.altJumpId), "详情展开后可见其他入口跳转");
  assert(desktop.studyBadgeAfterClick, "标记已学后卡片题签出现已学徽标");
  assert(desktop.teacherFilterWorks, "点击题签教师名可按主讲检索");
  assert(desktop.planCourseOpen && desktop.planModalAria === "true", "卡片书本图标打开学习规划单课面板");
  assert(desktop.planNoteSaved && desktop.planNoteBtnActive, "学习笔记保存到 hm-plan 且卡片笔记按钮点亮");
  assert(desktop.planCheckinRecorded && desktop.planCheckinOnce && desktop.planIcsReady, "打卡记入活动、当日去重、.ics 提醒入口可用");
  assert(desktop.planClosed && desktop.planHeatCells === 182 && desktop.planStatCount === 4, "概览面板：关闭正常、热力图 26 周 182 格、四项统计");
  assert(desktop.planRecentNoteShown && desktop.planOverviewText, "概览面板展示最近笔记、热力图与连续天数");
  assert(desktop.planExportShape, "学习数据可导出为 hm-plan JSON（含已学、笔记、打卡、活动）");
  assert(desktop.planImportMerged && desktop.planOrphanPruned && desktop.planUnknownCourseIgnored, "导入按时间合并且清理失效课程记录（孤儿 id 不入库）");
  assert(desktop.bannerCount === expectedCourseCount && desktop.bannerCategoryCount === expectedCourseCount && desktop.bannerStatusCount === 0 && desktop.bannerIdentityMatches, "全部课程题签完整呈现分类、教师和课程名，且不展示核验状态");
  assert(desktop.visibleAuditLabels === 0, "网页不显示入口已核/来源已核/内容错配等治理标签");
  assert(desktop.bannerTeacherFont >= 15 && desktop.bannerNameFont >= 26, `题签教师名和课程名字号醒目（教师${desktop.bannerTeacherFont}px、课程${desktop.bannerNameFont}px）`);
  assert(desktop.paths === expectedPathCount && desktop.pathNodes === 8 && desktop.pathDraftLabels === expectedPathCount, "全部草案路径及节点");
  assert(desktop.accessFilterRowExists && desktop.resetDisabledAtStart, "访问条件筛选行存在（5 项），初始状态下重置按钮不可用");
  assert(desktop.multiSelectUnion && desktop.bothPillsActive, `平台多选为并集（单选 ${desktop.afterFirstPlatform} 门 → 双选 ${desktop.afterTwo} 门，与数据一致）且两个 pill 同时高亮`);
  assert(desktop.resetRestoresFull === expectedCourseCount, `多选态下一键重置恢复全量（${desktop.resetRestoresFull} 门）`);
  assert(desktop.freeOnlyMatches, `访问条件「免费」筛选结果与数据一致（${desktop.freeOnlyCount} 门）`);
  assert(desktop.hashRoundTrip, "筛选深链往返一致（plat/acc 多值可还原）");
  assert(desktop.hashHasAccess, "深链中带访问条件参数 acc=free");
  assert(desktop.legacyHashParsed, "旧单值深链（plat=B站）仍可兼容解析");
  assert(desktop.resetEnabledAfterFilter && desktop.afterResetAll === expectedCourseCount && desktop.resetDisabledAfter && desktop.hashClearedAfterReset, "一键重置恢复全量并清空深链");
  assert(desktop.footerPathCount === expectedPathCount, `策展说明中的路径条数与数据一致（页面 ${desktop.footerPathCount}，数据 ${expectedPathCount}）`);
  assert(desktop.heroPathCount === expectedPathCount, `Hero 副标题路径条数由数据推导（${desktop.heroPathCount}）`);
  assert(
    desktop.emptyStateShown && desktop.emptyCondCount >= 1 && desktop.emptyClearPresent
      && desktop.emptyClearRestores === expectedCourseCount && desktop.emptySearchReset,
    `空态回显生效（${desktop.emptyCondCount} 个条件 chip）且一键清除恢复全量（${desktop.emptyClearRestores} 门）`
  );
  assert(
    desktop.cardsWithIds === expectedCourseCount && desktop.uniqueCardIds === expectedCourseCount && desktop.invalidCardIds === 0 && desktop.unknownCardIds === 0,
    `课程卡 ID 完整、唯一且可回查（有 ID ${desktop.cardsWithIds}、唯一 ${desktop.uniqueCardIds}、格式错误 ${desktop.invalidCardIds}、无法回查 ${desktop.unknownCardIds}）`
  );
  assert(desktop.pathReferencesValid && desktop.pathProgressSanitized && desktop.pathChecked && desktop.pathCourseFocusMatches, "路径坏存档清洗、进度持久化与课程定位");
  assert(desktop.favoriteStorage?.version === 2, "收藏存储升级到 v2");
  assert(desktop.favoriteStorage.ids?.includes("hc-001") && desktop.favoriteStorage.ids?.includes("hc-002"), "v2 ids 与旧 urls 混合迁移");
  assert(desktop.favoriteStorage.unresolved?.includes(unknownObjectRef), "v2 未匹配引用持续保留");
  assert(desktop.recommendationCount === 6 && desktop.uniqueRecommendationIds === 6 && desktop.recommendationCategoryCount === 6 && desktop.recommendationsAllCore, "六门复核候选唯一、跨分类且属于核心候选");
  assert(desktop.platformButtonsInitial === desktop.platformButtonsAfterClicks, "平台筛选按钮不重复");
  assert(desktop.difficultyButtonsInitial === desktop.difficultyButtonsAfterClicks, "难度筛选按钮不重复");
  // 「神话」命中数随语料增长（神话学分类与含神话字面的课程都会命中），改为数据锚定下限；
  // 关键不变量是：有命中、命中的是筛选结果而非全量、清空后恢复全量
  const expectedMythFacet = sourceCourses.filter(c => String(c.category || "").includes("神话") || String(c.name || "").includes("神话")).length;
  assert(desktop.searchMyth >= expectedMythFacet && desktop.searchMyth < expectedCourseCount && desktop.searchReset === expectedCourseCount, `搜索「神话」命中 ${desktop.searchMyth} 门（数据推导至少 ${expectedMythFacet} 门）且清空恢复全量`);
  assert(
    desktop.debounceImmediate === expectedCourseCount && desktop.debounceSettled === desktop.searchMyth,
    `搜索输入 150ms 防抖：立即读取仍为全量(${desktop.debounceImmediate})、落定后为命中数(${desktop.debounceSettled})`
  );
  assert(desktop.relevanceTopNameMatch, "搜索结果按相关度排序：命中课程名的排在首位");
  assert(desktop.multiWordCount > 0 && desktop.multiWordAllMatch, `多词 AND 搜索生效且结果两词皆命中（命中 ${desktop.multiWordCount} 门）`);
  assert(desktop.searchReset2 === expectedCourseCount, "多词搜索后清空能恢复全量");
  if(expectedTechniqueSample) assert(desktop.techniqueRowVisible && desktop.techniqueFilterCount > 0 && desktop.techniqueFilterSampleOk, `技法筛选生效且结果与数据一致（样本 ${expectedTechniqueSample}）`);
  assert(
    desktop.disabledLinks === expectedDisabledLinks,
    `${expectedDisabledLinks} 条风险链接暂停跳转（实际 ${desktop.disabledLinks}）`
  );
  assert(desktop.accessBadgeCount === sourceCourses.length - expectedDisabledLinks, `全部可跳转课程显示访问条件（实际 ${desktop.accessBadgeCount}）`);
  assert(desktop.blockedCompareLinkCount === 0 && desktop.blockedCompareShowsDisabled, "对比表不得绕过风险课程的链接阻断");
  assert(desktop.modalOpen && desktop.modalRole === "dialog" && desktop.modalFocus === "modalClose", "对比弹窗语义与初始焦点");
  assert(desktop.focusReturned === "ctCompare", "弹窗关闭后焦点返回");
  assert(!desktop.shareLeakedToken, "分享链接清除敏感参数");
  assert(!desktop.shareLeakedFragment, "分享链接清除敏感片段");
  assert(!desktop.oldClaimsPresent, "旧高风险断言已删除");
  assert(desktop.scrollWidth === desktop.clientWidth, "桌面无横向溢出");
  assert(desktop.coverTitleOverlaps === 0, `课程封面大字与底部小字无重叠（实际 ${desktop.coverTitleOverlaps} 张重叠）`);
  assert(desktop.minCardWidth >= 560, `桌面课程卡最小宽度至少 560px（实际 ${desktop.minCardWidth}px）`);
  // 高密度基准沿用 P1.5：可跳转课程卡 ≤390px。
  // 阻断卡因需展示「暂停原因」+自救提示而更高，单独设 480px 上限（不压缩，否则 P1 模块失去意义）。
  assert(desktop.maxNormalCardHeight <= 390, `桌面默认课程卡（可跳转）最高不超过390px（实际 ${desktop.maxNormalCardHeight}px；超高卡：${JSON.stringify(desktop.tallNormalIds || [])}）`);
  assert(desktop.maxCollapsedCardHeight <= 480, `含暂停原因说明的阻断卡最高不超过480px（实际 ${desktop.maxCollapsedCardHeight}px，共 ${desktop.blockedCardCount} 门）`);
  // 遮挡判定用实际导航高度，不写死像素（滚动控制台高度随内容变化，硬编码会造成假失败）
  assert(desktop.firstCourseCardRects[0]?.top >= desktop.scrollNavHeight,
    `课程首排不得被顶部导航遮挡（首排顶部 ${desktop.firstCourseCardRects[0]?.top}px，导航高 ${desktop.scrollNavHeight}px）`);
  // 密度基准：可跳转课程卡高度未退化（P1.5 的 390px 高密度目标由上面的 maxNormalCardHeight 严格保证，
  // 高度不变则纯可跳转场景的一屏门数必然不变，无需重复断言）。
  // 阻断卡需展示「暂停原因」而更高，会把整屏门数从 4 拉低到 3，此为功能增强的既定代价，以 ≥3 门兜底。
  assert(desktop.fullyVisibleCourseCards >= 3, `含阻断课程时一屏仍至少完整显示3门（实际 ${desktop.fullyVisibleCourseCards}门，其中可跳转 ${desktop.fullyVisibleNormalCards}门；${JSON.stringify(desktop.firstCourseCardRects)}）`);
  assert(desktop.scrollNavVisible, "滚过页眉后顶部课程控制台可见");
  assert(desktop.topNavControls === 7 && desktop.miniPlatformOptions === desktop.platformButtonsInitial, "顶部导航包含平台、难度、可访问、收藏、排序、检索和返回顶部");
  assert(desktop.miniPlatformSynced && desktop.miniDifficultySynced && desktop.miniFavSynced && desktop.miniOpenSynced && desktop.miniSortSynced, "顶部主要选项与原筛选工具双向同步");
  assert(desktop.openOnlyCourseCount === sourceCourses.length - expectedDisabledLinks, `“有入口”筛选应覆盖全部可跳转课程（实际 ${desktop.openOnlyCourseCount}）`);
  assert(desktop.leftNavWidth <= 48, `左侧浮动导航宽度不超过48px（实际 ${desktop.leftNavWidth}px）`);
  assert(desktop.detailButtonCount === expectedCourseCount && desktop.detailExpanded && desktop.expandedIntroVisible && desktop.detailCollapsed, "全部课程详情可按需展开并收起");
  assert(desktop.heroHeight <= 330, `桌面首屏页眉高度不超过 330px（实际 ${desktop.heroHeight}px）`);
  assert(desktop.mainWidth / desktop.wrapInnerWidth >= 0.99, `分类导航不侵占主列宽度（主列/内容容器 ${(desktop.mainWidth / desktop.wrapInnerWidth).toFixed(2)}）`);

  await cdp.call("Emulation.setDeviceMetricsOverride", { width:390, height:844, deviceScaleFactor:2, mobile:true });
  await cdp.navigate(`http://127.0.0.1:${serverPort}/`);
  const mobile = await cdp.evaluate(`(async () => {
    scrollTo(0,document.querySelector('.hero').offsetHeight+80);
    await new Promise(resolve=>setTimeout(resolve,120));
    return {
      courses:document.querySelectorAll('.card').length,
      paths:document.querySelectorAll('.path-item').length,
      scrollWidth:document.documentElement.scrollWidth,
      clientWidth:document.documentElement.clientWidth,
      minActionSize:Math.min(...[...document.querySelectorAll('.card-actions .act')].map(el=>el.getBoundingClientRect().width)),
      reviewFooterOverlapCount:[...document.querySelectorAll('#content .card')].filter(card=>{const review=card.querySelector('.review').getBoundingClientRect();const footer=card.querySelector('.card-footer').getBoundingClientRect();return review.bottom>footer.top;}).length,
      minReviewFooterGap:Math.round(Math.min(...[...document.querySelectorAll('#content .card')].map(card=>card.querySelector('.card-footer').getBoundingClientRect().top-card.querySelector('.review').getBoundingClientRect().bottom))),
      navOpenVisible:getComputedStyle(document.getElementById('miniOpenOnly')).display!=='none',
      navFavVisible:getComputedStyle(document.getElementById('miniFav')).display!=='none'
    };
  })()`, true);
  // 移动端学习规划面板：可开关、热力图不横向溢出、触控目标达标、笔记可保存
  const mobilePlan = await cdp.evaluate(`(() => {
    const result={};
    document.getElementById('planToggle').click();
    result.open=!document.getElementById('planModal').hidden;
    const box=document.querySelector('#planBody .heatmap-wrap');
    result.heatVisible=!!box&&box.getBoundingClientRect().width>0;
    result.heatOverflow=box?Math.round(box.scrollWidth-box.clientWidth):0;
    result.pageOverflowOpen=document.documentElement.scrollWidth-document.documentElement.clientWidth;
    result.minPlanBtn=document.querySelectorAll('#planBody .plan-stat').length?Math.min(...[...document.querySelectorAll('#planBody .plan-stat')].map(el=>el.getBoundingClientRect().width)):0;
    document.getElementById('planClose').click();
    result.closed=document.getElementById('planModal').hidden;
    const nb=document.querySelector('#content .card .note-btn'); nb.click();
    result.courseOpen=!document.getElementById('planModal').hidden;
    const ta=document.getElementById('planNoteText');
    result.textareaWidth=Math.round(ta.getBoundingClientRect().width);
    result.minCourseBtn=Math.min(...[...document.querySelectorAll('#planBody .plan-btn')].map(el=>Math.min(el.getBoundingClientRect().width,el.getBoundingClientRect().height)));
    ta.value='移动端笔记保存验证';
    document.getElementById('planSaveNote').click();
    const id=nb.closest('.card').dataset.id;
    const store=JSON.parse(localStorage.getItem('hm-plan'));
    result.noteSaved=!!(store.notes&&store.notes[id]&&store.notes[id].text==='移动端笔记保存验证');
    result.pageOverflowCourse=document.documentElement.scrollWidth-document.documentElement.clientWidth;
    document.getElementById('planClose').click();
    return result;
  })()`, true);
  // 面板保持打开状态截图，便于人工复核移动端排版
  await cdp.evaluate(`(() => { document.getElementById('planToggle').click(); })()`);
  await new Promise(resolve => setTimeout(resolve, 400));
  await cdp.screenshot("p1-mobile-planner.png");
  await cdp.evaluate(`(() => { document.getElementById('planClose').click(); })()`);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await cdp.screenshot("p1-mobile.png");
  await cdp.evaluate(`(() => { document.documentElement.style.scrollBehavior='auto'; const card=document.querySelector('#content .card'); scrollTo(0,scrollY+card.getBoundingClientRect().top-52); })()`);
  await new Promise(resolve => setTimeout(resolve, 350));
  await cdp.screenshot("p1-mobile-courses.png");
  assert(mobile.courses === expectedCourseCount && mobile.paths === expectedPathCount, "移动端课程与路径");
  assert(mobile.scrollWidth === mobile.clientWidth, "移动端无横向溢出");
  assert(mobile.minActionSize >= 44, "移动端卡片操作目标至少 44px");
  assert(mobile.reviewFooterOverlapCount === 0 && mobile.minReviewFooterGap >= 0, `移动端编辑观点不得与操作区重叠（重叠 ${mobile.reviewFooterOverlapCount}，最小间距 ${mobile.minReviewFooterGap}px）`);
  assert(mobile.navOpenVisible && mobile.navFavVisible, "移动端滚动控制台保留有入口与收藏操作");
  assert(mobilePlan.open && mobilePlan.closed, "移动端学习规划面板可开启与关闭");
  assert(mobilePlan.heatVisible && mobilePlan.heatOverflow === 0 && mobilePlan.pageOverflowOpen === 0, "移动端热力图完整显示且无横向溢出");
  assert(mobilePlan.courseOpen && mobilePlan.noteSaved && mobilePlan.pageOverflowCourse === 0, "移动端单课笔记可保存且面板不撑破页面");
  assert(mobilePlan.minCourseBtn >= 32, `移动端规划面板按钮可达（最小边 ${Math.round(mobilePlan.minCourseBtn)}px）`);

  await cdp.call("Emulation.clearDeviceMetricsOverride");
  await cdp.navigate(new URL(`file://${path.join(siteRoot, "index.html")}`).href);
  const fileMode = await cdp.evaluate(`(() => ({
    protocol:location.protocol,
    courses:document.querySelectorAll('.card').length,
    paths:document.querySelectorAll('.path-item').length,
    loadError:document.body.innerText.includes('数据加载失败')
  }))()`);
  assert(fileMode.protocol === "file:" && fileMode.courses === expectedCourseCount && fileMode.paths === expectedPathCount && !fileMode.loadError, "file:// 双击运行");
  assert(cdp.runtimeErrors.length === 0, "浏览器运行错误为 0");

  const result = { generatedAt:new Date().toISOString(), siteRoot:path.relative(root, siteRoot) || ".", legacyArrayMigration, desktop, mobile, mobilePlan, fileMode, runtimeErrorCount:cdp.runtimeErrors.length, runtimeErrors:cdp.runtimeErrors };
  fs.writeFileSync(path.join(validationDir, "p1-browser-results.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  ok = true;
  console.log("浏览器回归通过");
} finally {
  if (ws) ws.close();
  if (chrome && chrome.exitCode === null) {
    chrome.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve => chrome.once("exit", resolve)),
      new Promise(resolve => setTimeout(resolve, 2500))
    ]);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      // 与 2.5s 宽限同构的超时兜底：Chrome 可能在 SIGKILL 前一刻自行退出，此时 'exit' 事件
      // 已在挂上 once("exit") 监听器之前派发完毕，Promise 永远 resolve 不了导致进程挂起
      await Promise.race([
        new Promise(resolve => chrome.once("exit", resolve)),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    }
  }
  // keep-alive 连接会导致 server.close 的 callback 永不触发（Windows 上尤甚）：带超时等待并强制断开连接
  await new Promise(resolve => {
    const done = () => resolve();
    server.close(done);
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    setTimeout(done, 1000);
  });
  // profile 清理尽力而为：Windows 上 Chrome 退出中的 Crashpad 锁文件常驻，rmSync 可能持续 EBUSY。
  // 清理失败不再抛出——异常会淹没成功路径的退出码；临时目录残留无害，由 OS 回收。
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(profile, { recursive:true, force:true }); break; }
      catch (error) {
        if (attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
  } catch (error) {
    console.warn("临时 Chrome 目录清理失败（不影响结果）：" + profile + " - " + error.message);
  }
  // 成功路径主动退出：避免 Chrome profile 目录锁定等残留句柄导致进程挂起不退出
  if (ok) process.exit(0);
}
