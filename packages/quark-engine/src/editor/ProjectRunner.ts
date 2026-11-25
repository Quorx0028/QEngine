import type { Engine } from '../Engine';
import { quatFromEuler, type Vec3Tuple } from '../math/Mat4';
import type { EntityId } from '../Scene';
import { ShaderGraph } from '../render/ShaderGraph';
import { createBoxGeometry, createCylinderGeometry, createSphereGeometry } from '../render/Primitives';
import { parseColor } from '../builders/MaterialBuilder';
import { createWorldBuilder, WorldBuilder } from '../builders/WorldBuilder';
import { generateProceduralTexturePixels, loadImageDataUrlTexture } from './ProceduralTextures';
import { BlueprintRuntime } from './BlueprintRuntime';
import type { EditorEntityDef, EditorMaterialDef, QuarkProjectDoc } from './ProjectSchema';

export interface ProjectRunnerCallbacks {
  onShowBanner?: (title: string, subtitle: string, color: string) => void;
  onUpdateHudCounter?: (label: string, value: string | number | boolean) => void;
  onNodeExecuted?: (nodeId: string) => void;
}

export class ProjectRunner {
  readonly engine: Engine;
  readonly doc: QuarkProjectDoc;
  readonly mode: 'edit' | 'play';
  readonly docToEid = new Map<string, EntityId>();
  readonly eidToDoc = new Map<EntityId, string>();
  readonly docToMatId = new Map<string, number>();

  private readonly world: WorldBuilder;
  private readonly triggerPairs = new Map<EntityId, string>();
  private readonly lightRefs = new Map<string, { kind: 'point' | 'spot'; index: number }>();
  private readonly runtimeEuler = new Map<string, Vec3Tuple>();
  private playerEid: EntityId | null = null;
  private playerYaw = 0;
  private playerPitch = -0.08;
  private wasGrounded = true;
  private weatherAcc = 0;
  private unsubTriggerEnter: (() => void) | null = null;
  private unsubTriggerExit: (() => void) | null = null;
  private unsubPhysics: (() => void) | null = null;
  private blueprints: BlueprintRuntime | null = null;
  private disposed = false;

  private constructor(engine: Engine, doc: QuarkProjectDoc, mode: 'edit' | 'play') {
    this.engine = engine;
    this.doc = doc;
    this.mode = mode;
    this.world = createWorldBuilder(engine.scene, engine.assets, 'project');
  }

  static async mount(
    engine: Engine,
    doc: QuarkProjectDoc,
    mode: 'edit' | 'play',
    callbacks: ProjectRunnerCallbacks = {}
  ): Promise<ProjectRunner> {
    const runner = new ProjectRunner(engine, doc, mode);
    await runner.build(callbacks);
    return runner;
  }

  getPlayerEntity(): EntityId | null {
    return this.playerEid;
  }

  getSelectableIds(): Set<EntityId> {
    return new Set(this.eidToDoc.keys());
  }

