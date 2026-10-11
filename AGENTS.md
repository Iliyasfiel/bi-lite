# AGENTS.md —— bi-lite 开发规约

> 本文件是所有 AI 编码代理（DSH / OpenCode / Claude Code / Codex / Cursor 等）在本仓库工作的
> **唯一入口规约**。人也适用：工程纪律对人与代理一视同仁。
> 工具侧指针（`CLAUDE.md`、`.cursor/rules/`）如存在，均指向本文件，勿另立副本。
>
> ★ **渐进式加载**：本文件只放**规则**。判例的根因链、实测报错与踩坑过程按模块收在
>   `docs/判例与环境坑.md`（Node / DuckDB / Excel / HTTP / 工程判例）；规范文本是
>   `docs/需求与架构.md`；现状与刀谱是 `docs/开发计划.md`。遇到问题先查对应文档，别猜。

## 0. 一分钟认知

bi-lite = **开源、轻量的本地 BI 引擎**：一份 Excel 加一份 YAML 规格 → 本地 DuckDB 星型库 → 按模板出表。
三个入口共用同一套引擎（CLI 命令面已走完）：**MCP + skill** 给 agent，**Web** 给人，**CLI** 给人与脚本。

**它不是 BI 看板。** 保送填表（把财务数据按不同给定表格形式填成 Excel 报送）是主战场，看板是副产品。
核心抽象只有一个：`spec`（声明式规格 YAML）—— **接入规格**说"这份 Excel 怎么读"，
**报表规格**说"这张表按什么口径算、填进哪张模板"；Excel 与图表都是它的 renderer（`docs/需求与架构.md` §0）。

技术栈：**Node ≥ 22.6（本机 26.7.0，原生跑 `.ts`，无构建步骤）** + DuckDB（明细，进程内单文件）
+ Parquet（归档）。零外部服务、零前端框架。DuckDB 用 `@duckdb/node-api`，**版本锁死不用 `^`**（供应链风险）。

**最高优先级的不变式是安全**：财务数据不得以明文进入 LLM 上下文——不靠过滤，靠架构
（agent 无 SQL 权、只产出 spec）。详见铁律 1。

## 1. 必读文档（开工前按序）

| 顺序 | 文档 | 用途 |
|---|---|---|
| 1 | `docs/需求与架构.md` | **唯一的规范文本**。§3 选型 / §4 数据模型 / §5 spec 与渲染 / §6 安全 / §7 Agent / §10 风险 / §11 落地顺序 |
| 2 | `docs/判例与环境坑.md` | 判例根因链与实测记录（按模块）—— 铁律与速查表里每条"为什么"的出处 |
| 3 | `src/` 各文件头部注释 | 每个模块开头都指向对应章节 |
| 4 | `skills/bi-lite-ingest/SKILL.md` | **给 agent 的操作手册**：接入/报表规格字段、五步流程、lint 与 dry-run 分工、**不要向用户索要金额** |
| 5 | `skills/bi-lite-ingest/AGENT-PROMPT.md` | **接线 + 可粘的 system prompt**：MCP 配置（stdio）、行为纪律、12 工具用法。两份物料都由 `skillProblems()` 对拍 |
| 6 | `docs/tech-research-excel-template-and-duckdb.md` | 选型期的实测原始记录（含源码行号） |

**文档即规范**（code follows docs）：实现与文档冲突 → 改代码或改文档，**不悄悄偏离**。
涉及 §5.3（渲染器）或 §6（安全）的改动，先更新文档再改代码。

## 2. 铁律（违反任何一条 = 回滚，不接受"临时"例外）

1. **明细数据不出 DuckDB 进程；金额不进 LLM 上下文。**
   - agent **没有 SQL 权**：只暴露 §7.1 的 12 个工具，无 shell；给 agent 的预览（`planOf()`）
     只含坐标与形状，不含数值。
   - 输入侧与输出侧是两条防线：引擎不做脱敏、不管输入，职责是「**不往外发数据**」——
     `look_at_source` 对数字格只回 `{num:true}`，`dry_run_ingest` 与所有 `planOf()` 响应**永远没有金额**
     （e2e 断言专门比对）。「别把金额贴给我」写在 SKILL.md，是提醒不是防线。
   - 新增任何"返回查询结果"的接口前，先确认它不会把明细值送进 LLM。
   - 参考：Lightdash/Metabase/Superset 都给 LLM SQL 权再加闸门，bi-lite 是**根本不给**——
     自觉的路线分歧，别因"别人都这么做"而改。
