# QuarkEngine (QEngine)

An ultra-lightweight universal **2D / 2.5D / 3D engine** built on a **Rust + WebAssembly** core with a clean **TypeScript + WebGL2** API — designed for browser games, interactive 3D viewers & modeling tools, and rich 2D/3D web experiences.

- **MIT Licensed:** Friendly for both open-source and commercial closed-source products.
- **Zero-GC Core (Rust/WASM):** SoA Entity-Component-System, Warm-Started Symmetric PGS 3D/2D physics, BVH static mesh queries, Archimedes water buoyancy, A\* navigation grids, Blender `.glb` skeletal animation & parser, and frustum culling all run in linear WASM memory.
- **Modular Shader Pipeline:** Linear HDR PBR (`Heitz Smith-GGX`, clearcoat, subsurface, IBL), Anime/Toon cel-shading with outlines, holographic plaques, caustics, Voronoi/wave water, dissolve, dithering, custom GLSL node graphs (`ShaderGraph`), plus SSAO, Bloom, FXAA, and ACES Tone Mapping.
- **Hardware Instancing & Diagnostics:** Automatic GPU batching (`drawElementsInstanced`), texture/mesh tag lifecycle (`unloadTag`), and an integrated live frame profiler (`F2`).
- **One Engine for Any Format:** Build FPS/3D physics sandboxes, 2D RPGs with lighting & tilemaps, `.glb` product/model viewers, or interactive canvas widgets inside regular web apps.

## Quick Start

```bash
npm install
npm test         # Rust unit tests + WASM release build + TypeScript/WASM tests
npm run build    # Build quark-engine library and interactive playground
npm run dev      # Launch the interactive 3D/2D showcase playground
```

## TypeScript Example

```ts
import { Engine, createBoxGeometry } from 'quark-engine';

const engine = await Engine.init({ canvas: document.querySelector('canvas')! });
const { scene, assets } = engine;

const box = assets.registerMesh('box', createBoxGeometry(0.5, 0.5, 0.5));
const mat = assets.createPreset('pbr', 'ultraRealism');

const crate = scene.createEntity();
scene.setTransform(crate, { position: [0, 3, 0], immediate: true });
scene.setCollider3D(crate, { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] });
scene.setRigidBody(crate, { dynamic: true, mass: 1.5, friction: 0.78 });
scene.setMesh3D(crate, { meshId: box.meshId, materialId: mat, boundsRadius: 1 });

engine.start();
```
