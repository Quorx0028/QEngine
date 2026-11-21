export interface ParsedGlbResult {
  vertices: Float32Array;
  indices: Uint32Array;
  submeshes: Array<{
    indexOffset: number;
    indexCount: number;
    baseColor: [number, number, number, number];
    metallic: number;
    roughness: number;
  }>;
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
  core_matrices_ptr(ptr: number): number;
  core_matrices_len(ptr: number): number;
  core_render_2d_ptr(ptr: number): number;
  core_render_2d_len(ptr: number): number;
  core_render_2d_tex_ptr(ptr: number): number;
  core_render_2d_tex_len(ptr: number): number;
  core_render_3d_ptr(ptr: number): number;
  core_render_3d_len(ptr: number): number;
  core_parse_glb(ptr: number, bytesPtr: number, bytesLen: number): number;
  core_glb_vertices_ptr(ptr: number): number;
  core_glb_vertices_len(ptr: number): number;
  core_glb_indices_ptr(ptr: number): number;
  core_glb_indices_len(ptr: number): number;
  core_glb_submeshes_ptr(ptr: number): number;
  core_glb_submeshes_len(ptr: number): number;
  core_glb_bounds_ptr(ptr: number): number;
  core_glb_clear(ptr: number): void;
}

export class WasmBridge {
  private readonly exports: CoreExports;
  private corePtr: number;
  private scratchPtr: number;
  private readonly scratchBytes = 64 * 4; // 64 floats scratch (viewProj + vec3 + rayhit)

  private f32View: Float32Array;
  private u32View: Uint32Array;
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
    this.u32View = new Uint32Array(this.lastBuffer);
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
      this.u32View = new Uint32Array(buf);
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
    maxDist: number
  ): {
    entity: number;
    distance: number;
    point: [number, number, number];
    normal: [number, number, number];
  } | null {
    this.refreshViews();
    const outPtr = this.scratchPtr + 64; // offset past 16 floats
    const hitEntity = this.exports.core_raycast_3d(this.corePtr, ox, oy, oz, dx, dy, dz, maxDist, outPtr);
    if (!hitEntity) return null;
    const base = outPtr >>> 2;
    return {
      entity: hitEntity,
      distance: this.f32View[base],
      point: [this.f32View[base + 1], this.f32View[base + 2], this.f32View[base + 3]],
      normal: [this.f32View[base + 4], this.f32View[base + 5], this.f32View[base + 6]],
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
      const sPtr = this.exports.core_glb_submeshes_ptr(this.corePtr);
      const sLen = this.exports.core_glb_submeshes_len(this.corePtr);
      const bPtr = this.exports.core_glb_bounds_ptr(this.corePtr);

      const vertices = this.f32View.slice(vPtr >>> 2, (vPtr >>> 2) + vLen);
      const indices = this.u32View.slice(iPtr >>> 2, (iPtr >>> 2) + iLen);
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

      const submeshes: ParsedGlbResult['submeshes'] = [];
      for (let i = 0; i < subFloats.length; i += 8) {
        submeshes.push({
          indexOffset: subFloats[i],
          indexCount: subFloats[i + 1],
          baseColor: [subFloats[i + 2], subFloats[i + 3], subFloats[i + 4], subFloats[i + 5]],
          metallic: subFloats[i + 6],
          roughness: subFloats[i + 7],
        });
      }

      return { vertices, indices, submeshes, boundsMin, boundsMax };
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
