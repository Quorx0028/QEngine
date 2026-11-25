import type { AssetManager, LoadedMeshHandle } from '../assets/AssetManager';
import { quatFromEuler, type QuatTuple, type Vec3Tuple } from '../math/Mat4';
import type { MaterialDesc } from '../render/IRenderBackend';
import {
  createBoxGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createPlaneGeometry,
  createRampGeometry,
  createSphereGeometry,
  createWaterVolumeGeometry,
  extractColliderTriangles,
} from '../render/Primitives';
import type { ShaderPresetName } from '../render/ShaderPresets';
import { PHYSICS_MATERIAL_PRESETS, type EntityId, type Scene } from '../Scene';
import { material, MaterialBuilder, parseColor, type ColorInput } from './MaterialBuilder';

export type RoomSide = 'north' | 'south' | 'east' | 'west';

export type MaterialInput =
  | number
  | MaterialDesc
  | MaterialBuilder
  | ShaderPresetName
  | {
      preset?: ShaderPresetName;
      color?: ColorInput;
      glow?: ColorInput;
      metallic?: number;
      roughness?: number;
      doubleSided?: boolean;
      transparent?: boolean;
      grid?: number;
    };

export interface BoxSpawnOptions {
  pos: Vec3Tuple;
  size?: Vec3Tuple;
  euler?: Vec3Tuple;
  rotation?: QuatTuple;
  material?: MaterialInput;
  dynamic?: boolean;
  mass?: number;
  physics?: keyof typeof PHYSICS_MATERIAL_PRESETS;
  collider?: boolean;
  transparent?: boolean;
}

export interface SphereSpawnOptions {
  pos: Vec3Tuple;
  radius?: number;
  material?: MaterialInput;
  dynamic?: boolean;
  mass?: number;
  physics?: keyof typeof PHYSICS_MATERIAL_PRESETS;
  collider?: boolean;
}

export interface CylinderSpawnOptions {
  pos: Vec3Tuple;
  radius?: number;
  height?: number;
  euler?: Vec3Tuple;
  material?: MaterialInput;
  dynamic?: boolean;
  mass?: number;
  collider?: boolean;
}

export interface RampSpawnOptions {
  pos: Vec3Tuple;
  size?: Vec3Tuple;
  yaw?: number;
  material?: MaterialInput;
}

export interface TriggerSpawnOptions {
  pos: Vec3Tuple;
  size: Vec3Tuple;
  material?: MaterialInput;
  onEnter?: (other: EntityId) => void;
  onExit?: (other: EntityId) => void;
}

export interface BreakableOptions {
  pos: Vec3Tuple;
  size?: Vec3Tuple;
  material?: MaterialInput;
  shardCount?: number;
  shardMaterial?: MaterialInput;
}

export interface BreakableHandle {
  entity: EntityId;
  shatter: (hitPoint?: Vec3Tuple) => boolean;
}

export interface DoorConfig {
  side: RoomSide;
  width?: number;
  height?: number;
  interactive?: boolean;
}

export interface WindowConfig {
  side: RoomSide;
  width?: number;
  sillHeight?: number;
  height?: number;
}

export interface RoomOptions {
  /** `[cx, floorY, cz]` — bottom floor Y of the room (walls rise from `floorY` to `floorY + size[1]`). */
  center: Vec3Tuple;
  size: Vec3Tuple;
  wallThickness?: number;
  doors?: Array<RoomSide | DoorConfig>;
  windows?: Array<RoomSide | WindowConfig>;
  roof?: boolean;
  floor?: boolean;
  wallMaterial?: MaterialInput;
  floorMaterial?: MaterialInput;
  doorMaterial?: MaterialInput;
  glassMaterial?: MaterialInput;
  light?:
    | boolean
    | {
        color?: ColorInput;
        intensity?: number;
        radius?: number;
        godRay?: boolean;
      };
}

export interface DoorHandle {
  entity: EntityId;
  side: RoomSide;
  pivotPos: Vec3Tuple;
  open: boolean;
  toggle: () => boolean;
  setOpen: (open: boolean) => void;
}

export interface RoomHandle {
  entities: EntityId[];
  doors: DoorHandle[];
  setLight: (on: boolean) => void;
  toggleLight: () => boolean;
}

export interface StairsOptions {
  /** Bottom start point `[x, y, z]`. */
  from: Vec3Tuple;
  /** Top end point `[x, y, z]`. */
  to: Vec3Tuple;
  width?: number;
  steps?: number;
  material?: MaterialInput;
}

export interface PoolOptions {
  /** `[cx, bottomY, cz]` — bottom floor Y of the pool basin. */
  center: Vec3Tuple;
  size: [number, number, number];
  wallThickness?: number;
  glassSides?: RoomSide[];
  waterPreset?: 'realistic' | 'anime' | 'cyber' | MaterialInput;
  wallMaterial?: MaterialInput;
  floorMaterial?: MaterialInput;
  density?: number;
  flow?: Vec3Tuple;
  splashOnEnter?: boolean;
}

export interface PoolHandle {
  entities: EntityId[];
  waterSurface: EntityId;
  waterSensor: EntityId;
  waterMatId: number;
}

export interface GridBuildOptions {
  /** World origin `[x, floorY, z]` of the top-left cell (cell `[0, 0]`). */
  origin?: Vec3Tuple;
  /** Width & depth of each grid cell in meters (default `2.4`). */
  cellSize?: number;
  /** Wall height in meters (default `3.2`). */
  wallHeight?: number;
  floor?: boolean;
  roof?: boolean;
  wallMaterial?: MaterialInput;
  floorMaterial?: MaterialInput;
  doorMaterial?: MaterialInput;
  waterPreset?: 'realistic' | 'anime' | 'cyber';
  onPlayerSpawn?: (pos: Vec3Tuple) => void;
}

