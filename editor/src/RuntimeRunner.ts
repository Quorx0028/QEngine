import {
  createBoxGeometry,
  createPlaneGeometry,
  createPresetMaterial,
  createRampGeometry,
  createSphereGeometry,
  Engine,
  type EntityId,
  type LoadedMeshHandle,
  type MeshGeometry,
  quatFromEuler,
  type Vec3Tuple,
} from 'quark-engine';
import {
  base64ToUint8,
  type EditorObject,
  type EditorSceneDocument,
  evaluateObjectTrack,
} from './SceneDocument';

function createConeGeometry(radius = 0.6, height = 1.4, segments = 14): MeshGeometry {
  const verts: number[] = [];
  const inds: number[] = [];
  const tip: Vec3Tuple = [0, height * 0.5, 0];
  const baseY = -height * 0.5;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0: Vec3Tuple = [Math.cos(a0) * radius, baseY, Math.sin(a0) * radius];
    const p1: Vec3Tuple = [Math.cos(a1) * radius, baseY, Math.sin(a1) * radius];
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

export interface LiveObjectBinding {
  objId: string;
  entity: EntityId;
  materialId: number;
  meshHandle: LoadedMeshHandle;
}

export class SceneRuntimeBuilder {
  private readonly engine: Engine;
  private baseMeshes = new Map<string, LoadedMeshHandle>();
  private glbCache = new Map<string, LoadedMeshHandle>();
  readonly bindings = new Map<string, LiveObjectBinding>();
  readonly entityToObjectId = new Map<EntityId, string>();
  playerEntity: EntityId | null = null;
  private lightMarkerMat = 0;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  private ensureBaseMeshes(): void {
    if (this.baseMeshes.size > 0) return;
    const a = this.engine.assets;
    this.baseMeshes.set('box', a.registerMesh('ed-box', createBoxGeometry(0.5, 0.5, 0.5), 'global'));
    this.baseMeshes.set('sphere', a.registerMesh('ed-sphere', createSphereGeometry(0.5, 18, 24), 'global'));
    this.baseMeshes.set('plane', a.registerMesh('ed-plane', createPlaneGeometry(1, 1, 8), 'global'));
    this.baseMeshes.set('ramp', a.registerMesh('ed-ramp', createRampGeometry(1, 1, 1), 'global'));
    this.baseMeshes.set('cone', a.registerMesh('ed-cone', createConeGeometry(0.55, 1.2, 16), 'global'));
    this.baseMeshes.set('lightMarker', a.registerMesh('ed-light', createSphereGeometry(0.35, 10, 12), 'global'));
    this.lightMarkerMat = a.createPreset(
      'ed-light-mat',
      'hologram',
      { uniforms: { glowColor: [1, 0.9, 0.4], baseColor: [1, 0.95, 0.65, 0.85] } },
      'global'
    );
  }

  private makeGridTexture(): number {
    const existing = this.engine.assets.getTexture('ed-grid');
    if (existing) return existing;
    const size = 128;
    const px = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const edge = x < 3 || y < 3;
        const c = edge ? 190 : 244;
        const i = (y * size + x) * 4;
        px[i] = c;
        px[i + 1] = c + 2;
        px[i + 2] = Math.min(255, c + 6);
        px[i + 3] = 255;
      }
    }
    return this.engine.assets.createTexture('ed-grid', size, size, px, false, 'global');
  }

  async resolveGlb(obj: EditorObject): Promise<{ handle: LoadedMeshHandle; clipNames: string[] }> {
    this.ensureBaseMeshes();
    if (!obj.glbBase64) {
      return { handle: this.baseMeshes.get('box')!, clipNames: [] };
    }
    const cacheKey = `${obj.glbName ?? 'glb'}_${obj.glbBase64.length}_${obj.glbBase64.slice(0, 24)}`;
    let cached = this.glbCache.get(cacheKey);
    if (!cached) {
      const bytes = base64ToUint8(obj.glbBase64);
      cached = await this.engine.assets.loadGLB(bytes, {
        name: obj.glbName ?? obj.name,
        tag: 'glb',
        preset: obj.material.preset,
      });
      this.glbCache.set(cacheKey, cached);
    }
    return { handle: cached, clipNames: Object.keys(cached.clips) };
  }

  applyEnvironment(doc: EditorSceneDocument): void {
    const { scene } = this.engine;
    const env = doc.environment;
    scene.camera.mode = '3d';
    scene.skyTopColor = [...env.skyTop];
    scene.skyHorizonColor = [...env.skyHorizon];
    scene.fogColor = [...env.fogColor];
    scene.fogDensity = env.fogDensity;
    scene.light.direction = [...env.lightDir];
    scene.light.color = [...env.lightColor];
    scene.light.intensity = env.lightIntensity;
    scene.light.ambientColor = [...env.ambientColor];
    scene.shadowsEnabled = env.shadowsEnabled;
    scene.setPostProcessPreset(env.postProcess);
  }

  async rebuild(doc: EditorSceneDocument, playMode: boolean): Promise<void> {
    this.ensureBaseMeshes();
    const { scene, assets } = this.engine;
    scene.clear();
    assets.unloadTag('scene');
    this.bindings.clear();
    this.entityToObjectId.clear();
    this.playerEntity = null;

    scene.setGravity(0, playMode ? -22 : 0, 0);
    this.applyEnvironment(doc);

    const gridTex = this.makeGridTexture();

    for (const obj of doc.objects) {
      let meshHandle: LoadedMeshHandle;
      if (obj.meshKind === 'glb' && obj.glbBase64) {
        meshHandle = (await this.resolveGlb(obj)).handle;
      } else {
        meshHandle = this.baseMeshes.get(obj.meshKind) ?? this.baseMeshes.get('box')!;
      }

      const entity = scene.createEntity();
      const rot = quatFromEuler(
        (obj.rotationDeg[0] * Math.PI) / 180,
        (obj.rotationDeg[1] * Math.PI) / 180,
        (obj.rotationDeg[2] * Math.PI) / 180
      );
      scene.setTransform(entity, {
        position: obj.position,
        rotation: rot,
        scale: obj.scale,
        immediate: true,
      });

      const isMarker = obj.lightKind !== 'none' && obj.meshKind === 'lightMarker';
      let matId = this.lightMarkerMat;
      if (!isMarker) {
        matId = assets.createPreset(
          `mat_${obj.id}`,
          obj.material.preset,
          {
            textureId: obj.meshKind === 'plane' || obj.meshKind === 'box' ? gridTex : undefined,
            transparent: obj.material.transparent,
            doubleSided: obj.material.doubleSided,
            outlineWidth: obj.material.outlineWidth,
            uniforms: {
              baseColor: obj.material.baseColor,
              metallic: obj.material.metallic,
              roughness: obj.material.roughness,
            },
          },
          'scene'
        );
      }

      if (!(playMode && obj.lightKind !== 'none' && obj.meshKind === 'lightMarker')) {
        scene.setMesh3D(entity, {
          meshId: obj.meshKind === 'glb' ? meshHandle.meshId : meshHandle.meshId,
          materialId: obj.meshKind === 'glb' ? (meshHandle.materialIds[0] ?? matId) : matId,
          transparent: obj.material.transparent || isMarker,
          boundsRadius:
            Math.max(obj.scale[0], obj.scale[1], obj.scale[2]) * Math.max(meshHandle.boundsRadius, 1.0),
        });
      }

      if (playMode && obj.physics.enabled && obj.physics.colliderKind !== 'none') {
        if (obj.physics.colliderKind === 'sphere') {
          scene.setCollider3D(entity, { kind: 'sphere', radius: Math.max(...obj.scale) * 0.5 });
        } else if (obj.physics.colliderKind === 'capsule') {
          scene.setCollider3D(entity, {
            kind: 'capsule',
            radius: Math.max(obj.scale[0], obj.scale[2]) * 0.48,
            halfHeight: Math.max(0.2, obj.scale[1] * 0.35),
          });
        } else {
          const hy = obj.meshKind === 'plane' ? 0.25 : Math.max(0.05, obj.scale[1] * 0.5);
          scene.setCollider3D(entity, {
            kind: 'aabb',
            halfExtents: [obj.scale[0] * 0.5, hy, obj.scale[2] * 0.5],
          });
        }

        if (obj.physics.isTrigger) {
          scene.setTrigger(entity, true);
        } else if (obj.physics.dynamic) {
          scene.setRigidBody(entity, {
            dynamic: true,
            mass: obj.physics.mass,
            friction: obj.physics.friction,
            restitution: obj.physics.restitution,
            gravityScale: obj.physics.gravityScale,
            lockRotation: obj.physics.lockRotation || obj.physics.isCharacterController,
          });
          if (obj.physics.isCharacterController) {
            scene.setCharacterController(entity, { stepHeight: 0.48, maxSlopeDeg: 50 });
            this.playerEntity = entity;
          }
        }
      }

      if (obj.meshKind === 'glb' && meshHandle.skeletonId !== null) {
        const clipNames = Object.keys(meshHandle.clips);
        const clipName = obj.activeClip && meshHandle.clips[obj.activeClip] !== undefined
          ? obj.activeClip
          : clipNames[0];
        if (clipName) {
          scene.playAnimation(entity, meshHandle.skeletonId, meshHandle.clips[clipName], {
            speed: obj.animSpeed ?? 1,
            loop: obj.animLoop ?? true,
          });
        }
      }

      this.bindings.set(obj.id, { objId: obj.id, entity, materialId: matId, meshHandle });
      this.entityToObjectId.set(entity, obj.id);
    }

    this.syncLights(doc);
  }

  syncLights(doc: EditorSceneDocument): void {
    const { scene } = this.engine;
    scene.pointLights.length = 0;
    scene.spotLights.length = 0;
    for (const obj of doc.objects) {
      if (obj.lightKind === 'point' && scene.pointLights.length < 4) {
        scene.pointLights.push({
          position: [...obj.position],
          color: [...obj.light.color],
          intensity: obj.light.intensity,
          radius: obj.light.range,
        });
      } else if (obj.lightKind === 'spot' && scene.spotLights.length < 4) {
        const rx = (obj.rotationDeg[0] * Math.PI) / 180;
        const ry = (obj.rotationDeg[1] * Math.PI) / 180;
        const dx = -Math.sin(ry) * Math.cos(rx);
        const dy = Math.sin(rx);
        const dz = -Math.cos(ry) * Math.cos(rx);
        scene.spotLights.push({
          position: [...obj.position],
          direction: [dx, dy, dz],
          color: [...obj.light.color],
          intensity: obj.light.intensity,
          range: obj.light.range,
          innerConeDeg: obj.light.innerConeDeg,
          outerConeDeg: obj.light.outerConeDeg,
          castsShadow: obj.light.castsShadow,
        });
      }
    }
  }

  applyTimelineAt(doc: EditorSceneDocument, timeSec: number): void {
    const { scene } = this.engine;
    for (const obj of doc.objects) {
      if (obj.keyframes.length === 0) continue;
      const b = this.bindings.get(obj.id);
      if (!b) continue;
      const pose = evaluateObjectTrack(obj, timeSec, doc.timelineDuration, doc.timelineLoop);
      const rot = quatFromEuler(
        (pose.rotationDeg[0] * Math.PI) / 180,
        (pose.rotationDeg[1] * Math.PI) / 180,
        (pose.rotationDeg[2] * Math.PI) / 180
      );
      scene.setTransform(b.entity, {
        position: pose.position,
        rotation: rot,
        scale: pose.scale,
        immediate: true,
      });
    }
  }

  syncSingleObject(doc: EditorSceneDocument, obj: EditorObject): void {
    const b = this.bindings.get(obj.id);
    if (!b) return;
    const { scene, assets } = this.engine;
    const rot = quatFromEuler(
      (obj.rotationDeg[0] * Math.PI) / 180,
      (obj.rotationDeg[1] * Math.PI) / 180,
      (obj.rotationDeg[2] * Math.PI) / 180
    );
    scene.setTransform(b.entity, {
      position: obj.position,
      rotation: rot,
      scale: obj.scale,
      immediate: true,
    });
    if (obj.lightKind === 'none' && obj.meshKind !== 'glb') {
      const patch = createPresetMaterial(obj.material.preset, {
        textureId:
          obj.meshKind === 'plane' || obj.meshKind === 'box' ? this.makeGridTexture() : undefined,
        transparent: obj.material.transparent,
        doubleSided: obj.material.doubleSided,
        outlineWidth: obj.material.outlineWidth,
        uniforms: {
          baseColor: obj.material.baseColor,
          metallic: obj.material.metallic,
          roughness: obj.material.roughness,
        },
      });
      assets.updateMaterial(b.materialId, patch);
    }
    this.syncLights(doc);
  }
}