2. **维度白名单是唯一 SQL 入口。** `spec/compile.ts` 的 `DIMENSIONS` 是唯一维度注册表：
   `rows.dim` / `cols.dim` 必须过 `isRegisteredDim()`，未注册直接抛。报表侧目标表 `spec.fact` 同理：
   只从 `models/*.yml` 声明过的事实表（kind: fact）取名字，compile/query 编译期硬校验、
   lint 报 `FACT_UNKNOWN`（缺省 `fact_finance`）。不在别处拼接用户可控的表名/列名；
   过滤字段名匹配 `/^[a-z_][a-z0-9_]*$/i`；字符串字面量一律走 `q()` 转义。
3. **模板优先，绝不覆盖模板的既有格式。** 模板已显式设过的数字格式、样式、合并、公式、批注、图表
   一律不动，只往数据格写值（`docs/需求与架构.md` §5.3.4 坑 7）。
4. **`cell.style(...)` 是写路径，不是读路径。** 读单元格样式一律走 `readNumberFormat()`
   （`src/render/excel.ts`）。根因与实测见 `docs/判例与环境坑.md` §3.1。
5. **口径是窗口声明，不是行上字符串。** 五种口径拆三件（P5）：**窗口实存**（单月 / 本年累计 /
   账面累计，行上存 `period_from`、终点 ≡ `fin_month`，规则声明在 `models/fact_finance.yml`
   的 `calibers`）、**窗口平移**（去年同期累计：装载即落去年窗口、查询期标签 +1 年，不单独存行）、
   **calculator**（单月同比，语义层算，不占事实表列）。判据单一在 `compileMetrics`。
6. **账面累计必须实存，不得从单月派生。** 它含审计调整，累加不等；`calibers` 声明里
   非 calculator 的窗口口径都不许在代码里"顺手算出来"。
7. **执行链路的每一行都不经过 LLM。** 两种规格 YAML 由 agent（或人）产出，引擎只做**确定性执行**
   与**确定性拒绝**：`src/ingest/`、`src/spec/`、`src/render/` 下任何代码不得引用 LLM/MCP 相关模块，
   也不得为了"跑通"而放宽判据。
8. **运营指标独立成表**，共享 `dim_company` / `dim_period`，**不塞进 `fact_finance`**：
   量纲、频率、口径体系都不同（Kimball 星型）。`fact_contract` 与 `fact_business_line` 都已由声明长出来；
   `fact_business_line` 刻意**没有口径列**（运营指标没有财务那套口径体系）。加运营指标 = 新建表 + 加声明。
9. **数据文件不入库。** `data/` 下是真实财务数据，**永不提交、永不进 prompt、永不贴进 issue**。
10. **阈值与脱敏挂在"受众"上，不挂在查询上。** `audience='human'`（Web，已授权的人）返**精确值、
    无阈值**；`audience='agent'`（LLM/MCP）返**分档值 + 每格至少 3 行明细支撑**。
    判据是**每格背后的明细行数**（`minSupport`），**不是单元格个数**——按格数计会让
    20 格 × 每格 1 行明细的网格蒙混过关。Web 入口（`server.ts`）固定 `audience='human'` 并
    **无条件覆盖**请求体同名字段（e2e 有传 agent 验证被覆盖的用例）；受众由服务端按入口判定，
    绝不能让前端参数决定。禁止给 agent 开精确值出口。
11. **`enable_external_access=false` 是安全硬化，不能为了"归档/导出"而放开。** 写 Parquet 走
    `exportParquet()`（短命只读实例，`src/db/index.ts`）。**不要用 `allowed_directories`**
    ——与硬化互斥且拦不住 `read_text`，不能当安全边界（三条替代方案的报错原文见
    `docs/判例与环境坑.md` §2.3）。
