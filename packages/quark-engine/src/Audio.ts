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
  private readonly buffers = new Map<string, AudioBuffer>();
  private activeVoices = 0;
  private readonly maxVoices = 24;

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

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = opts.refDistance ?? 2.0;
    panner.maxDistance = opts.maxDistance ?? 40.0;
    panner.rolloffFactor = opts.rolloff ?? 1.2;
    panner.positionX.value = opts.position[0];
    panner.positionY.value = opts.position[1];
    panner.positionZ.value = opts.position[2];

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
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = 1.25;
    panner.positionX.value = position[0];
    panner.positionY.value = position[1];
    panner.positionZ.value = position[2];

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
      this.masterGain = null;
      this.busGains = { master: null, sfx: null, music: null, ambient: null };
    }
  }
}
