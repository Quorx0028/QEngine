# QuarkEngine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build QuarkEngine — a commercial-friendly, low-memory 2D/3D browser game and simulation engine packaged for `npm`/`pnpm`, powered by a Rust/WASM core, TypeScript WebGL2 renderer with composable shader block presets, Blender `.glb` import, jitter-free collisions, and an interactive walkable playground.

**Architecture:** `crates/quark-core` (Rust compiled to `wasm32-unknown-unknown` via raw `extern "C"` ABI) owns generational SoA ECS storage, fixed-timestep physics/collision solving, transform interpolation, `.glb` parsing, and frustum/layer render batching in linear memory. `packages/quark-engine` (TypeScript ESM + `.d.ts`) exposes the public `Engine`/`Scene`/`Input`/`Audio`/`AssetManager` API, refreshes zero-copy `TypedArray` views whenever WASM memory grows, and renders via `IRenderBackend` (`WebGL2Backend`) with composable GLSL shader block presets. `examples/playground` provides a playable 3D/2D arena with live shader preset mixing and `.glb` drag-and-drop.

**Tech Stack:** Rust (`rustc 1.100`, `glam`, `gltf`, `bytemuck`), TypeScript, WebGL2 / GLSL 300 es, Vite, Vitest, Node/npm (pnpm-compatible).

**Spec:** `docs/superpowers/specs/2026-11-21-quark-engine-design.md`

## Global Constraints

- **Dependencies license floor:** Only MIT, Apache-2.0, BSD, ISC, or Zlib dependencies (zero GPL/AGPL/LGPL).
- **Zero Rust requirement for package consumers:** End users install via `pnpm`/`npm` and write 100% TypeScript/JavaScript; pre-built `.wasm` ships inside `packages/quark-engine`.
- **Package manager compatibility:** Workspace and scripts must run cleanly under both `npm` and `pnpm`.
- **No per-frame JS allocations in hot loop:** Physics, culling, sorting, and interpolated transform generation write into flat WASM buffers read via `TypedArray` views.
- **No subagents:** Execute all work inline in the main session (`executing-plans`).

## Review Focus

- **WASM memory growth detachment:** Calling `core_alloc` or loading a large `.glb` triggers `memory.grow`, detaching cached `Float32Array` views on the TS side; `WasmBridge` must detect `view.buffer !== memory.buffer` and rebind before any read.
- **Tab-switch spiral of death:** Huge `dt` (e.g. `5.0s` after backgrounding a tab) must clamp to `<= 0.1s` so physics sub-stepping never freezes the browser.
- **Tile/mesh seam snagging:** A capsule or 2D circle sliding along adjacent wall AABBs or grid tiles must not catch on internal corners/seams.
- **GLB malformed or unsupported attributes:** Loading a `.glb` missing normals/UVs or with `u16`/`u32`/`u8` indices must either compute/default gracefully or return a clear typed error without panicking WASM.
- **GPU & WASM resource leaks on scene switch:** Calling `scene.dispose()` or `assetManager.unloadTag(tag)` must release both WebGL buffers/textures and WASM mesh/collider slots.

---

### Task 1: Workspace Setup & Rust WASM Core Skeleton

**Files:**
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `package.json`
- Create: `crates/quark-core/Cargo.toml`
- Create: `crates/quark-core/src/lib.rs`

**Interfaces:**
- Consumes: none (root setup)
- Produces:
  - `quark_alloc(len: usize) -> *mut u8`
  - `quark_dealloc(ptr: *mut u8, len: usize)`
  - `core_create() -> *mut EngineCore`
  - `core_destroy(ptr: *mut EngineCore)`
  - `core_abi_version() -> u32` (returns `1`)

- [ ] **Step 1: Initialize git, `.gitignore`, `LICENSE` (MIT), and root `package.json`**

Run `git init` if `.git` does not exist. Ensure `rustup target list --installed` includes `wasm32-unknown-unknown` (run `rustup target add wasm32-unknown-unknown` if missing). Create root `package.json` with npm/pnpm-compatible `workspaces: ["packages/*", "examples/*"]` and scripts `build:wasm`, `test:rust`, `test:ts`, `build`, `dev`.

- [ ] **Step 2: Write failing Rust test for allocator and `EngineCore` lifecycle**

In `crates/quark-core/src/lib.rs`, write `#[cfg(test)] mod tests` with `test_abi_version_and_lifecycle` asserting `core_abi_version() == 1`, `core_create()` returns non-null, and `quark_alloc(64)` / `quark_dealloc(ptr, 64)` round-trips cleanly.

