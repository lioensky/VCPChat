// 跨环境路径发现工具模块
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { app } = require('electron');

class PathResolver {
    constructor() {
        this.cachedPath = null; // 缓存已发现的路径
        this.configFileName = 'comfyui-settings.json';
        this.toolboxDirName = 'VCPToolBox';
        this.pluginDirName = 'ComfyUIGen';
    }

    /**
     * 多策略路径发现
     * 按优先级尝试不同的路径解析策略，并缓存结果
     */
    async findVCPToolBoxPath() {
        if (this.cachedPath) {
            return this.cachedPath;
        }

        const strategies = [
            this.findByEnvironmentVariable.bind(this),
            this.findByAppPath.bind(this), // 新增：基于 app.getAppPath()
            this.findByRelativePath.bind(this),
            this.findByCommonLocations.bind(this),
            this.findBySearchUp.bind(this),
            this.findByUserDataDir.bind(this)
        ];

        for (const strategy of strategies) {
            try {
                const result = await strategy();
                if (result) {
                    this.cachedPath = result; // 缓存结果
                    return result;
                }
            } catch (error) {
                console.warn(`[PathResolver] Strategy ${strategy.name} failed:`, error.message);
            }
        }

        throw new Error('Could not locate VCPToolBox directory in any known location');
    }

    /**
     * 策略1: 环境变量指定路径
     */
    async findByEnvironmentVariable() {
        const envPath = process.env.VCPTOOLBOX_PATH || process.env.VCP_TOOLBOX_PATH;
        if (envPath) {
            const toolboxPath = path.resolve(envPath);
            if (await this.validateToolboxPath(toolboxPath)) {
                return toolboxPath;
            }
        }
        return null;
    }

    /**
     * 新策略: 基于 Electron App Path
     * 通常在打包后，资源文件会与可执行文件放在一起
     */
    async findByAppPath() {
        const appPath = app.getAppPath();
        const candidatePaths = [
            path.resolve(appPath, '..', this.toolboxDirName), // 可执行文件旁边
            path.resolve(appPath, this.toolboxDirName) // 在 resources/app 目录内
        ];
        for (const testPath of candidatePaths) {
            if (await this.validateToolboxPath(testPath)) {
                return testPath;
            }
        }
        return null;
    }

    /**
     * 策略3: 相对路径 (作为开发环境的回退)
     */
    async findByRelativePath() {
        // 从当前模块位置向上查找
        const relativePaths = [
            // For VCPHumanToolBox context
            path.resolve(__dirname, '..', '..', '..', this.toolboxDirName),
            // For general project structure
            path.resolve(process.cwd(), '..', this.toolboxDirName),
            path.resolve(process.cwd(), this.toolboxDirName)
        ];

        for (const testPath of relativePaths) {
            if (await this.validateToolboxPath(testPath)) {
                return testPath;
            }
        }
        return null;
    }

    /**
     * 策略3: 常见安装位置
     */
    async findByCommonLocations() {
        const commonPaths = [];
        
        if (process.platform === 'win32') {
            commonPaths.push(
                path.join('C:', 'Program Files', 'VCPChat', this.toolboxDirName),
                path.join('C:', 'Program Files (x86)', 'VCPChat', this.toolboxDirName),
                path.join(os.homedir(), 'AppData', 'Local', 'VCPChat', this.toolboxDirName),
                path.join(os.homedir(), 'Documents', 'VCPChat', this.toolboxDirName)
            );
        } else if (process.platform === 'darwin') {
            commonPaths.push(
                path.join('/Applications', 'VCPChat.app', 'Contents', 'Resources', this.toolboxDirName),
                path.join(os.homedir(), 'Library', 'Application Support', 'VCPChat', this.toolboxDirName),
                path.join(os.homedir(), '.vcpchat', this.toolboxDirName)
            );
        } else {
            commonPaths.push(
                path.join('/opt', 'vcpchat', this.toolboxDirName),
                path.join('/usr', 'local', 'share', 'vcpchat', this.toolboxDirName),
                path.join(os.homedir(), '.local', 'share', 'vcpchat', this.toolboxDirName),
                path.join(os.homedir(), '.vcpchat', this.toolboxDirName)
            );
        }

        for (const testPath of commonPaths) {
            if (await this.validateToolboxPath(testPath)) {
                return testPath;
            }
        }
        return null;
    }

    /**
     * 策略4: 向上搜索
     */
    async findBySearchUp() {
        let currentDir = __dirname;
        const maxLevels = 5; // 最多向上搜索5级目录
        
        for (let i = 0; i < maxLevels; i++) {
            const testPath = path.join(currentDir, this.toolboxDirName);
            if (await this.validateToolboxPath(testPath)) {
                return testPath;
            }
            
            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) break; // 已到根目录
            currentDir = parentDir;
        }
        return null;
    }

    /**
     * 策略5: 用户数据目录 (备选方案)
     */
    async findByUserDataDir() {
        const userDataPaths = [
            path.join(os.homedir(), '.vcpchat', this.toolboxDirName),
            path.join(os.tmpdir(), 'vcpchat', this.toolboxDirName)
        ];

        // 如果其他策略都失败，在用户目录创建默认结构
        for (const testPath of userDataPaths) {
            try {
                await fs.ensureDir(path.join(testPath, 'Plugin', this.pluginDirName));
                return testPath;
            } catch (error) {
                continue;
            }
        }
        return null;
    }

    /**
     * 验证工具箱路径是否有效
     */
    async validateToolboxPath(toolboxPath) {
        try {
            const pluginPath = path.join(toolboxPath, 'Plugin', this.pluginDirName);
            // We only check if the ComfyUIGen plugin directory exists,
            // as not all plugins might have a manifest file. This is more robust.
            return await fs.pathExists(pluginPath);
        } catch (error) {
            return false;
        }
    }

    /**
     * 获取配置文件完整路径
     */
    async getConfigFilePath() {
        const toolboxPath = await this.findVCPToolBoxPath();
        return path.join(toolboxPath, 'Plugin', this.pluginDirName, this.configFileName);
    }

    /**
     * 获取工作流目录路径
     */
    async getWorkflowsPath() {
        const toolboxPath = await this.findVCPToolBoxPath();
        return path.join(toolboxPath, 'Plugin', this.pluginDirName, 'workflows');
    }

    async getWorkflowProcessorPath() {
        const base = await this.findVCPToolBoxPath();
        const processorPath = path.join(base, 'Plugin', 'ComfyUIGen', 'WorkflowTemplateProcessor.js');
        if (!fs.existsSync(processorPath)) {
            throw new Error(`WorkflowTemplateProcessor.js not found at ${processorPath}`);
        }
        return processorPath;
    }

    /**
     * 缓存发现的路径
     */
    cacheDiscoveredPath(toolboxPath) {
        // 可以将发现的路径缓存到配置文件或环境变量中
        process.env.VCPTOOLBOX_DISCOVERED_PATH = toolboxPath;
    }
}

module.exports = PathResolver;