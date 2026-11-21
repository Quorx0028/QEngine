import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(rootDir, 'packages/quark-engine/wasm/quark_core.wasm');
const destDir = resolve(rootDir, 'packages/quark-engine/dist/wasm');
const dest = resolve(destDir, 'quark_core.wasm');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`Packaged WASM -> ${dest}`);
