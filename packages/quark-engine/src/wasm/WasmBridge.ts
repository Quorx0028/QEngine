export interface ParsedGlbSubmesh {
  indexOffset: number;
  indexCount: number;
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
  emissiveFactor: [number, number, number];
  baseColorTexIndex: number;
  normalTexIndex: number;
  metallicRoughnessTexIndex: number;
  emissiveTexIndex: number;
  role: number;
}

export interface ParsedGlbResult {
  vertices: Float32Array;
  indices: Uint32Array;
  joints: Uint16Array;
  weights: Float32Array;
  submeshes: ParsedGlbSubmesh[];
  images: Array<{ mimeType: string; bytes: Uint8Array }>;
  colliderTriangles: Float32Array;
  triggerBoxes: Array<{
    center: [number, number, number];
    halfExtents: [number, number, number];
  }>;
  skeletonId: number | null;
  clips: Array<{ clipId: number; name: string }>;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
}

interface CoreExports {
  memory: WebAssembly.Memory;
  core_abi_version(): number;
  quark_alloc(len: number): number;
  quark_dealloc(ptr: number, len: number): void;
  core_create(): number;
  core_destroy(ptr: number): void;
  core_clear(ptr: number): void;
  core_set_gravity(ptr: number, gx: number, gy: number, gz: number): void;
  core_set_fixed_dt(ptr: number, fixedDt: number): void;
  core_spawn(ptr: number): number;
  core_despawn(ptr: number, entity: number): number;
  core_is_alive(ptr: number, entity: number): number;
  core_alive_count(ptr: number): number;
  core_set_parent(ptr: number, child: number, parent: number): number;
  core_set_transform(
    ptr: number,
    entity: number,
    px: number,
    py: number,
    pz: number,
    rx: number,
    ry: number,
    rz: number,
    rw: number,
    sx: number,
    sy: number,
    sz: number,
    immediate: number
  ): void;
  core_get_position(ptr: number, entity: number, outPtr: number): number;
  core_set_velocity(ptr: number, entity: number, vx: number, vy: number, vz: number): void;
  core_get_velocity(ptr: number, entity: number, outPtr: number): number;
  core_set_rigid_body(
    ptr: number,
    entity: number,
    dynamic: number,
    gravityScale: number,
    restitution: number,
    friction: number
  ): void;
  core_set_rigid_body_ex(
    ptr: number,
    entity: number,
    dynamic: number,
    gravityScale: number,
    restitution: number,
    friction: number,
    linearDamping: number,
    angularDamping: number,
    mass: number,
    lockRotation: number
  ): void;
  core_set_angular_velocity(ptr: number, entity: number, wx: number, wy: number, wz: number): void;
  core_apply_impulse(
    ptr: number,
    entity: number,
    ix: number,
    iy: number,
    iz: number,
    px: number,
    py: number,
    pz: number,
    hasPoint: number
  ): void;
  core_set_collision_filter(ptr: number, entity: number, layer: number, mask: number): void;
  core_set_trigger(ptr: number, entity: number, isTrigger: number): void;
  core_set_character_controller(ptr: number, entity: number, stepHeight: number, maxSlopeDeg: number): void;
  core_add_distance_joint(
    ptr: number,
    entityA: number,
    entityB: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    restLength: number,
    stiffness: number
  ): number;
  core_add_spring_joint(
    ptr: number,
    entityA: number,
    entityB: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    restLength: number,
    stiffness: number,
    damping: number
  ): number;
  core_add_hinge_joint(
    ptr: number,
    entityA: number,
    entityB: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    axisX: number,
    axisY: number,
    axisZ: number,
    hasLimits: number,
    minAngle: number,
    maxAngle: number
  ): number;
  core_remove_joint(ptr: number, jointId: number): number;
  core_is_sleeping(ptr: number, entity: number): number;
  core_is_grounded(ptr: number, entity: number): number;
  core_set_collider_3d(ptr: number, entity: number, kind: number, a: number, b: number, c: number): void;
  core_set_collider_2d(ptr: number, entity: number, kind: number, a: number, b: number): void;
  core_add_tile_grid_2d(
    ptr: number,
    ox: number,
    oy: number,
    tileSize: number,
    w: number,
    h: number,
    solidPtr: number,
    solidLen: number
  ): void;
  core_add_static_mesh_triangles(ptr: number, entity: number, vertsPtr: number, floatLen: number): void;
  core_set_sprite_2d(
    ptr: number,
    entity: number,
    w: number,
    h: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    r: number,
    g: number,
    b: number,
    a: number,
    texId: number,
    layer: number
  ): void;
  core_set_mesh_3d(
    ptr: number,
    entity: number,
    meshId: number,
    materialId: number,
    flags: number,
    boundsRadius: number
  ): void;
  core_step(ptr: number, frameDt: number, vpPtr: number): number;
  core_raycast_3d(
    ptr: number,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    outPtr: number
  ): number;
  core_raycast_3d_ex(
    ptr: number,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    mask: number,
    sphereRadius: number,
    outPtr: number
  ): number;
  core_set_terrain_heightmap(
    ptr: number,
    entity: number,
    originX: number,
    originZ: number,
    cellSize: number,
    width: number,
    height: number,
    heightsPtr: number,
    heightsLen: number
  ): void;
  core_sample_terrain_height(ptr: number, x: number, z: number, outNormalPtr: number): number;
  core_nav_build_3d(
    ptr: number,
    originX: number,
    originZ: number,
    cellSize: number,
    width: number,
    height: number,
    minY: number,
    maxY: number,
    agentRadius: number
  ): void;
  core_nav_build_2d(ptr: number): void;
  core_nav_set_blocked(ptr: number, cx: number, cz: number, blocked: number): void;
  core_nav_find_path(
    ptr: number,
    sx: number,
    sz: number,
    gx: number,
    gz: number,
    smooth: number
  ): number;
  core_nav_path_ptr(ptr: number): number;
  core_nav_path_len(ptr: number): number;
  core_get_bone_transform(ptr: number, entity: number, jointIdx: number, outPtr: number): number;
  core_matrices_ptr(ptr: number): number;
  core_matrices_len(ptr: number): number;
  core_render_2d_ptr(ptr: number): number;
  core_render_2d_len(ptr: number): number;
  core_render_2d_tex_ptr(ptr: number): number;
  core_render_2d_tex_len(ptr: number): number;
  core_render_3d_ptr(ptr: number): number;
  core_render_3d_len(ptr: number): number;
  core_events_ptr(ptr: number): number;
  core_events_len(ptr: number): number;
  core_parse_glb(ptr: number, bytesPtr: number, bytesLen: number): number;
  core_glb_vertices_ptr(ptr: number): number;
  core_glb_vertices_len(ptr: number): number;
  core_glb_indices_ptr(ptr: number): number;
  core_glb_indices_len(ptr: number): number;
  core_glb_submeshes_ptr(ptr: number): number;
  core_glb_submeshes_len(ptr: number): number;
  core_glb_bounds_ptr(ptr: number): number;
  core_glb_joints_ptr(ptr: number): number;
  core_glb_joints_len(ptr: number): number;
  core_glb_weights_ptr(ptr: number): number;
  core_glb_weights_len(ptr: number): number;
  core_glb_image_count(ptr: number): number;
  core_glb_image_ptr(ptr: number, idx: number): number;
  core_glb_image_len(ptr: number, idx: number): number;
  core_glb_image_mime_ptr(ptr: number, idx: number): number;
  core_glb_image_mime_len(ptr: number, idx: number): number;
  core_glb_triggers_ptr(ptr: number): number;
  core_glb_triggers_len(ptr: number): number;
  core_glb_collider_tris_ptr(ptr: number): number;
  core_glb_collider_tris_len(ptr: number): number;
  core_glb_has_skeleton(ptr: number): number;
  core_glb_clip_count(ptr: number): number;
  core_glb_clip_name_ptr(ptr: number, idx: number): number;
  core_glb_clip_name_len(ptr: number, idx: number): number;
  core_glb_register_animations(ptr: number, outFirstClipPtr: number): number;
  core_play_animation(
    ptr: number,
    entity: number,
    skeletonId: number,
    clipId: number,
    speed: number,
    looping: number,
    fadeSec: number
  ): void;
  core_bone_palettes_ptr(ptr: number): number;
  core_bone_palettes_len(ptr: number): number;
  core_palette_offsets_ptr(ptr: number): number;
  core_palette_offsets_len(ptr: number): number;
  core_glb_clear(ptr: number): void;
}

