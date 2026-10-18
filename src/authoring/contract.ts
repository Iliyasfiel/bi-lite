/** Static direction contracts and examples, validated by the authoring acceptance test. */

export type AuthoringContractDirection = 'ingest' | 'export';

export interface ContractDeclarationExample {
  /** models 用 name（= 表名）；metrics 用 file（= metrics/<file>）。 */
  name?: string;
  file?: string;
  text: string;
}

export interface ContractExamples {
  /** 通用无数据最小声明集：一张事实表 + 它引用的两个维度表。 */
  models: ContractDeclarationExample[];
  /** 通用无数据最小指标声明。 */
  metrics: ContractDeclarationExample[];
  /** 接入方向最小自洽样例（对上面的 models 校验通过）。 */
  ingestSpec: string;
  /** 导出方向最小自洽样例（对上面的 models/metrics 校验通过）。 */
  exportSpec: string;
}

const DIM_COMPANY = `kind: dimension
title: 主体维度
keys:
  - name: id
    type: varchar
    key: true
    notNull: true
    semantic: org
  - name: name
    type: varchar
    notNull: true
    semantic: org
`;

const DIM_METRIC = `kind: dimension
title: 指标维度
keys:
  - name: id
    type: varchar
    key: true
    notNull: true
    semantic: metric
  - name: name
    type: varchar
    notNull: true
    semantic: metric
`;

const FACT_LEDGER = `kind: fact
title: 事实表（示例）
grain: [fin_month, period_from, company_id, metric_id, scenario, ccy]
windowFrom: period_from
queryDefaults: { scenario: 实际, ccy: 人民币 }
calibers:
  - name: 单月
    from: same
  - name: 本月累计
    from: same
  - name: 本年累计
    from: year_start
keys:
  - name: fin_month
    type: date
    key: true
    notNull: true
    semantic: period
  - name: period_from
    type: date
    key: true
    notNull: true
  - name: company_id
    type: varchar
    role: dim_fk
    key: true
    refs: dim_company
    notNull: true
    semantic: org
  - name: metric_id
    type: varchar
    role: dim_fk
    key: true
    refs: dim_metric
    notNull: true
    semantic: metric
  - name: scenario
    type: varchar
    key: true
    notNull: true
    semantic: scenario
  - name: ccy
    type: varchar
    key: true
    notNull: true
    semantic: ccy
measures:
  - name: amount
    type: decimal(18,2)
    unit: 元
    semantic: money
provenance:
  - name: batch_id
    type: varchar
`;

const METRICS_EXAMPLE = `metrics:
  - id: revenue
    name: 营业收入
    unit: 元
    category: 规模指标
    fact: fact_ledger
`;

const INGEST_SPEC = `id: example_ingest       # 示例编号，勿照抄；实际用任务自己的稳定英文 id
title: <可选标题>
target: fact_ledger          # 必须是 models/*.yml 声明过的 fact 表
onConflict: reject           # reject（默认）| replace
unknownMaster: confirm       # confirm（默认）| create
onEmptyMeasure: skip         # skip（默认）| null
sheets:
  - name: 示例表             # 替换为结构投影给出的工作表 label，不是序号或文件名
    blocks:
      - anchor: D3           # 数据区左上角（第一个值格）
        rows:                # 行标签列 → 维度（可多列）
          - { col: A, dim: company }
          - { col: C, dim: metric }
        keys:                # 期数列 / 行内退化列（col 与 value 二选一）
          - { col: B, as: period, type: text }
          - { as: scenario, value: 实际 }
          - { as: ccy, value: 人民币 }
        values:
          columns: [D:G]     # 值列，只认列字母或 "D:G"
          skip:
            - columns: [G]
              why: 同比是派生列，不入库
          periodTypes: [单月, 本月累计, 本年累计]   # 按有效列逐位对应
          transforms:
            - metrics: [revenue]
              fromUnit: 万元
              toUnit: 元
          measure: amount
`;

