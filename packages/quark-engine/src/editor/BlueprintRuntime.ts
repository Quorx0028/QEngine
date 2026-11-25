import type { AudioSystem } from '../Audio';
import { quatFromEuler, type Vec3Tuple } from '../math/Mat4';
import type { VfxPresetName, WeatherType, EntityId, Scene } from '../Scene';
import { material } from '../builders/MaterialBuilder';
import type { AssetManager } from '../assets/AssetManager';
import { createBoxGeometry, createCylinderGeometry, createSphereGeometry } from '../render/Primitives';
import type { BlueprintEdge, BlueprintGraph, BlueprintNode, BlueprintNodeType } from './ProjectSchema';

export interface BlueprintNodeSpec {
  type: BlueprintNodeType;
  category: 'event' | 'logic' | 'action';
  label: string;
  inputs: string[];
  outputs: string[];
  defaultParams: Record<string, string | number | boolean>;
}

export const BLUEPRINT_NODE_CATALOG: readonly BlueprintNodeSpec[] = [
  { type: 'onStart', category: 'event', label: 'Старт игры', inputs: [], outputs: ['out'], defaultParams: {} },
  { type: 'timerLoop', category: 'event', label: 'Таймер', inputs: [], outputs: ['out'], defaultParams: { intervalSec: 1.0 } },
  { type: 'onTick', category: 'event', label: 'Каждый кадр', inputs: [], outputs: ['out'], defaultParams: { intervalSec: 0 } },
  { type: 'onKeyPress', category: 'event', label: 'Клавиша', inputs: [], outputs: ['out'], defaultParams: { key: 'KeyE' } },
  { type: 'onTriggerEnter', category: 'event', label: 'Вход в зону', inputs: [], outputs: ['out'], defaultParams: { triggerEntityId: '', onlyPlayer: true } },
  { type: 'onTriggerExit', category: 'event', label: 'Выход из зоны', inputs: [], outputs: ['out'], defaultParams: { triggerEntityId: '', onlyPlayer: true } },
  { type: 'onCollision', category: 'event', label: 'Удар', inputs: [], outputs: ['out'], defaultParams: { entityId: '', minImpulse: 1.0 } },
  { type: 'onRaycastClick', category: 'event', label: 'Клик по объекту', inputs: [], outputs: ['out'], defaultParams: { targetEntityId: '' } },

  { type: 'setVar', category: 'logic', label: 'Переменная', inputs: ['in'], outputs: ['out'], defaultParams: { name: 'score', op: 'add', value: 1 } },
  { type: 'ifVar', category: 'logic', label: 'Условие', inputs: ['in'], outputs: ['true', 'false'], defaultParams: { name: 'keys', cmp: '>=', value: 1 } },
  { type: 'sequence', category: 'logic', label: 'Цепочка 1-2-3', inputs: ['in'], outputs: ['then1', 'then2', 'then3'], defaultParams: {} },
  { type: 'flipFlop', category: 'logic', label: 'Переключатель A/B', inputs: ['in'], outputs: ['a', 'b'], defaultParams: {} },
  { type: 'randomBranch', category: 'logic', label: 'Случайно', inputs: ['in'], outputs: ['true', 'false'], defaultParams: { chance: 0.5 } },
  { type: 'gateOnce', category: 'logic', label: 'Один раз', inputs: ['in', 'reset'], outputs: ['out'], defaultParams: {} },
  { type: 'delay', category: 'logic', label: 'Пауза', inputs: ['in'], outputs: ['out'], defaultParams: { seconds: 1.0 } },

  { type: 'moveObject', category: 'action', label: 'Сдвинуть объект', inputs: ['in'], outputs: ['out'], defaultParams: { entityId: '', x: 0, y: 2.5, z: 0, durationSec: 0.8, mode: 'offset' } },
  { type: 'rotateObject', category: 'action', label: 'Повернуть', inputs: ['in'], outputs: ['out'], defaultParams: { entityId: '', rx: 0, ry: 90, rz: 0, durationSec: 0.6 } },
  { type: 'applyImpulse', category: 'action', label: 'Импульс', inputs: ['in'], outputs: ['out'], defaultParams: { entityId: '__player__', x: 0, y: 12, z: 0 } },
  { type: 'setStaticLocked', category: 'action', label: 'Фиксация физики', inputs: ['in'], outputs: ['out'], defaultParams: { entityId: '', locked: false } },
  { type: 'setMaterialStyle', category: 'action', label: 'Цвет и прозрачность', inputs: ['in'], outputs: ['out'], defaultParams: { entityId: '', color: '#38bdf8', opacity: 0.5, glow: '#38bdf8' } },
  { type: 'spawnProp', category: 'action', label: 'Создать объект', inputs: ['in'], outputs: ['out'], defaultParams: { kind: 'box', anchorEntityId: '', x: 0, y: 2, z: 0, dynamic: true, color: '#f59e0b' } },
  { type: 'destroyObject', category: 'action', label: 'Удалить объект', inputs: ['in'], outputs: ['out'], defaultParams: { entityId: '' } },
  { type: 'toggleLight', category: 'action', label: 'Свет вкл/выкл', inputs: ['in'], outputs: ['out'], defaultParams: { entityId: '', mode: 'toggle' } },
  { type: 'cameraShake', category: 'action', label: 'Тряска камеры', inputs: ['in'], outputs: ['out'], defaultParams: { intensity: 0.16, durationSec: 0.25 } },
  { type: 'emitVfx', category: 'action', label: 'Частицы VFX', inputs: ['in'], outputs: ['out'], defaultParams: { preset: 'sparks', entityId: '', x: 0, y: 0.5, z: 0, count: 28 } },
  { type: 'playSound', category: 'action', label: 'Звук 3D', inputs: ['in'], outputs: ['out'], defaultParams: { sound: 'pickup', freq: 720, entityId: '' } },
  { type: 'teleportPlayer', category: 'action', label: 'Телепорт игрока', inputs: ['in'], outputs: ['out'], defaultParams: { x: 0, y: 1.6, z: 0 } },
  { type: 'showBanner', category: 'action', label: 'Баннер экрана', inputs: ['in'], outputs: ['out'], defaultParams: { title: 'Готово', subtitle: '', color: '#38bdf8' } },
  { type: 'setHudCounter', category: 'action', label: 'Счётчик HUD', inputs: ['in'], outputs: ['out'], defaultParams: { label: 'Счёт', varName: 'score' } },
  { type: 'setWeather', category: 'action', label: 'Погода', inputs: ['in'], outputs: ['out'], defaultParams: { weather: 'rain' } },
];

