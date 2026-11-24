import { BehaviorManager, type EntityBehavior } from './gameplay/Behavior';
import { mat4LookAt, mat4Multiply, mat4Ortho, mat4Perspective, Vec3Tuple, QuatTuple } from './math/Mat4';
import {
  createPostProcessPreset,
  type PostProcessConfig,
  type PostProcessPresetName,
} from './render/PostProcess';
import { WasmBridge } from './wasm/WasmBridge';

export type EntityId = number;

export interface TransformOptions {
  position?: Vec3Tuple;
  rotation?: QuatTuple;
  scale?: Vec3Tuple;
  immediate?: boolean;
}

export type CombineRule = 'default' | 'average' | 'min' | 'max' | 'multiply';

export interface RigidBodyOptions {
  dynamic?: boolean;
  gravityScale?: number;
  restitution?: number;
  friction?: number;
  linearDamping?: number;
  angularDamping?: number;
  mass?: number;
  lockRotation?: boolean;
  density?: number;
  centerOfMass?: Vec3Tuple;
  staticFriction?: number;
  restitutionThreshold?: number;
  frictionCombine?: CombineRule;
  restitutionCombine?: CombineRule;
  ccd?: boolean;
  canSleep?: boolean;
}

export const PHYSICS_MATERIAL_PRESETS: Record<
  'wood' | 'stone' | 'steel' | 'ice' | 'rubber' | 'bouncy',
  Partial<RigidBodyOptions>
> = {
  wood: { density: 0.65, friction: 0.6, staticFriction: 0.72, restitution: 0.12, linearDamping: 0.14 },
  stone: { density: 2.4, friction: 0.82, staticFriction: 0.95, restitution: 0.05, linearDamping: 0.1 },
  steel: { density: 7.8, friction: 0.45, staticFriction: 0.58, restitution: 0.25, linearDamping: 0.06 },
  ice: { density: 0.92, friction: 0.03, staticFriction: 0.05, restitution: 0.08, linearDamping: 0.03 },
  rubber: { density: 1.15, friction: 0.95, staticFriction: 1.15, restitution: 0.68, linearDamping: 0.1 },
  bouncy: { density: 0.85, friction: 0.45, staticFriction: 0.55, restitution: 0.92, linearDamping: 0.04 },
};

export type CompoundPartDesc = {
  position?: Vec3Tuple;
  rotation?: QuatTuple;
  shape:
    | { kind: 'aabb'; halfExtents: Vec3Tuple }
    | { kind: 'sphere'; radius: number }
    | { kind: 'capsule'; radius: number; halfHeight: number }
    | { kind: 'cylinder'; radius: number; halfHeight: number };
};

export type Collider3DOptions =
  | { kind: 'aabb'; halfExtents: Vec3Tuple }
  | { kind: 'sphere'; radius: number }
  | { kind: 'capsule'; radius: number; halfHeight: number }
  | { kind: 'cylinder'; radius: number; halfHeight: number }
  | { kind: 'convexHull'; points: Vec3Tuple[] | Float32Array }
  | { kind: 'compound'; parts: CompoundPartDesc[] };

export type Collider2DOptions =
  | { kind: 'aabb2d'; halfExtents: [number, number] }
  | { kind: 'circle2d'; radius: number }
  | { kind: 'capsule2d'; radius: number; halfHeight: number };

export interface Sprite2DOptions {
  size?: [number, number];
  uvMin?: [number, number];
  uvMax?: [number, number];
  color?: [number, number, number, number];
  textureId?: number;
  layer?: number;
}

export interface Mesh3DOptions {
  meshId: number;
  materialId: number;
  transparent?: boolean;
  boundsRadius?: number;
}

export interface CameraState {
  mode: '3d' | '2d';
  position: Vec3Tuple;
  target: Vec3Tuple;
  up: Vec3Tuple;
  fovDeg: number;
  near: number;
  far: number;
  orthoHeight: number;
  zoom: number;
  pixelSnap: boolean;
}

export interface DirectionalLight {
  direction: Vec3Tuple;
  color: Vec3Tuple;
  intensity: number;
  ambientColor: Vec3Tuple;
}

