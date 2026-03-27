/**
 * VCPdesktop - 全局样式自动化引擎
 * 负责：按固定频率拉取 desktop-metrics 快照，并将指标值映射为全局样式（CSS 变量 / 壁纸滤镜）
 *
 * 设计目标：
 * - 只接受结构化配置（避免任意 JS/CSS 注入）
 * - 运行时覆盖（可持久化配置，但不持久化“实时输出值”）
 * - 通过 DesktopRemote 命令远程启停/查询
 */

'use strict';

(function () {
    const { state } = window.VCPDesktop;

    const DEFAULT_CONFIG = {
        enabled: false,
        intervalMs: 2000,
        metricsOptions: {},
        rules: [],
    };

    const SAFE_INTERVAL_MIN_MS = 250;
    const SAFE_INTERVAL_MAX_MS = 60000;

    const CSS_VAR_NAME_RE = /^--desktop-[a-z0-9-]{1,64}$/i;
    const CSS_UNIT_RE = /^[a-z%]{0,10}$/i;

    let initialized = false;
    let running = false;
    let timer = null;

    let config = { ...DEFAULT_CONFIG };
    let lastRunAt = null;
    let lastError = null;

    const baseline = {
        cssVars: new Map(), // name -> { value, priority }
        wallpaper: null,    // { filter, opacity }
    };

    function clampNumber(value, min, max) {
        if (typeof value !== 'number' || !isFinite(value)) return null;
        return Math.min(max, Math.max(min, value));
    }

    function roundTo(value, digits) {
        if (typeof value !== 'number' || !isFinite(value)) return null;
        const d = Number.isFinite(digits) ? digits : 0;
        const base = Math.pow(10, Math.min(6, Math.max(0, d)));
        return Math.round(value * base) / base;
    }

    function deepCloneJson(value) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (err) {
            return null;
        }
    }

    function getByPath(obj, path) {
        const rawPath = String(path || '').trim();
        if (!rawPath) return undefined;
        const segments = rawPath.split('.').map((seg) => seg.trim()).filter(Boolean);
        let cursor = obj;
        for (const seg of segments) {
            if (cursor === null || cursor === undefined) return undefined;
            cursor = cursor[seg];
        }
        return cursor;
    }

    function normalizeIntervalMs(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return DEFAULT_CONFIG.intervalMs;
        return Math.round(Math.min(SAFE_INTERVAL_MAX_MS, Math.max(SAFE_INTERVAL_MIN_MS, num)));
    }

    function normalizeCssVarName(name) {
        const raw = String(name || '').trim();
        if (!CSS_VAR_NAME_RE.test(raw)) {
            throw new Error(`cssVar 名称不合法: ${raw || '(empty)'}`);
        }
        return raw;
    }

    function normalizeUnit(unit) {
        const raw = String(unit || '').trim();
        if (!CSS_UNIT_RE.test(raw)) {
            throw new Error(`单位不合法: ${raw || '(empty)'}`);
        }
        return raw;
    }

    function sanitizeRule(rule) {
        if (!rule || typeof rule !== 'object') {
            throw new Error('规则必须为对象');
        }

        const id = String(rule.id || '').trim();
        if (!id) {
            throw new Error('规则缺少 id');
        }

        const sourcePath = String(rule.sourcePath || '').trim();
        if (!sourcePath) {
            throw new Error(`规则 '${id}' 缺少 sourcePath`);
        }

        const map = rule.map && typeof rule.map === 'object' ? rule.map : null;
        if (!map) {
            throw new Error(`规则 '${id}' 缺少 map`);
        }

        const inMin = Number(map.inMin);
        const inMax = Number(map.inMax);
        const outMin = Number(map.outMin);
        const outMax = Number(map.outMax);
        if (![inMin, inMax, outMin, outMax].every((v) => Number.isFinite(v))) {
            throw new Error(`规则 '${id}' map.inMin/inMax/outMin/outMax 必须为数值`);
        }

        const clamp = map.clamp !== false;
        const roundDigits = map.round === undefined ? null : clampNumber(Number(map.round), 0, 6);

        const target = rule.target && typeof rule.target === 'object' ? rule.target : null;
        if (!target) {
            throw new Error(`规则 '${id}' 缺少 target`);
        }

        const targetType = String(target.type || '').trim();
        if (!targetType) {
            throw new Error(`规则 '${id}' target.type 缺失`);
        }

        if (targetType === 'cssVar') {
            const name = normalizeCssVarName(target.name);
            const unit = normalizeUnit(target.unit || '');
            const targetRound = target.round === undefined ? null : clampNumber(Number(target.round), 0, 6);
            const priorityRaw = String(target.priority || '').trim().toLowerCase();
            const priority = priorityRaw === 'important' ? 'important' : '';

            return {
                id,
                enabled: rule.enabled !== false,
                sourcePath,
                map: { inMin, inMax, outMin, outMax, clamp, round: roundDigits },
                target: {
                    type: 'cssVar',
                    name,
                    unit,
                    round: targetRound,
                    priority,
                },
            };
        }

        if (targetType === 'wallpaper') {
            const name = String(target.name || '').trim();
            if (!['blur', 'brightness', 'opacity'].includes(name)) {
                throw new Error(`规则 '${id}' wallpaper 目标不支持: ${name || '(empty)'}`);
            }

            const targetRound = target.round === undefined ? null : clampNumber(Number(target.round), 0, 6);
            return {
                id,
                enabled: rule.enabled !== false,
                sourcePath,
                map: { inMin, inMax, outMin, outMax, clamp, round: roundDigits },
                target: {
                    type: 'wallpaper',
                    name,
                    round: targetRound,
                },
            };
        }

        throw new Error(`规则 '${id}' target.type 不支持: ${targetType}`);
    }

    function sanitizeConfigPatch(patch) {
        if (!patch || typeof patch !== 'object') {
            throw new Error('configPatch 必须为对象');
        }

        const next = {};
        if ('enabled' in patch) next.enabled = !!patch.enabled;
        if ('intervalMs' in patch) next.intervalMs = normalizeIntervalMs(patch.intervalMs);
        if ('metricsOptions' in patch) {
            next.metricsOptions = patch.metricsOptions && typeof patch.metricsOptions === 'object' ? deepCloneJson(patch.metricsOptions) || {} : {};
        }
        if ('rules' in patch) {
            if (!Array.isArray(patch.rules)) {
                throw new Error('rules 必须为数组');
            }
            next.rules = patch.rules.map(sanitizeRule);
        }
        return next;
    }

    function applyConfigPatch(patch) {
        const sanitized = sanitizeConfigPatch(patch);
        config = {
            ...config,
            ...sanitized,
            metricsOptions: sanitized.metricsOptions !== undefined ? sanitized.metricsOptions : config.metricsOptions,
            rules: sanitized.rules !== undefined ? sanitized.rules : config.rules,
        };
        return config;
    }

    function captureCssVarBaseline(name) {
        if (baseline.cssVars.has(name)) return;
        const style = document.documentElement?.style;
        if (!style) return;
        baseline.cssVars.set(name, {
            value: style.getPropertyValue(name),
            priority: style.getPropertyPriority(name) || '',
        });
    }

    function captureWallpaperBaseline() {
        if (baseline.wallpaper) return;
        const layer = document.getElementById('desktop-wallpaper-layer');
        if (!layer) {
            baseline.wallpaper = { filter: '', opacity: '' };
            return;
        }
        baseline.wallpaper = {
            filter: layer.style.filter || '',
            opacity: layer.style.opacity || '',
        };
    }

    function restoreBaselines() {
        // CSS 变量
        const rootStyle = document.documentElement?.style;
        if (rootStyle) {
            baseline.cssVars.forEach((item, name) => {
                if (name === '--desktop-dock-icon-size') {
                    const size = Number(state.globalSettings?.dock?.iconSize);
                    if (Number.isFinite(size) && size > 0) {
                        rootStyle.setProperty(name, `${Math.round(size)}px`);
                        return;
                    }
                }

                if (name === '--desktop-shortcut-icon-size') {
                    const size = Number(state.globalSettings?.desktopIcon?.iconSize);
                    if (Number.isFinite(size) && size > 0) {
                        rootStyle.setProperty(name, `${Math.round(size)}px`);
                        return;
                    }
                }

                if (item && typeof item.value === 'string' && item.value.length > 0) {
                    rootStyle.setProperty(name, item.value, item.priority || '');
                } else {
                    rootStyle.removeProperty(name);
                }
            });
        }

        // 壁纸滤镜
        const layer = document.getElementById('desktop-wallpaper-layer');
        if (layer && baseline.wallpaper) {
            const wp = state.globalSettings?.wallpaper;
            if (wp && typeof wp === 'object') {
                const blur = Number(wp.blur);
                const brightness = Number(wp.brightness);
                const opacity = Number(wp.opacity);
                applyWallpaperOverrides({
                    blur: Number.isFinite(blur) ? blur : 0,
                    brightness: Number.isFinite(brightness) ? brightness : 1,
                    opacity: Number.isFinite(opacity) ? opacity : 1,
                });
            } else {
                layer.style.filter = baseline.wallpaper.filter || '';
                layer.style.opacity = baseline.wallpaper.opacity || '';
            }
        }
    }

    function mapValue(inputValue, map) {
        const value = Number(inputValue);
        if (!Number.isFinite(value)) return null;

        const inMin = map.inMin;
        const inMax = map.inMax;
        const outMin = map.outMin;
        const outMax = map.outMax;

        if (inMax === inMin) {
            return outMin;
        }

        let t = (value - inMin) / (inMax - inMin);
        if (map.clamp !== false) {
            t = Math.min(1, Math.max(0, t));
        }
        let out = outMin + t * (outMax - outMin);

        if (map.round !== null && map.round !== undefined) {
            out = roundTo(out, map.round);
        }
        return out;
    }

    function applyCssVarTarget(target, numericValue) {
        const rootStyle = document.documentElement?.style;
        if (!rootStyle) return false;

        const name = target.name;
        captureCssVarBaseline(name);

        let value = numericValue;
        const finalRound = target.round;
        if (finalRound !== null && finalRound !== undefined) {
            value = roundTo(value, finalRound);
        }
        if (value === null) return false;

        const unit = target.unit || '';
        rootStyle.setProperty(name, `${value}${unit}`, target.priority || '');
        return true;
    }

    function applyWallpaperTarget(target, numericValue, wallpaperOverrides) {
        captureWallpaperBaseline();
        if (!wallpaperOverrides) return false;

        let value = numericValue;
        const finalRound = target.round;
        if (finalRound !== null && finalRound !== undefined) {
            value = roundTo(value, finalRound);
        }
        if (value === null) return false;

        if (target.name === 'blur') {
            wallpaperOverrides.blur = Math.max(0, value);
        } else if (target.name === 'brightness') {
            wallpaperOverrides.brightness = Math.max(0, value);
        } else if (target.name === 'opacity') {
            wallpaperOverrides.opacity = Math.min(1, Math.max(0, value));
        }

        return true;
    }

    function applyWallpaperOverrides(overrides) {
        const layer = document.getElementById('desktop-wallpaper-layer');
        if (!layer) return;

        const base = state.globalSettings?.wallpaper && typeof state.globalSettings.wallpaper === 'object'
            ? state.globalSettings.wallpaper
            : {};
        const baseBlurRaw = Number(base.blur);
        const baseBrightnessRaw = Number(base.brightness);
        const baseOpacityRaw = Number(base.opacity);
        const baseBlur = Number.isFinite(baseBlurRaw) ? Math.max(0, baseBlurRaw) : 0;
        const baseBrightness = Number.isFinite(baseBrightnessRaw) ? Math.max(0, baseBrightnessRaw) : 1;
        const baseOpacity = Number.isFinite(baseOpacityRaw) ? Math.min(1, Math.max(0, baseOpacityRaw)) : 1;

        const blur = overrides.blur !== undefined ? overrides.blur : baseBlur;
        const brightness = overrides.brightness !== undefined ? overrides.brightness : baseBrightness;
        const opacity = overrides.opacity !== undefined ? overrides.opacity : baseOpacity;

        const filters = [];
        if (typeof blur === 'number' && blur > 0) {
            filters.push(`blur(${blur}px)`);
        }
        if (typeof brightness === 'number' && brightness !== 1) {
            filters.push(`brightness(${brightness})`);
        }

        if (filters.length > 0) {
            layer.style.filter = filters.join(' ');
        } else {
            layer.style.filter = '';
        }

        if (typeof opacity === 'number') {
            layer.style.opacity = String(opacity);
        }
    }

    async function tick() {
        lastRunAt = new Date().toISOString();

        const metrics = window.VCPDesktop?.metrics;
        if (!metrics || typeof metrics.getSnapshot !== 'function') {
            lastError = 'metrics.getSnapshot 不可用';
            return;
        }

        const snapshot = await metrics.getSnapshot(config.metricsOptions || {});
        const wallpaperOverrides = {};
        let appliedCount = 0;

        for (const rule of config.rules || []) {
            if (!rule || rule.enabled === false) continue;
            const rawValue = getByPath(snapshot, rule.sourcePath);
            const mapped = mapValue(rawValue, rule.map);
            if (mapped === null) continue;

            if (rule.target.type === 'cssVar') {
                if (applyCssVarTarget(rule.target, mapped)) appliedCount += 1;
            } else if (rule.target.type === 'wallpaper') {
                if (applyWallpaperTarget(rule.target, mapped, wallpaperOverrides)) appliedCount += 1;
            }
        }

        if (Object.keys(wallpaperOverrides).length > 0) {
            applyWallpaperOverrides(wallpaperOverrides);
        }

        lastError = null;
        return appliedCount;
    }

    async function scheduleLoop() {
        if (!running) return;

        const startedAt = Date.now();
        try {
            await tick();
        } catch (err) {
            lastError = err?.message || String(err);
        }
        const elapsed = Date.now() - startedAt;
        const delay = Math.max(0, normalizeIntervalMs(config.intervalMs) - elapsed);

        if (!running) return;
        timer = setTimeout(scheduleLoop, delay);
    }

    function start() {
        if (running) return;
        running = true;
        scheduleLoop();
    }

    function stop() {
        if (!running) return;
        running = false;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        restoreBaselines();
    }

    async function setConfigPatch(patch, options = {}) {
        applyConfigPatch(patch);

        if (options.persist) {
            state.globalSettings = state.globalSettings || {};
            state.globalSettings.styleAutomation = deepCloneJson(config) || { ...config };
            if (window.VCPDesktop?.globalSettings?.save) {
                await window.VCPDesktop.globalSettings.save();
            }
        }

        if (config.enabled) {
            start();
        } else {
            stop();
        }

        return getStatus();
    }

    function getStatus() {
        return {
            initialized,
            running,
            enabled: !!config.enabled,
            intervalMs: normalizeIntervalMs(config.intervalMs),
            rules: (config.rules || []).map((rule) => ({
                id: rule.id,
                enabled: rule.enabled !== false,
                sourcePath: rule.sourcePath,
                map: rule.map,
                target: rule.target,
            })),
            lastRunAt,
            lastError,
        };
    }

    async function init() {
        if (initialized) return;
        initialized = true;

        const stored = state.globalSettings?.styleAutomation;
        if (stored && typeof stored === 'object') {
            try {
                applyConfigPatch(stored);
            } catch (err) {
                lastError = `读取持久化配置失败: ${err?.message || String(err)}`;
            }
        }

        if (config.enabled) {
            start();
        }
    }

    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.styleAutomation = {
        init,
        setConfigPatch,
        getStatus,
        start,
        stop,
    };
})();
