export { AssetManager, type LoadedMeshHandle } from './assets/AssetManager';
export { AudioSystem } from './Audio';
export { Engine, type EngineOptions, type EngineStats } from './Engine';
export { Input } from './Input';
export {
  mat4Identity,
  mat4LookAt,
  mat4Multiply,
  mat4Ortho,
  mat4Perspective,
  quatFromEuler,
  type QuatTuple,
  type Vec3Tuple,
} from './math/Mat4';
export type {
  IRenderBackend,
  MaterialDesc,
  MaterialUniforms,
  MeshGeometry,
  MeshSubmesh,
  ShaderBlockId,
} from './render/IRenderBackend';
export {
  createBoxGeometry,
  createPlaneGeometry,
  createRampGeometry,
  createSphereGeometry,
  extractColliderTriangles,
} from './render/Primitives';
export {
  composePostProcessShader,
  createPostProcessPreset,
  isPostProcessActive,
  POST_PROCESS_PRESET_NAMES,
  type PostProcessConfig,
  type PostProcessPresetName,
} from './render/PostProcess';
export { composeShader, SHADER_BLOCK_IDS, type ComposeShaderConfig } from './render/ShaderBlocks';
export { ShaderGraph } from './render/ShaderGraph';
export {
  createPresetMaterial,
  defaultMaterialUniforms,
  SHADER_PRESET_NAMES,
  type MaterialPresetOverrides,
  type ShaderPresetName,
} from './render/ShaderPresets';
export { computeSmoothNormals, WebGL2Backend } from './render/WebGL2Backend';
export {
  Scene,
  type CameraState,
  type Collider2DOptions,
  type Collider3DOptions,
  type CollisionEvent,
  type DirectionalLight,
  type EntityId,
  type Mesh3DOptions,
  type PointLight,
  type SpotLight,
  type RigidBodyOptions,
  type Sprite2DOptions,
  type TransformOptions,
  type TriggerEvent,
} from './Scene';
export { WasmBridge, type ParsedGlbResult } from './wasm/WasmBridge';
