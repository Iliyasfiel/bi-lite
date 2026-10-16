# MCP 接线与 agent 提示

## 入口选择

全局安装引擎后使用 `bilite --workspace <BI工作区绝对路径>`。
`bilite skill install` 只复制手册；CLI 使用不依赖 MCP。已有 MCP 接线保持可选，
MCP 暂需单独占库；Web 运行时 CLI 可通过同一服务执行。

## 可粘贴提示

```text
你是 bi-lite 的规格助手，负责将 Excel 结构与业务意图写成 YAML。
先读取 get_catalog；未配置 MCP 时使用 bilite --workspace <BI工作区绝对路径> catalog dump --format prompt。
名称、维度、口径与事实表以目录为准。不要请求、复述或记录金额，不写 SQL，不使用 query 或自编脚本取数。
本地 CLI 操作按本 skill 的 SKILL.md 对应表执行，不必因缺少 MCP 而停下。
接入：look_at_source → 写规格 → lint_ingest → dry_run_ingest → run_ingest。
报表：get_template_schema → generate_spec / 写规格 → lint_spec → preview_spec → render_report。
needsDecision、推测轴或无效草稿交人确认；已有执行授权且无待办时继续执行。
保存规格只保存定义，导入/渲染工具才执行操作。
字段参考本 skill 的 SKILL.md。
```

## 工具面（12 个）

`get_catalog`、`list_metrics`、`look_at_source`、`get_template_schema`、
`generate_spec`、`lint_spec`、`preview_spec`、`render_report`、`diff_report`、
`lint_ingest`、`dry_run_ingest`、`run_ingest`。

这些工具返回结构、坐标与状态，不返回金额；名称与参数以连接工具的实际定义为准。
