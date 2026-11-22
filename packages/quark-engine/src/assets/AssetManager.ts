import type { IRenderBackend, MaterialDesc, MeshGeometry, MeshSubmesh } from '../render/IRenderBackend';
import {
  createPresetMaterial,
  type MaterialPresetOverrides,
  type ShaderPresetName,
} from '../render/ShaderPresets';
import type { Scene } from '../Scene';
import type { WasmBridge } from '../wasm/WasmBridge';

export interface LoadedMeshHandle {
  meshId: number;
  materialIds: number[];
  skeletonId: number | null;
  clips: Record<string, number>;
  colliderEntity?: number;
  triggerEntities?: number[];
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
      skeletonId: null,
      clips: {},
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

  private async decodeImageToTexture(
    name: string,
    bytes: Uint8Array,
    mimeType: string,
    tag: string
  ): Promise<number | undefined> {
    if (!this.backend || bytes.byteLength === 0 || typeof createImageBitmap !== 'function') {
      return undefined;
    }
    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const blob = new Blob([copy.buffer], { type: mimeType || 'image/png' });
      const bmp = await createImageBitmap(blob);
      const w = bmp.width;
      const h = bmp.height;
      let pixels: Uint8Array | null = null;
      if (typeof OffscreenCanvas !== 'undefined') {
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.drawImage(bmp, 0, 0);
          pixels = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
        }
      } else if (typeof document !== 'undefined') {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.drawImage(bmp, 0, 0);
          pixels = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
        }
      }
      bmp.close();
      if (!pixels) return undefined;
      return this.createTexture(name, w, h, pixels, false, tag);
    } catch {
      return undefined;
    }
  }

  async loadGLB(
    source: string | URL | Uint8Array,
    options: {
      name?: string;
      tag?: string;
      preset?: ShaderPresetName;
      scene?: Scene;
      autoColliders?: boolean;
    } = {}
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
    const baseName = options.name ?? 'glb';

    // Decode embedded textures
    const texIds: Array<number | undefined> = [];
    for (let i = 0; i < parsed.images.length; i++) {
      const img = parsed.images[i];
      texIds.push(await this.decodeImageToTexture(`${baseName}_tex_${i}`, img.bytes, img.mimeType, tag));
    }

    const preset = options.preset ?? 'pbr';
    const materialIds: number[] = [];
    const meshSubmeshes: MeshSubmesh[] = [];
    parsed.submeshes
      .filter((sm) => sm.role === 0)
      .forEach((sm, idx) => {
        const matName = `${baseName}_mat_${idx}`;
        const texId = sm.baseColorTexIndex >= 0 ? texIds[sm.baseColorTexIndex] : undefined;
        const matId = this.createPreset(
          matName,
          preset,
          {
            textureId: texId,
            uniforms: {
              baseColor: sm.baseColor,
              metallic: sm.metallic,
              roughness: sm.roughness,
            },
          },
          tag
        );
        materialIds.push(matId);
        meshSubmeshes.push({
          indexOffset: sm.indexOffset,
          indexCount: sm.indexCount,
          materialId: matId,
        });
      });

    if (materialIds.length === 0) {
      materialIds.push(this.createPreset(`${baseName}_mat_default`, preset, {}, tag));
    }

    const meshId = this.backend.createMesh({
      vertices: parsed.vertices,
      indices: parsed.indices,
      joints: parsed.joints.length > 0 ? parsed.joints : undefined,
      weights: parsed.weights.length > 0 ? parsed.weights : undefined,
      submeshes: meshSubmeshes.length > 0 ? meshSubmeshes : undefined,
    });
    this.bucket(tag).meshes.push(meshId);

    let colliderEntity: number | undefined;
    let triggerEntities: number[] | undefined;
    if (options.scene && options.autoColliders !== false) {
      if (parsed.colliderTriangles.length >= 9) {
        colliderEntity = options.scene.createEntity();
        options.scene.setTransform(colliderEntity, { position: [0, 0, 0], immediate: true });
        options.scene.addStaticMeshTriangles(colliderEntity, parsed.colliderTriangles);
      }
      if (parsed.triggerBoxes.length > 0) {
        triggerEntities = parsed.triggerBoxes.map((tb) => {
          const te = options.scene!.createEntity();
          options.scene!.setTransform(te, { position: tb.center, immediate: true });
          options.scene!.setCollider3D(te, { kind: 'aabb', halfExtents: tb.halfExtents });
          options.scene!.setTrigger(te, true);
          return te;
        });
      }
    }

    const clips: Record<string, number> = {};
    for (const c of parsed.clips) {
      clips[c.name] = c.clipId;
    }

    const dx = (parsed.boundsMax[0] - parsed.boundsMin[0]) * 0.5;
    const dy = (parsed.boundsMax[1] - parsed.boundsMin[1]) * 0.5;
    const dz = (parsed.boundsMax[2] - parsed.boundsMin[2]) * 0.5;

    const handle: LoadedMeshHandle = {
      meshId,
      materialIds,
      skeletonId: parsed.skeletonId,
      clips,
      colliderEntity,
      triggerEntities,
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

  getMaterialsByTag(tag: string): number[] {
    return [...(this.tags.get(tag)?.materials ?? [])];
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
