# QuarkEngine — Design Specification

**Date:** 2026-11-21  
**Status:** Draft (awaiting approval)  
**Target Size:** Full project (staged modular build: Core WASM + TS Engine + Demo Playground)

---

## 1. Intent & Why

Build **QuarkEngine** — a custom, high-performance, low-memory 2D/3D browser game and simulation engine distributed as an `npm`/`pnpm` TypeScript/JavaScript library.

The engine is designed for indie games (OMORI-style 2D/2.5D RPGs, 100+ hour narrative games, 3D puzzle games), interactive web embeds, and lightweight simulations — rather than AAA multiplayer shooters. Game and web developers write **100% TypeScript/JavaScript**, while the heavy core (ECS, memory pools, fixed-timestep physics/collisions, culling, sorting, glTF parsing) runs in **Rust compiled to WebAssembly**.

---

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- **Pure TS/JS developer ergonomics:** Installable via `pnpm` or `npm` (`quark-engine`). Users never need Rust installed to build games with the published package.
- **Commercial & closed-source freedom:** Strictly MIT / Apache-2.0 / BSD / ISC / Zlib dependencies only; core logic compiled to `.wasm` also makes proprietary game/engine distribution straightforward.
- **Low RAM & stable frame times:** Structure-of-Arrays (SoA) ECS storage in Rust linear memory, zero per-frame JS object allocation in the hot loop, explicit asset/scene unloading (`.dispose()`) so long narrative games do not leak memory.
- **Jitter-free physics & collisions:** Fixed-timestep simulation accumulator with sub-stepping, continuous/swept depenetration and slope/wall sliding, and render-time transform interpolation (`prev` → `curr` by `alpha`).
- **Any visual style:** Unified WebGL2 renderer supporting 2D pixel-crisp/batched sprites, 3D PBR (realism), 3D Toon/Anime (cel-shading + rim + outline pass), and user-authored custom GLSL shaders.
- **Blender asset support:** Built-in `.glb` / `.gltf` 2.0 loader (meshes, node hierarchy, PBR/custom material mapping, skeletal skinning/keyframe animations, optional static collider meshes).

### Non-Goals (v1)
- Visual GUI scene/shader editor (code-first library + lightweight optional runtime debug overlay).
- AAA rendering features (raytracing, real-time global illumination, virtualized geometry).
- Built-in multiplayer networking / rollback netcode.
- Soft-body, cloth, or destructible voxel physics.

### Anti-Goals
- Any copyleft dependencies (GPL, AGPL, LGPL).
- Per-entity JS↔WASM boundary calls every frame (would destroy WASM performance).
- Heavy monolithic runtime bundles (startup payload should stay small and fast for web embeds).

---

## 3. Constraints & Environment Reality

- **Licenses:** All Rust crates and npm dev/runtime packages must be MIT / Apache-2.0 / BSD / ISC / Zlib.
- **Browser target:** WebGL2 + WebAssembly (supported across modern desktop and mobile browsers), with an internal `IRenderBackend` boundary so WebGPU can be added later without changing the public API.
- **Package manager compatibility:** Workspace and `package.json` must work seamlessly with both `npm` (currently installed) and `pnpm`.
- **Engine build toolchain:** `rustc 1.100.0`, `cargo`, `rustup`, `node`, and `npm` are already installed. Compiling Rust → WASM requires adding `wasm32-unknown-unknown` via `rustup` and installing `wasm-bindgen-cli` (no reliance on pre-installed `wasm-pack`).

---

## 4. Approaches Considered

1. **Wrapper over Three.js + Rapier (Rejected):** Fast to start, but larger bundle/RAM baseline and couples core rendering/physics to third-party architectures.
2. **Pure TypeScript from scratch (Rejected):** Good ergonomics, but lacks Rust's deterministic zero-GC memory layout and compiled core protection for heavy physics/simulations.
3. **Hybrid: Rust/WASM Core + TypeScript/WebGL2 Public API (Selected):** Combines near-native, GC-free Rust performance and compact binary `.wasm` core with a clean, idiomatic TypeScript/JavaScript API for game developers.

