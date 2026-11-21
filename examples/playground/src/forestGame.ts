import {
  createBoxGeometry,
  createPlaneGeometry,
  createPresetMaterial,
  Engine,
  quatFromEuler,
  type EntityId,
  type MeshGeometry,
  type Vec3Tuple,
} from 'quark-engine';
import { buildSampleCrystalGlb } from './sampleGlb';

function createConeGeometry(radius = 1, height = 2, segments = 12): MeshGeometry {
  const verts: number[] = [];
  const inds: number[] = [];
  const tip: Vec3Tuple = [0, height, 0];

  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0: Vec3Tuple = [Math.cos(a0) * radius, 0, Math.sin(a0) * radius];
    const p1: Vec3Tuple = [Math.cos(a1) * radius, 0, Math.sin(a1) * radius];

    const ux = p1[0] - tip[0], uy = p1[1] - tip[1], uz = p1[2] - tip[2];
    const vx = p0[0] - tip[0], vy = p0[1] - tip[1], vz = p0[2] - tip[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;

    const base = verts.length / 8;
    verts.push(...tip, nx, ny, nz, 0.5, 1);
    verts.push(...p1, nx, ny, nz, 1, 0);
    verts.push(...p0, nx, ny, nz, 0, 0);
    inds.push(base, base + 1, base + 2);
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(inds) };
}

export interface ForestHudRefs {
  container: HTMLElement;
  keysText: HTMLElement;
  staminaBar: HTMLElement;
  flashlightText: HTMLElement;
  statusBanner: HTMLElement;
  statusTitle: HTMLElement;
  statusSub: HTMLElement;
  onEndScreenRestart: () => void;
}

export interface ForestGameController {
  fixedUpdate(fixedDt: number): void;
  update(dt: number): void;
  getModeLabel(): string;
}

