import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createWorldBuilder, Engine, material, parseColor } from '../src';

const wasmBytes = readFileSync(resolve(import.meta.dirname, '../wasm/quark_core.wasm'));

describe('AI-Native Builders (material DSL & WorldBuilder)', () => {
  it('parses hex/rgb colors and builds materials with typo-safe fallback', () => {
    const sky = parseColor('#38bdf8');
    expect(sky[0]).toBeCloseTo(0x38 / 255, 4);
    expect(sky[1]).toBeCloseTo(0xbd / 255, 4);
    expect(sky[2]).toBeCloseTo(0xf8 / 255, 4);
    expect(sky[3]).toBe(1);

    const shortHex = parseColor('#f0a8');
    expect(shortHex[0]).toBeCloseTo(1, 4);
    expect(shortHex[3]).toBeCloseTo(0x88 / 255, 4);

    const built = material('cyberNeon')
      .color('#ff0080')
      .glow('#00ffff')
      .wave(0.15, 2.5)
      .outline(0.03, '#ffffff')
      .doubleSided()
      .build();

    expect(built.uniforms.baseColor[0]).toBeCloseTo(1, 4);
    expect(built.uniforms.glowColor[1]).toBeCloseTo(1, 4);
    expect(built.uniforms.waveAmp).toBeCloseTo(0.15, 4);
    expect(built.outlineWidth).toBeCloseTo(0.03, 4);
    expect(built.doubleSided).toBe(true);
    expect(built.blocks).toContain('vertexWave');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallback = material('totallyFakePresetName').build();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(fallback.blocks).toContain('pbrLighting');
    warnSpy.mockRestore();
  });

  it('constructs rooms, stairs, pools, breakables, and ASCII grids cleanly in WASM', async () => {
    const engine = await Engine.init({ wasmBytes });
    const world = createWorldBuilder(engine.scene, engine.assets);

    const rm = world.room({
      center: [0, 0, 0],
      size: [6, 3.2, 6],
      doors: ['east'],
      windows: ['south'],
      roof: true,
    });
    expect(rm.entities.length).toBeGreaterThanOrEqual(8);
    expect(rm.doors).toHaveLength(1);
    expect(rm.doors[0].toggle()).toBe(true);
    world.update(0.1);

    const stepEntities = world.stairs({
      from: [4, 0, 0],
      to: [8, 2.0, 0],
      width: 2.0,
      steps: 6,
    });
    expect(stepEntities).toHaveLength(6);

    const p = world.pool({
      center: [0, 0, 10],
      size: [5, 1.8, 5],
      glassSides: ['south'],
    });
    expect(p.entities.length).toBeGreaterThanOrEqual(6);
    expect(engine.scene.isPointUnderwater([0, 0.9, 10])).toBe(true);

    const grid = world.fromGrid(
      `
      #####
      #P.D#
      #CFW#
      #..B#
      #####
      `,
      { origin: [-20, 0, -20], cellSize: 2.4 }
    );
    expect(grid.doors).toHaveLength(1);
    expect(grid.campfires).toHaveLength(1);
    expect(grid.breakables).toHaveLength(1);
    expect(grid.waterSensors).toHaveLength(1);
    expect(grid.spawnPoint[0]).toBeCloseTo(-20 + 1 * 2.4, 4);

    // Shattering a breakable removes target and marks hit handled
    expect(world.handleRayHit(grid.breakables[0].entity, grid.spawnPoint)).toBe(true);
    expect(engine.scene.getActiveParticleCount()).toBeGreaterThan(0);

    for (let i = 0; i < 10; i++) engine.step(1 / 60);
  });
});
