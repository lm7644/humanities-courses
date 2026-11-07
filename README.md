# 人文学科公开课策展与样板路径

**在线站点：** [https://lm7644.github.io/humanities-courses/](https://lm7644.github.io/humanities-courses/) —— GitHub Pages 自动构建 `dist/`，主分支推送后自动更新，无需本地环境即可浏览。

**humanities-courses** — An open-source, fully static curation site for open courses in Chinese Language & Literature（汉语言文学）: verified course entries from Bilibili, China University MOOC, XuetangX, edX, Coursera and more, with multi-platform filtering, pinyin fuzzy search, curated learning paths, and local-only study tracking. No backend, no runtime dependencies — the built `dist/` runs on any static host (GitHub Pages deploy workflow included).

P1.6 双轮审计与公网发布版。完成稳定课程ID、证据字段、五条草案路径、桌面两列两排课程卡、书封题签、滚动课程控制台、左侧点阵导航、收藏兼容迁移、无障碍弹窗、入口条件标注、计划一致性审计和空目录复刻演练。当前共 205 门课程，其中 183 门提供外部入口，22 门因失效、错配或证据不足继续阻断；教师学术核验完成数仍为 0。

站点提供**学习规划**：工具栏「学习规划」打开概览（已学/累计打卡/连续天数/笔记数 + 近 26 周活动热力图 + 最近笔记 + 导出/导入学习数据）；每张课程卡的书本图标打开单课面板，可记笔记、当日打卡、下载 `.ics` 周提醒（每周 20:00，共 8 次）。这些数据只写入本机浏览器的 `hm-plan` / `hm-study`（localStorage），不上传、不跨设备同步；换设备或清缓存前请用「导出学习数据」留档，导入时按更新时间合并，并自动清理已下架课程的残留记录。

## 运行

- 直接双击 `index.html`：通过生成的 `data/courses.js` 与 `data/paths.js` 加载数据。
- 本地 HTTP：在本目录运行 `python -m http.server 8765`，访问 `http://127.0.0.1:8765/`（Windows 未装 `python3` 别名时用 `python`）。
- 工程命令需要 Node.js 22 或更高版本。

筛选支持平台多选（并集）与访问条件维度（免费 / 付费 / 需登录 / 待确认），工具栏「重置筛选」一键清空全部条件与检索词；筛选状态写入地址栏深链（`#f=plat=B站,edX&acc=free`），旧版单平台链接（`plat=B站`）仍可打开。空结果时页面会回显当前生效的条件并提供清除入口。

## 修改数据

1. 课程只编辑 `data/courses.json`，路径只编辑 `data/paths.json`。
2. 运行 `npm run build:data`，同步生成两个浏览器数据脚本。
3. 运行 `npm run build:core`，更新 20 门核心候选审查清单。
4. 运行 `npm run verify:full`，完成静态、离线巡检、计划一致性、真实浏览器验收、静态产物验收和空目录复刻演练。
5. 发布前运行 `npm run audit:network && npm run audit:round2`，生成独立联网报告与第二轮汇总审计。

`data/core-candidates.json` 是派生审查文件，不是新的编辑源。课程 Schema 见 `data/course.schema.json`，路径 Schema 见 `data/path.schema.json`。

## 证据边界

- `core_candidate` 只表示进入首轮人工复核，不表示课程已经可信发布。
- 五条路径均为 `draft_requires_academic_review`（当前共 5 条），课程范围仍需教师精确到讲次。
- HTTP 可达仅说明链接可访问，课程名、讲师、免费范围、授权与内容匹配仍需人工确认。
- 未知信息使用 `unknown`、`null` 或空数组，不按平台或讲师声誉推断。

## 验证命令

- `npm test`：生成数据一致性、字段/状态/唯一 ID/唯一 URL、核心候选、路径引用、凭证门禁与离线链接巡检。
- `npm run test:browser`：自行启动本地服务器与 Chrome，验证 HTTP、`file://`、桌面、移动端、旧收藏迁移、路径展开、搜索、筛选、对比弹窗、分享脱敏、触控尺寸和运行错误。
- `npm run audit:network`：联网检查可达性、来源标题漂移和90天过期状态，结果独立保存到 `validation/link-network-report.json`；自动结果不能替代内容复核。
- `npm run audit:plan`：验证7项当前采用的外部参考机制有真实工程落点，5项许可阻断资源未进入课程与路径正文。
- `npm run audit:symbols`：P0-1 门禁，扫描可交付源码与数据（`index.html`、`tools/`、`data/`、`dist/index.html`、workflow）中的 emoji 与符号字形，命中即失败。文档与二进制产物不在扫描口径内。
- `npm run audit:round2`：独立汇总课程、入口、文案、路径、计划、桌面、移动端、联网与运行时等门禁，门禁项数以 second-round-audit.js 实际输出为准，判定基线全部由数据动态推导（不再硬编码课程数）。浏览器回归与联网巡检产物若早于源码，本项降级为 `WARN` 提示重跑，不阻塞本地门禁；「核心候选」口径按 `editorial_status=core_candidate` 判定（`core` 布尔为首轮 20 门子集标记，见 `docs/decisions/OPEN-DECISIONS.md`）。
- `npm run build:site`：生成平台无关的 `dist/` 静态站点目录，只保留页面运行所需文件。
- `npm run verify:site`：校验静态站点目录是否完整。
- `npm run test:replica`：在全新临时目录复制白名单工程文件，重新构建并运行浏览器回归。
- `data/source-audit-20260729.json`：41门原待核课程的逐门来源审核账本；`data/source-audit-supplement-20260731.json` 保留第二轮替代入口接受/拒绝证据；教师学术审定仍为0。
- `data/reference-adoption.json`：活动计划保留的12个高价值外部参考对象账本。
- `data/reference-adoption.schema.json`：外部参考纳入账本Schema。

复刻步骤、外部对象边界和验收门槛见 `docs/项目复刻与可借鉴方案.md`。

历史交付残留（`index.html.bak-p1.6`、`validation/p0-*` 与 `public-*` 旧截图、`vibex-handoff/` 交付包）已冷归档到项目外的 `../chat-1-archive/2026-10-07/`，逐文件 SHA-256 校验一致后从仓库移除；`vibex-handoff` 如需重新交付，应按 VibeX 约束（单文件 `index.html` + `data.json`，无 Node 运行时、无 `.js` 附件）从当前主线重新生成。

## 视觉风格

视觉令牌与样例规范见 `docs/visual-spec.md`。要点：朱红主题（深色 `#E0483D` / 浅色 `#C8342A`）、17 类课程分类各配一色（经亮度对比校验）、serif 标题 + sans 正文、全量统一描边 SVG 图标（禁 emoji 作功能图标）、程序化 SVG 封面（零请求零版权，噪声滤镜全站共享单实例）。

托管与域名选择见 `docs/P1部署与域名方案.md`。平台子域名可以长期使用，但不属于项目所有者；自有域名需要单独注册，便于迁移。

## 发布

运行 `npm run release`。发布目录使用白名单生成，不包含 `.edgeone/`、`.env`、未使用封面或原始凭证。若要上传到静态托管平台，运行 `npm run build:site` 后上传 `dist/`，不要上传整个开发目录。

部署令牌只能放在平台或 CI Secret 中。原压缩包曾包含令牌，本地清空不能替代在 EdgeOne 控制台吊销、轮换与检查日志。