export interface PointLight {
  position: Vec3Tuple;
  color: Vec3Tuple;
  intensity: number;
  radius: number;
}

export interface SpotLight {
  position: Vec3Tuple;
  direction: Vec3Tuple;
  color: Vec3Tuple;
  intensity: number;
  range: number;
  innerConeDeg?: number;
  outerConeDeg?: number;
  castsShadow?: boolean;
}

export interface Light2D {
  position: [number, number];
  color: Vec3Tuple;
  radius: number;
  intensity?: number;
}

export interface CollisionEvent {
  entityA: EntityId;
  entityB: EntityId;
  normal: Vec3Tuple;
}

export interface RichPhysicsEvent {
  kind: number;
  entityA: EntityId;
  entityB: EntityId;
  normal: Vec3Tuple;
  contactPoint: Vec3Tuple;
  impulse: number;
}

export interface TriggerEvent {
  entityA: EntityId;
  entityB: EntityId;
}

export class Scene {
  private readonly bridge: WasmBridge;
  private readonly projMat = new Float32Array(16);
  private readonly viewMat = new Float32Array(16);
  private readonly vpMat = new Float32Array(16);

  readonly camera: CameraState = {
    mode: '3d',
    position: [0, 3, 8],
    target: [0, 1, 0],
    up: [0, 1, 0],
    fovDeg: 60,
    near: 0.1,
    far: 250,
    orthoHeight: 12,
    zoom: 1.0,
    pixelSnap: false,
  };

  readonly light: DirectionalLight = {
    direction: [0.55, 0.85, 0.45],
    color: [1.0, 0.97, 0.92],
    intensity: 1.35,
    ambientColor: [0.22, 0.25, 0.34],
  };

  readonly pointLights: PointLight[] = [];
  readonly spotLights: SpotLight[] = [];
  readonly lights2d: { ambientColor: Vec3Tuple; lights: Light2D[] } = {
    ambientColor: [1, 1, 1],
    lights: [],
  };
  postProcess: PostProcessConfig = createPostProcessPreset('none');
  shadowsEnabled = true;
  debugPhysics = false;
  skyTopColor: Vec3Tuple = [0.08, 0.16, 0.32];
  skyHorizonColor: Vec3Tuple = [0.22, 0.32, 0.48];
  fogColor: Vec3Tuple = [0.16, 0.22, 0.34];
  fogDensity = 0.008;

  private shakeTime = 0;
  private shakeDuration = 0;
  private shakeIntensity = 0;

  private readonly collisionEnterListeners = new Set<(ev: CollisionEvent) => void>();
  private readonly triggerEnterListeners = new Set<(ev: TriggerEvent) => void>();
  private readonly triggerExitListeners = new Set<(ev: TriggerEvent) => void>();
  private readonly richEventListeners = new Set<(ev: RichPhysicsEvent) => void>();
  readonly behaviors: BehaviorManager;

  constructor(bridge: WasmBridge) {
    this.bridge = bridge;
    this.behaviors = new BehaviorManager(this);
  }

  addBehavior<T extends EntityBehavior>(entity: EntityId, behavior: T): T {
    return this.behaviors.add(entity, behavior);
  }

  getBehavior<T extends EntityBehavior>(
    entity: EntityId,
    typeOrCtor: string | (abstract new (...args: never[]) => T)
  ): T | undefined {
    return this.behaviors.get(entity, typeOrCtor);
  }

  removeBehavior(entity: EntityId, behavior: EntityBehavior): boolean {
    return this.behaviors.remove(entity, behavior);
  }

  createEntity(): EntityId {
    return this.bridge.spawn();
  }

  destroyEntity(entity: EntityId): boolean {
    this.behaviors.destroyEntity(entity);
    return this.bridge.despawn(entity);
  }

  isAlive(entity: EntityId): boolean {
    return this.bridge.isAlive(entity);
  }

  getEntityCount(): number {
    return this.bridge.aliveCount();
  }

  setParent(child: EntityId, parent: EntityId): boolean {
    return this.bridge.setParent(child, parent);
  }

