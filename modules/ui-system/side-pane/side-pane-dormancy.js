/*
 * 副屏标签的休眠策略：决定哪些已挂载的视图该释放（标签本身留着，再显示时重新挂载）。
 *   - 隐藏超过 hiddenMs（默认 5 分钟）；
 *   - 属于别的对话的标签（scopeMode 'topic'）离开当前对话超过 otherTopicMs，来回切换时不会马上重建；
 *   - 同时挂着的视图超过 maxLiveViews 时，最久没显示的先休眠。
 * 不休眠：正在显示的、类型声明 dormancy 'keep' 的、视图报告自己正忙的（网页在加载或放声音……），
 * 忙的到期后隔 busyRetryMs 再看一次。
 * 'limit-only' 的类型（浏览器）不按隐藏时长休眠，只在超过上限时参与淘汰：销毁网页会丢掉表单、登录和后退栈，
 * 代价远高于重建其他视图（对照 ZCode browserTabResidencyPolicy.ts 只按数量淘汰）。
 * 'keep' 的视图不占 maxLiveViews 的名额，否则它们攒多了会把其他标签一切走就挤去休眠。
 * 'limit-only' 的视图也不占 maxLiveViews，而是有自己的 maxLivePages：连开几个代码查看、终端不能把登录着的网页挤掉
 * （ZCode 的浏览器驻留上限同样单独计数，其他标签类型不算在里面）。
 * 这里只做判断，不碰 DOM 和定时器，控制器负责执行和定时。
 */

export const DORMANCY_DEFAULTS = Object.freeze({
    hiddenMs: 5 * 60_000,
    otherTopicMs: 30_000,
    maxLiveViews: 8,
    maxLivePages: 12,
    busyRetryMs: 60_000
});

/**
 * @typedef {object} DormancyCandidate
 * @property {string} tabId
 * @property {boolean} shown 正在显示
 * @property {'none' | 'detach' | 'limit-only' | 'keep'} dormancy
 * @property {boolean} busy
 * @property {boolean} otherTopic 属于别的对话
 * @property {number | null} hiddenSince 从什么时候开始不显示；一直没显示过的用挂载时间
 * @property {number} lastShownAt 最近一次显示的时间，没显示过为 0
 * @property {number} openedAt
 */

const byLeastRecentlyShown = (a, b) => (a.lastShownAt - b.lastShownAt)
    || (a.openedAt - b.openedAt)
    || a.tabId.localeCompare(b.tabId);

/**
 * @param {DormancyCandidate[]} candidates 当前挂着的视图
 * @param {{ now: number } & Partial<typeof DORMANCY_DEFAULTS>} options
 * @returns {{ release: Array<{ tabId: string, reason: 'hidden' | 'other-topic' | 'view-limit' }>, nextCheckAt: number | null }}
 */
export function selectDormantViews(candidates, options) {
    const { now, hiddenMs, otherTopicMs, maxLiveViews, maxLivePages, busyRetryMs } = { ...DORMANCY_DEFAULTS, ...options };
    const release = [];
    const released = new Set();
    let nextCheckAt = null;
    const later = at => { nextCheckAt = nextCheckAt === null ? at : Math.min(nextCheckAt, at); };
    const sleepable = candidate => !candidate.shown && candidate.dormancy !== 'keep';

    for (const candidate of candidates) {
        if (!sleepable(candidate) || candidate.dormancy === 'limit-only') continue;
        const reason = candidate.otherTopic ? 'other-topic' : 'hidden';
        const due = (candidate.hiddenSince ?? now) + (candidate.otherTopic ? otherTopicMs : hiddenMs);
        if (due > now) {
            later(due);
        } else if (candidate.busy) {
            later(now + busyRetryMs);
        } else {
            release.push({ tabId: candidate.tabId, reason });
            released.add(candidate.tabId);
        }
    }

    const evictOver = (pool, limit) => {
        let live = pool.filter(candidate => !released.has(candidate.tabId)).length;
        if (live <= limit) return;
        const victims = pool
            .filter(candidate => sleepable(candidate) && !candidate.busy && !released.has(candidate.tabId))
            .sort(byLeastRecentlyShown);
        for (const victim of victims) {
            if (live <= limit) break;
            release.push({ tabId: victim.tabId, reason: 'view-limit' });
            released.add(victim.tabId);
            live -= 1;
        }
        // 超出上限但剩下的都在忙：过一会儿再看
        if (live > limit && pool.some(candidate => sleepable(candidate) && candidate.busy)) later(now + busyRetryMs);
    };
    evictOver(candidates.filter(candidate => candidate.dormancy !== 'keep' && candidate.dormancy !== 'limit-only'), maxLiveViews);
    evictOver(candidates.filter(candidate => candidate.dormancy === 'limit-only'), maxLivePages);
    return { release, nextCheckAt };
}
