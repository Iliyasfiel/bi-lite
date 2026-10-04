# bi-lite

> **开源、轻量的本地 BI 引擎**：一份 Excel 加一份 YAML 规格，就地建库、按模板出表。
> 把「从快报 Excel 手工抄到报送表」这件事，变成一条声明式流水线。

**两个方向**：Excel →（**接入规格**）→ 本地 DuckDB 星型库 →（**报表规格**）→ 按模板渲染的报送 Excel / 图表。
**三个入口**：**MCP + skill**（agent 与你对话，把模糊模板敲成规格）、**Web**（浏览器三个页签）、
**CLI**（`bilite`，给人与脚本：`ingest lint|dry-run|run` · `render` · `query` · `catalog dump|show` ·
`compact` · **`plan` / `apply` / `rebuild`** · `validate` · `skill export`；数据走 stdout、日志走 stderr，退出码即结论）。

财务数据**不以明文进入 LLM 上下文**——这不是靠过滤，是靠架构：agent 根本没有 SQL 权限，
它只能产出**规格（spec）**，数值第一次出现是在你自己的浏览器里。

---

## 它解决什么问题

集团每月从平台导出 Excel，**组织形式各异**：有的是长表（财务期 × 公司 × 指标 × 口径 × 金额），
有的是宽表（一行一公司、口径铺在列上），子公司报表又是另一种版式。
然后都要按**不同给定的表格形式**抄成报送 Excel。人工抄写有两个病根：

| 痛点 | 表现 | bi-lite 的解法 |
|---|---|---|
| 源表形态各异 | 长表/宽表/子公司报表，列名行列都不一样 | **接入规格**声明"这份 Excel 怎么读"（坐标 + 维度映射），任意形态收敛到同一份星型库 |
| 人工抄写易错 | 几十个格子对不上，差额靠肉眼找 | 报表规格编译成 SQL 由引擎算，人只看结果 |
| 口径经常更换 | Excel 超链接/公式救不了 | 数据与排版分离，换口径只改规格一行 |
| 财务数据敏感 | 不敢让 AI 碰 | agent 无 SQL 权，只产出规格（见下） |

**收敛点**：在当前 BI 的统计视角下，财务数据、合同金额等最终都收敛到
**财务期 × 公司 × 指标 × 口径 × 金额** 五维（`fact_finance` 的粒度；
运营指标如业务线是同构的另一张表，见下）。引擎不为某种具体模板写死 ——
长表、宽表、子公司报表只是**同一组坐标的不同摆法**，接入规格负责把摆法讲清楚。

**核心抽象只有一个**：`spec` —— 声明式规格。**接入规格**说"这份 Excel 怎么读"，
**报表规格**说"这张表按什么口径算、填进哪张模板"（"透视表的声明式版本"）。
Excel 和图表都是它的渲染器，不是两个功能。

---

## 快速开始

```bash
node --version          # 需要 ≥ 22.6（本项目用 Node 原生跑 .ts，无构建步骤）
npm install

npm run fixtures        # 生成测试假数据（模板 + 长表/宽表/对齐场景等接入夹具）
npm run e2e             # ★ 506 项断言全流程验收（唯一的门禁）
npm start               # 打开 http://127.0.0.1:4319
```

浏览器三个页签：**数据导入** → **看板查询** → **报表报送**。

---

## 一条数据是怎么走完全程的

```
任意形状的源 Excel（长表 / 宽表 / 子公司报表）
      │  ① 接入规格声明"怎么读"（Web 上传，本地校验，不经 LLM）
      ▼
   DuckDB 星型库（唯一可信源：财务期 × 公司 × 指标 × 口径 × 金额）──┐
      │                  │ 每批归档一份 Parquet
      │  ② 语义层查询     ▼
      │             data/parquet/fact_finance/batch=*/
      │  ③ 报表规格编译成参数化 SQL，在 DuckDB 内执行
      ▼
  结果矩阵
      │
      ├─④ Excel 渲染器 → 报送 Excel（打开原模板只填数据格，版式全保）
      └─④ 图表渲染器   → ECharts option → 看板
```

> 同构的第二张表：运营指标（合同、业务线）走同一条路，只是目标表不同
> （`target: fact_business_line`，无口径列 —— 运营指标没有财务那套口径体系）。

### 导入

