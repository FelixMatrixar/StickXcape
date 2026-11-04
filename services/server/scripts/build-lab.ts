/**
 * Builds the relay lab into dist/lab/, where the server serves it at /lab/.
 *
 *   node scripts/build-lab.ts            build once (part of npm run build and npm run dev)
 *   node scripts/build-lab.ts --watch    rebuild lab.js on every change
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const labDir = fileURLToPath(new URL('../lab/', import.meta.url));
const outDir = fileURLToPath(new URL('../dist/lab/', import.meta.url));

const options: esbuild.BuildOptions = {
  entryPoints: [join(labDir, 'main.ts')],
  outfile: join(outDir, 'lab.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  // iPhones from iOS 15 and Android Chrome from 2021, as in the frontend PRD's test devices.
  target: ['safari15', 'chrome96'],
  // Workspace packages build straight from their TypeScript sources.
  conditions: ['source'],
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
};

await mkdir(outDir, { recursive: true });
await copyFile(join(labDir, 'index.html'), join(outDir, 'index.html'));

if (process.argv.includes('--watch')) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log(`Watching the relay lab; output in ${outDir}`);
} else {
  await esbuild.build(options);
  console.log(`Relay lab built into ${outDir}`);
}