12. **禁止裸 `catch {}`。** 有意容错的地方必须留下可观测痕迹（打日志 + 回传状态字段）。
    判例：归档曾静默失效多轮（`docs/判例与环境坑.md` §5.6）。
13. **MCP 工具返回值必须过金额兜底；审计日志只记字段名，不记值。** `src/mcp/tools.ts` 的
    `callTool()` 对每个返回值递归扫描，出现 **≥ `AMOUNT_TRIPWIRE`（10000）的数字**即判泄漏：
    记审计 + 打 stderr + 返回拦截信息。**新增任何 MCP 工具都必须走 `callTool()`**，不得绕过。
    审计写 `data/audit/mcp.jsonl`，只记 `argKeys` / `resultKeys` / `ms` / 成败——记值就等于把金额
    写进另一个明文文件。这道兜底防的是"将来某次改动不小心把数值带进返回值"（把安静泄漏变成响亮报错），
    **不替代铁律 1 的结构性设计**；分档串与低额金额过不了它——第四道防线，不是第一道。
14. **上报的数字必须按声明的 params 过滤；"静默算错"比"拒绝出表"危险得多。** `parseSpec()` 检查
    `params` 每个键是否真的被 `{{key}}` 引用（`findUnusedParams()`），没引用就**解析即报错**。
    判例：声明 `year/month` 却不引用 → "2026年6月月报"把 12 个月全加总，且错数字曾被写进 e2e 断言
    （`docs/判例与环境坑.md` §5.1）。改 spec 结构先确认 `scope.time` 还在；新增用 `params` 的字段
    同步 `substitutableStrings()`（必须与 compile.ts 所有 `substitute()` 调用点一致）；
    断言数字与独立算法不一致时**先怀疑断言**。
15. **模板推断是"提案"，不是"决策"。** `src/spec/infer.ts` 每个轴必须带 `source`
    （template = 读到的 / guessed = 猜的）与 `evidence`，猜的不许标成读到的；判维要求**全部标签命中**，
    不许"半数像就算"；公式行**先排除、再判维**（首版顺序反了，「合计」行的标签被送去匹配指标表而失败）。
16. **主数据归并分两档；不确定就停下问人，绝不"按相似度自动合并"。** 立场：**合并两家公司比不合并
    危险得多**——不合并时数字明显不对（人会来查）；错合并时两家的钱被静默加在一起，报表看起来
    完全正常（没人查）。Tier 1 自动：仅 `normalizeName()` 后完全相同（格式噪音），且必须在 `issues`
    里留痕；Tier 2 只给候选（带 `why`）、由人拍板。落库两阶段：干跑**一次库都不写**，有歧义整体返回
    `needsDecision`（HTTP 200——待办不是失败）；阶段 2 先建维度再登记别名（登记前校验目标存在）。
    判据细节在 `src/ingest/resolve.ts` 头部。
17. **量纲维必须被钉住；欠约束的 spec 在解析期就拒绝，不许"先出数再看"。** `metric` 与
    `period_type` 是**量纲维**（决定"这个数是什么"），公司/月份/年份是筛选维（只决定"哪些数加进来"）。
    判例：无指标约束时那一格返回 67283、真值 65198——同量级、格式正常、没人怀疑
    （`docs/判例与环境坑.md` §5.2）。规则只有一份：`src/spec/lint.ts` 的 `lintSpec()`——
    `parseSpec` / `lint_spec` / HTTP / Web 诊断**全部**调它，**禁止另写判据**（两份判据会漂成
    "工具说没问题、保存却被拒"）。诊断**一次给全**（`diagnoseSpec()`）；量纲维定义在 `src/spec/dims.ts`
    不另写；`value.expr` 必须真的参与计算（手写求值器，不是 eval；`scope.company.filter` 引维表要补
    `needJoin`）。**新增任何"能算出数"的 spec 特性，必须同时回答"写错了会怎样"**——只要语言允许
    欠约束，写的人迟早会写出来，提示词挡不住也测不了。
