import { AudioSystem } from './Audio';
import { Input } from './Input';
import { Scene } from './Scene';
import { WasmBridge } from './wasm/WasmBridge';

export interface EngineOptions {
  canvas?: HTMLCanvasElement;
  wasmUrl?: string | URL;
  wasmBytes?: BufferSource;
  fixedDt?: number;
}

export interface EngineStats {
  fps: number;
  frameMs: number;
  entities: number;
  wasmMemoryBytes: number;
  drawCalls: number;
}

export class Engine {
  readonly bridge: WasmBridge;
  readonly scene: Scene;
  readonly input: Input;
  readonly audio: AudioSystem;
  readonly canvas: HTMLCanvasElement | null;

  private fixedDt: number;
  private accumulator = 0;
  private rafId = 0;
  private running = false;
  private lastTimeMs = 0;
  private fps = 0;
  private frameMs = 0;
  private lastDrawCalls = 0;

  private fixedUpdateCb: ((fixedDt: number) => void) | null = null;
  private updateCb: ((dt: number, alpha: number) => void) | null = null;
  private renderFrameHook: ((aspect: number) => number) | null = null;
  private resizeHandler: (() => void) | null = null;

  private constructor(bridge: WasmBridge, options: EngineOptions) {
    this.bridge = bridge;
    this.fixedDt = options.fixedDt ?? 1 / 60;
    this.bridge.setFixedDt(this.fixedDt);
    this.scene = new Scene(bridge);
    this.input = new Input();
    this.audio = new AudioSystem();
    this.canvas = options.canvas ?? null;

    if (this.canvas) {
      this.input.attach(this.canvas);
      this.syncCanvasSize();
      if (typeof window !== 'undefined') {
        this.resizeHandler = () => this.syncCanvasSize();
        window.addEventListener('resize', this.resizeHandler);
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

  syncCanvasSize(): void {
    if (!this.canvas || typeof window === 'undefined') return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  step(dtSeconds: number): number {
    const clamped = Math.max(0, Math.min(dtSeconds, 0.1));
    this.accumulator += clamped;
    let substeps = 0;
    while (this.accumulator >= this.fixedDt && substeps < 6) {
      this.fixedUpdateCb?.(this.fixedDt);
      this.accumulator -= this.fixedDt;
      substeps++;
    }
    if (substeps === 6 && this.accumulator >= this.fixedDt) {
      this.accumulator %= this.fixedDt;
    }

    const aspect =
      this.canvas && this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 16 / 9;
    const { viewProj } = this.scene.computeCameraMatrices(aspect);
    const alpha = this.bridge.step(clamped, viewProj);
    this.updateCb?.(clamped, alpha);
    if (this.renderFrameHook) {
      this.lastDrawCalls = this.renderFrameHook(aspect);
    }
    this.input.endFrame();
    return alpha;
  }

  start(): void {
    if (this.running || typeof requestAnimationFrame === 'undefined') return;
    this.running = true;
    this.lastTimeMs = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      const dtMs = now - this.lastTimeMs;
      this.lastTimeMs = now;
      this.frameMs = dtMs;
      if (dtMs > 0.01) {
        this.fps = this.fps * 0.9 + (1000 / dtMs) * 0.1;
      }
      this.syncCanvasSize();
      this.step(dtMs / 1000);
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
    };
  }

  dispose(): void {
    this.stop();
    if (this.resizeHandler && typeof window !== 'undefined') {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    this.input.dispose();
    this.audio.dispose();
    this.bridge.dispose();
  }
}