export class WasmBridge {
  private readonly exports: CoreExports;
  private corePtr: number;
  private scratchPtr: number;
  private readonly scratchBytes = 64 * 4; // 64 floats scratch (viewProj + vec3 + rayhit)
  private readonly textDecoder = new TextDecoder();

  private f32View: Float32Array;
  private i32View: Int32Array;
  private u32View: Uint32Array;
  private u16View: Uint16Array;
  private u8View: Uint8Array;
  private lastBuffer: ArrayBuffer;

  private constructor(exports: CoreExports) {
    this.exports = exports;
    if (exports.core_abi_version() !== 1) {
      throw new Error(`Unsupported quark-core ABI version: ${exports.core_abi_version()}`);
    }
    this.corePtr = exports.core_create();
    if (!this.corePtr) {
      throw new Error('Failed to create quark-core EngineCore instance');
    }
    this.scratchPtr = exports.quark_alloc(this.scratchBytes);
    this.lastBuffer = exports.memory.buffer;
    this.f32View = new Float32Array(this.lastBuffer);
    this.i32View = new Int32Array(this.lastBuffer);
    this.u32View = new Uint32Array(this.lastBuffer);
    this.u16View = new Uint16Array(this.lastBuffer);
    this.u8View = new Uint8Array(this.lastBuffer);
  }

