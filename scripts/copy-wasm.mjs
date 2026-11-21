import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(rootDir, 'crates/quark-core/target/wasm32-unknown-unknown/release/quark_core.wasm');
const destDir = resolve(rootDir, 'packages/quark-engine/wasm');
const dest = resolve(destDir, 'quark_core.wasm');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

try {
  execFileSync('wasm-opt', ['-Oz', dest, '-o', dest], { stdio: 'ignore' });
  console.log(`Copied and optimized (wasm-opt -Oz) -> ${dest}`);
} catch {
  console.log(`Copied ${src} -> ${dest}`);
}
