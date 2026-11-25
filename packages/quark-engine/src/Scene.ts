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

export type WeatherType = 'clear' | 'snow' | 'rain' | 'downpour';
export type CloudStyle = 'realistic' | 'anime' | 'dramatic' | 'clear';

export interface WeatherState {
  type: WeatherType;
  cloudStyle: CloudStyle;
  rainIntensity: number;
  wetness: number;
  cloudCoverage: number;
  cloudSpeed: number;
}

export interface DryZoneBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  ceilY: number;
}

export type VfxPresetName =
  | 'fire'
  | 'smoke'
  | 'sparks'
  | 'splash'
  | 'magic'
  | 'confetti'
  | 'bubbles'
  | 'dust'
  | 'rain'
  | 'downpour'
  | 'snow';

export interface ParticleSpawnOptions {
  position: Vec3Tuple;
  velocity: Vec3Tuple;
  sizeStart?: number;
  sizeEnd?: number;
  colorStart?: [number, number, number, number];
  colorEnd?: [number, number, number, number];
  lifetime?: number;
  gravity?: number;
  drag?: number;
  bounce?: number;
  floorY?: number;
  additive?: boolean;
  stretch?: number;
}

export class Scene {
  private readonly bridge: WasmBridge;
  private readonly projMat = new Float32Array(16);
  private readonly viewMat = new Float32Array(16);
  private readonly vpMat = new Float32Array(16);
  private readonly queryProjMat = new Float32Array(16);
  private readonly queryViewMat = new Float32Array(16);
  private readonly queryVpMat = new Float32Array(16);

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
  readonly weather: WeatherState = {
    type: 'clear',
    cloudStyle: 'realistic',
    rainIntensity: 0,
    wetness: 0,
    cloudCoverage: 0.48,
    cloudSpeed: 1.0,
  };

  private shakeTime = 0;
  private shakeDuration = 0;
  private shakeIntensity = 0;

  private readonly collisionEnterListeners = new Set<(ev: CollisionEvent) => void>();
  private readonly triggerEnterListeners = new Set<(ev: TriggerEvent) => void>();
  private readonly triggerExitListeners = new Set<(ev: TriggerEvent) => void>();
  private readonly richEventListeners = new Set<(ev: RichPhysicsEvent) => void>();
  private readonly waterZoneBoxes: Array<{ center: Vec3Tuple; halfExtents: Vec3Tuple }> = [];
  private readonly dryZoneBoxes: DryZoneBox[] = [];
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

