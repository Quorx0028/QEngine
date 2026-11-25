import type { Vec3Tuple } from './math/Mat4';

export interface OrbitControlsOptions {
  target?: Vec3Tuple;
  theta?: number;
  phi?: number;
  radius?: number;
  minRadius?: number;
  maxRadius?: number;
  minPhi?: number;
  maxPhi?: number;
  damping?: number;
  rotateSpeed?: number;
  panSpeed?: number;
  zoomSpeed?: number;
  autoRotate?: boolean;
  autoRotateSpeed?: number;
}

export interface OrbitCameraTarget {
  position: Vec3Tuple;
  target: Vec3Tuple;
}

export interface OrbitKeyframe {
  /** Normalized scroll/timeline progress in `[0..1]`. */
  progress: number;
  target: Vec3Tuple;
  radius: number;
  theta: number;
  phi: number;
}

/**
 * Spherical orbit/pan/zoom camera controller for 3D viewers, product showcases, and inspection modes.
 * Works both headlessly and attached to a canvas element with smooth exponential damping.
 */
export class OrbitControls {
  minRadius: number;
  maxRadius: number;
  minPhi: number;
  maxPhi: number;
  damping: number;
  rotateSpeed: number;
  panSpeed: number;
  zoomSpeed: number;
  autoRotate: boolean;
  autoRotateSpeed: number;
  enabled = true;

  private theta: number;
  private phi: number;
  private radius: number;
  private readonly target: Vec3Tuple;

  private targetTheta: number;
  private targetPhi: number;
  private targetRadius: number;
  private readonly desiredTarget: Vec3Tuple;

  private attachedEl: HTMLElement | null = null;
  private dragMode: 'none' | 'orbit' | 'pan' = 'none';
  private lastX = 0;
  private lastY = 0;

  constructor(opts: OrbitControlsOptions = {}) {
    this.minRadius = opts.minRadius ?? 1.5;
    this.maxRadius = opts.maxRadius ?? 60;
    this.minPhi = opts.minPhi ?? 0.08;
    this.maxPhi = opts.maxPhi ?? Math.PI * 0.49;
    this.damping = Math.max(0.1, opts.damping ?? 10);
    this.rotateSpeed = opts.rotateSpeed ?? 0.006;
    this.panSpeed = opts.panSpeed ?? 0.0022;
    this.zoomSpeed = opts.zoomSpeed ?? 0.0018;
    this.autoRotate = opts.autoRotate ?? false;
    this.autoRotateSpeed = opts.autoRotateSpeed ?? 0.45;

    const t = opts.target ?? [0, 0, 0];
    this.target = [t[0], t[1], t[2]];
    this.desiredTarget = [t[0], t[1], t[2]];
    this.theta = opts.theta ?? 0;
    this.phi = clamp(opts.phi ?? 1.1, this.minPhi, this.maxPhi);
    this.radius = clamp(opts.radius ?? 10, this.minRadius, this.maxRadius);

    this.targetTheta = this.theta;
    this.targetPhi = this.phi;
    this.targetRadius = this.radius;
  }

  setView(target: Vec3Tuple, radius: number, theta = this.theta, phi = this.phi): void {
    this.desiredTarget[0] = target[0];
    this.desiredTarget[1] = target[1];
    this.desiredTarget[2] = target[2];
    this.targetRadius = clamp(radius, this.minRadius, this.maxRadius);
    this.targetTheta = theta;
    this.targetPhi = clamp(phi, this.minPhi, this.maxPhi);
  }

  orbit(deltaTheta: number, deltaPhi: number): void {
    this.targetTheta += deltaTheta;
    this.targetPhi = clamp(this.targetPhi + deltaPhi, this.minPhi, this.maxPhi);
  }

  pan(rightDelta: number, upDelta: number): void {
    const sinT = Math.sin(this.theta);
    const cosT = Math.cos(this.theta);
    // Camera right vector lies in XZ plane perpendicular to viewing ray
    const rx = cosT;
    const rz = -sinT;
    const fx = -sinT * Math.cos(this.phi);
    const fy = Math.sin(this.phi);
    const fz = -cosT * Math.cos(this.phi);

    const scale = this.radius * 0.25;
    this.desiredTarget[0] += (rx * rightDelta + fx * upDelta) * scale;
    this.desiredTarget[1] += fy * upDelta * scale;
    this.desiredTarget[2] += (rz * rightDelta + fz * upDelta) * scale;
  }

  zoom(delta: number): void {
    this.targetRadius = clamp(
      this.targetRadius * (1 + Math.max(-0.5, Math.min(0.8, delta * 0.05))),
      this.minRadius,
      this.maxRadius
    );
  }

