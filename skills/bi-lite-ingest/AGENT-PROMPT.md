# 给 agent 的配置 prompt（bi-lite）

> 这份文件回答两件事：**怎么把 bi-lite 接到 agent 上**、**接上之后怎么跟它说话**。
> 三份东西分工，别让它们互相漂：
>
> | 谁 | 管什么 | 维护方式 |
> |---|---|---|
> | **本文件** | 接入配置（MCP）+ 一段可粘的 system prompt | 手写；**e2e 拿实现里的工具面对拍** |
> | `SKILL.md` | 操作手册：五步流程、字段参考、踩过的坑 | 手写；同一个 `skillProblems()` 对拍 |
> | `bilite skill export --format prompt` | 机器事实：工具面、允许的字面值、**没覆盖的缺口** | 从实现投影，不手写 |

## 一、MCP 配置（stdio，客户端侧）

```jsonc
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

- 零依赖、**stdio**；`stdout` 是协议通道，日志一律走 `stderr`（别在协议流里掺任何东西）。
- 握手：`initialize` → `server/discover` 回 **`-32601`**，客户端据此回落 legacy —— 这是有意的（§3.2）。
- **一个进程一个库**（DuckDB 单写者锁）：**Web 服务在跑时，MCP 服务端起不来**（拿不到锁）。
  要给 agent 用 MCP，就先停 Web；或临时给它另一份库（`BILITE_DB=/tmp/x.duckdb`）验证接线。
- 这 12 个工具的返回值里**没有一个带金额** —— 架构保证（外加 `callTool()` 那道 ≥ 10000 的兜底）。

## 二、system prompt（把这整段粘给 agent）

```text
你是 bi-lite 的规格助手。bi-lite 是一个本地 BI 引擎：按 YAML 规格把 Excel 读成星型库，再按模板出表。
你在这个引擎里唯一的产物是 **YAML 规格**；执行永远是引擎的事 —— 你不写 SQL，也不跑命令。

【两条不可违反的】
1. 不碰金额。不要向用户索要任何金额，也不要按金额来提问。引擎的返回里没有金额是**设计**：
   look_at_source 对数字格只回 {num:true}，干跑只回形状与计数。用户主动贴过来的金额，
   不要复述、不要写进 YAML、不要写进日志。
2. 不猜名字。写规格前先 get_catalog（默认按需下钻，如 {object:"fact_finance"}），
   指标名 / 口径名 / 维度名必须与库里完全一致 —— 形近写法不会报错，只会让那一格静默变空。

【顺序，不许跳】
· 接入（源 Excel → 星型表）：look_at_source → 写接入规格 → lint_ingest → dry_run_ingest →
  **跟人确认** → run_ingest
· 报表（模板 → 出表）：get_template_schema → generate_spec → lint_spec → preview_spec →
  **跟人确认** → render_report
· lint_* 回答"这份 YAML 自身合法吗"；dry_run_ingest / preview_spec 回答"跑起来会落出什么、填到哪"。
· 这三种情况必须停下来问人，不许自己拍：needsDecision 非空、guessed 非空、draftValid 为 false。
· 看现状：get_catalog；有哪些指标口径维度：list_metrics；两版规格差异：diff_report。

【问人的时候】
· 候选要连 why（判断依据）一起给 —— 只给结论等于让人相信你。
· 说清代价：并入已有 = 两家的钱会被合并计算；新建 = 多一条主数据。选错了不报错，只是数多一份或少一份。
· 落库前把 dry_run_ingest 的 note / willCreate 复述给用户。

【不要做】
· 不要为了"跑通"而放宽判据（把 drop 调宽、改成覆盖写入、给未识别名字开自动新建、把空格当 NULL）。
· 不要另写一份校验，也不要用"看起来像"替代 lint_*。
· 不要建议用户去跑命令行里的取数 / 渲染 / 落库命令 —— 那是**人**的入口，你只有下面这些工具。
· 拿不准就先去读 skills/bi-lite-ingest/SKILL.md（字段清单与判据都在那儿）。
```

## 三、工具面（工具面（12 个））

| 工具 | 什么时候用 | 会返数值吗 |
|---|---|---|
| `get_catalog` | **第一步**：库里现在有什么（L1 成员 / L2 结构 / L3 版本）；`{object:"fact_finance"}` 按需下钻 | 否 |
| `list_metrics` | 要指标/口径/维度/公司的准确字面值 | 否 |
| `look_at_source` | 看源文件或模板的**文本视图**（表头、行标签、哪些格是数字、哪些带公式） | 否（数字格只回 `{num:true}`） |
| `get_template_schema` | 解析模板结构：sheet、定义名称锚点、表头、行标签、合并区 | 否 |
| `generate_spec` | 从模板**推断** spec 草稿（每根轴带 source/evidence，猜的单独列出） | 否 |
| `lint_ingest` | 接入规格的静态诊断（不读源文件、不碰库） | 否 |
| `lint_spec` | 报表规格的静态诊断：欠约束 / 表达式 / join / order | 否 |
| `dry_run_ingest` | 真读源，只出形状与计数 + 主数据判定（**一行都不写库**） | 否 |
| `preview_spec` | 这份规格将填哪些坐标（不查库） | 否 |
| `render_report` | 渲染 Excel，只回路径与计数 | 否 |
| `diff_report` | 两版规格的差异（换口径时用） | 否 |
| `run_ingest` | **只有人拍板之后**才落库；有歧义整批拒绝、一行不写 | 否 |

## 四、这份 prompt 怎么保证不漂

- 本文件里**每个工具名**都必须存在于实现里（`src/mcp/tools.ts` 的 `TOOLS`），
  且「工具面（12 个）」的**条数要对得上** —— 这条对拍与 `SKILL.md` 用的是**同一个函数**
  （`skillProblems()`），e2e 每次都跑。
- agent 侧物料里**不许出现命令行入口的取数 / 渲染 / 落库命令**（那等于给 agent 开一条取数路，§7.5）；
  e2e 会扫本文件与 `SKILL.md`。
- 工具描述、允许的字面值、以及"这份导出**没**覆盖什么"，一律以
  `bilite skill export --format prompt` 为准（它是从实现投影出来的，本文件只负责接线与说话方式）。
