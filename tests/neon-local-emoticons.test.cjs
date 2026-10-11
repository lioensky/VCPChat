const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../Gamemodules/vcp-neon-game/js/game.js'), 'utf8');
const uiSource = source.slice(source.indexOf('export class UI')).replace('export class UI', 'class UI')
  .replaceAll('import.meta.url', '"file:///H:/MCP/VCPChat/Gamemodules/vcp-neon-game/js/game.js"');
function fixture(fetch) {
  const attributes = new Map();
  const face = { hidden: true, getAttribute: key => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value) };
  const line = { textContent: '低血警告' };
  const context = vm.createContext({ fetch, URL, console: { warn() {} } });
  vm.runInContext(uiSource + '\nthis.UI = UI;', context);
  const ui = Object.create(context.UI.prototype);
  Object.assign(ui, { novaFace: face, novaLine: line, novaStickers: new Map(),
    novaStickerRules: [{ keywords: ['低血'], sticker: '急得跳起.png' }],
    defaultNovaSticker: '疯狂吐槽.png' });
  return { ui, face, attributes };
}
test('reads client AppData and uses exact library URL', async () => {
  let requested;
  const h = fixture(async url => {
    requested = String(url);
    return { ok: true, json: async () => [
      { category: 'Nova表情包', filename: '急得跳起.png', url: 'http://local/nova.png' },
      { category: 'Nova表情包', filename: '疯狂吐槽.png', url: 'http://local/default.png' },
      { category: 'Kerr表情包', filename: '急得跳起.png', url: 'http://wrong/kerr.png' },
      { category: 'Nova表情包', filename: '急得跳起.png', url: 'javascript:bad' }
    ] };
  });
  await h.ui.loadNovaStickers();
  assert.equal(requested, 'file:///H:/MCP/VCPChat/AppData/emoticon_library.json');
  assert.equal(h.attributes.get('src'), 'http://local/nova.png');
  assert.equal(h.face.hidden, false);
  h.ui.setNovaLine('普通文案');
  assert.equal(h.attributes.get('src'), 'http://local/default.png');
});
test('missing library keeps text functional and avatar hidden', async () => {
  const h = fixture(async () => { throw new Error('missing'); });
  await h.ui.loadNovaStickers();
  h.ui.setNovaLine('仍然能吐槽');
  assert.equal(h.ui.novaLine.textContent, '仍然能吐槽');
  assert.equal(h.face.hidden, true);
  assert.equal(h.attributes.has('src'), false);
});
test('game no longer requests GitHub stickers', () => {
  const html = fs.readFileSync(path.join(__dirname, '../Gamemodules/vcp-neon-game/index.html'), 'utf8');
  assert.doesNotMatch(source + html, /raw\.githubusercontent\.com/);
});