  update(dt: number, camera: OrbitCameraTarget): void {
    if (this.autoRotate && this.dragMode === 'none') {
      this.targetTheta += this.autoRotateSpeed * dt;
    }

    const blend = 1 - Math.exp(-this.damping * Math.max(0, dt));
    this.theta += (this.targetTheta - this.theta) * blend;
    this.phi = clamp(this.phi + (this.targetPhi - this.phi) * blend, this.minPhi, this.maxPhi);
    this.radius = clamp(this.radius + (this.targetRadius - this.radius) * blend, this.minRadius, this.maxRadius);

    this.target[0] += (this.desiredTarget[0] - this.target[0]) * blend;
    this.target[1] += (this.desiredTarget[1] - this.target[1]) * blend;
    this.target[2] += (this.desiredTarget[2] - this.target[2]) * blend;

    const sinPhi = Math.sin(this.phi);
    const cosPhi = Math.cos(this.phi);
    const sinTheta = Math.sin(this.theta);
    const cosTheta = Math.cos(this.theta);

    camera.target[0] = this.target[0];
    camera.target[1] = this.target[1];
    camera.target[2] = this.target[2];
    camera.position[0] = this.target[0] + this.radius * sinPhi * sinTheta;
    camera.position[1] = this.target[1] + this.radius * cosPhi;
    camera.position[2] = this.target[2] + this.radius * sinPhi * cosTheta;
  }

  attach(element: HTMLElement): void {
    if (this.attachedEl === element) return;
    this.detach();
    this.attachedEl = element;
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('contextmenu', this.onContextMenu);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', this.onPointerMove);
      window.addEventListener('pointerup', this.onPointerUp);
    }
  }

  detach(): void {
    if (!this.attachedEl) return;
    this.attachedEl.removeEventListener('pointerdown', this.onPointerDown);
    this.attachedEl.removeEventListener('contextmenu', this.onContextMenu);
    this.attachedEl.removeEventListener('wheel', this.onWheel);
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', this.onPointerMove);
      window.removeEventListener('pointerup', this.onPointerUp);
    }
    this.attachedEl = null;
    this.dragMode = 'none';
  }

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.enabled) e.preventDefault();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.dragMode = e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'orbit';
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled || this.dragMode === 'none') return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.dragMode === 'orbit') {
      this.orbit(-dx * this.rotateSpeed, -dy * this.rotateSpeed);
    } else {
      this.pan(-dx * this.panSpeed * 4, dy * this.panSpeed * 4);
    }
  };

  getState(): { target: Vec3Tuple; radius: number; theta: number; phi: number } {
    return {
      target: [this.desiredTarget[0], this.desiredTarget[1], this.desiredTarget[2]],
      radius: this.targetRadius,
      theta: this.targetTheta,
      phi: this.targetPhi,
    };
  }

  /**
   * Samples a scroll/presentation camera timeline at `progress` (`0..1`) with smoothstep easing.
   * Ideal for Apple/product-style scroll-driven 3D web experiences.
   */
  applyTimeline(keyframes: readonly OrbitKeyframe[], progress01: number): void {
    if (keyframes.length === 0) return;
    const sorted = keyframes.length > 1 ? [...keyframes].sort((a, b) => a.progress - b.progress) : keyframes;
    const t = clamp(progress01, 0, 1);
    if (t <= sorted[0].progress || sorted.length === 1) {
      const k = sorted[0];
      this.setView(k.target, k.radius, k.theta, k.phi);
      return;
    }
    const last = sorted[sorted.length - 1];
    if (t >= last.progress) {
      this.setView(last.target, last.radius, last.theta, last.phi);
      return;
    }
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (t >= a.progress && t <= b.progress) {
        const span = Math.max(1e-5, b.progress - a.progress);
        const u = (t - a.progress) / span;
        const s = u * u * (3 - 2 * u);
        const dTheta = Math.atan2(Math.sin(b.theta - a.theta), Math.cos(b.theta - a.theta));
        this.setView(
          [
            a.target[0] + (b.target[0] - a.target[0]) * s,
            a.target[1] + (b.target[1] - a.target[1]) * s,
            a.target[2] + (b.target[2] - a.target[2]) * s,
          ],
          a.radius + (b.radius - a.radius) * s,
          a.theta + dTheta * s,
          a.phi + (b.phi - a.phi) * s
        );
        return;
      }
    }
  }

  /** Binds a scrollable element (or `window`) to drive camera keyframes automatically. Returns an unbind callback. */
  bindScrollTimeline(keyframes: readonly OrbitKeyframe[], scrollTarget?: HTMLElement | Window): () => void {
    if (typeof window === 'undefined') return () => {};
    const target = scrollTarget ?? window;
    const updateFromScroll = () => {
      if (target === window) {
        const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        this.applyTimeline(keyframes, window.scrollY / maxScroll);
      } else {
        const el = target as HTMLElement;
        const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
        this.applyTimeline(keyframes, el.scrollTop / maxScroll);
      }
    };
    target.addEventListener('scroll', updateFromScroll, { passive: true });
    updateFromScroll();
    return () => target.removeEventListener('scroll', updateFromScroll);
  }

  private readonly onPointerUp = (): void => {
    this.dragMode = 'none';
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    this.zoom(e.deltaY * this.zoomSpeed * 10);
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
