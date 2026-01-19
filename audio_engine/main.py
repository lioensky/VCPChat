import os
import threading
import time
import numpy as np
import soundfile as sf
import sounddevice as sd
from scipy.signal import tf2sos, sosfilt, firwin2, lfilter # resample is now handled by Rust
from mutagen import File as MutagenFile
from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import logging
import argparse
import hashlib
import subprocess
import io
# --- 尝试加载 .env 配置文件 ---
try:
    from dotenv import load_dotenv
    load_dotenv()
    logging.info("Loaded environment variables from .env file.")
except ImportError:
    logging.warning("python-dotenv not installed, skipping .env loading.")

# --- 动态导入 Rust 模块，增强鲁棒性 ---
try:
    import rust_audio_resampler
    RUST_RESAMPLER_AVAILABLE = True
    logging.info("Successfully imported Rust audio resampler module.")
except ImportError:
    rust_audio_resampler = None
    RUST_RESAMPLER_AVAILABLE = False
    logging.warning("Could not import 'rust_audio_resampler'. "
                    "High-quality upsampling will be disabled. "
                    "The application will continue with basic functionality.")

# --- 全局配置 ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
app = Flask(__name__)
CORS(app)  # 允许跨域请求
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='gevent')

# --- 音频引擎核心类 ---
class AudioEngine:
    """
    管理音频播放、解码、FFT计算和状态的核心类。
    在一个独立的线程中运行以避免阻塞Flask服务器。
    """
    def __init__(self, socketio_instance):
        self.socketio = socketio_instance
        self.stream = None
        self.file_path = None
        self.data = None
        self.samplerate = 0
        self.channels = 0
        self.position = 0
        self.is_playing = False
        self.is_paused = False
        self.lock = threading.RLock() # 使用可重入锁解决死锁问题
        self.thread = None
        self.stop_event = threading.Event()
        self.volume = 1.0  # 音量，范围 0.0 到 1.0
        self.fft_size = 2048  # FFT窗口大小, for better low-freq resolution
        self.hanning_window = np.hanning(self.fft_size) # 性能优化：预计算汉宁窗
        self.fft_update_interval = 1.0 / 20.0  # B3: 更新频率降至20Hz，降低前端负载
        self.num_log_bins = 48 # Number of bars for the visualizer
        self.device_id = None # Can be None for default device
        self.exclusive_mode = False
        # --- 从环境变量读取初始配置，实现简单的持久化/预设 ---
        env_target_sr = os.environ.get('VCP_AUDIO_TARGET_SAMPLERATE')
        self.target_samplerate = int(env_target_sr) if env_target_sr and env_target_sr.isdigit() else None
        
        env_eq_type = os.environ.get('VCP_AUDIO_EQ_TYPE', 'IIR').upper()
        self.eq_type = env_eq_type if env_eq_type in ['IIR', 'FIR'] else 'IIR'
        
        # 是否启用抢跑重采样
        self.preemptive_resample = os.environ.get('VCP_AUDIO_PREEMPTIVE_RESAMPLE', 'true').lower() != 'false'
        
        # 重采样质量档位: low, std, hq, uhq
        self.resample_quality = os.environ.get('VCP_AUDIO_RESAMPLE_QUALITY', 'hq').lower()

       # --- EQ Settings ---
        self.eq_enabled = False
        self.eq_bands = {
           '31': 0, '62': 0, '125': 0, '250': 0, '500': 0,
           '1k': 0, '2k': 0, '4k': 0, '8k': 0, '16k': 0
        }
        self.eq_filters = {} # To store SOS filter coefficients
        self.eq_zi = {} # To store initial filter conditions for each channel
        self.resample_cache_dir = None
        
        # --- New Optimization States ---
        self.dither_enabled = True
        self.dither_bits = 24  # Target output bit depth
        
        self._current_volume = 1.0   # Actually applied volume
        self._target_volume = 1.0    # Target volume
        self._volume_smoothing = 0.995  # Smoothing coefficient
        
        self.eq_type = 'IIR' # 'IIR' or 'FIR'
        self.fir_coeffs = None
        self.fir_zi = None
        self.fir_convolver = None # Rust FFT Convolver instance
        
        self.replaygain_enabled = True
        self.ns_state = None # Noise shaping state

    def _initialize_ns_state(self):
        """初始化 5 阶噪声整形的状态"""
        if self.channels > 0:
            # 每个通道 5 个误差历史记录
            self.ns_state = np.zeros(self.channels * 5, dtype=np.float64)

    def _apply_noise_shaping(self, audio_data):
        """
        使用 Rust 实现的高性能 5 阶心理声学噪声整形
        """
        if not self.dither_enabled or not RUST_RESAMPLER_AVAILABLE:
            return audio_data
        
        # 检查 Rust 模块是否包含该函数
        if not hasattr(rust_audio_resampler, 'apply_noise_shaping_high_order'):
            return audio_data

        if self.ns_state is None or len(self.ns_state) != self.channels * 5:
            self._initialize_ns_state()
        
        # 展平数据以适应 Rust 接口
        original_shape = audio_data.shape
        flat_data = audio_data.flatten()
        
        # 调用 Rust 噪声整形，并更新状态
        shaped_data, next_state = rust_audio_resampler.apply_noise_shaping_high_order(
            flat_data,
            self.ns_state,
            sample_rate=self.samplerate,
            bits=self.dither_bits,
            channels=self.channels
        )
        
        self.ns_state = next_state
        return shaped_data.reshape(original_shape)

    def _stream_callback(self, outdata, frames, time, status):
        """sounddevice的回调函数，用于填充音频数据"""
        if status:
            logging.warning(f"Stream callback status: {status}")

        with self.lock:
            if self.data is None or self.position + frames > len(self.data):
                outdata.fill(0)
                self.is_playing = False
                return

            chunk = self.data[self.position : self.position + frames].copy() # Use a copy to modify
                
            # --- Apply EQ if enabled ---
            if self.eq_enabled:
                if self.eq_type == 'IIR' and self.eq_filters:
                    # 性能优化 (B2): 将所有启用的SOS滤波器级联后下沉到 Rust 处理
                    active_sos_list = [self.eq_filters[band] for band in self.eq_filters if self.eq_bands.get(band, 0) != 0]
                    if active_sos_list:
                        cascaded_sos = np.vstack(active_sos_list)
                        
                        if RUST_RESAMPLER_AVAILABLE and hasattr(rust_audio_resampler, 'apply_iir_sos'):
                            # 准备连续的 zi 缓冲区 [channels * n_sections * 2]
                            n_sections = cascaded_sos.shape[0]
                            flat_zi = np.zeros(self.channels * n_sections * 2, dtype=np.float64)
                            
                            for i in range(self.channels):
                                if i not in self.eq_zi: self._initialize_eq_zi(i)
                                active_zi = np.vstack([self.eq_zi[i][band] for band in self.eq_filters if self.eq_bands.get(band, 0) != 0])
                                flat_zi[i * n_sections * 2 : (i + 1) * n_sections * 2] = active_zi.flatten()
                            
                            # 调用 Rust 实现的 IIR 滤波
                            flat_chunk = chunk.flatten()
                            processed_flat, next_flat_zi = rust_audio_resampler.apply_iir_sos(
                                flat_chunk, cascaded_sos.flatten(), flat_zi, channels=self.channels
                            )
                            chunk = processed_flat.reshape(chunk.shape)
                            
                            # 写回更新后的 zi
                            for i in range(self.channels):
                                updated_zi_ch = next_flat_zi[i * n_sections * 2 : (i + 1) * n_sections * 2].reshape((n_sections, 2))
                                zi_counter = 0
                                for band in self.eq_filters:
                                    if self.eq_bands.get(band, 0) != 0:
                                        num_sections = self.eq_filters[band].shape[0]
                                        self.eq_zi[i][band] = updated_zi_ch[zi_counter : zi_counter + num_sections, :]
                                        zi_counter += num_sections
                        else:
                            # 回退到 Python 实现
                            for i in range(self.channels):
                                if i not in self.eq_zi: self._initialize_eq_zi(i)
                                channel_data = chunk[:, i] if self.channels > 1 else chunk
                                active_zi = np.vstack([self.eq_zi[i][band] for band in self.eq_filters if self.eq_bands.get(band, 0) != 0])
                                channel_data, updated_zi = sosfilt(cascaded_sos, channel_data, zi=active_zi)
                                zi_counter = 0
                                for band in self.eq_filters:
                                    if self.eq_bands.get(band, 0) != 0:
                                        num_sections = self.eq_filters[band].shape[0]
                                        self.eq_zi[i][band] = updated_zi[zi_counter : zi_counter + num_sections, :]
                                        zi_counter += num_sections
                                if self.channels > 1: chunk[:, i] = channel_data
                                else: chunk = channel_data
                elif self.eq_type == 'FIR':
                    if self.fir_convolver is not None:
                        # 使用 Rust FFT 卷积引擎 (Overlap-Save)
                        flat_chunk = chunk.flatten()
                        processed_flat = self.fir_convolver.process(flat_chunk)
                        chunk = processed_flat.reshape(chunk.shape)
                    elif self.fir_coeffs is not None:
                        # 回退到 scipy lfilter (仅当 Rust 模块不可用时)
                        if self.fir_zi is None or len(self.fir_zi) != self.channels:
                            self._initialize_fir_zi()
                        
                        for i in range(self.channels):
                            channel_data = chunk[:, i] if self.channels > 1 else chunk
                            channel_data, self.fir_zi[i] = lfilter(self.fir_coeffs, 1.0, channel_data, zi=self.fir_zi[i])
                            if self.channels > 1:
                                chunk[:, i] = channel_data
                            else:
                                chunk = channel_data

            # --- Apply Volume Smoothing (Anti-Zipper Noise) ---
            if RUST_RESAMPLER_AVAILABLE and hasattr(rust_audio_resampler, 'apply_volume_smoothing'):
                # 下沉到 Rust 处理音量平滑
                flat_chunk = chunk.flatten()
                mixed_flat, self._current_volume = rust_audio_resampler.apply_volume_smoothing(
                    flat_chunk, self._current_volume, self._target_volume,
                    smoothing=self._volume_smoothing, channels=self.channels
                )
                mixed = mixed_flat.reshape(chunk.shape)
            else:
                volume_ramp = np.zeros(frames)
                for i in range(frames):
                    self._current_volume += (self._target_volume - self._current_volume) * (1 - self._volume_smoothing)
                    volume_ramp[i] = self._current_volume
                
                if self.channels > 1:
                    mixed = chunk * volume_ramp[:, np.newaxis]
                else:
                    mixed = chunk * volume_ramp

            # --- Apply High-Order Noise Shaping ---
            mixed = self._apply_noise_shaping(mixed)

            # --- Soft Clipping / Headroom Protection ---
            # 预留 0.1dB 的 Headroom 防止某些 DAC 内部插值溢出导致的爆音
            limit = 0.99
            np.clip(mixed, -limit, limit, out=mixed)
            
            # 最终转换为 32-bit float 输出给驱动
            outdata[:] = mixed.astype(np.float32)
            self.position += frames

    def _playback_thread(self):
        """在独立线程中运行播放和FFT计算"""
        last_fft_time = 0
        while not self.stop_event.is_set():
            if self.is_playing and not self.is_paused:
                current_time = time.time()
                # --- FFT 计算和发送 ---
                if current_time - last_fft_time >= self.fft_update_interval:
                    last_fft_time = current_time
                    with self.lock:
                        if self.data is None:
                            continue
                        # 获取当前播放位置附近的数据块用于FFT
                        start = self.position
                        end = start + self.fft_size
                        if end > len(self.data):
                            # 如果接近末尾，补零
                            pad_width = end - len(self.data)
                            if self.channels > 1:
                                fft_chunk = np.pad(self.data[start:], ((0, pad_width), (0, 0)), 'constant')
                            else:
                                fft_chunk = np.pad(self.data[start:], (0, pad_width), 'constant')
                        else:
                            fft_chunk = self.data[start:end]
                        
                        # 如果是多声道，转为单声道
                        if self.channels > 1:
                            fft_chunk = fft_chunk.mean(axis=1)

                        # 应用汉宁窗以减少频谱泄漏
                        # 性能优化 (B1): 使用预计算的汉宁窗
                        fft_chunk = fft_chunk * self.hanning_window
                        
                        # 执行FFT
                        fft_result = np.fft.rfft(fft_chunk)
                        magnitude = np.abs(fft_result)
                        
                        # CRITICAL FIX: Normalize the FFT magnitude by the window size.
                        # This is the root cause of all previous "clipping" and "flat" issues.
                        # Without this, the magnitude scale is arbitrary and far too large.
                        magnitude = magnitude / self.fft_size

                        # --- New Logarithmic Binning ---
                        freqs = np.fft.rfftfreq(self.fft_size, 1.0 / self.samplerate)

                        # Ignore DC component (first bin) and Nyquist
                        freqs = freqs[1:-1]
                        magnitude = magnitude[1:-1]

                        log_binned_magnitude = np.zeros(self.num_log_bins)
                        if len(freqs) > 0:
                            # Define logarithmic bin edges
                            min_freq = 20
                            max_freq = self.samplerate / 2
                            if max_freq > min_freq:
                                log_min = np.log10(min_freq)
                                log_max = np.log10(max_freq)
                                
                                log_bin_edges = np.logspace(log_min, log_max, self.num_log_bins + 1)
                                
                                # Assign each FFT frequency to a log bin using digitize
                                bin_indices = np.digitize(freqs, log_bin_edges)
                                
                                for i in range(1, self.num_log_bins + 1):
                                    in_bin_mask = (bin_indices == i)
                                    if np.any(in_bin_mask):
                                        # Use Root Mean Square (RMS) for a perceptually accurate representation of power.
                                        log_binned_magnitude[i-1] = np.sqrt(np.mean(np.square(magnitude[in_bin_mask])))

                        # 转换为分贝并归一化
                        log_magnitude = 20 * np.log10(log_binned_magnitude + 1e-9) # 避免log(0)
                        
                        # With the FFT properly normalized, we can use a standard 90dB dynamic range.
                        # This provides a good balance of sensitivity and headroom.
                        normalized_magnitude = np.clip((log_magnitude + 90) / 90, 0, 1)

                    # 通过WebSocket发送频谱数据
                    self.socketio.emit('spectrum_data', {'data': normalized_magnitude.tolist()})

                # --- 检查播放是否结束 ---
                with self.lock:
                    if self.data is None or self.position >= len(self.data):
                        self.is_playing = False
                        self.socketio.emit('playback_state', self.get_state())

            # 短暂休眠以降低CPU使用率
            time.sleep(0.01)

    def _read_replaygain(self, file_path):
        """读取ReplayGain标签"""
        try:
            audio_file = MutagenFile(file_path, easy=True)
            if audio_file is None:
                return 0.0
            
            # 尝试不同的tag格式
            rg_tags = [
                'replaygain_track_gain',
                'REPLAYGAIN_TRACK_GAIN',
                'R128_TRACK_GAIN'
            ]
            
            for tag in rg_tags:
                if tag in audio_file:
                    gain_str = audio_file[tag][0]
                    # 解析 "+3.5 dB" 格式
                    gain_db = float(gain_str.replace('dB', '').strip())
                    return gain_db
            return 0.0
        except Exception as e:
            logging.debug(f"Could not read ReplayGain: {e}")
            return 0.0

    def load(self, file_path):
        """加载音频文件，应用缓存，并为播放做准备。"""
        try:
            with self.lock:
                self.stop()

                # --- 1. Load Audio Data (with FFmpeg fallback) ---
                try:
                    logging.info(f"Attempting to load {file_path} with soundfile...")
                    original_data, original_samplerate = sf.read(file_path, dtype='float64')
                    logging.info("Successfully loaded with soundfile.")
                except sf.LibsndfileError as e:
                    # 修改：对所有 soundfile 错误都尝试 FFmpeg 回退
                    # 这样可以解决 Windows 中文路径 MP3 文件的问题
                    logging.warning(f"Soundfile failed: {e}. Falling back to FFmpeg.")
                    ffmpeg_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'bin', 'ffmpeg.exe'))
                    if not os.path.exists(ffmpeg_path):
                        logging.warning(f"ffmpeg.exe not found at {ffmpeg_path}, assuming it's in PATH.")
                        ffmpeg_path = 'ffmpeg'

                    # 改进的 FFmpeg 命令：降低日志噪音，并标准化输出为 f32le PCM
                    command = [
                        ffmpeg_path, '-v', 'error',
                        '-i', file_path,
                        '-acodec', 'pcm_f32le', # 标准化为 32-bit float
                        '-f', 'wav', '-'
                    ]
                    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    stdout_data, stderr_data = process.communicate()

                    if process.returncode != 0:
                        err_msg = f"FFmpeg failed with return code {process.returncode}. Stderr: {stderr_data.decode(errors='ignore')}"
                        logging.error(err_msg)
                        raise sf.LibsndfileError(f"FFmpeg decoding failed for {file_path}")

                    try:
                        original_data, original_samplerate = sf.read(io.BytesIO(stdout_data), dtype='float64')
                        logging.info(f"Successfully loaded {file_path} via FFmpeg.")
                    except Exception as read_e:
                        logging.error(f"Failed to read from FFmpeg stdout stream: {read_e}", exc_info=True)
                        raise read_e

                # --- 2. Correctly Determine Channels ---
                # 修复：在读取数据后立即确定通道数
                channels = original_data.shape[1] if original_data.ndim > 1 else 1

                # --- 3. Determine Target Samplerate ---
                target_sr = original_samplerate
                
                # 优先级 1: 用户手动设置的强制升频
                if self.target_samplerate:
                    target_sr = self.target_samplerate
                
                # 优先级 2: 独占模式下，匹配硬件原生采样率
                if self.exclusive_mode and self.device_id is not None:
                    try:
                        device_info = sd.query_devices(self.device_id)
                        hostapi_info = sd.query_hostapis(device_info['hostapi'])
                        if 'WASAPI' in hostapi_info['name']:
                            target_sr = int(device_info.get('default_samplerate', target_sr))
                    except Exception as e:
                        logging.warning(f"Could not query device for WASAPI default samplerate: {e}")
                
                # 优先级 3: 共享模式下的“抢跑”重采样 (Preemptive Resampling)
                elif not self.exclusive_mode and self.preemptive_resample:
                    mixer_sr = self._get_system_mixer_samplerate()
                    if mixer_sr != target_sr:
                        logging.info(f"Preemptive Resampling active: Target changed from {target_sr} to system mixer rate {mixer_sr}")
                        target_sr = mixer_sr

                # --- 4. Robust Caching Logic ---
                # 修复：使用更健壮的缓存键
                st = os.stat(file_path)
                key = f"{file_path}|{st.st_mtime_ns}|{st.st_size}|sr={target_sr}|fmt=f32le|ch={channels}"
                cache_filename = hashlib.md5(key.encode()).hexdigest() + '.wav'
                # 检查是否通过环境变量禁用了缓存
                use_cache = os.environ.get('VCP_AUDIO_USE_CACHE', 'true').lower() != 'false'
                cache_filepath = os.path.join(self.resample_cache_dir, cache_filename) if (self.resample_cache_dir and use_cache) else None

                if cache_filepath and os.path.exists(cache_filepath):
                    logging.info(f"Loading resampled data from cache: {cache_filepath}")
                    self.data, self.samplerate = sf.read(cache_filepath, dtype='float64')
                else:
                    # --- 5. Perform Resampling if needed (with graceful fallback) ---
                    if target_sr != original_samplerate:
                        if RUST_RESAMPLER_AVAILABLE:
                            logging.info(f"Resampling from {original_samplerate} Hz to {target_sr} Hz using Rust module...")
                            flat_data = original_data.flatten()
                            
                            # 修复：将正确的通道数传递给 Rust 重采样器
                            resampled_flat = rust_audio_resampler.resample(
                                flat_data,
                                original_samplerate,
                                target_sr,
                                channels, # 使用局部变量 `channels`
                                quality=self.resample_quality
                            )
                            
                            self.data = resampled_flat.reshape((-1, channels)) # 使用局部变量 `channels`
                            self.samplerate = target_sr
                            logging.info("Resampling complete.")
                            
                            if cache_filepath:
                                logging.info(f"Writing resampled data to cache: {cache_filepath}")
                                sf.write(cache_filepath, self.data, self.samplerate)
                        else:
                            logging.warning(f"Upsampling from {original_samplerate} Hz to {target_sr} Hz is required, but the Rust resampler module is not available. Playback will use the original sample rate.")
                            self.data = original_data
                            self.samplerate = original_samplerate
                    else:
                        self.data = original_data
                        self.samplerate = original_samplerate

                # --- 5.5 Apply ReplayGain ---
                if self.replaygain_enabled:
                    rg_db = self._read_replaygain(file_path)
                    if rg_db != 0:
                        rg_linear = 10 ** (rg_db / 20.0)
                        self.data = self.data * rg_linear
                        logging.info(f"Applied ReplayGain: {rg_db:.1f} dB")

                # --- 6. Finalize State ---
                self.file_path = file_path
                self.channels = channels # 使用我们之前确定的正确通道数
                self.position = 0
                self.is_playing = False
                self.is_paused = False
                
                # 为新加载的音轨（可能有多声道）重新初始化EQ和噪声整形状态
                self._design_eq_filters()
                self._initialize_ns_state()

                logging.info(f"Loaded '{file_path}', Samplerate: {self.samplerate}, Channels: {self.channels}, Duration: {len(self.data)/self.samplerate:.2f}s")
                return True
        except Exception as e:
            logging.error(f"Failed to load file {file_path}: {e}", exc_info=True)
            with self.lock:
                self.file_path = None
                self.data = None
            return False

    def play(self):
        """开始或恢复播放"""
        with self.lock:
            if not self.file_path or self.data is None:
                logging.warning("No file loaded to play.")
                return False
            
            if self.is_playing and self.is_paused: # 恢复播放
                self.stream.start()
                self.is_paused = False
                logging.info("Playback resumed.")
            elif not self.is_playing: # 从头开始播放
                self.position = 0
                
                # --- New: Configure device and exclusive mode ---
                stream_args = {
                    'samplerate': self.samplerate,
                    'channels': self.channels,
                    'callback': self._stream_callback
                }
                if self.device_id is not None:
                    stream_args['device'] = self.device_id
                
                if self.exclusive_mode:
                    try:
                        device_info = sd.query_devices(self.device_id)
                        hostapi_info = sd.query_hostapis(device_info['hostapi'])
                        if 'WASAPI' in hostapi_info['name']:
                            stream_args['extra_settings'] = sd.WasapiSettings(exclusive=True)
                            logging.info(f"Attempting to open device {self.device_id} in WASAPI Exclusive Mode.")
                    except Exception as e:
                        logging.error(f"Could not set WASAPI exclusive mode: {e}")

                self.stream = sd.OutputStream(**stream_args)
                self.stream.start()
                self.is_playing = True
                self.is_paused = False
                
                # 启动后台线程
                if self.thread is None or not self.thread.is_alive():
                    self.stop_event.clear()
                    self.thread = threading.Thread(target=self._playback_thread, daemon=True)
                    self.thread.start()
                logging.info("Playback started.")
        return True

    def pause(self):
        """暂停播放"""
        with self.lock:
            if self.is_playing and not self.is_paused:
                self.stream.stop()
                self.is_paused = True
                logging.info("Playback paused.")
        return True

    def seek(self, position_seconds):
        """跳转到指定时间"""
        with self.lock:
            if self.data is not None:
                new_position = int(position_seconds * self.samplerate)
                if 0 <= new_position < len(self.data):
                    self.position = new_position
                    logging.info(f"Seeked to {position_seconds:.2f}s (frame {self.position})")
                    return True
        return False

    def stop(self):
        """停止播放并清理资源"""
        with self.lock:
            if self.stream:
                self.stream.stop()
                self.stream.close()
                self.stream = None
            self.is_playing = False
            self.is_paused = False
            self.position = 0
        # 停止后台线程
        self.stop_event.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1)
        self.thread = None
        logging.info("Playback stopped and resources cleaned up.")

    def get_state(self):
        """获取当前播放器状态"""
        with self.lock:
            duration = len(self.data) / self.samplerate if self.data is not None else 0
            current_time = self.position / self.samplerate if self.samplerate > 0 else 0
            return {
                'is_playing': self.is_playing,
                'is_paused': self.is_paused,
                'duration': duration,
                'current_time': current_time,
                'file_path': self.file_path,
                'volume': self.volume,
                'device_id': self.device_id,
                'exclusive_mode': self.exclusive_mode,
                'eq_type': self.eq_type,
                'dither_enabled': self.dither_enabled,
                'replaygain_enabled': self.replaygain_enabled
            }

    def _get_system_mixer_samplerate(self):
        """获取Windows混音器的当前采样率"""
        try:
            # 查询默认输出设备
            device_info = sd.query_devices(kind='output')
            return int(device_info.get('default_samplerate', 48000))
        except Exception as e:
            logging.warning(f"Could not query system mixer samplerate: {e}")
            return 48000

    def set_volume(self, volume_level):
        """设置音量"""
        with self.lock:
            self._target_volume = float(volume_level)
            self.volume = self._target_volume # Keep for API compatibility
            logging.info(f"Target volume set to {self._target_volume}")
            return True

    def _design_linear_phase_eq(self):
        """设计线性相位FIR均衡器 (计算量大但无相位失真)"""
        if self.samplerate == 0:
            return None
        
        # 构建目标频率响应
        num_taps = 4097  # 必须是奇数
        nyquist = self.samplerate / 2
        
        # 频率点 (归一化)
        freq_points = [0, 31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000, nyquist]
        freq_points_normalized = [f / nyquist for f in freq_points]
        
        # 对应的增益 (从dB转为线性)
        bands_list = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']
        gain_db = [0] + [self.eq_bands.get(b, 0) for b in bands_list] + [self.eq_bands.get('16k', 0)]
        gain_linear = [10 ** (g / 20.0) for g in gain_db]
        
        # 确保频率点单调递增且在有效范围内
        freq_points_normalized = np.clip(freq_points_normalized, 0, 1)
        
        # 设计FIR滤波器
        fir_coeffs = firwin2(num_taps, freq_points_normalized, gain_linear)
        return fir_coeffs

    def _initialize_fir_zi(self):
        """Initialize FIR filter state"""
        if self.fir_coeffs is not None:
            self.fir_zi = [np.zeros(len(self.fir_coeffs) - 1) for _ in range(self.channels if self.channels > 0 else 1)]

    def _design_eq_filters(self):
        """根据当前的EQ设置设计IIR滤波器。"""
        if self.samplerate == 0:
            return
        
        nyquist = 0.5 * self.samplerate
        self.eq_filters = {} # 总是重新创建
        
        bands_config = {
           '31': (31, 1.41), '62': (62, 1.41), '125': (125, 1.41),
           '250': (250, 1.41), '500': (500, 1.41), '1k': (1000, 1.41),
           '2k': (2000, 1.41), '4k': (4000, 1.41), '8k': (8000, 1.41),
           '16k': (16000, 1.41)
        }

        # 按照频率排序以保证级联处理的顺序
        sorted_bands = sorted(bands_config.keys(), key=lambda b: bands_config[b][0])

        for band in sorted_bands:
            f0, Q = bands_config[band]
            gain_db = self.eq_bands.get(band, 0)
            
            # 注意：我们为所有频段都创建滤波器，即使增益为0。
            # 这样可以确保在回调中 `self.eq_zi[i][band]` 总是存在。
            # 实际是否应用该滤波器由回调中的 `if self.eq_bands.get(band, 0) != 0:` 决定。

            if f0 >= nyquist * 0.95:
                logging.warning(f"EQ band {band} ({f0} Hz) is too close to Nyquist frequency ({nyquist} Hz) and will be ignored.")
                if band in self.eq_filters:
                    del self.eq_filters[band] #确保它不会被使用
                continue

            A = 10**(gain_db / 40.0)
            w0 = 2 * np.pi * f0 / self.samplerate
            alpha = np.sin(w0) / (2.0 * Q)

            b0 = 1 + alpha * A
            b1 = -2 * np.cos(w0)
            b2 = 1 - alpha * A
            a0 = 1 + alpha / A
            a1 = -2 * np.cos(w0)
            a2 = 1 - alpha / A
            
            b = np.array([b0, b1, b2]) / a0
            a = np.array([a0, a1, a2]) / a0
            
            sos = tf2sos(b, a, analog=False)
            self.eq_filters[band] = sos
            
        if self.eq_type == 'FIR':
            self.fir_coeffs = self._design_linear_phase_eq()
            
            # 尝试初始化 Rust FFT 卷积器
            if RUST_RESAMPLER_AVAILABLE and hasattr(rust_audio_resampler, 'FFTConvolver'):
                try:
                    # 将单通道 IR 系数扩展并交错排列以匹配多通道输入
                    full_ir = np.tile(self.fir_coeffs[:, np.newaxis], (1, self.channels)).flatten()
                    self.fir_convolver = rust_audio_resampler.FFTConvolver(full_ir, self.channels)
                    logging.info(f"Initialized Rust FFT Convolver for {self.channels} channels.")
                except Exception as e:
                    logging.error(f"Failed to initialize Rust FFT Convolver: {e}")
                    self.fir_convolver = None
                    self._initialize_fir_zi()
            else:
                self._initialize_fir_zi()
            logging.info("Designed Linear Phase FIR EQ filter.")
        else:
            self._initialize_eq_zi()
            logging.info(f"Designed IIR EQ filters for bands: {list(self.eq_filters.keys())}")

    def _initialize_eq_zi(self, channel_index=None):
        """Initialize or reset the initial conditions for the EQ filters."""
        if not self.eq_filters:
            return

        def init_channel(ch_idx):
            self.eq_zi[ch_idx] = {}
            for band, sos in self.eq_filters.items():
                # The shape of zi for sosfilt is (n_sections, 2)
                self.eq_zi[ch_idx][band] = np.zeros((sos.shape[0], 2))

        if channel_index is not None:
            init_channel(channel_index)
        else:
            self.eq_zi = {}
            for i in range(self.channels if self.channels > 0 else 1):
                init_channel(i)

    def set_eq(self, bands, enabled):
        """Set EQ parameters and redesign filters."""
        with self.lock:
            self.eq_enabled = enabled
            if bands:
                for band, gain in bands.items():
                    if band in self.eq_bands:
                        # D2: 均衡器参数校验，增益限制在[-15, +15] dB
                        self.eq_bands[band] = np.clip(gain, -15.0, 15.0)
            
            self._design_eq_filters()
            logging.info(f"EQ set. Enabled: {self.eq_enabled}, Type: {self.eq_type}, Bands: {self.eq_bands}")
        return True

    def set_eq_type(self, eq_type):
        """Set EQ type (IIR or FIR)"""
        with self.lock:
            if eq_type.upper() in ['IIR', 'FIR']:
                self.eq_type = eq_type.upper()
                self._design_eq_filters()
                logging.info(f"EQ type set to {self.eq_type}")
                return True
        return False

    def configure_output(self, device_id=None, exclusive=False):
        """配置音频输出设备和模式"""
        with self.lock:
            was_playing = self.is_playing and not self.is_paused
            
            # Stop current playback before changing device
            if self.is_playing:
                self.stop()

            self.device_id = device_id
            self.exclusive_mode = exclusive
            logging.info(f"Audio output configured. Device: {self.device_id}, Exclusive: {self.exclusive_mode}")

            # If a track was playing, reload and play it on the new device
            if was_playing and self.file_path:
                # D1: 修正热切换时的seek逻辑
                # 保存切换前的采样帧索引和采样率
                old_position_frames = self.position
                old_samplerate = self.samplerate if self.samplerate > 0 else 1

                # 重要：重新加载文件以应用新的设备/模式设置（如重采样）
                if self.load(self.file_path):
                    # 按比例计算新的采样帧索引
                    new_position_frames = int(old_position_frames * (self.samplerate / old_samplerate))
                    self.position = new_position_frames
                    logging.info(f"Reloaded track for device change, mapped position from {old_position_frames} to {self.position}")
                    self.play()
           
            # Redesign filters for the new sample rate if necessary
            self._design_eq_filters()
        return True

    def configure_upsampling(self, target_rate):
        """配置目标升频采样率"""
        with self.lock:
            # 如果设置了新的速率，则设为None以使用原始速率
            self.target_samplerate = int(target_rate) if target_rate else None
            logging.info(f"Upsampling target rate set to: {self.target_samplerate} Hz.")

            # 重要：如果当前有加载的音轨，需要重新加载以应用新的升频设置
            if self.file_path:
                logging.info("Re-loading current track to apply new upsampling settings...")
                # 保存当前播放进度
                was_playing = self.is_playing and not self.is_paused
                # D1: 修正热切换时的seek逻辑
                old_position_frames = self.position
                old_samplerate = self.samplerate if self.samplerate > 0 else 1
                original_path = self.file_path
                
                # Reload the track. If it was playing, start it again.
                if self.load(original_path):
                    # 按比例计算新的采样帧索引
                    new_position_frames = int(old_position_frames * (self.samplerate / old_samplerate))
                    self.position = new_position_frames
                    logging.info(f"Reloaded track for upsampling change, mapped position from {old_position_frames} to {self.position}")
                    if was_playing:
                        self.play()
        return True
 
