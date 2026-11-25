import {
  createBoxGeometry,
  createConeGeometry,
  createPlaneGeometry,
  createSphereGeometry,
  createWorldBuilder,
  HotspotOverlay,
  material,
  OrbitControls,
  quatFromEuler,
  type Engine,
  type EntityId,
  type OrbitKeyframe,
  type Vec3Tuple,
} from 'quark-engine';
import { buildSampleCrystalGlb } from './sampleGlb';

export interface WebShowcaseController {
  update: (dt: number, elapsed: number) => void;
  dispose: () => void;
}

type FinishId = 'titanium' | 'sapphire' | 'amethyst' | 'neon';
type StudioMoodId = 'studio' | 'night' | 'rain';

const SITE_TIMELINE: OrbitKeyframe[] = [
  { progress: 0.0, target: [0.0, 2.05, 0.0], radius: 5.8, theta: 0.45, phi: 1.18 },
  { progress: 0.25, target: [0.0, 2.15, 0.0], radius: 4.1, theta: 1.25, phi: 1.02 },
  { progress: 0.5, target: [0.0, 2.05, 0.0], radius: 4.8, theta: 2.35, phi: 1.16 },
  { progress: 0.75, target: [0.0, 2.2, 0.0], radius: 3.9, theta: 3.45, phi: 0.96 },
  { progress: 1.0, target: [0.0, 1.95, 0.0], radius: 6.4, theta: 4.65, phi: 1.24 },
];

