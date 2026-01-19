use pyo3::prelude::*;
use numpy::{PyReadonlyArrayDyn, PyArray, Ix1};
use rubato::{Resampler, SincFixedIn, SincInterpolationType, SincInterpolationParameters, WindowFunction};

/// 根据质量档位选择SincInterpolationParameters
fn get_sinc_params(quality: &str, ratio: f64) -> SincInterpolationParameters {
    // B1: 动态截止频率：降采样时使用更保守的截止频率以避免混叠
    let f_cutoff = if ratio < 1.0 { 0.90 } else { 0.95 };

    match quality {
        "low" => SincInterpolationParameters {
            sinc_len: 64,
            f_cutoff,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 64,
            window: WindowFunction::Hann,
        },
        "std" => SincInterpolationParameters {
            sinc_len: 128,
            f_cutoff,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 128,
            window: WindowFunction::Blackman,
        },
        "hq" => SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        },
        _ => SincInterpolationParameters { // "uhq" or default
            sinc_len: 512,
            f_cutoff,
            interpolation: SincInterpolationType::Cubic, // 升级为三次插值
            oversampling_factor: 512,
            window: WindowFunction::BlackmanHarris2,
        },
    }
}

/// This function resamples audio data from a source sample rate to a target sample rate.
/// It's designed to be called from Python and uses high-quality sinc interpolation.
#[pyfunction]
#[pyo3(signature = (input_data, original_sr, target_sr, channels, quality=None))]
fn resample(
    py: Python,
    input_data: PyReadonlyArrayDyn<f64>,
    original_sr: u32,
    target_sr: u32,
    channels: u32,
    quality: Option<&str>,
) -> PyResult<Py<PyArray<f64, Ix1>>> {
    // A2: 参数校验
    if original_sr == 0 || target_sr == 0 || channels == 0 {
        return Err(pyo3::exceptions::PyValueError::new_err("original_sr, target_sr, and channels must be > 0"));
    }

    // D1: 检查输入数组是否为连续内存
    let slice = input_data.as_slice().map_err(|_| {
        pyo3::exceptions::PyValueError::new_err("input_data must be a contiguous 1-D float64 numpy array")
    })?;

    // A1: 检查输入长度是否为通道数的整数倍
    if slice.len() % (channels as usize) != 0 {
        return Err(pyo3::exceptions::PyValueError::new_err("Input data length must be a multiple of the number of channels"));
    }
    
    // Fast path: 如果采样率相同，直接返回，无需处理
    if original_sr == target_sr {
        return Ok(PyArray::from_slice(py, slice).to_owned().into());
    }

    let ratio = target_sr as f64 / original_sr as f64;
    let quality_str = quality.unwrap_or("hq");
    let params = get_sinc_params(quality_str, ratio);

    // C2: 释放 GIL，允许 Python 线程在 Rust 计算密集型任务期间运行
    let resampled_output = py.allow_threads(move || {
        // 去交错
        let frames = slice.len() / channels as usize;
        let mut waves_in: Vec<Vec<f64>> = vec![Vec::with_capacity(frames); channels as usize];
        for frame in slice.chunks_exact(channels as usize) {
            for (ch, &sample) in frame.iter().enumerate() {
                waves_in[ch].push(sample);
            }
        }

        // 创建重采样器
        let mut resampler = SincFixedIn::new(
            ratio,
            2.0, // max_resample_ratio_relative, 2.0 is a safe default
            params,
            frames,
            channels as usize,
        ).map_err(|e| e.to_string())?; // 将错误转换为字符串

        // 处理音频
        let waves_out = resampler.process(&waves_in, None)
            .map_err(|e| e.to_string())?;

        // 再交错
        let out_frames = waves_out.get(0).map_or(0, |v| v.len());
        let mut output_vec = vec![0.0f64; out_frames * channels as usize];
        for i in 0..out_frames {
            for (ch, channel_data) in waves_out.iter().enumerate() {
                output_vec[i * channels as usize + ch] = channel_data[i];
            }
        }
        
        Ok(output_vec)
    })
    .map_err(|e: String| pyo3::exceptions::PyValueError::new_err(e))?;

    Ok(PyArray::from_vec(py, resampled_output).to_owned().into())
}

/// A Python module implemented in Rust.
#[pymodule]
fn rust_audio_resampler(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(resample, m)?)?;
    Ok(())
}