export const NODE_SPEC_BY_TYPE = new Map<BlueprintNodeType, BlueprintNodeSpec>(
  BLUEPRINT_NODE_CATALOG.map((s) => [s.type, s])
);

export interface BlueprintHostApi {
  scene: Scene;
  assets: AssetManager;
  audio: AudioSystem;
  getPlayerEntity: () => EntityId | null;
  resolveEntityId: (docId: string) => EntityId | null;
  resolveEntityMaterialId?: (docId: string) => number | null;
  resolveLightIndex: (docId: string) => { kind: 'point' | 'spot'; index: number } | null;
  getEntityEulerDeg: (docId: string) => Vec3Tuple;
  setEntityEulerDeg: (docId: string, euler: Vec3Tuple) => void;
  setEntityStaticLocked: (docId: string, locked: boolean) => void;
  onShowBanner?: (title: string, subtitle: string, color: string) => void;
  onUpdateHudCounter?: (label: string, value: string | number | boolean) => void;
  onNodeExecuted?: (nodeId: string) => void;
}

interface ActiveMoveTween {
  eid: EntityId;
  startPos: Vec3Tuple;
  endPos: Vec3Tuple;
  elapsed: number;
  duration: number;
}

interface ActiveRotTween {
  docId: string;
  eid: EntityId;
  startEuler: Vec3Tuple;
  endEuler: Vec3Tuple;
  elapsed: number;
  duration: number;
}

