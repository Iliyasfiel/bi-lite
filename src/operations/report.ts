import type { Spec } from '../spec/types.ts';
import { declaredFactsOf } from '../gen/parse.ts';
import { compileBlock, runCompiled } from '../spec/compile.ts';
import { renderTemplate, type RenderBlock } from '../render/excel.ts';
import { query } from '../db/index.ts';

/** Numeric matrices stay inside the engine; callers receive paths and counts. */
export async function renderReport(spec: Spec, params: Record<string, string | number>, output: string) {
  if (!spec.template) throw new Error('报表未声明 template');
  const facts = declaredFactsOf();
  const blocks: RenderBlock[] = [];
  for (const sheet of spec.sheets) {
    for (const block of sheet.blocks) {
      const compiled = compileBlock(block, params, { factName: spec.fact, facts });
      const result = await runCompiled(compiled, (sql) => query(sql));
      blocks.push({
        sheet: sheet.name, anchor: block.anchor, colLabels: result.colLabels,
        rows: result.matrix.map((row) => ({ label: row.label, values: row.values })),
        format: block.value.format, writeRowLabels: false, writeColLabels: false,
      });
    }
  }
  return renderTemplate(spec.template, output, blocks);
}
