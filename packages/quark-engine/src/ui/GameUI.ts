/**
 * Zero-dependency lightweight HUD/UI overlay helper (no-op in headless/Node environments).
 */
export class GameUI {
  private root: HTMLElement | null = null;
  private barsWrap: HTMLElement | null = null;
  private promptEl: HTMLElement | null = null;
  private toastEl: HTMLElement | null = null;
  private crosshairEl: HTMLElement | null = null;
  private readonly bars = new Map<string, { fill: HTMLElement; text: HTMLElement }>();
  private toastTimer = 0;

  mount(parent?: HTMLElement): this {
    if (typeof document === 'undefined') return this;
    if (this.root) return this;
    const host = parent ?? document.body;

    const root = document.createElement('div');
    root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;font-family:ui-sans-serif,system-ui,sans-serif;z-index:20;';

    const barsWrap = document.createElement('div');
    barsWrap.style.cssText =
      'position:absolute;left:16px;bottom:16px;display:flex;flex-direction:column;gap:6px;min-width:190px;';

    const promptEl = document.createElement('div');
    promptEl.style.cssText =
      'position:absolute;left:50%;bottom:74px;transform:translateX(-50%);background:rgba(15,23,42,0.85);' +
      'color:#f8fafc;border:1px solid rgba(148,163,184,0.35);border-radius:8px;padding:6px 14px;font-size:13px;display:none;';

    const toastEl = document.createElement('div');
    toastEl.style.cssText =
      'position:absolute;left:50%;top:22px;transform:translateX(-50%);background:rgba(15,23,42,0.88);' +
      'color:#38bdf8;border:1px solid rgba(56,189,248,0.4);border-radius:8px;padding:6px 14px;font-size:13px;display:none;';

    const crosshairEl = document.createElement('div');
    crosshairEl.style.cssText =
      'position:absolute;left:50%;top:50%;width:6px;height:6px;transform:translate(-50%,-50%);' +
      'border-radius:50%;background:rgba(255,255,255,0.85);box-shadow:0 0 4px rgba(0,0,0,0.8);display:none;';

    root.append(barsWrap, promptEl, toastEl, crosshairEl);
    host.appendChild(root);

    this.root = root;
    this.barsWrap = barsWrap;
    this.promptEl = promptEl;
    this.toastEl = toastEl;
    this.crosshairEl = crosshairEl;
    return this;
  }

  setBar(id: string, ratio: number, opts: { label?: string; color?: string } = {}): void {
    const clamped = Math.max(0, Math.min(1, ratio));
    if (!this.barsWrap || typeof document === 'undefined') return;
    let entry = this.bars.get(id);
    if (!entry) {
      const box = document.createElement('div');
      box.style.cssText = 'background:rgba(15,23,42,0.78);padding:5px 8px;border-radius:6px;border:1px solid rgba(148,163,184,0.22);';
      const text = document.createElement('div');
      text.style.cssText = 'font-size:11px;color:#e2e8f0;margin-bottom:3px;font-weight:600;';
      const track = document.createElement('div');
      track.style.cssText = 'width:100%;height:7px;background:rgba(15,23,42,0.9);border-radius:4px;overflow:hidden;';
      const fill = document.createElement('div');
      fill.style.cssText = 'height:100%;width:100%;background:#38bdf8;transition:width 0.08s linear;';
      track.appendChild(fill);
      box.append(text, track);
      this.barsWrap.appendChild(box);
      entry = { fill, text };
      this.bars.set(id, entry);
    }
    entry.fill.style.width = `${Math.round(clamped * 100)}%`;
    if (opts.color) entry.fill.style.background = opts.color;
    entry.text.textContent = opts.label ?? `${id.toUpperCase()} ${Math.round(clamped * 100)}%`;
  }

  showPrompt(text: string | null): void {
    if (!this.promptEl) return;
    if (text) {
      this.promptEl.textContent = text;
      this.promptEl.style.display = 'block';
    } else {
      this.promptEl.style.display = 'none';
    }
  }

  setCrosshair(visible: boolean): void {
    if (!this.crosshairEl) return;
    this.crosshairEl.style.display = visible ? 'block' : 'none';
  }

  toast(message: string, durationSec = 2.5): void {
    if (!this.toastEl) return;
    this.toastEl.textContent = message;
    this.toastEl.style.display = 'block';
    this.toastTimer = Math.max(0.2, durationSec);
  }

  update(dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0 && this.toastEl) {
        this.toastEl.style.display = 'none';
      }
    }
  }

  dispose(): void {
    this.root?.remove();
    this.root = null;
    this.barsWrap = null;
    this.promptEl = null;
    this.toastEl = null;
    this.crosshairEl = null;
    this.bars.clear();
  }
}
