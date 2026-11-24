import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composePostProcessShader,
  composeShader,
  createConeGeometry,
  createWaterVolumeGeometry,
  Engine,
  SHADER_BLOCK_IDS,
} from '../src';

const wasmBytes = readFileSync(resolve(import.meta.dirname, '../wasm/quark_core.wasm'));

describe('Next-Gen Engine Systems (Water Volume, GPU Particles, Volumetrics, Decals, Cloth)', () => {
  it('generates sealed 3D Water Volume and Cone geometries', () => {
    const vol = createWaterVolumeGeometry(6, 1.4, 6, 8);
    // Top grid (9x9=81) + 4 walls (4*18=72) + bottom cap (4) = 157 vertices * 8 floats
    expect(vol.vertices.length).toBe(157 * 8);
    expect(vol.indices.length).toBeGreaterThan(8 * 8 * 6);

    const cone = createConeGeometry(0.2, 1.5, 3.0, 12);
    expect(cone.vertices.length).toBe(13 * 2 * 8);
    expect(cone.indices.length).toBe(12 * 6);
  });

  it('compiles volumetricBeam, surfaceDecal, and underwater post-process shaders', () => {
    expect(SHADER_BLOCK_IDS).toContain('volumetricBeam');
    expect(SHADER_BLOCK_IDS).toContain('surfaceDecal');

    const beam = composeShader({ blocks: ['volumetricBeam', 'distanceFog'] });
    expect(beam.fragmentSource).toContain('ndotvBeam');

    const decal = composeShader({ blocks: ['surfaceDecal', 'distanceFog'] });
    expect(decal.fragmentSource).toContain('scorchCol');

    const pp = composePostProcessShader();
    expect(pp.fragmentSource).toContain('u_underwater');
  });

  it('simulates GPU particles, underwater camera depth, and Verlet cloth inside WASM', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;

    scene.addWaterZone({ center: [0, 1, 0], halfExtents: [3, 1, 3] });
    expect(scene.isPointUnderwater([0, 0.5, 0])).toBe(true);
    expect(scene.getUnderwaterDepth([0, 0.5, 0])).toBeCloseTo(1.5, 4);
    expect(scene.isPointUnderwater([0, 2.5, 0])).toBe(false);

    scene.emitVfx('sparks', [0, 1, 0], 40);
    scene.emitVfx('smoke', [0, 1, 0], 20);
    expect(scene.getActiveParticleCount()).toBe(60);

    const clothId = scene.createCloth({
      origin: [0, 3, 0],
      rightStep: [0.3, 0, 0],
      downStep: [0, -0.3, 0],
      cols: 6,
      rows: 5,
      pinTop: true,
    });
    scene.setClothWind(clothId, [3.0, 0.2, 1.2]);

    for (let i = 0; i < 20; i++) {
      engine.step(1 / 60);
    }

    const alphaView = engine.bridge.getParticlesAlphaView();
    const addView = engine.bridge.getParticlesAddView();
    expect(alphaView.length).toBe(20 * 12);
    expect(addView.length).toBe(40 * 12);

    const clothVerts = scene.getClothVerticesView(clothId);
    const clothIdx = scene.getClothIndicesCopy(clothId);
    expect(clothVerts.length).toBe(6 * 5 * 8);
    expect(clothIdx.length).toBe(5 * 4 * 6);
    expect(Number.isFinite(clothVerts[clothVerts.length - 8])).toBe(true);
  });
});
