/** 只有这些命令会打开 DuckDB；其余 CLI 命令在 Web 运行时仍可本地执行。 */
export const DATABASE_INVOCATIONS = new Set([
  'ingest-dry-run',
  'ingest-run',
  'render',
  'query',
  'catalog-dump',
  'catalog-show',
  'plan',
  'apply',
  'rebuild',
  'replay',
  'generate-spec',
]);

export function isDatabaseInvocation(kind: string): boolean {
  return DATABASE_INVOCATIONS.has(kind);
}
