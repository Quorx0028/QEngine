import type { Vec3Tuple } from './math/Mat4';

export type AudioBus = 'master' | 'sfx' | 'music' | 'ambient';

export interface SpatialPlayOptions {
  position: Vec3Tuple;
  bus?: AudioBus;
  volume?: number;
  pitch?: number;
  loop?: boolean;
  refDistance?: number;
  maxDistance?: number;
  rolloff?: number;
}

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private busGains: Record<AudioBus, GainNode | null> = {
    master: null,
    sfx: null,
    music: null,
    ambient: null,
  };
  private busVolumes: Record<AudioBus, number> = {
    master: 1,
    sfx: 0.9,
    music: 0.55,
    ambient: 0.7,
  };
  private bgmSource: AudioBufferSourceNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private rainSource: AudioBufferSourceNode | null = null;
  private rainGain: GainNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private activeVoices = 0;
  private readonly maxVoices = 24;

  private getNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer && this.noiseBuffer.sampleRate === ctx.sampleRate) {
      return this.noiseBuffer;
    }
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.992 * b0 + white * 0.08;
      b1 = 0.92 * b1 + white * 0.25;
      data[i] = Math.max(-1, Math.min(1, b0 + b1 + white * 0.45));
    }
    this.noiseBuffer = buf;
    return buf;
  }

  private createPanner(
    ctx: AudioContext,
    position: Vec3Tuple,
    refDistance = 2.5,
    maxDistance = 42.0,
    rolloff = 1.2
  ): PannerNode {
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = rolloff;
    panner.positionX.value = position[0];
    panner.positionY.value = position[1];
    panner.positionZ.value = position[2];
    return panner;
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return null;
    if (!this.ctx) {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = this.busVolumes.master;
      master.connect(ctx.destination);

      const sfx = ctx.createGain();
      sfx.gain.value = this.busVolumes.sfx;
      sfx.connect(master);

      const music = ctx.createGain();
      music.gain.value = this.busVolumes.music;
      music.connect(master);

      const ambient = ctx.createGain();
      ambient.gain.value = this.busVolumes.ambient;
      ambient.connect(master);

      this.ctx = ctx;
      this.masterGain = master;
      this.busGains = { master, sfx, music, ambient };
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  setBusVolume(bus: AudioBus, volume: number): void {
    const clamped = Math.max(0, Math.min(2, volume));
    this.busVolumes[bus] = clamped;
    const node = this.busGains[bus];
    if (node && this.ctx) {
      node.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.02);
    }
  }

  getBusVolume(bus: AudioBus): number {
    return this.busVolumes[bus];
  }

  updateListener(position: Vec3Tuple, forward: Vec3Tuple, up: Vec3Tuple = [0, 1, 0]): void {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if ('positionX' in l) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(position[0], t);
      l.positionY.setValueAtTime(position[1], t);
      l.positionZ.setValueAtTime(position[2], t);
      l.forwardX.setValueAtTime(forward[0], t);
      l.forwardY.setValueAtTime(forward[1], t);
      l.forwardZ.setValueAtTime(forward[2], t);
      l.upX.setValueAtTime(up[0], t);
      l.upY.setValueAtTime(up[1], t);
      l.upZ.setValueAtTime(up[2], t);
    }
  }

  async loadSound(key: string, url: string): Promise<void> {
    const res = await fetch(url);
    await this.loadBuffer(key, await res.arrayBuffer());
  }

  async loadBuffer(key: string, data: ArrayBuffer): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const decoded = await ctx.decodeAudioData(data);
    this.buffers.set(key, decoded);
  }

  playSfx(key: string, volume = 0.8, bus: AudioBus = 'sfx', pitch = 1.0): void {
    const ctx = this.ensureContext();
    const buf = this.buffers.get(key);
    const busNode = this.busGains[bus] ?? this.masterGain;
    if (!ctx || !buf || !busNode || this.activeVoices >= this.maxVoices) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.max(0.25, pitch);
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(busNode);
    this.activeVoices++;
    src.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    };
    src.start();
  }

  playSpatial(key: string, opts: SpatialPlayOptions): AudioBufferSourceNode | null {
    const ctx = this.ensureContext();
    const buf = this.buffers.get(key);
    const busNode = this.busGains[opts.bus ?? 'sfx'] ?? this.masterGain;
    if (!ctx || !buf || !busNode || this.activeVoices >= this.maxVoices) return null;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = opts.loop ?? false;
    src.playbackRate.value = Math.max(0.25, opts.pitch ?? 1.0);

    const panner = this.createPanner(
      ctx,
      opts.position,
      opts.refDistance ?? 2.0,
      opts.maxDistance ?? 40.0,
      opts.rolloff ?? 1.2
    );

    const gain = ctx.createGain();
    gain.gain.value = opts.volume ?? 1.0;

    src.connect(gain);
    gain.connect(panner);
    panner.connect(busNode);
    this.activeVoices++;
    src.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    };
    src.start();
    return src;
  }

  playToneSpatial(
    freq: number,
    durationSec: number,
    position: Vec3Tuple,
    type: OscillatorType = 'triangle',
    volume = 0.16,
    refDistance = 2.0,
    maxDistance = 32.0
  ): void {
    const ctx = this.ensureContext();
    const busNode = this.busGains.sfx ?? this.masterGain;
    if (!ctx || !busNode || this.activeVoices >= this.maxVoices) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const panner = this.createPanner(ctx, position, refDistance, maxDistance, 1.25);

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(Math.max(0.001, volume), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.01, durationSec));
    osc.connect(gain);
    gain.connect(panner);
    panner.connect(busNode);
    this.activeVoices++;
    osc.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    };
    osc.start(now);
    osc.stop(now + durationSec + 0.01);
  }

  playBgm(key: string, volume = 0.45, fadeSec = 0.6): void {
    const ctx = this.ensureContext();
    const buf = this.buffers.get(key);
    const musicBus = this.busGains.music;
    if (!ctx || !buf || !musicBus) return;
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
    musicBus.gain.setValueAtTime(0.001, now);
    musicBus.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), now + fadeSec);
    src.connect(musicBus);
    src.start(now);
    this.bgmSource = src;
  }

  playTone(
    freq: number,
    durationSec = 0.08,
    type: OscillatorType = 'triangle',
    volume = 0.14
  ): void {
    const ctx = this.ensureContext();
    const sfxBus = this.busGains.sfx ?? this.masterGain;
    if (!ctx || !sfxBus || this.activeVoices >= this.maxVoices) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(Math.max(0.001, volume), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.01, durationSec));
    osc.connect(gain);
    gain.connect(sfxBus);
    this.activeVoices++;
    osc.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    };
    osc.start(now);
    osc.stop(now + durationSec + 0.01);
  }

  /** Procedural 3D spatial collision impact sound routed to the `sfx` bus. */
  playImpact3D(
    position: Vec3Tuple,
    intensity = 0.8,
    material: 'wood' | 'stone' | 'metal' | 'soft' = 'stone'
  ): void {
    const level = Math.max(0, Math.min(1.5, intensity));
    if (level < 0.12) return;
    const ctx = this.ensureContext();
    const sfxBus = this.busGains.sfx ?? this.masterGain;
    if (!ctx || !sfxBus || this.activeVoices >= this.maxVoices - 1) return;

    const now = ctx.currentTime;
    const panner = this.createPanner(ctx, position, 2.5, 45.0, 1.25);
    panner.connect(sfxBus);

    // Filtered noise transient
    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoiseBuffer(ctx);
    noise.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = material === 'metal' ? 'bandpass' : 'lowpass';
    filter.frequency.setValueAtTime(
      material === 'metal' ? 1650 : material === 'wood' ? 780 : material === 'soft' ? 420 : 620,
      now
    );
    filter.Q.value = material === 'metal' ? 4.5 : 1.2;

    const nGain = ctx.createGain();
    const vol = Math.min(0.45, 0.07 + level * 0.24);
    const dur = material === 'metal' ? 0.24 : 0.14;
    nGain.gain.setValueAtTime(vol, now);
    nGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(panner);
    this.activeVoices++;
    noise.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    };
    noise.start(now, Math.random() * 1.2, dur + 0.02);

    // Low-end resonant body thump / metallic ring
    const osc = ctx.createOscillator();
    const oGain = ctx.createGain();
    osc.type = material === 'metal' ? 'triangle' : 'sine';
    const baseHz = material === 'metal' ? 480 + Math.random() * 180 : material === 'wood' ? 175 : 115;
    osc.frequency.setValueAtTime(baseHz, now);
    osc.frequency.exponentialRampToValueAtTime(material === 'metal' ? baseHz * 0.72 : 38, now + dur);
    oGain.gain.setValueAtTime(vol * 0.65, now);
    oGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(oGain);
    oGain.connect(panner);
    osc.start(now);
    osc.stop(now + dur + 0.01);
  }

  /** Procedural 3D spatial explosion boom routed to the `sfx` bus. */
  playExplosion3D(position: Vec3Tuple, intensity = 1.0): void {
    const ctx = this.ensureContext();
    const sfxBus = this.busGains.sfx ?? this.masterGain;
    if (!ctx || !sfxBus || this.activeVoices >= this.maxVoices - 1) return;

    const now = ctx.currentTime;
    const scale = Math.max(0.3, Math.min(1.6, intensity));
    const panner = this.createPanner(ctx, position, 5.0, 75.0, 1.0);
    panner.connect(sfxBus);

    const roar = ctx.createBufferSource();
    roar.buffer = this.getNoiseBuffer(ctx);
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.setValueAtTime(1600, now);
    lpf.frequency.exponentialRampToValueAtTime(95, now + 0.9);
    const rGain = ctx.createGain();
    rGain.gain.setValueAtTime(0.42 * scale, now);
    rGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.95);
    roar.connect(lpf);
    lpf.connect(rGain);
    rGain.connect(panner);
    this.activeVoices++;
    roar.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    };
    roar.start(now, 0, 1.0);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(115, now);
    sub.frequency.exponentialRampToValueAtTime(24, now + 0.55);
    const sGain = ctx.createGain();
    sGain.gain.setValueAtTime(0.5 * scale, now);
    sGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    sub.connect(sGain);
    sGain.connect(panner);
    sub.start(now);
    sub.stop(now + 0.62);
  }

  /** Procedural 3D water splash SFX routed to the `sfx` bus. */
  playSplash3D(position: Vec3Tuple, intensity = 1.0): void {
    const ctx = this.ensureContext();
    const sfxBus = this.busGains.sfx ?? this.masterGain;
    if (!ctx || !sfxBus || this.activeVoices >= this.maxVoices) return;

    const now = ctx.currentTime;
    const panner = this.createPanner(ctx, position, 3.0, 48.0, 1.15);
    panner.connect(sfxBus);

    const splash = ctx.createBufferSource();
    splash.buffer = this.getNoiseBuffer(ctx);
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.Q.value = 1.1;
    bpf.frequency.setValueAtTime(1750, now);
    bpf.frequency.exponentialRampToValueAtTime(420, now + 0.42);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.4, 0.18 * intensity), now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.44);
    splash.connect(bpf);
    bpf.connect(g);
    g.connect(panner);
    this.activeVoices++;
    splash.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    };
    splash.start(now, Math.random() * 0.8, 0.46);
  }

  /** Continuous procedural rain loop on `ambient` bus; ramps gain smoothly from `0..1+`. */
  setRainAmbience(intensity: number): void {
    const target = Math.max(0, Math.min(1, intensity)) * 0.22;
    if (!this.ctx) {
      // Avoid waking AudioContext solely because rainIntensity == 0 before user gesture
      return;
    }
    const ctx = this.ctx;
    const ambientBus = this.busGains.ambient ?? this.masterGain;
    if (!ambientBus) return;
    if (!this.rainGain || !this.rainSource) {
      if (target <= 0.002) return;
      const src = ctx.createBufferSource();
      src.buffer = this.getNoiseBuffer(ctx);
      src.loop = true;
      const bpf = ctx.createBiquadFilter();
      bpf.type = 'bandpass';
      bpf.frequency.value = 1150;
      bpf.Q.value = 0.65;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      src.connect(bpf);
      bpf.connect(gain);
      gain.connect(ambientBus);
      src.start();
      this.rainSource = src;
      this.rainGain = gain;
    }
    this.rainGain.gain.setTargetAtTime(Math.max(0.0001, target), ctx.currentTime, 0.25);
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
    if (this.rainSource) {
      try {
        this.rainSource.stop();
      } catch {
        // ignore
      }
      this.rainSource = null;
      this.rainGain = null;
    }
    this.noiseBuffer = null;
    this.buffers.clear();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
      this.masterGain = null;
      this.busGains = { master: null, sfx: null, music: null, ambient: null };
    }
  }
}
