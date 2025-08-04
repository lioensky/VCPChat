// 跨环境路径发现工具模块
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

class PathResolver {
    constructor() {
        this.searchPaths = [];
        this.configFileName = 'comfyui-settings.json';
        this.toolboxDirName = 'VCPToolBox';
        this.pluginDirName = 'ComfyUIGen';
    }

    /**
     * 多策略路径发现
     * 按优先级尝试不同的路径解析策略
     */
    async findVCPToolBoxPath() {
        const strategies = [
            this.findByEnvironmentVariable.bind(this),
            this.findByRelativePath.bind(this),
            this.findByCommonLocations.bind(this),
            this.findBySearchUp.bind(this),
            this.findByUserDataDir.bind(this)
        ];

        for (const strategy of strategies) {
            try {
                const result = await strategy();
                if (result) {
                    console.log(`[PathResolver] Found VCPToolBox using strategy: ${strategy.name}`);
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
     * 策略2: 相对路径 (当前使用的方式)
     */
    async findByRelativePath() {
        // 从当前模块位置向上查找
        const relativePaths = [
            path.resolve(__dirname, '..', '..', this.toolboxDirName),
            path.resolve(__dirname, '..', '..', '..', this.toolboxDirName),
            path.resolve(process.cwd(), this.toolboxDirName),
            path.resolve(process.cwd(), '..', this.toolboxDirName)
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
            const exists = await fs.pathExists(pluginPath);
            if (exists) {
                // 进一步验证是否是正确的插件目录
                const manifestPath = path.join(pluginPath, 'plugin-manifest.json');
                if (await fs.pathExists(manifestPath)) {
                    return true;
                }
            }
            return false;
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

    /**
     * 缓存发现的路径
     */
    cacheDiscoveredPath(toolboxPath) {
        // 可以将发现的路径缓存到配置文件或环境变量中
        process.env.VCPTOOLBOX_DISCOVERED_PATH = toolboxPath;
    }
}

module.exports = PathResolver;