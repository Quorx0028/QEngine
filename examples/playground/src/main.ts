import {
  createBoxGeometry,
  createPlaneGeometry,
  createPostProcessPreset,
  createPresetMaterial,
  createRampGeometry,
  createSphereGeometry,
  Engine,
  extractColliderTriangles,
  POST_PROCESS_PRESET_NAMES,
  quatFromEuler,
  SHADER_BLOCK_IDS,
  SHADER_PRESET_NAMES,
  type EntityId,
  type MaterialDesc,
  type PostProcessPresetName,
  type ShaderBlockId,
  type ShaderPresetName,
  type Vec3Tuple,
} from 'quark-engine';
import wasmUrl from 'quark-engine/wasm?url';
import { startForestEscapeGame, type ForestGameController } from './forestGame';
import { buildSampleCrystalGlb } from './sampleGlb';

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

  const engine = await Engine.init({ canvas, wasmUrl });
  const { scene, assets, input, audio } = engine;

  let mode: '3d' | '2d' | 'forest' = '3d';
  let forestGame: ForestGameController | null = null;
  let sfxEnabled = true;
  let player = 0;
  let crystalEntity = 0;
  let crystalMatId = 0;
  let propsMatId = 0;
  let editTarget: 'all' | 'crystal' | 'props' = 'all';
  let activePreset: ShaderPresetName = 'animeToon';
  let activePpPreset: PostProcessPresetName = 'none';
  let yaw = 0;
  let pitch = -0.16;
  let hero2d = 0;
  let spinTime = 0;
  let wasGrounded = true;

  // 2D dialogue state
  let dialogueFull = '';
  let dialogueShown = 0;
  let dialogueActive = false;
  let npcs2d: Array<{ x: number; y: number; name: string; lines: string }> = [];

  const crystalDesc: MaterialDesc = createPresetMaterial('animeToon');
  const propsDesc: MaterialDesc = createPresetMaterial('pbr', {
    uniforms: { baseColor: [0.92, 0.56, 0.32, 1.0], roughness: 0.38 },
  });
  const worldDesc: MaterialDesc = createPresetMaterial('animeToon');

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
  }

  function build3DArena() {
    hideForestUi();
    scene.clear();
    assets.unloadTag('scene');
    dialogueActive = false;
    dialogueBox.classList.remove('visible');
    crosshairEl.style.display = 'block';
    mode = '3d';
    scene.camera.mode = '3d';
    scene.camera.pixelSnap = false;
    scene.fogDensity = 0.008;
    scene.light.intensity = 1.35;
    scene.setGravity(0, -22, 0);
    applyMood((document.getElementById('sel-mood') as HTMLSelectElement).value as MoodName);

    scene.pointLights.length = 0;
    scene.pointLights.push(
      { position: [0, 2.6, -3], color: [0.35, 0.85, 1.0], intensity: 2.2, radius: 11 },
      { position: [-7.5, 2.2, 2.5], color: [1.0, 0.58, 0.25], intensity: 1.9, radius: 10 }
    );

    const floorMesh = assets.registerMesh('floor', createPlaneGeometry(56, 56, 28), 'scene');
    const boxMesh = assets.registerMesh('box', createBoxGeometry(0.5, 0.5, 0.5), 'scene');
    const sphereMesh = assets.registerMesh('sphere', createSphereGeometry(0.55, 18, 24), 'scene');
    const rampGentleGeom = createRampGeometry(4.0, 2.0, 7.0);
    const rampGentleMesh = assets.registerMesh('ramp-gentle', rampGentleGeom, 'scene');
    const rampSteepGeom = createRampGeometry(4.2, 3.0, 5.2);
    const rampSteepMesh = assets.registerMesh('ramp-steep', rampSteepGeom, 'scene');

    const floorMat = assets.createMaterial(
      'floor-grid',
      {
        blocks: ['pbrLighting', 'triplanarGrid', 'distanceFog'],
        uniforms: {
          ...createPresetMaterial('pbr').uniforms,
          baseColor: [0.24, 0.28, 0.36, 1],
          roughness: 0.78,
          gridScale: 1.0,
        },
      },
      'scene'
    );

    const wallMat = assets.createPreset(
      'wall-pbr',
      'pbr',
      { uniforms: { baseColor: [0.4, 0.46, 0.58, 1], roughness: 0.55 } },
      'scene'
    );
    const rampMat = assets.createPreset(
      'ramp-toon',
      'animeToon',
      {
        uniforms: {
          baseColor: [0.95, 0.65, 0.35, 1],
          shadowTint: [0.55, 0.32, 0.28],
        },
        outlineWidth: 0.02,
      },
      'scene'
    );

    crystalMatId = assets.createMaterial('showcase-crystal', crystalDesc, 'scene');
    propsMatId = assets.createMaterial('showcase-props', propsDesc, 'scene');

    // Ground collider + floor mesh
    const floor = scene.createEntity();
    scene.setTransform(floor, { position: [0, -0.5, 0], immediate: true });
    scene.setCollider3D(floor, { kind: 'aabb', halfExtents: [28, 0.5, 28] });

    const floorVis = scene.createEntity();
    scene.setTransform(floorVis, { position: [0, 0, 0], immediate: true });
    scene.setMesh3D(floorVis, { meshId: floorMesh.meshId, materialId: floorMat, boundsRadius: 48 });

    // Arena walls & raised platform
    const staticBoxes: Array<{ pos: Vec3Tuple; scale: Vec3Tuple }> = [
      { pos: [0, 1.5, -20], scale: [40, 3, 1] },
      { pos: [0, 1.5, 20], scale: [40, 3, 1] },
      { pos: [-20, 1.5, 0], scale: [1, 3, 40] },
      { pos: [20, 1.5, 0], scale: [1, 3, 40] },
      { pos: [8, 1.0, -3.5], scale: [4.2, 2.0, 4.0] }, // upper platform after gentle ramp
      { pos: [-7.5, 1.5, -2.5], scale: [4.4, 3.0, 4.0] }, // upper platform after steep ramp
      { pos: [0, 0.5, -3], scale: [2.2, 1.0, 2.2] }, // crystal pedestal
    ];
    for (const w of staticBoxes) {
      const e = scene.createEntity();
      scene.setTransform(e, { position: w.pos, scale: w.scale, immediate: true });
      scene.setCollider3D(e, {
        kind: 'aabb',
        halfExtents: [w.scale[0] * 0.5, w.scale[1] * 0.5, w.scale[2] * 0.5],
      });
      scene.setMesh3D(e, { meshId: boxMesh.meshId, materialId: wallMat, boundsRadius: 24 });
    }

    // Gentle walkable ramp (right)
    const ramp1 = scene.createEntity();
    scene.setTransform(ramp1, { position: [8, 0, 2], immediate: true });
    scene.setMesh3D(ramp1, { meshId: rampGentleMesh.meshId, materialId: rampMat, boundsRadius: 6 });
    scene.addStaticMeshTriangles(ramp1, extractColliderTriangles(rampGentleGeom, [8, 0, 2]));

    // Steep physics ramp (left) — drop cubes here to watch tilting + friction!
    const ramp2 = scene.createEntity();
    scene.setTransform(ramp2, { position: [-7.5, 0, 2.1], immediate: true });
    scene.setMesh3D(ramp2, { meshId: rampSteepMesh.meshId, materialId: rampMat, boundsRadius: 6 });
    scene.addStaticMeshTriangles(ramp2, extractColliderTriangles(rampSteepGeom, [-7.5, 0, 2.1]));

    // Stackable physics cube pyramid to knock over
    const crateRows = [3, 2, 1];
    crateRows.forEach((count, row) => {
      for (let col = 0; col < count; col++) {
        const x = 3.5 + (col - (count - 1) * 0.5) * 1.15;
        const y = 0.55 + row * 1.05;
        const z = -7.5;
        const c = scene.createEntity();
        scene.setTransform(c, { position: [x, y, z], immediate: true });
        scene.setCollider3D(c, { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] });
        scene.setRigidBody(c, { dynamic: true, friction: 0.78, restitution: 0.12, lockRotation: false });
        scene.setMesh3D(c, { meshId: boxMesh.meshId, materialId: propsMatId, boundsRadius: 1.2 });
      }
    });

    // Showcase row of all 6 built-in presets
    SHADER_PRESET_NAMES.forEach((presetName, idx) => {
      const mId = assets.createPreset(`gallery-${presetName}`, presetName, {}, 'scene');
      const e = scene.createEntity();
      const x = -10 + idx * 4;
      scene.setTransform(e, { position: [x, 1.4, -15], scale: [1.3, 1.3, 1.3], immediate: true });
      scene.setMesh3D(e, {
        meshId: idx % 2 === 0 ? sphereMesh.meshId : boxMesh.meshId,
        materialId: mId,
        transparent: presetName === 'hologram',
        boundsRadius: 2,
      });
    });

    // Central crystal loaded via Rust GLB parser
    const crystalBytes = buildSampleCrystalGlb();
    const crystalHandle = assets.registerMesh(
      'sample-crystal',
      engine.bridge.parseGlb(crystalBytes),
      'scene'
    );
    crystalEntity = scene.createEntity();
    scene.setTransform(crystalEntity, { position: [0, 2.8, -3], immediate: true });
    scene.setMesh3D(crystalEntity, {
      meshId: crystalHandle.meshId,
      materialId: crystalMatId,
      transparent: crystalDesc.transparent,
      boundsRadius: 3,
    });

    // Player capsule (lockRotation: true so character stays upright on ramps!)
    player = scene.createEntity();
    scene.setTransform(player, { position: [0, 1.3, 8], immediate: true });
    scene.setCollider3D(player, { kind: 'capsule', radius: 0.42, halfHeight: 0.55 });
    scene.setRigidBody(player, {
      dynamic: true,
      gravityScale: 1,
      friction: 0,
      linearDamping: 0,
      lockRotation: true,
    });
    yaw = 0;
    pitch = -0.15;

    // Glowing Hologram Jump-Pad Trigger Zone (uses Milestone 1 WASM TriggerEnter event!)
    const padMat = assets.createPreset('jump-pad', 'hologram', {
      uniforms: { glowColor: [0.2, 1.0, 0.75], baseColor: [0.1, 0.9, 0.65, 0.65] },
    }, 'scene');
    const jumpPad = scene.createEntity();
    scene.setTransform(jumpPad, { position: [4, 0.12, 5], scale: [2.2, 0.2, 2.2], immediate: true });
    scene.setCollider3D(jumpPad, { kind: 'aabb', halfExtents: [1.1, 0.55, 1.1] });
    scene.setTrigger(jumpPad, true);
    scene.setMesh3D(jumpPad, { meshId: boxMesh.meshId, materialId: padMat, transparent: true, boundsRadius: 2 });

    scene.onTriggerEnter((ev) => {
      if (ev.entityA === jumpPad || ev.entityB === jumpPad) {
        const other = ev.entityA === jumpPad ? ev.entityB : ev.entityA;
        scene.applyImpulse(other, [0, 14.5, 0]);
        scene.triggerShake(0.06, 0.12);
        playSfx(660, 0.14, 'sine', 0.14);
      }
    });
  }

  function build2DOMORIStyleScene() {
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
      {
        x: -2,
        y: 2,
        name: 'AUBREY',
        lines: 'Привет! Видишь, как плавно работает Y-сортировка и коллизии без зацепов на углах тайлов?',
      },
      {
        x: 3.5,
        y: -1.5,
        name: 'KEL',
        lines: 'Попробуй переключиться обратно в 3D Arena и сбросить куб на трамплин клавишей R!',
      },
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

    const e = scene.createEntity();
    scene.setTransform(e, { position: spawnPos, immediate: true });
    if (kind === 'box') {
      scene.setCollider3D(e, { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] });
    } else {
      scene.setCollider3D(e, { kind: 'sphere', radius: 0.55 });
    }
    scene.setRigidBody(e, {
      dynamic: true,
      gravityScale: 1,
      restitution: kind === 'sphere' ? 0.52 : 0.14,
      friction: kind === 'sphere' ? 0.42 : 0.78,
      linearDamping: 0.1,
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

  function fireRaycastImpulse() {
    if (mode !== '3d') return;
    const [ox, oy, oz] = scene.camera.position;
    const dx = -Math.sin(yaw) * Math.cos(pitch);
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * Math.cos(pitch);
    const hit = scene.raycast3D([ox + dx * 0.65, oy + dy * 0.65, oz + dz * 0.65], [dx, dy, dz], 35);
    if (hit && hit.entity !== player) {
      scene.applyImpulse(hit.entity, [dx * 9.5, dy * 9.5 + 3.0, dz * 9.5], hit.point);
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
        assets.updateMaterial(id, desc);
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
    btnForest.classList.add('active');
    btn3d.classList.remove('active');
    btn2d.classList.remove('active');
    dialogueActive = false;
    dialogueBox.classList.remove('visible');
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
    btn2d.classList.add('active');
    btn3d.classList.remove('active');
    btnForest.classList.remove('active');
    build2DOMORIStyleScene();
  };
  btnForest.onclick = startForestMode;
  document.getElementById('btn-spawn-box')!.onclick = () => spawnDynamicBody('box');
  document.getElementById('btn-spawn-sphere')!.onclick = () => spawnDynamicBody('sphere');
  document.getElementById('btn-drop-ramp')!.onclick = () => spawnDynamicBody('box', true);
  document.getElementById('btn-reset')!.onclick = () => {
    if (mode === '3d') build3DArena();
    else if (mode === '2d') build2DOMORIStyleScene();
    else startForestMode();
  };

  canvas.addEventListener('click', () => {
    if (mode === '3d' || mode === 'forest') {
      if (!input.isPointerLocked()) input.requestPointerLock();
      else if (mode === '3d') fireRaycastImpulse();
    }
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.name.toLowerCase().endsWith('.glb')) return;
    if (mode !== '3d') build3DArena();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const handle = await assets.loadGLB(bytes, { name: file.name, tag: 'scene', preset: activePreset });
    const [px, py, pz] = scene.getPosition(player);
    const eId = scene.createEntity();
    scene.setTransform(eId, {
      position: [px - Math.sin(yaw) * 3.5, py + 0.5, pz - Math.cos(yaw) * 3.5],
      immediate: true,
    });
    scene.setMesh3D(eId, {
      meshId: handle.meshId,
      materialId: crystalMatId,
      boundsRadius: handle.boundsRadius,
    });
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

  engine.onUpdate((dt) => {
    spinTime += dt;
    if (input.wasKeyPressed('KeyH')) hudPanel.classList.toggle('collapsed');

    if (mode === 'forest' && forestGame) {
      forestGame.update(dt);
    } else if (mode === '3d') {
      if (input.wasKeyPressed('KeyE')) spawnDynamicBody('box');
      if (input.wasKeyPressed('KeyQ')) spawnDynamicBody('sphere');
      if (input.wasKeyPressed('KeyR')) spawnDynamicBody('box', true);
      if (input.wasKeyPressed('KeyF')) fireRaycastImpulse();

      const [dx, dy] = input.consumeMouseDelta();
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

      if (crystalEntity) {
        scene.setTransform(crystalEntity, {
          position: [0, 2.8 + Math.sin(spinTime * 2) * 0.25, -3],
          rotation: quatFromEuler(0, spinTime * 0.9, 0),
        });
      }
    } else {
      const [hx, hy] = scene.getPosition(hero2d);
      scene.camera.position = [hx, hy, 10];
      scene.camera.target = [hx, hy, 0];

      if (input.wasKeyPressed('KeyE') || input.wasKeyPressed('Space')) {
        if (dialogueActive) {
          dialogueActive = false;
          dialogueBox.classList.remove('visible');
        } else {
          const near = npcs2d.find((n) => Math.hypot(n.x - hx, n.y - hy) < 1.8);
          if (near) {
            dialogueActive = true;
            dialogueFull = near.lines;
            dialogueShown = 0;
            dialogueNameEl.textContent = near.name;
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
    statsEl.innerHTML =
      `<b>QuarkEngine</b> (${forestGame ? forestGame.getModeLabel() : mode.toUpperCase()})<br>` +
      `FPS: <b>${st.fps}</b> (${st.frameMs} ms)<br>` +
      `Entities: <b>${st.entities}</b> | Draws: <b>${st.drawCalls}</b><br>` +
      `WASM RAM: <b>${Math.round(st.wasmMemoryBytes / 1024)} KB</b>`;
  });

  build3DArena();
  engine.start();
}

bootstrap().catch((err) => {
  const statsEl = document.getElementById('stats');
  if (statsEl) statsEl.textContent = `Init error: ${String(err)}`;
  console.error(err);
});
