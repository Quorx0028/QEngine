import {
  createPostProcessPreset,
  createPresetMaterial,
  DialogueRunner,
  Engine,
  HotspotOverlay,
  OrbitControls,
  POST_PROCESS_PRESET_NAMES,
  SHADER_BLOCK_IDS,
  SHADER_PRESET_NAMES,
  TransformGizmo,
  type GizmoMode,
  type MaterialDesc,
  type OrbitKeyframe,
  type PostProcessPresetName,
  type ShaderBlockId,
  type ShaderPresetName,
  type Vec3Tuple,
} from 'quark-engine';
import wasmUrl from 'quark-engine/wasm?url';
import {
  buildShowcaseArena,
  type ArenaController,
  type SceneMaterialMeta,
} from './arenaBuilder';
import { startForestEscapeGame, type ForestGameController } from './forestGame';

type MoodName = 'daylight' | 'sunset' | 'cyber' | 'pastel';

const MOODS: Record<
  MoodName,
  {
    skyTop: Vec3Tuple;
    skyHorizon: Vec3Tuple;
    fogColor: Vec3Tuple;
    lightDir: Vec3Tuple;
    lightColor: Vec3Tuple;
    ambient: Vec3Tuple;
  }
> = {
  daylight: {
    skyTop: [0.12, 0.34, 0.68],
    skyHorizon: [0.58, 0.74, 0.92],
    fogColor: [0.52, 0.68, 0.86],
    lightDir: [0.55, 0.85, 0.45],
    lightColor: [1.0, 0.98, 0.92],
    ambient: [0.25, 0.29, 0.38],
  },
  sunset: {
    skyTop: [0.16, 0.12, 0.34],
    skyHorizon: [0.95, 0.48, 0.32],
    fogColor: [0.62, 0.36, 0.34],
    lightDir: [-0.75, 0.36, 0.52],
    lightColor: [1.0, 0.68, 0.42],
    ambient: [0.28, 0.2, 0.28],
  },
  cyber: {
    skyTop: [0.03, 0.04, 0.11],
    skyHorizon: [0.12, 0.16, 0.32],
    fogColor: [0.07, 0.09, 0.18],
    lightDir: [0.4, 0.8, 0.4],
    lightColor: [0.55, 0.75, 1.0],
    ambient: [0.14, 0.18, 0.28],
  },
  pastel: {
    skyTop: [0.42, 0.58, 0.94],
    skyHorizon: [0.98, 0.82, 0.9],
    fogColor: [0.82, 0.78, 0.92],
    lightDir: [0.5, 0.9, 0.3],
    lightColor: [1.0, 0.96, 1.0],
    ambient: [0.34, 0.32, 0.42],
  },
};

