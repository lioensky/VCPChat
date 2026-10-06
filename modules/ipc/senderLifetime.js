// modules/ipc/senderLifetime.js
// 页面（webContents）关闭、换成另一个文档或渲染进程崩溃时，它在主进程里登记的订阅、镜像都要一起清掉，
// 否则主进程会一直往已经不存在的页面推数据。页内跳转（hash / pushState）不算离开。
//
// 只认已经提交的导航（did-navigate），不认刚开始的（did-start-navigation）：
// 主窗口点开 http 链接时导航先开始，随后才被 will-navigate 拦下改用外部浏览器打开；
// 被取消、变成下载、返回 204 的导航也都不会提交。这些情况下页面还在，订阅不能丢。
// did-navigate 只在主框架提交新文档时触发，子框架和页内跳转都有各自的事件。
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
        sender.on('did-navigate', fire);
        sender.on('render-process-gone', fire);
    }
    releases.add(release);
    return () => { releases.delete(release); };
}

module.exports = { onSenderGone };
