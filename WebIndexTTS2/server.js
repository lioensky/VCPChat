const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3012);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);
const UPLOAD_FETCH_TIMEOUT_MS = Number(process.env.UPLOAD_FETCH_TIMEOUT_MS || 300000);
const ROOT_DIR = __dirname;
const CONFIG_PATH = path.join(ROOT_DIR, 'config.env');
const REFERENCE_ROOT_DIR = path.join(ROOT_DIR, 'references');
const OUTPUT_DIR = path.join(ROOT_DIR, 'tmp-output');
const APP_DATA_DIR = path.join(ROOT_DIR, '..', 'AppData');
const SETTINGS_JSON_PATH = path.join(APP_DATA_DIR, 'settings.json');
const TRUTH_JSON_PATH = path.join(APP_DATA_DIR, 'webindexmodel.json');
const MODEL_NAME = 'IndexTeam/IndexTTS-2';
const DEFAULT_VOICE = 'IndexTeam/IndexTTS-2:alex';
const DEFAULT_VOICES = [
  'IndexTeam/IndexTTS-2:alex',
  'IndexTeam/IndexTTS-2:anna',
  'IndexTeam/IndexTTS-2:bella',
  'IndexTeam/IndexTTS-2:benjamin',
  'IndexTeam/IndexTTS-2:charles',
  'IndexTeam/IndexTTS-2:claire',
  'IndexTeam/IndexTTS-2:david',
  'IndexTeam/IndexTTS-2:diana'
];

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(APP_DATA_DIR, { recursive: true });
fs.mkdirSync(REFERENCE_ROOT_DIR, { recursive: true });

function readEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) {
    return env;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const index = line.indexOf('=');
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    env[key] = value;
  }
  return env;
}

function readMainSettings() {
  if (!fs.existsSync(SETTINGS_JSON_PATH)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(SETTINGS_JSON_PATH, 'utf8'));
  } catch (error) {
    console.warn(`[WebIndexTTS2] Failed to read main settings from ${SETTINGS_JSON_PATH}: ${error.message}`);
    return {};
  }
}

function getEnvConfig() {
  const env = readEnvFile(CONFIG_PATH);
  const mainSettings = readMainSettings();
  const networkModeSettings = mainSettings.voiceLocalSettings || {};

  const resolvedUrl = (networkModeSettings.providerUrl || env.siliconflow_url || 'https://api.siliconflow.cn').replace(/\/+$/, '');
  const resolvedKey = networkModeSettings.providerKey || env.siliconflow_key || '';

  return {
    siliconflowUrl: resolvedUrl,
    siliconflowKey: resolvedKey,
    source: networkModeSettings.providerUrl || networkModeSettings.providerKey ? 'AppData/settings.json' : 'config.env'
  };
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function text(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function serveFile(res, filePath, contentType) {
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': data.length
  });
  res.end(data);
}

function safeReadText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').trim() : '';
}

