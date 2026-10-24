// 主进程给的设置：大小、透明度、免打扰、只看不点。
// 别的模块（声音、待机反应）读 window.deskPetPrefs 或听 window 上的 'deskpet:prefs' 事件。
export function createPetPrefs(ctx) {
    const { $ } = ctx;
    let prefsLoaded = false;

    function isQuiet() {
        return ctx.prefs.doNotDisturb === true;
    }

    function applyPrefs(next) {
        if (!next || typeof next !== 'object') return;
        const previous = ctx.prefs;
        ctx.prefs = { ...ctx.prefs, ...next };
        window.deskPetPrefs = Object.freeze({ ...ctx.prefs });
        ctx.dockVisibility.update({ through: ctx.prefs.clickThrough === true });
        document.documentElement.style.setProperty('--pet-scale', String(ctx.prefs.scale || 1));
        document.documentElement.style.setProperty('--pet-opacity', String(ctx.prefs.opacity ?? 1));
        document.body.classList.toggle('is-dnd', isQuiet());
        $('dndBadge').hidden = !isQuiet();
        if (isQuiet() && !previous.doNotDisturb) $('emotionBadge').hidden = true;
        $('throughBadge').hidden = !ctx.prefs.clickThrough;
        if (ctx.prefs.clickThrough && !previous.clickThrough) {
            ctx.reportHit(false);
            // 第一次载入就是穿透的（上次没关）不提示，只有刚打开时说一声怎么关
            if (prefsLoaded) {
                const how = ctx.prefs.clickThroughKey ? `托盘菜单或 ${ctx.prefs.clickThroughKey} ` : '托盘菜单';
                ctx.notice(`鼠标现在会直接穿过我。想再点到我，从${how}关掉「只看不点」。`, { ms: 8000 });
            }
        }
        // 刚开了免打扰：正在念的主窗口回复停下
        if (isQuiet() && !previous.doNotDisturb && !ctx.bubble.own) ctx.speech.stop();
        ctx.renderBubble();
        window.dispatchEvent(new CustomEvent('deskpet:prefs', { detail: window.deskPetPrefs }));
        prefsLoaded = true;
    }

    return { isQuiet, applyPrefs };
}
