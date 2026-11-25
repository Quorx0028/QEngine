import type { AssetManager } from '../assets/AssetManager';
import type { ProceduralTextureKind } from './ProjectSchema';

export function generateProceduralTexturePixels(
  kind: Exclude<ProceduralTextureKind, 'none' | 'custom'>,
  size = 128
): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const hash = (x: number, y: number) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      let r = 220;
      let g = 220;
      let b = 220;

      if (kind === 'grid') {
        const edge = x < 3 || y < 3 || x >= size - 2 || y >= size - 2;
        const mid = Math.abs(x - size / 2) <= 1 || Math.abs(y - size / 2) <= 1;
        if (edge) {
          r = 165; g = 185; b = 215;
        } else if (mid) {
          r = 195; g = 208; b = 225;
        } else {
          r = 232; g = 238; b = 248;
        }
      } else if (kind === 'checker') {
        const tile = (((x >> 4) + (y >> 4)) & 1) === 0;
        r = tile ? 240 : 120;
        g = tile ? 242 : 128;
        b = tile ? 248 : 142;
      } else if (kind === 'brick') {
        const row = Math.floor(y / 16);
        const offset = (row & 1) * 16;
        const bx = (x + offset) % 32;
        const by = y % 16;
        const mortar = bx < 2 || by < 2;
        const grain = (hash(Math.floor((x + offset) / 2), Math.floor(y / 2)) - 0.5) * 24;
        if (mortar) {
          r = 158; g = 155; b = 150;
        } else {
          r = Math.min(255, Math.max(0, 198 + grain));
          g = Math.min(255, Math.max(0, 118 + grain * 0.7));
          b = Math.min(255, Math.max(0, 96 + grain * 0.6));
        }
      } else if (kind === 'wood') {
        const ring = Math.sin(x * 0.28 + Math.sin(y * 0.08) * 2.2) * 14;
        const plank = x % 32 < 2;
        const v = (hash(x >> 1, y >> 2) - 0.5) * 16 + ring - (plank ? 45 : 0);
        r = Math.min(255, Math.max(0, 196 + v));
        g = Math.min(255, Math.max(0, 148 + v * 0.8));
        b = Math.min(255, Math.max(0, 102 + v * 0.55));
      } else if (kind === 'stone') {
        const n1 = hash(x >> 2, y >> 2);
        const n2 = hash(x >> 4, y >> 4);
        const c = Math.round(135 + (n1 * 0.5 + n2 * 0.5) * 65);
        r = c; g = c + 2; b = c + 6;
      } else if (kind === 'metal') {
        const streak = (hash(x, y >> 3) - 0.5) * 20;
        const rivet = (x % 32 === 6 || x % 32 === 26) && (y % 32 === 6 || y % 32 === 26);
        const seam = x < 2 || y < 2;
        const base = rivet ? 235 : seam ? 120 : 196 + streak;
        r = Math.min(255, Math.max(0, base));
        g = Math.min(255, Math.max(0, base + 4));
        b = Math.min(255, Math.max(0, base + 12));
      }

      px[idx] = r;
      px[idx + 1] = g;
      px[idx + 2] = b;
      px[idx + 3] = 255;
    }
  }
  return px;
}

export async function loadImageDataUrlTexture(
  assets: AssetManager,
  name: string,
  dataUrl: string,
  tag = 'project'
): Promise<number | undefined> {
  if (!assets.hasBackend || typeof createImageBitmap !== 'function') return undefined;
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bmp.close();
      return undefined;
    }
    ctx.drawImage(bmp, 0, 0);
    const pixels = new Uint8Array(ctx.getImageData(0, 0, bmp.width, bmp.height).data.buffer);
    bmp.close();
    return assets.createTexture(name, canvas.width, canvas.height, pixels, false, tag);
  } catch {
    return undefined;
  }
}