源 Excel 可以是**任意形态** —— 长表（坐标全在列里，每行自带期数）或宽表
（公司/指标在行上，期数整块相同、口径铺在列上）。差别只在接入规格的写法，
落库的目标是同一份五维星型库：

```yaml
# 长表：四个坐标全在列里（期数逐行不同）
rows: [{ col: B, dim: company }, { col: C, dim: metric }, { col: D, dim: period_type }]
keys: [{ col: A, as: period }]
values: { columns: [E] }

# 宽表：公司/指标在行上，期数整块相同，口径铺在列上
rows: [{ col: A, dim: company }, { col: C, dim: metric }]
keys: [{ col: B, as: period }]
values: { columns: [D, E], periodTypes: [本年累计, 单月] }  # 口径由列的位置决定
```

先上传源文件，再干跑（**不写库**）、确认无误后落库：

```bash
# 1. 上传源文件（只落盘，不解析不落库）
curl -X POST http://127.0.0.1:4319/api/ingest/upload \
  -H "x-filename: $(python3 -c 'import urllib.parse;print(urllib.parse.quote("集团导出长表.xlsx"))')" \
  --data-binary @test/fixtures/集团导出长表.xlsx

# 2. 干跑：只回形状与主数据判定，一次库都不写
curl -s -X POST http://127.0.0.1:4319/api/ingest/dry-run \
  -H 'content-type: application/json' \
  -d '{"yaml":"id: 试跑\nsource: test/fixtures/集团导出长表.xlsx\nsheets: []"}'

# 3. 落库（Web 向导同理，只是走浏览器点按钮）
```

> 上传不用 multipart（省依赖）：原始二进制 body + `X-Filename` 头。

### 主数据对齐：同一个公司，每月写法不同

源表里，「华东子公司」这个月可能写成 `（华东子公司）`，下个月写成 `华东分公司`。
如果每个写法都新建一条主数据，**同一家公司的钱就被拆到了两条主数据上** ——
报表出来少了一半，但格式完全正常。

匹配分两档，分界线是**"这个差异是不是只是格式噪音"**：

| 档 | 判据 | 处理 |
|---|---|---|
| **Tier 1** 自动 | `normalizeName()` 后完全相同（全角/空格/括号/大小写） | 直接归并，并在校验提示里**留痕**（"已自动归并 2 个写法"） |
| **Tier 2** 需确认 | 去壳后字号相同 / 名称互相包含 / 写法相近 | 只给**候选 + 判断依据**，由人拍板 |

```bash
# 看看这批名字里哪些需要人决定（干跑，一次库都不写）
curl -s -X POST http://127.0.0.1:4319/api/ingest/dry-run \
  -H 'content-type: application/json' \
  -d '{"yaml":"...接入规格 YAML..."}'
# → needsDecision：[{ kind: company, raw: 华东分公司, candidates: [...] }]

# 人确认一次，永久记住（手工登记一条别名；目标必须真实存在）
curl -s -X POST http://127.0.0.1:4319/api/aliases \
  -H 'content-type: application/json' \
  -d '{"kind":"company","raw":"华东分公司","targetId":"c_xxx","note":"2026-06 起改名"}'

# 落库时把决定带上：POST /api/ingest/run { yaml, decisions: [{ kind, raw, action: "merge", targetId }] }
```

**为什么不是"按相似度自动合并"**：不合并时数字明显不对（少了一半），人会来查；
**错合并时两家的钱被静默加在一起，报表看起来完全正常，没人会来查**。
所以宁可停下问人。有歧义时落库返回 **HTTP 200 + `needsDecision`**（待确认清单），一行都不落库 ——
那是待办，不是失败；Web 导入页会把待确认的名字渲染成卡片，选「并入已有」或「确认是新建」。

### 写一条报送规格

`specs/月度保送表.yaml`：

```yaml
id: 集团月度保送表
title: 集团经营月报
template: test/fixtures/月度保送表.xlsx    # 版式来源：人工做好的空模板

params:
  year: 2026
  month: 6

sheets:
  - name: 主要指标
    blocks:
      - anchor: { name: DATA_START }       # ★ 用定义名称，模板改版式时跟着走
        rows:
          dim: metric
          order: [营业收入, 利润总额, 营业成本, 净利润, 期间费用]
        cols:
          dim: period_type                 # ← 换口径只改这一行
          order: [本年累计, 去年同期累计, 单月, 账面累计]
        value:
          measure: amount
          agg: sum
          format: "#,##0.00"               # 同时管 Excel 单元格格式与看板显示
        scope:                             # ★ 必须写！见下方"静默算错"
          time:
            year: "{{year}}"
            month: "{{month}}"
```

