# 视觉令牌规范（visual-spec）

> 生成日期：2026-08-31（A1 色板校验 2026-09-04 更新）
> 唯一事实源是 `index.html` 头部 CSS 与 `CAT_COLORS`；本文是给复刻者与后续扩展者的可读快照，改动以代码为准。

## 1. 色彩

### 1.1 主题色（P0-2 合规：朱红定调，禁紫粉渐变主视觉）

| 用途 | 深色主题 | 浅色主题 |
|---|---|---|
| `--accent` | `#E0483D` | `#C8342A` |
| `--accent-2` | `#ff5b4d` | `#E0483D` |
| `--surface` / `--surface-2` | `#161412` / `#1e1b17` | `#fffdf8` / `#faf6ec` |
| `--ink` / `--ink-soft` | `#f3ede2` / `#c3bbac` | `#1a1611` / `#4a443a` |
| `--muted`（次要文字） | `#948a7b` | `#6b6257` |

**中性色对比度门禁**：`--muted` 在页面底 / 卡片底 / 次级底三档背景上的对比度须 ≥ 4.5:1（WCAG AA 正文）。当前实测：

| 主题 | 页面底 | 卡片底 | 次级底 |
|---|---|---|---|
| 暗色 | 5.75:1 | 5.41:1 | 5.05:1 |
| 浅色 | 5.21:1 | 5.89:1 | 5.54:1 |

该门禁已固化在 `tools/validate-project.js`（改动 `--muted` 低于阈值即 `ERROR`），历史值 `#857c6e` / `#8a8175` 会被拦下。

### 1.2 分类色板（CAT_COLORS，16 类）

| 分类 | 色值 | 亮度 L | 封面标题对比（#f4eee3） |
|---|---|---|---|
| 古代文学 | `#E0483D` | 0.208 | 3.5:1 |
| 现当代文学 | `#D6336C` | 0.177 | 4.0:1 |
| 文学理论 | `#3B5BDB` | 0.135 | 4.9:1 |
| 西方文论 | `#7048E8` | 0.139 | 4.8:1 |
| 比较文学 | `#0CA678` | 0.287 | 2.7:1 |
| 神话学 | `#E8590C` | 0.243 | 3.1:1 |
| 汉语修辞学 | `#2F9E44` | 0.255 | 3.0:1 |
| 写作与表达 | `#F08C00` | 0.373 | 2.2:1 |
| 东方文学 | `#E64980` | 0.231 | 3.2:1 |
| 语言学 | `#1098AD` | 0.256 | 3.0:1 |
| 艺术美学 | `#E03131` | 0.183 | 3.9:1 |
| 哲学与思想 | `#6741D9` | 0.117 | 5.5:1 |
| 戏剧影视 | `#F76707` | 0.295 | 2.6:1 |
| 英语文学 | `#0B7285` | 0.138 | 4.8:1 |
| 国画 | `#2B8A3E` | 0.190 | 3.8:1 |
| 书法 | `#6E4726`（原 `#5C3A21`，A1 校验提亮一档） | 0.080 | 6.5:1 |

**A1 校验方法**：WCAG 相对亮度 L；安全带取 `0.08 ≤ L ≤ 0.50`（保证封面浅色标题与分类标签深字双向可用）。新增分类取色必须落在安全带内。

## 2. 字体

| 用途 | 规格 |
|---|---|
| 标题（题签课程名） | serif（Georgia 系），28px / 900 / 行高 1.08，最多 2 行截断 |
| 题签教师名 | sans，17px / 800 / 行高 1.15（紧凑密度 14px） |
| 题签分类 | sans，10.5px / 800 / letter-spacing .18em |
| 卡片正文 | 12.5px 基准；meta 行 11.5–12px |

## 3. 图标（P0-1 合规）

- 全站唯一方案：`icon()` 注册表内的统一描边 SVG（stroke 1.8、round cap/join、24 viewBox）
- 尺寸：12px（徽标内）/ 16px（行内按钮）/ 默认 20px+（独立）
- 禁止 emoji / 符号字形（U+2600–26FF 等）作功能图标；门禁用正则扫描
- 现有语义：sun / moon / link / star / close / check / download / upload / alert / scale / book / flag / layers / lvl1-3 / contrast / circle / dense / comfort

## 4. 卡片结构样例（新增模块时的对齐基准）

