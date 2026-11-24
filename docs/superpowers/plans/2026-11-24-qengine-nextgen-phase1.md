# Phase 1 Implementation Plan: Water 2.0 & OrbitViewer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add customizable multi-wave Water 2.0 (`Realistic`, `Anime`, `Custom` Gerstner waves, foam, Fresnel reflections, depth absorption) and an ergonomic `OrbitControls` 3D viewer controller to `quark-engine` and showcase both live in `examples/playground`.

**Architecture:** `OrbitControls` operates purely on spherical camera coordinates (`theta`, `phi`, `radius`, `target`) with exponential damping and optional DOM pointer/wheel hooks so it works both in browsers and headless Vitest tests. `Water 2.0` extends `ShaderBlocks.ts`, `MaterialUniforms`, `WebGL2Backend.ts`, and `ShaderPresets.ts` with a new `waterSurface` shader block driven by 4 non-uniform Gerstner waves and a `waterStyle` (`0 = realistic`, `1 = anime`) blend factor.

**Tech Stack:** TypeScript ESM, WebGL2 / GLSL 300 es, Vitest, Vite.

**Spec:** `docs/superpowers/specs/2026-11-24-qengine-nextgen-vfx-physics-design.md`

## Global Constraints
- Zero per-frame heap allocations inside `OrbitControls.update` or render loops.
- Backward-compatible `MaterialUniforms` defaults (new water fields optional in TS interface, defaulted cleanly in `defaultMaterialUniforms` and `WebGL2Backend`).
- All existing 44 Rust tests + 27 TS tests remain passing.

## Review Focus
- `OrbitControls` camera poles (`phi` clamped away from `0` and `PI`) never produce `NaN` vectors.
- `OrbitControls` pan/zoom works regardless of canvas CSS size (`wheel` prevented on canvas only).
- `waterSurface` shader compiles cleanly in GLSL 300 es both with and without `vertexWave` / HDR output.
- Existing `waveSurface` / `waterCaustics` presets continue compiling without regressions.
- Playground UI controls (`FPS` vs `Orbit Viewer` + `Water 2.0` sliders/presets) clean up properly when switching to `2D OMORI` or `Forest Escape`.

---

### Task 1: Headless & DOM `OrbitControls`
**Files:**
- Create: `packages/quark-engine/src/OrbitControls.ts`
- Modify: `packages/quark-engine/src/index.ts`
- Test: `packages/quark-engine/tests/orbit-and-water.test.ts`

- [ ] **Step 1:** Write failing unit tests in `packages/quark-engine/tests/orbit-and-water.test.ts` testing orbit rotation, clamping near vertical poles, panning target, zooming min/max bounds, autoRotate, and damping convergence without DOM.
- [ ] **Step 2:** Run `npx vitest run packages/quark-engine/tests/orbit-and-water.test.ts` to verify failure.
- [ ] **Step 3:** Implement `packages/quark-engine/src/OrbitControls.ts` and export from `packages/quark-engine/src/index.ts`.
- [ ] **Step 4:** Re-run Vitest and confirm passing.

### Task 2: Water 2.0 Gerstner Shader Block & Presets
**Files:**
- Modify: `packages/quark-engine/src/render/IRenderBackend.ts`
- Modify: `packages/quark-engine/src/render/ShaderPresets.ts`
- Modify: `packages/quark-engine/src/render/ShaderBlocks.ts`
- Modify: `packages/quark-engine/src/render/WebGL2Backend.ts`
- Modify: `packages/quark-engine/tests/orbit-and-water.test.ts`

- [ ] **Step 1:** Add Water 2.0 tests checking `SHADER_BLOCK_IDS` includes `'waterSurface'`, `composeShader({ blocks: ['waterSurface', 'distanceFog'] })` generates Gerstner multi-wave GLSL + foam + anime/realistic uniform branches, and `createPresetMaterial('waterRealistic')` / `createPresetMaterial('waterAnime')` return distinct valid descriptors.
- [ ] **Step 2:** Implement `waterStyle`, `waterFoam`, `waterChoppiness`, `waterClarity` in `MaterialUniforms`, `defaultMaterialUniforms`, `WebGL2Backend.applyMaterialUniforms`, `ShaderBlocks.ts` (`waterSurface` 4-wave Gerstner vertex + analytical normal + realistic PBR reflection/absorption/foam & anime cel-water blend), and `waterRealistic` / `waterAnime` presets.
- [ ] **Step 3:** Run full `npm test` (`cargo test` + `vitest run`).

### Task 3: Playground Water 2.0 Studio & OrbitViewer Integration
**Files:**
- Modify: `examples/playground/src/arenaBuilder.ts`
- Modify: `examples/playground/index.html`
- Modify: `examples/playground/src/main.ts`

- [ ] **Step 1:** Upgrade the Playground Water Pool to use `waterRealistic` / `waterSurface` with a subtle ripple trigger ring & wave-driven floating crate bobbing helper.
- [ ] **Step 2:** Add Camera Mode switcher (`FPS Прогулка` / `Orbit 3D Превью`) with target presets (`Кристалл`, `Бассейн с водой`, `Тёмная комната`, `Вся арена`) & `Auto-Rotate`, plus live **Вода 2.0** preset buttons (`Realistic`, `Anime`, `Cyber`) and customization sliders.
- [ ] **Step 3:** Build (`npm run build`) and verify both **Water 2.0 (Realistic + Anime)** and **OrbitViewer** screenshots in headless Chrome (`0` console errors).
