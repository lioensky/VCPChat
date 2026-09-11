// Group settings UI slots.
// GroupRenderer owns group state and persistence; this module owns DOM details.

(function installGroupSettingsSlots(global) {
    const defaultAvatar = 'assets/default_avatar.png';

    function clear(node) {
        node?.replaceChildren();
    }

    function message(node, text, tag = 'p') {
        if (!node) return;
        clear(node);
        const wrapper = node.ownerDocument.createElement(tag);
        wrapper.textContent = text;
        node.appendChild(wrapper);
    }

    function ensureSettingsSurface({ document, settingsTab }) {
        if (!settingsTab) return null;
        let host = global.VCPSettingsSidebar?.getView?.('group') || document.getElementById('groupSettingsContainer');
        if (!host) {
            host = document.createElement('div');
            host.id = 'groupSettingsContainer';
            host.className = 'settings-sidebar-surface-view';
            settingsTab.appendChild(host);
        }
        if (!host.dataset.schemaRendered) {
            const schema = global.VCPSettingsSchema;
            if (!schema?.renderGroupSettingsSurface) return null;
            schema.renderGroupSettingsSurface(host, document);
            host.dataset.schemaRendered = 'true';
        }
        global.VCPSettingsSidebar?.register?.('group', host);
        return host;
    }

    function renderSummary(summary, value) {
        if (!summary) return;
        if (!value || value.kind !== 'identity') {
            summary.classList.remove('summary-with-avatar');
            summary.textContent = typeof value === 'string' ? value : '';
            return;
        }
        summary.classList.add('summary-with-avatar');
        clear(summary);
        const doc = summary.ownerDocument;
        const avatar = doc.createElement('img');
        avatar.className = 'group-settings-summary-avatar';
        avatar.src = value.avatarSrc || 'assets/default_group_avatar.png';
        avatar.alt = '';
        avatar.width = 30;
        avatar.height = 30;
        const copy = doc.createElement('div');
        copy.className = 'group-settings-summary-copy';
        const title = doc.createElement('span');
        title.className = 'group-settings-summary-label';
        title.textContent = value.text || '未命名群组';
        const meta = doc.createElement('span');
        meta.className = 'group-settings-summary-meta';
        meta.textContent = value.meta || '';
        copy.append(title, meta);
        summary.append(avatar, copy);
    }

    function readSelectedMemberIds(container) {
        return Array.from(container?.querySelectorAll('input[type="checkbox"]:checked') || [])
            .map(input => input.value);
    }

    function readSequentialSpeakerOrder(list) {
        return Array.from(list?.querySelectorAll('.sequential-speaker-order-item') || [])
            .map(item => item.dataset.agentId)
            .filter(Boolean);
    }

    function renderMemberList({ container, tagsContainer, agents, groupConfig, onChange }) {
        if (!container) return;
        clear(container);
        clear(tagsContainer);
        const doc = container.ownerDocument;
        (agents || []).forEach(agent => {
            const row = doc.createElement('div');
            row.className = 'group-member-item';
            const checkbox = doc.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `member_agent_${agent.id}`;
            checkbox.value = agent.id;
            checkbox.checked = Boolean(groupConfig?.members?.includes(agent.id));
            checkbox.addEventListener('change', () => onChange?.());
            const label = doc.createElement('label');
            label.className = 'group-member-label';
            label.htmlFor = checkbox.id;
            const avatar = doc.createElement('img');
            avatar.src = agent.avatarUrl || defaultAvatar;
            avatar.alt = agent.name || agent.id;
            avatar.className = 'avatar-small';
            const name = doc.createElement('span');
            name.className = 'group-member-name';
            name.textContent = agent.name || agent.id;
            label.append(avatar, name);
            row.append(checkbox, label);
            container.appendChild(row);
        });
    }

    function moveItem(list, item, direction, onChanged) {
        if (!item || !list) return;
        const sibling = direction < 0 ? item.previousElementSibling : item.nextElementSibling;
        if (!sibling) return;
        list.insertBefore(direction < 0 ? item : sibling, direction < 0 ? sibling : item);
        item.focus();
        onChanged?.();
    }

    function buildChevronIcon(doc, direction = 'up') {
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('width', '10');
        svg.setAttribute('height', '10');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.6');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', direction === 'up' ? 'M3.5 10L8 5.5L12.5 10' : 'M3.5 6L8 10.5L12.5 6');
        svg.append(path);
        return svg;
    }

    function buildGripVerticalIcon(doc) {
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('width', '12');
        svg.setAttribute('height', '12');
        svg.setAttribute('fill', 'currentColor');
        svg.setAttribute('aria-hidden', 'true');
        for (const [cx, cy] of [[5.5, 3.5], [5.5, 8], [5.5, 12.5], [10.5, 3.5], [10.5, 8], [10.5, 12.5]]) {
            const circle = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', String(cx));
            circle.setAttribute('cy', String(cy));
            circle.setAttribute('r', '1.25');
            svg.append(circle);
        }
        return svg;
    }

    function createSequentialItem({ list, agent, onChanged }) {
        const doc = list.ownerDocument;
        const item = doc.createElement('div');
        item.className = 'sequential-speaker-order-item';
        item.dataset.agentId = agent.id;
        item.draggable = true;
        item.tabIndex = 0;
        item.setAttribute('role', 'listitem');
        item.setAttribute('aria-label', `${agent.name || agent.id}，可拖拽调整发言顺序`);

        const handle = doc.createElement('span');
        handle.className = 'sequential-speaker-drag-handle';
        handle.title = '拖拽调整顺序';
        handle.setAttribute('aria-hidden', 'true');
        handle.append(buildGripVerticalIcon(doc));
        const avatar = doc.createElement('img');
        avatar.className = 'avatar-small';
        avatar.src = agent.avatarUrl || defaultAvatar;
        avatar.alt = '';
        const name = doc.createElement('span');
        name.className = 'sequential-speaker-name';
        name.textContent = agent.name || agent.id;
        const controls = doc.createElement('span');
        controls.className = 'sequential-speaker-order-controls';
        const up = doc.createElement('button');
        up.type = 'button';
        up.className = 'sequential-order-move-btn';
        up.title = '上移';
        up.setAttribute('aria-label', `上移 ${agent.name || agent.id}`);
        up.append(buildChevronIcon(doc, 'up'));
        up.addEventListener('click', () => moveItem(list, item, -1, onChanged));
        const down = doc.createElement('button');
        down.type = 'button';
        down.className = 'sequential-order-move-btn';
        down.title = '下移';
        down.setAttribute('aria-label', `下移 ${agent.name || agent.id}`);
        down.append(buildChevronIcon(doc, 'down'));
        down.addEventListener('click', () => moveItem(list, item, 1, onChanged));
        controls.append(up, down);
        item.append(handle, avatar, name, controls);

        item.addEventListener('dragstart', event => {
            item.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', agent.id);
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            list.querySelectorAll('.drag-over').forEach(node => node.classList.remove('drag-over'));
            onChanged?.();
        });
        item.addEventListener('dragover', event => {
            event.preventDefault();
            if (!item.classList.contains('dragging')) item.classList.add('drag-over');
            event.dataTransfer.dropEffect = 'move';
        });
        item.addEventListener('dragleave', event => {
            if (!item.contains(event.relatedTarget)) {
                item.classList.remove('drag-over');
            }
        });
        item.addEventListener('drop', event => {
            event.preventDefault();
            item.classList.remove('drag-over');
            const draggedId = event.dataTransfer.getData('text/plain');
            const draggedItem = Array.from(list.querySelectorAll('.sequential-speaker-order-item'))
                .find(node => node.dataset.agentId === draggedId);
            if (!draggedItem || draggedItem === item) return;
            const bounds = item.getBoundingClientRect();
            list.insertBefore(draggedItem, event.clientY > bounds.top + bounds.height / 2 ? item.nextElementSibling : item);
            onChanged?.();
        });
        item.addEventListener('keydown', event => {
            if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            moveItem(list, item, event.key === 'ArrowUp' ? -1 : 1, onChanged);
        });
        return item;
    }

    function renderSequentialSpeakerOrder({ list, agents, groupConfig = {}, onChanged }) {
        if (!list) return;
        const selectedIds = readSelectedMemberIds(list.ownerDocument.getElementById('groupMembersList'));
        const selectedSet = new Set(selectedIds);
        const draftOrder = readSequentialSpeakerOrder(list);
        const savedOrder = groupConfig.modeSettings?.sequential?.speakerOrder || groupConfig.sequentialSpeakerOrder || [];
        const preferredOrder = draftOrder.length ? draftOrder : savedOrder;
        const normalizedOrder = [
            ...preferredOrder.filter((id, index) => selectedSet.has(id) && preferredOrder.indexOf(id) === index),
            ...selectedIds.filter(id => !preferredOrder.includes(id))
        ];
        clear(list);
        if (!normalizedOrder.length) {
            const empty = list.ownerDocument.createElement('div');
            empty.className = 'sequential-speaker-order-empty';
            empty.textContent = '请先勾选群组成员';
            list.appendChild(empty);
            return;
        }
        normalizedOrder.forEach(id => {
            const agent = (agents || []).find(candidate => candidate.id === id);
            if (agent) list.appendChild(createSequentialItem({ list, agent, onChanged }));
        });
    }

    function renderMemberTags({ container, membersContainer, agents, groupConfig = {}, onChanged }) {
        if (!container || !membersContainer) return;
        const draftTags = Object.fromEntries(Array.from(container.querySelectorAll('input[type="text"]')).map(input => [input.dataset.agentId, input.value]));
        clear(container);
        const persisted = groupConfig.modeSettings?.naturerandom?.memberTags || groupConfig.memberTags || {};
        const selectedIds = readSelectedMemberIds(membersContainer);
        const doc = container.ownerDocument;
        selectedIds.forEach(agentId => {
            const agent = (agents || []).find(candidate => candidate.id === agentId);
            if (!agent) return;
            const row = doc.createElement('div');
            row.className = 'member-tag-input-item';
            const label = doc.createElement('label');
            label.htmlFor = `tags_for_${agentId}`;
            const agentName = agent.name || agent.id;
            label.textContent = agentName;
            label.title = agentName;
            const input = doc.createElement('input');
            input.type = 'text';
            input.id = `tags_for_${agentId}`;
            input.dataset.agentId = agentId;
            input.placeholder = '例如: 猫娘,小克,科学';
            input.value = draftTags[agentId] ?? persisted[agentId] ?? '';
            input.addEventListener('input', () => onChanged?.());
            row.append(label, input);
            container.appendChild(row);
        });
    }

    function readMemberTags(container) {
        return Object.fromEntries(Array.from(container?.querySelectorAll('input[type="text"]') || [])
            .map(input => [input.dataset.agentId, input.value.trim()]));
    }

    function setModeVisibility({ sequentialContainer, tagsContainer, mode }) {
        if (sequentialContainer) sequentialContainer.hidden = mode !== 'sequential';
        if (tagsContainer) tagsContainer.hidden = mode !== 'naturerandom';
    }

    function renderTopicList({ topics, container, groupId, currentTopicId, avatarSrc, onSelect, onContextMenu }) {
        if (!container) return;
        clear(container);
        if (topics?.error) {
            const item = container.ownerDocument.createElement('li');
            item.textContent = `加载话题失败: ${topics.error}`;
            container.appendChild(item);
            return;
        }
        if (!topics?.length) {
            const item = container.ownerDocument.createElement('li');
            item.textContent = '此群组还没有话题。';
            container.appendChild(item);
            return;
        }
        [...topics].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).forEach(topic => {
            const item = container.ownerDocument.createElement('li');
            item.className = 'topic-item';
            item.dataset.itemId = groupId;
            item.dataset.itemType = 'group';
            item.dataset.topicId = topic.id;
            if (topic.id === currentTopicId) item.classList.add('active', 'active-topic-glowing');
            const avatar = container.ownerDocument.createElement('img');
            avatar.className = 'avatar';
            avatar.src = avatarSrc || 'assets/default_avatar.png';
            avatar.alt = '群组头像';
            const name = container.ownerDocument.createElement('span');
            name.className = 'topic-name';
            name.textContent = topic.name;
            item.append(avatar, name);
            item.addEventListener('click', () => onSelect?.(topic.id));
            item.addEventListener('contextmenu', event => {
                event.preventDefault();
                onContextMenu?.(event, topic);
            });
            container.appendChild(item);
        });
    }

    function renderInviteButtons({ container, membersConfigs, groupConfig, groupId, topicId, onInvite }) {
        if (!container) return;
        clear(container);
        if (!membersConfigs?.length || !groupConfig || groupConfig.mode !== 'invite_only') {
            container.hidden = true;
            return;
        }
        container.hidden = false;
        const doc = container.ownerDocument;
        membersConfigs.filter(member => member && !member.error).forEach(member => {
            const button = doc.createElement('button');
            button.type = 'button';
            button.className = 'invite-agent-button';
            button.title = `邀请 ${member.name} 发言`;
            const avatar = doc.createElement('img');
            avatar.src = member.avatarUrl || defaultAvatar;
            avatar.alt = member.name || member.id;
            avatar.width = 24;
            avatar.height = 24;
            avatar.className = 'avatar-small';
            const name = doc.createElement('span');
            name.textContent = member.name || member.id;
            button.append(avatar, name);
            button.addEventListener('click', () => onInvite?.(groupId, topicId, member.id, member.name));
            container.appendChild(button);
        });
    }

    function clearInviteButtons(container) {
        if (!container) return;
        clear(container);
        container.hidden = true;
    }

    global.VCPGroupSettingsSlots = Object.freeze({
        ensureSettingsSurface,
        renderSummary,
        message,
        renderMemberList,
        readSelectedMemberIds,
        readSequentialSpeakerOrder,
        renderSequentialSpeakerOrder,
        renderMemberTags,
        readMemberTags,
        setModeVisibility,
        renderTopicList,
        renderInviteButtons,
        clearInviteButtons,
    });
    global.dispatchEvent(new CustomEvent('vcp-group-settings-slots-ready'));
})(window);
