// 给 JSDOM 窗口装上主输入框的命令（composer.insert-text），侧栏里的「填入主输入框」走的就是它
import '../../modules/ui-system/contribution-registry.js';
import { registerComposerCommands } from '../../modules/renderer/composerCommands.js';

export function installMainComposer(win, { selectedItem = () => null, topicId = () => null, uiHelper = null } = {}) {
    const commands = new globalThis.VCPContributions.CommandRegistry();
    win.VCPContributions = { commands };
    const registration = registerComposerCommands({
        win,
        messageInput: win.document.getElementById('messageInput'),
        selectedItemRef: { get: selectedItem },
        topicIdRef: { get: topicId },
        uiHelper,
        commands
    });
    return { commands, dispose: () => registration.dispose() };
}