  setGravity(x: number, y: number, z: number): void {
    this.bridge.setGravity(x, y, z);
  }

  setTransform(entity: EntityId, opts: TransformOptions): void {
    const p = opts.position ?? [0, 0, 0];
    const r = opts.rotation ?? [0, 0, 0, 1];
    const s = opts.scale ?? [1, 1, 1];
    this.bridge.setTransform(
      entity,
      p[0],
      p[1],
      p[2],
      r[0],
      r[1],
      r[2],
      r[3],
      s[0],
      s[1],
      s[2],
      opts.immediate ?? false
    );
  }

  getPosition(entity: EntityId, out?: Vec3Tuple): Vec3Tuple {
    return this.bridge.getPosition(entity, out);
  }

  setVelocity(entity: EntityId, vx: number, vy: number, vz: number): void {
    this.bridge.setVelocity(entity, vx, vy, vz);
  }

  getVelocity(entity: EntityId, out?: Vec3Tuple): Vec3Tuple {
    return this.bridge.getVelocity(entity, out);
  }

  setRigidBody(entity: EntityId, opts: RigidBodyOptions = {}): void {
    this.bridge.setRigidBody(
      entity,
      opts.dynamic ?? true,
      opts.gravityScale ?? 1.0,
      opts.restitution ?? 0.1,
      opts.friction ?? 0.75,
      opts.linearDamping ?? 0.12,
      opts.angularDamping ?? 0.35,
      opts.mass ?? 1.0,
      opts.lockRotation ?? false
    );
    const hasExtended =
      opts.density !== undefined ||
      opts.centerOfMass !== undefined ||
      opts.staticFriction !== undefined ||
      opts.restitutionThreshold !== undefined ||
      opts.frictionCombine !== undefined ||
      opts.restitutionCombine !== undefined ||
      opts.ccd !== undefined ||
      opts.canSleep !== undefined;
    if (hasExtended) {
      const ruleCode = (r?: CombineRule): number =>
        r === 'average' ? 1 : r === 'min' ? 2 : r === 'max' ? 3 : r === 'multiply' ? 4 : 0;
      const com = opts.centerOfMass ?? [0, 0, 0];
      this.bridge.setPhysicsMaterial(
        entity,
        opts.density ?? 0.0,
        com[0],
        com[1],
        com[2],
        opts.staticFriction ?? -1.0,
        opts.restitutionThreshold ?? 1.0,
        ruleCode(opts.frictionCombine),
        ruleCode(opts.restitutionCombine),
        opts.ccd ?? false,
        opts.canSleep ?? true
      );
    }
  }

  setAngularVelocity(entity: EntityId, wx: number, wy: number, wz: number): void {
    this.bridge.setAngularVelocity(entity, wx, wy, wz);
  }

  applyImpulse(entity: EntityId, impulse: Vec3Tuple, worldPoint?: Vec3Tuple): void {
    this.bridge.applyImpulse(
      entity,
      impulse[0],
      impulse[1],
      impulse[2],
      worldPoint?.[0],
      worldPoint?.[1],
      worldPoint?.[2]
    );
  }

  setPostProcessPreset(name: PostProcessPresetName): void {
    this.postProcess = createPostProcessPreset(name);
  }

  triggerShake(intensity: number, durationSec: number): void {
    this.shakeIntensity = intensity;
    this.shakeDuration = Math.max(0.01, durationSec);
    this.shakeTime = this.shakeDuration;
  }

  advanceEffects(dt: number): void {
    if (this.shakeTime > 0) {
      this.shakeTime = Math.max(0, this.shakeTime - dt);
    }
  }

  isGrounded(entity: EntityId): boolean {
    return this.bridge.isGrounded(entity);
  }

  isSleeping(entity: EntityId): boolean {
    return this.bridge.isSleeping(entity);
  }

  setCollisionFilter(entity: EntityId, layer: number, mask: number): void {
    this.bridge.setCollisionFilter(entity, layer, mask);
  }

