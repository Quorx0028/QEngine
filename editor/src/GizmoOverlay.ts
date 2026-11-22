import type { Vec3Tuple } from 'quark-engine';

export type GizmoMode = 'move' | 'rotate' | 'scale';
export type GizmoAxis = 'x' | 'y' | 'z';

export interface ProjectedPoint {
  x: number;
  y: number;
  visible: boolean;
}

const AXIS_VECS: Record<GizmoAxis, Vec3Tuple> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

const AXIS_COLORS: Record<GizmoAxis, string> = {
  x: '#f87171',
  y: '#4ade80',
  z: '#60a5fa',
};

export function projectPointToScreen(
  p: Vec3Tuple,
  vp: Float32Array,
  width: number,
  height: number
): ProjectedPoint {
  const cx = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
  const cy = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
  const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  if (cw <= 0.001) {
    return { x: -9999, y: -9999, visible: false };
  }
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (0.5 - ndcY * 0.5) * height,
    visible: true,
  };
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-4) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export class GizmoOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create 2D gizmo overlay context');
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private handleLength(target: Vec3Tuple, camPos: Vec3Tuple): number {
    const dist = Math.hypot(target[0] - camPos[0], target[1] - camPos[1], target[2] - camPos[2]);
    return Math.max(0.7, Math.min(4.5, dist * 0.16));
  }

  pickAxis(
    mouseX: number,
    mouseY: number,
    target: Vec3Tuple,
    camPos: Vec3Tuple,
    vp: Float32Array
  ): GizmoAxis | null {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const o = projectPointToScreen(target, vp, w, h);
    if (!o.visible) return null;
    const len = this.handleLength(target, camPos);

    let bestAxis: GizmoAxis | null = null;
    let bestDist = 14;
    (['x', 'y', 'z'] as GizmoAxis[]).forEach((ax) => {
      const v = AXIS_VECS[ax];
      const tip = projectPointToScreen(
        [target[0] + v[0] * len, target[1] + v[1] * len, target[2] + v[2] * len],
        vp,
        w,
        h
      );
      if (!tip.visible) return;
      const d = distToSegment(mouseX, mouseY, o.x, o.y, tip.x, tip.y);
      if (d < bestDist) {
        bestDist = d;
        bestAxis = ax;
      }
    });
    return bestAxis;
  }

  axisScreenDir(
    axis: GizmoAxis,
    target: Vec3Tuple,
    camPos: Vec3Tuple,
    vp: Float32Array
  ): [number, number, number] {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const v = AXIS_VECS[axis];
    const len = this.handleLength(target, camPos);
    const o = projectPointToScreen(target, vp, w, h);
    const tip = projectPointToScreen(
      [target[0] + v[0] * len, target[1] + v[1] * len, target[2] + v[2] * len],
      vp,
      w,
      h
    );
    const dx = tip.x - o.x;
    const dy = tip.y - o.y;
    const pxLen = Math.hypot(dx, dy);
    if (pxLen < 2) return [1, 0, 0.02];
    return [dx / pxLen, dy / pxLen, len / pxLen];
  }

  draw(
    target: Vec3Tuple | null,
    camPos: Vec3Tuple,
    vp: Float32Array,
    mode: GizmoMode,
    activeAxis: GizmoAxis | null,
    selectedName?: string
  ): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    if (!target) return;
    const o = projectPointToScreen(target, vp, w, h);
    if (!o.visible) return;

    const len = this.handleLength(target, camPos);

    // Center handle dot
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(o.x, o.y, 4.5, 0, Math.PI * 2);
    ctx.fill();

    if (selectedName) {
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
      const tw = ctx.measureText(selectedName).width + 12;
      ctx.fillRect(o.x - tw / 2, o.y - 28, tw, 18);
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'center';
      ctx.fillText(selectedName, o.x, o.y - 15);
    }

    (['x', 'y', 'z'] as GizmoAxis[]).forEach((ax) => {
      const v = AXIS_VECS[ax];
      const tip = projectPointToScreen(
        [target[0] + v[0] * len, target[1] + v[1] * len, target[2] + v[2] * len],
        vp,
        w,
        h
      );
      if (!tip.visible) return;
      const highlight = activeAxis === ax;
      const color = highlight ? '#fde047' : AXIS_COLORS[ax];

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = highlight ? 3.5 : 2.5;
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();

      if (mode === 'scale') {
        ctx.fillRect(tip.x - 4.5, tip.y - 4.5, 9, 9);
      } else if (mode === 'rotate') {
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, 6, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // Move arrowhead
        const ang = Math.atan2(tip.y - o.y, tip.x - o.x);
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(tip.x - 10 * Math.cos(ang - 0.38), tip.y - 10 * Math.sin(ang - 0.38));
        ctx.lineTo(tip.x - 10 * Math.cos(ang + 0.38), tip.y - 10 * Math.sin(ang + 0.38));
        ctx.closePath();
        ctx.fill();
      }

      ctx.font = 'bold 11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(ax.toUpperCase(), tip.x + 12 * Math.cos(Math.atan2(tip.y - o.y, tip.x - o.x)), tip.y + 12 * Math.sin(Math.atan2(tip.y - o.y, tip.x - o.x)));
    });
  }
}
