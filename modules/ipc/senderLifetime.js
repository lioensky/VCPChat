// modules/ipc/senderLifetime.js
// 页面（webContents）关闭或主框架导航到别处时，它在主进程里登记的订阅、镜像都要一起清掉，
// 否则主进程会一直往已经不存在的页面推数据。页内跳转（hash / pushState）不算离开。
'use strict';

const watchers = new WeakMap(); // sender → Set<release>

/**
 * 页面离开时调用 release；同一个页面可以登记多个 release，每个只调用一次。
 * @returns {() => void} 不再关心这个页面时调用，取消登记
 */
function onSenderGone(sender, release) {
    if (!sender || typeof sender.on !== 'function' || typeof release !== 'function') return () => {};
    let releases = watchers.get(sender);
    if (!releases) {
        releases = new Set();
        watchers.set(sender, releases);
        const fire = () => {
            const pending = [...releases];
            releases.clear();
            for (const fn of pending) {
                try { fn(); } catch (error) { console.error('[SenderLifetime] release failed:', error); }
            }
        };
        sender.on('destroyed', fire);
        sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace) fire();
        });
    }
    releases.add(release);
    return () => { releases.delete(release); };
}

module.exports = { onSenderGone };
