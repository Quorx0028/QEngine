import type {
  CloudStyle,
  QualityPreset,
  QuarkProjectDoc,
  WeatherType,
} from 'quark-engine';

const MOODS = {
  daylight: {
    label: 'День',
    skyTop: [0.12, 0.34, 0.68] as [number, number, number],
    skyHorizon: [0.64, 0.78, 0.92] as [number, number, number],
    fogColor: [0.56, 0.7, 0.86] as [number, number, number],
    lightDir: [0.55, 0.85, 0.42] as [number, number, number],
    lightColor: [1.0, 0.97, 0.92] as [number, number, number],
    ambientColor: [0.26, 0.31, 0.4] as [number, number, number],
  },
  sunset: {
    label: 'Закат',
    skyTop: [0.16, 0.13, 0.34] as [number, number, number],
    skyHorizon: [0.96, 0.56, 0.34] as [number, number, number],
    fogColor: [0.64, 0.4, 0.36] as [number, number, number],
    lightDir: [0.82, 0.34, -0.42] as [number, number, number],
    lightColor: [1.0, 0.72, 0.48] as [number, number, number],
    ambientColor: [0.28, 0.2, 0.26] as [number, number, number],
  },
  cyber: {
    label: 'Кибер-ночь',
    skyTop: [0.03, 0.05, 0.14] as [number, number, number],
    skyHorizon: [0.08, 0.16, 0.34] as [number, number, number],
    fogColor: [0.05, 0.09, 0.2] as [number, number, number],
    lightDir: [-0.45, 0.78, 0.5] as [number, number, number],
    lightColor: [0.55, 0.75, 1.0] as [number, number, number],
    ambientColor: [0.14, 0.18, 0.28] as [number, number, number],
  },
  pastel: {
    label: 'Пастель',
    skyTop: [0.42, 0.58, 0.94] as [number, number, number],
    skyHorizon: [0.98, 0.82, 0.9] as [number, number, number],
    fogColor: [0.82, 0.78, 0.92] as [number, number, number],
    lightDir: [0.5, 0.9, 0.3] as [number, number, number],
    lightColor: [1.0, 0.96, 1.0] as [number, number, number],
    ambientColor: [0.34, 0.32, 0.42] as [number, number, number],
  },
};

const QUALITIES: QualityPreset[] = ['eco', 'low', 'medium', 'high', 'ultra'];

export class WorldSettingsPanel {
  private readonly root: HTMLElement;
  private readonly getDoc: () => QuarkProjectDoc;
  private readonly onMutate: (rebuild: boolean) => void;

  constructor(root: HTMLElement, getDoc: () => QuarkProjectDoc, onMutate: (rebuild: boolean) => void) {
    this.root = root;
    this.getDoc = getDoc;
    this.onMutate = onMutate;
  }

  render(): void {
    const doc = this.getDoc();
    const env = doc.environment;
    this.root.innerHTML = '';

    const shell = document.createElement('div');
    shell.className = 'world-shell';

    const c1 = document.createElement('div');
    c1.className = 'card';
    c1.innerHTML = `<div class="card-title">Небо и погода</div>`;

    const selMood = document.createElement('select');
    selMood.setAttribute('aria-label', 'Освещение неба');
    for (const [k, v] of Object.entries(MOODS)) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = v.label;
      if (env.moodName === k) o.selected = true;
      selMood.appendChild(o);
    }
    selMood.onchange = () => {
      const m = MOODS[selMood.value as keyof typeof MOODS];
      env.moodName = selMood.value as typeof env.moodName;
      env.skyTop = [...m.skyTop];
      env.skyHorizon = [...m.skyHorizon];
      env.fogColor = [...m.fogColor];
      env.lightDir = [...m.lightDir];
      env.lightColor = [...m.lightColor];
      env.ambientColor = [...m.ambientColor];
      this.onMutate(true);
    };

