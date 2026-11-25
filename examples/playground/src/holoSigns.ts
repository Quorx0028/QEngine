import {
  createBoxGeometry,
  createPlaneGeometry,
  createPresetMaterial,
  quatFromEuler,
  type AssetManager,
  type EntityId,
  type Scene,
  type Vec3Tuple,
} from 'quark-engine';

export interface HoloSignOptions {
  position: Vec3Tuple;
  yaw?: number;
  width?: number;
  height?: number;
  title: string;
  subtitle: string;
  accent?: string;
  badge?: string;
  withPost?: boolean;
}

export interface HoloSignHandle {
  panelEntity: EntityId;
  baseY: number;
  yaw: number;
}

function hexToRgbTuple(hex: string): Vec3Tuple {
  const clean = hex.replace('#', '');
  const n = parseInt(clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean, 16);
  if (Number.isNaN(n)) return [0.3, 0.9, 1.0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function renderSignPixels(
  title: string,
  subtitle: string,
  accent: string,
  badge?: string
): { width: number; height: number; pixels: Uint8Array } {
  const width = 512;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, width, height);

  // Translucent dark cyber glass backing
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, 'rgba(8, 22, 42, 0.88)');
  grad.addColorStop(1, 'rgba(6, 14, 28, 0.82)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(10, 10, width - 20, height - 20, 22);
  ctx.fill();

  // Glowing frame border + corner brackets
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(12, 12, width - 24, height - 24, 20);
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.fillRect(28, 10, 120, 5);
  ctx.fillRect(width - 148, height - 15, 120, 5);

  // Top badge pill
  if (badge) {
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.roundRect(30, 28, Math.min(260, badge.length * 12 + 32), 34, 10);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = accent;
    ctx.font = '700 18px ui-sans-serif, system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(badge, 44, 46);
  }

  // Title text
  ctx.fillStyle = '#f8fafc';
  ctx.font = '800 32px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(title, 30, badge ? 76 : 44, width - 60);

  // Wrapped subtitle lines
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '500 22px ui-sans-serif, system-ui, -apple-system, sans-serif';
  const words = subtitle.split(' ');
  let line = '';
  let y = badge ? 124 : 96;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > width - 60) {
      ctx.fillText(line, 30, y);
      line = w;
      y += 28;
      if (y > height - 42) break;
    } else {
      line = test;
    }
  }
  if (line && y <= height - 30) {
    ctx.fillText(line, 30, y);
  }

  const img = ctx.getImageData(0, 0, width, height);
  return { width, height, pixels: new Uint8Array(img.data) };
}

export class HoloSignFactory {
  private readonly boxMeshId: number;
  private readonly postMatId: number;
  private counter = 0;

  constructor(
    private readonly scene: Scene,
    private readonly assets: AssetManager,
    tag = 'scene-holo'
  ) {
    this.boxMeshId = (
      this.assets.getMesh('box') ?? this.assets.registerMesh('holo-post-box', createBoxGeometry(0.5, 0.5, 0.5), tag)
    ).meshId;
    this.postMatId = this.assets.createPreset(
      'holo-post-mat',
      'ultraRealism',
      {
        uniforms: {
          baseColor: [0.16, 0.2, 0.28, 1],
          metallic: 0.85,
          roughness: 0.25,
          glowColor: [0.2, 0.88, 1.0],
        },
      },
      tag
    );
  }

  createSign(opts: HoloSignOptions): HoloSignHandle {
    const idx = this.counter++;
    const w = opts.width ?? 2.6;
    const h = opts.height ?? 1.3;
    const yaw = opts.yaw ?? 0;
    const accent = opts.accent ?? '#38bdf8';
    const rgb = hexToRgbTuple(accent);

    const { width, height, pixels } = renderSignPixels(opts.title, opts.subtitle, accent, opts.badge);
    const texId = this.assets.createTexture(`holo-sign-tex-${idx}`, width, height, pixels, false, 'scene-holo');
    const planeMesh = this.assets.registerMesh(`holo-sign-plane-${idx}`, createPlaneGeometry(w, h, 1), 'scene-holo');

    const matId = this.assets.createMaterial(
      `holo-sign-mat-${idx}`,
      {
        ...createPresetMaterial('hologram', {
          uniforms: {
            baseColor: [1, 1, 1, 0.94],
            glowColor: rgb,
            fresnelPower: 2.2,
          },
          textureId: texId,
          transparent: true,
          doubleSided: true,
        }),
      },
      'scene-holo'
    );

    const panelEntity = this.scene.createEntity();
    this.scene.setTransform(panelEntity, {
      position: opts.position,
      rotation: quatFromEuler(Math.PI / 2, yaw, 0),
      immediate: true,
    });
    this.scene.setMesh3D(panelEntity, {
      meshId: planeMesh.meshId,
      materialId: matId,
      transparent: true,
      boundsRadius: Math.hypot(w, h) * 0.55,
    });

    if (opts.withPost !== false && opts.position[1] > 0.7) {
      const postHeight = opts.position[1] - h * 0.5 - 0.08;
      if (postHeight > 0.15) {
        const post = this.scene.createEntity();
        this.scene.setTransform(post, {
          position: [opts.position[0], postHeight * 0.5, opts.position[2]],
          scale: [0.1, postHeight, 0.1],
          rotation: quatFromEuler(0, yaw, 0),
          immediate: true,
        });
        this.scene.setCollider3D(post, {
          kind: 'aabb',
          halfExtents: [0.06, postHeight * 0.5, 0.06],
        });
        this.scene.setMesh3D(post, {
          meshId: this.boxMeshId,
          materialId: this.postMatId,
          boundsRadius: 0.9,
        });
      }
    }

    return { panelEntity, baseY: opts.position[1], yaw };
  }
}
