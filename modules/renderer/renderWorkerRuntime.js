import '../../Flowlockmodules/flowlock-protocol.js';
import { Marked } from '../../node_modules/marked/lib/marked.esm.js';
import { createRenderTemplateCompiler } from './renderTemplateCompiler.js';
import { createContentProcessor } from './contentProcessor.js';
import { createEmoticonUrlFixer } from './emoticonUrlFixer.js';
import { splitToolBatchDomains } from './toolBatchDomains.js';
import { collectClosedToolResultRanges } from './toolResultRegions.js';
import { prepare, layout, clearCache } from './pretext.esm.js';

// This is the standard production parser, not a substitute for custom parsers.
export async function compileRenderJob(job) {
    const tools = [];
    const processor = createContentProcessor();
    const fixer = createEmoticonUrlFixer();
    await fixer.initialize({ getEmoticonLibrary: async () => job.emoticons || [] });
    const compiler = createRenderTemplateCompiler({
        mainRendererReferences: {
            markedInstance: new Marked(job.markdown),
            globalSettingsRef: { get: () => job.settings || {} },
            flowlockProtocol: job.flowlock ? globalThis.flowlockProtocol : null,
        },
        contentProcessor: processor,
        registerLazyTool(entry) {
            const id = `template-${tools.length}-${compiler.hashStringFNV1a(entry.raw)}`;
            tools.push({ id, ...entry });
            return id;
        },
        fixEmoticonUrlsInMarkdown(text) {
            return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
                (_match, alt, url) => `![${alt}](${fixer.fixEmoticonUrl(url)})`)
                .replace(/<img([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi,
                    (_match, before, url, after) => `<img${before}src="${fixer.fixEmoticonUrl(url)}"${after}>`);
        },
    });
    let ordinal = 0;
    const domains = splitToolBatchDomains(job.text);
    const parts = domains.map(domain => {
        const html = compiler.renderMarkdownToHtmlUncached(domain.source, {
            settings: job.settings, messageRole: job.role, depth: job.depth,
            batchDomain: true, resultOrdinal: ordinal,
        });
        ordinal += collectClosedToolResultRanges(domain.source).length;
        return html;
    });
    let estimatedHeight = null;
    if (job.measure && !/[<`~$\\]|!\[|\[\[|<<<|\|/.test(job.text)) {
        try {
            const { font, width, lineHeight } = job.measure;
            if (width > 0 && lineHeight > 0) {
                estimatedHeight = layout(prepare(job.text, font), width, lineHeight).height;
            }
        } catch { /* OffscreenCanvas/fonts are optional; never an exact DOM height. */ }
        finally { clearCache(); }
    }
    return { parts, tools, isolatedDomains: domains.length > 1, estimatedHeight };
}