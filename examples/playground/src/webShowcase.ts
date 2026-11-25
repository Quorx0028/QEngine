import {
  createPlaneGeometry,
  createWorldBuilder,
  material,
  OrbitControls,
  type CloudStyle,
  type Engine,
} from 'quark-engine';

type WeatherKind = 'clear' | 'rain' | 'downpour' | 'snow';

export interface WebShowcaseController {
  update: (dt: number, elapsed: number) => void;
  dispose: () => void;
}

type RainCamView = 'street' | 'sky' | 'puddles' | 'shelter';

export function startWebShowcaseMode(
  engine: Engine,
  overlayEl: HTMLElement,
  onExitToArena: () => void,
  playSfx: (freq: number, dur?: number, type?: OscillatorType, gain?: number) => void
): WebShowcaseController {
  const { scene, assets, canvas } = engine;
  const viewportCanvas = canvas!;

  assets.unloadTag('scene');
  assets.unloadTag('scene-fx');
  assets.unloadTag('scene-holo');
  scene.clear();

  scene.camera.mode = '3d';
  scene.shadowsEnabled = true;
  scene.light.direction = [0.55, 0.85, 0.4];
  scene.light.color = [1.0, 0.97, 0.92];
  scene.light.intensity = 1.35;
  scene.light.ambientColor = [0.28, 0.34, 0.44];
  scene.skyTopColor = [0.14, 0.42, 0.86];
  scene.skyHorizonColor = [0.64, 0.82, 0.98];
  scene.fogColor = [0.6, 0.77, 0.93];
  scene.fogDensity = 0.007;
  scene.setWeather('rain');
  scene.setCloudStyle('dramatic');
  scene.advanceEffects(2.5);
  scene.postProcess.bloomIntensity = 0.24;
  scene.postProcess.ssao = 0.55;
  scene.postProcess.screenOutline = 0;

  // Build cozy 3D street-corner diorama for the interactive Rain article widget
  const floorMesh = assets.registerMesh('site-street-floor', createPlaneGeometry(36, 36, 16), 'scene');
  const asphaltMat = material('ultraRealism')
    .color('#2b3442')
    .roughness(0.56)
    .metallic(0.08)
    .create(assets, 'site-asphalt', 'scene');
  const floorVis = scene.createEntity();
  scene.setTransform(floorVis, { position: [0, 0, 0], immediate: true });
  scene.setMesh3D(floorVis, { meshId: floorMesh.meshId, materialId: asphaltMat, boundsRadius: 28 });

  const floorCol = scene.createEntity();
  scene.setTransform(floorCol, { position: [0, -0.5, 0], immediate: true });
  scene.setCollider3D(floorCol, { kind: 'aabb', halfExtents: [18, 0.5, 18] });

  const world = createWorldBuilder(scene, assets, 'scene');
  // Sidewalk curb & crosswalk markings
  world.box({
    pos: [-4.5, 0.1, 0],
    size: [7.0, 0.2, 18.0],
    material: material('ultraRealism').color('#64748b').roughness(0.72),
  });
  for (let i = -3; i <= 3; i += 2) {
    world.box({
      pos: [1.6, 0.015, i * 1.1],
      size: [2.2, 0.03, 0.7],
      collider: false,
      material: material('ultraRealism').color('#cbd5e1').roughness(0.5),
    });
  }

  // Brick & glass bus-stop shelter (auto-registers dry zone under its roof!)
  world.room({
    center: [-4.2, 0.2, -1.2],
    size: [4.8, 3.0, 4.4],
    doors: ['east'],
    windows: ['north', 'south'],
    roof: true,
    floor: true,
    wallMaterial: material('ultraRealism').color('#334155').roughness(0.62),
    floorMaterial: material('ultraRealism').color('#475569').roughness(0.5),
    doorMaterial: material('ultraRealism').color('#0f766e').roughness(0.35),
    light: { color: '#fbbf24', intensity: 2.3, radius: 7.5, godRay: false },
  });

  // Cozy streetlamp pole next to the shelter
  world.cylinder({
    pos: [-1.4, 2.0, 2.2],
    radius: 0.09,
    height: 4.0,
    material: material('ultraRealism').color('#1e293b').metallic(0.85).roughness(0.28),
  });
  world.sphere({
    pos: [-1.4, 4.15, 2.2],
    radius: 0.24,
    collider: false,
    material: material('cyberNeon').color('#fef08a').glow('#f59e0b'),
  });
  if (scene.pointLights.length < 4) {
    scene.pointLights.push({
      position: [-1.4, 3.9, 2.2],
      color: [1.0, 0.84, 0.48],
      intensity: 1.9,
      radius: 9.0,
    });
  }

  // Park trees on the sidewalk
  for (const [tx, tz] of [
    [-6.2, 5.2],
    [-6.0, -6.5],
  ] as Array<[number, number]>) {
    world.cylinder({
      pos: [tx, 1.0, tz],
      radius: 0.18,
      height: 1.9,
      material: material('ultraRealism').color('#78350f').roughness(0.82),
    });
    world.sphere({
      pos: [tx, 2.45, tz],
      radius: 1.05,
      material: material('animeToon').color('#15803d').roughness(0.75),
    });
  }

  // Real 3D deep puddle / drainage pool along the curb
  world.pool({
    center: [4.2, 0.0, 2.5],
    size: [4.2, 0.35, 5.2],
    waterPreset: 'realistic',
    wallMaterial: material('ultraRealism').color('#475569').roughness(0.55),
    floorMaterial: material('ultraRealism').color('#1e293b').roughness(0.35),
  });

  // Render clean light-mode editorial website HTML
  overlayEl.innerHTML = `
    <header class="site-nav">
      <div class="site-nav-inner">
        <div class="site-brand">
          <span>Метео-Журнал</span>
          <span class="site-brand-badge">Интерактив + 3D</span>
        </div>
        <nav class="site-nav-links">
          <a href="#sec-what">Откуда берётся дождь</a>
          <a href="#sec-clouds">Облака</a>
          <a href="#sec-puddles">Лужи и круги</a>
          <a href="#sec-shelter">Под крышей</a>
          <button id="site-exit-btn" class="site-exit-btn">← Назад в Арену</button>
        </nav>
      </div>
    </header>

    <main class="site-main">
      <article class="article-body">
        <div class="article-kicker">Атмосфера и физика · Разбор с 3D-сценой</div>
        <h1 class="article-title">Что такое дождь: от невидимого пара в небе до кругов на лужах</h1>
        <p class="article-lead">
          Каждый день на Землю проливается около 1,4 миллиарда тонн воды. Разбираемся простым языком — и с живым 3D-виджетом справа, в котором можно крутить сцену и менять погоду — как воздух удерживает целые озёра и почему капли падают именно с такой скоростью.
        </p>
        <div class="article-meta">
          <span>Время чтения: 3 минуты</span>
          <span>•</span>
          <span>Справа: живая 3D-сцена на QuarkEngine</span>
        </div>

        <div class="article-facts">
          <div class="fact-card">
            <div class="fact-num">0.5–5 мм</div>
            <div class="fact-label">типичный диаметр дождевой капли</div>
          </div>
          <div class="fact-card">
            <div class="fact-num">~9 м/с</div>
            <div class="fact-label">предельная скорость падения крупной капли</div>
          </div>
          <div class="fact-card">
            <div class="fact-num">1 000 000</div>
            <div class="fact-label">облачных микрокапель нужно для одной капли дождя</div>
          </div>
        </div>

        <h2 id="sec-what">1. Почему вода сначала «висит» в небе, а потом падает</h2>
        <p>
          Солнце нагревает океаны, реки и влажную почву, превращая воду в невидимый пар. Тёплый воздух легче холодного и поднимается вверх. Чем выше — тем холоднее и ниже давление: пар остывает и конденсируется вокруг микроскопических пылинок и кристаллов соли.
        </p>
        <p>
          Пока капельки крошечные (около 0.02 мм), восходящие потоки воздуха легко держат их на весу — именно их мы видим как белые облака. Дождь начинается в тот момент, когда миллионы капелек сливаются (коалесценция) в капли тяжелее 0.5 мм и сила тяжести побеждает ветер.
        </p>

        <h2 id="sec-clouds">2. Какие облака приносят дождь</h2>
        <p>
          Не каждое облако способно дать ливень. Лёгкие перистые облака на высоте 8–10 км состоят из кристалликов льда и почти не проливаются. Кучевые выглядят объёмными «башнями», а настоящие грозовые и слоисто-дождевые облака темнеют снизу потому, что становятся слишком плотными и не пропускают солнечный свет.
        </p>
        <div class="inline-Try">
          <button class="site-chip" data-preset-combo="sunny">☀️ Показать солнечное небо</button>
          <button class="site-chip active" data-preset-combo="rainy">🌧️ Показать дождевые тучи</button>
          <button class="site-chip" data-preset-combo="storm">⛈️ Сильный ливень</button>
        </div>

        <div class="article-callout">
          <strong>Миф о форме капли:</strong> на рисунках каплю изображают как «слёзку» с острым хвостиком. На деле из-за сопротивления воздуха снизу мелкие капли почти шарообразны, а крупные сплющиваются в маленькие парашюты или булочки для бургера — и если вырастают больше 6 мм, разрываются потоком воздуха.
        </div>

        <h2 id="sec-puddles">3. Почему темнеет асфальт и появляются круги на воде</h2>
        <p>
          Когда дождь касается сухого пористого асфальта, вода заполняет микротрещины. Свет меньше рассеивается во все стороны и отражается зеркально — поэтому мокрая дорога кажется заметно темнее и начинает отражать небо и фонари.
        </p>
        <p>
          Когда слой воды образует лужу, каждая упавшая капля создаёт упругие капиллярные волны — те самые концентрические кольца. Переключите ракурс в виджете на «Лужи», чтобы рассмотреть их вблизи в 3D.
        </p>
        <div class="inline-Try">
          <button class="site-chip" data-focus-view="puddles">🔍 Приблизить асфальт и лужи</button>
        </div>

        <table class="article-table">
          <thead>
            <tr>
              <th>Тип осадков</th>
              <th>Размер капель / хлопьев</th>
              <th>Скорость падения</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Морось</td>
              <td>0.2 – 0.5 мм</td>
              <td>1 – 2 м/с</td>
            </tr>
            <tr>
              <td>Обычный дождь</td>
              <td>0.8 – 2.5 мм</td>
              <td>4 – 7 м/с</td>
            </tr>
            <tr>
              <td>Ливень</td>
              <td>3.0 – 5.5 мм</td>
              <td>8 – 9.5 м/с</td>
            </tr>
            <tr>
              <td>Снег</td>
              <td>2.0 – 10 мм (хлопья)</td>
              <td>0.8 – 1.5 м/с</td>
            </tr>
          </tbody>
        </table>

        <h2 id="sec-shelter">4. Сухая зона под крышей и круговорот воды</h2>
        <p>
          В 3D-движке, как и в природе, осадки не пролетают сквозь препятствия: капли бьются о крышу навеса и стекают по краям, оставляя асфальт внутри сухим. Как только облака выливают влагу и небо проясняется, солнце снова нагревает лужи — цикл запускается заново.
        </p>
        <div class="inline-Try">
          <button class="site-chip" data-focus-view="shelter">🏠 Заглянуть под навес в 3D</button>
        </div>
      </article>

      <aside class="widget-col">
        <div class="widget-card">
          <div class="widget-head">
            <strong>3D-виджет: Улица и осадки</strong>
            <span>ЛКМ — вращать · Колесо — зум</span>
          </div>
          <div class="widget-stage" id="site-widget-stage"></div>
          <div class="widget-controls">
            <div class="widget-row">
              <span class="widget-row-label">Погода:</span>
              <button class="site-chip" data-w="clear">Ясно</button>
              <button class="site-chip active" data-w="rain">Дождь</button>
              <button class="site-chip" data-w="downpour">Ливень</button>
              <button class="site-chip" data-w="snow">Снег</button>
            </div>
            <div class="widget-row">
              <span class="widget-row-label">Облака:</span>
              <button class="site-chip" data-c="realistic">Кучевые</button>
              <button class="site-chip active" data-c="dramatic">Гроза</button>
              <button class="site-chip" data-c="clear">Дымка</button>
            </div>
            <div class="widget-row">
              <span class="widget-row-label">Ракурс:</span>
              <button class="site-chip active" data-v="street">Улица</button>
              <button class="site-chip" data-v="sky">Небо</button>
              <button class="site-chip" data-v="puddles">Лужи</button>
              <button class="site-chip" data-v="shelter">Под навесом</button>
            </div>
          </div>
          <div class="widget-caption">
            Живой встроенный виджет на <b>QuarkEngine</b> внутри обычной HTML-статьи: те же столкновения капель с крышей, лужи и процедурные облака.
          </div>
        </div>
      </aside>
    </main>
  `;
  overlayEl.classList.add('visible');

  // Embed live #viewport canvas directly inside the article's 3D widget card!
  const widgetStage = overlayEl.querySelector('#site-widget-stage') as HTMLElement;
  widgetStage.appendChild(viewportCanvas);
  engine.syncCanvasSize();

  const resizeObs = new ResizeObserver(() => engine.syncCanvasSize());
  resizeObs.observe(widgetStage);

  const orbit = new OrbitControls({ target: [-1.2, 1.5, -0.4], radius: 10.5, theta: 0.62, phi: 1.24 });
  orbit.autoRotate = false;
  orbit.attach(viewportCanvas);
  orbit.enabled = true;

  let activeWeather: WeatherKind = 'rain';
  let weatherAcc = 0;

  const syncChip = (attr: string, val: string) => {
    overlayEl.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((b) => {
      b.classList.toggle('active', b.getAttribute(attr) === val);
    });
  };

  const applyWeather = (w: WeatherKind) => {
    activeWeather = w;
    scene.setWeather(w);
    if (w === 'clear') {
      scene.skyTopColor = [0.14, 0.42, 0.86];
      scene.skyHorizonColor = [0.64, 0.82, 0.98];
      scene.fogColor = [0.6, 0.77, 0.93];
      scene.light.intensity = 1.45;
    } else if (w === 'snow') {
      scene.skyTopColor = [0.22, 0.3, 0.44];
      scene.skyHorizonColor = [0.68, 0.74, 0.84];
      scene.fogColor = [0.62, 0.69, 0.78];
      scene.light.intensity = 0.85;
    } else if (w === 'downpour') {
      scene.skyTopColor = [0.08, 0.12, 0.2];
      scene.skyHorizonColor = [0.24, 0.3, 0.4];
      scene.fogColor = [0.22, 0.28, 0.38];
      scene.light.intensity = 0.75;
    } else {
      scene.skyTopColor = [0.14, 0.22, 0.36];
      scene.skyHorizonColor = [0.38, 0.48, 0.62];
      scene.fogColor = [0.34, 0.44, 0.58];
      scene.light.intensity = 0.95;
    }
    syncChip('data-w', w);
  };

  const applyClouds = (c: CloudStyle) => {
    scene.setCloudStyle(c);
    syncChip('data-c', c);
  };

  const applyView = (v: RainCamView) => {
    if (v === 'sky') {
      orbit.setView([-1.2, 4.2, -0.4], 9.0, 0.4, 1.72);
    } else if (v === 'puddles') {
      orbit.setView([2.6, 0.2, 2.2], 5.4, 0.82, 1.12);
    } else if (v === 'shelter') {
      orbit.setView([-3.6, 1.4, -1.0], 5.2, 1.25, 1.32);
    } else {
      orbit.setView([-1.2, 1.5, -0.4], 10.5, 0.62, 1.24);
    }
    syncChip('data-v', v);
  };

  applyWeather('rain');

  overlayEl.querySelector('#site-exit-btn')?.addEventListener('click', onExitToArena);
  overlayEl.querySelectorAll<HTMLButtonElement>('[data-w]').forEach((b) => {
    b.onclick = () => {
      applyWeather((b.dataset.w as WeatherKind) ?? 'rain');
      playSfx(520, 0.06, 'sine', 0.07);
    };
  });
  overlayEl.querySelectorAll<HTMLButtonElement>('[data-c]').forEach((b) => {
    b.onclick = () => {
      applyClouds((b.dataset.c as CloudStyle) ?? 'realistic');
      playSfx(620, 0.06, 'triangle', 0.07);
    };
  });
  overlayEl.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((b) => {
    b.onclick = () => {
      applyView((b.dataset.v as RainCamView) ?? 'street');
      playSfx(680, 0.06, 'sine', 0.07);
    };
  });
  overlayEl.querySelectorAll<HTMLButtonElement>('[data-focus-view]').forEach((b) => {
    b.onclick = () => {
      applyView((b.dataset.focusView as RainCamView) ?? 'street');
      playSfx(680, 0.06, 'sine', 0.07);
    };
  });
  overlayEl.querySelectorAll<HTMLButtonElement>('[data-preset-combo]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.presetCombo;
      overlayEl.querySelectorAll('[data-preset-combo]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      if (k === 'sunny') {
        applyWeather('clear');
        applyClouds('realistic');
        applyView('sky');
      } else if (k === 'storm') {
        applyWeather('downpour');
        applyClouds('dramatic');
        applyView('street');
      } else {
        applyWeather('rain');
        applyClouds('dramatic');
        applyView('street');
      }
      playSfx(580, 0.08, 'sine', 0.08);
    };
  });

  orbit.update(0.016, scene.camera);

  return {
    update(dt: number) {
      orbit.update(dt, scene.camera);
      if (activeWeather !== 'clear') {
        weatherAcc += dt;
        const interval = activeWeather === 'downpour' ? 0.02 : activeWeather === 'rain' ? 0.032 : 0.04;
        if (weatherAcc >= interval) {
          weatherAcc = 0;
          const count = activeWeather === 'downpour' ? 54 : activeWeather === 'rain' ? 28 : 22;
          scene.emitVfx(activeWeather, [-1.5, 11.5, -0.5], count, 0.02);
        }
      }
    },

    dispose() {
      resizeObs.disconnect();
      orbit.enabled = false;
      orbit.detach();
      // Move canvas cleanly back to document.body and restore full-viewport size
      document.body.prepend(viewportCanvas);
      overlayEl.classList.remove('visible');
      overlayEl.innerHTML = '';
      engine.syncCanvasSize();
    },
  };
}