18. **业务表由声明长出来；结构变更一律要人点一次 `bilite apply`。** 唯一真相是 `models/*.yml`
    （IR 见 `src/gen/ir.ts`；`_meta_columns` 是它的投影，不是第二份手写声明；判据：两种等价 YAML
    写法解析出逐字段相同的 IR）。启动只做两件事：空库引导 + 契约刷新；**DDL 一律不自动做**
    （否则 `bilite plan` 永远看不到东西）；删列/改类型是阻塞项，有阻塞项 `apply` 整体不动
    （半个落地比整体不动更难查）。新增一张表 = 加一份声明，**不许回头改 `src/gen/` 生成器代码**。
    六种模板：
    - **dimension**（含历史侧表 `*_hist`，见铁律 19）/ **fact**（grain 必须与主键一致）。
    - **聚合表（`kind: aggregate`）是派生物**：`source`（必须是声明的 fact）+ `grain` + `measures`
      （v1 只认 sum），**列由跨表投影、人不写列**；**口径与期数不许被聚合掉**（`MODEL_AGG_NONADDABLE`，
      铁律 8 前移到解析期）；grain 与源粒度同集合 → `MODEL_AGG_NOOP`（warn 也 fail-closed）。
      写路径只有 `CREATE OR REPLACE` 全量重算——删了能回来；`plan` 对它只比列名集合
      （不一致 = 非阻塞 `rebuild-table`）；落库与数据**同一事务**重建。
    - **声明行（`rows:`）与桥接表（`kind: bridge`）**：小维表与多对多映射写进 `models/*.yml`
      （git 即审计），写路径只有 `bilite rebuild` 全量对齐一条（DELETE→INSERT 同事务，维先桥后）。
      维度行不写 id（`nameHash(name)` 的纯函数）；桥接行外键**写名字**、落库解析成 id
      （错名整批拒，绝不静默建主数据）；每公司权重和必须 =1（摊分要么完整、要么整个不摊）。
      带 rows 的维**不许被 fact 引用**（`MODEL_ROWS_OWNER_BAD`：接入归并与全量对齐互删）。
      聚合表 `via:` 穿桥 = `SUM(amount × weight)` 加权摊分：join 键自动推导（恰一对），
      grain 必须留桥坐标（`MODEL_AGG_VIA_BAD`）。
19. **维度历史只增不改；"当前态"与"开放版本"是同一事实的两种表示，必须对拍。** 历史挂侧表
    （`dim_company_hist` / `dim_metric_hist`，由 `models/*_hist.yml` 声明），`dim_company` /
    `dim_metric` 仍是**当前态的唯一真相**——既有查询一个字都不用改（把版本行塞进维表本身，
    每处 join 都得补 `is_current`，少写一处数字就翻倍）。生效日一律用**期的首日**、绝不用 `now()`
    （重放要确定性）；区间半开 `[valid_from, valid_to)`，不允许重叠。改属性只走 `setDimAttributes()`
    （关旧版→开新版→更新当前态，三步同序），直改维表会被 `scdProblems()` 抓——它是两个表示
    不漂的**唯一**机制（e2e 第 33 阶段钉着）。事实行只记业务键；"按事实期取当时版"要显式
    as-of join（`dimAsOf`），把它变成默认行为是跨全链路切换，不在本轮。

## 3. 常用命令

```bash
npm run fixtures   # 生成测试假数据（模板 + 长表/宽表源与规格）到 test/fixtures/
npm run e2e        # ★ 全链路验收，567 项断言，唯一的门禁
npm start          # 启动本地 Web 服务（src/server.ts，默认 http://127.0.0.1:4319）
```

- **`npm run e2e` 必须全绿才可提交。** 覆盖 40 个阶段 + 三条结构守卫（页面路径↔路由表 /
  每个 MCP 工具都被真调用 / 六处文档条数自校验）+ 自包含守卫。阶段与断言清单见
  `test/e2e.ts` 分节注释——**刻意不写进文档**（条数以实跑输出为准，那个数字漂过两次）。
