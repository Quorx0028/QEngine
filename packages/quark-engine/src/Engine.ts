import { AssetManager } from './assets/AssetManager';
import { AudioSystem } from './Audio';
import { Input } from './Input';
import { DiagnosticsOverlay } from './render/DiagnosticsOverlay';
import type { IRenderBackend, RenderFrameMetrics } from './render/IRenderBackend';
import { WebGL2Backend } from './render/WebGL2Backend';
import { Scene } from './Scene';
import { WasmBridge } from './wasm/WasmBridge';

export interface EngineOptions {
  canvas?: HTMLCanvasElement;
  wasmUrl?: string | URL;
  wasmBytes?: BufferSource;
  fixedDt?: number;
  maxDpr?: number;
  backend?: IRenderBackend;
  crashOverlay?: boolean;
  showProfiler?: boolean;
}

export interface EngineFrameTimings {
  fixedMs: number;
  wasmStepMs: number;
  updateMs: number;
  renderMs: number;
}

export interface EngineErrorInfo {
  phase: 'fixedUpdate' | 'wasmStep' | 'update' | 'render' | 'loop';
  message: string;
  stack?: string;
  timestamp: number;
}

export interface EngineStats {
  fps: number;
  frameMs: number;
  entities: number;
  wasmMemoryBytes: number;
  drawCalls: number;
  timings: EngineFrameTimings;
  render: RenderFrameMetrics;
}

const ZERO_METRICS: RenderFrameMetrics = {
  instancedRuns: 0,
  instancedObjects: 0,
  skippedMaterialBinds: 0,
  shaderCount: 0,
  uboBound: false,
};

export class Engine {
  readonly bridge: WasmBridge;
  readonly scene: Scene;
  readonly input: Input;
  readonly audio: AudioSystem;
  readonly renderer: IRenderBackend | null;
  readonly assets: AssetManager;
  readonly canvas: HTMLCanvasElement | null;

  private fixedDt: number;
  private readonly maxDpr: number;
  private accumulator = 0;
  private elapsedTime = 0;
  private rafId = 0;
  private running = false;
  timeScale = 1.0;
  private lastTimeMs = 0;
  private fps = 0;
  private frameMs = 0;
  private lastDrawCalls = 0;

  private fixedUpdateCb: ((fixedDt: number) => void) | null = null;
  private updateCb: ((dt: number, alpha: number) => void) | null = null;
  private errorCb: ((err: EngineErrorInfo) => void) | null = null;
  private renderFrameHook: ((aspect: number) => number) | null = null;
  private resizeHandler: (() => void) | null = null;
  private profilerKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private diagnostics: DiagnosticsOverlay | null = null;
  private crashOverlayEnabled: boolean;
  private lastError: EngineErrorInfo | null = null;
  private profilerTickCounter = 0;
  private lastTimings: EngineFrameTimings = {
    fixedMs: 0,
    wasmStepMs: 0,
    updateMs: 0,
    renderMs: 0,
  };
  private pendingCaptures: Array<{
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    quality: number;
    resolve: (dataUrl: string) => void;
    reject: (err: unknown) => void;
  }> = [];

  private constructor(bridge: WasmBridge, options: EngineOptions) {
    this.bridge = bridge;
    this.fixedDt = options.fixedDt ?? 1 / 60;
    this.maxDpr = Math.max(0.5, options.maxDpr ?? 1.5);
    this.crashOverlayEnabled = options.crashOverlay ?? true;
    this.bridge.setFixedDt(this.fixedDt);
    this.scene = new Scene(bridge);
    this.input = new Input();
    this.audio = new AudioSystem();
    this.canvas = options.canvas ?? null;

    if (options.backend) {
      this.renderer = options.backend;
    } else if (this.canvas) {
      this.renderer = new WebGL2Backend(this.canvas);
    } else {
      this.renderer = null;
    }
    this.assets = new AssetManager(this.bridge, this.renderer);

    if (this.renderer) {
      const backend = this.renderer;
      this.renderFrameHook = (aspect: number) =>
        backend.renderFrame(this.bridge, this.scene, aspect, this.elapsedTime);
    }

    if (this.canvas) {
      this.input.attach(this.canvas);
      this.syncCanvasSize();
      if (typeof document !== 'undefined') {
        this.diagnostics = new DiagnosticsOverlay(this.canvas);
        if (options.showProfiler) {
          this.diagnostics.setProfilerVisible(true);
        }
      }
      if (typeof window !== 'undefined') {
        this.resizeHandler = () => this.syncCanvasSize();
        window.addEventListener('resize', this.resizeHandler);
        this.profilerKeyHandler = (e: KeyboardEvent) => {
          if (e.code === 'F2') {
            this.setProfilerVisible(!this.isProfilerVisible());
          }
        };
        window.addEventListener('keydown', this.profilerKeyHandler);
      }
    }
  }

