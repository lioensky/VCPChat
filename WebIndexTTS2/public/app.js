const resultBox = document.getElementById('resultBox');
const audioPlayer = document.getElementById('audioPlayer');
const configPanel = document.getElementById('configPanel');
const sampleCheckboxes = document.getElementById('sampleCheckboxes');
const groupUploadCheckboxes = document.getElementById('groupUploadCheckboxes');
const uploadSample = document.getElementById('uploadSample');
const targetFolder = document.getElementById('targetFolder');
const presetVoice = document.getElementById('presetVoice');
const deleteUriInput = document.getElementById('deleteUri');
const voiceList = document.getElementById('voiceList');

let latestVoiceList = [];
let latestConfig = null;
let currentFolderName = '';

function setResult(data) {
  resultBox.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (data && data.audioUrl) {
    audioPlayer.src = data.audioUrl;
    audioPlayer.play().catch(() => {});
  }
}

async function request(url, options = {}) {
  setResult(`请求中: ${url}`);
  try {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setResult(`请求失败: ${url}\n${message}`);
    throw error;
  }
}

function getSamplesForCurrentFolder() {
  if (!latestConfig) {
    return [];
  }
  return (latestConfig.samples || []).filter(sample => sample.folderName === currentFolderName);
}

function renderFolderSamples() {
  const samples = getSamplesForCurrentFolder();
  uploadSample.innerHTML = '';
  sampleCheckboxes.innerHTML = '';
  groupUploadCheckboxes.innerHTML = '';

  samples.forEach((sample, index) => {
    const option = document.createElement('option');
    option.value = sample.id;
    option.textContent = `${sample.sampleName} - ${sample.fileName}`;
    uploadSample.appendChild(option);

    const defaultChecked = index < 2 ? 'checked' : '';
    const dynamicLabel = document.createElement('label');
    dynamicLabel.className = 'checkbox-item';
    dynamicLabel.innerHTML = `
      <input type="checkbox" value="${sample.id}" ${defaultChecked} />
      <span>${sample.sampleName} - ${sample.fileName}</span>
    `;
    sampleCheckboxes.appendChild(dynamicLabel);

    const uploadLabel = document.createElement('label');
    uploadLabel.className = 'checkbox-item';
    uploadLabel.innerHTML = `
      <input type="checkbox" value="${sample.id}" />
      <span>${sample.sampleName} - ${sample.fileName}</span>
    `;
    groupUploadCheckboxes.appendChild(uploadLabel);
  });
}

function renderConfig(config) {
  latestConfig = config;
  configPanel.innerHTML = '';
  const entries = [
    ['基础地址', config.baseUrl],
    ['模型', config.model],
    ['默认音色', config.defaultVoice],
    ['API Key 是否存在', config.hasApiKey ? '是' : '否'],
    ['参考目录数', String((config.sourceFolders || []).length)],
    ['本地样本数', String(config.samples.length)]
  ];
  for (const [label, value] of entries) {
    const div = document.createElement('div');
    div.className = 'info-item';
    div.innerHTML = `<strong>${label}</strong><span>${value}</span>`;
    configPanel.appendChild(div);
  }

  const folders = config.sourceFolders || [];
  targetFolder.innerHTML = '';
  folders.forEach(folder => {
    const option = document.createElement('option');
    option.value = folder.folderName;
    option.textContent = `${folder.folderName} (${folder.sampleCount})`;
    targetFolder.appendChild(option);
  });

  if (!folders.length) {
    currentFolderName = '';
    renderFolderSamples();
  } else {
    const stillExists = folders.some(folder => folder.folderName === currentFolderName);
    currentFolderName = stillExists ? currentFolderName : folders[0].folderName;
    targetFolder.value = currentFolderName;
    renderFolderSamples();
  }

  if (presetVoice.value.trim() === '') {
    presetVoice.value = config.defaultVoice;
  }
}

