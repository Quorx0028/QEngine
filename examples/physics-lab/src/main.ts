import {
  Engine,
  PHYSICS_MATERIAL_PRESETS,
  quatFromEuler,
  createBoxGeometry,
  createCylinderGeometry,
  createPlaneGeometry,
  createRampGeometry,
  createSphereGeometry,
  extractColliderTriangles,
  type EntityId,
  type QuatTuple,
  type RigidBodyOptions,
  type Vec3Tuple,
} from 'quark-engine';
import wasmUrl from '../../../packages/quark-engine/wasm/quark_core.wasm?url';

type PhysMatKey = 'wood' | 'stone' | 'steel' | 'ice' | 'rubber';

interface StationSpawn {
  label: string;
  pos: Vec3Tuple;
  yaw: number;
}

const STATIONS: Record<number, StationSpawn> = {
  1: { label: '1 · Толкание & Уступ', pos: [0, 1.0, 2.5], yaw: 0 },
  2: { label: '2 · Стены / Ступени / Рампы', pos: [-16, 1.0, 2.5], yaw: 0 },
  3: { label: '3 · Вес & Центр масс', pos: [16, 1.0, 2.5], yaw: 0 },
  4: { label: '4 · Двери / Шарниры / Ломкость', pos: [-16, 1.0, 18.0], yaw: Math.PI },
  5: { label: '5 · CCD Тир & Сон', pos: [16, 1.0, 18.0], yaw: Math.PI },
  6: { label: '6 · Вода & Плавучесть', pos: [0, 1.0, 10.5], yaw: Math.PI },
  7: { label: '7 · Формы & Запросы', pos: [0, 1.0, -14.5], yaw: 0 },
};