  private async build(callbacks: ProjectRunnerCallbacks): Promise<void> {
    const { scene, assets, audio } = this.engine;
    assets.unloadTag('project');
    scene.clear();

    const env = this.doc.environment;
    scene.skyTopColor = [...env.skyTop];
    scene.skyHorizonColor = [...env.skyHorizon];
    scene.fogColor = [...env.fogColor];
    scene.fogDensity = env.fogDensity;
    scene.light.direction = [...env.lightDir];
    scene.light.color = [...env.lightColor];
    scene.light.ambientColor = [...env.ambientColor];
    scene.postProcess = { ...env.postProcess };
    this.engine.setQuality(env.quality);
    scene.shadowsEnabled = env.shadowsEnabled;
    scene.setWeather(env.weather);
    scene.setCloudStyle(env.cloudStyle);

    // 1. Build Materials + Procedural / Custom Textures
    for (const m of this.doc.materials) {
      await this.registerMaterial(m);
    }

    // 2. Build Entities
    const boxMeshId = assets.hasBackend ? assets.registerMesh('__ed_box__', createBoxGeometry(0.5, 0.5, 0.5), 'project').meshId : 1;
    const sphereMeshId = assets.hasBackend ? assets.registerMesh('__ed_sphere__', createSphereGeometry(0.5, 20, 28), 'project').meshId : 2;
    const cylMeshId = assets.hasBackend ? assets.registerMesh('__ed_cyl__', createCylinderGeometry(0.5, 0.5, 20), 'project').meshId : 3;

    for (const def of this.doc.entities) {
      await this.spawnEntity(def, boxMeshId, sphereMeshId, cylMeshId);
    }

    // 3. Apply Welds (fixed joints) in play mode
    if (this.mode === 'play') {
      for (const w of this.doc.welds) {
        const ea = this.docToEid.get(w.entityA);
        const eb = this.docToEid.get(w.entityB);
        if (ea !== undefined && eb !== undefined && scene.isAlive(ea) && scene.isAlive(eb)) {
          const pa = scene.getPosition(ea);
          const pb = scene.getPosition(eb);
          const dist = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
          scene.addDistanceJoint(ea, eb, { restLength: Math.max(0.05, dist), stiffness: 1.0 });
        }
      }
    }

    // 4. Spawn Player + Blueprints in Play mode
    if (this.mode === 'play') {
      if (this.doc.player.enabled) {
        this.playerEid = scene.createEntity();
        scene.setTransform(this.playerEid, { position: [...this.doc.player.spawnPos], immediate: true });
        scene.setCollider3D(this.playerEid, { kind: 'capsule', radius: 0.42, halfHeight: 0.72 });
        scene.setRigidBody(this.playerEid, {
          dynamic: true,
          gravityScale: 1,
          friction: 0,
          linearDamping: 0,
          lockRotation: true,
        });
        scene.setCharacterController(this.playerEid, { stepHeight: 0.5, maxSlopeDeg: 52 });
        this.playerYaw = 0;
        this.playerPitch = -0.06;
      }

      this.blueprints = new BlueprintRuntime(this.doc.blueprints, {
        scene,
        assets,
        audio,
        getPlayerEntity: () => this.playerEid,
        resolveEntityId: (docId) => this.docToEid.get(docId) ?? null,
        resolveEntityMaterialId: (docId) => {
          const def = this.doc.entities.find((e) => e.id === docId);
          return def ? (this.docToMatId.get(def.materialId) ?? null) : null;
        },
        resolveLightIndex: (docId) => this.lightRefs.get(docId) ?? null,
        getEntityEulerDeg: (docId) => this.runtimeEuler.get(docId) ?? [0, 0, 0],
        setEntityEulerDeg: (docId, euler) => this.runtimeEuler.set(docId, [...euler]),
        setEntityStaticLocked: (docId, locked) => {
          const eid = this.docToEid.get(docId);
          const def = this.doc.entities.find((e) => e.id === docId);
          if (eid !== undefined && def && scene.isAlive(eid)) {
            scene.setRigidBody(eid, {
              dynamic: !locked,
              mass: locked ? 0 : Math.max(0.2, def.physics.mass || 1),
              friction: def.physics.friction,
              restitution: def.physics.restitution,
            });
          }
        },
        onShowBanner: callbacks.onShowBanner,
        onUpdateHudCounter: callbacks.onUpdateHudCounter,
        onNodeExecuted: callbacks.onNodeExecuted,
      });

      this.unsubTriggerEnter = scene.onTriggerEnter((ev) => {
        const docA = this.triggerPairs.get(ev.entityA);
        const docB = this.triggerPairs.get(ev.entityB);
        if (docA) this.blueprints?.onTriggerEnter(docA, ev.entityB);
        if (docB) this.blueprints?.onTriggerEnter(docB, ev.entityA);
      });
      this.unsubTriggerExit = scene.onTriggerExit((ev) => {
        const docA = this.triggerPairs.get(ev.entityA);
        const docB = this.triggerPairs.get(ev.entityB);
        if (docA) this.blueprints?.onTriggerExit(docA, ev.entityB);
        if (docB) this.blueprints?.onTriggerExit(docB, ev.entityA);
      });
      this.unsubPhysics = scene.onPhysicsEvent((ev) => {
        if (ev.kind !== 1) return;
        const docA = this.eidToDoc.get(ev.entityA);
        const docB = this.eidToDoc.get(ev.entityB);
        if (docA) this.blueprints?.onCollision(docA, ev.impulse);
        if (docB) this.blueprints?.onCollision(docB, ev.impulse);
      });

      this.blueprints.fireStart();
    }
  }