async function bootstrap() {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const statsEl = document.getElementById('stats')!;
  const crosshairEl = document.getElementById('crosshair')!;
  const dialogueBox = document.getElementById('dialogue-box')!;
  const dialogueNameEl = document.getElementById('dialogue-name')!;
  const dialogueTextEl = document.getElementById('dialogue-text')!;
  const hudPanel = document.getElementById('hud-panel')!;
  const interactPromptEl = document.getElementById('interact-prompt')!;

  const engine = await Engine.init({ canvas, wasmUrl });
  const { scene, assets, input, audio } = engine;

  let mode: '3d' | '2d' | 'forest' = '3d';
  let cameraMode: 'fps' | 'orbit' = 'fps';
  const orbit = new OrbitControls({ target: [0, 2.7, -3], radius: 7.5, phi: 1.15, autoRotate: true });
  orbit.enabled = false;
  const hotspots = new HotspotOverlay(scene, canvas, orbit);
  hotspots.setVisible(false);
  const gizmoStatusEl = document.getElementById('gizmo-status')!;
  const btnGizmoToggle = document.getElementById('btn-gizmo-toggle')!;
  const gizmo = new TransformGizmo(scene, assets, orbit, {
    isSelectable: (eid) => eid !== player && eid !== arena?.floorEntity,
    onSelect: (eid) => {
      gizmoStatusEl.textContent = eid !== null
        ? `Выбрано: Entity #${eid} (тяни за X/Y/Z)`
        : gizmo.isEnabled()
          ? 'Кликни куб, сферу или кристалл в Orbit 3D'
          : 'Включи Gizmo и кликни объект в Orbit 3D';
    },
  });
  let weatherMode: 'clear' | 'snow' | 'rain' | 'downpour' = 'clear';
  let weatherAcc = 0;
  let forestGame: ForestGameController | null = null;
  let arena: ArenaController | null = null;
  let sfxEnabled = true;
  let player = 0;
  let crystalEntity = 0;
  let crystalMatId = 0;
  let propsMatId = 0;
  let editTarget: 'all' | 'crystal' | 'props' = 'all';
  let activePreset: ShaderPresetName = 'ultraRealism';
  let activePpPreset: PostProcessPresetName = 'ultraRealism';
  let yaw = 0;
  let pitch = -0.16;
  let hero2d = 0;
  let spinTime = 0;
  let wasGrounded = true;

  // 2D dialogue state backed by DialogueRunner
  const dialogueRunner = new DialogueRunner([
    {
      id: 'aubrey_1',
      speaker: 'AUBREY',
      text: 'Привет! Видишь 2D фонарь, мягкие тени и Y-сортировку без зацепов на тайлах?',
      nextId: 'aubrey_2',
    },
    {
      id: 'aubrey_2',
      speaker: 'AUBREY',
      text: 'Нажми E ещё раз, чтобы закрыть диалог, и загляни в 3D Arena — там лестница и дверь на петлях!',
    },
    {
      id: 'kel_1',
      speaker: 'KEL',
      text: 'Попробуй переключиться в Forest Escape! Теперь фонарик — настоящий GPU SpotLight с тенями и светлячками.',
    },
  ]);
  let dialogueFull = '';
  let dialogueShown = 0;
  let dialogueActive = false;
  let npcs2d: Array<{ x: number; y: number; startNode: string }> = [];

  const crystalDesc: MaterialDesc = createPresetMaterial('crystalGlass', {
    uniforms: {
      baseColor: [0.52, 0.9, 1.0, 0.86],
      glowColor: [0.32, 0.92, 1.0],
      rimColor: [0.95, 0.92, 1.0],
    },
  });
  const propsDesc: MaterialDesc = createPresetMaterial('ultraRealism', {
    uniforms: { baseColor: [0.92, 0.78, 0.62, 1.0], roughness: 0.42 },
  });
  const worldDesc: MaterialDesc = createPresetMaterial('ultraRealism');

  function playSfx(freq: number, dur = 0.08, type: OscillatorType = 'triangle', vol = 0.12) {
    if (sfxEnabled) audio.playTone(freq, dur, type, vol);
  }

  function applyMood(mood: MoodName) {
    const m = MOODS[mood];
    scene.skyTopColor = [...m.skyTop];
    scene.skyHorizonColor = [...m.skyHorizon];
    scene.fogColor = [...m.fogColor];
    scene.light.direction = [...m.lightDir];
    scene.light.color = [...m.lightColor];
    scene.light.ambientColor = [...m.ambient];
  }

  const forestHudEl = document.getElementById('forest-hud')!;
  const forestBannerEl = document.getElementById('forest-banner')!;

  function hideForestUi() {
    forestGame = null;
    forestHudEl.style.display = 'none';
    forestBannerEl.style.display = 'none';
    interactPromptEl.classList.remove('visible');
    hotspots.clear();
    hotspots.setVisible(false);
    gizmo.setEnabled(false);
    gizmo.detach();
    gizmo.resetHandles();
    btnGizmoToggle.textContent = 'Gizmo: ВЫКЛ';
    btnGizmoToggle.classList.remove('active');
    assets.unloadTag('gizmo');
    assets.unloadTag('scene-fx');
    assets.unloadTag('scene-holo');
  }

  const sceneMaterialMeta = new Map<number, SceneMaterialMeta>();

  function build3DArena() {
    hideForestUi();
    sceneMaterialMeta.clear();
    scene.clear();
    assets.unloadTag('scene');
    dialogueActive = false;
    dialogueBox.classList.remove('visible');
    crosshairEl.style.display = 'block';
    mode = '3d';
    applyMood((document.getElementById('sel-mood') as HTMLSelectElement).value as MoodName);

    arena = buildShowcaseArena({
      scene,
      assets,
      bridge: engine.bridge,
      crystalDesc,
      propsDesc,
      sceneMaterialMeta,
      playSfx,
    });
    player = arena.player;
    crystalEntity = arena.crystalEntity;
    crystalMatId = arena.crystalMatId;
    propsMatId = arena.propsMatId;
    yaw = 0;
    pitch = -0.14;
    wasGrounded = true;

    hotspots
      .add({
        id: 'hs-crystal',
        position: () => scene.getPosition(crystalEntity),
        label: 'Кристалл .GLB',
        badge: '3D VIEWER + SHADERS',
        description: 'Встроенный .GLB-парсер, OrbitControls и 15 шейдерных пресетов.',
        color: '#38bdf8',
        focusRadius: 6.2,
      })
      .add({
        id: 'hs-water',
        position: [14.5, 2.15, 3.0],
        label: 'Вода 3D Блок',
        badge: 'WATER VOLUME + UNDERWATER',
        description: 'Герстнер-волны + стенки, Архимед, брызги GPU и авто-подводный шейдер.',
        color: '#22d3ee',
        focusRadius: 8.0,
        focusTheta: 0.28,
        focusPhi: 1.24,
      })
      .add({
        id: 'hs-fire',
        position: [5.2, 1.35, -2.2],
        label: 'Костёр (GPU 8K)',
        badge: 'INSTANCED VFX',
        description: 'Огонь, дым и отскакивающие от пола искры за 2 draw call.',
        color: '#fb923c',
        focusRadius: 5.5,
      })
      .add({
        id: 'hs-room',
        position: [-11.5, 2.4, 3.0],
        label: 'Тёмная комната + Лучи',
        badge: 'GOD-RAYS + SPOT SHADOWS',
        description: 'Объёмный луч света, реальные тени SpotLight и дверь на [E].',
        color: '#fbbf24',
        focusRadius: 5.8,
      })
      .add({
        id: 'hs-ai',
        position: [12.0, 5.2, 23.0],
        label: 'Двор ИИ (WorldBuilder)',
        badge: 'FROMGRID + ROOM + STAIRS',
        description: 'Собрано декларативным API для нейросетей за несколько строк.',
        color: '#c084fc',
        focusRadius: 12.0,
      });
    syncHotspotsVisibility();
  }

  function build2DOMORIStyleScene() {
    arena = null;
    hideForestUi();
    scene.clear();
    assets.unloadTag('scene');
    if (document.pointerLockElement) document.exitPointerLock();
    crosshairEl.style.display = 'none';
    mode = '2d';
    scene.camera.mode = '2d';
    scene.camera.orthoHeight = 13;
    scene.camera.pixelSnap = true;
    scene.setGravity(0, 0, 0);

    const makeSpritePixels = (shirt: [number, number, number], hair: [number, number, number]) => {
      const pixels = new Uint8Array(16 * 16 * 4);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const i = (y * 16 + x) * 4;
          const border = x === 0 || x === 15 || y === 0 || y === 15;
          const eyes = y === 10 && (x === 5 || x === 10);
          if (border || eyes) {
            pixels.set([18, 16, 28, 255], i);
          } else if (y >= 12) {
            pixels.set([hair[0], hair[1], hair[2], 255], i);
          } else if (y >= 7) {
            pixels.set([246, 224, 210, 255], i);
          } else {
            pixels.set([shirt[0], shirt[1], shirt[2], 255], i);
          }
        }
      }
      return pixels;
    };

    const heroTex = assets.createTexture('hero-2d', 16, 16, makeSpritePixels([44, 42, 68], [24, 22, 36]), true, 'scene');
    const aubreyTex = assets.createTexture('npc-1', 16, 16, makeSpritePixels([110, 210, 200], [245, 130, 180]), true, 'scene');
    const kelTex = assets.createTexture('npc-2', 16, 16, makeSpritePixels([245, 145, 65], [64, 42, 30]), true, 'scene');

    const w = 17;
    const h = 13;
    const solid = new Uint8Array(w * h);
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const isWall =
          tx === 0 ||
          ty === 0 ||
          tx === w - 1 ||
          ty === h - 1 ||
          (tx === 5 && ty >= 3 && ty <= 8) ||
          (tx === 11 && ty >= 4 && ty <= 9);
        solid[ty * w + tx] = isWall ? 1 : 0;
        if (isWall) {
          const tile = scene.createEntity();
          scene.setTransform(tile, { position: [tx - 8, ty - 6, 0], immediate: true });
          scene.setSprite2D(tile, { size: [0.98, 0.98], color: [0.28, 0.24, 0.42, 1], layer: 0 });
        } else {
          const floor = scene.createEntity();
          scene.setTransform(floor, { position: [tx - 8, ty - 6, -0.5], immediate: true });
          const shade = (tx + ty) % 2 === 0 ? 0.13 : 0.16;
          scene.setSprite2D(floor, { size: [1, 1], color: [shade, shade * 1.05, shade * 1.35, 1], layer: -2 });
        }
      }
    }
    scene.addTileGrid2D([-8.5, -6.5], 1.0, w, h, solid);

    npcs2d = [
      { x: -2, y: 2, startNode: 'aubrey_1' },
      { x: 3.5, y: -1.5, startNode: 'kel_1' },
    ];
    npcs2d.forEach((npc, i) => {
      const e = scene.createEntity();
      scene.setTransform(e, { position: [npc.x, npc.y, 0], immediate: true });
      scene.setCollider2D(e, { kind: 'aabb2d', halfExtents: [0.42, 0.42] });
      scene.setSprite2D(e, {
        size: [0.95, 0.95],
        textureId: i === 0 ? aubreyTex : kelTex,
        color: [1, 1, 1, 1],
        layer: 1,
      });
    });

    hero2d = scene.createEntity();
    scene.setTransform(hero2d, { position: [0, 0, 0], immediate: true });
    scene.setCollider2D(hero2d, { kind: 'circle2d', radius: 0.36 });
    scene.setRigidBody(hero2d, { dynamic: true, gravityScale: 0, lockRotation: true });
    scene.setSprite2D(hero2d, { size: [0.95, 0.95], textureId: heroTex, color: [1, 1, 1, 1], layer: 1 });

    // Moody 2D RPG lantern & campfire dynamic lighting
    scene.lights2d.ambientColor = [0.36, 0.40, 0.58];
    scene.lights2d.lights.push(
      { position: [0, 0], color: [1.0, 0.9, 0.65], radius: 5.5, intensity: 0.95 },
      { position: [-2, 2], color: [0.6, 0.95, 1.0], radius: 3.5, intensity: 0.65 },
      { position: [3.5, -1.5], color: [1.0, 0.65, 0.3], radius: 3.5, intensity: 0.65 }
    );
  }

  function spawnDynamicBody(kind: 'box' | 'sphere', onRamp = false) {
    if (mode !== '3d') return;
    const mesh = assets.getMesh(kind);
    if (!mesh) return;
    let spawnPos: Vec3Tuple;
    let vel: Vec3Tuple = [0, 0, 0];
    if (onRamp) {
      spawnPos = [-7.5 + (Math.random() - 0.5) * 1.4, 3.6, 1.4];
      vel = [(Math.random() - 0.5) * 1.2, -1.0, 2.2];
    } else {
      const [px, py, pz] = scene.getPosition(player);
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      spawnPos = [px + fx * 2.4, py + 1.1, pz + fz * 2.4];
      vel = [fx * 7.5, 3.2, fz * 7.5];
    }

    const physSel = document.getElementById('sel-phys-mat') as HTMLSelectElement | null;
    const physPreset = physSel?.value ?? 'wood';
    const physTable: Record<string, { mass: number; friction: number; restitution: number; linearDamping: number }> = {
      wood: { mass: 1.0, friction: 0.78, restitution: kind === 'sphere' ? 0.45 : 0.12, linearDamping: 0.1 },
      steel: { mass: 18.0, friction: 0.65, restitution: 0.08, linearDamping: 0.06 },
      ice: { mass: 1.0, friction: 0.02, restitution: 0.05, linearDamping: 0.02 },
      rubber: { mass: 1.5, friction: 0.9, restitution: 0.85, linearDamping: 0.05 },
    };
    const phys = physTable[physPreset] ?? physTable.wood;

    const e = scene.createEntity();
    scene.setTransform(e, { position: spawnPos, immediate: true });
    if (kind === 'box') {
      scene.setCollider3D(e, { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] });
    } else {
      scene.setCollider3D(e, { kind: 'sphere', radius: 0.55 });
    }
    scene.setRigidBody(e, {
      dynamic: true,
      mass: phys.mass,
      gravityScale: 1,
      restitution: phys.restitution,
      friction: phys.friction,
      linearDamping: phys.linearDamping,
      angularDamping: 0.35,
      lockRotation: false,
    });
    scene.setVelocity(e, vel[0], vel[1], vel[2]);
    if (kind === 'box' && !onRamp) {
      scene.setAngularVelocity(e, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4);
    }
    scene.setMesh3D(e, {
      meshId: mesh.meshId,
      materialId: propsMatId,
      transparent: propsDesc.transparent,
      boundsRadius: 1.2,
    });
    playSfx(kind === 'box' ? 320 : 480, 0.07, 'square', 0.09);
  }

  function getCameraLookRay(): { origin: [number, number, number]; dir: [number, number, number] } {
    const [ox, oy, oz] = scene.camera.position;
    let dx: number;
    let dy: number;
    let dz: number;
    if (cameraMode === 'orbit') {
      const [tx, ty, tz] = scene.camera.target;
      const vx = tx - ox;
      const vy = ty - oy;
      const vz = tz - oz;
      const len = Math.hypot(vx, vy, vz) || 1;
      dx = vx / len;
      dy = vy / len;
      dz = vz / len;
    } else {
      dx = -Math.sin(yaw) * Math.cos(pitch);
      dy = Math.sin(pitch);
      dz = -Math.cos(yaw) * Math.cos(pitch);
    }
    return {
      origin: [ox + dx * 0.65, oy + dy * 0.65, oz + dz * 0.65],
      dir: [dx, dy, dz],
    };
  }

  function fireRaycastImpulse() {
    if (mode !== '3d') return;
    const { origin, dir } = getCameraLookRay();
    const hit = scene.raycast3D(origin, dir, 40);
    if (hit && hit.entity !== player) {
      arena?.onRayHit(hit.entity, hit.point, hit.normal);
      scene.applyImpulse(hit.entity, [dir[0] * 9.5, dir[1] * 9.5 + 3.0, dir[2] * 9.5], hit.point);
      scene.triggerShake(0.08, 0.14);
      playSfx(190, 0.11, 'sawtooth', 0.12);
    }
  }

  function getActiveTarget(): { desc: MaterialDesc; matId: number } {
    if (editTarget === 'all') return { desc: worldDesc, matId: crystalMatId };
    return editTarget === 'crystal'
      ? { desc: crystalDesc, matId: crystalMatId }
      : { desc: propsDesc, matId: propsMatId };
  }

  function syncActiveMaterial() {
    const { desc, matId } = getActiveTarget();
    if (editTarget === 'all') {
      const ids = assets.getMaterialsByTag('scene');
      for (const id of ids) {
        const meta = sceneMaterialMeta.get(id);
        const blocks = meta?.keepGrid && !desc.blocks.includes('triplanarGrid')
          ? [...desc.blocks, 'triplanarGrid' as ShaderBlockId]
          : desc.blocks;
        assets.updateMaterial(id, {
          ...desc,
          blocks,
          textureId: meta?.textureId ?? desc.textureId,
          uniforms: {
            ...desc.uniforms,
            baseColor: meta ? meta.baseColor : desc.uniforms.baseColor,
          },
        });
      }
      syncUiFromActiveDesc();
      return;
    }
    if (!matId) return;
    assets.updateMaterial(matId, desc);
    if (editTarget === 'crystal' && crystalEntity) {
      const handle = assets.getMesh('sample-crystal');
      if (handle) {
        scene.setMesh3D(crystalEntity, {
          meshId: handle.meshId,
          materialId: crystalMatId,
          transparent: desc.transparent,
          boundsRadius: 3,
        });
      }
    }
    syncUiFromActiveDesc();
  }

  // Global Screen Post-Process Controls
  const ppWrap = document.getElementById('pp-preset-buttons')!;
  const ppButtons = new Map<PostProcessPresetName, HTMLButtonElement>();
  const chkPpCrt = document.getElementById('chk-pp-crt') as HTMLInputElement;
  const slPpBloom = document.getElementById('sl-pp-bloom') as HTMLInputElement;
  const slPpOutline = document.getElementById('sl-pp-outline') as HTMLInputElement;
  const slPpSsao = document.getElementById('sl-pp-ssao') as HTMLInputElement;
  const slPpPixel = document.getElementById('sl-pp-pixel') as HTMLInputElement;
  const slPpChrom = document.getElementById('sl-pp-chrom') as HTMLInputElement;
  const slPpWave = document.getElementById('sl-pp-wave') as HTMLInputElement;

  function syncPpUi() {
    const pp = scene.postProcess;
    chkPpCrt.checked = pp.crt;
    slPpBloom.value = String(pp.bloomIntensity);
    document.getElementById('val-pp-bloom')!.textContent = pp.bloomIntensity.toFixed(2);
    slPpOutline.value = String(pp.screenOutline);
    document.getElementById('val-pp-outline')!.textContent = pp.screenOutline.toFixed(2);
    slPpSsao.value = String(pp.ssao);
    document.getElementById('val-pp-ssao')!.textContent = pp.ssao.toFixed(2);
    slPpPixel.value = String(pp.pixelSize);
    document.getElementById('val-pp-pixel')!.textContent = String(pp.pixelSize);
    slPpChrom.value = String(pp.chromaticAberration);
    document.getElementById('val-pp-chrom')!.textContent = pp.chromaticAberration.toFixed(4);
    slPpWave.value = String(pp.waveStrength);
    document.getElementById('val-pp-wave')!.textContent = pp.waveStrength.toFixed(3);
  }

  for (const ppName of POST_PROCESS_PRESET_NAMES) {
    const btn = document.createElement('button');
    btn.textContent = ppName;
    if (ppName === activePpPreset) btn.classList.add('active');
    btn.onclick = () => {
      activePpPreset = ppName;
      scene.postProcess = createPostProcessPreset(ppName);
      ppButtons.forEach((b, k) => b.classList.toggle('active', k === ppName));
      syncPpUi();
    };
    ppButtons.set(ppName, btn);
    ppWrap.appendChild(btn);
  }

  chkPpCrt.onchange = () => {
    scene.postProcess.enabled = true;
    scene.postProcess.crt = chkPpCrt.checked;
  };
  const bindPpSlider = (sl: HTMLInputElement, valId: string, apply: (v: number) => void, digits = 2) => {
    sl.oninput = () => {
      const v = Number(sl.value);
      scene.postProcess.enabled = true;
      apply(v);
      document.getElementById(valId)!.textContent = digits === 0 ? String(v) : v.toFixed(digits);
    };
  };
  bindPpSlider(slPpBloom, 'val-pp-bloom', (v) => (scene.postProcess.bloomIntensity = v), 2);
  bindPpSlider(slPpOutline, 'val-pp-outline', (v) => (scene.postProcess.screenOutline = v), 2);
  bindPpSlider(slPpSsao, 'val-pp-ssao', (v) => (scene.postProcess.ssao = v), 2);
  bindPpSlider(slPpPixel, 'val-pp-pixel', (v) => (scene.postProcess.pixelSize = v), 0);
  bindPpSlider(slPpChrom, 'val-pp-chrom', (v) => (scene.postProcess.chromaticAberration = v), 4);
  bindPpSlider(slPpWave, 'val-pp-wave', (v) => (scene.postProcess.waveStrength = v), 3);

  // UI Setup
  const presetWrap = document.getElementById('preset-buttons')!;
  const presetButtons = new Map<ShaderPresetName, HTMLButtonElement>();
  for (const name of SHADER_PRESET_NAMES) {
    const btn = document.createElement('button');
    btn.textContent = name;
    if (name === activePreset) btn.classList.add('active');
    btn.onclick = () => {
      activePreset = name;
      const { desc } = getActiveTarget();
      const fresh = createPresetMaterial(name);
      desc.blocks = [...fresh.blocks];
      desc.uniforms = { ...fresh.uniforms };
      desc.transparent = fresh.transparent;
      desc.doubleSided = fresh.doubleSided;
      desc.outlineWidth = fresh.outlineWidth;
      desc.outlineColor = fresh.outlineColor;
      presetButtons.forEach((b, k) => b.classList.toggle('active', k === name));
      syncActiveMaterial();
    };
    presetButtons.set(name, btn);
    presetWrap.appendChild(btn);
  }

  const blocksWrap = document.getElementById('block-toggles')!;
  const blockCheckboxes = new Map<ShaderBlockId, HTMLInputElement>();
  for (const block of SHADER_BLOCK_IDS) {
    const label = document.createElement('label');
    label.className = 'chk';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = crystalDesc.blocks.includes(block);
    chk.onchange = () => {
      const { desc } = getActiveTarget();
      if (chk.checked && !desc.blocks.includes(block)) desc.blocks.push(block);
      else if (!chk.checked) desc.blocks = desc.blocks.filter((b) => b !== block);
      desc.transparent = desc.blocks.includes('hologramScanline');
      syncActiveMaterial();
    };
    blockCheckboxes.set(block, chk);
    label.appendChild(chk);
    label.appendChild(document.createTextNode(block));
    blocksWrap.appendChild(label);
  }

  function syncUiFromActiveDesc() {
    const { desc } = getActiveTarget();
    blockCheckboxes.forEach((chk, id) => {
      chk.checked = desc.blocks.includes(id);
    });
    (document.getElementById('sl-cel') as HTMLInputElement).value = String(desc.uniforms.celSteps);
    document.getElementById('val-cel')!.textContent = String(desc.uniforms.celSteps);
    (document.getElementById('sl-outline') as HTMLInputElement).value = String(desc.outlineWidth ?? 0);
    document.getElementById('val-outline')!.textContent = String(desc.outlineWidth ?? 0);
    (document.getElementById('sl-dissolve') as HTMLInputElement).value = String(desc.uniforms.dissolve);
    document.getElementById('val-dissolve')!.textContent = String(desc.uniforms.dissolve);
    (document.getElementById('sl-wave') as HTMLInputElement).value = String(desc.uniforms.waveAmp);
    document.getElementById('val-wave')!.textContent = String(desc.uniforms.waveAmp);
    (document.getElementById('sl-dither') as HTMLInputElement).value = String(desc.uniforms.ditherStrength);
    document.getElementById('val-dither')!.textContent = String(desc.uniforms.ditherStrength);
  }

  (document.getElementById('sel-target') as HTMLSelectElement).onchange = (e) => {
    editTarget = (e.target as HTMLSelectElement).value as 'all' | 'crystal' | 'props';
    syncUiFromActiveDesc();
  };

  const bindSlider = (id: string, valId: string, onChange: (desc: MaterialDesc, v: number) => void) => {
    const sl = document.getElementById(id) as HTMLInputElement;
    const val = document.getElementById(valId)!;
    sl.oninput = () => {
      const n = Number(sl.value);
      val.textContent = sl.value;
      onChange(getActiveTarget().desc, n);
      syncActiveMaterial();
    };
  };
  bindSlider('sl-cel', 'val-cel', (d, v) => (d.uniforms.celSteps = v));
  bindSlider('sl-outline', 'val-outline', (d, v) => (d.outlineWidth = v));
  bindSlider('sl-dissolve', 'val-dissolve', (d, v) => (d.uniforms.dissolve = v));
  bindSlider('sl-wave', 'val-wave', (d, v) => (d.uniforms.waveAmp = v));
  bindSlider('sl-dither', 'val-dither', (d, v) => (d.uniforms.ditherStrength = v));

  const slZoom = document.getElementById('sl-zoom') as HTMLInputElement;
  slZoom.oninput = () => {
    scene.camera.zoom = Number(slZoom.value);
    document.getElementById('val-zoom')!.textContent = slZoom.value;
  };

  (document.getElementById('chk-shadows') as HTMLInputElement).onchange = (e) => {
    scene.shadowsEnabled = (e.target as HTMLInputElement).checked;
  };
  (document.getElementById('chk-sfx') as HTMLInputElement).onchange = (e) => {
    sfxEnabled = (e.target as HTMLInputElement).checked;
  };
  (document.getElementById('sel-mood') as HTMLSelectElement).onchange = (e) => {
    applyMood((e.target as HTMLSelectElement).value as MoodName);
  };

  document.getElementById('btn-toggle-hud')!.onclick = () => {
    hudPanel.classList.toggle('collapsed');
  };

  const btn3d = document.getElementById('btn-3d')!;
  const btn2d = document.getElementById('btn-2d')!;
  const btnForest = document.getElementById('btn-forest')!;

  function startForestMode() {
    arena = null;
    orbit.enabled = false;
    orbit.detach();
    btnForest.classList.add('active');
    btn3d.classList.remove('active');
    btn2d.classList.remove('active');
    dialogueActive = false;
    dialogueBox.classList.remove('visible');
    interactPromptEl.classList.remove('visible');
    scene.spotLights.length = 0;
    crosshairEl.style.display = 'block';
    mode = 'forest';
    forestGame = startForestEscapeGame(
      engine,
      {
        container: forestHudEl,
        keysText: document.getElementById('forest-keys')!,
        staminaBar: document.getElementById('forest-stamina')!,
        flashlightText: document.getElementById('forest-flashlight')!,
        statusBanner: forestBannerEl,
        statusTitle: document.getElementById('forest-title')!,
        statusSub: document.getElementById('forest-sub')!,
        onEndScreenRestart: startForestMode,
      },
      playSfx
    );
  }

  document.getElementById('btn-forest-retry')!.onclick = startForestMode;

  btn3d.onclick = () => {
    btn3d.classList.add('active');
    btn2d.classList.remove('active');
    btnForest.classList.remove('active');
    build3DArena();
  };
  btn2d.onclick = () => {
    orbit.enabled = false;
    orbit.detach();
    btn2d.classList.add('active');
    btn3d.classList.remove('active');
    btnForest.classList.remove('active');
    build2DOMORIStyleScene();
  };
  btnForest.onclick = startForestMode;

  const btnCamFps = document.getElementById('btn-cam-fps')!;
  const btnCamOrbit = document.getElementById('btn-cam-orbit')!;
  const selOrbitTarget = document.getElementById('sel-orbit-target') as HTMLSelectElement;
  const chkOrbitAuto = document.getElementById('chk-orbit-auto') as HTMLInputElement;

  function focusOrbitPreset(key: string) {
    if (!arena) return;
    if (key === 'water') {
      const [wx, wy, wz] = arena.waterCenter;
      orbit.setView([wx, wy + 1.15, wz], 8.2, 0.28, 1.24);
    } else if (key === 'underwater') {
      const [wx, , wz] = arena.waterCenter;
      orbit.setView([wx, 1.02, wz], 2.0, 0.55, 1.52);
    } else if (key === 'room') {
      const [rx, ry, rz] = arena.roomCenter;
      orbit.setView([rx - 0.5, ry + 1.45, rz], 3.1, 1.52, 1.32);
    } else if (key === 'fire') {
      orbit.setView([5.2, 0.9, -2.2], 5.6, -0.55, 1.18);
    } else if (key === 'cloth') {
      orbit.setView([-6.2, 2.3, -2.5], 5.8, -0.35, 1.32);
    } else if (key === 'shatter') {
      orbit.setView([12.0, 1.2, -7.2], 4.6, -0.18, 1.32);
    } else if (key === 'ai') {
      orbit.setView([0, 2.2, 22.5], 20.0, Math.PI, 1.12);
    } else if (key === 'arena') {
      orbit.setView([0, 1.5, -2.5], 24.0, 0.35, 1.02);
    } else {
      orbit.setView([0, 2.7, -3.0], 6.4, 0.25, 1.18);
    }
  }

  const chkHotspots = document.getElementById('chk-hotspots') as HTMLInputElement;
  function syncHotspotsVisibility() {
    hotspots.setVisible(mode === '3d' && cameraMode === 'orbit' && chkHotspots.checked);
  }

  function setCameraMode(next: 'fps' | 'orbit') {
    cameraMode = next;
    arena?.stopGrapple();
    btnCamFps.classList.toggle('active', next === 'fps');
    btnCamOrbit.classList.toggle('active', next === 'orbit');
    if (next === 'orbit') {
      if (document.pointerLockElement) document.exitPointerLock();
      crosshairEl.style.display = 'none';
      orbit.attach(canvas);
      orbit.enabled = true;
      focusOrbitPreset(selOrbitTarget.value);
    } else {
      orbit.enabled = false;
      orbit.detach();
      if (gizmo.isEnabled()) {
        gizmo.setEnabled(false);
        gizmo.detach();
        btnGizmoToggle.textContent = 'Gizmo: ВЫКЛ';
        btnGizmoToggle.classList.remove('active');
      }
      if (mode === '3d') crosshairEl.style.display = 'block';
    }
    syncHotspotsVisibility();
  }

  btnCamFps.onclick = () => setCameraMode('fps');
  btnCamOrbit.onclick = () => setCameraMode('orbit');
  selOrbitTarget.onchange = () => {
    if (cameraMode === 'orbit') focusOrbitPreset(selOrbitTarget.value);
  };
  chkOrbitAuto.onchange = () => {
    orbit.autoRotate = chkOrbitAuto.checked;
  };
  chkHotspots.onchange = syncHotspotsVisibility;

  // Screenshot capture + Scroll-Tour Camera Timeline (#5 Web Showcase Kit)
  document.getElementById('btn-screenshot')!.onclick = async () => {
    const dataUrl = await engine.captureScreenshot('image/png');
    (window as unknown as { __lastScreenshotDataUrl?: string }).__lastScreenshotDataUrl = dataUrl;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'quark-engine-shot.png';
    a.click();
  };

  const TOUR_KEYFRAMES: OrbitKeyframe[] = [
    { progress: 0.0, target: [0, 2.7, -3.0], radius: 6.4, theta: 0.25, phi: 1.18 },
    { progress: 0.25, target: [14.5, 1.2, 3.0], radius: 8.2, theta: 0.28, phi: 1.24 },
    { progress: 0.5, target: [5.2, 0.9, -2.2], radius: 5.6, theta: -0.55, phi: 1.18 },
    { progress: 0.75, target: [-11.5, 1.5, 3.0], radius: 4.0, theta: 1.52, phi: 1.28 },
    { progress: 1.0, target: [0, 2.2, 22.5], radius: 19.5, theta: Math.PI, phi: 1.12 },
  ];
  const slTour = document.getElementById('sl-tour') as HTMLInputElement;
  const valTour = document.getElementById('val-tour')!;
  slTour.oninput = () => {
    const t = Number(slTour.value);
    valTour.textContent = `${Math.round(t * 100)}%`;
    if (mode === '3d') {
      if (cameraMode !== 'orbit') setCameraMode('orbit');
      orbit.autoRotate = false;
      chkOrbitAuto.checked = false;
      orbit.applyTimeline(TOUR_KEYFRAMES, t);
    }
  };

  // Transform Gizmo + GPU Weather controls (#6)
  const btnGzMove = document.getElementById('btn-gz-move')!;
  const btnGzRotate = document.getElementById('btn-gz-rotate')!;
  const btnGzScale = document.getElementById('btn-gz-scale')!;
  const setGizmoMode = (m: GizmoMode) => {
    gizmo.setMode(m);
    btnGzMove.classList.toggle('active', m === 'translate');
    btnGzRotate.classList.toggle('active', m === 'rotate');
    btnGzScale.classList.toggle('active', m === 'scale');
  };
  btnGzMove.onclick = () => setGizmoMode('translate');
  btnGzRotate.onclick = () => setGizmoMode('rotate');
  btnGzScale.onclick = () => setGizmoMode('scale');
  btnGizmoToggle.onclick = () => {
    if (mode !== '3d') return;
    const next = !gizmo.isEnabled();
    if (next && cameraMode !== 'orbit') setCameraMode('orbit');
    gizmo.setEnabled(next);
    if (next) {
      gizmo.attach(canvas);
      if (gizmo.getSelected() === null && crystalEntity) gizmo.select(crystalEntity);
    } else {
      gizmo.detach();
    }
    btnGizmoToggle.textContent = next ? 'Gizmo: ВКЛ' : 'Gizmo: ВЫКЛ';
    btnGizmoToggle.classList.toggle('active', next);
    gizmoStatusEl.textContent = next
      ? `Выбрано: Entity #${gizmo.getSelected() ?? '-'} (тяни за X/Y/Z)`
      : 'Включи Gizmo и кликни объект в Orbit 3D';
  };

  const btnWClear = document.getElementById('btn-weather-clear')!;
  const btnWSnow = document.getElementById('btn-weather-snow')!;
  const btnWRain = document.getElementById('btn-weather-rain')!;
  const btnWDownpour = document.getElementById('btn-weather-downpour')!;
  const setWeather = (w: 'clear' | 'snow' | 'rain' | 'downpour') => {
    weatherMode = w;
    scene.setWeather(w);
    btnWClear.classList.toggle('active', w === 'clear');
    btnWSnow.classList.toggle('active', w === 'snow');
    btnWRain.classList.toggle('active', w === 'rain');
    btnWDownpour.classList.toggle('active', w === 'downpour');
  };
  btnWClear.onclick = () => setWeather('clear');
  btnWSnow.onclick = () => setWeather('snow');
  btnWRain.onclick = () => setWeather('rain');
  btnWDownpour.onclick = () => setWeather('downpour');

  // Water 2.0 customization controls
  const btnWReal = document.getElementById('btn-water-realistic')!;
  const btnWAnime = document.getElementById('btn-water-anime')!;
  const btnWCyber = document.getElementById('btn-water-cyber')!;
  const slWStyle = document.getElementById('sl-w-style') as HTMLInputElement;
  const slWAmp = document.getElementById('sl-w-amp') as HTMLInputElement;
  const slWChop = document.getElementById('sl-w-chop') as HTMLInputElement;
  const slWFoam = document.getElementById('sl-w-foam') as HTMLInputElement;
  const slWClarity = document.getElementById('sl-w-clarity') as HTMLInputElement;

  function syncWaterUi() {
    if (!arena) return;
    const u = arena.waterDesc.uniforms;
    const st = u.waterStyle ?? 0;
    const chop = u.waterChoppiness ?? 0.62;
    const foam = u.waterFoam ?? 0.65;
    const clarity = u.waterClarity ?? 0.66;
    slWStyle.value = String(st);
    document.getElementById('val-w-style')!.textContent = st.toFixed(2);
    slWAmp.value = String(u.waveAmp);
    document.getElementById('val-w-amp')!.textContent = u.waveAmp.toFixed(2);
    slWChop.value = String(chop);
    document.getElementById('val-w-chop')!.textContent = chop.toFixed(2);
    slWFoam.value = String(foam);
    document.getElementById('val-w-foam')!.textContent = foam.toFixed(2);
    slWClarity.value = String(clarity);
    document.getElementById('val-w-clarity')!.textContent = clarity.toFixed(2);
  }

  const pickWaterPreset = (name: 'realistic' | 'anime' | 'cyber') => {
    arena?.setWaterPreset(name);
    btnWReal.classList.toggle('active', name === 'realistic');
    btnWAnime.classList.toggle('active', name === 'anime');
    btnWCyber.classList.toggle('active', name === 'cyber');
    syncWaterUi();
  };
  btnWReal.onclick = () => pickWaterPreset('realistic');
  btnWAnime.onclick = () => pickWaterPreset('anime');
  btnWCyber.onclick = () => pickWaterPreset('cyber');

  const bindWaterSlider = (
    sl: HTMLInputElement,
    valId: string,
    apply: (v: number) => Record<string, number>
  ) => {
    sl.oninput = () => {
      const v = Number(sl.value);
      document.getElementById(valId)!.textContent = v.toFixed(2);
      arena?.updateWaterUniforms(apply(v));
    };
  };
  bindWaterSlider(slWStyle, 'val-w-style', (v) => ({ waterStyle: v }));
  bindWaterSlider(slWAmp, 'val-w-amp', (v) => ({ waveAmp: v }));
  bindWaterSlider(slWChop, 'val-w-chop', (v) => ({ waterChoppiness: v }));
  bindWaterSlider(slWFoam, 'val-w-foam', (v) => ({ waterFoam: v }));
  bindWaterSlider(slWClarity, 'val-w-clarity', (v) => ({ waterClarity: v }));

  document.getElementById('btn-spawn-box')!.onclick = () => spawnDynamicBody('box');
  document.getElementById('btn-spawn-sphere')!.onclick = () => spawnDynamicBody('sphere');
  document.getElementById('btn-drop-ramp')!.onclick = () => spawnDynamicBody('box', true);
  document.getElementById('btn-reset')!.onclick = () => {
    if (mode === '3d') build3DArena();
    else if (mode === '2d') build2DOMORIStyleScene();
    else startForestMode();
  };

  canvas.addEventListener('click', () => {
    if (mode === '3d' && cameraMode === 'orbit') return;
    if (mode === '3d' || mode === 'forest') {
      if (!input.isPointerLocked()) input.requestPointerLock();
      else if (mode === '3d') fireRaycastImpulse();
    }
  });

  canvas.addEventListener('contextmenu', (e) => {
    if (mode === '3d' && cameraMode === 'fps') e.preventDefault();
  });
  window.addEventListener('mousedown', (e) => {
    if (e.button === 2 && mode === '3d' && cameraMode === 'fps' && arena) {
      const { origin, dir } = getCameraLookRay();
      arena.startGrapple(origin, dir);
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 2) arena?.stopGrapple();
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.name.toLowerCase().endsWith('.glb')) return;
    if (mode !== '3d') build3DArena();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const handle = await assets.loadGLB(bytes, {
      name: file.name,
      tag: 'scene',
      preset: activePreset,
      scene,
      autoColliders: true,
    });
    const [px, py, pz] = scene.getPosition(player);
    const eId = scene.createEntity();
    scene.setTransform(eId, {
      position: [px - Math.sin(yaw) * 3.5, py + 0.5, pz - Math.cos(yaw) * 3.5],
      immediate: true,
    });
    scene.setMesh3D(eId, {
      meshId: handle.meshId,
      materialId: handle.materialIds[0] ?? crystalMatId,
      boundsRadius: handle.boundsRadius,
    });
    const clipNames = Object.keys(handle.clips);
    if (handle.skeletonId !== null && clipNames.length > 0) {
      scene.playAnimation(eId, handle.skeletonId, handle.clips[clipNames[0]], { loop: true });
    }
    if (cameraMode === 'orbit') {
      const glbPos = scene.getPosition(eId);
      orbit.setView(glbPos, Math.max(4, handle.boundsRadius * 2.5));
    }
  });

  engine.onFixedUpdate((fixedDt) => {
    if (mode === 'forest' && forestGame) {
      forestGame.fixedUpdate(fixedDt);
      return;
    }
    if (mode === '3d') {
      const forwardX = -Math.sin(yaw);
      const forwardZ = -Math.cos(yaw);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);

      let moveF = 0;
      let moveR = 0;
      if (input.isKeyDown('KeyW') || input.isKeyDown('ArrowUp')) moveF += 1;
      if (input.isKeyDown('KeyS') || input.isKeyDown('ArrowDown')) moveF -= 1;
      if (input.isKeyDown('KeyD') || input.isKeyDown('ArrowRight')) moveR += 1;
      if (input.isKeyDown('KeyA') || input.isKeyDown('ArrowLeft')) moveR -= 1;

      const len = Math.hypot(moveF, moveR) || 1;
      const speed = input.isKeyDown('ShiftLeft') ? 11.0 : 6.5;
      const vx = ((forwardX * moveF + rightX * moveR) / len) * (moveF !== 0 || moveR !== 0 ? speed : 0);
      const vz = ((forwardZ * moveF + rightZ * moveR) / len) * (moveF !== 0 || moveR !== 0 ? speed : 0);

      const [, curVy] = scene.getVelocity(player);
      const grounded = scene.isGrounded(player);
      let nextVy = curVy;
      if (input.isKeyDown('Space') && grounded && wasGrounded) {
        nextVy = 9.0;
        playSfx(420, 0.09, 'sine', 0.11);
      }
      wasGrounded = grounded;
      scene.setVelocity(player, vx, nextVy, vz);
      arena?.fixedUpdate(fixedDt);
    } else {
      let mx = 0;
      let my = 0;
      if (input.isKeyDown('KeyW') || input.isKeyDown('ArrowUp')) my += 1;
      if (input.isKeyDown('KeyS') || input.isKeyDown('ArrowDown')) my -= 1;
      if (input.isKeyDown('KeyD') || input.isKeyDown('ArrowRight')) mx += 1;
      if (input.isKeyDown('KeyA') || input.isKeyDown('ArrowLeft')) mx -= 1;
      const len = Math.hypot(mx, my) || 1;
      const speed = input.isKeyDown('ShiftLeft') ? 7.2 : 4.4;
      scene.setVelocity(hero2d, (mx / len) * speed, (my / len) * speed, 0);
    }
  });

  let grappleKeyDown = false;
  engine.onUpdate((dt) => {
    spinTime += dt;
    if (input.wasKeyPressed('KeyH')) hudPanel.classList.toggle('collapsed');

    if (mode === 'forest' && forestGame) {
      forestGame.update(dt);
    } else if (mode === '3d') {
      if (input.wasKeyPressed('KeyC')) spawnDynamicBody('box');
      if (input.wasKeyPressed('KeyQ')) spawnDynamicBody('sphere');
      if (input.wasKeyPressed('KeyR')) spawnDynamicBody('box', true);
      if (input.wasKeyPressed('KeyE')) arena?.tryInteract();
      if (input.wasKeyPressed('KeyL')) arena?.toggleRoomLight();
      if (input.wasKeyPressed('KeyF')) fireRaycastImpulse();
      if (input.wasKeyPressed('KeyG') && arena && !grappleKeyDown) {
        grappleKeyDown = true;
        const { origin, dir } = getCameraLookRay();
        arena.startGrapple(origin, dir);
      } else if (grappleKeyDown && !input.isKeyDown('KeyG')) {
        grappleKeyDown = false;
        arena?.stopGrapple();
      }

      const [dx, dy] = input.consumeMouseDelta();
      if (cameraMode === 'orbit') {
        orbit.update(dt, scene.camera);
      } else {
        yaw -= dx * 0.0024;
        pitch = Math.max(-1.25, Math.min(1.1, pitch - dy * 0.0022));

        const [px, py, pz] = scene.getPosition(player);
        const eyeY = py + 0.65;
        scene.camera.position = [px, eyeY, pz];
        scene.camera.target = [
          px - Math.sin(yaw) * Math.cos(pitch),
          eyeY + Math.sin(pitch),
          pz - Math.cos(yaw) * Math.cos(pitch),
        ];
      }

      arena?.update(dt, spinTime);
      hotspots.update();
      gizmo.update();

      if (weatherMode !== 'clear') {
        weatherAcc += dt;
        const stepInterval = weatherMode === 'downpour' ? 0.02 : weatherMode === 'rain' ? 0.03 : 0.04;
        if (weatherAcc >= stepInterval) {
          weatherAcc = 0;
          const [cx, , cz] = scene.camera.target;
          const count = weatherMode === 'downpour' ? 56 : weatherMode === 'rain' ? 28 : 22;
          scene.emitVfx(weatherMode, [cx, 12.5, cz], count, 0.03);
        }
      }

      const prompt = arena?.getInteractPrompt() ?? null;
      if (prompt) {
        interactPromptEl.textContent = prompt;
        interactPromptEl.classList.add('visible');
      } else {
        interactPromptEl.classList.remove('visible');
      }
    } else {
      const [hx, hy] = scene.getPosition(hero2d);
      scene.camera.position = [hx, hy, 10];
      scene.camera.target = [hx, hy, 0];
      if (scene.lights2d.lights.length > 0) {
        scene.lights2d.lights[0].position = [hx, hy];
      }

      if (input.wasKeyPressed('KeyE') || input.wasKeyPressed('Space')) {
        if (dialogueActive) {
          const next = dialogueRunner.advance();
          if (next) {
            dialogueFull = next.text;
            dialogueShown = 0;
            dialogueNameEl.textContent = next.speaker;
            dialogueTextEl.textContent = '';
          } else {
            dialogueActive = false;
            dialogueBox.classList.remove('visible');
          }
        } else {
          const near = npcs2d.find((n) => Math.hypot(n.x - hx, n.y - hy) < 1.8);
          const node = near ? dialogueRunner.start(near.startNode) : null;
          if (node) {
            dialogueActive = true;
            dialogueFull = node.text;
            dialogueShown = 0;
            dialogueNameEl.textContent = node.speaker;
            dialogueTextEl.textContent = '';
            dialogueBox.classList.add('visible');
          }
        }
      }

      if (dialogueActive && dialogueShown < dialogueFull.length) {
        const prevCount = Math.floor(dialogueShown);
        dialogueShown = Math.min(dialogueFull.length, dialogueShown + dt * 42);
        const curCount = Math.floor(dialogueShown);
        if (curCount > prevCount) {
          dialogueTextEl.textContent = dialogueFull.slice(0, curCount);
          if (curCount % 2 === 0) playSfx(520, 0.025, 'square', 0.03);
        }
      }
    }

    const st = engine.getStats();
    const uwDepth = mode === '3d' ? scene.getUnderwaterDepth(scene.camera.position) : 0;
    const gpuVfx = scene.getActiveParticleCount();
    statsEl.innerHTML =
      `<b>QuarkEngine</b> (${forestGame ? forestGame.getModeLabel() : mode.toUpperCase()}${uwDepth > 0 ? ' · UNDERWATER' : ''})<br>` +
      `FPS: <b>${st.fps}</b> (${st.frameMs} ms)<br>` +
      `Entities: <b>${st.entities}</b> | Draws: <b>${st.drawCalls}</b> | GPU VFX: <b>${gpuVfx}</b><br>` +
      `Instanced: <b>${st.render.instancedObjects}</b> objs (${st.render.instancedRuns} batches)<br>` +
      `WASM RAM: <b>${Math.round(st.wasmMemoryBytes / 1024)} KB</b> · F2 Profiler`;
  });

  scene.postProcess = createPostProcessPreset(activePpPreset);
  syncPpUi();
  syncUiFromActiveDesc();
  build3DArena();
  engine.start();
}

bootstrap().catch((err) => {
  const statsEl = document.getElementById('stats');
  if (statsEl) statsEl.textContent = `Init error: ${String(err)}`;
  console.error(err);
});
