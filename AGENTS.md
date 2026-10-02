# AGENTS.md —— bi-lite 开发规约

> 本文件是所有 AI 编码代理（DSH / OpenCode / Claude Code / Codex / Cursor 等）在本仓库工作的
> **唯一入口规约**。人也适用：工程纪律对人与代理一视同仁。
> 工具侧指针（`CLAUDE.md`、`.cursor/rules/`）如存在，均指向本文件，勿另立副本。

## 0. 一分钟认知

bi-lite = **开源、轻量的本地 BI 引擎**：一份 Excel 加一份 YAML 规格 → 本地 DuckDB 星型库 → 按模板出表。
三个入口共用同一套引擎（**CLI 的引擎侧命令已落地** —— 生成器侧与物料侧按阶段挂上，见 `docs/开发计划.md` §7）：**MCP + skill** 给 agent，**Web** 给人，**CLI** 给人与脚本。

**它不是 BI 看板。** 保送填表（把财务数据按不同给定表格形式填成 Excel 报送）是主战场，
看板是副产品。核心抽象只有一个：`spec`（声明式规格 YAML）—— **接入规格**说"这份 Excel 怎么读"，
**报表规格**说"这张表按什么口径算、填进哪张模板"；Excel 与图表都是它的 renderer。
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
| 4 | `skills/bi-lite-ingest/SKILL.md` | **给 agent 的操作手册**：接入规格/报表规格的字段、五步流程、lint 与 dry-run 的分工、**不要向用户索要金额** |

**文档即规范**（code follows docs）：实现与文档冲突 → 改代码或改文档，**不悄悄偏离**。
若改动涉及 §5.3（渲染器）或 §6（安全），先更新文档再改代码。

## 2. 铁律（违反任何一条 = 回滚，不接受"临时"例外）

1. **明细数据不出 DuckDB 进程；金额不进 LLM 上下文。**
   - agent **没有 SQL 权**。只暴露 §7.1 的工具（当前 12 个），无 shell。
   - 给 agent 的预览（`planOf()`）**只含坐标与形状，不含数值**。
   - 新增任何"返回查询结果"的工具或接口前，先确认它是否会把明细值送进 LLM。
   - **输入侧与输出侧是两条不同的防线**（用户 2025 定调）：引擎**不做脱敏、不管输入** ——
     它的职责是「**不往外发数据**」：`look_at_source` 对数字格只回 `{num:true}`，
     `dry_run_ingest` 与所有 `planOf()` 类响应里**永远没有金额**（e2e 有断言专门比对）。
     "别把金额贴给我"这件事写在 `skills/bi-lite-ingest/SKILL.md` 里 ——
     它是**提醒**，不是防线；用户真把金额贴进对话时，引擎能做的只有不把它再发出去。
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
7. **执行链路的每一行都不经过 LLM。** 接入规格 YAML 与报表规格 YAML **由 agent（或人）产出**，
   引擎只做**确定性执行**与**确定性拒绝**：`src/ingest/`、`src/spec/`、`src/render/` 下任何代码
   不得引用 LLM/MCP 相关模块，也不得为了"跑通"而放宽判据。
   *（原表述是「导入链路的每一行都不经过 LLM / `src/import/`」；**长表导入已退场**（2026-10-01），见 `docs/开发计划.md` §10。*
8. **运营指标独立成表**，共享 `dim_company` / `dim_period`，**不要塞进 `fact_finance`**：
   量纲、频率、口径体系都不同（Kimball 星型）。
   现有 `fact_contract` 与 `fact_business_line`（**都已建** —— 2026-10-02 起业务表由 `models/*.yml` 声明长出来）。
   `fact_business_line` 刻意**没有口径列**：运营指标没有"本年累计 / 单月 / 账面累计"这套财务口径体系，
   这正是"口径体系不同"的字面含义。加运营指标时**新建表 + 加一份声明**，别扩 `fact_finance`。
9. **数据文件不入库。** `data/` 下是真实财务数据，**永不提交、永不进 prompt、永不贴进 issue**。
10. **阈值与脱敏挂在"受众"上，不挂在查询上。** 见 §4 环境备忘第 7 条。
    `audience='human'`（Web 看板，已授权的人）返**精确值、无阈值**；
    `audience='agent'`（LLM/MCP）返**分档值 + 每格至少 3 行明细支撑**。
    反推保护的判据是**每格背后的明细行数**（`minSupport`），**不是单元格个数** ——
    按单元格个数计会让「公司 × 指标」单月网格（20 格、每格仅 1 行明细）蒙混过关。
    禁止把 `audience` 默认成 `'agent'` 之外的值绕过限制，也禁止给 agent 开精确值出口。
    **Web 入口（`src/server.ts`）固定 `audience='human'`，并无条件覆盖请求体里的 `audience` 字段**
    （e2e 有用例专门传 `agent` 验证被覆盖）。受众视角由**服务端按入口**判定，
    绝不能让前端参数决定 —— 那等于把安全边界交给能构造任意 HTTP 请求的一方。
11. **`enable_external_access=false` 是安全硬化，不能为了"归档/导出"而放开它。**
    需要写 Parquet 时走 `src/db/index.ts` 的 **`exportParquet()`** —— 它另开一个
    **短命只读实例**（`access_mode: READ_ONLY`）来跑 `COPY`，用完 `closeSync()`。
    只读实例**结构上无法改动主库**（实测 `Cannot execute statement of type "INSERT" ... in read-only mode`），
    且主实例的硬化完全不受影响（归档前后 `read_text('/etc/passwd')` 始终被拒）。
    **不要用 `allowed_directories` 来"既允许归档又保持硬化"** —— 实测它与
    `enable_external_access=false` 互斥，且**不拦截 `read_text`/`read_csv`**，不能当安全边界。
    详见 §4 备忘 9 与 `docs/需求与架构.md` §4.4.1。
12. **禁止裸 `catch {}`。** 有意容错的地方必须留下可观测痕迹（打日志 + 回传状态字段）。
    判例：Parquet 归档曾因裸 `catch {}` **静默失效多轮**而无人察觉（R13）。
    现在 `POST /api/ingest/run` 回传 `archived: boolean`，而且**写完会在同一个只读实例上读回来数一遍**
    （对不上就判失败 —— 见 §4 备忘 13），e2e 有断言守着。
13. **MCP 工具返回值必须过金额兜底；审计日志只记字段名，不记值。**
    `src/mcp/tools.ts` 的 `callTool()` 对每个返回值递归扫描，出现 **≥ `AMOUNT_TRIPWIRE`（10000）的数字**
    即判定泄漏：记审计 + 打 stderr + 返回 `内部错误：… 已拦截（安全不变量）`。
    **新增任何 MCP 工具都必须走 `callTool()`**，不得绕过。
    审计写 `data/audit/mcp.jsonl`，只记 `argKeys` / `resultKeys` / `ms` / 成败 ——
    **记值就等于把金额写进另一个明文文件**，那会让整套安全设计自我否定。
    这道兜底**不替代铁律 1 的结构性设计**（如 `preview_spec` 根本不查库）：
    它防的是"将来某次改动不小心把数值带进返回值"，作用是把**安静的泄漏**变成**响亮的报错**。
    已知局限：分档串（`12.3亿`）与真正的低额金额都过不了它 —— 所以它只是第四道防线，不是第一道。