  static async load(options: { wasmBytes?: BufferSource; wasmUrl?: string | URL } = {}): Promise<WasmBridge> {
    let instance: WebAssembly.Instance;
    if (options.wasmBytes) {
      const mod = await WebAssembly.instantiate(options.wasmBytes, {});
      instance = mod.instance;
    } else {
      const url = options.wasmUrl ?? new URL('../../wasm/quark_core.wasm', import.meta.url);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch quark_core.wasm (${response.status})`);
      }
      const bytes = await response.arrayBuffer();
      const mod = await WebAssembly.instantiate(bytes, {});
      instance = mod.instance;
    }
    return new WasmBridge(instance.exports as unknown as CoreExports);
  }

  private refreshViews(): void {
    const buf = this.exports.memory.buffer;
    if (buf !== this.lastBuffer) {
      this.lastBuffer = buf;
      this.f32View = new Float32Array(buf);
      this.i32View = new Int32Array(buf);
      this.u32View = new Uint32Array(buf);
      this.u16View = new Uint16Array(buf);
      this.u8View = new Uint8Array(buf);
    }
  }

  alloc(bytes: number): number {
    const ptr = this.exports.quark_alloc(bytes);
    this.refreshViews();
    return ptr;
  }

  dealloc(ptr: number, bytes: number): void {
    this.exports.quark_dealloc(ptr, bytes);
  }

  getWasmMemoryBytes(): number {
    this.refreshViews();
    return this.lastBuffer.byteLength;
  }

  clear(): void {
    this.exports.core_clear(this.corePtr);
  }

  setGravity(x: number, y: number, z: number): void {
    this.exports.core_set_gravity(this.corePtr, x, y, z);
  }

  setFixedDt(fixedDt: number): void {
    this.exports.core_set_fixed_dt(this.corePtr, fixedDt);
  }

  spawn(): number {
    const id = this.exports.core_spawn(this.corePtr);
    this.refreshViews();
    return id;
  }

  despawn(entity: number): boolean {
    return this.exports.core_despawn(this.corePtr, entity) !== 0;
  }

  isAlive(entity: number): boolean {
    return this.exports.core_is_alive(this.corePtr, entity) !== 0;
  }

  aliveCount(): number {
    return this.exports.core_alive_count(this.corePtr);
  }

  setParent(child: number, parent: number): boolean {
    return this.exports.core_set_parent(this.corePtr, child, parent) !== 0;
  }

  setTransform(
    entity: number,
    px: number,
    py: number,
    pz: number,
    rx: number,
    ry: number,
    rz: number,
    rw: number,
    sx: number,
    sy: number,
    sz: number,
    immediate: boolean
  ): void {
    this.exports.core_set_transform(
      this.corePtr,
      entity,
      px,
      py,
      pz,
      rx,
      ry,
      rz,
      rw,
      sx,
      sy,
      sz,
      immediate ? 1 : 0
    );
  }

  getPosition(entity: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    this.refreshViews();
    const ok = this.exports.core_get_position(this.corePtr, entity, this.scratchPtr);
    if (!ok) return out;
    const base = this.scratchPtr >>> 2;
    out[0] = this.f32View[base];
    out[1] = this.f32View[base + 1];
    out[2] = this.f32View[base + 2];
    return out;
  }

  setVelocity(entity: number, vx: number, vy: number, vz: number): void {
    this.exports.core_set_velocity(this.corePtr, entity, vx, vy, vz);
  }

  getVelocity(entity: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    this.refreshViews();
    const ok = this.exports.core_get_velocity(this.corePtr, entity, this.scratchPtr);
    if (!ok) return out;
    const base = this.scratchPtr >>> 2;
    out[0] = this.f32View[base];
    out[1] = this.f32View[base + 1];
    out[2] = this.f32View[base + 2];
    return out;
  }

  setRigidBody(
    entity: number,
    dynamic: boolean,
    gravityScale: number,
    restitution: number,
    friction: number,
    linearDamping = 0.12,
    angularDamping = 0.35,
    mass = 1.0,
    lockRotation = false
  ): void {
    this.exports.core_set_rigid_body_ex(
      this.corePtr,
      entity,
      dynamic ? 1 : 0,
      gravityScale,
      restitution,
      friction,
      linearDamping,
      angularDamping,
      mass,
      lockRotation ? 1 : 0
    );
  }

  setAngularVelocity(entity: number, wx: number, wy: number, wz: number): void {
    this.exports.core_set_angular_velocity(this.corePtr, entity, wx, wy, wz);
  }

  applyImpulse(
    entity: number,
    ix: number,
    iy: number,
    iz: number,
    px?: number,
    py?: number,
    pz?: number
  ): void {
    const hasPt = px !== undefined && py !== undefined && pz !== undefined ? 1 : 0;
    this.exports.core_apply_impulse(
      this.corePtr,
      entity,
      ix,
      iy,
      iz,
      px ?? 0,
      py ?? 0,
      pz ?? 0,
      hasPt
    );
  }

  isGrounded(entity: number): boolean {
    return this.exports.core_is_grounded(this.corePtr, entity) !== 0;
  }

  setCollider3D(entity: number, kind: number, a: number, b: number, c: number): void {
    this.exports.core_set_collider_3d(this.corePtr, entity, kind, a, b, c);
  }

  setCollider2D(entity: number, kind: number, a: number, b: number): void {
    this.exports.core_set_collider_2d(this.corePtr, entity, kind, a, b);
  }

  addTileGrid2D(ox: number, oy: number, tileSize: number, width: number, height: number, solid: Uint8Array): void {
    const ptr = this.alloc(solid.byteLength);
    this.refreshViews();
    this.u8View.set(solid, ptr);
    this.exports.core_add_tile_grid_2d(this.corePtr, ox, oy, tileSize, width, height, ptr, solid.byteLength);
    this.dealloc(ptr, solid.byteLength);
  }

  addStaticMeshTriangles(entity: number, flatTriangles: Float32Array): void {
    const byteLen = flatTriangles.byteLength;
    const ptr = this.alloc(byteLen);
    this.refreshViews();
    this.f32View.set(flatTriangles, ptr >>> 2);
    this.exports.core_add_static_mesh_triangles(this.corePtr, entity, ptr, flatTriangles.length);
    this.dealloc(ptr, byteLen);
  }

  setSprite2D(
    entity: number,
    w: number,
    h: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    r: number,
    g: number,
    b: number,
    a: number,
    texId: number,
    layer: number
  ): void {
    this.exports.core_set_sprite_2d(this.corePtr, entity, w, h, u0, v0, u1, v1, r, g, b, a, texId, layer);
  }

  setMesh3D(entity: number, meshId: number, materialId: number, flags: number, boundsRadius: number): void {
    this.exports.core_set_mesh_3d(this.corePtr, entity, meshId, materialId, flags, boundsRadius);
  }

  step(frameDt: number, viewProj: Float32Array): number {
    this.refreshViews();
    this.f32View.set(viewProj.subarray(0, 16), this.scratchPtr >>> 2);
    const alpha = this.exports.core_step(this.corePtr, frameDt, this.scratchPtr);
    this.refreshViews();
    return alpha;
  }

  raycast3D(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    mask = 0xffffffff,
    sphereRadius = 0
  ): {
    entity: number;
    distance: number;
    point: [number, number, number];
    normal: [number, number, number];
  } | null {
    this.refreshViews();
    const outPtr = this.scratchPtr + 64; // offset past 16 floats
    const hitEntity = this.exports.core_raycast_3d_ex(
      this.corePtr,
      ox,
      oy,
      oz,
      dx,
      dy,
      dz,
      maxDist,
      mask >>> 0,
      sphereRadius,
      outPtr
    );
    if (!hitEntity) return null;
    const base = outPtr >>> 2;
    return {
      entity: hitEntity,
      distance: this.f32View[base],
      point: [this.f32View[base + 1], this.f32View[base + 2], this.f32View[base + 3]],
      normal: [this.f32View[base + 4], this.f32View[base + 5], this.f32View[base + 6]],
    };
  }

  setTerrainHeightmap(
    entity: number,
    originX: number,
    originZ: number,
    cellSize: number,
    width: number,
    height: number,
    heights: Float32Array
  ): void {
    const ptr = this.alloc(heights.byteLength);
    try {
      this.refreshViews();
      this.f32View.set(heights, ptr >>> 2);
      this.exports.core_set_terrain_heightmap(
        this.corePtr,
        entity,
        originX,
        originZ,
        cellSize,
        width,
        height,
        ptr,
        heights.length
      );
    } finally {
      this.dealloc(ptr, heights.byteLength);
    }
  }

  sampleTerrainHeight(
    x: number,
    z: number
  ): { height: number; normal: [number, number, number] } | null {
    this.refreshViews();
    const outPtr = this.scratchPtr + 64;
    const h = this.exports.core_sample_terrain_height(this.corePtr, x, z, outPtr);
    if (Number.isNaN(h)) return null;
    const base = outPtr >>> 2;
    return {
      height: h,
      normal: [this.f32View[base], this.f32View[base + 1], this.f32View[base + 2]],
    };
  }

  buildNavGrid3D(
    originX: number,
    originZ: number,
    cellSize: number,
    width: number,
    height: number,
    minY: number,
    maxY: number,
    agentRadius: number
  ): void {
    this.exports.core_nav_build_3d(
      this.corePtr,
      originX,
      originZ,
      cellSize,
      width,
      height,
      minY,
      maxY,
      agentRadius
    );
  }

  buildNavGrid2D(): void {
    this.exports.core_nav_build_2d(this.corePtr);
  }

  setNavBlocked(cx: number, cz: number, blocked: boolean): void {
    this.exports.core_nav_set_blocked(this.corePtr, cx, cz, blocked ? 1 : 0);
  }

  findNavPath(
    sx: number,
    sz: number,
    gx: number,
    gz: number,
    smooth = true
  ): Array<[number, number]> {
    const pts = this.exports.core_nav_find_path(this.corePtr, sx, sz, gx, gz, smooth ? 1 : 0);
    if (pts === 0) return [];
    this.refreshViews();
    const ptr = this.exports.core_nav_path_ptr(this.corePtr);
    const len = this.exports.core_nav_path_len(this.corePtr);
    if (!ptr || len < 2) return [];
    const base = ptr >>> 2;
    const out: Array<[number, number]> = [];
    for (let i = 0; i + 1 < len; i += 2) {
      out.push([this.f32View[base + i], this.f32View[base + i + 1]]);
    }
    return out;
  }

  getBoneWorldTransform(
    entity: number,
    jointIndex: number
  ): { position: [number, number, number]; rotation: [number, number, number, number] } | null {
    this.refreshViews();
    const outPtr = this.scratchPtr + 64;
    const ok = this.exports.core_get_bone_transform(this.corePtr, entity, jointIndex, outPtr);
    if (!ok) return null;
    const base = outPtr >>> 2;
    return {
      position: [this.f32View[base], this.f32View[base + 1], this.f32View[base + 2]],
      rotation: [
        this.f32View[base + 3],
        this.f32View[base + 4],
        this.f32View[base + 5],
        this.f32View[base + 6],
      ],
    };
  }

  getWorldMatricesView(): Float32Array {
    this.refreshViews();
    const ptr = this.exports.core_matrices_ptr(this.corePtr);
    const len = this.exports.core_matrices_len(this.corePtr);
    if (!ptr || len === 0) return new Float32Array(0);
    const start = ptr >>> 2;
    return this.f32View.subarray(start, start + len);
  }

  getRender2DView(): Float32Array {
    this.refreshViews();
    const ptr = this.exports.core_render_2d_ptr(this.corePtr);
    const len = this.exports.core_render_2d_len(this.corePtr);
    if (!ptr || len === 0) return new Float32Array(0);
    const start = ptr >>> 2;
    return this.f32View.subarray(start, start + len);
  }

  getRender2DTexView(): Uint32Array {
    this.refreshViews();
    const ptr = this.exports.core_render_2d_tex_ptr(this.corePtr);
    const len = this.exports.core_render_2d_tex_len(this.corePtr);
    if (!ptr || len === 0) return new Uint32Array(0);
    const start = ptr >>> 2;
    return this.u32View.subarray(start, start + len);
  }

  getRender3DView(): Uint32Array {
    this.refreshViews();
    const ptr = this.exports.core_render_3d_ptr(this.corePtr);
    const len = this.exports.core_render_3d_len(this.corePtr);
    if (!ptr || len === 0) return new Uint32Array(0);
    const start = ptr >>> 2;
    return this.u32View.subarray(start, start + len);
  }

  setCollisionFilter(entity: number, layer: number, mask: number): void {
    this.exports.core_set_collision_filter(this.corePtr, entity, layer >>> 0, mask >>> 0);
  }

  setTrigger(entity: number, isTrigger: boolean): void {
    this.exports.core_set_trigger(this.corePtr, entity, isTrigger ? 1 : 0);
  }

  setCharacterController(entity: number, stepHeight: number, maxSlopeDeg: number): void {
    this.exports.core_set_character_controller(this.corePtr, entity, stepHeight, maxSlopeDeg);
  }

  addDistanceJoint(
    entityA: number,
    entityB: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    restLength: number,
    stiffness: number
  ): number {
    return this.exports.core_add_distance_joint(
      this.corePtr,
      entityA,
      entityB,
      ax,
      ay,
      az,
      bx,
      by,
      bz,
      restLength,
      stiffness
    );
  }

  addSpringJoint(
    entityA: number,
    entityB: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    restLength: number,
    stiffness: number,
    damping: number
  ): number {
    return this.exports.core_add_spring_joint(
      this.corePtr,
      entityA,
      entityB,
      ax,
      ay,
      az,
      bx,
      by,
      bz,
      restLength,
      stiffness,
      damping
    );
  }

  addHingeJoint(
    entityA: number,
    entityB: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    axisX: number,
    axisY: number,
    axisZ: number,
    hasLimits: boolean,
    minAngle: number,
    maxAngle: number
  ): number {
    return this.exports.core_add_hinge_joint(
      this.corePtr,
      entityA,
      entityB,
      ax,
      ay,
      az,
      bx,
      by,
      bz,
      axisX,
      axisY,
      axisZ,
      hasLimits ? 1 : 0,
      minAngle,
      maxAngle
    );
  }

  removeJoint(jointId: number): boolean {
    return this.exports.core_remove_joint(this.corePtr, jointId) !== 0;
  }

  isSleeping(entity: number): boolean {
    return this.exports.core_is_sleeping(this.corePtr, entity) !== 0;
  }

  forEachPhysicsEvent(
    cb: (kind: number, entityA: number, entityB: number, nx: number, ny: number, nz: number) => void
  ): void {
    this.refreshViews();
    const ptr = this.exports.core_events_ptr(this.corePtr);
    const len = this.exports.core_events_len(this.corePtr);
    if (!ptr || len < 6) return;
    const base = ptr >>> 2;
    for (let i = 0; i + 5 < len; i += 6) {
      const off = base + i;
      cb(
        this.u32View[off],
        this.u32View[off + 1],
        this.u32View[off + 2],
        this.f32View[off + 3],
        this.f32View[off + 4],
        this.f32View[off + 5]
      );
    }
  }

  playAnimation(
    entity: number,
    skeletonId: number,
    clipId: number,
    speed = 1.0,
    loop = true,
    fadeSec = 0.2
  ): void {
    this.exports.core_play_animation(
      this.corePtr,
      entity,
      skeletonId,
      clipId,
      speed,
      loop ? 1 : 0,
      fadeSec
    );
  }

  getBonePalettesView(): Float32Array {
    this.refreshViews();
    const ptr = this.exports.core_bone_palettes_ptr(this.corePtr);
    const len = this.exports.core_bone_palettes_len(this.corePtr);
    if (!ptr || len === 0) return new Float32Array(0);
    const start = ptr >>> 2;
    return this.f32View.subarray(start, start + len);
  }

  getPaletteOffsetsView(): Int32Array {
    this.refreshViews();
    const ptr = this.exports.core_palette_offsets_ptr(this.corePtr);
    const len = this.exports.core_palette_offsets_len(this.corePtr);
    if (!ptr || len === 0) return new Int32Array(0);
    const start = ptr >>> 2;
    return this.i32View.subarray(start, start + len);
  }

  parseGlb(bytes: Uint8Array): ParsedGlbResult {
    const ptr = this.alloc(bytes.byteLength);
    try {
      this.refreshViews();
      this.u8View.set(bytes, ptr);
      const status = this.exports.core_parse_glb(this.corePtr, ptr, bytes.byteLength);
      if (status !== 0) {
        throw new Error(`Failed to parse GLB binary (code ${status})`);
      }
      this.refreshViews();

      const vPtr = this.exports.core_glb_vertices_ptr(this.corePtr);
      const vLen = this.exports.core_glb_vertices_len(this.corePtr);
      const iPtr = this.exports.core_glb_indices_ptr(this.corePtr);
      const iLen = this.exports.core_glb_indices_len(this.corePtr);
      const jPtr = this.exports.core_glb_joints_ptr(this.corePtr);
      const jLen = this.exports.core_glb_joints_len(this.corePtr);
      const wPtr = this.exports.core_glb_weights_ptr(this.corePtr);
      const wLen = this.exports.core_glb_weights_len(this.corePtr);
      const sPtr = this.exports.core_glb_submeshes_ptr(this.corePtr);
      const sLen = this.exports.core_glb_submeshes_len(this.corePtr);
      const bPtr = this.exports.core_glb_bounds_ptr(this.corePtr);

      const vertices = this.f32View.slice(vPtr >>> 2, (vPtr >>> 2) + vLen);
      const indices = this.u32View.slice(iPtr >>> 2, (iPtr >>> 2) + iLen);
      const joints = jPtr && jLen > 0 ? this.u16View.slice(jPtr >>> 1, (jPtr >>> 1) + jLen) : new Uint16Array(0);
      const weights = wPtr && wLen > 0 ? this.f32View.slice(wPtr >>> 2, (wPtr >>> 2) + wLen) : new Float32Array(0);

      const subFloats = this.f32View.subarray(sPtr >>> 2, (sPtr >>> 2) + sLen);
      const bOff = bPtr >>> 2;
      const boundsMin: [number, number, number] = [
        this.f32View[bOff],
        this.f32View[bOff + 1],
        this.f32View[bOff + 2],
      ];
      const boundsMax: [number, number, number] = [
        this.f32View[bOff + 3],
        this.f32View[bOff + 4],
        this.f32View[bOff + 5],
      ];

      const submeshes: ParsedGlbSubmesh[] = [];
      for (let i = 0; i + 15 < subFloats.length; i += 16) {
        submeshes.push({
          indexOffset: subFloats[i],
          indexCount: subFloats[i + 1],
          baseColor: [subFloats[i + 2], subFloats[i + 3], subFloats[i + 4], subFloats[i + 5]],
          metallic: subFloats[i + 6],
          roughness: subFloats[i + 7],
          emissiveFactor: [subFloats[i + 8], subFloats[i + 9], subFloats[i + 10]],
          baseColorTexIndex: Math.round(subFloats[i + 11]),
          normalTexIndex: Math.round(subFloats[i + 12]),
          metallicRoughnessTexIndex: Math.round(subFloats[i + 13]),
          emissiveTexIndex: Math.round(subFloats[i + 14]),
          role: Math.round(subFloats[i + 15]),
        });
      }

      const images: ParsedGlbResult['images'] = [];
      const imgCount = this.exports.core_glb_image_count(this.corePtr);
      for (let i = 0; i < imgCount; i++) {
        const dPtr = this.exports.core_glb_image_ptr(this.corePtr, i);
        const dLen = this.exports.core_glb_image_len(this.corePtr, i);
        const mPtr = this.exports.core_glb_image_mime_ptr(this.corePtr, i);
        const mLen = this.exports.core_glb_image_mime_len(this.corePtr, i);
        const imgBytes = dPtr && dLen > 0 ? this.u8View.slice(dPtr, dPtr + dLen) : new Uint8Array(0);
        const mimeType = mPtr && mLen > 0 ? this.textDecoder.decode(this.u8View.subarray(mPtr, mPtr + mLen)) : 'image/png';
        images.push({ mimeType, bytes: imgBytes });
      }

      const colPtr = this.exports.core_glb_collider_tris_ptr(this.corePtr);
      const colLen = this.exports.core_glb_collider_tris_len(this.corePtr);
      const colliderTriangles =
        colPtr && colLen > 0 ? this.f32View.slice(colPtr >>> 2, (colPtr >>> 2) + colLen) : new Float32Array(0);

      const trigPtr = this.exports.core_glb_triggers_ptr(this.corePtr);
      const trigLen = this.exports.core_glb_triggers_len(this.corePtr);
      const triggerBoxes: ParsedGlbResult['triggerBoxes'] = [];
      if (trigPtr && trigLen >= 6) {
        const tf = this.f32View.subarray(trigPtr >>> 2, (trigPtr >>> 2) + trigLen);
        for (let i = 0; i + 5 < tf.length; i += 6) {
          triggerBoxes.push({
            center: [tf[i], tf[i + 1], tf[i + 2]],
            halfExtents: [tf[i + 3], tf[i + 4], tf[i + 5]],
          });
        }
      }

      let skeletonId: number | null = null;
      const clips: ParsedGlbResult['clips'] = [];
      if (this.exports.core_glb_has_skeleton(this.corePtr) !== 0) {
        const skelRes = this.exports.core_glb_register_animations(this.corePtr, this.scratchPtr);
        this.refreshViews();
        if (skelRes >= 0) {
          skeletonId = skelRes;
          const firstClipId = this.u32View[this.scratchPtr >>> 2];
          const clipCount = this.exports.core_glb_clip_count(this.corePtr);
          for (let i = 0; i < clipCount; i++) {
            const nPtr = this.exports.core_glb_clip_name_ptr(this.corePtr, i);
            const nLen = this.exports.core_glb_clip_name_len(this.corePtr, i);
            const name = nPtr && nLen > 0
              ? this.textDecoder.decode(this.u8View.subarray(nPtr, nPtr + nLen))
              : `Clip_${i}`;
            clips.push({ clipId: firstClipId + i, name });
          }
        }
      }

      return {
        vertices,
        indices,
        joints,
        weights,
        submeshes,
        images,
        colliderTriangles,
        triggerBoxes,
        skeletonId,
        clips,
        boundsMin,
        boundsMax,
      };
    } finally {
      this.exports.core_glb_clear(this.corePtr);
      this.dealloc(ptr, bytes.byteLength);
    }
  }

  dispose(): void {
    if (this.corePtr) {
      if (this.scratchPtr) {
        this.exports.quark_dealloc(this.scratchPtr, this.scratchBytes);
        this.scratchPtr = 0;
      }
      this.exports.core_destroy(this.corePtr);
      this.corePtr = 0;
    }
  }
}
