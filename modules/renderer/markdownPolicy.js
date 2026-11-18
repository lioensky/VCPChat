// Keep Markdown source byte-for-byte intact: a single tilde is ordinary text.
// A bare link in Chinese text ends where the sentence punctuation starts.
const installed = new WeakMap();
const POLICY_METHODS = ['del', 'url'];

// GFM bare links end only at whitespace or '<', so "见 www.example.com，后文。" would link the rest of the
// sentence. A bare link ends at full-width punctuation, curly quotes, the ellipsis or the em dash, and at a
// CJK character inside the host name. CJK characters in the path stay (zh.wikipedia.org/wiki/中文).
const LINK_STOP = /[—‘-‟…　-〿！-／：-＠［-｀｛-･]/;
const CJK = /[⺀-⿿぀-鿿가-힯豈-﫿]/;

export function bareLinkEnd(raw) {
    const text = String(raw);
    let end = text.search(LINK_STOP);
    if (end < 0) end = text.length;
    const scheme = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.exec(text);
    const hostStart = scheme ? scheme[0].length : 0;
    const slash = text.indexOf('/', hostStart);
    const hostEnd = Math.min(end, slash < 0 ? text.length : slash);
    const cjk = text.slice(hostStart, hostEnd).search(CJK);
    return cjk < 0 ? end : hostStart + cjk;
}

export function applyMarkdownPolicy(parser) {
    if (!parser?.use || installed.has(parser)) return parser;
    parser.use({
        tokenizer: {
            del(src) {
                if (!src.startsWith('~~')) return undefined;
                // Delegate double-tilde parsing (including escapes/nesting) to Marked.
                return false;
            },
            url(src) {
                // Marked's own bare-link rule decides whether a link starts here; only its end is moved.
                const markedUrl = Object.getPrototypeOf(this).url;
                const token = markedUrl.call(this, src);
                const end = token ? bareLinkEnd(token.raw) : -1;
                return end >= 0 && end < token.raw.length ? markedUrl.call(this, src.slice(0, end)) : token;
            },
        },
    });
    const tokenizer = parser.defaults.tokenizer;
    installed.set(parser, {
        tokenizer,
        methods: Object.fromEntries(POLICY_METHODS.map(name => [name, tokenizer[name]])),
    });
    return parser;
}

export function hasOnlyMarkdownPolicyTokenizer(parser) {
    const policy = installed.get(parser);
    return Boolean(policy && parser.defaults.tokenizer === policy.tokenizer
        && POLICY_METHODS.every(name => policy.tokenizer[name] === policy.methods[name])
        && Object.keys(policy.tokenizer).every(key =>
            ['options', 'rules', 'lexer', ...POLICY_METHODS].includes(key)));
}

export function markdownWorkerOptions(parser) {
    const options = { ...parser.defaults };
    if (hasOnlyMarkdownPolicyTokenizer(parser)) options.tokenizer = null;
    return options;
}