# --- 全局音频引擎实例 ---
audio_engine = AudioEngine(socketio)

# --- Helper Functions ---
def get_audio_devices():
    devices = sd.query_devices()
    hostapis = sd.query_hostapis()
    
    # Find the WASAPI host API index
    wasapi_index = -1
    for i, api in enumerate(hostapis):
        if 'WASAPI' in api['name']:
            wasapi_index = i
            break
            
    if wasapi_index == -1:
        logging.warning("WASAPI host API not found.")
        return {'wasapi': [], 'other': []}

    wasapi_devices = []
    other_devices = []
    
    for device in devices:
        # We only care about output devices
        if device['max_output_channels'] > 0:
            device_info = {
                'id': device['index'],
                'name': device['name'],
                'hostapi': device['hostapi'],
                'max_output_channels': device['max_output_channels'],
                'default_samplerate': device['default_samplerate']
            }
            if device['hostapi'] == wasapi_index:
                wasapi_devices.append(device_info)
            else:
                other_devices.append(device_info)
                
    return {'wasapi': wasapi_devices, 'other': other_devices}

# --- Flask API 路由 ---
@app.route('/devices', methods=['GET'])
def list_devices():
    try:
        devices = get_audio_devices()
        return jsonify({'status': 'success', 'devices': devices})
    except Exception as e:
        logging.error(f"Failed to list audio devices: {e}", exc_info=True)
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/configure_output', methods=['POST'])
def configure_output_device():
    data = request.get_json()
    device_id = data.get('device_id')
    exclusive = data.get('exclusive', False)
    
    if audio_engine.configure_output(device_id, exclusive):
        return jsonify({'status': 'success', 'message': 'Output configured', 'state': audio_engine.get_state()})
    else:
        return jsonify({'status': 'error', 'message': 'Failed to configure output'}), 500

