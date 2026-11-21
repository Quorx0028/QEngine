# QEngine — Global Improvement Roadmap & Architecture Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan milestone-by-milestone. Each milestone must ship with passing Rust (`cargo test`), TypeScript (`vitest`), and build/browser checks.

**Goal:** Evolve QEngine from a working v0.1 prototype into a production-ready, commercially sellable 2D/2.5D/3D browser game & simulation library (`npm`/`pnpm`) with full Blender animation/material import, scalable BVH/sleeping physics + trigger events, post-processing, 2D RPG tooling, particles, debug gizmos, and optional WebGPU backend.

**Architecture:** Keep the zero-GC Rust/WASM linear-memory core (`crates/quark-core`) + zero-copy `TypedArray` bridge (`WasmBridge.ts`) + pluggable `IRenderBackend` (`WebGL2Backend` and future `WebGPUBackend`). All new heavy systems (BVH, broadphase, skeletal skinning evaluation, collision event ring-buffer, particle simulation) stay in Rust linear memory; rendering, asset decoding, and ergonomic game APIs stay in tree-shakeable TypeScript.

**Tech Stack:** Rust (`wasm32-unknown-unknown`, `glam`, `gltf`, `bytemuck`, `wasm-opt`), TypeScript ESM, WebGL2 / GLSL 300 es (+ WebGPU / WGSL option), Vite, Vitest, Playwright (for automated WebGL2 visual smoke tests).

**Spec:** `docs/superpowers/specs/2026-11-21-quark-engine-design.md`

## Global Constraints

- **License purity:** Only MIT, Apache-2.0, BSD, ISC, or Zlib dependencies across Rust and npm (zero GPL/AGPL/LGPL).
- **Bundle & RAM discipline:** Keep core `.wasm` under 500 KB gzipped via `wasm-opt -Oz`, zero per-frame JS allocations in the render/physics loop, and deterministic `.dispose()` / tag unloading for 100+ hour games.
- **Zero Rust requirement for end users:** Game developers install via `pnpm`/`npm` and write 100% TypeScript/JavaScript.
- **Backward-compatible API:** Preserve `Engine.init`, `Scene`, `AssetManager`, and `ShaderPresets` ergonomics as milestones land.

## Review Focus

- **Large Blender `.glb` levels (50k+ triangles) & O(N²) collision stalls:** Solved in Milestone 1 via StaticTriMesh BVH + Spatial Hash broadphase + RigidBody sleeping.
- **Memory leaks across 100+ scene transitions:** Solved via automated ref-count & WebGL resource-leak assertions in Milestone 3 & 6.
- **Multi-submesh / skinned Blender models rendering with wrong materials or T-pose:** Solved in Milestone 2 via submesh material arrays and Rust bone-matrix palette buffer.
- **Shader compilation stutters on first spawn:** Solved in Milestone 3 via pre-warm / async shader compile cache.
- **Debug gizmos shipping into final game bundles:** Solved in Milestone 6 via tree-shakeable `DebugOverlay` / `?debug` module split.

---

### Milestone 1: Core Scalability, Collision Events & WASM Optimization

**Files:**
- Modify: `crates/quark-core/src/physics.rs` (BVH for `StaticTriMesh`, Spatial Hash broadphase, RigidBody `sleeping` state, trigger/sensor colliders, event ring buffer)
- Modify: `crates/quark-core/src/ecs.rs` (trigger flags, layer/mask bitfields for collision filtering)
- Modify: `crates/quark-core/src/lib.rs` (export `core_events_ptr`, `core_events_len`, `core_set_collision_mask`)
- Modify: `packages/quark-engine/src/wasm/WasmBridge.ts` & `Scene.ts` (`onCollision`, `onTrigger`, `setCollisionLayer`)
- Modify: `scripts/copy-wasm.mjs` (optional `wasm-opt -Oz` pass when available)

**Interfaces:**
- Produces:
  - Collision/Trigger event buffer (`[eventType: u32, entityA: u32, entityB: u32, normalX/Y/Z: f32]`)
  - `StaticTriMesh` 2-level BVH (triangle AABB tree built once on load)
  - Spatial hash broadphase grid for dynamic bodies + velocity/angular sleep threshold

