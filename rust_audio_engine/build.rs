fn main() {
    // 仅在 Windows MSVC 环境下处理
    if std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default() == "windows" {
        // 使用 vcpkg 自动探测 soxr (支持 x64-windows-static-md)
        // 正确的 API 是 vcpkg::find_package
        // 尝试 vcpkg，如果不成功则尝试 pkg-config
        if vcpkg::find_package("soxr").is_err() {
            // 如果 vcpkg 探测失败，尝试传统的 pkg-config (由脚本设置的环境变量驱动)
            if let Err(e2) = pkg_config::probe_library("soxr") {
                // 只有当两者都失败时才打印警告
                println!("cargo:warning=Both vcpkg and pkg-config failed to find soxr: {}", e2);
            }
        }
    }

    // 重新运行触发条件
    println!("cargo:rerun-if-changed=build.rs");
}
