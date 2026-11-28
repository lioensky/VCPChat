// modules/musicThumbar.js
// Windows 任务栏缩略图上的「上一首 / 播放·暂停 / 下一首」三个按钮（鼠标停在任务栏的音乐窗口图标上出现）。
// 点按钮和窗口里的按钮一样，走 music-control 发给音乐页面；播放状态变了就把中间那个换成对应的图标。
// 只在 Windows 上做；图标在 assets/music-thumbar/（白色，带 @2x，高分屏自动用大图）。

const path = require('path');

const ICON_DIR = path.join(__dirname, '..', 'assets', 'music-thumbar');

function createMusicThumbar({ nativeImage, platform = process.platform, iconDir = ICON_DIR } = {}) {
    const enabled = platform === 'win32' && nativeImage && typeof nativeImage.createFromPath === 'function';
    const icons = Object.create(null);
    const icon = (name) => {
        if (!icons[name]) icons[name] = nativeImage.createFromPath(path.join(iconDir, `${name}.png`));
        return icons[name];
    };
    let lastKey = '';

    const buttons = (win, playing) => {
        const send = (command) => () => {
            if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed?.()) {
                win.webContents.send('music-control', command);
            }
        };
        return [
            { tooltip: '上一首', icon: icon('previous'), click: send('previous') },
            playing
                ? { tooltip: '暂停', icon: icon('pause'), click: send('pause') }
                : { tooltip: '播放', icon: icon('play'), click: send('play') },
            { tooltip: '下一首', icon: icon('next'), click: send('next') }
        ];
    };

    // force：窗口隐藏再显示后 Windows 会丢掉按钮，要重新设一遍
    const update = (win, { playing = false, force = false } = {}) => {
        if (!enabled || !win || win.isDestroyed() || typeof win.setThumbarButtons !== 'function') return false;
        const key = `${win.id}:${playing ? 1 : 0}`;
        if (!force && key === lastKey) return false;
        try {
            const ok = win.setThumbarButtons(buttons(win, playing));
            if (ok === false) return false;
            lastKey = key;
            return true;
        } catch (error) {
            console.warn('[Music] setThumbarButtons failed:', error?.message || error);
            return false;
        }
    };

    const reset = () => { lastKey = ''; };

    return { enabled, update, reset };
}

module.exports = { createMusicThumbar };
