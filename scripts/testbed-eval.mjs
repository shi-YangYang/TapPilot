#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './testbed-runner.mjs';
export { main };
export { evaluateOracle } from './testbed-verifier.mjs';
export { chooseFixtureAction } from './testbed-fixture-policy.mjs';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = error?.code ?? error?.message;
    console.error(typeof code === 'string' && /^[A-Z][A-Z_0-9]{0,63}$/.test(code) ? code : 'EVALUATION_FAILED');
    process.exitCode = 1;
  });
}
