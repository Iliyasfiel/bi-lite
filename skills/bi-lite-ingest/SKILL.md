---
name: bi-lite-ingest
description: 基于空白结构样表与业务说明编写 bi-lite 规格草稿，检查含数据文件、确认语义，并交接用户在 Web 手动导入。
---

# bi-lite 规格操作手册

agent 只协助编写和解释规格。真实源文件留在本机，用户在 Web 页面手动试运行和导入。
不要向用户索要金额、含数据文件或数据截图，不复述、记录或将其写入 YAML。

## 三道停止条件

1. **先检查文件，再看结构。** 每个 Excel 必须先通过 `bilite agent template --template <文件>` / `get_template_schema` 的本地全工作簿检查；接入样表也一样。成功响应须有 `safety.checked: true` 和 `safety.policy: blank-structure-v2`，缺少标志即视为旧工具，不继续。不能先用通用文件读取器、表格 skill、Python、解压/XML、截图/OCR 或其他工具读取内容。检查未通过、检查范围不足或工具版本不支持检查时立即停止，不生成或修改草稿，也不换工具绕过。`look_at_source` / `agent look` 同样只接受空白结构样表，不能用来查看带数据源。
   检测到实存数值（包括零）、单元格缓存值、金额或百分比样式的数字文本，或无法判断的内容，告知用户：“检测到文件可能包含业务数据，已停止处理。请不要继续向聊天发送数据，请在本机清空数据后提供结构样表；真实源文件仅在 Web 中手动选择。”不附带任何单元格内容。公式常量只作为“有公式”的结构标记，不回传公式正文；普通标签中的年份、期数等数字可以保留。如果文件已被上传到聊天，说明本次停止无法撤回可能已发生的模型接触。
2. **草稿后必须等待确认。** 安全检查通过后才能读取目录和结构、生成草稿。未确认草稿仅放 `drafts/` 或聊天中的结构提案，不写入引擎扫描的 `ingest/`、`specs/`、`models/`、`metrics/`，不上传/注册到 Web。逐项说明指标含义、主体与合并范围、行列映射、期间/累计、场景、币种、单位/符号、空值/重复处理、模板公式保留方式；标明不确定、相互矛盾及待用户选择的解释，不自动补业务假设。提出具体问题并停止等待用户明确确认这一版。没有 guessed、静态校验通过、“帮我处理/测试”或旧授权都不等于本次草稿已确认。修订语义后重新确认。
3. **确认草稿也不授权 agent 导入。** 用户确认后才可将相应规格保存到 `ingest/` 或 `specs/`，再向用户交接 Web 操作。agent 不调用 `dry_run_ingest`、`run_ingest`、CLI 的 `ingest dry-run/run`、`replay`，不代点 Web 的上传、试运行、确认导入，也不以脚本、SQL、HTTP 或更改 `unknownMaster`/`onConflict` 绕过。业务数据的试运行、主数据决定和正式导入均由用户亲自在 Web 完成。

本 skill 与本地检查是止损措施，不是宿主隔离或对历史泄露的补救。空表检查不保证识别图片、批注、嵌入附件等全部载体；模板中这些内容须由用户在本机先移除，不能因检查通过而宣称文件绝对安全。

## 工具面（12 个）

| 用途 | 工具 |
|---|---|
| 元数据 | `get_catalog`、`list_metrics` |
| 源与模板结构 | `look_at_source`、`get_template_schema` |
| 报表 | `generate_spec`、`lint_spec`、`preview_spec`、`render_report`、`diff_report` |
| 接入 | `lint_ingest`；`dry_run_ingest`、`run_ingest` 为已禁用的兼容入口，不调用 |

先读取目录，名称、目标事实表与口径以目录为准。只通过以下引擎入口操作，不用 SQL、自编脚本或 `query` 命令读取金额。

## 本地 CLI（未配置 MCP 时使用）

优先使用已安装的全局 `bilite`。在目标 BI 工作区根目录运行，或在命令前加 `--workspace <工作区绝对路径>`。
新工作区用 `bilite init <目录>` 建立空目录；财务模型按需用 `bilite init <目录> --preset finance` 补入。
初始化不复制业务指标、源文件或数据库。Web 运行时 CLI 自动转交数据库操作；MCP 暂须单独占库。

