import type { DeclaredFact } from '../gen/ir.ts';
import { diagnoseIngest, type IngestIssue, type IngestSpec } from '../ingest/types.ts';
import { compileBlock } from '../spec/compile.ts';
import { diagnoseSpec, type Spec } from '../spec/types.ts';
import type { AuthoringDirection, AuthoringTemplateGeometry } from './tasks.ts';
import type { SemanticCandidate, SemanticSnapshot } from './semantic.ts';

export interface CandidateDiagnostic {
  level: 'error' | 'warn';
  code: string;
  at: string;
  message: string;
  hint?: string;
}

export interface CandidateSummary {
  direction: AuthoringDirection;
  fact: string | null;
  companies: string[];
  metrics: string[];
  periods: string[];
  scenarios: string[];
  currencies: string[];
  transforms: string[];
  skipped: string[];
  blocks: number;
  sourceBinding: string | null;
  fillAreas: string[];
  protectedFormulaCells: string[];
  unresolved: string[];
}

export interface CandidateResult {
  ok: boolean;
  direction: AuthoringDirection;
  diagnostics: CandidateDiagnostic[];
  errors: string[];
  unresolved: string[];
  summary: CandidateSummary | null;
}

type ValidationContext = Pick<SemanticSnapshot, 'facts' | 'metrics'> & {
  definitions?: SemanticCandidate['definitions'];
};

function diagnostic(value: {
  level?: 'error' | 'warn';
  code: string;
  at: string;
  message: string;
  hint?: string;
}): CandidateDiagnostic {
  return {
    level: value.level ?? 'error',
    code: value.code,
    at: value.at,
    message: value.message,
    ...(value.hint ? { hint: value.hint } : {}),
  };
}

function unique(values: unknown[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim()).map((v) => v.trim()))];
}

function summaryAxes(
  factName: string | null,
  facts: DeclaredFact[],
  scenarios: unknown[],
  currencies: unknown[],
): { scenarios: string[]; currencies: string[] } {
  const fact = facts.find((entry) => entry.name === (factName || 'fact_finance'));
  return {
    scenarios: unique([
      ...scenarios,
      ...(fact?.queryDefaults?.scenario ? [fact.queryDefaults.scenario] : []),
    ]),
    currencies: unique([
      ...currencies,
      ...(fact?.queryDefaults?.ccy ? [fact.queryDefaults.ccy] : []),
    ]),
  };
}

function unresolvedOf(
  summary: CandidateSummary,
  diagnostics: CandidateDiagnostic[],
): string[] {
  const missing: string[] = [];
  if (!summary.fact) missing.push('目标事实表尚未确定');
  if (!summary.metrics.length) missing.push('指标范围尚未确定');
  if (!summary.periods.length) missing.push('报告期间或窗口来源尚未确定');
  if (!summary.scenarios.length) missing.push('场景尚未确定');
  if (!summary.currencies.length) missing.push('币种尚未确定');
  if (!summary.blocks) missing.push('填充区域尚未确定');
  if (diagnostics.some((entry) => entry.level === 'error')) missing.push('存在必须修订的静态诊断');
  return [...new Set([...missing, ...summary.unresolved])];
}

function ingestSummary(spec: IngestSpec, facts: DeclaredFact[]): CandidateSummary {
  const blocks = spec.sheets.flatMap((sheet) => sheet.blocks);
  const transforms = blocks.flatMap((block) => (block.values.transforms ?? []).map((rule) => {
    const target = rule.metrics?.length ? rule.metrics.join('/') : '默认规则';
    return `${target}: ${rule.fromUnit} → ${rule.toUnit}${rule.sign ? ` (${rule.sign})` : ''}${rule.rounding ? ` ${rule.rounding}` : ''}`;
  }));
  const skipped = blocks.flatMap((block) => {
    const value = block.values.skip ?? [];
    return value.map((entry) => `${entry.columns.join(',')}: ${entry.why}`);
  });
  const scenarios = blocks.flatMap((block) => block.keys
    .filter((key) => key.as === 'scenario' && 'value' in key)
    .map((key) => key.value));
  const currencies = blocks.flatMap((block) => block.keys
    .filter((key) => key.as === 'ccy' && 'value' in key)
    .map((key) => key.value));
  const factName = spec.target?.trim() || 'fact_finance';
  const defaults = summaryAxes(factName, facts, scenarios, currencies);
  return {
    direction: 'ingest',
    fact: factName,
    companies: unique(blocks.flatMap((block) => [
      ...(block.rows.some((row) => row.dim === 'company') ? ['按源表主体列'] : []),
      ...(block.facts?.company && 'literal' in block.facts.company
        ? [block.facts.company.literal]
        : []),
    ])),
    metrics: unique(blocks.flatMap((block) => [
      ...(block.rows.some((row) => row.dim === 'metric') ? ['按源表指标列'] : []),
      ...(block.facts?.metric && 'literal' in block.facts.metric
        ? [block.facts.metric.literal]
        : []),
    ])),
    periods: unique(blocks.flatMap((block) => [
      ...block.keys.filter((key) => key.as === 'period')
        .map((key) => key.value ?? (key.col ? `源表 ${key.col} 列` : '')),
      ...(block.facts?.period && 'literal' in block.facts.period
        ? [block.facts.period.literal]
        : []),
    ])),
    scenarios: defaults.scenarios,
    currencies: defaults.currencies,
    transforms: unique(transforms),
    skipped: unique(skipped),
    blocks: blocks.length,
    sourceBinding: spec.source?.trim() || null,
    fillAreas: [],
    protectedFormulaCells: [],
    unresolved: [],
  };
}