14. **上报的数字必须按声明的 params 过滤；"静默算错"比"拒绝出表"危险得多。**
    `parseSpec()` 会检查 `params` 的每个键是否真的被 `{{key}}` 引用过（`findUnusedParams()`），
    没有引用就**解析即报错**。判例（§11.3）：`specs/月度保送表.yaml` 曾声明 `year/month` 却从不引用，
    于是"2026 年 6 月月报"静默地把 **12 个月全加总**（B4 得 765345，真值 66826）——
    数字同量级、格式正常，人不会怀疑它。更糟的是**错数字被写进了 e2e 断言**，测试反而成了 bug 的守卫。
    - 改 spec 结构时，**先确认 `scope.time` 还在**；新增会用到 `params` 的字段，记得同步
      `substitutableStrings()`（必须与 `compile.ts` 里所有 `substitute()` 调用点一致）。
    - 发现断言里的数字与独立算法（如直接 SQL）不一致时，**先怀疑断言**，别急着改代码迁就它。
15. **模板推断是"提案"，不是"决策"。** `src/spec/infer.ts` 的每个轴必须带 `source`
    （`template` = 读到的 / `guessed` = 猜的）与 `evidence`（判断依据），
    "猜的"要单独列出来给人核对。**不许把猜出来的东西标成读到的** —— 那会让人失去核对的机会。
    判维要求**全部标签命中**某维度，不许"半数像就算"。
    公式行必须**先排除、再判维**（首版顺序反了，导致「合计」行的标签被送去匹配指标表而失败）。
16. **主数据归并分两档；不确定就停下问人，绝不"按相似度自动合并"。**
    立场（`src/ingest/resolve.ts` 头部）：**合并两家公司比不合并危险得多** ——
    不合并时数字明显不对（少了一半），人会来查；错合并时两家的钱被静默加在一起，
    **报表看起来完全正常，没人会来查**。因此：
    - **Tier 1 自动**：仅 `normalizeName()` 后完全相同（全角/空白/括号/大小写 = **格式噪音**），
      且自动归并必须在 `issues` 里**留痕**（否则「我的公司名怎么不见了」会变成无从排查的疑问）。
    - **Tier 2 需确认**：去壳字号相同 / 互相包含 / 编辑距离相近 —— **只给候选，由人拍板**；
      候选必须带 `why`（判断依据），**不给人看依据的推荐等于猜**。
    - **落库必须分两阶段**（`runIngest` 的 `planOnly` 干跑 / 正式落库）：`registerAlias()` 写的别名
      **永久生效且无干净撤销办法**，所以阶段 1（干跑）**一次库都不写**，有歧义就整体返回
      `needsDecision`、一行都不落。
      *（可行的关键：新建维度的 id 是 `hash(raw)` 的纯函数，无需写库即可算出。）*
    - 阶段 2 顺序：**先建维度、再登记别名**（别名可指向本批同时新建的实体），
      且登记前校验目标存在 —— 否则会造出**指向虚空却从此自动命中**的别名。
    - 判据细节：`stemCompany()` **不能把纯壳名剥空**（`'有限公司'` 剥成 `'有限'` 是碎片、不是字号）；
      "写法相近"**必须要求首字相同**（否则「西北子公司」vs「华东子公司」仅差 2 字、相似度 0.6 会误报），
      且**字号一旦对上就直接返回、不补弱信号**（有强信号时就不要弱信号）。
    - 有歧义时**只回 `needsDecision` 且一行都不写**（HTTP 200，不是 4xx）—— **那是待办，不是失败**。
17. **量纲维必须被钉住；欠约束的 spec 在解析期就拒绝，不许"先出数再看"。**
    `metric` 与 `period_type` 是**量纲维**（决定"这个数是什么"）；公司/月份/年份是**筛选维**
    （只是"哪些数加进来"）。前两者必须有约束，否则多个指标的金额会被**加成一个数**。
    判例（§7.2.1）：`rows: company / cols: period_type` 无指标约束时，那一格返回 **67283**，
    真值 **65198** —— 同量级、格式正常、人不会怀疑。
    - 规则只有一份：`src/spec/lint.ts` 的 `lintSpec()`。`parseSpec()`、`lint_spec` 工具、
      `/api/specs/lint`、Web 诊断面板**全部**调它。**禁止另写一份判据** ——
      两份判据会漂移，表现为"工具说没问题、保存却被拒"，这是最难查的那类 bug。
      e2e 有一条断言专门比对 `lintSpec 判定「可保存」⇔ parseSpec 不抛`。
    - **一次给全所有问题**（`diagnoseSpec()`），不能"改一条、再撞下一条"。
      `parseSpec` 遇错即抛是它该做的；`lint_spec` 的职责恰恰是**列清单**。
    - 量纲维的定义在 `src/spec/dims.ts`，**不要**在别处再写一份"哪些维度重要"的判断。
    - `value.expr` 必须真的参与计算（判例：曾经写了却不算，静默返回两个原始累计额）。
      求值走 `src/spec/expr.ts` 的**手写求值器，不是 `eval`**。
      同类的还有 `scope.company.filter` 引用 `dim_company` 却不建 JOIN —— 修法是补 `needJoin`。
    - **新增任何"能算出数"的 spec 特性时，必须同时回答：写错了会怎样？**
      答不上来就先别加 —— 路径 2（自然语言 → spec）的全部工程价值都在这里，
      **只要语言允许欠约束，写的人（无论人还是 agent）迟早会写出来，而提示词既挡不住也测不了。**

18. **业务表由声明长出来；结构变更一律要人点一次 `bilite apply`。**
    - 唯一真相是 `models/*.yml`（IR 见 `src/gen/ir.ts`）。**`_meta_columns` 是它的投影**，
      不是第二份手写声明 —— 谁在别处再写一份"哪些列是什么角色"，谁就造了第二个真相。
      判据（e2e 第 30 阶段）：两种等价的 YAML 写法解析出**逐字段相同**的 IR。
    - **启动时只做两件事**：空库引导（一张声明的表都没有 → 把它建起来）、契约刷新（不是 DDL）。
      **结构变更（DDL）一律不自动做** —— 否则 `bilite plan` 就永远看不到东西，
      "先见 diff 再决定落地"这条验收标准就成了摆设。
    - **删列 / 改类型永不自动做**（`plan` 把它们标成阻塞项）：那是丢数据的事，只能由人决定。
      有阻塞项时 `apply` **整体不动**（连能做的也不做 —— 半个落地比整体不动更难查）。
    - 新增一张业务表 = 在 `models/` 里加一份声明 + `bilite plan` / `bilite apply`；
      **不许回头改 `src/gen/` 里的生成器代码**（P3 的判据：表不该随模板增长而需要改代码）。

