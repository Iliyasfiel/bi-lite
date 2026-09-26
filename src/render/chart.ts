/**
 * ECharts 渲染器（docs/需求与架构.md §5.3、F5）
 *
 * ★ 核心设计：**图表不是另一个功能，是同一个 spec 的另一个 renderer。**
 *   同一个 Block（rows / cols / value）既能填 Excel，也能出图 —— 切换口径时两者一起跟随。
 *
 * ★ 安全设计：这里刻意拆成两个函数
 *   - toEChartsOption()  含数值 → 只允许送到**人的浏览器**
 *   - chartShape()       只含结构与标签、**不含数值** → 这才是可以给 LLM 看的
 *   与 compile.ts 的 planOf() 同一套路（§6.2 第②层：给坐标不给数值）。
 */
import type { Block } from '../spec/types.ts';

/** Block 上的图表声明（可选；没有则只能渲染 Excel） */
export interface ChartSpec {
  type: 'bar' | 'line' | 'pie' | 'area';
  /** 哪个维度当类目轴。默认 rows（横轴=行标签，系列=列口径） */
  category?: 'rows' | 'cols';
  title?: string;
  /** 柱/面积是否堆叠 */
  stacked?: boolean;
  /** 只画部分行/列（不写则全画） */
  include?: { rows?: string[]; cols?: string[] };
}

/** 渲染器的输入：与 Excel 渲染器共用 runCompiled() 的输出 */
export interface ChartInput {
  rowLabels: string[];
  colLabels: string[];
  matrix: Array<{ label: string; values: (number | null)[] }>;
}

export interface EChartsSeries {
  name: string;
  type: 'bar' | 'line' | 'pie';
  stack?: string;
  areaStyle?: Record<string, never>;
  data: Array<number | null | { name: string; value: number | null }>;
  smooth?: boolean;
  label?: { show: boolean; position: string };
  radius?: string;
}

export interface EChartsOption {
  title?: { text: string };
  tooltip: { trigger: 'axis' | 'item' };
  legend?: { data: string[]; top?: number };
  grid?: { left: number; right: number; bottom: number; top: number; containLabel: boolean };
  xAxis?: { type: 'category'; data: string[]; axisLabel?: { rotate?: number } };
  yAxis?: { type: 'value' };
  series: EChartsSeries[];
}

/**
 * 生成含数值的 ECharts option —— **仅供浏览器**。
 * 与 Excel 渲染器同源：同一个 matrix，换个投影方向。
 */
export function toEChartsOption(chart: ChartSpec, input: ChartInput): EChartsOption {
  const axis = chart.category ?? 'rows';
  const byRows = axis === 'rows';

  const rowIdx = pick(chart.include?.rows, input.rowLabels);
  const colIdx = pick(chart.include?.cols, input.colLabels);

  const rows = rowIdx.map((i) => input.rowLabels[i]);
  const cols = colIdx.map((j) => input.colLabels[j]);

  // 类目轴 / 系列：取决于是"行当横轴"还是"列当横轴"
  const categories = byRows ? rows : cols;
  const seriesNames = byRows ? cols : rows;

  const seriesData = seriesNames.map((name, s) => {
    const data = (byRows ? rowIdx : colIdx).map((i) => {
      const row = input.matrix[i];
      if (!row) return null;
      const v = byRows ? row.values[colIdx[s]] : row.values[i];
      return v === undefined ? null : v;
    });
    return { name, data };
  });

  // 饼图：单系列、按类目切分（饼图的多系列语义不清晰，故意只支持第一个口径）
  if (chart.type === 'pie') {
    const first = seriesData[0];
    const flat = categories.map((c, i) => ({ name: c, value: (first?.data[i] ?? null) as number | null }));
    return {
      ...(chart.title ? { title: { text: chart.title } } : {}),
      tooltip: { trigger: 'item' },
      legend: { data: flat.map((f) => f.name), top: 8 },
      series: [{
        name: first?.name ?? chart.title ?? '占比',
        type: 'pie',
        radius: '62%',
        data: flat,
        label: { show: true, position: 'outside' },
      }],
    };
  }

  const series: EChartsSeries[] = seriesData.map(({ name, data }) => {
    switch (chart.type) {
      case 'line':
        return { name, type: 'line', smooth: true, data };
      case 'area':
        return { name, type: 'line', smooth: true, areaStyle: {}, data };
      default:
        return { name, type: 'bar', data, ...(chart.stacked ? { stack: 'total' } : {}) };
    }
  });

  const longLabels = categories.some((c) => c.length > 4);

  return {
    ...(chart.title ? { title: { text: chart.title } } : {}),
    tooltip: { trigger: 'axis' },
    legend: { data: seriesNames, top: 8 },
    grid: { left: 8, right: 16, bottom: 8, top: chart.title ? 56 : 40, containLabel: true },
    xAxis: {
      type: 'category',
      data: categories,
      ...(longLabels ? { axisLabel: { rotate: 30 } } : {}),
    },
    yAxis: { type: 'value' },
    series,
  };
}

