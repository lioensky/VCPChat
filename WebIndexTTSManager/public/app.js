const resultBox = document.getElementById('resultBox');
const configPanel = document.getElementById('configPanel');
const modelList = document.getElementById('modelList');
const voiceList = document.getElementById('voiceList');
const deleteUriInput = document.getElementById('deleteUri');
const newModelIdInput = document.getElementById('newModelId');

let latestRemoteVoices = [];
let latestConfig = null;

function setResult(data) {
  resultBox.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

async function request(url, options = {}) {
  setResult(`请求中: ${url}`);
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...options
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new Error(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }

  setResult(data);
  return data;
}

function renderConfig(config) {
  latestConfig = config;
  configPanel.innerHTML = '';

  const entries = [
    ['SiliconFlow URL', config.siliconflowUrl],
    ['API Key 是否存在', config.hasApiKey ? '是' : '否'],
    ['真相 JSON', config.truthJsonPath],
    ['模型目录数', String(config.models.length)]
  ];

  for (const [label, value] of entries) {
    const div = document.createElement('div');
    div.className = 'info-item';
    div.innerHTML = `<strong>${label}</strong><span>${value}</span>`;
    configPanel.appendChild(div);
  }

  renderModels(config.models || []);
}

function renderModels(models) {
  if (!models.length) {
    modelList.innerHTML = '<p>暂无模型目录。</p>';
    return;
  }

  modelList.innerHTML = models.map(model => `
    <div class="model-item">
      <div><strong>modelId:</strong> ${model.modelId}</div>
      <div><strong>folderName:</strong> ${model.folderName}</div>
      <div><strong>sampleCount:</strong> ${model.sampleCount}</div>
      <div><strong>defaultVoices:</strong> ${(model.defaultVoices || []).join(', ') || '无'}</div>
    </div>
  `).join('');
}

function normalizeVoiceListPayload(payload) {
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

function renderVoiceList(results) {
  latestRemoteVoices = normalizeVoiceListPayload(results);
  if (!latestRemoteVoices.length) {
    voiceList.innerHTML = '<p>暂无线上参考音色。</p>';
    return;
  }

  voiceList.innerHTML = latestRemoteVoices.map(item => `
    <div class="voice-item">
      <div><strong>customName:</strong> ${item.customName || ''}</div>
      <div><strong>uri:</strong> ${item.uri || ''}</div>
      <div><strong>model:</strong> ${item.model || ''}</div>
      <div><strong>text:</strong> ${(item.text || '').slice(0, 120)}</div>
      <button class="small-action" data-uri="${item.uri || ''}">填入删除框</button>
    </div>
  `).join('');

  voiceList.querySelectorAll('[data-uri]').forEach(button => {
    button.addEventListener('click', () => {
      deleteUriInput.value = button.dataset.uri || '';
      setResult(`已填入 URI: ${button.dataset.uri || ''}`);
    });
  });
}

async function loadConfig() {
  const data = await request('/api/config', { method: 'GET' });
  renderConfig(data);
}

document.getElementById('refreshConfigBtn').addEventListener('click', loadConfig);

document.getElementById('refreshTruthBtn').addEventListener('click', async () => {
  await request('/api/truth/refresh', {
    method: 'POST',
    body: JSON.stringify({})
  });
});

document.getElementById('createModelBtn').addEventListener('click', async () => {
  const modelId = newModelIdInput.value.trim();
  if (!modelId) {
    setResult('请先输入 modelId');
    return;
  }

  await request('/api/model/create', {
    method: 'POST',
    body: JSON.stringify({ modelId })
  });

  await loadConfig();
});

document.getElementById('listVoiceBtn').addEventListener('click', async () => {
  const data = await request('/api/voice/list', { method: 'GET' });
  renderVoiceList(data);
});

document.getElementById('deleteVoiceBtn').addEventListener('click', async () => {
  const uri = deleteUriInput.value.trim();
  if (!uri) {
    setResult('请先输入要删除的 uri');
    return;
  }

  await request('/api/voice/delete', {
    method: 'POST',
    body: JSON.stringify({ uri })
  });
});

loadConfig().catch(error => {
  setResult(`初始化失败: ${error.message}`);
});