  static async init(options: EngineOptions = {}): Promise<Engine> {
    const bridge = await WasmBridge.load({
      wasmBytes: options.wasmBytes,
      wasmUrl: options.wasmUrl,
    });
    return new Engine(bridge, options);
  }

  /** Internal hook attached by WebGL2Backend/Renderer when canvas is active. */
  setRenderHook(fn: ((aspect: number) => number) | null): void {
    this.renderFrameHook = fn;
  }

  onFixedUpdate(cb: ((fixedDt: number) => void) | null): void {
    this.fixedUpdateCb = cb;
  }

  onUpdate(cb: ((dt: number, alpha: number) => void) | null): void {
    this.updateCb = cb;
  }

  onError(cb: ((err: EngineErrorInfo) => void) | null): void {
    this.errorCb = cb;
  }

  getLastError(): EngineErrorInfo | null {
    return this.lastError;
  }

  clearError(): void {
    this.lastError = null;
    this.diagnostics?.hideCrash();
  }

  /**
   * Captures the active WebGL2 canvas frame as a Data URL immediately after rendering,
   * avoiding blank frames even when `preserveDrawingBuffer` is disabled.
   */
  captureScreenshot(
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png',
    quality = 0.92
  ): Promise<string> {
    if (!this.canvas) {
      return Promise.reject(new Error('Cannot capture screenshot without an attached canvas'));
    }
    return new Promise<string>((resolve, reject) => {
      this.pendingCaptures.push({ mimeType, quality, resolve, reject });
      if (!this.running && this.renderFrameHook) {
        const aspect = this.canvas!.height > 0 ? this.canvas!.width / this.canvas!.height : 16 / 9;
        this.lastDrawCalls = this.renderFrameHook(aspect);
        const jobs = this.pendingCaptures.splice(0, this.pendingCaptures.length);
        for (const job of jobs) {
          try {
            job.resolve(this.canvas!.toDataURL(job.mimeType, job.quality));
          } catch (err) {
            job.reject(err);
          }
        }
      }
    });
  }

  isProfilerVisible(): boolean {
    return this.diagnostics?.isProfilerVisible() ?? false;
  }

  setProfilerVisible(visible: boolean): void {
    this.diagnostics?.setProfilerVisible(visible);
    if (visible) {
      this.diagnostics?.updateProfiler(this.getStats());
    }
  }

  private handleLoopError(phase: EngineErrorInfo['phase'], err: unknown): void {
    this.stop();
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack.split('\n').slice(1, 5).join('\n') : undefined;
    const info: EngineErrorInfo = {
      phase,
      message,
      stack,
      timestamp: Date.now(),
    };
    this.lastError = info;
    console.error(`[QuarkEngine CrashGuard:${phase}]`, err);
    this.errorCb?.(info);
    if (this.crashOverlayEnabled && this.diagnostics) {
      this.diagnostics.showCrash(info, () => {
        this.clearError();
        this.start();
      });
    }
  }