```
<article class="card" style="--cat-color:{CAT_COLORS[分类]}">
  .cover（132px，紧凑 108px）
    ├─ coverSVG（程序化：渐变底 + 圆点纹理 + 分类标签 + 大字标题 + 主讲·平台脚注）
    ├─ .course-banner（渐变遮罩 + 4px 左侧分类色条，阴影 35% 透明度）
    │    ├─ .banner-category / .banner-teacher(含 .teacher-link 可点击检索) / .banner-name
    ├─ .alt-badge（右上，另有 N 个入口）
    └─ .study-badge（左上，已学对勾）
  .card-body
    ├─ .badges（平台 / 难度 lvl 电平条 / 访问条件）
    ├─ .meta（学校·职称 / 阶段·时长·核验日期）
    ├─ .intro（编辑摘要）/ .review（编辑观点）
    ├─ .blocked-note（仅阻断课：accent 左条 + 暂停原因）
    ├─ .card-detail（展开区：系列条目 / 技法 / 载体 / 其他入口 .alt-jump）
    └─ .card-footer（go 链接 / 查看详情 / 收藏·已学·对比·深链·报告）
</article>
```

## 5. 动效

| 项 | 规格 |
|---|---|
| 卡片入场 | cardIn 400ms，每组 12 张按 55ms 错峰 |
| 徽标入场 | badgeIn 220ms（alt / study） |
| 详情展开 | max-height + opacity 200ms |
| hover tilt | ±8° / ±7°（B4 克制化），reduce-motion 降级 |
| 禁用兜底 | `prefers-reduced-motion` 与 `[data-anim="off"]` 均禁 transition/animation |

## 6. 性能约定

- feTurbulence 噪声滤镜全站共享单实例 `#hcGrain`（width:0 容器挂 body，勿用 display:none——会导致 filter 引用失效）
- 封面纯 SVG 零请求；运行时零依赖（禁止引入 Tailwind / Fuse.js / 图标库包）
- >200 门课程才考虑懒渲染（当前 205 门，已达阈值；开源初版不做，列入社区迭代项）

## 6.1 学习规划面板令牌（笔记 / 打卡 / 提醒 / 热力图）

| 元素 | 规格 |
|---|---|
| 面板容器 | 复用 `.modal-box`，宽度 `min(680px,96vw)`；标题栏与对比弹窗一致 |
| 统计块 | `.plan-stat` 四列网格（≤640px 转 2 列），数字用 `--font-serif` 22px + `--accent`，标签 12px `--ink-soft` |
| 热力图 | 26 周 × 7 天 = 182 格；`grid-auto-flow:column` + `grid-template-rows:repeat(7,12px)`，格 12px、间距 3px（移动端 9px/2px） |
| 热力图色阶 | 5 档：`--line` → `rgba(224,72,61,.28/.52/.76)` → `--accent`（浅色主题用 `rgba(200,52,42,…)`）；今日加 `--ink-soft` 描边，未来日期 `visibility:hidden` 留位 |
| 图例 | 5 个 `.hm-sw` 色块（**禁符号字形**，P0-1） |
| 笔记编辑 | `.plan-textarea` 13.5px/1.7，最大 4000 字，聚焦 `--accent-soft` 外发光 |
| 面板按钮 | `.plan-btn` 主按钮实心 `--accent`，`.ghost` 描边；禁用态 `opacity:.5` |
| 导入导出行 | 概览面板统计块下方 `.plan-actions`：两个 `.plan-btn.ghost`（导出/导入学习数据）+ 一句 `.plan-hint` 说明合并策略 |
| 站内轻提示 | `.toast-wrap` 底部居中，`.toast` 左边框 3px `--accent`，`toastIn` 180ms；reduce-motion 与 `[data-anim="off"]` 禁用动画 |
| 空态 | `.empty-cond` 条件 chip（`--line-strong` 描边）+ `.empty-clear` 一键清除按钮 |
| 多选筛选行 | 平台 / 访问条件为多选：选中项 `.pill.active`（朱红实底），「全部」清空该维度；可同时高亮多个 |
| 访问条件维度 | 5 项：全部 / 免费 / 付费 / 需登录 / 待确认，值映射到数据 `access_mode`（`free`/`paid`/`login_required`/`unknown`） |
| 重置筛选按钮 | 工具栏 `.pill.ghost`，无筛选时 `disabled` + `aria-disabled`，有筛选时 `.active` 点亮 |

## 7. 封面 SVG 样例（字段映射）

```
color   = CAT_COLORS[分类]
cat     = 分类名（标签底色块 + 深字 #0d0c0a）
title   = 课程名（Georgia serif，自适应字号，最多 2 行）
teacher · platform = 底部脚注（13px #cbbfb0）
initial = 课程名首字符（右下 220px 装饰大字，opacity .10）
```