  setTrigger(entity: EntityId, isTrigger: boolean): void {
    this.bridge.setTrigger(entity, isTrigger);
  }

  setCharacterController(
    entity: EntityId,
    opts: {
      stepHeight?: number;
      maxSlopeDeg?: number;
      pushStrength?: number;
      maxPushMass?: number;
      groundSnap?: number;
      antiTipPush?: boolean;
    } = {}
  ): void {
    if (
      opts.pushStrength !== undefined ||
      opts.maxPushMass !== undefined ||
      opts.groundSnap !== undefined ||
      opts.antiTipPush !== undefined
    ) {
      this.bridge.setCharacterControllerEx(
        entity,
        opts.stepHeight ?? 0.45,
        opts.maxSlopeDeg ?? 50,
        opts.pushStrength ?? 0.75,
        opts.maxPushMass ?? 35.0,
        opts.groundSnap ?? 0.12,
        opts.antiTipPush ?? true
      );
    } else {
      this.bridge.setCharacterController(entity, opts.stepHeight ?? 0.45, opts.maxSlopeDeg ?? 50);
    }
  }

  addWaterZone(opts: {
    center: Vec3Tuple;
    halfExtents: Vec3Tuple;
    rotation?: QuatTuple;
    density?: number;
    linearDrag?: number;
    angularDrag?: number;
    flow?: Vec3Tuple;
  }): number {
    const r = opts.rotation ?? [0, 0, 0, 1];
    const f = opts.flow ?? [0, 0, 0];
    return this.bridge.addWaterZone(
      opts.center[0],
      opts.center[1],
      opts.center[2],
      opts.halfExtents[0],
      opts.halfExtents[1],
      opts.halfExtents[2],
      r[0],
      r[1],
      r[2],
      r[3],
      opts.density ?? 1.0,
      opts.linearDrag ?? 2.2,
      opts.angularDrag ?? 2.0,
      f[0],
      f[1],
      f[2]
    );
  }

  clearWaterZones(): void {
    this.bridge.clearWaterZones();
  }

  addBallSocketJoint(
    entityA: EntityId,
    entityB: EntityId,
    opts: { anchorA?: Vec3Tuple; anchorB?: Vec3Tuple } = {}
  ): number {
    const a = opts.anchorA ?? [0, 0, 0];
    const b = opts.anchorB ?? [0, 0, 0];
    return this.bridge.addBallSocketJoint(entityA, entityB, a[0], a[1], a[2], b[0], b[1], b[2]);
  }

  addFixedJoint(
    entityA: EntityId,
    entityB: EntityId,
    opts: { anchorA?: Vec3Tuple; anchorB?: Vec3Tuple } = {}
  ): number {
    const a = opts.anchorA ?? [0, 0, 0];
    const b = opts.anchorB ?? [0, 0, 0];
    return this.bridge.addFixedJoint(entityA, entityB, a[0], a[1], a[2], b[0], b[1], b[2]);
  }

  addPrismaticJoint(
    entityA: EntityId,
    entityB: EntityId,
    opts: {
      anchorA?: Vec3Tuple;
      anchorB?: Vec3Tuple;
      axis: Vec3Tuple;
      minDist?: number;
      maxDist?: number;
    }
  ): number {
    const a = opts.anchorA ?? [0, 0, 0];
    const b = opts.anchorB ?? [0, 0, 0];
    const hasLimits = opts.minDist !== undefined || opts.maxDist !== undefined;
    return this.bridge.addPrismaticJoint(
      entityA,
      entityB,
      a[0],
      a[1],
      a[2],
      b[0],
      b[1],
      b[2],
      opts.axis[0],
      opts.axis[1],
      opts.axis[2],
      hasLimits,
      opts.minDist ?? -100,
      opts.maxDist ?? 100
    );
  }

  setHingeMotor(jointId: number, speed: number, maxTorque: number): boolean {
    return this.bridge.setHingeMotor(jointId, speed, maxTorque);
  }

  setJointBreakForce(jointId: number, breakForce: number): boolean {
    return this.bridge.setJointBreakForce(jointId, breakForce);
  }

