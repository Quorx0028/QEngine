import { describe, expect, it } from 'vitest';
import {
  composeShader,
  createPresetMaterial,
  OrbitControls,
  SHADER_BLOCK_IDS,
  SHADER_PRESET_NAMES,
} from '../src';

describe('OrbitControls', () => {
  it('orbits around target, clamps poles, pans, zooms within bounds, and converges smoothly', () => {
    const cam = {
      position: [0, 3, 8] as [number, number, number],
      target: [0, 1, 0] as [number, number, number],
    };
    const controls = new OrbitControls({
      target: [0, 1, 0],
      radius: 8,
      minRadius: 2,
      maxRadius: 25,
      damping: 12,
    });

    controls.orbit(Math.PI * 0.5, 0.4);
    for (let i = 0; i < 60; i++) controls.update(1 / 60, cam);

    const dist = Math.hypot(
      cam.position[0] - cam.target[0],
      cam.position[1] - cam.target[1],
      cam.position[2] - cam.target[2]
    );
    expect(dist).toBeCloseTo(8, 2);

    // Pole clamp prevents NaN or gimbal flip
    controls.orbit(0, 100);
    controls.update(0.1, cam);
    expect(Number.isFinite(cam.position[0])).toBe(true);
    expect(Number.isFinite(cam.position[1])).toBe(true);
    expect(Number.isFinite(cam.position[2])).toBe(true);
    expect(cam.position[1] - cam.target[1]).toBeGreaterThan(0);

    // Zoom clamps to [minRadius, maxRadius]
    controls.zoom(-100);
    for (let i = 0; i < 60; i++) controls.update(1 / 60, cam);
    const minDist = Math.hypot(
      cam.position[0] - cam.target[0],
      cam.position[1] - cam.target[1],
      cam.position[2] - cam.target[2]
    );
    expect(minDist).toBeGreaterThanOrEqual(1.99);

    controls.zoom(500);
    for (let i = 0; i < 60; i++) controls.update(1 / 60, cam);
    const maxDist = Math.hypot(
      cam.position[0] - cam.target[0],
      cam.position[1] - cam.target[1],
      cam.position[2] - cam.target[2]
    );
    expect(maxDist).toBeLessThanOrEqual(25.01);

    // Pan shifts target cleanly
    const beforeX = cam.target[0];
    const beforeZ = cam.target[2];
    controls.pan(2.5, 0);
    controls.update(0.5, cam);
    expect(Math.hypot(cam.target[0] - beforeX, cam.target[2] - beforeZ)).toBeGreaterThan(0.5);
  });

  it('autoRotates horizontally when enabled', () => {
    const cam = {
      position: [0, 2, 6] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
    };
    const controls = new OrbitControls({ autoRotate: true, autoRotateSpeed: 1.5, damping: 20 });
    controls.update(0.016, cam);
    const x0 = cam.position[0];
    for (let i = 0; i < 20; i++) controls.update(1 / 60, cam);
    expect(cam.position[0]).not.toBeCloseTo(x0, 3);
  });

  it('fly() moves camera and target along gaze vectors, and freelook() keeps camera position fixed', () => {
    const cam = {
      position: [0, 2, 10] as [number, number, number],
      target: [0, 2, 0] as [number, number, number],
    };
    const controls = new OrbitControls({
      target: [0, 2, 0],
      radius: 10,
      theta: 0,
      phi: Math.PI * 0.5,
      rightClickLook: true,
    });
    controls.update(1, cam);
    const eyeBefore: [number, number, number] = [...cam.position];

    // Fly forward (+3 toward -Z), right (+2 toward +X), up (+1 toward +Y)
    controls.fly(3, 2, 1);
    controls.update(0.016, cam);
    expect(cam.position[0]).toBeCloseTo(eyeBefore[0] + 2, 1);
    expect(cam.position[1]).toBeCloseTo(eyeBefore[1] + 1, 1);
    expect(cam.position[2]).toBeCloseTo(eyeBefore[2] - 3, 1);

    // Freelook pivots target around current camera eye without teleporting camera position
    const eyeLock: [number, number, number] = [...cam.position];
    controls.freelook(0.6, -0.3);
    controls.update(0.016, cam);
    expect(cam.position[0]).toBeCloseTo(eyeLock[0], 2);
    expect(cam.position[1]).toBeCloseTo(eyeLock[1], 2);
    expect(cam.position[2]).toBeCloseTo(eyeLock[2], 2);
    expect(cam.target[0]).toBeLessThan(eyeLock[0]);
  });
});

describe('Water 2.0 Gerstner Shader & Presets', () => {
  it('exposes waterSurface block and compiles non-uniform Gerstner GLSL with style controls', () => {
    expect(SHADER_BLOCK_IDS).toContain('waterSurface');
    expect(SHADER_PRESET_NAMES).toContain('waterRealistic');
    expect(SHADER_PRESET_NAMES).toContain('waterAnime');

    const { vertexSource, fragmentSource } = composeShader({
      blocks: ['waterSurface', 'distanceFog'],
    });
    expect(vertexSource).toContain('gerstnerWave');
    expect(vertexSource).toContain('u_waterChoppiness');
    expect(fragmentSource).toContain('u_waterStyle');
    expect(fragmentSource).toContain('u_waterFoam');
    expect(fragmentSource).toContain('u_waterClarity');

    const realistic = createPresetMaterial('waterRealistic');
    const anime = createPresetMaterial('waterAnime');
    expect(realistic.uniforms.waterStyle).toBeLessThan(0.2);
    expect(anime.uniforms.waterStyle).toBeGreaterThan(0.8);
    expect(realistic.transparent).toBe(true);
    expect(anime.transparent).toBe(true);
  });
});
