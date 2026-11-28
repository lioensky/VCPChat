// Musicmodules/music-dock/music-dock-stage-settings.js
// 底栏控制页里的舞台设置：把舞台控制舱里的三块（当前舞台的专属设置、全局输出、演出阵列）和「恢复出厂编排」
// 搬到控制页对应的位置（appendChild，不重建，舞台宿主绑在上面的事件和引用都还在），给专属设置排序、拆说明，
// 以及控制页下半的「显示」一组（renderExt）和直达舞台设置（openStageSettings）。
//
// 从 music-dock.js 拆出来，代码原样搬过来；和底栏共用的状态（state、el）和小工具通过 create(ctx) 传进来。
(function (global) {
    'use strict';

    // 每个舞台先露出最常动的几项，其余的收在「全部 N 项」里原地展开。没列出的舞台按定义顺序取前几项。
    const TUNE_FIRST = Object.freeze({
        diorama: ['rain', 'lyricCarrier', 'showTranslation', 'letterbox', 'cameraCuts', 'fireworks'],
        tunnel: ['cameraSpeed', 'showTranslation', 'fontScale', 'starfield', 'showPlanets', 'showShips'],
        kowloon: ['rain', 'cameraMode', 'lightning', 'reflections', 'showTranslation', 'fog'],
        orbit: ['tilt', 'roll', 'axisLine', 'showTranslation'],
        signal: ['panel', 'showSpectrum', 'pulseRate', 'showTranslation'],
        groupchat: ['echoes', 'voiceNotes', 'fontScale', 'showTranslation'],
        impression: ['timeOfDay', 'flecks', 'frame', 'showTranslation'],
        clockwork: ['secondHand', 'fontScale', 'waitingOpacity', 'showTranslation'],
        hanabi: ['density', 'trails', 'reflection', 'showTranslation'],
        lumiere: ['smoke', 'dust', 'fontScale', 'showTranslation'],
        fogpane: ['fog', 'rain', 'drops', 'drips', 'cameraSpeed', 'showTranslation'],
        inkdraft: ['cameraCuts', 'figures', 'collisions', 'halftone', 'inkFlip', 'showTranslation'],
        luminous: ['fontScale', 'layoutStyle', 'showTranslation', 'showUpcoming', 'glow'],
        partita: ['fontScale', 'layoutStyle', 'showTranslation', 'showUpcoming', 'glow'],
        cadenza: ['fontScale', 'showTranslation', 'showUpcoming', 'heroEmphasis', 'glow'],
        fume: ['cameraMode', 'cameraSpeed', 'geometricBackground', 'glow', 'heroScale']
    });
    const TUNE_FIRST_COUNT = 6;
    const TUNE_LABEL_NOTE_RE = /^(.+?)（(.+)）$/;

    function create(ctx) {
        const {
            state, el, cleanups, listen, openPanel,
            stageActive, currentStageMode, segment, escapeHtml, icon
        } = ctx;

        const stageRoot = document.getElementById('music-stage');
        const stageParts = [
            ['.music-stage-tuning-controls', el.tuneSlot],
            ['.music-stage-common-controls', el.commonSlot],
            ['.music-stage-mode-options', el.arraySlot],
            ['.music-stage-settings-footer', el.advActs]
        ].map(([selector, slot]) => ({ node: stageRoot?.querySelector(selector), slot })).filter((part) => part.node);
        const stageSettingsHome = stageParts.map(({ node }) => ({ node, parent: node.parentNode, next: node.nextSibling }));
        for (const { node, slot } of stageParts) slot.appendChild(node);
        if (stageParts.length) document.body.classList.add('music-dock-stage-settings');
        cleanups.push(() => {
            for (const { node, parent, next } of stageSettingsHome.slice().reverse()) {
                if (parent?.isConnected) parent.insertBefore(node, next?.parentNode === parent ? next : null);
            }
            document.body.classList.remove('music-dock-stage-settings');
        });
        const tuningNode = el.tuneSlot.firstElementChild;

        let tuneBusy = false;
        let tuningDirty = true;
        let lastTuneSceneId = '';
        let lastTuneAll = null;
        // 宿主每次换舞台都会重建这些行。这里只做三件事：把「名字（说明）」拆成名字和一行小字说明、
        // 把常用项排到前面、给其余的行打上记号；控件本身和它上面的事件不动。
        const dressTuning = () => {
            if (!tuningNode || tuneBusy) return;
            const scene = currentStageMode();
            const sceneId = scene?.id || '';
            if (!tuningDirty && sceneId === lastTuneSceneId && state.tuneAll === lastTuneAll) return;
            tuneBusy = true;
            try {
                const rows = Array.from(tuningNode.children);
                const rowByKey = new Map();
                for (const row of rows) {
                    const key = row.querySelector('[data-stage-config-key]')?.dataset.stageConfigKey || '';
                    if (key && !rowByKey.has(key)) rowByKey.set(key, row);
                    const label = row.querySelector('.music-stage-tuning-label');
                    if (!label || label.dataset.mdDone) continue;
                    label.dataset.mdDone = '1';
                    const match = TUNE_LABEL_NOTE_RE.exec(label.textContent || '');
                    if (match) {
                        label.textContent = match[1];
                        const note = document.createElement('small');
                        note.className = 'md-tune-note';
                        note.textContent = match[2];
                        label.appendChild(note);
                    }
                }
                const wanted = TUNE_FIRST[sceneId] || [];
                let first = [];
                if (rows.length <= TUNE_FIRST_COUNT + 2) {
                    first = rows.slice();
                } else {
                    for (let i = 0; i < wanted.length; i += 1) {
                        const hit = rowByKey.get(wanted[i]);
                        if (hit) first.push(hit);
                    }
                    if (first.length < 3) first = rows.slice(0, TUNE_FIRST_COUNT);
                }
                const firstSet = new Set(first);
                const rest = [];
                for (let i = 0; i < rows.length; i += 1) {
                    if (!firstSet.has(rows[i])) rest.push(rows[i]);
                }
                const ordered = first.concat(rest);
                let orderChanged = false;
                for (let i = 0; i < ordered.length; i += 1) {
                    if (ordered[i] !== rows[i]) { orderChanged = true; break; }
                }
                if (orderChanged) {
                    const frag = document.createDocumentFragment();
                    for (let i = 0; i < ordered.length; i += 1) frag.appendChild(ordered[i]);
                    tuningNode.appendChild(frag);
                }
                for (let i = 0; i < rest.length; i += 1) {
                    if (!rest[i].classList.contains('md-tune-rest')) rest[i].classList.add('md-tune-rest');
                }
                for (let i = 0; i < first.length; i += 1) {
                    if (first[i].classList.contains('md-tune-rest')) first[i].classList.remove('md-tune-rest');
                }
                const hideSec = rows.length === 0;
                if (el.tuneSec.hidden !== hideSec) el.tuneSec.hidden = hideSec;
                const hideMore = rest.length === 0;
                if (el.tuneMore.hidden !== hideMore) el.tuneMore.hidden = hideMore;
                const showAll = Boolean(state.tuneAll || rest.length === 0);
                if (el.tuneSlot.classList.contains('md-tune-all') !== showAll) el.tuneSlot.classList.toggle('md-tune-all', showAll);
                const expStr = String(state.tuneAll);
                if (el.tuneMore.getAttribute('aria-expanded') !== expStr) el.tuneMore.setAttribute('aria-expanded', expStr);
                const moreKey = `${state.tuneAll ? 1 : 0}:${rows.length}`;
                if (el.tuneMore.dataset.mdMoreKey !== moreKey) {
                    el.tuneMore.dataset.mdMoreKey = moreKey;
                    el.tuneMore.innerHTML = `<span>${state.tuneAll ? '只看常用项' : `全部 ${rows.length} 项`}</span>${icon(state.tuneAll ? 'chevron-up' : 'chevron-down', 14)}`;
                }
                const nextTitle = scene ? `${scene.label}设置` : '舞台设置';
                if (el.tuneTitle.textContent !== nextTitle) el.tuneTitle.textContent = nextTitle;
                const nextHint = scene?.description || '';
                if (el.tuneHint.textContent !== nextHint) el.tuneHint.textContent = nextHint;
                tuningDirty = false;
                lastTuneSceneId = sceneId;
                lastTuneAll = state.tuneAll;
            } finally {
                tuneBusy = false;
            }
        };
        if (tuningNode) {
            const tuneObserver = new MutationObserver(() => { tuningDirty = true; dressTuning(); tuneObserver.takeRecords(); });
            tuneObserver.observe(tuningNode, { childList: true });
            cleanups.push(() => tuneObserver.disconnect());
        }
        listen(el.tuneMore, 'click', () => { state.tuneAll = !state.tuneAll; tuningDirty = true; dressTuning(); });
        listen(el.advToggle, 'click', () => {
            const open = el.advBody.hidden;
            el.advBody.hidden = !open;
            el.advToggle.setAttribute('aria-expanded', String(open));
            el.advToggle.classList.toggle('md-open', open);
        });

        const advWrap = el.advToggle?.closest('.md-adv') || null;
        let lastExtKey = '';
        let introBtn = null;
        // 「显示」和开场回放在曲库、舞台都可用；当前舞台和共用舞台选项只在演出时可见。
        function renderExt(show) {
            const hideExt = !show;
            if (el.ext.hidden !== hideExt) el.ext.hidden = hideExt;
            if (!show) return;
            dressTuning();
            const light = document.body.classList.contains('light-theme');
            const motion = global.MusicMotion;
            const hasMotion = Boolean(motion && Array.isArray(motion.PREFERENCES));
            const extKey = `${light ? 1 : 0}|${hasMotion ? motion.preference : ''}`;
            if (extKey !== lastExtKey || !el.body2.firstChild) {
                lastExtKey = extKey;
                let html = '<div class="md-grp-h"><b>显示</b></div>'
                    + `<div class="md-nrow"><span class="md-lb">外观</span><span class="md-r">`
                    + segment('data-act="theme"', [{ html: icon('sun', 15), aria: '浅色' }, { html: icon('moon', 15), aria: '深色' }], light ? 0 : 1, 'md-inline')
                    + '</span></div>';
                if (hasMotion) {
                    const prefs = motion.PREFERENCES;
                    const at = Math.max(0, prefs.findIndex((p) => p.value === motion.preference));
                    html += `<div class="md-nrow"><span class="md-lb">降低动态</span><span class="md-r">`
                        + segment('data-act="motion"', prefs.map((p) => ({ html: escapeHtml(p.label), aria: `降低动态：${p.label}` })), at, 'md-inline md-seg-tx')
                        + '</span></div>';
                }
                el.body2.innerHTML = html;
            }
            const hasIntro = typeof global.MusicIntro?.replay === 'function';
            const hideAdv = !hasIntro && !stageActive();
            if (advWrap && advWrap.hidden !== hideAdv) advWrap.hidden = hideAdv;
            if (!introBtn || !introBtn.isConnected) introBtn = el.advActs.querySelector('[data-act="intro"]');
            if (hasIntro && !introBtn) {
                el.advActs.insertAdjacentHTML('afterbegin', `<button class="md-wide md-intro" type="button" data-act="intro">${icon('clapperboard', 15)}<span>播放完整开场</span>${icon('chevron-right', 14)}</button>`);
                introBtn = el.advActs.firstElementChild;
            } else if (!hasIntro && introBtn) {
                introBtn.remove();
                introBtn = null;
            }
        }
        // 以前这里是「舞台调制」子页；现在只是打开控制页并滚到舞台那一段。
        function openStageSettings() {
            openPanel('控制');
            if (!stageActive()) return;
            // offsetTop counts from the panel, not from the scrolling body below its header,
            // so it overshot by the header height and hid the section title and first label.
            const scroller = el.ext.parentElement;
            if (scroller) {
                const top = el.tuneSec.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8;
                if (top > 0) scroller.scrollTop = top;
            }
            el.body.querySelector('[data-act="scene-pick"]')?.focus({ preventScroll: true });
        }

        return { renderExt, openStageSettings };
    }

    global.MusicDockStageSettings = { create };
})(window);