  private async registerMaterial(m: EditorMaterialDef): Promise<number> {
    const { assets } = this.engine;
    let texId: number | undefined;
    if (assets.hasBackend) {
      if (m.textureKind === 'custom' && m.customImageDataUrl) {
        texId = await loadImageDataUrlTexture(assets, `tex_${m.id}`, m.customImageDataUrl, 'project');
      } else if (m.textureKind !== 'none' && m.textureKind !== 'custom') {
        const pixels = generateProceduralTexturePixels(m.textureKind, 128);
        texId = assets.createTexture(`tex_${m.id}`, 128, 128, pixels, false, 'project');
      }
    }

    const sg = new ShaderGraph();
    for (const blk of m.blocks) sg.add(blk);
    sg.setUniforms(m.uniforms);
    sg.setTransparent(Boolean(m.transparent));
    sg.setDoubleSided(Boolean(m.doubleSided));
    if (m.outlineWidth && m.outlineWidth > 0) {
      sg.setOutline(m.outlineWidth, m.outlineColor ?? [0.06, 0.05, 0.1]);
    }
    if (m.customVertexSnippet) sg.withCustomVertex(m.customVertexSnippet);
    if (m.customFragmentSnippet) sg.withCustomFragment(m.customFragmentSnippet);
    const desc = sg.compile();
    if (texId !== undefined) desc.textureId = texId;
    const matId = assets.hasBackend ? assets.createMaterial(`mat_${m.id}`, desc, 'project') : 1;
    this.docToMatId.set(m.id, matId);
    return matId;
  }

