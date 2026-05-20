const HUMAN_ACTOR_TYPES = new Set(['human', 'owner', 'user']);
const CODEX_EXTERNAL_ACTOR_ID = 'codex_ai_designer';
const CODEX_MEMBER_ID = 'Codex_Projection';
const XIAOAN_MEMBER_ID = 'VCP_Assistant';
const ZERO_WIDTH_SPACE = '\u200B';

function normalizeText(value) {
    return String(value || '').trim();
}

function splitAliases(value) {
    if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean);
    return normalizeText(value)
        .split(/[,，、\s]+/)
        .map(normalizeText)
        .filter(Boolean);
}

function visibleTextLength(text) {
    return String(text || '').replaceAll(ZERO_WIDTH_SPACE, '').length;
}

function visibleOffsetToRawOffset(text, visibleOffset) {
    let visibleCount = 0;
    const rawText = String(text || '');
    for (let i = 0; i < rawText.length; i += 1) {
        if (rawText[i] === ZERO_WIDTH_SPACE) continue;
        if (visibleCount === visibleOffset) return i;
        visibleCount += 1;
    }
    return rawText.length;
}

function avatarFromAgentConfig(config) {
    return config?.avatarUrl || config?.avatar || config?.avatarPath || '';
}

function labelForMember(memberId, agentConfig = {}) {
    if (memberId === XIAOAN_MEMBER_ID) return '小安';
    if (memberId === CODEX_MEMBER_ID) return 'AI设计师 Codex';
    return normalizeText(agentConfig.name) || memberId;
}

function upsertCandidate(candidateMap, candidate) {
    const key = candidate.identityKey || candidate.id || candidate.name;
    const existing = candidateMap.get(key);
    if (!existing) {
        candidateMap.set(key, candidate);
        return;
    }

    const aliases = new Set([...(existing.aliases || []), ...(candidate.aliases || [])]);
    candidateMap.set(key, {
        ...existing,
        ...candidate,
        aliases: Array.from(aliases),
        avatarUrl: candidate.avatarUrl || existing.avatarUrl,
        role: candidate.role || existing.role
    });
}

async function buildCandidates(groupConfig, chatAPI) {
    const candidateMap = new Map();
    const memberTags = groupConfig?.memberTags || {};
    const members = Array.isArray(groupConfig?.members) ? groupConfig.members : [];
    const externalParticipants = Array.isArray(groupConfig?.externalParticipants)
        ? groupConfig.externalParticipants
        : [];

    for (const memberId of members) {
        let agentConfig = {};
        try {
            agentConfig = await chatAPI?.getAgentConfig?.(memberId) || {};
        } catch (error) {
            console.warn(`[MentionAutocomplete] Failed to load agent config for ${memberId}:`, error);
        }

        const name = labelForMember(memberId, agentConfig);
        const aliases = [
            memberId,
            normalizeText(agentConfig.name),
            ...splitAliases(memberTags[memberId])
        ].filter(Boolean);

        upsertCandidate(candidateMap, {
            id: memberId,
            identityKey: memberId === CODEX_MEMBER_ID ? CODEX_EXTERNAL_ACTOR_ID : memberId,
            name,
            role: normalizeText(agentConfig.role) || 'Agent',
            avatarUrl: avatarFromAgentConfig(agentConfig),
            aliases,
            source: 'member'
        });
    }

    for (const participant of externalParticipants) {
        const actorType = normalizeText(participant.actor_type).toLowerCase();
        if (HUMAN_ACTOR_TYPES.has(actorType)) continue;

        const actorId = normalizeText(participant.actor_id);
        const name = normalizeText(participant.actor_name_cn) || actorId;
        if (!name) continue;

        upsertCandidate(candidateMap, {
            id: actorId,
            identityKey: actorId === CODEX_EXTERNAL_ACTOR_ID ? CODEX_EXTERNAL_ACTOR_ID : actorId,
            name,
            role: normalizeText(participant.role_cn) || '外部参与者',
            avatarUrl: '',
            aliases: [actorId, name, normalizeText(participant.actor_type)].filter(Boolean),
            source: 'external'
        });
    }

    const priority = new Map([
        [XIAOAN_MEMBER_ID, 10],
        [CODEX_EXTERNAL_ACTOR_ID, 20],
        [CODEX_MEMBER_ID, 20]
    ]);

    return Array.from(candidateMap.values()).sort((a, b) => {
        const aRank = priority.get(a.identityKey) || priority.get(a.id) || 100;
        const bRank = priority.get(b.identityKey) || priority.get(b.id) || 100;
        return aRank - bRank || a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
}

function candidateMatches(candidate, query) {
    const normalizedQuery = query.toLowerCase();
    if (!normalizedQuery) return true;
    return [candidate.name, candidate.id, candidate.role, ...(candidate.aliases || [])]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(normalizedQuery));
}

function getCurrentGroupConfig(refs) {
    const currentSelectedItem = refs?.currentSelectedItem?.get?.();
    if (!currentSelectedItem || currentSelectedItem.type !== 'group') return null;
    return currentSelectedItem.config || currentSelectedItem;
}

function fragmentToPlainText(fragment) {
    let text = '';
    fragment.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.nodeValue.replaceAll(ZERO_WIDTH_SPACE, '');
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList.contains('mention-token')) {
                text += `@${node.dataset.mentionName || node.textContent.replace(/^@/, '')}`;
            } else if (node.tagName === 'BR') {
                text += '\n';
            } else {
                text += fragmentToPlainText(node);
                if (['DIV', 'P'].includes(node.tagName)) text += '\n';
            }
        }
    });
    return text;
}