@app.route('/configure_upsampling', methods=['POST'])
def configure_upsampling_route():
    data = request.get_json()
    target_rate = data.get('target_samplerate') # e.g., 96000, 192000, or null
    if audio_engine.configure_upsampling(target_rate):
        return jsonify({'status': 'success', 'message': f'Upsampling rate set to {target_rate}.'})
    else:
        return jsonify({'status': 'error', 'message': 'Failed to set upsampling rate.'}), 500
 
@app.route('/set_eq', methods=['POST'])
def set_eq():
   data = request.get_json()
   bands = data.get('bands') # e.g., {'60': 3, '1k': -2}
   enabled = data.get('enabled')
   
   if audio_engine.set_eq(bands, enabled):
       return jsonify({'status': 'success', 'message': 'EQ settings updated', 'state': audio_engine.get_state()})
   else:
       return jsonify({'status': 'error', 'message': 'Failed to update EQ settings'}), 500

@app.route('/set_eq_type', methods=['POST'])
def set_eq_type():
    data = request.get_json()
    eq_type = data.get('type')
    if audio_engine.set_eq_type(eq_type):
        return jsonify({'status': 'success', 'message': f'EQ type set to {eq_type}', 'state': audio_engine.get_state()})
    else:
        return jsonify({'status': 'error', 'message': 'Failed to set EQ type'}), 500

