# QuarkStudio Visual Game Editor Implementation Plan

**Goal:** Build a complete browser-based 3D game editor (`QuarkStudio`) on branch `editor` so the user can visually construct rooms and levels, lock/fix static geometry vs dynamic props, craft procedural/custom textures and shader materials, wire gameplay via visual Blueprint nodes, Play/Stop test in real time, and save/export their game without writing code or using AI.

**Architecture:**
1. **Reusable Engine Editor Core (`packages/quark-engine/src/editor/`)**:
   - `ProjectSchema.ts`: Serializable JSON project schema (`QuarkProjectDoc`), starter templates (`empty`, `escapeRoom`, `parkour`), and scene/blueprint/material data types.
   - `ProceduralTextures.ts`: Deterministic procedural RGBA texture generator (`grid`, `checker`, `brick`, `wood`, `stone`, `metal`) + DataURL upload support.
   - `BlueprintRuntime.ts`: Graph interpreter executing Event (`onStart`, `onTick`, `onKeyPress`, `onTriggerEnter`, `onTriggerExit`, `onCollision`, `onRaycastClick`), Logic/Var (`setVar`, `ifVar`, `gateOnce`, `delay`), and Action (`moveObject`, `rotateObject`, `applyImpulse`, `setStaticLocked`, `spawnProp`, `destroyObject`, `toggleLight`, `emitVfx`, `playSound`, `teleportPlayer`, `showBanner`, `setHudCounter`, `setWeather`) nodes with clean Play/Stop lifecycle cleanup and live trace hooks.
   - `ProjectRunner.ts`: Instantiates any `QuarkProjectDoc` into a `Scene` + `AssetManager` + `WorldBuilder` + `AudioSystem`, supporting both `edit` (physics bodies frozen, rooms/objects selectable) and `play` (active physics, player FPS controller, triggers, raycast clicks, blueprints) modes.
   - Small `TransformGizmo.ts` upgrade: optional grid/angle snap (`snapStep`, `rotSnapDeg`), `onDragEnd` callback for Undo/Redo, and `canEditEntity` guard for editor-pinned objects.
2. **Standalone Editor IDE (`examples/editor/`)**:
   - Full dark studio IDE layout: Top Toolbar (Templates, Undo/Redo, Gizmo + Snap, Quick Spawn + `.glb` Import, Play/Stop, Save/Export JSON & Playable HTML), Left Scene Hierarchy Outliner (Static Lock vs Dynamic + Editor Pin badges), Center 3D Viewport + Bottom Drawer (Visual Blueprint Node Canvas, Visual Shader & Texture Studio, World/Sky/Quality panel), Right Inspector (Transform, Drop-to-Floor, Static/Dynamic/Trigger Fixation, Weld, Material/Room/Light props).

**Verification:**
- Vitest unit tests covering `ProjectSchema`, `ProceduralTextures`, `BlueprintRuntime` (events/variables/conditions/actions/delays), and `ProjectRunner` edit↔play roundtrip.
- `npm test && npm run build` across `quark-core`, `packages/quark-engine`, `examples/playground`, and `examples/editor`.
- Headless Chrome verification of `examples/editor` (templates, node editor UI, shader studio UI, Play/Stop mode switching, 0 console/runtime errors).