19. **维度历史只增不改；"当前态"与"开放版本"是同一事实的两种表示，必须对拍。**
    - 形态：**历史挂侧表**（`dim_company_hist` / `dim_metric_hist`，由 `models/*_hist.yml` 声明），
      `dim_company` / `dim_metric` 仍是**当前态的唯一真相**。为什么不把版本行塞进维表本身：
      那样**每一处 join 都必须补 `is_current`**，少写一处就是同一家公司在结果里出现两次
      （数字翻倍而报表看起来完全正常）。侧表把这份成本关在一处：**既有查询一个字都不用改**。
    - **生效日一律用"期的首日"，绝不用 `now()`** —— 重放要确定性：同一份 raw 今天跑与下个月跑，
      "这一版从哪天生效"必须一样（§4 备忘 12 的同族陷阱）。
    - 区间是**半开** `[valid_from, valid_to)`：`valid_to` = 下一版生效日，NULL = 生效中；
      不允许造出重叠区间（`setDimAttributes` 会拒绝，`scdProblems()` 会报）。
    - **改属性只能走 `setDimAttributes()`**（关旧版 → 开新版 → 更新当前态，三步同序），
      直改维表会被 `scdProblems()` ② 抓出来 —— 它是这两个表示不漂的**唯一**机制（e2e 第 32 阶段钉着）。
    - 事实行仍然只记**业务键**：要"按事实期取当时那一版"必须显式 as-of join（`dimAsOf`）。
      把它变成默认行为 = 版本键进事实表（类型 2 的代理键），那是一次跨全链路切换，**不在本轮**。

## 3. 常用命令

```bash
npm run fixtures   # 生成测试假数据（模板 + 960 行长表 + 接入路径的源与规格：宽表一份、长表一份）到 test/fixtures/
npm run e2e        # ★ 全链路验收，431 项断言，唯一的门禁
npm start          # 启动本地 Web 服务（src/server.ts，默认 http://127.0.0.1:4319）
npm run bench      # ⚠️ 未实现（test/bench.ts 尚不存在）
```

- **`npm run e2e` 必须全绿才可提交。** 断言覆盖全部阶段 —— **刻意不写阶段条数，那个数字漂过两次**
  （条数以实跑输出为准）：模板指纹 → **CLI 解析层与命令表** → 开库 → 接入规格干跑 → 落库 →
  spec 编译查询 → Excel 渲染 → 版式保真 → 读回 → 换口径出第二张表 → 安全边界 → 语义层 →
  图表渲染 → **Web 服务 HTTP 全链路** → **MCP 工具集（真实客户端 + 模板推断）** →
  **spec 校验（防静默算错，铁律 14 + 17）** → **主数据对齐（铁律 16）** → **着陆层 raw（幂等与保真，P1）** → **重放（raw 是值的唯一来源，P1）** → **装载顺序守卫（事实行不许指向不存在的主数据，P1）** → **装载事务化（不留半个批次，P1）** → **源文件被删后仍能重放（路径 → raw，P1）** → **CLI render / query（受众钉死 + 物料隔离，P1）** → **catalog（列契约与三层导出，P1）** → **MCP catalog（agent 拿得到现状，P4）** → **CLI `validate`（一份命令、两份判据，§8.2 ④）** → **skill export 与手册对拍（§8.2 ①）** → **Web 接入向导（新接入路径的 HTTP 面 + 拍板回路，§11.5）** → **长表接入对拍（与冻结快照逐行含金额，§11.6）** → **退场守卫（旧路由 404 / 旧控件不在页面上）** → **期数的日期格（声明 `type: date`；1904 系统拒绝）** → **口径名不在注册表（PERIODTYPE_UNKNOWN）** → **CLI `catalog show` 与 `ingest dry-run` / `run` 真跑（退出码即结论：error 也退 1）** → **上传件只增不减守卫（扫 src/ 证明没有自动清理）** → **Parquet 归档 compaction（R8：逐批次对拍后才删源；0 行残骸退 1）** → **生成器 P2（两种写法同一份 IR / plan 只读 / apply 幂等 / 加列不重写数据 / 删列被拦）** → **运营事实表（target 由声明决定 / 无口径列也能落库 / 退化列进主键 / 只进目标表）** → **维度版本行（SCD2：历史侧表 / 生效日用期首日 / 时点查询 / 零回归 / 不变量守卫会抓）** → **三条结构守卫（页面路径 ↔ 路由表 / 每个 MCP 工具都被真调用 / 六处文档条数自校验）** → **自包含守卫（夹具规格与它的源都得在；不许拿生产规格当运行输入）**。
- 服务端**只监听 127.0.0.1**，数据不出本机。`src/server.ts` 导出 `start(port)` / `stop()`，
  传 `port=0` 由内核分配端口（e2e 就是这样在进程内起服务的）。
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
   导入频率是每月几次，故不需要更复杂的方案。**不要引入第二个常驻进程去开这个库。**
   ⚠️ **别把这条读成"只有服务端能开库"**：Web / MCP / **CLI** 三个入口都是"薄壳 + 自己开库"，
   互斥由上面这把锁天然强制。CLI 是**短命进程**（用完即退），不构成本条禁止的"常驻进程"；
   服务端在跑时它拿不到锁，**明确报错**即可，不许静默失败。见 `docs/需求与架构.md` §4.4 末。
   （唯一例外：`exportParquet()` 会开一个**同进程内、用完即弃的只读实例**做 Parquet 归档 —— 见备忘 9。
   它在同进程内，不构成"第二个进程"，且只读。）
6. **`exceljs` 只能用于生成测试 fixture**（`devDependencies`）。
   **生产路径禁用**：对含批注/图表/图片的真实模板 `readFile` 即崩，写出还会静默删 8/9 类部件（§5.3.1）。
   另外它 `addConditionalFormatting` 用 `type: 'dataBar'` 会崩，测试里用 `cellIs`。
7. **聚合阈值与脱敏按 `audience` 分级**（`src/semantic/query.ts` 的 `THRESHOLDS`）：
   `human { minSupport: 0, maxRows: 5000 }` / `agent { minSupport: 3, maxRows: 200 }`。
   **`minSupport` 是"每格背后的明细行数"，实现上由 SQL 并出 `count(CASE WHEN <cond> THEN 1 END) AS n{i}` 得来。**
   取 3 的依据：累计类口径每格 ≥ 6 行，而「单月 × 单指标 × 单公司」恰好 = 1 行 —— 阈值 3 挡住后者、不误伤看板。
   实测 agent 查全年按公司分组 `minSupport = 12` 放行；单月探测式查询报
   `结果过于精细（每格仅 1 行明细支撑 < 阈值 3）`。
   **不要把判据改回"单元格个数"** —— 那会让 20 格 × 每格 1 行明细的查询蒙混过关。
8. **Node 原生 TS 是 strip-only 模式，不支持构造函数参数属性。**
   `constructor(msg: string, readonly reason: string)` 报
   `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode`。
   必须写成显式字段赋值（见 `QueryRefused`）。**这是固有约束，会反复遇到。**
9. **`enable_external_access=false` 会连 `COPY ... TO` 一起拒，Parquet 归档必须另走只读实例。**
   实测报错：`Permission Error: Cannot access file "..." - file system operations are disabled by configuration`。
   三条走不通的替代方案（都实测过，别再试）：
   - `enable_external_access=false` + `allowed_directories` → `Cannot change allowed_directories when enable_external_access is disabled`
   - 开 `lock_configuration` 后再 `SET allowed_directories` → `configuration has been locked`
   - 想靠 `allowed_directories` 拦读 → **它不拦截 `read_text`/`read_csv`**，实测能读到 `/etc/passwd`
   正确做法：`exportParquet()` 开 `{ enable_external_access: 'true', access_mode: 'READ_ONLY' }` 的短命实例，
   `conn.closeSync()` + `inst.closeSync()` 收尾。**连接与实例都只有 `closeSync()`，没有 `close()`。**
   另一条实测事实：**归档后主连接也读不回 Parquet**（`read_parquet` 同样被硬化拒），这是预期行为。
   **另注：`connection.close()` / `instance.close()` 不存在** —— 只有 `closeSync()`；
   写 `await inst.close()` 会得到 `inst.close is not a function`（我自己踩过）。
