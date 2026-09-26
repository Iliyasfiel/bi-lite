# bi-lite

> **长表 → 口径规格 → 多形态产出** 的轻量引擎。
> 把「从快报 Excel 手工抄到报送表」这件事，变成一条声明式流水线。

财务数据**不以明文进入 LLM 上下文**——这不是靠过滤，是靠架构：agent 根本没有 SQL 权限，
它只能产出**口径规格（spec）**，数值第一次出现是在你自己的浏览器里。

---

## 它解决什么问题

集团每月从平台导出财务长表（财务期 × 公司 × 指标 × 口径 × 金额），
然后要按**不同给定的表格形式**抄成报送 Excel。人工抄写有两个病根：

| 痛点 | 表现 | bi-lite 的解法 |
|---|---|---|
| 人工抄写易错 | 几十个格子对不上，差额靠肉眼找 | spec 编译成 SQL 由引擎算，人只看结果 |
| 口径经常更换 | Excel 超链接/公式救不了 | 数据与排版分离，换口径只改 spec 一行 |
| 财务数据敏感 | 不敢让 AI 碰 | agent 无 SQL 权，只产出 spec（见下） |

**核心抽象只有一个**：`spec` —— 声明式口径规格（"透视表的声明式版本"）。
Excel 和图表都是它的渲染器，不是两个功能。

---

## 快速开始

```bash
node --version          # 需要 ≥ 22.6（本项目用 Node 原生跑 .ts，无构建步骤）
npm install

npm run fixtures        # 生成测试假数据（模板 + 960 行长表）
npm run e2e             # ★ 186 项断言全流程验收
npm start               # 打开 http://127.0.0.1:4319
```

浏览器三个页签：**数据导入** → **看板查询** → **报表报送**。

---

## 一条数据是怎么走完全程的

```
集团导出 Excel 长表
      │  ① 导入（Web 上传，本地校验，不经 LLM）
      ▼
   DuckDB（唯一可信源）──┐
      │                  │ 每批归档一份 Parquet
      │  ② 语义层查询     ▼
      │             data/parquet/fact_finance/batch=*/
      │  ③ spec 编译成参数化 SQL，在 DuckDB 内执行
      ▼
  结果矩阵
      │
      ├─④ Excel 渲染器 → 报送 Excel（打开原模板只填数据格，版式全保）
      └─④ 图表渲染器   → ECharts option → 看板
```

### 导入

从公司平台导出的长表，表头是 `财务期 | 公司名称 | 指标名称 | 口径 | 金额`。
上传后先做 STAGED 校验（**不写库**），确认无误再提交：

```bash
# e2e 里就是这么调的（Web 界面同理，只是走浏览器）
curl -X POST http://127.0.0.1:4319/api/import/stage \
  -H "x-filename: $(python3 -c 'import urllib.parse;print(urllib.parse.quote("集团导出长表.xlsx"))')" \
  --data-binary @test/fixtures/集团导出长表.xlsx
```

> 上传不用 multipart（省依赖）：原始二进制 body + `X-Filename` 头。

### 主数据对齐：同一个公司，每月写法不同

集团导出的长表里，「华东子公司」这个月可能写成 `（华东子公司）`，下个月写成 `华东分公司`。
如果每个写法都新建一条主数据，**同一家公司的钱就被拆到了两条主数据上** ——
报表出来少了一半，但格式完全正常。

匹配分两档，分界线是**"这个差异是不是只是格式噪音"**：

| 档 | 判据 | 处理 |
|---|---|---|
| **Tier 1** 自动 | `normalizeName()` 后完全相同（全角/空格/括号/大小写） | 直接归并，并在校验提示里**留痕**（"已自动归并 2 个写法"） |
| **Tier 2** 需确认 | 去壳后字号相同 / 名称互相包含 / 写法相近 | 只给**候选 + 判断依据**，由人拍板 |

