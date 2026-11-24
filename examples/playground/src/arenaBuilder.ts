import {
  createBoxGeometry,
  createCylinderGeometry,
  createPlaneGeometry,
  createPresetMaterial,
  createRampGeometry,
  createSphereGeometry,
  extractColliderTriangles,
  ParticleEmitter,
  quatFromEuler,
  SHADER_PRESET_NAMES,
  type AssetManager,
  type EntityId,
  type MaterialDesc,
  type Scene,
  type ShaderBlockId,
  type ShaderPresetName,
  type Vec3Tuple,
  type WasmBridge,
} from 'quark-engine';
import { HoloSignFactory } from './holoSigns';
import { buildSampleCrystalGlb } from './sampleGlb';

export interface SceneMaterialMeta {
  baseColor: [number, number, number, number];
  textureId?: number;
  keepGrid?: boolean;
}

export interface ArenaBuildContext {
  scene: Scene;
  assets: AssetManager;
  bridge: WasmBridge;
  crystalDesc: MaterialDesc;
  propsDesc: MaterialDesc;
  sceneMaterialMeta: Map<number, SceneMaterialMeta>;
  playSfx: (freq: number, dur?: number, type?: OscillatorType, vol?: number) => void;
}

export interface ArenaController {
  player: EntityId;
  crystalEntity: EntityId;
  crystalMatId: number;
  propsMatId: number;
  crateTexId: number;
  getInteractPrompt: () => string | null;
  tryInteract: () => void;
  toggleRoomLight: () => void;
  fixedUpdate: (dt: number) => void;
  update: (dt: number, totalTime: number) => void;
}

function makeStoneTileTexture(assets: AssetManager): number {
  const size = 128;
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const border = x < 3 || y < 3 || x > size - 4 || y > size - 4;
      const hash = ((x * 73856093) ^ (y * 19349663)) & 255;
      const speck = (hash % 18) - 9;
      const base = border ? 128 : 184 + speck;
      px[i] = Math.max(20, Math.min(255, base));
      px[i + 1] = Math.max(20, Math.min(255, base + 4));
      px[i + 2] = Math.max(20, Math.min(255, base + 12));
      px[i + 3] = 255;
    }
  }
  return assets.createTexture('stone-tile', size, size, px, false, 'scene');
}

function makeCrateWoodTexture(assets: AssetManager): number {
  const size = 128;
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const frame = x < 10 || y < 10 || x > size - 11 || y > size - 11;
      const diag = Math.abs(x - y) < 6;
      const plank = y % 32 < 2;
      const grain = (((x * 37 + y * 13) & 15) - 7) * 2;
      const lum = frame || diag ? 148 + grain : plank ? 115 : 196 + grain;
      px[i] = Math.max(20, Math.min(255, lum));
      px[i + 1] = Math.max(20, Math.min(255, lum * 0.84));
      px[i + 2] = Math.max(20, Math.min(255, lum * 0.62));
      px[i + 3] = 255;
    }
  }
  return assets.createTexture('crate-wood', size, size, px, false, 'scene');
}

