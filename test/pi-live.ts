import {
  defaultAuthoringAuthPath,
  defaultAuthoringConfigPath,
  loadAuthoringConfig,
  resolveAuthoringApiKey,
  runtimeFromAuthoringConfig,
} from '../src/authoring/config.ts';
import { buildAuthoringTurnInput } from '../src/authoring/context.ts';
import { runAuthoringTurn } from '../src/authoring/pi.ts';
import { AUTHORING_SMOKE_USER_TEXT, authoringSmokeTask } from '../src/authoring/smoke.ts';

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((arg) => arg !== '--preview' && arg !== '--send');
if (unknown.length || args.size > 1) {
  console.error('用法: npm run test:pi:live -- --preview | --send');
  process.exit(1);
}
const send = args.has('--send');

const task = authoringSmokeTask();
const input = buildAuthoringTurnInput(task, AUTHORING_SMOKE_USER_TEXT);
const config = loadAuthoringConfig();
let keySource: string | null = null;
try {
  keySource = resolveAuthoringApiKey(config).source;
} catch {
  keySource = null;
}

if (!send) {
  console.log(JSON.stringify({
    config: {
      file: defaultAuthoringConfigPath(),
      authFile: defaultAuthoringAuthPath(),
      api: config.api,
      baseUrl: config.baseUrl,
      modelId: config.modelId,
      apiKeyEnv: config.apiKeyEnv,
      keyPresent: keySource !== null,
      keySource,
    },
    preview: input.preview,
  }, null, 2));
} else {
  const result = await runAuthoringTurn({
    ...input,
  }, runtimeFromAuthoringConfig(config), {
    task: { id: task.id, sha256: task.template.sha256 },
  });
  console.log(JSON.stringify({
    text: result.text,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    requestCount: result.requestCount,
    proposalCount: result.proposals.length,
    toolResults: result.toolResults.map((item) => ({ name: item.name, blocked: item.blocked })),
  }, null, 2));
}