```bash
# 看看这批名字里哪些需要人决定（不写库）
curl -s -X POST http://127.0.0.1:4319/api/import/suggest \
  -H 'content-type: application/json' \
  -d '{"names":[{"kind":"company","raw":"华东分公司"}]}'
# → 候选：华东子公司（字号相同（剥掉「有限公司」「集团」等形式后缀后一致））

# 人确认一次，永久记住
curl -s -X POST http://127.0.0.1:4319/api/aliases \
  -H 'content-type: application/json' \
  -d '{"kind":"company","raw":"华东分公司","targetId":"c_xxx","note":"2026-06 起改名"}'
```

**为什么不是"按相似度自动合并"**：不合并时数字明显不对（少了一半），人会来查；
**错合并时两家的钱被静默加在一起，报表看起来完全正常，没人会来查**。
所以宁可停下问人。有歧义时接口返 **HTTP 200 + `pendingConfirm: true`**，一行都不落库 ——
那是待办，不是失败；Web 导入页会把待确认的名字渲染成卡片，选「并入已有」或「确认是新建」。

### 写一条报送规格

`specs/月度保送表.yaml`：

```yaml
id: 集团月度保送表
title: 集团经营月报
template: test/fixtures/月度保送表.xlsx    # 版式来源：人工做好的空模板

params:
  year: 2026
  month: 6

sheets:
  - name: 主要指标
    blocks:
      - anchor: { name: DATA_START }       # ★ 用定义名称，模板改版式时跟着走
        rows:
          dim: metric
          order: [营业收入, 利润总额, 营业成本, 净利润, 期间费用]
        cols:
          dim: period_type                 # ← 换口径只改这一行
          order: [本年累计, 去年同期累计, 单月, 账面累计]
        value:
          measure: amount
          agg: sum
          format: "#,##0.00"               # 同时管 Excel 单元格格式与看板显示
        scope:                             # ★ 必须写！见下方"静默算错"
          time:
            year: "{{year}}"
            month: "{{month}}"
```

**换一种表格口径**，就是把 `rows.dim` 换成 `company`、`cols.order` 砍成两列——
数据与版式都不用重抄。

> ### ⚠️ 静默算错：`params` 声明了就必须用
>
> `scope.time` 不是可选的。少了它，spec 编译出的 SQL 里**没有任何时间条件** ——
> 一张写着"2026 年 6 月"的月报会把**12 个月全加总**，而数字看起来完全合理
> （实测 B4 = 765345，真值 66826）。最险的是这个错数字还被写进了 e2e 断言，
> 测试不但没抓住 bug，反而成了 bug 的守卫。
>
> 所以 `parseSpec()` 会硬校验：**`params` 里声明的每个键都必须被 `{{key}}` 引用过**，
> 否则解析直接报错。Web 保存 spec 时也走同一道校验。

### 从模板自动生成规格

不必手写上面那段 YAML。上传一个人工做好的空模板，系统会推断出草稿：

- **Web**：「报表报送」页 → 上传 `.xlsx` → 看到每个轴的来源与判断依据 → 核对后保存
- **MCP**：agent 调 `generate_spec`，拿到同样的草稿

推断结果是**提案**，不是决策。每个轴都标注来源：

| 标记 | 含义 |
|---|---|
| **读到的** | 模板里真的写了（如 B4 左方一列预置了 5 个指标名） |
| **猜的** | 从角格「公司」对照注册表推出，模板里没有预置行清单 |

模板里的「合计」公式行会被自动排除（保留原样、不写入），
推断出的 spec 固定带上 `scope.time`，让上面那个"静默算错"默认不发生。

### 渲染

```bash
# 预览：只回坐标与形状（B4:E8，20 个格子），不含金额
curl -s -X POST http://127.0.0.1:4319/api/report/preview \
  -H 'content-type: application/json' \
  -d '{"specFile":"specs/月度保送表.yaml","params":{"year":2026,"month":6}}'

# 导出：打开模板只填数据格
curl -s -X POST http://127.0.0.1:4319/api/report/render \
  -H 'content-type: application/json' \
  -d '{"specFile":"specs/月度保送表.yaml","params":{"year":2026,"month":6}}'
```

