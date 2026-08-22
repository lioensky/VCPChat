# VCPChat Rust 音频引擎（Rubato / DSP 实验分支）

该目录构建 VCPChat 的独立 Rust 音频服务。当前实验分支使用纯 Rust Rubato 4.0 f64 重采样路线，并迁入统一 DSP 阶段、流式进度、延迟、尾部、finish/reset 和实时无分配契约。

## 构建要求

- Rust stable toolchain
- Windows 使用 MSVC Rust target
- 不需要 vcpkg
- 不需要 pkg-config
- 不链接 libsoxr

## 标准构建

在该目录执行：

```cmd
cargo build --release --locked --bin audio_server --no-default-features --features rubato,loudness-db
```

如需针对当前 CPU 优化：

```cmd
set RUSTFLAGS=-C target-cpu=native
cargo build --release --locked --bin audio_server --no-default-features --features rubato,loudness-db
```

## 独立 A/B 产物

从工作区根目录运行：

```cmd
编译并部署音频引擎.bat
```

脚本输出：

```text
audio_engine/audio_server_rubato_dsp.exe
```

该文件名不会覆盖现有 SoXR 基线产物。双 CPU 构建可运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build_all.ps1
```

其输出为：

```text
audio_engine/audio_server_rubato_dsp_avx2.exe
audio_engine/audio_server_rubato_dsp_avx512.exe
```

## 技术边界

- 音频样本内部使用 f64。
- 常见采样率比例优先采用 Rubato FFT。
- 精确 2× Linear/High 上采样采用专用半带 FIR。
- 病态比例采用窗函数 Sinc。
- Minimum/Maximum phase 使用迁入的频谱或连续多相 FIR 扩展。
- 重采样接口显式报告 consumed、produced 和流式状态。
- 处理器声明 latency、tail、finish 和 reset 行为。
- 最终目标顺序为源域 DSP、卷积、动态响度、Rubato、True-Peak Limiter、Noise Shaper、终端格式转换。

## 对照解释

该实验产物包含 Rubato 路线和新版 DSP 管理，因此与旧产物的听感或性能差异代表“整条新音频路线”的差异，不能全部单独归因于 Rubato。若只比较重采样算法，应关闭其他 DSP，固定相位、采样率、drain、输出长度和终端格式后进行离线对齐、null test 与 ABX。