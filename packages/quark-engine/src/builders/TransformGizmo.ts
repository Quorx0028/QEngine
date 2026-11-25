import type { AssetManager } from '../assets/AssetManager';
import { quatFromEuler, type QuatTuple, type Vec3Tuple } from '../math/Mat4';
import type { OrbitControls } from '../OrbitControls';
import { createConeGeometry, createSphereGeometry } from '../render/Primitives';
import type { EntityId, Scene } from '../Scene';
import { material } from './MaterialBuilder';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type GizmoAxis = 'x' | 'y' | 'z';

export interface TransformGizmoOptions {
  ignoreEntities?: Iterable<EntityId>;
  isSelectable?: (entity: EntityId) => boolean;
  canDrag?: (entity: EntityId) => boolean;
  snapStep?: number;
  rotSnapDeg?: number;
  onSelect?: (entity: EntityId | null) => void;
  onChange?: (entity: EntityId, mode: GizmoMode) => void;
  onDragEnd?: (entity: EntityId, mode: GizmoMode) => void;
}

/**
 * Interactive 3D Transform Gizmo (`Translate` / `Rotate` / `Scale` + click-to-pick) for 3D viewers and scene editing.
 * Temporarily pauses `OrbitControls` while dragging an axis handle.
 */
export class TransformGizmo {
  private readonly scene: Scene;
  private readonly assets: AssetManager;
  private readonly orbit: OrbitControls | null;
  private readonly ignoreEntities: Set<EntityId>;
  private readonly customSelectable?: (entity: EntityId) => boolean;
  private readonly customCanDrag?: (entity: EntityId) => boolean;
  private readonly onSelectCb?: (entity: EntityId | null) => void;
  private readonly onChangeCb?: (entity: EntityId, mode: GizmoMode) => void;
  private readonly onDragEndCb?: (entity: EntityId, mode: GizmoMode) => void;
  private snapStep = 0;
  private rotSnapDeg = 0;

  private mode: GizmoMode = 'translate';
  private enabled = false;
  private selected: EntityId | null = null;
  private attachedEl: HTMLElement | null = null;

  private readonly handleEntities: EntityId[] = [];
  private stemX = 0;
  private tipX = 0;
  private stemY = 0;
  private tipY = 0;
  private stemZ = 0;
  private tipZ = 0;
  private centerOrb = 0;
  private handlesBuilt = false;

  private downPos: [number, number] | null = null;
  private dragAxis: GizmoAxis | null = null;
  private dragStartT = 0;
  private dragStartPos: Vec3Tuple = [0, 0, 0];
  private dragStartRot: QuatTuple = [0, 0, 0, 1];
  private dragStartScale: Vec3Tuple = [1, 1, 1];
  private dragCurrentScale: Vec3Tuple = [1, 1, 1];
  private dragStartX = 0;
  private dragStartY = 0;
  private prevOrbitEnabled = true;

  constructor(
    scene: Scene,
    assets: AssetManager,
    orbit: OrbitControls | null = null,
    opts: TransformGizmoOptions = {}
  ) {
    this.scene = scene;
    this.assets = assets;
    this.orbit = orbit;
    this.ignoreEntities = new Set(opts.ignoreEntities ?? []);
    this.customSelectable = opts.isSelectable;
    this.customCanDrag = opts.canDrag;
    this.snapStep = Math.max(0, opts.snapStep ?? 0);
    this.rotSnapDeg = Math.max(0, opts.rotSnapDeg ?? 0);
    this.onSelectCb = opts.onSelect;
    this.onChangeCb = opts.onChange;
    this.onDragEndCb = opts.onDragEnd;
  }

  setSnap(moveStep: number, rotDeg = 0): void {
    this.snapStep = Math.max(0, moveStep);
    this.rotSnapDeg = Math.max(0, rotDeg);
  }