10. **HTTP 层的两条实测坑**：
    - **流式响应没有 `content-length`**。`fs.createReadStream(...).pipe(res)` 不设该头，
      断言 `headers.get('content-length')` 会拿到 `null`。要按**实际字节**判（`(await res.arrayBuffer()).byteLength`）。
    - **不用 multipart 上传**。为省依赖，上传走**原始二进制 body + `X-Filename` 头**（前端 File API 读成 ArrayBuffer 直发）。
      文件名要 `encodeURIComponent`，服务端 `safeName()` 会剥掉路径成分。
11. **整段 DDL 是一个模板字符串 —— 注释里不能出现反引号。** `src/db/schema.ts` 的 `DDL` 用反引号包住，
    在 SQL 注释里写一个 `` ` `` 会把它**提前闭合**，于是后面的 SQL 被当成 TS 解析，
    报错是 `Expected a semicolon` 而且**指在毫不相干的下一行**（实测踩过：排查花了两轮）。
    想要代码样式就用中文引号，或直接写名字。
12. **`xlsx-populate` 把「日期格」给成**序列号（number）**，不是 `Date` 对象** —— 日期格要靠 spec 声明（`type: date`）才读得对。**
    实测：一个 `numFmt = 'yyyy-mm-dd'` 的日期格，`cell.value()` 返回 `number`、`typeof` 也是 `number`
    —— 于是 `v instanceof Date` 这类判断**是死代码**。
    后果实测过两次，两个方向都踩了：
    - 旧长表路径 `normalizeMonth()` 里正是这么写的 → 实际走 `String(46173)`，
      再配 `^(\d{4})[-/年]?(\d{1,2})` → **2026-06 的日期格被读成 `4617-04-01`**。
      数字看着像年份、格式完全正常，**没人会去查**（详见 `docs/需求与架构.md` §11.6）。
    - 新接入层用的是 `textAt()`，它**只认字符串**（这是有意的：数字在类型层面没有出口，铁律 1）
      → 日期格被读成"没有值"，期数列凭空消失，而干跑还报 `ok`（只是坐标空缺）。

    **现在的处置：由 spec 声明「这一列是日期」** —— `keys: [{ col: A, as: period, type: date }]`。
    声明了，引擎才把格子里的序列号按日期解读（序列号 → 日期，只支持 **1900 系统**）；
    没声明就报 `PERIOD_CELL_NOT_TEXT`，并在提示里把两条路都写出来（改成文本 / 声明 `type: date`）。
    - **为什么不自动看 `numFmt` 判断**（那是更"聪明"的做法）：**因为重放**。raw 里存的是那个数字
      （实测 `kind=number, raw_value=46174`），**压根没存"它是日期格"这件事**；
      靠读 xlsx 的格式来判断，首灌（读 xlsx）与重放（读 raw）就会得出**不同的期数**。
      把解读写成声明，两条路读的是同一份事实（e2e 第 27 阶段有用例钉着这一点）。
    - **只支持 1900 系统，1904 一律拒绝**：同一个日期在两套系统里的序列号差 **1462 天**
      （实测 2026-06-01 = 46174 vs 44712），拿 1900 基准去读 1904 的工作簿会**静默差 4 年**。
      xlsx-populate **不给**这个标志（实测三个可疑属性全是 `undefined`），只能自己看
      `xl/workbook.xml` 的 `<workbookPr date1904="1">`（`template.ts` 的 `usesDate1904()`）。
      拒绝发生在**两处**：打开始源文件（干跑/落库都会走到）与**着陆之前** ——
      后者是因为"raw 存了序列号却存不下日期系统"，那种 raw 会变成重放陷阱。
    - 序列号 **< 61 一律拒绝**（0/负数/1900 年 1–2 月）：Excel 凭空算进了 1900-02-29（序列号 60），
      1..59 与 ≥61 的基准差一天 —— 而在这里**差一天就等于差一个月**，所以不猜。
    - **"按序列号猜年份"这条路永远不要走**（旧路就是这么静默写出 4617 年的）。
13. **★ 归档用的"短命只读实例"会顺手把主实例的库锁丢掉 —— 于是第二个进程能进来。**
    这是 2026-10-01 由一条新断言（e2e"归档文件可被 DuckDB 读回"）挖出来的、**存在了很久**的
    静默失效。三点都实测过：
    - **归档之前**：第二个进程 `db.open()` 报 `Could not set lock on file`（备忘 5 的不变式成立）。
    - **归档一次之后**：那个只读实例 `closeSync()` 的那一刻，**主实例的锁就没了**
      —— 第二个进程 `db.open()` **直接成功**。`CHECKPOINT`、跑一条空查询都拿不回来；
      **只有"把主实例关掉重开"能拿回来**（所以 `exportParquet()` 的 `finally` 里调 `reattach()`）。
    - **只读实例是"创建那一刻的快照"**：把它留着不关能保住锁，但它再也看不见后来的提交
      （实测连续三次归档都读回 0 行）。所以只读实例必须**每次新建**。
    **后果长什么样**（要能一眼认出来）：两个写者同开一个库 → 主实例后续的归档全部读到**过期视图**
    → 写出的 Parquet **只有表头、0 行**（实测 960 行的批次写成 **222 字节**），
    而 `archived` 还报 `true`。判据：**`archived: true` 不等于"归档里有数"** ——
    所以 `exportParquet()` 现在带 `verify`（写完在同一实例上 `read_parquet` 数一遍），
    对不上就抛错、`archived` 置 false。
    **推论（比这条本身重要）**：`exportParquet()` 是**跨进程也会改变库状态边界**的操作。
    "同进程内、只读、用完即弃"这套说辞（备忘 5 末尾的"唯一例外"）**不成立** —— 别再照着它推理。
    **对照（2026-10-02 补）**：`db/compact.ts` 的归档合并开的是 `:memory:` 实例 —— 它**不打开库文件**，
    所以既不需要 `reattach()`，也不会把锁弄丢。**要碰库文件才需要上面那套舞蹈；不需要碰就别碰。**

## 5. 架构地图

```
src/
  cli.ts           命令行入口（三个入口之一，给人与脚本；见 docs/开发计划.md §7）
                   命令：ingest lint|dry-run|run · render · query · catalog dump|show · compact · plan|apply · validate · skill export
                   （`scanArgs` 是唯一的参数扫描器）
                   ★ `validate` 不写新判据 —— 只判别该调 `diagnoseIngest` 还是 `diagnoseSpec`（顶层有没有 source）
                   ★ 解析层 parseCliArgs() 是纯函数 —— 不启动任何东西即可覆盖整个命令面
                   ★ handler 惰性 import（--help / lint 不加载 duckdb）；数据走 stdout、日志走 stderr
                   ★ 命令表自检：注册了却没 handler → 启动即报错（别让它静默空转）
                   ★ 退出码就是结论（脚本只看它）：被拒 / 有 error → 1；`needsDecision` 是待办 → 仍 0
                     （干跑也一样 —— "这份源根本读不了"报成成功是最坏的一种安静；e2e 第 28 阶段钉着）
                   ★ plan / apply 是**两条**命令：plan 只读（连空库引导都不做，见 db/index.ts 的启动策略）；
                     apply 落地非阻塞项，有阻塞项就整体不动。两者共用同一份 IR 与同一份 DDL 生成
                   ★ query 的受众**写死 human**（铁律 10）—— 没有 `--audience` 这种开关
                   ⚠️ 不许把 CLI 取数命令写进 agent 侧物料 —— 那等于给 agent 开一条取数路（§7.5，e2e 有断言）
  gen/             ★ 生成器（P2）：models/*.yml → IR → plan → apply。业务表的 DDL 由它长出来
    ir.ts          ★ IR 定义（表 / 列 / 主键 / 外键 / 角色）+ metaOf()（列契约的**唯一投影**）+ 指纹
                   ★ 判据：**换一种 YAML 写法，IR 以下一行都不该改**（e2e 拿两种写法对拍）
    parse.ts       YAML → IR；两种等价写法（分组 keys/measures · 平铺 columns）；
                   diagnoseModels() 一次给全所有问题；跨表校验 refs 指向的表必须也被声明
    ddl.ts         IR → DDL（纯函数：plan 给人看的是它、apply 执行的也是它）
    plan.ts        IR + 现有库结构 → 人可读变更清单（**只读**）；删列 / 改类型 / NOT NULL 列 → 阻塞项
    apply.ts       plan → 落库（DDL + 列契约 + _model/_model_dep，**同一事务**）
  paths.ts          ★ 源文件路径白名单（resolveSource）—— **唯一实现**，是安全判据，别复制第二份
  land/             ★ 着陆层：源文件 → raw_file / raw_cell（append-only，**"可重放"的唯一依据**）
    raw.ts         landRawFile()：sha256 幂等（同 hash 一格都不重写）+ 只存有值的格
                   + raw_source（路径 → 最近一次着陆）：**源文件删了也能重放**；
                     findRawFile() 两步走 —— 文件在按内容找，文件不在按路径找
                   + raw_value 不 trim（与 template.ts 的 textAt 语义刻意不同）+ BEGIN/COMMIT
                   ★ 返回值结构上只有计数与哈希，不含任何格内容（照 previewSpec「根本不查库」那套路）
                   ★ **1904 日期系统的工作簿拒绝着陆** —— raw 存得下序列号、存不下日期系统，
                     那种 raw 会变成"重放得出另一个答案"的陷阱
                   read.ts        rawWorkbook()：把 raw_cell 还成「可读工作簿」（忠实还原，不解读）
                                  ★ 这是「可重放」的落点：删掉 stg/dim/fact 后仍能从 raw 重建
                   ⚠️ 清洗/换算一律不许往回写 raw —— 否则它就成了第二份真相
  skill/           ★ 手册里**可对拍**的那部分，从实现投影（架构 §8.2 ①：规则是实现的投影）
    export.ts      skillFactsFrom(TOOLS) → 工具面 + 注册表；skillPrompt → Markdown
                   + skillProblems(SKILL.md, 工具名)：**把「手册会不会漂」变成断言**（同 metaProblems 的套路）
                   ⚠️ 诚实边界写在导出物里：规格字段清单与判据 code 全集**反射不到**
                     （strip-only，类型在运行时不存在），所以它替代不了 SKILL.md，只是它的可对拍部分
  meta/            ★ 列契约与 catalog：物理层向语义层 / Agent 自省自己（架构 §7.2、§8.5）
    columns.ts     META = **声明层的投影**（metaOf(loadModels())，铁律 18 —— 不再手写第二份）
                   + registerMeta(meta?)：apply 与接入层**两处**登记同一份投影（后者在落库同一事务里）
                   + metaProblems()：把声明与 information_schema 对拍，四类漂移全报（可注入声明，e2e 据此证明它真会抓）
                   + schemaFingerprint()：ddlHash，agent 靠它判断手里那份 catalog 是不是旧的
    catalog.ts     catalogDump() 三层导出（L1 业务成员 / L2 物理结构 / L3 版本）+ catalogShow() 按需下钻
                   ★ 零金额；**不含** raw_* / _ingest_batch / dim_alias —— 那些是运营侧，混进来会把快照撑成运营日志
  db/
    schema.ts      **基础元数据** DDL（运营侧 raw_* / import_batch / dim_alias + 控制面 _meta_* / _model*）
                   + PERIOD_TYPES 口径注册表。★ **业务表（dim_*/fact_*）的 DDL 不在这里** —— 见 src/gen/
                   ⚠️ 整段 DDL 是**模板字符串**：注释里写反引号会把它提前闭合（报错却指在下一行）
    index.ts       open(..., { models: ensure | skip }) / writer() / reader() / query() / execute() / close()
                   + ensureModels()：启动策略见铁律 18（空库引导 + 契约刷新；**DDL 一律不自动做**，有阻塞项即抛错）
                   + exportParquet()（★ 只读实例写归档 → **归档后重开主实例把库锁拿回来**（`reattach()`）
                     → **写完读回来数一遍**；见铁律 11 与 §4 备忘 13）
                   —— 单进程双连接；query() 已处理 BigInt 与 JSON 解析
    scd2.ts        ★ 维度版本行（SCD2 类型 2）：setDimAttributes / dimAsOf / dimHistory / scdProblems
                   ★ **历史挂侧表**，当前态维表不动 —— 既有查询零回归（这是"不把 is_current 撒满全仓库"的落点）
                   ★ 生效日只用期的首日（不用 now()）：重放要确定性；区间半开 [from, to)
    compact.ts     ★ Parquet 归档的小文件合并（R8）：只按**文件大小**挑候选（≥ 2 个才动手 —— 否则会来回重写）
                   + **先逐 batch_id 对拍、再删源文件**；对不上就抛错，一个源文件都不删
                   + 0 行的归档残骸**不动它**、单独报出来（那是过去某次归档失败的证据，不是垃圾）
                   ★ 它开的是 `:memory:` 实例 —— **不碰库文件、也不碰库锁**，服务端在跑时也能合并
                     （与 exportParquet() 的锁舞蹈刻意不同：那边必须碰库，这边一个字节都不读库）
  ingest/          ★ 接入层：源 Excel（任意形态）→ 星型表。YAML 由 agent 产出，这里只确定性执行
    types.ts       IngestSpec 类型 + parseIngestSpec() + lintIngest() + diagnoseIngest()
                   ★ 判据只有一份（与 spec/lint.ts 同理）；口径从调用方注入，不 import PERIOD_TYPES
    dryrun.ts      展开网格 → 事实行（只出形状与计数；onRow 回调是金额唯一一次离开读取循环）
                   openBook? 决定「值从哪来」：默认开 xlsx，已着陆则换成 raw（src/land/read.ts）
                   ⚠️ 有 openBook 时**不要求源文件还在** —— 否则「删了源文件也能重放」到不了这一步
                   ★ **长表也走这一条路**（四个坐标全在列里、期数逐行不同）：行键 = rows 列 + 期数；
                     期数认完整日期；`PERIOD_PER_ROW` 只是 warn（按每行各自的期数落库）。
                     这四条能力是"取代旧长表路径"的前提，e2e 第 26 阶段有对拍（§11.6）
                   ★ `keys[].as` 除了 `period`，还可以指向**目标表声明的行内退化列**
                     （如 `as: business_line`）：那一格的文本按原样写进事实表，它进主键、不是维。
                     合法名字由声明决定，写错即解析期拒绝。
                   ★ **日期格靠声明**：`keys[].type: date` 才把序列号按日期解读（默认 text）——
                     自动读 numFmt 会在**重放**时失效（raw 里只有那个数字）；1904 系统两处拒绝。
                     序列号 < 61 直接拒绝（差额只有一天，而这里差一天 = 差一个月）。e2e 第 27 阶段有断言
    run.ts         runIngest()：**关卡 0 先着陆**（同一份文件幂等）→ 关卡 1 形状不对一行不写 →
                   ★ **目标表由声明决定**（`spec.target` → `declaredFacts`）：INSERT 的列序、主键、
                     撞库预检、归档目录名全部读声明 —— 代码里不再有 "fact_finance" 这个字符串
                     （运营事实表没有口径列，就是靠这一条才填得进去的）
                   关卡 2 无值格 → 主数据两档归并 → 落库。落库那条路**从 raw 读**（可重放）；
                   干跑不写库：已着陆就读 raw，没着陆就读工作簿
                   ★ 阶段 2 的全部库写包在 **BEGIN/COMMIT** 里（Parquet 归档在 COMMIT 之后 ——
                     它另开实例拿锁，事务里拿不到）。中途失败整体回滚，不留半个批次
                   ★ `dimIdOf()` 取不到维度 id 当场抛 —— 否则 lit(undefined) 会写出 `'undefined'` 脏 id
    normalize.ts   toHalfWidth/normalizeName/stemCompany（判重与归并共用）
    resolve.ts     ★ 两档主数据归并（铁律 16）—— 原在 import/，2026-10-01 搬进接入层
                   + normalizeName()（去格式噪音，Tier 1 判据）
                   + stemCompany()（剥公司形式后缀，仅用于生成候选）
                   + buildResolver() / candidates()（候选必带 why）
                   + registerAlias() / listAliases() / describeUnresolved()
                   + 立场：合并两家公司比不合并危险得多
    master.ts      masterCatalog()：主数据快照的唯一实现（MCP 工具与 Web 路由共用，防判据漂移）
  spec/
    types.ts       Spec 类型 + parseSpec()（YAML → 校验过的 Spec）+ SpecError
                   + parseSpecLenient()（解析但不校验，给诊断用）
                   + diagnoseSpec()（★ 一次给全所有问题，lint/Web/HTTP 共用）
                   + findUnusedParams()（★ 防"声明了 params 却没用"的静默算错，铁律 14）
    dims.ts        ★ 维度角色表：哪些是「量纲维」、哪些是「筛选维」（铁律 17）
                   + DIMENSIONS 的单一来源（compile.ts 从这里 re-export）
    expr.ts        ★ 派生表达式求值器（手写 tokenizer/parser，**不是 eval**）
                   + evalExpr() —— expr 的输入来自 SQL、输出在 JS 里算
    lint.ts        ★ 结构诊断的**唯一判据**：欠约束 / expr 引用 / join / order / chart
                   + lintSpec() + unpinnedMeaningDims()
                   + PERIODTYPE_UNKNOWN：口径名必须是注册过的（与 semantic/query.ts 的 allowedPeriods 同源）。
                     ★ 判例（2026-10-01 实测）：把「本年累计」写成形近的「本年度累计」，parseSpec 放行、
                     lint 一条不报，而那一格从 **66826 静默变成 null** —— 写进报送表像「这一项本月没有数」。
                   ⚠️ 禁止另写一份判据 —— 漂移会表现为"说没问题、保存却被拒"
    compile.ts     ★ DIMENSIONS 白名单 + compileBlock() → 参数化 SQL
                   + runCompiled()（expr 参与计算）+ planOf()（坐标预览，不含金额）
    template.ts    模板结构读取：表头/行标签/合并区/定义名称/公式行
                   + readTemplateSchema() / readRegion() / textAt()（数字在类型层面没出口）
                   + usesDate1904()：读 xl/workbook.xml 的 workbookPr —— 1904 系统的工作簿不许进接入层
    infer.ts       ★ 模板 → spec 草稿（铁律 15）
                   + 每个轴带 source（template=读到的 / guessed=猜的）+ evidence（依据）
                   + 公式行先排除再判维；判维要求全部标签命中
                   + 手写 YAML 输出（注释是草稿的主要价值）
  semantic/
    query.ts       ★ queryMetrics()：唯一的自由查询出口
                   + staticCatalog()（元数据，零金额）+ band() 分档脱敏
                   + QueryRefused + THRESHOLDS（按 audience 分级，见 §4 备忘 7）
  render/
    excel.ts       ★ renderTemplate()：xlsx-populate 模板填充
                   + readNumberFormat()（纯只读，勿改成 cell.style()）
                   + 兜底：setNumericCellXml / setTextCellXml（JSZip + 定向 XML）
                   + quoteFormulas()（公式注入防护）
    chart.ts       ★ toEChartsOption()（含数值，只给浏览器）
                   + chartShape()（只含结构与标签、不含数据点，可给 agent）
  server.ts        ★ **Web 入口**（零框架 node:http；给"人"）—— 三个入口之一
                   + `audience` 写死 human 并**无条件覆盖**请求体里的同名字段（铁律 10）
                   + 接入路径路由 `/api/ingest/{specs,lint,upload,dry-run,run,save}`：
                     upload 只落盘（不解析不落库，落点必须过 `resolveSource`）；
                     specs 顺带回 YAML 文本（**枚举出来的路径**，不另开一个路径判据）；
                     其余五条与 MCP 工具共用 `diagnoseIngest` / `runIngest`，不写新判据
                   ★ 退场守卫：旧 `/api/import/*` 路由**已删**，e2e 钉着「POST 一律 404」
  web/             ★ Web 界面（零前端框架、零构建；`app.js` + `index.html` + `style.css`）
    app.js         数据导入 / 看板查询 / 报表报送三块；**页面不写判据**，只把服务端结论摆给人看
                   + 接入向导：上传源 → 挑/改接入规格 → 边打字诊断 → 干跑 → 待确认拍板 → 落库
                   + `source:` 由人点按钮改（改完在编辑器里可见）—— 不开"运行时覆盖 source"的第二条真相
  mcp/
    tools.ts       ★ 12 个工具
                   看现状：get_catalog（★ 按需下钻；零金额；把「现在有什么」交给 agent）
                   报表侧：list_metrics / get_template_schema / lint_spec / preview_spec /
                           render_report / diff_report / generate_spec
                   接入侧：look_at_source（★ 数字格只回 {num:true}）/ lint_ingest /
                           dry_run_ingest / run_ingest
                   + callTool()：★ 金额兜底（铁律 13）+ 审计（只记字段名）
                   + findAmountLike()（递归找 ≥ AMOUNT_TRIPWIRE 的数字，给 e2e 复用）
                   + previewSpec() ★ 不查库 —— 坐标纯从 spec 的 order 长度 + 锚点推出
                   + generateSpec() ★ 不查库 —— 只读模板结构与注册表（铁律 15）
    server.ts      零依赖 MCP stdio 服务端（JSON-RPC 2.0，按 \n 分帧）
                   ⚠️ stdout 是协议通道，日志一律走 stderr
                   server/discover 必须回 -32601 才会让客户端回落 legacy（§3.2）