  getTransform(entity: EntityId): { position: Vec3Tuple; rotation: QuatTuple; scale: Vec3Tuple } {
    return this.bridge.getTransform(entity);
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

  setWeather(type: WeatherType): void {
    this.weather.type = type;
    if (type === 'rain') {
      this.weather.rainIntensity = Math.max(this.weather.rainIntensity, 0.45);
      this.weather.wetness = Math.max(this.weather.wetness, 0.42);
    } else if (type === 'downpour') {
      this.weather.rainIntensity = Math.max(this.weather.rainIntensity, 0.95);
      this.weather.wetness = Math.max(this.weather.wetness, 0.78);
    }
  }

  setCloudStyle(style: CloudStyle): void {
    this.weather.cloudStyle = style;
  }

  /** Marks an indoor covered volume (e.g. roofed room) so shader puddles & rain ripples stay outside. */
  addDryZone(opts: { center: Vec3Tuple; size: Vec3Tuple }): void {
    const [cx, cy, cz] = opts.center;
    const [w, h, d] = opts.size;
    this.dryZoneBoxes.push({
      minX: cx - w * 0.5,
      maxX: cx + w * 0.5,
      minZ: cz - d * 0.5,
      maxZ: cz + d * 0.5,
      ceilY: cy + h * 0.5 - 0.12,
    });
  }

  getDryZones(): readonly DryZoneBox[] {
    return this.dryZoneBoxes;
  }

  advanceEffects(dt: number): void {
    if (this.shakeTime > 0) {
      this.shakeTime = Math.max(0, this.shakeTime - dt);
    }
    const w = this.weather;
    const targetRain = w.type === 'downpour' ? 1.35 : w.type === 'rain' ? 0.72 : 0.0;
    const targetWet = w.type === 'downpour' ? 1.0 : w.type === 'rain' ? 0.85 : 0.0;
    const targetClouds =
      w.type === 'downpour' ? 0.94 : w.type === 'rain' ? 0.8 : w.type === 'snow' ? 0.68 : 0.48;
    const targetSpeed = w.type === 'downpour' ? 2.4 : w.type === 'rain' ? 1.65 : 1.0;

    const rate = Math.min(1, dt * 1.4);
    w.rainIntensity += (targetRain - w.rainIntensity) * rate;
    const wetRate = targetWet > w.wetness ? Math.min(1, dt * 0.55) : Math.min(1, dt * 0.16);
    w.wetness += (targetWet - w.wetness) * wetRate;
    w.cloudCoverage += (targetClouds - w.cloudCoverage) * rate;
    w.cloudSpeed += (targetSpeed - w.cloudSpeed) * rate;
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
    this.waterZoneBoxes.push({
      center: [...opts.center],
      halfExtents: [...opts.halfExtents],
    });
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
    this.waterZoneBoxes.length = 0;
    this.bridge.clearWaterZones();
  }

  getUnderwaterDepth(point: Vec3Tuple): number {
    let maxDepth = 0;
    for (let i = 0; i < this.waterZoneBoxes.length; i++) {
      const z = this.waterZoneBoxes[i];
      if (
        Math.abs(point[0] - z.center[0]) <= z.halfExtents[0] &&
        Math.abs(point[2] - z.center[2]) <= z.halfExtents[2]
      ) {
        const top = z.center[1] + z.halfExtents[1];
        const bot = z.center[1] - z.halfExtents[1];
        if (point[1] >= bot && point[1] <= top) {
          maxDepth = Math.max(maxDepth, top - point[1]);
        }
      }
    }
    return maxDepth;
  }

  isPointUnderwater(point: Vec3Tuple): boolean {
    return this.getUnderwaterDepth(point) > 0;
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

  /** Projects a 3D/2D world position to screen pixel coordinates `[0..width, 0..height]`. */
  worldToScreen(
    point: Vec3Tuple,
    viewportWidth: number,
    viewportHeight: number
  ): { x: number; y: number; depth: number; visible: boolean } {
    const w = Math.max(viewportWidth, 1);
    const h = Math.max(viewportHeight, 1);
    const aspect = w / h;
    if (this.camera.mode === '2d') {
      const halfH = (this.camera.orthoHeight / Math.max(this.camera.zoom, 0.1)) * 0.5;
      const halfW = halfH * Math.max(aspect, 0.001);
      mat4Ortho(
        this.camera.position[0] - halfW,
        this.camera.position[0] + halfW,
        this.camera.position[1] - halfH,
        this.camera.position[1] + halfH,
        -50,
        50,
        this.queryVpMat
      );
    } else {
      mat4Perspective((this.camera.fovDeg * Math.PI) / 180, aspect, this.camera.near, this.camera.far, this.queryProjMat);
      mat4LookAt(this.camera.position, this.camera.target, this.camera.up, this.queryViewMat);
      mat4Multiply(this.queryProjMat, this.queryViewMat, this.queryVpMat);
    }
    const m = this.queryVpMat;
    const x = point[0], y = point[1], z = point[2];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0.0001) {
      return { x: -9999, y: -9999, depth: cw, visible: false };
    }
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    const ndcZ = cz / cw;
    const sx = (ndcX * 0.5 + 0.5) * w;
    const sy = (0.5 - ndcY * 0.5) * h;
    const visible = ndcX >= -1.08 && ndcX <= 1.08 && ndcY >= -1.08 && ndcY <= 1.08 && ndcZ >= -1 && ndcZ <= 1.01;
    return { x: sx, y: sy, depth: cw, visible };
  }

  /** Converts pointer CSS coordinates and viewport rect into a normalized world-space ray. */
  screenToRay(
    clientX: number,
    clientY: number,
    rect: { left: number; top: number; width: number; height: number }
  ): { origin: Vec3Tuple; dir: Vec3Tuple } {
    const rw = Math.max(rect.width, 1);
    const rh = Math.max(rect.height, 1);
    const nx = ((clientX - rect.left) / rw) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rh) * 2;
    const aspect = rw / rh;

    if (this.camera.mode === '2d') {
      const halfH = (this.camera.orthoHeight / Math.max(this.camera.zoom, 0.1)) * 0.5;
      const halfW = halfH * aspect;
      return {
        origin: [this.camera.position[0] + nx * halfW, this.camera.position[1] + ny * halfH, 20],
        dir: [0, 0, -1],
      };
    }

    const pos = this.camera.position;
    const tgt = this.camera.target;
    const up = this.camera.up;
    let fx = tgt[0] - pos[0], fy = tgt[1] - pos[1], fz = tgt[2] - pos[2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;

    let rx = fy * up[2] - fz * up[1];
    let ry = fz * up[0] - fx * up[2];
    let rz = fx * up[1] - fy * up[0];
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;

    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    const tanHalf = Math.tan(((this.camera.fovDeg * Math.PI) / 180) * 0.5);
    let dx = fx + rx * (nx * aspect * tanHalf) + ux * (ny * tanHalf);
    let dy = fy + ry * (nx * aspect * tanHalf) + uy * (ny * tanHalf);
    let dz = fz + rz * (nx * aspect * tanHalf) + uz * (ny * tanHalf);
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;

    return { origin: [pos[0], pos[1], pos[2]], dir: [dx, dy, dz] };
  }

  getActiveParticleCount(): number {
    return this.bridge.getParticlesCount();
  }

  emitParticle(opts: ParticleSpawnOptions): void {
    const c0 = opts.colorStart ?? [1, 1, 1, 1];
    const c1 = opts.colorEnd ?? [c0[0], c0[1], c0[2], 0];
    this.bridge.spawnParticle(
      opts.position[0],
      opts.position[1],
      opts.position[2],
      opts.velocity[0],
      opts.velocity[1],
      opts.velocity[2],
      opts.sizeStart ?? 0.2,
      opts.sizeEnd ?? 0.05,
      c0[0],
      c0[1],
      c0[2],
      c0[3],
      c1[0],
      c1[1],
      c1[2],
      c1[3],
      opts.lifetime ?? 0.8,
      opts.gravity ?? -9.8,
      opts.drag ?? 0.2,
      opts.bounce ?? 0,
      opts.floorY ?? 0,
      opts.additive ?? false,
      opts.stretch ?? 0
    );
  }

  emitVfx(preset: VfxPresetName, origin: Vec3Tuple, count = 24, floorY = 0.02): void {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.random();
      if (preset === 'fire') {
        this.emitParticle({
          position: [origin[0] + Math.cos(ang) * rad * 0.25, origin[1] + Math.random() * 0.15, origin[2] + Math.sin(ang) * rad * 0.25],
          velocity: [Math.cos(ang) * 0.45, 1.4 + Math.random() * 1.9, Math.sin(ang) * 0.45],
          sizeStart: 0.28 + Math.random() * 0.14,
          sizeEnd: 0.04,
          colorStart: [1.0, 0.72, 0.22, 0.92],
          colorEnd: [0.95, 0.15, 0.02, 0.0],
          lifetime: 0.45 + Math.random() * 0.35,
          gravity: 1.2,
          drag: 0.6,
          additive: true,
        });
      } else if (preset === 'smoke') {
        this.emitParticle({
          position: [origin[0] + Math.cos(ang) * rad * 0.28, origin[1], origin[2] + Math.sin(ang) * rad * 0.28],
          velocity: [Math.cos(ang) * 0.35, 1.0 + Math.random() * 1.1, Math.sin(ang) * 0.35],
          sizeStart: 0.24,
          sizeEnd: 0.85,
          colorStart: [0.32, 0.34, 0.38, 0.45],
          colorEnd: [0.22, 0.24, 0.28, 0.0],
          lifetime: 1.1 + Math.random() * 0.6,
          gravity: 0.35,
          drag: 0.9,
          additive: false,
        });
      } else if (preset === 'sparks') {
        const spd = 2.8 + Math.random() * 5.2;
        this.emitParticle({
          position: [origin[0], origin[1], origin[2]],
          velocity: [Math.cos(ang) * spd, 2.2 + Math.random() * 4.5, Math.sin(ang) * spd],
          sizeStart: 0.13,
          sizeEnd: 0.03,
          colorStart: [1.0, 0.88, 0.42, 1.0],
          colorEnd: [1.0, 0.32, 0.05, 0.0],
          lifetime: 0.55 + Math.random() * 0.45,
          gravity: -18,
          drag: 0.25,
          bounce: 0.62,
          floorY,
          additive: true,
          stretch: 0.95,
        });
      } else if (preset === 'splash') {
        const spd = 1.6 + Math.random() * 3.8;
        this.emitParticle({
          position: [origin[0] + Math.cos(ang) * rad * 0.4, origin[1], origin[2] + Math.sin(ang) * rad * 0.4],
          velocity: [Math.cos(ang) * spd, 2.8 + Math.random() * 4.2, Math.sin(ang) * spd],
          sizeStart: 0.14,
          sizeEnd: 0.04,
          colorStart: [0.85, 0.96, 1.0, 0.95],
          colorEnd: [0.45, 0.85, 1.0, 0.0],
          lifetime: 0.55 + Math.random() * 0.35,
          gravity: -16,
          drag: 0.4,
          bounce: 0.25,
          floorY,
          additive: false,
          stretch: 0.8,
        });
      } else if (preset === 'magic') {
        this.emitParticle({
          position: [origin[0] + Math.cos(ang) * rad * 0.6, origin[1] + Math.random() * 0.4, origin[2] + Math.sin(ang) * rad * 0.6],
          velocity: [Math.cos(ang) * 1.1, 1.1 + Math.random() * 1.6, Math.sin(ang) * 1.1],
          sizeStart: 0.18,
          sizeEnd: 0.02,
          colorStart: [0.35, 0.95, 1.0, 1.0],
          colorEnd: [0.78, 0.35, 1.0, 0.0],
          lifetime: 0.75 + Math.random() * 0.45,
          gravity: -0.6,
          drag: 0.8,
          additive: true,
        });
      } else if (preset === 'bubbles') {
        this.emitParticle({
          position: [origin[0] + Math.cos(ang) * rad * 1.6, origin[1] + Math.random() * 0.4, origin[2] + Math.sin(ang) * rad * 1.6],
          velocity: [(Math.random() - 0.5) * 0.35, 0.65 + Math.random() * 0.9, (Math.random() - 0.5) * 0.35],
          sizeStart: 0.07 + Math.random() * 0.06,
          sizeEnd: 0.1,
          colorStart: [0.75, 0.95, 1.0, 0.75],
          colorEnd: [0.9, 1.0, 1.0, 0.0],
          lifetime: 0.9 + Math.random() * 0.6,
          gravity: 0.4,
          drag: 1.2,
          additive: false,
        });
      } else if (preset === 'dust') {
        this.emitParticle({
          position: [
            origin[0] + (Math.random() - 0.5) * 4.6,
            Math.max(floorY + 0.3, origin[1] + (Math.random() - 0.5) * 2.4),
            origin[2] + (Math.random() - 0.5) * 4.6,
          ],
          velocity: [(Math.random() - 0.5) * 0.22, 0.04 + Math.random() * 0.12, (Math.random() - 0.5) * 0.22],
          sizeStart: 0.045 + Math.random() * 0.04,
          sizeEnd: 0.025,
          colorStart: [1.0, 0.9, 0.58, 0.78],
          colorEnd: [1.0, 0.78, 0.38, 0.0],
          lifetime: 2.2 + Math.random() * 1.6,
          gravity: 0.02,
          drag: 1.5,
          additive: true,
        });
      } else if (preset === 'rain' || preset === 'downpour') {
        const heavy = preset === 'downpour';
        const span = heavy ? 32 : 28;
        const px = origin[0] + (Math.random() - 0.5) * span;
        const pz = origin[2] + (Math.random() - 0.5) * span;
        const roofHit = this.raycast3D([px, 28, pz], [0, -1, 0], 30);
        const surfaceY = roofHit ? Math.max(floorY, roofHit.point[1]) : floorY;
        const minSpawnY = surfaceY + 0.45;
        const maxSpawnY = Math.max(minSpawnY + 2.5, origin[1] + 3.0);
        const py = minSpawnY + Math.random() * (maxSpawnY - minSpawnY);
        const speedY = heavy ? -24 - Math.random() * 7 : -18 - Math.random() * 5;
        this.emitParticle({
          position: [px, py, pz],
          velocity: [heavy ? -3.4 : -1.5, speedY, heavy ? -2.2 : -1.0],
          sizeStart: heavy ? 0.11 : 0.085,
          sizeEnd: 0.06,
          colorStart: heavy ? [0.78, 0.9, 1.0, 0.78] : [0.74, 0.88, 1.0, 0.65],
          colorEnd: [0.65, 0.82, 1.0, 0.0],
          lifetime: heavy ? 0.68 : 0.72,
          gravity: -28,
          drag: 0.04,
          bounce: 0.28,
          floorY: surfaceY + 0.02,
          additive: false,
          stretch: heavy ? 2.8 : 2.2,
        });
        if (Math.random() < (heavy ? 0.32 : 0.14)) {
          this.emitParticle({
            position: [px, surfaceY + 0.05, pz],
            velocity: [(Math.random() - 0.5) * 1.6, 1.4 + Math.random() * 1.4, (Math.random() - 0.5) * 1.6],
            sizeStart: 0.075,
            sizeEnd: 0.02,
            colorStart: [0.85, 0.94, 1.0, 0.72],
            colorEnd: [0.75, 0.9, 1.0, 0.0],
            lifetime: 0.24,
            gravity: -16,
            floorY: surfaceY + 0.02,
            additive: false,
          });
        }
      } else if (preset === 'snow') {
        const px = origin[0] + (Math.random() - 0.5) * 30;
        const pz = origin[2] + (Math.random() - 0.5) * 30;
        const roofHit = this.raycast3D([px, 28, pz], [0, -1, 0], 30);
        const surfaceY = roofHit ? Math.max(floorY, roofHit.point[1]) : floorY;
        const minSpawnY = surfaceY + 0.35;
        const maxSpawnY = Math.max(minSpawnY + 2.0, origin[1] + 2.5);
        const py = minSpawnY + Math.random() * (maxSpawnY - minSpawnY);
        this.emitParticle({
          position: [px, py, pz],
          velocity: [(Math.random() - 0.5) * 1.5, -2.0 - Math.random() * 1.2, (Math.random() - 0.5) * 1.5],
          sizeStart: 0.11 + Math.random() * 0.08,
          sizeEnd: 0.07,
          colorStart: [0.96, 0.98, 1.0, 0.9],
          colorEnd: [0.95, 0.98, 1.0, 0.0],
          lifetime: 5.8 + Math.random() * 2.2,
          gravity: -0.25,
          drag: 0.12,
          bounce: 0.04,
          floorY: surfaceY + 0.02,
          additive: false,
        });
      } else {
        // confetti (2D & 3D festive burst)
        const palette: Array<[number, number, number, number]> = [
          [1.0, 0.25, 0.45, 1],
          [0.25, 0.9, 0.65, 1],
          [0.3, 0.75, 1.0, 1],
          [1.0, 0.82, 0.2, 1],
        ];
        const col = palette[i % palette.length];
        this.emitParticle({
          position: [origin[0], origin[1], origin[2]],
          velocity: [Math.cos(ang) * (2.0 + Math.random() * 4.0), 3.0 + Math.random() * 4.5, Math.sin(ang) * (2.0 + Math.random() * 4.0)],
          sizeStart: 0.16,
          sizeEnd: 0.12,
          colorStart: col,
          colorEnd: [col[0], col[1], col[2], 0],
          lifetime: 1.4 + Math.random() * 0.6,
          gravity: -9.5,
          drag: 1.8,
          bounce: 0.3,
          floorY,
          additive: false,
        });
      }
    }
  }

