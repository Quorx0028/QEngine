import type { QualityPreset } from '../Engine';
import type { Vec3Tuple } from '../math/Mat4';
import type { MaterialUniforms, ShaderBlockId } from '../render/IRenderBackend';
import {
  createPostProcessPreset,
  type PostProcessConfig,
} from '../render/PostProcess';
import { createPresetMaterial, type ShaderPresetName } from '../render/ShaderPresets';
import type { CloudStyle, WeatherType } from '../Scene';
import type { RoomSide } from '../builders/WorldBuilder';

export type ProceduralTextureKind = 'none' | 'grid' | 'checker' | 'brick' | 'wood' | 'stone' | 'metal' | 'custom';

export type PhysicsMode = 'static' | 'dynamic' | 'kinematic' | 'none';

export type EditorEntityKind =
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'ramp'
  | 'room'
  | 'stairs'
  | 'pool'
  | 'trigger'
  | 'breakable'
  | 'pointLight'
  | 'spotLight'
  | 'glb';

export interface EditorMaterialDef {
  id: string;
  name: string;
  preset: ShaderPresetName;
  blocks: ShaderBlockId[];
  uniforms: MaterialUniforms;
  textureKind: ProceduralTextureKind;
  customImageDataUrl?: string;
  transparent?: boolean;
  doubleSided?: boolean;
  outlineWidth?: number;
  outlineColor?: [number, number, number];
  customVertexSnippet?: string;
  customFragmentSnippet?: string;
}

export interface EditorPhysicsDef {
  /** `static` pins geometry so rooms/walls never fall or topple; `dynamic` simulates gravity & collisions. */
  mode: PhysicsMode;
  /** When true, prevents accidental TransformGizmo dragging inside the editor viewport. */
  editorLocked?: boolean;
  mass: number;
  friction: number;
  restitution: number;
  gravityScale?: number;
  isTrigger?: boolean;
}

export interface EditorRoomConfig {
  doors?: RoomSide[];
  doorNoLeaf?: boolean;
  windows?: RoomSide[];
  roof?: boolean;
  floor?: boolean;
  lightColor?: string;
  godRay?: boolean;
}

export interface EditorLightConfig {
  color: string;
  intensity: number;
  range: number;
  innerDeg?: number;
  outerDeg?: number;
  enabled?: boolean;
}

export interface EditorEntityDef {
  id: string;
  name: string;
  kind: EditorEntityKind;
  position: Vec3Tuple;
  /** Euler rotation in degrees `[rx, ry, rz]`. */
  rotationDeg: Vec3Tuple;
  scale: Vec3Tuple;
  /** Full extents `[w, h, d]` for boxes, rooms, triggers, pools, ramps. */
  size: Vec3Tuple;
  radius?: number;
  height?: number;
  materialId: string;
  physics: EditorPhysicsDef;
  roomConfig?: EditorRoomConfig;
  lightConfig?: EditorLightConfig;
  glbDataBase64?: string;
  tags?: string[];
}

export interface EditorWeldDef {
  id: string;
  entityA: string;
  entityB: string;
  breakForce?: number;
}

export type BlueprintNodeType =
  | 'onStart'
  | 'onTick'
  | 'onKeyPress'
  | 'onTriggerEnter'
  | 'onTriggerExit'
  | 'onCollision'
  | 'onRaycastClick'
  | 'setVar'
  | 'ifVar'
  | 'gateOnce'
  | 'delay'
  | 'moveObject'
  | 'rotateObject'
  | 'applyImpulse'
  | 'setStaticLocked'
  | 'spawnProp'
  | 'destroyObject'
  | 'toggleLight'
  | 'emitVfx'
  | 'playSound'
  | 'teleportPlayer'
  | 'showBanner'
  | 'setHudCounter'
  | 'setWeather';

export interface BlueprintNode {
  id: string;
  type: BlueprintNodeType;
  x: number;
  y: number;
  params: Record<string, string | number | boolean>;
}

export interface BlueprintEdge {
  id: string;
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
}

export interface BlueprintGraph {
  id: string;
  name: string;
  enabled: boolean;
  targetEntityId?: string;
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
}

export interface EditorEnvironmentDef {
  moodName: 'daylight' | 'sunset' | 'cyber' | 'pastel';
  skyTop: Vec3Tuple;
  skyHorizon: Vec3Tuple;
  fogColor: Vec3Tuple;
  fogDensity: number;
  lightDir: Vec3Tuple;
  lightColor: Vec3Tuple;
  ambientColor: Vec3Tuple;
  shadowsEnabled: boolean;
  weather: WeatherType;
  cloudStyle: CloudStyle;
  quality: QualityPreset;
  postProcess: PostProcessConfig;
}