---

## 5. Architecture

### 5.1 Repository Layout
```text
QuarkEngine/
├── crates/
│   └── quark-core/          # Rust core compiled to wasm32-unknown-unknown
│       ├── src/
│       │   ├── math.rs      # Vec2/3/4, Quat, Mat4, Aabb, Ray, Frustum (or glam)
│       │   ├── ecs.rs       # Generational entity IDs + SoA component pools
│       │   ├── physics.rs   # Fixed-step solver, 2D/3D colliders, swept slide, interpolation
│       │   ├── gltf.rs      # Binary .glb / .gltf parser -> flat GPU-ready buffers
│       │   ├── render.rs    # Culling, sorting (2D layers / 3D opaque+transparent), instance batches
│       │   └── lib.rs       # wasm-bindgen exports + raw pointer views into linear memory
│       └── Cargo.toml
├── packages/
│   └── quark-engine/        # Publishable npm/pnpm package (ESM + .d.ts + bundled .wasm)
│       ├── src/
│       │   ├── Engine.ts    # Lifecycle (init, start, stop, dispose), fixed/render loop
│       │   ├── Scene.ts     # Entity/component ergonomic TS API + chunk/scene cleanup
│       │   ├── Input.ts     # Keyboard, mouse, pointer lock, gamepad abstraction
│       │   ├── Audio.ts     # Web Audio API BGM crossfade + 2D/3D SFX pooling
│       │   ├── assets/      # Texture, GLTF/GLB loader, reference-counted cache
│       │   └── render/      # IRenderBackend, WebGL2Backend, Materials (PBR, Toon, Sprite, Shader)
│       └── package.json
├── examples/
│   └── playground/          # Vite browser sandbox:
│                            #   - Walkable 3D test arena (WASD, mouse look, jump, smooth capsule slide on walls/ramps, spawn boxes/spheres, glTF drop/load, live shader block presets)
│                            #   - 2D/2.5D OMORI-style mode toggle (pixel sprites, tilemap collision, Y-sort, custom 2D shader blocks)
│                            #   - Live telemetry HUD (FPS, frame time, WASM memory bytes, entity/draw count)
├── docs/
│   └── superpowers/specs/
└── package.json             # Root workspace scripts (npm/pnpm compatible)
```

### 5.2 Zero-Copy JS ↔ WASM Memory Bridge & Packaging
- **WASM loading:** `Engine.init({ wasmUrl? })` resolves the bundled `.wasm` via standard ESM `new URL(..., import.meta.url)` (works out of the box in Vite/Rollup/Webpack/pnpm/npm) with an optional custom URL override for CDNs or single-file embeds.
- To eliminate per-frame marshalling overhead:
  - Rust maintains flat contiguous output buffers in WASM linear memory:
    - `transform_matrices`: interpolated `4x4` world matrices (`f32`) for rendering.
    - `render_2d_instances`: sorted sprite draw instances (`x, y, z, w, h, rot, uvRect, color, texId`).
    - `render_3d_commands`: sorted mesh draw items (`meshId, materialId, transformOffset, flags`).
  - TS wraps these pointers in `Float32Array` / `Uint32Array` views over `wasmMemory.buffer`.
  - **Critical safety guard:** Whenever WASM memory grows, existing `ArrayBuffer` views detach. The TS bridge checks `view.buffer !== wasmMemory.buffer` after every `step()` / asset load and refreshes views automatically.

