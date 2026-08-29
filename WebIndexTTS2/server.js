import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 3460);
const API_KEY = process.env.MIMO_API_KEY || '';
const CONFIGURED_API_URL = process.env.MIMO_API_URL || 'https://www.dmxapi.cn/v1/chat/completions';
const API_URL = /\/chat\/completions\/?$/.test(CONFIGURED_API_URL)
  ? CONFIGURED_API_URL.replace(/\/$/, '')
  : `${CONFIGURED_API_URL.replace(/\/$/, '')}/chat/completions`;
const CONFIGURED_MODEL = process.env.MIMO_MODEL || 'mimo-v2.5-tts';
const BASE_MODEL = CONFIGURED_MODEL.replace(/-(?:voicedesign|voiceclone)$/, '');
const SAMPLE_RATE = 24000;
const MODELS = Object.freeze({
  preset: BASE_MODEL,
  voicedesign: `${BASE_MODEL}-voicedesign`,
  voiceclone: `${BASE_MODEL}-voiceclone`
});
const ALLOWED_VOICES = new Set([
  'mimo_default',
  '冰糖',
  '茉莉',
  '苏打',
  '白桦',
  'Mia',
  'Chloe',
  'Milo',
  'Dean'
]);

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function createHttpError(message, status = 500, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function normalizeContent({ style, text }) {
  const safeStyle = String(style || '').trim();
  const safeText = String(text || '').trim();

  if (!safeText) {
    throw createHttpError('待合成文本不能为空。', 400);
  }

  if (safeStyle.includes('(') || safeStyle.includes(')') || safeStyle.includes('<') || safeStyle.includes('>')) {
    throw createHttpError('风格名称中不能包含括号或尖括号，请只填写风格文字，例如：开心 变快。', 400);
  }

  if (safeStyle && /唱歌|sing(?:ing)?/i.test(safeStyle) && !/^(唱歌|sing|singing)$/i.test(safeStyle)) {
    throw createHttpError('唱歌风格必须单独使用，不能与其他风格混用。', 400);
  }

  return `${safeStyle ? `(${safeStyle})` : ''}${safeText}`;
}

function buildRequest({ mode, voice, style, text, userPrompt, optimizeTextPreview, referenceAudio }) {
  if (!Object.hasOwn(MODELS, mode)) {
    throw createHttpError(`不支持的合成模式：${mode}。`, 400);
  }

  const content = normalizeContent({ style, text });
  const safeUserPrompt = String(userPrompt || '').trim();
  const messages = [];
  const audio = { format: 'pcm16' };

  if (mode === 'preset') {
    if (!ALLOWED_VOICES.has(voice)) {
      throw createHttpError(`不支持的 MiMo 2.5 预置音色：${voice}。`, 400);
    }

    if (safeUserPrompt) messages.push({ role: 'user', content: safeUserPrompt });
    audio.voice = voice;
  } else if (mode === 'voicedesign') {
    if (!safeUserPrompt) {
      throw createHttpError('音色设计模式必须填写自然语言音色描述。', 400);
    }

    messages.push({ role: 'user', content: safeUserPrompt });
    audio.optimize_text_preview = Boolean(optimizeTextPreview);
  } else {
    if (!/^data:audio\/(?:wav|mpeg);base64,[A-Za-z0-9+/=\s]+$/.test(String(referenceAudio || ''))) {
      throw createHttpError('音色克隆模式需要 wav 或 mp3 格式的参考音频。', 400);
    }

    if (Buffer.byteLength(referenceAudio, 'utf8') > 10 * 1024 * 1024) {
      throw createHttpError('参考音频 Base64 编码后不能超过 10 MB。', 413);
    }

    messages.push({ role: 'user', content: safeUserPrompt });
    audio.voice = referenceAudio;
  }

  messages.push({ role: 'assistant', content });

  return {
    payload: {
      model: MODELS[mode],
      messages,
      audio,
      stream: true
    },
    preview: {
      mode,
      model: MODELS[mode],
      voice: mode === 'preset' ? voice : undefined,
      referenceAudio: mode === 'voiceclone' ? '已提供（内容已隐藏）' : undefined,
      optimizeTextPreview: mode === 'voicedesign' ? Boolean(optimizeTextPreview) : undefined,
      content,
      userPrompt: safeUserPrompt
    }
  };
}

function sendSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readUpstreamError(upstream) {
  const raw = await upstream.text();
  let details = raw;

  try {
    details = raw ? JSON.parse(raw) : {};
  } catch {
    // 保留上游的原始文本，便于排查网关错误。
  }

  const message = details?.error?.message
    || details?.message
    || `MiMo API 请求失败，HTTP ${upstream.status}。`;

  return createHttpError(message, upstream.status, details);
}

app.get('/api/config', (req, res) => {
  res.json({
    model: BASE_MODEL,
    models: MODELS,
    modes: [
      { id: 'preset', label: '预置音色' },
      { id: 'voicedesign', label: '自然语言设计音色' },
      { id: 'voiceclone', label: '参考音频克隆音色' }
    ],
    apiUrl: API_URL,
    defaultPort: PORT,
    hasApiKey: Boolean(API_KEY),
    streaming: true,
    sampleRate: SAMPLE_RATE,
    voices: [
      { id: 'mimo_default', label: 'mimo_default · 默认音色' },
      { id: '冰糖', label: '冰糖 · 中文女声' },
      { id: '茉莉', label: '茉莉 · 中文女声' },
      { id: '苏打', label: '苏打 · 中文男声' },
      { id: '白桦', label: '白桦 · 中文男声' },
      { id: 'Mia', label: 'Mia · 英文女声' },
      { id: 'Chloe', label: 'Chloe · 英文女声' },
      { id: 'Milo', label: 'Milo · 英文男声' },
      { id: 'Dean', label: 'Dean · 英文男声' }
    ],
    stylePresets: [
      '开心',
      '悲伤',
      '愤怒',
      '温柔',
      '高冷',
      '活泼',
      '严肃',
      '变快',
      '变慢',
      '东北话',
      '四川话',
      '粤语',
      '夹子音',
      '御姐音',
      '大叔音',
      '孙悟空',
      '林黛玉',
      '唱歌'
    ],
    inlineTagExamples: [
      '[吸气]',
      '[深呼吸]',
      '[叹气]',
      '[紧张]',
      '[激动]',
      '[疲惫]',
      '[颤抖]',
      '[气声]',
      '[笑]',
      '[轻笑]',
      '[抽泣]',
      '[哽咽]'
    ]
  });
});

app.post('/api/tts', async (req, res, next) => {
  const controller = new AbortController();
  let streamStarted = false;
  let streamFinished = false;

  req.once('aborted', () => controller.abort());
  res.once('close', () => {
    if (!streamFinished) controller.abort();
  });

  try {
    if (!API_KEY) {
      throw createHttpError('未配置 MIMO_API_KEY。请复制 .env.example 为 .env 并填入 API Key。', 500);
    }

    const {
      mode = 'preset',
      voice = 'mimo_default',
      style = '',
      text = '',
      userPrompt = '',
      optimizeTextPreview = false,
      referenceAudio = ''
    } = req.body || {};

    const { payload, preview } = buildRequest({
      mode,
      voice,
      style,
      text,
      userPrompt,
      optimizeTextPreview,
      referenceAudio
    });

    const upstream = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!upstream.ok) {
      throw await readUpstreamError(upstream);
    }

    if (!upstream.body) {
      throw createHttpError('MiMo API 未返回可读取的流式响应。', 502);
    }

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    streamStarted = true;

    sendSse(res, {
      type: 'start',
      sampleRate: SAMPLE_RATE,
      format: 'pcm16',
      filename: `mimo_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.wav`,
      requestPreview: preview
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let audioChunkCount = 0;

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return false;

      const value = trimmed.slice(5).trim();
      if (value === '[DONE]') return true;

      let chunk;
      try {
        chunk = JSON.parse(value);
      } catch {
        return false;
      }

      const audio = chunk?.choices?.[0]?.delta?.audio;
      if (audio?.data) {
        audioChunkCount += 1;
        sendSse(res, {
          type: 'audio',
          data: audio.data,
          chunk: audioChunkCount
        });
      }

      return false;
    };

    let done = false;
    while (!done) {
      const result = await reader.read();
      buffer += decoder.decode(result.value || new Uint8Array(), { stream: !result.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (processLine(line)) {
          done = true;
          break;
        }
      }

      if (result.done) {
        if (buffer) processLine(buffer);
        break;
      }
    }

    if (audioChunkCount === 0) {
      throw createHttpError('MiMo API 流结束，但没有返回音频数据。', 502);
    }

    streamFinished = true;
    sendSse(res, { type: 'done', chunks: audioChunkCount });
    res.end();
  } catch (error) {
    if (error.name === 'AbortError') {
      if (!res.writableEnded) res.end();
      return;
    }

    if (streamStarted) {
      sendSse(res, {
        type: 'error',
        error: error.message || '流式语音合成失败。',
        details: error.details
      });
      streamFinished = true;
      res.end();
      return;
    }

    next(error);
  }
});

app.use((error, req, res, _next) => {
  const status = Number(error.status || 500);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: error.message || '服务器内部错误。',
    details: error.details
  });
});

app.listen(PORT, () => {
  console.log(`MiMo TTS local tester is running at http://localhost:${PORT}`);
});