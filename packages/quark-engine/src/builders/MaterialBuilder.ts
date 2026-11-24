import type { AssetManager } from '../assets/AssetManager';
import type { MaterialDesc, ShaderBlockId } from '../render/IRenderBackend';
import {
  createPresetMaterial,
  SHADER_PRESET_NAMES,
  type ShaderPresetName,
} from '../render/ShaderPresets';

export type ColorTuple3 = readonly [number, number, number];
export type ColorTuple4 = readonly [number, number, number, number];
export type ColorInput = string | ColorTuple3 | ColorTuple4;

const warnedPresets = new Set<string>();

/**
 * Converts hex (`#rgb`, `#rrggbb`, `#rrggbbaa`), `rgb(...)`, `rgba(...)`, or numeric tuples into normalized `[r, g, b, a]`.
 */
export function parseColor(input: ColorInput, defaultAlpha = 1): [number, number, number, number] {
  if (typeof input !== 'string') {
    const r = Number(input[0] ?? 1);
    const g = Number(input[1] ?? 1);
    const b = Number(input[2] ?? 1);
    const a = input.length >= 4 ? Number(input[3] ?? defaultAlpha) : defaultAlpha;
    return [r, g, b, a];
  }
  const s = input.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16) / 255;
      const g = parseInt(hex[1] + hex[1], 16) / 255;
      const b = parseInt(hex[2] + hex[2], 16) / 255;
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : defaultAlpha;
      return [r, g, b, a];
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : defaultAlpha;
      return [r, g, b, a];
    }
  }
  const rgbMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(s);
  if (rgbMatch) {
    return [
      Number(rgbMatch[1]) / 255,
      Number(rgbMatch[2]) / 255,
      Number(rgbMatch[3]) / 255,
      rgbMatch[4] !== undefined ? Number(rgbMatch[4]) : defaultAlpha,
    ];
  }
  console.warn(`[QuarkEngine] Unknown color "${input}", falling back to white.`);
  return [1, 1, 1, defaultAlpha];
}

function resolveSafePreset(name: string): ShaderPresetName {
  if ((SHADER_PRESET_NAMES as readonly string[]).includes(name)) {
    return name as ShaderPresetName;
  }
  if (!warnedPresets.has(name)) {
    warnedPresets.add(name);
    console.warn(
      `[QuarkEngine] Unknown shader preset "${name}". Falling back to "ultraRealism". Valid presets: ${SHADER_PRESET_NAMES.join(', ')}`
    );
  }
  return 'ultraRealism';
}

/**
 * Fluent builder for materials and shader presets tailored for concise, typo-safe scene scripting.
 */
export class MaterialBuilder {
  private readonly desc: MaterialDesc;

  constructor(preset: ShaderPresetName | (string & {}) = 'ultraRealism') {
    const safe = resolveSafePreset(preset);
    const base = createPresetMaterial(safe);
    this.desc = {
      ...base,
      blocks: [...base.blocks],
      uniforms: {
        ...base.uniforms,
        baseColor: [...base.uniforms.baseColor],
        shadowTint: [...base.uniforms.shadowTint],
        rimColor: [...base.uniforms.rimColor],
        glowColor: [...base.uniforms.glowColor],
        edgeColor: [...base.uniforms.edgeColor],
      },
    };
  }

  color(c: ColorInput): this {
    this.desc.uniforms.baseColor = parseColor(c, this.desc.uniforms.baseColor[3]);
    if (this.desc.uniforms.baseColor[3] < 0.995) {
      this.desc.transparent = true;
    }
    return this;
  }

  glow(c: ColorInput): this {
    const [r, g, b] = parseColor(c);
    this.desc.uniforms.glowColor = [r, g, b];
    this.withBlock('pulseEmissive');
    return this;
  }

  edgeColor(c: ColorInput): this {
    const [r, g, b] = parseColor(c);
    this.desc.uniforms.edgeColor = [r, g, b];
    return this;
  }

  metallic(v: number): this {
    this.desc.uniforms.metallic = v;
    return this;
  }