产出的 Excel **保留模板的一切**：样式、合并单元格、公式、条件格式、数据验证、
冻结窗格、批注、图表、图片。实测 18 个 zip 部件零丢失。

---

## 安全设计：为什么财务数据进不了 LLM

四层防护，逐层收紧：

| 层 | 手段 |
|---|---|
| ① 能力边界 | agent **没有 SQL 权**，只暴露 6 个 MCP 工具，无 shell |
| ② 给坐标不给数值 | `preview_spec` 返回 `B4:E8 将填 5 行 × 4 列`，看不到任何金额 |
| ③ 查询下推 | spec 在服务端编译成参数化 SQL，在 DuckDB 内执行；维度只能来自白名单 |
| ④ 分档 + 审计 | agent 视角的金额返 `12.3亿` 而非精确值，每格须 ≥3 行明细支撑；字段级审计 |

**关键推论**：改口径只需要 spec 的文本 diff，**不需要任何数值参与**。
所以"财务数据不进上下文"是架构上自然达成的，而不是靠事后过滤。

### MCP 工具集（仅此六个）

| 工具 | 作用 | 返回数值？ |
|---|---|---|
| `list_metrics` | 列出已注册指标/维度/口径/公司 | 否 |
| `get_template_schema` | 解析模板结构（锚点、表头、行标签、合并区） | 否（模板里的数字也不回传） |
| `preview_spec` | 返回将填充的坐标网格 | **否，且本工具不查库** |
| `render_report` | 渲染 Excel，返回文件路径 | 否（只回路径与计数） |
| `diff_report` | 比较两版 spec 的差异 | 否 |
| `generate_spec` | 从模板推断 spec 草稿（区分"读到的"与"猜的"） | 否（**不查库**，只读模板结构） |

另有一道**机械兜底**：任何工具返回值里若出现 ≥ 10000 的数字，本次调用直接失败。
它不替代上面的结构设计，只是让"将来某次改动不小心泄漏"变成一个响亮的错误。

**主数据归并（`/api/aliases`）刻意不做成 MCP 工具**：它是一次**不可逆的写操作**，
登记后永久生效。合并两家公司会把它们的钱静默加在一起，而报表看起来完全正常 ——
这种事必须由人在界面上看着依据点确认，不该成为 agent 顺手就能做的事。

### 把 MCP 接到客户端

```jsonc
// 例如 DSH / Claude Code 的 MCP 配置
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

协议实现是**零依赖手写**的（约 150 行）——官方 SDK 只为 6 个工具要拉 16MB，
而实际协议面只有 4 个方法。漂移风险用 e2e 对冲：验收阶段**用真实 MCP 客户端**连本服务，
不是自打 mock。

---

## 技术选型

| 层 | 选择 | 为什么 |
|---|---|---|
| 运行时 | **Node ≥ 22.6**（原生跑 `.ts`） | 无构建步骤，符合"轻量化" |
| 明细存储 | **DuckDB** | 列存、进程内单文件、交叉聚合毫秒级 |
| 归档 | **Parquet**（每批一文件） | 备份即拷目录 |
| Excel 模板填充 | **xlsx-populate 1.21.0** | 只改 XML 节点，保真度最高 |
| 图表 | **ECharts**（从 node_modules 直供） | 离线可用，无 CDN |
| Web | **node:http + 原生 JS** | 零框架、零外部服务 |
| 测试 | **Node 原生 `node:test` 风格的自研 harness** | 186 项断言，一条命令验收 |

**版本锁死**：`@duckdb/node-api` 用 `1.5.5-r.5`（不带 `^`）——1.3.3 系列曾被投毒
（CVE-2025-59037）。

---

## 项目结构

```
src/
  db/schema.ts       DDL（四维表 + 事实表 + 批次表）+ 口径注册表
  db/index.ts        open / query / execute / exportParquet（单进程双连接）
  import/longtable.ts 长表解析 + STAGED 三态校验 + 提交 + Parquet 归档
                      commit() 两阶段：有歧义整体不落库
  import/resolve.ts  ★ 主数据两档归并（Tier 1 自动 / Tier 2 人拍板）+ 别名表
  spec/types.ts      spec 类型与校验（YAML → Spec）
  spec/compile.ts    ★ 维度白名单 DIMENSIONS + spec → 参数化 SQL + planOf
  spec/template.ts   模板结构读取（表头/行标签/合并区/定义名称/公式行）
  spec/infer.ts      ★ 模板 → spec 草稿（带 source/evidence，猜的要人确认）
  semantic/query.ts  ★ 唯一的自由查询出口 + 受众分级 + 反推防护
  render/excel.ts    ★ xlsx-populate 模板填充（保版式）
  render/chart.ts    ★ 同一 spec → ECharts option / 形状描述
  mcp/tools.ts       ★ 六个 MCP 工具 + 金额兜底 + 审计
  mcp/server.ts      零依赖 MCP stdio 服务端
  server.ts          零框架本地 Web 服务
  web/               三个页签的前端（原生 JS）
