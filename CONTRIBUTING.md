# 开发环境与协作

本文供新设备、contributor 和开发 agent 复用。项目规则与目录地图见 [AGENTS.md](AGENTS.md)，
设计见 [需求与架构](docs/需求与架构.md)，待办以 [开发计划](docs/开发计划.md) 为准。

## 首次配置

开发基线由 `.node-version` 固定，目前为 **Node 24.18.0**；使用随 Node 安装的 npm，
已有 Node 版本管理器时让它读取该文件，不要求全员安装同一种管理器。
包的 `engines` 仍声明 `>=22.6`，它不是已验证的开发基线；最低分发版本另行验收，不据此在旧 Node 上反复尝试。
端到端与安装包验收覆盖 Windows 和 macOS arm64；Linux 和最低 Node 分发版本尚待验收。

必需工具为 Git、Node 和 npm；建议备有 `rg` 用于搜索。编辑器和 agent 宿主自选，
不要求全局 TypeScript、Python、Docker、独立 DuckDB 服务或全局 `bilite`。

```bash
git clone <仓库地址>
cd bi-lite
node --version
npm --version
npm ci
npm run doctor
```

克隆地址从实际协作仓库取得，不复制他人的绝对路径。`npm ci` 使用已提交的 `package-lock.json`；
切换分支后，只有锁文件或依赖目录不匹配时才重装，不在每轮任务开头重复安装。
修改依赖才使用 `npm install`，同时提交 `package.json` 与锁文件。

`npm run doctor` 只报告版本、工具、直接依赖是否与锁文件一致，以及 DuckDB 原生驱动能否在内存启动；
不联网、不安装东西、不读取业务值、不打开工作区数据库。
它会提示影响工作区选择的环境变量是否存在，但不输出其值。

## 日常开发

1. 查看 `git status --short`，保留已有修改；先读架构、计划和相关模块。
2. 换设备或首次接手时运行 `npm run doctor`；环境和锁文件未变化时复用已确认的结果。
3. 源码直接运行 TypeScript，导入保留 `.ts`；发布构建只用本地锁定的 TypeScript。
4. 按改动选择验证，检查结果写在任务/PR 中，不追加到项目文档当流水账。