async function main() {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const statsBox = document.getElementById('stats-box')!;
  const chkDebug = document.getElementById('chk-debug') as HTMLInputElement;
  const selMat = document.getElementById('sel-mat') as HTMLSelectElement;
  const selTimescale = document.getElementById('sel-timescale') as HTMLSelectElement;
  const btnReset = document.getElementById('btn-reset')!;
  const stationBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.station-btn'));

  const wasmBytes = await fetch(wasmUrl).then((r) => r.arrayBuffer());
  const engine = await Engine.init({ canvas, wasmBytes });
  const { scene, assets, input } = engine;

  scene.postProcess = {
    ...scene.postProcess,
    bloomIntensity: 0.28,
    bloomThreshold: 1.05,
    ssao: 0.35,
    vignette: 0.14,
  };
  scene.shadowsEnabled = true;
  scene.debugPhysics = true;
  scene.light.direction = [0.55, 0.85, 0.42];
  scene.light.intensity = 1.55;
  scene.light.ambientColor = [0.24, 0.28, 0.36];
  scene.skyTopColor = [0.1, 0.24, 0.52];
  scene.skyHorizonColor = [0.46, 0.62, 0.82];
  scene.fogDensity = 0.004;

  // Materials
  const floorMat = assets.createPreset('lab-floor', 'ultraRealism', {
    blocks: ['pbrLighting', 'triplanarGrid', 'distanceFog'],
    uniforms: { baseColor: [0.68, 0.72, 0.78, 1], roughness: 0.55, metallic: 0.05 },
  });
  const wallMat = assets.createPreset('lab-wall', 'ultraRealism', {
    blocks: ['pbrLighting', 'triplanarGrid', 'distanceFog'],
    uniforms: { baseColor: [0.44, 0.48, 0.56, 1], roughness: 0.62, metallic: 0.1 },
  });
  const woodMat = assets.createPreset('lab-wood', 'ultraRealism', {
    uniforms: { baseColor: [0.74, 0.5, 0.26, 1], roughness: 0.68, metallic: 0.02 },
  });
  const stoneMat = assets.createPreset('lab-stone', 'ultraRealism', {
    uniforms: { baseColor: [0.52, 0.54, 0.58, 1], roughness: 0.78, metallic: 0.05 },
  });
  const steelMat = assets.createPreset('lab-steel', 'ultraRealism', {
    uniforms: { baseColor: [0.72, 0.77, 0.84, 1], roughness: 0.22, metallic: 0.88 },
  });
  const iceMat = assets.createPreset('lab-ice', 'crystalGlass', {
    transparent: true,
    uniforms: { baseColor: [0.62, 0.88, 1.0, 0.72], roughness: 0.06, glowColor: [0.7, 0.95, 1] },
  });
  const rubberMat = assets.createPreset('lab-rubber', 'ultraRealism', {
    uniforms: { baseColor: [0.9, 0.28, 0.36, 1], roughness: 0.45, metallic: 0.04 },
  });
  const waterSurfaceMat = assets.createPreset('lab-water-surf', 'waveSurface', {
    transparent: true,
    doubleSided: true,
    uniforms: {
      baseColor: [0.12, 0.55, 0.88, 0.62],
      glowColor: [0.42, 0.88, 1.0],
      roughness: 0.08,
      waveAmp: 0.09,
      waveFreq: 2.2,
    },
  });
  const waterFloorMat = assets.createPreset('lab-water-bed', 'waterCaustics', {
    uniforms: {
      baseColor: [0.16, 0.48, 0.68, 1],
      glowColor: [0.45, 0.95, 1.0],
      waveAmp: 0.0,
    },
  });
  const doorMat = assets.createPreset('lab-door', 'ultraRealism', {
    uniforms: { baseColor: [0.85, 0.62, 0.28, 1], roughness: 0.45 },
  });
  const neonMat = assets.createPreset('lab-neon', 'cyberNeon', {
    uniforms: { baseColor: [0.14, 0.2, 0.35, 1], glowColor: [0.2, 0.95, 0.75] },
  });

  const unitBoxMesh = assets.registerMesh('lab-box', createBoxGeometry(0.5, 0.5, 0.5)).meshId;
  const unitSphereMesh = assets.registerMesh('lab-sphere', createSphereGeometry(0.5, 16, 24)).meshId;
  const unitCylMesh = assets.registerMesh('lab-cyl', createCylinderGeometry(0.5, 0.5, 24)).meshId;

  function matIdForPreset(k: PhysMatKey): number {
    switch (k) {
      case 'stone': return stoneMat;
      case 'steel': return steelMat;
      case 'ice': return iceMat;
      case 'rubber': return rubberMat;
      default: return woodMat;
    }
  }

  const spawnDynamicIds: EntityId[] = [];

  function addBox(
    pos: Vec3Tuple,
    halfExtents: Vec3Tuple,
    matId: number,
    rb?: RigidBodyOptions,
    rot: QuatTuple = [0, 0, 0, 1],
    transparent = false
  ): EntityId {
    const e = scene.createEntity();
    const meshId = assets.registerMesh(
      `box-${halfExtents.join('x')}`,
      createBoxGeometry(halfExtents[0], halfExtents[1], halfExtents[2])
    ).meshId;
    scene.setTransform(e, { position: pos, rotation: rot, immediate: true });
    scene.setCollider3D(e, { kind: 'aabb', halfExtents });
    if (rb) {
      scene.setRigidBody(e, rb);
    }
    scene.setMesh3D(e, {
      meshId,
      materialId: matId,
      transparent,
      boundsRadius: Math.hypot(...halfExtents) + 0.1,
    });
    if (rb && rb.dynamic !== false) spawnDynamicIds.push(e);
    return e;
  }

  function addSphere(
    pos: Vec3Tuple,
    radius: number,
    matId: number,
    rb?: RigidBodyOptions,
    transparent = false
  ): EntityId {
    const e = scene.createEntity();
    scene.setTransform(e, { position: pos, scale: [radius * 2, radius * 2, radius * 2], immediate: true });
    scene.setCollider3D(e, { kind: 'sphere', radius });
    if (rb) scene.setRigidBody(e, rb);
    scene.setMesh3D(e, {
      meshId: unitSphereMesh,
      materialId: matId,
      transparent,
      boundsRadius: radius + 0.1,
    });
    if (rb && rb.dynamic !== false) spawnDynamicIds.push(e);
    return e;
  }

  function addCylinder(
    pos: Vec3Tuple,
    radius: number,
    halfHeight: number,
    matId: number,
    rb?: RigidBodyOptions,
    rot: QuatTuple = [0, 0, 0, 1]
  ): EntityId {
    const e = scene.createEntity();
    scene.setTransform(e, {
      position: pos,
      rotation: rot,
      scale: [radius * 2, halfHeight * 2, radius * 2],
      immediate: true,
    });
    scene.setCollider3D(e, { kind: 'cylinder', radius, halfHeight });
    if (rb) scene.setRigidBody(e, rb);
    scene.setMesh3D(e, {
      meshId: unitCylMesh,
      materialId: matId,
      boundsRadius: Math.hypot(radius, halfHeight) + 0.1,
    });
    if (rb && rb.dynamic !== false) spawnDynamicIds.push(e);
    return e;
  }

  let player: EntityId = 0;
  let yaw = 0;
  let pitch = -0.08;
  let wasGrounded = false;
  let activeStation = 1;
  let lastImpactImpulse = 0;
  let lastQueryInfo = '—';
  let spinningDoorJoint = 0;

  function buildWorld() {
    scene.clearWaterZones();
    spawnDynamicIds.length = 0;
    lastImpactImpulse = 0;

    // Ground Floor (leaving clean pool basin opening at z=13..23, x=-5..5? Or pool with recessed rim on floor!)
    addBox([0, -0.5, 0], [36, 0.5, 36], floorMat, { dynamic: false, friction: 0.78 });
    // Arena perimeter walls
    addBox([0, 2, -36], [36, 2.5, 0.5], wallMat, { dynamic: false });
    addBox([0, 2, 36], [36, 2.5, 0.5], wallMat, { dynamic: false });
    addBox([-36, 2, 0], [0.5, 2.5, 36], wallMat, { dynamic: false });
    addBox([36, 2, 0], [0.5, 2.5, 36], wallMat, { dynamic: false });

    // =========================================================================
    // STATION 1: Push vs Topple &Cliff Edge (Center x=0, z=-4..-10)
    // =========================================================================
    addBox([-2.4, 0.5, -5.5], [0.5, 0.5, 0.5], woodMat, { ...PHYSICS_MATERIAL_PRESETS.wood });
    addBox([0.0, 0.5, -5.5], [0.5, 0.5, 0.5], iceMat, { ...PHYSICS_MATERIAL_PRESETS.ice }, [0, 0, 0, 1], true);
    addBox([2.4, 0.5, -5.5], [0.5, 0.5, 0.5], rubberMat, { ...PHYSICS_MATERIAL_PRESETS.rubber });
    // Raised table ledge with wood cube ready to be shoved off edge to verify natural tip-over!
    addBox([5.0, 0.45, -6.5], [1.4, 0.45, 2.2], wallMat, { dynamic: false, friction: 0.7 });
    addBox([5.0, 1.4, -7.2], [0.5, 0.5, 0.5], woodMat, { ...PHYSICS_MATERIAL_PRESETS.wood });

    // =========================================================================
    // STATION 2: Anti-Climb Walls, Walkable Stairs, Low-Ceiling Trap, OBB Ramps (x=-16)
    // =========================================================================
    // 1.5m & 2.4m solid walls (must block walking & wall-jumping!)
    addBox([-20, 0.75, -5.0], [1.2, 0.75, 0.5], wallMat, { dynamic: false });
    addBox([-17, 1.2, -5.0], [1.2, 1.2, 0.5], wallMat, { dynamic: false });
    // 2 stacked 1x1 dynamic crates against wall
    addBox([-14.2, 0.5, -5.0], [0.5, 0.5, 0.5], woodMat, { ...PHYSICS_MATERIAL_PRESETS.wood });
    addBox([-14.2, 1.52, -5.0], [0.5, 0.5, 0.5], woodMat, { ...PHYSICS_MATERIAL_PRESETS.wood });
    // Walkable 0.35m staircase + un-steppable 0.72m high curb
    for (let s = 0; s < 5; s++) {
      addBox([-21.5, 0.175 + s * 0.35, -9.5 - s * 1.1], [1.3, 0.175, 0.65], stoneMat, { dynamic: false });
    }
    addBox([-18.2, 0.36, -9.5], [1.1, 0.36, 0.8], wallMat, { dynamic: false }); // 0.72m block (> stepHeight 0.5)
    // Low-ceiling step trap (0.35m step under 1.55m ceiling — headroom check must block!)
    addBox([-15.4, 0.175, -9.5], [1.1, 0.175, 1.2], wallMat, { dynamic: false });
    addBox([-15.4, 2.15, -9.5], [1.3, 0.25, 1.2], wallMat, { dynamic: false });
    // Walkable 22° rotated OBB ramp vs Steep 65° rotated OBB slope
    const qGentle = quatFromEuler(0.38, 0, 0); // ~21.8°
    addBox([-12.2, 0.85, -10.5], [1.4, 0.2, 3.0], wallMat, { dynamic: false }, qGentle);
    const qSteep = quatFromEuler(1.13, 0, 0); // ~65°
    addBox([-9.0, 1.7, -10.5], [1.3, 0.2, 2.4], rubberMat, { dynamic: false }, qSteep);
    // TriangleMesh seam-smoothed ramp
    const triRampGeom = createRampGeometry(2.6, 1.4, 4.0);
    const triRampMesh = assets.registerMesh('lab-tri-ramp', triRampGeom).meshId;
    const triEnt = scene.createEntity();
    const triOffset: Vec3Tuple = [-24.5, 0, -10.5];
    scene.setTransform(triEnt, { position: triOffset, immediate: true });
    scene.setMesh3D(triEnt, { meshId: triRampMesh, materialId: stoneMat, boundsRadius: 4 });
    scene.addStaticMeshTriangles(triEnt, extractColliderTriangles(triRampGeom, triOffset));

    // =========================================================================
    // STATION 3: Weight, Density & Low Center-of-Mass (Roly-Poly & Seesaw, x=+16)
    // =========================================================================
    addBox([13.0, 0.35, -5.5], [0.35, 0.35, 0.35], woodMat, { ...PHYSICS_MATERIAL_PRESETS.wood });
    addBox([15.2, 0.65, -5.5], [0.65, 0.65, 0.65], stoneMat, { ...PHYSICS_MATERIAL_PRESETS.stone });
    addBox([18.2, 0.8, -5.5], [0.8, 0.8, 0.8], steelMat, { ...PHYSICS_MATERIAL_PRESETS.steel });
    // "Roly-Poly" weighted crate with low centerOfMass: tilts & rights itself!
    addBox(
      [21.5, 0.6, -5.5],
      [0.5, 0.55, 0.5],
      neonMat,
      {
        dynamic: true,
        mass: 5.0,
        centerOfMass: [0, -0.45, 0],
        angularDamping: 0.8,
        friction: 0.75,
      },
      quatFromEuler(0, 0, 0.45)
    );
    // Seesaw beam on Hinge joint
    const fulcrum = addBox([16.0, 0.4, -10.5], [0.4, 0.4, 0.6], stoneMat, { dynamic: false });
    const plank = addBox([16.0, 0.95, -10.5], [3.2, 0.12, 0.9], woodMat, {
      dynamic: true,
      mass: 8.0,
      friction: 0.85,
    });
    scene.addHingeJoint(fulcrum, plank, {
      anchorA: [0, 0.55, 0],
      anchorB: [0, 0, 0],
      axis: [0, 0, 1],
      minAngle: -0.45,
      maxAngle: 0.45,
    });
    addBox([13.6, 1.6, -10.5], [0.4, 0.4, 0.4], woodMat, { ...PHYSICS_MATERIAL_PRESETS.wood });
    addBox([18.4, 1.8, -10.5], [0.45, 0.45, 0.45], steelMat, { ...PHYSICS_MATERIAL_PRESETS.steel });

    // =========================================================================
    // STATION 4: Hinged Swinging Door, Motorized Spinner, Springs, Prismatic Lift, Breakable Bridge (x=-16, z=+20)
    // =========================================================================
    // Frame post + hinged swinging door with 0.06m hinge clearance so corner never jams!
    const doorPost = addBox([-18.2, 1.25, 22.0], [0.22, 1.25, 0.22], stoneMat, { dynamic: false });
    const doorLeaf = addBox([-17.15, 1.25, 22.0], [0.75, 1.15, 0.09], doorMat, {
      dynamic: true,
      mass: 3.5,
      angularDamping: 0.9,
      friction: 0.3,
    });
    scene.addHingeJoint(doorPost, doorLeaf, {
      anchorA: [0.25, 0, 0],
      anchorB: [-0.8, 0, 0],
      axis: [0, 1, 0],
      minAngle: -1.65,
      maxAngle: 1.65,
    });

    // Motorized turnstile spinner
    const spinPost = addBox([-13.0, 1.0, 22.0], [0.2, 1.0, 0.2], stoneMat, { dynamic: false });
    const spinBar = addBox([-13.0, 1.2, 22.0], [1.4, 0.14, 0.14], steelMat, {
      dynamic: true,
      mass: 4.0,
      friction: 0.4,
    });
    spinningDoorJoint = scene.addHingeJoint(spinPost, spinBar, {
      anchorA: [0, 0.2, 0],
      anchorB: [0, 0, 0],
      axis: [0, 1, 0],
    });
    scene.setHingeMotor(spinningDoorJoint, 2.4, 18.0);

    // Prismatic sliding elevator platform + Spring pendulum
    const railAnchor = addBox([-22.0, 3.2, 22.0], [0.3, 0.3, 0.3], wallMat, { dynamic: false });
    const sliderBlock = addBox([-22.0, 1.5, 22.0], [0.7, 0.25, 0.7], neonMat, {
      dynamic: true,
      mass: 2.0,
      gravityScale: 0.25,
    });
    scene.addPrismaticJoint(railAnchor, sliderBlock, {
      anchorA: [0, -1.7, 0],
      anchorB: [0, 0, 0],
      axis: [0, 1, 0],
      minDist: -0.9,
      maxDist: 1.2,
    });

    // Breakable Fixed Joint target (shoot with LMB / F to snap it loose!)
    const breakAnchor = addBox([-15.5, 3.5, 25.5], [1.6, 0.25, 0.4], wallMat, { dynamic: false });
    const breakBlock = addBox([-15.5, 2.3, 25.5], [0.7, 0.7, 0.4], iceMat, {
      dynamic: true,
      mass: 2.0,
    }, [0, 0, 0, 1], true);
    const fixId = scene.addFixedJoint(breakAnchor, breakBlock, {
      anchorA: [0, -1.2, 0],
      anchorB: [0, 0, 0],
    });
    scene.setJointBreakForce(fixId, 180);

    // =========================================================================
    // STATION 5: Ultra-Thin CCD Shooting Wall & Sleeping Pyramid (x=+16, z=+20)
    // =========================================================================
    // 0.08m ultra-thin glass/steel walls (halfExtents = 0.04)
    addBox([18.5, 1.5, 24.0], [1.8, 1.5, 0.04], iceMat, { dynamic: false }, [0, 0, 0, 1], true);
    addBox([14.0, 1.5, 24.0], [1.8, 1.5, 0.04], steelMat, { dynamic: false });
    // 4-tier pyramid (10 cubes) to observe Island Sleeping!
    let rows = 4;
    for (let r = 0; r < rows; r++) {
      const cols = rows - r;
      for (let c = 0; c < cols; c++) {
        const px = 16.0 + (c - (cols - 1) * 0.5) * 1.05;
        const py = 0.5 + r * 1.01;
        addBox([px, py, 21.0], [0.5, 0.5, 0.5], woodMat, { ...PHYSICS_MATERIAL_PRESETS.wood });
      }
    }

    // =========================================================================
    // STATION 6: WATER POOL (Animated Wave Surface + Caustics + Archimedes Buoyancy, z=+14..+24)
    // =========================================================================
    // Pool curb walls
    addBox([0, 1.0, 14.2], [5.4, 1.0, 0.4], stoneMat, { dynamic: false });
    addBox([0, 1.0, 24.2], [5.4, 1.0, 0.4], stoneMat, { dynamic: false });
    addBox([-5.2, 1.0, 19.2], [0.4, 1.0, 5.4], stoneMat, { dynamic: false });
    addBox([5.2, 1.0, 19.2], [0.4, 1.0, 5.4], stoneMat, { dynamic: false });
    // Staircase into pool so player can walk right into the water!
    addBox([0, 0.35, 13.3], [1.8, 0.35, 0.55], stoneMat, { dynamic: false });
    addBox([0, 0.75, 13.85], [1.8, 0.75, 0.45], stoneMat, { dynamic: false });
    // Caustic pool bed plane
    const causticBed = scene.createEntity();
    scene.setTransform(causticBed, { position: [0, 0.03, 19.2], immediate: true });
    scene.setMesh3D(causticBed, {
      meshId: assets.registerMesh('pool-bed', createPlaneGeometry(9.6, 9.6, 4)).meshId,
      materialId: waterFloorMat,
      boundsRadius: 8,
    });
    // Translucent rippling wave surface visual (no solid collider)
    const waterVis = scene.createEntity();
    scene.setTransform(waterVis, { position: [0, 1.85, 19.2], immediate: true });
    scene.setMesh3D(waterVis, {
      meshId: assets.registerMesh('pool-surface', createPlaneGeometry(9.6, 9.6, 28)).meshId,
      materialId: waterSurfaceMat,
      transparent: true,
      boundsRadius: 8,
    });
    // Physical WaterZone volume (y=0..1.85)
    scene.addWaterZone({
      center: [0, 0.925, 19.2],
      halfExtents: [4.8, 0.925, 4.8],
      density: 1.0,
      linearDrag: 2.6,
      angularDrag: 2.2,
      flow: [0.25, 0, 0],
    });
    // Floating wood crate, bobbing cylinder barrels, sunken steel sphere!
    addBox([-2.2, 2.2, 19.0], [0.55, 0.45, 0.55], woodMat, { ...PHYSICS_MATERIAL_PRESETS.wood, density: 0.45 });
    addCylinder([0.2, 2.4, 18.8], 0.42, 0.55, woodMat, { ...PHYSICS_MATERIAL_PRESETS.wood, density: 0.52 }, quatFromEuler(0, 0, 1.57));
    addSphere([2.4, 2.5, 19.4], 0.48, steelMat, { ...PHYSICS_MATERIAL_PRESETS.steel }); // sinks!
    addSphere([1.1, 2.6, 20.8], 0.45, rubberMat, { ...PHYSICS_MATERIAL_PRESETS.rubber, density: 0.65 });

    // =========================================================================
    // STATION 7: Cylinder Barrels, Compound Shapes, ConvexHull & Spatial Queries (z=-20)
    // =========================================================================
    // Upright & rolling cylinders
    addCylinder([-3.0, 0.65, -21.0], 0.5, 0.65, steelMat, { ...PHYSICS_MATERIAL_PRESETS.steel });
    addCylinder([-1.2, 0.65, -21.0], 0.5, 0.65, woodMat, { ...PHYSICS_MATERIAL_PRESETS.wood }, quatFromEuler(1.57, 0, 0));
    // Compound L-beam collider
    const compE = scene.createEntity();
    scene.setTransform(compE, { position: [1.5, 0.8, -21.0], immediate: true });
    scene.setCollider3D(compE, {
      kind: 'compound',
      parts: [
        { position: [-0.55, 0, 0], shape: { kind: 'aabb', halfExtents: [0.55, 0.25, 0.5] } },
        { position: [0.55, 0.45, 0], shape: { kind: 'aabb', halfExtents: [0.25, 0.7, 0.5] } },
      ],
    });
    scene.setRigidBody(compE, { ...PHYSICS_MATERIAL_PRESETS.stone });
    scene.setMesh3D(compE, { meshId: unitBoxMesh, materialId: neonMat, boundsRadius: 1.5 });
    spawnDynamicIds.push(compE);

    // ConvexHull octahedral crystal block
    const hullE = scene.createEntity();
    scene.setTransform(hullE, { position: [4.2, 1.0, -21.0], immediate: true });
    scene.setCollider3D(hullE, {
      kind: 'convexHull',
      points: [
        [0, 0.9, 0],
        [0, -0.9, 0],
        [0.7, 0, 0],
        [-0.7, 0, 0],
        [0, 0, 0.7],
        [0, 0, -0.7],
      ],
    });
    scene.setRigidBody(hullE, { ...PHYSICS_MATERIAL_PRESETS.stone });
    scene.setMesh3D(hullE, { meshId: unitSphereMesh, materialId: iceMat, transparent: true, boundsRadius: 1.2 });
    spawnDynamicIds.push(hullE);

    // Player Capsule + CharacterController
    player = scene.createEntity();
    const s = STATIONS[activeStation];
    yaw = s.yaw;
    scene.setTransform(player, { position: s.pos, immediate: true });
    scene.setCollider3D(player, { kind: 'capsule', radius: 0.42, halfHeight: 0.55 });
    scene.setRigidBody(player, {
      dynamic: true,
      mass: 70.0,
      friction: 0.4,
      restitution: 0.0,
      lockRotation: true,
      linearDamping: 0.05,
    });
    scene.setCharacterController(player, {
      stepHeight: 0.5,
      maxSlopeDeg: 50,
      pushStrength: 0.9,
      maxPushMass: 35,
      groundSnap: 0.14,
      antiTipPush: true,
    });
  }

  buildWorld();

  scene.onPhysicsEvent((ev) => {
    if (ev.impulse > 0.1) {
      lastImpactImpulse = ev.impulse;
    }
  });

  function teleportStation(n: number) {
    const s = STATIONS[n];
    if (!s) return;
    activeStation = n;
    yaw = s.yaw;
    pitch = -0.08;
    scene.setTransform(player, { position: s.pos, immediate: true });
    scene.setVelocity(player, 0, 0, 0);
    stationBtns.forEach((b) => b.classList.toggle('active', Number(b.dataset.station) === n));
  }

  stationBtns.forEach((btn) => {
    btn.onclick = () => teleportStation(Number(btn.dataset.station));
  });
  chkDebug.onchange = () => {
    scene.debugPhysics = chkDebug.checked;
  };
  selTimescale.onchange = () => {
    engine.timeScale = Number(selTimescale.value);
  };
  btnReset.onclick = () => buildWorld();

  canvas.addEventListener('click', () => {
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock();
    } else {
      fireCcdBullet();
    }
  });

  function spawnInFront(kind: 'box' | 'sphere' | 'cylinder', speed = 2.0, ccd = false) {
    const key = selMat.value as PhysMatKey;
    const preset = PHYSICS_MATERIAL_PRESETS[key];
    const [px, py, pz] = scene.getPosition(player);
    const dx = -Math.sin(yaw) * Math.cos(pitch);
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * Math.cos(pitch);
    const pos: Vec3Tuple = [px + dx * 1.7, py + 0.55 + dy * 1.2, pz + dz * 1.7];
    let ent: EntityId;
    if (kind === 'box') {
      ent = addBox(pos, [0.45, 0.45, 0.45], matIdForPreset(key), { ...preset, ccd }, [0, 0, 0, 1], key === 'ice');
    } else if (kind === 'sphere') {
      ent = addSphere(pos, ccd ? 0.18 : 0.42, matIdForPreset(key), { ...preset, ccd, restitution: ccd ? 0.45 : preset.restitution }, key === 'ice');
    } else {
      ent = addCylinder(pos, 0.4, 0.5, matIdForPreset(key), { ...preset, ccd });
    }
    scene.setVelocity(ent, dx * speed, dy * speed, dz * speed);
  }

  function fireCcdBullet() {
    spawnInFront('sphere', 140.0, true);
  }

  engine.onFixedUpdate(() => {
    const fX = -Math.sin(yaw);
    const fZ = -Math.cos(yaw);
    const rX = Math.cos(yaw);
    const rZ = -Math.sin(yaw);

    let mF = 0;
    let mR = 0;
    if (input.isKeyDown('KeyW') || input.isKeyDown('ArrowUp')) mF += 1;
    if (input.isKeyDown('KeyS') || input.isKeyDown('ArrowDown')) mF -= 1;
    if (input.isKeyDown('KeyD') || input.isKeyDown('ArrowRight')) mR += 1;
    if (input.isKeyDown('KeyA') || input.isKeyDown('ArrowLeft')) mR -= 1;

    const len = Math.hypot(mF, mR) || 1;
    const speed = input.isKeyDown('ShiftLeft') ? 11.0 : 6.5;
    const vx = ((fX * mF + rX * mR) / len) * (mF || mR ? speed : 0);
    const vz = ((fZ * mF + rZ * mR) / len) * (mF || mR ? speed : 0);

    const [, curVy] = scene.getVelocity(player);
    const grounded = scene.isGrounded(player);
    let nextVy = curVy;
    if (input.isKeyDown('Space') && grounded && wasGrounded) {
      nextVy = 9.0;
    }
    wasGrounded = grounded;
    scene.setVelocity(player, vx, nextVy, vz);
  });

  engine.onUpdate(() => {
    if (input.wasKeyPressed('F3')) {
      scene.debugPhysics = !scene.debugPhysics;
      chkDebug.checked = scene.debugPhysics;
    }
    if (input.wasKeyPressed('Backquote')) buildWorld();
    if (input.wasKeyPressed('KeyE')) spawnInFront('box');
    if (input.wasKeyPressed('KeyQ')) spawnInFront('sphere');
    if (input.wasKeyPressed('KeyC')) spawnInFront('cylinder');
    if (input.wasKeyPressed('KeyF')) fireCcdBullet();

    for (let k = 1; k <= 7; k++) {
      if (input.wasKeyPressed(`Digit${k}`)) teleportStation(k);
    }

    if (input.wasKeyPressed('KeyX')) {
      const [px, py, pz] = scene.getPosition(player);
      const targets = scene.overlapSphere([px, py, pz], 6.0);
      let pushed = 0;
      for (const t of targets) {
        if (t === player) continue;
        const [tx, ty, tz] = scene.getPosition(t);
        const dx = tx - px;
        const dy = Math.max(0.4, ty - py + 0.8);
        const dz = tz - pz;
        const d = Math.hypot(dx, dy, dz) || 1;
        scene.applyImpulse(t, [(dx / d) * 18, (dy / d) * 14, (dz / d) * 18]);
        pushed++;
      }
      lastQueryInfo = `OverlapSphere(r=6m): ${pushed} тел`;
    }

    if (input.wasKeyPressed('KeyZ')) {
      const [px, py, pz] = scene.getPosition(player);
      const dx = -Math.sin(yaw) * Math.cos(pitch);
      const dy = Math.sin(pitch);
      const dz = -Math.cos(yaw) * Math.cos(pitch);
      const hit = scene.sweepBox([px, py + 0.65, pz], [0.35, 0.35, 0.35], [dx, dy, dz], 25, [0, 0, 0, 1], 0xffffffff, player);
      lastQueryInfo = hit
        ? `SweepBox: ent=${hit.entity}, d=${hit.distance.toFixed(2)}m`
        : 'SweepBox: мимо';
    }

    const [mdx, mdy] = input.consumeMouseDelta();
    yaw -= mdx * 0.0024;
    pitch = Math.max(-1.25, Math.min(1.1, pitch - mdy * 0.0022));

    const [px, py, pz] = scene.getPosition(player);
    const eyeY = py + 0.65;
    scene.camera.position = [px, eyeY, pz];
    scene.camera.target = [
      px - Math.sin(yaw) * Math.cos(pitch),
      eyeY + Math.sin(pitch),
      pz - Math.cos(yaw) * Math.cos(pitch),
    ];

    const v = scene.getVelocity(player);
    const spd = Math.hypot(v[0], v[2]).toFixed(1);
    let sleepingCount = 0;
    for (const id of spawnDynamicIds) {
      if (scene.isSleeping(id)) sleepingCount++;
    }
    const g = engine.getStats();
    statsBox.innerHTML =
      `FPS: <b>${g.fps}</b> (${g.frameMs}ms) · Entities: ${g.entities}<br>` +
      `Pos: [${px.toFixed(2)}, ${py.toFixed(2)}, ${pz.toFixed(2)}] · Speed: ${spd} m/s<br>` +
      `Grounded: <b style="color:${scene.isGrounded(player) ? '#6bff95' : '#ff8c7a'}">${scene.isGrounded(player)}</b> · ` +
      `Sleeping: ${sleepingCount}/${spawnDynamicIds.length}<br>` +
      `Last Impulse: ${lastImpactImpulse.toFixed(1)} · Query: ${lastQueryInfo}`;
  });

  engine.start();
}

main().catch((err) => {
  const box = document.getElementById('stats-box');
  if (box) box.textContent = `Ошибка запуска: ${err?.message ?? err}`;
  console.error(err);
});
