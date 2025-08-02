import os
import threading
import time
import numpy as np
import soundfile as sf
import sounddevice as sd
from scipy.signal import tf2sos, sosfilt # resample is now handled by Rust
from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import logging
import argparse
import hashlib
import subprocess
import io
import rust_audio_resampler # <-- 导入我们新的 Rust 模块

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
        self.fft_update_interval = 1.0 / 30.0  # 约每秒30次
        self.num_log_bins = 48 # Number of bars for the visualizer
        self.device_id = None # Can be None for default device
        self.exclusive_mode = False
        self.target_samplerate = None  # None代表不进行升频
       # --- EQ Settings ---
        self.eq_enabled = False
        self.eq_bands = {
           '31': 0, '62': 0, '125': 0, '250': 0, '500': 0,
           '1k': 0, '2k': 0, '4k': 0, '8k': 0, '16k': 0
        }
        self.eq_filters = {} # To store SOS filter coefficients
        self.eq_zi = {} # To store initial filter conditions for each channel
        self.resample_cache_dir = None

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
            if self.eq_enabled and self.eq_filters:
                for i in range(self.channels):
                    # Ensure zi exists for the channel
                    if i not in self.eq_zi:
                        self._initialize_eq_zi(i)
                    
                    channel_data = chunk[:, i] if self.channels > 1 else chunk
                    
                    # Apply each filter band
                    for band in self.eq_filters:
                        if self.eq_bands[band] != 0: # Only apply if gain is not 0
                            channel_data, self.eq_zi[i][band] = sosfilt(self.eq_filters[band], channel_data, zi=self.eq_zi[i][band])
                    
                    if self.channels > 1:
                        chunk[:, i] = channel_data
                    else:
                        chunk = channel_data

            # 应用音量
            outdata[:] = chunk * self.volume
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
                        window = np.hanning(self.fft_size)
                        fft_chunk = fft_chunk * window
                        
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

    def load(self, file_path):
        """加载音频文件，并应用缓存机制"""
        try:
            with self.lock:
                self.stop() # 先停止当前播放

                # --- Load Audio Data ---
                try:
                    # 尝试直接用 soundfile 加载
                    logging.info(f"Attempting to load {file_path} with soundfile...")
                    original_data, original_samplerate = sf.read(file_path, dtype='float64')
                    logging.info(f"Successfully loaded with soundfile.")
                except sf.LibsndfileError as e:
                    # 如果是格式无法识别的错误，则尝试使用 FFmpeg 作为后备方案
                    if 'Format not recognised' in str(e):
                        logging.warning(f"Soundfile failed: {e}. Falling back to FFmpeg.")
                        
                        # 构建 ffmpeg 的路径
                        ffmpeg_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'bin', 'ffmpeg.exe'))
                        
                        if not os.path.exists(ffmpeg_path):
                            logging.warning(f"ffmpeg.exe not found at {ffmpeg_path}, assuming it's in PATH.")
                            ffmpeg_path = 'ffmpeg'

                        command = [
                            ffmpeg_path,
                            '-i', file_path,
                            '-f', 'wav',       # 输出 WAV 格式到 stdout
                            '-'
                        ]

                        # 使用 communicate() 来避免死锁，并捕获 stdout 和 stderr
                        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                        stdout_data, stderr_data = process.communicate()

                        # 检查 ffmpeg 是否成功执行
                        if process.returncode != 0:
                            logging.error(f"FFmpeg failed with return code {process.returncode}.")
                            logging.error(f"FFmpeg stderr: {stderr_data.decode(errors='ignore')}")
                            # 抛出异常，让外层知道加载失败
                            raise sf.LibsndfileError(f"FFmpeg decoding failed for {file_path}")

                        # 如果成功，从内存中的 stdout 数据加载
                        try:
                            original_data, original_samplerate = sf.read(io.BytesIO(stdout_data), dtype='float64')
                            logging.info(f"Successfully loaded {file_path} via FFmpeg.")
                        except Exception as e:
                            logging.error(f"Failed to read from FFmpeg stdout stream: {e}", exc_info=True)
                            raise e
                    else:
                        # 如果是其他 soundfile 错误，重新抛出
                        raise e

                # --- Determine Target Samplerate ---
                target_sr = original_samplerate

                if self.target_samplerate and self.target_samplerate > target_sr:
                    target_sr = self.target_samplerate
                
                if self.exclusive_mode and self.device_id is not None:
                    try:
                        device_info = sd.query_devices(self.device_id)
                        hostapi_info = sd.query_hostapis(device_info['hostapi'])
                        if 'WASAPI' in hostapi_info['name']:
                            target_sr = int(device_info.get('default_samplerate', target_sr))
                    except Exception as e:
                        logging.warning(f"Could not query device for WASAPI default samplerate: {e}")

                # --- Caching Logic ---
                cache_key = f"{file_path}_{target_sr}".encode('utf-8')
                cache_filename = f"{hashlib.md5(cache_key).hexdigest()}.wav"
                cache_filepath = os.path.join(self.resample_cache_dir, cache_filename) if self.resample_cache_dir else None

                if cache_filepath and os.path.exists(cache_filepath):
                    logging.info(f"Loading resampled data from cache: {cache_filepath}")
                    self.data, self.samplerate = sf.read(cache_filepath, dtype='float64')
                else:
                    # --- Perform Resampling if needed ---
                    if target_sr != original_samplerate:
                        logging.info(f"Resampling from {original_samplerate} Hz to {target_sr} Hz...")
                        num_original_samples = len(original_data)
                        num_new_samples = int(num_original_samples * target_sr / original_samplerate)
                        # --- NEW: Use Rust-based resampler ---
                        # Flatten the array for the Rust function, which expects interleaved audio
                        flat_data = original_data.flatten()
                        
                        # Call the high-performance Rust resampler
                        resampled_flat = rust_audio_resampler.resample(
                            flat_data,
                            original_samplerate,
                            target_sr,
                            self.channels
                        )
                        
                        # Reshape the 1D result back to a 2D array (frames, channels)
                        self.data = resampled_flat.reshape((-1, self.channels))
                        self.samplerate = target_sr
                        logging.info("Resampling complete.")
                        
                        # Write to cache
                        if cache_filepath:
                            logging.info(f"Writing resampled data to cache: {cache_filepath}")
                            sf.write(cache_filepath, self.data, self.samplerate)
                    else:
                        self.data = original_data
                        self.samplerate = original_samplerate

                self.file_path = file_path
                self.channels = self.data.shape[1] if len(self.data.shape) > 1 else 1
                self.position = 0
                self.is_playing = False
                self.is_paused = False
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
                'exclusive_mode': self.exclusive_mode
            }

    def set_volume(self, volume_level):
        """设置音量"""
        with self.lock:
            self.volume = float(volume_level)
            logging.info(f"Volume set to {self.volume}")
            return True

    def _design_eq_filters(self):
        """Design IIR filters based on current EQ settings."""
        if self.samplerate == 0:
            return
        
        nyquist = 0.5 * self.samplerate
        self.eq_filters = {}
        
        # Define band frequencies and Q factor
        bands_config = {
           '31': (31, 1.41), '62': (62, 1.41), '125': (125, 1.41),
           '250': (250, 1.41), '500': (500, 1.41), '1k': (1000, 1.41),
           '2k': (2000, 1.41), '4k': (4000, 1.41), '8k': (8000, 1.41),
           '16k': (16000, 1.41)
        }

        for band, (f0, Q) in bands_config.items():
            gain_db = self.eq_bands.get(band, 0)
            if gain_db != 0:
                # Correct implementation for a peaking EQ biquad filter
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
                
                # Convert the transfer function (b, a) to second-order sections (SOS)
                # This is the numerically stable way to implement higher-order filters.
                sos = tf2sos(b, a, analog=False)
                self.eq_filters[band] = sos
        self._initialize_eq_zi()
        logging.info(f"Designed EQ filters for bands: {list(self.eq_filters.keys())}")

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
                        self.eq_bands[band] = gain
            
            self._design_eq_filters()
            logging.info(f"EQ set. Enabled: {self.eq_enabled}, Bands: {self.eq_bands}")
        return True

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
                current_position_seconds = self.position / self.samplerate if self.samplerate > 0 else 0
                # Important: Reload the file to apply new device/mode settings (like resampling)
                if self.load(self.file_path):
                    self.seek(current_position_seconds)
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
                current_position_seconds = self.position / self.samplerate if self.samplerate > 0 else 0
                original_path = self.file_path
                
                # Reload the track. If it was playing, start it again.
                if self.load(original_path):
                    self.seek(current_position_seconds)
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

    if args.resample_cache_dir:
        audio_engine.resample_cache_dir = args.resample_cache_dir
        logging.info(f"Resample cache directory set to: {audio_engine.resample_cache_dir}")

    port = 5555
    logging.getLogger('werkzeug').disabled = True
    
    logging.info(f"Starting Hi-Fi Audio Engine on http://127.0.0.1:{port}")
    # Print a ready signal to stdout so the main process knows the server is up.
    import sys
    print("FLASK_SERVER_READY")
    sys.stdout.flush()
    socketio.run(app, host='127.0.0.1', port=port, debug=False, log_output=False)