- 服务端**只监听 127.0.0.1**，数据不出本机。`src/server.ts` 导出 `start(port)` / `stop()`；
  传 `port=0` 由内核分配端口（e2e 就是这样在进程内起服务的）。
- `test/fixtures/` 与 `test/output/` 是**生成物**，可随时删了重跑 `npm run fixtures`。
- 验收脚本会 **`rm -rf data/bi.duckdb`**（每次从空库跑），别拿它对着真实数据库跑。

## 4. 环境速查（本机已知坑；根因链与实测报错见 `docs/判例与环境坑.md`）

| # | 坑 | 正确做法 |
|---|---|---|
| 1 | npm 全局缓存含 root 属主文件 → EPERM | 所有 npm 命令加 `--cache /tmp/npm-cache-$$`；勿 `sudo chown` |
| 2 | Node 原生 `.ts`：必须 `"type":"module"`、导入带 `.ts` 扩展名；strip-only 不支持构造函数参数属性 | 按规矩写（判例 §1.2，`QueryRefused` 是标准写法） |
| 3 | DuckDB `run()` 只有 `getChunk`；`getRowObjectsJson()` 返回的已是解析好的数组 | 取数用 `runAndRead*` + `getRowsJson()`；勿对已解析结果再 `JSON.parse` |
| 4 | 单写者锁：有跨进程写者时连 `READ_ONLY` 都拿不到 | 单进程独占 + 进程内双连接；勿引第二个常驻进程；CLI 短命进程拿不到锁就明确报错 |
| 5 | `enable_external_access=false` 连 `COPY` 一起拒；`allowed_directories` 不当安全边界 | `exportParquet()` 短命只读实例（铁律 11，判例 §2.3） |
| 6 | 归档的只读实例一关，主实例的库锁就丢 | `reattach()` 拿回锁 + `verify` 读回计数；`compact` 用 `:memory:` 不碰锁（判例 §2.4） |
| 7 | 事务内读自己的写：`query()` 数出 0 | 读自己刚写的一律 `queryWriter()`（判例 §2.5） |
| 8 | `Sheet.cell()` 不收定义名称；`cell.style()` "读"操作污染 styles.xml | 定义名称走 `Workbook.definedName()`；读样式走 `readNumberFormat()`（判例 §3.1） |
| 9 | 日期格给序列号（number），`v instanceof Date` 是死代码；1900/1904 差 1462 天 | 接入规格声明 `type: date`；1904 一律拒绝；序列号 <61 拒绝（判例 §3.2） |
| 10 | exceljs 读真实模板崩、写出静默删部件 | 只许生成测试 fixture（devDependencies，判例 §3.3） |
| 11 | 流式响应没有 `content-length`；不用 multipart | 按 `arrayBuffer().byteLength` 断言；上传走二进制 body + `X-Filename`（判例 §4） |
| 12 | DDL 模板字符串：注释里写反引号会提前闭合；行注释会吞掉后面的逗号 | 注释用中文引号；逗号写在注释之前（判例 §5.5） |
| 13 | `typeof null === 'object'`（联合类型判别处，踩过两次） | 判别条件加 `!== null`；写之前先想一遍 null（判例 §5.7） |

## 5. 架构地图

（每个模块一行定位 + 关键判据；模块内细节看文件头部注释与 `docs/需求与架构.md`）

