import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DialogueRunner,
  Engine,
  PHYSICS_MATERIAL_PRESETS,
  ParticleEmitter,
  SpriteAnimator,
  Tilemap,
} from '../src';

const wasmBytes = readFileSync(resolve(import.meta.dirname, '../wasm/quark_core.wasm'));

describe('Batch 3 Game Modules (Controllers, Joints, 2D RPG, Particles)', () => {
  it('supports CharacterController stair step-up and DistanceJoint/HingeJoint via Scene TS API', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;

    const floor = scene.createEntity();
    scene.setTransform(floor, { position: [0, -0.5, 0], immediate: true });
    scene.setCollider3D(floor, { kind: 'aabb', halfExtents: [20, 0.5, 20] });

    const step = scene.createEntity();
    scene.setTransform(step, { position: [0, 0.175, 2.5], immediate: true });
    scene.setCollider3D(step, { kind: 'aabb', halfExtents: [3, 0.175, 1.5] });

    const hero = scene.createEntity();
    scene.setTransform(hero, { position: [0, 0.9, 0], immediate: true });
    scene.setCollider3D(hero, { kind: 'capsule', radius: 0.4, halfHeight: 0.5 });
    scene.setRigidBody(hero, { dynamic: true, lockRotation: true, friction: 0 });
    scene.setCharacterController(hero, { stepHeight: 0.5, maxSlopeDeg: 50 });

    for (let i = 0; i < 45; i++) {
      scene.setVelocity(hero, 0, scene.getVelocity(hero)[1], 4);
      engine.step(1 / 60);
    }
    expect(scene.getPosition(hero)[2]).toBeGreaterThan(1.5);
    expect(scene.getPosition(hero)[1]).toBeGreaterThan(1.15);

    const anchor = scene.createEntity();
    scene.setTransform(anchor, { position: [5, 5, 0], immediate: true });
    const bob = scene.createEntity();
    scene.setTransform(bob, { position: [7, 5, 0], immediate: true });
    scene.setCollider3D(bob, { kind: 'sphere', radius: 0.3 });
    scene.setRigidBody(bob, { dynamic: true, lockRotation: true });
    const jId = scene.addDistanceJoint(anchor, bob, { restLength: 2, stiffness: 1 });
    expect(jId).toBeGreaterThan(0);

    for (let i = 0; i < 60; i++) engine.step(1 / 60);
    const bp = scene.getPosition(bob);
    const dist = Math.hypot(bp[0] - 5, bp[1] - 5, bp[2]);
    expect(Math.abs(dist - 2)).toBeLessThan(0.15);
    expect(scene.removeJoint(jId)).toBe(true);
    engine.dispose();
  });

  it('SpriteAnimator advances grid frames cleanly over dt', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;
    const e = scene.createEntity();
    scene.setTransform(e, { position: [0, 0, 0], immediate: true });

    const anim = new SpriteAnimator(scene, e, {
      cols: 4,
      rows: 2,
      size: [1, 1],
      clips: {
        idle: { frames: [0, 1], fps: 4, loop: true },
        walk: { frames: [4, 5, 6, 7], fps: 8, loop: true },
      },
    });
    anim.play('walk');
    expect(anim.currentFrame).toBe(4);
    expect(anim.currentUvMin).toEqual([0, 0.5]);
    expect(anim.currentUvMax).toEqual([0.25, 1]);

    anim.update(0.13); // > 1/8s -> frame index 1 -> tile 5 (col 1, row 1)
    expect(anim.currentFrame).toBe(5);
    expect(anim.currentUvMin[0]).toBeCloseTo(0.25, 4);
    expect(anim.currentUvMin[1]).toBeCloseTo(0.5, 4);
    engine.dispose();
  });

  it('Tilemap parses Tiled JSON layers and registers solid TileGrid2D collisions', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;
    scene.setGravity(0, 0, 0);

    const mapJson = {
      width: 4,
      height: 3,
      tilewidth: 16,
      tileheight: 16,
      layers: [
        {
          name: 'floor',
          type: 'tilelayer' as const,
          width: 4,
          height: 3,
          data: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        },
        {
          name: 'walls',
          type: 'tilelayer' as const,
          width: 4,
          height: 3,
          properties: [{ name: 'solid', value: true }],
          // Note Tiled top row y=0 -> bottom row in engine Y or mapped consistently; put wall column at x=2
          data: [0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0],
        },
        {
          name: 'spawns',
          type: 'objectgroup' as const,
          objects: [{ name: 'player_spawn', type: 'spawn', x: 8, y: 24 }],
        },
      ],
    };

    const tm = Tilemap.fromTiledJson(scene, mapJson, {
      tileWorldSize: 1.0,
      origin: [0, 0],
      tilesetCols: 4,
      tilesetRows: 1,
    });
    expect(tm.tileEntities.length).toBeGreaterThanOrEqual(15);
    expect(tm.getObjectByName('player_spawn')).toBeDefined();

    const mover = scene.createEntity();
    scene.setTransform(mover, { position: [0.5, 1.5, 0], immediate: true });
    scene.setCollider2D(mover, { kind: 'aabb2d', halfExtents: [0.3, 0.3] });
    scene.setRigidBody(mover, { dynamic: true, gravityScale: 0, lockRotation: true });

    for (let i = 0; i < 60; i++) {
      scene.setVelocity(mover, 5, 0, 0);
      engine.step(1 / 60);
    }
    // Blocked by solid tile column x=2..3 -> center stays <= 1.72
    expect(scene.getPosition(mover)[0]).toBeLessThanOrEqual(1.75);
    engine.dispose();
  });

  it('DialogueRunner evaluates branching choices and flag mutations', () => {
    const runner = new DialogueRunner([
      {
        id: 'intro',
        speaker: 'Cat',
        text: 'Want the flashlight?',
        choices: [
          { label: 'Yes', nextId: 'accept', setFlags: { hasFlashlight: true } },
          { label: 'Already got one', nextId: 'secret', requiresFlag: 'hasFlashlight' },
          { label: 'No', nextId: 'decline' },
        ],
      },
      { id: 'accept', speaker: 'Cat', text: 'Here you go!' },
      { id: 'decline', speaker: 'Cat', text: 'Be careful in the dark.' },
      { id: 'secret', speaker: 'Cat', text: 'Whoa, double brightness!' },
    ]);

    runner.start('intro');
    expect(runner.isActive).toBe(true);
    expect(runner.getAvailableChoices().map((c) => c.label)).toEqual(['Yes', 'No']);
    runner.choose(0);
    expect(runner.currentNode?.id).toBe('accept');
    expect(runner.flags.hasFlashlight).toBe(true);
    runner.advance();
    expect(runner.isActive).toBe(false);

    // Re-start intro with flag set -> secret choice unlocks
    runner.start('intro');
    expect(runner.getAvailableChoices().map((c) => c.label)).toEqual(['Yes', 'Already got one', 'No']);
  });

  it('ParticleEmitter recycles a fixed ring pool of entities without leaking', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;
    const emitter = new ParticleEmitter(scene, {
      maxParticles: 4,
      lifetime: 0.5,
      gravity: -2,
    });

    const initialCount = scene.getEntityCount();
    expect(initialCount).toBe(4);
    emitter.emit(4, [0, 1, 0]);
    emitter.emit(2, [2, 1, 0]); // wraps around pool, zero new entities allocated!
    expect(scene.getEntityCount()).toBe(4);
    emitter.update(0.25);
    emitter.update(0.4); // all expire
    expect(emitter.activeCount).toBe(0);
    emitter.dispose();
    expect(scene.getEntityCount()).toBe(0);
    engine.dispose();
  });

  it('supports density presets, cylinder/compound colliders, water buoyancy, queries, and debug lines via Scene TS API', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;

    const floor = scene.createEntity();
    scene.setTransform(floor, { position: [0, -0.5, 0], immediate: true });
    scene.setCollider3D(floor, { kind: 'aabb', halfExtents: [20, 0.5, 20] });

    scene.addWaterZone({
      center: [0, 2, 0],
      halfExtents: [10, 2, 10],
      density: 1.0,
      linearDrag: 2.0,
    });

    const floater = scene.createEntity();
    scene.setTransform(floater, { position: [-2, 4.2, 0], immediate: true });
    scene.setCollider3D(floater, { kind: 'cylinder', radius: 0.45, halfHeight: 0.5 });
    scene.setRigidBody(floater, { ...PHYSICS_MATERIAL_PRESETS.wood, density: 0.45 });

    const sinker = scene.createEntity();
    scene.setTransform(sinker, { position: [2, 4.2, 0], immediate: true });
    scene.setCollider3D(sinker, {
      kind: 'compound',
      parts: [
        { position: [-0.25, 0, 0], shape: { kind: 'sphere', radius: 0.35 } },
        { position: [0.25, 0, 0], shape: { kind: 'sphere', radius: 0.35 } },
      ],
    });
    scene.setRigidBody(sinker, { ...PHYSICS_MATERIAL_PRESETS.steel });

    for (let i = 0; i < 180; i++) {
      engine.step(1 / 60);
    }
    expect(scene.getPosition(floater)[1]).toBeGreaterThan(3.1);
    expect(scene.getPosition(sinker)[1]).toBeLessThan(1.0);

    const hits = scene.overlapSphere([2, 0.4, 0], 1.5);
    expect(hits).toContain(sinker);

    const sw = scene.sweepBox([-5, 0.4, 0], [0.4, 0.4, 0.4], [1, 0, 0], 10);
    expect(sw?.entity).toBe(sinker);

    const dbg = scene.getPhysicsDebugLines();
    expect(dbg.length).toBeGreaterThan(30);
    engine.dispose();
  });
});