export interface EditorPlayerConfig {
  enabled: boolean;
  spawnPos: Vec3Tuple;
  moveSpeed: number;
  sprintSpeed: number;
  jumpSpeed: number;
  crosshair: boolean;
}

export interface QuarkProjectDoc {
  version: 1;
  name: string;
  environment: EditorEnvironmentDef;
  player: EditorPlayerConfig;
  materials: EditorMaterialDef[];
  entities: EditorEntityDef[];
  welds: EditorWeldDef[];
  blueprints: BlueprintGraph[];
}

export type StarterTemplateId = 'empty' | 'escapeRoom' | 'parkour';

export function makeMaterialFromPreset(
  id: string,
  name: string,
  preset: ShaderPresetName,
  overrides: Partial<MaterialUniforms> = {},
  textureKind: ProceduralTextureKind = 'none'
): EditorMaterialDef {
  const base = createPresetMaterial(preset, { uniforms: overrides });
  return {
    id,
    name,
    preset,
    blocks: [...base.blocks],
    uniforms: { ...base.uniforms },
    textureKind,
    transparent: base.transparent,
    doubleSided: base.doubleSided,
    outlineWidth: base.outlineWidth,
    outlineColor: base.outlineColor ? [...base.outlineColor] : undefined,
  };
}

export function createStarterProject(template: StarterTemplateId = 'escapeRoom'): QuarkProjectDoc {
  const floorMat = makeMaterialFromPreset('mat_floor', 'Пол (Сетка)', 'ultraRealism', { baseColor: [0.24, 0.3, 0.4, 1], roughness: 0.72, gridScale: 1.0 }, 'grid');
  floorMat.blocks = ['pbrLighting', 'triplanarGrid', 'distanceFog'];
  const baseMats: EditorMaterialDef[] = [
    floorMat,
    makeMaterialFromPreset('mat_wall', 'Стены комнаты (Кирпич)', 'ultraRealism', { baseColor: [0.76, 0.78, 0.84, 1], roughness: 0.85 }, 'brick'),
    makeMaterialFromPreset('mat_wood', 'Дерево (Ящики)', 'ultraRealism', { baseColor: [0.85, 0.68, 0.48, 1], roughness: 0.68 }, 'wood'),
    makeMaterialFromPreset('mat_neon', 'Неон (Энергия)', 'cyberNeon', { baseColor: [0.1, 0.88, 1.0, 1], glowColor: [0.0, 0.95, 1.0], roughness: 0.2 }),
    makeMaterialFromPreset('mat_gold', 'Золото (Ключ/Монета)', 'pbr', { baseColor: [1.0, 0.82, 0.2, 1], glowColor: [0.95, 0.65, 0.05], metallic: 0.9, roughness: 0.2 }),
    makeMaterialFromPreset('mat_trigger', 'Зона триггера', 'hologram', { baseColor: [0.2, 0.95, 0.55, 0.35], glowColor: [0.2, 0.95, 0.55] }),
    makeMaterialFromPreset('mat_door', 'Дверь (Металл)', 'pbr', { baseColor: [0.55, 0.62, 0.72, 1], metallic: 0.75, roughness: 0.35 }, 'metal'),
  ];

  const baseEnv: EditorEnvironmentDef = {
    moodName: 'daylight',
    skyTop: [0.12, 0.34, 0.68],
    skyHorizon: [0.64, 0.78, 0.92],
    fogColor: [0.56, 0.7, 0.86],
    fogDensity: 0.004,
    lightDir: [0.55, 0.85, 0.42],
    lightColor: [1.0, 0.97, 0.92],
    ambientColor: [0.26, 0.31, 0.4],
    shadowsEnabled: true,
    weather: 'clear',
    cloudStyle: 'realistic',
    quality: 'high',
    postProcess: createPostProcessPreset('ultraRealism'),
  };

  if (template === 'empty') {
    return {
      version: 1,
      name: 'Моя первая игра',
      environment: baseEnv,
      player: { enabled: true, spawnPos: [0, 1.4, 6], moveSpeed: 6.5, sprintSpeed: 10.5, jumpSpeed: 8.6, crosshair: true },
      materials: baseMats,
      entities: [
        {
          id: 'floor_main',
          name: 'Основной пол',
          kind: 'box',
          position: [0, -0.5, 0],
          rotationDeg: [0, 0, 0],
          scale: [1, 1, 1],
          size: [48, 1, 48],
          materialId: 'mat_floor',
          physics: { mode: 'static', editorLocked: true, mass: 0, friction: 0.85, restitution: 0.05 },
        },
        {
          id: 'crate_1',
          name: 'Ящик с физикой',
          kind: 'box',
          position: [0, 0.6, -2],
          rotationDeg: [0, 0, 0],
          scale: [1, 1, 1],
          size: [1.2, 1.2, 1.2],
          materialId: 'mat_wood',
          physics: { mode: 'dynamic', mass: 1.5, friction: 0.75, restitution: 0.1 },
        },
      ],
      welds: [],
      blueprints: [
        {
          id: 'bp_main',
          name: 'Старт игры',
          enabled: true,
          nodes: [
            { id: 'n1', type: 'onStart', x: 60, y: 80, params: {} },
            { id: 'n2', type: 'showBanner', x: 320, y: 80, params: { title: 'Добро пожаловать!', subtitle: 'Собирай сцену и добавляй ноды логики', color: '#38bdf8' } },
          ],
          edges: [{ id: 'e1', fromNode: 'n1', fromPort: 'out', toNode: 'n2', toPort: 'in' }],
        },
      ],
    };
  }

  if (template === 'parkour') {
    return {
      version: 1,
      name: 'Неоновый Паркур',
      environment: {
        ...baseEnv,
        moodName: 'cyber',
        skyTop: [0.03, 0.05, 0.14],
        skyHorizon: [0.08, 0.16, 0.34],
        fogColor: [0.05, 0.09, 0.2],
        lightColor: [0.65, 0.8, 1.0],
        ambientColor: [0.16, 0.2, 0.32],
        postProcess: { ...createPostProcessPreset('ultraRealism'), bloomIntensity: 0.52 },
      },
      player: { enabled: true, spawnPos: [0, 1.4, 8], moveSpeed: 6.8, sprintSpeed: 11.2, jumpSpeed: 9.0, crosshair: true },
      materials: baseMats,
      entities: [
        {
          id: 'floor_start',
          name: 'Старт-платформа',
          kind: 'box',
          position: [0, -0.5, 6],
          rotationDeg: [0, 0, 0],
          scale: [1, 1, 1],
          size: [12, 1, 12],
          materialId: 'mat_floor',
          physics: { mode: 'static', editorLocked: true, mass: 0, friction: 0.85, restitution: 0.05 },
        },
        {
          id: 'pad_jump',
          name: 'Батут (Триггер)',
          kind: 'trigger',
          position: [0, 0.35, 2],
          rotationDeg: [0, 0, 0],
          scale: [1, 1, 1],
          size: [2.6, 0.5, 2.6],
          materialId: 'mat_neon',
          physics: { mode: 'static', mass: 0, friction: 0.5, restitution: 0, isTrigger: true },
        },
        {
          id: 'plat_high',
          name: 'Верхняя платформа',
          kind: 'box',
          position: [0, 4.0, -7],
          rotationDeg: [0, 0, 0],
          scale: [1, 1, 1],
          size: [10, 1, 10],
          materialId: 'mat_wall',
          physics: { mode: 'static', mass: 0, friction: 0.85, restitution: 0.05 },
        },
        {
          id: 'trig_win',
          name: 'Финиш (Портал)',
          kind: 'trigger',
          position: [0, 5.5, -9],
          rotationDeg: [0, 0, 0],
          scale: [1, 1, 1],
          size: [2.4, 2.2, 2.4],
          materialId: 'mat_trigger',
          physics: { mode: 'static', mass: 0, friction: 0.5, restitution: 0, isTrigger: true },
        },
        {
          id: 'parkour_crate',
          name: 'Ящик на платформе',
          kind: 'box',
          position: [-2, 5.2, -6.5],
          rotationDeg: [0, 18, 0],
          scale: [1, 1, 1],
          size: [1.1, 1.1, 1.1],
          materialId: 'mat_wood',
          physics: { mode: 'dynamic', mass: 1.5, friction: 0.75, restitution: 0.1 },
        },
      ],
      welds: [],
      blueprints: [
        {
          id: 'bp_parkour',
          name: 'Логика батута и финиша',
          enabled: true,
          nodes: [
            { id: 'p_e1', type: 'onTriggerEnter', x: 50, y: 60, params: { triggerEntityId: 'pad_jump', onlyPlayer: true } },
            { id: 'p_a1', type: 'applyImpulse', x: 320, y: 50, params: { entityId: '__player__', x: 0, y: 15.5, z: -5.5 } },
            { id: 'p_a2', type: 'playSound', x: 590, y: 50, params: { sound: 'pickup', freq: 620, entityId: 'pad_jump' } },
            { id: 'p_e2', type: 'onTriggerEnter', x: 50, y: 240, params: { triggerEntityId: 'trig_win', onlyPlayer: true } },
            { id: 'p_a3', type: 'emitVfx', x: 320, y: 230, params: { preset: 'confetti', entityId: 'trig_win', x: 0, y: 1, z: 0, count: 48 } },
            { id: 'p_a4', type: 'showBanner', x: 590, y: 230, params: { title: 'УРОВЕНЬ ПРОЙДЕН!', subtitle: 'Ты допрыгнул до финиша', color: '#4ade80' } },
          ],
          edges: [
            { id: 'pe1', fromNode: 'p_e1', fromPort: 'out', toNode: 'p_a1', toPort: 'in' },
            { id: 'pe2', fromNode: 'p_a1', fromPort: 'out', toNode: 'p_a2', toPort: 'in' },
            { id: 'pe3', fromNode: 'p_e2', fromPort: 'out', toNode: 'p_a3', toPort: 'in' },
            { id: 'pe4', fromNode: 'p_a3', fromPort: 'out', toNode: 'p_a4', toPort: 'in' },
          ],
        },
      ],
    };
  }

  // Default: Escape Room starter showing locked walls, key pickup, and triggered door!
  return {
    version: 1,
    name: 'Побег из комнаты',
    environment: baseEnv,
    player: { enabled: true, spawnPos: [0, 1.4, 2.5], moveSpeed: 6.2, sprintSpeed: 9.8, jumpSpeed: 8.5, crosshair: true },
    materials: baseMats,
    entities: [
      {
        id: 'floor_main',
        name: 'Пол мира',
        kind: 'box',
        position: [0, -0.5, 0],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
        size: [48, 1, 48],
        materialId: 'mat_floor',
        physics: { mode: 'static', editorLocked: true, mass: 0, friction: 0.85, restitution: 0.05 },
      },
      {
        id: 'room_main',
        name: 'Закрытая комната (Статика)',
        kind: 'room',
        position: [0, 0, 0],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
        size: [10, 3.8, 10],
        materialId: 'mat_wall',
        physics: { mode: 'static', editorLocked: true, mass: 0, friction: 0.8, restitution: 0 },
        roomConfig: { doors: ['north'], doorNoLeaf: true, windows: ['east', 'west', 'south'], roof: false, floor: true, lightColor: '#ffd996', godRay: true },
      },
      {
        id: 'door_locked',
        name: 'Бронедверь (Двигается нодой)',
        kind: 'box',
        position: [0, 1.35, -5.0],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
        size: [2.2, 2.7, 0.32],
        materialId: 'mat_door',
        physics: { mode: 'kinematic', mass: 0, friction: 0.7, restitution: 0 },
      },
      {
        id: 'key_gold',
        name: 'Золотой ключ',
        kind: 'sphere',
        position: [-3.0, 1.15, -2.5],
        rotationDeg: [0, 0, 0],
        scale: [0.85, 0.85, 0.85],
        size: [0.7, 0.7, 0.7],
        radius: 0.42,
        materialId: 'mat_gold',
        physics: { mode: 'static', mass: 0, friction: 0.5, restitution: 0, isTrigger: true },
      },
      {
        id: 'trig_door',
        name: 'Триггер у двери',
        kind: 'trigger',
        position: [0, 1.1, -3.7],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
        size: [2.4, 2.2, 1.6],
        materialId: 'mat_trigger',
        physics: { mode: 'static', mass: 0, friction: 0.5, restitution: 0, isTrigger: true },
      },
      {
        id: 'crate_decor',
        name: 'Ящик в углу (Физика)',
        kind: 'box',
        position: [3.2, 0.65, -2.6],
        rotationDeg: [0, 22, 0],
        scale: [1, 1, 1],
        size: [1.1, 1.1, 1.1],
        materialId: 'mat_wood',
        physics: { mode: 'dynamic', mass: 2.0, friction: 0.78, restitution: 0.1 },
      },
      {
        id: 'exit_pad',
        name: 'Зона выхода (Снаружи)',
        kind: 'trigger',
        position: [0, 0.9, -9.0],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
        size: [3.2, 1.8, 2.4],
        materialId: 'mat_neon',
        physics: { mode: 'static', mass: 0, friction: 0.5, restitution: 0, isTrigger: true },
      },
    ],
    welds: [],
    blueprints: [
      {
        id: 'bp_escape',
        name: 'Ключ и Дверь (Blueprint)',
        enabled: true,
        nodes: [
          { id: 'n_start', type: 'onStart', x: 40, y: 40, params: {} },
          { id: 'n_hud0', type: 'setHudCounter', x: 290, y: 40, params: { label: 'Ключи', varName: 'keys' } },
          { id: 'n_hint', type: 'showBanner', x: 550, y: 40, params: { title: 'Найди золотой ключ', subtitle: 'Подойди к двери после того как заберёшь ключ', color: '#fbbf24' } },
          { id: 'n_key_trig', type: 'onTriggerEnter', x: 40, y: 190, params: { triggerEntityId: 'key_gold', onlyPlayer: true } },
          { id: 'n_key_once', type: 'gateOnce', x: 280, y: 190, params: {} },
          { id: 'n_key_var', type: 'setVar', x: 500, y: 190, params: { name: 'keys', op: 'add', value: 1 } },
          { id: 'n_key_fx', type: 'emitVfx', x: 730, y: 150, params: { preset: 'confetti', entityId: 'key_gold', x: 0, y: 0.4, z: 0, count: 32 } },
          { id: 'n_key_sfx', type: 'playSound', x: 960, y: 150, params: { sound: 'pickup', freq: 780, entityId: 'key_gold' } },
          { id: 'n_key_del', type: 'destroyObject', x: 1180, y: 150, params: { entityId: 'key_gold' } },
          { id: 'n_door_trig', type: 'onTriggerEnter', x: 40, y: 360, params: { triggerEntityId: 'trig_door', onlyPlayer: true } },
          { id: 'n_door_if', type: 'ifVar', x: 290, y: 360, params: { name: 'keys', cmp: '>=', value: 1 } },
          { id: 'n_door_move', type: 'moveObject', x: 560, y: 320, params: { entityId: 'door_locked', x: 0, y: 3.1, z: 0, durationSec: 0.8, mode: 'offset' } },
          { id: 'n_door_sfx', type: 'playSound', x: 820, y: 320, params: { sound: 'door', freq: 280, entityId: 'door_locked' } },
          { id: 'n_door_lock', type: 'showBanner', x: 560, y: 460, params: { title: 'Дверь заперта!', subtitle: 'Сначала подбери золотой ключ слева', color: '#f87171' } },
          { id: 'n_win_trig', type: 'onTriggerEnter', x: 40, y: 560, params: { triggerEntityId: 'exit_pad', onlyPlayer: true } },
          { id: 'n_win_ban', type: 'showBanner', x: 310, y: 560, params: { title: 'ПОБЕДА!', subtitle: 'Ты выбрался из комнаты!', color: '#4ade80' } },
        ],
        edges: [
          { id: 'e_s1', fromNode: 'n_start', fromPort: 'out', toNode: 'n_hud0', toPort: 'in' },
          { id: 'e_s2', fromNode: 'n_hud0', fromPort: 'out', toNode: 'n_hint', toPort: 'in' },
          { id: 'e_k1', fromNode: 'n_key_trig', fromPort: 'out', toNode: 'n_key_once', toPort: 'in' },
          { id: 'e_k2', fromNode: 'n_key_once', fromPort: 'out', toNode: 'n_key_var', toPort: 'in' },
          { id: 'e_k3', fromNode: 'n_key_var', fromPort: 'out', toNode: 'n_key_fx', toPort: 'in' },
          { id: 'e_k4', fromNode: 'n_key_fx', fromPort: 'out', toNode: 'n_key_sfx', toPort: 'in' },
          { id: 'e_k5', fromNode: 'n_key_sfx', fromPort: 'out', toNode: 'n_key_del', toPort: 'in' },
          { id: 'e_d1', fromNode: 'n_door_trig', fromPort: 'out', toNode: 'n_door_if', toPort: 'in' },
          { id: 'e_d2', fromNode: 'n_door_if', fromPort: 'true', toNode: 'n_door_move', toPort: 'in' },
          { id: 'e_d3', fromNode: 'n_door_move', fromPort: 'out', toNode: 'n_door_sfx', toPort: 'in' },
          { id: 'e_d4', fromNode: 'n_door_if', fromPort: 'false', toNode: 'n_door_lock', toPort: 'in' },
          { id: 'e_w1', fromNode: 'n_win_trig', fromPort: 'out', toNode: 'n_win_ban', toPort: 'in' },
        ],
      },
    ],
  };
}
