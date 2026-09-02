// schema/user-identity — "用户身份" 分区（M1）。
// 头像资料卡与折叠样式区是专属组件（custom），标记由 render/widgets
// 逐字构建；管理员账号两行走普通 text 行（论坛通道，save:false 不进
// 全量载荷）。用户名/颜色对在资料卡内部，没有独立字段描述符，由分区
// collect 钩子按同一套值语义收集（M5-a）。
import { section, text, custom } from './kernel.js';
import { collectKey } from '../value-semantics.js';
import { buildUserProfileCard } from '../render/widgets.js';

export const userIdentitySection = section('user-identity', '用户身份', [
    custom('userProfileCard', buildUserProfileCard),
    text('adminUsername', {
        inputType: 'text',
        label: '管理员账号:',
        placeholder: '论坛管理员账号',
        rowStyle: 3,
        save: false,
    }),
    text('adminPassword', {
        inputType: 'password',
        label: '管理员密码:',
        placeholder: '论坛管理员密码',
        save: false,
    }),
], {
    // 资料卡内部的用户名与颜色对 + 已退役控件的常量键：
    // userUseThemeColorsInChat 在整个设置表单里没有控件（同名复选框属于
    // 单 Agent 表单），旧保存链的 `?.checked || false` 恒为 false。
    collect(scope) {
        return {
            userName: collectKey(scope, 'userName', { trim: true, falsy: '用户' }),
            userAvatarBorderColor: collectKey(scope, 'userAvatarBorderColor', { falsy: '#3d5a80' }),
            userNameTextColor: collectKey(scope, 'userNameTextColor', { falsy: '#ffffff' }),
            userUseThemeColorsInChat: false,
        };
    },
});
