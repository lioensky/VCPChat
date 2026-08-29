# VCP-CDS Native Runtimes

此目录由项目根目录的 `npm run build` 自动生成本机 VCP-CDS Release 运行时。

目录约定：

```text
bin/
├── win32-x64/
│   └── vcp_chat_data_service.exe
├── win32-arm64/
│   └── vcp_chat_data_service.exe
├── darwin-x64/
│   └── vcp_chat_data_service
├── darwin-arm64/
│   └── vcp_chat_data_service
├── linux-x64/
│   └── vcp_chat_data_service
└── linux-arm64/
    └── vcp_chat_data_service
```

构建脚本位于：

```text
rust_chat_data_service/build-runtime.js
```

规则：

1. `npm run build` 只原生编译当前操作系统和 CPU 架构。
2. Windows、macOS、Linux 发布包应在对应平台的 CI Runner 或开发机上构建。
3. x64 与 arm64 产物不能混用。
4. macOS/Linux 产物会自动设置可执行权限。
5. 仓库跟踪 `win32-x64/vcp_chat_data_service.exe` 作为无 Rust 环境的 Windows x64 bootstrap 运行时；Protocol 或 Schema 变化时必须与源码同步提交。其他本地生成的二进制不提交 Git。
6. `npm run pack` 与 `npm run dist` 会自动先执行 `npm run build`。
