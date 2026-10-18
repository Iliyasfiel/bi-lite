# bi-lite

轻量的本地 BI 引擎：把不同形态的 Excel 按 YAML 规格导入 DuckDB，再按指定模板生成报送 Excel。
主要目标是模板填表报送；查询与图表是辅助能力。数据与计算留在本机。

术语按“接入 / 导出 × 规格 / 报表”统一：接入规格定义读取规则，接入报表是含数据的源 Excel；
导出规格定义取数与填充规则，导出报表是生成的含数据 Excel。规格本身无业务数据，以 YAML 表达语义，
可关联空白 Excel 结构样表。完整定义见 [统一术语](docs/需求与架构.md#统一术语)。

仓库提供5主体、6指标、18期的可重建经营测试包，按需选择 [18期经营测试](docs/18期经营测试.md) 恢复后试用，不是空工作区的默认内容。
下方的小型示例使用另一组指标；自动验收使用独立临时副本，不修改本地测试源或业务库。

## 开始使用

开发环境基线、安装和排障见 [CONTRIBUTING.md](CONTRIBUTING.md)；必读约定见 [AGENTS.md](AGENTS.md)。
开发直接运行 TypeScript，仅打包时转译 JavaScript，无外部数据库服务；最低 Node 和其他平台分发支持待确认。

```bash
npm ci
npm run doctor
npm start
```

打开 http://127.0.0.1:4319 。上述命令不恢复18期接入报表；需要示例时另行按测试说明显式准备。
原有小型示例由 `fixtures` 生成在 `test/fixtures/`，配套 `ingest/月度经营接入.yaml` 与 `specs/月度保送表.yaml`；使用方式与隔离说明见贡献指南。

导入流程：选源文件 → 编写或加载接入 YAML → 校验、试运行 → 确认主数据 → 执行导入。
保存到 `ingest/` 只保存规格；点击执行导入或运行 CLI 接入命令才会进库。
导出流程：选择已编写的导出规格及其空白 Excel → 本地预览 → 导出报表。
CLI 的 `bilite spec <Excel路径>` 已有连续制定与确认保存实现，目前属于开发预览：
完整语义读取和真实业务闭环尚未验收，Web 的统一制定交互仍待接入。
旧 agent generate 保留为有限规则推断。

打开已保存报表时，页面按规格默认值生成全部参数（包括年份、月份、口径及自定义参数）。
预览展示实际取数范围和默认场景/币种，比率显示为百分比。修改参数后须重新预览，导出沿用已预览的参数。
导入确认显示经过空值处理后的候选值格数，并明确空值是跳过还是写入 NULL；该计数在事实去重前计算。

## 主要功能

- 接入长表、宽表和网格 Excel，按规格映射主体、期数、指标与度量。
- 主数据名称归一与人工确认；导入批次、覆盖记录、原始着陆、标准化与重放。
- 按 YAML 声明生成业务表；`plan` 查看结构变化、`apply` 应用、`rebuild` 重建派生数据。
- 财务窗口口径、场景/币种筛选与换算；查询展示实际采用的范围。
- YAML 指标身份、单位/分类与聚合后公式；显式接入单位转换、反号与批次快照重放。
- 有限规则推断导出规格草稿、规格预览、Excel 导出，保留原 Excel 格式与公式。
- Web、CLI、MCP 共用引擎。agent 产出规格，工具只返回结构与执行结果描述。

Web 运行时 CLI 转交同一持库服务；MCP 目前须单独占库。Web 默认只监听本机。

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
启动时事务同步主数据，Web 在串行操作开始时重读声明；MCP 修改定义后需重启。
存量名称/别名对应多个指标时会拒绝同步，需要先人工归并。
属性变更保留历史；可用 `effectiveFrom: "2026-10-15"` 指定生效日，省略为当天，
变更日期必须晚于当前版本起点。删除声明不删除历史主数据和旧别名。

模板中的指标可用编号或名称引用；金额、百分比格式由模板分别设置。

## 多模板复用指标

导出规格引用 `metrics/` 中的指标定义，不在模板内复制业务公式。目前支持以下派生指标布局：

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

## CLI 与网页共用

`bilite web` 前台启动服务；Web 运行时，CLI 会自动通过服务提交导入、出表、查询和模型命令，单一进程持有 DuckDB。正常停止或崩溃后 CLI 可继续独立使用。
`--port` 指定端口，`--no-open` 保持前台运行但不打开浏览器；默认打开浏览器，失败时保留服务并输出地址。空工作区可在网页按需添加财务基础模型。

## CLI 使用

`npm pack` 会先转译发布目录再生成安装包；真实 `.tgz` 安装后可直接使用全局 `bilite`。开发仓库仍可用 `npm link` 调试，代码更新后直接生效。

```bash
# 在任意目录，操作已有的 bi-lite 工作区
bilite --workspace ./my-bi agent preview specs/月报.yaml

# 或建立独立工作区，之后使用该目录自己的模型、指标和数据库
bilite init ./my-bi
bilite --workspace ./my-bi catalog dump --format prompt
```

`--workspace`（简写 `-C`）放在命令前；也可用 `BILITE_WORKSPACE` 环境变量指定工作区，未指定时从当前目录向上识别工作区标识。
初始化默认建立空工作区，不复制模型、指标、测试数据或数据库；`bilite init <目录> --preset finance` 补入受控财务模型。已有模型时预设补入会被拒绝，不会覆盖文件。
源文件、规格、模板、输出及默认数据库路径均相对所选工作区；先把源文件放入该工作区允许的目录（例如 `data/`）。
若设置了 `BILITE_DB`，数据库位置仍按该显式设置处理。Windows 新终端需能找到 npm 的全局命令目录。

可选安装 Codex 手册：`bilite skill install` 默认复制到所选工作区 `.agents/skills/bi-lite-ingest`；
`--scope user` 安装到 `CODEX_HOME/skills`（未设置时为 `~/.codex/skills`），不要求当前目录是工作区。
安装记录版本，不配置 MCP；已有文件默认拒绝覆盖，确认更新用 `--force`。更新只覆盖随包模板文件，其他自定义文件保留；链接目录须先由用户整理。
引擎更新不会自动修改已安装的手册。

仍可在仓库根目录运行 `node src/cli.ts <命令>`，用 `--help` 查看参数。
CLI 适合人工操作、脚本和本地 agent；结果通常以 JSON 写到 stdout，日志写到 stderr。

| 命令 | 功能 |
|---|---|
| `ingest lint / dry-run / run` | 校验接入规格、试运行、执行导入 |
| `validate` | 校验指标定义、接入或报表 YAML |
| `render` | 按导出规格填充模板，输出 Excel；只返回路径与状态 |
| `query` | 按指标、口径与范围查询精确值，供人使用 |
| `catalog dump / show` | 查看业务成员与模型结构 |
| `agent look / template` | 先检查空白结构样表；含实存数值、金额样式文本或检查失败时拒绝返回内容 |
| `agent generate / preview / diff` | 推断报表草稿、预览坐标、比较规格差异 |
| `plan / apply / rebuild` | 查看与应用模型变化，重建派生数据 |
| `replay / compact / skill export` | 重放对拍、整理归档、导出操作元数据 |
| `skill install` | 可选安装项目/用户级手册副本；`--force` 显式更新 |

开发验收入口与范围见贡献指南；`npm run e2e` 验证主链路，`npm run package:check` 验证真实安装包。

导入并出表的示例：

```bash
node src/cli.ts ingest lint ingest/月度经营接入.yaml
node src/cli.ts ingest dry-run ingest/月度经营接入.yaml
node src/cli.ts ingest run ingest/月度经营接入.yaml
node src/cli.ts render specs/月度保送表.yaml --out 月度报送.xlsx
```

执行导入前确认试运行中的主数据待办；示例需先运行 `npm run fixtures`。
报表写到 `output/`。agent 使用结构与状态命令，不使用返回精确金额的 `query`。
这些导入命令供本机用户手动执行。agent 不执行数据试运行/导入，应先检查空白样表、说明草稿语义并等待用户确认，再交接用户在 Web 手动导入真实源文件。
不要向聊天上传含业务数据的文件；本地检查无法撤回上传造成的模型接触，也不保证覆盖图片、批注、附件等内容。
`agent preview` 支持坐标锚点和模板中的定义名称锚点，与 MCP 复用预览逻辑。

`agent generate` 依赖工作区的业务目录推断区块。空目录或未支持的复合布局会返回
`status: needs-modeling`、结构投影和待补事项，`yaml: null`、`draftValid: false`；
这表示结构已读取、规格尚未生成，不会自动添加模型或样例数据。该命令不调用 DeepSeek。

## Agent 接入配置

内置助手和外部 agent 的配置与支持边界如下。[需求与架构](docs/需求与架构.md) 统一规格制定、数据边界和 CLI/Web 分工，
[开发计划](docs/开发计划.md) 说明当前缺口与交付顺序。先完成 CLI 单入口的安全检查、方向选择、对话和确认生成，
再接 Web 的同一流程；下列供应商命令仅用于配置和连通测试。
仅源码开发的测试工作区 reset 见 [贡献指南](CONTRIBUTING.md)。

### 配置内置助手供应商

默认使用 DeepSeek 与 `deepseek-flash`，交互输入 API key：

```bash
bilite authoring setup
bilite authoring status
bilite authoring test
bilite authoring test --send
```

配置保存在用户配置目录的 `bilite/authoring.json`，密钥单独写入同目录
`authoring-auth.json`（0600），不进入项目工作区，也不读取 `~/.pi/agent`。
macOS/Linux 默认目录为 `~/.config`（可由 `XDG_CONFIG_HOME` 指定），Windows 使用 `%APPDATA%`。
`BILITE_AUTHORING_CONFIG`、`BILITE_AUTHORING_AUTH` 可分别指定配置和凭据文件；
密钥优先读取配置中 `apiKeyEnv` 指定的环境变量（默认 `BILITE_AUTHORING_API_KEY`），未设置时读取凭据文件。
配置字段为 `version`、`api`、`baseUrl`、`modelId`、`apiKeyEnv` 和可选 `maxPromptChars`，只支持 `openai-completions`，未知字段拒绝；
密钥变量限定为 `BILITE_AUTHORING_*`。端点使用 HTTPS，本机回环端点可用 HTTP；不开放 OAuth。
`status` 和默认的 `test` 只检查本地配置并输出发送预览；只有 `test --send`
才用示例结构发起一次真实模型请求。
DeepSeek `deepseek-flash` 的示例结构烟测和多轮对话已使用；这不代表完整制定与报送闭环已验收。

`maxPromptChars` 是应用本地的完整上下文字符预算，默认 1,000,000，包含结构、历史、工具声明及提案回执。
它与供应商的 token 窗口独立；模型提交 YAML 和声明后，同一次运行的后续请求会继续增长。
本地超限会显示实际字符数与配置上限并保留任务，可调整该字段后重新运行同一命令继续；不自动丢弃历史。

### 制定接入或导出规格（开发预览）

在交互终端运行；Excel 路径按调用目录解析，可使用中文和空格：

```bash
bilite spec "/path/to/无数据结构样表.xlsx"
# 也可明确业务工作区
bilite --workspace /path/to/workspace spec "/path/to/无数据结构样表.xlsx"
```

入口内完成本地检查、接入/导出选择、供应商配置、连续对话、业务摘要和文件差异审阅，
选择“确认保存”后发布正式规格及配套声明。普通对话中的“好的”和模型自述均不能发布。
含数据文件会被拒绝，制定全程不打开业务数据库、不自动导入或生成含数据报表。

接入规格保存在 `ingest/`，执行时用 `--source` 选择报表；导出规格保存在 `specs/` 并关联
`templates/` 的空白 Excel。`models/`、`metrics/` 的必要变更随同确认发布。
未发布任务保存在 `.bilite/authoring/`；暂存或失败后重新运行同一命令可继续，EOF 保留任务且不发布。
发布中断时入口先恢复提交；Web 持有执行锁时保留任务并提示稍后重试。

当前助手每轮获得声明元数据和内置格式契约，尚无完整、按需的语义读取能力；
已有指标的公式正文未进入模型语义快照。真实供应商已进行多轮对话，但两方向的制定、确认保存与业务执行尚未整体通过。
旧 `authoring` 分步命令保留兼容与诊断用途。离线关键节点通过不代表业务闭环通过；人工验收见
[规格制定与入库测试指引](docs/规格制定与入库测试指引.md)。

### 安装 skill（以 Codex 为例）

在业务工作区中显式安装手册副本：

```bash
bilite skill install
```

源码开发可用 `node bin/bilite.mjs skill install`，不要求全局命令。
已有开发链接或副本时先保留，按需由用户决定是否替换；安装不会静默覆盖。
手册可配合 CLI 使用，无需 MCP；宿主按自己的发现机制载入项目 `.agents/skills/bi-lite-ingest`。
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
**使用同一数据库前先停止 Web 或其他 MCP 进程。** `cwd` 指向目标业务工作区；源码脚本路径指向引擎 checkout，规格与模型相对工作区解析。

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