| MCP 操作 | 对应 CLI |
|---|---|
| 目录 | `bilite catalog dump --format prompt` |
| 空白样表结构 | `bilite agent look <空白样表.xlsx>`（先完成空表检查） |
| 模板结构 | `bilite agent template --template <模板.xlsx>` |
| 生成草稿 | `bilite agent generate --template <模板.xlsx>` |
| 校验/预览 | `bilite validate <规格.yaml>`、`bilite agent preview <规格.yaml>` |
| 接入规格静态检查 | `bilite ingest lint drafts/<规格.yaml>` |
| 数据试运行/导入 | agent 不执行；交给用户在 Web 手动完成 |
| 填表 | 仅用户已确认报表规格且另行明确要求导出时，才使用 `render_report` / `bilite render` |

所有相对路径属于所选 BI 工作区，不属于引擎安装目录或当前聊天目录。CLI 的 agent 命令、接入结果和填表结果只返回结构、计数、路径与状态；不要改用返回精确值的查询入口。
`bilite skill install` 将手册副本装入工作区 `.agents/skills/bi-lite-ingest`；`--scope user` 装入用户的 `CODEX_HOME/skills`。
安装不配置 MCP；已有副本默认保留，确认更新时用 `--force`。引擎升级不会自动覆盖手册中的用户修改。

## 接入流程与字段

空白样表检查 → `get_catalog` → 空白样表结构 → `drafts/` 中写 YAML → `lint_ingest` → 说明语义、歧义和矛盾 → 等待用户确认 → 保存已确认规格 → 交接 Web。
静态 lint 仅检查规格结构，不证明业务含义正确。不要执行读取真实源文件的数据试运行。

```yaml
id: 月报接入
source: data/uploads/月报.xlsx
target: fact_finance
onConflict: reject
unknownMaster: confirm
onEmptyMeasure: skip
sheets:
  - name: 月报
    blocks:
      - anchor: D2
        rows:
          - { col: A, dim: company }
          - { col: C, dim: metric }
        values:
          columns: [D, E]
          periodTypes: [本年累计, 单月]
        keys:
          - { col: B, as: period }
          - { as: scenario, value: 实际 }
          - { as: ccy, value: 人民币 }
        drop: { labels: [合计, 小计] }
```

值列显式列出，可用 `skip` 排除派生列；口径可由表头映射或按列顺序给定。
固定主体/指标/期数可用 `facts` 的 `literal` 或 `cell` 指定。
`values.transforms` 按指标定义将源单位转换为标准单位。百分数和比率不同：单位 `%` 的 57.77 表示 57.77%，不能再次乘以 100。
期数字符串支持年月与完整日期；Excel 日期格须声明 `type: date`，只支持 1900 日期系统。
正式源路径放 `data/`，测试示例放 `test/fixtures/`。名称、空值、冲突问题按诊断处理。

## 报表流程与字段

空表检查 → `get_catalog` / `get_template_schema` → `generate_spec` 或写草稿 → `lint_spec` → 解释全部语义 → 等待用户确认。
确认后才可保存/注册报表规格，必要时用 `preview_spec` 核对坐标；不因此自动渲染或导入。

## Web 交接

告知用户工作区绝对路径和已确认的规格文件名，建议自行运行 `bilite --workspace <目录> web`。
在“数据导入”页由用户选择本机源 Excel、载入接入规格、点击“试运行”、核对单位/期间/范围和主数据候选，再亲自点击“确认导入”。
如果只有报表规格而无接入规格，明确缺少接入规则，不把报表规格当接入规格，不自动创建或导入指标/事实。
不要要求用户把源数据发回聊天来排错；可请求不含金额的错误代码、坐标或结构说明。

报表声明 `id`、`template`、`fact`（可省略，默认财务表）、`params` 与 `sheets[].blocks[]`。
区块包含 `anchor`、`rows`、`cols`、`value`、`scope`；轴使用 `dim` 与 `order`。
指标与口径必须确定，累计需指定期末，参数要实际被引用。
窗口、场景和币种以工作区模型声明为准；使用财务预设时见 `models/fact_finance.yml`。
模板格式与公式由引擎保留，精细排版在人使用的 Excel 中完成。

集团合并主体与子公司是不同观察范围；不要将合并主体与其子公司再次加总。
源表同比等派生列不作为基础金额导入；导出后可在 Excel 中重算模板原有公式。
