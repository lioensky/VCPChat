// Run with Electron: electron scripts/test-message-image-electron.cjs
// Only the save dialog is substituted; the feature encodes, previews and writes a real PNG.
const {app,BrowserWindow,dialog} = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'message-image-'));
app.setPath('userData',path.join(tmp,'profile'));
async function test() {
    await app.whenReady();
    const base = pathToFileURL(root + path.sep).href;
    fs.writeFileSync(path.join(tmp,'main.html'),`<base href="${base}"><div id="chatMessages"><div class="message-item assistant" data-message-id="1" style="width:700px"><div class="md-content">Example message</div><div class="message-timestamp">12:30</div></div></div><div class="chat-input-area"><div class="chat-input-card"></div></div>`);
    fs.writeFileSync(path.join(tmp,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('chatAPI',{messageImagePrepare:(...args)=>ipcRenderer.invoke('message-image:prepare',...args),messageImageOutput:(...args)=>ipcRenderer.invoke('message-image:output',...args)});`);
    const win = new BrowserWindow({show:false,webPreferences:{preload:path.join(tmp,'preload.cjs'),backgroundThrottling:false}});
    const handle = require('../modules/messageImage').register({projectRoot:tmp});
    const dest = path.join(tmp,'preview.png');
    dialog.showSaveDialog = async () => ({canceled:false,filePath:dest});
    const js = code => win.webContents.executeJavaScript(code);
    try {
        await win.loadFile(path.join(tmp,'main.html'));
        await js(fs.readFileSync(path.join(root,'modules/ui-system/contribution-registry.js'),'utf8'));
        const bytes = await js(`(async()=>{const {install}=await import(new URL('modules/messageImage/renderer/index.js',document.baseURI));install();const item=document.querySelector('.message-item');void window.VCPContributions.commands.execute('message-menu.message-image-copy-image',{messageItem:item});const wait=async(fn)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error(document.querySelector('dialog')?.innerText||'no preview')};const ready=()=>document.querySelector('dialog [data-action=save]:enabled');await wait(ready);document.querySelector('[data-setting=timestamps]').click();await wait(ready);const image=document.querySelector('dialog img');const data=Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer()));ready().click();await wait(()=>!document.querySelector('dialog'));return data})()`);
        assert.deepEqual(fs.readFileSync(dest),Buffer.from(bytes));
        console.log(`Preview equals saved PNG (${bytes.length} bytes)`);
    } finally {handle.dispose();win.destroy();}
}
test().then(()=>app.exit(0),err=>{console.error(err);app.exit(1)});
