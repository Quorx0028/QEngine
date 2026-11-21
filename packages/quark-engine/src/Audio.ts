export class AudioSystem {
  private ctx: AudioContext | null = null;
  private bgmGain: GainNode | null = null;
  private bgmSource: AudioBufferSourceNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return null;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.bgmGain = this.ctx.createGain();
      this.bgmGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  async loadSound(key: string, url: string): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arr);
    this.buffers.set(key, decoded);
  }

  playSfx(key: string, volume = 0.8): void {
    const ctx = this.ensureContext();
    const buf = this.buffers.get(key);
    if (!ctx || !buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  }

  playBgm(key: string, volume = 0.45, fadeSec = 0.6): void {
    const ctx = this.ensureContext();
    const buf = this.buffers.get(key);
    if (!ctx || !buf || !this.bgmGain) return;
    const now = ctx.currentTime;
    if (this.bgmSource) {
      try {
        this.bgmSource.stop(now + fadeSec);
      } catch {
        // already stopped
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.bgmGain.gain.setValueAtTime(0.001, now);
    this.bgmGain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), now + fadeSec);
    src.connect(this.bgmGain);
    src.start(now);
    this.bgmSource = src;
  }

  unloadSound(key: string): void {
    this.buffers.delete(key);
  }

  dispose(): void {
    if (this.bgmSource) {
      try {
        this.bgmSource.stop();
      } catch {
        // ignore
      }
      this.bgmSource = null;
    }
    this.buffers.clear();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
