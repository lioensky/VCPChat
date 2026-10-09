/* 桌宠头顶「正在做什么」的小卡片：回复里调工具时显示在气泡下面，
 * 比如「🔍 正在搜索 · 今天的天气」，做完变成对勾，回复结束一会儿后收起。 */
import { createToolActivityTracker, describeActivity } from './toolActivity.js';

const HOLD_AFTER_END_MS = 6000;

// isMuted：免打扰时主窗口里那边的回复不在桌宠上露面，卡片也一样收着
export function createToolCard({ el, onChange = () => {}, isMuted = () => false }) {
    const icon = el.querySelector('.tool-card-icon');
    const text = el.querySelector('.tool-card-text');
    const count = el.querySelector('.tool-card-count');
    let tracker = null;
    let hideTimer = 0;

    const render = () => {
        const latest = tracker?.latest;
        const wasHidden = el.hidden;
        el.hidden = !latest || isMuted();
        if (latest) {
            const view = describeActivity(latest);
            el.dataset.status = view.status;
            icon.textContent = view.icon;
            text.textContent = view.text;
            el.title = view.text;
            const total = tracker.activities.length;
            count.textContent = total > 1 ? `第 ${total} 步` : '';
        }
        if (wasHidden !== el.hidden) onChange();
    };

    return {
        start() {
            clearTimeout(hideTimer);
            tracker = createToolActivityTracker();
            render();
        },
        push(chunk) {
            if (!tracker) tracker = createToolActivityTracker();
            if (tracker.push(chunk)) render();
        },
        end() {
            if (!tracker) return;
            if (tracker.finish()) render();
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                tracker = null;
                render();
            }, HOLD_AFTER_END_MS);
        },
        /** 免打扰开关、回复归属变了时重画 */
        refresh: render,
        get visible() { return !el.hidden; },
    };
}
