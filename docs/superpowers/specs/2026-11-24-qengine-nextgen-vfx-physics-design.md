# QEngine Next-Gen VFX, Water 2.0, Physics & Universal 3D/2D Viewer Design

**Date:** 2026-11-24
**Scope:** Expand QEngine from an existing 2D/3D WASM game core into a universal creative engine for games, interactive 3D viewers/modeling previews, and rich 2D/3D web widgets — adding **Water 2.0**, **OrbitViewer**, **GPU/WASM VFX Particles 2.0**, **Volumetric Light + Decals**, and **Cloth/Rope/Fracture/Grappling Physics**.

## Intent & Why
- Make QEngine visually competitive with modern indie/web engines in both realistic PBR and stylized anime aesthetics.
- Keep it practical for non-game web uses (interactive `.glb` model inspection via `OrbitControls`, embeddable 2D/3D canvas widgets).
- Preserve QEngine's signature strengths: compact Rust/WASM footprint, MIT license compatibility, and zero-GC runtime loops.

## Explicitly Excluded (Non-Goals for This Cycle)
- Scene JSON Save/Load serialization, multiplayer networking/WebRTC, and procedural world/dungeon generators (deferred to a future cycle per user direction).

## Architecture & Approaches Considered

### Approach A (Chosen): Rust/WASM Linear-Memory Simulation + WebGL2 GPU Instancing + Modular GLSL
- Heavy per-frame simulation (particle pools/bounces, Verlet cloth/ropes, debris) lives in Rust linear memory without JS heap churn.
- WebGL2 renders particles, volumetric cones, decals, and waves via `drawElementsInstanced` and modular `ShaderBlocks` GLSL snippets.
- Camera/viewer helpers (`OrbitControls`) live in lightweight, tree-shakeable TypeScript with headless unit testability.

### Approach B (Rejected): Pure TypeScript CPU Loops + Per-Object Draws
- Faster initial prototyping, but causes JS GC stutter beyond ~1,500 dynamic particles/cloth vertices and loses frame stability.

## Phased Rollout

1. **Phase 1 — Water 2.0 & `OrbitViewer`:**
   - 4-wave non-uniform Gerstner vertex + fragment `waterSurface` block with analytical normals, depth/absorption tint, crest & shoreline foam, Fresnel sky/sun reflection, and continuous `Realistic ↔ Anime` stylization (`waterRealistic`, `waterAnime`).
   - `OrbitControls` headless-safe TypeScript controller (orbit, pan, damped wheel zoom, auto-rotate, target focus) integrated into Playground as a 1-click 3D Viewer mode.
2. **Phase 2 — GPU/WASM Particle System 2.0:**
   - Instanced camera-facing billboard + trail particles (`10,000+` capacity, `Additive` & `Alpha` blending, lifetime color/size curves, floor bounce collisions, 2D confetti/web effects).
3. **Phase 3 — Atmospheric Volumetrics & Decals:**
   - Soft additive volumetric light cones / god-rays (for ceiling lamp & doorway shafts) and projected decals on static/dynamic surfaces.
4. **Phase 4 — Interactive Soft/Destructible Physics:**
   - Verlet/XPBD cloth & ropes in Rust/WASM (wind + player interaction), shatterable/breakable props, and raycast grappling hook (`G` / RMB).

## Verification Strategy
- Rust (`cargo test`), TypeScript (`vitest`), `tsc --noEmit`, `vite build`, and live headless Chrome WebGL2 visual/console verification after every phase.
