import type { PostProcessPresetName, ShaderPresetName, Vec3Tuple } from 'quark-engine';

export type EditorMeshKind = 'box' | 'sphere' | 'plane' | 'ramp' | 'cone' | 'lightMarker' | 'glb';
export type EditorColliderKind = 'none' | 'aabb' | 'sphere' | 'capsule';
export type EditorLightKind = 'none' | 'point' | 'spot';

export interface AnimationKeyframe {
  time: number;
  position: Vec3Tuple;
  rotationDeg: Vec3Tuple;
  scale: Vec3Tuple;
}

export interface EditorPhysicsConfig {
  enabled: boolean;
  dynamic: boolean;
  mass: number;
  friction: number;
  restitution: number;
  gravityScale: number;
  linearDamping?: number;
  angularDamping?: number;
  lockRotation: boolean;
  colliderKind: EditorColliderKind;
  isTrigger: boolean;
  isCharacterController: boolean;
}

export interface EditorMaterialConfig {
  preset: ShaderPresetName;
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
  transparent: boolean;
  doubleSided: boolean;
  outlineWidth: number;
}

export interface EditorLightConfig {
  color: Vec3Tuple;
  intensity: number;
  range: number;
  innerConeDeg: number;
  outerConeDeg: number;
  castsShadow: boolean;
}

export interface EditorPrefab {
  id: string;
  name: string;
  template: Omit<EditorObject, 'id' | 'position' | 'prefabId'>;
}

export interface EditorObject {
  id: string;
  name: string;
  prefabId?: string;
  meshKind: EditorMeshKind;
  position: Vec3Tuple;
  rotationDeg: Vec3Tuple;
  scale: Vec3Tuple;
  material: EditorMaterialConfig;
  physics: EditorPhysicsConfig;
  lightKind: EditorLightKind;
  light: EditorLightConfig;
  keyframes: AnimationKeyframe[];
  glbBase64?: string;
  glbName?: string;
  activeClip?: string;
  animSpeed?: number;
  animLoop?: boolean;
}

export interface EditorEnvironment {
  skyTop: Vec3Tuple;
  skyHorizon: Vec3Tuple;
  fogColor: Vec3Tuple;
  fogDensity: number;
  lightDir: Vec3Tuple;
  lightColor: Vec3Tuple;
  lightIntensity: number;
  ambientColor: Vec3Tuple;
  shadowsEnabled: boolean;
  postProcess: PostProcessPresetName;
}

export interface EditorSceneDocument {
  version: 1;
  name: string;
  timelineDuration: number;
  timelineLoop: boolean;
  environment: EditorEnvironment;
  objects: EditorObject[];
  prefabs?: EditorPrefab[];
}

export const RUNTIME_STORAGE_KEY = 'quark_editor_runtime_scene_v1';