interface PendingDelay {
  graphId: string;
  nodeId: string;
  port: string;
  remaining: number;
}

const MAX_EXEC_STEPS = 256;

export class BlueprintRuntime {
  private readonly graphs: BlueprintGraph[];
  private readonly host: BlueprintHostApi;
  private readonly vars = new Map<string, string | number | boolean>();
  private readonly hudBindings = new Map<string, string>(); // varName -> label
  private readonly onceGates = new Set<string>();
  private readonly flipStates = new Set<string>();
  private readonly tickAccumulators = new Map<string, number>();
  private readonly moveTweens: ActiveMoveTween[] = [];
  private readonly rotTweens: ActiveRotTween[] = [];
  private readonly pendingDelays: PendingDelay[] = [];
  private disposed = false;

  constructor(graphs: BlueprintGraph[], host: BlueprintHostApi) {
    this.graphs = graphs.filter((g) => g.enabled);
    this.host = host;
  }

  getVar(name: string): string | number | boolean {
    return this.vars.get(name) ?? 0;
  }

  fireStart(): void {
    this.triggerEventNodes('onStart');
  }

  onKey(code: string): void {
    this.triggerEventNodes('onKeyPress', (n) => String(n.params.key ?? 'KeyE') === code);
  }

  onTriggerEnter(triggerDocId: string, otherEid: EntityId): void {
    const playerEid = this.host.getPlayerEntity();
    this.triggerEventNodes('onTriggerEnter', (n) => {
      if (String(n.params.triggerEntityId ?? '') !== triggerDocId) return false;
      const onlyPlayer = Boolean(n.params.onlyPlayer ?? true);
      return !onlyPlayer || (playerEid !== null && otherEid === playerEid);
    });
  }

  onTriggerExit(triggerDocId: string, otherEid: EntityId): void {
    const playerEid = this.host.getPlayerEntity();
    this.triggerEventNodes('onTriggerExit', (n) => {
      if (String(n.params.triggerEntityId ?? '') !== triggerDocId) return false;
      const onlyPlayer = Boolean(n.params.onlyPlayer ?? true);
      return !onlyPlayer || (playerEid !== null && otherEid === playerEid);
    });
  }

  onCollision(entityDocId: string, impulse: number): void {
    this.triggerEventNodes('onCollision', (n) => {
      const target = String(n.params.entityId ?? '');
      const minImp = Number(n.params.minImpulse ?? 0.5);
      return (target === '' || target === entityDocId) && impulse >= minImp;
    });
  }

  onRaycastClick(entityDocId: string): void {
    this.triggerEventNodes('onRaycastClick', (n) => String(n.params.targetEntityId ?? '') === entityDocId);
  }

