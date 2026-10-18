import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { declaredFacts, type DeclaredFact, type Ir, type IrCaliber, type IrColumn } from '../gen/ir.ts';
import { diagnoseModelSources, MODEL_API_VERSION, type GenIssue } from '../gen/parse.ts';
import { diagnoseMetricSources, type MetricDefinition } from '../metrics/definitions.ts';

export const AUTHORING_METRICS_DIR = 'metrics';
export const AUTHORING_MODELS_DIR = 'models';
export const MAX_AUTHORING_DECLARATION_BYTES = 2 * 1024 * 1024;
export const MAX_AUTHORING_DECLARATION_FILES = 256;

export type DeclarationKind = 'model' | 'metrics';

export interface DeclarationFile {
  kind: DeclarationKind;
  name: string;
  sha256: string;
  text: string;
}

export interface AuthoringColumnProjection {
  name: string;
  type: string;
  role: IrColumn['role'];
  key: boolean;
  notNull: boolean;
  semantic: string | null;
  unit: string | null;
  refs: string | null;
}

export interface AuthoringCaliberProjection {
  name: string;
  from: IrCaliber['from'] | null;
  since: string | null;
  shift: number | null;
  calculator: boolean;
  operand: string | null;
}

export interface AuthoringFactProjection {
  name: string;
  periodColumn: string;
  companyColumn: string;
  metricColumn: string;
  measureColumn: string;
  windowFrom: string | null;
  calibers: AuthoringCaliberProjection[];
  queryDefaults: Record<string, string>;
  columns: AuthoringColumnProjection[];
}

export interface AuthoringMetricProjection {
  id: string;
  name: string;
  unit: string;
  category: string;
  direction: MetricDefinition['direction'];
  fact: string;
  aliases: string[];
  hasCalculation: boolean;
}

/** Persisted only under .bilite; paths and source text remain local. */
export interface SemanticSnapshot {
  version: 1;
  fingerprint: string;
  policy: 'authoring-semantic-declarations-v1';
  files: Array<{ kind: DeclarationKind; name: string; sha256: string; text: string }>;
  facts: AuthoringFactProjection[];
  metrics: AuthoringMetricProjection[];
  issues: GenIssue[];
}

/** The only declaration content intended for model prompts. */
export interface SemanticProjection {
  fingerprint: string;
  facts: AuthoringFactProjection[];
  metrics: AuthoringMetricProjection[];
}

export interface SemanticCandidate {
  snapshot: SemanticSnapshot;
  ir: Ir;
  definitions: MetricDefinition[];
  facts: DeclaredFact[];
  issues: GenIssue[];
}

/** A loaded declaration set plus its canonical path and hash, retained only in task storage. */
export interface SemanticCandidateState {
  version: 1;
  baseFingerprint: string;
  fingerprint: string;
  files: DeclarationFile[];
  facts: AuthoringFactProjection[];
  metrics: AuthoringMetricProjection[];
  issues: GenIssue[];
}

export interface SemanticChange {
  path: string;
  before: string | null;
  after: string | null;
}

export class SemanticSnapshotError extends Error {
  readonly code:
    | 'DECLARATION_LINK'
    | 'DECLARATION_FILE_INVALID'
    | 'DECLARATION_TOO_LARGE'
    | 'DECLARATION_FINGERPRINT_STALE'
    | 'DECLARATION_CANDIDATE_INVALID';