  private async spawnEntity(
    def: EditorEntityDef,
    boxMeshId: number,
    sphereMeshId: number,
    cylMeshId: number
  ): Promise<void> {
    const { scene, assets } = this.engine;
    const matId = this.docToMatId.get(def.materialId) ?? Array.from(this.docToMatId.values())[0] ?? 1;
    const rotRad: Vec3Tuple = [
      (def.rotationDeg[0] * Math.PI) / 180,
      (def.rotationDeg[1] * Math.PI) / 180,
      (def.rotationDeg[2] * Math.PI) / 180,
    ];
    const quat = quatFromEuler(rotRad[0], rotRad[1], rotRad[2]);
    // In Edit mode everything behaves as static/frozen so rooms & props never fall while constructing!
    const isDynamic = this.mode === 'play' && def.physics.mode === 'dynamic' && !def.physics.isTrigger;
    this.runtimeEuler.set(def.id, [...def.rotationDeg]);

    if (def.kind === 'room') {
      const rc = def.roomConfig ?? {};
      const doors = (rc.doors ?? ['south']).map((side) => ({ side, noLeaf: Boolean(rc.doorNoLeaf) }));
      const room = this.world.room({
        center: def.position,
        size: def.size,
        doors,
        windows: rc.windows ?? [],
        roof: rc.roof ?? true,
        floor: rc.floor ?? true,
        wallMaterial: matId,
        light: rc.lightColor ? { color: rc.lightColor, godRay: Boolean(rc.godRay) } : false,
      });
      if (room.entities.length > 0) {
        this.docToEid.set(def.id, room.entities[0]);
        for (const re of room.entities) this.eidToDoc.set(re, def.id);
      }
      return;
    }

    if (def.kind === 'stairs') {
      const halfZ = def.size[2] * 0.5;
      const entities = this.world.stairs({
        from: [def.position[0], def.position[1], def.position[2] + halfZ],
        to: [def.position[0], def.position[1] + def.size[1], def.position[2] - halfZ],
        width: def.size[0],
        material: matId,
      });
      if (entities.length > 0) {
        this.docToEid.set(def.id, entities[0]);
        for (const se of entities) this.eidToDoc.set(se, def.id);
      }
      return;
    }

    if (def.kind === 'pool') {
      const pool = this.world.pool({
        center: def.position,
        size: [def.size[0], def.size[1], def.size[2]],
        glassSides: ['south'],
        waterPreset: 'realistic',
      });
      this.docToEid.set(def.id, pool.waterSurface);
      for (const pe of pool.entities) this.eidToDoc.set(pe, def.id);
      return;
    }

    if (def.kind === 'ramp') {
      const e = this.world.ramp({
        pos: def.position,
        size: def.size,
        yaw: rotRad[1],
        material: matId,
      });
      this.docToEid.set(def.id, e);
      this.eidToDoc.set(e, def.id);
      return;
    }

    if (def.kind === 'breakable') {
      const br = this.world.breakable({ pos: def.position, size: def.size, material: matId });
      this.docToEid.set(def.id, br.entity);
      this.eidToDoc.set(br.entity, def.id);
      return;
    }

    if (def.kind === 'pointLight' || def.kind === 'spotLight') {
      const lc = def.lightConfig ?? { color: '#ffcf70', intensity: 8, range: 14, enabled: true };
      const rgba = parseColor(lc.color);
      const col: Vec3Tuple = [rgba[0], rgba[1], rgba[2]];
      if (def.kind === 'pointLight') {
        const idx = scene.pointLights.length;
        if (idx < 4) {
          scene.pointLights.push({
            position: [...def.position],
            color: col,
            intensity: lc.enabled === false ? 0 : lc.intensity,
            radius: lc.range,
          });
          this.lightRefs.set(def.id, { kind: 'point', index: idx });
        }
      } else {
        const idx = scene.spotLights.length;
        if (idx < 4) {
          scene.spotLights.push({
            position: [...def.position],
            direction: [0, -1, 0],
            color: col,
            intensity: lc.enabled === false ? 0 : lc.intensity,
            range: lc.range,
            innerConeDeg: lc.innerDeg ?? 22,
            outerConeDeg: lc.outerDeg ?? 42,
            castsShadow: idx === 0,
          });
          this.lightRefs.set(def.id, { kind: 'spot', index: idx });
        }
      }
      // Small visual light helper orb in edit mode so lights can be selected/dragged with Gizmo!
      const helper = scene.createEntity();
      scene.setTransform(helper, { position: def.position, rotation: quat, scale: [0.4, 0.4, 0.4], immediate: true });
      scene.setCollider3D(helper, { kind: 'sphere', radius: 0.28 });
      scene.setTrigger(helper, true);
      if (this.mode === 'edit' && assets.hasBackend) {
        scene.setMesh3D(helper, { meshId: sphereMeshId, materialId: matId, boundsRadius: 0.5 });
      }
      this.docToEid.set(def.id, helper);
      this.eidToDoc.set(helper, def.id);
      return;
    }

    if (def.kind === 'glb' && def.glbDataBase64 && assets.hasBackend) {
      const raw = Uint8Array.from(atob(def.glbDataBase64), (c) => c.charCodeAt(0));
      const loaded = await assets.loadGLB(raw, { name: `glb_${def.id}`, tag: 'project', scene, autoColliders: false });
      const e = scene.createEntity();
      scene.setTransform(e, { position: def.position, rotation: quat, scale: def.scale, immediate: true });
      const hx = Math.max(0.2, ((loaded.boundsMax[0] - loaded.boundsMin[0]) * 0.5) * def.scale[0]);
      const hy = Math.max(0.2, ((loaded.boundsMax[1] - loaded.boundsMin[1]) * 0.5) * def.scale[1]);
      const hz = Math.max(0.2, ((loaded.boundsMax[2] - loaded.boundsMin[2]) * 0.5) * def.scale[2]);
      scene.setCollider3D(e, { kind: 'aabb', halfExtents: [hx, hy, hz] });
      scene.setRigidBody(e, {
        dynamic: isDynamic,
        mass: def.physics.mass || 2,
        friction: def.physics.friction,
        restitution: def.physics.restitution,
      });
      scene.setMesh3D(e, { meshId: loaded.meshId, materialId: loaded.materialIds[0] ?? matId, boundsRadius: loaded.boundsRadius });
      this.docToEid.set(def.id, e);
      this.eidToDoc.set(e, def.id);
      return;
    }

    // Standard primitives: box, sphere, cylinder, trigger
    const e = scene.createEntity();
    const effScale: Vec3Tuple = [
      def.size[0] * def.scale[0],
      def.size[1] * def.scale[1],
      def.size[2] * def.scale[2],
    ];
    if (def.kind === 'sphere') {
      const r = (def.radius ?? 0.5) * Math.max(def.scale[0], def.scale[1], def.scale[2]);
      scene.setTransform(e, { position: def.position, rotation: quat, scale: [r * 2, r * 2, r * 2], immediate: true });
      scene.setCollider3D(e, { kind: 'sphere', radius: r });
      if (assets.hasBackend) scene.setMesh3D(e, { meshId: sphereMeshId, materialId: matId, boundsRadius: r * 1.15 });
    } else if (def.kind === 'cylinder') {
      const r = (def.radius ?? 0.5) * Math.max(def.scale[0], def.scale[2]);
      const h = (def.height ?? def.size[1]) * def.scale[1];
      scene.setTransform(e, { position: def.position, rotation: quat, scale: [r * 2, h, r * 2], immediate: true });
      scene.setCollider3D(e, { kind: 'cylinder', radius: r, halfHeight: h * 0.5 });
      if (assets.hasBackend) scene.setMesh3D(e, { meshId: cylMeshId, materialId: matId, boundsRadius: Math.hypot(r, h * 0.5) });
    } else {
      scene.setTransform(e, { position: def.position, rotation: quat, scale: effScale, immediate: true });
      if (def.physics.mode !== 'none' || def.kind === 'trigger' || this.mode === 'edit') {
        scene.setCollider3D(e, { kind: 'aabb', halfExtents: [effScale[0] * 0.5, effScale[1] * 0.5, effScale[2] * 0.5] });
      }
      if (assets.hasBackend) {
        const isTrig = def.kind === 'trigger' || Boolean(def.physics.isTrigger);
        scene.setMesh3D(e, {
          meshId: boxMeshId,
          materialId: matId,
          transparent: isTrig,
          boundsRadius: Math.hypot(effScale[0] * 0.5, effScale[1] * 0.5, effScale[2] * 0.5) + 0.1,
        });
      }
    }

    if (def.kind === 'trigger' || def.physics.isTrigger) {
      scene.setTrigger(e, true);
      this.triggerPairs.set(e, def.id);
    } else if (def.physics.mode !== 'none') {
      scene.setRigidBody(e, {
        dynamic: isDynamic,
        mass: isDynamic ? Math.max(0.1, def.physics.mass) : 0,
        friction: def.physics.friction,
        restitution: def.physics.restitution,
        gravityScale: def.physics.gravityScale ?? 1,
      });
    }

    this.docToEid.set(def.id, e);
    this.eidToDoc.set(e, def.id);
  }

