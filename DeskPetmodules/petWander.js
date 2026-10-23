// 溜达：主进程挪窗口，页面只决定什么时候想走、走的时候一颠一颠（路线在 modules/deskpet/wander.js）。
// 有了任何动静就停下（主进程那边也会停）。
// 溜达（设置里打开）：这么久没人理、站在任务栏上才走；走过一次以后隔一阵再走
const WANDER_AFTER_MS = 60000;
const WANDER_GAP_MS = [40000, 100000];

export function createPetWander(ctx) {
    const { api } = ctx;
    let nextWanderAt = 0;

    function wanderGap() {
        return WANDER_GAP_MS[0] + Math.random() * (WANDER_GAP_MS[1] - WANDER_GAP_MS[0]);
    }

    function wanderTick(ui) {
        const now = Date.now();
        const busy = !!ui || !!ctx.frame.state || ctx.life.phase !== 'awake' || now - ctx.lastActivity < WANDER_AFTER_MS;
        if (ctx.walking) {
            if (busy) api.wander?.({ stop: true });
            return;
        }
        if (ctx.prefs.wander !== true || busy || now < nextWanderAt) return;
        nextWanderAt = now + wanderGap();
        const figure = ctx.figureBounds();
        if (figure) api.wander?.({ figure });
    }

    function bindWalk() {
        api.onWalk?.(({ dir }) => {
            ctx.walking = dir;
            if (dir) document.body.dataset.walk = dir;
            else delete document.body.dataset.walk;
        });
    }

    return { wanderTick, bindWalk };
}