function editorToPlainText(editor) {
    return fragmentToPlainText(editor);
}

function collectMentions(editor) {
    const mentions = [];
    let offset = 0;

    function walk(node) {
        node.childNodes.forEach((child) => {
            if (child.nodeType === Node.TEXT_NODE) {
                offset += visibleTextLength(child.nodeValue);
                return;
            }

            if (child.nodeType !== Node.ELEMENT_NODE) return;

            if (child.classList.contains('mention-token')) {
                const name = child.dataset.mentionName || child.textContent.replace(/^@/, '');
                const text = `@${name}`;
                mentions.push({
                    id: child.dataset.mentionId || '',
                    name,
                    identityKey: child.dataset.mentionIdentityKey || child.dataset.mentionId || '',
                    start: offset,
                    end: offset + text.length,
                    text
                });
                offset += text.length;
                return;
            }

            if (child.tagName === 'BR') {
                offset += 1;
                return;
            }

            walk(child);
            if (['DIV', 'P'].includes(child.tagName)) offset += 1;
        });
    }

    walk(editor);
    return mentions;
}

function getCaretTextOffset(editor) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.endContainer)) return editorToPlainText(editor).length;

    const preCaretRange = document.createRange();
    preCaretRange.selectNodeContents(editor);
    preCaretRange.setEnd(range.endContainer, range.endOffset);
    return fragmentToPlainText(preCaretRange.cloneContents()).length;
}

function findDomPositionForTextOffset(root, targetOffset) {
    let offset = 0;

    function walk(node) {
        for (let index = 0; index < node.childNodes.length; index += 1) {
            const child = node.childNodes[index];

            if (child.nodeType === Node.TEXT_NODE) {
                const length = visibleTextLength(child.nodeValue);
                if (targetOffset <= offset + length) {
                    return {
                        node: child,
                        offset: visibleOffsetToRawOffset(child.nodeValue, targetOffset - offset)
                    };
                }
                offset += length;
                continue;
            }

            if (child.nodeType !== Node.ELEMENT_NODE) continue;

            if (child.classList.contains('mention-token')) {
                const name = child.dataset.mentionName || child.textContent.replace(/^@/, '');
                const length = `@${name}`.length;
                if (targetOffset <= offset) return { node, offset: index };
                if (targetOffset <= offset + length) return { node, offset: index + 1 };
                offset += length;
                continue;
            }

            if (child.tagName === 'BR') {
                if (targetOffset <= offset + 1) return { node, offset: index + 1 };
                offset += 1;
                continue;
            }

            const nested = walk(child);
            if (nested) return nested;
            if (['DIV', 'P'].includes(child.tagName)) {
                if (targetOffset <= offset + 1) return { node, offset: index + 1 };
                offset += 1;
            }
        }
        return null;
    }

    return walk(root) || { node: root, offset: root.childNodes.length };
}