**换一种表格口径**，就是把 `rows.dim` 换成 `company`、`cols.order` 砍成两列——
数据与版式都不用重抄。

> ### ⚠️ 静默算错：`params` 声明了就必须用
>
> `scope.time` 不是可选的。少了它，spec 编译出的 SQL 里**没有任何时间条件** ——
> 一张写着"2026 年 6 月"的月报会把**12 个月全加总**，而数字看起来完全合理
> （实测 B4 = 765345，真值 66826）。最险的是这个错数字还被写进了 e2e 断言，
> 测试不但没抓住 bug，反而成了 bug 的守卫。
>
> 所以 `parseSpec()` 会硬校验：**`params` 里声明的每个键都必须被 `{{key}}` 引用过**，
> 否则解析直接报错。Web 保存 spec 时也走同一道校验。

### 从模板自动生成规格

不必手写上面那段 YAML。上传一个人工做好的空模板，系统会推断出草稿：

- **Web**：「报表报送」页 → 上传 `.xlsx` → 看到每个轴的来源与判断依据 → 核对后保存
- **MCP**：agent 调 `generate_spec`，拿到同样的草稿

推断结果是**提案**，不是决策。每个轴都标注来源：

| 标记 | 含义 |
|---|---|
| **读到的** | 模板里真的写了（如 B4 左方一列预置了 5 个指标名） |
| **猜的** | 从角格「公司」对照注册表推出，模板里没有预置行清单 |

模板里的「合计」公式行会被自动排除（保留原样、不写入），
推断出的 spec 固定带上 `scope.time`，让上面那个"静默算错"默认不发生。
如果模板里**根本没有指标信息**（比如只有「公司 × 本年累计」的板块表），
推断器会**直接说"这张表我推不出来"**并给出 error，草稿无法保存 ——
它不会注入一个占位指标让 spec "看起来合法"。

### 用一句话写规格（§7.2 路径 2）

「按板块对比今年和去年的利润总额」→ agent 产出 spec 草稿 → 你确认。

这条路**不是靠提示词**实现的，而是靠让 spec 语言本身**在解析期就挡住欠约束**。
因为实测确认过：只要语言允许欠约束的写法，写的人（无论人还是 agent）迟早会写出来。

最典型的一种：**不写指标约束**。

```yaml
rows: { dim: company, order: [华东子公司] }
cols: { dim: period_type, order: [本年累计] }
value: { measure: amount, agg: sum }     # ← 没说要哪个指标
```

这段 YAML 语法完全合法，跑出来的数字也"正常"，但它把**五个指标的金额加成了一个数**
（实测 67283，真值 65198）。同量级、格式正常、人不会怀疑它 —— 这就是最危险的那种错误。
现在它会被**解析即拒绝**：

```
这个 block 没有任何指标约束：行和列分别是 company / period_type，
这会把多个指标的金额**加成一个数**。
  → 把这个 block 的指标钉死。两种改法：
     ① 把指标做成轴（rows: { dim: metric, order: [营业收入, 利润总额] }）；
     ② 用 scope.filter 指定单一指标（scope: { filter: { metric: { name: 营业收入 } } }）
```

**为什么是"拒绝"而不是"警告"**：财务场景下**静默算错比拒绝出表危险得多** ——
错数字同量级、格式正常，人不会怀疑；表出不来，人一定会来查。

配套的三处入口用的是**同一套判据**（`lintSpec`，写在 `src/spec/lint.ts`）：

| 入口 | 用途 |
|---|---|
| `lint_spec`（MCP 工具） | agent 写草稿后**自己先撞一次墙**，按 issues 修完再交给人 |
| `POST /api/specs/lint` | 诊断接口，一次返回**全部**问题（不是只报第一条） |
| Web 草稿框 | **边打字边诊断**，有问题时保存按钮直接置灰 |

派生表达式（`value.expr`）也会真的参与计算 —— 例如"同比"可以直接写成
`(本年累计 - 去年同期累计) / 去年同期累计`，求值走的是手写求值器而不是 `eval`。

