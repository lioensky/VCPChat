# Rust 音频重采样模块

该模块为 VCPChat 的 Python 音频引擎提供高性能的音频重采样功能。

## 构建说明

本项目使用 `maturin` 进行构建，依赖 vcpkg 安装的 soxr 库。

### 编译命令 (Windows CMD)

```cmd
cd H:\VCP\VCPChat\rust_audio_engine
set PATH=H:\VCP\vcpkg\installed\x64-windows-static\tools\pkgconf;%PATH%
set "PKG_CONFIG_PATH=H:\VCP\vcpkg\installed\x64-windows-static\lib\pkgconfig"
set RUSTFLAGS=-C target-cpu=native
py -3.13 -m maturin build --release --interpreter python3.13
```

### 安装命令

```cmd
py -3.13 -m pip install target/wheels/rust_audio_resampler-0.1.0-cp313-cp313-win_amd64.whl --force-reinstall
```

### 一键编译安装 (Windows CMD)

```cmd
cd H:\VCP\VCPChat\rust_audio_engine && set PATH=H:\VCP\vcpkg\installed\x64-windows-static\tools\pkgconf;%PATH% && set "PKG_CONFIG_PATH=H:\VCP\vcpkg\installed\x64-windows-static\lib\pkgconfig" && set RUSTFLAGS=-C target-cpu=native && py -3.13 -m maturin build --release --interpreter python3.13 && py -3.13 -m pip install target/wheels/rust_audio_resampler-0.1.0-cp313-cp313-win_amd64.whl --force-reinstall
```

```cmd
cd rust_audio_engine && set PATH=H:\VCP\vcpkg\installed\x64-windows-static\tools\pkgconf;%PATH% && set "PKG_CONFIG_PATH=H:\VCP\vcpkg\installed\x64-windows-static\lib\pkgconfig" && set RUSTFLAGS=-C target-cpu=native && cargo build --release
```
```
$env:PATH = "H:\VCP\vcpkg\installed\x64-windows-static\tools\pkgconf;$env:PATH"; $env:PKG_CONFIG_PATH = "H:\VCP\vcpkg\installed\x64-windows-static\lib\pkgconfig"; $env:RUSTFLAGS = "-C target-cpu=native"; cargo build --release
```


## 关键技术点

- **SIMD 加速**: 通过 `target-cpu=native` 开启，显著提升 FFT 卷积和噪声整形的性能。
- **Python 3.13**: 完美支持最新版 Python。
- **64-bit Pipeline**: 内部处理全程保持双精度浮点。
- **高精度相位时钟**: 启用 `QualityFlags::HighPrecisionClock`，提升无理数采样率比的精度。
- **极高品质**: 使用 `QualityRecipe::very_high()` (= Bits28) 配置。
- **多通道支持**: 1-2 通道使用 Stereo 格式高效处理，3+ 通道使用 Mono 逐通道处理。