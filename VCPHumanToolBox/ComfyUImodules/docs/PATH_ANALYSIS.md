# 跨环境路径寻址问题分析

## 当前路径解析方式的问题

### 1. 硬编码相对路径问题
```javascript
// 当前前端路径解析 (comfyUIHandlers.js)
const configDir = path.resolve(__dirname, '..', '..', 'VCPToolBox', 'Plugin', 'ComfyUIGen');

// 当前后端路径解析 (ComfyUIGen.js)  
const SETTINGS_FILE = path.resolve(__dirname, 'comfyui-settings.json');
```

### 2. 不同部署场景的路径差异

#### 场景A: 开发环境 (你的当前结构)
```
D:\workspace\
├── VCPChat\              # 前端主程序
│   └── ComfyUImodules\    # 前端配置模块
└── VCPToolBox\            # 工具箱目录
    └── Plugin\
        └── ComfyUIGen\    # 后端插件
```

#### 场景B: 其他用户可能的结构
```
/home/user/apps/
├── VCPChat\              # 前端程序
└── SomeOtherDir\         # 不同的工具箱位置
    └── VCPToolBox\
        └── Plugin\
            └── ComfyUIGen\
```

#### 场景C: 打包发布后的结构
```
/app/
├── VCPChat\              # 主程序
├── plugins\              # 插件可能在不同位置
│   └── ComfyUIGen\
└── config\               # 配置可能集中存放
```

### 3. 路径解析失败的风险
- **相对路径依赖**: `path.resolve(__dirname, '..', '..')` 假设固定的目录层级
- **目录结构变化**: 用户可能有不同的工作区组织方式
- **跨平台兼容性**: Windows/Linux/macOS 路径分隔符不同
- **权限问题**: 不同位置的读写权限可能不同

## 潜在问题场景

### 场景1: 用户使用不同的工作区结构
```bash
# 你的结构
D:\workspace\VCPChat\
D:\workspace\VCPToolBox\

# 用户可能的结构  
C:\MyApps\VCPChat\
C:\Tools\VCPToolBox\

# 结果: path.resolve(__dirname, '..', '..') 找不到 VCPToolBox
```

### 场景2: 容器化部署
```dockerfile
# Docker 容器中的路径可能完全不同
/opt/vcpchat/
/var/lib/vcptoolbox/
```

### 场景3: 便携版安装
```
PortableApps\
├── VCPChat\
└── Data\
    └── VCPToolBox\
```

## 需要解决的核心问题
1. **路径发现**: 如何自动找到 VCPToolBox 目录
2. **配置存储**: 配置文件应该存放在哪里
3. **跨环境兼容**: 支持各种部署方式
4. **降级策略**: 找不到路径时的备选方案