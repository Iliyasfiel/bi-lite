# AGENTS.md —— bi-lite 开发规约

> 本文件是所有 AI 编码代理（DSH / OpenCode / Claude Code / Codex / Cursor 等）在本仓库工作的
> **唯一入口规约**。人也适用：工程纪律对人与代理一视同仁。
> 工具侧指针（`CLAUDE.md`、`.cursor/rules/`）如存在，均指向本文件，勿另立副本。

## 0. 一分钟认知

bi-lite = **「长表 → 口径规格 → 多形态产出」的引擎**。

**它不是 BI 看板。** 保送填表（把财务数据按不同给定表格形式填成 Excel 报送）是主战场，
看板是副产品。核心抽象只有一个：`spec`（声明式口径规格），Excel 与图表都是它的 renderer。
详见 `docs/需求与架构.md` §0。

技术栈：**Node ≥ 22.6（本机 26.7.0，原生跑 `.ts`，无构建步骤）** + DuckDB（明细，进程内单文件）
+ Parquet（归档）。零外部服务、零前端框架。DuckDB 用 `@duckdb/node-api`，**版本锁死不用 `^`**（供应链风险，§3.1.2）。

**最高优先级的不变式是安全**：财务数据不得以明文进入 LLM 上下文。这不是靠过滤实现，
是靠架构（agent 无 SQL 权、只产出 spec）。详见 §2 铁律 1。

## 1. 必读文档（开工前按序）

| 顺序 | 文档 | 用途 |
|---|---|---|
| 1 | `docs/需求与架构.md` | **唯一的规范文本**。§3 选型 / §4 数据模型 / §5 spec 与渲染 / §6 安全 / §7 Agent / §10 风险 / §11 落地顺序 |
| 2 | `docs/tech-research-excel-template-and-duckdb.md` | 实测原始记录（含源码行号与完整输出）。§5.3 的结论都出自这里 |
| 3 | `src/` 各文件头部注释 | 每个模块开头都指向对应章节 |

**文档即规范**（code follows docs）：实现与文档冲突 → 改代码或改文档，**不悄悄偏离**。
若改动涉及 §5.3（渲染器）或 §6（安全），先更新文档再改代码。

## 2. 铁律（违反任何一条 = 回滚，不接受"临时"例外）

1. **明细数据不出 DuckDB 进程；金额不进 LLM 上下文。**
   - agent **没有 SQL 权**。只暴露 §7.1 的五个工具，无 shell。
   - 给 agent 的预览（`planOf()`）**只含坐标与形状，不含数值**。
   - 新增任何"返回查询结果"的工具或接口前，先确认它是否会把明细值送进 LLM。
   - 参考：Lightdash/Metabase/Superset 三家都给 LLM SQL 权再加闸门，**bi-lite 是根本不给**。
     这是自觉的路线分歧，不要因为"别人都这么做"而改。
2. **维度白名单是唯一 SQL 入口。** `spec/compile.ts` 的 `DIMENSIONS` 是唯一的维度注册表。
   `rows.dim` / `cols.dim` 必须过 `isRegisteredDim()`，**未注册直接抛错**。
   不要在别处拼接用户可控的表名或列名。过滤字段名须匹配 `/^[a-z_][a-z0-9_]*$/i`，
   字符串字面量一律走 `q()` 转义。
3. **模板优先，绝不覆盖模板的既有格式。** 见 §5.3.4 坑 7 与 §4 环境备忘。
   模板已显式设过的数字格式、样式、合并、公式、批注、图表，一律不动。
   只往数据格写值。
4. **`cell.style(...)` 是写路径，不是读路径。** 任何"读取单元格样式"的需求都必须走
   `readNumberFormat()`（`src/render/excel.ts`）。理由见 §4 环境备忘第 2 条。
5. **口径是列不是行。** `fact_finance.period_type` 是列。新增口径 = 注册进
   `src/db/schema.ts` 的 `PERIOD_TYPES`，不是新增表或新增列。
6. **账面累计必须实存，不得从单月派生。** 它含审计调整，累加不等。
   `PERIOD_TYPES` 里 `derivable: false` 的项都不许在代码里"顺手算出来"。
7. **导入链路的每一行都不经过 LLM。** `src/import/` 下任何代码不得引用 LLM/MCP 相关模块。
8. **运营指标独立成表**，共享 `dim_company` / `dim_period`，**不要塞进 `fact_finance`**：
   量纲、频率、口径体系都不同（Kimball 星型）。
   现有 `fact_contract`（已建表）；后续的 `fact_business_line` **尚未建**，加运营指标时新建表，别扩 `fact_finance`。