    const selWeather = document.createElement('select');
    selWeather.setAttribute('aria-label', 'Погода');
    for (const [id, lbl] of [['clear', 'Ясно'], ['snow', 'Снег'], ['rain', 'Дождь'], ['downpour', 'Ливень']] as const) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = lbl;
      if (env.weather === id) o.selected = true;
      selWeather.appendChild(o);
    }
    selWeather.onchange = () => {
      env.weather = selWeather.value as WeatherType;
      this.onMutate(true);
    };

    const selCloud = document.createElement('select');
    selCloud.setAttribute('aria-label', 'Стиль облаков');
    for (const [id, lbl] of [['realistic', 'Реализм'], ['anime', 'Аниме'], ['dramatic', 'Шторм'], ['clear', 'Чистое']] as const) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = lbl;
      if (env.cloudStyle === id) o.selected = true;
      selCloud.appendChild(o);
    }
    selCloud.onchange = () => {
      env.cloudStyle = selCloud.value as CloudStyle;
      this.onMutate(true);
    };

    const chkSh = document.createElement('label');
    chkSh.className = 'tb-chk';
    const cbSh = document.createElement('input');
    cbSh.type = 'checkbox';
    cbSh.checked = env.shadowsEnabled;
    cbSh.onchange = () => {
      env.shadowsEnabled = cbSh.checked;
      this.onMutate(true);
    };
    chkSh.append(cbSh, document.createTextNode('Тени'));

    c1.append(selMood, selWeather, selCloud, chkSh);

    const c2 = document.createElement('div');
    c2.className = 'card';
    c2.innerHTML = `<div class="card-title">Качество графики</div>`;
    const qWrap = document.createElement('div');
    qWrap.className = 'quality-segs';
    for (const q of QUALITIES) {
      const b = document.createElement('button');
      b.textContent = q.toUpperCase();
      if (env.quality === q) b.classList.add('active');
      b.onclick = () => {
        env.quality = q;
        this.onMutate(true);
        this.render();
      };
      qWrap.appendChild(b);
    }

    const addSlider = (label: string, min: number, max: number, step: number, val: number, onSet: (v: number) => void) => {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:11px;';
      const sp = document.createElement('span');
      sp.textContent = `${label} ${val.toFixed(2)}`;
      const rng = document.createElement('input');
      rng.type = 'range';
      rng.min = String(min);
      rng.max = String(max);
      rng.step = String(step);
      rng.value = String(val);
      rng.oninput = () => {
        const nv = Number(rng.value);
        sp.textContent = `${label} ${nv.toFixed(2)}`;
        onSet(nv);
      };
      rng.onchange = () => this.onMutate(true);
      wrap.append(sp, rng);
      return wrap;
    };

    c2.append(
      qWrap,
      addSlider('Bloom', 0, 1.2, 0.05, env.postProcess.bloomIntensity, (v) => {
        env.postProcess.enabled = true;
        env.postProcess.bloomIntensity = v;
      }),
      addSlider('SSAO', 0, 1.0, 0.05, env.postProcess.ssao, (v) => {
        env.postProcess.enabled = true;
        env.postProcess.ssao = v;
      }),
      addSlider('Outline', 0, 1.0, 0.05, env.postProcess.screenOutline, (v) => {
        env.postProcess.enabled = true;
        env.postProcess.screenOutline = v;
      })
    );

    const c3 = document.createElement('div');
    c3.className = 'card';
    c3.innerHTML = `<div class="card-title">Игрок</div>`;

    const chkPl = document.createElement('label');
    chkPl.className = 'tb-chk';
    const cbPl = document.createElement('input');
    cbPl.type = 'checkbox';
    cbPl.checked = doc.player.enabled;
    cbPl.onchange = () => {
      doc.player.enabled = cbPl.checked;
      this.onMutate(false);
    };
    chkPl.append(cbPl, document.createTextNode('Спавнить игрока при запуске'));

    const spawnGrid = document.createElement('div');
    spawnGrid.className = 'vec3-grid';
    (['X', 'Y', 'Z'] as const).forEach((axis, idx) => {
      const lbl = document.createElement('label');
      lbl.textContent = axis;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = '0.5';
      inp.value = String(doc.player.spawnPos[idx]);
      inp.onchange = () => {
        doc.player.spawnPos[idx] = Number(inp.value);
        this.onMutate(false);
      };
      lbl.appendChild(inp);
      spawnGrid.appendChild(lbl);
    });

    c3.append(
      chkPl,
      spawnGrid,
      addSlider('Скорость', 2, 16, 0.5, doc.player.moveSpeed, (v) => (doc.player.moveSpeed = v)),
      addSlider('Прыжок', 3, 18, 0.5, doc.player.jumpSpeed, (v) => (doc.player.jumpSpeed = v))
    );

    shell.append(c1, c2, c3);
    this.root.appendChild(shell);
  }
}
