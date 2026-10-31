// Build do pacote: ESM e CommonJS para bundlers, versão <script> minificada e os tipos (.d.ts).
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
const common = { bundle: true, platform: 'browser', target: 'es2018', legalComments: 'none' };

await build({ ...common, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/index.js' });
await build({ ...common, entryPoints: ['src/index.ts'], format: 'cjs', outfile: 'dist/index.cjs' });
await build({ ...common, entryPoints: ['src/global.ts'], format: 'iife', minify: true, outfile: 'dist/hh-analytics.min.js' });
// Tipos num arquivo só, sem import relativo: funciona em qualquer moduleResolution (bundler, node16, nodenext) e em CJS
execSync('npx tsc -p tsconfig.build.json', { stdio: 'inherit' });
const types = readFileSync('dist/.types/types.d.ts', 'utf8');
const client = readFileSync('dist/.types/client.d.ts', 'utf8').replace(/^import type .*\r?\n/m, '');
const dts = `${types}\n${client}`;
if (/from '\.\//.test(dts)) throw new Error('index.d.ts ainda tem import relativo');
writeFileSync('dist/index.d.ts', dts);
writeFileSync('dist/index.d.cts', dts);
rmSync('dist/.types', { recursive: true, force: true });

for (const f of ['index.js', 'index.cjs', 'hh-analytics.min.js', 'index.d.ts', 'index.d.cts']) {
  console.log(`dist/${f}`.padEnd(28), `${(statSync(`dist/${f}`).size / 1024).toFixed(1)} KB`);
}
