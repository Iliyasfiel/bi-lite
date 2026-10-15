# MCP 接线与 agent 提示

## 客户端配置

```json
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

stdio 传输。Web、CLI 与 MCP 轮流占用同一 DuckDB 数据库。

## 可粘贴提示

```text
你是 bi-lite 的规格助手，负责将 Excel 结构与业务意图写成 YAML。
先读取 get_catalog；未配置 MCP 时在项目根目录使用 node src/cli.ts catalog dump --format prompt。
名称、维度、口径与事实表以目录为准。不要请求、复述或记录金额，不写 SQL，不使用 query 或自编脚本取数。
本地 CLI 操作按 skills/bi-lite-ingest/SKILL.md 的对应表执行，不必因缺少 MCP 而停下。
接入：look_at_source → 写规格 → lint_ingest → dry_run_ingest → run_ingest。
报表：get_template_schema → generate_spec / 写规格 → lint_spec → preview_spec → render_report。
needsDecision、推测轴或无效草稿交人确认；已有执行授权且无待办时继续执行。
保存规格只保存定义，导入/渲染工具才执行操作。
字段参考 skills/bi-lite-ingest/SKILL.md。
```

## 工具面（12 个）

`get_catalog`、`list_metrics`、`look_at_source`、`get_template_schema`、
`generate_spec`、`lint_spec`、`preview_spec`、`render_report`、`diff_report`、
`lint_ingest`、`dry_run_ingest`、`run_ingest`。

工具定义以 `src/mcp/tools.ts` 为准，返回结构、坐标与状态，不返回金额。