export interface GridLevelHandle {
  entities: EntityId[];
  spawnPoint: Vec3Tuple;
  doors: DoorHandle[];
  breakables: BreakableHandle[];
  campfires: Vec3Tuple[];
  waterSensors: EntityId[];
}

interface InternalDoorState {
  handle: DoorHandle;
  width: number;
  height: number;
  thickness: number;
  alongX: boolean;
  angle: number;
  target: number;
}

/**
 * High-level, AI-friendly 3D scene & architecture builder built on top of Scene, AssetManager, and Rust/WASM physics.
 * Automatically shares base meshes & cached materials so repeated blocks stay hardware-instanced.
 */
export class WorldBuilder {
  private readonly scene: Scene;
  private readonly assets: AssetManager;
  private readonly defaultTag: string;

  private readonly meshCache = new Map<string, LoadedMeshHandle>();
  private readonly matCache = new Map<string, number>();
  private readonly doors: InternalDoorState[] = [];
  private readonly breakables = new Map<EntityId, () => boolean>();
  private readonly ignoreRayEntities = new Set<EntityId>();
  private meshCounter = 0;
  private matCounter = 0;

  constructor(scene: Scene, assets: AssetManager, defaultTag = 'world') {
    this.scene = scene;
    this.assets = assets;
    this.defaultTag = defaultTag;
  }

  private ensureUnitBox(): number {
    if (!this.assets.hasBackend) return 0;
    const key = '__wb_unit_box__';
    let h = this.meshCache.get(key) ?? this.assets.getMesh('box') ?? this.assets.getMesh(key);
    if (!h) {
      h = this.assets.registerMesh(key, createBoxGeometry(0.5, 0.5, 0.5), this.defaultTag);
    }
    this.meshCache.set(key, h);
    return h.meshId;
  }

  private ensureUnitSphere(): number {
    if (!this.assets.hasBackend) return 0;
    const key = '__wb_unit_sphere__';
    let h = this.meshCache.get(key) ?? this.assets.getMesh(key);
    if (!h) {
      h = this.assets.registerMesh(key, createSphereGeometry(0.5, 16, 22), this.defaultTag);
    }
    this.meshCache.set(key, h);
    return h.meshId;
  }

  private ensureUnitCylinder(): number {
    if (!this.assets.hasBackend) return 0;
    const key = '__wb_unit_cyl__';
    let h = this.meshCache.get(key) ?? this.assets.getMesh(key);
    if (!h) {
      h = this.assets.registerMesh(key, createCylinderGeometry(0.5, 0.5, 18), this.defaultTag);
    }
    this.meshCache.set(key, h);
    return h.meshId;
  }

  resolveMaterial(input?: MaterialInput, fallback: ShaderPresetName = 'ultraRealism'): number {
    if (!this.assets.hasBackend) return 0;
    if (typeof input === 'number') return input;
    if (input instanceof MaterialBuilder) {
      const built = input.build();
      const cacheKey = `__mb__:${JSON.stringify(built)}`;
      const cached = this.matCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const id = this.assets.createMaterial(`wb-mat-${++this.matCounter}`, built, this.defaultTag);
      this.matCache.set(cacheKey, id);
      return id;
    }
    if (input && typeof input === 'object' && 'blocks' in input) {
      const cacheKey = `__desc__:${JSON.stringify(input)}`;
      const cached = this.matCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const id = this.assets.createMaterial(`wb-mat-${++this.matCounter}`, input, this.defaultTag);
      this.matCache.set(cacheKey, id);
      return id;
    }
    const cacheKey = JSON.stringify(input ?? fallback);
    const cached = this.matCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let id: number;
    if (!input) {
      id = material(fallback).create(this.assets, `wb-mat-${++this.matCounter}`, this.defaultTag);
    } else if (typeof input === 'string') {
      if (input.startsWith('#') || input.startsWith('rgb')) {
        id = material(fallback).color(input).create(this.assets, `wb-mat-${++this.matCounter}`, this.defaultTag);
      } else {
        id = material(input).create(this.assets, `wb-mat-${++this.matCounter}`, this.defaultTag);
      }
    } else {
      const b = material(input.preset ?? fallback);
      if (input.color !== undefined) b.color(input.color);
      if (input.glow !== undefined) b.glow(input.glow);
      if (input.metallic !== undefined) b.metallic(input.metallic);
      if (input.roughness !== undefined) b.roughness(input.roughness);
      if (input.grid !== undefined) b.grid(input.grid);
      if (input.doubleSided) b.doubleSided(true);
      if (input.transparent) b.transparent();
      id = b.create(this.assets, `wb-mat-${++this.matCounter}`, this.defaultTag);
    }
    this.matCache.set(cacheKey, id);
    return id;
  }

  /** Spawns a box using FULL `[width, height, depth]` dimensions (no manual halfExtents). */
  box(opts: BoxSpawnOptions): EntityId {
    const size = opts.size ?? [1, 1, 1];
    const e = this.scene.createEntity();
    const rot =
      opts.rotation ??
      (opts.euler ? quatFromEuler(opts.euler[0], opts.euler[1], opts.euler[2]) : undefined);
    this.scene.setTransform(e, {
      position: opts.pos,
      scale: size,
      rotation: rot,
      immediate: true,
    });
    if (opts.collider !== false) {
      this.scene.setCollider3D(e, {
        kind: 'aabb',
        halfExtents: [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5],
      });
    }
    if (opts.dynamic) {
      const phys = opts.physics ? PHYSICS_MATERIAL_PRESETS[opts.physics] : undefined;
      this.scene.setRigidBody(e, {
        dynamic: true,
        mass: opts.mass ?? 1.0,
        friction: phys?.friction ?? 0.65,
        restitution: phys?.restitution ?? 0.12,
        density: phys?.density,
      });
    }
    if (this.assets.hasBackend) {
      const matId = this.resolveMaterial(opts.material);
      this.scene.setMesh3D(e, {
        meshId: this.ensureUnitBox(),
        materialId: matId,
        transparent: opts.transparent,
        boundsRadius: 0.9,
      });
    }
    return e;
  }

