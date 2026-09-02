const SOUND_ROOT = '/assets/dice-box/sounds';

const createNumberedFiles = (directory, prefix, count) => Array.from(
    { length: count },
    (_, index) => `${SOUND_ROOT}/${directory}/${prefix}${index + 1}.mp3`
);

const SOUND_BANKS = Object.freeze({
    dicehit: Object.freeze({
        plastic: createNumberedFiles('dicehit', 'dicehit_plastic', 15),
        metal: createNumberedFiles('dicehit', 'dicehit_metal', 12),
        wood: createNumberedFiles('dicehit', 'dicehit_wood', 12),
        coin: createNumberedFiles('dicehit', 'dicehit_coin', 6)
    }),
    surface: Object.freeze({
        felt: createNumberedFiles('surfaces', 'surface_felt', 7),
        metal: createNumberedFiles('surfaces', 'surface_metal', 9),
        woodTable: createNumberedFiles('surfaces', 'surface_wood_table', 7),
        woodTray: createNumberedFiles('surfaces', 'surface_wood_tray', 7)
    })
});

const THEME_SOUND_PROFILES = Object.freeze({
    default: { dicehit: 'plastic', surface: 'felt', pitch: 1 },
    gemstone: { dicehit: 'coin', surface: 'woodTray', pitch: 1.08 },
    rock: { dicehit: 'wood', surface: 'woodTray', pitch: 0.82 },
    rust: { dicehit: 'metal', surface: 'metal', pitch: 0.88 },
    smooth: { dicehit: 'plastic', surface: 'felt', pitch: 1.04 },
    blueGreenMetal: { dicehit: 'metal', surface: 'metal', pitch: 0.92 },
    diceOfRolling: { dicehit: 'plastic', surface: 'woodTray', pitch: 0.98 },
    gemstoneMarble: { dicehit: 'coin', surface: 'woodTray', pitch: 1.02 },
    wooden: { dicehit: 'wood', surface: 'woodTable', pitch: 0.94 }
});

const MAGIC_SOUND_PROFILES = Object.freeze({
    normal: { energy: 1, tempo: 1, pitch: 1 },
    moon: { energy: 0.72, tempo: 0.62, pitch: 0.88 },
    storm: { energy: 1.25, tempo: 1.55, pitch: 1.08 },
    lead: { energy: 1.16, tempo: 0.76, pitch: 0.74 },
    bounce: { energy: 1.2, tempo: 1.32, pitch: 1.14 }
});