  constructor(code: SemanticSnapshotError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const declarationRoots = (workspace: string) => ({
  models: path.join(path.resolve(workspace), AUTHORING_MODELS_DIR),
  metrics: path.join(path.resolve(workspace), AUTHORING_METRICS_DIR),
});

function declarationFiles(workspace: string): Array<{
  kind: DeclarationKind;
  name: string;
  file: string;
}> {
  const roots = declarationRoots(workspace);
  const out: Array<{ kind: DeclarationKind; name: string; file: string }> = [];
  let bytes = 0;
  for (const kind of ['model', 'metrics'] as const) {
    const root = kind === 'model' ? roots.models : roots.metrics;
    if (!fs.existsSync(root)) continue;
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new SemanticSnapshotError(
        'DECLARATION_LINK',
        `${kind === 'model' ? AUTHORING_MODELS_DIR : AUTHORING_METRICS_DIR} 必须是普通目录`,
      );
    }
    for (const name of fs.readdirSync(root).filter((file) => /\.ya?ml$/i.test(file)).sort()) {
      if (out.length >= MAX_AUTHORING_DECLARATION_FILES) {
        throw new SemanticSnapshotError('DECLARATION_TOO_LARGE', '声明文件数量超过上限');
      }
      const file = path.join(root, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new SemanticSnapshotError('DECLARATION_LINK', `${kind} 声明必须是普通文件：${name}`);
      }
      bytes += stat.size;
      if (bytes > MAX_AUTHORING_DECLARATION_BYTES) {
        throw new SemanticSnapshotError('DECLARATION_TOO_LARGE', '声明文件总量超过 2MB 上限');
      }
      out.push({ kind, name, file });
    }
  }
  return out;
}

/** Reads declarations only; importing this path must never open DuckDB. */
export function readDeclarationFiles(workspace = process.cwd()): DeclarationFile[] {
  return declarationFiles(workspace).map(({ kind, name, file }) => {
    const text = fs.readFileSync(file, 'utf8');
    return {
      kind,
      name,
      text,
      sha256: createHash('sha256').update(text).digest('hex'),
    };
  });
}

function fingerprintFiles(files: DeclarationFile[]): string {
  const canonical = files
    .map((file) => `${file.kind}/${file.name}\0${file.sha256}\n`)
    .sort()
    .join('');
  return createHash('sha256').update(canonical).digest('hex');
}

function issue(code: string, at: string, message: string, hint?: string): GenIssue {
  return { level: 'error', code, at, message, ...(hint ? { hint } : {}) };
}

function metricDefinitions(files: DeclarationFile[]): {
  definitions: MetricDefinition[];
  issues: GenIssue[];
} {
  const metricFiles = files.filter((file) => file.kind === 'metrics');
  if (!metricFiles.length) return { definitions: [], issues: [] };
  const result = diagnoseMetricSources(metricFiles.map((file) => ({
    file: `${AUTHORING_METRICS_DIR}/${file.name}`,
    text: file.text,
  })));
  return {
    definitions: result.definitions,
    issues: result.issues.map((entry) => issue(entry.code, entry.at, entry.message)),
  };
}

function columnProjection(column: IrColumn): AuthoringColumnProjection {
  return {
    name: column.name,
    type: column.type,
    role: column.role,
    key: column.key,
    notNull: column.notNull,
    semantic: column.semantic ?? null,
    unit: column.unit ?? null,
    refs: column.refs ?? null,
  };
}

function factProjection(fact: DeclaredFact): AuthoringFactProjection {
  return {
    name: fact.name,
    periodColumn: fact.periodColumn,
    companyColumn: fact.companyColumn,
    metricColumn: fact.metricColumn,
    measureColumn: fact.measureColumn,
    windowFrom: fact.windowFrom,
    calibers: fact.calibers.map((caliber) => ({
      name: caliber.name,
      from: caliber.from ?? null,
      since: caliber.since ?? null,
      shift: caliber.shift ?? null,
      calculator: caliber.calculator === true,
      operand: caliber.operand ?? null,
    })),
    queryDefaults: { ...fact.queryDefaults },
    columns: fact.columns.map(columnProjection),
  };
}

function metricProjection(def: MetricDefinition): AuthoringMetricProjection {
  return {
    id: def.id,
    name: def.name,
    unit: def.unit,
    category: def.category,
    direction: def.direction,
    fact: def.fact,
    aliases: [...def.aliases],
    hasCalculation: Boolean(def.calculation),
  };
}

/** Builds a read-only declaration snapshot without loading DuckDB or master data. */
export function createSemanticSnapshot(workspace = process.cwd()): SemanticSnapshot {
  const files = readDeclarationFiles(workspace);
  return buildSemanticSnapshot(files);
}

function buildSemanticSnapshot(files: DeclarationFile[]): SemanticSnapshot {
  const issues: GenIssue[] = [];
  const definitionsResult = metricDefinitions(files);
  const definitions = definitionsResult.definitions;
  issues.push(...definitionsResult.issues);

  const model = diagnoseModelSources(
    files.filter((file) => file.kind === 'model').map((file) => ({
      name: file.name,
      text: file.text,
      label: `${AUTHORING_MODELS_DIR}/${file.name}`,
    })),
    { emptyAsValidIr: true },
  );
  issues.push(...model.issues);
  let facts: DeclaredFact[] = [];
  if (model.ir) {
    facts = declaredFacts(model.ir);
    for (const def of definitions) {
      if (!facts.some((fact) => fact.name === def.fact)) {
        issues.push(issue('METRIC_FACT_BAD', `metrics/${def.id}.fact`, `指标 ${def.id} 引用了未声明的事实表 ${def.fact}`));
      }
    }
  }
  const snapshot: SemanticSnapshot = {
    version: 1,
    fingerprint: fingerprintFiles(files),
    policy: 'authoring-semantic-declarations-v1',
    files: files.map(({ kind, name, sha256, text }) => ({ kind, name, sha256, text })),
    facts: facts.map(factProjection),
    metrics: definitions.map(metricProjection),
    issues,
  };
  return snapshot;
}

export function semanticProjection(snapshot: SemanticSnapshot): SemanticProjection {
  return {
    fingerprint: snapshot.fingerprint,
    facts: snapshot.facts.map((fact) => ({
      ...fact,
      calibers: fact.calibers.map((caliber) => ({ ...caliber })),
      queryDefaults: { ...fact.queryDefaults },
      columns: fact.columns.map((column) => ({ ...column })),
    })),
    metrics: snapshot.metrics.map((metric) => ({ ...metric, aliases: [...metric.aliases] })),
  };
}

function modelIr(files: DeclarationFile[]): Ir {
  const result = diagnoseModelSources(
    files.filter((entry) => entry.kind === 'model').map((file) => ({
      name: file.name,
      text: file.text,
      label: `${AUTHORING_MODELS_DIR}/${file.name}`,
    })),
    { emptyAsValidIr: true },
  );
  return result.ir ?? { apiVersion: MODEL_API_VERSION, tables: [] };
}

const metricDefinitionsOf = (files: DeclarationFile[]): MetricDefinition[] => metricDefinitions(files).definitions;

/**
 * Applies an explicit local review set to the snapshot in memory. The base
 * fingerprint prevents an editor from checking a candidate against stale files.
 */
export function applySemanticChanges(
  snapshot: SemanticSnapshot,
  expectedFingerprint: string,
  changes: Array<{ path: string; content: string | null }>,
): SemanticCandidate {
  if (snapshot.fingerprint !== expectedFingerprint) {
    throw new SemanticSnapshotError(
      'DECLARATION_FINGERPRINT_STALE',
      '声明在预览后发生变化，请重新读取再提交候选变更',
    );
  }
  const files = snapshot.files.map(({ kind, name, sha256: _sha, text }) => ({
    kind, name, text, sha256: createHash('sha256').update(text).digest('hex'),
  }));
  const seen = new Set<string>();
  for (const change of changes) {
    if (typeof change.path !== 'string'
      || (typeof change.content !== 'string' && change.content !== null)) {
      throw new SemanticSnapshotError('DECLARATION_CANDIDATE_INVALID', '声明变更必须包含 path 与 content');
    }
    const match = /^(models|metrics)\/([^/\\\\]+\.ya?ml)$/i.exec(change.path);
    if (!match) {
      throw new SemanticSnapshotError('DECLARATION_CANDIDATE_INVALID', `声明路径越界：${change.path}`);
    }
    const kind: DeclarationKind = match[1]!.toLowerCase() === 'models' ? 'model' : 'metrics';
    const name = match[2];
    if (!name || !/^[a-z_][a-z0-9_-]*\.ya?ml$/i.test(name)) {
      throw new SemanticSnapshotError('DECLARATION_CANDIDATE_INVALID', `声明文件名不合法：${change.path}`);
    }
    const key = `${kind}/${name}`;
    if (seen.has(key)) {
      throw new SemanticSnapshotError('DECLARATION_CANDIDATE_INVALID', `声明变更重复：${change.path}`);
    }
    seen.add(key);
    const index = files.findIndex((file) => file.kind === kind && file.name === name);
    if (change.content === null) {
      if (index >= 0) files.splice(index, 1);
      continue;
    }
    if (Buffer.byteLength(change.content) > MAX_AUTHORING_DECLARATION_BYTES) {
      throw new SemanticSnapshotError('DECLARATION_TOO_LARGE', `候选声明超过上限：${change.path}`);
    }
    const entry = {
      kind,
      name,
      text: change.content,
      sha256: createHash('sha256').update(change.content).digest('hex'),
    };
    if (index >= 0) files[index] = entry;
    else files.push(entry);
  }
  if (files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) > MAX_AUTHORING_DECLARATION_BYTES) {
    throw new SemanticSnapshotError('DECLARATION_TOO_LARGE', '候选声明总量超过 2MB 上限');
  }
  const next = buildSemanticSnapshot(files);
  const ir = modelIr(files);
  const definitions = metricDefinitionsOf(files);
  const facts = declaredFacts(ir);
  return { snapshot: next, ir, definitions, facts, issues: next.issues };
}

