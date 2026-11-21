# QuarkEngine

Ультралёгкий браузерный 2D/3D-движок в виде `npm` / `pnpm`-библиотеки с ядром на **Rust + WebAssembly** и публичным API на **TypeScript / WebGL2**.

- **Лицензия:** MIT (совместима с закрытым исходным кодом и коммерческой продажей игр/приложений).
- **Zero-GC ядро:** ECS (SoA-массивы), физика и коллизии с `fixed timestep` + интерполяцией, парсер Blender `.glb` и куллинг работают в WASM-памяти без нагрузки на сборщик мусора JS.
- **Стили и пресеты шейдерных блоков:** `pbr`, `animeToon` (с контуром), `hologram`, `dissolve`, `retroDither`, `waveSurface` + конструктор GLSL-блоков (`composeShader`).
- **2D + 3D:** единая сцена для 2D/2.5D RPG (в духе OMORI, Y-сортировка, тайлмапы без зацепов на стыках) и 3D-игр / веб-витрин.

## Быстрый старт

```bash
npm install
npm run test     # Rust unit tests + build wasm + TypeScript/WASM integration tests
npm run build    # Сборка библиотеки quark-engine и playground
npm run dev      # Запуск интерактивной песочницы в браузере
```

## Пример кода (TypeScript)

```ts
import { Engine, createBoxGeometry, extractColliderTriangles } from 'quark-engine';

const engine = await Engine.init({ canvas: document.querySelector('canvas')! });
const { scene, assets } = engine;

const box = assets.registerMesh('box', createBoxGeometry(0.5, 0.5, 0.5));
const mat = assets.createPreset('toon', 'animeToon', { outlineWidth: 0.03 });

const player = scene.createEntity();
scene.setTransform(player, { position: [0, 2, 0], immediate: true });
scene.setCollider3D(player, { kind: 'capsule', radius: 0.4, halfHeight: 0.55 });
scene.setRigidBody(player, { dynamic: true });
scene.setMesh3D(player, { meshId: box.meshId, materialId: mat });

engine.start();
```
