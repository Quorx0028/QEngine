import { describe, expect, it } from 'vitest';
import {
  addKeyframe,
  base64ToUint8,
  createDefaultSceneDocument,
  evaluateObjectTrack,
  parseSceneDocument,
  removeKeyframeAt,
  serializeSceneDocument,
  uint8ToBase64,
} from '../src/SceneDocument';

describe('Editor SceneDocument & Animation Timeline', () => {
  it('creates a valid starter scene with ground, player, animated prop, and lighting', () => {
    const doc = createDefaultSceneDocument();
    expect(doc.version).toBe(1);
    expect(doc.objects.length).toBeGreaterThanOrEqual(4);
    expect(doc.objects.some((o) => o.physics.isCharacterController)).toBe(true);
    expect(doc.objects.some((o) => o.keyframes.length >= 2)).toBe(true);
    expect(doc.objects.some((o) => o.lightKind !== 'none')).toBe(true);
  });

  it('evaluates transform keyframes smoothly with clamping and looping', () => {
    const doc = createDefaultSceneDocument();
    const obj = doc.objects[0];
    obj.keyframes = [];
    addKeyframe(obj, 0, [0, 1, 0], [0, 0, 0], [1, 1, 1]);
    addKeyframe(obj, 2, [4, 5, -2], [0, 180, 0], [3, 1, 1]);

    const mid = evaluateObjectTrack(obj, 1, 2, true);
    expect(mid.position[0]).toBeCloseTo(2, 4);
    expect(mid.position[1]).toBeCloseTo(3, 4);
    expect(mid.position[2]).toBeCloseTo(-1, 4);
    expect(mid.rotationDeg[1]).toBeCloseTo(90, 4);
    expect(mid.scale[0]).toBeCloseTo(2, 4);

    // Wrapped time t=3 on duration 2 -> t=1
    const wrapped = evaluateObjectTrack(obj, 3, 2, true);
    expect(wrapped.position[0]).toBeCloseTo(2, 4);

    // Clamped when loop = false
    const clamped = evaluateObjectTrack(obj, 5, 2, false);
    expect(clamped.position[0]).toBeCloseTo(4, 4);

    expect(removeKeyframeAt(obj, 0)).toBe(true);
    expect(obj.keyframes.length).toBe(1);
  });

  it('roundtrips SceneDocument JSON and base64 GLB payloads losslessly', () => {
    const raw = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 255, 128, 17]);
    const b64 = uint8ToBase64(raw);
    expect(Array.from(base64ToUint8(b64))).toEqual(Array.from(raw));

    const doc = createDefaultSceneDocument();
    doc.name = 'My Test Level';
    doc.objects[1].glbBase64 = b64;
    doc.objects[1].glbName = 'hero.glb';

    const json = serializeSceneDocument(doc);
    const parsed = parseSceneDocument(json);
    expect(parsed.name).toBe('My Test Level');
    expect(parsed.objects[1].glbName).toBe('hero.glb');
    expect(Array.from(base64ToUint8(parsed.objects[1].glbBase64!))).toEqual(Array.from(raw));
  });
});
