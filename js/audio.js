// 全部音效由 WebAudio 现场合成,无外部音频资源;每个声音都对应一个可见事件。
export class SoundKit {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.master = null;
  }

  _ensure() {
    if (!this.enabled) return null;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  _noise(ctx, dur) {
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  _env(ctx, peak, t0, a, d) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    g.connect(this.master);
    return g;
  }

  shutter() {
    const ctx = this._ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [dt, freq, peak] of [[0, 2600, 0.4], [0.09, 1500, 0.3]]) {
      const n = this._noise(ctx, 0.05);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = 1.2;
      n.connect(bp).connect(this._env(ctx, peak, t + dt, 0.004, 0.05));
      n.start(t + dt);
      n.stop(t + dt + 0.08);
    }
  }

  reveal() {
    const ctx = this._ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const n = this._noise(ctx, 1.1);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(240, t);
    lp.frequency.exponentialRampToValueAtTime(1600, t + 0.85);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.05);
    n.connect(lp).connect(g).connect(this.master);
    n.start(t);
    n.stop(t + 1.1);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(340, t + 0.9);
    o.connect(this._env(ctx, 0.1, t, 0.25, 0.75));
    o.start(t);
    o.stop(t + 1.1);
  }

  tick() {
    const ctx = this._ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 880;
    o.connect(this._env(ctx, 0.16, t, 0.005, 0.07));
    o.start(t);
    o.stop(t + 0.1);
  }

  blip() {
    const ctx = this._ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    [660, 990].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.connect(this._env(ctx, 0.18, t + i * 0.09, 0.008, 0.12));
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.16);
    });
  }

  deny() {
    const ctx = this._ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 150;
    o.connect(this._env(ctx, 0.12, t, 0.01, 0.14));
    o.start(t);
    o.stop(t + 0.18);
  }
}