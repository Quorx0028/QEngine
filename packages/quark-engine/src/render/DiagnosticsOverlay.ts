import type { EngineErrorInfo, EngineStats } from '../Engine';

function ensureContainer(canvas: HTMLCanvasElement): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const parent = canvas.parentElement;
  if (!parent) return null;
  const style = window.getComputedStyle(parent);
  if (style.position === 'static') {
    parent.style.position = 'relative';
  }
  return parent;
}

export class DiagnosticsOverlay {
  private readonly canvas: HTMLCanvasElement;
  private profilerEl: HTMLDivElement | null = null;
  private crashEl: HTMLDivElement | null = null;
  private visible = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  isProfilerVisible(): boolean {
    return this.visible;
  }

  setProfilerVisible(show: boolean): void {
    this.visible = show;
    if (!show) {
      if (this.profilerEl) this.profilerEl.style.display = 'none';
      return;
    }
    this.ensureProfilerEl();
    if (this.profilerEl) this.profilerEl.style.display = 'block';
  }

  private ensureProfilerEl(): void {
    if (this.profilerEl) return;
    const host = ensureContainer(this.canvas);
    if (!host) return;
    const el = document.createElement('div');
    el.setAttribute('data-quark-profiler', '1');
    el.style.cssText = [
      'position:absolute',
      'right:12px',
      'bottom:12px',
      'z-index:9998',
      'background:rgba(15,23,42,0.88)',
      'color:#e2e8f0',
      'border:1px solid #334155',
      'border-radius:6px',
      'padding:8px 10px',
      'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'pointer-events:none',
      'min-width:230px',
      'display:none',
    ].join(';');
    host.appendChild(el);
    this.profilerEl = el;
  }

  updateProfiler(stats: EngineStats): void {
    if (!this.visible) return;
    this.ensureProfilerEl();
    if (!this.profilerEl) return;
    const t = stats.timings;
    const r = stats.render;
    const wasmMb = (stats.wasmMemoryBytes / (1024 * 1024)).toFixed(2);
    const lines = [
      `FPS ${stats.fps} (${stats.frameMs.toFixed(1)} ms)`,
      `Fixed ${t.fixedMs.toFixed(2)} | WASM ${t.wasmStepMs.toFixed(2)} | Upd ${t.updateMs.toFixed(2)} | GPU ${t.renderMs.toFixed(2)} ms`,
      `Draws ${stats.drawCalls} | Instanced ${r.instancedRuns} (${r.instancedObjects} obj) | MatSkip ${r.skippedMaterialBinds}`,
      `Entities ${stats.entities} | Shaders ${r.shaderCount} | WASM ${wasmMb} MB`,
    ];
    this.profilerEl.textContent = lines.join('\n');
    this.profilerEl.style.whiteSpace = 'pre';
  }

  showCrash(err: EngineErrorInfo, onResume: () => void): void {
    const host = ensureContainer(this.canvas);
    if (!host) return;
    this.hideCrash();
    const el = document.createElement('div');
    el.setAttribute('data-quark-crash', '1');
    el.style.cssText = [
      'position:absolute',
      'inset:16px',
      'margin:auto',
      'max-width:520px',
      'height:fit-content',
      'z-index:9999',
      'background:#0f172a',
      'color:#f8fafc',
      'border:1px solid #ef4444',
      'border-radius:8px',
      'padding:14px 16px',
      'font:12px/1.5 ui-sans-serif,system-ui,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,0.45)',
    ].join(';');

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;color:#fca5a5;margin-bottom:6px;';
    title.textContent = `Loop halted in ${err.phase}`;

    const msg = document.createElement('pre');
    msg.style.cssText =
      'margin:0 0 10px 0;padding:8px;background:#1e293b;border-radius:4px;overflow:auto;max-height:140px;font:11px/1.4 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;';
    msg.textContent = err.stack ? `${err.message}\n${err.stack}` : err.message;

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

    const btnResume = document.createElement('button');
    btnResume.textContent = 'Resume';
    btnResume.style.cssText =
      'background:#2563eb;color:#fff;border:1px solid #60a5fa;border-radius:5px;padding:4px 10px;cursor:pointer;font-size:12px;';
    btnResume.onclick = () => {
      this.hideCrash();
      onResume();
    };

    const btnDismiss = document.createElement('button');
    btnDismiss.textContent = 'Dismiss';
    btnDismiss.style.cssText =
      'background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:5px;padding:4px 10px;cursor:pointer;font-size:12px;';
    btnDismiss.onclick = () => this.hideCrash();

    actions.append(btnDismiss, btnResume);
    el.append(title, msg, actions);
    host.appendChild(el);
    this.crashEl = el;
  }

  hideCrash(): void {
    if (this.crashEl) {
      this.crashEl.remove();
      this.crashEl = null;
    }
  }

  dispose(): void {
    this.hideCrash();
    if (this.profilerEl) {
      this.profilerEl.remove();
      this.profilerEl = null;
    }
  }
}