9. **数据文件不入库。** `data/` 下是真实财务数据，**永不提交、永不进 prompt、永不贴进 issue**。

## 3. 常用命令

```bash
npm run fixtures   # 生成测试假数据（模板 + 960 行长表）到 test/fixtures/
npm run e2e        # ★ 全链路验收，39 项断言，唯一的门禁
npm run bench      # ⚠️ 未实现（test/bench.ts 尚不存在）
npm start          # ⚠️ 未实现（src/server.ts 尚不存在，见 §6）
```

- **`npm run e2e` 必须全绿才可提交。** 断言覆盖：导入 → spec 编译 → 查询 → 渲染 → 版式保真 →
  读回 → 换口径出第二张表 → 安全边界。
- `test/fixtures/` 与 `test/output/` 是**生成物**，可随时删了重跑 `npm run fixtures`。
- 验收脚本会 **`rm -rf data/bi.duckdb`**（每次从空库跑）。别拿它对着真实数据库跑。

## 4. 环境备忘（本机已知坑，都已实测）

1. **npm 全局缓存含 root 属主文件 → 一律 EPERM。** 所有 npm 命令加 `--cache /tmp/npm-cache-$$`。
   **不要 `sudo chown`**（会污染用户全局环境）。
2. **`xlsx-populate` 的两个 API 陷阱**（都是实测踩出来的，见 §5.3.3 / §5.3.4）：
   - `Sheet.cell()` **只接受** `"B4"` 或 `(row, col)`。传定义名称会崩在 `addressConverter`（`Sheet.js:123`）。
     定义名称要用 **`Workbook.definedName(name)`**，它返回的是**已解析好的 Cell 对象**（不是地址字符串），
     可直接 `rowNumber()` / `columnNumber()`；名称不存在时返回 `undefined`（不抛错）。
   - **`cell.style('numberFormat')` 这个"读"操作有副作用** —— 内部走 `styleSheet().createStyle()`，
     会向 `styles.xml` **追加**整套 font/fill/border/xf。实测仅"读"20 格就把
     `styles.xml` 从 **2839B 涨到 7947B**、fonts **4→24**、cellXfs **8→28**。
     正确做法见 `readNumberFormat()`：直接读 `styleSheet()._cellXfsNode.children[cell._styleId].attributes.numFmtId`，
     再 `getNumberFormatCode(id)`。
3. **Node 原生跑 `.ts` 需要 `package.json` 有 `"type": "module"`**，否则报
   `SyntaxError: Cannot use import statement outside a module`。
   **导入 `.ts` 模块时必须带扩展名**（`from '../db/index.ts'`），这是 Node 原生 TS 的解析规则。
4. **`@duckdb/node-api` 的取数 API**：`conn.run()` 返回的 `DuckDBMaterializedResult`
   **只有 `getChunk(i)`，没有 `getRows()`** → 取数必须用 `runAndRead*`。
   `JSON.stringify(reader.getRows())` 会因 BigInt 抛 `TypeError` → 用 `getRowsJson()` / `getRowObjectsJson()`。
   ⚠️ **`getRowObjectsJson()` 返回的已经是解析好的数组，不是 JSON 字符串** —— 再 `JSON.parse()` 会在空结果时
   报 `SyntaxError: Unexpected end of JSON input`。
5. **DuckDB 单写者锁**：有跨进程写者时，其它进程**连 `READ_ONLY` 都拿不到锁**。
   当前设计规避了这点：**单进程独占一个 `.duckdb` 文件**，导入与查询用同进程内的两个连接（MVCC 让读不被写阻塞）。
   导入频率是每月几次，故不需要更复杂的方案。**不要引入第二个进程去开这个库。**
6. **`exceljs` 只能用于生成测试 fixture**（`devDependencies`）。
   **生产路径禁用**：对含批注/图表/图片的真实模板 `readFile` 即崩，写出还会静默删 8/9 类部件（§5.3.1）。
   另外它 `addConditionalFormatting` 用 `type: 'dataBar'` 会崩，测试里用 `cellIs`。

## 5. 架构地图

