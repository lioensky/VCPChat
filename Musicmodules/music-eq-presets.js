// Musicmodules/music-eq-presets.js
// 自己的 EQ 预设：调好的十段曲线存个名字，以后在预设下拉里一点就回来（耳机一条、音箱一条、某张专辑一条）。
// 下拉的末尾多两项操作：「＋ 把当前设置存为预设…」（弹框起名，同名覆盖），选中自己的预设时还有「删除「名字」」。
// 存在本机（localStorage musicEqUserPresets，最多 16 个）；命令面板里也能存。
// 自己的预设放进 app.eqPresets（键 u:名字），原来的「跟着滑块显示当前预设 / 自定义」逻辑不用改。
//
// 对外：app.eqUserPresets = { list(), save(name), remove(name), promptSave() }；纯函数 cleanName / bandsEqual 供测试。

(function (global) {
    'use strict';

    const KEY = 'musicEqUserPresets';
    const MAX = 16;
    const PREFIX = 'u:';
    const SAVE = '__eq-save';
    const DEL = '__eq-delete';
    const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

    const cleanName = (s) => String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 24);
    const bandsEqual = (a, b) => {
        const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
        for (const k of keys) if ((Number(a?.[k]) || 0) !== (Number(b?.[k]) || 0)) return false;
        return true;
    };

    function setupMusicEqPresets(app, { storage = (() => { try { return global.localStorage; } catch (e) { return null; } })() } = {}) {
        if (!app || app.eqUserPresets || !app.eqPresets || typeof app.applyEqPreset !== 'function') return;
        const doc = global.document;
        const toast = (message, extra = {}) => { try { global.MusicToast?.show?.({ message, ...extra }); } catch (e) { /* 没有提示层 */ } };

        let presets = [];
        try {
            const v = JSON.parse(storage?.getItem(KEY) || '[]');
            if (Array.isArray(v)) presets = v.filter((p) => p && cleanName(p.name) && p.bands && typeof p.bands === 'object').slice(0, MAX);
        } catch (e) { presets = []; }
        const persist = () => { try { storage?.setItem(KEY, JSON.stringify(presets)); } catch (e) { /* 存不下就算了 */ } };

        const sliderCache = Object.create(null);
        const getSlider = (band) => {
            let slider = sliderCache[band];
            if (slider && slider.isConnected !== false) return slider;
            slider = doc?.getElementById?.(`eq-${band}`) || null;
            if (slider) sliderCache[band] = slider;
            return slider;
        };
        const currentBands = () => {
            const out = {};
            for (const band of Object.keys(app.eqBands || {})) {
                const slider = getSlider(band);
                const v = Number(slider ? slider.value : app.eqBands[band]);
                out[band] = Number.isFinite(v) ? v : 0;
            }
            return out;
        };

        // 下拉里的东西：一组「我的预设」+ 两个操作项
        let group = null;
        let saveOpt = null;
        let delOpt = null;
        const select = () => app.eqPresetSelect || doc?.getElementById?.('eq-preset-select');
        const syncPresetsObject = () => {
            for (const k of Object.keys(app.eqPresets)) if (k.startsWith(PREFIX)) delete app.eqPresets[k];
            for (const p of presets) app.eqPresets[PREFIX + p.name] = { ...p.bands };
        };
        const render = () => {
            const sel = select();
            if (!sel || !doc) return;
            if (!group) {
                group = doc.createElement('optgroup');
                group.label = '我的预设';
                const ops = doc.createElement('optgroup');
                ops.label = '';
                saveOpt = doc.createElement('option');
                saveOpt.value = SAVE;
                saveOpt.textContent = '＋ 把当前设置存为预设…';
                delOpt = doc.createElement('option');
                delOpt.value = DEL;
                ops.append(saveOpt, delOpt);
                sel.append(group, ops);
            }
            group.replaceChildren(...presets.map((p) => {
                const o = doc.createElement('option');
                o.value = PREFIX + p.name;
                o.textContent = p.name;
                return o;
            }));
            group.hidden = !presets.length;
            syncDelete();
        };
        // 「删除」只在选中的是自己的预设时出现
        const syncDelete = () => {
            const sel = select();
            if (!delOpt || !sel) return;
            const v = String(sel.value || '');
            const mine = v.startsWith(PREFIX);
            delOpt.textContent = mine ? `删除「${v.slice(PREFIX.length)}」` : '删除';
            delOpt.dataset.name = mine ? v.slice(PREFIX.length) : '';
            delOpt.hidden = !mine;
            delOpt.disabled = !mine;
        };

        const save = (rawName) => {
            const name = cleanName(rawName);
            if (!name) return null;
            const bands = currentBands();
            const at = presets.findIndex((p) => p.name === name);
            const entry = { name, bands };
            if (at !== -1) presets[at] = entry;
            else {
                if (presets.length >= MAX) { toast(`最多存 ${MAX} 个预设，先删掉一个再存`, { kind: 'error' }); return null; }
                presets.push(entry);
            }
            persist();
            syncPresetsObject();
            render();
            app.syncEqPresetSelect?.();
            syncDelete();
            toast(at !== -1 ? `已更新预设「${name}」` : `已存为预设「${name}」，在均衡器的预设里能找到`, { kind: 'success' });
            return entry;
        };
        const remove = (name) => {
            const at = presets.findIndex((p) => p.name === name);
            if (at === -1) return false;
            const [gone] = presets.splice(at, 1);
            persist();
            syncPresetsObject();
            render();
            app.syncEqPresetSelect?.();
            syncDelete();
            toast(`已删除预设「${name}」（现在的均衡器设置没变）`, {
                kind: 'success',
                action: { label: '撤销', run: () => { if (!presets.some((p) => p.name === gone.name) && presets.length < MAX) { presets.splice(Math.min(at, presets.length), 0, gone); persist(); syncPresetsObject(); render(); app.syncEqPresetSelect?.(); syncDelete(); } } }
            });
            return true;
        };

        // 起名框：长相和「新建歌单」一样（.dialog-overlay > .dialog），Enter 存、Esc 取消
        let asking = false;
        let closeActivePrompt = null;
        const promptSave = () => {
            if (!doc || asking) return;
            asking = true;
            const previousFocus = doc.activeElement;
            const sel = select();
            const v = String(sel?.value || '');
            let n = presets.length + 1;
            while (presets.some((p) => p.name === `我的 EQ ${n}`)) n++;
            const suggestion = v.startsWith(PREFIX) ? v.slice(PREFIX.length) : `我的 EQ ${n}`;
            const overlay = doc.createElement('div');
            overlay.className = 'dialog-overlay music-dialog music-eq-name';
            overlay.innerHTML = `
                <div class="dialog glass-panel" role="dialog" aria-modal="true" aria-labelledby="music-eq-name-t">
                    <h3 id="music-eq-name-t">存为 EQ 预设</h3>
                    <input type="text" maxlength="24" aria-label="预设名字" placeholder="比如：耳机、音箱、人声">
                    <p class="music-dialog-msg"></p>
                    <div class="dialog-actions">
                        <button type="button" class="dialog-btn cancel">取消</button>
                        <button type="button" class="dialog-btn confirm">存</button>
                    </div>
                </div>`;
            const input = overlay.querySelector('input');
            const note = overlay.querySelector('.music-dialog-msg');
            const ok = overlay.querySelector('.dialog-btn.confirm');
            input.value = suggestion;
            const refresh = () => {
                const name = cleanName(input.value);
                const clash = Boolean(name) && presets.some((p) => p.name === name);
                const full = !clash && presets.length >= MAX;
                ok.disabled = !name || full;
                // 存满了就在框里直接说，别等点了「存」才弹错
                note.textContent = full ? `已经存了 ${MAX} 个，只能覆盖同名的；或者先在预设下拉里删掉一个。` : clash ? '已经有同名的预设，存了会覆盖它。' : '存的是现在的十段增益。';
            };
            input.addEventListener('input', refresh);
            refresh();
            let done = false;
            let focusTimer = 0;
            let openRaf = 0;
            const finish = (name) => {
                if (done) return;
                done = true;
                asking = false;
                closeActivePrompt = null;
                if (openRaf && typeof global.cancelAnimationFrame === 'function') { global.cancelAnimationFrame(openRaf); openRaf = 0; }
                if (focusTimer) { clearTimeout(focusTimer); focusTimer = 0; }
                global.removeEventListener('keydown', onKey, true);
                overlay.classList.remove('visible');
                setTimeout(() => overlay.remove(), 320);
                if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') { try { previousFocus.focus({ preventScroll: true }); } catch (e) { /* 还不回去就算了 */ } }
                if (name) save(name);
            };
            const onKey = (e) => {
                if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); finish(null); return; }
                if (e.key === 'Enter' && !e.isComposing && doc.activeElement === input) { e.preventDefault(); e.stopPropagation(); if (!ok.disabled) finish(input.value); return; }
                if (e.key === 'Tab') {
                    const focusables = [...overlay.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])')];
                    if (focusables.length) {
                        const first = focusables[0], last = focusables[focusables.length - 1];
                        const active = doc.activeElement;
                        if (e.shiftKey ? (active === first || !overlay.contains(active)) : (active === last || !overlay.contains(active))) {
                            e.preventDefault();
                            (e.shiftKey ? last : first).focus({ preventScroll: true });
                        }
                    }
                    return;
                }
                if (NAV_KEYS.has(e.key) && e.target !== input) { e.stopPropagation(); return; }
                if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && e.target !== input) e.stopPropagation();
            };
            closeActivePrompt = () => finish(null);
            overlay.querySelector('.dialog-btn.cancel').addEventListener('click', () => finish(null));
            ok.addEventListener('click', () => { if (!ok.disabled) finish(input.value); });
            overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(null); });
            doc.body.appendChild(overlay);
            global.addEventListener('keydown', onKey, true);
            openRaf = global.requestAnimationFrame?.(() => { openRaf = 0; if (!done) overlay.classList.add('visible'); }) || 0;
            focusTimer = setTimeout(() => { focusTimer = 0; if (!done) { try { input.focus(); input.select(); } catch (e) { /* 没关系 */ } } }, 30);
        };

        // 操作项被选中时：在 change 到达下拉自己的处理之前拦下（捕获阶段，挂在 document 上），做完把下拉还原成实际状态
        const onPresetSelectChange = (e) => {
            const sel = select();
            if (!sel || e.target !== sel) return;
            const v = sel.value;
            if (v !== SAVE && v !== DEL) { syncDelete(); return; }
            e.stopPropagation();
            e.stopImmediatePropagation();
            const target = delOpt?.dataset.name || '';
            app.syncEqPresetSelect?.();
            if (v === SAVE) promptSave();
            else if (target) remove(target); // 删的是打开下拉前选中的那个自己的预设
            syncDelete();
        };
        if (doc) {
            doc.addEventListener('change', onPresetSelectChange, true);
        }
        global.addEventListener?.('beforeunload', () => {
            if (doc) doc.removeEventListener('change', onPresetSelectChange, true);
            closeActivePrompt?.();
            closeActivePrompt = null;
        }, { once: true });

        // 滑块变了、换了预设，「删除」项跟着更新
        const hooks = (global.MusicAppHooks || require('./music-app-hooks.js'));
        hooks.wrap(app, 'syncEqPresetSelect', 'eq-presets', (base) => function (...args) {
            const r = base.apply(this, args);
            syncDelete();
            return r;
        });
        // 原生预设列表是之后才填的：填完再接上自己的（已经填好就直接接）
        syncPresetsObject();
        hooks.wrap(app, 'populateEqPresets', 'eq-presets', (base) => function (...args) {
            const r = base.apply(this, args);
            group = null;
            render();
            app.syncEqPresetSelect?.();
            return r;
        });
        const sel = select();
        if (sel && sel.options.length) { render(); app.syncEqPresetSelect?.(); }

        app.eqUserPresets = {
            list: () => presets.map((p) => ({ name: p.name, bands: { ...p.bands } })),
            save, remove, promptSave,
            isCustom: () => !Object.values(app.eqPresets).some((b) => bandsEqual(b, currentBands()))
        };
    }

    const exported = { setupMusicEqPresets, cleanName, bandsEqual };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicEqPresets = exported;
})(typeof window !== 'undefined' ? window : globalThis);
