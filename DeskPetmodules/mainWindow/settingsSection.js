// 全局设置的「桌宠」分区（由 ./index.js 经 modules/settings/extensions.js 注册）。
// 内容全部在自包含面板里（settingsPanel.js）：大预览、我的桌宠卡片、选项、快捷键。
// 持久化权威是主进程 deskpet-settings:* IPC（AppData/deskpet/settings.json、state.json），
// 不经过表单 collect/自动保存。
import { section, custom } from '../../modules/settings/schema/kernel.js';
import { buildDeskPetPanel } from './settingsPanel.js';

export const deskPetSection = section('deskpet', '桌宠', [
    custom('deskPetPanel', buildDeskPetPanel),
]);