  /** Spawns a sphere of exact radius. */
  sphere(opts: SphereSpawnOptions): EntityId {
    const r = opts.radius ?? 0.5;
    const e = this.scene.createEntity();
    this.scene.setTransform(e, {
      position: opts.pos,
      scale: [r * 2, r * 2, r * 2],
      immediate: true,
    });
    if (opts.collider !== false) {
      this.scene.setCollider3D(e, { kind: 'sphere', radius: r });
    }
    if (opts.dynamic) {
      const phys = opts.physics ? PHYSICS_MATERIAL_PRESETS[opts.physics] : undefined;
      this.scene.setRigidBody(e, {
        dynamic: true,
        mass: opts.mass ?? 1.0,
        friction: phys?.friction ?? 0.5,
        restitution: phys?.restitution ?? 0.35,
        density: phys?.density,
      });
    }
    if (this.assets.hasBackend) {
      this.scene.setMesh3D(e, {
        meshId: this.ensureUnitSphere(),
        materialId: this.resolveMaterial(opts.material),
        boundsRadius: 0.55,
      });
    }
    return e;
  }

  /** Spawns a cylinder of exact radius and height. */
  cylinder(opts: CylinderSpawnOptions): EntityId {
    const r = opts.radius ?? 0.4;
    const h = opts.height ?? 1.6;
    const e = this.scene.createEntity();
    this.scene.setTransform(e, {
      position: opts.pos,
      scale: [r * 2, h, r * 2],
      rotation: opts.euler ? quatFromEuler(opts.euler[0], opts.euler[1], opts.euler[2]) : undefined,
      immediate: true,
    });
    if (opts.collider !== false) {
      this.scene.setCollider3D(e, { kind: 'cylinder', radius: r, halfHeight: h * 0.5 });
    }
    if (opts.dynamic) {
      this.scene.setRigidBody(e, { dynamic: true, mass: opts.mass ?? 1.5, friction: 0.6 });
    }
    if (this.assets.hasBackend) {
      this.scene.setMesh3D(e, {
        meshId: this.ensureUnitCylinder(),
        materialId: this.resolveMaterial(opts.material),
        boundsRadius: 0.75,
      });
    }
    return e;
  }

  /** Spawns a walkable sloped ramp (`size = [width, height, length]`) with exact triangle BVH collision. */
  ramp(opts: RampSpawnOptions): EntityId {
    const [w, h, l] = opts.size ?? [3.0, 1.5, 4.5];
    const e = this.scene.createEntity();
    const geom = createRampGeometry(w, h, l);
    const yaw = opts.yaw ?? 0;
    const rot = yaw ? quatFromEuler(0, yaw, 0) : undefined;
    this.scene.setTransform(e, { position: opts.pos, rotation: rot, immediate: true });
    const tris = extractColliderTriangles(geom, yaw ? [0, 0, 0] : opts.pos);
    if (yaw) {
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      for (let i = 0; i < tris.length; i += 3) {
        const lx = tris[i];
        const lz = tris[i + 2];
        tris[i] = opts.pos[0] + lx * c + lz * s;
        tris[i + 1] += opts.pos[1];
        tris[i + 2] = opts.pos[2] - lx * s + lz * c;
      }
    }
    this.scene.addStaticMeshTriangles(e, tris);
    if (this.assets.hasBackend) {
      const handle = this.assets.registerMesh(`wb-ramp-${++this.meshCounter}`, geom, this.defaultTag);
      this.scene.setMesh3D(e, {
        meshId: handle.meshId,
        materialId: this.resolveMaterial(opts.material, 'ultraRealism'),
        boundsRadius: Math.hypot(w, h, l) * 0.6,
      });
    }
    return e;
  }

  /** Spawns an overlap trigger volume (excluded automatically from solid ray-hit decals). */
  trigger(opts: TriggerSpawnOptions): EntityId {
    const e = this.scene.createEntity();
    this.scene.setTransform(e, { position: opts.pos, scale: opts.size, immediate: true });
    this.scene.setCollider3D(e, {
      kind: 'aabb',
      halfExtents: [opts.size[0] * 0.5, opts.size[1] * 0.5, opts.size[2] * 0.5],
    });
    this.scene.setTrigger(e, true);
    this.ignoreRayEntities.add(e);
    if (opts.material !== undefined && this.assets.hasBackend) {
      this.scene.setMesh3D(e, {
        meshId: this.ensureUnitBox(),
        materialId: this.resolveMaterial(opts.material, 'hologram'),
        transparent: true,
        boundsRadius: 0.9,
      });
    }
    if (opts.onEnter) {
      this.scene.onTriggerEnter((ev) => {
        if (ev.entityA === e || ev.entityB === e) {
          opts.onEnter!(ev.entityA === e ? ev.entityB : ev.entityA);
        }
      });
    }
    if (opts.onExit) {
      this.scene.onTriggerExit((ev) => {
        if (ev.entityA === e || ev.entityB === e) {
          opts.onExit!(ev.entityA === e ? ev.entityB : ev.entityA);
        }
      });
    }
    return e;
  }