export function validateIngestCandidate(
  yamlText: string,
  context: ValidationContext,
): CandidateResult {
  const result = diagnoseIngest(yamlText, {
    facts: context.facts,
    periodTypes: context.facts.flatMap((fact) => fact.calibers.map((caliber) => caliber.name)),
  });
  const diagnostics = [
    ...(result.parseError ? [diagnostic({
      code: 'INGEST_YAML_BAD',
      at: 'yaml',
      message: result.parseError,
    })] : []),
    ...result.issues.map((value: IngestIssue) => diagnostic(value)),
  ];
  // Lenient parsing returns the raw YAML object even when lint rejects its
  // shape. Only validated structures are safe to traverse for a summary.
  const summary = result.spec && !result.willBeRejected ? ingestSummary(result.spec, context.facts) : null;
  const unresolved = summary ? unresolvedOf(summary, diagnostics) : ['接入规格结构尚未确定'];
  return {
    ok: Boolean(result.spec) && !result.willBeRejected && unresolved.length === 0,
    direction: 'ingest',
    diagnostics,
    errors: [
      ...(result.parseError ? [result.parseError] : []),
      ...result.issues.filter((value) => value.level === 'error')
        .map((value) => `${value.at}: ${value.message}`),
    ],
    unresolved,
    summary,
  };
}

function exportSummary(spec: Spec, facts: DeclaredFact[]): CandidateSummary {
  const blocks = spec.sheets.flatMap((sheet) => sheet.blocks);
  const companies = blocks.flatMap((block) => {
    const names = [
      ...(block.scope?.company?.filter?.name ? [block.scope.company.filter.name] : []),
      ...(block.scope?.filter?.company?.name ?? []),
      ...(block.rows.dim === 'company' ? block.rows.order ?? [] : []),
    ];
    return names;
  });
  const metrics = blocks.flatMap((block) => [
    ...(block.value.metric ? [block.value.metric] : []),
    ...(block.rows.dim === 'metric' ? block.rows.order ?? [] : []),
    ...(block.cols.dim === 'metric' ? block.cols.order ?? [] : []),
  ]);
  const periods = blocks.flatMap((block) => [
    ...(block.cols.dim === 'period_type' ? block.cols.order ?? [] : []),
    ...(block.value.periodType ? [block.value.periodType] : []),
    ...(block.scope?.time?.year !== undefined && block.scope.time.month !== undefined
      ? [`${block.scope.time.year}-${String(block.scope.time.month).padStart(2, '0')}`]
      : []),
  ]);
  const scenarios = blocks.flatMap((block) => [
    ...(block.scope?.filter?.scenario
      ? Object.values(block.scope.filter.scenario).flat()
        .filter((value): value is string => typeof value === 'string')
      : []),
  ]);
  const currencies = blocks.flatMap((block) => [
    ...(block.scope?.filter?.ccy
      ? Object.values(block.scope.filter.ccy).flat()
        .filter((value): value is string => typeof value === 'string')
      : []),
  ]);
  const skipped = blocks.flatMap((sheetBlock) => [
    ...(sheetBlock.value.expr ? [`派生表达式: ${sheetBlock.value.expr}`] : []),
  ]);
  const factName = spec.fact?.trim() || 'fact_finance';
  const defaults = summaryAxes(factName, facts, scenarios, currencies);
  return {
    direction: 'export',
    fact: factName,
    companies: unique(companies),
    metrics: unique(metrics),
    periods: unique(periods),
    scenarios: defaults.scenarios,
    currencies: defaults.currencies,
    transforms: [],
    skipped: unique(skipped),
    blocks: blocks.length,
    sourceBinding: null,
    fillAreas: [],
    protectedFormulaCells: [],
    unresolved: [],
  };
}