export function startForestEscapeGame(
  engine: Engine,
  hud: ForestHudRefs,
  playSfx: (freq: number, dur?: number, type?: OscillatorType, vol?: number) => void
): ForestGameController {
  const { scene, assets, input } = engine;
  scene.clear();
  assets.unloadTag('scene');

  scene.camera.mode = '3d';
  scene.camera.pixelSnap = false;
  scene.shadowsEnabled = true;
  scene.setGravity(0, -24, 0);

  // Dark foggy night forest atmosphere
  scene.skyTopColor = [0.008, 0.014, 0.035];
  scene.skyHorizonColor = [0.025, 0.045, 0.085];
  scene.fogColor = [0.018, 0.028, 0.052];
  scene.fogDensity = 0.048;
  scene.light.direction = [-0.35, 0.8, -0.4];
  scene.light.color = [0.42, 0.54, 0.85];
  scene.light.intensity = 0.16;
  scene.light.ambientColor = [0.035, 0.045, 0.075];

  const floorMesh = assets.registerMesh('f-floor', createPlaneGeometry(66, 66, 24), 'scene');
  const boxMesh = assets.registerMesh('f-box', createBoxGeometry(0.5, 0.5, 0.5), 'scene');
  const coneMesh = assets.registerMesh('f-cone', createConeGeometry(1.0, 2.2, 10), 'scene');
  const keyMesh = assets.registerMesh('f-key', engine.bridge.parseGlb(buildSampleCrystalGlb()), 'scene');

  const groundMat = assets.createMaterial(
    'f-ground',
    {
      blocks: ['pbrLighting', 'distanceFog'],
      uniforms: {
        ...createPresetMaterial('pbr').uniforms,
        baseColor: [0.09, 0.14, 0.08, 1],
        roughness: 0.92,
      },
    },
    'scene'
  );
  const trunkMat = assets.createPreset(
    'f-trunk',
    'pbr',
    { uniforms: { baseColor: [0.22, 0.14, 0.09, 1], roughness: 0.9 } },
    'scene'
  );
  const pineMat = assets.createPreset(
    'f-pine',
    'pbr',
    { uniforms: { baseColor: [0.06, 0.22, 0.1, 1], roughness: 0.82 } },
    'scene'
  );
  const fenceMat = assets.createPreset(
    'f-fence',
    'pbr',
    { uniforms: { baseColor: [0.16, 0.15, 0.18, 1], roughness: 0.85 } },
    'scene'
  );
  const monsterBodyMat = assets.createPreset(
    'f-monster',
    'pbr',
    { uniforms: { baseColor: [0.05, 0.04, 0.06, 1], roughness: 0.6 } },
    'scene'
  );
  const monsterEyeMat = assets.createMaterial(
    'f-eye',
    {
      blocks: ['fresnelGlow', 'distanceFog'],
      uniforms: {
        ...createPresetMaterial('pbr').uniforms,
        baseColor: [1.0, 0.1, 0.08, 1],
        glowColor: [1.0, 0.2, 0.15],
        fresnelPower: 0.5,
      },
    },
    'scene'
  );
  const keyMat = assets.createPreset(
    'f-key-mat',
    'hologram',
    { uniforms: { baseColor: [0.25, 0.95, 1.0, 0.85], glowColor: [0.4, 1.0, 1.0] } },
    'scene'
  );
  const exitLockedMat = assets.createPreset(
    'f-exit-locked',
    'pbr',
    { uniforms: { baseColor: [0.45, 0.15, 0.15, 1] } },
    'scene'
  );
  const exitOpenMat = assets.createPreset(
    'f-exit-open',
    'hologram',
    { uniforms: { baseColor: [0.2, 1.0, 0.45, 0.85], glowColor: [0.3, 1.0, 0.55] } },
    'scene'
  );

  // Floor & perimeter walls
  const floorCol = scene.createEntity();
  scene.setTransform(floorCol, { position: [0, -0.5, 0], immediate: true });
  scene.setCollider3D(floorCol, { kind: 'aabb', halfExtents: [33, 0.5, 33] });

  const floorVis = scene.createEntity();
  scene.setTransform(floorVis, { position: [0, 0, 0], immediate: true });
  scene.setMesh3D(floorVis, { meshId: floorMesh.meshId, materialId: groundMat, boundsRadius: 55 });

  const bounds: Array<{ pos: Vec3Tuple; scale: Vec3Tuple }> = [
    { pos: [0, 2, -28], scale: [56, 4, 1] },
    { pos: [0, 2, 28], scale: [56, 4, 1] },
    { pos: [-28, 2, 0], scale: [1, 4, 56] },
    { pos: [28, 2, 0], scale: [1, 4, 56] },
  ];
  for (const b of bounds) {
    const e = scene.createEntity();
    scene.setTransform(e, { position: b.pos, scale: b.scale, immediate: true });
    scene.setCollider3D(e, { kind: 'aabb', halfExtents: [b.scale[0] * 0.5, b.scale[1] * 0.5, b.scale[2] * 0.5] });
    scene.setMesh3D(e, { meshId: boxMesh.meshId, materialId: fenceMat, boundsRadius: 32 });
  }

  // Deterministic scattered pine forest (leaving spawn [0, 20] and exit [0, -25] clear)
  const treeCoords: Array<[number, number, number]> = [];
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 48; i++) {
    const x = (rand() - 0.5) * 48;
    const z = (rand() - 0.5) * 48;
    if (Math.hypot(x, z - 20) < 5.5 || Math.hypot(x, z + 24) < 5.5 || Math.hypot(x, z + 18) < 4.5) {
      continue;
    }
    const scale = 0.85 + rand() * 0.55;
    treeCoords.push([x, z, scale]);

    const trunk = scene.createEntity();
    scene.setTransform(trunk, { position: [x, 1.3 * scale, z], scale: [0.65 * scale, 2.6 * scale, 0.65 * scale], immediate: true });
    scene.setCollider3D(trunk, { kind: 'aabb', halfExtents: [0.35 * scale, 1.4 * scale, 0.35 * scale] });
    scene.setMesh3D(trunk, { meshId: boxMesh.meshId, materialId: trunkMat, boundsRadius: 2.5 });

    const crown1 = scene.createEntity();
    scene.setTransform(crown1, { position: [x, 2.0 * scale, z], scale: [2.1 * scale, 1.5 * scale, 2.1 * scale], immediate: true });
    scene.setMesh3D(crown1, { meshId: coneMesh.meshId, materialId: pineMat, boundsRadius: 4.0 });

    const crown2 = scene.createEntity();
    scene.setTransform(crown2, { position: [x, 3.3 * scale, z], scale: [1.55 * scale, 1.4 * scale, 1.55 * scale], immediate: true });
    scene.setMesh3D(crown2, { meshId: coneMesh.meshId, materialId: pineMat, boundsRadius: 3.5 });
  }

  // Player
  const player = scene.createEntity();
  scene.setTransform(player, { position: [0, 1.2, 20], immediate: true });
  scene.setCollider3D(player, { kind: 'capsule', radius: 0.42, halfHeight: 0.55 });
  scene.setRigidBody(player, {
    dynamic: true,
    gravityScale: 1,
    friction: 0,
    linearDamping: 0,
    lockRotation: true,
  });

  // 3 Energy Keys scattered in the dark woods
  const keyPositions: Vec3Tuple[] = [
    [-18, 1.3, 6],
    [17, 1.3, -2],
    [-12, 1.3, -16],
  ];
  const activeKeys = new Map<EntityId, boolean>();
  const keyList: EntityId[] = [];
  for (const kp of keyPositions) {
    const k = scene.createEntity();
    scene.setTransform(k, { position: kp, scale: [0.55, 0.55, 0.55], immediate: true });
    scene.setCollider3D(k, { kind: 'aabb', halfExtents: [1.1, 1.4, 1.1] });
    scene.setTrigger(k, true);
    scene.setMesh3D(k, { meshId: keyMesh.meshId, materialId: keyMat, transparent: true, boundsRadius: 2 });
    activeKeys.set(k, true);
    keyList.push(k);
  }

  // Exit Gate at north clearing (0, 1.5, -25)
  const exitGate = scene.createEntity();
  scene.setTransform(exitGate, { position: [0, 1.7, -25], scale: [3.2, 3.4, 1.2], immediate: true });
  scene.setCollider3D(exitGate, { kind: 'aabb', halfExtents: [1.7, 1.8, 0.9] });
  scene.setTrigger(exitGate, true);
  scene.setMesh3D(exitGate, { meshId: boxMesh.meshId, materialId: exitLockedMat, boundsRadius: 4 });

  // Monster
  const monster = scene.createEntity();
  scene.setTransform(monster, { position: [4, 1.4, -18], immediate: true });
  scene.setCollider3D(monster, { kind: 'capsule', radius: 0.55, halfHeight: 0.8 });
  scene.setRigidBody(monster, {
    dynamic: true,
    gravityScale: 1,
    friction: 0,
    linearDamping: 0,
    lockRotation: true,
  });

  const monsterBody = scene.createEntity();
  scene.setTransform(monsterBody, { position: [0, 0, 0], scale: [0.95, 2.4, 0.75], immediate: true });
  scene.setParent(monsterBody, monster);
  scene.setMesh3D(monsterBody, { meshId: boxMesh.meshId, materialId: monsterBodyMat, boundsRadius: 2.5 });

  const eyeL = scene.createEntity();
  scene.setTransform(eyeL, { position: [-0.2, 0.85, 0.39], scale: [0.16, 0.12, 0.1], immediate: true });
  scene.setParent(eyeL, monster);
  scene.setMesh3D(eyeL, { meshId: boxMesh.meshId, materialId: monsterEyeMat, boundsRadius: 0.5 });

  const eyeR = scene.createEntity();
  scene.setTransform(eyeR, { position: [0.2, 0.85, 0.39], scale: [0.16, 0.12, 0.1], immediate: true });
  scene.setParent(eyeR, monster);
  scene.setMesh3D(eyeR, { meshId: boxMesh.meshId, materialId: monsterEyeMat, boundsRadius: 0.5 });

  // Point lights: [0] flashlight target, [1] player ambient glow, [2] monster red glow, [3] exit/beacon glow
  scene.pointLights.length = 0;
  scene.pointLights.push(
    { position: [0, 1.6, 14], color: [1.0, 0.93, 0.74], intensity: 3.8, radius: 13.5 },
    { position: [0, 1.6, 20], color: [0.65, 0.75, 0.95], intensity: 0.85, radius: 4.5 },
    { position: [4, 2.2, -18], color: [1.0, 0.12, 0.1], intensity: 2.8, radius: 10.5 },
    { position: [0, 2.5, -25], color: [1.0, 0.25, 0.2], intensity: 2.2, radius: 12.0 }
  );

  let yaw = 0;
  let pitch = -0.05;
  let flashlightOn = true;
  let stamina = 1.0;
  let keysCollected = 0;
  let gameState: 'playing' | 'won' | 'lost' = 'playing';
  let elapsed = 0;
  let heartbeatTimer = 0;
  let steerBias = 1;

  hud.container.style.display = 'flex';
  hud.statusBanner.style.display = 'none';
  hud.keysText.textContent = 'Ключи: 0 / 3';
  hud.flashlightText.textContent = 'Фонарик (F): ВКЛ';

  scene.onTriggerEnter((ev) => {
    if (gameState !== 'playing') return;
    const isPlayer = ev.entityA === player || ev.entityB === player;
    if (!isPlayer) return;
    const other = ev.entityA === player ? ev.entityB : ev.entityA;

    if (activeKeys.get(other)) {
      activeKeys.set(other, false);
      scene.destroyEntity(other);
      keysCollected++;
      hud.keysText.textContent = `Ключи: ${keysCollected} / 3`;
      playSfx(660 + keysCollected * 110, 0.18, 'triangle', 0.16);
      if (keysCollected >= 3) {
        scene.setMesh3D(exitGate, {
          meshId: boxMesh.meshId,
          materialId: exitOpenMat,
          transparent: true,
          boundsRadius: 4,
        });
        scene.pointLights[3].color = [0.2, 1.0, 0.45];
        scene.pointLights[3].intensity = 4.0;
        playSfx(880, 0.3, 'sine', 0.18);
      }
      return;
    }

    if (other === exitGate && keysCollected >= 3) {
      gameState = 'won';
      if (document.pointerLockElement) document.exitPointerLock();
      hud.statusBanner.style.display = 'block';
      hud.statusTitle.textContent = 'ТЫ ВЫБРАЛСЯ ИЗ ЛЕСА!';
      hud.statusTitle.style.color = '#4ade80';
      hud.statusSub.textContent = `Время побега: ${elapsed.toFixed(1)} сек.`;
      playSfx(987, 0.35, 'sine', 0.2);
    }
  });

  return {
    getModeLabel: () => 'FOREST ESCAPE',
    fixedUpdate(fixedDt: number) {
      if (gameState !== 'playing') {
        scene.setVelocity(player, 0, 0, 0);
        scene.setVelocity(monster, 0, 0, 0);
        return;
      }

      // Player movement + stamina sprint
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

      const moving = moveF !== 0 || moveR !== 0;
      const wantsSprint = input.isKeyDown('ShiftLeft') && moving && stamina > 0.05;
      if (wantsSprint) {
        stamina = Math.max(0, stamina - fixedDt * 0.32);
      } else {
        stamina = Math.min(1, stamina + fixedDt * (moving ? 0.14 : 0.26));
      }

      const speed = wantsSprint ? 8.4 : 5.2;
      const len = Math.hypot(moveF, moveR) || 1;
      const vx = moving ? ((forwardX * moveF + rightX * moveR) / len) * speed : 0;
      const vz = moving ? ((forwardZ * moveF + rightZ * moveR) / len) * speed : 0;
      const [, curVy] = scene.getVelocity(player);
      let nextVy = curVy;
      if (input.isKeyDown('Space') && scene.isGrounded(player)) {
        nextVy = 8.2;
      }
      scene.setVelocity(player, vx, nextVy, vz);

      // Monster stalker AI + obstacle avoidance steering
      const pPos = scene.getPosition(player);
      const mPos = scene.getPosition(monster);
      const toPx = pPos[0] - mPos[0];
      const toPz = pPos[2] - mPos[2];
      const dist = Math.hypot(toPx, toPz) || 1;

      let dirX = toPx / dist;
      let dirZ = toPz / dist;

      // Steer around tree trunks ahead (start ray outside monster's own 0.55m capsule)
      const aheadHit = scene.raycast3D(
        [mPos[0] + dirX * 0.75, 1.1, mPos[2] + dirZ * 0.75],
        [dirX, 0, dirZ],
        2.0
      );
      if (aheadHit && aheadHit.entity !== player && aheadHit.entity !== monster) {
        const perpX = -dirZ * steerBias;
        const perpZ = dirX * steerBias;
        dirX = dirX * 0.25 + perpX * 0.95;
        dirZ = dirZ * 0.25 + perpZ * 0.95;
        const sl = Math.hypot(dirX, dirZ) || 1;
        dirX /= sl;
        dirZ /= sl;
      } else if (Math.random() < 0.01) {
        steerBias = -steerBias;
      }

      // Monster moves faster as keys are collected or when flashlight shines straight at it
      const monsterSpeed = 3.85 + keysCollected * 0.45;
      const [, mVy] = scene.getVelocity(monster);
      scene.setVelocity(monster, dirX * monsterSpeed, mVy, dirZ * monsterSpeed);

      const mYaw = Math.atan2(dirX, dirZ);
      scene.setTransform(monster, {
        position: mPos,
        rotation: quatFromEuler(0, mYaw, 0),
      });

      if (dist < 1.35) {
        gameState = 'lost';
        if (document.pointerLockElement) document.exitPointerLock();
        scene.triggerShake(0.35, 0.5);
        hud.statusBanner.style.display = 'block';
        hud.statusTitle.textContent = 'МОНСТР ПОЙМАЛ ТЕБЯ!';
        hud.statusTitle.style.color = '#f87171';
        hud.statusSub.textContent = `Собрано ключей: ${keysCollected}/3 · Продержался ${elapsed.toFixed(1)} сек.`;
        playSfx(110, 0.45, 'sawtooth', 0.24);
      }
    },

    update(dt: number) {
      if (gameState === 'playing') {
        elapsed += dt;
        if (input.wasKeyPressed('KeyF')) {
          flashlightOn = !flashlightOn;
          hud.flashlightText.textContent = `Фонарик (F): ${flashlightOn ? 'ВКЛ' : 'ВЫКЛ'}`;
          playSfx(flashlightOn ? 740 : 420, 0.04, 'square', 0.07);
        }
      }

      const [dx, dy] = input.consumeMouseDelta();
      if (gameState === 'playing') {
        yaw -= dx * 0.0024;
        pitch = Math.max(-1.2, Math.min(1.05, pitch - dy * 0.0022));
      }

      const [px, py, pz] = scene.getPosition(player);
      const eyeY = py + 0.65;
      const lookX = -Math.sin(yaw) * Math.cos(pitch);
      const lookY = Math.sin(pitch);
      const lookZ = -Math.cos(yaw) * Math.cos(pitch);

      scene.camera.position = [px, eyeY, pz];
      scene.camera.target = [px + lookX, eyeY + lookY, pz + lookZ];

      const [mx, my, mz] = scene.getPosition(monster);
      const monsterDist = Math.hypot(mx - px, mz - pz);

      // Flashlight beam placement via real WASM raycast (start outside player's 0.42m capsule)
      if (flashlightOn) {
        const hit = scene.raycast3D(
          [px + lookX * 0.65, eyeY + lookY * 0.65, pz + lookZ * 0.65],
          [lookX, lookY, lookZ],
          11.5
        );
        const beamDist = hit ? Math.max(1.2, hit.distance) : 8.5;
        const flicker = monsterDist < 10 ? 0.72 + Math.sin(elapsed * 37) * 0.28 : 1.0;
        scene.pointLights[0].position = [px + lookX * beamDist, eyeY + lookY * beamDist, pz + lookZ * beamDist];
        scene.pointLights[0].intensity = 4.0 * flicker;
        scene.pointLights[1].position = [px, eyeY, pz];
        scene.pointLights[1].intensity = 0.9;
      } else {
        scene.pointLights[0].intensity = 0;
        scene.pointLights[1].position = [px, eyeY, pz];
        scene.pointLights[1].intensity = 0.35;
      }

      scene.pointLights[2].position = [mx, my + 0.9, mz];

      // Spin remaining keys
      for (const k of keyList) {
        if (!activeKeys.get(k)) continue;
        const kp = scene.getPosition(k);
        scene.setTransform(k, {
          position: [kp[0], 1.25 + Math.sin(elapsed * 3) * 0.2, kp[2]],
          rotation: quatFromEuler(0, elapsed * 1.6, 0),
        });
      }

      // Tension heartbeat sound + subtle camera shake when monster is near
      if (gameState === 'playing' && monsterDist < 17) {
        const urgency = Math.max(0.22, (monsterDist / 17) * 0.85);
        heartbeatTimer += dt;
        if (heartbeatTimer >= urgency) {
          heartbeatTimer = 0;
          playSfx(58, 0.08, 'sine', 0.14 * (1 - monsterDist / 20));
          if (monsterDist < 6.5) {
            scene.triggerShake(0.035, 0.09);
          }
        }
      }

      hud.staminaBar.style.width = `${Math.round(stamina * 100)}%`;
      hud.staminaBar.style.background = stamina < 0.25 ? '#f87171' : '#38bdf8';
    },
  };
}