export function startWebShowcaseMode(
  engine: Engine,
  overlayEl: HTMLElement,
  onExitToArena: () => void,
  playSfx: (freq: number, dur?: number, type?: OscillatorType, gain?: number) => void
): WebShowcaseController {
  const { scene, assets, bridge, canvas } = engine;
  const targetCanvas = canvas!;

  assets.unloadTag('scene');
  assets.unloadTag('scene-fx');
  assets.unloadTag('scene-holo');
  scene.clear();

  scene.camera.mode = '3d';
  scene.shadowsEnabled = true;
  scene.light.ambientColor = [0.24, 0.27, 0.34];
  scene.fogColor = [0.07, 0.09, 0.14];
  scene.fogDensity = 0.011;
  scene.skyTopColor = [0.09, 0.14, 0.26];
  scene.skyHorizonColor = [0.42, 0.55, 0.74];
  scene.setWeather('clear');
  scene.setCloudStyle('clear');
  scene.light.direction = [0.55, 0.85, 0.45];
  scene.light.color = [1.0, 0.97, 0.92];
  scene.light.intensity = 1.45;
  scene.postProcess.bloomIntensity = 0.36;
  scene.postProcess.ssao = 0.55;
  scene.postProcess.screenOutline = 0;

  scene.pointLights.push(
    { position: [-2.8, 3.4, 2.5], color: [0.25, 0.78, 1.0], intensity: 2.2, radius: 10 },
    { position: [2.8, 2.6, -2.5], color: [0.75, 0.42, 1.0], intensity: 1.9, radius: 10 }
  );

  const studioFloorMesh = assets.registerMesh('site-floor', createPlaneGeometry(42, 42, 12), 'scene');
  const floorMat = material('ultraRealism')
    .color('#1c2434')
    .metallic(0.42)
    .roughness(0.28)
    .clearcoat(0.55)
    .grid(0.8)
    .create(assets, 'site-floor-mat', 'scene');
  const floorEntity = scene.createEntity();
  scene.setTransform(floorEntity, { position: [0, 0, 0], immediate: true });
  scene.setMesh3D(floorEntity, { meshId: studioFloorMesh.meshId, materialId: floorMat, boundsRadius: 32 });

  const world = createWorldBuilder(scene, assets, 'scene');
  // Sleek stepped display plinth
  world.cylinder({
    pos: [0, 0.16, 0],
    radius: 2.25,
    height: 0.32,
    collider: false,
    material: material('ultraRealism').color('#1f2937').metallic(0.75).roughness(0.24),
  });
  world.cylinder({
    pos: [0, 0.38, 0],
    radius: 1.55,
    height: 0.14,
    collider: false,
    material: material('cyberNeon').color('#0f172a').glow('#38bdf8'),
  });

  // Hero assembly parts (split & expand smoothly with scrollProgress!)
  const crystalHandle = assets.registerMesh('site-crystal', bridge.parseGlb(buildSampleCrystalGlb()), 'scene');
  const shellBoxMesh = assets.registerMesh('site-box', createBoxGeometry(0.5, 0.5, 0.5), 'scene');
  const lensSphereMesh = assets.registerMesh('site-lens', createSphereGeometry(0.5, 18, 24), 'scene');
  const beamMesh = assets.registerMesh('site-beam', createConeGeometry(0.35, 1.45, 2.4, 24), 'scene');

  const coreMatId = material('crystalGlass')
    .color('#38bdf8c8')
    .glow('#38bdf8')
    .roughness(0.06)
    .transparent()
    .doubleSided(true)
    .create(assets, 'site-core-mat', 'scene');

  const shellMatId = material('ultraRealism')
    .color('#cbd5e1')
    .metallic(0.88)
    .roughness(0.18)
    .clearcoat(0.85)
    .create(assets, 'site-shell-mat', 'scene');

  const trimMatId = material('cyberNeon')
    .color('#1e293b')
    .glow('#38bdf8')
    .metallic(0.82)
    .roughness(0.22)
    .create(assets, 'site-trim-mat', 'scene');

  const finMatId = material('iridescent')
    .color('#38bdf8')
    .metallic(0.78)
    .roughness(0.16)
    .create(assets, 'site-fin-mat', 'scene');

  const beamMatId = material('ultraRealism')
    .blocks('volumetricBeam')
    .color('#38bdf838')
    .glow('#38bdf8')
    .transparent('additive', false)
    .doubleSided(true)
    .create(assets, 'site-beam-mat', 'scene');

  const coreEntity = scene.createEntity();
  scene.setTransform(coreEntity, { position: [0, 2.05, 0], scale: [1.05, 1.05, 1.05], immediate: true });
  scene.setMesh3D(coreEntity, {
    meshId: crystalHandle.meshId,
    materialId: coreMatId,
    transparent: true,
    boundsRadius: 2.2,
  });

  const beamEntity = scene.createEntity();
  scene.setTransform(beamEntity, { position: [0, 1.65, 0], immediate: true });
  scene.setMesh3D(beamEntity, {
    meshId: beamMesh.meshId,
    materialId: beamMatId,
    transparent: true,
    boundsRadius: 3.0,
  });

  const leftShell = scene.createEntity();
  scene.setTransform(leftShell, { position: [-0.72, 2.05, 0], scale: [0.42, 1.48, 1.15], immediate: true });
  scene.setMesh3D(leftShell, { meshId: shellBoxMesh.meshId, materialId: shellMatId, boundsRadius: 0.9 });

  const rightShell = scene.createEntity();
  scene.setTransform(rightShell, { position: [0.72, 2.05, 0], scale: [0.42, 1.48, 1.15], immediate: true });
  scene.setMesh3D(rightShell, { meshId: shellBoxMesh.meshId, materialId: shellMatId, boundsRadius: 0.9 });

  const topCap = scene.createEntity();
  scene.setTransform(topCap, { position: [0, 3.02, 0], scale: [1.18, 0.24, 1.18], immediate: true });
  scene.setMesh3D(topCap, { meshId: shellBoxMesh.meshId, materialId: shellMatId, boundsRadius: 0.9 });

  const gyroOuterBars: EntityId[] = [];
  for (let i = 0; i < 4; i++) {
    const bar = scene.createEntity();
    scene.setTransform(bar, { position: [0, 2.05, 0], scale: [0.08, 0.08, 2.55], immediate: true });
    scene.setMesh3D(bar, { meshId: shellBoxMesh.meshId, materialId: trimMatId, boundsRadius: 0.9 });
    gyroOuterBars.push(bar);
  }

  const satOrbs: EntityId[] = [];
  for (let i = 0; i < 6; i++) {
    const orb = scene.createEntity();
    scene.setTransform(orb, { position: [0, 2.05, 0], scale: [0.22, 0.22, 0.22], immediate: true });
    scene.setMesh3D(orb, { meshId: lensSphereMesh.meshId, materialId: finMatId, boundsRadius: 0.6 });
    satOrbs.push(orb);
  }

  // Orbit controls & scroll coupling
  const orbit = new OrbitControls({ target: [0, 2.05, 0], radius: 5.8, theta: 0.45, phi: 1.18 });
  orbit.autoRotate = false;
  orbit.attach(targetCanvas);
  orbit.enabled = true;

  // Render clean scrollable Landing Page overlay
  overlayEl.innerHTML = `
    <div class="site-topbar">
      <div class="site-brand"><span class="site-dot"></span> QuarkCore X1 · Web Showcase</div>
      <div class="site-topbar-actions">
        <span id="site-scroll-pct" class="site-pill">Scroll: 0%</span>
        <button id="site-btn-exit" class="site-cta-sm">← Вернуться в Арену</button>
      </div>
    </div>
    <div class="site-scroll" id="site-scroll">
      <section class="site-card site-hero">
        <div class="site-badge">WEBGL2 + RUST/WASM ENGINE</div>
        <h1>Интерактивный 3D-продукт прямо на вашем сайте</h1>
        <p>Крути страницу колесом мыши: скролл плавно управляет камерой, разборкой корпуса и подсветкой, при этом модель всегда можно покрутить мышью вручную.</p>
        <div class="site-actions">
          <button id="site-btn-explore" class="site-primary">Листать презентацию ↓</button>
          <button id="site-btn-autorotate" class="site-ghost">Авто-вращение: ВЫКЛ</button>
        </div>
      </section>

      <section class="site-card site-right">
        <div class="site-badge">01 · SCROLL TIMELINE</div>
        <h2>Взрыв-схема при прокрутке</h2>
        <p>Привязано к <code>OrbitControls.applyTimeline()</code>: при скролле створки корпуса раздвигаются, открывая граненое GLB-ядро и объёмный луч света.</p>
      </section>

      <section class="site-card">
        <div class="site-badge">02 · LIVE CONFIGURATOR</div>
        <h2>Мгновенная смена материалов</h2>
        <p>Покупатель выбирает отделку в один клик — PBR-металл, прозрачное стекло или переливчатый иридесцентный шейдер обновляются без перезагрузки.</p>
        <div class="site-swatches">
          <button data-finish="titanium" class="swatch active">Титан</button>
          <button data-finish="sapphire" class="swatch">Сапфир</button>
          <button data-finish="amethyst" class="swatch">Аметист</button>
          <button data-finish="neon" class="swatch">Кибер-Неон</button>
        </div>
      </section>

      <section class="site-card site-right">
        <div class="site-badge">03 · АТМОСФЕРА И ПОГОДА</div>
        <h2>Живое освещение под дизайн сайта</h2>
        <p>Переключи студийный свет, неоновую ночь или дождь с мокрыми отражениями на подиуме прямо в реальном времени.</p>
        <div class="site-swatches">
          <button data-mood="studio" class="swatch active">Студия</button>
          <button data-mood="night" class="swatch">Неон Ночь</button>
          <button data-mood="rain" class="swatch">Дождь</button>
        </div>
      </section>

      <section class="site-card site-center">
        <div class="site-badge">04 · ГОТОВО К ВСТРАИВАНИЮ</div>
        <h2>~650 KB WASM + WebGL2 без сторонних зависимостей</h2>
        <p>Нажимай на 3D-метки прямо на модели или переходи обратно в песочницу, чтобы протестировать физику и игры.</p>
        <div class="site-actions" style="justify-content:center">
          <button id="site-btn-top" class="site-ghost">Наверх ↑</button>
          <button id="site-btn-exit-bottom" class="site-primary">Открыть 3D Арену</button>
        </div>
      </section>
    </div>
  `;
  overlayEl.classList.add('visible');

  const hotspots = new HotspotOverlay(scene, targetCanvas, orbit);
  hotspots.add({
    id: 'core',
    position: [0, 2.05, 0],
    label: 'WASM Кристалл-ядро',
    badge: 'GLB + PBR',
    description: 'Встроенный .GLB-меш, прозрачное стекло и преломление света.',
    color: '#38bdf8',
    onClick: () => {
      scrollTarget = 0.24;
      scrollContainer.scrollTo({ top: scrollTarget * maxScroll(), behavior: 'smooth' });
      playSfx(740, 0.09, 'sine', 0.1);
    },
  });
  hotspots.add({
    id: 'shell',
    position: [0.95, 2.05, 0],
    label: 'Титан-кожух',
    badge: 'EXPLODED VIEW',
    description: 'Створки раздвигаются при скролле страницы в реальном времени.',
    color: '#cbd5e1',
    onClick: () => {
      scrollTarget = 0.5;
      scrollContainer.scrollTo({ top: scrollTarget * maxScroll(), behavior: 'smooth' });
      playSfx(580, 0.09, 'triangle', 0.1);
    },
  });
  hotspots.add({
    id: 'gyro',
    position: [0, 3.15, 0],
    label: 'Инстанс-стабилизатор',
    badge: 'INSTANCING',
    description: 'Вращающиеся орбитальные кольца и спутники с PBR-блеском.',
    color: '#a855f7',
    onClick: () => {
      scrollTarget = 0.75;
      scrollContainer.scrollTo({ top: scrollTarget * maxScroll(), behavior: 'smooth' });
      playSfx(660, 0.09, 'sine', 0.1);
    },
  });

  const scrollContainer = overlayEl.querySelector('#site-scroll') as HTMLElement;
  const scrollPctEl = overlayEl.querySelector('#site-scroll-pct') as HTMLElement;
  const maxScroll = () => Math.max(1, scrollContainer.scrollHeight - scrollContainer.clientHeight);

  let scrollTarget = 0;
  let scrollSmooth = 0;
  let manualDragActive = false;
  let weatherAcc = 0;
  let activeMood: StudioMoodId = 'studio';

  const onPointerDownCanvas = () => {
    manualDragActive = true;
  };
  targetCanvas.addEventListener('pointerdown', onPointerDownCanvas);

  const onScroll = () => {
    scrollTarget = Math.max(0, Math.min(1, scrollContainer.scrollTop / maxScroll()));
    manualDragActive = false;
    scrollPctEl.textContent = `Scroll: ${Math.round(scrollTarget * 100)}%`;
  };
  scrollContainer.addEventListener('scroll', onScroll, { passive: true });

  // Forward wheel events over canvas directly to the landing page scroller unless Ctrl/Alt zoom
  const onCanvasWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) return;
    scrollContainer.scrollTop += e.deltaY;
  };
  targetCanvas.addEventListener('wheel', onCanvasWheel, { passive: true });

  const applyFinish = (id: FinishId) => {
    const presets: Record<
      FinishId,
      { shell: [number, number, number]; core: [number, number, number]; glow: string }
    > = {
      titanium: { shell: [0.8, 0.84, 0.9], core: [0.22, 0.74, 0.98], glow: '#38bdf8' },
      sapphire: { shell: [0.14, 0.34, 0.72], core: [0.42, 0.9, 1.0], glow: '#22d3ee' },
      amethyst: { shell: [0.38, 0.22, 0.68], core: [0.92, 0.48, 1.0], glow: '#c084fc' },
      neon: { shell: [0.09, 0.12, 0.18], core: [0.2, 1.0, 0.75], glow: '#34d399' },
    };
    const p = presets[id];
    assets.updateMaterial(shellMatId, {
      ...material(id === 'neon' ? 'cyberNeon' : 'ultraRealism')
        .color([...p.shell, 1])
        .glow(p.glow)
        .metallic(id === 'neon' ? 0.65 : 0.88)
        .roughness(id === 'neon' ? 0.24 : 0.16)
        .clearcoat(0.85)
        .build(),
    });
    assets.updateMaterial(coreMatId, {
      ...material('crystalGlass')
        .color([...p.core, 0.78])
        .glow(p.glow)
        .roughness(0.06)
        .transparent()
        .doubleSided(true)
        .build(),
    });
    assets.updateMaterial(trimMatId, {
      ...material('cyberNeon').color('#0f172a').glow(p.glow).metallic(0.8).roughness(0.2).build(),
    });
    assets.updateMaterial(beamMatId, {
      ...material('ultraRealism')
        .blocks('volumetricBeam')
        .color([...p.core, 0.28])
        .glow(p.glow)
        .transparent('additive', false)
        .doubleSided(true)
        .build(),
    });
    playSfx(620, 0.08, 'triangle', 0.08);
  };

  const applyStudioMood = (m: StudioMoodId) => {
    activeMood = m;
    if (m === 'studio') {
      scene.setWeather('clear');
      scene.setCloudStyle('clear');
      scene.skyTopColor = [0.09, 0.14, 0.26];
      scene.skyHorizonColor = [0.42, 0.55, 0.74];
      scene.fogColor = [0.07, 0.09, 0.14];
      scene.fogDensity = 0.011;
      scene.light.intensity = 1.45;
      scene.light.color = [1.0, 0.97, 0.92];
    } else if (m === 'night') {
      scene.setWeather('clear');
      scene.setCloudStyle('clear');
      scene.skyTopColor = [0.015, 0.02, 0.06];
      scene.skyHorizonColor = [0.08, 0.06, 0.18];
      scene.fogColor = [0.02, 0.02, 0.06];
      scene.fogDensity = 0.014;
      scene.light.intensity = 0.35;
      scene.light.color = [0.55, 0.65, 1.0];
    } else {
      scene.setWeather('rain');
      scene.setCloudStyle('dramatic');
      scene.skyTopColor = [0.08, 0.11, 0.18];
      scene.skyHorizonColor = [0.22, 0.28, 0.38];
      scene.fogColor = [0.1, 0.13, 0.2];
      scene.fogDensity = 0.018;
      scene.light.intensity = 0.75;
    }
    playSfx(480, 0.09, 'sine', 0.08);
  };

  overlayEl.querySelector('#site-btn-exit')?.addEventListener('click', onExitToArena);
  overlayEl.querySelector('#site-btn-exit-bottom')?.addEventListener('click', onExitToArena);
  overlayEl.querySelector('#site-btn-explore')?.addEventListener('click', () => {
    scrollContainer.scrollTo({ top: maxScroll() * 0.28, behavior: 'smooth' });
  });
  overlayEl.querySelector('#site-btn-top')?.addEventListener('click', () => {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
  });
  const autoBtn = overlayEl.querySelector('#site-btn-autorotate') as HTMLButtonElement | null;
  if (autoBtn) {
    autoBtn.onclick = () => {
      orbit.autoRotate = !orbit.autoRotate;
      manualDragActive = orbit.autoRotate;
      autoBtn.textContent = orbit.autoRotate ? 'Авто-вращение: ВКЛ' : 'Авто-вращение: ВЫКЛ';
    };
  }

  overlayEl.querySelectorAll<HTMLButtonElement>('[data-finish]').forEach((btn) => {
    btn.onclick = () => {
      overlayEl.querySelectorAll('[data-finish]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      applyFinish((btn.dataset.finish as FinishId) ?? 'titanium');
    };
  });
  overlayEl.querySelectorAll<HTMLButtonElement>('[data-mood]').forEach((btn) => {
    btn.onclick = () => {
      overlayEl.querySelectorAll('[data-mood]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      applyStudioMood((btn.dataset.mood as StudioMoodId) ?? 'studio');
    };
  });

  // Track orbit camera cleanly at start
  orbit.applyTimeline(SITE_TIMELINE, 0);
  orbit.update(0.016, scene.camera);

  return {
    update(dt: number, elapsed: number) {
      scrollSmooth += (scrollTarget - scrollSmooth) * Math.min(1, dt * 8);
      if (!manualDragActive) {
        orbit.applyTimeline(SITE_TIMELINE, scrollSmooth);
      }
      orbit.update(dt, scene.camera);

      // Exploded view mechanics driven directly by scroll progress
      const explode = Math.sin(Math.min(1, scrollSmooth * 1.35) * Math.PI * 0.72);
      const bob = Math.sin(elapsed * 1.9) * 0.08;
      scene.setTransform(coreEntity, {
        position: [0, 2.05 + bob, 0],
        rotation: quatFromEuler(elapsed * 0.35, elapsed * 0.85, 0),
        scale: [1.05 + explode * 0.14, 1.05 + explode * 0.14, 1.05 + explode * 0.14],
      });
      const shellSpread = 0.74 + explode * 0.92;
      scene.setTransform(leftShell, {
        position: [-shellSpread, 2.05 + bob * 0.4, 0],
        rotation: quatFromEuler(0, 0, explode * 0.14),
        scale: [0.42, 1.48, 1.15],
      });
      scene.setTransform(rightShell, {
        position: [shellSpread, 2.05 + bob * 0.4, 0],
        rotation: quatFromEuler(0, 0, -explode * 0.14),
        scale: [0.42, 1.48, 1.15],
      });
      scene.setTransform(topCap, {
        position: [0, 3.02 + explode * 0.75, 0],
        rotation: quatFromEuler(0, elapsed * 0.25, 0),
        scale: [1.18, 0.24, 1.18],
      });
      const frameR = 1.32 + explode * 0.35;
      const frameY = 2.05 + bob * 0.25;
      for (let i = 0; i < 4; i++) {
        const a = elapsed * 0.65 + (i * Math.PI) / 2;
        scene.setTransform(gyroOuterBars[i], {
          position: [Math.cos(a) * frameR, frameY, Math.sin(a) * frameR],
          rotation: quatFromEuler(0.18 * Math.sin(elapsed + i), -a, 0),
          scale: [0.09, 0.09, frameR * 1.95],
        });
      }

      const satR = 1.75 + explode * 0.8;
      satOrbs.forEach((orb, idx) => {
        const a = elapsed * 0.9 + (idx / satOrbs.length) * Math.PI * 2;
        const p: Vec3Tuple = [
          Math.cos(a) * satR,
          2.05 + Math.sin(elapsed * 2.1 + idx) * (0.28 + explode * 0.35),
          Math.sin(a) * satR,
        ];
        scene.setTransform(orb, { position: p, scale: [0.22, 0.22, 0.22] });
      });

      if (activeMood === 'rain') {
        weatherAcc += dt;
        if (weatherAcc >= 0.03) {
          weatherAcc = 0;
          scene.emitVfx('rain', [0, 12.5, 0], 26, 0.03);
        }
      }

      hotspots.update();
    },

    dispose() {
      scrollContainer.removeEventListener('scroll', onScroll);
      targetCanvas.removeEventListener('pointerdown', onPointerDownCanvas);
      targetCanvas.removeEventListener('wheel', onCanvasWheel);
      orbit.enabled = false;
      orbit.detach();
      hotspots.dispose();
      overlayEl.classList.remove('visible');
      overlayEl.innerHTML = '';
    },
  };
}
