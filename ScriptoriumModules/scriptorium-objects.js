'use strict';

(() => {
    const OBJECT_SELECTOR = '[data-vdoc-object-id]';
    const SHAPE_SELECTOR = '[data-vdoc-object="shape"]';
    const FLOW_LAYOUTS = new Set(['block', 'float-left', 'float-right']);
    const LAYER_ACTIONS = new Set(['front', 'forward', 'backward', 'back']);
    const SHAPES = Object.freeze({
        rectangle: {
            name: '矩形',
            defaults: { fill: '#4f8f80', stroke: '#245c50', strokeWidth: 2, radius: 4 },
        },
        rounded: {
            name: '圆角矩形',
            defaults: { fill: '#d9a441', stroke: '#7f5d1e', strokeWidth: 2, radius: 16 },
        },
        ellipse: {
            name: '椭圆',
            defaults: { fill: '#8b6fb1', stroke: '#514069', strokeWidth: 2, radius: 0 },
        },
        triangle: {
            name: '三角形',
            defaults: { fill: '#d66e57', stroke: '#79382d', strokeWidth: 2, radius: 0 },
        },
        star: {
            name: '星形',
            defaults: { fill: '#e0b63f', stroke: '#806417', strokeWidth: 2, radius: 0 },
        },
        arrow: {
            name: '箭头',
            defaults: { fill: '#4b82bd', stroke: '#285178', strokeWidth: 2, radius: 0 },
        },
        line: {
            name: '直线',
            defaults: { fill: 'none', stroke: '#315e55', strokeWidth: 4, radius: 0 },
        },
    });

    function createId(prefix = 'object') {
        const uuid = globalThis.crypto?.randomUUID?.();
        return `${prefix}-${uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
    }

    function finite(value, fallback = 0, minimum = -Infinity, maximum = Infinity) {
        const parsed = Number.parseFloat(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(minimum, Math.min(maximum, parsed));
    }

    function safeColor(value, fallback = '#000000', allowNone = false) {
        const normalized = String(value || '').trim();
        if (allowNone && normalized === 'none') return 'none';
        if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized.toLowerCase();
        return fallback;
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, (character) =>
            `&#${character.charCodeAt(0)};`
        );
    }

    function expandSvgViewBoxToContent(svg) {
        const serialized = new XMLSerializer().serializeToString(svg);
        const template = document.createElement('template');
        template.innerHTML = serialized;
        const measuredSvg = template.content.firstElementChild;
        if (!measuredSvg?.matches?.('svg')) return false;

        const measurementHost = document.createElement('div');
        measurementHost.style.cssText =
            'position:fixed;left:-100000px;top:-100000px;visibility:hidden;'
            + 'width:1px;height:1px;overflow:visible;pointer-events:none';
        measurementHost.appendChild(measuredSvg);
        document.body.appendChild(measurementHost);
        try {
            const bounds = measuredSvg.getBBox?.();
            if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height]
                .every(Number.isFinite)
                || bounds.width <= 0 || bounds.height <= 0) {
                return false;
            }

            const current = String(svg.getAttribute('viewBox') || '')
                .trim().split(/[\s,]+/).map(Number);
            if (current.length !== 4 || !current.every(Number.isFinite)
                || current[2] <= 0 || current[3] <= 0) {
                svg.setAttribute(
                    'viewBox',
                    `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`
                );
                return true;
            }

            const [x, y, width, height] = current;
            const right = Math.max(x + width, bounds.x + bounds.width);
            const bottom = Math.max(y + height, bounds.y + bounds.height);
            const left = Math.min(x, bounds.x);
            const top = Math.min(y, bounds.y);
            const epsilon = .01;
            if (left >= x - epsilon && top >= y - epsilon
                && right <= x + width + epsilon
                && bottom <= y + height + epsilon) {
                return false;
            }

            // 只扩展、不收缩原始视图框：保留作者主动设置的内部留白，
            // 同时把 width=150 等越界几何重新纳入对象选择框。
            svg.setAttribute(
                'viewBox',
                `${left} ${top} ${right - left} ${bottom - top}`
            );
            return true;
        } catch {
            return false;
        } finally {
            measurementHost.remove();
        }
    }

    function sanitizeSvgSource(source) {
        const text = String(source || '').trim();
        if (!text) return { valid: false, message: 'SVG 源码不能为空。', source: '' };
        const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
        if (parsed.querySelector('parsererror')) {
            return { valid: false, message: 'SVG XML 语法无效。', source: '' };
        }
        const svg = parsed.documentElement;
        if (!svg || svg.localName?.toLowerCase() !== 'svg') {
            return { valid: false, message: '源码必须以单一 <svg> 元素为根。', source: '' };
        }

        svg.querySelectorAll(
            'script,foreignObject,iframe,object,embed,applet,base,link,meta'
        ).forEach((node) => node.remove());
        [svg, ...svg.querySelectorAll('*')].forEach((node) => {
            [...node.attributes].forEach((attribute) => {
                const name = attribute.name.toLowerCase();
                const value = attribute.value.trim();
                if (name.startsWith('on')
                    || (/^(?:href|xlink:href|src)$/i.test(name)
                        && !value.startsWith('#')
                        && !value.startsWith('data:image/'))) {
                    node.removeAttribute(attribute.name);
                }
            });
        });
        // image/svg+xml 返回的是 XML 文档节点；不同 Chromium 版本不保证
        // XML SVGElement 暴露 HTMLElement.dataset 和 CSSStyleDeclaration。
        // 使用标准属性写入，序列化后再进入 HTML 文档时语义完全相同。
        svg.setAttribute('data-vdoc-shape-svg', 'true');
        svg.setAttribute('role', 'img');
        const enforcedStyle = [
            svg.getAttribute('style') || '',
            'display:block',
            'width:100%',
            'height:100%',
            'pointer-events:none',
        ].filter(Boolean).join(';');
        svg.setAttribute('style', enforcedStyle);
        if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', '0 0 100 100');
        expandSvgViewBoxToContent(svg);
        return {
            valid: true,
            message: 'SVG 源码有效。',
            source: new XMLSerializer().serializeToString(svg),
        };
    }

    function sanitizeCssSource(source) {
        return String(source || '')
            .replace(/@import\s+[^;]+;?/gi, '')
            .replace(/url\(\s*(['"]?)\s*(?:javascript|vbscript|file):[\s\S]*?\1\s*\)/gi, 'none')
            .replace(/expression\s*\([\s\S]*?\)/gi, '');
    }

    function scopeObjectCss(source, objectId) {
        const css = sanitizeCssSource(source).trim();
        if (!css) return { valid: true, message: '未附加对象 CSS。', css: '', source: '' };
        if (/@(?:charset|import|namespace|supports|media|container|layer|keyframes|page)\b/i.test(css)) {
            return {
                valid: false,
                message: '对象 CSS 暂不接受 @ 规则；请使用普通选择器规则。',
                css: '',
                source: css,
            };
        }

        const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
        const rules = [];
        let match;
        let consumed = '';
        while ((match = rulePattern.exec(stripped))) {
            consumed += match[0];
            const declarations = match[2].trim();
            if (!declarations) continue;
            const selectors = match[1].split(',').map((selector) => selector.trim())
                .filter(Boolean);
            if (!selectors.length) {
                return { valid: false, message: 'CSS 选择器不能为空。', css: '', source: css };
            }
            rules.push({ selectors, declarations });
        }
        const normalizedInput = stripped.replace(/\s+/g, '');
        const normalizedConsumed = consumed.replace(/\s+/g, '');
        if (!rules.length || normalizedInput !== normalizedConsumed) {
            return {
                valid: false,
                message: 'CSS 语法无效，或包含当前对象编辑器不支持的嵌套规则。',
                css: '',
                source: css,
            };
        }

        const scope = `[data-vdoc-object-id="${CSS.escape(String(objectId))}"]`;
        const scoped = rules.map(({ selectors, declarations }) => {
            const scopedSelectors = selectors.map((selector) => {
                if (selector.includes(':object')) {
                    return selector.replaceAll(':object', scope);
                }
                if (/^svg(?=$|[\s.#:[>+~])/.test(selector)) {
                    return `${scope} ${selector}`;
                }
                return `${scope} ${selector}`;
            });
            return `${scopedSelectors.join(', ')} { ${declarations} }`;
        }).join('\n');
        return {
            valid: true,
            message: `CSS 有效 · ${rules.length} 条对象作用域规则。`,
            css: scoped,
            source: css,
        };
    }

    function objectCssSource(node) {
        const style = node?.querySelector?.(':scope > style[data-vdoc-object-style]');
        if (!style) return '';
        try {
            return decodeURIComponent(style.dataset.vdocObjectCssSource || '');
        } catch {
            return '';
        }
    }

    function applyObjectCss(node, source) {
        if (!node?.dataset?.vdocObjectId) return false;
        const result = scopeObjectCss(source, node.dataset.vdocObjectId);
        if (!result.valid) return false;
        let style = node.querySelector(':scope > style[data-vdoc-object-style]');
        if (!result.css) {
            style?.remove();
            return true;
        }
        if (!style) {
            style = document.createElement('style');
            style.dataset.vdocObjectStyle = 'true';
            node.appendChild(style);
        }
        style.dataset.vdocObjectCssSource = encodeURIComponent(result.source);
        style.textContent = result.css;
        return true;
    }

    function objectTypeFor(node) {
        if (!node) return '';
        if (node.dataset.vdocObject) return node.dataset.vdocObject;
        if (node.matches?.('.vdoc-media-batch')) return 'media-group';
        if (node.matches?.('.vdoc-media')) return node.dataset.vdocMedia || 'media';
        return '';
    }

    function applyFlowLayout(node, layout = 'block') {
        const normalized = FLOW_LAYOUTS.has(layout) ? layout : 'block';
        node.dataset.vdocObjectLayout = normalized;
        node.style.position = 'relative';
        node.style.left = '';
        node.style.top = '';
        node.style.zIndex = '';
        node.style.transform = '';
        node.style.float = normalized === 'float-left'
            ? 'left'
            : normalized === 'float-right'
                ? 'right'
                : 'none';
        node.style.clear = normalized === 'block' ? 'both' : 'none';
        node.style.margin = normalized === 'float-left'
            ? '.35em 1.2em .8em 0'
            : normalized === 'float-right'
                ? '.35em 0 .8em 1.2em'
                : '1em auto';
        node.style.maxWidth = '100%';
        return normalized;
    }

    function applySlideLayout(node, options = {}) {
        node.dataset.vdocObjectLayout = 'free';
        node.style.position = 'absolute';
        node.style.left = `${finite(options.left ?? node.style.left, 80)}px`;
        node.style.top = `${finite(options.top ?? node.style.top, 80)}px`;
        node.style.width = `${finite(options.width ?? node.style.width, 260, 24)}px`;
        node.style.height = `${finite(options.height ?? node.style.height, 180, 24)}px`;
        node.style.margin = '0';
        node.style.maxWidth = 'none';
        node.style.zIndex = String(Math.round(finite(
            options.zIndex ?? node.style.zIndex,
            1,
            -10000,
            10000
        )));
        node.style.setProperty(
            '--vdoc-object-rotation',
            `${finite(options.rotation ?? node.dataset.vdocObjectRotation, 0, -360, 360)}deg`
        );
        node.dataset.vdocObjectRotation = String(
            finite(options.rotation ?? node.dataset.vdocObjectRotation, 0, -360, 360)
        );
        node.style.transform = 'rotate(var(--vdoc-object-rotation, 0deg))';
        node.style.transformOrigin = 'center';
        return 'free';
    }

    function normalizeObjectNode(node, deck = false) {
        if (!node?.dataset) return false;
        let changed = false;
        const type = objectTypeFor(node);
        if (!type) return false;
        if (!node.dataset.vdocObject) {
            node.dataset.vdocObject = type;
            changed = true;
        }
        if (!node.dataset.vdocObjectId) {
            node.dataset.vdocObjectId = createId(type === 'shape' ? 'shape' : 'media');
            changed = true;
        }
        if (!node.dataset.vdocObjectName) {
            const caption = node.querySelector?.('figcaption')?.textContent?.trim();
            node.dataset.vdocObjectName = caption || (
                type === 'shape'
                    ? SHAPES[node.dataset.vdocShapeKind]?.name || '图形'
                    : type === 'media-group'
                        ? '媒体组'
                        : '媒体'
            );
            changed = true;
        }
        if (deck && node.dataset.vdocObjectLayout !== 'free') {
            applySlideLayout(node);
            changed = true;
        } else if (!deck && !FLOW_LAYOUTS.has(node.dataset.vdocObjectLayout)) {
            applyFlowLayout(node, 'block');
            changed = true;
        }
        node.setAttribute('data-vdoc-pagination', 'atomic');
        return changed;
    }

    function normalizeSource(source, deck = false) {
        const template = document.createElement('template');
        template.innerHTML = String(source || '');
        let changed = false;
        const candidates = template.content.querySelectorAll(
            `${OBJECT_SELECTOR}, .vdoc-media, .vdoc-media-batch`
        );
        candidates.forEach((node) => {
            // 批量媒体组是一个可排版对象；其内部 figure 保留媒体语义，
            // 但不能再次成为可拖拽对象，否则点击子项会脱离组布局。
            if (node.parentElement?.closest(OBJECT_SELECTOR)) return;
            changed = normalizeObjectNode(node, deck) || changed;
        });
        return {
            source: changed ? template.innerHTML : String(source || ''),
            changed,
        };
    }

    function shapeGeometry(kind, svg) {
        svg.replaceChildren();
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        let geometry;
        if (kind === 'rectangle' || kind === 'rounded') {
            geometry = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            geometry.setAttribute('x', '2');
            geometry.setAttribute('y', '2');
            geometry.setAttribute('width', '96');
            geometry.setAttribute('height', '96');
        } else if (kind === 'ellipse') {
            geometry = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
            geometry.setAttribute('cx', '50');
            geometry.setAttribute('cy', '50');
            geometry.setAttribute('rx', '48');
            geometry.setAttribute('ry', '48');
        } else if (kind === 'triangle') {
            geometry = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            geometry.setAttribute('points', '50,3 97,97 3,97');
        } else if (kind === 'star') {
            geometry = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            geometry.setAttribute(
                'points',
                '50,3 61,36 96,36 68,57 79,92 50,71 21,92 32,57 4,36 39,36'
            );
        } else if (kind === 'arrow') {
            geometry = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            geometry.setAttribute('points', '3,38 62,38 62,17 97,50 62,83 62,62 3,62');
        } else {
            geometry = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            geometry.setAttribute('x1', '4');
            geometry.setAttribute('y1', '50');
            geometry.setAttribute('x2', '96');
            geometry.setAttribute('y2', '50');
            geometry.setAttribute('vector-effect', 'non-scaling-stroke');
        }
        geometry.dataset.vdocShapeGeometry = 'true';
        svg.appendChild(geometry);
        return geometry;
    }

    function applyShapeProperties(node, properties = {}) {
        if (!node?.matches?.(SHAPE_SELECTOR)) return false;
        const kind = SHAPES[node.dataset.vdocShapeKind]
            ? node.dataset.vdocShapeKind
            : 'rectangle';
        const defaults = SHAPES[kind].defaults;
        const fill = safeColor(
            properties.fill ?? node.dataset.vdocShapeFill,
            defaults.fill === 'none' ? '#ffffff' : defaults.fill,
            true
        );
        const stroke = safeColor(
            properties.stroke ?? node.dataset.vdocShapeStroke,
            defaults.stroke,
            true
        );
        const strokeWidth = finite(
            properties.strokeWidth ?? node.dataset.vdocShapeStrokeWidth,
            defaults.strokeWidth,
            0,
            24
        );
        const radius = finite(
            properties.radius ?? node.dataset.vdocShapeRadius,
            defaults.radius,
            0,
            50
        );
        const opacity = finite(
            properties.opacity ?? node.dataset.vdocObjectOpacity,
            100,
            0,
            100
        );
        const dash = ['solid', 'dash', 'dot'].includes(
            properties.dash ?? node.dataset.vdocShapeDash
        )
            ? properties.dash ?? node.dataset.vdocShapeDash
            : 'solid';
        const svg = node.querySelector(':scope > svg');
        if (!svg) return false;
        let geometry = svg.querySelector('[data-vdoc-shape-geometry]');
        if (!geometry && node.dataset.vdocShapeSource !== 'asset'
            && node.dataset.vdocShapeSource !== 'custom') {
            geometry = shapeGeometry(kind, svg);
        }
        if (geometry) {
            geometry.setAttribute('fill', kind === 'line' ? 'none' : fill);
            geometry.setAttribute('stroke', stroke);
            geometry.setAttribute('stroke-width', String(strokeWidth));
            geometry.setAttribute('stroke-linejoin', 'round');
            geometry.setAttribute('stroke-linecap', 'round');
            if (geometry.tagName === 'rect') {
                geometry.setAttribute('rx', String(radius));
                geometry.setAttribute('ry', String(radius));
            }
            if (dash === 'dash') {
                geometry.setAttribute('stroke-dasharray', '9 6');
            } else if (dash === 'dot') {
                geometry.setAttribute('stroke-dasharray', '2 6');
            } else {
                geometry.removeAttribute('stroke-dasharray');
            }
        }
        node.dataset.vdocShapeFill = fill;
        node.dataset.vdocShapeStroke = stroke;
        node.dataset.vdocShapeStrokeWidth = String(strokeWidth);
        node.dataset.vdocShapeRadius = String(radius);
        node.dataset.vdocShapeDash = dash;
        node.dataset.vdocObjectOpacity = String(opacity);
        node.style.opacity = String(opacity / 100);
        return true;
    }

    function createShape(kind = 'rectangle', options = {}) {
        const normalizedKind = SHAPES[kind] ? kind : 'rectangle';
        const node = document.createElement('figure');
        node.className = 'vdoc-object vdoc-shape';
        node.dataset.vdocObject = 'shape';
        node.dataset.vdocObjectId = createId('shape');
        node.dataset.vdocShapeKind = normalizedKind;
        node.dataset.vdocObjectName = SHAPES[normalizedKind].name;
        node.dataset.vdocPagination = 'atomic';
        node.setAttribute('description', `${SHAPES[normalizedKind].name}图形`);
        node.setAttribute('aria-label', `${SHAPES[normalizedKind].name}图形`);
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.dataset.vdocShapeSvg = 'true';
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', SHAPES[normalizedKind].name);
        svg.style.display = 'block';
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.overflow = 'visible';
        svg.style.pointerEvents = 'none';
        shapeGeometry(normalizedKind, svg);
        node.appendChild(svg);
        node.style.width = `${finite(options.width, 260, 24)}px`;
        node.style.height = `${finite(options.height, 180, 24)}px`;
        if (options.deck) applySlideLayout(node, options);
        else applyFlowLayout(node, options.layout || 'block');
        applyShapeProperties(node, options);
        return node;
    }

    function createShapeFromSvg(asset, source, options = {}) {
        const result = sanitizeSvgSource(source || asset?.source);
        if (!result.valid) throw new Error(result.message);
        const template = document.createElement('template');
        template.innerHTML = result.source;
        const svg = template.content.firstElementChild;
        if (!svg?.matches?.('svg')) {
            throw new Error('SVG 资产没有有效根元素。');
        }
        const node = document.createElement('figure');
        node.className = 'vdoc-object vdoc-shape';
        node.dataset.vdocObject = 'shape';
        node.dataset.vdocObjectId = createId('shape');
        node.dataset.vdocShapeKind = 'asset';
        node.dataset.vdocShapeSource = 'asset';
        node.dataset.vdocSvgAssetId = String(asset?.id || '');
        node.dataset.vdocSvgAssetVersion = String(asset?.version || 1);
        node.dataset.vdocSvgAssetKind = String(asset?.kind || 'static');
        node.dataset.vdocObjectName = String(asset?.name || 'SVG 图形');
        node.dataset.vdocPagination = 'atomic';
        const description = String(
            options.description ?? asset?.description ?? asset?.name ?? 'SVG 图形'
        );
        node.setAttribute('description', description);
        node.dataset.vdocDescription = description;
        node.setAttribute('aria-label', description);
        svg.setAttribute('aria-label', description);
        node.appendChild(svg);
        node.style.width = `${finite(
            options.width,
            asset?.defaultSize?.width || 260,
            24,
            4096
        )}px`;
        node.style.height = `${finite(
            options.height,
            asset?.defaultSize?.height || 180,
            24,
            4096
        )}px`;
        node.dataset.vdocObjectOpacity = String(
            finite(options.opacity, 100, 0, 100)
        );
        node.style.opacity = String(
            finite(options.opacity, 100, 0, 100) / 100
        );
        if (options.deck) applySlideLayout(node, options);
        else applyFlowLayout(node, options.layout || 'block');
        return node;
    }

    function findObject(fragment, objectId) {
        if (!objectId) return null;
        return fragment.querySelector(
            `[data-vdoc-object-id="${CSS.escape(String(objectId))}"]`
        );
    }

    function findAnchor(fragment, anchorId) {
        if (!anchorId) return null;
        return fragment.querySelector(
            `[data-vdoc-text="${CSS.escape(String(anchorId))}"],`
            + `[data-vdoc-block="${CSS.escape(String(anchorId))}"]`
        );
    }

    function normalizeLayers(parent) {
        const objects = [...parent.children].filter((child) =>
            child.matches?.(OBJECT_SELECTOR)
        );
        objects.forEach((object, index) => {
            object.style.zIndex = String(index + 1);
        });
    }

    function applyLayerAction(node, action) {
        if (!node?.parentElement || !LAYER_ACTIONS.has(action)) return false;
        const parent = node.parentElement;
        const objects = [...parent.children].filter((child) =>
            child.matches?.(OBJECT_SELECTOR)
        );
        const index = objects.indexOf(node);
        if (index < 0) return false;
        if (action === 'front') parent.appendChild(node);
        else if (action === 'back') parent.insertBefore(node, objects[0]);
        else if (action === 'forward' && objects[index + 1]) {
            objects[index + 1].after(node);
        } else if (action === 'backward' && objects[index - 1]) {
            objects[index - 1].before(node);
        } else {
            return false;
        }
        normalizeLayers(parent);
        return true;
    }

    function applyObjectPatch(node, patch = {}, deck = false) {
        if (!node) return false;
        if (patch.name !== undefined) {
            node.dataset.vdocObjectName = String(patch.name || '未命名对象').slice(0, 120);
        }
        if (patch.description !== undefined) {
            const description = String(patch.description || '').slice(0, 1200);
            node.setAttribute('description', description);
            node.dataset.vdocDescription = description;
            node.setAttribute('aria-label', description || node.dataset.vdocObjectName);

            // 媒体语义必须在对象壳、媒体节点和可见图注之间保持一致。
            // SVG 图形没有 figcaption，因此只更新其 aria/description。
            if (node.dataset.vdocObject !== 'shape') {
                node.querySelectorAll('img,video,audio').forEach((media) => {
                    media.setAttribute('description', description);
                    media.dataset.vdocDescription = description;
                    media.setAttribute('aria-label', description || node.dataset.vdocObjectName);
                    if (media.tagName === 'IMG') media.alt = description;
                    media.title = description;
                });
                const caption = node.querySelector(':scope > figcaption');
                if (caption) caption.textContent = description;
            }
        }
        if (patch.width !== undefined) {
            node.style.width = `${finite(patch.width, 240, 24, 4096)}px`;
        }
        if (patch.height !== undefined) {
            node.style.height = `${finite(patch.height, 160, 24, 4096)}px`;
        }
        if (patch.rotation !== undefined && deck) {
            const rotation = finite(patch.rotation, 0, -360, 360);
            node.dataset.vdocObjectRotation = String(rotation);
            node.style.setProperty('--vdoc-object-rotation', `${rotation}deg`);
            node.style.transform = 'rotate(var(--vdoc-object-rotation, 0deg))';
        }
        if (patch.layout !== undefined && !deck) applyFlowLayout(node, patch.layout);
        if (node.matches(SHAPE_SELECTOR)) {
            applyShapeProperties(node, patch);
            if (patch.svgSource !== undefined) {
                const svgResult = sanitizeSvgSource(patch.svgSource);
                if (!svgResult.valid) return false;
                const template = document.createElement('template');
                template.innerHTML = svgResult.source;
                const svg = template.content.firstElementChild;
                const currentSvg = node.querySelector(':scope > svg');
                if (!svg || !currentSvg) return false;
                currentSvg.replaceWith(svg);
                node.dataset.vdocShapeSource = 'custom';
            }
        }
        if (patch.cssSource !== undefined && !applyObjectCss(node, patch.cssSource)) {
            return false;
        }
        return true;
    }

    function applyMutationToSource(source, mutation = {}, deck = false) {
        const template = document.createElement('template');
        template.innerHTML = String(source || '');
        const fragment = template.content;
        const node = findObject(fragment, mutation.objectId);
        if (!node) return { changed: false, source: String(source || '') };

        let changed = false;
        if (mutation.type === 'update') {
            changed = applyObjectPatch(node, mutation.patch || {}, deck);
        } else if (mutation.type === 'geometry') {
            Object.entries(mutation.styles || {}).forEach(([property, value]) => {
                if (!['left', 'top', 'width', 'height', 'zIndex'].includes(property)) return;
                node.style[property] = String(value);
                changed = true;
            });
        } else if (mutation.type === 'flow-move') {
            const anchor = findAnchor(fragment, mutation.anchorId);
            if (anchor && !node.contains(anchor)) {
                if (mutation.position === 'before') anchor.before(node);
                else anchor.after(node);
                applyFlowLayout(node, mutation.layout || node.dataset.vdocObjectLayout);
                changed = true;
            }
        } else if (mutation.type === 'layer') {
            changed = applyLayerAction(node, mutation.action);
        } else if (mutation.type === 'delete') {
            node.remove();
            changed = true;
        }
        return {
            changed,
            source: changed ? template.innerHTML : String(source || ''),
        };
    }

    function createObjectController(context = {}) {
        const ui = context.elements || {};
        const state = {
            selectedId: null,
            selectedNode: null,
            drag: null,
            rootAbort: null,
            uiAbort: null,
            draftOriginal: null,
        };

        function root() {
            return context.getRoot?.() || null;
        }

        function freeCanvas() {
            return context.layoutPort?.mode?.() === 'free-canvas';
        }

        function selected() {
            const currentRoot = root();
            if (state.selectedNode?.isConnected && currentRoot?.contains(state.selectedNode)) {
                return state.selectedNode;
            }
            state.selectedNode = state.selectedId
                ? currentRoot?.querySelector(
                    `[data-vdoc-object-id="${CSS.escape(state.selectedId)}"]`
                )
                : null;
            return state.selectedNode;
        }

        function removeResizeHandles() {
            root()?.querySelectorAll('[data-vdoc-object-resize-handle]').forEach((handle) =>
                handle.remove()
            );
        }

        function installResizeHandles(node) {
            removeResizeHandles();
            if (!node?.isConnected) return;
            ['nw', 'ne', 'sw', 'se'].forEach((direction) => {
                const handle = document.createElement('span');
                handle.dataset.vdocObjectResizeHandle = direction;
                handle.contentEditable = 'false';
                handle.setAttribute('aria-hidden', 'true');
                node.appendChild(handle);
            });
        }

        function clearSelection() {
            const hadSelection = Boolean(state.selectedId || state.selectedNode);
            removeResizeHandles();
            root()?.querySelectorAll('[data-vdoc-object-selected]').forEach((node) =>
                node.removeAttribute('data-vdoc-object-selected')
            );
            root()?.querySelectorAll('[data-vdoc-object-drop]').forEach((node) =>
                node.removeAttribute('data-vdoc-object-drop')
            );
            state.selectedId = null;
            state.selectedNode = null;
            hideMenu();
            if (hadSelection) context.onSelectionChange?.(null);
        }

        function select(node) {
            if (!node?.matches?.(OBJECT_SELECTOR)) return false;
            root()?.querySelectorAll('[data-vdoc-object-selected]').forEach((candidate) => {
                if (candidate !== node) candidate.removeAttribute('data-vdoc-object-selected');
            });
            node.dataset.vdocObjectSelected = 'true';
            state.selectedId = node.dataset.vdocObjectId;
            state.selectedNode = node;
            installResizeHandles(node);
            context.onSelectionChange?.({
                objectId: state.selectedId,
                type: node.dataset.vdocObject,
                name: node.dataset.vdocObjectName,
            });
            return true;
        }

        function hideMenu() {
            if (ui['object-context-menu']) ui['object-context-menu'].hidden = true;
        }

        function showMenu(x, y) {
            const menu = ui['object-context-menu'];
            const node = selected();
            if (!menu || !node) return;
            menu.querySelectorAll('[data-object-deck-only]').forEach((control) => {
                control.hidden = !freeCanvas();
            });
            menu.querySelectorAll('[data-object-flow-only]').forEach((control) => {
                control.hidden = freeCanvas();
            });
            menu.hidden = false;
            const width = 210;
            const height = 360;
            menu.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, x))}px`;
            menu.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, y))}px`;
        }

        function nearestDropTarget(clientX, clientY, object) {
            const blocks = [...root()?.querySelectorAll('[data-vdoc-text]') || []]
                .filter((block) => !object.contains(block));
            let nearest = null;
            blocks.forEach((block) => {
                const rect = block.getBoundingClientRect();
                const xDistance = clientX < rect.left
                    ? rect.left - clientX
                    : clientX > rect.right
                        ? clientX - rect.right
                        : 0;
                const yDistance = clientY < rect.top
                    ? rect.top - clientY
                    : clientY > rect.bottom
                        ? clientY - rect.bottom
                        : 0;
                const distance = Math.hypot(xDistance, yDistance);
                if (!nearest || distance < nearest.distance) {
                    nearest = {
                        block,
                        distance,
                        position: clientY < rect.top + rect.height / 2 ? 'before' : 'after',
                    };
                }
            });
            return nearest;
        }

        function beginDrag(event, object, resizeDirection = '') {
            const rect = object.getBoundingClientRect();
            state.drag = {
                pointerId: event.pointerId,
                object,
                mode: resizeDirection ? 'resize' : 'move',
                resizeDirection,
                startX: event.clientX,
                startY: event.clientY,
                originalLeft: finite(object.style.left, 0),
                originalTop: finite(object.style.top, 0),
                originalWidth: object.offsetWidth || finite(object.style.width, 240, 24),
                originalHeight: object.offsetHeight || finite(object.style.height, 160, 24),
                aspectRatio: (object.offsetWidth || 240) / Math.max(1, object.offsetHeight || 160),
                moved: false,
                drop: null,
                rect,
            };
            object.setPointerCapture?.(event.pointerId);
            object.dataset.vdocObjectDragging = 'true';
        }

        function moveDrag(event) {
            const drag = state.drag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            if (!drag.moved && Math.hypot(dx, dy) < 4) return;
            drag.moved = true;
            event.preventDefault();
            const scale = Math.max(.01, Number(context.getZoom?.() || 100) / 100);
            if (drag.mode === 'resize') {
                const sceneDx = dx / scale;
                const sceneDy = dy / scale;
                const west = drag.resizeDirection.includes('w');
                const north = drag.resizeDirection.includes('n');
                let width = Math.max(24, drag.originalWidth + (west ? -sceneDx : sceneDx));
                let height = Math.max(24, drag.originalHeight + (north ? -sceneDy : sceneDy));

                if (event.shiftKey && Number.isFinite(drag.aspectRatio)) {
                    if (Math.abs(sceneDx) >= Math.abs(sceneDy)) {
                        height = width / drag.aspectRatio;
                    } else {
                        width = height * drag.aspectRatio;
                    }
                    width = Math.max(24, width);
                    height = Math.max(24, height);
                }

                drag.object.style.width = `${Math.round(width * 10) / 10}px`;
                drag.object.style.height = `${Math.round(height * 10) / 10}px`;
                if (freeCanvas()) {
                    if (west) {
                        drag.object.style.left =
                            `${Math.round((drag.originalLeft + drag.originalWidth - width) * 10) / 10}px`;
                    }
                    if (north) {
                        drag.object.style.top =
                            `${Math.round((drag.originalTop + drag.originalHeight - height) * 10) / 10}px`;
                    }
                }
            } else if (freeCanvas()) {
                drag.object.style.left = `${Math.round((drag.originalLeft + dx / scale) * 10) / 10}px`;
                drag.object.style.top = `${Math.round((drag.originalTop + dy / scale) * 10) / 10}px`;
            } else {
                root()?.querySelectorAll('[data-vdoc-object-drop]').forEach((node) =>
                    node.removeAttribute('data-vdoc-object-drop')
                );
                drag.drop = nearestDropTarget(event.clientX, event.clientY, drag.object);
                if (drag.drop) drag.drop.block.dataset.vdocObjectDrop = drag.drop.position;
            }
        }

        function finishDrag(event, cancelled = false) {
            const drag = state.drag;
            if (!drag || (event?.pointerId !== undefined && drag.pointerId !== event.pointerId)) {
                return false;
            }
            state.drag = null;
            drag.object.removeAttribute('data-vdoc-object-dragging');
            try {
                if (drag.object.hasPointerCapture?.(drag.pointerId)) {
                    drag.object.releasePointerCapture(drag.pointerId);
                }
            } catch {}
            root()?.querySelectorAll('[data-vdoc-object-drop]').forEach((node) =>
                node.removeAttribute('data-vdoc-object-drop')
            );

            // commitMutation 会定向修改源码并同步重建整个编辑 ShadowRoot。
            // 不能在 pointerup/pointercancel 的当前分发栈中销毁捕获指针的对象，
            // 否则 Chromium 可能保留旧命中链，后续右键菜单虽出现但其“编辑”
            // 操作无法稳定解析新对象。下一帧提交让浏览器先完成指针清理。
            const commitAfterPointer = (mutation) => {
                window.requestAnimationFrame(() => context.commitMutation?.(mutation));
            };
            if (!drag.moved || cancelled) {
                if (cancelled) {
                    drag.object.style.left = freeCanvas() ? `${drag.originalLeft}px` : '';
                    drag.object.style.top = freeCanvas() ? `${drag.originalTop}px` : '';
                    if (drag.mode === 'resize') {
                        drag.object.style.width = `${drag.originalWidth}px`;
                        drag.object.style.height = `${drag.originalHeight}px`;
                    }
                }
                return false;
            }
            if (drag.mode === 'resize') {
                const styles = {
                    width: drag.object.style.width,
                    height: drag.object.style.height,
                };
                if (freeCanvas()) {
                    styles.left = drag.object.style.left;
                    styles.top = drag.object.style.top;
                }
                commitAfterPointer({
                    type: 'geometry',
                    objectId: drag.object.dataset.vdocObjectId,
                    styles,
                    impact: freeCanvas() ? 'geometry' : 'flow',
                });
                return true;
            }
            if (freeCanvas()) {
                commitAfterPointer({
                    type: 'geometry',
                    objectId: drag.object.dataset.vdocObjectId,
                    styles: {
                        left: drag.object.style.left,
                        top: drag.object.style.top,
                    },
                    impact: 'geometry',
                });
                return true;
            }
            if (drag.drop) {
                commitAfterPointer({
                    type: 'flow-move',
                    objectId: drag.object.dataset.vdocObjectId,
                    anchorId: drag.drop.block.dataset.vdocText
                        || drag.drop.block.dataset.vdocBlock,
                    position: drag.drop.position,
                    layout: drag.object.dataset.vdocObjectLayout || 'block',
                    impact: 'flow',
                });
                return true;
            }
            return false;
        }

        function fillInspector(node) {
            const geometry = node.querySelector?.('[data-vdoc-shape-geometry]');
            ui['object-inspector-title'].textContent =
                node.dataset.vdocObjectName || '编辑对象';
            ui['object-name-input'].value = node.dataset.vdocObjectName || '';
            ui['object-description-input'].value =
                node.getAttribute('description') || node.dataset.vdocDescription || '';
            ui['object-width-input'].value = String(Math.round(
                finite(node.style.width, node.getBoundingClientRect().width, 24)
            ));
            ui['object-height-input'].value = String(Math.round(
                finite(node.style.height, node.getBoundingClientRect().height, 24)
            ));
            ui['object-rotation-input'].value =
                node.dataset.vdocObjectRotation || '0';
            ui['object-layout-select'].value =
                node.dataset.vdocObjectLayout || (freeCanvas() ? 'free' : 'block');
            ui['object-fill-input'].value = safeColor(
                node.dataset.vdocShapeFill,
                '#4f8f80'
            );
            ui['object-stroke-input'].value = safeColor(
                node.dataset.vdocShapeStroke,
                '#245c50'
            );
            ui['object-stroke-width-input'].value =
                node.dataset.vdocShapeStrokeWidth || geometry?.getAttribute('stroke-width') || '2';
            ui['object-radius-input'].value =
                node.dataset.vdocShapeRadius || geometry?.getAttribute('rx') || '0';
            ui['object-opacity-input'].value =
                node.dataset.vdocObjectOpacity || '100';
            ui['object-dash-select'].value =
                node.dataset.vdocShapeDash || 'solid';
            ui['object-svg-source-input'].value =
                node.matches(SHAPE_SELECTOR)
                    ? node.querySelector(':scope > svg')?.outerHTML || ''
                    : '';
            ui['object-css-source-input'].value = objectCssSource(node);
            ui['object-shape-fields'].hidden = !node.matches(SHAPE_SELECTOR);
            ui['object-layout-field'].hidden = freeCanvas();
            ui['object-rotation-field'].hidden = !freeCanvas();
            refreshSourcePreview();
        }

        function inspectorPatch() {
            const node = selected();
            return {
                name: ui['object-name-input'].value,
                description: ui['object-description-input'].value,
                width: ui['object-width-input'].value,
                height: ui['object-height-input'].value,
                rotation: ui['object-rotation-input'].value,
                layout: ui['object-layout-select'].value,
                fill: ui['object-fill-input'].value,
                stroke: ui['object-stroke-input'].value,
                strokeWidth: ui['object-stroke-width-input'].value,
                radius: ui['object-radius-input'].value,
                opacity: ui['object-opacity-input'].value,
                dash: ui['object-dash-select'].value,
                svgSource: node?.matches(SHAPE_SELECTOR)
                    ? ui['object-svg-source-input'].value
                    : undefined,
                cssSource: ui['object-css-source-input'].value,
            };
        }

        function sourceValidation() {
            const node = selected();
            const svg = node?.matches(SHAPE_SELECTOR)
                ? sanitizeSvgSource(ui['object-svg-source-input'].value)
                : { valid: true, message: '当前对象不包含 SVG 源码。', source: '' };
            const css = scopeObjectCss(
                ui['object-css-source-input'].value,
                node?.dataset?.vdocObjectId || 'preview-object'
            );
            return {
                valid: svg.valid && css.valid,
                svg,
                css,
                message: !svg.valid ? svg.message : !css.valid ? css.message
                    : `${svg.message} ${css.message}`,
            };
        }

        function previewDocument(node, validation) {
            const svg = validation.svg.source;
            const css = validation.css.css;
            const objectId = node?.dataset?.vdocObjectId || 'preview-object';
            const width = finite(ui['object-width-input'].value, 260, 24, 4096);
            const height = finite(ui['object-height-input'].value, 180, 24, 4096);
            let content;
            if (node?.matches(SHAPE_SELECTOR)) {
                content = svg;
            } else if (node) {
                const clone = node.cloneNode(true);
                clone.querySelectorAll('[data-vdoc-object-resize-handle]').forEach((handle) =>
                    handle.remove()
                );
                content = clone.innerHTML;
            } else {
                content = '<div>对象预览不可用</div>';
            }
            const safeCss = String(css || '').replace(/<\/style/gi, '<\\/style');
            return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{width:100%;height:100%;margin:0;background:#fffdf8;color:#1d2421}
body{display:grid;place-items:center;padding:24px;overflow:auto}
.preview-object{position:relative;width:${width}px;height:${height}px;max-width:100%;max-height:100%}
.preview-object>svg{display:block;width:100%;height:100%;overflow:visible}
${safeCss}
</style></head><body><div class="preview-object" data-vdoc-object-id="${escapeHtml(objectId)}">${content}</div></body></html>`;
        }

        function refreshSourcePreview() {
            const node = selected();
            if (!node) return false;
            const validation = sourceValidation();
            ui['object-source-diagnostics'].textContent = validation.message;
            ui['object-source-diagnostics'].classList.toggle('valid', validation.valid);
            ui['object-source-diagnostics'].classList.toggle('invalid', !validation.valid);
            ui['object-inspector-apply-btn'].disabled = !validation.valid;
            if (validation.valid) {
                ui['object-preview-frame'].srcdoc = previewDocument(node, validation);
            }
            return validation.valid;
        }

        function openInspector() {
            const node = selected();
            if (!node || !ui['object-inspector-dialog']) return false;
            hideMenu();

            // 模态窗的可见性不能依赖 SVG/CSS 解析或 iframe 预览成功。
            // 先展示外壳；后续任一高级字段初始化失败时，用户仍可看到诊断、
            // 取消草稿，而不是表现为点击“编辑对象属性”后毫无反应。
            ui['object-inspector-dialog'].hidden = false;
            try {
                // 缩放手柄属于编辑器临时 UI，不能进入属性草稿快照。否则取消
                // 属性编辑时会恢复一套旧手柄，随后 select() 又安装一套新手柄。
                const original = node.cloneNode(true);
                original.querySelectorAll('[data-vdoc-object-resize-handle]').forEach((handle) =>
                    handle.remove()
                );
                original.removeAttribute('data-vdoc-object-selected');
                original.removeAttribute('data-vdoc-object-dragging');
                state.draftOriginal = {
                    html: original.outerHTML,
                    objectId: node.dataset.vdocObjectId,
                };
                fillInspector(node);
            } catch (error) {
                console.error('[ScriptoriumObjects] Inspector initialization failed:', error);
                state.draftOriginal = null;
                if (ui['object-source-diagnostics']) {
                    ui['object-source-diagnostics'].textContent =
                        `属性预览初始化失败：${error.message}`;
                    ui['object-source-diagnostics'].classList.remove('valid');
                    ui['object-source-diagnostics'].classList.add('invalid');
                }
                if (ui['object-inspector-apply-btn']) {
                    ui['object-inspector-apply-btn'].disabled = true;
                }
            }
            return true;
        }

        function previewInspector() {
            const node = selected();
            if (!node || !refreshSourcePreview()) return;
            applyObjectPatch(node, inspectorPatch(), freeCanvas());
        }

        function closeInspector(cancel = false) {
            if (!ui['object-inspector-dialog']
                || ui['object-inspector-dialog'].hidden) return;
            if (cancel && state.draftOriginal) {
                const node = selected();
                if (node) {
                    const template = document.createElement('template');
                    template.innerHTML = state.draftOriginal.html;
                    const restored = template.content.firstElementChild;
                    node.replaceWith(restored);
                    state.selectedNode = restored;
                    select(restored);
                }
            }
            ui['object-inspector-dialog'].hidden = true;
            state.draftOriginal = null;
        }

        function applyInspector() {
            const node = selected();
            if (!node || !refreshSourcePreview()) return false;
            const patch = inspectorPatch();
            applyObjectPatch(node, patch, freeCanvas());
            context.commitMutation?.({
                type: 'update',
                objectId: node.dataset.vdocObjectId,
                patch,
                impact: freeCanvas() ? 'geometry' : 'flow',
            });
            closeInspector(false);
            return true;
        }

        function runAction(action) {
            const node = selected();
            if (!node) return false;
            hideMenu();
            if (action === 'edit') return openInspector();
            if (action === 'delete') {
                context.commitMutation?.({
                    type: 'delete',
                    objectId: node.dataset.vdocObjectId,
                    impact: freeCanvas() ? 'geometry' : 'flow',
                });
                clearSelection();
                return true;
            }
            if (action.startsWith('layout-')) {
                const layout = action.slice(7);
                applyFlowLayout(node, layout);
                context.commitMutation?.({
                    type: 'update',
                    objectId: node.dataset.vdocObjectId,
                    patch: { layout },
                    impact: 'flow',
                });
                return true;
            }
            if (LAYER_ACTIONS.has(action)) {
                applyLayerAction(node, action);
                context.commitMutation?.({
                    type: 'layer',
                    objectId: node.dataset.vdocObjectId,
                    action,
                    impact: 'geometry',
                });
                return true;
            }
            return false;
        }

        function bindRoot(nextRoot = root()) {
            state.rootAbort?.abort();
            state.rootAbort = new AbortController();
            clearSelection();
            if (!nextRoot) return;
            const options = { capture: true, signal: state.rootAbort.signal };
            nextRoot.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                const resizeHandle = event.target.closest?.(
                    '[data-vdoc-object-resize-handle]'
                );
                const resizeDirection = resizeHandle?.dataset?.vdocObjectResizeHandle || '';
                const object = (resizeHandle || event.target).closest?.(OBJECT_SELECTOR);
                if (!object) {
                    clearSelection();
                    return;
                }

                // 必须在 select() 重建手柄前保存命中的方向；重建后 event.target
                // 指向的旧手柄已脱离 DOM，但本次缩放事务仍应正常开始。
                if (resizeDirection) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    select(object);
                    beginDrag(event, object, resizeDirection);
                    return;
                }

                // 原生音视频控件与对象内可编辑图注仍需接收正常指针事件。
                // 点击它们只选中对象，不启动拖拽；图片、SVG 和对象空白区
                // 则继续作为拖拽命中面。
                const interactive = event.target.closest?.(
                    'video,audio,button,input,select,textarea,a,[data-vdoc-text]'
                );
                select(object);
                if (interactive && object.contains(interactive)) return;

                event.preventDefault();
                event.stopImmediatePropagation();
                beginDrag(event, object);
            }, options);
            nextRoot.addEventListener('pointermove', (event) => {
                if (!state.drag) return;
                event.stopImmediatePropagation();
                moveDrag(event);
            }, options);
            nextRoot.addEventListener('pointerup', (event) => {
                if (!state.drag) return;
                event.stopImmediatePropagation();
                finishDrag(event);
            }, options);
            nextRoot.addEventListener('pointercancel', (event) => {
                finishDrag(event, true);
            }, options);
            nextRoot.addEventListener('contextmenu', (event) => {
                const object = event.target.closest?.(OBJECT_SELECTOR);
                if (!object) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                select(object);
                showMenu(event.clientX, event.clientY);
            }, options);
            nextRoot.querySelectorAll(`${OBJECT_SELECTOR}, .vdoc-media, .vdoc-media-batch`)
                .forEach((node) => {
                    if (node.parentElement?.closest(OBJECT_SELECTOR)) return;
                    normalizeObjectNode(node, freeCanvas());
                });
        }

        function bindUi() {
            state.uiAbort?.abort();
            state.uiAbort = new AbortController();
            const options = { signal: state.uiAbort.signal };
            ui['insert-shape-btn']?.addEventListener('click', () => {
                if (!context.canInsert?.()) return;
                const kind = ui['shape-kind-select']?.value || 'rectangle';
                const node = createShape(kind, { deck: freeCanvas() });
                context.insertObject?.(node);
            }, options);
            ui['object-context-menu']?.addEventListener('click', (event) => {
                const action = event.target.closest('[data-object-action]')?.dataset.objectAction;
                if (action) runAction(action);
            }, options);
            ui['object-inspector-form']?.addEventListener(
                'input',
                previewInspector,
                options
            );
            ui['object-inspector-form']?.addEventListener('submit', (event) => {
                event.preventDefault();
                applyInspector();
            }, options);
            ui['object-inspector-cancel-btn']?.addEventListener('click', () =>
                closeInspector(true)
            , options);
            ui['object-inspector-dialog']?.addEventListener('click', (event) => {
                if (event.target === ui['object-inspector-dialog']) closeInspector(true);
            }, options);
            window.addEventListener('pointerdown', (event) => {
                if (!ui['object-context-menu']?.contains(event.target)) hideMenu();
            }, {
                capture: true,
                signal: state.uiAbort.signal,
            });
        }

        function handleKeydown(event) {
            if (event.key === 'Escape') {
                if (!ui['object-inspector-dialog']?.hidden) {
                    closeInspector(true);
                    return true;
                }
                if (state.drag) finishDrag(null, true);
                clearSelection();
                return false;
            }
            if ((event.key === 'Delete' || event.key === 'Backspace')
                && selected()
                && !event.target?.closest?.('input,textarea,select,.CodeMirror')) {
                event.preventDefault();
                runAction('delete');
                return true;
            }
            if (freeCanvas() && selected()
                && /^Arrow(?:Left|Right|Up|Down)$/.test(event.key)) {
                event.preventDefault();
                const node = selected();
                const step = event.shiftKey ? 10 : 1;
                const left = finite(node.style.left, 0)
                    + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0);
                const top = finite(node.style.top, 0)
                    + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
                node.style.left = `${left}px`;
                node.style.top = `${top}px`;
                context.commitMutation?.({
                    type: 'geometry',
                    objectId: node.dataset.vdocObjectId,
                    styles: { left: node.style.left, top: node.style.top },
                    impact: 'geometry',
                });
                return true;
            }
            return false;
        }

        bindUi();
        return Object.freeze({
            bindRoot,
            clearSelection,
            select,
            selected,
            openInspector,
            closeInspector,
            handleKeydown,
            dispose() {
                state.rootAbort?.abort();
                state.uiAbort?.abort();
                state.rootAbort = null;
                state.uiAbort = null;
                clearSelection();
            },
        });
    }

    window.ScriptoriumObjects = Object.freeze({
        OBJECT_SELECTOR,
        SHAPE_SELECTOR,
        SHAPES,
        sanitizeSvgSource,
        scopeObjectCss,
        normalizeSource,
        normalizeObjectNode,
        createShape,
        createShapeFromSvg,
        applyFlowLayout,
        applySlideLayout,
        applyShapeProperties,
        applyObjectPatch,
        applyMutationToSource,
        createObjectController,
    });
})();