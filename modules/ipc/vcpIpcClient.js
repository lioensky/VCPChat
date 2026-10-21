// modules/ipc/vcpIpcClient.js
/**
 * @fileoverview VCP 方案 2 前端全双工 IPC 客户端 (VcpIpcClient)
 * 运行于 Electron 主进程，通过命名管道直接连接 VCPToolBox 守护进程。
 * 实现零端口占用通信、实时流式解析与生命体主动唤醒事件接收。
 */

'use strict';

const net = require('net');
const EventEmitter = require('events');
const { StringDecoder } = require('string_decoder');

const DEFAULT_PIPE_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\vcp-ipc'
  : '/tmp/vcp-ipc.sock';

class VcpIpcClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pipePath = options.pipePath || process.env.VCP_IPC_PIPE || DEFAULT_PIPE_PATH;
    this.socket = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.minReconnectDelay = 1000;
    this.maxReconnectDelay = 15000;
    this.activeStreams = new Map(); // requestId -> { onChunk, onEnd, onError, signal }
    this.pendingInterrupts = new Map(); // requestId -> { resolve, timer }
    this.autoReconnect = true;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.debugMode = Boolean(options.debugMode);
  }

  /**
   * 建立与后台 IPC 守护进程的连接
   */
  connect() {
    if (this.socket || this.connected) return;

    this.buffer = '';
    this.decoder = new StringDecoder('utf8');

    try {
      this.socket = net.connect(this.pipePath);

      this.socket.on('connect', () => {
        this.connected = true;
        this.reconnectDelay = this.minReconnectDelay;
        this.buffer = '';
        this.decoder = new StringDecoder('utf8');
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        console.log(`[VcpIpcClient] 成功连接到本地 VCP IPC 守护进程 (${this.pipePath})`);
        this.emit('connected');
      });

      this.socket.on('data', chunk => {
        this.buffer += this.decoder.write(chunk);
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop(); // 保留不完整的一行

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const message = JSON.parse(trimmed);
            this._handleIncomingMessage(message);
          } catch (err) {
            if (this.debugMode) {
              console.warn('[VcpIpcClient] NDJSON parse error:', err.message);
            }
          }
        }
      });

      this.socket.on('error', err => {
        // 后台尚未启动时属于正常静默状态，仅在 debugMode 打印
        if (this.debugMode) {
          console.log('[VcpIpcClient] IPC connection error:', err.message);
        }
      });

      this.socket.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        this.buffer = '';
        this.decoder = new StringDecoder('utf8');

        if (wasConnected) {
          console.log('[VcpIpcClient] 与本地 VCP IPC 守护进程断开连接，准备重连...');
          this.emit('disconnected');
        }

        // 清理所有未决的中断等待 Promise 并清理定时器
        for (const [id, pending] of this.pendingInterrupts.entries()) {
          if (pending.timer) clearTimeout(pending.timer);
          try {
            pending.resolve(false);
          } catch (_) {}
        }
        this.pendingInterrupts.clear();

        // 清理当前所有未完成的流并逐个移除 abort 监听器
        const pendingStreams = [];
        for (const id of Array.from(this.activeStreams.keys())) {
          const stream = this._cleanupStream(id);
          if (stream) pendingStreams.push(stream);
        }
        for (const stream of pendingStreams) {
          if (stream.onError) {
            try {
              stream.onError(new Error('IPC socket closed unexpectedly'));
            } catch (err) {
              console.error('[VcpIpcClient] onError callback error:', err);
            }
          }
        }

        if (this.autoReconnect && !this.reconnectTimer) {
          const delay = this.reconnectDelay;
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
          }, delay);
        }
      });

    } catch (connectError) {
      this.connected = false;
      this.socket = null;
      this.buffer = '';
      this.decoder = new StringDecoder('utf8');
      if (this.autoReconnect && !this.reconnectTimer) {
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, delay);
      }
    }
  }

  /**
   * 是否处于已连接可用状态
   * @returns {boolean}
   */
  isConnected() {
    return this.connected && this.socket && !this.socket.destroyed;
  }

  /**
   * 通过 IPC 通道发送流式对话请求
   * @param {object} payload - 请求数据体
   * @param {object} handlers - 回调处理器
   * @param {function} handlers.onChunk - 接收单个 chunk
   * @param {function} handlers.onEnd - 流结束
   * @param {function} handlers.onError - 发生错误
   * @param {AbortSignal} [handlers.signal] - 中止信号
   * @returns {boolean} 是否成功进入发送链路
   */
  sendChatStream(payload, { onChunk, onEnd, onError, signal } = {}) {
    if (!this.isConnected()) {
      return false;
    }

    if (signal?.aborted) {
      if (onError) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        onError(err);
      }
      return false;
    }

    const requestId = payload.id || payload.requestId || payload.messageId || `req-${Date.now()}`;
    let abortListener = null;

    if (signal) {
      abortListener = () => {
        this.interrupt(requestId, 'caller_aborted').catch(() => {});
        const s = this._cleanupStream(requestId);
        if (s && s.onEnd) {
          s.onEnd({ type: 'aborted', reason: signal.reason || 'caller_aborted' });
        }
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }

    const streamMeta = { onChunk, onEnd, onError, signal, abortListener };
    this.activeStreams.set(requestId, streamMeta);

    const message = {
      type: 'chat:start',
      requestId,
      payload
    };

    try {
      this.socket.write(JSON.stringify(message) + '\n');
      return true;
    } catch (err) {
      this._cleanupStream(requestId);
      if (onError) onError(err);
      return false;
    }
  }

  /**
   * 清理请求状态并释放 AbortListener 监听器
   * @private
   */
  _cleanupStream(requestId) {
    const stream = this.activeStreams.get(requestId);
    if (!stream) return null;
    if (stream.signal && stream.abortListener) {
      try {
        stream.signal.removeEventListener('abort', stream.abortListener);
      } catch (_) {}
    }
    this.activeStreams.delete(requestId);
    return stream;
  }

  /**
   * 检查指定 requestId 是否为当前活跃的 IPC 请求
   * @param {string} requestId
   * @returns {boolean}
   */
  hasActiveStream(requestId) {
    return Boolean(requestId && this.activeStreams.has(requestId));
  }

  /**
   * 发送保活心跳探针
   * @returns {boolean}
   */
  ping() {
    if (!this.isConnected()) return false;
    try {
      this.socket.write(JSON.stringify({ type: 'ping', timestamp: Date.now() }) + '\n');
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 发送请求中断信号并等待远端确认
   * @param {string} requestId - 请求ID
   * @param {string} [reason='user_interrupted'] - 中断原因
   * @param {number} [timeoutMs=3000] - 等待确认超时时间 (ms)
   * @returns {Promise<boolean>} 是否成功获得远端正面确认 (success === true)
   */
  async interrupt(requestId, reason = 'user_interrupted', timeoutMs = 3000) {
    if (!requestId || !this.isConnected()) return false;

    return new Promise((resolve) => {
      // 若此前已有针对该 requestId 的未完成中断等待，先行清理避免泄漏
      const existing = this.pendingInterrupts.get(requestId);
      if (existing) {
        if (existing.timer) clearTimeout(existing.timer);
        try { existing.resolve(false); } catch (_) {}
      }

      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingInterrupts.delete(requestId);
          if (this.debugMode) {
            console.warn(`[VcpIpcClient] 中断确认超时 (${timeoutMs}ms) for ${requestId}`);
          }
          resolve(false);
        }, timeoutMs);
      }

      this.pendingInterrupts.set(requestId, { resolve, timer });

      try {
        const payload = JSON.stringify({
          type: 'chat:interrupt',
          requestId,
          reason
        }) + '\n';

        const writeOk = this.socket.write(payload);
        if (writeOk === false && this.socket.destroyed) {
          if (timer) clearTimeout(timer);
          this.pendingInterrupts.delete(requestId);
          resolve(false);
        }
      } catch (_) {
        if (timer) clearTimeout(timer);
        this.pendingInterrupts.delete(requestId);
        resolve(false);
      }
    });
  }

  /**
   * 注册生命体主动唤醒监听器
   * @param {function} callback
   */
  onProactiveWake(callback) {
    this.on('proactive:wake', callback);
  }

  /**
   * 处理后端推送的指令与事件
   * @private
   */
  _handleIncomingMessage(message) {
    const { type, requestId, chunk, event } = message;

    // 0. 保活探针响应
    if (type === 'pong') {
      this.emit('pong', message);
      return;
    }

    // 1. 流式 Chunk 消息
    if (type === 'chat:chunk' && requestId) {
      const stream = this.activeStreams.get(requestId);
      if (stream) {
        if (chunk?.type === 'done') {
          const s = this._cleanupStream(requestId);
          if (s) {
            if (s.onChunk) s.onChunk(chunk);
            if (s.onEnd) s.onEnd(chunk);
          }
        } else if (chunk?.type === 'error') {
          const s = this._cleanupStream(requestId);
          if (s && s.onError) s.onError(new Error(chunk.error || 'Chat stream error'));
        } else if (chunk?.type === 'aborted') {
          const s = this._cleanupStream(requestId);
          if (s && s.onEnd) s.onEnd(chunk);
        } else {
          if (stream.onChunk) stream.onChunk(chunk);
        }
      }
      return;
    }

    // 2. 生命体主动唤醒广播
    if (type === 'proactive:wake' && event) {
      console.log(`[VcpIpcClient] 收到来自 AI 生命体的主动唤醒事件: level=${event.level}, title=${event.title}`);
      this.emit('proactive:wake', event);
      return;
    }

    // 3. 中断确认
    if (type === 'chat:interrupted' && requestId) {
      const isConfirmed = message.success === true;
      const pending = this.pendingInterrupts.get(requestId);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingInterrupts.delete(requestId);
        pending.resolve(isConfirmed);
      }
      if (!isConfirmed) {
        // 仅在明确收到 success === true 的正面确认时结束流；负向确认或无确认保持流继续
        return;
      }
      const s = this._cleanupStream(requestId);
      if (s && s.onEnd) {
        s.onEnd({ type: 'aborted', reason: 'interrupted' });
      }
      return;
    }
  }

  /**
   * 关闭客户端
   */
  destroy() {
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const currentSocket = this.socket;
    this.socket = null;
    this.connected = false;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');

    // 清理所有未决的中断等待 Promise 并清理定时器
    for (const [id, pending] of this.pendingInterrupts.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      try {
        pending.resolve(false);
      } catch (_) {}
    }
    this.pendingInterrupts.clear();

    // 清理所有遗留未决的流
    const pendingStreams = [];
    for (const id of Array.from(this.activeStreams.keys())) {
      const stream = this._cleanupStream(id);
      if (stream) pendingStreams.push(stream);
    }
    for (const stream of pendingStreams) {
      if (stream.onError) {
        try {
          stream.onError(new Error('IPC client destroyed'));
        } catch (_) {}
      }
    }

    if (currentSocket) {
      try {
        currentSocket.destroy();
      } catch (_) {}
    }
  }
}

// 导出全局单例
const vcpIpcClient = new VcpIpcClient();

module.exports = vcpIpcClient;
