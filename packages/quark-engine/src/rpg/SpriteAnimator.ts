import type { EntityId, Scene } from '../Scene';

export interface SpriteAnimClip {
  frames: number[];
  fps?: number;
  loop?: boolean;
}

export interface SpriteAnimatorOptions {
  cols: number;
  rows: number;
  clips: Record<string, SpriteAnimClip>;
  initialClip?: string;
  size?: [number, number];
  textureId?: number;
  color?: [number, number, number, number];
  layer?: number;
}

/**
 * Grid-based 2D sprite animation controller that updates Sprite2D UV rects per tick.
 */
export class SpriteAnimator {
  private readonly scene: Scene;
  readonly entity: EntityId;
  readonly cols: number;
  readonly rows: number;
  private readonly clips: Record<string, SpriteAnimClip>;
  private readonly size: [number, number];
  private readonly textureId?: number;
  private readonly color: [number, number, number, number];
  private readonly layer: number;

  private activeClipName: string;
  private elapsed = 0;
  private frameIdx = 0;
  private _currentFrame = 0;
  private _uvMin: [number, number] = [0, 0];
  private _uvMax: [number, number] = [1, 1];
  finished = false;

  constructor(scene: Scene, entity: EntityId, opts: SpriteAnimatorOptions) {
    this.scene = scene;
    this.entity = entity;
    this.cols = Math.max(1, opts.cols);
    this.rows = Math.max(1, opts.rows);
    this.clips = opts.clips;
    this.size = opts.size ?? [1, 1];
    this.textureId = opts.textureId;
    this.color = opts.color ?? [1, 1, 1, 1];
    this.layer = opts.layer ?? 0;

    const firstClip = opts.initialClip ?? Object.keys(opts.clips)[0] ?? '';
    this.activeClipName = firstClip;
    this.applyFrame(this.clips[firstClip]?.frames[0] ?? 0);
  }

  get currentClip(): string {
    return this.activeClipName;
  }

  get currentFrame(): number {
    return this._currentFrame;
  }

  get currentUvMin(): [number, number] {
    return [this._uvMin[0], this._uvMin[1]];
  }

  get currentUvMax(): [number, number] {
    return [this._uvMax[0], this._uvMax[1]];
  }

  play(clipName: string, restart = false): void {
    const clip = this.clips[clipName];
    if (!clip || clip.frames.length === 0) return;
    if (this.activeClipName === clipName && !restart) return;
    this.activeClipName = clipName;
    this.elapsed = 0;
    this.frameIdx = 0;
    this.finished = false;
    this.applyFrame(clip.frames[0]);
  }

  update(dt: number): void {
    const clip = this.clips[this.activeClipName];
    if (!clip || clip.frames.length === 0) return;
    const fps = Math.max(0.1, clip.fps ?? 8);
    const frameDur = 1 / fps;
    const loop = clip.loop ?? true;

    this.elapsed += Math.max(0, dt);
    const steps = Math.floor(this.elapsed / frameDur);
    if (steps <= 0) return;

    this.elapsed -= steps * frameDur;
    if (loop) {
      this.frameIdx = (this.frameIdx + steps) % clip.frames.length;
    } else {
      const next = this.frameIdx + steps;
      if (next >= clip.frames.length - 1) {
        this.frameIdx = clip.frames.length - 1;
        this.finished = true;
      } else {
        this.frameIdx = next;
      }
    }
    this.applyFrame(clip.frames[this.frameIdx]);
  }

  private applyFrame(tileIdx: number): void {
    this._currentFrame = tileIdx;
    const col = ((tileIdx % this.cols) + this.cols) % this.cols;
    const row = Math.floor(tileIdx / this.cols) % this.rows;
    const cw = 1 / this.cols;
    const ch = 1 / this.rows;
    this._uvMin = [col * cw, row * ch];
    this._uvMax = [(col + 1) * cw, (row + 1) * ch];
    this.scene.setSprite2D(this.entity, {
      size: this.size,
      uvMin: this._uvMin,
      uvMax: this._uvMax,
      color: this.color,
      textureId: this.textureId,
      layer: this.layer,
    });
  }
}
