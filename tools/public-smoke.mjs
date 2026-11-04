#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2];
if (!/^https:\/\//.test(url || "")) throw new Error("用法：node tools/public-smoke.mjs https://公网地址/");
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
  throw new Error("未找到 Chrome/Chromium");
}
function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.unref(); server.on("error", reject); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); }); }
function assert(condition, message) { if (!condition) throw new Error(`公网验收失败：${message}`); }
async function waitDevtools(port) { for (let index = 0; index < 200; index++) { try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("Chrome DevTools 未启动"); }
async function connectWebSocket(target) { const ws = new WebSocket(target); await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); }); return ws; }

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; this.waiters = []; this.errors = []; ws.addEventListener("message", event => this.onMessage(JSON.parse(event.data))); }
  onMessage(message) {
    if (message.id && this.pending.has(message.id)) { this.pending.get(message.id)(message); this.pending.delete(message.id); return; }
    if (message.method === "Runtime.exceptionThrown") this.errors.push({ type: "exception", detail: message.params });
    if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") this.errors.push({ type: "log", detail: message.params.entry });
    const index = this.waiters.findIndex(waiter => waiter.method === message.method);
    if (index >= 0) this.waiters.splice(index, 1)[0].resolve(message); else this.events.push(message);
  }
  call(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)); }, 20000); this.pending.set(id, message => { clearTimeout(timer); if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`)); else resolve(message.result || {}); }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  waitFor(method) { const index = this.events.findIndex(event => event.method === method); if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`${method} 事件超时`)), 20000); this.waiters.push({ method, resolve: value => { clearTimeout(timer); resolve(value); } }); }); }
  async navigate(target) { this.events = []; await this.call("Page.navigate", { url: target }); await this.waitFor("Page.loadEventFired"); for (let index = 0; index < 80; index++) { const rendered = Number(await this.evaluate("document.querySelectorAll('#content .card').length") || 0); const total = Number(await this.evaluate("window.HUMANITIES_COURSES ? window.HUMANITIES_COURSES.length : 0") || 0); if (total > 0 && rendered === total) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error(`公网页面未完成渲染：卡数 ${await this.evaluate("document.querySelectorAll('#content .card').length")} / 数据 ${await this.evaluate("window.HUMANITIES_COURSES ? window.HUMANITIES_COURSES.length : 0")}`); }
  async evaluate(expression, awaitPromise = false, userGesture = false) { const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise, userGesture }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; }
  async screenshot(filename) { const result = await this.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); fs.writeFileSync(path.join(validationDir, filename), Buffer.from(result.data, "base64")); }
}

const devtoolsPort = await freePort();
const profile = path.join(os.tmpdir(), `humanities-public-smoke-${process.pid}`);
let chrome;
let ws;
try {
  chrome = spawn(chromePath(), ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", `--remote-debugging-port=${devtoolsPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  await waitDevtools(devtoolsPort);
  const target = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, { method: "PUT" })).json();
  ws = await connectWebSocket(target.webSocketDebuggerUrl);
  const cdp = new CDP(ws);
  await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Log.enable"); await cdp.call("Target.setDiscoverTargets", { discover: true });

  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.navigate(`${url}${url.includes("?") ? "&" : "?"}public-smoke=20260731`);
  const desktop = await cdp.evaluate(`(async()=>{
    const result={title:document.title,courses:document.querySelectorAll('#content .card').length,paths:document.querySelectorAll('.path-item').length,disabled:document.querySelectorAll('#content .go.disabled').length,badges:document.querySelectorAll('#content .access-badge').length,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth};
    const enabled=[...document.querySelectorAll('#content .go[href]')];
    result.externalLinkContract=enabled.every(link=>link.target==='_blank'&&link.rel.includes('noopener')&&link.rel.includes('noreferrer')&&link.href.startsWith('https://'));
    result.yeLangHref=document.querySelector('#content .card[data-id="hc-045"] .go[href]')?.href||null;
    result.liuQingAnchors=document.querySelectorAll('#content .card[data-id="hc-015"] .go[href]').length;
    result.leDaiyunAnchors=document.querySelectorAll('#content .card[data-id="hc-023"] .go[href]').length;
    document.getElementById('openOnlyToggle').click();result.openOnlyCount=document.querySelectorAll('#content .card').length;document.getElementById('openOnlyToggle').click();
    const search=document.getElementById('searchInput');search.value='Dante';search.dispatchEvent(new Event('input',{bubbles:true}));result.danteCount=document.querySelectorAll('#content .card').length;search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,150));
    const first=document.querySelector('#content .card');document.documentElement.style.scrollBehavior='auto';document.documentElement.style.overflowAnchor='none';document.body.style.overflowAnchor='none';const nav=document.getElementById('scrollNav').getBoundingClientRect().height;scrollTo(0,first.getBoundingClientRect().top+scrollY-nav-2);await new Promise(r=>setTimeout(r,180));for(let n=0;n<3;n++){const d=first.getBoundingClientRect().top-(nav+2);if(Math.abs(d)<=1)break;scrollBy(0,d);await new Promise(r=>setTimeout(r,100));}
    const rects=[...document.querySelectorAll('#content .card')].map(card=>{const r=card.getBoundingClientRect();return{top:Math.round(r.top),bottom:Math.round(r.bottom)}});result.firstCardTop=rects[0].top;result.fullyVisible=rects.filter(r=>r.top>=nav-1&&r.bottom<=innerHeight).length;return result;
  })()`, true);
  await new Promise(resolve => setTimeout(resolve, 1200));
  await cdp.screenshot("public-desktop.png");
  cdp.events = cdp.events.filter(event => event.method !== "Target.targetCreated");
  const externalTargetPromise = cdp.waitFor("Target.targetCreated");
  await cdp.evaluate("document.querySelector('#content .go[href]').click()", false, true);
  await externalTargetPromise;
  await new Promise(resolve => setTimeout(resolve, 1200));
  const targetsAfterClick = await cdp.call("Target.getTargets");
  desktop.clickedExternalUrl = (targetsAfterClick.targetInfos || []).find(info => /^https:\/\/www\.bilibili\.com\/video\//.test(info.url || ""))?.url || null;

  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.navigate(`${url}${url.includes("?") ? "&" : "?"}public-mobile-smoke=20260731`);
  const mobile = await cdp.evaluate(`(()=>({courses:document.querySelectorAll('#content .card').length,paths:document.querySelectorAll('.path-item').length,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,minAction:Math.min(...[...document.querySelectorAll('.card-actions .act')].map(el=>el.getBoundingClientRect().width)),reviewFooterOverlap:[...document.querySelectorAll('#content .card')].filter(card=>card.querySelector('.review').getBoundingClientRect().bottom>card.querySelector('.card-footer').getBoundingClientRect().top).length,pathHorizontalOverflow:document.querySelector('.path-grid').scrollWidth>document.querySelector('.path-grid').clientWidth}))()`);
  await new Promise(resolve => setTimeout(resolve, 1200));
  await cdp.screenshot("public-mobile.png");

  const result = { generatedAt: new Date().toISOString(), url, desktop, mobile, runtimeErrorCount: cdp.errors.length, runtimeErrors: cdp.errors };
  assert(desktop.title === "人文学科公开课目录 · 选课与学习路径", "页面标题或版本不符");
  assert(desktop.courses === Number(await cdp.evaluate("window.HUMANITIES_COURSES.length")) && desktop.paths === Number(await cdp.evaluate("window.HUMANITIES_PATHS.paths.length")), "桌面课程或路径数量");
  assert(desktop.disabled === Number(await cdp.evaluate("window.HUMANITIES_COURSES.filter(c=>['unavailable','needs_review'].includes(c.status)).length")) && desktop.badges === desktop.courses - desktop.disabled && desktop.openOnlyCount === desktop.courses - desktop.disabled, "入口数量或筛选语义");
  assert(desktop.yeLangHref?.includes("BV1bE411D7Y9") && desktop.liuQingAnchors === 0 && desktop.leDaiyunAnchors === 0, "第二轮替代入口决策未生效");
  assert(desktop.danteCount >= 1, "外链安全属性或长标题搜索");
  assert(/^https:\/\/www\.bilibili\.com\/video\//.test(desktop.clickedExternalUrl || ""), `真实课程点击未打开预期外部页面：${desktop.clickedExternalUrl}`);
  assert(desktop.scrollWidth === desktop.clientWidth && desktop.firstCardTop >= 53 && desktop.fullyVisible >= 4, "桌面溢出、导航遮挡或四门一屏");
  assert(mobile.courses === Number(await cdp.evaluate("window.HUMANITIES_COURSES.length")) && mobile.paths === Number(await cdp.evaluate("window.HUMANITIES_PATHS.paths.length")) && mobile.scrollWidth === mobile.clientWidth, "移动端内容或横向溢出");
  assert(mobile.minAction >= 44 && mobile.reviewFooterOverlap === 0 && mobile.pathHorizontalOverflow, "移动触控、卡片重叠或路径书架");
  assert(result.runtimeErrorCount === 0, `运行时错误 ${result.runtimeErrorCount}`);
  fs.writeFileSync(path.join(validationDir, "public-smoke-results.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  console.log("CloudBase公网桌面与移动端回归通过");
} finally {
  if (ws) ws.close();
  if (chrome) chrome.kill("SIGTERM");
  fs.rmSync(profile, { recursive: true, force: true });
}
