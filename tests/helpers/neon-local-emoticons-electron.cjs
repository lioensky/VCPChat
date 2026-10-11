const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
const timer = setTimeout(() => app.exit(1), 15000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.resolve(__dirname, '../../Gamemodules/vcp-neon-game/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const response = await fetch('file:///H:/MCP/VCPChat/AppData/emoticon_library.json');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const entries = await response.json();
    const nova = entries.filter(entry => entry.category === 'Nova表情包');
    return { count: nova.length, defaultUrl: nova.find(entry => entry.filename === '疯狂吐槽.png')?.url };
  })()`);
  assert.ok(result.count > 0);
  assert.match(result.defaultUrl, /^https?:\/\//);
  console.log('LOCAL_EMOTICONS_ELECTRON_PASS', JSON.stringify(result));
  clearTimeout(timer);
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timer); app.exit(1); });