```
src/
  cli.ts           CLI 入口（三入口之一）：ingest lint|dry-run|run · render · query · catalog dump|show
                   · compact · plan|apply|rebuild · replay · validate · skill export
                   ★ parseCliArgs() 纯数据；handler 惰性 import（--help 不加载原生依赖）；
                     stdout=数据 / stderr=日志；命令表自检（注册无 handler 启动即报错）；
                     退出码即结论（被拒/error→1，needsDecision 是待办→0）；query 受众写死 human
                   ⚠️ agent 侧物料不许出现 CLI 取数命令（e2e 有断言）
  gen/             ★ 生成器：models/*.yml → IR → plan → apply / rebuild（业务表 DDL 由声明长出来）
    ir.ts          IR + metaOf()（列契约唯一投影）+ 指纹；nameHash() / viaJoinCandidates() 共享纯函数
    parse.ts       YAML → IR + diagnoseModels()（一次给全）；跨表守卫（refs 存在 / 桥形状 /
                   MODEL_ROWS_OWNER_BAD / via 四守卫 / MODEL_AGG_NONADDABLE）
    ddl.ts         IR → DDL（纯函数）+ rebuildTableSql(t, ir)（聚合 CTAS；via 穿桥加权摊分）
    plan.ts        IR + 库结构 → 变更清单（只读）；删列/改类型 → 阻塞项；聚合表只比列名集合
    apply.ts       plan → 落库（DDL + 契约 + _model/_model_dep，同一事务）
    sync.ts        ★ 声明行（rows）唯一写实现：DELETE→INSERT 全量对齐（维先桥后）；名字→id 解析
                   （错名整批拒）；权重和 ≠1 整批回滚；读自己的写走 queryWriter
    rebuild.ts     rebuildAll()：sync 声明行 + 重算聚合 + 契约刷新，一个事务（CLI bilite rebuild）；
                   落库事务内只 executeRebuilds（行不依赖事实）
  paths.ts         源文件路径白名单（resolveSource）—— 唯一实现，安全判据，别复制第二份
  land/            着陆层：源 → raw_file/raw_cell（append-only，可重放的唯一依据）
    raw.ts         landRawFile()（sha256 幂等 + raw_source 路径回放 + 1904 拒着陆）
    read.ts        rawWorkbook()（raw → 可读工作簿；清洗/换算不许回写 raw）
  ingest/          接入层：源 Excel → 星型表（规格 YAML 由 agent 产出，这里只确定性执行）
    types.ts       IngestSpec + parseIngestSpec + lintIngest/diagnoseIngest（判据只有一份）
    dryrun.ts      展开网格 → 事实行（只出形状计数；长表同路；keys[].as 可指退化列；type: date）；
                   每行带值格坐标（col）——stg 影子与 replay 对拍的坐标来源
    run.ts         runIngest()：关卡 0 着陆 → 形状 → 无值格 → 主数据两档 → 落库（事务化）；
                   ★ 目标表由声明决定（spec.target → declaredFacts），代码里没有表名字符串；
                   fact + stg_fact_rows 同事务双写（架构 §4.7：少一份当场炸）
    replay.ts      replaySpec()：按 spec 从库内 raw 重展、与最新批 stg 逐格对拍；
                   结论只含坐标+字段名（零金额出口），未落库 → SPEC_NOT_INGESTED
    normalize.ts   toHalfWidth / normalizeName / stemCompany
    resolve.ts     两档主数据归并（铁律 16；判据细节在本文件头部）
    master.ts      masterCatalog()（主数据快照唯一实现）
  spec/            规格引擎：报表规格 → SQL → 矩阵
    types.ts       Spec 类型（含 fact：报表侧目标表）+ parseSpec + diagnoseSpec + findUnusedParams
    dims.ts        维度角色表 + DIMENSIONS 单一来源 + dimAvailableOn(dim, fact)（三处共用）
    geometry.ts    模板几何（两侧共用的锚点判据）+ looksLikeIngestDoc（按几何判别两份判据）
    expr.ts        派生表达式求值器（手写 tokenizer/parser，不是 eval）
    lint.ts        ★ 结构诊断唯一判据：lintSpec + PERIODTYPE_UNKNOWN；禁止另写一份
    compile.ts     DIMENSIONS 白名单 + compileBlock(factName/facts) → 参数化 SQL + planOf（无金额）
    template.ts    模板结构读取 + textAt（数字在类型层面没出口）+ usesDate1904
    infer.ts       模板 → spec 草稿（铁律 15：提案不是决策）
  semantic/query.ts  queryMetrics()（唯一自由查询出口）：受众分级 + 反推防护（minSupport）+
                   compileMetrics(mq, facts)（FACT_UNKNOWN / DIM_NOT_ON_FACT / PERIOD_TYPE_NOT_ON_FACT）
  semantic/introspect.ts  语义自省：声明 → 每张表能查什么（measures/dimRefs/slicers/谱系），
                   纯函数零 DB；零新登记（架构 §7.1），随 catalogDump().semantic 导出
  semantic/rewrite.ts  查询改写器：业务形状（指标成员+查询级口径）→ MetricsQuery，只翻译不判，
                   白名单/钉住判据仍在 compileMetrics 一处；P5 selector/calculator 接缝
  render/          excel.ts（模板填充 + readNumberFormat + XML 兜底 + quoteFormulas）/
                   chart.ts（toEChartsOption 含数值 / chartShape 无数据点可给 agent）
  server.ts        Web 入口（零框架 node:http）：audience 固定 human 并覆盖请求体；
                   /api/ingest/{specs,lint,upload,dry-run,run,save} 与 MCP 工具共用判据
  web/             Web 界面（零框架零构建）；页面不写判据，只把服务端结论摆给人看
  mcp/             tools.ts（12 工具 + callTool 金额兜底 + 审计）/ server.ts（零依赖 stdio）
  meta/            columns.ts（META=声明投影 + registerMeta + metaProblems + schemaFingerprint）/
                   catalog.ts（三层导出，零金额，不含 raw_*/_ingest_batch/dim_alias）
  db/              schema.ts（基础元数据 DDL + PERIOD_TYPES；业务表 DDL 在 gen/）/
                   index.ts（open/query/execute/queryWriter/exportParquet+reattach+verify）/
                   scd2.ts（铁律 19）/ compact.ts（:memory: 实例合并，不碰库锁）
  skill/           export.ts（skillFacts + skillProblems：手册不漂的断言）
specs/  models/  templates/  ingest/    # 声明与规格 YAML（版本化）；data/ 永不提交
```