  addDistanceJoint(
    entityA: EntityId,
    entityB: EntityId,
    opts: { anchorA?: Vec3Tuple; anchorB?: Vec3Tuple; restLength: number; stiffness?: number }
  ): number {
    const a = opts.anchorA ?? [0, 0, 0];
    const b = opts.anchorB ?? [0, 0, 0];
    return this.bridge.addDistanceJoint(
      entityA,
      entityB,
      a[0],
      a[1],
      a[2],
      b[0],
      b[1],
      b[2],
      opts.restLength,
      opts.stiffness ?? 1.0
    );
  }

  addSpringJoint(
    entityA: EntityId,
    entityB: EntityId,
    opts: {
      anchorA?: Vec3Tuple;
      anchorB?: Vec3Tuple;
      restLength: number;
      stiffness: number;
      damping?: number;
    }
  ): number {
    const a = opts.anchorA ?? [0, 0, 0];
    const b = opts.anchorB ?? [0, 0, 0];
    return this.bridge.addSpringJoint(
      entityA,
      entityB,
      a[0],
      a[1],
      a[2],
      b[0],
      b[1],
      b[2],
      opts.restLength,
      opts.stiffness,
      opts.damping ?? 1.0
    );
  }

  addHingeJoint(
    entityA: EntityId,
    entityB: EntityId,
    opts: {
      anchorA?: Vec3Tuple;
      anchorB?: Vec3Tuple;
      axis: Vec3Tuple;
      minAngle?: number;
      maxAngle?: number;
    }
  ): number {
    const a = opts.anchorA ?? [0, 0, 0];
    const b = opts.anchorB ?? [0, 0, 0];
    const hasLimits = opts.minAngle !== undefined || opts.maxAngle !== undefined;
    return this.bridge.addHingeJoint(
      entityA,
      entityB,
      a[0],
      a[1],
      a[2],
      b[0],
      b[1],
      b[2],
      opts.axis[0],
      opts.axis[1],
      opts.axis[2],
      hasLimits,
      opts.minAngle ?? -Math.PI,
      opts.maxAngle ?? Math.PI
    );
  }

  removeJoint(jointId: number): boolean {
    return this.bridge.removeJoint(jointId);
  }

  onCollisionEnter(cb: (ev: CollisionEvent) => void): () => void {
    this.collisionEnterListeners.add(cb);
    return () => this.collisionEnterListeners.delete(cb);
  }

  onTriggerEnter(cb: (ev: TriggerEvent) => void): () => void {
    this.triggerEnterListeners.add(cb);
    return () => this.triggerEnterListeners.delete(cb);
  }

  onTriggerExit(cb: (ev: TriggerEvent) => void): () => void {
    this.triggerExitListeners.add(cb);
    return () => this.triggerExitListeners.delete(cb);
  }

  onPhysicsEvent(cb: (ev: RichPhysicsEvent) => void): () => void {
    this.richEventListeners.add(cb);
    return () => this.richEventListeners.delete(cb);
  }

  /** Internal event pump invoked by Engine.step after WASM simulation. */
  dispatchPhysicsEvents(): void {
    this.bridge.forEachPhysicsEvent((kind, entityA, entityB, nx, ny, nz) => {
      if (kind === 1) {
        const ev: CollisionEvent = { entityA, entityB, normal: [nx, ny, nz] };
        this.behaviors.dispatchCollision(ev);
        this.collisionEnterListeners.forEach((cb) => cb(ev));
      } else if (kind === 2) {
        const ev: TriggerEvent = { entityA, entityB };
        this.behaviors.dispatchTriggerEnter(ev);
        this.triggerEnterListeners.forEach((cb) => cb(ev));
      } else if (kind === 3) {
        const ev: TriggerEvent = { entityA, entityB };
        this.behaviors.dispatchTriggerExit(ev);
        this.triggerExitListeners.forEach((cb) => cb(ev));
      }
    });
    if (this.richEventListeners.size > 0) {
      this.bridge.forEachRichPhysicsEvent((kind, entityA, entityB, nx, ny, nz, px, py, pz, impulse) => {
        const ev: RichPhysicsEvent = {
          kind,
          entityA,
          entityB,
          normal: [nx, ny, nz],
          contactPoint: [px, py, pz],
          impulse,
        };
        this.richEventListeners.forEach((cb) => cb(ev));
      });
    }
  }

