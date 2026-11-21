import type { IRenderBackend, MaterialDesc, MeshGeometry } from '../render/IRenderBackend';
import {
  createPresetMaterial,
  type MaterialPresetOverrides,
  type ShaderPresetName,
} from '../render/ShaderPresets';
import type { WasmBridge } from '../wasm/WasmBridge';

export interface LoadedMeshHandle {
  meshId: number;
  materialIds: number[];
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  boundsRadius: number;
  vertices: Float32Array;
  indices: Uint32Array;
}

interface TagBucket {
  meshes: number[];
  materials: number[];
  textures: number[];
}

export class AssetManager {
  private readonly bridge: WasmBridge;
  private readonly backend: IRenderBackend | null;
  private readonly tags = new Map<string, TagBucket>();
  private readonly namedMeshes = new Map<string, LoadedMeshHandle>();
  private readonly namedMaterials = new Map<string, number>();
  private readonly namedTextures = new Map<string, number>();

  constructor(bridge: WasmBridge, backend: IRenderBackend | null = null) {
    this.bridge = bridge;
    this.backend = backend;
  }

  private bucket(tag: string): TagBucket {
    let b = this.tags.get(tag);
    if (!b) {
      b = { meshes: [], materials: [], textures: [] };
      this.tags.set(tag, b);
    }
    return b;
  }

  registerMesh(name: string, geom: MeshGeometry, tag = 'default'): LoadedMeshHandle {
    if (!this.backend) {
      throw new Error('Cannot register GPU mesh without an active render backend');
    }
    const meshId = this.backend.createMesh(geom);
    this.bucket(tag).meshes.push(meshId);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < geom.vertices.length; i += 8) {
      const x = geom.vertices[i], y = geom.vertices[i + 1], z = geom.vertices[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const dx = (maxX - minX) * 0.5;
    const dy = (maxY - minY) * 0.5;
    const dz = (maxZ - minZ) * 0.5;
    const handle: LoadedMeshHandle = {
      meshId,
      materialIds: [],
      boundsMin: [minX, minY, minZ],
      boundsMax: [maxX, maxY, maxZ],
      boundsRadius: Math.hypot(dx, dy, dz) || 1,
      vertices: geom.vertices,
      indices: geom.indices,
    };
    this.namedMeshes.set(name, handle);
    return handle;
  }

  createPreset(
    name: string,
    preset: ShaderPresetName,
    overrides: MaterialPresetOverrides = {},
    tag = 'default'
  ): number {
    return this.createMaterial(name, createPresetMaterial(preset, overrides), tag);
  }

  createMaterial(name: string, desc: MaterialDesc, tag = 'default'): number {
    if (!this.backend) {
      throw new Error('Cannot create GPU material without an active render backend');
    }
    const id = this.backend.createMaterial(desc);
    this.bucket(tag).materials.push(id);
    this.namedMaterials.set(name, id);
    return id;
  }

  updateMaterial(materialId: number, patch: Partial<MaterialDesc>): void {
    this.backend?.updateMaterial(materialId, patch);
  }

  createTexture(
    name: string,
    width: number,
    height: number,
    pixels: Uint8Array,
    pixelated = false,
    tag = 'default'
  ): number {
    if (!this.backend) {
      throw new Error('Cannot create GPU texture without an active render backend');
    }
    const id = this.backend.createTexture(width, height, pixels, pixelated);
    this.bucket(tag).textures.push(id);
    this.namedTextures.set(name, id);
    return id;
  }

  async loadGLB(
    source: string | URL | Uint8Array,
    options: { name?: string; tag?: string; preset?: ShaderPresetName } = {}
  ): Promise<LoadedMeshHandle> {
    if (!this.backend) {
      throw new Error('Cannot load GLB mesh without an active render backend');
    }
    const bytes =
      source instanceof Uint8Array
        ? source
        : new Uint8Array(await (await fetch(source)).arrayBuffer());

    const parsed = this.bridge.parseGlb(bytes);
    const tag = options.tag ?? 'default';
    const meshId = this.backend.createMesh({
      vertices: parsed.vertices,
      indices: parsed.indices,
    });
    this.bucket(tag).meshes.push(meshId);

    const preset = options.preset ?? 'pbr';
    const materialIds: number[] = [];
    parsed.submeshes.forEach((sm, idx) => {
      const matName = `${options.name ?? 'glb'}_mat_${idx}`;
      const matId = this.createPreset(
        matName,
        preset,
        {
          uniforms: {
            baseColor: sm.baseColor,
            metallic: sm.metallic,
            roughness: sm.roughness,
          },
        },
        tag
      );
      materialIds.push(matId);
    });

    const dx = (parsed.boundsMax[0] - parsed.boundsMin[0]) * 0.5;
    const dy = (parsed.boundsMax[1] - parsed.boundsMin[1]) * 0.5;
    const dz = (parsed.boundsMax[2] - parsed.boundsMin[2]) * 0.5;

    const handle: LoadedMeshHandle = {
      meshId,
      materialIds,
      boundsMin: parsed.boundsMin,
      boundsMax: parsed.boundsMax,
      boundsRadius: Math.hypot(dx, dy, dz) || 1,
      vertices: parsed.vertices,
      indices: parsed.indices,
    };
    if (options.name) {
      this.namedMeshes.set(options.name, handle);
    }
    return handle;
  }

  getMesh(name: string): LoadedMeshHandle | undefined {
    return this.namedMeshes.get(name);
  }

  getMaterial(name: string): number | undefined {
    return this.namedMaterials.get(name);
  }

  getTexture(name: string): number | undefined {
    return this.namedTextures.get(name);
  }

  unloadTag(tag: string): void {
    const b = this.tags.get(tag);
    if (!b || !this.backend) return;
    for (const m of b.meshes) {
      this.backend.disposeMesh(m);
      for (const [k, v] of this.namedMeshes.entries()) {
        if (v.meshId === m) this.namedMeshes.delete(k);
      }
    }
    for (const mat of b.materials) {
      this.backend.disposeMaterial(mat);
      for (const [k, v] of this.namedMaterials.entries()) {
        if (v === mat) this.namedMaterials.delete(k);
      }
    }
    for (const tex of b.textures) {
      this.backend.disposeTexture(tex);
      for (const [k, v] of this.namedTextures.entries()) {
        if (v === tex) this.namedTextures.delete(k);
      }
    }
    this.tags.delete(tag);
  }

  dispose(): void {
    for (const tag of Array.from(this.tags.keys())) {
      this.unloadTag(tag);
    }
  }
}
