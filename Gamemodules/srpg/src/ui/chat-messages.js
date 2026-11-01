import { ctx, isEnabledForChat } from '../st.js';

/** Identify the battle report independently of the configurable prompt header. */
export function battleMessageTitle(message) {
    if (!message?.is_user || message.is_system || typeof message.mes !== 'string') return null;
    const title = message.mes.match(/^〔战场：(.+)｜(第 \d+(?:–\d+)? 回合)〕$/m);
    if (!title || !/【需要描写的行动】|【背景信息（无需详细描写，一笔带过或略过即可）】|（本次战场变化无需描写，请继续推进剧情。）/.test(message.mes)) return null;
    return `${title[1]} · ${title[2]}`;
}

/** Only wrap the rendered DOM; the stored message and LLM prompt remain intact. */
export function foldBattleMessage(textElement, message) {
    const title = battleMessageTitle(message);
    if (!title || !textElement || textElement.querySelector('textarea, .tsrpg-chat-report')) return;
    if (!textElement.childNodes.length) return;
    const details = document.createElement('details');
    details.className = 'tsrpg-chat-report';
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    label.textContent = `♞ 战斗记录 · ${title}`;
    const hint = document.createElement('small');
    hint.className = 'tsrpg-chat-report-hint';
    hint.textContent = '点击展开 / 收起';
    summary.append(label, hint);
    const content = document.createElement('div');
    content.className = 'tsrpg-chat-report-content';
    content.append(...Array.from(textElement.childNodes));
    details.append(summary, content);
    textElement.append(details);
}

export function unfoldBattleMessage(textElement) {
    const details = textElement?.querySelector('.tsrpg-chat-report');
    const content = details?.querySelector('.tsrpg-chat-report-content');
    if (content) details.replaceWith(...Array.from(content.childNodes));
}

export function installBattleMessageFolding() {
    let observedChat = null, observer = null;
    const decorate = element => {
        if (!isEnabledForChat()) return;
        const rawId = element.getAttribute('mesid');
        if (rawId == null || rawId === '') return;
        const id = Number(rawId);
        if (!Number.isInteger(id) || id < 0) return;
        foldBattleMessage(element.querySelector('.mes_text'), ctx().chat?.[id]);
    };
    const refresh = () => {
        const chat = document.getElementById('chat');
        if (!chat) return;
        if (!isEnabledForChat()) {
            observer?.disconnect(); observer = null; observedChat = null;
            chat.querySelectorAll('.mes_text').forEach(unfoldBattleMessage);
            return;
        }
        if (chat !== observedChat) {
            observer?.disconnect();
            observedChat = chat;
            observer = new MutationObserver(records => {
                const messages = new Set();
                for (const record of records) {
                    const parent = record.target.parentElement?.closest('.mes');
                    const current = record.target.closest?.('.mes') || parent;
                    if (current) messages.add(current);
                    for (const node of record.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        if (node.matches('.mes')) messages.add(node);
                        node.querySelectorAll('.mes').forEach(el => messages.add(el));
                    }
                }
                messages.forEach(decorate);
            });
            observer.observe(chat, { childList: true, subtree: true });
        }
        chat.querySelectorAll('.mes').forEach(decorate);
    };
    const { eventSource, eventTypes } = ctx();
    for (const key of ['CHAT_CHANGED', 'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED']) {
        if (eventTypes[key]) eventSource.on(eventTypes[key], refresh);
    }
    refresh();
    return refresh;
}
