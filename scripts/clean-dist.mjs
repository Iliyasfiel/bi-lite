import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Rebuild only generated output, including obsolete modules from previous builds.
const output = fileURLToPath(new URL('../dist/', import.meta.url));
fs.rmSync(output, { recursive: true, force: true });