### 5.3 Jitter-Free Physics & Collisions
- **Loop:** Variable `requestAnimationFrame` delta is clamped (e.g., max `0.1s` to prevent spiral-of-death on tab switch) and accumulated into fixed steps (default `1/60s`).
- **Simulation (Rust):**
  - Stores `prev_pos` / `prev_rot` before stepping and `curr_pos` / `curr_rot` after stepping.
  - **2D Colliders:** `AABB2D`, `Circle2D`, `TileGrid2D` (fast grid-cell lookup for RPG maps).
  - **3D Colliders:** `AABB3D`, `Sphere3D`, `Capsule3D` (for smooth character movement), `StaticTriangleBVH` (from Blender meshes).
  - **Resolution:** Iterative depenetration + velocity projection (slide along walls/slopes without snagging on tile seams or mesh edges) + optional rigidbody impulse/gravity/friction.
- **Render Interpolation:** Before emitting render matrices, Rust computes `lerp(prev_pos, curr_pos, alpha)` and `slerp(prev_rot, curr_rot, alpha)` where `alpha = accumulator / fixed_dt`. Camera and player move smoothly on 60Hz, 120Hz, or 144Hz displays.

### 5.4 Multi-Style Rendering & Custom Shaders (WebGL2)
- **`IRenderBackend` interface:** Decouples engine scene/materials from raw WebGL2 calls (enabling a future WebGPU backend).
- **2D Pipeline:** Instanced quad batcher, texture atlasing, nearest-neighbor (`pixelated`) or linear filtering, Y-sorting / explicit Z-layers, pixel-snapped or smooth camera.
- **3D Materials & Composable Shader Block Presets:**
  - `PBRMaterial`: albedo, metallic-roughness, normal map, emissive, directional/point lights, shadow map support, ACES tone mapping.
  - `ToonMaterial`: stepped cel-shading ramp, shadow tint, Fresnel rim light, optional inverted-hull outline pass.
  - `ShaderMaterial` + **Shader Block Presets (`ShaderBlocks` / `ShaderPresets`)**: composable GLSL 300 es building blocks (`celLighting`, `rimLight`, `fresnelGlow`, `vertexWave`, `dissolveNoise`, `hologramScanline`, `pixelDither`, `fog`) and ready-made presets (`pbr`, `animeToon`, `hologram`, `dissolve`, `retroDither`, `waveSurface`) with automatic engine uniforms (`u_view`, `u_proj`, `u_model`, `u_time`, lights) and typed custom uniforms.

### 5.5 Blender Asset Pipeline (`.glb` / `.gltf`)
- Rust parses `.glb` binary containers (using MIT/Apache-2.0 `gltf` crate or lean custom parser) into contiguous vertex/index arrays, texture payloads, node hierarchy, skeletal joints/inverse-bind matrices, and animation tracks.
- Supports mapping imported materials to either `PBRMaterial` or `ToonMaterial` (so a Blender model can instantly render in realistic or anime style), and tagging meshes (e.g., `_col`) for automatic static BVH collider generation.

### 5.6 Memory Lifecycle
- Every GPU resource (textures, VAOs, buffers, shader programs) and WASM mesh/physics asset is tracked by handle and reference count.
- `scene.dispose()` / `engine.unloadTag(tag)` frees both WASM arena allocations and WebGL2 GPU objects deterministically.

---

## 6. Left to the Implementation Plan

1. Exact binary ABI struct layout for `RenderItem2D`, `RenderItem3D`, and `LightData` shared between Rust and TS.
2. Choice of `glam` + `gltf` crates (verifying MIT/Apache-2.0 licenses and compiled `.wasm` size impact) vs minimal custom modules.
3. Build pipeline: `cargo build --target wasm32-unknown-unknown --release` + `wasm-bindgen` + `tsc`/Vite library bundle (`dist/`).
4. Verification suite:
   - `cargo test` for math, ECS generational IDs, fixed-timestep determinism, collision sliding without seam-snagging, and glTF parsing.
   - TypeScript unit tests for buffer view re-binding on WASM memory growth, resource disposal, and public API.
   - Interactive Vite `examples/playground` verified in a live browser (2D pixel/sprite scene + 3D Blender `.glb` with Toon/PBR toggle + capsule collision).
