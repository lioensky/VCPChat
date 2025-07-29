import os
import threading
import time
import numpy as np
import soundfile as sf
import sounddevice as sd
from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import logging

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
        self.fft_size = 1024  # FFT窗口大小
        self.fft_update_interval = 1.0 / 30.0  # 约每秒30次
        self.device_id = None # Can be None for default device
        self.exclusive_mode = False

    def _stream_callback(self, outdata, frames, time, status):
        """sounddevice的回调函数，用于填充音频数据"""
        if status:
            logging.warning(f"Stream callback status: {status}")

        with self.lock:
            if self.position + frames <= len(self.data):
                chunk = self.data[self.position : self.position + frames]
                # 应用音量
                outdata[:] = chunk * self.volume
                self.position += frames
            else:
                outdata.fill(0)
                # 标记播放结束
                self.is_playing = False
                logging.info("Playback finished.")

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
                        # 获取当前播放位置附近的数据块用于FFT
                        start = self.position
                        end = start + self.fft_size
                        if end > len(self.data):
                            # 如果接近末尾，补零
                            fft_chunk = np.pad(self.data[start:], (0, end - len(self.data)), 'constant')
                        else:
                            fft_chunk = self.data[start:end]
                        
                        # 如果是多声道，转为单声道
                        if self.channels > 1:
                            fft_chunk = fft_chunk.mean(axis=1)

                        # 应用汉宁窗以减少频谱泄漏
                        window = np.hanning(len(fft_chunk))
                        fft_chunk = fft_chunk * window
                        
                        # 执行FFT
                        fft_result = np.fft.rfft(fft_chunk)
                        magnitude = np.abs(fft_result)
                        
                        # 转换为分贝并归一化
                        log_magnitude = 20 * np.log10(magnitude + 1e-9) # 避免log(0)
                        # 将范围从[-180, max_db]映射到[0, 1]
                        normalized_magnitude = np.clip((log_magnitude + 100) / 100, 0, 1)

                    # 通过WebSocket发送频谱数据
                    self.socketio.emit('spectrum_data', {'data': normalized_magnitude.tolist()})

                # --- 检查播放是否结束 ---
                with self.lock:
                    if self.position >= len(self.data):
                        self.is_playing = False
                        self.socketio.emit('playback_state', self.get_state())

            # 短暂休眠以降低CPU使用率
            time.sleep(0.01)

    def load(self, file_path):
        """加载音频文件"""
        try:
            logging.info(f"Attempting to read file: {file_path}")
            # 1. 先读取文件到临时变量
            data, samplerate = sf.read(file_path, dtype='float64')
            
            # 2. 如果读取成功，再获取锁并修改引擎状态
            with self.lock:
                self.stop() # 停止当前播放
                
                self.file_path = file_path
                self.data = data
                self.samplerate = samplerate
                self.channels = self.data.shape[1] if len(self.data.shape) > 1 else 1
                self.position = 0
                self.is_playing = False
                self.is_paused = False
                logging.info(f"Loaded '{file_path}', Samplerate: {self.samplerate}, Channels: {self.channels}, Duration: {len(self.data)/self.samplerate:.2f}s")
            return True
        except Exception as e:
            # 捕获所有异常，包括 soundfile 可能抛出的底层错误
            logging.error(f"Failed to load file {file_path}: {e}", exc_info=True) # exc_info=True 会记录堆栈跟踪
            # 确保即使加载失败，引擎状态也是干净的
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
                    'callback': self._stream_callback,
                    'finished_callback': self.stop_event.set
                }
                if self.device_id is not None:
                    stream_args['device'] = self.device_id
                
                if self.exclusive_mode:
                    try:
                        # Attempt to set exclusive mode flags for WASAPI
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
                self.load(self.file_path) # Reload to reset state
                self.seek(current_position_seconds)
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
    port = 5555
    # 禁用 werkzeug 的请求日志
    logging.getLogger('werkzeug').disabled = True
    
    logging.info(f"Starting Hi-Fi Audio Engine on http://127.0.0.1:{port}")
    # 使用 eventlet 或 gevent 运行以获得最佳的WebSocket性能
    socketio.run(app, host='127.0.0.1', port=port, debug=False, log_output=False)