/**
 * 只含结构与标签、**不含任何数值** 的图表描述 —— 可安全给 agent。
 * 这是 §6.2 第②层的图表版：agent 能知道"将画一张 4 系列 × 5 类目的柱状图"，
 * 但拿不到任何一个数据点。
 */
export function chartShape(chart: ChartSpec, input: ChartInput) {
  const rowIdx = pick(chart.include?.rows, input.rowLabels);
  const colIdx = pick(chart.include?.cols, input.colLabels);
  return {
    chartType: chart.type,
    categoryAxis: (chart.category ?? 'rows') === 'rows' ? 'rows' : 'cols',
    categoryLabels: ((chart.category ?? 'rows') === 'rows' ? rowIdx : colIdx).map((i) =>
      ((chart.category ?? 'rows') === 'rows' ? input.rowLabels : input.colLabels)[i],
    ),
    seriesLabels: ((chart.category ?? 'rows') === 'rows' ? colIdx : rowIdx).map((i) =>
      ((chart.category ?? 'rows') === 'rows' ? input.colLabels : input.rowLabels)[i],
    ),
    pointCount: rowIdx.length * colIdx.length,
    stacked: chart.stacked ?? false,
    note: '本描述仅含结构与标签，不含任何数据点',
  };
}

/**
 * 把语义层 `query_metrics` 的结果适配成图表输入。
 *
 * 这样 Web 看板与 spec 报表**共用同一个图表实现** —— 看板不是第二套画图代码。
 *
 * ★ 安全上的顺带好处：agent 视角返回的是分档字符串（"19.3万"），
 *   这里 `typeof c === 'number'` 会把它们全部变成 null，
 *   所以即便误把 agent 结果喂进来，也不会画出数值 —— 从严失败。
 */
export function chartInputFromMetrics(m: {
  columns: Array<{ label: string }>;
  groups: Array<{ values: Array<string | null>; cells: Array<number | string | null> }>;
}): ChartInput {
  const labelOf = (g: { values: Array<string | null> }) =>
    g.values.filter((v): v is string => v !== null).join(' / ') || '合计';
  return {
    rowLabels: m.groups.map(labelOf),
    colLabels: m.columns.map((c) => c.label),
    matrix: m.groups.map((g) => ({ label: labelOf(g), values: g.cells.map((c) => (typeof c === 'number' ? c : null)) })),
  };
}

/** 把「要哪些标签」翻译成「要哪些下标」；未指定则全要 */
function pick(wanted: string[] | undefined, all: string[]): number[] {
  if (!wanted) return all.map((_, i) => i);
  const idx: number[] = [];
  for (const w of wanted) {
    const i = all.indexOf(w);
    if (i >= 0) idx.push(i);
  }
  return idx;
}