const EXPORT_SPEC = `id: example_export       # 示例编号，勿照抄；实际用任务自己的稳定英文 id
fact: fact_ledger
sheets:
  - name: 示例表             # 替换为结构投影给出的工作表 label
    blocks:
      - anchor: B4           # 坐标，或 { name: 定义名称 }
        rows: { dim: company }
        cols:
          dim: period_type   # 口径轴只能做列
          order: [单月, 本年累计]
        value:
          metric: revenue    # 指标行 × 口径列；或改用 periodType 做公司行 × 指标列
          measure: amount
          agg: sum
        scope:
          time: { year: 2026, month: 6 }   # 累计口径必须钉住报告期
`;

/** 通用无数据最小自洽样例。既是提示内容，也是可被现有校验器验证的输入。 */
export const contractExamples: ContractExamples = {
  models: [
    { name: 'dim_company.yml', text: DIM_COMPANY },
    { name: 'dim_metric.yml', text: DIM_METRIC },
    { name: 'fact_ledger.yml', text: FACT_LEDGER },
  ],
  metrics: [{ file: 'metrics.yml', text: METRICS_EXAMPLE }],
  ingestSpec: INGEST_SPEC,
  exportSpec: EXPORT_SPEC,
};

/** 每个声明文件单独成块并标出文件名 —— 拼在一起会被误读成"一个多 kind 文件"。 */
function declarationBlocks(files: ContractDeclarationExample[]): string {
  return files
    .map((file) => `${file.name ? `models/${file.name}` : `metrics/${file.file}`}：\n` + '```yaml\n' + file.text + '```\n')
    .join('\n');
}

const SHARED_RULES = `【方向契约（内置，权威）】

一、方向
- 接入：源 Excel → 本地库。读网格、映射坐标、构造事实行；保存到 ingest/。它不是导出规格。
- 导出：本地库 → Excel。声明取数范围、轴、度量与填充坐标；保存到 specs/ 并关联空白模板。
- 只提交与任务方向一致的那一份规格；两份规格字段不通用，不要互相套用。
- sheet.name 必须原样使用结构投影里给出的工作表 label（不是序号、不是文件名）。
`;

const INGEST_SECTION = `二、接入规格 YAML
必需：id、sheets[].name、sheets[].blocks[]。每个 block 必须能解释出事实行的全部必需坐标。
- 顶层可选：title、source（执行参数，可省略）、target（默认 fact_finance）、
  onConflict: reject|replace、unknownMaster: confirm|create、onEmptyMeasure: skip|null。
- block.anchor：数据区左上角坐标（如 D3）；接入不支持定义名称。
- block.rows：数组，每项 { col, dim }；dim 只能取已注册维度白名单；
  复合行键（如 A 列主体 + C 列指标）就多写几项 —— 不要硬塞进一列。
- block.keys：数组，每项 { col?, as, value?, type? }；col 与 value 二选一。
  as: period 是期数列（type: text|date）；其它 as 只能是目标表声明过的行内退化列。
- block.values：columns（必需，只认列字母或 "D:G"）、measure（默认 amount）、
  headerRow、periodTypes（按有效列逐位对应）或 periodTypeFromHeader（表头文本 → 口径）、
  skip: [{ columns, why }]（why 必填；跳过优先于 columns）；
  transforms: [{ metrics?, fromUnit, toUnit, sign?, rounding? }]（单位组内互转：
  元/千元/万元/亿元、比率/%；sign: preserve|negate；rounding: reject|half-up；
  一个区块最多一条默认规则，即不写 metrics 的那条）。
- block.facts：网格外的固定键 { literal: "..." } 或 { cell: "A2" }；一个键只能有一个来源。
- 公式只作为存在标记：不要把公式正文写进规格，也不要把公式列当值列。
- 把派生列写进 columns 范围再顺手跳过是很自然的写法，引擎只给 warn 级提示，不算错。

接入最小样例（对下面的通用声明集校验通过；id 与表名是占位，勿照抄）：
${INGEST_SPEC}`;

