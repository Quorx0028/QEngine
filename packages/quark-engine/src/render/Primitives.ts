import type { MeshGeometry } from './IRenderBackend';

export function createBoxGeometry(hx = 0.5, hy = 0.5, hz = 0.5): MeshGeometry {
  const faces: Array<{ n: [number, number, number]; corners: Array<[number, number, number]> }> = [
    { n: [0, 0, 1], corners: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], corners: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
    { n: [1, 0, 0], corners: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { n: [-1, 0, 0], corners: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
    { n: [0, 1, 0], corners: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { n: [0, -1, 0], corners: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
  ];

  const vertices = new Float32Array(24 * 8);
  const indices = new Uint32Array(36);
  const uvs: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  faces.forEach((f, fi) => {
    const vBase = fi * 4;
    for (let i = 0; i < 4; i++) {
      const off = (vBase + i) * 8;
      vertices[off] = f.corners[i][0];
      vertices[off + 1] = f.corners[i][1];
      vertices[off + 2] = f.corners[i][2];
      vertices[off + 3] = f.n[0];
      vertices[off + 4] = f.n[1];
      vertices[off + 5] = f.n[2];
      vertices[off + 6] = uvs[i][0];
      vertices[off + 7] = uvs[i][1];
    }
    const iBase = fi * 6;
    indices[iBase] = vBase;
    indices[iBase + 1] = vBase + 1;
    indices[iBase + 2] = vBase + 2;
    indices[iBase + 3] = vBase;
    indices[iBase + 4] = vBase + 2;
    indices[iBase + 5] = vBase + 3;
  });

  return { vertices, indices };
}

export function createPlaneGeometry(width = 10, depth = 10, subdivs = 8): MeshGeometry {
  const cols = Math.max(1, subdivs);
  const rows = Math.max(1, subdivs);
  const vCount = (cols + 1) * (rows + 1);
  const vertices = new Float32Array(vCount * 8);
  const indices = new Uint32Array(cols * rows * 6);

  let vi = 0;
  for (let z = 0; z <= rows; z++) {
    const vz = (z / rows - 0.5) * depth;
    for (let x = 0; x <= cols; x++) {
      const vx = (x / cols - 0.5) * width;
      vertices[vi++] = vx;
      vertices[vi++] = 0;
      vertices[vi++] = vz;
      vertices[vi++] = 0;
      vertices[vi++] = 1;
      vertices[vi++] = 0;
      vertices[vi++] = x / cols;
      vertices[vi++] = z / rows;
    }
  }

  let ii = 0;
  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      const tl = z * (cols + 1) + x;
      const tr = tl + 1;
      const bl = (z + 1) * (cols + 1) + x;
      const br = bl + 1;
      indices[ii++] = tl;
      indices[ii++] = bl;
      indices[ii++] = tr;
      indices[ii++] = tr;
      indices[ii++] = bl;
      indices[ii++] = br;
    }
  }
  return { vertices, indices };
}

export function createSphereGeometry(radius = 0.5, stacks = 16, slices = 24): MeshGeometry {
  const verts: number[] = [];
  const inds: number[] = [];
  for (let y = 0; y <= stacks; y++) {
    const v = y / stacks;
    const phi = v * Math.PI;
    for (let x = 0; x <= slices; x++) {
      const u = x / slices;
      const theta = u * Math.PI * 2;
      const nx = -Math.cos(theta) * Math.sin(phi);
      const ny = Math.cos(phi);
      const nz = Math.sin(theta) * Math.sin(phi);
      verts.push(nx * radius, ny * radius, nz * radius, nx, ny, nz, u, v);
    }
  }
  for (let y = 0; y < stacks; y++) {
    for (let x = 0; x < slices; x++) {
      const a = y * (slices + 1) + x;
      const b = a + slices + 1;
      inds.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(inds) };
}

export function createRampGeometry(width = 3, height = 1.6, length = 5): MeshGeometry {
  const hw = width * 0.5;
  const hl = length * 0.5;
  const p = [
    [-hw, 0, hl],
    [hw, 0, hl],
    [hw, height, -hl],
    [-hw, height, -hl],
    [-hw, 0, -hl],
    [hw, 0, -hl],
  ] as const;
  const tris: Array<[readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]]> = [
    // Slope face
    [p[0], p[1], p[2]],
    [p[0], p[2], p[3]],
    // Back vertical face
    [p[4], p[3], p[2]],
    [p[4], p[2], p[5]],
    // Left side
    [p[0], p[3], p[4]],
    // Right side
    [p[1], p[5], p[2]],
    // Bottom
    [p[0], p[4], p[5]],
    [p[0], p[5], p[1]],
  ];

  const verts = new Float32Array(tris.length * 3 * 8);
  const inds = new Uint32Array(tris.length * 3);
  tris.forEach((tri, ti) => {
    const [a, b, c] = tri;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    [a, b, c].forEach((pt, pi) => {
      const vi = ti * 3 + pi;
      const off = vi * 8;
      verts[off] = pt[0];
      verts[off + 1] = pt[1];
      verts[off + 2] = pt[2];
      verts[off + 3] = nx;
      verts[off + 4] = ny;
      verts[off + 5] = nz;
      verts[off + 6] = pi === 1 ? 1 : 0;
      verts[off + 7] = pi === 2 ? 1 : 0;
      inds[vi] = vi;
    });
  });
  return { vertices: verts, indices: inds };
}

/** Extracts flat world/local triangle vertices [x,y,z,...] for Physics StaticTriMesh colliders. */
export function extractColliderTriangles(
  geom: MeshGeometry,
  offset: [number, number, number] = [0, 0, 0]
): Float32Array {
  const out = new Float32Array(geom.indices.length * 3);
  for (let i = 0; i < geom.indices.length; i++) {
    const vIdx = geom.indices[i] * 8;
    out[i * 3] = geom.vertices[vIdx] + offset[0];
    out[i * 3 + 1] = geom.vertices[vIdx + 1] + offset[1];
    out[i * 3 + 2] = geom.vertices[vIdx + 2] + offset[2];
  }
  return out;
}