### 渲染

```bash
# 预览：只回坐标与形状（B4:E8，20 个格子），不含金额
curl -s -X POST http://127.0.0.1:4319/api/report/preview \
  -H 'content-type: application/json' \
  -d '{"specFile":"specs/月度保送表.yaml","params":{"year":2026,"month":6}}'

# 导出：打开模板只填数据格
curl -s -X POST http://127.0.0.1:4319/api/report/render \
  -H 'content-type: application/json' \
  -d '{"specFile":"specs/月度保送表.yaml","params":{"year":2026,"month":6}}'
```

产出的 Excel **保留模板的一切**：样式、合并单元格、公式、条件格式、数据验证、
冻结窗格、批注、图表、图片。实测 18 个 zip 部件零丢失。

---

## 安全设计：为什么财务数据进不了 LLM

四层防护，逐层收紧：

| 层 | 手段 |
|---|---|
| ① 能力边界 | agent **没有 SQL 权**，只暴露 12 个 MCP 工具，无 shell |
| ② 给坐标不给数值 | `preview_spec` 返回 `B4:E8 将填 5 行 × 4 列`，看不到任何金额 |
| ③ 查询下推 | spec 在服务端编译成参数化 SQL，在 DuckDB 内执行；维度只能来自白名单 |
| ④ 分档 + 审计 | agent 视角的金额返 `12.3亿` 而非精确值，每格须 ≥3 行明细支撑；字段级审计 |

**关键推论**：改口径只需要 spec 的文本 diff，**不需要任何数值参与**。
所以"财务数据不进上下文"是架构上自然达成的，而不是靠事后过滤。

### MCP 工具集（仅此十二个）

| 工具 | 作用 | 返回数值？ |
|---|---|---|
| `list_metrics` | 列出已注册指标/维度/口径/公司 | 否 |
| `get_template_schema` | 解析模板结构（锚点、表头、行标签、合并区） | 否（模板里的数字也不回传） |
| `lint_spec` | **静态诊断**：欠约束/表达式/join 等结构问题 | 否（只读 spec 文本，**不查库**） |
| `preview_spec` | 返回将填充的坐标网格 | **否，且本工具不查库** |
| `render_report` | 渲染 Excel，返回文件路径 | 否（只回路径与计数） |
| `diff_report` | 比较两版 spec 的差异 | 否 |
| `generate_spec` | 从模板推断 spec 草稿（区分"读到的"与"猜的"） | 否（**不查库**，只读模板结构） |
| `look_at_source` | 看源 Excel 的文本视图（表头/行标签/哪些格是数字） | 否（数字格只回 `{num:true}`） |
| `lint_ingest` | **静态诊断**接入规格（源 Excel → 星型表的映射） | 否（不读源文件、**不查库**） |
| `dry_run_ingest` | 干跑：形状 + 主数据判定，一次库都不写 | 否 |
| `run_ingest` | 按接入规格真正落库（有歧义整批拒绝、一行不写） | 否 |
| `get_catalog` | 库里现在有什么：L1 成员 / L2 结构 / L3 版本（按需下钻） | 否 |

前七个是**报表侧**（spec → Excel/图表），后五个是**接入侧与现状**（源 Excel → 星型表、库里有什么）。

另有一道**机械兜底**：任何工具返回值里若出现 ≥ 10000 的数字，本次调用直接失败。
它不替代上面的结构设计，只是让"将来某次改动不小心泄漏"变成一个响亮的错误。

**主数据归并（`/api/aliases`）刻意不做成 MCP 工具**：它是一次**不可逆的写操作**，
登记后永久生效。合并两家公司会把它们的钱静默加在一起，而报表看起来完全正常 ——
这种事必须由人在界面上看着依据点确认，不该成为 agent 顺手就能做的事。

### 把 MCP 接到客户端

```jsonc
// 例如 DSH / Claude Code 的 MCP 配置
{
  "mcpServers": {
    "bi-lite": {
      "command": "node",
      "args": ["/绝对路径/bi-lite/src/mcp/server.ts"],
      "cwd": "/绝对路径/bi-lite"
    }
  }
}
```

协议实现是**零依赖手写**的（约 150 行）——官方 SDK 只为 12 个工具要拉 16MB，
而实际协议面只有 4 个方法。漂移风险用 e2e 对冲：验收阶段**用真实 MCP 客户端**连本服务，
不是自打 mock。

