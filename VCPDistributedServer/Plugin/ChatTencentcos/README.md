# ChatTencentcos 插件

## 概述

ChatTencentcos 是一个简化的腾讯云对象存储（COS）插件，专为VCPChat场景设计，支持文件上传和下载功能。

## 功能特性

- **upload_file**: 上传文件到腾讯云COS，支持自动压缩大文件和文件夹
- **download_file**: 从腾讯云COS下载文件
- 支持文件自动压缩（超过100MB）
- 完整的权限控制机制


## 安装要求

### 依赖包

请确保安装以下Python依赖包：

```bash
pip install python-dotenv>=0.19.0
pip install qcloud-cos-sdk>=5.0.0
```

或使用requirements.txt：

```bash
pip install -r requirements.txt
```

### 环境配置

1. 复制 `config.env.example` 为 `config.env`
2. 配置腾讯云COS相关参数：

```env
# 腾讯云COS配置
TENCENTCLOUD_SECRET_ID=your_secret_id_here
TENCENTCLOUD_SECRET_KEY=your_secret_key_here

# 基础COS配置
COS_BUCKET_NAME=test-1314943652
COS_REGION=ap-hongkong

# AgentAI操作文件夹的父目录配置
AGENT_PARENT_DIR=VCPAgentAI

# AgentAI操作文件夹配置
AGENT_FOLDERS_CONFIG=agent-data:true:true:true:true:false,agent-temp:true:true:true:true:true,agent-readonly:false:true:false:false:false

# 插件端口配置
PLUGIN_PORT=9786

# 文件压缩配置
COMPRESS_THRESHOLD_MB=100
```

## 使用说明

### 重要配置提示

**优先配置VCPToolBox\Plugin\TencentCOSBackup**

如果您的系统中同时部署了VCPToolBox和VCPChat：

1. **优先配置VCPToolBox\Plugin\TencentCOSBackup插件**
2. 如果VCPToolBox与VCPChat部署在同一台机器中，则无需配置ChatTencentcos插件
3. ChatTencentcos插件主要用于独立部署场景

### 获取插件指令

请前往VCPToolBox的AdminPanel面板的ChatTencentcos插件页面，复制指令描述到系统提示词中，或变为日记格式放入工具日记本中。

### 命令格式

#### 上传文件

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」ChatTencentcos「末」,
command:「始」upload_file「末」,
local_path:「始」/path/to/local/file.txt「末」,
cos_folder:「始」agent-data「末」,
remote_filename:「始」backup_file.txt「末」
<<<[END_TOOL_REQUEST]>>>
```

#### 下载文件

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」ChatTencentcos「末」,
command:「始」download_file「末」,
cos_key:「始」VCPAgentAI/agent-data/backup_file.txt「末」,
local_path:「始」/path/to/save/file.txt「末」
<<<[END_TOOL_REQUEST]>>>
```

## 权限配置

插件支持细粒度的文件夹权限控制：

- **agent-data**: 允许上传、列出、下载、复制和移动、禁止删除
- **agent-temp**: 允许所有操作（上传、列出、下载、复制和移动、删除）
- **agent-readonly**: 只允许列出，禁止其他操作

## 文件夹结构

腾讯云 COS 存储桶文件夹结构示例：

```
VCPAgentAI/
├── agent-data/
├── agent-temp/
└── agent-readonly/
```

## 安全说明

- 不建议在配置文件中直接配置TENCENTCLOUD_SECRET_ID与TENCENTCLOUD_SECRET_KEY
- 建议使用环境变量或配置子用户权限的方式管理密钥
- 为保证安全，插件不从远程服务器获取COS客户端


## 故障排除

### 常见问题

1. **连接失败**: 检查腾讯云密钥配置是否正确
2. **权限错误**: 确认文件夹权限配置是否正确
3. **文件不存在**: 检查本地文件路径是否正确
4. **配置错误**: 确认config.env文件中的所有必需参数都已配置

### 调试模式

如需调试，可以在config.env中添加：

```env
DEBUG_MODE=true
```

## 版本信息

- **版本**: 1.0.0
- **作者**: liukk222
- **插件类型**: synchronous
- **通信协议**: stdio
- **默认端口**: 9786

## 许可证

本插件遵循VCPChat项目的许可证条款。

## 技术支持

如有问题或建议，请联系VCP开发团队。