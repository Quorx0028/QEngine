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
  | 'microDetail';

export interface MeshGeometry {
  /** Interleaved floats: [px, py, pz, nx, ny, nz, u, v] (8 floats per vertex) */
  vertices: Float32Array;
  indices: Uint32Array;
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
}

export interface MaterialDesc {
  blocks: ShaderBlockId[];
  uniforms: MaterialUniforms;
  transparent?: boolean;
  doubleSided?: boolean;
  outlineWidth?: number;
  outlineColor?: [number, number, number];
  textureId?: number;
  customVertexSnippet?: string;
  customFragmentSnippet?: string;
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
  dispose(): void;
}
