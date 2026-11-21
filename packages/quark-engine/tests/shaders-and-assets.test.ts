import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AssetManager } from '../src/assets/AssetManager';
import { Engine } from '../src/Engine';
import type { IRenderBackend, MaterialDesc, MeshGeometry } from '../src/render/IRenderBackend';
import { composeShader, SHADER_BLOCK_IDS } from '../src/render/ShaderBlocks';
import { createPresetMaterial, SHADER_PRESET_NAMES } from '../src/render/ShaderPresets';

const wasmBytes = readFileSync(resolve(import.meta.dirname, '../wasm/quark_core.wasm'));

class StubRenderBackend implements IRenderBackend {
  nextMeshId = 1;
  nextMatId = 1;
  nextTexId = 1;
  readonly activeMeshes = new Set<number>();
  readonly activeMaterials = new Set<number>();
  readonly activeTextures = new Set<number>();

  createMesh(_geom: MeshGeometry): number {
    const id = this.nextMeshId++;
    this.activeMeshes.add(id);
    return id;
  }
  disposeMesh(id: number): void {
    this.activeMeshes.delete(id);
  }
  createMaterial(_desc: MaterialDesc): number {
    const id = this.nextMatId++;
    this.activeMaterials.add(id);
    return id;
  }
  updateMaterial(_id: number, _patch: Partial<MaterialDesc>): void {}
  disposeMaterial(id: number): void {
    this.activeMaterials.delete(id);
  }
  createTexture(_width: number, _height: number, _pixels: Uint8Array, _pixelated?: boolean): number {
    const id = this.nextTexId++;
    this.activeTextures.add(id);
    return id;
  }
  disposeTexture(id: number): void {
    this.activeTextures.delete(id);
  }
  renderFrame(): number {
    return 0;
  }
  dispose(): void {
    this.activeMeshes.clear();
    this.activeMaterials.clear();
    this.activeTextures.clear();
  }
}

describe('ShaderBlocks, ShaderPresets & AssetManager', () => {
  it('composes GLSL 300 es vertex and fragment shaders from selected ShaderBlocks without duplicates', () => {
    const { vertexSource, fragmentSource } = composeShader({
      blocks: ['celLighting', 'rimLight', 'vertexWave', 'pixelDither', 'distanceFog'],
    });
    expect(vertexSource).toContain('#version 300 es');
    expect(fragmentSource).toContain('#version 300 es');
    expect(vertexSource).toContain('applyVertexWave');
    expect(fragmentSource).toContain('evalCelLighting');
    expect(fragmentSource).toContain('evalRimLight');
    expect(fragmentSource).toContain('applyPixelDither');
    expect(fragmentSource).toContain('applyDistanceFog');
    expect(SHADER_BLOCK_IDS.length).toBeGreaterThanOrEqual(8);
  });

  it('creates all built-in ShaderPresets with typed defaults and overrides', () => {
    expect(SHADER_PRESET_NAMES).toEqual([
      'pbr',
      'animeToon',
      'hologram',
      'dissolve',
      'retroDither',
      'waveSurface',
    ]);

    const toon = createPresetMaterial('animeToon', { outlineWidth: 0.045 });
    expect(toon.outlineWidth).toBeCloseTo(0.045, 5);
    expect(toon.blocks).toContain('celLighting');
    expect(toon.blocks).toContain('rimLight');

    const holo = createPresetMaterial('hologram');
    expect(holo.transparent).toBe(true);
    expect(holo.blocks).toContain('hologramScanline');
    expect(holo.blocks).toContain('fresnelGlow');
  });

  it('AssetManager tracks resources by tag and disposes tag-scoped assets without leaking', async () => {
    const engine = await Engine.init({ wasmBytes });
    const backend = new StubRenderBackend();
    const assets = new AssetManager(engine.bridge, backend);

    const meshGlobal = assets.registerMesh(
      'hero',
      {
        vertices: new Float32Array(24),
        indices: new Uint32Array([0, 1, 2]),
      },
      'global'
    );
    const meshLevel = assets.registerMesh(
      'crate',
      {
        vertices: new Float32Array(24),
        indices: new Uint32Array([0, 1, 2]),
      },
      'level-1'
    );
    const matLevel = assets.createPreset('crate-mat', 'animeToon', {}, 'level-1');

    expect(backend.activeMeshes.has(meshGlobal.meshId)).toBe(true);
    expect(backend.activeMeshes.has(meshLevel.meshId)).toBe(true);
    expect(backend.activeMaterials.has(matLevel)).toBe(true);

    assets.unloadTag('level-1');
    expect(backend.activeMeshes.has(meshGlobal.meshId)).toBe(true);
    expect(backend.activeMeshes.has(meshLevel.meshId)).toBe(false);
    expect(backend.activeMaterials.has(matLevel)).toBe(false);

    assets.dispose();
    expect(backend.activeMeshes.size).toBe(0);
    engine.dispose();
  });
});
