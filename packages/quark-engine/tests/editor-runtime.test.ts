import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BlueprintRuntime,
  createStarterProject,
  Engine,
  generateProceduralTexturePixels,
  ProjectRunner,
  TransformGizmo,
  type IRenderBackend,
} from '../src/index';

const wasmPath = path.resolve(__dirname, '../wasm/quark_core.wasm');
const wasmBytes = fs.readFileSync(wasmPath);

function createMockBackend(): IRenderBackend {
  let id = 1;
  return {
    createMesh: () => id++,
    disposeMesh: () => {},
    createMaterial: () => id++,
    updateMaterial: () => {},
    disposeMaterial: () => {},
    createTexture: () => id++,
    disposeTexture: () => {},
    renderFrame: () => 0,
    dispose: () => {},
  };
}

describe('QuarkStudio Editor Runtime (Schema, Textures, Blueprints, Edit/Play Runner)', () => {
  it('generateProceduralTexturePixels produces valid 128x128 RGBA textures for every preset', () => {
    for (const kind of ['grid', 'checker', 'brick', 'wood', 'stone', 'metal'] as const) {
      const px = generateProceduralTexturePixels(kind, 128);
      expect(px.byteLength).toBe(128 * 128 * 4);
      expect(px[3]).toBe(255);
    }
  });

  it('ProjectRunner freezes dynamics in Edit mode and runs gravity + Blueprints in Play mode', async () => {
    const engine = await Engine.init({ wasmBytes, backend: createMockBackend() });
    const doc = createStarterProject('escapeRoom');

    // Edit mode: dynamic crate must stay fixed in place and never fall
    const crateDef = doc.entities.find((e) => e.id === 'crate_decor')!;
    const initialY = crateDef.position[1];

    const editRunner = await ProjectRunner.mount(engine, doc, 'edit');
    for (let i = 0; i < 60; i++) {
      editRunner.fixedUpdate(1 / 60);
      engine.step(1 / 60);
      editRunner.update(1 / 60);
    }
    const crateEditEid = editRunner.docToEid.get('crate_decor')!;
    expect(Math.abs(engine.scene.getPosition(crateEditEid)[1] - initialY)).toBeLessThan(0.01);
    editRunner.dispose();

    // Play mode: start banner fires, HUD counter initializes, key pickup sets variable & opens door
    const banners: string[] = [];
    const counters: Array<{ label: string; value: unknown }> = [];
    const playRunner = await ProjectRunner.mount(engine, doc, 'play', {
      onShowBanner: (title) => banners.push(title),
      onUpdateHudCounter: (label, value) => counters.push({ label, value }),
    });
    expect(banners.length).toBeGreaterThanOrEqual(1);
    expect(counters.some((c) => c.label === 'Ключи')).toBe(true);

    // Move player onto key trigger & door trigger, step physics + blueprints
    const playerEid = playRunner.getPlayerEntity()!;
    const keyDef = doc.entities.find((e) => e.id === 'key_gold')!;
    engine.scene.setTransform(playerEid, { position: [...keyDef.position], immediate: true });
    for (let i = 0; i < 20; i++) {
      engine.step(1 / 60);
      playRunner.update(1 / 60);
    }
    expect(counters.some((c) => c.label === 'Ключи' && Number(c.value) === 1)).toBe(true);

    const doorTrig = doc.entities.find((e) => e.id === 'trig_door')!;
    const doorStartY = doc.entities.find((e) => e.id === 'door_locked')!.position[1];
    engine.scene.setTransform(playerEid, { position: [...doorTrig.position], immediate: true });
    for (let i = 0; i < 65; i++) {
      engine.step(1 / 60);
      playRunner.update(1 / 60);
    }
    const doorEid = playRunner.docToEid.get('door_locked')!;
    expect(engine.scene.getPosition(doorEid)[1]).toBeGreaterThan(doorStartY + 1.5);

    playRunner.dispose();
    engine.dispose();
  });

  it('BlueprintRuntime handles delay timers, gateOnce, and setStaticLocked cleanly', async () => {
    const engine = await Engine.init({ wasmBytes });
    const box = engine.scene.createEntity();
    engine.scene.setTransform(box, { position: [0, 5, 0], immediate: true });
    engine.scene.setCollider3D(box, { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] });
    engine.scene.setRigidBody(box, { dynamic: false, mass: 0 });

    const executed: string[] = [];
    const bp = new BlueprintRuntime(
      [
        {
          id: 'g1',
          name: 'Test',
          enabled: true,
          nodes: [
            { id: 's', type: 'onStart', x: 0, y: 0, params: {} },
            { id: 'd', type: 'delay', x: 100, y: 0, params: { seconds: 0.2 } },
            { id: 'u', type: 'setStaticLocked', x: 200, y: 0, params: { entityId: 'b1', locked: false } },
          ],
          edges: [
            { id: 'e1', fromNode: 's', fromPort: 'out', toNode: 'd', toPort: 'in' },
            { id: 'e2', fromNode: 'd', fromPort: 'out', toNode: 'u', toPort: 'in' },
          ],
        },
      ],
      {
        scene: engine.scene,
        assets: engine.assets,
        audio: engine.audio,
        getPlayerEntity: () => null,
        resolveEntityId: (id) => (id === 'b1' ? box : null),
        resolveLightIndex: () => null,
        getEntityEulerDeg: () => [0, 0, 0],
        setEntityEulerDeg: () => {},
        setEntityStaticLocked: (_id, locked) => {
          engine.scene.setRigidBody(box, { dynamic: !locked, mass: locked ? 0 : 1.0 });
        },
        onNodeExecuted: (nid) => executed.push(nid),
      }
    );

    bp.fireStart();
    for (let i = 0; i < 45; i++) {
      engine.step(1 / 60);
      bp.update(1 / 60);
    }
    expect(executed).toContain('u');
    expect(engine.scene.getPosition(box)[1]).toBeLessThan(4.5);

    bp.dispose();
    engine.dispose();
  });

  it('TransformGizmo selects recycled entity IDs after resetHandles and ProjectRunner picks triggers & rooms cleanly', async () => {
    const engine = await Engine.init({ wasmBytes, backend: createMockBackend() });
    const gizmo = new TransformGizmo(engine.scene, engine.assets, null, {});
    gizmo.setEnabled(true); // creates handle entities 1..7 BEFORE scene.clear()
    gizmo.resetHandles();

    const doc = createStarterProject('escapeRoom');
    const runner = await ProjectRunner.mount(engine, doc, 'edit', { showTriggersInEdit: true });

    // Every doc entity (including floor_main e1 and room_main e2) must be selectable via gizmo.select
    for (const ent of doc.entities) {
      const eid = runner.docToEid.get(ent.id)!;
      gizmo.select(eid);
      expect(gizmo.getSelected()).toBe(eid);
    }

    // Ray aimed straight at gold key [-3.0, 1.15, -2.5] picks key_gold first (even though isTrigger: true)
    const keyHits = runner.pickEntitiesAlongRay([-3.0, 4.0, 1.0], [0, -2.85 / Math.hypot(2.85, 3.5), -3.5 / Math.hypot(2.85, 3.5)]);
    expect(keyHits.length).toBeGreaterThanOrEqual(1);
    expect(runner.eidToDoc.get(keyHits[0])).toBe('key_gold');

    // Ray aimed straight at trig_door [0, 1.1, -3.7] picks trig_door when triggers shown, and skips it when hidden
    const trigHitsShown = runner.pickEntitiesAlongRay([0, 2.0, 1.0], [0, -0.9 / Math.hypot(0.9, 4.7), -4.7 / Math.hypot(0.9, 4.7)], { includeTriggers: true });
    expect(runner.eidToDoc.get(trigHitsShown[0])).toBe('trig_door');
    const trigHitsHidden = runner.pickEntitiesAlongRay([0, 2.0, 1.0], [0, -0.9 / Math.hypot(0.9, 4.7), -4.7 / Math.hypot(0.9, 4.7)], { includeTriggers: false });
    expect(runner.eidToDoc.get(trigHitsHidden[0])).not.toBe('trig_door');

    gizmo.dispose();
    runner.dispose();
    engine.dispose();
  });
});