specs/             口径规格 YAML（如 月度保送表.yaml）
templates/         原始报送模板（人工制作，不修改）
data/              ⚠️ 真实财务数据，永不提交
  audit/           MCP 审计日志（JSONL，只记字段名不记值）
```

**数据流**：Excel（任意形态）→（`land/` 着陆 → `ingest/` 按接入规格展开，不经 LLM）→ DuckDB
→（`spec/` 编译成 SQL，本地执行）→ 结果矩阵 →（`render/`）→ 报送 Excel 或 ECharts option。
*（旧长表路径 `import/` 已于 2026-10-01 **整体**退场：longtable.ts 删了、resolve.ts 搬进 `ingest/`。）*
**agent 只参与产出 spec，从不接触数值。**

**两条"给 agent 看不给数值"的对称设计**（新增返回数据的接口时照这个套路）：
- `planOf(spec, results)` → 坐标网格（§5，第②层）
- `chartShape(chart, input)` → 图表形状描述（§5.3，同一思路）

## 6. 落地顺序与当前进度

按 `docs/需求与架构.md` §11，**顺序很重要**：规格引擎（第 3 步）必须先于 agent 入口（第 4 步）。
规格引擎是人的工具，agent 只是它的快捷输入方式。**反过来做会得到一个花哨但不准的东西。**

| 阶段 | 状态 |
|---|---|
| 1. 导入闭环 | ✅ **完成**（服务端 960 行/320–380ms + Web 导入向导 + Parquet 归档） |
| 2. 语义层 + 查询 | ✅ **完成**（`queryMetrics` 受众分级 / 反推防护 / 注入防护 + Web 看板查询页） |
| 3. 规格引擎 | ✅ **完成**（Excel 模板填充 + ECharts 两个 renderer + Web 报表预览/导出） |
| 4. agent 入口 | ✅ **完成**（MCP 12 工具，零依赖 stdio；e2e 用**真实 MCP 客户端**验收） |
| 5. 模板 → spec 自动生成 | ✅ **完成**（`template.ts` + `infer.ts` + `generate_spec` + Web 上传模板出草稿） |
| R1. 主数据对齐 | ✅ **完成**（`resolve.ts` 两档归并 + `dim_alias` 表 + 两阶段 commit + Web 待确认卡片，铁律 16） |
| §7.2 路径 2 | ✅ **完成**（`dims.ts` / `expr.ts` / `lint.ts` 挡住欠约束 + `lint_spec` 工具 + Web 边打字边诊断，铁律 17） |
| 生成器（P2） | ✅ **完成**（`models/*.yml` → IR → `bilite plan` / `bilite apply`：业务表的 DDL 由声明长出来、`_meta_columns` 是它的投影；启动时不自动改结构，见铁律 18） |
| 维度版本行（SCD2） | ✅ **完成**（历史挂侧表 `dim_*_hist`；`setDimAttributes` 三步同序、`dimAsOf` 半开区间时点查询、`scdProblems()` 对拍两份表示 —— 见铁律 19 与 `docs/开发计划.md` §20） |
| 运营事实表 | ✅ **完成**（`fact_business_line` 由声明长出来，**无口径列**；接入规格的 `target:` 决定写进哪张表 —— 见铁律 18 与 `docs/开发计划.md` §19） |
| CLI 入口 | ✅ **命令面走完了**（`ingest lint` / `dry-run` / `run` · `render` · `query` · `catalog dump` / `show` · `compact` · **`plan` / `apply`** · `validate` / `skill export`）。`lint` 零 DB 访问；`query` 受众写死 human；`catalog dump` 遇契约漂移**不以成功退出** —— 见 `docs/开发计划.md` §7 |

五步全部完成，已由 `src/server.ts` + `src/web/` + `src/mcp/` 打通到人与 agent 两个入口，
**431 项 e2e 断言**（含第 12 阶段 HTTP 全链路、第 13 阶段真实 MCP 客户端与模板推断、
第 14 阶段 spec 校验防静默算错、第 15 阶段主数据对齐、第 25 阶段新接入路径的 HTTP 面与拍板回路
（含并发落库、归档可读）、第 26 阶段长表接入对拍（与**冻结快照**逐行含金额）、
第 27 阶段期数的日期格（声明 type: date 才读；不声明不猜；重放一致；1904 拒绝））守着。

**下一步（尚未开始）**：
- ~~`src/import/` 退场~~ → **已完成（2026-10-01，三片全绿）**：`longtable.ts`、三条 `/api/import/*` 路由、
  旧导入页与旧断言都删了，并补了**退场守卫**（旧路由必须 404、首页不许留旧控件）。
  第 26 阶段的对拍改为对**冻结快照**（`test/expected/集团导出长表-960行.json`）。
  ⚠️ `resolve.ts` 同轮搬进了 `src/ingest/`，`src/import/` 目录随之消失 —— 旧路径至此**零残留**。
- ~~期数的真实日期格~~ → **已完成（2026-10-01）**：由 spec 声明 `type: date`（序列号→日期，只支持
  1900 系统；1904 系统两处响亮拒绝），e2e 第 27 阶段钉着"声明了才读、不声明不猜、重放一致"。
- ⏸ ~~已推后（用户 2026-10-01 拍板）~~ → **2026-10-02 用户重新拍板：这四项重新开工**
  （见 `docs/开发计划.md` §6 与 §17/§18）。① **§10 R8 Parquet compaction 已落**（第 29 阶段 8 条断言）；
  ② **生成器 P2 已落**（`models/*.yml` → IR → plan / apply，第 30 阶段 13 条断言；业务表的 DDL 不再手写）；
  ③ **`fact_business_line` 已落**（声明 + `target:` 由声明决定，第 31 阶段 13 条断言）；
  ④ **SCD2 已落**（历史侧表 + 时点查询 + 不变量守卫，第 32 阶段 10 条断言）。**四项全部完成。**

**§7.2 路径 2（自然语言描述口径 → spec）已完成**，但它**不是一个独立功能**：
真正的工作量落在"让 spec 语言在解析期挡住欠约束"上（`src/spec/{dims,expr,lint}.ts`），
agent 侧只是多了一个 `lint_spec` 工具让它自己先撞一次墙。
判据（写进 §7.2.1）：**只要语言允许欠约束，写的人迟早会写出来，而提示词既挡不住也测不了。**

### 6.1 本轮的教训：测试也会成为 bug 的守卫

第 5 步发现 `specs/月度保送表.yaml` 声明 `year/month` 却从不引用，
"2026年6月月报"实际把 **12 个月全加总**（B4 = 765345，真值 66826）。
**错的数字已经被写进 `test/e2e.ts` 的断言**，此后一直是绿的 ——
测试不但没抓住 bug，反而把它锁死了（详见 §2 铁律 14、`docs/需求与架构.md` §11.3）。

**推论**：断言里的期望值必须来自**独立算法**（如直接 SQL 查一遍），
不能来自"上一次跑出来的结果"。发现数字对不上时，**先怀疑断言**。

**新增 MCP 工具时**：必须走 `callTool()`（铁律 13），并在 `test/e2e.ts` 第 13 阶段补断言
（工具数、返回值零金额、错误路径）。

### 6.2 接口全绿 ≠ 功能可用：浏览器里才撞得到的三个 bug

R1 交付后 e2e **186 项全绿**，但把人真的会走的路径在浏览器里点一遍，
连着撞出 **3 个 e2e 结构上抓不到的 bug**：

1. **`UnresolvedName` 没有 `kind` 字段** —— 候选清单由「公司」「指标」两个 Resolver
   分别产出，汇总成 `unresolved.companies / .metrics` 后**就再也分不出谁是谁**。
   后果有两个：前端把公司标成「指标」（截图里一眼可见）；更要命的是人拍板回传的
   `DimDecision.kind` 变成 `undefined`，服务端按 `kind|normalized` 查决定表**永远匹配不上** ——
   **点「并入」等于没点，提交被无限次拦下**。这是整个"人拍板"机制在不工作。
   *为什么 e2e 没抓到*：断言只查了 `Array.isArray(staged.unresolved.companies)`
   （§7 那句"stage 输出 unresolved 候选清单"），**从没把 unresolved 转成 decisions 再提交一次**。
   现在补的断言正是端到端复现浏览器那一步：`unresolved → decisions → commit` 必须通过。
2. **点完「并入」提交按钮不变** —— 决定确实记下了，但 `refresh()` 只重渲染卡片、
   没同步按钮状态，按钮仍是 disabled 且文案不变。人看到的是"点了没反应"。
   修法：抽出 `syncCommitButton()`，`renderStage()` 与 `refresh()` **都调它**。
   *为什么 e2e 没抓到*：断言在服务端，不经过 DOM。
3. **并发/连点上传撞 `batchId`** —— 原来只有 `Date.now()`，同毫秒的两个请求生成同一个 id，
   后到的那个直接 `Duplicate key "batch_id: ..."`. 用户手快连点两次，或拖放时误触发两次
   `change`，就会看到校验失败。修法：时间戳外加一个进程内自增序号。
   *为什么 e2e 没抓到*：断言是串行的，从不并发调用 `stage()`。

**推论（比这三条本身重要）**：
- **接口测试覆盖不了 UI 状态机。** 交付带交互的功能前，**必须真的走一遍人的路径**
  （浏览器点击），不能只看 e2e 绿。
- **"两个来源的数据汇总成一个列表"时，务必把来源标识带下去。** 丢掉 `kind` 这种
  "看起来冗余"的字段，代价是下游全部失能 —— 而且**不报错**，只是静默不生效。
- **断言要复现用户动作的完整回路**，而不是只检查中间产物存在（`Array.isArray(...)`
  这种断言几乎不设防）。
- **凡是有唯一 id 生成的地方，都问一句"同毫秒两次会怎样"**。

## 7. 测试纪律

- **当前只有假数据。** 用户明确指示：*「测试都用假数据测，生产环境会有不同的数据导入格式，先跑通」*。
  因此：**不要为了让某个断言过关而把导入层写死成假数据的列名。**
- **生产接入规格（`ingest/*.yaml`）的 `source:` 必须指向稳定位置**：`data/` 下的正式文件，
  或人在向导里上传后落下的 `data/uploads/...`。**不许指向探针/临时目录**（如 `data/probe-run/`）——
  那种路径清一次调试残留就断；更坏的是探针重跑会在**同一个路径**生成另一份文件，
  规格从此换个数据源而**没有任何提示**。
  （判例：`ingest/月度经营接入.yaml` 曾经指在 `data/probe-run/`，2026-10-01 挪到 `data/月度经营接入源.xlsx`。）
- **`data/uploads/` 只增不减是设计，不是欠账；清理是人工动作，判据如下。**
  上传件 = 人在向导里传进来的源文件，落点固定 `data/uploads/`（`resolveSource` 白名单根之一）。
  **为什么不能自动轮换**：生产接入规格的 `source:` 可以直接指向 `data/uploads/xxx.xlsx`，
  删掉它那条规格**立刻变成死路径**，而且没有任何提示 —— 与上一条判例同源，只是方向相反
  （那边是路径被换掉，这边是路径被删掉）。
  可以删的前提有两条，**都要成立**：① 该路径在 `raw_source` 里出现过（说明它已着陆，
  重放走 raw、不再依赖文件本体 —— e2e 第 20 阶段钉着"源文件删了也能重放"）；
  ② 没有任何 `ingest/*.yaml` 的 `source:` 正指向它。
  顺序是「先跑一次 `bilite ingest run <规格>` 让它进 raw，再删文件」。
  `templates/uploads/` 同理（那边还多一条：无法保证是空表，所以不进版本库，见 `.gitignore`）。
  **代码里不许出现"自动删上传件"**：e2e 第 25 阶段扫 `src/` 把这件事钉住了。
- **接入层必须对格式差异宽容**，这是 R1（主数据对齐）的核心。现在**形状只有一处声明**：接入规格 YAML
  （旧的 `readLongTable()` 与它那份"列名别名表"已随退场一起删除 —— 那正是"两份实现"的代价）。
  期数认 `2026-06` / `2026/6` / `2026年6月` / `202606` 与**完整日期**；
  **日期格要声明**：`keys: [{ col, as: period, type: date }]` —— 不声明就报 `PERIOD_CELL_NOT_TEXT`（引擎不猜，见 §4 备忘 12）。
  新增容忍度时**同时考虑**：公司名/指标名的别名（`dim_company.alias` / `dim_metric.alias` 已在用）。
- **未识别的主数据必须报给人确认，不得静默自动建维。** 这件事**已实现**（铁律 16）：
  Tier 1（纯格式差异）自动归并且**在 `issues` 里留痕**；Tier 2（去壳/包含/相似）
  只给候选（带 `why`）、由人在 Web 上「并入已有 / 新建」二选一，或经 `runIngest({decisions})` 传入；
  有歧义时整体不落库（返回 `needsDecision`，**一行都没写** —— 那是待办，不是失败）。
  **`unknownMaster: create` 仍会新建无候选的名字** —— 那是给"确实是新公司"用的，
  不是用来跳过确认的。名字有候选时它**照样会拦下来**。
  干跑输出里的 `unmatched` 继续保留给人看（"这批名字里有多少是见过的"）。
  **不做主数据对齐，三个月后数据全是孤儿行。**
- 新增校验规则 → 加到接入层的 `lintIngest()` / `dryRunIngest()` 的 `issues`，并同步加进 `test/e2e.ts` 第 2 阶段。
- **改了断言 → 同步 §3 / §6 里的条数** —— 现在这条**由 e2e 自校验**：末尾它会读
  `AGENTS.md` §3/§6、`docs/需求与架构.md` §11.1 与 `README.md` **三处**的条数，对不上就红，
  并告出六处各是多少。**README 是 2026-10-02 才纳进来的** —— 在此之前它一直写着过时的
  247 与「231 项断言，15 个阶段」；纳进来的当天又漏了一处（"技术选型"表格里那个 231），
  所以它现在是**三处**而不是两处。README 恰好是最多人信的那份文档。
  （条数会漂：231 与 247 对不上过一次，根因就是没人管它 —— 所以干脆交给门禁。）
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