**Deliverables & Verification:**
- [ ] **TDD Step 1:** Rust benchmark/unit tests: 500 stacked/scattered dynamic bodies step in `< 2ms` with broadphase + sleeping; 20,000-triangle `StaticTriMesh` raycast & capsule query visits `< 64` triangles via BVH; trigger volume emits `TriggerEnter` / `TriggerExit` without applying physical push.
- [ ] **TDD Step 2:** TypeScript integration test verifying `scene.onTriggerEnter` / `scene.onCollisionEnter` callbacks fire from WASM ring-buffer and respect `layer`/`mask` bitflags.
- [ ] **Verify:** `cargo test`, `vitest run`, `wasm-opt -Oz` size check.

---

### Milestone 2: Full Blender `.glb` Pipeline (Textures, Multi-Material & Skeletal Animation)

**Files:**
- Modify: `crates/quark-core/src/gltf_loader.rs` (extract embedded image bytes/MIME per texture slot, multi-primitive submesh material indices, `Skin` joints + `InverseBindMatrices`, `AnimationClip` channels for translation/rotation/scale)
- Create: `crates/quark-core/src/animation.rs` (`AnimationPlayer` component, keyframe interpolation, crossfade blending, bone matrix palette `Vec<f32>` in WASM linear memory)
- Modify: `packages/quark-engine/src/assets/AssetManager.ts` (decode embedded PNG/JPEG via `createImageBitmap` into WebGL2 textures: albedo, normal, metallicRoughness, emissive; attach material array per `LoadedMeshHandle`)
- Modify: `packages/quark-engine/src/render/ShaderBlocks.ts` & `WebGL2Backend.ts` (vertex skinning `a_joints` + `a_weights` + `u_boneMatrices[64]`, multi-submesh draw loop, normal map tangent-space perturbation)

**Interfaces:**
- Produces:
  - `scene.playAnimation(entity, clipName, { loop, fadeSec, speed })`
  - `LoadedMeshHandle.materials: number[]` + `animations: string[]`

**Deliverables & Verification:**
- [ ] **TDD Step 1:** Rust test with a skinned 2-bone `.glb` fixture verifying bone matrix palette interpolation at `t = 0.0 / 0.5 / 1.0`.
- [ ] **TDD Step 2:** TS test verifying multi-submesh `.glb` maps distinct base colors/textures per primitive and cleans up all decoded textures on `unloadTag()`.
- [ ] **Verify:** Drop an animated rigged Blender `.glb` character into the playground and verify smooth animation + PBR/AnimeToon + outline rendering.

---

### Milestone 3: Renderer 2.0 (3D Instancing, Post-Processing & 2.5D Billboards)

**Files:**
- Create: `packages/quark-engine/src/render/PostProcess.ts` (`PostProcessStack`: HDR offscreen FBO, threshold Bloom, Vignette, Chromatic Aberration, CRT/Pixelate pass, Screen-Space Depth/Normal Outline, Color LUT/Grading)
- Modify: `packages/quark-engine/src/render/WebGL2Backend.ts` (3D hardware instancing `drawElementsInstanced` for shared `(meshId, materialId)` batches; tangent-space normal maps + emissive + metallicRoughness textures; 2.5D camera-facing billboard sprite flag)
- Modify: `packages/quark-engine/src/render/ShaderBlocks.ts` (instanced `a_instanceMat` vertex path, emissive glow feeding Bloom threshold)

**Interfaces:**
- Produces:
  - `scene.postProcess: { bloom: boolean; bloomIntensity: number; crt: boolean; vignette: number; pixelScale: number; chromaticAberration: number }`
  - `scene.setSprite2D(..., { billboard3D?: boolean })`

**Deliverables & Verification:**
- [ ] **TDD Step 1:** Test `PostProcessStack` shader composition & resize/dispose FBO lifecycle; test 3D instancing batch grouping in Rust `RenderQueue` (`items_3d_instanced`).
- [ ] **Verify:** 1,000 instanced 3D props render in 1–2 draw calls at 60 FPS with Bloom + CRT/Anime post-FX toggles.

