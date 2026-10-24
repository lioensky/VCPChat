/* 给桌宠的文件：拖到桌宠上的文件、往输入框里粘贴的图片，先攒在输入条上面，和下一句话一起发出去。
 * 纯函数，页面和测试共用。 */

export const MAX_FILES = 10;
export const MAX_PASTE_BYTES = 20 * 1024 * 1024;

/** 加进去，去掉重复的（同一路径；粘贴的图按名字和大小），最多留 MAX_FILES 个。返回新数组和被丢掉的个数 */
export function addFiles(current, incoming) {
    const list = [...current];
    let dropped = 0;
    const key = (f) => f.path || `paste:${f.name}:${f.size}`;
    for (const file of incoming) {
        if (!file || (!file.path && !file.data)) { dropped += 1; continue; }
        if (list.some((x) => key(x) === key(file))) continue;
        if (list.length >= MAX_FILES) { dropped += 1; continue; }
        list.push(file);
    }
    return { list, dropped };
}

/** 输入条上面那一行字：「📎 a.png」「📎 a.png 等 3 个」 */
export function describeFiles(list) {
    if (!list.length) return '';
    const first = list[0].name || '文件';
    const name = first.length > 24 ? `${first.slice(0, 23)}…` : first;
    return list.length === 1 ? `📎 ${name}` : `📎 ${name} 等 ${list.length} 个`;
}

/** 粘贴的图片起个名字：「粘贴的图片-20261009-153012.png」 */
export function pastedName(type, now = new Date()) {
    const ext = (String(type).split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `粘贴的图片-${stamp}.${ext}`;
}