  /** Spawns a fragile glass/crystal block that shatters into dynamic shards on `.shatter()` or `onRayHit`. */
  breakable(opts: BreakableOptions): BreakableHandle {
    const size = opts.size ?? [0.8, 1.2, 0.35];
    const shardCount = opts.shardCount ?? 6;
    const matInput =
      opts.material ??
      material('crystalGlass').color('#7dd3fcbf').glow('#38bdf8').doubleSided(true).transparent();
    const shardMat = opts.shardMaterial ?? matInput;

    const entity = this.box({
      pos: opts.pos,
      size,
      material: matInput,
      transparent: true,
    });

    let broken = false;
    const shatter = (hitPoint?: Vec3Tuple): boolean => {
      if (broken) return false;
      broken = true;
      this.breakables.delete(entity);
      const pos = this.scene.getPosition(entity);
      const hp = hitPoint ?? pos;
      this.scene.destroyEntity(entity);
      this.scene.emitVfx('sparks', pos, 36, Math.max(0.04, pos[1] - size[1] * 0.5));
      this.scene.emitVfx('magic', pos, 24, Math.max(0.04, pos[1] - size[1] * 0.5));
      for (let i = 0; i < shardCount; i++) {
        const ang = (i / shardCount) * Math.PI * 2 + Math.random() * 0.5;
        const sc: Vec3Tuple = [0.18 + Math.random() * 0.14, 0.22 + Math.random() * 0.16, 0.16];
        const shard = this.box({
          pos: [pos[0] + Math.cos(ang) * 0.2, pos[1] + (Math.random() - 0.3) * 0.35, pos[2] + Math.sin(ang) * 0.2],
          size: sc,
          euler: [Math.random() * 3, Math.random() * 3, Math.random() * 3],
          material: shardMat,
          dynamic: true,
          mass: 0.45,
          transparent: true,
        });
        this.scene.setVelocity(
          shard,
          Math.cos(ang) * (4 + Math.random() * 3.5) + (pos[0] - hp[0]) * 1.8,
          3.2 + Math.random() * 4.2,
          Math.sin(ang) * (4 + Math.random() * 3.5) + (pos[2] - hp[2]) * 1.8
        );
      }
      return true;
    };

    this.breakables.set(entity, () => shatter());
    return { entity, shatter };
  }

  private registerHingedDoor(
    side: RoomSide,
    pivotPos: Vec3Tuple,
    width: number,
    height: number,
    thickness: number,
    alongX: boolean,
    mat: MaterialInput | undefined,
    interactive: boolean
  ): DoorHandle {
    const entity = this.scene.createEntity();
    this.scene.setCollider3D(entity, {
      kind: 'aabb',
      halfExtents: alongX ? [width * 0.5, height * 0.5, thickness * 0.5] : [thickness * 0.5, height * 0.5, width * 0.5],
    });
    if (this.assets.hasBackend) {
      this.scene.setMesh3D(entity, {
        meshId: this.ensureUnitBox(),
        materialId: this.resolveMaterial(mat, 'ultraRealism'),
        boundsRadius: 0.9,
      });
    }

    const state: InternalDoorState = {
      width,
      height,
      thickness,
      alongX,
      angle: 0,
      target: 0,
      handle: null as unknown as DoorHandle,
    };

    const syncDoor = (angle: number) => {
      const cx = alongX
        ? pivotPos[0] + Math.cos(angle) * (width * 0.5)
        : pivotPos[0] + Math.sin(angle) * (width * 0.5);
      const cz = alongX
        ? pivotPos[2] - Math.sin(angle) * (width * 0.5)
        : pivotPos[2] + Math.cos(angle) * (width * 0.5);
      this.scene.setTransform(entity, {
        position: [cx, pivotPos[1], cz],
        scale: alongX ? [width, height, thickness] : [thickness, height, width],
        rotation: quatFromEuler(0, angle, 0),
        immediate: angle === 0,
      });
    };

    syncDoor(0);

    const handle: DoorHandle = {
      entity,
      side,
      pivotPos,
      open: false,
      setOpen(open: boolean) {
        if (!interactive) return;
        handle.open = open;
        state.target = open ? 1.55 : 0;
      },
      toggle() {
        if (!interactive) return false;
        handle.setOpen(!handle.open);
        return handle.open;
      },
    };
    state.handle = handle;
    if (interactive) {
      this.doors.push(state);
    }
    return handle;
  }

