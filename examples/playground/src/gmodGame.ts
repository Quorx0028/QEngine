import {
  createBoxGeometry,
  createConeGeometry,
  createPlaneGeometry,
  createSphereGeometry,
  createWorldBuilder,
  material,
  quatFromEuler,
  type Engine,
  type EntityId,
  type Vec3Tuple,
} from 'quark-engine';
import type { Input } from 'quark-engine';

export type GModTool = 'physgun' | 'weld' | 'thruster' | 'boom';
export type GModPropKind = 'crate' | 'barrel' | 'plank' | 'steelBall' | 'bouncy' | 'glass' | 'stack';

export interface GModSandboxController {
  update: (dt: number, elapsed: number) => void;
  dispose: () => void;
}

interface PropMeta {
  kind: GModPropKind;
  matId: number;
  baseColor: [number, number, number, number];
  glowColor: [number, number, number];
  mass: number;
  friction: number;
  restitution: number;
  frozen: boolean;
  isGlass?: boolean;
  isExplosive?: boolean;
}

export function startGModSandbox(
  engine: Engine,
  input: Input,
  hudEl: HTMLElement,
  playSfx: (freq: number, dur?: number, type?: OscillatorType, gain?: number) => void
): GModSandboxController {
  const { scene, assets, canvas } = engine;
  const targetCanvas = canvas!;

  assets.unloadTag('scene');
  assets.unloadTag('scene-fx');
  assets.unloadTag('scene-holo');
  scene.clear();

  scene.camera.mode = '3d';
  scene.shadowsEnabled = true;
  scene.light.direction = [0.48, 0.88, 0.42];
  scene.light.color = [1.0, 0.96, 0.9];
  scene.light.intensity = 1.38;
  scene.light.ambientColor = [0.28, 0.34, 0.44];
  scene.skyTopColor = [0.16, 0.44, 0.88];
  scene.skyHorizonColor = [0.64, 0.82, 0.98];
  scene.fogColor = [0.62, 0.78, 0.94];
  scene.fogDensity = 0.0055;
  scene.setWeather('clear');
  scene.setCloudStyle('realistic');
  scene.postProcess.bloomIntensity = 0.28;
  scene.postProcess.ssao = 0.55;
  scene.postProcess.screenOutline = 0;

  // Classic gm_construct open sandbox yard
  const floorMesh = assets.registerMesh('gmod-floor', createPlaneGeometry(68, 68, 24), 'scene');
  const boxMesh = assets.registerMesh('box', createBoxGeometry(0.5, 0.5, 0.5), 'scene');
  const sphereMesh = assets.registerMesh('gmod-sphere', createSphereGeometry(0.5, 18, 22), 'scene');
  const beamMesh = assets.registerMesh('gmod-beam', createConeGeometry(0.03, 0.03, 1.0, 8), 'scene');

  const groundMat = material('ultraRealism')
    .color('#516072')
    .roughness(0.58)
    .grid(0.5)
    .create(assets, 'gmod-ground', 'scene');
  const floorEntity = scene.createEntity();
  scene.setTransform(floorEntity, { position: [0, -0.5, 0], immediate: true });
  scene.setCollider3D(floorEntity, { kind: 'aabb', halfExtents: [34, 0.5, 34] });
  const floorVis = scene.createEntity();
  scene.setTransform(floorVis, { position: [0, 0, 0], immediate: true });
  scene.setMesh3D(floorVis, { meshId: floorMesh.meshId, materialId: groundMat, boundsRadius: 50 });

  const world = createWorldBuilder(scene, assets, 'scene');
  const wallMat = material('ultraRealism').color('#475569').roughness(0.65);
  // Perimeter walls + build pad + ramp + workshop hangar + pool!
  world.box({ pos: [0, 2.2, -33.5], size: [68, 4.4, 1], material: wallMat });
  world.box({ pos: [0, 2.2, 33.5], size: [68, 4.4, 1], material: wallMat });
  world.box({ pos: [-33.5, 2.2, 0], size: [1, 4.4, 68], material: wallMat });
  world.box({ pos: [33.5, 2.2, 0], size: [1, 4.4, 68], material: wallMat });

  // Central GMod flat build platform
  world.box({
    pos: [0, 0.14, -4],
    size: [10, 0.28, 10],
    material: material('ultraRealism').color('#334155').grid(1.0).roughness(0.42),
  });
  // Launch ramp
  world.ramp({
    pos: [-11, 0, -4],
    size: [4.2, 2.2, 7.5],
    material: material('ultraRealism').color('#64748b').grid(1.0),
  });
  // Workshop Garage / Hangar (`room()` with [E] door & windows)
  world.room({
    center: [16, 0, -14],
    size: [10, 4.2, 10],
    doors: ['south'],
    windows: ['west'],
    roof: true,
    floor: false,
    wallMaterial: material('ultraRealism').color('#3b4656').roughness(0.6),
    doorMaterial: material('ultraRealism').color('#b45309').roughness(0.45),
    light: { color: '#fbbf24', intensity: 2.2, godRay: true },
  });
  // Sandbox Water Pool
  world.pool({
    center: [-16, 0, 12],
    size: [8, 2.0, 8],
    glassSides: ['east'],
    waterPreset: 'realistic',
  });

  // Materials for spawned GMod props
  const woodMat = material('ultraRealism').color('#b47b44').roughness(0.62).create(assets, 'gm-wood', 'scene');
  const barrelMat = material('ultraRealism').color('#dc2626').glow('#f97316').metallic(0.45).roughness(0.32).create(assets, 'gm-barrel', 'scene');
  const plankMat = material('ultraRealism').color('#94a3b8').grid(1.0).roughness(0.48).create(assets, 'gm-plank', 'scene');
  const steelMat = material('ultraRealism').color('#cbd5e1').metallic(0.92).roughness(0.18).create(assets, 'gm-steel', 'scene');
  const bouncyMat = material('animeToon').color('#10b981').glow('#34d399').create(assets, 'gm-bouncy', 'scene');
  const glassMat = material('crystalGlass').color('#7dd3fc90').glow('#38bdf8').transparent().doubleSided(true).create(assets, 'gm-glass', 'scene');
  const frozenMat = material('cyberNeon').color('#1d4ed8').glow('#38bdf8').create(assets, 'gm-frozen', 'scene');

  const props = new Map<EntityId, PropMeta>();
  const thrusters: Array<{ entity: EntityId; dir: Vec3Tuple; ttl: number }> = [];
  let weldCount = 0;

  const propDefaults: Record<
    Exclude<GModPropKind, 'stack'>,
    { mat: number; col: [number, number, number, number]; glow: [number, number, number]; mass: number; fric: number; rest: number }
  > = {
    crate: { mat: woodMat, col: [0.7, 0.48, 0.27, 1], glow: [0, 0, 0], mass: 1.5, fric: 0.78, rest: 0.1 },
    barrel: { mat: barrelMat, col: [0.86, 0.15, 0.15, 1], glow: [0.98, 0.45, 0.08], mass: 3.0, fric: 0.65, rest: 0.15 },
    plank: { mat: plankMat, col: [0.58, 0.64, 0.72, 1], glow: [0, 0, 0], mass: 4.0, fric: 0.82, rest: 0.08 },
    steelBall: { mat: steelMat, col: [0.8, 0.84, 0.88, 1], glow: [0, 0, 0], mass: 14.0, fric: 0.6, rest: 0.25 },
    bouncy: { mat: bouncyMat, col: [0.06, 0.72, 0.5, 1], glow: [0.2, 0.82, 0.6], mass: 1.2, fric: 0.85, rest: 0.9 },
    glass: { mat: glassMat, col: [0.49, 0.82, 0.99, 0.58], glow: [0.22, 0.74, 0.97], mass: 1.0, fric: 0.4, rest: 0.2 },
  };

  const spawnProp = (kind: GModPropKind, posOverride?: Vec3Tuple): EntityId | null => {
    if (kind === 'stack') {
      const basePos = posOverride ?? getAimSpot(4.5, 0.55);
      for (let row = 0; row < 3; row++) {
        const cols = 3 - row;
        for (let c = 0; c < cols; c++) {
          spawnProp('crate', [
            basePos[0] + (c - (cols - 1) * 0.5) * 1.06,
            0.52 + row * 1.02,
            basePos[2],
          ]);
        }
      }
      playSfx(540, 0.09, 'triangle', 0.1);
      return null;
    }

    const pos = posOverride ?? getAimSpot(3.4, 1.35);
    const d = propDefaults[kind];
    const e = scene.createEntity();
    let size: Vec3Tuple = [1, 1, 1];
    let isSphere = false;
    if (kind === 'plank') size = [2.8, 0.28, 1.2];
    else if (kind === 'barrel') size = [0.78, 1.18, 0.78];
    else if (kind === 'glass') size = [1.5, 1.5, 0.14];
    else if (kind === 'steelBall' || kind === 'bouncy') {
      isSphere = true;
      size = [1.05, 1.05, 1.05];
    }

    scene.setTransform(e, { position: pos, scale: size, immediate: true });
    if (isSphere) {
      scene.setCollider3D(e, { kind: 'sphere', radius: 0.525 });
    } else {
      scene.setCollider3D(e, { kind: 'aabb', halfExtents: [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5] });
    }
    scene.setRigidBody(e, {
      dynamic: true,
      mass: d.mass,
      friction: d.fric,
      restitution: d.rest,
      linearDamping: 0.1,
      angularDamping: 0.35,
    });
    scene.setMesh3D(e, {
      meshId: isSphere ? sphereMesh.meshId : boxMesh.meshId,
      materialId: d.mat,
      transparent: kind === 'glass',
      boundsRadius: isSphere ? 0.55 : 0.9,
    });
    props.set(e, {
      kind,
      matId: d.mat,
      baseColor: d.col,
      glowColor: d.glow,
      mass: d.mass,
      friction: d.fric,
      restitution: d.rest,
      frozen: false,
      isGlass: kind === 'glass',
      isExplosive: kind === 'barrel',
    });
    scene.emitVfx('magic', pos, 14, 0.04);
    playSfx(640, 0.06, 'sine', 0.07);
    return e;
  };

  // Pre-seed courtyard props for instant play!
  for (let i = 0; i < 3; i++) spawnProp('barrel', [-3 + i * 1.3, 0.65, -4]);
  spawnProp('stack', [2.4, 0.55, -5.0]);
  spawnProp('plank', [-0.2, 0.4, -1.8]);
  spawnProp('steelBall', [-3.6, 0.7, -1.6]);
  spawnProp('glass', [0.0, 1.0, -7.2]);

  // Player controller
  const player = scene.createEntity();
  scene.setTransform(player, { position: [0, 1.35, 8.5], immediate: true });
  scene.setCollider3D(player, { kind: 'capsule', radius: 0.42, halfHeight: 0.55 });
  scene.setRigidBody(player, { dynamic: true, gravityScale: 1, friction: 0, linearDamping: 0, lockRotation: true });
  scene.setCharacterController(player, { stepHeight: 0.5, maxSlopeDeg: 50 });

  // PhysGun beam entity
  const beamMat = material('cyberNeon').color('#38bdf8').glow('#22d3ee').create(assets, 'gm-beam-mat', 'scene-fx');
  const beamEntity = scene.createEntity();
  scene.setTransform(beamEntity, { position: [0, -100, 0], scale: [0.001, 0.001, 0.001], immediate: true });
  scene.setMesh3D(beamEntity, { meshId: beamMesh.meshId, materialId: beamMat, boundsRadius: 1.0 });

  let yaw = 0;
  let pitch = -0.06;
  let activeTool: GModTool = 'physgun';
  let heldProp: EntityId | null = null;
  let holdDist = 4.0;
  let weldFirst: EntityId | null = null;
  let spawnOpen = false;

  const getLookRay = () => {
    const [px, py, pz] = scene.getPosition(player);
    const cp = Math.cos(pitch);
    return {
      origin: [px, py + 0.65, pz] as Vec3Tuple,
      dir: [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp] as Vec3Tuple,
    };
  };

  function getAimSpot(dist: number, minY = 0.6): Vec3Tuple {
    const { origin, dir } = getLookRay();
    return [
      origin[0] + dir[0] * dist,
      Math.max(minY, origin[1] + dir[1] * dist),
      origin[2] + dir[2] * dist,
    ];
  }

  const detonate = (center: Vec3Tuple, destroyTarget?: EntityId) => {
    if (destroyTarget !== undefined && scene.isAlive(destroyTarget)) {
      props.delete(destroyTarget);
      scene.destroyEntity(destroyTarget);
    }
    scene.emitVfx('fire', center, 44, 0.04);
    scene.emitVfx('sparks', center, 48, 0.04);
    scene.emitVfx('smoke', center, 20, 0.04);
    scene.triggerShake(0.24, 0.28);
    engine.audio.playExplosion3D(center, 1.15);

    const toDetonate: Array<{ e: EntityId; pos: Vec3Tuple }> = [];
    for (const [eid, meta] of props) {
      if (!scene.isAlive(eid)) continue;
      const p = scene.getPosition(eid);
      const dx = p[0] - center[0];
      const dy = p[1] - center[1];
      const dz = p[2] - center[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < 8.0) {
        if (meta.isExplosive && d > 0.05) {
          toDetonate.push({ e: eid, pos: p });
        } else {
          if (meta.frozen) toggleFreeze(eid, false);
          const falloff = (1 - d / 8.0) * 18.0;
          const inv = 1 / Math.max(0.2, d);
          scene.applyImpulse(eid, [dx * inv * falloff, (dy * inv + 0.55) * falloff, dz * inv * falloff]);
        }
      }
    }
    for (const item of toDetonate) {
      detonate(item.pos, item.e);
    }
  };

  const toggleFreeze = (eid: EntityId, forceFreeze?: boolean) => {
    const meta = props.get(eid);
    if (!meta || !scene.isAlive(eid)) return;
    const next = forceFreeze ?? !meta.frozen;
    meta.frozen = next;
    if (next) {
      scene.setVelocity(eid, 0, 0, 0);
      scene.setRigidBody(eid, { dynamic: false, mass: 0 });
      scene.setMesh3D(eid, {
        meshId: meta.kind === 'steelBall' || meta.kind === 'bouncy' ? sphereMesh.meshId : boxMesh.meshId,
        materialId: frozenMat,
        boundsRadius: meta.kind === 'steelBall' || meta.kind === 'bouncy' ? 0.55 : 0.9,
      });
      playSfx(920, 0.06, 'sine', 0.09);
    } else {
      scene.setRigidBody(eid, {
        dynamic: true,
        mass: meta.mass,
        friction: meta.friction,
        restitution: meta.restitution,
      });
      scene.setVelocity(eid, 0, 0, 0);
      scene.setMesh3D(eid, {
        meshId: meta.kind === 'steelBall' || meta.kind === 'bouncy' ? sphereMesh.meshId : boxMesh.meshId,
        materialId: meta.matId,
        transparent: meta.isGlass,
        boundsRadius: meta.kind === 'steelBall' || meta.kind === 'bouncy' ? 0.55 : 0.9,
      });
      playSfx(520, 0.06, 'triangle', 0.08);
    }
  };

  // Render clean GMod HUD + Toolbelt + [Q] Spawn Menu
  hudEl.innerHTML = `
    <div class="gmod-status" id="gmod-status"></div>
    <div class="gmod-spawn-menu" id="gmod-spawn-menu">
      <div class="gmod-spawn-head">
        <span>Q · СПАВН-МЕНЮ ПРОПОВ</span>
        <button id="gmod-clear-props">Очистить пропы</button>
      </div>
      <div class="gmod-spawn-grid">
        <button data-prop="crate">📦 Ящик</button>
        <button data-prop="barrel">🛢️ Бочка (БУМ)</button>
        <button data-prop="plank">🪵 Плита / Мост</button>
        <button data-prop="steelBall">⚙️ Тяжёлый шар</button>
        <button data-prop="bouncy">🟢 Прыгучий мяч</button>
        <button data-prop="glass">🧊 Хрупкое стекло</button>
        <button data-prop="stack">🧱 Пирамида ящиков</button>
      </div>
    </div>
    <div class="gmod-toolbelt">
      <button data-tool="physgun" class="active">[1] PhysGun</button>
      <button data-tool="weld">[2] Weld (Сварка)</button>
      <button data-tool="thruster">[3] Thruster (Ракета)</button>
      <button data-tool="boom">[4] Boom (Взрыв)</button>
      <button id="gmod-btn-spawn">[Q] Спавн-меню</button>
    </div>
  `;
  hudEl.classList.add('visible');

  const statusEl = hudEl.querySelector('#gmod-status') as HTMLElement;
  const spawnMenuEl = hudEl.querySelector('#gmod-spawn-menu') as HTMLElement;

  const setTool = (tool: GModTool) => {
    activeTool = tool;
    if (tool !== 'physgun') heldProp = null;
    if (tool !== 'weld') weldFirst = null;
    hudEl.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
  };
  const setSpawnOpen = (open: boolean) => {
    spawnOpen = open;
    spawnMenuEl.classList.toggle('visible', open);
    if (open && document.pointerLockElement) document.exitPointerLock();
  };

  hudEl.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
    b.onclick = () => setTool((b.dataset.tool as GModTool) ?? 'physgun');
  });
  hudEl.querySelectorAll<HTMLButtonElement>('[data-prop]').forEach((b) => {
    b.onclick = () => spawnProp((b.dataset.prop as GModPropKind) ?? 'crate');
  });
  hudEl.querySelector('#gmod-btn-spawn')?.addEventListener('click', () => setSpawnOpen(!spawnOpen));
  hudEl.querySelector('#gmod-clear-props')?.addEventListener('click', () => {
    heldProp = null;
    weldFirst = null;
    for (const [eid] of props) {
      if (scene.isAlive(eid)) scene.destroyEntity(eid);
    }
    props.clear();
  });

  const onMouseDown = (e: MouseEvent) => {
    if (spawnOpen) return;
    if (e.target !== targetCanvas) return;
    if (!input.isPointerLocked()) {
      targetCanvas.requestPointerLock();
      return;
    }
    const { origin, dir } = getLookRay();
    const hit = scene.raycast3D(origin, dir, 36);

    if (activeTool === 'physgun') {
      if (e.button === 0) {
        if (hit && props.has(hit.entity)) {
          heldProp = hit.entity;
          holdDist = Math.max(2.0, Math.min(18.0, hit.distance));
          const meta = props.get(heldProp)!;
          if (meta.frozen) toggleFreeze(heldProp, false);
          playSfx(760, 0.05, 'sine', 0.08);
        }
      } else if (e.button === 2) {
        if (heldProp !== null && scene.isAlive(heldProp)) {
          toggleFreeze(heldProp, true);
          heldProp = null;
        } else if (hit && props.has(hit.entity)) {
          toggleFreeze(hit.entity);
        }
      }
      return;
    }

    if (!hit) return;

    if (activeTool === 'weld') {
      if (e.button === 0 && props.has(hit.entity)) {
        if (weldFirst === null || !scene.isAlive(weldFirst)) {
          weldFirst = hit.entity;
          scene.emitVfx('sparks', hit.point, 12, 0.04);
          playSfx(680, 0.05, 'triangle', 0.09);
        } else if (weldFirst !== hit.entity) {
          const pA = scene.getPosition(weldFirst);
          const pB = scene.getPosition(hit.entity);
          const mid: Vec3Tuple = [(pA[0] + pB[0]) * 0.5, (pA[1] + pB[1]) * 0.5, (pA[2] + pB[2]) * 0.5];
          scene.addFixedJoint(weldFirst, hit.entity, {
            anchorA: [mid[0] - pA[0], mid[1] - pA[1], mid[2] - pA[2]],
            anchorB: [mid[0] - pB[0], mid[1] - pB[1], mid[2] - pB[2]],
          });
          weldCount++;
          scene.emitVfx('sparks', mid, 26, 0.04);
          playSfx(880, 0.1, 'sawtooth', 0.11);
          weldFirst = null;
        }
      }
    } else if (activeTool === 'thruster' && props.has(hit.entity)) {
      const meta = props.get(hit.entity)!;
      if (meta.frozen) toggleFreeze(hit.entity, false);
      const pushDir: Vec3Tuple = [-hit.normal[0], -hit.normal[1] + 0.18, -hit.normal[2]];
      thrusters.push({ entity: hit.entity, dir: pushDir, ttl: 3.2 });
      playSfx(420, 0.14, 'sawtooth', 0.1);
    } else if (activeTool === 'boom') {
      if (e.button === 0 && props.has(hit.entity)) {
        detonate(hit.point, hit.entity);
      } else if (e.button === 2) {
        detonate(hit.point);
      }
    }
  };

  const onMouseUp = (e: MouseEvent) => {
    if (e.button === 0 && activeTool === 'physgun') {
      heldProp = null;
    }
  };

  const onWheel = (e: WheelEvent) => {
    if (heldProp !== null) {
      holdDist = Math.max(1.8, Math.min(22.0, holdDist - e.deltaY * 0.01));
    }
  };

  const onCtxMenu = (e: MouseEvent) => e.preventDefault();
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('wheel', onWheel, { passive: true });
  targetCanvas.addEventListener('contextmenu', onCtxMenu);

  return {
    update(dt: number) {
      if (input.wasKeyPressed('Digit1')) setTool('physgun');
      if (input.wasKeyPressed('Digit2')) setTool('weld');
      if (input.wasKeyPressed('Digit3')) setTool('thruster');
      if (input.wasKeyPressed('Digit4')) setTool('boom');
      if (input.wasKeyPressed('KeyQ')) setSpawnOpen(!spawnOpen);

      if (input.wasKeyPressed('KeyE')) {
        world.getNearestDoor(scene.getPosition(player), 3.0)?.toggle();
      }

      if (input.wasKeyPressed('KeyR')) {
        if (heldProp !== null && scene.isAlive(heldProp)) {
          const { dir } = getLookRay();
          const id = heldProp;
          heldProp = null;
          scene.applyImpulse(id, [dir[0] * 18, dir[1] * 18 + 2.5, dir[2] * 18]);
          playSfx(320, 0.1, 'sawtooth', 0.14);
        } else {
          // Unfreeze all frozen props!
          for (const [eid, meta] of props) {
            if (meta.frozen) toggleFreeze(eid, false);
          }
        }
      }

      // WASD + Space + Shift player movement
      const [dx, dy] = input.consumeMouseDelta();
      yaw -= dx * 0.0024;
      pitch = Math.max(-1.25, Math.min(1.15, pitch - dy * 0.0022));

      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const rx = Math.cos(yaw);
      const rz = -Math.sin(yaw);
      let mx = 0;
      let mz = 0;
      if (input.isKeyDown('KeyW')) { mx += fx; mz += fz; }
      if (input.isKeyDown('KeyS')) { mx -= fx; mz -= fz; }
      if (input.isKeyDown('KeyD')) { mx += rx; mz += rz; }
      if (input.isKeyDown('KeyA')) { mx -= rx; mz -= rz; }
      const mLen = Math.hypot(mx, mz);
      const speed = input.isKeyDown('ShiftLeft') ? 9.5 : 5.8;
      const [, vy] = scene.getVelocity(player);
      scene.setVelocity(player, mLen > 0 ? (mx / mLen) * speed : 0, vy, mLen > 0 ? (mz / mLen) * speed : 0);
      if (input.wasKeyPressed('Space')) {
        const hitG = scene.raycast3D(scene.getPosition(player), [0, -1, 0], 1.15);
        if (hitG) scene.setVelocity(player, mLen > 0 ? (mx / mLen) * speed : 0, 8.2, mLen > 0 ? (mz / mLen) * speed : 0);
      }

      world.update(dt);

      const [px, py, pz] = scene.getPosition(player);
      const eyeY = py + 0.65;
      scene.camera.position = [px, eyeY, pz];
      scene.camera.target = [
        px - Math.sin(yaw) * Math.cos(pitch),
        eyeY + Math.sin(pitch),
        pz - Math.cos(yaw) * Math.cos(pitch),
      ];

      // PhysGun PD spring hold + glowing cyan tether beam
      if (heldProp !== null && scene.isAlive(heldProp)) {
        const targetPos = getAimSpot(holdDist, 0.55);
        const curPos = scene.getPosition(heldProp);
        const curVel = scene.getVelocity(heldProp);
        const errX = targetPos[0] - curPos[0];
        const errY = targetPos[1] - curPos[1];
        const errZ = targetPos[2] - curPos[2];
        scene.setVelocity(
          heldProp,
          (errX * 14 - curVel[0] * 0.45),
          (errY * 14 - curVel[1] * 0.45),
          (errZ * 14 - curVel[2] * 0.45)
        );
        const hand: Vec3Tuple = [px + rx * 0.25, eyeY - 0.14, pz + rz * 0.25];
        const bx = curPos[0] - hand[0];
        const by = curPos[1] - hand[1];
        const bz = curPos[2] - hand[2];
        const bLen = Math.max(0.1, Math.hypot(bx, by, bz));
        const bYaw = Math.atan2(bx, bz);
        const bPitch = Math.atan2(by, Math.hypot(bx, bz));
        scene.setTransform(beamEntity, {
          position: [(hand[0] + curPos[0]) * 0.5, (hand[1] + curPos[1]) * 0.5, (hand[2] + curPos[2]) * 0.5],
          rotation: quatFromEuler(Math.PI * 0.5 - bPitch, bYaw, 0),
          scale: [1.0, bLen, 1.0],
          immediate: true,
        });
      } else {
        heldProp = null;
        scene.setTransform(beamEntity, { position: [0, -100, 0], scale: [0.001, 0.001, 0.001], immediate: true });
      }

      // Active rocket thrusters
      for (let i = thrusters.length - 1; i >= 0; i--) {
        const th = thrusters[i];
        th.ttl -= dt;
        if (th.ttl <= 0 || !scene.isAlive(th.entity)) {
          thrusters.splice(i, 1);
          continue;
        }
        const f = 22.0 * dt;
        scene.applyImpulse(th.entity, [th.dir[0] * f, th.dir[1] * f, th.dir[2] * f]);
        scene.emitVfx('fire', scene.getPosition(th.entity), 3, 0.05);
      }

      let frozenCnt = 0;
      for (const [, m] of props) if (m.frozen) frozenCnt++;
      statusEl.innerHTML =
        `<b>GMod Sandbox</b> · Инструмент: <b>${activeTool.toUpperCase()}</b> · Пропов: <b>${props.size}</b> · Заморожено: <b>${frozenCnt}</b> · Сварок: <b>${weldCount}</b><br>` +
        `<span>ЛКМ: действие | ПКМ: заморозить (PhysGun) | Колесо: дистанция | R: толчок/разморозка | Q: спавн-меню | 1-4: инструменты</span>`;
    },

    dispose() {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('wheel', onWheel);
      targetCanvas.removeEventListener('contextmenu', onCtxMenu);
      hudEl.classList.remove('visible');
      hudEl.innerHTML = '';
    },
  };
}