- [ ] **Step 3: Run `cargo test` to verify RED**

Run: `cargo test --manifest-path crates/quark-core/Cargo.toml`
Expected: FAIL because `crates/quark-core/Cargo.toml` / functions do not exist yet.

- [ ] **Step 4: Implement `crates/quark-core/Cargo.toml` and `src/lib.rs`**

Add `glam = { version = "0.29", default-features = false, features = ["libm"] }`, `bytemuck = { version = "1.19", features = ["derive"] }`, `gltf = { version = "1.4", default-features = false, features = ["utils"] }`. Implement `EngineCore`, `quark_alloc`, `quark_dealloc`, `core_create`, `core_destroy`, `core_abi_version`.

- [ ] **Step 5: Run `cargo test` and `cargo build --target wasm32-unknown-unknown --release`**

Run: `cargo test --manifest-path crates/quark-core/Cargo.toml && cargo build --manifest-path crates/quark-core/Cargo.toml --target wasm32-unknown-unknown --release`
Expected: PASS and `.wasm` artifact emitted at `crates/quark-core/target/wasm32-unknown-unknown/release/quark_core.wasm`.

- [ ] **Step 6: Commit**

```bash
git add .gitignore LICENSE package.json crates/quark-core/Cargo.toml crates/quark-core/src/lib.rs
git commit -m "chore: bootstrap QuarkEngine workspace and quark-core WASM skeleton"
```

---

### Task 2: Generational ECS, SoA Component Pools & Transform Interpolation

**Files:**
- Create: `crates/quark-core/src/ecs.rs`
- Modify: `crates/quark-core/src/lib.rs`

**Interfaces:**
- Consumes: `glam::{Vec2, Vec3, Quat, Mat4}`
- Produces:
  - `pub type EntityHandle = u32;` (low 20 bits = index up to ~1M entities, high 12 bits = generation `1..=4095`; `0` invalid sentinel — avoids JS `BigInt` across WASM `extern "C"` ABI)
  - `pub struct World` with `spawn() -> EntityHandle`, `despawn(h: EntityHandle) -> bool`, `is_alive(h: EntityHandle) -> bool`, `set_parent(child, parent)`
  - SoA storage for `Transform3D` (`prev_pos`, `curr_pos`, `prev_rot`, `curr_rot`, `scale`), `Velocity3D`, `Sprite2D`, `MeshInstance3D`
  - `compute_interpolated_matrices(&mut self, alpha: f32)` updating `world_matrices: Vec<f32>` (16 `f32` per alive entity slot or dense render index)

- [ ] **Step 1: Write failing tests in `crates/quark-core/src/ecs.rs`**

Tests:
1. `test_generational_entity_reuse`: spawn `e1`, despawn `e1`, spawn `e2` -> `e1 != e2`, `is_alive(e1) == false`, `is_alive(e2) == true`, index slot is reused.
2. `test_transform_interpolation_alpha`: set `prev_pos = (0,0,0)`, `curr_pos = (10,0,0)`; at `alpha = 0.0` matrix translation is `0`, at `alpha = 0.5` it is `5`, at `alpha = 1.0` it is `10`.
3. `test_parent_child_world_matrix`: parent at `(10, 0, 0)`, child local at `(0, 5, 0)` -> child world translation is `(10, 5, 0)`.

- [ ] **Step 2: Run `cargo test` to verify RED**

Run: `cargo test --manifest-path crates/quark-core/Cargo.toml ecs`
Expected: FAIL (`ecs` module missing).

- [ ] **Step 3: Implement `crates/quark-core/src/ecs.rs` and wire into `EngineCore`**

Implement sparse-set / generational slot table, SoA component arrays, parent-child hierarchical world matrix computation (handles arbitrary tree depth iteratively or topologically without stack overflow), and `lerp`/`slerp` interpolation.

- [ ] **Step 4: Run `cargo test` to verify GREEN**