let idCounter = 1;
export function nextObjectId(): string {
  return `obj_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

export function createDefaultObject(
  name: string,
  meshKind: EditorMeshKind,
  overrides: Partial<EditorObject> = {}
): EditorObject {
  return {
    id: nextObjectId(),
    name,
    meshKind,
    position: [0, 1, 0],
    rotationDeg: [0, 0, 0],
    scale: [1, 1, 1],
    material: {
      preset: 'ultraRealism',
      baseColor: [0.85, 0.87, 0.92, 1],
      metallic: 0.15,
      roughness: 0.42,
      transparent: false,
      doubleSided: false,
      outlineWidth: 0,
      ...overrides.material,
    },
    physics: {
      enabled: meshKind !== 'lightMarker',
      dynamic: false,
      mass: 1,
      friction: 0.75,
      restitution: 0.15,
      gravityScale: 1,
      linearDamping: 0.12,
      angularDamping: 0.35,
      lockRotation: false,
      colliderKind: meshKind === 'sphere' ? 'sphere' : 'aabb',
      isTrigger: false,
      isCharacterController: false,
      ...overrides.physics,
    },
    lightKind: overrides.lightKind ?? 'none',
    light: {
      color: [1, 0.94, 0.82],
      intensity: 3.5,
      range: 18,
      innerConeDeg: 18,
      outerConeDeg: 38,
      castsShadow: true,
      ...overrides.light,
    },
    keyframes: overrides.keyframes ?? [],
    ...overrides,
  };
}

export function createDefaultSceneDocument(): EditorSceneDocument {
  const doc: EditorSceneDocument = {
    version: 1,
    name: 'Untitled Scene',
    timelineDuration: 4.0,
    timelineLoop: true,
    environment: {
      skyTop: [0.16, 0.42, 0.84],
      skyHorizon: [0.68, 0.82, 0.98],
      fogColor: [0.58, 0.72, 0.88],
      fogDensity: 0.008,
      lightDir: [0.55, 0.85, 0.45],
      lightColor: [1.0, 0.97, 0.92],
      lightIntensity: 1.35,
      ambientColor: [0.24, 0.28, 0.36],
      shadowsEnabled: true,
      postProcess: 'ultraRealism',
    },
    objects: [
      createDefaultObject('Ground Floor', 'plane', {
        position: [0, 0, 0],
        scale: [40, 1, 40],
        material: {
          preset: 'ultraRealism',
          baseColor: [0.42, 0.48, 0.56, 1],
          metallic: 0.08,
          roughness: 0.42,
          transparent: false,
          doubleSided: false,
          outlineWidth: 0,
        },
        physics: {
          enabled: true,
          dynamic: false,
          mass: 1,
          friction: 0.8,
          restitution: 0.05,
          gravityScale: 1,
          lockRotation: true,
          colliderKind: 'aabb',
          isTrigger: false,
          isCharacterController: false,
        },
      }),
      createDefaultObject('Player', 'box', {
        position: [0, 1.2, 6],
        scale: [0.8, 1.8, 0.8],
        material: {
          preset: 'animeToon',
          baseColor: [0.3, 0.75, 1.0, 1],
          metallic: 0.1,
          roughness: 0.4,
          transparent: false,
          doubleSided: false,
          outlineWidth: 0.025,
        },
        physics: {
          enabled: true,
          dynamic: true,
          mass: 1,
          friction: 0,
          restitution: 0,
          gravityScale: 1,
          lockRotation: true,
          colliderKind: 'capsule',
          isTrigger: false,
          isCharacterController: true,
        },
      }),
      createDefaultObject('Floating Crystal', 'box', {
        position: [0, 2.0, 0],
        scale: [1.1, 1.1, 1.1],
        material: {
          preset: 'iridescent',
          baseColor: [0.7, 0.9, 1.0, 1],
          metallic: 0.65,
          roughness: 0.18,
          transparent: false,
          doubleSided: false,
          outlineWidth: 0,
        },
        physics: {
          enabled: false,
          dynamic: false,
          mass: 1,
          friction: 0.5,
          restitution: 0.2,
          gravityScale: 1,
          lockRotation: false,
          colliderKind: 'none',
          isTrigger: false,
          isCharacterController: false,
        },
        keyframes: [
          { time: 0, position: [0, 1.6, 0], rotationDeg: [0, 0, 45], scale: [1.1, 1.1, 1.1] },
          { time: 2, position: [0, 2.5, 0], rotationDeg: [0, 180, 45], scale: [1.25, 1.25, 1.25] },
          { time: 4, position: [0, 1.6, 0], rotationDeg: [0, 360, 45], scale: [1.1, 1.1, 1.1] },
        ],
      }),
      createDefaultObject('Crate Dynamic', 'box', {
        position: [3.2, 1.0, -1],
        scale: [1.2, 1.2, 1.2],
        material: {
          preset: 'ultraRealism',
          baseColor: [0.85, 0.64, 0.42, 1],
          metallic: 0.05,
          roughness: 0.6,
          transparent: false,
          doubleSided: false,
          outlineWidth: 0,
        },
        physics: {
          enabled: true,
          dynamic: true,
          mass: 2,
          friction: 0.85,
          restitution: 0.15,
          gravityScale: 1,
          lockRotation: false,
          colliderKind: 'aabb',
          isTrigger: false,
          isCharacterController: false,
        },
      }),
      createDefaultObject('Accent PointLight', 'lightMarker', {
        position: [0, 3.2, 0.5],
        scale: [0.35, 0.35, 0.35],
        lightKind: 'point',
        light: {
          color: [0.4, 0.85, 1.0],
          intensity: 2.6,
          range: 14,
          innerConeDeg: 18,
          outerConeDeg: 36,
          castsShadow: false,
        },
      }),
    ],
  };
  return doc;
}

export function addKeyframe(
  obj: EditorObject,
  time: number,
  position: Vec3Tuple,
  rotationDeg: Vec3Tuple,
  scale: Vec3Tuple
): void {
  const t = Math.round(Math.max(0, time) * 100) / 100;
  const existing = obj.keyframes.find((k) => Math.abs(k.time - t) < 0.02);
  if (existing) {
    existing.position = [...position];
    existing.rotationDeg = [...rotationDeg];
    existing.scale = [...scale];
  } else {
    obj.keyframes.push({
      time: t,
      position: [...position],
      rotationDeg: [...rotationDeg],
      scale: [...scale],
    });
    obj.keyframes.sort((a, b) => a.time - b.time);
  }
}

export function removeKeyframeAt(obj: EditorObject, time: number): boolean {
  const before = obj.keyframes.length;
  obj.keyframes = obj.keyframes.filter((k) => Math.abs(k.time - time) >= 0.02);
  return obj.keyframes.length !== before;
}

export function evaluateObjectTrack(
  obj: EditorObject,
  timeSec: number,
  duration: number,
  loop: boolean
): { position: Vec3Tuple; rotationDeg: Vec3Tuple; scale: Vec3Tuple } {
  const kfs = obj.keyframes;
  if (kfs.length === 0) {
    return {
      position: [...obj.position],
      rotationDeg: [...obj.rotationDeg],
      scale: [...obj.scale],
    };
  }
  if (kfs.length === 1) {
    return {
      position: [...kfs[0].position],
      rotationDeg: [...kfs[0].rotationDeg],
      scale: [...kfs[0].scale],
    };
  }

  const maxT = Math.max(0.05, duration);
  const t = loop ? ((timeSec % maxT) + maxT) % maxT : Math.max(0, Math.min(maxT, timeSec));

  if (t <= kfs[0].time) {
    return {
      position: [...kfs[0].position],
      rotationDeg: [...kfs[0].rotationDeg],
      scale: [...kfs[0].scale],
    };
  }
  const last = kfs[kfs.length - 1];
  if (t >= last.time) {
    return {
      position: [...last.position],
      rotationDeg: [...last.rotationDeg],
      scale: [...last.scale],
    };
  }

  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = Math.max(0.0001, b.time - a.time);
      const u = (t - a.time) / span;
      return {
        position: [
          a.position[0] + (b.position[0] - a.position[0]) * u,
          a.position[1] + (b.position[1] - a.position[1]) * u,
          a.position[2] + (b.position[2] - a.position[2]) * u,
        ],
        rotationDeg: [
          a.rotationDeg[0] + (b.rotationDeg[0] - a.rotationDeg[0]) * u,
          a.rotationDeg[1] + (b.rotationDeg[1] - a.rotationDeg[1]) * u,
          a.rotationDeg[2] + (b.rotationDeg[2] - a.rotationDeg[2]) * u,
        ],
        scale: [
          a.scale[0] + (b.scale[0] - a.scale[0]) * u,
          a.scale[1] + (b.scale[1] - a.scale[1]) * u,
          a.scale[2] + (b.scale[2] - a.scale[2]) * u,
        ],
      };
    }
  }

  return { position: [...last.position], rotationDeg: [...last.rotationDeg], scale: [...last.scale] };
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function serializeSceneDocument(doc: EditorSceneDocument): string {
  return JSON.stringify(doc, null, 2);
}

export function parseSceneDocument(json: string): EditorSceneDocument {
  const raw = JSON.parse(json) as Partial<EditorSceneDocument>;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.objects)) {
    throw new Error('Invalid QuarkEngine scene document format');
  }
  return {
    version: 1,
    name: raw.name ?? 'Loaded Scene',
    timelineDuration: raw.timelineDuration ?? 4.0,
    timelineLoop: raw.timelineLoop ?? true,
    environment: raw.environment ?? createDefaultSceneDocument().environment,
    objects: raw.objects,
    prefabs: Array.isArray(raw.prefabs) ? raw.prefabs : [],
  };
}

export function cloneSceneDocument(doc: EditorSceneDocument): EditorSceneDocument {
  return parseSceneDocument(serializeSceneDocument(doc));
}

export class DocumentHistory {
  private readonly past: string[] = [];
  private readonly future: string[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 50) {
    this.maxEntries = Math.max(2, maxEntries);
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  record(snapshotBefore: EditorSceneDocument | string): void {
    const json =
      typeof snapshotBefore === 'string' ? snapshotBefore : serializeSceneDocument(snapshotBefore);
    if (this.past.length > 0 && this.past[this.past.length - 1] === json) {
      return;
    }
    this.past.push(json);
    if (this.past.length > this.maxEntries) {
      this.past.shift();
    }
    this.future.length = 0;
  }

  undo(current: EditorSceneDocument): EditorSceneDocument | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(serializeSceneDocument(current));
    return parseSceneDocument(prev);
  }

  redo(current: EditorSceneDocument): EditorSceneDocument | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(serializeSceneDocument(current));
    return parseSceneDocument(next);
  }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
  }
}

export function createPrefabFromObject(
  doc: EditorSceneDocument,
  obj: EditorObject
): EditorPrefab {
  const { id: _id, position: _pos, prefabId: _pid, ...template } = JSON.parse(
    JSON.stringify(obj)
  ) as EditorObject;
  const prefab: EditorPrefab = {
    id: `prefab_${Date.now().toString(36)}_${(idCounter++).toString(36)}`,
    name: obj.name,
    template,
  };
  if (!doc.prefabs) doc.prefabs = [];
  doc.prefabs.push(prefab);
  obj.prefabId = prefab.id;
  return prefab;
}

export function instantiatePrefab(
  prefab: EditorPrefab,
  position: Vec3Tuple
): EditorObject {
  const tpl = JSON.parse(JSON.stringify(prefab.template)) as EditorPrefab['template'];
  return {
    ...tpl,
    id: nextObjectId(),
    prefabId: prefab.id,
    position: [...position],
  };
}

export function syncPrefabInstances(
  doc: EditorSceneDocument,
  sourceObj: EditorObject
): number {
  if (!sourceObj.prefabId) return 0;
  const tpl = JSON.parse(JSON.stringify(sourceObj)) as EditorObject;
  const prefab = doc.prefabs?.find((p) => p.id === sourceObj.prefabId);
  if (prefab) {
    prefab.name = tpl.name;
    const { id: _id, position: _pos, prefabId: _pid, ...rest } = tpl;
    prefab.template = rest;
  }
  let updated = 0;
  for (let i = 0; i < doc.objects.length; i++) {
    const target = doc.objects[i];
    if (target.id === sourceObj.id || target.prefabId !== sourceObj.prefabId) continue;
    const keepId = target.id;
    const keepPos: Vec3Tuple = [...target.position];
    const cloned = JSON.parse(JSON.stringify(sourceObj)) as EditorObject;
    cloned.id = keepId;
    cloned.position = keepPos;
    doc.objects[i] = cloned;
    updated++;
  }
  return updated;
}