function normalizeModelFolderName(modelId) {
  return modelId.replace(/[\\/:*?"<>|]+/g, '_');
}

function listReferenceSourceDirectories() {
  if (!fs.existsSync(REFERENCE_ROOT_DIR)) {
    return [];
  }

  return fs.readdirSync(REFERENCE_ROOT_DIR)
    .map(name => ({
      name,
      fullPath: path.join(REFERENCE_ROOT_DIR, name)
    }))
    .filter(item => fs.existsSync(item.fullPath) && fs.statSync(item.fullPath).isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function collectSamplesFromDirectory(dirPath, folderName) {
  const results = [];
  if (!fs.existsSync(dirPath)) {
    return results;
  }

  const files = fs.readdirSync(dirPath).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  for (const file of files) {
    if (!/\.(wav|mp3|opus|m4a|flac|ogg)$/i.test(file)) {
      continue;
    }
    const ext = path.extname(file);
    const name = path.basename(file, ext);
    const txtPath = path.join(dirPath, `${name}.txt`);
    const audioPath = path.join(dirPath, file);
    results.push({
      id: `${folderName}/${name}`,
      audioPath,
      text: safeReadText(txtPath),
      fileName: file,
      sampleName: name,
      modelId: MODEL_NAME,
      folderName,
      sourceDir: dirPath
    });
  }

  return results;
}

function getReferenceSources() {
  return listReferenceSourceDirectories().map(item => ({
    folderName: item.name,
    fullPath: item.fullPath,
    samples: collectSamplesFromDirectory(item.fullPath, item.name)
  }));
}

function getReferenceSamples() {
  return getReferenceSources().flatMap(item => item.samples);
}

function getSampleById(sampleId) {
  const normalizedId = String(sampleId || '').trim();
  if (!normalizedId) {
    return null;
  }
  return getReferenceSamples().find(item => item.id === normalizedId) || null;
}

function normalizeRemoteVoiceListPayload(payload) {
  if (Array.isArray(payload?.results)) {
    return payload.results;
  }
  if (Array.isArray(payload?.result)) {
    return payload.result;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return [];
}

function normalizeUploadedVoice(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const nested = payload.result && typeof payload.result === 'object' ? payload.result : null;
  const candidate = nested || payload;
  const uri = candidate.uri || candidate.voice || candidate.id || payload.uri || '';
  return {
    uri,
    customName: candidate.customName || candidate.name || payload.customName || '',
    model: candidate.model || payload.model || MODEL_NAME,
    text: candidate.text || payload.text || '',
    raw: payload
  };
}

function buildTruthPayload(remoteVoices = []) {
  const defaultVoices = DEFAULT_VOICES.map(voice => ({
    id: voice,
    type: 'default',
    modelId: MODEL_NAME,
    displayName: voice.split(':').pop() || voice,
    voice
  }));

  const remoteVoiceItems = remoteVoices
    .filter(voice => voice && voice.uri)
    .map(voice => ({
      id: voice.uri,
      type: 'remote',
      modelId: voice.model || MODEL_NAME,
      displayName: voice.customName || voice.uri,
      voice: voice.uri,
      uri: voice.uri,
      customName: voice.customName || '',
      text: voice.text || '',
      raw: voice
    }));

  const sources = getReferenceSources();

  return {
    updatedAt: new Date().toISOString(),
    source: 'WebIndexTTS2',
    referenceRootDir: REFERENCE_ROOT_DIR,
    models: sources.map(source => ({
      modelId: MODEL_NAME,
      folderName: source.folderName,
      defaults: defaultVoices,
      remoteVoices: remoteVoiceItems,
      localSamples: source.samples.map(sample => ({
        id: sample.id,
        sampleName: sample.sampleName,
        fileName: sample.fileName,
        text: sample.text,
        folderName: sample.folderName
      })),
      mergedVoiceOptions: [...defaultVoices, ...remoteVoiceItems]
    }))
  };
}

function writeTruthJson(payload) {
  fs.writeFileSync(TRUTH_JSON_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

async function refreshTruthJson(remoteVoices = null) {
  let normalizedVoices = remoteVoices;
  if (!Array.isArray(normalizedVoices)) {
    try {
      const remote = await siliconJsonFetch('/v1/audio/voice/list', { method: 'GET' });
      normalizedVoices = normalizeRemoteVoiceListPayload(remote);
    } catch (error) {
      normalizedVoices = [];
    }
  }

  const payload = buildTruthPayload(normalizedVoices);
  writeTruthJson(payload);
  return payload;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => {
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.length) {
    return {};
  }
  return JSON.parse(body.toString('utf8'));
}

function ensureApiKey() {
  const { siliconflowKey, source } = getEnvConfig();
  if (!siliconflowKey) {
    const error = new Error(`缺少网络 API Key。当前读取来源: ${source}`);
    error.statusCode = 500;
    throw error;
  }
}

async function siliconJsonFetch(pathname, options = {}) {
  const { siliconflowUrl, siliconflowKey } = getEnvConfig();
  ensureApiKey();
  const headers = {
    Authorization: `Bearer ${siliconflowKey}`,
    ...(options.headers || {})
  };
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : FETCH_TIMEOUT_MS;
  const fetchOptions = { ...options };
  delete fetchOptions.timeoutMs;

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`SiliconFlow 请求超时: ${pathname}`));
  }, timeoutMs);

  try {
    console.log(`[WebIndexTTS2] -> ${fetchOptions.method || 'GET'} ${siliconflowUrl}${pathname} timeout=${timeoutMs}ms`);
    const response = await fetch(`${siliconflowUrl}${pathname}`, {
      ...fetchOptions,
      headers,
      signal: controller.signal
    });
    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const data = isJson ? await response.json() : await response.text();
    console.log(`[WebIndexTTS2] <- ${response.status} ${pathname}`);

    if (!response.ok) {
      const error = new Error(`SiliconFlow 请求失败: ${response.status}`);
      error.statusCode = response.status;
      error.details = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`SiliconFlow 请求超时(${timeoutMs}ms): ${pathname}`);
      timeoutError.statusCode = 504;
      timeoutError.details = error.message;
      throw timeoutError;
    }
    console.error(`[WebIndexTTS2] 请求异常 ${pathname}:`, error);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function siliconBinaryFetch(pathname, payload) {
  const { siliconflowUrl, siliconflowKey } = getEnvConfig();
  ensureApiKey();
  const response = await fetch(`${siliconflowUrl}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${siliconflowKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!response.ok) {
    const errorText = buffer.toString('utf8');
    const error = new Error(`SiliconFlow 语音生成失败: ${response.status}`);
    error.statusCode = response.status;
    error.details = errorText;
    throw error;
  }
  return { buffer, contentType };
}

function buildMultipartBody(parts, boundary) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    let disposition = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename) {
      disposition += `; filename="${encodeURIComponent(part.filename)}"`;
    }
    chunks.push(Buffer.from(`${disposition}\r\n`));
    if (part.contentType) {
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    }
    chunks.push(Buffer.from('\r\n'));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value)));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function guessMime(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.opus')) return 'audio/ogg';
  return 'application/octet-stream';
}

function saveGeneratedFile(prefix, extension, buffer) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${prefix}-${timestamp}.${extension}`;
  const fullPath = path.join(OUTPUT_DIR, fileName);
  fs.writeFileSync(fullPath, buffer);
  return fileName;
}

function extensionFromFormat(format, contentType) {
  if (format) {
    if (format === 'pcm') return 'pcm';
    return format;
  }
  if (contentType.includes('wav')) return 'wav';
  if (contentType.includes('mpeg')) return 'mp3';
  if (contentType.includes('ogg')) return 'opus';
  return 'bin';
}

async function handlePresetSpeech(req, res) {
  const body = await parseJsonBody(req);
  const payload = {
    model: MODEL_NAME,
    input: body.input || '你好，这是一段默认音色测试文本。',
    voice: body.voice || DEFAULT_VOICE,
    response_format: body.response_format || 'mp3',
    speed: typeof body.speed === 'number' ? body.speed : 1
  };
  const { buffer, contentType } = await siliconBinaryFetch('/v1/audio/speech', payload);
  const fileName = saveGeneratedFile('preset', extensionFromFormat(payload.response_format, contentType), buffer);
  json(res, 200, {
    ok: true,
    request: payload,
    fileName,
    audioUrl: `/outputs/${encodeURIComponent(fileName)}`,
    contentType,
    size: buffer.length
  });
}

async function handleReferenceSpeech(req, res) {
  const body = await parseJsonBody(req);
  if (!body.voiceUri) {
    return json(res, 400, { ok: false, error: '缺少 voiceUri' });
  }
  const payload = {
    model: MODEL_NAME,
    input: body.input || '你好，这是一段使用已上传参考音频的测试文本。',
    voice: body.voiceUri,
    response_format: body.response_format || 'mp3',
    speed: typeof body.speed === 'number' ? body.speed : 1
  };
  const { buffer, contentType } = await siliconBinaryFetch('/v1/audio/speech', payload);
  const fileName = saveGeneratedFile('reference-uri', extensionFromFormat(payload.response_format, contentType), buffer);
  json(res, 200, {
    ok: true,
    request: payload,
    fileName,
    audioUrl: `/outputs/${encodeURIComponent(fileName)}`,
    contentType,
    size: buffer.length
  });
}

async function handleDynamicReferences(req, res) {
  const body = await parseJsonBody(req);
  const sampleIds = Array.isArray(body.sampleIds) && body.sampleIds.length
    ? body.sampleIds.map(item => String(item))
    : ['1', '2'];

  const allSamples = getReferenceSamples();
  const selected = allSamples.filter(item => sampleIds.includes(item.id));
  if (!selected.length) {
    return json(res, 400, { ok: false, error: '未匹配到任何本地参考音频样本' });
  }

  const references = selected.map(item => {
    const audioBuffer = fs.readFileSync(item.audioPath);
    return {
      audio: audioBuffer.toString('base64'),
      text: item.text
    };
  });

  const payload = {
    model: MODEL_NAME,
    input: body.input || '[S1]你好，这里是动态参考音频测试。[S2]这是第二段声音表现。',
    references,
    response_format: body.response_format || 'wav'
  };

  const { buffer, contentType } = await siliconBinaryFetch('/v1/audio/speech', payload);
  const fileName = saveGeneratedFile('references', extensionFromFormat(payload.response_format, contentType), buffer);
  json(res, 200, {
    ok: true,
    requestSummary: {
      model: payload.model,
      input: payload.input,
      referenceCount: references.length,
      response_format: payload.response_format
    },
    fileName,
    audioUrl: `/outputs/${encodeURIComponent(fileName)}`,
    contentType,
    size: buffer.length
  });
}

async function uploadVoiceSample(sample, customName) {
  const boundary = `----NodeBoundary${Date.now().toString(16)}${sample.id}`;

  const multipart = buildMultipartBody([
    { name: 'model', value: MODEL_NAME },
    { name: 'customName', value: customName },
    { name: 'text', value: sample.text },
    {
      name: 'file',
      filename: sample.fileName,
      contentType: guessMime(sample.fileName),
      value: fs.readFileSync(sample.audioPath)
    }
  ], boundary);

  return await siliconJsonFetch('/v1/uploads/audio/voice', {
    method: 'POST',
    timeoutMs: UPLOAD_FETCH_TIMEOUT_MS,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(multipart.length)
    },
    body: multipart
  });
}

async function handleUploadVoice(req, res) {
  const body = await parseJsonBody(req);
  const sampleId = String(body.sampleId || '').trim();
  const sample = getSampleById(sampleId);
  if (!sample) {
    return json(res, 400, { ok: false, error: `未找到样本 ${sampleId}` });
  }
  const customName = body.customName || `amis_voice_${sample.sampleName}_${Date.now()}`;
  console.log(`[WebIndexTTS2] 开始上传参考音频 sampleId=${sampleId}, customName=${customName}`);
  const data = await uploadVoiceSample(sample, customName);
  const normalizedVoice = normalizeUploadedVoice(data);
  console.log(`[WebIndexTTS2] 上传完成 sampleId=${sampleId}, uri=${normalizedVoice?.uri || ''}`);
  const payload = await refreshTruthJson();

  json(res, 200, {
    ok: true,
    sampleId,
    customName,
    uploadResult: data,
    uploadedVoice: normalizedVoice,
    uri: normalizedVoice?.uri || '',
    truthJsonPath: TRUTH_JSON_PATH,
    truthPayload: payload
  });
}

async function handleBatchUploadVoices(req, res) {
  const body = await parseJsonBody(req);
  const sampleIds = Array.isArray(body.sampleIds) ? body.sampleIds.map(item => String(item)) : [];
  const prefix = body.prefix || 'amis_batch';

  if (!sampleIds.length) {
    return json(res, 400, { ok: false, error: '缺少 sampleIds' });
  }

  const allSamples = getReferenceSamples();
  const results = [];
  for (let index = 0; index < sampleIds.length; index += 1) {
    const sampleId = sampleIds[index];
    const sample = allSamples.find(item => item.id === sampleId);
    if (!sample) {
      results.push({
        sampleId,
        ok: false,
        error: `未找到样本 ${sampleId}`
      });
      continue;
    }

    const safeSampleName = sample.sampleName.replace(/[^\w\u4e00-\u9fa5-]+/g, '_');
    const customName = `${prefix}_${safeSampleName}_${index + 1}`;
    try {
      const uploadResult = await uploadVoiceSample(sample, customName);
      const uploadedVoice = normalizeUploadedVoice(uploadResult);
      results.push({
        sampleId,
        ok: true,
        customName,
        uploadResult,
        uploadedVoice,
        uri: uploadedVoice?.uri || ''
      });
    } catch (error) {
      results.push({
        sampleId,
        ok: false,
        customName,
        error: error.message,
        details: error.details || null
      });
    }
  }

  const payload = await refreshTruthJson();

  json(res, 200, {
    ok: true,
    count: results.length,
    results,
    truthJsonPath: TRUTH_JSON_PATH,
    truthPayload: payload
  });
}

async function handleListVoices(req, res) {
  const data = await siliconJsonFetch('/v1/audio/voice/list', {
    method: 'GET'
  });
  json(res, 200, {
    ok: true,
    ...data
  });
}

async function handleDeleteVoice(req, res) {
  const body = await parseJsonBody(req);
  if (!body.uri) {
    return json(res, 400, { ok: false, error: '缺少 uri' });
  }
  let data = null;
  let endpoint = '/v1/audio/voice/deletions';
  try {
    data = await siliconJsonFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uri: body.uri })
    });
  } catch (error) {
    endpoint = '/v1/audio/voice/delete';
    data = await siliconJsonFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uri: body.uri })
    });
  }
  const payload = await refreshTruthJson();
  json(res, 200, {
    ok: true,
    endpoint,
    deleteResult: data,
    truthJsonPath: TRUTH_JSON_PATH,
    truthPayload: payload
  });
}