const EXPORT_SECTION = `二、导出规格 YAML
必需：id、sheets[].name、sheets[].blocks[]。
- 顶层可选：title、fact（默认 fact_finance）、params（{{参数}} 默认值；声明了就必须被引用）。
- block.anchor：坐标 "B4"，或 { name: 定义名称 }。
- block.rows / block.cols：{ dim, order?, filter? }；dim 取已注册维度白名单。
- block.value：metric（公司行 × 口径列）或 periodType（公司行 × 指标列）二者之一钉住量纲；
  另有 measure（默认 amount）、agg: sum|avg|max|min|count、expr（派生表达式）、format。
- block.scope：time: { year, month }、company.filter、通用 filter: { 维度: { 列: 值 } }。
- 指标与口径必须被钉住（轴或 filter 都算）；口径轴只能做 cols；
  累计口径必须钉住报告期（scope.time 给 year 与 month）。
- block.chart 可选：type: bar|line|pie|area。
- 模板里已有的公式、格式、合并只保留，不重写；填充区不能覆盖公式格。
- rows.order 留空只有 warn 级提示；有真实主体清单时再写全（本示例不写具体主体）。

导出最小样例（对下面的通用声明集校验通过；id 与表名是占位，勿照抄）：
${EXPORT_SPEC}`;

const DECLARATION_SECTION = `三、模型声明 models/*.yml（只在缺失时作为候选声明提出）
- 一个文件一张表，文件名即表名（只认 [a-z_][a-z0-9_]*）；每个文件独立成一份 YAML。
- 顶层 kind：dimension|fact|bridge|aggregate；title；fact 必须写 grain。
- 列有两种等价写法：分组 keys/measures/provenance，或平铺 columns；不能同时写。
  列字段：name、type（varchar|date|integer|bigint|boolean|timestamp|decimal(p,s)|varchar[]）、
  role（pk|dim_fk|measure|degenerate|provenance）、key、notNull、semantic、unit、refs、comment。
- 事实表主键必须与 grain 一致；dim_fk 用 refs 指向已声明的维度表。
- 口径体系写在事实表上：windowFrom（窗口起点列）+ calibers（from: same|year_start|since，
  可选 shift，或 calculator: true + operand）；queryDefaults 给默认场景/币种成员。
- rows 只给 dimension / bridge 的声明内嵌行；事实表的行来自接入。

通用最小声明集（无业务数据，与上面的示例配套；每个文件单独保存）：
${declarationBlocks(contractExamples.models)}

四、指标声明 metrics/*.yml
顶层 metrics 列表；每项字段：id（[a-z][a-z0-9_]*）、name、unit、category、
可选 direction: positive|negative、aliases、fact、calculation、effectiveFrom。
calculation 只能引用已声明的指标编号，支持四则运算、取余与括号；派生指标不接收源金额。

指标最小样例：
${declarationBlocks(contractExamples.metrics)}`;

const BEHAVIOR_SECTION = `五、行为规则
- 只给当前方向的规格；接入不是导出，导出不是接入。示例里的 id、表名、工作表名、期间和单位均为格式示意，不是本任务的业务确认，不要照抄。
- 缺能力、字段或声明时给出明确诊断与待办，不猜字段、不编枚举，也不向用户索要引擎 schema、源码或堆栈。
- 上下文字段 revision 与 currentDraft.version 是权威；历史消息里的旧编号一律以当前上下文为准。
- 不替用户确认、发布、接入、查询或填充报表；未决项必须保留在 unresolved 里。`;

/**
 * 按方向组装系统提示里的契约正文：只带当前方向的规格与样例，
 * 声明、指标与行为规则为两方向共用。direction 为 null 时只给共用部分。
 */
export function authoringDirectionContract(direction: AuthoringContractDirection | null): string {
  return [
    SHARED_RULES,
    direction === 'ingest' ? INGEST_SECTION : direction === 'export' ? EXPORT_SECTION : '',
    DECLARATION_SECTION,
    BEHAVIOR_SECTION,
  ].filter(Boolean).join('\n');
}
