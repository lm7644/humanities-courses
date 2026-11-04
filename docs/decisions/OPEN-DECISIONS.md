# OPEN-DECISIONS 未决事项登记册

> 规则：只追加 + 就地关闭（OPEN → RESOLVED，补 Resolution 字段）。每次 Phase/批次开始时把未决项带到工作上下文最前面。
> 创建：2026-10-06（项目全面检查报告 `_20261006` 配套）

| ID | Date | Source | Open Item | Related Constraints | Current Leaning | Blocked By | Resolves When | Status |
|----|------|--------|-----------|---------------------|------------------|-----------|--------------|--------|
| OPEN-1 | 2026-10-06 | 全面检查 §4.2 | 核心候选双轨标识：`core` 布尔（20 门 true）与 `editorial_status=core_candidate`（71 门）口径不一致，导致 17 条路径引用被判违规 | 门禁 `second-round-audit` 按布尔口径；数据按状态口径 | **方案乙**：门禁改用 `editorial_status` 判定（改动 3 行，不动数据） | 用户拍板 | 用户确认口径后 | RESOLVED |
| OPEN-2 | 2026-10-06 | 全面检查 P1-7 | 22 门阻断课程（needs_review 11 / unavailable 11）的最终去向：永久留档 / 180 天后移入 `data/courses-archive.json` | 证据边界原则：不为未核验课程编造信息 | 设 180 天规则；最早核验日 2026-07-28 → 2027-01-24 前后才触发 | 需先定规则再等时间 | 规则写入 `docs/P1内容治理与教师共建规则.md` | OPEN |
| OPEN-3 | 2026-10-06 | 全面检查 P0-4 | canonical 与部署域名：现指向 CloudBase 测试域名（平台声明非项目所有者） | SEO 权重、分享卡片缓存、迁移成本 | 注册自有域名后统一改 canonical + sitemap + og:url | 需注册/备案决策 | 域名确定并完成一次部署 | OPEN |
| OPEN-4 | 2026-10-06 | 全面检查 §4.3 | `vibex-handoff` 交付包处置：按 VibeX 约束重新生成一版，还是归档出工作区并从 git 移除 | VibeX 硬约束：单文件 index.html + data.json，无 Node 运行时、无 .js 附件 | 归档（该包已落后 416 行且违反 P0-1 符号字形禁令） | 用户选择 | 归档或重新生成完成 | OPEN |
| OPEN-5 | 2026-10-25 | 接收方复核（F1） | ci.yml/links.yml 的 push/PR 触发分支仅 `main`，而本地仓库唯一分支为 `master`——推送后 CI 不触发 | 交接文档 P0「推送 GitHub 远端」的生效前提 | 双分支对齐：两个 workflow 的 branches 改为 `[main, master]`（任一分支名推送均触发） | 无（技术修正，无需用户拍板） | workflow 已改并随修复集提交 | RESOLVED |

## 已关闭

| ID | Resolution |
|----|-----------|
| OPEN-1 | 2026-10-06 采用**方案乙**：`tools/second-round-audit.js` 的「路径引用闭合」改用 `editorial_status === "core_candidate"` 判定，数据未改动。`core` 布尔保留为「首轮 20 门已人工过一遍」的子集标记，不再作为路径引用与门禁的判据；`npm run build:core` 的派生清单语义同步说明于 README。 |
| OPEN-5 | 2026-10-25 接收方修复：`.github/workflows/ci.yml` 与 `links.yml` 的 push/PR `branches` 由 `[main]` 改为 `[main, master]`，消除本地 master 分支推送后 CI 不触发的问题。 |
