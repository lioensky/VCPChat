const NOTE = {
  C2: 65.41,
  D2: 73.42,
  Eb2: 77.78,
  E2: 82.41,
  F2: 87.31,
  G2: 98.00,
  Ab2: 103.83,
  A2: 110.00,
  Bb2: 116.54,
  B2: 123.47,
  C3: 130.81,
  D3: 146.83,
  Eb3: 155.56,
  E3: 164.81,
  F3: 174.61,
  G3: 196.00,
  Ab3: 207.65,
  A3: 220.00,
  Bb3: 233.08,
  B3: 246.94,
  C4: 261.63,
  D4: 293.66,
  Eb4: 311.13,
  E4: 329.63,
  F4: 349.23,
  G4: 392.00,
  Ab4: 415.30,
  A4: 440.00,
  Bb4: 466.16,
  B4: 493.88,
  C5: 523.25,
  D5: 587.33,
  Eb5: 622.25,
  E5: 659.25,
  F5: 698.46,
  G5: 783.99,
  A5: 880.00,
};

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.enabled = true;
    this.musicEnabled = true;
    this.sfxEnabled = true;
    this.started = false;
    this.nextStepTime = 0;
    this.step = 0;
    this.tempo = 168;
    this.lookaheadTimer = null;
    this.recent = new Map();

    this.bass = [
      "C2", "C2", "G2", "C3", "Bb2", "C3", "G2", "C2",
      "Ab2", "Ab2", "Eb3", "Ab2", "Bb2", "C3", "Bb2", "G2",
      "F2", "F2", "C3", "F2", "Ab2", "Bb2", "C3", "Eb3",
      "G2", "G2", "D3", "G2", "Bb2", "C3", "D3", "G3",
    ];

    this.lead = [
      "C5", "G4", "C5", "Eb5", "G5", "Eb5", "C5", "Bb4",
      "C5", "Eb5", "G5", "A5", "G5", "Eb5", "D5", "C5",
      "Bb4", "C5", "Eb5", "F5", "G5", "F5", "Eb5", "C5",
      "D5", "Eb5", "G5", "A5", "G5", "D5", "Eb5", "G5",
    ];

    this.arp = ["C4", "Eb4", "G4", "C5", "Eb5", "C5", "G4", "Eb4", "Bb3", "D4", "F4", "Bb4", "D5", "Bb4", "F4", "D4"];
  }

  ensure() {
    if (this.ctx) return;

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      this.enabled = false;
      return;
    }

    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();

    this.master.gain.value = 0.74;
    this.musicGain.gain.value = 0.24;
    this.sfxGain.gain.value = 0.44;

    this.musicGain.connect(this.master);
    this.sfxGain.connect(this.master);
    this.master.connect(this.ctx.destination);
  }

  async start() {
    this.ensure();
    if (!this.ctx || !this.enabled) return;

    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }

    if (!this.started) {
      this.started = true;
      this.nextStepTime = this.ctx.currentTime + 0.04;
      this.step = 0;
      this.lookaheadTimer = window.setInterval(() => this.scheduleLoop(), 80);
    }
  }

  stop() {
    if (this.lookaheadTimer) {
      window.clearInterval(this.lookaheadTimer);
      this.lookaheadTimer = null;
    }
    this.started = false;
  }

  toggleAll() {
    this.enabled = !this.enabled;
    if (this.master) {
      this.master.gain.setTargetAtTime(this.enabled ? 0.74 : 0.0001, this.ctx.currentTime, 0.02);
    }
    if (this.enabled) {
      this.start();
    }
    return this.enabled;
  }

  toggleMusic() {
    this.musicEnabled = !this.musicEnabled;
    if (this.musicGain) {
      this.musicGain.gain.setTargetAtTime(this.musicEnabled ? 0.24 : 0.0001, this.ctx.currentTime, 0.02);
    }
    return this.musicEnabled;
  }

  toggleSfx() {
    this.sfxEnabled = !this.sfxEnabled;
    if (this.sfxGain) {
      this.sfxGain.gain.setTargetAtTime(this.sfxEnabled ? 0.44 : 0.0001, this.ctx.currentTime, 0.02);
    }
    return this.sfxEnabled;
  }

  scheduleLoop() {
    if (!this.ctx || !this.enabled || !this.musicEnabled) return;

    const stepDuration = 60 / this.tempo / 2;
    const scheduleAhead = 0.28;

    while (this.nextStepTime < this.ctx.currentTime + scheduleAhead) {
      this.scheduleStep(this.step, this.nextStepTime, stepDuration);
      this.nextStepTime += stepDuration;
      this.step = (this.step + 1) % 32;
    }
  }

  scheduleStep(step, time, stepDuration) {
    const bassNote = this.bass[step % this.bass.length];
    const leadNote = this.lead[step % this.lead.length];
    const arpNote = this.arp[step % this.arp.length];

    if (bassNote) {
      const bassVolume = step % 4 === 0 ? 0.30 : 0.20;
      this.tone(NOTE[bassNote], time, stepDuration * 0.86, "square", bassVolume, this.musicGain, 0.004, 0.045);
      if (step % 8 === 0) {
        this.tone(NOTE[bassNote] / 2, time, stepDuration * 1.6, "sawtooth", 0.12, this.musicGain, 0.012, 0.18);
      }
    }

    if (leadNote) {
      const leadVolume = step % 8 === 6 ? 0.15 : 0.105;
      this.tone(NOTE[leadNote], time + 0.006, stepDuration * 0.66, "square", leadVolume, this.musicGain, 0.002, 0.035);
      if (step % 4 === 2 || step % 8 === 7) {
        this.tone(NOTE[leadNote] * 2, time + 0.01, stepDuration * 0.34, "square", 0.04, this.musicGain, 0.002, 0.025, 8);
      }
    }

    this.tone(NOTE[arpNote], time + stepDuration * 0.52, stepDuration * 0.26, "triangle", 0.05, this.musicGain, 0.002, 0.024);

    if (step % 4 === 0) {
      this.noise(time, 0.05, 0.072, 760, 0.26);
    }

    if (step % 4 === 2) {
      this.noise(time, 0.038, 0.052, 5200, 0.14);
    }

    if (step % 2 === 1) {
      this.noise(time + stepDuration * 0.48, 0.018, 0.026, 6500, 0.08);
    }

    if (step % 16 === 15) {
      this.noise(time + stepDuration * 0.25, 0.09, 0.048, 3000, 0.32);
    }
  }

  tone(freq, start, duration, type, volume, destination, attack = 0.004, release = 0.05, detune = 0) {
    if (!this.ctx || !this.enabled) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    osc.detune.setValueAtTime(detune, start);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + attack);
    gain.gain.setValueAtTime(volume, Math.max(start + attack, start + duration - release));
    gain.gain.linearRampToValueAtTime(0.0001, start + duration);

    osc.connect(gain);
    gain.connect(destination);

    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  noise(start, duration, volume, cutoff = 1600, resonance = 0.1) {
    if (!this.ctx || !this.enabled) return;

    const sampleRate = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    }

    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    filter.type = "highpass";
    filter.frequency.value = cutoff;
    filter.Q.value = resonance;

    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    source.buffer = buffer;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.musicGain);

    source.start(start);
    source.stop(start + duration);
  }

  sfx(name) {
    if (!this.sfxEnabled || !this.enabled) return;
    this.ensure();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const last = this.recent.get(name) || 0;
    const cooldown = name === "shoot" ? 0.045 : name === "hit" ? 0.025 : 0.08;
    if (now - last < cooldown) return;
    this.recent.set(name, now);

    if (name === "shoot") {
      this.tone(880, now, 0.045, "square", 0.045, this.sfxGain, 0.001, 0.025);
      this.tone(1320, now + 0.006, 0.035, "square", 0.025, this.sfxGain, 0.001, 0.02);
      return;
    }

    if (name === "hit") {
      this.tone(180, now, 0.055, "sawtooth", 0.052, this.sfxGain, 0.001, 0.04);
      return;
    }

    if (name === "xp") {
      this.tone(660, now, 0.04, "triangle", 0.055, this.sfxGain, 0.001, 0.02);
      this.tone(990, now + 0.035, 0.05, "triangle", 0.04, this.sfxGain, 0.001, 0.03);
      return;
    }

    if (name === "level") {
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        this.tone(freq, now + i * 0.055, 0.12, "square", 0.075, this.sfxGain, 0.002, 0.05);
      });
      return;
    }

    if (name === "buff") {
      [392, 523.25, 783.99].forEach((freq, i) => {
        this.tone(freq, now + i * 0.04, 0.16, "triangle", 0.075, this.sfxGain, 0.002, 0.06);
      });
      return;
    }

    if (name === "elite") {
      this.tone(98, now, 0.42, "sawtooth", 0.08, this.sfxGain, 0.01, 0.22);
      this.tone(196, now + 0.08, 0.32, "square", 0.055, this.sfxGain, 0.01, 0.18);
      return;
    }

    if (name === "fusion") {
      [261.63, 392, 523.25, 783.99, 1046.5].forEach((freq, i) => {
        this.tone(freq, now + i * 0.045, 0.22, i % 2 ? "square" : "triangle", 0.085, this.sfxGain, 0.002, 0.08);
      });
      return;
    }

    if (name === "hurt") {
      this.tone(150, now, 0.16, "sawtooth", 0.1, this.sfxGain, 0.002, 0.09);
      this.noise(now, 0.08, 0.04, 600, 0.4);
      return;
    }

    if (name === "dead") {
      [392, 330, 262, 196, 98].forEach((freq, i) => {
        this.tone(freq, now + i * 0.09, 0.22, "square", 0.085, this.sfxGain, 0.002, 0.11);
      });
    }
  }
}