const randomItem = (items) => items[Math.floor(Math.random() * items.length)];
const randomBetween = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class DiceSoundscape {
    constructor({ volume = 0.46, maxConcurrent = 7 } = {}) {
        this.volume = clamp(volume, 0, 1);
        this.maxConcurrent = maxConcurrent;
        this.context = null;
        this.masterGain = null;
        this.bufferCache = new Map();
        this.activeSources = new Set();
        this.timer = null;
        this.generation = 0;
        this.startedAt = 0;
        this.initialDiceCount = 1;
        this.remainingDice = 1;
        this.profile = THEME_SOUND_PROFILES.default;
        this.magicProfile = MAGIC_SOUND_PROFILES.normal;
        this.running = false;
        this.unlocked = false;

        const unlock = () => {
            this.ensureContext().then(() => {
                this.unlocked = true;
            }).catch(() => {});
        };

        document.addEventListener('pointerdown', unlock, { once: true, passive: true });
        document.addEventListener('keydown', unlock, { once: true });
    }

    async ensureContext() {
        if (!this.context) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) throw new Error('Web Audio API is unavailable.');

            this.context = new AudioContextClass();
            this.masterGain = this.context.createGain();
            this.masterGain.gain.value = this.volume;
            this.masterGain.connect(this.context.destination);
        }

        if (this.context.state === 'suspended') {
            await this.context.resume();
        }

        return this.context;
    }

    setVolume(volume) {
        this.volume = clamp(Number(volume) || 0, 0, 1);
        if (this.masterGain) {
            this.masterGain.gain.setTargetAtTime(
                this.volume,
                this.context.currentTime,
                0.025
            );
        }
    }

    getProfile(theme) {
        return THEME_SOUND_PROFILES[theme] || THEME_SOUND_PROFILES.default;
    }

    getMagicProfile(magic) {
        return MAGIC_SOUND_PROFILES[magic] || MAGIC_SOUND_PROFILES.normal;
    }

    async loadBuffer(url) {
        if (!this.bufferCache.has(url)) {
            const promise = fetch(url)
                .then((response) => {
                    if (!response.ok) {
                        throw new Error(`Unable to load sound: ${response.status}`);
                    }
                    return response.arrayBuffer();
                })
                .then((arrayBuffer) => this.ensureContext()
                    .then((context) => context.decodeAudioData(arrayBuffer)))
                .catch((error) => {
                    this.bufferCache.delete(url);
                    console.warn('[DiceSoundscape] Sound load failed:', url, error);
                    return null;
                });

            this.bufferCache.set(url, promise);
        }

        return this.bufferCache.get(url);
    }

    preload(theme = 'default') {
        const profile = this.getProfile(theme);
        const candidates = [
            ...SOUND_BANKS.dicehit[profile.dicehit].slice(0, 3),
            ...SOUND_BANKS.surface[profile.surface].slice(0, 3)
        ];

        candidates.forEach((url) => {
            this.loadBuffer(url);
        });
    }

    async playSample(group, {
        gain = 0.5,
        pitch = 1,
        pan = 0,
        allowWhenStopped = false
    } = {}) {
        if (this.activeSources.size >= this.maxConcurrent || gain <= 0.01) return;

        const files = SOUND_BANKS[group.type]?.[group.name];
        if (!files?.length) return;

        try {
            const context = await this.ensureContext();
            const buffer = await this.loadBuffer(randomItem(files));
            if (!buffer || (!this.running && !allowWhenStopped)) return;

            const source = context.createBufferSource();
            const sourceGain = context.createGain();
            const panner = typeof context.createStereoPanner === 'function'
                ? context.createStereoPanner()
                : null;

            source.buffer = buffer;
            source.playbackRate.value = clamp(
                pitch * randomBetween(0.92, 1.08),
                0.55,
                1.65
            );
            sourceGain.gain.value = clamp(gain, 0.015, 0.9);

            source.connect(sourceGain);
            if (panner) {
                panner.pan.value = clamp(pan, -0.85, 0.85);
                sourceGain.connect(panner);
                panner.connect(this.masterGain);
            } else {
                sourceGain.connect(this.masterGain);
            }

            this.activeSources.add(source);
            source.addEventListener('ended', () => {
                this.activeSources.delete(source);
                source.disconnect();
                sourceGain.disconnect();
                panner?.disconnect();
            }, { once: true });
            source.start();
        } catch (error) {
            console.warn('[DiceSoundscape] Unable to play collision sound:', error);
        }
    }

    start({
        theme = 'default',
        magic = 'normal',
        diceCount = 1
    } = {}) {
        this.stop({ allowTail: true });

        this.generation += 1;
        this.running = true;
        this.startedAt = performance.now();
        this.initialDiceCount = clamp(Math.round(diceCount) || 1, 1, 100);
        this.remainingDice = this.initialDiceCount;
        this.profile = this.getProfile(theme);
        this.magicProfile = this.getMagicProfile(magic);

        this.preload(theme);
        this.playImpactBurst();
        this.scheduleNext(this.generation);
    }

    playImpactBurst() {
        const countWeight = clamp(Math.log2(this.initialDiceCount + 1) / 3, 0.3, 1);
        const energy = this.magicProfile.energy;

        this.playSample(
            { type: 'surface', name: this.profile.surface },
            {
                gain: 0.32 * energy + 0.2 * countWeight,
                pitch: this.profile.pitch * this.magicProfile.pitch,
                pan: randomBetween(-0.22, 0.22)
            }
        );

        if (this.initialDiceCount > 1) {
            window.setTimeout(() => {
                if (!this.running) return;
                this.playSample(
                    { type: 'dicehit', name: this.profile.dicehit },
                    {
                        gain: 0.22 * energy * countWeight,
                        pitch: this.profile.pitch * this.magicProfile.pitch,
                        pan: randomBetween(-0.55, 0.55)
                    }
                );
            }, 55);
        }
    }

    getCurrentEnergy() {
        const elapsed = performance.now() - this.startedAt;
        const timeDecay = Math.exp(-elapsed / 2450);
        const remainingRatio = this.remainingDice / this.initialDiceCount;
        const activity = 0.3 + remainingRatio * 0.7;

        return clamp(
            timeDecay * activity * this.magicProfile.energy,
            0.035,
            1.3
        );
    }

    scheduleNext(generation) {
        if (!this.running || generation !== this.generation) return;

        const energy = this.getCurrentEnergy();
        const diceDensity = clamp(Math.log2(this.initialDiceCount + 1), 1, 5);
        const tempo = this.magicProfile.tempo;
        const minimumDelay = 52 / tempo;
        const maximumDelay = (390 + (1 - Math.min(energy, 1)) * 760) / tempo;
        const delay = randomBetween(minimumDelay, maximumDelay)
            / Math.sqrt(diceDensity);

        this.timer = window.setTimeout(() => {
            if (!this.running || generation !== this.generation) return;

            const currentEnergy = this.getCurrentEnergy();
            const surfaceChance = 0.58 + (1 - Math.min(currentEnergy, 1)) * 0.2;
            const isSurfaceHit = Math.random() < surfaceChance;
            const group = isSurfaceHit
                ? { type: 'surface', name: this.profile.surface }
                : { type: 'dicehit', name: this.profile.dicehit };
            const baseGain = isSurfaceHit ? 0.34 : 0.24;
            const quietVariation = randomBetween(0.55, 1);

            this.playSample(group, {
                gain: baseGain * currentEnergy * quietVariation,
                pitch: this.profile.pitch * this.magicProfile.pitch,
                pan: randomBetween(-0.78, 0.78)
            });

            this.scheduleNext(generation);
        }, delay);
    }

    onDieComplete() {
        this.remainingDice = Math.max(0, this.remainingDice - 1);

        if (!this.running) return;

        const energy = this.getCurrentEnergy();
        if (energy > 0.12 && Math.random() < 0.72) {
            this.playSample(
                { type: 'surface', name: this.profile.surface },
                {
                    gain: 0.16 * energy,
                    pitch: this.profile.pitch * this.magicProfile.pitch * 0.96,
                    pan: randomBetween(-0.5, 0.5)
                }
            );
        }
    }

    complete() {
        if (!this.running) return;

        const finalEnergy = this.getCurrentEnergy();
        const finalProfile = this.profile;
        const finalMagicProfile = this.magicProfile;

        this.stop({ allowTail: true });

        if (finalEnergy > 0.06) {
            this.playSample(
                { type: 'surface', name: finalProfile.surface },
                {
                    gain: clamp(0.09 + finalEnergy * 0.08, 0.08, 0.2),
                    pitch: finalProfile.pitch * finalMagicProfile.pitch * 0.9,
                    pan: randomBetween(-0.22, 0.22),
                    allowWhenStopped: true
                }
            );
        }
    }

    stop({ allowTail = true } = {}) {
        this.running = false;
        this.generation += 1;

        if (this.timer) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }

        if (!allowTail) {
            this.activeSources.forEach((source) => {
                try {
                    source.stop();
                } catch {
                    // 音源可能已自然结束。
                }
            });
            this.activeSources.clear();
        }
    }
}