---

## 技术选型

| 层 | 选择 | 为什么 |
|---|---|---|
| 运行时 | **Node ≥ 22.6**（原生跑 `.ts`） | 无构建步骤，符合"轻量化" |
| 明细存储 | **DuckDB** | 列存、进程内单文件、交叉聚合毫秒级 |
| 归档 | **Parquet**（每批一文件） | 备份即拷目录 |
| Excel 模板填充 | **xlsx-populate 1.21.0** | 只改 XML 节点，保真度最高 |
| 图表 | **ECharts**（从 node_modules 直供） | 离线可用，无 CDN |
| Web | **node:http + 原生 JS** | 零框架、零外部服务 |
| 测试 | **Node 原生 `node:test` 风格的自研 harness** | 506 项断言，一条命令验收 |

**版本锁死**：`@duckdb/node-api` 用 `1.5.5-r.5`（不带 `^`）——1.3.3 系列曾被投毒
（CVE-2025-59037）。

---

## 项目结构

```
src/
  cli.ts             命令行入口（与 Web / MCP 同构的薄壳；数据走 stdout、日志走 stderr）
  gen/               ★ 生成器：models/*.yml → IR → plan / apply / rebuild（业务表的 DDL 由声明长出来）
  paths.ts           ★ 源文件路径白名单（唯一实现 —— 它是安全判据，不许再写一份）
  db/schema.ts       DDL（四维表 + 事实表 + 批次表 + raw 着陆表 + 列契约表）+ 口径注册表
  db/index.ts        open / query / execute / exportParquet（单进程双连接）
  land/              ★ 着陆层：源文件 → raw（append-only，可重放的唯一依据）+ 还成可读工作簿
  ingest/            ★ 接入层：接入规格 YAML + 源 Excel → 星型表（两阶段落库 / 主数据两档归并）
  meta/              列契约与 catalog（物理层向语义层 / agent 自省）
  spec/types.ts      spec 类型与校验 + diagnoseSpec()（一次给全所有问题）
  spec/dims.ts       ★ 维度角色表（量纲维 / 筛选维），DIMENSIONS 的单一来源
  spec/expr.ts       ★ 派生表达式求值器（手写，不是 eval）
  spec/lint.ts       ★ 结构诊断的唯一判据（欠约束 / expr / join / order / 口径名）
  spec/compile.ts    ★ 维度白名单 + spec → 参数化 SQL + runCompiled + planOf
  spec/template.ts   模板结构读取（表头/行标签/合并区/定义名称/公式行）
  spec/infer.ts      ★ 模板 → spec 草稿（带 source/evidence，猜的要人确认）
  semantic/query.ts  ★ 唯一的自由查询出口 + 受众分级 + 反推防护
  render/excel.ts    ★ xlsx-populate 模板填充（保版式）
  render/chart.ts    ★ 同一 spec → ECharts option / 形状描述
  skill/export.ts    ★ 手册里可对拍的那部分（从实现投影，不是抄一份）
  mcp/tools.ts       ★ 十二个 MCP 工具 + 金额兜底 + 审计
  mcp/server.ts      零依赖 MCP stdio 服务端
  server.ts          零框架本地 Web 服务
  web/               三个页签的前端（原生 JS）
models/              ★ 业务表（dim_* / fact_*）的**声明** —— 它们不再手写 DDL：`bilite plan` → `bilite apply`
specs/               口径规格 YAML
ingest/              接入规格 YAML（源文件路径必须指向 data/ 下的稳定位置）
templates/           原始报送模板（人工制作，不修改）
docs/                需求与架构（规范文本）+ 实测调研报告 + 开发计划
data/                ⚠️ 真实财务数据，永不提交
```

---

## 命令

```bash
npm run fixtures   # 生成测试假数据到 test/fixtures/
npm run e2e        # ★ 唯一门禁，506 项断言
npm start          # 本地 Web 服务（默认 http://127.0.0.1:4319）
```

> `npm run e2e` 会清空 `data/bi.duckdb` 重跑。**别拿它对着真实数据库跑。**

> **CLI**（三个入口里的第三个，给人与脚本）：`npm link` 之后直接用 `bilite`，或 `node src/cli.ts`。
> `bilite --help` 看全部命令。数据走 stdout、日志与进度走 stderr，退出码 **0 跑通 / 1 被拒 / 2 用法错误**
> （"需要人拍板"算跑通，不算失败）。

