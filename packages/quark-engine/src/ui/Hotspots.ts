import type { Vec3Tuple } from '../math/Mat4';
import type { OrbitControls } from '../OrbitControls';
import type { Scene } from '../Scene';

export interface HotspotOptions {
  id: string;
  position: Vec3Tuple | (() => Vec3Tuple);
  label: string;
  badge?: string;
  description?: string;
  color?: string;
  focusRadius?: number;
  focusTheta?: number;
  focusPhi?: number;
  occlude?: boolean;
  onClick?: (id: string) => void;
}

interface InternalHotspot {
  opts: HotspotOptions;
  root: HTMLDivElement;
  dot: HTMLButtonElement;
  card: HTMLDivElement;
}

/**
 * Interactive HTML 3D Hotspot / Annotation overlay projected dynamically from world coordinates.
 * Designed for 3D product showcases, interactive architecture tours, and web embeds.
 */
export class HotspotOverlay {
  private readonly scene: Scene;
  private readonly container: HTMLElement;
  private readonly canvas: HTMLElement;
  private readonly orbit: OrbitControls | null;
  private readonly layer: HTMLDivElement;
  private readonly items = new Map<string, InternalHotspot>();
  private activeId: string | null = null;
  private visible = true;

  constructor(scene: Scene, canvas: HTMLElement, orbit: OrbitControls | null = null, container?: HTMLElement) {
    this.scene = scene;
    this.canvas = canvas;
    this.orbit = orbit;
    this.container = container ?? canvas.parentElement ?? document.body;

    this.layer = document.createElement('div');
    this.layer.style.cssText =
      'position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:15;';
    this.container.appendChild(this.layer);
  }

  add(opts: HotspotOptions): this {
    this.remove(opts.id);
    const accent = opts.color ?? '#38bdf8';

    const root = document.createElement('div');
    root.style.cssText =
      'position:absolute;top:0;left:0;will-change:transform,opacity;pointer-events:none;transition:opacity 0.14s ease;';

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.style.cssText = `
      pointer-events:auto;
      display:inline-flex;align-items:center;gap:6px;
      padding:4px 10px 4px 6px;
      border-radius:999px;
      background:rgba(10,16,28,0.86);
      backdrop-filter:blur(8px);
      border:1.5px solid ${accent};
      color:#f8fafc;
      font:600 12px/1.2 system-ui,-apple-system,sans-serif;
      box-shadow:0 4px 16px rgba(0,0,0,0.45);
      cursor:pointer;
      transform:translate(-50%,-50%);
      white-space:nowrap;
    `;
    dot.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${accent};box-shadow:0 0 8px ${accent};display:inline-block;"></span><span>${escapeHtml(opts.label)}</span>`;

    const card = document.createElement('div');
    card.style.cssText = `
      display:none;
      pointer-events:auto;
      margin-top:8px;
      width:230px;
      padding:10px 12px;
      border-radius:10px;
      background:rgba(10,16,28,0.94);
      backdrop-filter:blur(10px);
      border:1px solid ${accent};
      color:#e2e8f0;
      font:400 12px/1.45 system-ui,-apple-system,sans-serif;
      box-shadow:0 12px 28px rgba(0,0,0,0.55);
      transform:translate(-50%, 0);
    `;
    const badgeHtml = opts.badge
      ? `<div style="font:700 10px/1 system-ui;letter-spacing:0.06em;color:${accent};margin-bottom:4px;">${escapeHtml(opts.badge)}</div>`
      : '';
    card.innerHTML = `${badgeHtml}<div style="font-weight:700;color:#fff;margin-bottom:3px;">${escapeHtml(opts.label)}</div>${
      opts.description ? `<div style="color:#cbd5e1;">${escapeHtml(opts.description)}</div>` : ''
    }`;

    dot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const willOpen = this.activeId !== opts.id;
      this.setActive(willOpen ? opts.id : null);
      if (this.orbit) {
        const pos = typeof opts.position === 'function' ? opts.position() : opts.position;
        this.orbit.setView(
          pos,
          opts.focusRadius ?? 5.6,
          opts.focusTheta,
          opts.focusPhi
        );
      }
      opts.onClick?.(opts.id);
    });

    root.appendChild(dot);
    root.appendChild(card);
    this.layer.appendChild(root);
    this.items.set(opts.id, { opts, root, dot, card });
    return this;
  }

  setActive(id: string | null): void {
    this.activeId = id;
    for (const [k, item] of this.items) {
      item.card.style.display = k === id ? 'block' : 'none';
    }
  }

  remove(id: string): void {
    const existing = this.items.get(id);
    if (existing) {
      existing.root.remove();
      this.items.delete(id);
    }
  }

  clear(): void {
    for (const item of this.items.values()) item.root.remove();
    this.items.clear();
    this.activeId = null;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.layer.style.display = visible ? 'block' : 'none';
  }

  isVisible(): boolean {
    return this.visible;
  }

  update(): void {
    if (!this.visible || this.items.size === 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || (typeof window !== 'undefined' ? window.innerWidth : 1280);
    const h = rect.height || (typeof window !== 'undefined' ? window.innerHeight : 720);
    const camPos = this.scene.camera.position;

    for (const item of this.items.values()) {
      const worldPos = typeof item.opts.position === 'function' ? item.opts.position() : item.opts.position;
      const proj = this.scene.worldToScreen(worldPos, w, h);
      if (!proj.visible) {
        item.root.style.opacity = '0';
        item.root.style.pointerEvents = 'none';
        continue;
      }

      let occluded = false;
      if (item.opts.occlude) {
        const dx = worldPos[0] - camPos[0];
        const dy = worldPos[1] - camPos[1];
        const dz = worldPos[2] - camPos[2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist > 0.6) {
          const hit = this.scene.raycast3D(camPos, [dx / dist, dy / dist, dz / dist], dist - 0.45);
          if (hit) occluded = true;
        }
      }

      item.root.style.opacity = occluded ? '0.22' : '1';
      item.root.style.transform = `translate3d(${(rect.left + proj.x).toFixed(1)}px, ${(rect.top + proj.y).toFixed(1)}px, 0)`;
    }
  }

  dispose(): void {
    this.clear();
    this.layer.remove();
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