export function validateExportCandidate(
  yamlText: string,
  context: ValidationContext,
  template?: AuthoringTemplateGeometry,
): CandidateResult {
  const result = diagnoseSpec(yamlText, { facts: context.facts });
  const diagnostics = [
    ...(result.parseError ? [diagnostic({
      code: 'SPEC_YAML_BAD',
      at: 'yaml',
      message: result.parseError,
    })] : []),
    ...result.issues.map((entry) => diagnostic({
      level: entry.level,
      code: entry.code,
      at: entry.at,
      message: entry.message,
      hint: entry.hint,
    })),
  ];
  const summary = result.spec && !result.willBeRejected ? exportSummary(result.spec, context.facts) : null;
  if (result.spec && !result.willBeRejected && template) {
    const geometry = validateFillGeometry(result.spec, template, context);
    diagnostics.push(...geometry.diagnostics);
    if (summary) {
      summary.fillAreas = geometry.fillAreas;
      summary.protectedFormulaCells = geometry.protectedFormulaCells;
    }
  }
  if (result.spec && !result.willBeRejected) {
    try {
      for (const [sheetIndex, sheet] of result.spec.sheets.entries()) {
        for (const [blockIndex, block] of sheet.blocks.entries()) {
          try {
            compileBlock(block, result.spec.params ?? {}, {
              factName: result.spec.fact,
              facts: context.facts,
              metrics: context.definitions,
            });
          } catch (error) {
            diagnostics.push(diagnostic({
              code: 'SPEC_COMPILE_BAD',
              at: `sheets[${sheetIndex}].blocks[${blockIndex}]`,
              message: (error as Error).message,
            }));
          }
        }
      }
    } catch (error) {
      diagnostics.push(diagnostic({
        code: 'SPEC_COMPILE_BAD',
        at: 'blocks',
        message: (error as Error).message,
      }));
    }
  }
  const unresolved = summary ? unresolvedOf(summary, diagnostics) : ['导出规格结构尚未确定'];
  return {
    ok: Boolean(result.spec) && !result.willBeRejected
      && !diagnostics.some((entry) => entry.level === 'error') && unresolved.length === 0,
    direction: 'export',
    diagnostics,
    errors: [
      ...result.errors,
      ...diagnostics.filter((entry) => entry.code === 'SPEC_COMPILE_BAD')
        .map((entry) => `${entry.at}: ${entry.message}`),
    ],
    unresolved,
    summary,
  };
}