export function candidateState(
  candidate: SemanticCandidate,
  baseFingerprint: string,
): SemanticCandidateState {
  return {
    version: 1,
    baseFingerprint,
    fingerprint: candidate.snapshot.fingerprint,
    files: candidate.snapshot.files.map((file) => ({ ...file })),
    facts: candidate.snapshot.facts.map((fact) => ({
      ...fact,
      calibers: fact.calibers.map((caliber) => ({ ...caliber })),
      queryDefaults: { ...fact.queryDefaults },
      columns: fact.columns.map((column) => ({ ...column })),
    })),
    metrics: candidate.snapshot.metrics.map((metric) => ({ ...metric, aliases: [...metric.aliases] })),
    issues: candidate.issues.map((entry) => ({ ...entry })),
  };
}

export function candidateFromState(
  state: SemanticCandidateState,
  workspace = process.cwd(),
): SemanticCandidate {
  if (createSemanticSnapshot(workspace).fingerprint !== state.baseFingerprint) {
    throw new SemanticSnapshotError('DECLARATION_FINGERPRINT_STALE', '工作区声明已变化，请重新检查候选');
  }
  const ir = modelIr(state.files);
  const definitions = metricDefinitionsOf(state.files);
  const candidate: SemanticCandidate = {
    snapshot: {
      version: 1,
      fingerprint: state.fingerprint,
      policy: 'authoring-semantic-declarations-v1',
      files: state.files.map((file) => ({ ...file })),
      facts: state.facts.map((fact) => ({
        ...fact,
        calibers: fact.calibers.map((caliber) => ({ ...caliber })),
        queryDefaults: { ...fact.queryDefaults },
        columns: fact.columns.map((column) => ({ ...column })),
      })),
      metrics: state.metrics.map((metric) => ({ ...metric, aliases: [...metric.aliases] })),
      issues: state.issues.map((entry) => ({ ...entry })),
    },
    ir,
    definitions,
    facts: declaredFacts(ir),
    issues: state.issues.map((entry) => ({ ...entry })),
  };
  return candidate;
}