export function buildShowcaseArena(ctx: ArenaBuildContext): ArenaController {
  const { scene, assets, bridge, crystalDesc, propsDesc, sceneMaterialMeta, playSfx } = ctx;

  scene.camera.mode = '3d';
  scene.camera.pixelSnap = false;
  scene.fogDensity = 0.0065;
  scene.light.intensity = 1.4;
  scene.setGravity(0, -22, 0);

  const floorTex = makeStoneTileTexture(assets);
  const crateTex = makeCrateWoodTexture(assets);

  const floorMesh = assets.registerMesh('floor', createPlaneGeometry(56, 56, 28), 'scene');
  const waterMesh = assets.registerMesh('water-surface', createPlaneGeometry(6.3, 6.3, 28), 'scene');
  const boxMesh = assets.registerMesh('box', createBoxGeometry(0.5, 0.5, 0.5), 'scene');
  const sphereMesh = assets.registerMesh('sphere', createSphereGeometry(0.55, 18, 24), 'scene');
  const cylMesh = assets.registerMesh('cyl', createCylinderGeometry(0.45, 0.9, 20), 'scene');
  const moteMesh = assets.registerMesh('dust-mote', createSphereGeometry(0.014, 6, 8), 'scene');
  const rampGentleGeom = createRampGeometry(4.0, 2.0, 7.0);
  const rampGentleMesh = assets.registerMesh('ramp-gentle', rampGentleGeom, 'scene');
  const rampSteepGeom = createRampGeometry(4.2, 3.0, 5.2);
  const rampSteepMesh = assets.registerMesh('ramp-steep', rampSteepGeom, 'scene');

  const floorMat = assets.createMaterial(
    'floor-grid',
    {
      blocks: ['pbrLighting', 'envIBL', 'microDetail', 'triplanarGrid', 'distanceFog'],
      uniforms: {
        ...createPresetMaterial('ultraRealism').uniforms,
        baseColor: [0.42, 0.46, 0.54, 1],
        roughness: 0.36,
        metallic: 0.12,
        gridScale: 1.0,
      },
      textureId: floorTex,
    },
    'scene'
  );
  sceneMaterialMeta.set(floorMat, {
    baseColor: [0.42, 0.46, 0.54, 1],
    textureId: floorTex,
    keepGrid: true,
  });

  const wallMat = assets.createPreset(
    'wall-pbr',
    'ultraRealism',
    {
      uniforms: { baseColor: [0.46, 0.52, 0.62, 1], roughness: 0.52 },
      textureId: floorTex,
    },
    'scene'
  );
  sceneMaterialMeta.set(wallMat, { baseColor: [0.46, 0.52, 0.62, 1], textureId: floorTex });

  const darkRoomWallMat = assets.createPreset(
    'dark-room-wall',
    'ultraRealism',
    {
      uniforms: { baseColor: [0.16, 0.17, 0.2, 1], roughness: 0.82, metallic: 0.08 },
      textureId: floorTex,
    },
    'scene'
  );
  sceneMaterialMeta.set(darkRoomWallMat, { baseColor: [0.16, 0.17, 0.2, 1], textureId: floorTex });

  const doorMat = assets.createPreset(
    'door-steel-wood',
    'ultraRealism',
    {
      uniforms: {
        baseColor: [0.58, 0.42, 0.3, 1],
        metallic: 0.32,
        roughness: 0.44,
        clearcoat: 0.4,
      },
      textureId: crateTex,
    },
    'scene'
  );
  sceneMaterialMeta.set(doorMat, { baseColor: [0.58, 0.42, 0.3, 1], textureId: crateTex });

  const rampMat = assets.createPreset(
    'ramp-toon',
    'ultraRealism',
    {
      uniforms: { baseColor: [0.76, 0.56, 0.38, 1], roughness: 0.45 },
      textureId: crateTex,
    },
    'scene'
  );
  sceneMaterialMeta.set(rampMat, { baseColor: [0.76, 0.56, 0.38, 1], textureId: crateTex });

  const crystalMatId = assets.createMaterial('showcase-crystal', crystalDesc, 'scene');
  sceneMaterialMeta.set(crystalMatId, { baseColor: [...crystalDesc.uniforms.baseColor] });

  propsDesc.textureId = crateTex;
  const propsMatId = assets.createMaterial('showcase-props', propsDesc, 'scene');
  sceneMaterialMeta.set(propsMatId, { baseColor: [0.92, 0.78, 0.62, 1], textureId: crateTex });

  const metalMatId = assets.createPreset(
    'steel-mat',
    'ultraRealism',
    { uniforms: { baseColor: [0.74, 0.78, 0.86, 1], metallic: 0.92, roughness: 0.22 } },
    'scene'
  );

  const buoyMatId = assets.createPreset(
    'buoy-mat',
    'ultraRealism',
    {
      uniforms: {
        baseColor: [0.98, 0.45, 0.18, 1],
        roughness: 0.28,
        clearcoat: 0.85,
      },
    },
    'scene'
  );

  // Arena Floor
  const floor = scene.createEntity();
  scene.setTransform(floor, { position: [0, -0.5, 0], immediate: true });
  scene.setCollider3D(floor, { kind: 'aabb', halfExtents: [28, 0.5, 28] });

  const floorVis = scene.createEntity();
  scene.setTransform(floorVis, { position: [0, 0, 0], immediate: true });
  scene.setMesh3D(floorVis, { meshId: floorMesh.meshId, materialId: floorMat, boundsRadius: 48 });

  const addStaticBox = (pos: Vec3Tuple, scale: Vec3Tuple, matId = wallMat) => {
    const e = scene.createEntity();
    scene.setTransform(e, { position: pos, scale, immediate: true });
    scene.setCollider3D(e, {
      kind: 'aabb',
      halfExtents: [scale[0] * 0.5, scale[1] * 0.5, scale[2] * 0.5],
    });
    scene.setMesh3D(e, {
      meshId: boxMesh.meshId,
      materialId: matId,
      boundsRadius: Math.hypot(scale[0], scale[1], scale[2]) * 0.6,
    });
    return e;
  };

  // Perimeter walls (48x48 arena)
  addStaticBox([0, 1.8, -23.5], [48, 3.6, 1.0]);
  addStaticBox([0, 1.8, 23.5], [48, 3.6, 1.0]);
  addStaticBox([-23.5, 1.8, 0], [1.0, 3.6, 48]);
  addStaticBox([23.5, 1.8, 0], [1.0, 3.6, 48]);

  // Center crystal pedestal + raised platforms + ramps + staircase
  addStaticBox([0, 0.45, -3], [2.4, 0.9, 2.4]);
  addStaticBox([8.0, 1.0, -3.5], [4.2, 2.0, 4.0]); // platform behind gentle ramp
  addStaticBox([-15.5, 1.5, -9.2], [4.4, 3.0, 4.0]); // platform behind steep ramp

  // Ramps (Triangle BVH colliders)
  const ramp1 = scene.createEntity();
  scene.setTransform(ramp1, { position: [8.0, 0, 2.0], immediate: true });
  scene.setMesh3D(ramp1, { meshId: rampGentleMesh.meshId, materialId: rampMat, boundsRadius: 6 });
  scene.addStaticMeshTriangles(ramp1, extractColliderTriangles(rampGentleGeom, [8.0, 0, 2.0]));

  const ramp2 = scene.createEntity();
  scene.setTransform(ramp2, { position: [-15.5, 0, -4.6], immediate: true });
  scene.setMesh3D(ramp2, { meshId: rampSteepMesh.meshId, materialId: rampMat, boundsRadius: 6 });
  scene.addStaticMeshTriangles(ramp2, extractColliderTriangles(rampSteepGeom, [-15.5, 0, -4.6]));

  // 5-step staircase for CharacterController auto-step
  for (let s = 0; s < 5; s++) {
    const h = (s + 1) * 0.3;
    addStaticBox([-5.2, h * 0.5, -6.5 - s * 0.9], [2.6, h, 0.9]);
  }

  // Moving platform (tests ground_support rider carry!)
  const platMat = assets.createPreset(
    'plat-mat',
    'cyberNeon',
    { uniforms: { baseColor: [0.18, 0.25, 0.4, 1], glowColor: [0.25, 0.9, 1.0] } },
    'scene'
  );
  const movingPlat = scene.createEntity();
  scene.setTransform(movingPlat, { position: [0, 0.35, -10.5], scale: [3.4, 0.4, 3.4], immediate: true });
  scene.setCollider3D(movingPlat, { kind: 'aabb', halfExtents: [1.7, 0.2, 1.7] });
  scene.setMesh3D(movingPlat, { meshId: boxMesh.meshId, materialId: platMat, boundsRadius: 3.0 });

  // Central faceted GLB gemstone crystal
  const crystalBytes = buildSampleCrystalGlb();
  const crystalHandle = assets.registerMesh('sample-crystal', bridge.parseGlb(crystalBytes), 'scene');
  const crystalEntity = scene.createEntity();
  scene.setTransform(crystalEntity, { position: [0, 2.7, -3], immediate: true });
  scene.setMesh3D(crystalEntity, {
    meshId: crystalHandle.meshId,
    materialId: crystalMatId,
    transparent: crystalDesc.transparent,
    boundsRadius: 3,
  });

  // 13 Shader Presets Showcase Gallery along the North wall
  SHADER_PRESET_NAMES.forEach((presetName, idx) => {
    const mId = assets.createPreset(`gallery-${presetName}`, presetName, {}, 'scene');
    const e = scene.createEntity();
    const x = -15 + idx * 2.5;
    scene.setTransform(e, { position: [x, 1.35, -19.0], scale: [1.15, 1.15, 1.15], immediate: true });
    scene.setCollider3D(e, { kind: 'aabb', halfExtents: [0.6, 0.6, 0.6] });
    scene.setMesh3D(e, {
      meshId: idx % 2 === 0 ? sphereMesh.meshId : boxMesh.meshId,
      materialId: mId,
      transparent: presetName === 'hologram' || presetName === 'crystalGlass',
      boundsRadius: 1.5,
    });
  });

  // Stackable crate pyramid + 4-cube vertical tower
  const crateRows = [3, 2, 1];
  crateRows.forEach((count, row) => {
    for (let col = 0; col < count; col++) {
      const x = 3.2 + (col - (count - 1) * 0.5) * 1.04;
      const y = 0.501 + row * 1.005;
      const c = scene.createEntity();
      scene.setTransform(c, { position: [x, y, -8.5], immediate: true });
      scene.setCollider3D(c, { kind: 'aabb', halfExtents: [0.5, 0.5, 0.5] });
      scene.setRigidBody(c, {
        dynamic: true,
        mass: 1.4,
        friction: 0.78,
        restitution: 0.12,
        linearDamping: 0.12,
        angularDamping: 0.35,
      });
      scene.setMesh3D(c, { meshId: boxMesh.meshId, materialId: propsMatId, boundsRadius: 1.2 });
    }
  });

  // Ball-Socket Wrecking Pendulum (Joint physics showcase!)
  addStaticBox([5.5, 4.4, -12.0], [2.4, 0.35, 0.6], wallMat);
  addStaticBox([4.5, 2.2, -12.0], [0.35, 4.4, 0.35], wallMat);
  addStaticBox([6.5, 2.2, -12.0], [0.35, 4.4, 0.35], wallMat);
  const anchorNode = scene.createEntity();
  scene.setTransform(anchorNode, { position: [5.5, 4.2, -12.0], immediate: true });
  scene.setCollider3D(anchorNode, { kind: 'sphere', radius: 0.15 });
  const wreckBall = scene.createEntity();
  scene.setTransform(wreckBall, { position: [7.6, 2.9, -12.0], scale: [1.3, 1.3, 1.3], immediate: true });
  scene.setCollider3D(wreckBall, { kind: 'sphere', radius: 0.7 });
  scene.setRigidBody(wreckBall, {
    dynamic: true,
    mass: 12.0,
    friction: 0.4,
    restitution: 0.6,
    linearDamping: 0.02,
    angularDamping: 0.05,
  });
  scene.setMesh3D(wreckBall, { meshId: sphereMesh.meshId, materialId: metalMatId, boundsRadius: 1.0 });
  scene.addBallSocketJoint(anchorNode, wreckBall, { anchorA: [0, 0, 0], anchorB: [0, 2.4, 0] });

  // ======================== ZONE: WATER POOL + ARCHIMEDES BUOYANCY ========================
  const waterCenter: Vec3Tuple = [14.5, 0, 3.0];
  const poolBottomMat = assets.createPreset(
    'pool-caustics',
    'waterCaustics',
    { uniforms: { baseColor: [0.16, 0.44, 0.58, 1], glowColor: [0.42, 0.92, 1.0] } },
    'scene'
  );
  // Caustic floor + 4 stone pool rim walls + step ramp in/out
  addStaticBox([waterCenter[0], 0.05, waterCenter[2]], [6.4, 0.1, 6.4], poolBottomMat);
  addStaticBox([waterCenter[0], 0.45, waterCenter[2] - 3.35], [7.1, 0.9, 0.45], wallMat);
  addStaticBox([waterCenter[0], 0.45, waterCenter[2] + 3.35], [7.1, 0.9, 0.45], wallMat);
  addStaticBox([waterCenter[0] + 3.35, 0.45, waterCenter[2]], [0.45, 0.9, 6.3], wallMat);
  addStaticBox([waterCenter[0] - 3.35, 0.45, waterCenter[2] - 1.7], [0.45, 0.9, 2.9], wallMat);
  addStaticBox([waterCenter[0] - 3.35, 0.45, waterCenter[2] + 1.7], [0.45, 0.9, 2.9], wallMat);
  // Wide entry step on west side of pool so player can walk right in & out
  addStaticBox([waterCenter[0] - 3.6, 0.22, waterCenter[2]], [0.9, 0.44, 1.9], wallMat);
  addStaticBox([waterCenter[0] - 2.9, 0.35, waterCenter[2]], [0.7, 0.7, 1.9], wallMat);

  const waterSurfaceMat = assets.createMaterial(
    'water-surface-mat',
    {
      blocks: ['pbrLighting', 'vertexWave', 'voronoiCaustics', 'glassRefract', 'fresnelGlow', 'distanceFog'],
      uniforms: {
        ...createPresetMaterial('waveSurface').uniforms,
        baseColor: [0.08, 0.56, 0.78, 0.62],
        glowColor: [0.45, 0.95, 1.0],
        roughness: 0.08,
        waveAmp: 0.06,
        waveFreq: 3.1,
        fresnelPower: 2.2,
      },
      transparent: true,
      doubleSided: true,
    },
    'scene-fx'
  );
  const waterSurface = scene.createEntity();
  scene.setTransform(waterSurface, { position: [waterCenter[0], 0.98, waterCenter[2]], immediate: true });
  scene.setMesh3D(waterSurface, {
    meshId: waterMesh.meshId,
    materialId: waterSurfaceMat,
    transparent: true,
    boundsRadius: 6,
  });

  scene.addWaterZone({
    center: [waterCenter[0], 0.52, waterCenter[2]],
    halfExtents: [3.1, 0.52, 3.1],
    density: 1.45,
    linearDrag: 2.8,
    angularDrag: 2.6,
    flow: [0.35, 0, 0.22],
  });

  // Buoyant crates + buoy sphere + heavy sinking steel sphere in pool
  const poolBodies: EntityId[] = [];
  for (let i = 0; i < 3; i++) {
    const c = scene.createEntity();
    scene.setTransform(c, {
      position: [waterCenter[0] - 1.2 + i * 1.15, 1.4, waterCenter[2] - 0.8 + (i % 2) * 1.6],
      scale: [0.75, 0.75, 0.75],
      immediate: true,
    });
    scene.setCollider3D(c, { kind: 'aabb', halfExtents: [0.375, 0.375, 0.375] });
    scene.setRigidBody(c, { dynamic: true, mass: 0.35, friction: 0.5, restitution: 0.2 });
    scene.setMesh3D(c, { meshId: boxMesh.meshId, materialId: propsMatId, boundsRadius: 0.9 });
    poolBodies.push(c);
  }
  const buoy = scene.createEntity();
  scene.setTransform(buoy, { position: [waterCenter[0] + 0.8, 1.5, waterCenter[2] + 0.6], scale: [0.8, 0.8, 0.8], immediate: true });
  scene.setCollider3D(buoy, { kind: 'sphere', radius: 0.44 });
  scene.setRigidBody(buoy, { dynamic: true, mass: 0.28, friction: 0.6, restitution: 0.5 });
  scene.setMesh3D(buoy, { meshId: sphereMesh.meshId, materialId: buoyMatId, boundsRadius: 0.8 });

  const sinker = scene.createEntity();
  scene.setTransform(sinker, { position: [waterCenter[0] - 0.6, 1.5, waterCenter[2] + 1.2], scale: [0.7, 0.7, 0.7], immediate: true });
  scene.setCollider3D(sinker, { kind: 'sphere', radius: 0.38 });
  scene.setRigidBody(sinker, { dynamic: true, mass: 12.0, friction: 0.6, restitution: 0.1 });
  scene.setMesh3D(sinker, { meshId: sphereMesh.meshId, materialId: metalMatId, boundsRadius: 0.7 });

  const splashEmitter = new ParticleEmitter(scene, {
    maxParticles: 48,
    lifetime: 0.7,
    gravity: -14,
    spread: [1.3, 1.2, 1.3],
    speedMin: 1.8,
    speedMax: 4.2,
    meshId: moteMesh.meshId,
    materialId: buoyMatId,
  });

  // ======================== ZONE: DARK ROOM (E-DOOR + SPOTLIGHT + DUST) ========================
  const roomC: Vec3Tuple = [-11.5, 0, 3.0]; // interior x: [-14.5..-8.5], z: [0.0..6.0], y: [0..3.8]
  // Back, North, South walls, Ceiling, Floor
  addStaticBox([roomC[0] - 3.2, 2.0, roomC[2]], [0.45, 4.0, 6.8], darkRoomWallMat);
  addStaticBox([roomC[0], 2.0, roomC[2] - 3.2], [6.4, 4.0, 0.45], darkRoomWallMat);
  addStaticBox([roomC[0], 2.0, roomC[2] + 3.2], [6.4, 4.0, 0.45], darkRoomWallMat);
  addStaticBox([roomC[0], 4.1, roomC[2]], [6.8, 0.35, 6.8], darkRoomWallMat);
  // East wall with clean 1.9m doorway gap centered at z = roomC[2] (3.0)
  addStaticBox([roomC[0] + 3.0, 2.0, roomC[2] - 2.05], [0.45, 4.0, 2.3], darkRoomWallMat);
  addStaticBox([roomC[0] + 3.0, 2.0, roomC[2] + 2.05], [0.45, 4.0, 2.3], darkRoomWallMat);
  addStaticBox([roomC[0] + 3.0, 3.35, roomC[2]], [0.45, 1.3, 1.85], darkRoomWallMat);

  // Small table + stacked wooden prop + warm wall panel inside room to cast dramatic SpotLight shadows!
  addStaticBox([roomC[0] - 0.8, 0.42, roomC[2] - 0.5], [1.5, 0.84, 1.1], propsMatId);
  addStaticBox([roomC[0] + 0.3, 0.28, roomC[2] + 1.2], [0.65, 0.56, 0.65], propsMatId);
  addStaticBox([roomC[0] - 0.8, 1.12, roomC[2] - 0.5], [0.46, 0.46, 0.46], propsMatId);

  // Glowing doorframe status bar above door outside
  const frameLedMat = assets.createPreset(
    'room-frame-led',
    'cyberNeon',
    { uniforms: { baseColor: [0.15, 0.95, 0.65, 1], glowColor: [0.2, 1.0, 0.7] } },
    'scene'
  );
  addStaticBox([roomC[0] + 2.75, 2.76, roomC[2]], [0.12, 0.1, 1.7], frameLedMat);

  // Hanging light fixture + emissive glowing lightbulb
  addStaticBox([roomC[0], 3.7, roomC[2]], [0.06, 0.6, 0.06], metalMatId);
  const lampShade = scene.createEntity();
  scene.setTransform(lampShade, { position: [roomC[0], 3.38, roomC[2]], scale: [0.75, 0.16, 0.75], immediate: true });
  scene.setMesh3D(lampShade, { meshId: cylMesh.meshId, materialId: metalMatId, boundsRadius: 0.6 });

  const bulbMat = assets.createPreset(
    'bulb-emissive',
    'cyberNeon',
    {
      uniforms: {
        baseColor: [1.0, 0.92, 0.72, 1],
        glowColor: [1.0, 0.78, 0.38],
      },
    },
    'scene'
  );
  const bulbEntity = scene.createEntity();
  scene.setTransform(bulbEntity, { position: [roomC[0], 3.22, roomC[2]], scale: [0.36, 0.36, 0.36], immediate: true });
  scene.setMesh3D(bulbEntity, { meshId: sphereMesh.meshId, materialId: bulbMat, boundsRadius: 0.4 });

  // Interactive Door hinged on North edge of doorway
  const hingePos: Vec3Tuple = [roomC[0] + 3.0, 1.35, roomC[2] - 0.92];
  const doorWidth = 1.82;
  const doorEntity = scene.createEntity();
  let doorOpen = false;
  let doorAngle = 0;
  let doorTarget = 0;

  const updateDoorTransform = (angle: number) => {
    // Under Y-rotation, offset [0, 0, +doorWidth*0.5] maps to [+sin*w/2, 0, +cos*w/2]
    const cx = hingePos[0] + Math.sin(angle) * (doorWidth * 0.5);
    const cz = hingePos[2] + Math.cos(angle) * (doorWidth * 0.5);
    scene.setTransform(doorEntity, {
      position: [cx, hingePos[1], cz],
      scale: [0.16, 2.7, doorWidth],
      rotation: quatFromEuler(0, angle, 0),
    });
  };
  scene.setCollider3D(doorEntity, { kind: 'aabb', halfExtents: [0.08, 1.35, doorWidth * 0.5] });
  scene.setMesh3D(doorEntity, { meshId: boxMesh.meshId, materialId: doorMat, boundsRadius: 2.0 });
  updateDoorTransform(0);
  scene.setTransform(doorEntity, {
    position: [hingePos[0], hingePos[1], hingePos[2] + doorWidth * 0.5],
    scale: [0.16, 2.7, doorWidth],
    rotation: quatFromEuler(0, 0, 0),
    immediate: true,
  });

  // Glowing golden dust particles inside the Dark Room (instanced in 1 draw call!)
  const dustMatId = assets.createPreset(
    'dust-mote-mat',
    'cyberNeon',
    {
      uniforms: {
        baseColor: [1.0, 0.9, 0.65, 1.0],
        glowColor: [1.0, 0.8, 0.42],
      },
    },
    'scene'
  );
  interface DustMote {
    entity: EntityId;
    bx: number;
    by: number;
    bz: number;
    phase: number;
    speed: number;
    scale: number;
  }
  const dustMotes: DustMote[] = [];
  for (let i = 0; i < 76; i++) {
    const bx = roomC[0] + (Math.random() - 0.5) * 4.8;
    const by = 0.45 + Math.random() * 2.75;
    const bz = roomC[2] + (Math.random() - 0.5) * 4.8;
    const sc = 0.65 + Math.random() * 1.15;
    const e = scene.createEntity();
    scene.setTransform(e, { position: [bx, by, bz], scale: [sc, sc, sc], immediate: true });
    scene.setMesh3D(e, { meshId: moteMesh.meshId, materialId: dustMatId, boundsRadius: 0.15 });
    dustMotes.push({
      entity: e,
      bx,
      by,
      bz,
      phase: Math.random() * Math.PI * 2,
      speed: 0.6 + Math.random() * 0.9,
      scale: sc,
    });
  }

  let roomLightOn = true;

  // Lights: SpotLight[0] INSIDE dark room casts real-time 1024px perspective shadows!
  scene.pointLights.length = 0;
  scene.spotLights.length = 0;
  scene.spotLights.push({
    position: [roomC[0], 3.16, roomC[2]],
    direction: [0.05, -0.99, 0.02],
    color: [1.0, 0.82, 0.48],
    intensity: 3.4,
    range: 15,
    innerConeDeg: 32,
    outerConeDeg: 68,
    castsShadow: true,
  });
  scene.pointLights.push(
    { position: [roomC[0], 2.95, roomC[2]], color: [1.0, 0.74, 0.38], intensity: 2.7, radius: 8.5 },
    { position: [0, 2.7, -3], color: [0.35, 0.85, 1.0], intensity: 2.1, radius: 10 },
    { position: [waterCenter[0], 2.1, waterCenter[2]], color: [0.35, 0.95, 1.0], intensity: 1.5, radius: 9 },
    { position: [4.5, 1.1, 5.5], color: [0.2, 1.0, 0.75], intensity: 1.4, radius: 5 }
  );

  // ======================== ZONE: FIXED JUMP PAD (SOLID BASE + TRIGGER TOP) ========================
  const padPos: Vec3Tuple = [4.5, 0, 5.5];
  const padMat = assets.createPreset(
    'jump-pad',
    'cyberNeon',
    { uniforms: { baseColor: [0.08, 0.35, 0.32, 1], glowColor: [0.18, 1.0, 0.72] } },
    'scene'
  );
  // Solid rubberized base platform (walk on it without sinking!)
  const padBase = addStaticBox([padPos[0], 0.14, padPos[2]], [2.5, 0.28, 2.5], padMat);
  // Subtle trim ring around it
  const padTriggerMat = assets.createPreset(
    'jump-pad-holo',
    'hologram',
    { uniforms: { glowColor: [0.2, 1.0, 0.75], baseColor: [0.1, 0.9, 0.65, 0.55] } },
    'scene-fx'
  );
  const jumpPadTrigger = scene.createEntity();
  scene.setTransform(jumpPadTrigger, { position: [padPos[0], 0.42, padPos[2]], scale: [2.2, 0.32, 2.2], immediate: true });
  scene.setCollider3D(jumpPadTrigger, { kind: 'aabb', halfExtents: [1.15, 0.36, 1.15] });
  scene.setTrigger(jumpPadTrigger, true);
  scene.setMesh3D(jumpPadTrigger, {
    meshId: boxMesh.meshId,
    materialId: padTriggerMat,
    transparent: true,
    boundsRadius: 2,
  });

  // ======================== ZONE: HARDWARE INSTANCING + WASM A* NAV BOT ========================
  const instZoneOrigin: Vec3Tuple = [-8.5, 0, -13.5];
  const instMat = assets.createPreset(
    'inst-wave-mat',
    'iridescent',
    { uniforms: { baseColor: [0.35, 0.72, 0.96, 1], metallic: 0.65, roughness: 0.2 } },
    'scene'
  );
  const instBlocks: Array<{ entity: EntityId; x: number; z: number; phase: number }> = [];
  for (let gx = 0; gx < 8; gx++) {
    for (let gz = 0; gz < 8; gz++) {
      const bx = instZoneOrigin[0] + (gx - 3.5) * 0.85;
      const bz = instZoneOrigin[2] + (gz - 3.5) * 0.85;
      const e = scene.createEntity();
      scene.setTransform(e, { position: [bx, 0.45, bz], scale: [0.58, 0.9, 0.58], immediate: true });
      scene.setMesh3D(e, { meshId: boxMesh.meshId, materialId: instMat, boundsRadius: 1.0 });
      instBlocks.push({ entity: e, x: bx, z: bz, phase: gx * 0.45 + gz * 0.45 });
    }
  }

  // Build 3D NavGrid around static obstacles and create an autonomous patrolling AI Bot!
  scene.buildNavGrid3D({
    originX: -20,
    originZ: -18,
    cellSize: 1.0,
    width: 40,
    height: 36,
    minY: 0.15,
    maxY: 3.0,
    agentRadius: 0.45,
  });

  const botWaypoints: Array<[number, number]> = [
    [-4.5, 9.5],
    [1.5, 9.5],
    [2.5, 2.0],
    [-4.5, -1.5],
    [-8.0, 5.5],
  ];
  let botWpIdx = 0;
  let botPath: Array<[number, number]> = [];
  let botPathIdx = 0;
  let botRepathTimer = 0;

  const botMat = assets.createPreset(
    'nav-bot-mat',
    'cyberNeon',
    { uniforms: { baseColor: [0.22, 0.26, 0.36, 1], glowColor: [0.35, 0.9, 1.0], roughness: 0.25 } },
    'scene'
  );
  const navBot = scene.createEntity();
  scene.setTransform(navBot, { position: [-4.5, 0.9, 9.5], scale: [0.75, 1.4, 0.75], immediate: true });
  scene.setCollider3D(navBot, { kind: 'capsule', radius: 0.36, halfHeight: 0.45 });
  scene.setRigidBody(navBot, {
    dynamic: true,
    mass: 2.0,
    gravityScale: 1,
    friction: 0,
    linearDamping: 0,
    lockRotation: true,
  });
  scene.setMesh3D(navBot, { meshId: cylMesh.meshId, materialId: botMat, boundsRadius: 1.2 });

  // ======================== PLAYER CAPSULE ========================
  const player = scene.createEntity();
  scene.setTransform(player, { position: [0, 1.3, 10.5], immediate: true });
  scene.setCollider3D(player, { kind: 'capsule', radius: 0.42, halfHeight: 0.55 });
  scene.setRigidBody(player, {
    dynamic: true,
    gravityScale: 1,
    friction: 0,
    linearDamping: 0,
    lockRotation: true,
  });
  scene.setCharacterController(player, { stepHeight: 0.5, maxSlopeDeg: 50 });

  // Bounce pad trigger + impulse with cooldown so rapid landing/walking works cleanly
  const bounceCooldowns = new Map<EntityId, number>();
  const bounceEntity = (other: EntityId) => {
    if (other === padBase || other === jumpPadTrigger || other === floor) return;
    if ((bounceCooldowns.get(other) ?? 0) > 0) return;
    bounceCooldowns.set(other, 0.22);
    const [vx, , vz] = scene.getVelocity(other);
    scene.setVelocity(other, vx, 14.8, vz);
    splashEmitter.emit(12, [padPos[0], 0.45, padPos[2]]);
    if (other === player) {
      scene.triggerShake(0.08, 0.14);
      playSfx(680, 0.14, 'sine', 0.14);
    } else {
      playSfx(520, 0.08, 'triangle', 0.09);
    }
  };

  scene.onTriggerEnter((ev) => {
    if (ev.entityA === jumpPadTrigger || ev.entityB === jumpPadTrigger) {
      const other = ev.entityA === jumpPadTrigger ? ev.entityB : ev.entityA;
      bounceEntity(other);
    }
  });

  // ======================== HOLOGRAPHIC TEXT PLAQUES ========================
  const signs = new HoloSignFactory(scene, assets, 'scene');
  const floatingSigns = [
    signs.createSign({
      position: [2.2, 1.55, -2.5],
      yaw: -0.35,
      badge: 'GLB + SHADERS',
      title: 'Центральный кристалл',
      subtitle: 'Встроенный .GLB парсер и 13 пресетов шейдеров в правой панели.',
      accent: '#38bdf8',
    }),
    signs.createSign({
      position: [6.8, 1.55, 6.2],
      yaw: -0.65,
      badge: 'TRIGGER + IMPULSE',
      title: 'Батут (Прыжковая зона)',
      subtitle: 'Твёрдая платформа + сенсор триггера запускают игрока вверх.',
      accent: '#34d399',
    }),
    signs.createSign({
      position: [10.4, 1.85, -0.4],
      yaw: -0.58,
      badge: 'ARCHIMEDES + CAUSTICS',
      title: 'Физика воды и волны',
      subtitle: 'Архимедова выталкивающая сила, течение, каустика дна и брызги.',
      accent: '#22d3ee',
    }),
    signs.createSign({
      position: [-6.8, 1.65, 5.4],
      yaw: 0.55,
      badge: 'SPOT SHADOWS + DUST',
      title: 'Тёмная комната [E]',
      subtitle: 'Нажми E у двери, войди под лампу [L]: реальные тени и пыль.',
      accent: '#fbbf24',
    }),
    signs.createSign({
      position: [-4.5, 1.7, -12.2],
      yaw: 0.42,
      badge: 'INSTANCING + A* NAV',
      title: 'Оптимизация (1 draw call)',
      subtitle: '64 анимированных куба одним draw call + WASM A* навигация бота.',
      accent: '#a78bfa',
    }),
    signs.createSign({
      position: [8.8, 1.75, -11.4],
      yaw: -0.42,
      badge: 'JOINTS + PBR',
      title: 'Физика, маятник и кубы',
      subtitle: 'Ball-socket шарнир, рампы, ступени, лифт и PGS стек кубов.',
      accent: '#fb7185',
    }),
    signs.createSign({
      position: [-7.2, 2.8, -17.5],
      yaw: 0.12,
      width: 4.8,
      height: 1.25,
      badge: 'MATERIAL GALLERY',
      title: 'Все 13 шейдерных материалов',
      subtitle: 'PBR · Toon · Hologram · Dissolve · Wave · Iridescent · Glass · Magma · Ultra',
      accent: '#c084fc',
      withPost: false,
    }),
  ];

  let wasPlayerInWater = false;
  let elapsed = 0;

  return {
    player,
    crystalEntity,
    crystalMatId,
    propsMatId,
    crateTexId: crateTex,

    getInteractPrompt() {
      const [px, , pz] = scene.getPosition(player);
      const distDoor = Math.hypot(px - (roomC[0] + 3.0), pz - roomC[2]);
      if (distDoor < 2.4) {
        return doorOpen ? '[E] Закрыть дверь' : '[E] Открыть дверь';
      }
      const inRoom =
        px >= roomC[0] - 3.0 &&
        px <= roomC[0] + 2.8 &&
        pz >= roomC[2] - 3.0 &&
        pz <= roomC[2] + 3.0;
      if (inRoom) {
        return roomLightOn ? '[E / L] Выключить лампочку' : '[E / L] Включить лампочку';
      }
      return null;
    },

    toggleRoomLight() {
      roomLightOn = !roomLightOn;
      assets.updateMaterial(bulbMat, {
        ...createPresetMaterial('cyberNeon', {
          uniforms: roomLightOn
            ? { baseColor: [1.0, 0.92, 0.72, 1], glowColor: [1.0, 0.78, 0.38] }
            : { baseColor: [0.18, 0.18, 0.22, 1], glowColor: [0.0, 0.0, 0.0] },
        }),
      });
      playSfx(roomLightOn ? 780 : 380, 0.06, 'triangle', 0.11);
    },

    tryInteract() {
      const [px, , pz] = scene.getPosition(player);
      const distDoor = Math.hypot(px - (roomC[0] + 3.0), pz - roomC[2]);
      if (distDoor < 2.4) {
        doorOpen = !doorOpen;
        doorTarget = doorOpen ? 1.55 : 0;
        playSfx(doorOpen ? 260 : 190, 0.12, 'sawtooth', 0.08);
        return;
      }
      const inRoom =
        px >= roomC[0] - 3.0 &&
        px <= roomC[0] + 2.8 &&
        pz >= roomC[2] - 3.0 &&
        pz <= roomC[2] + 3.0;
      if (inRoom) {
        this.toggleRoomLight();
      }
    },

    fixedUpdate(dt: number) {
      for (const [eid, rem] of bounceCooldowns) {
        if (rem <= dt) bounceCooldowns.delete(eid);
        else bounceCooldowns.set(eid, rem - dt);
      }

      // Check solid top pad proximity fallback for player (even walking softly onto pad)
      const [px, py, pz] = scene.getPosition(player);
      const onPadXZ = Math.abs(px - padPos[0]) < 1.25 && Math.abs(pz - padPos[2]) < 1.25;
      if (onPadXZ && py >= 0.9 && py <= 1.55) {
        const [, curVy] = scene.getVelocity(player);
        if (curVy <= 1.2) {
          bounceEntity(player);
        }
      }

      // Water buoyancy + swimming assist for player
      const inWaterXZ = Math.abs(px - waterCenter[0]) < 3.1 && Math.abs(pz - waterCenter[2]) < 3.1;
      const inWater = inWaterXZ && py < 1.65;
      if (inWater && !wasPlayerInWater) {
        splashEmitter.emit(16, [px, 1.0, pz]);
        playSfx(240, 0.14, 'sine', 0.12);
      }
      wasPlayerInWater = inWater;
      if (inWater) {
        const [, curVy] = scene.getVelocity(player);
        const sub = Math.max(0, Math.min(1, (1.45 - py) / 1.0));
        scene.applyImpulse(player, [0, sub * 32.0 * dt, 0]);
        if (curVy < -4.0) {
          const [vx, , vz] = scene.getVelocity(player);
          scene.setVelocity(player, vx, curVy * 0.88, vz);
        }
      }

      // Animate moving platform smoothly along Y (sinusoidal elevator)
      const platY = 0.35 + (Math.sin(elapsed * 1.1) * 0.5 + 0.5) * 2.2;
      scene.setTransform(movingPlat, { position: [0, platY, -10.5] });

      // Smoothly animate E-door swing & collider transform
      const diff = doorTarget - doorAngle;
      if (Math.abs(diff) > 0.002) {
        doorAngle += diff * Math.min(1, dt * 7.5);
        updateDoorTransform(doorAngle);
      }

      // AI Navigation Bot patrolling via WASM NavGrid3D A*
      botRepathTimer -= dt;
      const [bx, , bz] = scene.getPosition(navBot);
      const goal = botWaypoints[botWpIdx];
      if (Math.hypot(goal[0] - bx, goal[1] - bz) < 0.8) {
        botWpIdx = (botWpIdx + 1) % botWaypoints.length;
        botPath = [];
      }
      if (botPath.length === 0 || botRepathTimer <= 0) {
        botRepathTimer = 1.4;
        const nextGoal = botWaypoints[botWpIdx];
        botPath = scene.findNavPath([bx, bz], nextGoal, true);
        botPathIdx = botPath.length > 1 ? 1 : 0;
      }
      const targetPt = botPath[botPathIdx] ?? botWaypoints[botWpIdx];
      const dx = targetPt[0] - bx;
      const dz = targetPt[1] - bz;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.45 && botPathIdx + 1 < botPath.length) {
        botPathIdx++;
      }
      const [, bvy] = scene.getVelocity(navBot);
      if (dist > 0.05) {
        scene.setVelocity(navBot, (dx / dist) * 2.8, bvy, (dz / dist) * 2.8);
      } else {
        scene.setVelocity(navBot, 0, bvy, 0);
      }
    },

    update(dt: number, spinTime: number) {
      elapsed += dt;
      splashEmitter.update(dt);

      // Rotate central crystal around Y smoothly
      scene.setTransform(crystalEntity, {
        position: [0, 2.7 + Math.sin(spinTime * 2) * 0.22, -3],
        rotation: quatFromEuler(0, spinTime * 0.9, 0),
      });

      // Bob holo plaques subtly
      for (let i = 0; i < floatingSigns.length; i++) {
        const hs = floatingSigns[i];
        const pos = scene.getPosition(hs.panelEntity);
        scene.setTransform(hs.panelEntity, {
          position: [pos[0], hs.baseY + Math.sin(spinTime * 1.8 + i) * 0.04, pos[2]],
          rotation: quatFromEuler(Math.PI / 2, hs.yaw, 0),
        });
      }

      // Animate 64 instanced blocks (1 single GPU instanced draw call!)
      for (const blk of instBlocks) {
        const h = 0.55 + (Math.sin(spinTime * 2.6 + blk.phase) * 0.5 + 0.5) * 1.35;
        scene.setTransform(blk.entity, {
          position: [blk.x, h * 0.5, blk.z],
          scale: [0.58, h, 0.58],
        });
      }

      // Animate floating warm dust motes in Dark Room light cone
      for (const m of dustMotes) {
        const t = spinTime * m.speed + m.phase;
        const mx = m.bx + Math.sin(t * 0.7) * 0.28;
        const my = m.by + Math.cos(t * 0.55) * 0.24;
        const mz = m.bz + Math.cos(t * 0.65) * 0.28;
        const visScale = roomLightOn ? m.scale : m.scale * 0.35;
        scene.setTransform(m.entity, {
          position: [mx, my, mz],
          scale: [visScale, visScale, visScale],
        });
      }

      // Subtle warm filament flicker on Dark Room SpotLight & PointLight
      const flicker = roomLightOn
        ? 0.95 + 0.05 * Math.sin(spinTime * 11.3) * Math.cos(spinTime * 4.7)
        : 0.0;
      if (scene.spotLights.length > 0) {
        scene.spotLights[0].intensity = 3.4 * flicker;
      }
      if (scene.pointLights.length > 0) {
        scene.pointLights[0].intensity = 2.7 * flicker;
      }
    },
  };
}
