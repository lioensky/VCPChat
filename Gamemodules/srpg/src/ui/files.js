// 下载 / 选择 JSON 文件
import { h } from './dom.js';

export const today = () => new Date().toISOString().slice(0, 10);

export function downloadJson(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** 让用户选择一个 JSON 文件并解析；取消时 reject(new Error('cancelled')) */
export function pickJson() {
    return new Promise((resolve, reject) => {
        const input = h('input', { type: 'file', accept: '.json,application/json' });
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return reject(new Error('cancelled'));
            try {
                resolve(JSON.parse(await file.text()));
            } catch {
                reject(new Error('文件不是有效的 JSON'));
            }
        });
        input.click();
    });
}