  setCollider3D(entity: EntityId, opts: Collider3DOptions): void {
    if (opts.kind === 'aabb') {
      this.bridge.setCollider3D(entity, 0, opts.halfExtents[0], opts.halfExtents[1], opts.halfExtents[2]);
    } else if (opts.kind === 'sphere') {
      this.bridge.setCollider3D(entity, 1, opts.radius, 0, 0);
    } else if (opts.kind === 'capsule') {
      this.bridge.setCollider3D(entity, 2, opts.radius, opts.halfHeight, 0);
    } else if (opts.kind === 'cylinder') {
      this.bridge.setCollider3D(entity, 3, opts.radius, opts.halfHeight, 0);
    } else if (opts.kind === 'convexHull') {
      const verts =
        opts.points instanceof Float32Array
          ? opts.points
          : Float32Array.from(opts.points.flatMap((p) => p));
      this.bridge.setConvexHullCollider(entity, verts);
    } else {
      const packed = new Float32Array(opts.parts.length * 11);
      for (let i = 0; i < opts.parts.length; i++) {
        const part = opts.parts[i];
        const o = i * 11;
        const p = part.position ?? [0, 0, 0];
        const r = part.rotation ?? [0, 0, 0, 1];
        packed[o + 1] = p[0];
        packed[o + 2] = p[1];
        packed[o + 3] = p[2];
        packed[o + 4] = r[0];
        packed[o + 5] = r[1];
        packed[o + 6] = r[2];
        packed[o + 7] = r[3];
        if (part.shape.kind === 'aabb') {
          packed[o] = 0;
          packed[o + 8] = part.shape.halfExtents[0];
          packed[o + 9] = part.shape.halfExtents[1];
          packed[o + 10] = part.shape.halfExtents[2];
        } else if (part.shape.kind === 'sphere') {
          packed[o] = 1;
          packed[o + 8] = part.shape.radius;
        } else if (part.shape.kind === 'cylinder') {
          packed[o] = 3;
          packed[o + 8] = part.shape.radius;
          packed[o + 9] = part.shape.halfHeight;
        } else {
          packed[o] = 2;
          packed[o + 8] = part.shape.radius;
          packed[o + 9] = part.shape.halfHeight;
        }
      }
      this.bridge.setCompoundCollider(entity, packed, opts.parts.length);
    }
  }

  setCollider2D(entity: EntityId, opts: Collider2DOptions): void {
    if (opts.kind === 'aabb2d') {
      this.bridge.setCollider2D(entity, 0, opts.halfExtents[0], opts.halfExtents[1]);
    } else if (opts.kind === 'capsule2d') {
      this.bridge.setCollider2D(entity, 2, opts.radius, opts.halfHeight);
    } else {
      this.bridge.setCollider2D(entity, 1, opts.radius, 0);
    }
  }

  overlapSphere(center: Vec3Tuple, radius: number, mask = 0xffffffff, includeTriggers = false): EntityId[] {
    return this.bridge.overlapShape(1, center[0], center[1], center[2], 0, 0, 0, 1, radius, 0, 0, mask, includeTriggers);
  }

  overlapBox(
    center: Vec3Tuple,
    halfExtents: Vec3Tuple,
    rotation: QuatTuple = [0, 0, 0, 1],
    mask = 0xffffffff,
    includeTriggers = false
  ): EntityId[] {
    return this.bridge.overlapShape(
      0,
      center[0],
      center[1],
      center[2],
      rotation[0],
      rotation[1],
      rotation[2],
      rotation[3],
      halfExtents[0],
      halfExtents[1],
      halfExtents[2],
      mask,
      includeTriggers
    );
  }