  /**
   * Builds a sealed architectural room (`center = [cx, floorY, cz]`) with exact doorways, hinged `[E]` doors,
   * translucent windows, floor, optional roof, and optional interior light / volumetric god-ray cone.
   */
  room(opts: RoomOptions): RoomHandle {
    const [cx, floorY, cz] = opts.center;
    const [w, h, d] = opts.size;
    const t = opts.wallThickness ?? 0.36;
    const wallMat = opts.wallMaterial ?? { color: '#334155', roughness: 0.72 };
    const floorMat = opts.floorMaterial ?? { color: '#475569', roughness: 0.45, grid: 1.0 };
    const doorMat = opts.doorMaterial ?? { color: '#92400e', roughness: 0.45, metallic: 0.25 };
    const glassMat =
      opts.glassMaterial ??
      material('crystalGlass').color('#7dd3fc40').glow('#38bdf8').doubleSided(true).transparent();

    const entities: EntityId[] = [];
    const doors: DoorHandle[] = [];

    if (opts.floor !== false) {
      entities.push(this.box({ pos: [cx, floorY - 0.08, cz], size: [w, 0.16, d], material: floorMat }));
    }
    if (opts.roof !== false) {
      entities.push(this.box({ pos: [cx, floorY + h + t * 0.4, cz], size: [w + t, t * 0.8, d + t], material: wallMat }));
      this.scene.addDryZone({ center: [cx, floorY + h * 0.5, cz], size: [w, h, d] });
    }

    const doorMap = new Map<RoomSide, DoorConfig>();
    for (const item of opts.doors ?? []) {
      const cfg = typeof item === 'string' ? { side: item } : item;
      doorMap.set(cfg.side, cfg);
    }
    const winMap = new Map<RoomSide, WindowConfig>();
    for (const item of opts.windows ?? []) {
      const cfg = typeof item === 'string' ? { side: item } : item;
      winMap.set(cfg.side, cfg);
    }

    const buildSideWall = (side: RoomSide) => {
      const alongX = side === 'north' || side === 'south';
      const span = alongX ? w : d;
      const offset = alongX ? d * 0.5 - t * 0.5 : w * 0.5 - t * 0.5;
      const sign = side === 'south' || side === 'east' ? 1 : -1;
      const wallCenter: Vec3Tuple = alongX
        ? [cx, floorY + h * 0.5, cz + sign * offset]
        : [cx + sign * offset, floorY + h * 0.5, cz];

      const doorCfg = doorMap.get(side);
      if (doorCfg) {
        const dw = Math.min(doorCfg.width ?? 1.85, span - t * 2 - 0.3);
        const dh = Math.min(doorCfg.height ?? 2.55, h - 0.25);
        const sideLen = Math.max(0.25, (span - dw) * 0.5);
        const sideOffset = dw * 0.5 + sideLen * 0.5;

        for (const s of [-1, 1] as const) {
          const p: Vec3Tuple = alongX
            ? [wallCenter[0] + s * sideOffset, floorY + h * 0.5, wallCenter[2]]
            : [wallCenter[0], floorY + h * 0.5, wallCenter[2] + s * sideOffset];
          entities.push(this.box({ pos: p, size: alongX ? [sideLen, h, t] : [t, h, sideLen], material: wallMat }));
        }
        const lintelH = h - dh;
        if (lintelH > 0.05) {
          entities.push(
            this.box({
              pos: [wallCenter[0], floorY + dh + lintelH * 0.5, wallCenter[2]],
              size: alongX ? [dw, lintelH, t] : [t, lintelH, dw],
              material: wallMat,
            })
          );
        }
        const pivotPos: Vec3Tuple = alongX
          ? [wallCenter[0] - dw * 0.5, floorY + dh * 0.5, wallCenter[2]]
          : [wallCenter[0], floorY + dh * 0.5, wallCenter[2] - dw * 0.5];
        const dhdl = this.registerHingedDoor(
          side,
          pivotPos,
          dw - 0.04,
          dh,
          Math.min(0.16, t * 0.6),
          alongX,
          doorMat,
          doorCfg.interactive !== false
        );
        entities.push(dhdl.entity);
        doors.push(dhdl);
        return;
      }

      const winCfg = winMap.get(side);
      if (winCfg) {
        const ww = Math.min(winCfg.width ?? 2.6, span - t * 2 - 0.4);
        const sillH = Math.min(winCfg.sillHeight ?? 0.95, h * 0.45);
        const wh = Math.min(winCfg.height ?? 1.45, h - sillH - 0.25);
        const sideLen = Math.max(0.25, (span - ww) * 0.5);
        const sideOffset = ww * 0.5 + sideLen * 0.5;

        for (const s of [-1, 1] as const) {
          const p: Vec3Tuple = alongX
            ? [wallCenter[0] + s * sideOffset, floorY + h * 0.5, wallCenter[2]]
            : [wallCenter[0], floorY + h * 0.5, wallCenter[2] + s * sideOffset];
          entities.push(this.box({ pos: p, size: alongX ? [sideLen, h, t] : [t, h, sideLen], material: wallMat }));
        }
        entities.push(
          this.box({
            pos: [wallCenter[0], floorY + sillH * 0.5, wallCenter[2]],
            size: alongX ? [ww, sillH, t] : [t, sillH, ww],
            material: wallMat,
          })
        );
        const topH = h - sillH - wh;
        if (topH > 0.05) {
          entities.push(
            this.box({
              pos: [wallCenter[0], floorY + sillH + wh + topH * 0.5, wallCenter[2]],
              size: alongX ? [ww, topH, t] : [t, topH, ww],
              material: wallMat,
            })
          );
        }
        entities.push(
          this.box({
            pos: [wallCenter[0], floorY + sillH + wh * 0.5, wallCenter[2]],
            size: alongX ? [ww, wh, 0.08] : [0.08, wh, ww],
            material: glassMat,
            transparent: true,
          })
        );
        return;
      }

      entities.push(
        this.box({
          pos: wallCenter,
          size: alongX ? [span, h, t] : [t, h, span],
          material: wallMat,
        })
      );
    };

    for (const side of ['north', 'south', 'west', 'east'] as const) {
      buildSideWall(side);
    }

    let pointLightIdx = -1;
    let beamEntity: EntityId | null = null;
    let beamMatId = 0;
    const beamColor =
      typeof opts.light === 'object' && opts.light.color ? parseColor(opts.light.color) : [1, 0.85, 0.5, 0.3];

    if (opts.light) {
      const lCfg = typeof opts.light === 'object' ? opts.light : {};
      const bulbMat = material('cyberNeon')
        .color(lCfg.color ?? '#fde68a')
        .glow(lCfg.color ?? '#fbbf24')
        .create(this.assets, `wb-bulb-${++this.matCounter}`, this.defaultTag);
      const bulb = this.scene.createEntity();
      this.scene.setTransform(bulb, {
        position: [cx, floorY + h - 0.25, cz],
        scale: [0.34, 0.34, 0.34],
        immediate: true,
      });
      if (this.assets.hasBackend) {
        this.scene.setMesh3D(bulb, { meshId: this.ensureUnitSphere(), materialId: bulbMat, boundsRadius: 0.4 });
      }
      entities.push(bulb);

      if (this.scene.pointLights.length < 4) {
        pointLightIdx = this.scene.pointLights.length;
        const [lr, lg, lb] = parseColor(lCfg.color ?? '#ffcf70');
        this.scene.pointLights.push({
          position: [cx, floorY + h - 0.5, cz],
          color: [lr, lg, lb],
          intensity: lCfg.intensity ?? 2.4,
          radius: lCfg.radius ?? Math.max(w, d) * 1.4,
        });
      }

      if (lCfg.godRay && this.assets.hasBackend) {
        const beamH = Math.max(1.2, h - 0.35);
        const cone = this.assets.registerMesh(
          `wb-beam-${++this.meshCounter}`,
          createConeGeometry(0.14, Math.min(w, d) * 0.36, beamH, 22),
          this.defaultTag
        );
        beamMatId = material('ultraRealism')
          .blocks('volumetricBeam')
          .color([beamColor[0], beamColor[1], beamColor[2], 0.3])
          .glow([beamColor[0], beamColor[1], beamColor[2]])
          .transparent('additive', false)
          .doubleSided(true)
          .create(this.assets, `wb-beam-mat-${++this.matCounter}`, this.defaultTag);
        beamEntity = this.scene.createEntity();
        this.scene.setTransform(beamEntity, {
          position: [cx, floorY + beamH * 0.5 + 0.05, cz],
          immediate: true,
        });
        this.scene.setMesh3D(beamEntity, {
          meshId: cone.meshId,
          materialId: beamMatId,
          transparent: true,
          boundsRadius: beamH,
        });
        entities.push(beamEntity);
      }
    }

    let lightOn = Boolean(opts.light);
    const baseIntensity =
      typeof opts.light === 'object' && opts.light.intensity !== undefined ? opts.light.intensity : 2.4;

    const setLight = (on: boolean) => {
      lightOn = on;
      if (pointLightIdx >= 0 && this.scene.pointLights[pointLightIdx]) {
        this.scene.pointLights[pointLightIdx].intensity = on ? baseIntensity : 0;
      }
      if (beamMatId && this.assets.hasBackend) {
        this.assets.updateMaterial(beamMatId, {
          uniforms: {
            ...material('ultraRealism').build().uniforms,
            baseColor: [beamColor[0], beamColor[1], beamColor[2], on ? 0.3 : 0.0],
            glowColor: [beamColor[0], beamColor[1], beamColor[2]],
          },
        });
      }
    };

    return {
      entities,
      doors,
      setLight,
      toggleLight: () => {
        setLight(!lightOn);
        return lightOn;
      },
    };
  }