Run: `cargo test --manifest-path crates/quark-core/Cargo.toml`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/quark-core/src/ecs.rs crates/quark-core/src/lib.rs
git commit -m "feat(core): add generational SoA ECS and interpolated transform hierarchy"
```

---

### Task 3: Fixed-Timestep Jitter-Free Physics & Collision Solver (2D + 3D)

**Files:**
- Create: `crates/quark-core/src/physics.rs`
- Modify: `crates/quark-core/src/ecs.rs`
- Modify: `crates/quark-core/src/lib.rs`

**Interfaces:**
- Consumes: `World` transforms, velocities, collider components (`Collider3D::{Aabb, Sphere, Capsule}`, `Collider2D::{Aabb2D, Circle2D}`, `StaticTriMesh`, `TileGrid2D`)
- Produces:
  - `PhysicsConfig { fixed_dt: f32, max_frame_dt: f32, gravity: Vec3, max_substeps: u32 }`
  - `step_simulation(world: &mut World, frame_dt: f32) -> f32` (returns interpolation `alpha` in `[0.0, 1.0]`; clamps `frame_dt` to `max_frame_dt = 0.1`)
  - `raycast_3d(origin, dir, max_dist) -> Option<RayHit>`
  - `is_grounded(entity: EntityHandle) -> bool`

- [ ] **Step 1: Write failing physics tests in `crates/quark-core/src/physics.rs`**

Tests:
1. `test_clamp_huge_frame_dt_prevents_spiral`: passing `frame_dt = 5.0` steps at most `max_substeps` (`<= 6` steps for `0.1s` clamp) instead of 300 steps.
2. `test_capsule_wall_slide_without_jitter`: dynamic capsule moving diagonally `(5, 0, 5)` into a static wall AABB slides smoothly along the free axis with zero oscillation across 120 ticks.
3. `test_adjacent_tile_seam_no_snag`: 2D circle / 3D capsule moving parallel across two flush adjacent floor/wall AABBs (`[0..2]` and `[2..4]`) continues smoothly past `x = 2.0` without catching on the internal seam.
4. `test_gravity_ground_landing_and_stability`: falling body lands on floor AABB, sets `is_grounded == true`, and resting `y` stays constant (`|vy| < 1e-4`, no micro-bounce jitter).

- [ ] **Step 2: Run `cargo test` to verify RED**

Run: `cargo test --manifest-path crates/quark-core/Cargo.toml physics`
Expected: FAIL (`physics` module missing).

- [ ] **Step 3: Implement `crates/quark-core/src/physics.rs`**

Implement fixed-timestep accumulator, `prev = curr` snapshot before each fixed step, iterative multi-substep sweep/depenetration with minimum translation vector (MTV) and velocity projection along contact normal (prioritizing floor normals over internal seam edges via face-normal filtering / depenetration order), 2D `TileGrid2D` fast cell collision, and 3D `StaticTriMesh` AABB-broadphase + closest-point capsule/sphere narrowphase.

- [ ] **Step 4: Run `cargo test` to verify GREEN**

Run: `cargo test --manifest-path crates/quark-core/Cargo.toml`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/quark-core/src/physics.rs crates/quark-core/src/ecs.rs crates/quark-core/src/lib.rs
git commit -m "feat(core): add fixed-timestep 2D/3D collision solver with smooth wall sliding"
```

---

### Task 4: Blender `.glb`/`.gltf` Parser, Render Batching & C-ABI Exports

**Files:**
- Create: `crates/quark-core/src/gltf_loader.rs`
- Create: `crates/quark-core/src/render.rs`
- Modify: `crates/quark-core/src/lib.rs`