  overlapCapsule(
    center: Vec3Tuple,
    radius: number,
    halfHeight: number,
    rotation: QuatTuple = [0, 0, 0, 1],
    mask = 0xffffffff,
    includeTriggers = false
  ): EntityId[] {
    return this.bridge.overlapShape(
      2,
      center[0],
      center[1],
      center[2],
      rotation[0],
      rotation[1],
      rotation[2],
      rotation[3],
      radius,
      halfHeight,
      0,
      mask,
      includeTriggers
    );
  }

  sweepBox(
    origin: Vec3Tuple,
    halfExtents: Vec3Tuple,
    dir: Vec3Tuple,
    maxDist = 50,
    rotation: QuatTuple = [0, 0, 0, 1],
    mask = 0xffffffff,
    ignoreEntity = 0
  ) {
    return this.bridge.sweepShape(
      0,
      origin[0],
      origin[1],
      origin[2],
      rotation[0],
      rotation[1],
      rotation[2],
      rotation[3],
      halfExtents[0],
      halfExtents[1],
      halfExtents[2],
      dir[0],
      dir[1],
      dir[2],
      maxDist,
      mask,
      ignoreEntity
    );
  }

  sweepCapsule(
    origin: Vec3Tuple,
    radius: number,
    halfHeight: number,
    dir: Vec3Tuple,
    maxDist = 50,
    rotation: QuatTuple = [0, 0, 0, 1],
    mask = 0xffffffff,
    ignoreEntity = 0
  ) {
    return this.bridge.sweepShape(
      2,
      origin[0],
      origin[1],
      origin[2],
      rotation[0],
      rotation[1],
      rotation[2],
      rotation[3],
      radius,
      halfHeight,
      0,
      dir[0],
      dir[1],
      dir[2],
      maxDist,
      mask,
      ignoreEntity
    );
  }

  getPhysicsDebugLines(): Float32Array {
    return this.bridge.getPhysicsDebugLinesView();
  }

  addTileGrid2D(
    origin: [number, number],
    tileSize: number,
    width: number,
    height: number,
    solid: Uint8Array
  ): void {
    this.bridge.addTileGrid2D(origin[0], origin[1], tileSize, width, height, solid);
  }

  addStaticMeshTriangles(entity: EntityId, flatTriangles: Float32Array): void {
    this.bridge.addStaticMeshTriangles(entity, flatTriangles);
  }

  setSprite2D(entity: EntityId, opts: Sprite2DOptions = {}): void {
    const size = opts.size ?? [1, 1];
    const uvMin = opts.uvMin ?? [0, 0];
    const uvMax = opts.uvMax ?? [1, 1];
    const c = opts.color ?? [1, 1, 1, 1];
    this.bridge.setSprite2D(
      entity,
      size[0],
      size[1],
      uvMin[0],
      uvMin[1],
      uvMax[0],
      uvMax[1],
      c[0],
      c[1],
      c[2],
      c[3],
      opts.textureId ?? 0,
      opts.layer ?? 0
    );
  }

  setMesh3D(entity: EntityId, opts: Mesh3DOptions): void {
    this.bridge.setMesh3D(
      entity,
      opts.meshId,
      opts.materialId,
      opts.transparent ? 1 : 0,
      opts.boundsRadius ?? 1.5
    );
  }

  playAnimation(
    entity: EntityId,
    skeletonId: number,
    clipId: number,
    opts: { speed?: number; loop?: boolean; fadeSec?: number } = {}
  ): void {
    this.bridge.playAnimation(
      entity,
      skeletonId,
      clipId,
      opts.speed ?? 1.0,
      opts.loop ?? true,
      opts.fadeSec ?? 0.2
    );
  }

  raycast3D(origin: Vec3Tuple, dir: Vec3Tuple, maxDist = 100, mask = 0xffffffff) {
    return this.bridge.raycast3D(
      origin[0],
      origin[1],
      origin[2],
      dir[0],
      dir[1],
      dir[2],
      maxDist,
      mask,
      0
    );
  }

  sphereCast3D(
    origin: Vec3Tuple,
    radius: number,
    dir: Vec3Tuple,
    maxDist = 100,
    mask = 0xffffffff
  ) {
    return this.bridge.raycast3D(
      origin[0],
      origin[1],
      origin[2],
      dir[0],
      dir[1],
      dir[2],
      maxDist,
      mask,
      radius
    );
  }

