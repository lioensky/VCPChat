/*
 * VCP Loom · Bing 手机版测试注入脚本
 * 在远程页面上下文中执行，不具备 Node.js 或 VChat IPC 权限。
 */

document.documentElement.dataset.vcpLoomApp = 'example-mobile';

let viewport = document.querySelector('meta[name="viewport"]');
if (!viewport) {
    viewport = document.createElement('meta');
    viewport.name = 'viewport';
    document.head.appendChild(viewport);
}
viewport.content = 'width=device-width, initial-scale=1, viewport-fit=cover';

console.info('[VCP Loom] Bing mobile injection applied.');