  private ensureHandles(): void {
    if (this.handlesBuilt || !this.assets.hasBackend) return;
    this.handlesBuilt = true;
    const stemMesh = this.assets.registerMesh('__gizmo_stem__', createConeGeometry(0.032, 0.032, 1.0, 10), 'gizmo');
    const tipMesh = this.assets.registerMesh('__gizmo_tip__', createConeGeometry(0.005, 0.11, 0.28, 12), 'gizmo');
    const orbMesh = this.assets.registerMesh('__gizmo_orb__', createSphereGeometry(0.11, 10, 14), 'gizmo');

    const matX = material('cyberNeon').color('#ef4444').glow('#fb7185').create(this.assets, '__gz_x__', 'gizmo');
    const matY = material('cyberNeon').color('#22c55e').glow('#4ade80').create(this.assets, '__gz_y__', 'gizmo');
    const matZ = material('cyberNeon').color('#3b82f6').glow('#38bdf8').create(this.assets, '__gz_z__', 'gizmo');
    const matC = material('cyberNeon').color('#facc15').glow('#fde047').create(this.assets, '__gz_c__', 'gizmo');

    const makePart = (meshId: number, materialId: number): EntityId => {
      const e = this.scene.createEntity();
      this.scene.setTransform(e, { position: [0, -999, 0], scale: [0.001, 0.001, 0.001], immediate: true });
      this.scene.setMesh3D(e, { meshId, materialId, boundsRadius: 2.0 });
      this.handleEntities.push(e);
      this.ignoreEntities.add(e);
      return e;
    };

    this.stemX = makePart(stemMesh.meshId, matX);
    this.tipX = makePart(tipMesh.meshId, matX);
    this.stemY = makePart(stemMesh.meshId, matY);
    this.tipY = makePart(tipMesh.meshId, matY);
    this.stemZ = makePart(stemMesh.meshId, matZ);
    this.tipZ = makePart(tipMesh.meshId, matZ);
    this.centerOrb = makePart(orbMesh.meshId, matC);
  }

  /** Rebuilds handle entities after a `scene.clear()` / `assets.releaseTag('gizmo')` call. */
  resetHandles(): void {
    this.handlesBuilt = false;
    this.handleEntities.length = 0;
    this.selected = null;
    this.dragAxis = null;
  }

  ignore(entity: EntityId): void {
    this.ignoreEntities.add(entity);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.endDrag();
      this.hideHandles();
    } else {
      this.ensureHandles();
      this.update();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setMode(mode: GizmoMode): void {
    this.mode = mode;
  }

  getMode(): GizmoMode {
    return this.mode;
  }

  select(entity: EntityId | null): void {
    if (entity !== null && (!this.scene.isAlive(entity) || this.ignoreEntities.has(entity))) {
      entity = null;
    }
    this.selected = entity;
    this.onSelectCb?.(entity);
    if (entity === null) {
      this.hideHandles();
    } else {
      this.update();
    }
  }

  getSelected(): EntityId | null {
    if (this.selected !== null && !this.scene.isAlive(this.selected)) {
      this.selected = null;
      this.onSelectCb?.(null);
    }
    return this.selected;
  }

  attach(element: HTMLElement): void {
    if (this.attachedEl === element) return;
    this.detach();
    this.attachedEl = element;
    element.addEventListener('pointerdown', this.onPointerDown, true);
    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', this.onPointerMove, true);
      window.addEventListener('pointerup', this.onPointerUp, true);
    }
  }

