/* Side pane home page: the current assistant's avatar and name above the notifications list. */
'use strict';

/**
 * 首页固定在标签条最左边：上面是当前助手的头像和名字，下面直接是通知列表。
 * 这里只管头像和名字；通知列表是 #notificationsSidebar 自己的。
 */
export function createSidePaneHome({ contentContainer }) {
    const view = contentContainer?.querySelector?.('#sidePaneViewHome') || null;
    const find = (parent, selector) => parent?.querySelector?.(selector) || null;
    const profile = find(view, '.side-pane-home-profile');
    const profileAvatar = find(profile, '.side-pane-home-avatar');
    const profileImage = find(profileAvatar, 'img');
    const profileName = find(profile, '.side-pane-home-name');
    const cleanups = [];

    let profileProvider = null;
    let profileEdit = null;
    let profileRename = null;
    let profileNameValue = '';
    let nameEdit = null;

    // 每次回到首页现取，改了头像或名字也能跟上
    function renderProfile() {
        if (!profile) return;
        let current = null;
        try {
            current = profileProvider?.() || null;
        } catch (error) {
            console.warn('[SidePaneHome] Failed to read profile:', error);
        }
        profile.hidden = !current;
        profileEdit = typeof current?.onEditAvatar === 'function' ? current.onEditAvatar : null;
        profileRename = typeof current?.onRename === 'function' ? current.onRename : null;
        if (!current) return;
        profileNameValue = current.name || '';
        if (profileName) {
            // 正在改名时不覆盖输入框
            if (!nameEdit) profileName.value = profileNameValue;
            profileName.readOnly = !profileRename;
            profileName.title = profileRename ? '编辑名称' : '';
        }
        if (profileImage) {
            const src = current.avatarUrl || 'assets/default_avatar.png';
            if (profileImage.getAttribute('src') !== src) profileImage.setAttribute('src', src);
        }
        if (profileAvatar) {
            profileAvatar.disabled = !profileEdit;
            profileAvatar.setAttribute('aria-label', profileEdit ? '编辑头像' : (current.name || '头像'));
        }
    }

    if (profileAvatar) {
        const onAvatarClick = () => {
            if (profileEdit) profileEdit();
        };
        profileAvatar.addEventListener('click', onAvatarClick);
        cleanups.push(() => profileAvatar.removeEventListener('click', onAvatarClick));
    }

    // 名字点一下就能改：回车或点别处保存，Esc 放弃；空名字不保存
    if (profileName) {
        const onNameFocus = () => {
            if (profileName.readOnly || !profileRename) return;
            nameEdit = { rename: profileRename, original: profileNameValue };
        };
        const onNameKeydown = (e) => {
            if (!nameEdit) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                profileName.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                profileName.value = nameEdit.original;
                profileName.blur();
            }
        };
        const onNameBlur = async () => {
            const edit = nameEdit;
            nameEdit = null;
            if (!edit) return;
            const next = profileName.value.trim();
            if (!next || next === edit.original) {
                profileName.value = edit.original;
                return;
            }
            profileName.value = next;
            try {
                const result = await edit.rename(next);
                if (result === false || result?.error) throw new Error(result?.error || 'rename-failed');
                if (profileNameValue === edit.original) profileNameValue = next;
            } catch (error) {
                console.warn('[SidePaneHome] Failed to rename:', error);
                if (!nameEdit && profileName.value === next) profileName.value = edit.original;
            }
        };
        profileName.addEventListener('focus', onNameFocus);
        profileName.addEventListener('keydown', onNameKeydown);
        profileName.addEventListener('blur', onNameBlur);
        cleanups.push(() => {
            profileName.removeEventListener('focus', onNameFocus);
            profileName.removeEventListener('keydown', onNameKeydown);
            profileName.removeEventListener('blur', onNameBlur);
        });
    }

    return Object.freeze({
        renderProfile,
        setProfileProvider(provider) {
            profileProvider = typeof provider === 'function' ? provider : null;
            renderProfile();
        },
        dispose() {
            cleanups.forEach(cleanup => cleanup());
            cleanups.length = 0;
        }
    });
}