export function reviewSemanticChanges(
  snapshot: SemanticSnapshot,
  changes: Array<{ path: string; content: string | null }>,
): SemanticChange[] {
  const candidate = applySemanticChanges(snapshot, snapshot.fingerprint, changes);
  const before = new Map(snapshot.files.map((file) => [
    `${file.kind === 'model' ? AUTHORING_MODELS_DIR : AUTHORING_METRICS_DIR}/${file.name}`,
    file.text,
  ]));
  const after = new Map(candidate.snapshot.files.map((file) => [
    `${file.kind === 'model' ? AUTHORING_MODELS_DIR : AUTHORING_METRICS_DIR}/${file.name}`,
    file.text,
  ]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.flatMap((file) => {
    const oldText = before.get(file) ?? null;
    const newText = after.get(file) ?? null;
    return oldText === newText ? [] : [{ path: file, before: oldText, after: newText }];
  });
}

export function assertSnapshotCurrent(snapshot: SemanticSnapshot, workspace = process.cwd()): void {
  if (createSemanticSnapshot(workspace).fingerprint !== snapshot.fingerprint) {
    throw new SemanticSnapshotError('DECLARATION_FINGERPRINT_STALE', '工作区声明已变化，请重新检查声明');
  }
}

export function sameDeclarationFiles(
  left: DeclarationFile[],
  right: DeclarationFile[],
): boolean {
  return isDeepStrictEqual(
    left.map(({ kind, name, sha256 }) => ({ kind, name, sha256 })),
    right.map(({ kind, name, sha256 }) => ({ kind, name, sha256 })),
  );
}