**Interfaces:**
- Consumes: `World`, `gltf` crate
- Produces:
  - `LoadedGltfAsset`: interleaved vertex buffer (`pos[3], normal[3], uv[2]`, stride `8 * f32`), `u32` index buffer, submeshes `(index_offset, index_count, base_color[4], metallic, roughness, bounds_min[3], bounds_max[3])`, plus optional flat triangle list for static colliders.
  - `RenderQueue`:
    - `items_2d: Vec<f32>` (12 floats per sprite: `x, y, z, w, h, rot, u0, v0, u1, v1, rgba_packed_or_color_idx, tex_id` — let's use 14 floats: `x, y, z, w, h, rot, u0, v0, u1, v1, r, g, b, a` + separate `tex_ids_2d: Vec<u32>`)
    - `items_3d: Vec<u32>` + `mats_3d: Vec<f32>` (each 3D draw command: `mesh_id, material_id, entity_slot_or_mat_idx, flags`, paired with `world_matrices`)
  - Complete `extern "C"` WASM ABI in `lib.rs` for TS `WasmBridge` (entity spawn/despawn, transform/velocity/collider setters, `core_step`, `core_load_glb`, buffer pointers/lengths, stats getters).

- [ ] **Step 1: Write failing tests for `.glb` parsing & 2D/3D render sorting**

Tests:
1. `test_parse_minimal_valid_glb`: build a tiny valid binary `.glb` in-memory in the test (single triangle mesh) and assert `parse_glb` extracts 3 vertices (`stride = 8`), 3 indices, and valid AABB bounds without errors; also test malformed bytes and missing normals (auto-generated flat normals, no panic).
2. `test_render_2d_y_and_layer_sorting`: two sprites on layer `0` at `y = 10` and `y = 2` -> emitted in painter order (`y = 10` back before `y = 2` front, or explicit `layer` ascending then `y` descending for top-down RPGs).
3. `test_render_3d_frustum_culling`: entity inside camera frustum is emitted; entity far behind camera is culled.

- [ ] **Step 2: Run `cargo test` to verify RED**

Run: `cargo test --manifest-path crates/quark-core/Cargo.toml gltf_loader render`
Expected: FAIL.

- [ ] **Step 3: Implement `gltf_loader.rs`, `render.rs`, and full `extern "C"` ABI in `lib.rs`**

Ensure graceful error codes (`i32 < 0`) on malformed GLB instead of panics, auto-generate normals/UVs when omitted in Blender exports, compute frustum planes from view-projection matrix, and expose raw linear-memory pointers/lengths for zero-copy TS views.

- [ ] **Step 4: Run `cargo test` and build `wasm32-unknown-unknown` release**

Run: `cargo test --manifest-path crates/quark-core/Cargo.toml && cargo build --manifest-path crates/quark-core/Cargo.toml --target wasm32-unknown-unknown --release`
Expected: PASS and `.wasm` builds cleanly without warnings.

- [ ] **Step 5: Commit**

```bash
git add crates/quark-core/src/gltf_loader.rs crates/quark-core/src/render.rs crates/quark-core/src/lib.rs
git commit -m "feat(core): add GLB loader, frustum culling, 2D/3D render batching, and WASM ABI"
```

---

### Task 5: TypeScript WASM Bridge, Memory-Growth Guard & Engine/Scene API

**Files:**
- Create: `packages/quark-engine/package.json`
- Create: `packages/quark-engine/tsconfig.json`
- Create: `packages/quark-engine/vitest.config.ts`
- Create: `packages/quark-engine/src/wasm/WasmBridge.ts`
- Create: `packages/quark-engine/src/Engine.ts`
- Create: `packages/quark-engine/src/Scene.ts`
- Create: `packages/quark-engine/src/Input.ts`
- Create: `packages/quark-engine/src/Audio.ts`
- Create: `packages/quark-engine/src/index.ts`
- Test: `packages/quark-engine/tests/wasm-bridge.test.ts`

**Interfaces:**
- Consumes: compiled `quark_core.wasm` (copied to `packages/quark-engine/wasm/quark_core.wasm` by `build:wasm` script)
- Produces:
  - `WasmBridge.load(bytesOrUrl)`: zero-copy `f32`/`u32`/`u8` memory view accessors that check `buffer !== memory.buffer` after every WASM call.
  - `Engine.init(options?: { canvas?: HTMLCanvasElement; wasmUrl?: string | URL; wasmBytes?: BufferSource })`
  - `Scene` with `createEntity()`, `destroyEntity()`, `addTransform()`, `addRigidBody()`, `addCollider3D()`, `addCollider2D()`, `addSprite()`, `addMesh()`, `raycast()`, `isGrounded()`, `dispose()`.
  - `Input` (keyboard state, mouse delta, pointer lock helpers) and `AudioSystem` (Web Audio BGM crossfade + SFX).

- [ ] **Step 1: Install TS devDependencies (`typescript`, `vitest`, `vite`) in workspace (all MIT)**

Verify installed package licenses are MIT/ISC/Apache-2.0. Copy `quark_core.wasm` via `npm run build:wasm`.

- [ ] **Step 2: Write failing integration tests against real compiled `.wasm` (`wasm-bridge.test.ts`)**

Tests:
1. `recovers TypedArray views when WASM memory grows`: allocate large buffers via `bridge.alloc` to force `memory.grow`, then read `getWorldMatricesView()` and verify it is not detached and reflects updated transforms.
2. `runs fixed-timestep capsule collision without jitter from TypeScript`: spawn floor + wall + capsule entity via `Scene`, step 60 frames, assert smooth wall slide and grounded state.
3. `parses a real GLB buffer in WASM and exposes vertex/index arrays cleanly`.

- [ ] **Step 3: Run `vitest` to verify RED**

Run: `npm --workspace packages/quark-engine test`
Expected: FAIL (`WasmBridge` / `Scene` not implemented).

- [ ] **Step 4: Implement `WasmBridge.ts`, `Engine.ts`, `Scene.ts`, `Input.ts`, `Audio.ts`, `index.ts`**

Keep `Engine` runnable headless in Node tests when `canvas` is omitted (skipping WebGL attach) so core WASM/Scene tests stay fast and dependency-free.

- [ ] **Step 5: Run `vitest` to verify GREEN**

Run: `npm --workspace packages/quark-engine test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/quark-engine
git commit -m "feat(engine): add TypeScript WASM bridge with memory-grow safety, Scene, Input, and Audio"
```

---

### Task 6: WebGL2 Backend, Composable Shader Block Presets & AssetManager

**Files:**
- Create: `packages/quark-engine/src/render/IRenderBackend.ts`
- Create: `packages/quark-engine/src/render/ShaderBlocks.ts`
- Create: `packages/quark-engine/src/render/ShaderPresets.ts`
- Create: `packages/quark-engine/src/render/Materials.ts`
- Create: `packages/quark-engine/src/render/WebGL2Backend.ts`
- Create: `packages/quark-engine/src/render/Primitives.ts`
- Create: `packages/quark-engine/src/assets/AssetManager.ts`
- Modify: `packages/quark-engine/src/Engine.ts`
- Modify: `packages/quark-engine/src/index.ts`
- Test: `packages/quark-engine/tests/shaders-and-assets.test.ts`

**Interfaces:**
- Consumes: `WasmBridge`, `Scene`
- Produces:
  - `ShaderBlocks`: composable GLSL 300 es blocks (`celLighting`, `rimLight`, `fresnelGlow`, `vertexWave`, `dissolveNoise`, `hologramScanline`, `pixelDither`, `triplanarGrid`, `distanceFog`) + `composeShader(config)`
  - `ShaderPresets`: `createPresetMaterial(name: 'pbr' | 'animeToon' | 'hologram' | 'dissolve' | 'retroDither' | 'waveSurface', overrides?)`
  - `Material` classes: `PBRMaterial`, `ToonMaterial` (with outline pass option), `SpriteMaterial`, `ShaderMaterial`
  - `Primitives`: procedural GPU-ready meshes (`createBox`, `createPlane`, `createSphere`, `createCapsule`, `createRamp`) so games and tests work with zero external files too
  - `WebGL2Backend`: instanced 2D sprite batcher, 3D lit + outline + custom shader pass, ACES tone mapping, deterministic resource `dispose()`
  - `AssetManager`: `loadGLB(urlOrBuffer, options?)`, `loadTexture(url, { pixelated })`, `unloadTag(tag)`, `dispose()`

- [ ] **Step 1: Write failing tests in `packages/quark-engine/tests/shaders-and-assets.test.ts`**

Tests:
1. `composes valid GLSL 300 es vertex and fragment shaders from selected ShaderBlocks` (checks `#version 300 es`, injected block functions, uniforms, and no duplicate definitions when toggling multiple blocks).
2. `creates all built-in ShaderPresets with typed default uniforms` (`pbr`, `animeToon`, `hologram`, `dissolve`, `retroDither`, `waveSurface`).
3. `AssetManager reference-counts resources and disposes tag-scoped meshes cleanly`.

- [ ] **Step 2: Run `vitest` to verify RED**

Run: `npm --workspace packages/quark-engine test`
Expected: FAIL.

- [ ] **Step 3: Implement `IRenderBackend`, `ShaderBlocks`, `ShaderPresets`, `Materials`, `Primitives`, `WebGL2Backend`, `AssetManager`, and integrate into `Engine`**

Ensure `WebGL2Backend` supports instanced 2D sprites (`drawArraysInstanced`), 3D meshes with `ToonMaterial` two-pass outline (front-face culling extruded along normals), `PBRMaterial` directional+hemisphere+point lighting, custom `ShaderMaterial` uniforms, and clean `dispose()` of all VAOs/VBOs/EBOs/textures/programs.

- [ ] **Step 4: Run `vitest` + `tsc --noEmit` to verify GREEN**

Run: `npm --workspace packages/quark-engine test && npm --workspace packages/quark-engine run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/quark-engine
git commit -m "feat(render): add WebGL2 backend, composable GLSL shader block presets, primitives, and AssetManager"
```

---

### Task 7: Playable 3D/2D Sandbox Scene, Shader Studio & Build Verification

**Files:**
- Create: `examples/playground/package.json`
- Create: `examples/playground/index.html`
- Create: `examples/playground/src/main.ts`
- Create: `examples/playground/src/sampleGlb.ts` (builds/loads a valid sample multi-part `.glb` monument on demand + supports user drag-and-drop of real Blender `.glb` files)
- Create: `examples/playground/vite.config.ts`
- Modify: `packages/quark-engine/package.json` (library build output `dist/` + `wasm/` + `exports`)
- Create: `README.md`

**Interfaces:**
- Consumes: `quark-engine` (`Engine`, `Scene`, `Input`, `ShaderPresets`, `composeShader`, `Primitives`, `AssetManager`)
- Produces:
  - Playable browser demo with:
    1. **3D Walkable Arena:** WASD movement, mouse look (click canvas for pointer lock, or drag/arrow keys fallback), Space jump, Shift sprint, smooth capsule sliding along walls, pillars, and a ramp; spawn dynamic test cubes/spheres; drop any Blender `.glb` onto the window to load it into the arena.
    2. **2D / 2.5D OMORI-style Mode:** One-click switch to top-down 2D pixel-crisp scene with Y-sorted procedural sprite characters, tilemap wall collisions without seam snagging, and camera follow.
    3. **Shader Block Preset Studio HUD:** Switch material preset (`pbr`, `animeToon`, `hologram`, `dissolve`, `retroDither`, `waveSurface`), toggle composable shader blocks (`rimLight`, `fresnelGlow`, `vertexWave`, `pixelDither`, `distanceFog`), tweak live sliders (`celSteps`, `dissolve`, `waveAmp`, `outlineWidth`), and watch live telemetry (FPS, frame ms, WASM memory KB, entities, draw calls).

- [ ] **Step 1: Implement `packages/quark-engine` library build (`npm run build`) and verify `dist/` exports**

Verify ESM bundle, `.d.ts` declarations, and bundled `quark_core.wasm` emit cleanly into `packages/quark-engine/dist/`.

- [ ] **Step 2: Implement `examples/playground` (`index.html`, `main.ts`, `sampleGlb.ts`, `vite.config.ts`) and `README.md`**

Keep UI crisp and minimal (no clutter): canvas fills viewport, compact floating test & shader-block control panel, clear keybinding hint (`WASD`, `Space`, `Shift`, `Click` to look, drag `.glb` to test Blender model).

- [ ] **Step 3: Run full test suite (`cargo test` + `vitest`), library build, and playground production build (`vite build`)**

Run: `npm run test && npm run build`
Expected: All Rust tests pass, all TypeScript tests pass, `quark-engine` package builds cleanly, and `examples/playground` builds with zero errors.

- [ ] **Step 4: Live browser / dev server check**

Start Vite dev server on `examples/playground` and verify headless/live page loads without console or WebGL shader compilation errors (using Playwright/headless check if available or verifying shader compilation & server response cleanly; report exact observed result).

- [ ] **Step 5: Commit**

```bash
git add examples/playground packages/quark-engine README.md package.json
git commit -m "feat(playground): add walkable 3D/2D sandbox, shader block presets studio, and package build"
```

---

## Self-Review Notes
- **Spec coverage:** Every section of `2026-11-21-quark-engine-design.md` (MIT/Apache-2.0 licenses, Rust/WASM SoA ECS + interpolation, jitter-free 2D/3D collisions, `.glb` Blender loader, `IRenderBackend` + WebGL2 + Shader Block Presets, `AssetManager` disposal, and playable playground) maps directly to Tasks 1–7.
- **Type consistency:** `EntityHandle` (`u64` / `bigint` or packed safe `number` in TS? Wait — **builder catch!** In JavaScript/TypeScript, `u64` over `extern "C"` passes as `BigInt` (`bigint`) in WASM! Either use `u32` packed generational handle `(gen << 20) | index` — 1M simultaneous entities * 4096 generations, fits cleanly in `u32` / JS `number` with zero `BigInt` overhead! — OR pass `u64` as `BigInt`. Let's use **packed `u32` handle** (`12` bits generation = 4096 reuses per slot, `20` bits index = up to 1,048,575 simultaneous entities) OR `u64`? Actually `1,048,575` simultaneous entities and `4096` generations per slot in `u32` is super fast, zero `BigInt`, works seamlessly across `Uint32Array` and `extern "C"`! Let's standardize on `pub type EntityHandle = u32;` with `0` = invalid (`generation` starts at `1`, wraps `1..=4095` skipping `0`)! Let's fix that note right in Task 2 below so there's zero mismatch between Rust and TS!).