  /** Updates live transform & physics for a single entity in Edit mode without rebuilding the whole scene. */
  syncEntityTransformInEdit(def: EditorEntityDef): void {
    const eid = this.docToEid.get(def.id);
    if (eid === undefined || !this.engine.scene.isAlive(eid)) return;
    if (def.kind === 'pointLight' || def.kind === 'spotLight') {
      const lref = this.lightRefs.get(def.id);
      if (lref) {
        if (lref.kind === 'point' && this.engine.scene.pointLights[lref.index]) {
          this.engine.scene.pointLights[lref.index].position = [...def.position];
        } else if (lref.kind === 'spot' && this.engine.scene.spotLights[lref.index]) {
          this.engine.scene.spotLights[lref.index].position = [...def.position];
        }
      }
    }
    const quat = quatFromEuler(
      (def.rotationDeg[0] * Math.PI) / 180,
      (def.rotationDeg[1] * Math.PI) / 180,
      (def.rotationDeg[2] * Math.PI) / 180
    );
    const curXf = this.engine.scene.getTransform(eid);
    const nextScale: Vec3Tuple =
      def.kind === 'box' || def.kind === 'trigger'
        ? [def.size[0] * def.scale[0], def.size[1] * def.scale[1], def.size[2] * def.scale[2]]
        : curXf.scale;
    this.engine.scene.setTransform(eid, { position: def.position, rotation: quat, scale: nextScale, immediate: true });
    this.engine.scene.setVelocity(eid, 0, 0, 0);
  }

