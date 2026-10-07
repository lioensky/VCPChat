/*
 * 标签实现推迟到第一次用到才加载：启动时只登记类型和入口，终端、浏览器、轨迹、计划详情、代码查看、命令输出的代码
 * 在第一次打开（或第一次调用它的 open 函数）时才 import。加载失败下次调用会重试。
 */

/**
 * @param {() => Promise<object> | object} load 返回真正的 provider
 * @param {string[]} [methods] 除 mountTab 外需要转发的方法（都按异步处理）
 * @param {{ label?: string, notify?: (message: string, type: string) => void }} [options]
 *   转发方法（入口按钮、文件链接等）加载失败时提示用户；mountTab 失败由侧栏的出错页负责
 */
export function createLazyProvider(load, methods = [], { label = '', notify = null } = {}) {
    let loading = null;
    let loaded = null;
    const resolve = () => {
        if (loaded) return Promise.resolve(loaded);
        if (!loading) {
            loading = Promise.resolve().then(load).then(provider => {
                if (!provider || typeof provider.mountTab !== 'function') {
                    throw new TypeError('Lazy side pane provider must resolve to an object with mountTab()');
                }
                loaded = provider;
                return provider;
            }).finally(() => { loading = null; });
        }
        return loading;
    };
    const proxy = {
        isLoaded: () => loaded !== null,
        load: resolve,
        mountTab: async (...args) => (await resolve()).mountTab(...args)
    };
    const reportLoadFailure = (error) => {
        const fn = notify || globalThis.uiHelperFunctions?.showToastNotification;
        try {
            fn?.(`${label || '标签页'}加载失败：${error?.message || error}`, 'error');
        } catch (_error) { /* 提示失败不影响把原错误抛回去 */ }
    };
    for (const name of methods) {
        proxy[name] = async (...args) => {
            let provider;
            try {
                provider = await resolve();
            } catch (error) {
                // 点了没反应最难受：至少告诉用户哪个功能没加载出来，下次再点会重新加载
                reportLoadFailure(error);
                throw error;
            }
            return provider[name](...args);
        };
    }
    return Object.freeze(proxy);
}