specs/               口径规格 YAML
templates/           原始报送模板（人工制作，不修改）
docs/                需求与架构（规范文本）+ 实测调研报告
data/                ⚠️ 真实财务数据，永不提交
```

---

## 命令

```bash
npm run fixtures   # 生成测试假数据到 test/fixtures/
npm run e2e        # ★ 唯一门禁，186 项断言，15 个阶段
npm start          # 本地 Web 服务（默认 http://127.0.0.1:4319）
npm run bench      # ⚠️ 未实现
```

> `npm run e2e` 会清空 `data/bi.duckdb` 重跑。**别拿它对着真实数据库跑。**

---

## 当前进度

| 阶段 | 状态 |
|---|---|
| 1. 导入闭环 | ✅ 服务端 + Web 导入向导 + Parquet 归档 |
| 2. 语义层 + 查询 | ✅ 受众分级 / 反推防护 / 注入防护 + Web 看板 |
| 3. 规格引擎 | ✅ Excel + ECharts 两个渲染器 + Web 报表预览导出 |
| 4. agent 入口 | ✅ MCP 六工具（真实 MCP 客户端验收通过） |
| 5. 模板 → spec | ✅ 上传模板自动出 spec 草稿（Web + `generate_spec`） |
| R1. 主数据对齐 | ✅ 两档归并（Tier 1 自动 / Tier 2 人拍板）+ `dim_alias` 表 + Web 待确认卡片 |

### 已知限制

- **只有假数据在跑**。生产环境的导入格式会有差异，导入层对列名/公司名/指标名
  有别名表，但**真实导出很可能超出这份表** —— 未识别的主数据会列进 `stage()` 的
  待确认清单，需要人工确认，不会静默建维。
- **别名只增不减**：`dim_alias` 里的映射一旦登记就永久生效（人确认过一次，下月自动命中）。
  目前没有 Web 上的撤销入口，改错了要去 `GET /api/aliases` 看清单。
  这也是 `commit()` 分两阶段的原因 —— 宁可整体不落库，也不留下半成品别名。
- **`fact_business_line` 尚未建表**：运营指标（合同、业务线）目前只有 `fact_contract`。
- **公式缓存值不写回**：xlsx-populate 不重算公式。下游若直接读公式列数值，
  Excel 打开时会自动重算，但程序化读取需要另做处理。
- **重打包后有 10/18 个部件字节不等**（属性顺序、转义、空白等良性差异）。
  功能元素无一丢失，但对**有电子签章 / 哈希校验**的下游是风险。

---

## 文档

- [`docs/需求与架构.md`](docs/需求与架构.md) —— **唯一的规范文本**（需求、数据模型、spec 语言、安全设计、风险、落地顺序）
- [`docs/tech-research-excel-template-and-duckdb.md`](docs/tech-research-excel-template-and-duckdb.md) —— Excel 保真与 DuckDB 的实测原始记录
- [`AGENTS.md`](AGENTS.md) —— 给 AI 编码代理的开发规约（16 条铁律）

## License

Apache-2.0
