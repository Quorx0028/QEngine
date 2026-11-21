/** Builds an in-memory binary GLB octahedron crystal to exercise the Rust glTF/GLB parser out of the box. */
export function buildSampleCrystalGlb(): Uint8Array {
  const top: [number, number, number] = [0, 1.6, 0];
  const bot: [number, number, number] = [0, -1.6, 0];
  const ring: Array<[number, number, number]> = [
    [1.0, 0, 0],
    [0, 0, 1.0],
    [-1.0, 0, 0],
    [0, 0, -1.0],
  ];

  const pos: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    pos.push(...top, ...b, ...a);
    pos.push(...bot, ...a, ...b);
  }

  const bin = new Uint8Array(pos.length * 4);
  const dv = new DataView(bin.buffer);
  pos.forEach((v, idx) => dv.setFloat32(idx * 4, v, true));

  const jsonStr = JSON.stringify({
    asset: { version: '2.0', generator: 'QuarkEngine Sample' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: pos.length / 3,
        type: 'VEC3',
        min: [-1, -1.6, -1],
        max: [1, 1.6, 1],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.38, 0.84, 1.0, 1.0],
          metallicFactor: 0.35,
          roughnessFactor: 0.2,
        },
      },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
  });

  const rawJson = new TextEncoder().encode(jsonStr);
  const paddedJsonLen = Math.ceil(rawJson.length / 4) * 4;
  const jsonBytes = new Uint8Array(paddedJsonLen);
  jsonBytes.fill(0x20);
  jsonBytes.set(rawJson);

  const totalLen = 12 + 8 + paddedJsonLen + 8 + bin.byteLength;
  const glb = new Uint8Array(totalLen);
  const outDv = new DataView(glb.buffer);
  glb.set([0x67, 0x6c, 0x54, 0x46], 0);
  outDv.setUint32(4, 2, true);
  outDv.setUint32(8, totalLen, true);
  outDv.setUint32(12, paddedJsonLen, true);
  outDv.setUint32(16, 0x4e4f534a, true);
  glb.set(jsonBytes, 20);
  const binOff = 20 + paddedJsonLen;
  outDv.setUint32(binOff, bin.byteLength, true);
  outDv.setUint32(binOff + 4, 0x004e4942, true);
  glb.set(bin, binOff + 8);
  return glb;
}