  setTerrainHeightmap(
    originX: number,
    originZ: number,
    cellSize: number,
    width: number,
    height: number,
    heights: Float32Array
  ): EntityId {
    const entity = this.createEntity();
    this.setTransform(entity, { position: [0, 0, 0], immediate: true });
    this.bridge.setTerrainHeightmap(entity, originX, originZ, cellSize, width, height, heights);
    return entity;
  }

  sampleTerrainHeight(x: number, z: number) {
    return this.bridge.sampleTerrainHeight(x, z);
  }

  buildNavGrid3D(opts: {
    originX: number;
    originZ: number;
    cellSize?: number;
    width: number;
    height: number;
    minY?: number;
    maxY?: number;
    agentRadius?: number;
  }): void {
    this.bridge.buildNavGrid3D(
      opts.originX,
      opts.originZ,
      opts.cellSize ?? 1.0,
      opts.width,
      opts.height,
      opts.minY ?? 0.1,
      opts.maxY ?? 5.0,
      opts.agentRadius ?? 0.4
    );
  }

  buildNavGrid2D(): void {
    this.bridge.buildNavGrid2D();
  }

  setNavBlocked(cx: number, cz: number, blocked: boolean): void {
    this.bridge.setNavBlocked(cx, cz, blocked);
  }

  findNavPath(
    start: [number, number],
    goal: [number, number],
    smooth = true
  ): Array<[number, number]> {
    return this.bridge.findNavPath(start[0], start[1], goal[0], goal[1], smooth);
  }

  getBoneWorldTransform(entity: EntityId, jointIndex: number) {
    return this.bridge.getBoneWorldTransform(entity, jointIndex);
  }

  computeCameraMatrices(aspect: number): {
    view: Float32Array;
    proj: Float32Array;
    viewProj: Float32Array;
  } {
    let sx = 0;
    let sy = 0;
    if (this.shakeTime > 0 && this.shakeDuration > 0) {
      const decay = this.shakeTime / this.shakeDuration;
      const amp = this.shakeIntensity * decay;
      sx = (Math.random() * 2 - 1) * amp;
      sy = (Math.random() * 2 - 1) * amp;
    }

    if (this.camera.mode === '2d') {
      const halfH = (this.camera.orthoHeight / Math.max(this.camera.zoom, 0.1)) * 0.5;
      const halfW = halfH * Math.max(aspect, 0.001);
      const cx = (this.camera.pixelSnap ? Math.round(this.camera.position[0] * 32) / 32 : this.camera.position[0]) + sx;
      const cy = (this.camera.pixelSnap ? Math.round(this.camera.position[1] * 32) / 32 : this.camera.position[1]) + sy;
      mat4Ortho(cx - halfW, cx + halfW, cy - halfH, cy + halfH, -50, 50, this.projMat);
      this.viewMat.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      this.vpMat.set(this.projMat);
    } else {
      const pos: Vec3Tuple = [this.camera.position[0] + sx, this.camera.position[1] + sy, this.camera.position[2]];
      const tgt: Vec3Tuple = [this.camera.target[0] + sx, this.camera.target[1] + sy, this.camera.target[2]];
      mat4Perspective((this.camera.fovDeg * Math.PI) / 180, aspect, this.camera.near, this.camera.far, this.projMat);
      mat4LookAt(pos, tgt, this.camera.up, this.viewMat);
      mat4Multiply(this.projMat, this.viewMat, this.vpMat);
    }
    return { view: this.viewMat, proj: this.projMat, viewProj: this.vpMat };
  }

  clear(): void {
    this.behaviors.clear();
    this.collisionEnterListeners.clear();
    this.triggerEnterListeners.clear();
    this.triggerExitListeners.clear();
    this.pointLights.length = 0;
    this.spotLights.length = 0;
    this.lights2d.ambientColor = [1, 1, 1];
    this.lights2d.lights.length = 0;
    this.bridge.clear();
  }
}