function setEditorSelection(editor, textOffset) {
    const position = findDomPositionForTextOffset(editor, textOffset);
    const range = document.createRange();
    range.setStart(position.node, position.offset);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

function findMentionTrigger(text, caretOffset, mentions) {
    const mentionRange = mentions.find(mention => caretOffset >= mention.start && caretOffset <= mention.end);
    if (mentionRange) return null;

    const beforeCaret = text.slice(0, caretOffset);
    const atIndex = beforeCaret.lastIndexOf('@');
    if (atIndex < 0) return null;

    const existingTokenAtIndex = mentions.find(mention => atIndex >= mention.start && atIndex < mention.end);
    if (existingTokenAtIndex) return null;

    const query = beforeCaret.slice(atIndex + 1);
    if (/[\r\n\t\s]/.test(query)) return null;

    const previousChar = atIndex > 0 ? beforeCaret[atIndex - 1] : '';
    if (previousChar && /[A-Za-z0-9._-]/.test(previousChar)) return null;

    return { atIndex, query, caretOffset };
}

function createMentionToken(candidate) {
    const token = document.createElement('span');
    token.className = 'mention-token';
    token.contentEditable = 'false';
    token.dataset.mentionId = candidate.id || '';
    token.dataset.mentionName = candidate.name || '';
    token.dataset.mentionIdentityKey = candidate.identityKey || candidate.id || '';
    token.textContent = `@${candidate.name}`;
    return token;
}

export function setupMentionAutocomplete({ messageInput, refs, chatAPI, uiHelperFunctions }) {
    if (!messageInput || messageInput.dataset.mentionAutocompleteBound === 'true') return;

    const inputCard = messageInput.closest('.chat-input-card') || messageInput.parentElement || document.body;
    const editor = document.createElement('div');
    editor.className = 'mention-rich-input';
    editor.contentEditable = messageInput.disabled ? 'false' : 'true';
    editor.dataset.placeholder = messageInput.getAttribute('placeholder') || '输入消息...';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    inputCard.insertBefore(editor, messageInput);

    messageInput.classList.add('mention-source-input');
    messageInput.setAttribute('aria-hidden', 'true');
    messageInput.tabIndex = -1;

    const popup = document.createElement('div');
    popup.id = 'mention-suggestion-popup';
    popup.className = 'mention-suggestion-popup';
    popup.hidden = true;
    popup.setAttribute('role', 'listbox');
    inputCard.appendChild(popup);

    const nativeValueDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    const nativeDisabledDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'disabled');
    let syncingFromEditor = false;

    const state = {
        isOpen: false,
        trigger: null,
        candidates: [],
        filtered: [],
        activeIndex: 0,
        cacheKey: '',
        cacheCandidates: [],
        composing: false
    };

    function syncTextareaFromEditor() {
        syncingFromEditor = true;
        nativeValueDescriptor.set.call(messageInput, editorToPlainText(editor));
        messageInput.__mentionMetadata = collectMentions(editor);
        syncingFromEditor = false;
        messageInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function renderPlainText(value) {
        editor.textContent = value || '';
        messageInput.__mentionMetadata = [];
    }

    Object.defineProperty(messageInput, 'value', {
        configurable: true,
        get() {
            return nativeValueDescriptor.get.call(messageInput);
        },
        set(value) {
            nativeValueDescriptor.set.call(messageInput, String(value || ''));
            if (!syncingFromEditor) renderPlainText(String(value || ''));
        }
    });

    Object.defineProperty(messageInput, 'disabled', {
        configurable: true,
        get() {
            return nativeDisabledDescriptor.get.call(messageInput);
        },
        set(value) {
            const disabled = Boolean(value);
            nativeDisabledDescriptor.set.call(messageInput, disabled);
            editor.contentEditable = disabled ? 'false' : 'true';
            editor.classList.toggle('disabled', disabled);
        }
    });

    renderPlainText(nativeValueDescriptor.get.call(messageInput));
    messageInput.disabled = nativeDisabledDescriptor.get.call(messageInput);

    function closePopup() {
        state.isOpen = false;
        state.trigger = null;
        state.filtered = [];
        state.activeIndex = 0;
        popup.hidden = true;
        popup.innerHTML = '';
    }

    function renderPopup() {
        popup.innerHTML = '';
        if (!state.filtered.length) {
            closePopup();
            return;
        }

        state.filtered.forEach((candidate, index) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = `mention-suggestion-item${index === state.activeIndex ? ' active' : ''}`;
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', index === state.activeIndex ? 'true' : 'false');

            const avatar = document.createElement('span');
            avatar.className = 'mention-suggestion-avatar';
            if (candidate.avatarUrl) {
                const img = document.createElement('img');
                img.src = candidate.avatarUrl;
                img.alt = '';
                avatar.appendChild(img);
            } else {
                avatar.textContent = candidate.name.slice(0, 1);
            }

            const textWrap = document.createElement('span');
            textWrap.className = 'mention-suggestion-text';

            const name = document.createElement('span');
            name.className = 'mention-suggestion-name';
            name.textContent = candidate.name;

            const role = document.createElement('span');
            role.className = 'mention-suggestion-role';
            role.textContent = candidate.role || candidate.id;

            textWrap.appendChild(name);
            textWrap.appendChild(role);
            item.appendChild(avatar);
            item.appendChild(textWrap);

            item.addEventListener('mousedown', (event) => {
                event.preventDefault();
                insertCandidate(candidate);
            });

            popup.appendChild(item);
        });

        popup.hidden = false;
        state.isOpen = true;
    }

    function applyFilter(query) {
        state.filtered = state.candidates.filter(candidate => candidateMatches(candidate, query));
        state.activeIndex = 0;
        renderPopup();
    }

    async function refreshCandidates(groupConfig) {
        const groupId = normalizeText(groupConfig?.id);
        const memberKey = JSON.stringify({
            groupId,
            members: groupConfig?.members || [],
            externalParticipants: groupConfig?.externalParticipants || [],
            memberTags: groupConfig?.memberTags || {}
        });

        if (memberKey === state.cacheKey) {
            state.candidates = state.cacheCandidates;
            return;
        }

        state.cacheKey = memberKey;
        state.cacheCandidates = await buildCandidates(groupConfig, chatAPI);
        state.candidates = state.cacheCandidates;
    }

    async function updatePopup() {
        if (state.composing) return;

        const groupConfig = getCurrentGroupConfig(refs);
        if (!groupConfig || document.activeElement !== editor) {
            closePopup();
            return;
        }

        const text = editorToPlainText(editor);
        const mentions = collectMentions(editor);
        const caretOffset = getCaretTextOffset(editor);
        const trigger = findMentionTrigger(text, caretOffset, mentions);
        if (!trigger) {
            closePopup();
            return;
        }

        state.trigger = trigger;

        try {
            await refreshCandidates(groupConfig);
            applyFilter(trigger.query);
        } catch (error) {
            console.error('[MentionAutocomplete] Failed to refresh mention candidates:', error);
            uiHelperFunctions?.showToastNotification?.(`@候选加载失败: ${error.message}`, 'error');
            closePopup();
        }
    }

    function insertCandidate(candidate) {
        if (!state.trigger) return;

        editor.focus();
        const startPosition = findDomPositionForTextOffset(editor, state.trigger.atIndex);
        const endPosition = findDomPositionForTextOffset(editor, state.trigger.caretOffset);
        const range = document.createRange();
        range.setStart(startPosition.node, startPosition.offset);
        range.setEnd(endPosition.node, endPosition.offset);
        range.deleteContents();

        const token = createMentionToken(candidate);
        const spacer = document.createTextNode(ZERO_WIDTH_SPACE);
        range.insertNode(spacer);
        range.insertNode(token);

        const nextRange = document.createRange();
        nextRange.setStart(spacer, spacer.nodeValue.length);
        nextRange.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(nextRange);

        syncTextareaFromEditor();
        closePopup();
    }

    editor.addEventListener('compositionstart', () => {
        state.composing = true;
    });

    editor.addEventListener('compositionend', () => {
        state.composing = false;
        syncTextareaFromEditor();
        updatePopup();
    });

    editor.addEventListener('input', () => {
        syncTextareaFromEditor();
        updatePopup();
    });

    editor.addEventListener('paste', (event) => {
        event.preventDefault();
        const text = event.clipboardData?.getData('text/plain') || '';
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        setEditorSelection(editor, getCaretTextOffset(editor) + text.length);
        syncTextareaFromEditor();
        updatePopup();
    });

    editor.addEventListener('click', updatePopup);
    editor.addEventListener('keyup', (event) => {
        if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
        updatePopup();
    });

    editor.addEventListener('keydown', (event) => {
        if (state.isOpen && state.filtered.length) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                state.activeIndex = (state.activeIndex + 1) % state.filtered.length;
                renderPopup();
                return;
            }

            if (event.key === 'ArrowUp') {
                event.preventDefault();
                state.activeIndex = (state.activeIndex - 1 + state.filtered.length) % state.filtered.length;
                renderPopup();
                return;
            }

            if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                event.stopPropagation();
                insertCandidate(state.filtered[state.activeIndex]);
                return;
            }

            if (event.key === 'Escape') {
                event.preventDefault();
                closePopup();
                return;
            }
        }

        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            syncTextareaFromEditor();
            messageInput.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true
            }));
            return;
        }

        if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            document.execCommand('insertLineBreak');
            syncTextareaFromEditor();
            updatePopup();
        }
    });

    editor.addEventListener('blur', () => {
        setTimeout(closePopup, 120);
    });

    document.addEventListener('selectionchange', () => {
        if (document.activeElement === editor) updatePopup();
    });

    messageInput.dataset.mentionAutocompleteBound = 'true';
}
