# bi-lite 开发约定

bi-lite 是本地 BI 引擎：Excel + YAML 接入规格 → DuckDB → YAML 报表规格 → 模板 Excel。
核心场景是按给定模板填表报送。第二版继续围绕这条主链路开发。

## 开工入口

先读 `docs/需求与架构.md` 与 `docs/开发计划.md`，再读相关模块。
工作区结构见本文件；用户使用与接入配置见 `README.md`；agent 操作手册在 `skills/bi-lite-ingest/`。
文档描述当前设计与功能状态，不记录开发流水账、历史报错或断言数量。

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

## 实现约定

1. 业务结构由 `models/*.yml` 声明。新增模板优先增加规格，业务表按领域划分。
2. 规格由人或 agent 编写；读取、计算、落库与渲染由本地引擎确定性执行。
3. agent 只接触结构与元数据，不接触金额、不执行 SQL。Web 给本机用户显示精确值。
4. 接入与报表复用现有解析、校验与编译逻辑；模板既有格式、公式、合并等应保留。
5. 累计是期末窗口值，账面累计按源文件实存；场景、币种与期数要明确。
6. Node ≥22.6 原生运行 TypeScript，导入带 `.ts`。不引入构建步骤或外部服务。
   DuckDB 使用版本锁定的 `@duckdb/node-api`；exceljs 仅用于生成测试假数据。
7. 生产接入源放在稳定的 `data/` 路径；`test/fixtures/` 只用于可重建的示例。
   保存 `ingest/*.yaml` 只是保存规格，执行导入才写库。
8. 功能或架构变化同步更新相应说明，保持简短。清理文档不代表删除运行时校验。

## 测试纪律（第二版）

- **每轮开发只测试最重要的节点，不要每次增加一堆测试用例。**
- 优先复用已有主链路验收。低影响、可逆修改采用针对性检查，不默认新增测试。
- 只有新增核心行为或修复重要回归，才补一个有代表性的用例；替换重复、过时的用例。
- 不做穷举参数排列、实现镜像测试、文档字数/断言数量对拍或为覆盖率堆用例。
- 保留模型启动、试运行、导入/重放、查询口径、模板导出、入口权限边界的核心验收。
- `npm run e2e` 在临时工作区生成假数据并运行，不清空或写入当前项目数据库。
  引擎主链路改动提交前运行；文档、样式等修改按实际影响验证。
- 验证结论写清检查范围与结果，不把每次测试过程追加到项目文档。

## 常用命令

```bash
npm run fixtures --cache /tmp/bi-lite-npm-cache
npm run e2e --cache /tmp/bi-lite-npm-cache
npm start --cache /tmp/bi-lite-npm-cache
```

Web 默认监听 `127.0.0.1:4319`。DuckDB 单写者：Web、CLI、MCP 不同时占用同一库。