function handleSamples(res) {
  const env = getEnvConfig();
  const sources = getReferenceSources();
  const samples = sources.flatMap(source => source.samples).map(item => ({
    id: item.id,
    text: item.text,
    fileName: item.fileName,
    sampleName: item.sampleName,
    folderName: item.folderName
  }));
  json(res, 200, {
    ok: true,
    model: MODEL_NAME,
    defaultVoice: DEFAULT_VOICE,
    baseUrl: env.siliconflowUrl,
    hasApiKey: Boolean(env.siliconflowKey),
    configSource: env.source,
    settingsJsonPath: SETTINGS_JSON_PATH,
    truthJsonPath: TRUTH_JSON_PATH,
    referenceRootDir: REFERENCE_ROOT_DIR,
    sourceFolders: sources.map(source => ({
      folderName: source.folderName,
      sampleCount: source.samples.length
    })),
    samples
  });
}

function handleError(res, error) {
  const statusCode = error.statusCode || 500;
  json(res, statusCode, {
    ok: false,
    error: error.message || '未知错误',
    details: error.details || null
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = parsedUrl;

    if (req.method === 'GET' && pathname === '/') {
      return serveFile(res, path.join(ROOT_DIR, 'public', 'index.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/app.js') {
      return serveFile(res, path.join(ROOT_DIR, 'public', 'app.js'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/styles.css') {
      return serveFile(res, path.join(ROOT_DIR, 'public', 'styles.css'), 'text/css; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      return handleSamples(res);
    }
    if (req.method === 'POST' && pathname === '/api/speech/preset') {
      return await handlePresetSpeech(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/speech/reference-uri') {
      return await handleReferenceSpeech(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/speech/dynamic-references') {
      return await handleDynamicReferences(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/voice/upload') {
      return await handleUploadVoice(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/voice/upload-batch') {
      return await handleBatchUploadVoices(req, res);
    }
    if (req.method === 'GET' && pathname === '/api/voice/list') {
      return await handleListVoices(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/voice/delete') {
      return await handleDeleteVoice(req, res);
    }
    if (req.method === 'GET' && pathname.startsWith('/outputs/')) {
      const fileName = decodeURIComponent(pathname.replace('/outputs/', ''));
      const outputPath = path.join(OUTPUT_DIR, fileName);
      if (!outputPath.startsWith(OUTPUT_DIR) || !fs.existsSync(outputPath)) {
        return text(res, 404, 'Not Found');
      }
      return serveFile(res, outputPath, guessMime(outputPath));
    }
    return text(res, 404, 'Not Found');
  } catch (error) {
    return handleError(res, error);
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});