**数据流**：Excel（任意形态）→（`land/` 着陆 → `ingest/` 按接入规格展开，不经 LLM）→ DuckDB
→（`spec/` 编译成 SQL，本地执行）→ 结果矩阵 →（`render/`）→ 报送 Excel 或 ECharts。
**agent 只参与产出 spec，从不接触数值。**

**两条"给 agent 看不给数值"的对称设计**（新增返回数据的接口照这个套路）：
`planOf(spec, results)` → 坐标网格；`chartShape(chart, input)` → 图表形状描述。

## 6. 落地进度

按 `docs/需求与架构.md` §11 顺序：规格引擎先于 agent 入口（agent 只是规格引擎的快捷输入方式）。

| 阶段 | 状态 |
|---|---|
| 1. 导入闭环 | ✅ 服务端 + Web 导入向导 + Parquet 归档 |
| 2. 语义层 + 查询 | ✅ 受众分级 / 反推防护 / 注入防护 + Web 看板 |
| 3. 规格引擎 | ✅ Excel + ECharts 两个渲染器 + Web 报表预览导出 |
| 4. agent 入口 | ✅ MCP 十二工具（真实 MCP 客户端验收通过） |
| 5. 模板 → spec | ✅ 上传模板自动出 spec 草稿（Web + `generate_spec`） |
| R1. 主数据对齐 | ✅ 两档归并（Tier 1 自动 / Tier 2 人拍板）+ `dim_alias` 表 + Web 待确认卡片 |
| §7.2 路径 2 | ✅ 自然语言 → spec：靠"spec 语言挡住欠约束"实现（`lint_spec` + 边打字边诊断） |
| 生成器（P2） | ✅ `models/*.yml` → IR → `bilite plan` / `bilite apply`（铁律 18） |
| 运营事实表 | ✅ `fact_business_line`（无口径列；`target:` 由声明决定） |
| 维度版本行（SCD2） | ✅ 历史侧表 + `dimAsOf` 时点查询 + `scdProblems()` 对拍（铁律 19） |
| 报表侧目标表声明化 | ✅ `spec.fact` 白名单（FACT_UNKNOWN / DIM_NOT_ON_FACT / PERIOD_TYPE_NOT_ON_FACT） |
| 聚合表 | ✅ `kind: aggregate`：投影列 / `MODEL_AGG_NONADDABLE` / 全量重算（e2e 第 34 阶段） |
| 桥接层 | ✅ `kind: bridge` + 声明行 `rows:`：全量对齐 / 权重和 =1 / `via:` 加权摊分（e2e 第 35 阶段） |
| 语义层自省 + 改写器 | ✅ `introspect`（声明 → 能查什么，零新登记）/ `rewrite`（纯翻译，判据一份）/ `catalog.semantic`（e2e 第 36 阶段） |
| 标准化层（stg） | ✅ `stg_fact_rows` 同事务影子（fact+stg 少一份当场炸）/ `bilite replay` 从库内 raw 重展对拍，结论只含坐标+字段名（e2e 第 37 阶段） |
| CLI 入口 | ✅ 命令面走完（`ingest` 三连 · `render` · `query` · `catalog` · `compact` · `plan/apply/rebuild` · `replay` · `validate` · `skill export`） |

