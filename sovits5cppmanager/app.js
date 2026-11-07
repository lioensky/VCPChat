'use strict';
(() => {
    const form = document.querySelector('#editor');
    const status = document.querySelector('#status');
    const field = name => form.elements.namedItem(name);
    let presets = [], objectUrl = '', working = false;
    const labels = { auto:'多语种混合', auto_yue:'多语种混合（粤）', all_zh:'中文',zh:'中英混合',en:'英文',all_ja:'日文',ja:'日英混合',all_ko:'韩文',ko:'韩英混合',all_yue:'粤语',yue:'粤英混合' };
    async function api(url, method = 'GET', body) {
        const response = await fetch(url, { method, headers: { 'X-GSV-Manager': '1', ...(body && !(body instanceof File) ? {'Content-Type':'application/json'} : {}) }, body: body instanceof File ? body : body ? JSON.stringify(body) : undefined });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || `HTTP ${response.status}`);
        }
        return response.headers.get('content-type').includes('audio/') ? response.blob() : response.json();
    }
    async function run(fn) {
        if (working) return;
        working = true;
        document.querySelectorAll('button').forEach(b => b.disabled = true);
        try { status.textContent = '处理中…'; await fn(); status.textContent = '完成'; }
        catch (e) { status.textContent = e.message; }
        finally { working = false; document.querySelectorAll('button').forEach(b => b.disabled = false); }
    }
    function edit(p) {
        form.reset();
        for (const [key,value] of Object.entries(p)) if (field(key)) field(key).value = value;
        document.querySelector('#audioInfo').textContent = p.audio || '尚未导入';
    }
    function fresh() { edit({id:crypto.randomUUID(),audio:'',promptLang:'all_zh',textLang:'auto'}); }
    async function load() {
        const doc = await api('/api/presets'); presets = doc.presets;
        for (const key of ['promptLang','textLang']) {
            const select = field(key), current = select.value;
            select.replaceChildren(...doc.languages.map(code => {
                const option = document.createElement('option');
                option.value = code; option.textContent = labels[code] || code; return option;
            }));
            select.value = current || (key === 'promptLang' ? 'all_zh' : 'auto');
        }
        document.querySelector('#list').replaceChildren(...presets.map(p => {
            const button = document.createElement('button');
            button.textContent = `${p.name} · ${p.emotion}`;
            button.addEventListener('click', () => edit(p));
            return button;
        }));
    }
    document.querySelector('#new').addEventListener('click', fresh);
    document.querySelector('#file').addEventListener('change', event => run(async () => {
        const file = event.target.files[0]; if (!file) return;
        const result = await api('/api/audio','POST',file);
        field('audio').value = result.audio;
        document.querySelector('#audioInfo').textContent = `${file.name} · ${result.duration.toFixed(2)} 秒`;
    }));
    form.addEventListener('submit', event => {
        event.preventDefault();
        run(async () => {
            const p = Object.fromEntries(new FormData(form));
            p.speed = Number(p.speed); p.sampleSteps = Number(p.sampleSteps);
            await api('/api/presets','POST',p); await load();
        });
    });
    document.querySelector('#delete').addEventListener('click', () => {
        if (!presets.some(p => p.id === field('id').value) || !confirm('删除当前预设？参考音频保留，不会删除原文件。')) return;
        run(async () => { await api(`/api/presets?id=${encodeURIComponent(field('id').value)}`,'DELETE'); await load(); fresh(); });
    });
    document.querySelector('#preview').addEventListener('click', () => run(async () => {
        const blob = await api('/api/preview','POST',{id:field('id').value,baseUrl:document.querySelector('#baseUrl').value,text:document.querySelector('#previewText').value});
        const player = document.querySelector('#player'); player.pause();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(blob); player.src = objectUrl; await player.play();
    }));
    window.addEventListener('beforeunload', () => { if (objectUrl) URL.revokeObjectURL(objectUrl); });
    run(async () => { await load(); fresh(); });
})();