  /** Builds a walkable staircase from `from` up to `to`. */
  stairs(opts: StairsOptions): EntityId[] {
    const [fx, fy, fz] = opts.from;
    const [tx, ty, tz] = opts.to;
    const width = opts.width ?? 2.0;
    const dx = tx - fx;
    const dy = ty - fy;
    const dz = tz - fz;
    const horizLen = Math.hypot(dx, dz) || 1;
    const steps = opts.steps ?? Math.max(4, Math.round(Math.abs(dy) / 0.28));
    const yaw = Math.atan2(dx, dz);
    const stepDepth = horizLen / steps + 0.08;
    const stepRise = dy / steps;
    const mat = opts.material ?? { color: '#64748b', roughness: 0.65 };

    const ids: EntityId[] = [];
    for (let i = 0; i < steps; i++) {
      const frac = (i + 0.5) / steps;
      const topY = fy + stepRise * (i + 1);
      const h = Math.max(0.18, topY - fy);
      ids.push(
        this.box({
          pos: [fx + dx * frac, fy + h * 0.5, fz + dz * frac],
          size: [width, h, stepDepth],
          euler: [0, yaw, 0],
          material: mat,
        })
      );
    }
    return ids;
  }

  /**
   * Builds a 3D volumetric water tank (`center = [cx, bottomY, cz]`) with caustic floor,
   * optional glass sides, sealed `createWaterVolumeGeometry`, Archimedes `addWaterZone`,
   * automatic Underwater camera shader activation, and GPU particle splashes.
   */
  pool(opts: PoolOptions): PoolHandle {
    const [cx, bottomY, cz] = opts.center;
    const [w, h, d] = opts.size;
    const t = opts.wallThickness ?? 0.35;
    const glassSet = new Set<RoomSide>(opts.glassSides ?? []);
    const wallMat = opts.wallMaterial ?? { color: '#475569', roughness: 0.55 };
    const floorMat =
      opts.floorMaterial ?? material('waterCaustics').color('#1e6b8a').glow('#5eead4');
    const glassMat = material('crystalGlass').color('#93c5fd3d').glow('#38bdf8').doubleSided(true).transparent();

    const entities: EntityId[] = [];
    entities.push(this.box({ pos: [cx, bottomY + 0.05, cz], size: [w, 0.1, d], material: floorMat }));

    const innerW = Math.max(0.5, w - t * 2);
    const innerD = Math.max(0.5, d - t * 2);
    const waterH = Math.max(0.3, h - 0.12);
    const waterCenterY = bottomY + 0.08 + waterH * 0.5;

    const addPoolWall = (side: RoomSide) => {
      const isGlass = glassSet.has(side);
      const m = isGlass ? glassMat : wallMat;
      const useT = isGlass ? Math.min(0.14, t) : t;
      const alongX = side === 'north' || side === 'south';
      const sign = side === 'south' || side === 'east' ? 1 : -1;
      const pos: Vec3Tuple = alongX
        ? [cx, bottomY + h * 0.5, cz + sign * (d * 0.5 - t * 0.5)]
        : [cx + sign * (w * 0.5 - t * 0.5), bottomY + h * 0.5, cz];
      entities.push(
        this.box({
          pos,
          size: alongX ? [w, h, useT] : [useT, h, innerD],
          material: m,
          transparent: isGlass,
        })
      );
    };
    for (const side of ['north', 'south', 'west', 'east'] as const) addPoolWall(side);

    const wp = opts.waterPreset ?? 'realistic';
    const waterMatInput: MaterialInput =
      wp === 'anime'
        ? 'waterAnime'
        : wp === 'cyber'
          ? material('waterRealistic')
              .color('#0f3d8fd1')
              .edgeColor('#380a73')
              .glow('#26ffe0')
              .water({ style: 0.35, foam: 0.9, clarity: 0.52 })
          : wp === 'realistic'
            ? 'waterRealistic'
            : wp;

    const waterMatId = this.resolveMaterial(waterMatInput, 'waterRealistic');
    const waterSurface = this.scene.createEntity();
    this.ignoreRayEntities.add(waterSurface);
    this.scene.setTransform(waterSurface, { position: [cx, waterCenterY, cz], immediate: true });
    if (this.assets.hasBackend) {
      const waterGeom = createWaterVolumeGeometry(innerW + 0.04, waterH, innerD + 0.04, 34);
      const waterHandle = this.assets.registerMesh(`wb-water-${++this.meshCounter}`, waterGeom, 'scene-fx');
      this.scene.setMesh3D(waterSurface, {
        meshId: waterHandle.meshId,
        materialId: waterMatId,
        transparent: true,
        boundsRadius: Math.hypot(innerW, waterH, innerD) * 0.65,
      });
    }
    entities.push(waterSurface);

    this.scene.addWaterZone({
      center: [cx, waterCenterY, cz],
      halfExtents: [innerW * 0.5, waterH * 0.5, innerD * 0.5],
      density: opts.density ?? 1.45,
      linearDrag: 2.8,
      angularDrag: 2.6,
      flow: opts.flow ?? [0.25, 0, 0.15],
    });

    const surfaceY = bottomY + 0.08 + waterH;
    const waterSensor = this.trigger({
      pos: [cx, surfaceY - 0.04, cz],
      size: [innerW * 0.96, 0.24, innerD * 0.96],
      onEnter: opts.splashOnEnter !== false
        ? (other) => {
            if (other === waterSurface) return;
            const op = this.scene.getPosition(other);
            const [, vy] = this.scene.getVelocity(other);
            if (Math.abs(vy) > 1.1) {
              this.scene.emitVfx('splash', [op[0], surfaceY, op[2]], Math.min(40, Math.round(Math.abs(vy) * 4)), surfaceY - 0.05);
            }
          }
        : undefined,
    });
    entities.push(waterSensor);

    return { entities, waterSurface, waterSensor, waterMatId };
  }

