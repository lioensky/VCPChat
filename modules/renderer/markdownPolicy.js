// Keep Markdown source byte-for-byte intact: a single tilde is ordinary text.
const installed = new WeakMap();

export function applyMarkdownPolicy(parser) {
    if (!parser?.use || installed.has(parser)) return parser;
    parser.use({
        tokenizer: {
            del(src) {
                if (!src.startsWith('~~')) return undefined;
                // Delegate double-tilde parsing (including escapes/nesting) to Marked.
                return false;
            },
        },
    });
    installed.set(parser, {
        tokenizer: parser.defaults.tokenizer,
        method: parser.defaults.tokenizer.del,
    });
    return parser;
}

export function hasOnlyMarkdownPolicyTokenizer(parser) {
    const policy = installed.get(parser);
    return Boolean(policy && parser.defaults.tokenizer === policy.tokenizer
        && policy.tokenizer.del === policy.method
        && Object.keys(policy.tokenizer).every(key =>
            ['options', 'rules', 'lexer', 'del'].includes(key)));
}

export function markdownWorkerOptions(parser) {
    const options = { ...parser.defaults };
    if (hasOnlyMarkdownPolicyTokenizer(parser)) options.tokenizer = null;
    return options;
}