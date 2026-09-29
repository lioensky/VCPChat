# ProjectForge AST Indexer Runtimes

此目录由 `npm run build`（或 `npm run build:pf-indexer`）自动生成本机索引器 Release 运行时。

目录约定：

```text
bin/
├── win32-x64/
│   └── projectforge_indexer.exe
├── win32-arm64/
│   └── projectforge_indexer.exe
├── darwin-x64/ | darwin-arm64/ | linux-x64/ | linux-arm64/
│   └── projectforge_indexer
```

构建脚本位于：

```text
rust_projectforge_indexer/build-runtime.js
```

规则：

1. 构建只原生编译当前操作系统和 CPU 架构；其他平台请在对应平台构建。
2. 仓库跟踪 `win32-x64/projectforge_indexer.exe` 作为无 Rust 环境的 Windows x64 bootstrap 运行时（与 VCP-CDS 同策略）；协议版本（`PROTOCOL_VERSION`）或符号提取规则变化时必须与源码同步提交。其他本地生成的二进制不提交 Git。
3. 二进制缺失或协议不匹配时插件不会失败：Outline / FindSymbol / `symbol=` 给出降级提示，其他施工命令照常可用。
4. Windows 上重新构建前请先停止 VCPDistributedServer / VChat，否则运行中的 exe 会被锁定。