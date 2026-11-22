import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AnimStateMachine,
  composeShader,
  createTerrainGeometry,
  defineBehavior,
  Engine,
  GameUI,
  Input,
} from '../src';

const wasmBytes = readFileSync(resolve(import.meta.dirname, '../wasm/quark_core.wasm'));

describe('Core Engine Systems (Nav, Terrain, SphereCast, Sockets, Behavior, FSM, InputMap, GameUI)', () => {
  it('auto-bakes 3D NavGrid around static obstacles and computes smoothed A* paths in WASM', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;

    const wall = scene.createEntity();
    scene.setTransform(wall, { position: [0.5, 1, 0.5], immediate: true });
    scene.setCollider3D(wall, { kind: 'aabb', halfExtents: [0.5, 1.5, 3.0] });

    scene.buildNavGrid3D({
      originX: -10,
      originZ: -10,
      cellSize: 1.0,
      width: 20,
      height: 20,
      minY: 0.1,
      maxY: 4.0,
      agentRadius: 0.4,
    });

    const path = scene.findNavPath([-3, 0.5], [3, 0.5], true);
    expect(path.length).toBeGreaterThanOrEqual(3);
    const goal = path[path.length - 1];
    expect(Math.abs(goal[0] - 3)).toBeLessThan(1.0);
    expect(Math.abs(goal[1] - 0.5)).toBeLessThan(1.0);
    // Waypoints detour in Z around wall [-2.5 .. +3.5]
    expect(path.some((pt) => Math.abs(pt[1]) > 2.5)).toBe(true);
    engine.dispose();
  });

  it('registers TerrainHeightmap physics/raycast + supports sphereCast3D and layer masks', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;

    const heights = new Float32Array([
      0, 0, 2,
      0, 0, 2,
      0, 0, 2,
    ]);
    const terrainEnt = scene.setTerrainHeightmap(-4, -4, 4, 3, 3, heights);
    expect(terrainEnt).toBeGreaterThan(0);

    const sample = scene.sampleTerrainHeight(2, 0);
    expect(sample).not.toBeNull();
    expect(sample!.height).toBeCloseTo(1.0, 2);
    expect(scene.sampleTerrainHeight(3, 0)!.height).toBeCloseTo(1.5, 2);

    const geom = createTerrainGeometry(heights, 3, 3, 4, -4, -4);
    expect(geom.vertices.length).toBe(9 * 8);
    expect(geom.indices.length).toBe(4 * 6);

    const target = scene.createEntity();
    scene.setTransform(target, { position: [0, 1.5, -5], immediate: true });
    scene.setCollider3D(target, { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] });
    scene.setCollisionFilter(target, 0b100, 0b100);

    // Thin ray slightly off to side (x=0.8) misses, while sphereCast(radius=0.45) hits layer 0b100
    expect(scene.raycast3D([0.8, 1.5, 0], [0, 0, -1], 20, 0b100)).toBeNull();
    const sphereHit = scene.sphereCast3D([0.8, 1.5, 0], 0.45, [0, 0, -1], 20, 0b100);
    expect(sphereHit?.entity).toBe(target);
    const filteredOut = scene.sphereCast3D([0.8, 1.5, 0], 0.45, [0, 0, -1], 20, 0b001);
    expect(filteredOut?.entity).not.toBe(target);
    engine.dispose();
  });

  it('Behavior lifecycle executes start/fixedUpdate/update/triggerEnter/destroy cleanly', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;
    scene.setGravity(0, 0, 0);

    let starts = 0;
    let fixedTicks = 0;
    let triggered = 0;
    let destroyed = 0;

    const MoverBehavior = defineBehavior('Mover', () => ({
      speed: 2,
      onStart() {
        starts++;
      },
      onFixedUpdate(ctx) {
        fixedTicks++;
        ctx.scene.setVelocity(ctx.entity, this.speed, 0, 0);
      },
      onTriggerEnter() {
        triggered++;
      },
      onDestroy() {
        destroyed++;
      },
    }));

    const sensor = scene.createEntity();
    scene.setTransform(sensor, { position: [1.5, 0, 0], immediate: true });
    scene.setCollider3D(sensor, { kind: 'aabb', halfExtents: [0.5, 1, 1] });
    scene.setTrigger(sensor, true);

    const e = scene.createEntity();
    scene.setTransform(e, { position: [0, 0, 0], immediate: true });
    scene.setCollider3D(e, { kind: 'sphere', radius: 0.4 });
    scene.setRigidBody(e, { dynamic: true, gravityScale: 0, linearDamping: 0 });
    const b = MoverBehavior({ speed: 4 });
    scene.addBehavior(e, b);
    expect(scene.getBehavior(e, 'Mover')).toBe(b);

    for (let i = 0; i < 30; i++) engine.step(1 / 60);
    expect(starts).toBe(1);
    expect(fixedTicks).toBeGreaterThanOrEqual(29);
    expect(triggered).toBe(1);

    scene.destroyEntity(e);
    expect(destroyed).toBe(1);
    engine.dispose();
  });

  it('AnimStateMachine switches states via declarative predicates and InputMap handles axes cleanly', () => {
    let active = '';
    let speed = 0;
    const fsm = new AnimStateMachine((s) => {
      active = s;
    })
      .addState('idle')
      .addState('run')
      .addTransition('idle', 'run', () => speed > 0.5, 0.15)
      .addTransition('run', 'idle', () => speed <= 0.5, 0.2)
      .start('idle');

    expect(active).toBe('idle');
    speed = 3.0;
    fsm.update();
    expect(active).toBe('run');
    speed = 0.0;
    fsm.update();
    expect(active).toBe('idle');

    const input = new Input();
    input.bindAxis('move_x', { posKeys: ['KeyD'], negKeys: ['KeyA'] });
    input.bindAction('jump', { keys: ['Space'] });
    expect(input.getAxis('move_x')).toBe(0);
    expect(input.isActionDown('jump')).toBe(false);

    const ui = new GameUI();
    ui.setBar('hp', 0.8, { label: 'HP' });
    ui.showPrompt('[E] Open');
    ui.dispose();
  });

  it('composeShader includes u_uvScale and terrainSplat slope/height blending', () => {
    const { vertexSource, fragmentSource } = composeShader({
      blocks: ['pbrLighting', 'terrainSplat'],
    });
    expect(vertexSource).toContain('uniform vec2 u_uvScale;');
    expect(vertexSource).toContain('v_uv = a_uv * u_uvScale;');
    expect(fragmentSource).toContain('evalTerrainSplat');
  });
});