  /**
   * Builds a 3D level directly from a multi-line ASCII map:
   * `#` wall · `=` half-wall · `D` door `[E]` · `G` window · `W` 3D pool water · `C` dynamic crate · `B` breakable crystal · `P` player spawn
   */
  fromGrid(grid: string | string[], opts: GridBuildOptions = {}): GridLevelHandle {
    const rawLines = Array.isArray(grid) ? grid : grid.split(/\r?\n/);
    const nonEmpty = rawLines.map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0);
    // Dedent common leading spaces so indented JS/TS template literals align to column 0
    const minIndent = nonEmpty.reduce((min, l) => {
      const m = /^ */.exec(l)?.[0].length ?? 0;
      return Math.min(min, m);
    }, Infinity);
    const rows = minIndent > 0 && Number.isFinite(minIndent)
      ? nonEmpty.map((l) => l.slice(minIndent))
      : nonEmpty;
    const rowCount = rows.length;
    const colCount = Math.max(0, ...rows.map((r) => r.length));

    const [ox, floorY, oz] = opts.origin ?? [0, 0, 0];
    const cell = opts.cellSize ?? 2.4;
    const wallH = opts.wallHeight ?? 3.2;
    const wallMat = opts.wallMaterial ?? { color: '#3b4252', roughness: 0.72 };
    const floorMat = opts.floorMaterial ?? { color: '#4c566a', roughness: 0.5, grid: 1.0 };
    const doorMat = opts.doorMaterial ?? { color: '#9a5b25', roughness: 0.44 };
    const glassMat = material('crystalGlass').color('#7dd3fc42').glow('#38bdf8').doubleSided(true).transparent();

    const entities: EntityId[] = [];
    const doors: DoorHandle[] = [];
    const breakables: BreakableHandle[] = [];
    const campfires: Vec3Tuple[] = [];
    const waterSensors: EntityId[] = [];
    let spawnPoint: Vec3Tuple = [ox + colCount * cell * 0.5, floorY + 1.2, oz + rowCount * cell * 0.5];

    const charAt = (r: number, c: number) => (r >= 0 && r < rowCount && c >= 0 && c < rows[r].length ? rows[r][c] : ' ');
    const isSolidChar = (ch: string) => ch === '#' || ch === 'G' || ch === 'D' || ch === '=';

    if (opts.floor !== false && rowCount > 0 && colCount > 0) {
      entities.push(
        this.box({
          pos: [ox + (colCount * cell) * 0.5 - cell * 0.5, floorY - 0.1, oz + (rowCount * cell) * 0.5 - cell * 0.5],
          size: [colCount * cell, 0.2, rowCount * cell],
          material: floorMat,
        })
      );
    }
    if (opts.roof && rowCount > 0 && colCount > 0) {
      entities.push(
        this.box({
          pos: [ox + (colCount * cell) * 0.5 - cell * 0.5, floorY + wallH + 0.12, oz + (rowCount * cell) * 0.5 - cell * 0.5],
          size: [colCount * cell, 0.24, rowCount * cell],
          material: wallMat,
        })
      );
    }

    const waterVisited = new Set<string>();
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        const ch = rows[r][c];
        const x = ox + c * cell;
        const z = oz + r * cell;

