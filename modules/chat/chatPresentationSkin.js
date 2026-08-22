/** Controlled presentation skin: token-only, state-read-only, owned teardown. */
export function createPresentationSkin({ id, tokens = {}, render, update = null }) {
    if (!id || !/^[a-z0-9-]+$/.test(id)) throw new TypeError('skin id must be lowercase kebab-case');
    if (typeof render !== 'function') throw new TypeError('skin render function is required');
    if (update !== null && typeof update !== 'function') throw new TypeError('skin update must be a function');
    const frozenTokens = Object.freeze({ ...tokens });
    return Object.freeze({
        id,
        tokens: frozenTokens,
        mount(root, state) {
            if (!root) throw new TypeError('skin root is required');
            const snapshot = Object.freeze({ ...state });
            const renderedTeardown = render(root, snapshot, frozenTokens);
            const teardown = typeof renderedTeardown === 'function' ? renderedTeardown : () => {};
            if (update) teardown.update = (nextState) => update(root, Object.freeze({ ...nextState }), frozenTokens);
            return teardown;
        }
    });
}