  createCloth(opts: {
    origin: Vec3Tuple;
    rightStep: Vec3Tuple;
    downStep: Vec3Tuple;
    cols: number;
    rows: number;
    pinTop?: boolean;
    pinLeft?: boolean;
  }): number {
    return this.bridge.createCloth(
      opts.origin[0],
      opts.origin[1],
      opts.origin[2],
      opts.rightStep[0],
      opts.rightStep[1],
      opts.rightStep[2],
      opts.downStep[0],
      opts.downStep[1],
      opts.downStep[2],
      opts.cols,
      opts.rows,
      opts.pinTop ?? true,
      opts.pinLeft ?? false
    );
  }

  setClothWind(clothId: number, wind: Vec3Tuple): void {
    this.bridge.setClothWind(clothId, wind[0], wind[1], wind[2]);
  }

  pushClothSphere(clothId: number, center: Vec3Tuple, radius: number): void {
    this.bridge.pushClothSphere(clothId, center[0], center[1], center[2], radius);
  }

  getClothVerticesView(clothId: number): Float32Array {
    return this.bridge.getClothVerticesView(clothId);
  }

  getClothIndicesCopy(clothId: number): Uint32Array {
    return this.bridge.getClothIndicesCopy(clothId);
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
    this.waterZoneBoxes.length = 0;
    this.dryZoneBoxes.length = 0;
    this.weather.type = 'clear';
    this.weather.rainIntensity = 0;
    this.weather.wetness = 0;
    this.weather.cloudCoverage = 0.48;
    this.weather.cloudSpeed = 1.0;
    this.bridge.clear();
  }
}
