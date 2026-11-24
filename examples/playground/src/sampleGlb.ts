/** Builds an in-memory binary GLB faceted quartz/gemstone crystal with verified outward CCW winding. */
export function buildSampleCrystalGlb(): Uint8Array {
  const sides = 8;
  const top: [number, number, number] = [0, 1.38, 0];
  const bot: [number, number, number] = [0, -1.38, 0];
  const crown: Array<[number, number, number]> = [];
  const girdle: Array<[number, number, number]> = [];
  const lower: Array<[number, number, number]> = [];

  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const b = ((i + 0.5) / sides) * Math.PI * 2;
    crown.push([Math.cos(a) * 0.56, 0.72, Math.sin(a) * 0.56]);
    girdle.push([Math.cos(b) * 0.88, 0.08, Math.sin(b) * 0.88]);
    lower.push([Math.cos(a) * 0.54, -0.62, Math.sin(a) * 0.54]);
  }

  const pos: number[] = [];
  const pushOutwardTri = (
    p1: [number, number, number],
    p2: [number, number, number],
    p3: [number, number, number]
  ) => {
    const ux = p2[0] - p1[0];
    const uy = p2[1] - p1[1];
    const uz = p2[2] - p1[2];
    const vx = p3[0] - p1[0];
    const vy = p3[1] - p1[1];
    const vz = p3[2] - p1[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const cx = (p1[0] + p2[0] + p3[0]) / 3;
    const cy = (p1[1] + p2[1] + p3[1]) / 3;
    const cz = (p1[2] + p2[2] + p3[2]) / 3;
    if (nx * cx + ny * cy + nz * cz >= 0) {
      pos.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
    } else {
      pos.push(p1[0], p1[1], p1[2], p3[0], p3[1], p3[2], p2[0], p2[1], p2[2]);
    }
  };

  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    // Upper crown pyramid
    pushOutwardTri(top, crown[i], crown[next]);
    // Crown-to-girdle facets (quad split cleanly along crown[next] - girdle[i])
    pushOutwardTri(crown[i], girdle[i], crown[next]);
    pushOutwardTri(crown[next], girdle[i], girdle[next]);
    // Girdle-to-lower pavilion facets
    pushOutwardTri(girdle[i], lower[i], lower[next]);
    pushOutwardTri(girdle[i], lower[next], girdle[next]);
    // Lower point
    pushOutwardTri(bot, lower[next], lower[i]);
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
        min: [-0.9, -1.4, -0.9],
        max: [0.9, 1.4, 0.9],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.42, 0.88, 1.0, 1.0],
          metallicFactor: 0.45,
          roughnessFactor: 0.14,
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