@app.route('/configure_optimizations', methods=['POST'])
def configure_optimizations():
    data = request.get_json()
    with audio_engine.lock:
        if 'dither_enabled' in data:
            audio_engine.dither_enabled = bool(data['dither_enabled'])
        if 'replaygain_enabled' in data:
            audio_engine.replaygain_enabled = bool(data['replaygain_enabled'])
    return jsonify({'status': 'success', 'message': 'Optimizations updated', 'state': audio_engine.get_state()})

@app.route('/load', methods=['POST'])
def load_track():
    data = request.get_json()
    file_path = data.get('path')
    if not file_path or not os.path.exists(file_path):
        return jsonify({'status': 'error', 'message': 'File not found'}), 400
    
    if audio_engine.load(file_path):
        return jsonify({'status': 'success', 'message': 'Track loaded', 'state': audio_engine.get_state()})
    else:
        return jsonify({'status': 'error', 'message': 'Failed to load track'}), 500

@app.route('/play', methods=['POST'])
def play_track():
    if audio_engine.play():
        return jsonify({'status': 'success', 'message': 'Playback started/resumed', 'state': audio_engine.get_state()})
    else:
        return jsonify({'status': 'error', 'message': 'Could not start playback'}), 500

@app.route('/pause', methods=['POST'])
def pause_track():
    if audio_engine.pause():
        return jsonify({'status': 'success', 'message': 'Playback paused', 'state': audio_engine.get_state()})
    else:
        return jsonify({'status': 'error', 'message': 'Could not pause playback'}), 500

