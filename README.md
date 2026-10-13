# bi-lite

轻量的本地 BI 引擎：把不同形态的 Excel 按 YAML 规格导入 DuckDB，再按指定模板生成报送 Excel。
主要目标是模板填表报送；查询与图表是辅助能力。数据与计算留在本机。

## 开始使用

需要 Node ≥22.6，无构建步骤、无外部数据库服务。

```bash
npm install --cache /tmp/bi-lite-npm-cache
npm run fixtures --cache /tmp/bi-lite-npm-cache
npm start --cache /tmp/bi-lite-npm-cache
```

打开 http://127.0.0.1:4319 。示例源与空白模板由 `fixtures` 生成在 `test/fixtures/`。
`ingest/月度经营接入.yaml` 与 `specs/月度保送表.yaml` 是配套示例。

导入流程：选源文件 → 编写或加载接入 YAML → 校验、试运行 → 确认主数据 → 执行导入。
保存到 `ingest/` 只保存规格；点击执行导入或运行 CLI 接入命令才会进库。
出表流程：选空白模板 → 编写或生成报表 YAML → 预览 → 导出。

## 主要功能

- 接入长表、宽表和网格 Excel，按规格映射主体、期数、指标与度量。
- 主数据名称归一与人工确认；导入批次、覆盖记录、原始着陆、标准化与重放。
- 按 YAML 声明生成业务表；`plan` 查看结构变化、`apply` 应用、`rebuild` 重建派生数据。
- 财务窗口口径、场景/币种筛选与换算；查询展示实际采用的范围。
- 模板生成报表规格草稿、规格预览、Excel 导出，保留原模板格式与公式。
- Web、CLI、MCP 共用引擎。agent 产出规格，工具只返回结构与执行结果描述。

Web、CLI、MCP 应轮流使用同一数据库；Web 默认只监听本机。

## CLI 使用

在仓库根目录运行 `node src/cli.ts <命令>`，用 `--help` 查看参数。
CLI 适合人工操作、脚本和本地 agent；结果通常以 JSON 写到 stdout，日志写到 stderr。

| 命令 | 功能 |
|---|---|
| `ingest lint / dry-run / run` | 校验接入规格、试运行、执行导入 |
| `validate` | 校验接入或报表 YAML |
| `render` | 按报表规格填充模板，输出 Excel；只返回路径与状态 |
| `query` | 按指标、口径与范围查询精确值，供人使用 |
| `catalog dump / show` | 查看业务成员与模型结构 |
| `agent look / template` | 查看源或模板结构，数字格只返回类型标记 |
| `agent generate / preview / diff` | 推断报表草稿、预览坐标、比较规格差异 |
| `plan / apply / rebuild` | 查看与应用模型变化，重建派生数据 |
| `replay / compact / skill export` | 重放对拍、整理归档、导出操作元数据 |

导入并出表的示例：

```bash
node src/cli.ts ingest lint ingest/月度经营接入.yaml
node src/cli.ts ingest dry-run ingest/月度经营接入.yaml
node src/cli.ts ingest run ingest/月度经营接入.yaml
node src/cli.ts render specs/月度保送表.yaml --out 月度报送.xlsx
```

执行导入前确认试运行中的主数据待办；示例需先运行 `npm run fixtures`。
报表写到 `output/`。agent 使用结构与状态命令，不使用返回精确金额的 `query`。
当前 `agent preview` 支持坐标锚点；定义名称锚点可在 Web 或 MCP 中预览。

## Agent 接入配置

### 安装 skill（以 Codex 为例）

在仓库根目录执行，将现有手册注册为项目 skill：

```bash
mkdir -p .agents/skills
ln -s ../../skills/bi-lite-ingest .agents/skills/bi-lite-ingest
```

链接已存在时无需重建。Codex 从 `.agents/skills/` 发现 skill，支持目录符号链接。
在本项目中打开对话，输入 `$bi-lite-ingest`，或明确要求“使用 bi-lite-ingest 接入这个 Excel”。
如果尚未显示，重新打开客户端。其他 agent 按其 skill 目录约定安装同一份手册。

现有 skill 手册按 MCP 工具流程编写，按该流程使用时需配置 MCP。
本地 agent 也可调用上述 CLI 命令，无需启动 MCP 服务；skill 本身只提供操作说明。
手册在 `skills/bi-lite-ingest/SKILL.md`，可粘贴提示在同目录的 `AGENT-PROMPT.md`。

### 配置 MCP（以 Codex 为例）

在 `~/.codex/config.toml` 中添加，替换为实际仓库绝对路径：

```toml
[mcp_servers.bi-lite]
command = "node"
args = ["/绝对路径/bi-lite/src/mcp/server.ts"]
cwd = "/绝对路径/bi-lite"
```

如果客户端启动环境找不到 Node，将 `command` 换成 Node 可执行文件的绝对路径。
配置后运行 `codex mcp list` 检查是否注册，再在对话中调用 `get_catalog` 验证连接。
服务端由客户端启动，采用 stdio，不需要额外启动 HTTP 服务。
**使用同一数据库前先停止 Web 或其他 MCP 进程。** `cwd` 必须是仓库根目录，规格与模型使用相对路径。

使用 `mcpServers` 配置格式且支持 `cwd` 的其他客户端，可使用：

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

Codex 的 skill 发现与 MCP 配置格式分别参考官方 [Skills](https://developers.openai.com/codex/skills)
和 [MCP](https://developers.openai.com/codex/mcp) 文档。

### 选择接入方式

本地 agent 可用 skill 配合 CLI 完成结构查看、规格编写、导入与报表生成。
MCP 用于客户端的工具调用接入，现有配置继续可用。
两种入口共用引擎；数据访问权限由宿主控制。

## 项目状态

第一版主链路已完成。第二版优先做 YAML 指标定义、接入单位/符号转换与模板复用。
设计见 [需求与架构](docs/需求与架构.md)，状态见 [开发计划](docs/开发计划.md)。
开发工作区与测试约定见 [AGENTS.md](AGENTS.md)。
