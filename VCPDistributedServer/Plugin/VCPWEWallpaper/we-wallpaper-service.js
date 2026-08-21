/**
 * we-wallpaper-service.js - VCPWEWallpaper service 插件入口
 *
 * pluginType: "service" + communication.protocol: "direct"
 * 由 VCPDistributedServer/Plugin.js 的 initializeServices() 加载：
 *   - initialize():  常驻初始化（本插件无需，路由注册时自检）
 *   - registerRoutes(app, config, projectBasePath, services):
 *       把 inventory / media / preview 路由挂到主 Express 应用（默认 5974 端口）
 *
 * 无 config.env 依赖、无 invocationCommands（对 AI 不可见，纯基础设施）。
 * 配套渲染端: VCPWEWallpaperUI (renderer 型前端插件)。
 */
'use strict';

const { registerRoutes, BASE } = require('./lib/media-server');

/** service 插件无重初始化需求，仅打印就绪日志。 */
async function initialize({ logger = console } = {}) {
    logger.log?.('[VCPWEWallpaper] service 插件已加载（路由将在服务器启动时注册）');
}

/** 模块级导出 registerRoutes：Plugin.js initializeServices 会直接调用它。 */
module.exports = {
    initialize,
    registerRoutes,
    BASE,
};