  detach(): void {
    if (!this.attachedEl) return;
    this.attachedEl.removeEventListener('pointerdown', this.onPointerDown, true);
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', this.onPointerMove, true);
      window.removeEventListener('pointerup', this.onPointerUp, true);
    }
    this.attachedEl = null;
    this.endDrag();
  }

  private hideHandles(): void {
    if (!this.handlesBuilt) return;
    for (const e of this.handleEntities) {
      if (this.scene.isAlive(e)) {
        this.scene.setTransform(e, { position: [0, -999, 0], scale: [0.001, 0.001, 0.001], immediate: true });
      }
    }
  }

  private gizmoScale(center: Vec3Tuple): number {
    const cam = this.scene.camera.position;
    const dist = Math.hypot(center[0] - cam[0], center[1] - cam[1], center[2] - cam[2]);
    return Math.max(0.75, Math.min(3.5, dist * 0.14));
  }

  update(): void {
    if (!this.enabled) return;
    const eid = this.getSelected();
    if (eid === null) {
      this.hideHandles();
      return;
    }
    this.ensureHandles();
    if (!this.handlesBuilt) return;

    const p = this.scene.getPosition(eid);
    const s = this.gizmoScale(p);
    const halfStem = 0.55 * s;
    const tipDist = 1.18 * s;

    this.scene.setTransform(this.centerOrb, { position: p, scale: [s, s, s], immediate: true });
    // X handle (+X rotates local +Y cylinder by -PI/2 around Z)
    this.scene.setTransform(this.stemX, {
      position: [p[0] + halfStem, p[1], p[2]],
      rotation: quatFromEuler(0, 0, -Math.PI * 0.5),
      scale: [s, s, s],
      immediate: true,
    });
    this.scene.setTransform(this.tipX, {
      position: [p[0] + tipDist, p[1], p[2]],
      rotation: quatFromEuler(0, 0, -Math.PI * 0.5),
      scale: [s, s, s],
      immediate: true,
    });
    // Y handle (+Y upright)
    this.scene.setTransform(this.stemY, {
      position: [p[0], p[1] + halfStem, p[2]],
      scale: [s, s, s],
      immediate: true,
    });
    this.scene.setTransform(this.tipY, {
      position: [p[0], p[1] + tipDist, p[2]],
      scale: [s, s, s],
      immediate: true,
    });
    // Z handle (+Z rotates local +Y cylinder by +PI/2 around X)
    this.scene.setTransform(this.stemZ, {
      position: [p[0], p[1], p[2] + halfStem],
      rotation: quatFromEuler(Math.PI * 0.5, 0, 0),
      scale: [s, s, s],
      immediate: true,
    });
    this.scene.setTransform(this.tipZ, {
      position: [p[0], p[1], p[2] + tipDist],
      rotation: quatFromEuler(Math.PI * 0.5, 0, 0),
      scale: [s, s, s],
      immediate: true,
    });
  }

  private hitTestAxis(origin: Vec3Tuple, dir: Vec3Tuple, center: Vec3Tuple): { axis: GizmoAxis; tAxis: number } | null {
    const s = this.gizmoScale(center);
    const axes: Array<{ axis: GizmoAxis; v: Vec3Tuple }> = [
      { axis: 'x', v: [1, 0, 0] },
      { axis: 'y', v: [0, 1, 0] },
      { axis: 'z', v: [0, 0, 1] },
    ];
    let best: { axis: GizmoAxis; tAxis: number; dist: number } | null = null;
    for (const a of axes) {
      const hit = rayClosestToAxis(origin, dir, center, a.v);
      if (!hit) continue;
      if (hit.tAxis >= 0.1 * s && hit.tAxis <= 1.55 * s && hit.dist < 0.28 * s) {
        if (!best || hit.dist < best.dist) {
          best = { axis: a.axis, tAxis: hit.tAxis, dist: hit.dist };
        }
      }
    }
    return best ? { axis: best.axis, tAxis: best.tAxis } : null;
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled || e.button !== 0 || !this.attachedEl) return;
    this.downPos = [e.clientX, e.clientY];
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;

    const eid = this.getSelected();
    if (eid === null) return;

    const rect = this.attachedEl.getBoundingClientRect();
    const ray = this.scene.screenToRay(e.clientX, e.clientY, rect);
    const xf = this.scene.getTransform(eid);
    const hit = this.hitTestAxis(ray.origin, ray.dir, xf.position);
    if (!hit) return;
    if (this.customCanDrag && !this.customCanDrag(eid)) return;

    // Grabbed an axis handle! Pause OrbitControls while dragging
    e.stopPropagation();
    e.preventDefault();
    this.dragAxis = hit.axis;
    this.dragStartT = hit.tAxis;
    this.dragStartPos = [...xf.position];
    this.dragStartRot = [...xf.rotation];
    this.dragStartScale = [...xf.scale];
    this.dragCurrentScale = [...xf.scale];
    if (this.orbit) {
      this.prevOrbitEnabled = this.orbit.enabled;
      this.orbit.enabled = false;
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled || !this.dragAxis || !this.attachedEl) return;
    const eid = this.getSelected();
    if (eid === null) {
      this.endDrag();
      return;
    }

    const axisVec: Vec3Tuple =
      this.dragAxis === 'x' ? [1, 0, 0] : this.dragAxis === 'y' ? [0, 1, 0] : [0, 0, 1];
    const axisIdx = this.dragAxis === 'x' ? 0 : this.dragAxis === 'y' ? 1 : 2;

    if (this.mode === 'translate') {
      const rect = this.attachedEl.getBoundingClientRect();
      const ray = this.scene.screenToRay(e.clientX, e.clientY, rect);
      const res = rayClosestToAxis(ray.origin, ray.dir, this.dragStartPos, axisVec);
      if (res) {
        const rawDelta = res.tAxis - this.dragStartT;
        const delta =
          this.snapStep > 0 ? Math.round(rawDelta / this.snapStep) * this.snapStep : rawDelta;
        const nextPos: Vec3Tuple = [...this.dragStartPos];
        nextPos[axisIdx] += delta;
        if (this.snapStep > 0) {
          nextPos[axisIdx] = Math.round(nextPos[axisIdx] / this.snapStep) * this.snapStep;
        }
        this.scene.setTransform(eid, {
          position: nextPos,
          rotation: this.dragStartRot,
          scale: this.dragStartScale,
          immediate: true,
        });
        this.scene.setVelocity(eid, 0, 0, 0);
        this.update();
        this.onChangeCb?.(eid, this.mode);
      }
    } else if (this.mode === 'rotate') {
      let ang = (e.clientX - this.dragStartX) * 0.012;
      if (this.rotSnapDeg > 0) {
        const stepRad = (this.rotSnapDeg * Math.PI) / 180;
        ang = Math.round(ang / stepRad) * stepRad;
      }
      const nextRot = mulQuatAxisAngle(this.dragStartRot, axisVec, ang);
      this.scene.setTransform(eid, {
        position: this.dragStartPos,
        rotation: nextRot,
        scale: this.dragStartScale,
        immediate: true,
      });
      this.scene.setVelocity(eid, 0, 0, 0);
      this.update();
      this.onChangeCb?.(eid, this.mode);
    } else {
      const delta = (e.clientX - this.dragStartX - (e.clientY - this.dragStartY)) * 0.008;
      const nextScale: Vec3Tuple = [...this.dragStartScale];
      nextScale[axisIdx] = Math.max(0.15, Math.min(24, this.dragStartScale[axisIdx] * (1 + delta)));
      const rx = nextScale[0] / Math.max(1e-4, this.dragCurrentScale[0]);
      const ry = nextScale[1] / Math.max(1e-4, this.dragCurrentScale[1]);
      const rz = nextScale[2] / Math.max(1e-4, this.dragCurrentScale[2]);
      this.dragCurrentScale = [...nextScale];
      this.scene.setTransform(eid, {
        position: this.dragStartPos,
        rotation: this.dragStartRot,
        scale: nextScale,
        immediate: true,
      });
      this.scene.scaleCollider3D(eid, rx, ry, rz);
      this.scene.setVelocity(eid, 0, 0, 0);
      this.update();
      this.onChangeCb?.(eid, this.mode);
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.dragAxis) {
      this.endDrag();
      this.downPos = null;
      return;
    }
    if (!this.enabled || !this.downPos || !this.attachedEl || e.button !== 0) {
      this.downPos = null;
      return;
    }
    const moved = Math.hypot(e.clientX - this.downPos[0], e.clientY - this.downPos[1]);
    this.downPos = null;
    if (moved > 5) return; // user orbited camera, not a pick click

    const rect = this.attachedEl.getBoundingClientRect();
    const ray = this.scene.screenToRay(e.clientX, e.clientY, rect);
    const hit = this.scene.raycast3D(ray.origin, ray.dir, 95);
    if (hit && !this.ignoreEntities.has(hit.entity) && (!this.customSelectable || this.customSelectable(hit.entity))) {
      this.select(hit.entity);
    } else {
      this.select(null);
    }
  };

  private endDrag(): void {
    if (!this.dragAxis) return;
    const finished = this.selected;
    this.dragAxis = null;
    if (this.orbit) {
      this.orbit.enabled = this.prevOrbitEnabled;
    }
    if (finished !== null) {
      this.onDragEndCb?.(finished, this.mode);
    }
  }

  dispose(): void {
    this.detach();
    this.hideHandles();
    for (const e of this.handleEntities) {
      if (this.scene.isAlive(e)) this.scene.destroyEntity(e);
    }
    this.handleEntities.length = 0;
    this.handlesBuilt = false;
  }
}