  syncCanvasSize(): void {
    if (!this.canvas || typeof window === 'undefined') return;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  step(dtSeconds: number, guarded = false): number {
    const clamped = Math.max(0, Math.min(dtSeconds, 0.1));
    this.elapsedTime += clamped;
    this.accumulator += clamped;

    const t0 = this.nowMs();
    let substeps = 0;
    let phase: EngineErrorInfo['phase'] = 'fixedUpdate';
    try {
      while (this.accumulator >= this.fixedDt && substeps < 6) {
        this.scene.behaviors.stepFixed(this.fixedDt);
        this.fixedUpdateCb?.(this.fixedDt);
        this.accumulator -= this.fixedDt;
        substeps++;
      }
      if (substeps === 6 && this.accumulator >= this.fixedDt) {
        this.accumulator %= this.fixedDt;
      }
      const t1 = this.nowMs();

      phase = 'wasmStep';
      const aspect =
        this.canvas && this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 16 / 9;
      const { viewProj } = this.scene.computeCameraMatrices(aspect);
      const alpha = this.bridge.step(clamped, viewProj);
      const t2 = this.nowMs();

      phase = 'update';
      this.scene.dispatchPhysicsEvents();
      this.scene.advanceEffects(clamped);
      this.scene.behaviors.stepUpdate(clamped);
      this.updateCb?.(clamped, alpha);

      // Sync WebAudio 3D spatial listener to active camera
      const camPos = this.scene.camera.position;
      const camTgt = this.scene.camera.target;
      this.audio.updateListener(
        camPos,
        [camTgt[0] - camPos[0], camTgt[1] - camPos[1], camTgt[2] - camPos[2]],
        this.scene.camera.up
      );
      const t3 = this.nowMs();

      phase = 'render';
      if (this.renderFrameHook) {
        this.lastDrawCalls = this.renderFrameHook(aspect);
      }
      if (this.pendingCaptures.length > 0 && this.canvas) {
        const jobs = this.pendingCaptures.splice(0, this.pendingCaptures.length);
        for (const job of jobs) {
          try {
            job.resolve(this.canvas.toDataURL(job.mimeType, job.quality));
          } catch (capErr) {
            job.reject(capErr);
          }
        }
      }
      const t4 = this.nowMs();

      this.lastTimings = {
        fixedMs: t1 - t0,
        wasmStepMs: t2 - t1,
        updateMs: t3 - t2,
        renderMs: t4 - t3,
      };
      this.input.endFrame();
      return alpha;
    } catch (err) {
      if (guarded) {
        this.handleLoopError(phase, err);
        return 0;
      }
      throw err;
    }
  }

  start(): void {
    if (this.running || typeof requestAnimationFrame === 'undefined') return;
    this.running = true;
    this.lastTimeMs = this.nowMs();
    const tick = (now: number) => {
      if (!this.running) return;
      const dtMs = now - this.lastTimeMs;
      this.lastTimeMs = now;
      this.frameMs = dtMs;
      if (dtMs > 0.01) {
        this.fps = this.fps * 0.9 + (1000 / dtMs) * 0.1;
      }
      this.syncCanvasSize();
      this.step((dtMs / 1000) * Math.max(0, this.timeScale), true);
      if (!this.running) return;
      this.profilerTickCounter++;
      if (this.diagnostics?.isProfilerVisible() && this.profilerTickCounter % 6 === 0) {
        this.diagnostics.updateProfiler(this.getStats());
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  getStats(): EngineStats {
    return {
      fps: Math.round(this.fps),
      frameMs: Number(this.frameMs.toFixed(2)),
      entities: this.scene.getEntityCount(),
      wasmMemoryBytes: this.bridge.getWasmMemoryBytes(),
      drawCalls: this.lastDrawCalls,
      timings: { ...this.lastTimings },
      render: this.renderer?.getRenderMetrics ? this.renderer.getRenderMetrics() : { ...ZERO_METRICS },
    };
  }

  dispose(): void {
    this.stop();
    if (this.resizeHandler && typeof window !== 'undefined') {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.profilerKeyHandler && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.profilerKeyHandler);
      this.profilerKeyHandler = null;
    }
    this.diagnostics?.dispose();
    this.input.dispose();
    this.audio.dispose();
    this.assets.dispose();
    this.renderer?.dispose();
    this.bridge.dispose();
  }
}
