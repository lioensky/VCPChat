/*
 * 标签实现推迟到第一次用到才加载：启动时只登记类型和入口，终端、浏览器、轨迹、计划详情的代码
 * 在第一次打开（或第一次调用它的 open 函数）时才 import。加载失败下次调用会重试。
 */

/**
 * @param {() => Promise<object> | object} load 返回真正的 provider
 * @param {string[]} [methods] 除 mountTab 外需要转发的方法（都按异步处理）
 */
export function createLazyProvider(load, methods = []) {
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
    for (const name of methods) {
        proxy[name] = async (...args) => (await resolve())[name](...args);
    }
    return Object.freeze(proxy);
}
