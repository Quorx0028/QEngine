import { mat4LookAt, mat4Multiply, mat4Ortho, mat4Perspective, Vec3Tuple, QuatTuple } from './math/Mat4';
import { WasmBridge } from './wasm/WasmBridge';

export type EntityId = number;

export interface TransformOptions {
  position?: Vec3Tuple;
  rotation?: QuatTuple;
  scale?: Vec3Tuple;
  immediate?: boolean;
}

export interface RigidBodyOptions {
  dynamic?: boolean;
  gravityScale?: number;
  restitution?: number;
  friction?: number;
  linearDamping?: number;
  angularDamping?: number;
  mass?: number;
  lockRotation?: boolean;
}

export type Collider3DOptions =
  | { kind: 'aabb'; halfExtents: Vec3Tuple }
  | { kind: 'sphere'; radius: number }
  | { kind: 'capsule'; radius: number; halfHeight: number };

export type Collider2DOptions =
  | { kind: 'aabb2d'; halfExtents: [number, number] }
  | { kind: 'circle2d'; radius: number };

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
  shadowsEnabled = true;
  skyTopColor: Vec3Tuple = [0.08, 0.16, 0.32];
  skyHorizonColor: Vec3Tuple = [0.22, 0.32, 0.48];
  fogColor: Vec3Tuple = [0.16, 0.22, 0.34];
  fogDensity = 0.008;

  private shakeTime = 0;
  private shakeDuration = 0;
  private shakeIntensity = 0;

  constructor(bridge: WasmBridge) {
    this.bridge = bridge;
  }

  createEntity(): EntityId {
    return this.bridge.spawn();
  }

  destroyEntity(entity: EntityId): boolean {
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

  setCollider3D(entity: EntityId, opts: Collider3DOptions): void {
    if (opts.kind === 'aabb') {
      this.bridge.setCollider3D(entity, 0, opts.halfExtents[0], opts.halfExtents[1], opts.halfExtents[2]);
    } else if (opts.kind === 'sphere') {
      this.bridge.setCollider3D(entity, 1, opts.radius, 0, 0);
    } else {
      this.bridge.setCollider3D(entity, 2, opts.radius, opts.halfHeight, 0);
    }
  }

  setCollider2D(entity: EntityId, opts: Collider2DOptions): void {
    if (opts.kind === 'aabb2d') {
      this.bridge.setCollider2D(entity, 0, opts.halfExtents[0], opts.halfExtents[1]);
    } else {
      this.bridge.setCollider2D(entity, 1, opts.radius, 0);
    }
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

  raycast3D(origin: Vec3Tuple, dir: Vec3Tuple, maxDist = 100) {
    return this.bridge.raycast3D(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], maxDist);
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
    this.bridge.clear();
  }
}