  update(dt: number): void {
    if (this.disposed) return;

    // 1. Periodic onTick / timerLoop nodes
    for (const g of this.graphs) {
      for (const n of g.nodes) {
        if (n.type !== 'onTick' && n.type !== 'timerLoop') continue;
        const interval = Math.max(n.type === 'timerLoop' ? 0.05 : 0, Number(n.params.intervalSec ?? 0));
        const key = `${g.id}:${n.id}`;
        const acc = (this.tickAccumulators.get(key) ?? 0) + dt;
        if (acc >= interval) {
          this.tickAccumulators.set(key, interval > 0 ? acc - interval : 0);
          this.executeFromOutput(g, n.id, 'out');
        } else {
          this.tickAccumulators.set(key, acc);
        }
      }
    }

    // 2. Pending Delay nodes
    for (let i = this.pendingDelays.length - 1; i >= 0; i--) {
      const d = this.pendingDelays[i];
      d.remaining -= dt;
      if (d.remaining <= 0) {
        this.pendingDelays.splice(i, 1);
        const g = this.graphs.find((gr) => gr.id === d.graphId);
        if (g) this.executeFromOutput(g, d.nodeId, d.port);
      }
    }

    // 3. Smooth Move tweens
    for (let i = this.moveTweens.length - 1; i >= 0; i--) {
      const tw = this.moveTweens[i];
      if (!this.host.scene.isAlive(tw.eid)) {
        this.moveTweens.splice(i, 1);
        continue;
      }
      tw.elapsed += dt;
      const t = Math.min(1, tw.elapsed / Math.max(0.01, tw.duration));
      const s = t * t * (3 - 2 * t);
      const pos: Vec3Tuple = [
        tw.startPos[0] + (tw.endPos[0] - tw.startPos[0]) * s,
        tw.startPos[1] + (tw.endPos[1] - tw.startPos[1]) * s,
        tw.startPos[2] + (tw.endPos[2] - tw.startPos[2]) * s,
      ];
      const xf = this.host.scene.getTransform(tw.eid);
      this.host.scene.setTransform(tw.eid, { position: pos, rotation: xf.rotation, scale: xf.scale });
      if (t >= 1) this.moveTweens.splice(i, 1);
    }

    // 4. Smooth Rotate tweens
    for (let i = this.rotTweens.length - 1; i >= 0; i--) {
      const tw = this.rotTweens[i];
      if (!this.host.scene.isAlive(tw.eid)) {
        this.rotTweens.splice(i, 1);
        continue;
      }
      tw.elapsed += dt;
      const t = Math.min(1, tw.elapsed / Math.max(0.01, tw.duration));
      const s = t * t * (3 - 2 * t);
      const eul: Vec3Tuple = [
        tw.startEuler[0] + (tw.endEuler[0] - tw.startEuler[0]) * s,
        tw.startEuler[1] + (tw.endEuler[1] - tw.startEuler[1]) * s,
        tw.startEuler[2] + (tw.endEuler[2] - tw.startEuler[2]) * s,
      ];
      this.host.setEntityEulerDeg(tw.docId, eul);
      const xf = this.host.scene.getTransform(tw.eid);
      this.host.scene.setTransform(tw.eid, {
        position: xf.position,
        rotation: quatFromEuler((eul[0] * Math.PI) / 180, (eul[1] * Math.PI) / 180, (eul[2] * Math.PI) / 180),
        scale: xf.scale,
      });
      if (t >= 1) this.rotTweens.splice(i, 1);
    }
  }

  private triggerEventNodes(type: BlueprintNodeType, pred?: (node: BlueprintNode) => boolean): void {
    if (this.disposed) return;
    for (const g of this.graphs) {
      for (const n of g.nodes) {
        if (n.type === type && (!pred || pred(n))) {
          this.host.onNodeExecuted?.(n.id);
          this.executeFromOutput(g, n.id, 'out');
        }
      }
    }
  }

  private executeFromOutput(graph: BlueprintGraph, fromNodeId: string, fromPort: string, depth = 0): void {
    if (this.disposed || depth >= MAX_EXEC_STEPS) return;
    const edges = graph.edges.filter((e: BlueprintEdge) => e.fromNode === fromNodeId && e.fromPort === fromPort);
    for (const edge of edges) {
      const nextNode = graph.nodes.find((n) => n.id === edge.toNode);
      if (nextNode) {
        this.executeNode(graph, nextNode, edge.toPort, depth + 1);
      }
    }
  }

  private resolveTargetEid(refId: string): EntityId | null {
    if (refId === '__player__') return this.host.getPlayerEntity();
    return this.host.resolveEntityId(refId);
  }

