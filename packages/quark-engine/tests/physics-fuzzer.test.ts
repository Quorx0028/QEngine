import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  PHYSICS_MATERIAL_PRESETS,
  quatFromEuler,
  type EntityId,
} from '../src';

const wasmBytes = readFileSync(resolve(__dirname, '../wasm/quark_core.wasm'));

function assertFiniteVec(v: [number, number, number], label: string) {
  for (let i = 0; i < 3; i++) {
    expect(Number.isFinite(v[i]), `${label}[${i}] must be finite (got ${v[i]})`).toBe(true);
  }
}

describe('Physics Invariant Fuzzer & Engine Crash Guard', () => {
  it('survives 360 ticks of mixed-shape pushing, elevated crates, water buoyancy, and CCD without NaNs or WASM traps', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;

    // Ground + raised table ledge
    const ground = scene.createEntity();
    scene.setTransform(ground, { position: [0, -0.5, 0], immediate: true });
    scene.setCollider3D(ground, { kind: 'aabb', halfExtents: [30, 0.5, 30] });

    const ledge = scene.createEntity();
    scene.setTransform(ledge, { position: [0, 0.45, -3.5], immediate: true });
    scene.setCollider3D(ledge, { kind: 'aabb', halfExtents: [2, 0.45, 1.5] });

    // Rotated OBB ramp
    const ramp = scene.createEntity();
    scene.setTransform(ramp, {
      position: [6, 0.9, -2],
      rotation: quatFromEuler(0.38, 0, 0),
      immediate: true,
    });
    scene.setCollider3D(ramp, { kind: 'aabb', halfExtents: [1.5, 0.2, 3.0] });

    const tracked: EntityId[] = [];
    const spawnDynamic = (
      pos: [number, number, number],
      col: Parameters<typeof scene.setCollider3D>[1],
      rb: Parameters<typeof scene.setRigidBody>[1]
    ) => {
      const e = scene.createEntity();
      scene.setTransform(e, { position: pos, immediate: true });
      scene.setCollider3D(e, col);
      scene.setRigidBody(e, rb);
      tracked.push(e);
      return e;
    };

    // Overhanging elevated crate BEFORE player + tall steel cube + stacked wood crates + cylinder + compound + hull
    spawnDynamic([0, 1.4, -2.1], { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] }, { ...PHYSICS_MATERIAL_PRESETS.wood });
    spawnDynamic([0, 0.8, -5.5], { kind: 'aabb', halfExtents: [0.8, 0.8, 0.8] }, { ...PHYSICS_MATERIAL_PRESETS.steel });
    spawnDynamic([-2.2, 0.5, -3.5], { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] }, { ...PHYSICS_MATERIAL_PRESETS.rubber });
    spawnDynamic([-2.2, 1.52, -3.5], { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] }, { ...PHYSICS_MATERIAL_PRESETS.wood });
    spawnDynamic([2.5, 0.7, -3.5], { kind: 'cylinder', radius: 0.45, halfHeight: 0.6 }, { ...PHYSICS_MATERIAL_PRESETS.stone });
    spawnDynamic(
      [-4.5, 1.0, -3.5],
      {
        kind: 'compound',
        parts: [
          { position: [-0.4, 0, 0], shape: { kind: 'aabb', halfExtents: [0.4, 0.25, 0.4] } },
          { position: [0.4, 0.4, 0], shape: { kind: 'aabb', halfExtents: [0.2, 0.6, 0.4] } },
        ],
      },
      { ...PHYSICS_MATERIAL_PRESETS.wood }
    );
    spawnDynamic([0, 2.2, 6.0], { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] }, { ...PHYSICS_MATERIAL_PRESETS.balsa });

    // Water zone at z = +4..+10
    scene.addWaterZone({ center: [0, 1.0, 7.0], halfExtents: [4, 1.0, 3], density: 1.0 });

    // Player capsule + CharacterController
    const player = scene.createEntity();
    scene.setTransform(player, { position: [0, 0.97, 1.0], immediate: true });
    scene.setCollider3D(player, { kind: 'capsule', radius: 0.42, halfHeight: 0.55 });
    scene.setRigidBody(player, { dynamic: true, mass: 70, lockRotation: true });
    scene.setCharacterController(player, {
      stepHeight: 0.5,
      maxSlopeDeg: 50,
      pushStrength: 0.9,
      maxPushMass: 35,
      groundSnap: 0.14,
      antiTipPush: true,
    });
    tracked.push(player);

    // Thin wall + fast CCD bullet
    const thinWall = scene.createEntity();
    scene.setTransform(thinWall, { position: [0, 1.5, -10], immediate: true });
    scene.setCollider3D(thinWall, { kind: 'aabb', halfExtents: [5, 1.5, 0.04] });
    const bullet = spawnDynamic([0, 1.2, 2.0], { kind: 'sphere', radius: 0.15 }, { ...PHYSICS_MATERIAL_PRESETS.steel, ccd: true });
    scene.setVelocity(bullet, 0, 0, -120);

    for (let tick = 0; tick < 360; tick++) {
      // Sweep player across arena targets: forward push, strafing, jumping
      const phase = tick % 120;
      const vx = phase < 40 ? 0 : phase < 80 ? -5.0 : 5.0;
      const vz = tick < 180 ? -6.5 : 4.5;
      const vy = tick % 45 === 10 && scene.isGrounded(player) ? 8.5 : scene.getVelocity(player)[1];
      scene.setVelocity(player, vx, vy, vz);

      engine.step(1 / 60);

      for (const id of tracked) {
        const p = scene.getPosition(id);
        const v = scene.getVelocity(id);
        assertFiniteVec(p, `entity ${id} pos @ tick ${tick}`);
        assertFiniteVec(v, `entity ${id} vel @ tick ${tick}`);
        expect(p[1], `entity ${id} fell out of world @ tick ${tick}`).toBeGreaterThan(-20);
      }
      if (tick % 60 === 0) {
        const hits = scene.overlapSphere(scene.getPosition(player), 4.0);
        expect(hits.length).toBeGreaterThan(0);
        const sw = scene.sweepBox([0, 1.0, 2.0], [0.3, 0.3, 0.3], [0, 0, -1], 20);
        expect(sw === null || Number.isFinite(sw.distance)).toBe(true);
        const dbg = scene.getPhysicsDebugLines();
        expect(dbg.length % 10).toBe(0);
      }
    }

    const stats = engine.getStats();
    expect(stats.timings.wasmStepMs).toBeGreaterThanOrEqual(0);
    expect(stats.timings.fixedMs).toBeGreaterThanOrEqual(0);
    engine.dispose();
  });

  it('Crash Guard catches runtime errors in guarded step without losing phase diagnostics', async () => {
    const engine = await Engine.init({ wasmBytes });
    const captured: string[] = [];
    engine.onError((err) => {
      captured.push(`${err.phase}:${err.message}`);
    });
    engine.onUpdate(() => {
      throw new Error('synthetic boom');
    });

    const alpha = engine.step(1 / 60, true);
    expect(alpha).toBe(0);
    expect(captured).toEqual(['update:synthetic boom']);
    expect(engine.getLastError()?.phase).toBe('update');

    engine.onUpdate(null);
    engine.clearError();
    expect(engine.getLastError()).toBeNull();
    engine.dispose();
  });
});