function rayClosestToAxis(
  ro: Vec3Tuple,
  rd: Vec3Tuple,
  ao: Vec3Tuple,
  ad: Vec3Tuple
): { tRay: number; tAxis: number; dist: number } | null {
  const wx = ro[0] - ao[0], wy = ro[1] - ao[1], wz = ro[2] - ao[2];
  const a = rd[0] * rd[0] + rd[1] * rd[1] + rd[2] * rd[2];
  const b = rd[0] * ad[0] + rd[1] * ad[1] + rd[2] * ad[2];
  const c = ad[0] * ad[0] + ad[1] * ad[1] + ad[2] * ad[2];
  const d = rd[0] * wx + rd[1] * wy + rd[2] * wz;
  const e = ad[0] * wx + ad[1] * wy + ad[2] * wz;
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-6) return null;
  const tRay = (b * e - c * d) / denom;
  const tAxis = (a * e - b * d) / denom;
  if (tRay < 0) return null;
  const px = ro[0] + rd[0] * tRay - (ao[0] + ad[0] * tAxis);
  const py = ro[1] + rd[1] * tRay - (ao[1] + ad[1] * tAxis);
  const pz = ro[2] + rd[2] * tRay - (ao[2] + ad[2] * tAxis);
  return { tRay, tAxis, dist: Math.hypot(px, py, pz) };
}

function mulQuatAxisAngle(q: QuatTuple, axis: Vec3Tuple, angle: number): QuatTuple {
  const half = angle * 0.5;
  const s = Math.sin(half);
  const ax = axis[0] * s, ay = axis[1] * s, az = axis[2] * s, aw = Math.cos(half);
  // world-axis rotation: delta * q
  const rx = aw * q[0] + ax * q[3] + ay * q[2] - az * q[1];
  const ry = aw * q[1] - ax * q[2] + ay * q[3] + az * q[0];
  const rz = aw * q[2] + ax * q[1] - ay * q[0] + az * q[3];
  const rw = aw * q[3] - ax * q[0] - ay * q[1] - az * q[2];
  const len = Math.hypot(rx, ry, rz, rw) || 1;
  return [rx / len, ry / len, rz / len, rw / len];
}