  private executeNode(graph: BlueprintGraph, node: BlueprintNode, inPort: string, depth: number): void {
    if (this.disposed || depth >= MAX_EXEC_STEPS) return;
    this.host.onNodeExecuted?.(node.id);
    const p = node.params;
    const scene = this.host.scene;

    switch (node.type) {
      case 'gateOnce': {
        const key = `${graph.id}:${node.id}`;
        if (inPort === 'reset') {
          this.onceGates.delete(key);
          return;
        }
        if (this.onceGates.has(key)) return;
        this.onceGates.add(key);
        this.executeFromOutput(graph, node.id, 'out', depth + 1);
        return;
      }

      case 'delay': {
        const seconds = Math.max(0.01, Number(p.seconds ?? 1));
        this.pendingDelays.push({ graphId: graph.id, nodeId: node.id, port: 'out', remaining: seconds });
        return;
      }

      case 'setVar': {
        const name = String(p.name ?? 'score');
        const op = String(p.op ?? 'add');
        const val = p.value ?? 1;
        const cur = this.vars.get(name) ?? 0;
        const next = op === 'add' ? Number(cur) + Number(val) : val;
        this.vars.set(name, next);
        const hudLabel = this.hudBindings.get(name);
        if (hudLabel) this.host.onUpdateHudCounter?.(hudLabel, next);
        this.executeFromOutput(graph, node.id, 'out', depth + 1);
        return;
      }

      case 'ifVar': {
        const name = String(p.name ?? 'keys');
        const cmp = String(p.cmp ?? '>=');
        const rawCur = this.vars.get(name) ?? 0;
        const rawVal = p.value ?? 1;
        const a = Number(rawCur);
        const b = Number(rawVal);
        let ok = false;
        if (cmp === '==') ok = String(rawCur) === String(rawVal) || a === b;
        else if (cmp === '!=') ok = String(rawCur) !== String(rawVal) && a !== b;
        else if (cmp === '>=') ok = a >= b;
        else if (cmp === '<=') ok = a <= b;
        else if (cmp === '>') ok = a > b;
        else if (cmp === '<') ok = a < b;
        this.executeFromOutput(graph, node.id, ok ? 'true' : 'false', depth + 1);
        return;
      }

      case 'moveObject': {
        const eid = this.resolveTargetEid(String(p.entityId ?? ''));
        if (eid !== null && scene.isAlive(eid)) {
          const cur = scene.getPosition(eid);
          const dx = Number(p.x ?? 0);
          const dy = Number(p.y ?? 2);
          const dz = Number(p.z ?? 0);
          const endPos: Vec3Tuple =
            String(p.mode ?? 'offset') === 'setPos'
              ? [dx, dy, dz]
              : [cur[0] + dx, cur[1] + dy, cur[2] + dz];
          const duration = Number(p.durationSec ?? 0.6);
          if (duration <= 0.02) {
            const xf = scene.getTransform(eid);
            scene.setTransform(eid, { position: endPos, rotation: xf.rotation, scale: xf.scale, immediate: true });
          } else {
            this.moveTweens.push({ eid, startPos: [...cur], endPos, elapsed: 0, duration });
          }
        }
        break;
      }

      case 'rotateObject': {
        const docId = String(p.entityId ?? '');
        const eid = this.resolveTargetEid(docId);
        if (eid !== null && scene.isAlive(eid)) {
          const startEuler = this.host.getEntityEulerDeg(docId);
          const endEuler: Vec3Tuple = [
            startEuler[0] + Number(p.rx ?? 0),
            startEuler[1] + Number(p.ry ?? 90),
            startEuler[2] + Number(p.rz ?? 0),
          ];
          this.rotTweens.push({
            docId,
            eid,
            startEuler,
            endEuler,
            elapsed: 0,
            duration: Math.max(0.02, Number(p.durationSec ?? 0.6)),
          });
        }
        break;
      }

      case 'applyImpulse': {
        const eid = this.resolveTargetEid(String(p.entityId ?? '__player__'));
        if (eid !== null && scene.isAlive(eid)) {
          const ix = Number(p.x ?? 0);
          const iy = Number(p.y ?? 12);
          const iz = Number(p.z ?? 0);
          if (String(p.entityId) === '__player__') {
            const [vx, vy, vz] = scene.getVelocity(eid);
            scene.setVelocity(eid, vx + ix * 0.5, Math.max(vy, iy), vz + iz * 0.5);
          } else {
            scene.applyImpulse(eid, [ix, iy, iz]);
          }
        }
        break;
      }

      case 'setStaticLocked': {
        this.host.setEntityStaticLocked(String(p.entityId ?? ''), Boolean(p.locked));
        break;
      }

      case 'sequence': {
        this.executeFromOutput(graph, node.id, 'then1', depth + 1);
        this.executeFromOutput(graph, node.id, 'then2', depth + 1);
        this.executeFromOutput(graph, node.id, 'then3', depth + 1);
        return;
      }

      case 'flipFlop': {
        const key = `${graph.id}:${node.id}`;
        const isA = !this.flipStates.has(key);
        if (isA) this.flipStates.add(key);
        else this.flipStates.delete(key);
        this.executeFromOutput(graph, node.id, isA ? 'a' : 'b', depth + 1);
        return;
      }

      case 'randomBranch': {
        const chance = Math.max(0, Math.min(1, Number(p.chance ?? 0.5)));
        this.executeFromOutput(graph, node.id, Math.random() < chance ? 'true' : 'false', depth + 1);
        return;
      }

      case 'cameraShake': {
        scene.triggerShake(Number(p.intensity ?? 0.16), Number(p.durationSec ?? 0.25));
        break;
      }

      case 'setMaterialStyle': {
        const docId = String(p.entityId ?? '');
        const matId = this.host.resolveEntityMaterialId?.(docId);
        if (matId !== null && matId !== undefined && this.host.assets.hasBackend) {
          const clean = String(p.color ?? '#38bdf8').replace('#', '');
          const r = parseInt(clean.slice(0, 2) || 'ff', 16) / 255;
          const g = parseInt(clean.slice(2, 4) || 'ff', 16) / 255;
          const b = parseInt(clean.slice(4, 6) || 'ff', 16) / 255;
          const alpha = Math.max(0, Math.min(1, Number(p.opacity ?? 1)));
          const gClean = String(p.glow ?? '#38bdf8').replace('#', '');
          const gr = parseInt(gClean.slice(0, 2) || '00', 16) / 255;
          const gg = parseInt(gClean.slice(2, 4) || '00', 16) / 255;
          const gb = parseInt(gClean.slice(4, 6) || '00', 16) / 255;
          this.host.assets.updateMaterial(matId, {
            transparent: alpha < 0.99,
            uniforms: {
              baseColor: [r, g, b, alpha],
              glowColor: [gr, gg, gb],
            } as never,
          });
        }
        break;
      }

      case 'spawnProp': {
        const anchor = this.resolveTargetEid(String(p.anchorEntityId ?? ''));
        const base = anchor !== null && scene.isAlive(anchor) ? scene.getPosition(anchor) : [0, 0, 0];
        const pos: Vec3Tuple = [base[0] + Number(p.x ?? 0), base[1] + Number(p.y ?? 2), base[2] + Number(p.z ?? 0)];
        const kind = String(p.kind ?? 'box');
        const col = String(p.color ?? '#f59e0b');
        const dyn = Boolean(p.dynamic ?? true);
        const e = scene.createEntity();
        scene.setTransform(e, { position: pos, immediate: true });
        if (kind === 'sphere') {
          scene.setCollider3D(e, { kind: 'sphere', radius: 0.45 });
          if (this.host.assets.hasBackend) {
            const m = this.host.assets.registerMesh('__bp_sphere__', createSphereGeometry(0.45, 16, 20), 'project');
            scene.setMesh3D(e, { meshId: m.meshId, materialId: material('pbr').color(col).create(this.host.assets, `__bp_col_${col}`, 'project'), boundsRadius: 0.6 });
          }
        } else if (kind === 'cylinder') {
          scene.setCollider3D(e, { kind: 'cylinder', radius: 0.42, halfHeight: 0.5 });
          if (this.host.assets.hasBackend) {
            const m = this.host.assets.registerMesh('__bp_cyl__', createCylinderGeometry(0.42, 0.5, 16), 'project');
            scene.setMesh3D(e, { meshId: m.meshId, materialId: material('pbr').color(col).create(this.host.assets, `__bp_col_${col}`, 'project'), boundsRadius: 0.8 });
          }
        } else {
          scene.setCollider3D(e, { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] });
          if (this.host.assets.hasBackend) {
            const m = this.host.assets.registerMesh('__bp_box__', createBoxGeometry(0.5, 0.5, 0.5), 'project');
            scene.setMesh3D(e, { meshId: m.meshId, materialId: material('pbr').color(col).create(this.host.assets, `__bp_col_${col}`, 'project'), boundsRadius: 0.9 });
          }
        }
        scene.setRigidBody(e, { dynamic: dyn, mass: dyn ? 1.5 : 0, friction: 0.72, restitution: 0.15 });
        break;
      }

      case 'destroyObject': {
        const eid = this.resolveTargetEid(String(p.entityId ?? ''));
        if (eid !== null && scene.isAlive(eid)) {
          scene.destroyEntity(eid);
        }
        break;
      }

      case 'toggleLight': {
        const lref = this.host.resolveLightIndex(String(p.entityId ?? ''));
        if (lref) {
          const mode = String(p.mode ?? 'toggle');
          const arr = lref.kind === 'point' ? scene.pointLights : scene.spotLights;
          const light = arr[lref.index];
          if (light) {
            const onVal = Number(p.onIntensity ?? 8);
            const isOn = light.intensity > 0.05;
            light.intensity = mode === 'on' ? onVal : mode === 'off' ? 0 : isOn ? 0 : onVal;
          }
        }
        break;
      }

      case 'emitVfx': {
        const eid = this.resolveTargetEid(String(p.entityId ?? ''));
        const base = eid !== null && scene.isAlive(eid) ? scene.getPosition(eid) : [0, 1, 0];
        const pos: Vec3Tuple = [base[0] + Number(p.x ?? 0), base[1] + Number(p.y ?? 0.5), base[2] + Number(p.z ?? 0)];
        scene.emitVfx((String(p.preset ?? 'sparks') as VfxPresetName), pos, Math.max(4, Number(p.count ?? 28)), 0.03);
        break;
      }

      case 'playSound': {
        const eid = this.resolveTargetEid(String(p.entityId ?? ''));
        const pos: Vec3Tuple = eid !== null && scene.isAlive(eid) ? scene.getPosition(eid) : scene.camera.position;
        const sound = String(p.sound ?? 'pickup');
        const freq = Number(p.freq ?? 680);
        if (sound === 'explosion') this.host.audio.playExplosion3D(pos, 1.0);
        else if (sound === 'splash') this.host.audio.playSplash3D(pos, 1.0);
        else if (sound === 'impact') this.host.audio.playImpact3D(pos, 0.9, 'stone');
        else if (sound === 'door') this.host.audio.playImpact3D(pos, 0.85, 'metal');
        else this.host.audio.playToneSpatial(freq, 0.14, pos, 'triangle', 0.18);
        break;
      }

      case 'teleportPlayer': {
        const peid = this.host.getPlayerEntity();
        if (peid !== null && scene.isAlive(peid)) {
          scene.setTransform(peid, { position: [Number(p.x ?? 0), Number(p.y ?? 1.6), Number(p.z ?? 0)], immediate: true });
          scene.setVelocity(peid, 0, 0, 0);
        }
        break;
      }

      case 'showBanner': {
        this.host.onShowBanner?.(String(p.title ?? ''), String(p.subtitle ?? ''), String(p.color ?? '#38bdf8'));
        break;
      }

      case 'setHudCounter': {
        const varName = String(p.varName ?? 'score');
        const label = String(p.label ?? varName);
        this.hudBindings.set(varName, label);
        this.host.onUpdateHudCounter?.(label, this.vars.get(varName) ?? 0);
        break;
      }

      case 'setWeather': {
        scene.setWeather(String(p.weather ?? 'clear') as WeatherType);
        break;
      }
    }

    this.executeFromOutput(graph, node.id, 'out', depth + 1);
  }

  dispose(): void {
    this.disposed = true;
    this.moveTweens.length = 0;
    this.rotTweens.length = 0;
    this.pendingDelays.length = 0;
    this.vars.clear();
    this.onceGates.clear();
    this.flipStates.clear();
  }
}
