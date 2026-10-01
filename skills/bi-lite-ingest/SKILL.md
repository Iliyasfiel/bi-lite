---
name: bi-lite-ingest
description: Use when turning a source Excel (a subsidiary's filled report, a group export, any table shape) or a blank report template into a bi-lite YAML spec — 接入规格（源 → 星型表）或报表规格（模板 → 出表）— and when a person asks "把这个文件导进来" / "识别这个模板" / "这张表怎么接入". Covers the read-then-ask workflow, the spec fields, the lint/dry-run split, and what must never be sent to the model.
---

# bi-lite：把任意 Excel 变成可复用 YAML

bi-lite 有**两类 YAML**，都只由你（agent）与人对话产出，引擎只做确定性执行与确定性拒绝：

| | 做什么 | 产物 | 执行者 |
|---|---|---|---|
| **接入规格** | 源 Excel（任意形态）→ 星型表行 | `ingest/<id>.yaml` | `run_ingest` |
| **报表规格** | 模板 + 口径 → 出表/出图 | `specs/<id>.yaml` | `preview_spec` / `render_report` |

## 0. 先记住这条：引擎不往外发数据，你也不要去要

- `look_at_source` 对**数字格只回 `{num: true}`**（结构上不可能泄漏金额）；`dry_run_ingest` 的响应里**永远没有金额**。这是设计，不是限制。
- **不要请用户把表里的金额贴给你**。你写规格只需要**结构**：表头在第几行、行标签在哪一列、哪几列是数字、哪些行带公式。
- 用户如果主动贴了金额，那已经发生了：**不要复述、不要写进 YAML、不要写进 issue 或 commit message**，继续按结构办事。
- 需要"这个数对不对"的判断时，让**人在浏览器里看**（`preview_spec` / 报表渲染），不要把它搬进对话。

## 1. 工具面（12 个）

- **看现状：`get_catalog`** —— 写任何 YAML 之前先读它
- 看图：`look_at_source`（源/模板的文本视图 + 类型 + 公式标记）
- 报表：`list_metrics` / `get_template_schema` / `generate_spec` / `lint_spec` / `preview_spec` / `render_report` / `diff_report`
- 接入：`lint_ingest` / `dry_run_ingest` / `run_ingest`

**你没有 SQL 权，也没有 shell。** 想"先看看这表长什么样"只有 `look_at_source`。

### 为什么第一步是 `get_catalog`

它给的是**库里现在有什么**（L1 已注册的指标/公司/口径/维度、L2 表与列、L3 版本）。
不读它就写 YAML，你会**发明**名字：看到"应收账款"造一个 `receivable_amount`，
而库里早有 `account.receivable`。这不是维度值重复，是**指标身份重复** ——
同一个口径两个 code，之后所有汇总都会出错，而且**不报错**。

- **默认用法是按需下钻**：`get_catalog({object: "fact_finance"})` 只看那一张表，别把整库吞下去。
- 它是一份**快照**（带 `apiVersion` / `ddlHash` / `asOf`），**会过期**：
  写完 YAML 要让 `lint_ingest` / `lint_spec` 读**当下**的结构复核 —— 那两个才是判据，快照只是素材。
- 返回值里**没有金额**，也没有装载批次历史。

## 2. 接入规格：五步，顺序不能换

```text
① look_at_source       看清结构（表头行/标签列/数字列/公式行）
② 写 YAML              按 §3 的字段写出 ingest/<id>.yaml 草稿
③ lint_ingest          静态判据：能不能跑（不读源、不碰库）
④ dry_run_ingest       真读源，只出形状与计数；有歧义的名字在这里浮出来
⑤ 与人对话 → run_ingest  歧义拍板后才落库
```

**③ 与 ④ 的分工是刻意的**：`lint_ingest` 回答"这份 YAML 自身合法吗"，`dry_run_ingest` 回答"拿这个源跑会落出什么"。前者不读文件，后者读文件但**一行都不写库**。

**④ 之后必须先跟人说话**，只要有 `needsDecision` 非空：引擎对"库里找不到的名字"默认**整批拒绝、一行都不落**（`unknownMaster: confirm`）。合并两家不同的公司会把它们的钱静默加在一起，报表看起来完全正常，没人会来查 —— 所以这一步不自动做。

对话模板（`needsDecision[]` 里每一项都问）：

> 「源里的「华东(子)公司」库里没有。它是：
> ① 已存在的【华东子公司】（并入，`action: merge` + `targetId`）
> ② 一家新的公司（新建，`action: create`）
> ——两者的区别：选①这家的钱会和华东子公司合并计算；选②会新建一条主数据。选错了不会报错，只会让数多一份或少一份。」

候选里每一项都带 `why`（判定依据）——**把 `why` 一起给用户看**，不要只给名字。

## 3. 接入规格字段参考（每个字段都问：写错了会怎样）

```yaml
id: 子公司月报接入            # 必填，文件名以它为准
source: data/华东子公司-2026-06.xlsx   # 必填，限定在 data/ templates/ test/fixtures/ 内
onConflict: reject            # 同一坐标出现两次：reject（默认，整批拒绝并列出冲突）/ replace（后写覆盖）
unknownMaster: confirm        # 找不到的主数据：confirm（默认，整体不落库交人）/ create（只在明确知道是全新子公司时用）
onEmptyMeasure: skip          # 值格为空：skip（默认，空不是 0，也不是一条事实）/ null（照样写一行、金额 NULL）
sheets:
  - name: Sheet               # 精确 sheet 名
    blocks:
      - anchor: D2            # 数据区左上角（第一个值格）。写错 → 大概率 NO_DATA_ROWS 或整块错位
        rows:                 # 行方向标签列，可多列
          - { col: A, dim: company }
          - { col: C, dim: metric }
        values:
          columns: [D, E, G]  # ★ 值列必须显式列出，不自动推断（自动推断列族出过一次静默错位）
          headerRow: 1        # 值列表头所在行，默认 = 锚点的上一行。指向数据行 → 直接 error
          periodTypeFromHeader: { 本年累计: 本年累计, 本年累计(上年): 去年同期累计, 本月数: 单月 }
          # 表头既不在映射里、又没在 periodTypes 里给出 → error，并列出全部未映射的表头
          periodTypes: [...]  # 或按位置一对一地给
          skip:
            - { columns: [F, J], why: 同比%/上年同期列库里没有对应口径 }
          measure: amount
        keys:
          - { col: B, as: period }   # 行内的期数列（如每行都写着 2026-06）
        facts:                # ★ 网格之外的固定键。**先确认它真的不在网格里**：
          company: { literal: 华东子公司 }   # 一个文件一家公司时用 literal；
          # { cell: A2 } 是"名字写在某个固定格子里"（格子空 → FACT_CELL_EMPTY，引擎不猜）。
          # ★ 反例：整列都是公司名的（全集团一张表）**不要**用 facts —— 那是 rows 里的一列，见 §4 ①
        drop:                 # 不接入的行
          labels: [合计, 小计]
          prefixes: ['其中：']
```

**几条硬判据**（都是 error，不是提醒）：

- 行键重复（同一块里两行的行键**完全一样**）→ `ROWKEY_DUPLICATE_IN_FILE`。★ 行键 = `rows` 里**所有**列的组合 **+ `keys` 里的期数**（有 keys 时）。A 列是公司、C 列是指标时，「华东+营业收入」与「华南+营业收入」不是重复（跨公司同名指标是正常的）；长表里同一家公司同一指标的 **12 个月也不是重复**（期数各不同，期数算进行键）。
- 坐标重复（展开后同一坐标被写两次）→ 按 `onConflict` 处理，默认拒绝。
- 带公式的行（合计/小计）没被 `drop` 排掉 → error。
- 行键列有空值 → 会建出无名主数据 → error（报错里点名是哪一维、哪些行）。
- 期数认不出 → `PERIOD_UNPARSEABLE`；`facts.<dim>.cell` 指向空格 → `FACT_CELL_EMPTY`。
  ★ 认得的写法：`2026-06` / `2026/6` / `2026.6` / `2026年6月` / `202606`，**以及完整日期** `2026-06-01` / `2026/6/1` / `2026年6月30日`（含带时间的）。集团导出的「财务期」常常就是一个具体日子。
  ⚠️ 期数列如果是**日期格或数字格**（不是文本），会报 `PERIOD_CELL_NOT_TEXT` —— 接入层只从文本读期数，请把那一列设成文本。**不要**指望引擎按 Excel 序列号猜年份（旧长表路径就是这么静默写出 4617 年的）。
- **期数可以逐行不同**（长表：一行一条事实、期数在某一列）→ 报一条 **warn** `PERIOD_PER_ROW`，按每行各自的期数落库。只有当一个 block 本该整块同一个期（宽表模板每行都重复写当期）时，这条提醒才意味着 `keys.col` 可能指错了列。
- 整块没有一个值格有数 → 一行都不落库（`空 ≠ 0`），并额外给一条 warn `SOURCE_LOOKS_EMPTY`：「这个源看起来是一份空模板，结构能读出来（行标签/值列/期数），但没有坐标能落库」。**把这条原话说给用户**——别让人以为"导入成功过"。
- 值列里有不是数字的格子（`1,234` / `12%` / `（5,000）` / `N/A`）→ `MEASURE_NON_NUMERIC`：引擎不把它们当 0、也不当空。

## 4. 两个真实实例（真模板上踩过的）

**① 全集团一张表：公司名在 A 列（公司财务报表模板的默认形状）。** A1 表头写「单位」（= 单位名称），A2 往下每一行是**子公司名**，C 列是 130 个指标标签 —— 于是同一个指标名在每家子公司下都会重复出现。这时公司**不是**网格外的固定键，它就是行键的一列：

```yaml
rows:
  - { col: A, dim: company }   # 子公司（整列都有值 → 是"列"，不是 facts）
  - { col: C, dim: metric }    # 指标（跨公司同名，正常）
```

判据只有一条：**拿不准是"列"还是"网格外"，先 `look_at_source` 看那一列有没有值 —— 整列都有值就是列。** 行键是所有 rows 列的组合，所以「华东+营业收入」和「华南+营业收入」是两个坐标、不报重复；同一家公司里同一个指标出现两次才报 `ROWKEY_DUPLICATE_IN_FILE`，报错会点出完整行键（「公司=华东子公司 / 指标=营业收入」在第 2、8 行）。

> ★ 这里踩过一次真实的坑：只看这份空模板的 A 列整列为空，就断定"公司名不在网格里"，把公司写成了 `facts.company`。**空模板的列本来就是空的** —— 结论不能从"现在没数据"推出来，要问人、或等有数据的文件。用户当场纠正：「整个集团的数据都在同一个模板的表中，A 列是用于区分不同子公司的」。

**② 模板自己可能带缺陷。** 同一份模板第 89、90 行同名（「经营活动产生的现金流量净额」）→ 报表规格报「行标签重复…请先改模板」，接入规格报 `ROWKEY_DUPLICATE_IN_FILE`（同公司、同指标，确实是重复坐标）。**两条路都会拦**。这不是引擎的 bug，是引擎把人该发现的问题说出来了；不要为了让流程走下去而把 `drop` 调宽 —— 那会让一行的数静默消失。要确认的是它属于哪一种：模板笔误（改一行标签）还是本来就该拆成两行（各改成一个说清区别的名字）。

## 5. 报表规格：模板 → 出表

```text
get_template_schema  →  generate_spec  →  lint_spec  →  preview_spec  →  render_report
                       （产出草稿 + issues）
```

- `generate_spec` 的输出里每根轴都带 `source: template | guessed` 与 `dimSource`，还有 `period`（读自模板的期数）与 `guessed[]`。**`guessed` 非空时必须问人**，不要当它已定稿。
- 期数是**读**出来的（模板 B 列/年月列），不是猜的；`period: null` 说明模板里没有，`params` 里的 year/month 是默认值，**要把这件事说出来**。
- `draftValid: false` 时草稿不能当定稿用：**先解决 issues 再保存**（`/api/specs/save` 与 `parseSpec` 用同一份判据，改不动的东西保存一定失败）。
- 量纲维（`metric` / `period_type`）必须被钉住：`rows: company / cols: period_type` 却没有指标约束时，那一格会把多个指标的金额加成一个数（判例：返回 67283，真值 65198——同量级、格式正常、人不会怀疑）。

## 6. 不许绕过的事

- 不要为了"跑通"而放宽判据：`drop` 调宽、`onConflict: replace`、`unknownMaster: create`、`onEmptyMeasure: null` 都是**会静默改变数字**的开关。要用就先说清代价，再让人确认。
- 不要自己另写一份校验（例如在 YAML 里加"我确认过了"的字段）、也不要在对话里用相似度替代 `lint_*`。
- 落库前后的差异要能复述给用户：`dry_run_ingest` 的 `note` 与 `willCreate` 就是给这一步用的。
