import type { Scene } from '../Scene';
import type { WasmBridge } from '../wasm/WasmBridge';

export type ShaderBlockId =
  | 'pbrLighting'
  | 'celLighting'
  | 'rimLight'
  | 'fresnelGlow'
  | 'vertexWave'
  | 'dissolveNoise'
  | 'hologramScanline'
  | 'pixelDither'
  | 'triplanarGrid'
  | 'distanceFog'
  | 'iridescent'
  | 'matcapNeon'
  | 'glassRefract'
  | 'voronoiCaustics'
  | 'pixelWorld'
  | 'pulseEmissive'
  | 'envIBL'
  | 'microDetail'
  | 'clearcoat'
  | 'subsurfaceWrap'
  | 'terrainSplat';

export interface MeshSubmesh {
  indexOffset: number;
  indexCount: number;
  materialId?: number;
}

export interface MeshGeometry {
  /** Interleaved floats: [px, py, pz, nx, ny, nz, u, v] (8 floats per vertex) */
  vertices: Float32Array;
  indices: Uint32Array;
  /** Optional packed 4 joint indices per vertex (Uint16Array, length = 4 * vertexCount) */
  joints?: Uint16Array;
  /** Optional packed 4 bone weights per vertex (Float32Array, length = 4 * vertexCount) */
  weights?: Float32Array;
  /** Optional multi-material submesh draw ranges */
  submeshes?: MeshSubmesh[];
}

export interface MaterialUniforms {
  baseColor: [number, number, number, number];
  shadowTint: [number, number, number];
  rimColor: [number, number, number];
  glowColor: [number, number, number];
  edgeColor: [number, number, number];
  metallic: number;
  roughness: number;
  celSteps: number;
  rimPower: number;
  fresnelPower: number;
  waveAmp: number;
  waveFreq: number;
  dissolve: number;
  ditherStrength: number;
  gridScale: number;
  uvScale?: [number, number];
  clearcoat?: number;
  clearcoatRoughness?: number;
  subsurface?: number;
  bumpScale?: number;
}

export interface MaterialDesc {
  blocks: ShaderBlockId[];
  uniforms: MaterialUniforms;
  transparent?: boolean;
  doubleSided?: boolean;
  outlineWidth?: number;
  outlineColor?: [number, number, number];
  textureId?: number;
  normalMapId?: number;
  metallicRoughnessMapId?: number;
  emissiveMapId?: number;
  emissiveColor?: [number, number, number];
  customVertexSnippet?: string;
  customFragmentSnippet?: string;
}

export interface RenderFrameMetrics {
  instancedRuns: number;
  instancedObjects: number;
  skippedMaterialBinds: number;
  shaderCount: number;
  uboBound: boolean;
}

export interface IRenderBackend {
  createMesh(geom: MeshGeometry): number;
  disposeMesh(meshId: number): void;
  createMaterial(desc: MaterialDesc): number;
  updateMaterial(materialId: number, patch: Partial<MaterialDesc>): void;
  disposeMaterial(materialId: number): void;
  createTexture(width: number, height: number, pixels: Uint8Array, pixelated?: boolean): number;
  disposeTexture(textureId: number): void;
  renderFrame(bridge: WasmBridge, scene: Scene, aspect: number, timeSec: number): number;
  warmupMaterials?(descs: MaterialDesc[]): number;
  getRenderMetrics?(): RenderFrameMetrics;
  dispose(): void;
}
