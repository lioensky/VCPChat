const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3012);
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.env');
const REFERENCES_DIR = path.join(ROOT_DIR, 'references');
const APP_DATA_DIR = path.join(ROOT_DIR, '..', 'AppData');
const SETTINGS_JSON_PATH = path.join(APP_DATA_DIR, 'settings.json');
const TRUTH_JSON_PATH = path.join(APP_DATA_DIR, 'webindexmodel.json');

const MODEL_PRESETS = {
  'IndexTeam/IndexTTS-2': {
    modelId: 'IndexTeam/IndexTTS-2',
    defaultVoices: [
      'IndexTeam/IndexTTS-2:alex',
      'IndexTeam/IndexTTS-2:anna',
      'IndexTeam/IndexTTS-2:bella',
      'IndexTeam/IndexTTS-2:benjamin',
      'IndexTeam/IndexTTS-2:charles',
      'IndexTeam/IndexTTS-2:claire',
      'IndexTeam/IndexTTS-2:david',
      'IndexTeam/IndexTTS-2:diana'
    ]
  }
};

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(REFERENCES_DIR, { recursive: true });
fs.mkdirSync(APP_DATA_DIR, { recursive: true });

function readEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
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
    console.warn(`[WebIndexTTSManager] Failed to read main settings from ${SETTINGS_JSON_PATH}: ${error.message}`);
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

function ensureModelDirectory(modelId) {
  const modelDir = path.join(REFERENCES_DIR, normalizeModelFolderName(modelId));
  fs.mkdirSync(modelDir, { recursive: true });
  return modelDir;
}

function listModelDirectories() {
  if (!fs.existsSync(REFERENCES_DIR)) return [];
  return fs.readdirSync(REFERENCES_DIR)
    .map(name => path.join(REFERENCES_DIR, name))
    .filter(fullPath => fs.statSync(fullPath).isDirectory());
}

function getAudioFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter(file => /\.(wav|mp3|opus|m4a|flac|ogg)$/i.test(file))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function scanReferenceLibrary() {
  const discovered = [];

  for (const modelDir of listModelDirectories()) {
    const folderName = path.basename(modelDir);
    const modelId = Object.keys(MODEL_PRESETS).find(
      key => normalizeModelFolderName(key) === folderName
    ) || folderName;

    const audios = getAudioFiles(modelDir).map(fileName => {
      const baseName = fileName.replace(/\.[^.]+$/, '');
      const textPath = path.join(modelDir, `${baseName}.txt`);
      return {
        id: `${folderName}/${baseName}`,
        modelId,
        folderName,
        sampleName: baseName,
        fileName,
        audioPath: path.join(modelDir, fileName),
        text: safeReadText(textPath)
      };
    });

    discovered.push({
      modelId,
      folderName,
      samples: audios
    });
  }

  Object.values(MODEL_PRESETS).forEach(preset => {
    const folderName = normalizeModelFolderName(preset.modelId);
    if (!discovered.find(item => item.folderName === folderName)) {
      ensureModelDirectory(preset.modelId);
      discovered.push({
        modelId: preset.modelId,
        folderName,
        samples: []
      });
    }
  });

  discovered.sort((a, b) => a.modelId.localeCompare(b.modelId, 'zh-CN'));
  return discovered;
}

async function readRequestBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.length) return {};
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

  const response = await fetch(`${siliconflowUrl}${pathname}`, {
    ...options,
    headers
  });

  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const data = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const error = new Error(`SiliconFlow 请求失败: ${response.status}`);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

function buildTruthPayload(remoteVoices = []) {
  const library = scanReferenceLibrary();

  const models = library.map(item => {
    const preset = MODEL_PRESETS[item.modelId];
    const defaultVoices = (preset?.defaultVoices || []).map(voice => ({
      id: voice,
      type: 'default',
      modelId: item.modelId,
      displayName: voice.split(':').pop() || voice,
      voice: voice
    }));

    const remoteVoiceItems = remoteVoices
      .filter(voice => (voice.model || item.modelId) === item.modelId)
      .map(voice => ({
        id: voice.uri,
        type: 'remote',
        modelId: item.modelId,
        displayName: voice.customName || voice.uri,
        voice: voice.uri,
        uri: voice.uri,
        customName: voice.customName || '',
        text: voice.text || '',
        raw: voice
      }));

    return {
      modelId: item.modelId,
      folderName: item.folderName,
      defaults: defaultVoices,
      remoteVoices: remoteVoiceItems,
      localSamples: item.samples.map(sample => ({
        id: sample.id,
        sampleName: sample.sampleName,
        fileName: sample.fileName,
        text: sample.text
      })),
      mergedVoiceOptions: [...defaultVoices, ...remoteVoiceItems]
    };
  });

  return {
    updatedAt: new Date().toISOString(),
    source: 'WebIndexTTSManager',
    models
  };
}

