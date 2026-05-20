const path = require('path');
const fs = require('fs-extra');
const { SHARED_CHAT_GROUP_ID } = require('./agentIdentity');

const DEFAULT_GROUP_AVATAR_FILE = 'avatar.png';
const CANONICAL_GROUP_AVATAR_NAME = 'VCP三方会谈.png';

function defaultGroupAvatarSourcePath(appPaths) {
    const appDataRoot = appPaths.AGENT_GROUPS_DIR
        ? path.dirname(appPaths.AGENT_GROUPS_DIR)
        : '';
    const canonicalAvatar = appDataRoot
        ? path.join(appDataRoot, 'avatarimage', CANONICAL_GROUP_AVATAR_NAME)
        : '';
    const sharedGroupAvatar = appPaths.AGENT_GROUPS_DIR
        ? path.join(appPaths.AGENT_GROUPS_DIR, SHARED_CHAT_GROUP_ID, DEFAULT_GROUP_AVATAR_FILE)
        : '';
    if (canonicalAvatar && fs.existsSync(canonicalAvatar)) return canonicalAvatar;
    if (sharedGroupAvatar && fs.existsSync(sharedGroupAvatar)) return sharedGroupAvatar;
    return path.join(__dirname, '..', '..', 'assets', 'default_group_avatar.png');
}

function createGroupAvatarResolver(appPaths) {
    async function ensureDefaultGroupAvatar(groupDir, config) {
        if (config.avatar) return config;
        const sharedGroupAvatar = defaultGroupAvatarSourcePath(appPaths);
        const fallbackAvatar = path.join(__dirname, '..', '..', 'assets', 'default_group_avatar.png');
        const sourceAvatar = await fs.pathExists(sharedGroupAvatar) ? sharedGroupAvatar : fallbackAvatar;
        if (await fs.pathExists(sourceAvatar)) {
            await fs.copy(sourceAvatar, path.join(groupDir, DEFAULT_GROUP_AVATAR_FILE), { overwrite: true });
            config.avatar = DEFAULT_GROUP_AVATAR_FILE;
        }
        return config;
    }

    async function resolveGroupAvatarUrl(groupPath, config) {
        const candidates = [];
        const appDataRoot = appPaths.AGENT_GROUPS_DIR
            ? path.dirname(appPaths.AGENT_GROUPS_DIR)
            : '';
        if (appDataRoot && config?.id) {
            candidates.push(path.join(appDataRoot, 'avatarimage', `group_${config.id}.png`));
        }
        if (config.avatar) candidates.push(path.join(groupPath, config.avatar));
        candidates.push(
            path.join(groupPath, 'avatar.png'),
            path.join(groupPath, 'avatar.jpg'),
            path.join(groupPath, 'avatar.jpeg'),
            path.join(groupPath, 'avatar.gif')
        );
        for (const avatarPath of candidates) {
            if (await fs.pathExists(avatarPath)) {
                return `file://${avatarPath}?t=${Date.now()}`;
            }
        }
        const defaultAvatar = defaultGroupAvatarSourcePath(appPaths);
        if (await fs.pathExists(defaultAvatar)) {
            return `file://${defaultAvatar}?t=${Date.now()}`;
        }
        return null;
    }

    return {
        ensureDefaultGroupAvatar,
        resolveGroupAvatarUrl
    };
}

module.exports = {
    DEFAULT_GROUP_AVATAR_FILE,
    CANONICAL_GROUP_AVATAR_NAME,
    createGroupAvatarResolver,
    defaultGroupAvatarSourcePath
};
