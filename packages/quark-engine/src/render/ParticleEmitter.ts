import type { Vec3Tuple } from '../math/Mat4';
import type { EntityId, Scene } from '../Scene';

export interface ParticleEmitterOptions {
  maxParticles?: number;
  lifetime?: number;
  gravity?: number;
  size?: [number, number];
  startColor?: [number, number, number, number];
  endColor?: [number, number, number, number];
  speedMin?: number;
  speedMax?: number;
  spread?: Vec3Tuple;
  textureId?: number;
  layer?: number;
  meshId?: number;
  materialId?: number;
}

/**
 * Fixed-capacity ring-pooled particle emitter (zero per-frame entity allocations).
 */
export class ParticleEmitter {
  private readonly scene: Scene;
  private readonly entities: EntityId[];
  private readonly age: Float32Array;
  private readonly maxAge: Float32Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly opts: Required<
    Pick<ParticleEmitterOptions, 'maxParticles' | 'lifetime' | 'gravity' | 'size' | 'startColor' | 'endColor' | 'speedMin' | 'speedMax' | 'spread' | 'layer'>
  > &
    Pick<ParticleEmitterOptions, 'textureId' | 'meshId' | 'materialId'>;

  private cursor = 0;

  constructor(scene: Scene, options: ParticleEmitterOptions = {}) {
    this.scene = scene;
    const maxParticles = Math.max(1, options.maxParticles ?? 64);
    this.opts = {
      maxParticles,
      lifetime: Math.max(0.05, options.lifetime ?? 1.2),
      gravity: options.gravity ?? -3.5,
      size: options.size ?? [0.22, 0.22],
      startColor: options.startColor ?? [1, 0.9, 0.65, 0.95],
      endColor: options.endColor ?? [0.8, 0.35, 0.15, 0],
      speedMin: options.speedMin ?? 0.6,
      speedMax: options.speedMax ?? 2.2,
      spread: options.spread ?? [1.0, 1.0, 1.0],
      layer: options.layer ?? 8,
      textureId: options.textureId,
      meshId: options.meshId,
      materialId: options.materialId,
    };

    this.entities = new Array<EntityId>(maxParticles);
    this.age = new Float32Array(maxParticles).fill(-1);
    this.maxAge = new Float32Array(maxParticles).fill(this.opts.lifetime);
    this.px = new Float32Array(maxParticles);
    this.py = new Float32Array(maxParticles);
    this.pz = new Float32Array(maxParticles);
    this.vx = new Float32Array(maxParticles);
    this.vy = new Float32Array(maxParticles);
    this.vz = new Float32Array(maxParticles);

    for (let i = 0; i < maxParticles; i++) {
      const e = scene.createEntity();
      scene.setTransform(e, { position: [0, -9999, 0], scale: [0, 0, 0], immediate: true });
      if (this.opts.meshId !== undefined && this.opts.materialId !== undefined) {
        scene.setMesh3D(e, {
          meshId: this.opts.meshId,
          materialId: this.opts.materialId,
          boundsRadius: 0.4,
        });
      }
      this.entities[i] = e;
    }
  }

  get activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.opts.maxParticles; i++) {
      if (this.age[i] >= 0) n++;
    }
    return n;
  }

  emit(count: number, origin: Vec3Tuple): void {
    const sp = this.opts.spread;
    for (let k = 0; k < count; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.opts.maxParticles;

      this.age[i] = 0;
      this.maxAge[i] = this.opts.lifetime * (0.75 + Math.random() * 0.5);
      this.px[i] = origin[0] + (Math.random() - 0.5) * 0.25 * sp[0];
      this.py[i] = origin[1] + (Math.random() - 0.5) * 0.25 * sp[1];
      this.pz[i] = origin[2] + (Math.random() - 0.5) * 0.25 * sp[2];

      let dx = (Math.random() * 2 - 1) * sp[0];
      let dy = (Math.random() * 0.8 + 0.2) * sp[1];
      let dz = (Math.random() * 2 - 1) * sp[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      const spd = this.opts.speedMin + Math.random() * (this.opts.speedMax - this.opts.speedMin);
      this.vx[i] = (dx / len) * spd;
      this.vy[i] = (dy / len) * spd;
      this.vz[i] = (dz / len) * spd;

      this.scene.setTransform(this.entities[i], {
        position: [this.px[i], this.py[i], this.pz[i]],
        scale: [1, 1, 1],
        immediate: true,
      });
      if (this.opts.meshId === undefined) {
        this.scene.setSprite2D(this.entities[i], {
          size: this.opts.size,
          color: this.opts.startColor,
          textureId: this.opts.textureId,
          layer: this.opts.layer,
        });
      }
    }
  }

  update(dt: number): void {
    const c0 = this.opts.startColor;
    const c1 = this.opts.endColor;
    for (let i = 0; i < this.opts.maxParticles; i++) {
      if (this.age[i] < 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.maxAge[i]) {
        this.age[i] = -1;
        this.scene.setTransform(this.entities[i], {
          position: [0, -9999, 0],
          scale: [0, 0, 0],
          immediate: true,
        });
        continue;
      }

      this.vy[i] += this.opts.gravity * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;

      const t = this.age[i] / this.maxAge[i];
      const sc = 1 - t * 0.65;
      this.scene.setTransform(this.entities[i], {
        position: [this.px[i], this.py[i], this.pz[i]],
        scale: [sc, sc, sc],
      });

      if (this.opts.meshId === undefined) {
        this.scene.setSprite2D(this.entities[i], {
          size: this.opts.size,
          color: [
            c0[0] + (c1[0] - c0[0]) * t,
            c0[1] + (c1[1] - c0[1]) * t,
            c0[2] + (c1[2] - c0[2]) * t,
            c0[3] + (c1[3] - c0[3]) * t,
          ],
          textureId: this.opts.textureId,
          layer: this.opts.layer,
        });
      }
    }
  }

  dispose(): void {
    for (const e of this.entities) {
      if (this.scene.isAlive(e)) {
        this.scene.destroyEntity(e);
      }
    }
    this.age.fill(-1);
  }
}
