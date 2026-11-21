import {
  createBoxGeometry,
  createPlaneGeometry,
  createPresetMaterial,
  createRampGeometry,
  createSphereGeometry,
  Engine,
  extractColliderTriangles,
  quatFromEuler,
  SHADER_BLOCK_IDS,
  SHADER_PRESET_NAMES,
  type EntityId,
  type MaterialDesc,
  type ShaderBlockId,
  type ShaderPresetName,
} from 'quark-engine';
import wasmUrl from 'quark-engine/wasm?url';
import { buildSampleCrystalGlb } from './sampleGlb';

async function bootstrap() {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const statsEl = document.getElementById('stats')!;

  const engine = await Engine.init({ canvas, wasmUrl });
  const { scene, assets, input } = engine;

  let mode: '3d' | '2d' = '3d';
  let player = 0;
  let crystalEntity = 0;
  let showcaseMatId = 0;
  let activePreset: ShaderPresetName = 'animeToon';
  let yaw = 0;
  let pitch = -0.18;
  let hero2d = 0;
  let spinTime = 0;
  const spawnedDynamics: EntityId[] = [];

  const currentDesc: MaterialDesc = createPresetMaterial(activePreset);

  function build3DArena() {
    scene.clear();
    assets.unloadTag('scene');
    spawnedDynamics.length = 0;
    mode = '3d';
    scene.camera.mode = '3d';
    scene.camera.pixelSnap = false;
    scene.setGravity(0, -22, 0);

    const floorMesh = assets.registerMesh('floor', createPlaneGeometry(48, 48, 24), 'scene');
    const boxMesh = assets.registerMesh('box', createBoxGeometry(0.5, 0.5, 0.5), 'scene');
    const sphereMesh = assets.registerMesh('sphere', createSphereGeometry(0.55, 18, 24), 'scene');
    const rampGeom = createRampGeometry(3.4, 2.0, 6.0);
    const rampMesh = assets.registerMesh('ramp', rampGeom, 'scene');

    const floorMat = assets.createMaterial(
      'floor-grid',
      {
        blocks: ['pbrLighting', 'triplanarGrid', 'distanceFog'],
        uniforms: {
          ...createPresetMaterial('pbr').uniforms,
          baseColor: [0.22, 0.26, 0.34, 1],
          roughness: 0.72,
          gridScale: 1.0,
        },
      },
      'scene'
    );

    const wallMat = assets.createPreset(
      'wall-toon',
      'pbr',
      { uniforms: { baseColor: [0.35, 0.42, 0.54, 1] } },
      'scene'
    );

    showcaseMatId = assets.createMaterial('showcase', currentDesc, 'scene');

    // Ground collider + render plane
    const floor = scene.createEntity();
    scene.setTransform(floor, { position: [0, -0.5, 0], immediate: true });
    scene.setCollider3D(floor, { kind: 'aabb', halfExtents: [24, 0.5, 24] });

    const floorVis = scene.createEntity();
    scene.setTransform(floorVis, { position: [0, 0, 0], immediate: true });
    scene.setMesh3D(floorVis, { meshId: floorMesh.meshId, materialId: floorMat, boundsRadius: 40 });

    // Arena boundary walls & pillars for testing smooth capsule wall slide
    const walls: Array<{ pos: [number, number, number]; scale: [number, number, number] }> = [
      { pos: [0, 1.5, -18], scale: [36, 3, 1] },
      { pos: [0, 1.5, 18], scale: [36, 3, 1] },
      { pos: [-18, 1.5, 0], scale: [1, 3, 36] },
      { pos: [18, 1.5, 0], scale: [1, 3, 36] },
      { pos: [-6, 1.5, -4], scale: [2.2, 3, 2.2] },
      { pos: [6, 1.2, -5], scale: [3.2, 2.4, 1.4] },
      { pos: [0, 0.6, -10], scale: [6, 1.2, 2] },
    ];
    for (const w of walls) {
      const e = scene.createEntity();
      scene.setTransform(e, { position: w.pos, scale: w.scale, immediate: true });
      scene.setCollider3D(e, {
        kind: 'aabb',
        halfExtents: [w.scale[0] * 0.5, w.scale[1] * 0.5, w.scale[2] * 0.5],
      });
      scene.setMesh3D(e, { meshId: boxMesh.meshId, materialId: wallMat, boundsRadius: 20 });
    }

    // Walkable ramp (triangle mesh collider)
    const rampEntity = scene.createEntity();
    scene.setTransform(rampEntity, { position: [8, 0, 2], immediate: true });
    scene.setMesh3D(rampEntity, { meshId: rampMesh.meshId, materialId: wallMat, boundsRadius: 6 });
    scene.addStaticMeshTriangles(rampEntity, extractColliderTriangles(rampGeom, [8, 0, 2]));

    // Showcase row of all 6 built-in presets
    SHADER_PRESET_NAMES.forEach((presetName, idx) => {
      const mId = assets.createPreset(`gallery-${presetName}`, presetName, {}, 'scene');
      const e = scene.createEntity();
      const x = -10 + idx * 4;
      scene.setTransform(e, { position: [x, 1.35, -13.5], scale: [1.3, 1.3, 1.3], immediate: true });
      scene.setMesh3D(e, {
        meshId: idx % 2 === 0 ? sphereMesh.meshId : boxMesh.meshId,
        materialId: mId,
        transparent: presetName === 'hologram',
        boundsRadius: 2,
      });
    });

    // Central crystal loaded via Rust GLB parser + controlled by Shader Block Studio
    const crystalBytes = buildSampleCrystalGlb();
    const crystalHandle = assets.registerMesh(
      'sample-crystal',
      engine.bridge.parseGlb(crystalBytes),
      'scene'
    );
    crystalEntity = scene.createEntity();
    scene.setTransform(crystalEntity, { position: [0, 2.1, -3], immediate: true });
    scene.setMesh3D(crystalEntity, {
      meshId: crystalHandle.meshId,
      materialId: showcaseMatId,
      transparent: currentDesc.transparent,
      boundsRadius: 3,
    });

    // Player capsule
    player = scene.createEntity();
    scene.setTransform(player, { position: [0, 1.2, 6], immediate: true });
    scene.setCollider3D(player, { kind: 'capsule', radius: 0.42, halfHeight: 0.55 });
    scene.setRigidBody(player, { dynamic: true, gravityScale: 1, friction: 0 });
    yaw = 0;
    pitch = -0.15;
  }

  function build2DOMORIStyleScene() {
    scene.clear();
    assets.unloadTag('scene');
    spawnedDynamics.length = 0;
    mode = '2d';
    scene.camera.mode = '2d';
    scene.camera.orthoHeight = 14;
    scene.camera.pixelSnap = true;
    scene.setGravity(0, 0, 0);

    // Build crisp 16x16 procedural pixel character texture
    const pixels = new Uint8Array(16 * 16 * 4);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = (y * 16 + x) * 4;
        const border = x === 0 || x === 15 || y === 0 || y === 15;
        const eyes = y === 10 && (x === 5 || x === 10);
        if (border) {
          pixels.set([20, 18, 30, 255], i);
        } else if (eyes) {
          pixels.set([20, 18, 30, 255], i);
        } else if (y >= 7) {
          pixels.set([245, 224, 210, 255], i);
        } else {
          pixels.set([58, 52, 88, 255], i);
        }
      }
    }
    const heroTex = assets.createTexture('hero-2d', 16, 16, pixels, true, 'scene');

    // Tile grid (15x11 room with pillars — tests seam-free 2D movement)
    const w = 15;
    const h = 11;
    const solid = new Uint8Array(w * h);
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const isWall = tx === 0 || ty === 0 || tx === w - 1 || ty === h - 1 || (tx === 5 && ty >= 3 && ty <= 7);
        solid[ty * w + tx] = isWall ? 1 : 0;
        if (isWall) {
          const tile = scene.createEntity();
          scene.setTransform(tile, { position: [tx - 7, ty - 5, 0], immediate: true });
          scene.setSprite2D(tile, { size: [0.98, 0.98], color: [0.24, 0.22, 0.36, 1], layer: 0 });
        } else {
          const floor = scene.createEntity();
          scene.setTransform(floor, { position: [tx - 7, ty - 5, -0.5], immediate: true });
          const shade = (tx + ty) % 2 === 0 ? 0.14 : 0.17;
          scene.setSprite2D(floor, { size: [1, 1], color: [shade, shade * 1.05, shade * 1.35, 1], layer: -2 });
        }
      }
    }
    scene.addTileGrid2D([-7.5, -5.5], 1.0, w, h, solid);

    // NPCs for Y-sort testing
    const npcPositions: Array<[number, number, [number, number, number, number]]> = [
      [-2, 1.5, [0.95, 0.55, 0.65, 1]],
      [3, -1.5, [0.5, 0.9, 0.78, 1]],
    ];
    for (const [nx, ny, col] of npcPositions) {
      const npc = scene.createEntity();
      scene.setTransform(npc, { position: [nx, ny, 0], immediate: true });
      scene.setCollider2D(npc, { kind: 'aabb2d', halfExtents: [0.4, 0.4] });
      scene.setSprite2D(npc, { size: [0.9, 0.9], textureId: heroTex, color: col, layer: 1 });
    }

    hero2d = scene.createEntity();
    scene.setTransform(hero2d, { position: [0, 0, 0], immediate: true });
    scene.setCollider2D(hero2d, { kind: 'circle2d', radius: 0.38 });
    scene.setRigidBody(hero2d, { dynamic: true, gravityScale: 0 });
    scene.setSprite2D(hero2d, { size: [0.95, 0.95], textureId: heroTex, color: [1, 1, 1, 1], layer: 1 });
  }

  function spawnDynamicCrate() {
    if (mode !== '3d') return;
    const boxMesh = assets.getMesh('box');
    if (!boxMesh) return;
    const [px, py, pz] = scene.getPosition(player);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const e = scene.createEntity();
    scene.setTransform(e, { position: [px + fx * 2.2, py + 1.1, pz + fz * 2.2], immediate: true });
    scene.setCollider3D(e, { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] });
    scene.setRigidBody(e, { dynamic: true, gravityScale: 1, restitution: 0.2 });
    scene.setVelocity(e, fx * 6, 3.5, fz * 6);
    scene.setMesh3D(e, { meshId: boxMesh.meshId, materialId: showcaseMatId, boundsRadius: 1.2 });
    spawnedDynamics.push(e);
  }

  function syncShowcaseMaterial() {
    if (!showcaseMatId) return;
    assets.updateMaterial(showcaseMatId, currentDesc);
    if (crystalEntity) {
      const handle = assets.getMesh('sample-crystal');
      if (handle) {
        scene.setMesh3D(crystalEntity, {
          meshId: handle.meshId,
          materialId: showcaseMatId,
          transparent: currentDesc.transparent,
          boundsRadius: 3,
        });
      }
    }
    syncUiCheckboxes();
  }

  // Build HUD controls
  const presetWrap = document.getElementById('preset-buttons')!;
  const presetButtons = new Map<ShaderPresetName, HTMLButtonElement>();
  for (const name of SHADER_PRESET_NAMES) {
    const btn = document.createElement('button');
    btn.textContent = name;
    if (name === activePreset) btn.classList.add('active');
    btn.onclick = () => {
      activePreset = name;
      const fresh = createPresetMaterial(name);
      currentDesc.blocks = [...fresh.blocks];
      currentDesc.uniforms = { ...fresh.uniforms };
      currentDesc.transparent = fresh.transparent;
      currentDesc.doubleSided = fresh.doubleSided;
      currentDesc.outlineWidth = fresh.outlineWidth;
      currentDesc.outlineColor = fresh.outlineColor;
      presetButtons.forEach((b, k) => b.classList.toggle('active', k === name));
      syncShowcaseMaterial();
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
    chk.checked = currentDesc.blocks.includes(block);
    chk.onchange = () => {
      if (chk.checked && !currentDesc.blocks.includes(block)) {
        currentDesc.blocks.push(block);
      } else if (!chk.checked) {
        currentDesc.blocks = currentDesc.blocks.filter((b) => b !== block);
      }
      currentDesc.transparent = currentDesc.blocks.includes('hologramScanline');
      syncShowcaseMaterial();
    };
    blockCheckboxes.set(block, chk);
    label.appendChild(chk);
    label.appendChild(document.createTextNode(block));
    blocksWrap.appendChild(label);
  }

  function syncUiCheckboxes() {
    blockCheckboxes.forEach((chk, id) => {
      chk.checked = currentDesc.blocks.includes(id);
    });
  }

  const bindSlider = (id: string, valId: string, onChange: (v: number) => void) => {
    const sl = document.getElementById(id) as HTMLInputElement;
    const val = document.getElementById(valId)!;
    sl.oninput = () => {
      const n = Number(sl.value);
      val.textContent = sl.value;
      onChange(n);
      syncShowcaseMaterial();
    };
  };
  bindSlider('sl-cel', 'val-cel', (v) => (currentDesc.uniforms.celSteps = v));
  bindSlider('sl-outline', 'val-outline', (v) => (currentDesc.outlineWidth = v));
  bindSlider('sl-dissolve', 'val-dissolve', (v) => (currentDesc.uniforms.dissolve = v));
  bindSlider('sl-wave', 'val-wave', (v) => (currentDesc.uniforms.waveAmp = v));
  bindSlider('sl-dither', 'val-dither', (v) => (currentDesc.uniforms.ditherStrength = v));

  const btn3d = document.getElementById('btn-3d')!;
  const btn2d = document.getElementById('btn-2d')!;
  btn3d.onclick = () => {
    btn3d.classList.add('active');
    btn2d.classList.remove('active');
    build3DArena();
  };
  btn2d.onclick = () => {
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
    btn2d.classList.add('active');
    btn3d.classList.remove('active');
    build2DOMORIStyleScene();
  };
  document.getElementById('btn-spawn')!.onclick = spawnDynamicCrate;
  document.getElementById('btn-reset')!.onclick = () => {
    if (mode === '3d') build3DArena();
    else build2DOMORIStyleScene();
  };

  canvas.addEventListener('click', () => {
    if (mode === '3d' && !input.isPointerLocked()) {
      input.requestPointerLock();
    }
  });

  // Drag-and-drop Blender .glb support
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
      materialId: showcaseMatId,
      boundsRadius: handle.boundsRadius,
    });
  });

  engine.onFixedUpdate(() => {
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
      const speed = input.isKeyDown('ShiftLeft') ? 10.5 : 6.2;
      const vx = ((forwardX * moveF + rightX * moveR) / len) * (moveF !== 0 || moveR !== 0 ? speed : 0);
      const vz = ((forwardZ * moveF + rightZ * moveR) / len) * (moveF !== 0 || moveR !== 0 ? speed : 0);

      const [, curVy] = scene.getVelocity(player);
      let nextVy = curVy;
      if (input.isKeyDown('Space') && scene.isGrounded(player)) {
        nextVy = 8.4;
      }
      scene.setVelocity(player, vx, nextVy, vz);
    } else {
      let mx = 0;
      let my = 0;
      if (input.isKeyDown('KeyW') || input.isKeyDown('ArrowUp')) my += 1;
      if (input.isKeyDown('KeyS') || input.isKeyDown('ArrowDown')) my -= 1;
      if (input.isKeyDown('KeyD') || input.isKeyDown('ArrowRight')) mx += 1;
      if (input.isKeyDown('KeyA') || input.isKeyDown('ArrowLeft')) mx -= 1;
      const len = Math.hypot(mx, my) || 1;
      const speed = input.isKeyDown('ShiftLeft') ? 7.0 : 4.2;
      scene.setVelocity(hero2d, (mx / len) * speed, (my / len) * speed, 0);
    }
  });

  engine.onUpdate((dt) => {
    spinTime += dt;
    if (input.wasKeyPressed('KeyE')) {
      spawnDynamicCrate();
    }

    if (mode === '3d') {
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
          position: [0, 2.2 + Math.sin(spinTime * 2) * 0.22, -3],
          rotation: quatFromEuler(0, spinTime * 0.85, 0),
        });
      }
    } else {
      const [hx, hy] = scene.getPosition(hero2d);
      scene.camera.position = [hx, hy, 10];
      scene.camera.target = [hx, hy, 0];
    }

    const st = engine.getStats();
    statsEl.innerHTML =
      `<b>QuarkEngine</b> (${mode.toUpperCase()})<br>` +
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
