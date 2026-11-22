import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/Engine';

const wasmBytes = readFileSync(resolve(import.meta.dirname, '../wasm/quark_core.wasm'));

function makeMinimalGlb(): Uint8Array {
  const bin = new Uint8Array(44);
  const binView = new DataView(bin.buffer);
  const coords = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  coords.forEach((v, i) => binView.setFloat32(i * 4, v, true));
  [0, 1, 2].forEach((idx, i) => binView.setUint16(36 + i * 2, idx, true));

  const jsonStr = JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 44 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  });
  const enc = new TextEncoder();
  const rawJson = enc.encode(jsonStr);
  const paddedJsonLen = Math.ceil(rawJson.length / 4) * 4;
  const jsonBytes = new Uint8Array(paddedJsonLen);
  jsonBytes.fill(0x20);
  jsonBytes.set(rawJson);

  const totalLen = 12 + 8 + paddedJsonLen + 8 + bin.length;
  const out = new Uint8Array(totalLen);
  const dv = new DataView(out.buffer);
  out.set([0x67, 0x6c, 0x54, 0x46], 0); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLen, true);
  dv.setUint32(12, paddedJsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const binHeader = 20 + paddedJsonLen;
  dv.setUint32(binHeader, bin.length, true);
  dv.setUint32(binHeader + 4, 0x004e4942, true);
  out.set(bin, binHeader + 8);
  return out;
}

