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
    engine.dispose();
  });
});