@app.route('/seek', methods=['POST'])
def seek_track():
    data = request.get_json()
    position = data.get('position') # in seconds
    if position is None:
        return jsonify({'status': 'error', 'message': 'Position not provided'}), 400
    
    if audio_engine.seek(float(position)):
        return jsonify({'status': 'success', 'message': 'Seek successful', 'state': audio_engine.get_state()})
    else:
        return jsonify({'status': 'error', 'message': 'Seek failed'}), 500

@app.route('/state', methods=['GET'])
def get_state():
    return jsonify({'status': 'success', 'state': audio_engine.get_state()})

@app.route('/stop', methods=['POST'])
def stop_track():
    audio_engine.stop()
    return jsonify({'status': 'success', 'message': 'Playback stopped', 'state': audio_engine.get_state()})

@app.route('/volume', methods=['POST'])
def set_volume():
    data = request.get_json()
    volume = data.get('volume')
    if volume is None:
        return jsonify({'status': 'error', 'message': 'Volume not provided'}), 400
    
    if audio_engine.set_volume(volume):
        return jsonify({'status': 'success', 'message': 'Volume set', 'state': audio_engine.get_state()})
    else:
        return jsonify({'status': 'error', 'message': 'Failed to set volume'}), 500

# --- SocketIO 事件处理 ---
@socketio.on('connect')
def handle_connect():
    logging.info('Client connected to WebSocket')
    emit('response', {'data': 'Connected to Hi-Fi Audio Engine!'})

@socketio.on('disconnect')
def handle_disconnect():
    logging.info('Client disconnected from WebSocket')

# --- 主程序入口 ---
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Hi-Fi Audio Engine for VCP')
    parser.add_argument('--resample-cache-dir', type=str, help='Directory to store resampled audio files.')
    args = parser.parse_args()

    # 优先从命令行参数读取，其次从环境变量读取
    cache_dir = args.resample_cache_dir or os.environ.get('VCP_AUDIO_CACHE_DIR')
    if cache_dir:
        audio_engine.resample_cache_dir = cache_dir
        logging.info(f"Resample cache directory set to: {audio_engine.resample_cache_dir}")

    port = 5555
    logging.getLogger('werkzeug').disabled = True
    
    logging.info(f"Starting Hi-Fi Audio Engine on http://127.0.0.1:{port}")
    # Print a ready signal to stdout so the main process knows the server is up.
    import sys
    print("FLASK_SERVER_READY")
    sys.stdout.flush()
    socketio.run(app, host='127.0.0.1', port=port, debug=False, log_output=False)