function renderVoiceList(results) {
  latestVoiceList = results || [];
  if (!latestVoiceList.length) {
    voiceList.innerHTML = '<p>暂无已上传参考音频。</p>';
    return;
  }
  voiceList.innerHTML = latestVoiceList.map(item => `
    <div class="voice-item">
      <div><strong>customName:</strong> ${item.customName || ''}</div>
      <div><strong>uri:</strong> ${item.uri || ''}</div>
      <div><strong>model:</strong> ${item.model || ''}</div>
      <div><strong>text:</strong> ${(item.text || '').slice(0, 120)}</div>
    </div>
  `).join('');
}

async function loadConfig() {
  const data = await request('/api/config', { method: 'GET' });
  renderConfig(data);
}

document.getElementById('refreshConfigBtn').addEventListener('click', loadConfig);

document.getElementById('presetBtn').addEventListener('click', async () => {
  await request('/api/speech/preset', {
    method: 'POST',
    body: JSON.stringify({
      input: document.getElementById('presetInput').value,
      voice: presetVoice.value
    })
  });
});

targetFolder.addEventListener('change', () => {
  currentFolderName = targetFolder.value;
  renderFolderSamples();
});

document.getElementById('uploadBtn').addEventListener('click', async () => {
  try {
    const sampleId = uploadSample.value;
    const customName = document.getElementById('uploadName').value.trim();
    const data = await request('/api/voice/upload', {
      method: 'POST',
      body: JSON.stringify({ sampleId, customName })
    });
    if (data.uri) {
      document.getElementById('voiceUri').value = data.uri;
    }
  } catch (_) {}
});

document.getElementById('groupUploadBtn').addEventListener('click', async () => {
  const checked = Array.from(groupUploadCheckboxes.querySelectorAll('input[type="checkbox"]:checked'))
    .map(item => item.value);
  const prefix = document.getElementById('groupUploadPrefix').value.trim() || 'amis_batch';

  if (!checked.length) {
    setResult('请先勾选至少一个样本用于组上传。');
    return;
  }

  const results = [];
  for (let index = 0; index < checked.length; index += 1) {
    const sampleId = checked[index];
    const sample = getSamplesForCurrentFolder().find(item => item.id === sampleId);
    const sampleName = sample ? sample.sampleName : sampleId;
    const customName = `${prefix}_${sampleName}_${index + 1}`;
    const data = await request('/api/voice/upload', {
      method: 'POST',
      body: JSON.stringify({ sampleId, customName })
    });
    results.push({
      sampleId,
      customName,
      uri: data.uri || null
    });
  }

  const lastUri = results.length ? results[results.length - 1].uri : '';
  if (lastUri) {
    document.getElementById('voiceUri').value = lastUri;
  }
  setResult({
    ok: true,
    message: '组上传完成',
    results
  });
});

document.getElementById('referenceBtn').addEventListener('click', async () => {
  await request('/api/speech/reference-uri', {
    method: 'POST',
    body: JSON.stringify({
      voiceUri: document.getElementById('voiceUri').value.trim(),
      input: document.getElementById('referenceInput').value
    })
  });
});

document.getElementById('dynamicBtn').addEventListener('click', async () => {
  const checked = Array.from(sampleCheckboxes.querySelectorAll('input[type="checkbox"]:checked'))
    .map(item => item.value);

  await request('/api/speech/dynamic-references', {
    method: 'POST',
    body: JSON.stringify({
      sampleIds: checked,
      input: document.getElementById('dynamicInput').value
    })
  });
});

document.getElementById('listBtn').addEventListener('click', async () => {
  const data = await request('/api/voice/list', { method: 'GET' });
  renderVoiceList(data.results || []);
});

document.getElementById('fillDeleteBtn').addEventListener('click', () => {
  if (latestVoiceList.length) {
    deleteUriInput.value = latestVoiceList[0].uri || '';
    setResult('已将首个列表项 uri 填入删除框。');
    return;
  }
  setResult('当前没有可填充的参考音频列表，请先点击“获取参考音频列表”。');
});

document.getElementById('deleteBtn').addEventListener('click', async () => {
  await request('/api/voice/delete', {
    method: 'POST',
    body: JSON.stringify({
      uri: deleteUriInput.value.trim()
    })
  });
});

loadConfig().catch(error => {
  setResult(`初始化失败: ${error.message}`);
});