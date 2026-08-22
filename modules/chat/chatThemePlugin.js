const ALLOWED_TOKENS = new Set(['accent', 'surface', 'text', 'muted', 'bubble']);

/** Token-only theme extension. Arbitrary CSS text/selectors are rejected. */
export function createChatThemePlugin({ id, tokens = {} }) {
    if (!id || !/^[a-z0-9-]+$/.test(id)) throw new TypeError('theme id must be lowercase kebab-case');
    const invalid = Object.keys(tokens).filter(token => !ALLOWED_TOKENS.has(token));
    if (invalid.length) throw new Error(`Unsupported chat theme token: ${invalid.join(', ')}`);
    const frozen = Object.freeze({ ...tokens });
    return Object.freeze({ id, tokens: frozen, apply(root) {
        if (!root) throw new TypeError('theme root is required');
        for (const [name, value] of Object.entries(frozen)) root.style.setProperty(`--chat-${name}`, String(value));
        return () => Object.keys(frozen).forEach(name => root.style.removeProperty(`--chat-${name}`));
    } });
}
