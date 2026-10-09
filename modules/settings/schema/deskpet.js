// schema/deskpet — "桌宠" 分区。
// 内容全部在自包含面板里（deskpet-panel.js）：大预览、我的桌宠卡片、选项、快捷键。
// 持久化权威是主进程 deskpet-settings:* IPC（AppData/deskpet/settings.json、state.json），
// 不经过表单 collect/自动保存。
import { section, custom } from './kernel.js';
import { buildDeskPetPanel } from './deskpet-panel.js';

export const deskPetSection = section('deskpet', '桌宠', [
    custom('deskPetPanel', buildDeskPetPanel),
]);