```
src/
  db/
    schema.ts      DDL（四维表 + 事实表 + 批次表）+ PERIOD_TYPES 口径注册表
    index.ts       open() / writer() / reader() / query() / execute()
                   —— 单进程双连接；query() 已处理 BigInt 与 JSON 解析
  import/
    longtable.ts   长表解析 + stage()（STAGED 校验，不写库）+ commit() + archiveParquet()
                   三态：STAGED → SYNCING → READY / ERROR
  spec/
    types.ts       Spec 类型 + parseSpec()（YAML → 校验过的 Spec）+ SpecError
    compile.ts     ★ DIMENSIONS 白名单 + compileBlock() → 参数化 SQL
                   + runCompiled() + planOf()（给 agent 的坐标预览，不含金额）
  render/
    excel.ts       ★ renderTemplate()：xlsx-populate 模板填充
                   + readNumberFormat()（纯只读，勿改成 cell.style()）
                   + 兜底：setNumericCellXml / setTextCellXml（JSZip + 定向 XML）
                   + quoteFormulas()（公式注入防护）
specs/             口径规格 YAML（如 月度保送表.yaml）
templates/         原始报送模板（人工制作，不修改）
data/              ⚠️ 真实财务数据，永不提交
```

**数据流**：Excel 长表 →（`import/`，不经 LLM）→ DuckDB →（`spec/` 编译成 SQL，本地执行）
→ 结果矩阵 →（`render/`）→ 报送 Excel。
**agent 只参与产出 spec，从不接触数值。**

## 6. 落地顺序与当前进度

按 `docs/需求与架构.md` §11，**顺序很重要**：规格引擎（第 3 步）必须先于 agent 入口（第 4 步）。
规格引擎是人的工具，agent 只是它的快捷输入方式。**反过来做会得到一个花哨但不准的东西。**

| 阶段 | 状态 |
|---|---|
| 1. 导入闭环 | ✅ 已完成（验收：960 行/350ms，12 月 × 4 公司 × 5 指标 × 4 口径） |
| 2. 语义层 + 查询 | ⬜ 未开始 —— `query_metrics` 自由查询 + Web 看板 |
| 3. 规格引擎 | 🟡 Excel 渲染器 ✅；ECharts 渲染器（同一 spec 的第二个 renderer）⬜ |
| 4. agent 入口 | ⬜ 未开始 —— MCP 五个工具 + 模板/自然语言 → spec |

**下一步**：第 2 步（它是第 4 步的前提 —— 没有注册维度就没有可下推的查询）。

## 7. 测试纪律

- **当前只有假数据。** 用户明确指示：*「测试都用假数据测，生产环境会有不同的数据导入格式，先跑通」*。
  因此：**不要为了让某个断言过关而把导入层写死成假数据的列名。**
- **导入层必须对格式差异宽容**，这是 R1（主数据对齐）的核心。当前 `readLongTable()` 已支持
  表头别名（`财务期/月份/期间/fin_month` 等）与多种月份写法（`2026-06` / `2026/6` / `2026年6月` / `Date`），
  **但这是它最容易翻车的地方** —— 真实集团导出的列名、口径写法很可能超出这份别名表。
  新增别名时**同时考虑**：公司名/指标名的别名（`dim_company.alias` / `dim_metric.alias` 已在用）。
- **未识别的主数据必须报给人确认，不得静默自动建维。** `stage()` 输出的
  `unknownCompanies` / `unknownMetrics` / `unknownPeriodTypes` 是给人看的；
  自动建维（`commit({autoCreateDims: true})`）只是让链路能跑通的过渡行为。
  **不做主数据对齐，三个月后数据全是孤儿行。**
- 新增校验规则 → 加到 `stage()` 的 `issues`，并同步加进 `test/e2e.ts` 第 2 阶段。
- 安全相关的断言（第 9 阶段）**只许增加，不许删除**。
- 版式保真的断言（第 6 阶段）包含 **styles.xml 防膨胀** 四项 —— 这是铁律 4 的回归防线。

## 8. 范围管控（防范围蔓延）

`docs/需求与架构.md` §2.3 Non-goals 是"说不"的书面依据：

- ❌ 不做复杂图表编辑器 —— 让 Office / Univer 承担最后 10% 的精细排版
- ❌ 不做定时调度、多租户、外部数仓对接
- ❌ **不给 agent 自主执行 SQL 的能力**（铁律 1）
- ❌ 不引入构建步骤（Node 原生跑 TS 是有意选择，符合"轻量化"）
- ❌ 不引入 `exceljs` 到生产路径（§5.3.1 已实测排除）

诱惑来时先查这张表。