  fixedUpdate(dt: number): void {
    if (this.disposed || this.mode !== 'play') return;
    this.world.update(dt);
    if (!this.playerEid || !this.engine.scene.isAlive(this.playerEid)) return;
    const { input, scene } = this.engine;
    const fx = -Math.sin(this.playerYaw);
    const fz = -Math.cos(this.playerYaw);
    const rx = Math.cos(this.playerYaw);
    const rz = -Math.sin(this.playerYaw);
    let mf = 0;
    let mr = 0;
    if (input.isKeyDown('KeyW') || input.isKeyDown('ArrowUp')) mf += 1;
    if (input.isKeyDown('KeyS') || input.isKeyDown('ArrowDown')) mf -= 1;
    if (input.isKeyDown('KeyD') || input.isKeyDown('ArrowRight')) mr += 1;
    if (input.isKeyDown('KeyA') || input.isKeyDown('ArrowLeft')) mr -= 1;
    const len = Math.hypot(mf, mr) || 1;
    const spd = input.isKeyDown('ShiftLeft') ? this.doc.player.sprintSpeed : this.doc.player.moveSpeed;
    const vx = ((fx * mf + rx * mr) / len) * (mf !== 0 || mr !== 0 ? spd : 0);
    const vz = ((fz * mf + rz * mr) / len) * (mf !== 0 || mr !== 0 ? spd : 0);
    const [, curVy] = scene.getVelocity(this.playerEid);
    const grounded = scene.isGrounded(this.playerEid);
    let nextVy = curVy;
    if (input.isKeyDown('Space') && grounded && this.wasGrounded) {
      nextVy = this.doc.player.jumpSpeed;
    }
    this.wasGrounded = grounded;
    scene.setVelocity(this.playerEid, vx, nextVy, vz);
  }

  update(dt: number): void {
    if (this.disposed) return;
    const { scene, input } = this.engine;

    if (this.mode === 'play') {
      const [dx, dy] = input.consumeMouseDelta();
      this.playerYaw -= dx * 0.0024;
      this.playerPitch = Math.max(-1.25, Math.min(1.1, this.playerPitch - dy * 0.0022));
      if (this.playerEid !== null && scene.isAlive(this.playerEid)) {
        const [px, py, pz] = scene.getPosition(this.playerEid);
        const eyeY = py + 0.65;
        scene.camera.position = [px, eyeY, pz];
        scene.camera.target = [
          px - Math.sin(this.playerYaw) * Math.cos(this.playerPitch),
          eyeY + Math.sin(this.playerPitch),
          pz - Math.cos(this.playerYaw) * Math.cos(this.playerPitch),
        ];
        if (input.wasKeyPressed('KeyE')) {
          this.world.tryInteract([px, py, pz]);
        }
      }
      for (const k of ['KeyE', 'KeyF', 'KeyQ', 'Space', 'KeyR', 'Digit1', 'Digit2', 'Digit3']) {
        if (input.wasKeyPressed(k)) this.blueprints?.onKey(k);
      }
      this.blueprints?.update(dt);
    }

    const weather = scene.weather.type;
    if (weather !== 'clear') {
      this.weatherAcc += dt;
      const interval = weather === 'downpour' ? 0.025 : weather === 'rain' ? 0.035 : 0.045;
      if (this.weatherAcc >= interval) {
        this.weatherAcc = 0;
        const [cx, , cz] = scene.camera.target;
        const baseCount = weather === 'downpour' ? 48 : weather === 'rain' ? 24 : 18;
        const count = Math.max(4, Math.round(baseCount * scene.renderQuality.particleScale));
        scene.emitVfx(weather, [cx, 12.5, cz], count, 0.03);
      }
    }
  }

  handlePlayClick(): void {
    if (this.mode !== 'play') return;
    const { scene } = this.engine;
    const [ox, oy, oz] = scene.camera.position;
    const [tx, ty, tz] = scene.camera.target;
    const vx = tx - ox;
    const vy = ty - oy;
    const vz = tz - oz;
    const len = Math.hypot(vx, vy, vz) || 1;
    const hit = scene.raycast3D([ox + (vx / len) * 0.6, oy + (vy / len) * 0.6, oz + (vz / len) * 0.6], [vx / len, vy / len, vz / len], 45);
    if (hit && hit.entity !== this.playerEid) {
      const docId = this.eidToDoc.get(hit.entity);
      if (docId) {
        this.blueprints?.onRaycastClick(docId);
      }
      this.world.handleRayHit(hit.entity, hit.point);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubTriggerEnter?.();
    this.unsubTriggerExit?.();
    this.unsubPhysics?.();
    this.blueprints?.dispose();
    this.engine.assets.unloadTag('project');
    this.engine.scene.clear();
  }
}