function writeTruthJson(payload) {
  fs.writeFileSync(TRUTH_JSON_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

async function handleConfig(res) {
  const env = getEnvConfig();
  const library = scanReferenceLibrary();

  json(res, 200, {
    ok: true,
    siliconflowUrl: env.siliconflowUrl,
    recommendedSiliconflowUrl: 'https://api.siliconflow.cn',
    networkProviderLabel: '硅基流动 IndexTTS2',
    hasApiKey: Boolean(env.siliconflowKey),
    configSource: env.source,
    settingsJsonPath: SETTINGS_JSON_PATH,
    truthJsonPath: TRUTH_JSON_PATH,
    models: library.map(item => ({
      modelId: item.modelId,
      folderName: item.folderName,
      sampleCount: item.samples.length,
      defaultVoices: MODEL_PRESETS[item.modelId]?.defaultVoices || []
    }))
  });
}

async function handleLibraryList(res) {
  json(res, 200, {
    ok: true,
    models: scanReferenceLibrary()
  });
}

async function handleVoiceList(res) {
  const data = await siliconJsonFetch('/v1/audio/voice/list', { method: 'GET' });
  json(res, 200, {
    ok: true,
    ...data
  });
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

async function handleTruthRefresh(res) {
  let remoteVoices = [];
  try {
    const remote = await siliconJsonFetch('/v1/audio/voice/list', { method: 'GET' });
    remoteVoices = normalizeRemoteVoiceListPayload(remote);
  } catch (error) {
    remoteVoices = [];
  }

  const payload = buildTruthPayload(remoteVoices);
  writeTruthJson(payload);

  json(res, 200, {
    ok: true,
    truthJsonPath: TRUTH_JSON_PATH,
    modelCount: payload.models.length,
    remoteVoiceCount: remoteVoices.length,
    payload
  });
}

async function handleCreateModel(req, res) {
  const body = await parseJsonBody(req);
  const modelId = String(body.modelId || '').trim();
  if (!modelId) {
    return json(res, 400, { ok: false, error: '缺少 modelId' });
  }

  const modelDir = ensureModelDirectory(modelId);
  json(res, 200, {
    ok: true,
    modelId,
    folderName: path.basename(modelDir)
  });
}

async function handleDeleteVoice(req, res) {
  const body = await parseJsonBody(req);
  if (!body.uri) {
    return json(res, 400, { ok: false, error: '缺少 uri' });
  }

  const data = await siliconJsonFetch('/v1/audio/voice/deletions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ uri: body.uri })
  });

  json(res, 200, {
    ok: true,
    deleteResult: data
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
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/app.js') {
      return serveFile(res, path.join(PUBLIC_DIR, 'app.js'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/styles.css') {
      return serveFile(res, path.join(PUBLIC_DIR, 'styles.css'), 'text/css; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      return handleConfig(res);
    }
    if (req.method === 'GET' && pathname === '/api/library') {
      return handleLibraryList(res);
    }
    if (req.method === 'GET' && pathname === '/api/voice/list') {
      return await handleVoiceList(res);
    }
    if (req.method === 'POST' && pathname === '/api/truth/refresh') {
      return await handleTruthRefresh(res);
    }
    if (req.method === 'POST' && pathname === '/api/model/create') {
      return await handleCreateModel(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/voice/delete') {
      return await handleDeleteVoice(req, res);
    }

    return text(res, 404, 'Not Found');
  } catch (error) {
    return handleError(res, error);
  }
});

server.listen(PORT, () => {
  console.log(`WebIndexTTSManager running at http://localhost:${PORT}`);
});