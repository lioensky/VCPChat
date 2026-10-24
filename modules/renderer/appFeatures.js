/**
 * 主窗口一侧的应用功能模块：问主进程这次加载了哪些功能（modules/appFeatures.js），
 * 逐个载入它们 feature.json 里的 renderer 入口并调用 install(context)。某个功能出错只记日志。
 */
export async function installAppFeatures(context) {
    let entries = [];
    try {
        entries = await context.chatAPI?.listAppFeatureEntries?.() || [];
    } catch (error) {
        console.warn('[AppFeatures] 读不到功能列表:', error);
        return;
    }
    for (const { name, renderer } of entries) {
        try {
            // renderer 相对项目根目录；这个文件在 modules/renderer/
            const module = await import(new URL(`../../${renderer}`, import.meta.url).href);
            await module.install?.(context);
        } catch (error) {
            console.warn(`[AppFeatures] ${name} 在主窗口这一侧载入失败:`, error);
        }
    }
}