---

### Milestone 4: Character Controller, Puzzle Joints & 2D RPG Toolkit

**Files:**
- Create: `crates/quark-core/src/character.rs` (`CharacterController3D`: `move_and_slide`, stair step-up `max_step_height`, `max_slope_deg`, moving-platform delta carry, coyote time helper)
- Create: `crates/quark-core/src/joints.rs` (distance, hinge/door, spring constraints for 3D physics puzzles)
- Create: `packages/quark-engine/src/rpg/Tilemap.ts` (LDtk / Tiled JSON parser -> batched tilemap chunk meshes + automatic `TileGrid2D` collision generation)
- Create: `packages/quark-engine/src/rpg/SpriteAnimator.ts` (sprite-sheet frame grid + directional clip state machine)
- Modify: `packages/quark-engine/src/render/WebGL2Backend.ts` (2D multiplicative darkness + radial 2D lights pass for atmospheric RPG rooms)

**Interfaces:**
- Produces:
  - `scene.setCharacterController(entity, { stepHeight, maxSlopeDeg })`
  - `scene.addJoint({ kind: 'hinge' | 'spring' | 'distance', entityA, entityB, ... })`
  - `TilemapLoader.loadTiledJson(...)`, `SpriteAnimator`

**Deliverables & Verification:**
- [ ] **TDD Step 1:** Rust tests: character climbs a `0.35m` stair step smoothly without snagging; moving platform carries standing player horizontally; hinge door swings around pivot within angle limits.
- [ ] **TDD Step 2:** TS test loading a sample Tiled JSON map and verifying tile chunk generation + solid collider sync.

---

### Milestone 5: Particles, Shader Graph Compiler & Scene Serialization

**Files:**
- Create: `crates/quark-core/src/particles.rs` + `packages/quark-engine/src/render/ParticleEmitter.ts` (zero-GC pooled 2D/3D particle emitters with gravity, color/size over lifetime, instanced draw)
- Create: `packages/quark-engine/src/render/ShaderGraph.ts` (node-graph DAG compiler to GLSL 300 es — inputs: UV, WorldPos, Normal, Time, Noise, Fresnel, Texture -> outputs: Albedo, Emission, Alpha, VertexOffset)
- Create: `packages/quark-engine/src/serialization/SceneSerializer.ts` (JSON/binary scene snapshot + Save/Load game state + async `preloadManifest` with progress callback)

**Interfaces:**
- Produces:
  - `ShaderGraph.create().addNode(...).compileMaterial()`
  - `scene.createParticleEmitter(opts)`
  - `SceneSerializer.exportJson(scene)` / `SceneSerializer.importJson(scene, data)`

**Deliverables & Verification:**
- [ ] **TDD Step 1:** Unit tests for `ShaderGraph` topological sort, cycle detection, and GLSL codegen; round-trip `SceneSerializer` export -> `scene.clear()` -> import preserving entities, transforms, colliders, and materials.

---

### Milestone 6: Runtime Debug Gizmos, WebGPU Backend & Automated Browser QA

**Files:**
- Create: `packages/quark-engine/src/debug/DebugGizmos.ts` (line renderer for AABB/Sphere/Capsule colliders, BVH bounds, raycasts, and velocity vectors; tree-shakeable)
- Create: `packages/quark-engine/src/render/WebGPUBackend.ts` (optional `IRenderBackend` implementation for WebGPU with automatic fallback to `WebGL2Backend`)
- Create: `tests/e2e/playground.spec.ts` (Playwright headless browser verification: zero console/GLSL errors, 3D/2D mode switch, cube ramp drop, shader preset switching, FPS & memory stability check)
- Upgrade: `examples/playground` (full showcase: 3D physics puzzle room with hinge door + pressure-plate trigger + animated `.glb` + 2D OMORI-style multi-room Tiled map with 2D lighting & particles)

**Deliverables & Verification:**
- [ ] **Verify:** `npm run test`, Playwright E2E WebGL2 suite green, `packages/quark-engine` `npm pack` dry-run verified under both `npm` and `pnpm`.
