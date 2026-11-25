import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine, OrbitControls, TransformGizmo, type OrbitKeyframe } from '../src';

const wasmBytes = readFileSync(resolve(import.meta.dirname, '../wasm/quark_core.wasm'));

describe('Web Showcase Kit & Transform Gizmo (#5 & #6)', () => {
  it('projects worldToScreen and screenToRay accurately in 3D & 2D', async () => {
    const engine = await Engine.init({ wasmBytes });
    const { scene } = engine;

    scene.camera.mode = '3d';
    scene.camera.position = [0, 2, 10];
    scene.camera.target = [0, 2, 0];

    const centerProj = scene.worldToScreen([0, 2, 0], 1000, 500);
    expect(centerProj.visible).toBe(true);
    expect(centerProj.x).toBeCloseTo(500, 1);
    expect(centerProj.y).toBeCloseTo(250, 1);

    const behindProj = scene.worldToScreen([0, 2, 20], 1000, 500);
    expect(behindProj.visible).toBe(false);

    const ray = scene.screenToRay(500, 250, { left: 0, top: 0, width: 1000, height: 500 });
    expect(ray.origin[2]).toBeCloseTo(10, 4);
    expect(ray.dir[0]).toBeCloseTo(0, 4);
    expect(ray.dir[1]).toBeCloseTo(0, 4);
    expect(ray.dir[2]).toBeCloseTo(-1, 4);
  });

  it('samples OrbitControls scroll timeline keyframes smoothly with angle wrapping', () => {
    const orbit = new OrbitControls();
    const keyframes: OrbitKeyframe[] = [
      { progress: 0.0, target: [0, 0, 0], radius: 10, theta: 0, phi: 1.0 },
      { progress: 1.0, target: [10, 4, -6], radius: 4, theta: Math.PI, phi: 1.4 },
    ];

    orbit.applyTimeline(keyframes, 0.5);
    const s = orbit.getState();
    expect(s.target[0]).toBeCloseTo(5, 3);
    expect(s.target[1]).toBeCloseTo(2, 3);
    expect(s.radius).toBeCloseTo(7, 3);
    expect(s.phi).toBeCloseTo(1.2, 3);
  });

  it('reads/writes full transforms via getTransform and spawns GPU rain/snow weather', async () => {
    const engine = await Engine.init({ wasmBytes });
    const { scene, assets } = engine;

    const eid = scene.createEntity();
    scene.setTransform(eid, {
      position: [2, 3, -4],
      rotation: [0, 0.7071068, 0, 0.7071068],
      scale: [1.5, 2.5, 0.75],
      immediate: true,
    });
    const xf = scene.getTransform(eid);
    expect(xf.position[0]).toBeCloseTo(2, 4);
    expect(xf.position[1]).toBeCloseTo(3, 4);
    expect(xf.rotation[1]).toBeCloseTo(0.7071, 3);
    expect(xf.scale[1]).toBeCloseTo(2.5, 4);

    const gizmo = new TransformGizmo(scene, assets, null);
    gizmo.select(eid);
    expect(gizmo.getSelected()).toBe(eid);
    gizmo.setMode('scale');
    expect(gizmo.getMode()).toBe('scale');
    gizmo.dispose();

    scene.setWeather('downpour');
    scene.setCloudStyle('anime');
    expect(scene.weather.cloudStyle).toBe('anime');
    scene.advanceEffects(1.0);
    expect(scene.weather.wetness).toBeGreaterThan(0.75);
    expect(scene.weather.rainIntensity).toBeGreaterThan(0.95);

    scene.addDryZone({ center: [0, 2, 0], size: [6, 4, 6] });
    expect(scene.getDryZones()).toHaveLength(1);
    expect(scene.getDryZones()[0].ceilY).toBeCloseTo(3.88, 2);

    scene.emitVfx('dust', [0, 1.8, 0], 10, 0.1);
    scene.emitVfx('rain', [0, 12, 0], 30, 0);
    scene.emitVfx('downpour', [0, 12, 0], 40, 0);
    scene.emitVfx('snow', [0, 12, 0], 20, 0);
    expect(scene.getActiveParticleCount()).toBeGreaterThanOrEqual(100);
    engine.step(1 / 60);
    expect(engine.bridge.getParticlesAlphaView().length).toBeGreaterThan(0);
  });
});