  roughness(v: number): this {
    this.desc.uniforms.roughness = v;
    return this;
  }

  clearcoat(v: number): this {
    this.desc.uniforms.clearcoat = v;
    this.withBlock('clearcoat');
    return this;
  }

  cel(steps = 3): this {
    this.desc.uniforms.celSteps = steps;
    this.withBlock('celLighting');
    return this;
  }

  rim(power = 3): this {
    this.desc.uniforms.rimPower = power;
    this.withBlock('rimLight');
    return this;
  }

  outline(width = 0.03, color?: ColorInput): this {
    this.desc.outlineWidth = width;
    if (color) {
      const [r, g, b] = parseColor(color, 1);
      this.desc.outlineColor = [r, g, b];
    }
    return this;
  }

  dissolve(amount = 0.3): this {
    this.desc.uniforms.dissolve = amount;
    this.withBlock('dissolveNoise');
    return this;
  }

  wave(amp = 0.16, freq = 2.0): this {
    this.desc.uniforms.waveAmp = amp;
    this.desc.uniforms.waveFreq = freq;
    this.withBlock('vertexWave');
    return this;
  }

  dither(strength = 0.75): this {
    this.desc.uniforms.ditherStrength = strength;
    this.withBlock('pixelDither');
    return this;
  }

  grid(scale = 1.0): this {
    this.desc.uniforms.gridScale = scale;
    this.withBlock('triplanarGrid');
    return this;
  }

  water(opts: {
    style?: number;
    choppiness?: number;
    foam?: number;
    clarity?: number;
    amp?: number;
    freq?: number;
  }): this {
    if (opts.style !== undefined) this.desc.uniforms.waterStyle = opts.style;
    if (opts.choppiness !== undefined) this.desc.uniforms.waterChoppiness = opts.choppiness;
    if (opts.foam !== undefined) this.desc.uniforms.waterFoam = opts.foam;
    if (opts.clarity !== undefined) this.desc.uniforms.waterClarity = opts.clarity;
    if (opts.amp !== undefined) this.desc.uniforms.waveAmp = opts.amp;
    if (opts.freq !== undefined) this.desc.uniforms.waveFreq = opts.freq;
    this.withBlock('waterSurface');
    return this;
  }

  texture(textureId: number): this {
    this.desc.textureId = textureId;
    return this;
  }

  blocks(...blocks: ShaderBlockId[]): this {
    this.desc.blocks = [...blocks];
    return this;
  }

  withBlock(block: ShaderBlockId): this {
    if (!this.desc.blocks.includes(block)) {
      this.desc.blocks.push(block);
    }
    return this;
  }

  withoutBlock(block: ShaderBlockId): this {
    this.desc.blocks = this.desc.blocks.filter((b) => b !== block);
    return this;
  }

  transparent(blendMode: 'alpha' | 'additive' = 'alpha', depthWrite = false): this {
    this.desc.transparent = true;
    this.desc.blendMode = blendMode;
    this.desc.depthWrite = depthWrite;
    return this;
  }

  doubleSided(enabled = true): this {
    this.desc.doubleSided = enabled;
    return this;
  }

  polygonOffset(enabled = true): this {
    this.desc.polygonOffset = enabled;
    return this;
  }

  build(): MaterialDesc {
    return {
      ...this.desc,
      blocks: [...this.desc.blocks],
      uniforms: { ...this.desc.uniforms },
    };
  }

  create(assets: AssetManager, name = `mat-${Math.random().toString(36).slice(2, 8)}`, tag = 'scene'): number {
    if (!assets.hasBackend) return 0;
    return assets.createMaterial(name, this.build(), tag);
  }
}

/**
 * Starts a fluent material builder from any built-in shader preset (`ultraRealism`, `cyberNeon`, `animeToon`, etc.).
 */
export function material(preset: ShaderPresetName | (string & {}) = 'ultraRealism'): MaterialBuilder {
  return new MaterialBuilder(preset);
}