function validateFillGeometry(
  spec: Spec,
  template: AuthoringTemplateGeometry,
  context: ValidationContext,
): {
  diagnostics: CandidateDiagnostic[];
  fillAreas: string[];
  protectedFormulaCells: string[];
} {
  const diagnostics: CandidateDiagnostic[] = [];
  const fillAreas: string[] = [];
  const protectedFormulaCells: string[] = [];
  const occupied = new Map<string, string>();
  const parsedRef = (ref: string): { row: number; col: number } | null => {
    const match = /^([A-Za-z]+)([0-9]+)$/.exec(ref);
    if (!match) return null;
    let col = 0;
    for (const char of match[1].toUpperCase()) col = col * 26 + char.codePointAt(0)! - 64;
    return { row: Number(match[2]), col };
  };
  const key = (sheet: string, row: number, col: number) => `${sheet}\0${row}\0${col}`;
  for (const [sheetIndex, sheet] of spec.sheets.entries()) {
    const templateSheet = template.sheets.find((entry) => entry.name === sheet.name);
    if (!templateSheet) {
      diagnostics.push(diagnostic({
        code: 'SHEET_NOT_IN_TEMPLATE',
        at: `sheets[${sheetIndex}].name`,
        message: `模板中没有工作表「${sheet.name}」`,
      }));
      continue;
    }
    const end = templateSheet.usedRange?.split(':').at(-1);
    const templateEnd = end ? parsedRef(end) : null;
    for (const [blockIndex, block] of sheet.blocks.entries()) {
      const at = `sheets[${sheetIndex}].blocks[${blockIndex}]`;
      let start: { row: number; col: number } | null = null;
      if (typeof block.anchor === 'string') {
        start = parsedRef(block.anchor);
      } else {
        const named = template.anchors?.find((entry) => entry.name === block.anchor.name);
        if (named) start = parsedRef(named.ref);
      }
      if (!start) continue;
      let result;
      try {
        result = compileBlock(block, spec.params ?? {}, {
          maxRows: 10_000,
          factName: spec.fact,
          facts: context.facts,
          metrics: context.definitions,
        });
      } catch (error) {
        diagnostics.push(diagnostic({
          code: 'SPEC_COMPILE_BAD',
          at,
          message: (error as Error).message,
        }));
        continue;
      }
      fillAreas.push(
        `${sheet.name}!${typeof block.anchor === 'string' ? block.anchor : block.anchor.name}: ` +
        `${result.rowLabels.length} 行 × ${result.colLabels.length} 列`,
      );
      const operations: Array<{ row: number; col: number; formula: boolean }> = [];
      for (let r = 0; r < result.rowLabels.length; r++) {
        for (let c = 0; c < result.colLabels.length; c++) {
          operations.push({ row: start.row + r, col: start.col + c, formula: false });
        }
      }
      if (block.writeRowLabels) {
        for (let r = 0; r < result.rowLabels.length; r++) {
          operations.push({ row: start.row + r, col: start.col - 1, formula: false });
        }
      }
      if (block.writeColLabels) {
        for (let c = 0; c < result.colLabels.length; c++) {
          operations.push({ row: start.row - 1, col: start.col + c, formula: false });
        }
      }
      const formulas = new Set((templateSheet.formulaCells ?? []).map((ref) => ref.toUpperCase()));
      protectedFormulaCells.push(...[...formulas].map((ref) => `${templateSheet.name}!${ref}`));
      const mergedRanges = (templateSheet.mergedCells ?? []).flatMap((range) => {
        const [from, to] = range.split(':');
        const start = from ? parsedRef(from) : null;
        const end = to ? parsedRef(to) : start;
        return start && end ? [{ start, end }] : [];
      });
      for (const operation of operations) {
        if (operation.row < 1 || operation.col < 1) {
          diagnostics.push(diagnostic({
            code: 'FILL_RANGE_OUT_OF_BOUNDS',
            at,
            message: `填充坐标早于 A1：第 ${operation.row} 行，第 ${operation.col} 列`,
          }));
          continue;
        }
        const ref = cellAddress(operation.row, operation.col);
        if (templateEnd && (operation.row > templateEnd.row || operation.col > templateEnd.col)) {
          diagnostics.push(diagnostic({
            code: 'FILL_RANGE_OUT_OF_BOUNDS',
            at,
            message: `填充坐标 ${ref} 超出模板已用范围 ${templateSheet.usedRange}`,
          }));
        }
        if (formulas.has(ref)) {
          diagnostics.push(diagnostic({
            code: 'FORMULA_CELL_COLLISION',
            at,
            message: `填充会覆盖模板公式格 ${ref}`,
          }));
        }
        const mergedCollision = mergedRanges.find((range) =>
          operation.row >= range.start.row && operation.row <= range.end.row
          && operation.col >= range.start.col && operation.col <= range.end.col
          && !(operation.row === range.start.row && operation.col === range.start.col));
        if (mergedCollision) {
          diagnostics.push(diagnostic({
            code: 'MERGED_CELL_COLLISION',
            at,
            message: `填充会写入合并区（${ref}），只能写左上角或调整锚点`,
          }));
        }
        const cell = key(sheet.name, operation.row, operation.col);
        const previous = occupied.get(cell);
        if (previous) {
          diagnostics.push(diagnostic({
            code: 'FILL_RANGE_OVERLAP',
            at,
            message: `${ref} 与 ${previous} 的填充范围重叠`,
          }));
        } else occupied.set(cell, at);
      }
    }
  }
  return {
    diagnostics,
    fillAreas: unique(fillAreas),
    protectedFormulaCells: unique(protectedFormulaCells),
  };
}

function cellAddress(row: number, col: number): string {
  let column = '';
  for (let value = col; value > 0; value = Math.floor((value - 1) / 26)) {
    column = String.fromCharCode(65 + (value - 1) % 26) + column;
  }
  return `${column}${row}`;
}

export function validateCandidate(
  direction: AuthoringDirection,
  yamlText: string,
  context: ValidationContext,
): CandidateResult {
  return direction === 'ingest'
    ? validateIngestCandidate(yamlText, context)
    : validateExportCandidate(yamlText, context);
}

