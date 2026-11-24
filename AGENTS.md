# AGENTS.md — QuarkEngine Coding Guide for AI Agents

Read `llms.txt` first for a concise cheat sheet of the public API.

## Rules of Thumb When Writing QuarkEngine Apps

1. **Use `createWorldBuilder(scene, assets)` and `material()` by default.**
   - Avoid writing repetitive `createEntity` + `setTransform` + `setCollider3D` + `setMesh3D` boilerplate unless you need custom low-level ECS control.
   - `world.box`, `world.room`, `world.stairs`, `world.pool`, and `world.fromGrid` take **full sizes `[w, h, d]`** and compute `halfExtents` + `boundsRadius` automatically.
2. **Prevent `[0,0,0]` spawn ghosting:** When calling `scene.setTransform(...)` directly during entity creation or teleportation, pass `immediate: true`.
3. **Respect WebGL2 light limits:** `scene.pointLights` renders up to `4` lights; `scene.spotLights[0]` casts real-time perspective shadows. Use emissive `cyberNeon` meshes for extra accent lights.
4. **Always dispose per-scene tags on reload:** Pass a tag (default `'scene'` / `'world'`) to `assets.*` and call `assets.releaseTag('scene')` + `scene.clear()` when rebuilding or switching levels.
5. **Verify before finishing:** Run `npm test && npm run build`.
