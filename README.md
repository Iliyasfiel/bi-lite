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

打开已保存报表时，页面按规格默认值生成全部参数（包括年份、月份、口径及自定义参数）。
预览展示实际取数范围和默认场景/币种，比率显示为百分比。修改参数后须重新预览，导出沿用已预览的参数。
导入确认显示经过空值处理后的候选值格数，并明确空值是跳过还是写入 NULL；该计数在事实去重前计算。

## 主要功能

- 接入长表、宽表和网格 Excel，按规格映射主体、期数、指标与度量。
- 主数据名称归一与人工确认；导入批次、覆盖记录、原始着陆、标准化与重放。
- 按 YAML 声明生成业务表；`plan` 查看结构变化、`apply` 应用、`rebuild` 重建派生数据。
- 财务窗口口径、场景/币种筛选与换算；查询展示实际采用的范围。
- YAML 指标身份、单位/分类与聚合后公式；显式接入单位转换、反号与批次快照重放。
- 模板生成报表规格草稿、规格预览、Excel 导出，保留原模板格式与公式。
- Web、CLI、MCP 共用引擎。agent 产出规格，工具只返回结构与执行结果描述。

Web、CLI、MCP 应轮流使用同一数据库；Web 默认只监听本机。

## YAML 指标定义

`metrics/*.yml` 集中维护指标；示例见 `metrics/finance.yml`。`id` 是稳定业务编号，
名称可改，已有指标和事实关联会保留。`unit` 是标准单位，源单位通过显式的接入转换规则统一。

```yaml
metrics:
  - id: revenue
    name: 营业收入
    unit: 元
    category: 主要指标
  - id: operating_cost
    name: 营业成本
    unit: 元
    category: 主要指标
    direction: negative
  - id: gross_profit
    name: 毛利润
    unit: 元
    category: 盈利指标
    calculation: revenue - operating_cost
```

公式引用业务编号，支持四则运算、取余和括号，可引用其他派生指标。
先按同一范围汇总基础指标，再计算结果；缺操作数或除零显示为空。
派生指标只接受 `sum` 聚合，不接收源金额，不能额外按指标过滤或分组。
`fact` 默认 `fact_finance`，不支持跨事实表公式；单位与业务含义由定义编写者确认。
可用 `aliases: [主营收入]` 声明已确认的别名。

```bash
node src/cli.ts validate metrics/finance.yml
npm run fixtures
node src/cli.ts ingest run ingest/月度经营接入.yaml
node src/cli.ts render specs/盈利指标表.yaml --out 盈利指标.xlsx
```

校验会检查同目录下全部指标文件及跨文件引用，不写数据库。
正常启动入口时事务同步主数据；修改定义后重启正在运行的 Web/MCP。
存量名称/别名对应多个指标时会拒绝同步，需要先人工归并。
属性变更保留历史；可用 `effectiveFrom: "2026-10-15"` 指定生效日，省略为当天，
变更日期必须晚于当前版本起点。删除声明不删除历史主数据和旧别名。

模板中的指标可用编号或名称引用；金额、百分比格式由模板分别设置。

## 多模板复用指标

报表规格引用 `metrics/` 中的指标定义，不在模板内复制业务公式。目前支持以下派生指标布局：

| 布局 | 固定范围写法 | 示例 |
|---|---|---|
| 指标行 × 口径列 | 指标与口径分别在轴上声明 | `specs/盈利指标表.yaml` |
| 公司行 × 指标列 | `value.periodType: 本年累计` | `specs/公司盈利对比表.yaml` 第一个工作表 |
| 公司行 × 口径列 | `value.metric: gross_margin` | 同一示例的第二个工作表 |

固定绑定可用 `{{参数}}` 替换，不能与同一维度的轴或过滤重复指定。
累计口径仍须在 `scope.time` 明确报告年/月；未知口径、calculator 口径或冲突绑定会被拒绝。
比率始终先按公司汇总操作数再计算，保留模板预置标签和各列数字格式。

```bash
node src/cli.ts render specs/公司盈利对比表.yaml --out 公司盈利对比.xlsx
node src/cli.ts render specs/公司盈利对比表.yaml --param periodType=去年同期累计 --out 公司同期对比.xlsx
```

这些示例共用同一批导入数据，只需生成示例模板并导入一次。CLI/MCP 结构预览与导出复用编译器，
能展示实际绑定的指标/口径及标签，不执行查询、不返回金额。

## 接入单位与符号转换

在接入区块的 `values` 中声明规则：

```yaml
transforms:
  - fromUnit: 万元
    toUnit: 元
  - metrics: [operating_cost]
    fromUnit: 万元
    toUnit: 元
    sign: negate
```

不写 `metrics` 的规则用于整个区块；指标专属规则覆盖它。示例将源金额由万元转为元，
并将源表中负数记录的成本反号；`direction: negative` 只是指标评价方向，不会自动反号。
完整示例见 `ingest/万元经营接入.yaml`，配套源由 `npm run fixtures` 生成，
可替代原月度接入规格使用，两个示例含相同业务数据，应选一种导入。

支持元/千元/万元/亿元之间、%与比率之间转换；相同单位可只做反号。
源为 Excel 百分比数值 `0.15` 时应声明比率；源为数字 `15` 表示百分之十五时才声明 `%`。
目标单位须与指标定义一致，未声明指标使用事实度量单位。不会根据显示格式猜单位，不做汇率换算。
未匹配规则的值保持原样，空值保持 skip/null 设置。

默认保留符号并拒绝超出目标 DECIMAL 精度的结果；需舍入时显式设置 `rounding: half-up`，
正负数均按绝对值四舍五入。溢出和无法无损传递的结果拒绝导入。
试运行展示转换规则和作用格数，不返回金额。

每批导入保存规格、指标和模型快照。`replay` 默认使用批次快照与库内原始数据，
当前 YAML 只用于确定规格 id；`--source` 可指定当前文件做对拍。结果中的 `specSource`
说明采用了快照还是传入规格；无快照的旧批次继续按传入规格重放。

## CLI 使用

在仓库根目录运行 `node src/cli.ts <命令>`，用 `--help` 查看参数。
CLI 适合人工操作、脚本和本地 agent；结果通常以 JSON 写到 stdout，日志写到 stderr。

| 命令 | 功能 |
|---|---|
| `ingest lint / dry-run / run` | 校验接入规格、试运行、执行导入 |
| `validate` | 校验指标定义、接入或报表 YAML |
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
`agent preview` 支持坐标锚点和模板中的定义名称锚点，与 MCP 复用预览逻辑。

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

第一版主链路已完成，第二版四项优先功能已完成首批交付：YAML 指标定义、单位/符号转换、三种派生指标模板布局与主链路体验。
当前进入真实源文件与报送模板的试用验收阶段；已验证示例流程和本地 Web 交互，真实业务验收仍待完成。
设计见 [需求与架构](docs/需求与架构.md)，状态见 [开发计划](docs/开发计划.md)。
开发工作区与测试约定见 [AGENTS.md](AGENTS.md)。
