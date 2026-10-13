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

## 工作区结构

| 目录 | 用途 |
|---|---|
| `src/ingest/`、`src/land/` | 源文件着陆、接入与重放 |
| `src/spec/`、`src/semantic/` | 规格解析、查询编译与语义计算 |
| `src/render/` | Excel 模板填充与图表渲染 |
| `src/gen/`、`src/db/`、`src/meta/` | YAML 模型生成、数据库与元数据 |
| `src/web/`、`src/server.ts` | 本地 Web 界面与 HTTP 入口 |
| `src/cli.ts`、`src/mcp/` | CLI 与 agent 入口 |
| `models/` | 表结构、维度、窗口口径、聚合与桥接声明 |
| `ingest/`、`specs/`、`templates/` | 接入规格、报表规格、空白模板 |
| `skills/bi-lite-ingest/` | agent 操作手册与 MCP 配置 |
| `docs/` | 架构与功能状态 |
| `test/` | 主链路验收、假数据生成器 |
| `data/`、`output/` | 本地数据与输出，不进版本库 |

## 主要功能

- 接入长表、宽表和网格 Excel，按规格映射主体、期数、指标与度量。
- 主数据名称归一与人工确认；导入批次、覆盖记录、原始着陆、标准化与重放。
- 按 YAML 声明生成业务表；`plan` 查看结构变化、`apply` 应用、`rebuild` 重建派生数据。
- 财务窗口口径、场景/币种筛选与换算；查询展示实际采用的范围。
- 模板生成报表规格草稿、规格预览、Excel 导出，保留原模板格式与公式。
- Web、CLI、MCP 共用引擎。agent 产出规格，工具只返回结构与执行结果描述。

CLI 帮助：`node src/cli.ts --help`。
Web、CLI、MCP 应轮流使用同一数据库；Web 默认只监听本机。

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

**当前 skill 使用 MCP 工具，需要同时完成下方 MCP 配置；单独安装 skill 不会提供执行能力。**
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

### skill + CLI 与 MCP 的定位

第二版建议以 **skill + agent 专用 CLI** 作为本地 agent 的主入口：
skill 描述流程，短命 CLI 执行确定性操作；MCP 保留为工具客户端的可选适配层。
两种入口共用引擎与操作实现，不发展两套业务功能。

当前 CLI 面向人与脚本，`query` 返回精确值，不应直接提供给业务 agent。
MCP 已有源结构读取、模板推断、坐标预览等操作，CLI 尚未完整对应这些能力。
因此现阶段使用 **skill + MCP**；切换前应补齐 agent CLI，复用现有工具调用与无金额返回逻辑。
skill 是操作说明，数据访问权限仍需由宿主限制；换成 MCP 也不会限制 agent 已拥有的 shell 或文件权限。

## 开发与验收

```bash
npm run e2e --cache /tmp/bi-lite-npm-cache
```

少量验收覆盖模型启动、试运行、导入/重放、查询口径、模板导出与入口边界。
测试在临时工作区生成假数据，结束后清理，不修改当前项目数据库。
每次开发仅验证关键节点，具体约定见 [AGENTS.md](AGENTS.md)。

第一版主链路已完成。第二版优先做 YAML 指标定义、接入单位/符号转换与模板复用。
设计见 [需求与架构](docs/需求与架构.md)，状态见 [开发计划](docs/开发计划.md)。
