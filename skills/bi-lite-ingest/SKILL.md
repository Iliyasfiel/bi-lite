---
name: bi-lite-ingest
description: 将源 Excel 或空白报送模板转换为 bi-lite 接入/报表 YAML 规格。
---

# bi-lite 规格操作手册

接入规格保存到 `ingest/`，报表规格保存到 `specs/`。保存规格不执行落库或渲染。
agent 只编写规格；金额读取、计算、落库、填表由本地引擎完成。
不要向用户索要金额，不复述或记录用户贴来的金额。数字格在工具中只显示 `{num:true}`。

## 工具面（12 个）

| 用途 | 工具 |
|---|---|
| 元数据 | `get_catalog`、`list_metrics` |
| 源与模板结构 | `look_at_source`、`get_template_schema` |
| 报表 | `generate_spec`、`lint_spec`、`preview_spec`、`render_report`、`diff_report` |
| 接入 | `lint_ingest`、`dry_run_ingest`、`run_ingest` |

先读取目录，名称、目标事实表与口径以目录为准。只通过以下引擎入口操作，不用 SQL、自编脚本或 `query` 命令读取金额。

## 本地 CLI（未配置 MCP 时使用）

优先使用已安装的全局 `bilite`。在目标 BI 工作区根目录运行，或在命令前加 `--workspace <工作区绝对路径>`。
新工作区用 `bilite init <目录>` 建立空目录；财务模型按需用 `bilite init <目录> --preset finance` 补入。
初始化不复制业务指标、源文件或数据库。Web 运行时 CLI 自动转交数据库操作；MCP 暂须单独占库。

| MCP 操作 | 对应 CLI |
|---|---|
| 目录 | `bilite catalog dump --format prompt` |
| 源结构 | `bilite agent look <源.xlsx>` |
| 模板结构 | `bilite agent template --template <模板.xlsx>` |
| 生成草稿 | `bilite agent generate --template <模板.xlsx>` |
| 校验/预览 | `bilite validate <规格.yaml>`、`bilite agent preview <规格.yaml>` |
| 接入 | `bilite ingest lint <规格.yaml>`、`bilite ingest dry-run <规格.yaml>`、`bilite ingest run <规格.yaml>` |
| 填表 | `bilite render <规格.yaml> --out <文件.xlsx>` |

所有相对路径属于所选 BI 工作区，不属于引擎安装目录或当前聊天目录。CLI 的 agent 命令、接入结果和填表结果只返回结构、计数、路径与状态；不要改用返回精确值的查询入口。
`bilite skill install` 将手册副本装入工作区 `.agents/skills/bi-lite-ingest`；`--scope user` 装入用户的 `CODEX_HOME/skills`。
安装不配置 MCP；已有副本默认保留，确认更新时用 `--force`。引擎升级不会自动覆盖手册中的用户修改。

## 接入流程与字段

`get_catalog` → `look_at_source` → 写 YAML → `lint_ingest` → `dry_run_ingest` → 确认后 `run_ingest`。
lint 检查规格，dry-run 读取源但不写库，返回形状、计数和主数据待办。
有 `needsDecision` 时把候选与 `why` 给人确认；已有授权且无待办时可执行导入。

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

`get_catalog` → `get_template_schema` → `generate_spec` 或写 YAML → `lint_spec` → `preview_spec` → `render_report`。
模板推断的 guessed 轴与无效草稿交人确认。预览只返回坐标，不返回金额。

报表声明 `id`、`template`、`fact`（可省略，默认财务表）、`params` 与 `sheets[].blocks[]`。
区块包含 `anchor`、`rows`、`cols`、`value`、`scope`；轴使用 `dim` 与 `order`。
指标与口径必须确定，累计需指定期末，参数要实际被引用。
窗口、场景和币种以工作区模型声明为准；使用财务预设时见 `models/fact_finance.yml`。
模板格式与公式由引擎保留，精细排版在人使用的 Excel 中完成。

集团合并主体与子公司是不同观察范围；不要将合并主体与其子公司再次加总。
源表同比等派生列不作为基础金额导入；导出后可在 Excel 中重算模板原有公式。