describe('WasmBridge & Engine headless integration', () => {
  it('recovers TypedArray views when WASM memory grows', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;
    const e = scene.createEntity();
    scene.setTransform(e, { position: [7, 2, -3], immediate: true });
    engine.step(1 / 60);

    const viewBefore = engine.bridge.getWorldMatricesView();
    expect(viewBefore[12]).toBeCloseTo(7, 4);

    // Force WASM memory.grow
    const ptr = engine.bridge.alloc(4 * 1024 * 1024);
    expect(ptr).toBeGreaterThan(0);
    engine.bridge.dealloc(ptr, 4 * 1024 * 1024);

    scene.setTransform(e, { position: [12, 4, -1], immediate: true });
    engine.step(1 / 60);
    const viewAfter = engine.bridge.getWorldMatricesView();
    expect(viewAfter.buffer.byteLength).toBeGreaterThan(0);
    expect(viewAfter[12]).toBeCloseTo(12, 4);
    expect(viewAfter[13]).toBeCloseTo(4, 4);
    engine.dispose();
  });

  it('runs fixed-timestep capsule collision without jitter from TypeScript', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;
    scene.setGravity(0, 0, 0);

    const wall = scene.createEntity();
    scene.setTransform(wall, { position: [0, 1, 2], immediate: true });
    scene.setCollider3D(wall, { kind: 'aabb', halfExtents: [10, 2, 0.5] });

    const player = scene.createEntity();
    scene.setTransform(player, { position: [0, 1, 0], immediate: true });
    scene.setCollider3D(player, { kind: 'capsule', radius: 0.4, halfHeight: 0.5 });
    scene.setRigidBody(player, { dynamic: true, gravityScale: 0, friction: 0 });

    for (let i = 0; i < 60; i++) {
      scene.setVelocity(player, 4, 0, 4);
      engine.step(1 / 60);
    }

    const pos = scene.getPosition(player);
    expect(pos[0]).toBeGreaterThan(3.5);
    expect(pos[2]).toBeLessThanOrEqual(1.105);
    engine.dispose();
  });

  it('parses a minimal GLB buffer in WASM and cleans up buffers', async () => {
    const engine = await Engine.init({ wasmBytes });
    const glb = makeMinimalGlb();
    const parsed = engine.bridge.parseGlb(glb);
    expect(parsed.vertices.length).toBe(24);
    expect(Array.from(parsed.indices)).toEqual([0, 1, 2]);
    expect(parsed.submeshes.length).toBe(1);
    expect(parsed.boundsMax[0]).toBeCloseTo(1, 4);
    engine.dispose();
  });

  it('applies off-center impulse and stops sliding via friction from TypeScript', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;

    const floor = scene.createEntity();
    scene.setTransform(floor, { position: [0, -0.5, 0], immediate: true });
    scene.setCollider3D(floor, { kind: 'aabb', halfExtents: [25, 0.5, 25] });

    const cube = scene.createEntity();
    scene.setTransform(cube, { position: [0, 0.5, 0], immediate: true });
    scene.setCollider3D(cube, { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] });
    scene.setRigidBody(cube, { dynamic: true, friction: 0.85, lockRotation: false });

    scene.applyImpulse(cube, [5, 0, 0], [0, 0.8, 0.2]);
    const [, ] = scene.getVelocity(cube);
    expect(scene.getVelocity(cube)[0]).toBeGreaterThan(4.5);

    for (let i = 0; i < 180; i++) {
      engine.step(1 / 60);
    }
    expect(Math.abs(scene.getVelocity(cube)[0])).toBeLessThan(0.1);
    expect(scene.isSleeping(cube)).toBe(true);
    engine.dispose();
  });

  it('fires onTriggerEnter and onTriggerExit callbacks from WASM and respects collision masks', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;
    scene.setGravity(0, 0, 0);

    const sensor = scene.createEntity();
    scene.setTransform(sensor, { position: [3, 0, 0], immediate: true });
    scene.setCollider3D(sensor, { kind: 'aabb', halfExtents: [1, 1, 1] });
    scene.setTrigger(sensor, true);
    scene.setCollisionFilter(sensor, 0b01, 0b01);

    const mover = scene.createEntity();
    scene.setTransform(mover, { position: [0, 0, 0], immediate: true });
    scene.setCollider3D(mover, { kind: 'sphere', radius: 0.5 });
    scene.setRigidBody(mover, { dynamic: true, gravityScale: 0, linearDamping: 0 });
    scene.setCollisionFilter(mover, 0b01, 0b01);
    scene.setVelocity(mover, 6, 0, 0);

    const entered: number[] = [];
    const exited: number[] = [];
    scene.onTriggerEnter((ev) => entered.push(ev.entityA, ev.entityB));
    scene.onTriggerExit((ev) => exited.push(ev.entityA, ev.entityB));

    for (let i = 0; i < 90; i++) {
      engine.step(1 / 60);
    }

    expect(entered.length).toBeGreaterThan(0);
    expect(exited.length).toBeGreaterThan(0);
    expect(scene.getPosition(mover)[0]).toBeGreaterThan(7.5);
    engine.dispose();
  });

  it('extracts GLB images, _col/_trig conventions, skeletal skinning, and animates bone palettes in WASM', async () => {
    const engine = await Engine.init({ wasmBytes });
    const scene = engine.scene;

    // Build GLB with embedded 1x1 PNG, skinned visual tri + Walk anim, Wall_col, Door_trig
    const chunks: number[] = [];
    const pushFloats = (arr: number[]) => {
      const off = chunks.length;
      const buf = new ArrayBuffer(arr.length * 4);
      const dv = new DataView(buf);
      arr.forEach((v, i) => dv.setFloat32(i * 4, v, true));
      chunks.push(...new Uint8Array(buf));
      return off;
    };
    const pushU16 = (arr: number[]) => {
      const off = chunks.length;
      const buf = new ArrayBuffer(arr.length * 2);
      const dv = new DataView(buf);
      arr.forEach((v, i) => dv.setUint16(i * 2, v, true));
      chunks.push(...new Uint8Array(buf));
      while (chunks.length % 4 !== 0) chunks.push(0);
      return off;
    };
    const pushU8 = (arr: number[]) => {
      const off = chunks.length;
      chunks.push(...arr);
      while (chunks.length % 4 !== 0) chunks.push(0);
      return off;
    };

    const visPosOff = pushFloats([0, 0, 0, 1, 0, 0, 0, 1, 0]); // 0: 36 bytes
    const visUvOff = pushFloats([0, 0, 1, 0, 0, 1]); // 1: 24 bytes
    const jointsOff = pushU8([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // 2: 12 bytes
    const weightsOff = pushFloats([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]); // 3: 48 bytes
    const idxOff = pushU16([0, 1, 2]); // 4: 6 bytes
    const ibmOff = pushFloats([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); // 5: 64 bytes
    const timeOff = pushFloats([0, 1]); // 6: 8 bytes
    const transOff = pushFloats([0, 0, 0, 0, 2, 0]); // 7: 24 bytes
    const colPosOff = pushFloats([-1, 0, 4, 1, 0, 4, 0, 2, 4]); // 8: 36 bytes
    const trigPosOff = pushFloats([-1, -1, 6, 1, 1, 8]); // 9: 24 bytes
    const trigIdxOff = pushU16([0, 1, 0]); // 10: 6 bytes
    // Minimal valid PNG header signature bytes
    const pngBytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const imgOff = pushU8(pngBytes); // 11: 8 bytes

    const jsonStr = JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0, 2, 3] }],
      nodes: [
        { name: 'Hero', mesh: 0, skin: 0 },
        { name: 'RootBone', translation: [0, 0, 0] },
        { name: 'Wall_col', mesh: 1 },
        { name: 'Door_trig', mesh: 2 },
      ],
      skins: [{ inverseBindMatrices: 5, joints: [1] }],
      animations: [
        {
          name: 'Walk',
          samplers: [{ input: 6, interpolation: 'LINEAR', output: 7 }],
          channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
        },
      ],
      images: [{ bufferView: 11, mimeType: 'image/png' }],
      textures: [{ source: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.2, roughnessFactor: 0.6 } }],
      buffers: [{ byteLength: chunks.length }],
      bufferViews: [
        { buffer: 0, byteOffset: visPosOff, byteLength: 36 },
        { buffer: 0, byteOffset: visUvOff, byteLength: 24 },
        { buffer: 0, byteOffset: jointsOff, byteLength: 12 },
        { buffer: 0, byteOffset: weightsOff, byteLength: 48 },
        { buffer: 0, byteOffset: idxOff, byteLength: 6 },
        { buffer: 0, byteOffset: ibmOff, byteLength: 64 },
        { buffer: 0, byteOffset: timeOff, byteLength: 8 },
        { buffer: 0, byteOffset: transOff, byteLength: 24 },
        { buffer: 0, byteOffset: colPosOff, byteLength: 36 },
        { buffer: 0, byteOffset: trigPosOff, byteLength: 24 },
        { buffer: 0, byteOffset: trigIdxOff, byteLength: 6 },
        { buffer: 0, byteOffset: imgOff, byteLength: pngBytes.length },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
        { bufferView: 2, componentType: 5121, count: 3, type: 'VEC4' },
        { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' },
        { bufferView: 4, componentType: 5123, count: 3, type: 'SCALAR' },
        { bufferView: 5, componentType: 5126, count: 1, type: 'MAT4' },
        { bufferView: 6, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
        { bufferView: 7, componentType: 5126, count: 2, type: 'VEC3' },
        { bufferView: 8, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 4], max: [1, 2, 4] },
        { bufferView: 9, componentType: 5126, count: 2, type: 'VEC3', min: [-1, -1, 6], max: [1, 1, 8] },
        { bufferView: 10, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1, JOINTS_0: 2, WEIGHTS_0: 3 }, indices: 4, material: 0 }] },
        { primitives: [{ attributes: { POSITION: 8 }, indices: 4 }] },
        { primitives: [{ attributes: { POSITION: 9 }, indices: 10 }] },
      ],
    });
    const rawJson = new TextEncoder().encode(jsonStr);
    const paddedJsonLen = Math.ceil(rawJson.length / 4) * 4;
    const jsonBytes = new Uint8Array(paddedJsonLen).fill(0x20);
    jsonBytes.set(rawJson);
    const totalLen = 12 + 8 + paddedJsonLen + 8 + chunks.length;
    const glb = new Uint8Array(totalLen);
    const dv = new DataView(glb.buffer);
    glb.set([0x67, 0x6c, 0x54, 0x46], 0);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, totalLen, true);
    dv.setUint32(12, paddedJsonLen, true);
    dv.setUint32(16, 0x4e4f534a, true);
    glb.set(jsonBytes, 20);
    dv.setUint32(20 + paddedJsonLen, chunks.length, true);
    dv.setUint32(24 + paddedJsonLen, 0x004e4942, true);
    glb.set(chunks, 28 + paddedJsonLen);

    const parsed = engine.bridge.parseGlb(glb);
    expect(parsed.images.length).toBe(1);
    expect(parsed.images[0].mimeType).toBe('image/png');
    expect(parsed.colliderTriangles.length).toBe(9);
    expect(parsed.triggerBoxes.length).toBe(1);
    expect(parsed.joints.length).toBeGreaterThanOrEqual(12);
    expect(parsed.weights.length).toBeGreaterThanOrEqual(12);
    expect(parsed.skeletonId).not.toBeNull();
    expect(parsed.clips.map((c) => c.name)).toEqual(['Walk']);
    expect(parsed.submeshes[0].baseColorTexIndex).toBe(0);

    const hero = scene.createEntity();
    scene.setTransform(hero, { position: [0, 0, 0], immediate: true });
    scene.setMesh3D(hero, { meshId: 1, materialId: 1 });
    scene.playAnimation(hero, parsed.skeletonId!, parsed.clips[0].clipId, { speed: 1, loop: true });

    // Advance 0.5s in 0.1s steps -> Walk translation should interpolate to ~ (0, 1, 0)
    for (let i = 0; i < 5; i++) {
      engine.step(0.1);
    }
    const palettes = engine.bridge.getBonePalettesView();
    const offsets = engine.bridge.getPaletteOffsetsView();
    const slot = hero & 0xfffff;
    expect(offsets[slot]).toBe(0);
    // Column-major mat4 translation Y is index 13
    expect(palettes[13]).toBeCloseTo(1.0, 2);
    engine.dispose();
  });
});