---

## 当前进度

| 阶段 | 状态 |
|---|---|
| 1. 导入闭环 | ✅ 服务端 + Web 导入向导 + Parquet 归档 |
| 2. 语义层 + 查询 | ✅ 受众分级 / 反推防护 / 注入防护 + Web 看板 |
| 3. 规格引擎 | ✅ Excel + ECharts 两个渲染器 + Web 报表预览导出 |
| 4. agent 入口 | ✅ MCP 十二工具（真实 MCP 客户端验收通过） |
| 5. 模板 → spec | ✅ 上传模板自动出 spec 草稿（Web + `generate_spec`） |
| R1. 主数据对齐 | ✅ 两档归并（Tier 1 自动 / Tier 2 人拍板）+ `dim_alias` 表 + Web 待确认卡片 |
| §7.2 路径 2 | ✅ 自然语言 → spec：靠"spec 语言挡住欠约束"实现（`lint_spec` + 边打字边诊断） |
| CLI 入口 | ✅ `ingest lint/dry-run/run` · `render` · `query` · `catalog dump/show` · `compact` · `plan` / `apply` / `rebuild` · `validate` · `skill export` |
| 聚合表 | ✅ `kind: aggregate`：列由跨表投影、`CREATE OR REPLACE` 全量重算（删了能回来）、落库同事务重建 |
| 桥接层 | ✅ `kind: bridge` + 声明行 `rows:`：`bilite rebuild` 全量对齐、权重和 =1、聚合 `via:` 加权摊分（守恒对拍） |
| 维度版本行（SCD2） | ✅ 历史挂侧表 `dim_*_hist`；`dimAsOf` 时点查询；**当前态查询零回归** |

### 已知限制

- **只有假数据在跑**。生产环境的源表形态会有差异 —— 但差异只在"摆法"，
  不在"收敛点"：接入规格声明坐标映射，未识别的主数据会列进 `runIngest()` 的
  `needsDecision` 待确认清单，需要人工确认，不会静默建维。
- **别名只增不减**：`dim_alias` 里的映射一旦登记就永久生效（人确认过一次，下月自动命中）。
  目前没有 Web 上的撤销入口，改错了要去 `GET /api/aliases` 看清单。
  这也是落库分两阶段（先判定、再写库）的原因 —— 宁可整体不落库，也不留下半成品别名。
- **`data/uploads/` 只增不减是有意的**：上传件是接入规格 `source:` 可以直接指向的源文件，
  删掉它那条规格立刻变成死路径（而且没有任何提示）。清理是人工动作，两条判据见 `AGENTS.md` §7。
- **业务表由 `models/*.yml` 声明长出来**（`bilite plan` 看 diff、`bilite apply` 落地）——
  `fact_business_line`（运营指标，**没有口径列**）与 `fact_contract` 都在其中，不再是手写 DDL；
  聚合表（`kind: aggregate`）同理，声明 source/grain/measures，列由投影、`bilite rebuild` 全量重算；
  小维表与桥接表（`kind: bridge`）的行也写在声明里（`rows:`），`bilite rebuild` 全量对齐。
- **公式缓存值不写回**：xlsx-populate 不重算公式。下游若直接读公式列数值，
  Excel 打开时会自动重算，但程序化读取需要另做处理。
- **重打包后有 10/18 个部件字节不等**（属性顺序、转义、空白等良性差异）。
  功能元素无一丢失，但对**有电子签章 / 哈希校验**的下游是风险。

---

## 文档

- [`docs/需求与架构.md`](docs/需求与架构.md) —— **唯一的规范文本**（需求、数据模型、spec 语言、安全设计、风险、落地顺序）
- [`docs/tech-research-excel-template-and-duckdb.md`](docs/tech-research-excel-template-and-duckdb.md) —— Excel 保真与 DuckDB 的实测原始记录
- [`AGENTS.md`](AGENTS.md) —— 给 AI 编码代理的开发规约（19 条铁律）
- [`skills/bi-lite-ingest/AGENT-PROMPT.md`](skills/bi-lite-ingest/AGENT-PROMPT.md) —— **给 agent 的接线与 system prompt**（MCP 配置 + 行为纪律）

## License

Apache-2.0
