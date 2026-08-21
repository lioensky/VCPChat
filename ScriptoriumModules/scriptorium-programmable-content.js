'use strict';

(() => {
    let reviewEnabled = true;

    const LOCAL_LIBRARIES = Object.freeze({
        anime: '../vendor/anime.min.js',
        three: '../vendor/three.min.js',
    });

    const CDN_PATTERNS = Object.freeze([
        {
            library: 'three',
            patterns: [
                /^(?:https?:)?\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js(?:\/|$)/i,
                /^(?:https?:)?\/\/cdn\.jsdelivr\.net\/npm\/three(?:@[^/]+)?(?:\/|$)/i,
                /^(?:https?:)?\/\/unpkg\.com\/three(?:@[^/]+)?(?:\/|$)/i,
                /^(?:https?:)?\/\/esm\.sh\/three(?:@[^/?#]+)?(?:[/?#]|$)/i,
                /^(?:https?:)?\/\/cdn\.skypack\.dev\/three(?:@[^/?#]+)?(?:[/?#]|$)/i,
            ],
        },
        {
            library: 'anime',
            patterns: [
                /^(?:https?:)?\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/animejs(?:\/|$)/i,
                /^(?:https?:)?\/\/cdn\.jsdelivr\.net\/npm\/animejs(?:@[^/]+)?(?:\/|$)/i,
                /^(?:https?:)?\/\/unpkg\.com\/animejs(?:@[^/]+)?(?:\/|$)/i,
                /^(?:https?:)?\/\/esm\.sh\/animejs(?:@[^/?#]+)?(?:[/?#]|$)/i,
                /^(?:https?:)?\/\/cdn\.skypack\.dev\/animejs(?:@[^/?#]+)?(?:[/?#]|$)/i,
            ],
        },
    ]);

    const JAVASCRIPT_URL_PATTERN =
        /(?:https?:)?\/\/[^\s'"`\\)]+|(?:\.\.?\/|\/)?vendor\/(?:anime|three)(?:\.min)?\.js(?:[?#][^\s'"`\\)]*)?/gi;

    const REFUSE_RULES = Object.freeze([
        {
            id: 'node-require',
            pattern: /\brequire\s*\(|\bmodule\.exports\b|\bexports\s*\./,
            message: '禁止调用 Node.js 模块系统。',
        },
        {
            id: 'node-process',
            pattern: /\bprocess(?:\.|\[)|\bglobal(?:\.|\[)/,
            message: '禁止访问 Node.js process/global 对象。',
        },
        {
            id: 'filesystem',
            pattern: /\b(?:node:)?fs(?:\/promises)?\b|\breadFileSync\b|\bwriteFileSync\b|\bcreateWriteStream\b/,
            message: '禁止直接访问文件系统；文档资源必须使用受控资源接口。',
        },
        {
            id: 'process-execution',
            pattern: /\bchild_process\b|\bexecFile(?:Sync)?\b|\bspawn(?:Sync)?\b|\bfork\s*\(/,
            message: '禁止创建进程或执行系统命令。',
        },
        {
            id: 'electron-ipc',
            pattern: /\belectron\b|\bipcRenderer\b|\bipcMain\b|\bwebContents\b/,
            message: '禁止访问 Electron 或 IPC 能力。',
        },
        {
            id: 'dynamic-eval',
            pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(|\bimport\s*\(/,
            message: '禁止二次动态求值或动态模块导入。',
        },
        {
            id: 'constructor-escape',
            pattern: /\.constructor\s*\.\s*constructor|\[['"]constructor['"]\]\s*\[['"]constructor['"]\]/,
            message: '禁止通过构造器链逃逸脚本作用域。',
        },
        {
            id: 'document-destruction',
            pattern: /\bdocument\s*\.\s*(?:write|writeln|open|close)\s*\(/,
            message: '禁止覆盖或重建 Scriptorium 宿主文档。',
        },
        {
            id: 'file-protocol',
            pattern: /(?:^|['"`(\s])file\s*:/i,
            message: '禁止直接访问 file: URL。',
        },
        {
            id: 'privileged-navigation',
            // 只拒绝对特权窗口引用的实际成员访问，以及明确的导航调用。
            // 裸单词 top/parent/opener 可能合法出现在局部变量、注释和文案中；
            // globalThis.THREE/anime/devicePixelRatio 也是本地依赖常见读取方式，
            // 均不应仅因接触全局命名空间而被误判为宿主导航。
            pattern: /\b(?:window|globalThis)\s*(?:\.\s*(?:top|parent|opener)\b|\[\s*['"](?:top|parent|opener)['"]\s*\])|\b(?:top|parent|opener)\s*(?:\.|\[)|\b(?:(?:window|globalThis)\s*\.\s*)?location\s*\.\s*(?:assign|replace)\s*\(/,
            message: '禁止访问特权窗口引用或控制宿主导航。',
        },
    ]);

    const WARN_RULES = Object.freeze([
        {
            id: 'network-fetch',
            pattern: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/,
            message: '脚本包含网络访问；运行时 CSP 会限制目标，但建议改用文档内置资源。',
        },
        {
            id: 'persistent-storage',
            pattern: /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bcaches\s*\./,
            message: '脚本使用持久化存储，可能在文档关闭后保留状态。',
        },
        {
            id: 'global-events',
            pattern: /\b(?:window|document)\s*\.\s*addEventListener\s*\(/,
            message: '脚本向全局对象注册事件；建议返回清理函数或使用 runtime.addCleanup()。',
        },
        {
            id: 'continuous-runtime',
            pattern: /\brequestAnimationFrame\s*\(|\bsetInterval\s*\(/,
            message: '脚本包含持续动画或定时任务，将由 Scriptorium 生命周期运行时跟踪。',
        },
        {
            id: 'webgl',
            pattern: /\bWebGLRenderingContext\b|\bWebGL2RenderingContext\b|\bTHREE\s*\./,
            message: '脚本使用 WebGL/Three.js，请确保在清理阶段释放 Renderer、Geometry 和 Material。',
        },
    ]);

    function dependencyForUrl(value) {
        const url = String(value || '').trim();
        if (!url) return { action: 'ignore', source: url, reason: 'empty-source' };

        for (const entry of CDN_PATTERNS) {
            if (entry.patterns.some((pattern) => pattern.test(url))) {
                return {
                    action: 'local',
                    library: entry.library,
                    source: url,
                    localUrl: LOCAL_LIBRARIES[entry.library],
                    level: 'info',
                    message: `${entry.library} CDN 已重定向到 Scriptorium 本地固定依赖。`,
                };
            }
        }

        if (/^(?:\.\.?\/|\/)?vendor\/(?:anime|three)(?:\.min)?\.js(?:[?#].*)?$/i.test(url)) {
            const library = /three/i.test(url) ? 'three' : 'anime';
            return {
                action: 'local',
                library,
                source: url,
                localUrl: LOCAL_LIBRARIES[library],
                level: 'info',
                message: `${library} 已映射到 Scriptorium 本地依赖。`,
            };
        }

        if (/^(?:https?:)?\/\//i.test(url)) {
            return {
                action: 'ignore',
                source: url,
                level: 'warn',
                code: 'EXTERNAL_SCRIPT_IGNORED',
                message: `外部脚本未在允许列表中，已忽略：${url}`,
            };
        }

        return {
            action: 'ignore',
            source: url,
            level: 'warn',
            code: 'UNKNOWN_SCRIPT_SOURCE',
            message: `未知脚本来源已忽略：${url}`,
        };
    }

    function normalizeJavaScriptDependencies(source, context = {}) {
        const code = String(source || '');
        const diagnostics = [];
        const dependencies = new Set();
        const normalizedSource = code.replace(JAVASCRIPT_URL_PATTERN, (url) => {
            const dependency = dependencyForUrl(url);
            if (dependency.action !== 'local' || !dependency.library) return url;
            dependencies.add(dependency.library);
            diagnostics.push({
                level: 'info',
                ruleId: 'javascript-cdn-localized',
                library: dependency.library,
                source: url,
                localUrl: dependency.localUrl,
                message: `${dependency.library} JavaScript 中的 CDN URL 已转换为 Scriptorium 本地链接。`,
                context,
            });
            return dependency.localUrl;
        });
        return {
            source: normalizedSource,
            dependencies: [...dependencies],
            diagnostics,
            changed: normalizedSource !== code,
        };
    }

    function dependenciesForJavaScript(source) {
        const code = String(source || '');
        const dependencies = new Set(
            normalizeJavaScriptDependencies(code).dependencies
        );
        if (/\bTHREE\s*\.|\bnew\s+THREE\b/.test(code)) dependencies.add('three');
        if (/\banime\s*\(|\banime\s*\./.test(code)) dependencies.add('anime');
        return [...dependencies];
    }

    function reviewJavaScript(source, context = {}) {
        const code = String(source || '');
        const findings = [];

        if (!reviewEnabled) {
            return {
                allowed: true,
                level: 'allow',
                context: {
                    ...context,
                    documentKind: context.documentKind || 'unknown',
                    surface: context.surface || 'unknown',
                    scriptId: context.scriptId || null,
                },
                dependencies: dependenciesForJavaScript(code),
                findings: [{
                    level: 'info',
                    ruleId: 'security-review-disabled',
                    message: '人类已在本机关闭可编程内容安全审查；脚本未执行 warn/refuse 规则扫描。',
                }],
                reviewDisabled: true,
            };
        }

        for (const rule of REFUSE_RULES) {
            if (rule.pattern.test(code)) {
                findings.push({
                    level: 'refuse',
                    ruleId: rule.id,
                    message: rule.message,
                });
            }
        }
        for (const rule of WARN_RULES) {
            if (rule.pattern.test(code)) {
                findings.push({
                    level: 'warn',
                    ruleId: rule.id,
                    message: rule.message,
                });
            }
        }

        const refused = findings.some((finding) => finding.level === 'refuse');
        return {
            allowed: !refused,
            level: refused
                ? 'refuse'
                : findings.some((finding) => finding.level === 'warn')
                    ? 'warn'
                    : 'allow',
            context: {
                ...context,
                documentKind: context.documentKind || 'unknown',
                surface: context.surface || 'unknown',
                scriptId: context.scriptId || null,
            },
            dependencies: dependenciesForJavaScript(code),
            findings,
        };
    }

    function reviewScriptsInHtml(html, context = {}) {
        const template = document.createElement('template');
        template.innerHTML = String(html || '');
        const scripts = [...template.content.querySelectorAll('script')];
        return scripts.map((script, index) => {
            const scriptId = script.id || script.dataset.vdocScript || `inline-${index + 1}`;
            if (script.src) {
                return {
                    scriptId,
                    kind: 'external',
                    dependency: dependencyForUrl(script.getAttribute('src')),
                };
            }
            return {
                scriptId,
                kind: 'inline',
                review: reviewJavaScript(script.textContent, {
                    ...context,
                    scriptId,
                }),
            };
        });
    }

    function normalizeHtmlDependencies(html, context = {}) {
        const template = document.createElement('template');
        template.innerHTML = String(html || '');
        const diagnostics = [];
        const dependencies = new Set();

        [...template.content.querySelectorAll('script')].forEach((script, index) => {
            const markedLibrary = String(script.dataset.vdocLibrary || '').toLowerCase();
            let source = script.getAttribute('src');

            // 兼容早期工程中的不可执行依赖占位节点。重新经过规范化时，
            // 将其升级为明确指向 Scriptorium vendor 的本地可执行脚本标签。
            if (!source && LOCAL_LIBRARIES[markedLibrary]) {
                source = script.dataset.vdocOriginalSrc || LOCAL_LIBRARIES[markedLibrary];
                script.setAttribute('src', LOCAL_LIBRARIES[markedLibrary]);
                if (script.type === 'application/x-vdoc-library') {
                    script.removeAttribute('type');
                }
                dependencies.add(markedLibrary);
                diagnostics.push({
                    level: 'info',
                    ruleId: 'local-library-marker-upgraded',
                    scriptId: script.id
                        || script.dataset.vdocScript
                        || `external-${index + 1}`,
                    library: markedLibrary,
                    source,
                    localUrl: LOCAL_LIBRARIES[markedLibrary],
                    message: `${markedLibrary} 旧依赖占位节点已升级为本地可执行脚本链接。`,
                    context,
                });
                return;
            }

            if (!source) {
                dependenciesForJavaScript(script.textContent)
                    .forEach((library) => dependencies.add(library));

                // VDOCX 是单一 HTML 中的多个交互岛。含局部脚本的最近组件
                // 必须作为分页原子块，避免 Canvas、控制按钮和脚本被拆到不同页。
                const island = script.closest(
                    '[data-vdoc-interactive], [data-vdoc-component], section, article, figure, div'
                );
                if (island) {
                    island.dataset.vdocInteractive = island.dataset.vdocInteractive || 'true';
                    island.dataset.vdocPagination = 'atomic';
                }
                return;
            }

            const scriptId = script.id
                || script.dataset.vdocScript
                || `external-${index + 1}`;
            const dependency = dependencyForUrl(source);

            if (dependency.action === 'local' && dependency.library) {
                dependencies.add(dependency.library);
                script.setAttribute('src', dependency.localUrl);
                script.removeAttribute('integrity');
                script.removeAttribute('crossorigin');
                script.removeAttribute('referrerpolicy');
                script.dataset.vdocLibrary = dependency.library;
                script.dataset.vdocOriginalSrc = script.dataset.vdocOriginalSrc || source;
                if (script.type === 'application/x-vdoc-library') {
                    script.removeAttribute('type');
                }
                diagnostics.push({
                    level: 'info',
                    ruleId: 'cdn-localized',
                    scriptId,
                    library: dependency.library,
                    source,
                    localUrl: dependency.localUrl,
                    message: `${dependency.library} CDN 依赖已在源码进入审批前发布为 Scriptorium 本地脚本链接。`,
                    context,
                });
                return;
            }

            // 未允许的外部依赖保留审计信息，但改成浏览器不会执行的声明节点。
            script.removeAttribute('src');
            script.removeAttribute('integrity');
            script.removeAttribute('crossorigin');
            script.removeAttribute('referrerpolicy');
            script.type = 'application/x-vdoc-ignored-external';
            script.dataset.vdocIgnoredSrc = source;
            script.textContent = '';
            diagnostics.push({
                level: 'warn',
                ruleId: dependency.code || 'external-script-ignored',
                scriptId,
                source,
                message: dependency.message || `外部脚本已忽略：${source}`,
                context,
            });
        });

        return {
            html: template.innerHTML,
            dependencies: [...dependencies],
            diagnostics,
            changed: template.innerHTML !== String(html || ''),
        };
    }

    window.ScriptoriumProgrammableContent = Object.freeze({
        LOCAL_LIBRARIES,
        dependencyForUrl,
        normalizeJavaScriptDependencies,
        dependenciesForJavaScript,
        reviewJavaScript,
        reviewScriptsInHtml,
        normalizeHtmlDependencies,
        isReviewEnabled: () => reviewEnabled,
        setReviewEnabled(value) {
            reviewEnabled = value !== false;
            return reviewEnabled;
        },
    });
})();