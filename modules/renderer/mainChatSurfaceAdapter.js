import { createChatSurface } from '../chat/chatSurface.js';
import { createStreamConsumerRegistry } from '../chat/streamConsumerRegistry.js';
import { createVcpStreamBridge } from '../chat/vcpStreamBridge.js';
import { createMainChatStreamConsumer } from './mainChatStreamConsumer.js';

/** Main-window composition owner. Domain protocols remain outside this adapter. */
export function createMainChatSurfaceAdapter({
    root,
    renderer,
    repository,
    focusTarget,
    operations,
    presentationState,
    renderDependencies,
    streamCapabilities,
    disposeRenderer,
}) {
    if (!root || !renderer || !repository) throw new TypeError('MainChatSurfaceAdapter requires root, renderer and repository');
    const streamRoutes = createStreamConsumerRegistry();
    const surface = createChatSurface({
        root,
        renderer,
        repository,
        focusTarget,
        mode: 'interactive',
        operations,
        presentationState,
        disposeRenderer,
    });
    renderer.initializeMessageRenderer({ ...renderDependencies, chatDomRenderer: surface.renderer });
    const bridge = createVcpStreamBridge({
        createConsumer: initialEvent => createMainChatStreamConsumer(initialEvent, {
            ...streamCapabilities,
            resolveProjection: messageId => streamRoutes.claim(messageId),
        }),
    });
    let disposed = false;
    return Object.freeze({
        surface,
        domRenderer: surface.renderer,
        streamRoutes: Object.freeze({ register: (...args) => streamRoutes.register(...args) }),
        acceptStreamEvent(event) { return disposed ? false : bridge.accept(event); },
        async dispose() {
            if (disposed) return;
            disposed = true;
            streamRoutes.dispose();
            await bridge.dispose();
            await surface.dispose();
        },
    });
}