五步全部完成，已由 `src/server.ts` + `src/web/` + `src/mcp/` 打通到人与 agent 两个入口，
**567 项 e2e 断言**守着（阶段与断言清单见 `test/e2e.ts` 分节注释——刻意不在此复述，条数漂过两次，
由 e2e 末尾的自校验盯着）。

**下一步**：历史施工项全部完成（`docs/开发计划.md` §1 与 §4 刀谱）；未完成与待定看 `docs/开发计划.md` §3。

## 7. 测试纪律

- **当前只有假数据**（用户指示：先跑通，生产数据的形态差异只在"摆法"）。**不要为了让断言过关
  把导入层写死成假数据的列名。**
- **生产接入规格（`ingest/*.yaml`）的 `source:` 必须指向稳定位置**（`data/` 正式文件或 `data/uploads/`），
  **不许指向探针/临时目录**——那种路径清一次调试残留就断，且探针重跑会在同一路径生成另一份文件，
  规格从此换数据源而没有任何提示。
- **`data/uploads/` 只增不减是设计**：上传件是规格 `source:` 可以直接指向的源文件，删掉它那条规格
  立刻变成死路径。可删的前提两条都要成立：① 已在 `raw_source` 里出现过（可重放）；② 没有任何
  `ingest/*.yaml` 的 `source:` 指向它。**代码里不许出现"自动删上传件"**（e2e 扫 `src/` 钉着）。
- **接入层必须对格式差异宽容**（R1 的核心）：形状只有接入规格 YAML 一处声明；期数认
  `2026-06` / `2026/6` / `2026年6月` / `202606` 与完整日期；日期格要声明 `type: date`
  （不声明就报 `PERIOD_CELL_NOT_TEXT`，引擎不猜）。
- **未识别的主数据必须报给人确认，不得静默自动建维**（铁律 16）。**不做主数据对齐，
  三个月后数据全是孤儿行。**
- 新增校验规则 → 加进 `lintIngest()` / `dryRunIngest()` 的 `issues`，并同步 e2e 第 2 阶段。
- **改了断言 → 同步 §3 / §6 的条数**：由 e2e 末尾自校验盯着（读 `AGENTS.md` §3/§6、
  `docs/需求与架构.md` §11.1、`README.md` 三处，共六处，对不上就红）。
- 安全相关的断言（第 9 阶段）**只许增加，不许删除**。
- 版式保真断言（第 6 阶段）含 **styles.xml 防膨胀**四项 —— 铁律 4 的回归防线。

## 8. 范围管控（防范围蔓延）

`docs/需求与架构.md` §2.3 Non-goals 是"说不"的书面依据：

- ❌ 不做复杂图表编辑器 —— 让 Office / Univer 承担最后 10% 的精细排版
- ❌ 不做定时调度、多租户、外部数仓对接
- ❌ **不给 agent 自主执行 SQL 的能力**（铁律 1）
- ❌ 不引入构建步骤（Node 原生跑 TS 是有意选择，符合"轻量化"）
- ❌ 不引入 `exceljs` 到生产路径（实测排除）

诱惑来时先查这张表。