        if (ch === '#') {
          entities.push(this.box({ pos: [x, floorY + wallH * 0.5, z], size: [cell, wallH, cell], material: wallMat }));
        } else if (ch === '=') {
          entities.push(this.box({ pos: [x, floorY + 0.55, z], size: [cell, 1.1, cell], material: wallMat }));
        } else if (ch === 'G') {
          const sill = 0.9;
          const wh = Math.max(0.8, wallH - sill - 0.6);
          entities.push(this.box({ pos: [x, floorY + sill * 0.5, z], size: [cell, sill, cell], material: wallMat }));
          entities.push(
            this.box({
              pos: [x, floorY + sill + wh + (wallH - sill - wh) * 0.5, z],
              size: [cell, wallH - sill - wh, cell],
              material: wallMat,
            })
          );
          entities.push(
            this.box({
              pos: [x, floorY + sill + wh * 0.5, z],
              size: [cell * 0.96, wh, 0.16],
              material: glassMat,
              transparent: true,
            })
          );
        } else if (ch === 'D') {
          const nsWall = isSolidChar(charAt(r - 1, c)) || isSolidChar(charAt(r + 1, c));
          const alongX = !nsWall;
          const dh = Math.min(2.45, wallH - 0.25);
          const lintelH = wallH - dh;
          if (lintelH > 0.05) {
            entities.push(
              this.box({
                pos: [x, floorY + dh + lintelH * 0.5, z],
                size: alongX ? [cell, lintelH, 0.32] : [0.32, lintelH, cell],
                material: wallMat,
              })
            );
          }
          const pivotPos: Vec3Tuple = alongX
            ? [x - cell * 0.48, floorY + dh * 0.5, z]
            : [x, floorY + dh * 0.5, z - cell * 0.48];
          const dhdl = this.registerHingedDoor('north', pivotPos, cell * 0.94, dh, 0.16, alongX, doorMat, true);
          entities.push(dhdl.entity);
          doors.push(dhdl);
        } else if (ch === 'W' && !waterVisited.has(`${r},${c}`)) {
          let maxC = c;
          while (maxC + 1 < rows[r].length && charAt(r, maxC + 1) === 'W' && !waterVisited.has(`${r},${maxC + 1}`)) {
            maxC++;
          }
          let maxR = r;
          outer: while (maxR + 1 < rowCount) {
            for (let cc = c; cc <= maxC; cc++) {
              if (charAt(maxR + 1, cc) !== 'W' || waterVisited.has(`${maxR + 1},${cc}`)) break outer;
            }
            maxR++;
          }
          for (let rr = r; rr <= maxR; rr++) {
            for (let cc = c; cc <= maxC; cc++) waterVisited.add(`${rr},${cc}`);
          }
          const poolW = (maxC - c + 1) * cell;
          const poolD = (maxR - r + 1) * cell;
          const poolCx = ox + ((c + maxC) * 0.5) * cell;
          const poolCz = oz + ((r + maxR) * 0.5) * cell;
          const p = this.pool({
            center: [poolCx, floorY, poolCz],
            size: [poolW, 1.35, poolD],
            wallThickness: 0.24,
            glassSides: ['south'],
            waterPreset: opts.waterPreset ?? 'realistic',
          });
          entities.push(...p.entities);
          waterSensors.push(p.waterSensor);
        } else if (ch === 'C') {
          entities.push(
            this.box({
              pos: [x, floorY + 0.55, z],
              size: [0.95, 0.95, 0.95],
              material: { color: '#d97706', roughness: 0.65 },
              dynamic: true,
              physics: 'wood',
            })
          );
        } else if (ch === 'B') {
          const br = this.breakable({ pos: [x, floorY + 0.7, z], size: [0.85, 1.35, 0.4] });
          entities.push(br.entity);
          breakables.push(br);
        } else if (ch === 'F') {
          entities.push(
            this.cylinder({
              pos: [x, floorY + 0.12, z],
              radius: 0.52,
              height: 0.24,
              material: { color: '#1f2937', roughness: 0.85 },
            })
          );
          campfires.push([x, floorY + 0.28, z]);
        } else if (ch === 'L') {
          const lamp = this.box({
            pos: [x, floorY + wallH - 0.12, z],
            size: [0.45, 0.14, 0.45],
            material: material('cyberNeon').color('#fef08a').glow('#facc15'),
            collider: false,
          });
          entities.push(lamp);
        } else if (ch === 'P') {
          spawnPoint = [x, floorY + 1.2, z];
        }
      }
    }

    if (opts.onPlayerSpawn) opts.onPlayerSpawn(spawnPoint);
    return { entities, spawnPoint, doors, breakables, campfires, waterSensors };
  }

  /** Animates interactive doors managed by this WorldBuilder. Call once per fixed/frame update. */
  update(dt: number): void {
    for (const d of this.doors) {
      const diff = d.target - d.angle;
      if (Math.abs(diff) > 0.002) {
        d.angle += diff * Math.min(1, dt * 7.5);
        const cx = d.alongX
          ? d.handle.pivotPos[0] + Math.cos(d.angle) * (d.width * 0.5)
          : d.handle.pivotPos[0] + Math.sin(d.angle) * (d.width * 0.5);
        const cz = d.alongX
          ? d.handle.pivotPos[2] - Math.sin(d.angle) * (d.width * 0.5)
          : d.handle.pivotPos[2] + Math.cos(d.angle) * (d.width * 0.5);
        this.scene.setTransform(d.handle.entity, {
          position: [cx, d.handle.pivotPos[1], cz],
          scale: d.alongX ? [d.width, d.height, d.thickness] : [d.thickness, d.height, d.width],
          rotation: quatFromEuler(0, d.angle, 0),
        });
      }
    }
  }

  getNearestDoor(pos: Vec3Tuple, maxDist = 2.6): DoorHandle | null {
    let best: DoorHandle | null = null;
    let bestD = maxDist;
    for (const d of this.doors) {
      const cur = this.scene.getPosition(d.handle.entity);
      const dist = Math.hypot(pos[0] - cur[0], pos[2] - cur[2]);
      if (dist < bestD && Math.abs(pos[1] - cur[1]) < 2.2) {
        bestD = dist;
        best = d.handle;
      }
    }
    return best;
  }

  /** Opens/closes the closest interactive door built by this WorldBuilder if within `maxDist`. */
  tryInteract(pos: Vec3Tuple, maxDist = 2.6): boolean {
    const door = this.getNearestDoor(pos, maxDist);
    if (!door) return false;
    door.toggle();
    return true;
  }

  /** Returns `true` if a raycast hit shattered a breakable or struck an ignored trigger/water surface. */
  handleRayHit(entity: EntityId, _point: Vec3Tuple): boolean {
    const fn = this.breakables.get(entity);
    if (fn) return fn();
    return this.ignoreRayEntities.has(entity);
  }
}

export function createWorldBuilder(scene: Scene, assets: AssetManager, defaultTag = 'world'): WorldBuilder {
  return new WorldBuilder(scene, assets, defaultTag);
}