依赖接口核对、实现与探针的执行顺序及止损规则见 [AGENTS.md](AGENTS.md#执行顺序与止损)。

| 改动 | 验证入口 | 影响范围 |
|---|---|---|
| 环境与依赖 | `npm run doctor` | 只读环境检查；原生驱动仅用内存 |
| pi 会话适配与配置 | `npm run test:pi` | 官方协议受控传输、预算、取消、工具、配置与发送 DTO；不调用真实模型 |
| 共享规格任务与候选 | `npm run test:authoring` | 任务租约、修订、连续会话、两类候选与无数据库边界；不调用真实模型 |
| 接入、语义计算、模型或渲染 | `npm run e2e` | 临时副本和假数据，结束后清理 |
| CLI、工作区、服务生命周期或发布资源 | `npm run package:check` | 临时安装真实 `.tgz`，启动回环服务后清理 |
| 源码开发 reset | `npm run test:development` | 临时工作区，检查真实锁、链接拒绝与配置保留 |
| 打包输出 | `npm run build` / `npm pack` | 生成 `dist/` / `.tgz`，不提交产物 |
| 文档或简单样式 | `git diff --check` 及相关针对性检查 | 不默认跑全套验收 |

`build` 当前做转译，**不做完整类型检查**（见 `tsconfig.json` 的 `noCheck`）。
通过构建不能替代运行验收。`package:check` 安装包时可能需要联网，
不以开发链接代替分发验收；浏览器启动回调的自动验证也不等同于实际桌面浏览器验收。

## 本机试用

自动验收不会生成或修改当前仓库的业务库。人工试用前区分两类示例：

- `npm run fixtures:business`：恢复版本化的18期经营测试包，按 [18期经营测试](docs/18期经营测试.md) 试用。
- `npm run fixtures`：生成原有小型示例；其指标配置与18期测试不同，宜在隔离副本中使用。

`npm start` 在当前工作区启动网页，默认 `127.0.0.1:4319`。开发时也可以直接：

```bash
node bin/bilite.mjs --workspace <业务工作区> web --port 4320 --no-open
node bin/bilite.mjs --workspace <业务工作区> catalog dump --format prompt
```

源码入口足够开发使用，**无需 `npm link`**。需要调试全局链接时才使用它，
并核对命令实际指向的 checkout；链接和 PATH 是本机状态，不是协作前提。
Web 运行时 CLI 自动转交数据库操作；MCP 目前仍须单独占库。
不要复制另一设备的 `.bilite/`、数据库锁或 `node_modules/` 来恢复环境。

### 重置独立测试工作区（仅源码开发）

先停止目标工作区的 Web 服务，再使用源码命令标记、预览和确认：

```bash
node bin/bilite.mjs --workspace <测试工作区> dev enable
node bin/bilite.mjs --workspace <测试工作区> dev reset
node bin/bilite.mjs --workspace <测试工作区> dev reset --confirm <工作区名>
```

`enable` 只在工作区标识中写入开发标记；不带 `--confirm` 的 reset 只输出清单。
确认后清空模型、指标、模板、规格、草稿、数据库、会话、输出与受管缓存，重建空业务目录。
工作区标识和工作区外的供应商配置保留，不自动重装财务预设。
源码/Git/包目录、未知文件、链接、外部数据库和活动持锁服务会被拒绝，不自动杀进程。
该实现放在 `dev/`，测试在 `test/development.ts`，正式包不包含实现或 Web reset 入口；上线前移除源码功能。

## 配置和常见阻塞

| 情况 | 处理方式 |
|---|---|
| Node 不在基线或入口缺少原生 TS 能力 | 先切换到 `.node-version`，再执行诊断；不临时加 TS 加载器/构建系统 |
| 依赖缺失、锁版本不符或换了 OS/CPU | 在该设备用 `npm ci` 重建依赖；不要复用另一平台的原生二进制 |
| 注册表连接重置或下载超时 | 优先复用缓存；确认网络或本机 registry 配置后有界重试，勿无限等待 |
| 企业镜像或代理 | 按本机约束配置；不把凭据、私人镜像地址或代理写进仓库 |
| 包验收安装受个人 npm 配置影响 | 验收脚本已隔离 userconfig；排查实际错误，不改全局设置来掩盖问题 |
| Windows 临时目录链接报 EPERM | 先判断是否是 sandbox/权限边界，再按宿主机制申请运行；不反复重装依赖或关闭安全设置 |
| 端口冲突 | 显式指定 `--port`，不要结束未知进程 |
| 数据库锁或握手失败 | 先核对工作区和持有服务；只停止本人/本任务启动的服务，不盲删活动锁 |

缓存默认使用 npm 自己的目录；不要把 `/tmp` 或某人的用户目录作为跨平台必需参数。
包验收可选环境变量为 `BILITE_TEST_OFFLINE=1`（依赖已完整缓存时）和
`BILITE_TEST_REGISTRY`（临时指定 registry）；不必写入持久配置。
Windows 若涉及中文文件的 Python 辅助工具，按需使用 `python -X utf8`；Python 不是引擎依赖。

业务工作区由 `--workspace`、`BILITE_WORKSPACE` 或向上查找标识决定，
`BILITE_DB` 可覆盖数据库位置。验收前留意这些变量的继承，避免误用业务库；
敏感值和个人配置不提交。
项目没有必须安装的 agent 插件。使用本项目手册的安装方式见 README；
用户级 skill、MCP 和个人宿主配置按需设置，不由仓库自动写入。

## 多人协作与收尾

- 每个开发者/agent 使用自己的分支或 worktree、自己的业务数据目录；需要并行网页服务时使用不同端口。
- `.gitattributes` 统一文本为 LF、Excel 为二进制；不要为换行规范重写整仓文件或修改别人的 Git 全局设置。
- 行为与配置变更保持显式：业务模型在 `models/`，初始化资源在 `assets/presets/`，不要把个人业务声明当默认资源发布。
- PR 说明问题、最终行为、验证范围及未验证的平台；不上传金额、源文件、数据库、日志、个人设置或构建产物。
- 收尾停止本任务的临时服务，清理本任务生成的截图、包和构建输出；保留用户业务文件及其他任务修改。
- 后续可将已验证的命令接入 CI；在跨平台验收前，不将其他系统标记为已支持。
