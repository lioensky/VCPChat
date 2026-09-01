// schema/user-identity — "用户身份" 分区（M1）。
// 头像资料卡与折叠样式区是专属组件（custom），标记由 render/widgets
// 逐字构建；管理员账号两行走普通 text 行。
import { section, text, custom } from './kernel.js';
import { buildUserProfileCard } from '../render/widgets.js';

export const userIdentitySection = section('user-identity', '用户身份', [
    custom('userProfileCard', buildUserProfileCard),
    text('adminUsername', {
        inputType: 'text',
        label: '管理员账号:',
        placeholder: '论坛管理员账号',
        rowStyle: 3,
    }),
    text('adminPassword', {
        inputType: 'password',
        label: '管理员密码:',
        placeholder: '论坛管理员密码',
    }),
]);
