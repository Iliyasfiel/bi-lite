import { masterCatalog } from '../ingest/master.ts';
import { diagnoseIngest, parseIngestSpec } from '../ingest/types.ts';

/** The same catalog and validation context serve Web and CLI ingestion. */
export async function prepareIngest(text: string) {
  const cat = await masterCatalog();
  const context = { periodTypes: cat.periodTypes, facts: cat.facts };
  const d = diagnoseIngest(text, context);
  return {
    cat, d, context,
    spec: d.willBeRejected ? null : parseIngestSpec(text, context),
    errors: d.issues.filter((issue) => issue.level === 'error'),
    warnings: d.issues.filter((issue) => issue.level === 'warn'),
  };
}
