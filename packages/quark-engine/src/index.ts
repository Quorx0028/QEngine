export { AssetManager, type LoadedMeshHandle } from './assets/AssetManager';
export { AudioSystem, type AudioBus, type SpatialPlayOptions } from './Audio';
export {
  Engine,
  type EngineErrorInfo,
  type EngineFrameTimings,
  type EngineOptions,
  type EngineStats,
} from './Engine';
export { Input, type ActionBinding, type AxisBinding } from './Input';
export {
  OrbitControls,
  type OrbitCameraTarget,
  type OrbitControlsOptions,
} from './OrbitControls';
export { AnimStateMachine, type AnimTransition } from './gameplay/AnimStateMachine';
export {
  BehaviorManager,
  BehaviorRegistry,
  defineBehavior,
  type BehaviorContext,
  type EntityBehavior,
} from './gameplay/Behavior';
export { GameUI } from './ui/GameUI';
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
  RenderFrameMetrics,
  ShaderBlockId,
} from './render/IRenderBackend';
export {
  createBoxGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createPlaneGeometry,
  createRampGeometry,
  createSphereGeometry,
  createTerrainGeometry,
  createWaterVolumeGeometry,
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
  DialogueRunner,
  type DialogueChoice,
  type DialogueFlagValue,
  type DialogueNode,
} from './rpg/DialogueRunner';
export {
  SpriteAnimator,
  type SpriteAnimClip,
  type SpriteAnimatorOptions,
} from './rpg/SpriteAnimator';
export {
  Tilemap,
  type TiledJsonMap,
  type TiledLayer,
  type TiledObject,
  type TilemapLoadOptions,
  type WorldTiledObject,
} from './rpg/Tilemap';
export { ParticleEmitter, type ParticleEmitterOptions } from './render/ParticleEmitter';
export {
  PHYSICS_MATERIAL_PRESETS,
  Scene,
  type CameraState,
  type Collider2DOptions,
  type Collider3DOptions,
  type CollisionEvent,
  type CombineRule,
  type CompoundPartDesc,
  type DirectionalLight,
  type EntityId,
  type Light2D,
  type Mesh3DOptions,
  type ParticleSpawnOptions,
  type PointLight,
  type RichPhysicsEvent,
  type SpotLight,
  type RigidBodyOptions,
  type Sprite2DOptions,
  type TransformOptions,
  type TriggerEvent,
  type VfxPresetName,
} from './Scene';
export { WasmBridge, type ParsedGlbResult } from './wasm/WasmBridge';
