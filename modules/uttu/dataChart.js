// 文坊的数据图表块。源码里写 ```chart 图ID 围栏，里面一个 JSON：
// data 以外的键是图形（类型、横轴、系列、格式），data 是数据，一行一个对象。这里负责解析和校验、画成静态 SVG、
// 按 UpdateChartData 改数据（只换 data 那一段，图形部分一个字节不动）。页面（文坊渲染）和插件服务（Node）共用：
// 画图不碰 DOM，文字宽度按字数估；只有 renderAll 在页面里量宽度、判深浅。
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UTTUDataChart = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const ID_PATTERN = /^[A-Za-z0-9][\w-]{0,63}$/;
    const TYPES = ['line', 'area', 'bar', 'pie'];
    const FORMATS = ['number', 'percent', 'compact'];
    const LABELS = ['auto', 'none', 'last', 'all'];
    const LIMITS = Object.freeze({ rows: 2000, bytes: 256 * 1024, series: 8, slices: 8 });

    // 正负两色（系列写 "sign": true，正数一色、负数一色，比如盈亏、增减、净流入）。默认红正绿负（A 股习惯）；
    // 要整体换成绿正红负，在这里对调。单份文档要不同，在文档 CSS 里设 --vdoc-chart-positive / --vdoc-chart-negative。
    const SIGN_COLORS = Object.freeze({
        dark: { positive: '#d4553e', negative: '#93ad6b' },
        light: { positive: '#b8432f', negative: '#5a7a35' },
    });
    // 系列色：第一个用文档的强调色 --vdoc-accent（墨底赤陶、素白赭红、纸本棕），后面按底色深浅取一组；
    // 文档 CSS 可以用 --vdoc-chart-2 … --vdoc-chart-8 换。深色取自 uttu-tokens.css，浅色是同色相加深一档，
    // 在纸色上对比度都在 4:1 以上。
    const PALETTES = Object.freeze({
        dark: ['#c35f2c', '#6d8fa6', '#93ad6b', '#d8a443', '#8a6f9e', '#dea06c', '#b4a893', '#9b795d'],
        light: ['#b4532a', '#4a6b84', '#5a7a35', '#9a6c12', '#6e5687', '#a8662f', '#7a705e', '#7d5a3f'],
    });
    // 饼图扇区之间的缝用纸色；没有文档样式时按深浅取。
    const PAPER = Object.freeze({ dark: '#1b1814', light: '#f7f5f0' });

    const FONT = 11.5;

    function escapeXml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    }

    function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function byteLength(text) {
        const value = String(text || '');
        return typeof TextEncoder === 'function' ? new TextEncoder().encode(value).length : value.length * 3;
    }

    function isRow(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    function numberOf(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    // 系列颜色只收 #hex、颜色名和 var(--xxx)，它会进 style 属性。
    function safeColor(value) {
        const text = String(value || '').trim();
        return /^(#[0-9a-f]{3,8}|[a-z]{3,20}|var\(--[\w-]+\))$/i.test(text) ? text : null;
    }

    // ---- 解析和校验 ----

    function fail(message) {
        return { error: message };
    }

    function seriesOf(raw, x, data, type) {
        const list = raw.series !== undefined ? raw.series : raw.y;
        let items;
        if (list === undefined) {
            const keys = [];
            data.slice(0, 20).forEach((row) => Object.keys(row).forEach((key) => {
                if (key !== x && !keys.includes(key) && numberOf(row[key]) !== null) keys.push(key);
            }));
            items = keys;
        } else {
            items = Array.isArray(list) ? list : [list];
        }
        return items
            .map((item) => (typeof item === 'string' ? { key: item } : item))
            .filter((item) => isRow(item) && typeof item.key === 'string' && item.key)
            .map((item) => ({
                key: item.key,
                name: String(item.name || item.key),
                type: type === 'pie' ? 'pie' : (['line', 'area', 'bar'].includes(item.type) ? item.type : type),
                sign: item.sign === true,
                color: safeColor(item.color),
            }));
    }

    // 原始 JSON 对象 → 规范化的图（spec）。出错返回 { error }。
    function normalize(raw) {
        if (!isRow(raw)) return fail('图表内容必须是一个 JSON 对象。');
        const type = String(raw.type || 'line').toLowerCase();
        if (!TYPES.includes(type)) return fail(`不认识的图表类型 ${raw.type}，可用 line、area、bar、pie。`);
        const data = raw.data === undefined ? [] : raw.data;
        if (!Array.isArray(data)) return fail('data 必须是数组，一行一个对象。');
        if (data.length > LIMITS.rows) return fail(`data 有 ${data.length} 行，超过 ${LIMITS.rows} 行；先按周或按月汇总。`);
        const badRow = data.findIndex((row) => !isRow(row));
        if (badRow >= 0) return fail(`data 第 ${badRow + 1} 行不是对象。`);
        const x = typeof raw.x === 'string' && raw.x ? raw.x : null;
        if (!x) return fail(type === 'pie' ? '缺少 x：扇区名称用哪一列。' : '缺少 x：横轴用哪一列。');
        let series = seriesOf(raw, x, data, type);
        if (!series.length) return fail('没有可画的系列：用 series 或 y 写数值列。');
        if (series.length > LIMITS.series) return fail(`系列最多 ${LIMITS.series} 个。`);
        if (type === 'pie') series = series.slice(0, 1);
        const format = FORMATS.includes(raw.format) ? raw.format : 'number';
        const digits = Number.isInteger(raw.digits) ? Math.max(0, Math.min(6, raw.digits)) : null;
        const height = Number.isFinite(Number(raw.height))
            ? Math.max(140, Math.min(640, Math.round(Number(raw.height))))
            : (type === 'pie' ? 220 : 260);
        return {
            spec: {
                type,
                title: raw.title ? String(raw.title) : '',
                note: raw.note ? String(raw.note) : '',
                x,
                series,
                stack: raw.stack === true,
                unit: raw.unit ? String(raw.unit) : '',
                format,
                digits,
                height,
                yMin: numberOf(raw.yMin),
                yMax: numberOf(raw.yMax),
                labels: LABELS.includes(raw.labels) ? raw.labels : 'auto',
                data,
            },
        };
    }

    function parse(text) {
        if (byteLength(text) > LIMITS.bytes) return fail(`图表块超过 ${LIMITS.bytes / 1024} KB；先汇总数据。`);
        let raw;
        try {
            raw = JSON.parse(String(text || ''));
        } catch (error) {
            return fail(`图表 JSON 写错了：${error.message}`);
        }
        return normalize(raw);
    }

    // ---- 数字格式 ----

    function decimalsFor(step) {
        if (!Number.isFinite(step) || step <= 0) return 0;
        const text = String(Number(step.toPrecision(6)));
        const exponent = text.match(/e-(\d+)$/);
        if (exponent) return Number(exponent[1]);
        return (text.split('.')[1] || '').length;
    }

    function autoDigits(value) {
        const abs = Math.abs(value);
        if (abs === 0 || abs >= 1000) return 0;
        if (abs >= 100) return 1;
        if (abs >= 1) return 2;
        return 3;
    }

    function trimZeros(text) {
        return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
    }

    function grouped(value, digits) {
        return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }

    function compactScale(abs) {
        if (abs >= 1e8) return [1e8, '亿'];
        if (abs >= 1e4) return [1e4, '万'];
        return [1, ''];
    }

    // tick 为刻度时传 { step, scale }：小数位按刻度间隔走，万、亿的单位按整根轴统一。
    function formatValue(value, spec, tick = null) {
        if (value === null || !Number.isFinite(value)) return '';
        if (spec.format === 'percent') {
            const digits = spec.digits ?? (tick ? decimalsFor(tick.step * 100) : 1);
            return `${(value * 100).toFixed(digits)}%`;
        }
        if (spec.format === 'compact') {
            const [div, suffix] = tick ? tick.scale : compactScale(Math.abs(value));
            const scaled = value / div;
            const digits = spec.digits ?? (tick
                ? decimalsFor(tick.step / div)
                : (div === 1 ? autoDigits(scaled) : (Math.abs(scaled) >= 100 ? 0 : 1)));
            const text = tick || spec.digits !== null ? scaled.toFixed(digits) : trimZeros(scaled.toFixed(digits));
            return `${text}${value === 0 ? '' : suffix}${spec.unit}`;
        }
        const digits = spec.digits ?? (tick ? decimalsFor(tick.step) : autoDigits(value));
        const text = grouped(value, digits);
        return `${tick || spec.digits !== null ? text : (text.includes('.') ? text.replace(/\.?0+$/, '') : text)}${spec.unit}`;
    }

    // ---- 量文字（估算） ----

    function textWidth(text, size = FONT) {
        let width = 0;
        for (const ch of String(text)) {
            const code = ch.codePointAt(0);
            if (code >= 0x2e80) width += size;
            else if (/[0-9]/.test(ch)) width += size * 0.6;
            else if (/[A-Z%]/.test(ch)) width += size * 0.7;
            else if (/[\s.,:;'|!il]/.test(ch)) width += size * 0.32;
            else width += size * 0.56;
        }
        return width;
    }

    // ---- 刻度 ----

    function niceTicks(min, max, count) {
        let low = min;
        let high = max;
        if (low === high) {
            const pad = Math.abs(low) * 0.1 || 1;
            low -= pad;
            high += pad;
        }
        const raw = (high - low) / Math.max(1, count);
        const power = Math.pow(10, Math.floor(Math.log10(raw)));
        const unit = raw / power;
        const step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
        const start = Math.floor(low / step + 1e-9) * step;
        const end = Math.ceil(high / step - 1e-9) * step;
        const list = [];
        for (let index = 0; start + index * step <= end + step / 2; index += 1) {
            list.push(Number((start + index * step).toPrecision(12)));
        }
        return { min: start, max: end, step, list };
    }

    // ---- 颜色 ----

    function seriesColor(series, index, dark) {
        if (series.color) return series.color;
        const palette = dark ? PALETTES.dark : PALETTES.light;
        return index === 0
            ? `var(--vdoc-accent, ${palette[0]})`
            : `var(--vdoc-chart-${index + 1}, ${palette[index % palette.length]})`;
    }

    function signColor(value, dark) {
        const colors = dark ? SIGN_COLORS.dark : SIGN_COLORS.light;
        return value < 0
            ? `var(--vdoc-chart-negative, ${colors.negative})`
            : `var(--vdoc-chart-positive, ${colors.positive})`;
    }

    // ---- 图例 ----

    function legend(spec, width, dark) {
        if (spec.series.length < 2 && !spec.series.some((series) => series.sign)) return { svg: '', height: 0 };
        const items = spec.series.map((series, index) => {
            const label = series.name;
            const swatch = series.sign ? 16 : 12;
            return { series, index, label, width: swatch + 6 + textWidth(label) + 18 };
        });
        let x = 0;
        let row = 0;
        const parts = [];
        items.forEach((item) => {
            if (x > 0 && x + item.width > width) {
                x = 0;
                row += 1;
            }
            const y = row * 20 + 10;
            if (item.series.sign) {
                parts.push(`<rect x="${x}" y="${y - 5}" width="7" height="10" style="fill:${signColor(1, dark)}"/>`
                    + `<rect x="${x + 8}" y="${y - 5}" width="7" height="10" style="fill:${signColor(-1, dark)}"/>`);
            } else if (item.series.type === 'line') {
                parts.push(`<rect x="${x}" y="${y - 1.5}" width="12" height="3" rx="1.5" `
                    + `style="fill:${seriesColor(item.series, item.index, dark)}"/>`);
            } else {
                parts.push(`<rect x="${x}" y="${y - 5}" width="12" height="10" rx="2" `
                    + `style="fill:${seriesColor(item.series, item.index, dark)}"/>`);
            }
            const textX = x + (item.series.sign ? 16 : 12) + 6;
            parts.push(`<text x="${textX}" y="${y}" dy=".35em" fill="currentColor" fill-opacity=".78">`
                + `${escapeXml(item.label)}</text>`);
            x += item.width;
        });
        return { svg: `<g class="uttu-chart-legend">${parts.join('')}</g>`, height: (row + 1) * 20 + 6 };
    }

    // ---- 直角坐标（折线、面积、柱） ----

    function cartesian(spec, width, dark) {
        const rows = spec.data;
        const count = rows.length;
        const labels = rows.map((row) => String(row[spec.x] ?? ''));
        const value = (row, key) => numberOf(row[key]);
        const bars = spec.series.filter((series) => series.type === 'bar');
        const areas = spec.series.filter((series) => series.type === 'area');
        const lines = spec.series.filter((series) => series.type === 'line');
        const stackBars = spec.stack && bars.length > 1;
        const stackAreas = spec.stack && areas.length > 1;

        // 每个系列每一行的 [下沿, 上沿]；堆叠时按正负各自累加。
        const extents = new Map();
        const barLow = rows.map(() => ({ pos: 0, neg: 0 }));
        bars.forEach((series) => extents.set(series, rows.map((row, index) => {
            const v = value(row, series.key);
            if (v === null) return null;
            if (!stackBars) return [0, v];
            const slot = barLow[index];
            const base = v >= 0 ? slot.pos : slot.neg;
            if (v >= 0) slot.pos += v;
            else slot.neg += v;
            return [base, base + v];
        })));
        const areaLow = rows.map(() => 0);
        areas.forEach((series) => extents.set(series, rows.map((row, index) => {
            const v = value(row, series.key);
            if (!stackAreas) return v === null ? null : [0, v];
            const base = areaLow[index];
            areaLow[index] += v ?? 0;
            return [base, base + (v ?? 0)];
        })));
        lines.forEach((series) => extents.set(series, rows.map((row) => {
            const v = value(row, series.key);
            return v === null ? null : [v, v];
        })));

        const values = [];
        extents.forEach((list) => list.forEach((pair) => pair && values.push(pair[0], pair[1])));
        if (!values.length) return null;
        let min = Math.min(...values);
        let max = Math.max(...values);
        if (bars.length || areas.length) {
            min = Math.min(min, 0);
            max = Math.max(max, 0);
        }
        if (spec.yMin !== null) min = spec.yMin;
        if (spec.yMax !== null) max = spec.yMax;

        const top = legend(spec, width, dark);
        const plotTop = top.height + 8;
        const height = spec.height + top.height;
        const plotBottom = height - 26;
        const ticks = niceTicks(min, max, Math.max(2, Math.min(6, Math.round((plotBottom - plotTop) / 52))));
        const tick = {
            step: ticks.step,
            scale: compactScale(Math.max(Math.abs(ticks.min), Math.abs(ticks.max))),
        };
        const tickLabels = ticks.list.map((t) => formatValue(t, spec, tick));
        const left = Math.ceil(Math.max(...tickLabels.map((text) => textWidth(text)))) + 12;

        // 直接标值：折线、面积的最后一个点标在线尾（系列不多时），柱少时标在柱上。
        const lastLabelled = spec.labels === 'none'
            ? []
            : [...areas, ...lines].filter(() => spec.labels !== 'auto' || areas.length + lines.length <= 4);
        const lastPoints = lastLabelled.map((series) => {
            const list = extents.get(series);
            let index = list.length - 1;
            while (index >= 0 && !list[index]) index -= 1;
            if (index < 0) return null;
            const raw = series.type === 'area' && stackAreas ? value(rows[index], series.key) : list[index][1];
            return { series, index, y: list[index][1], text: formatValue(raw, spec) };
        }).filter(Boolean);
        const right = lastPoints.length
            ? Math.ceil(Math.max(...lastPoints.map((point) => textWidth(point.text)))) + 14
            : 10;

        const plotLeft = left;
        const plotRight = Math.max(plotLeft + 40, width - right);
        const plotWidth = plotRight - plotLeft;
        const band = plotWidth / Math.max(1, count);
        const xAt = bars.length
            ? (index) => plotLeft + band * (index + 0.5)
            : (index) => (count === 1 ? plotLeft + plotWidth / 2 : plotLeft + plotWidth * index / (count - 1));
        const yAt = (v) => plotBottom - (v - ticks.min) / (ticks.max - ticks.min) * (plotBottom - plotTop);
        const clampY = (v) => Math.max(plotTop - 4, Math.min(plotBottom + 4, yAt(v)));
        const fixed = (n) => Number(n.toFixed(2));

        const parts = [];
        if (top.svg) parts.push(top.svg);
        // 网格和纵轴刻度；0 线稍深。
        ticks.list.forEach((t, index) => {
            const y = fixed(yAt(t));
            const zero = t === 0 && ticks.min < 0;
            parts.push(`<line x1="${plotLeft}" x2="${fixed(plotRight)}" y1="${y}" y2="${y}" stroke="currentColor" `
                + `stroke-opacity="${zero ? 0.4 : 0.12}" stroke-width="1"/>`);
            parts.push(`<text x="${plotLeft - 8}" y="${y}" dy=".35em" text-anchor="end" fill="currentColor" `
                + `fill-opacity=".62">${escapeXml(tickLabels[index])}</text>`);
        });

        // 横轴标签：点多时隔几个标一个，最后一个总要标（时间序列看最新）。
        const labelWidth = Math.max(...labels.map((text) => textWidth(text)), 1);
        const spacing = bars.length || count < 2 ? band : plotWidth / (count - 1);
        const every = Math.max(1, Math.ceil((labelWidth + 12) / Math.max(1, spacing)));
        const shown = [];
        for (let index = 0; index < count; index += every) shown.push(index);
        if (count && shown[shown.length - 1] !== count - 1) {
            if (shown.length > 1 && count - 1 - shown[shown.length - 1] < every) shown.pop();
            shown.push(count - 1);
        }
        shown.forEach((index) => {
            const half = textWidth(labels[index]) / 2;
            const x = Math.max(half, Math.min(width - half, xAt(index)));
            parts.push(`<text x="${fixed(x)}" y="${plotBottom + 19}" text-anchor="middle" fill="currentColor" `
                + `fill-opacity=".62">${escapeXml(labels[index])}</text>`);
        });

        // 柱
        const showBarLabels = spec.labels === 'all'
            || (spec.labels === 'auto' && bars.length === 1 && !areas.length && !lines.length && count <= 16);
        const groupWidth = band * (count > 40 ? 0.84 : 0.66);
        bars.forEach((series, order) => {
            const index0 = spec.series.indexOf(series);
            const list = extents.get(series);
            const barWidth = stackBars ? groupWidth : groupWidth / bars.length;
            const gap = !stackBars && bars.length > 1 && barWidth > 4 ? 1 : 0;
            list.forEach((pair, index) => {
                if (!pair) return;
                const [low, high] = pair;
                const x = xAt(index) - groupWidth / 2 + (stackBars ? 0 : order * barWidth);
                let y = Math.min(clampY(low), clampY(high));
                let h = Math.abs(clampY(high) - clampY(low));
                if (high !== low && h < 1) {
                    h = 1;
                    if (high > low) y -= 1;
                }
                const raw = value(rows[index], series.key);
                const color = series.sign ? signColor(raw, dark) : seriesColor(series, index0, dark);
                parts.push(`<rect x="${fixed(x + gap / 2)}" y="${fixed(y)}" width="${fixed(Math.max(1, barWidth - gap))}" `
                    + `height="${fixed(h)}" style="fill:${color}"/>`);
                if (showBarLabels) {
                    const text = formatValue(raw, spec);
                    if (spec.labels === 'all' || textWidth(text, 11) <= band - 2) {
                        // 标在柱端外侧；碰到横轴文字或图例时改标在柱内（用纸色字），柱太短就不标。
                        const end = clampY(high);
                        let ly = raw < 0 ? end + 13 : end - 5;
                        let fill = 'fill="currentColor" fill-opacity=".8"';
                        if (raw < 0 ? ly > plotBottom - 2 : ly - 10 < plotTop - 4) {
                            ly = raw < 0 ? end - 5 : end + 13;
                            fill = `style="fill:var(--vdoc-paper, ${dark ? PAPER.dark : PAPER.light})"`;
                            if (h < 17) ly = null;
                        }
                        if (ly !== null) {
                            parts.push(`<text x="${fixed(x + barWidth / 2)}" y="${fixed(ly)}" text-anchor="middle" `
                                + `font-size="11" ${fill}>${escapeXml(text)}</text>`);
                        }
                    }
                }
            });
        });

        // 面积和折线：缺数的地方断开。
        const pathOf = (list, pick) => {
            let d = '';
            let open = false;
            list.forEach((pair, index) => {
                if (!pair) {
                    open = false;
                    return;
                }
                d += `${open ? 'L' : 'M'}${fixed(xAt(index))},${fixed(clampY(pick(pair)))}`;
                open = true;
            });
            return d;
        };
        const strokeWidth = count > 120 ? 1.5 : 2;
        areas.forEach((series) => {
            const color = seriesColor(series, spec.series.indexOf(series), dark);
            const list = extents.get(series);
            // 面积按连续段画，每段上沿去、下沿回。
            let segment = [];
            const flush = () => {
                if (!segment.length) return;
                const upper = segment.map(({ index, pair }) => `${fixed(xAt(index))},${fixed(clampY(pair[1]))}`);
                const lower = [...segment].reverse()
                    .map(({ index, pair }) => `${fixed(xAt(index))},${fixed(clampY(pair[0]))}`);
                parts.push(`<path d="M${upper.join('L')}L${lower.join('L')}Z" style="fill:${color}" fill-opacity=".2"/>`);
                segment = [];
            };
            list.forEach((pair, index) => (pair ? segment.push({ index, pair }) : flush()));
            flush();
            parts.push(`<path d="${pathOf(list, (pair) => pair[1])}" fill="none" style="stroke:${color}" `
                + `stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/>`);
        });
        lines.forEach((series) => {
            const color = seriesColor(series, spec.series.indexOf(series), dark);
            const list = extents.get(series);
            parts.push(`<path d="${pathOf(list, (pair) => pair[1])}" fill="none" style="stroke:${color}" `
                + `stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/>`);
            if (count <= 24) {
                list.forEach((pair, index) => {
                    if (!pair) return;
                    parts.push(`<circle cx="${fixed(xAt(index))}" cy="${fixed(clampY(pair[1]))}" r="2.6" `
                        + `style="fill:${color}"/>`);
                });
            }
        });

        // 线尾标值：按高低排开，至少隔 13px。
        const placed = lastPoints
            .map((point) => ({ ...point, ly: clampY(point.y) }))
            .sort((a, b) => a.ly - b.ly);
        placed.forEach((point, order) => {
            if (order > 0) point.ly = Math.max(point.ly, placed[order - 1].ly + 13);
        });
        placed.forEach((point) => {
            const color = seriesColor(point.series, spec.series.indexOf(point.series), dark);
            parts.push(`<circle cx="${fixed(xAt(point.index))}" cy="${fixed(clampY(point.y))}" r="3" style="fill:${color}"/>`);
            parts.push(`<text x="${fixed(xAt(point.index) + 7)}" y="${fixed(Math.min(point.ly, plotBottom + 6))}" dy=".35em" `
                + `style="fill:${color}" font-weight="600">${escapeXml(point.text)}</text>`);
        });

        return { body: parts.join(''), height };
    }

    // ---- 饼图（环形） ----

    function pie(spec, width, dark) {
        const series = spec.series[0];
        let slices = spec.data
            .map((row) => ({ label: String(row[spec.x] ?? ''), value: numberOf(row[series.key]) }))
            .filter((slice) => slice.value !== null && slice.value > 0);
        if (!slices.length) return null;
        if (slices.length > LIMITS.slices) {
            const sorted = [...slices].sort((a, b) => b.value - a.value);
            const kept = sorted.slice(0, LIMITS.slices - 1);
            const rest = sorted.slice(LIMITS.slices - 1).reduce((sum, slice) => sum + slice.value, 0);
            slices = [...slices.filter((slice) => kept.includes(slice)), { label: '其他', value: rest }];
        }
        const total = slices.reduce((sum, slice) => sum + slice.value, 0);
        const rows = slices.map((slice, index) => {
            const share = slice.value / total;
            return {
                ...slice,
                index,
                text: `${formatValue(slice.value, spec)} · ${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`,
            };
        });
        const legendWidth = Math.max(...rows.map((row) => 18 + textWidth(row.label) + 12 + textWidth(row.text)));
        const side = width >= 360 && width - legendWidth >= 180;
        const diameter = side
            ? Math.min(spec.height - 12, width - legendWidth - 32)
            : Math.min(spec.height - 12, width - 16);
        const radius = diameter / 2;
        const inner = radius * 0.6;
        const cx = side ? radius + 4 : width / 2;
        const cy = radius + 6;
        const legendX = side ? diameter + 32 : Math.max(0, (width - legendWidth) / 2);
        const legendY = side ? Math.max(6, cy - rows.length * 11) : diameter + 22;
        const height = side ? Math.max(spec.height, legendY + rows.length * 22) : legendY + rows.length * 22 + 4;
        const paper = `var(--vdoc-paper, ${dark ? PAPER.dark : PAPER.light})`;
        const fixed = (n) => Number(n.toFixed(2));
        const point = (angle, r) => [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
        const parts = [];
        let angle = 0;
        rows.forEach((row) => {
            const sweep = row.value / total * Math.PI * 2;
            const color = seriesColor(series, row.index, dark);
            if (rows.length === 1) {
                parts.push(`<circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="${fixed((radius + inner) / 2)}" fill="none" `
                    + `style="stroke:${color}" stroke-width="${fixed(radius - inner)}"/>`);
            } else {
                const [x1, y1] = point(angle, radius);
                const [x2, y2] = point(angle + sweep, radius);
                const [x3, y3] = point(angle + sweep, inner);
                const [x4, y4] = point(angle, inner);
                const large = sweep > Math.PI ? 1 : 0;
                parts.push(`<path d="M${fixed(x1)},${fixed(y1)}A${fixed(radius)},${fixed(radius)} 0 ${large} 1 `
                    + `${fixed(x2)},${fixed(y2)}L${fixed(x3)},${fixed(y3)}A${fixed(inner)},${fixed(inner)} 0 ${large} 0 `
                    + `${fixed(x4)},${fixed(y4)}Z" style="fill:${color};stroke:${paper}" stroke-width="1.5"/>`);
            }
            angle += sweep;
        });
        parts.push(`<text x="${fixed(cx)}" y="${fixed(cy - 4)}" text-anchor="middle" fill="currentColor" font-size="17" `
            + `font-weight="600">${escapeXml(formatValue(total, spec))}</text>`);
        parts.push(`<text x="${fixed(cx)}" y="${fixed(cy + 15)}" text-anchor="middle" fill="currentColor" `
            + `fill-opacity=".6">合计</text>`);
        rows.forEach((row, order) => {
            const y = legendY + order * 22 + 8;
            const color = seriesColor(series, row.index, dark);
            parts.push(`<rect x="${fixed(legendX)}" y="${fixed(y - 5)}" width="10" height="10" rx="2" `
                + `style="fill:${color}"/>`);
            parts.push(`<text x="${fixed(legendX + 18)}" y="${fixed(y)}" dy=".35em" fill="currentColor">`
                + `${escapeXml(row.label)}<tspan dx="12" fill-opacity=".62">${escapeXml(row.text)}</tspan></text>`);
        });
        return { body: parts.join(''), height: Math.ceil(height) };
    }

    // ---- 成图 ----

    const KIND_NAMES = { line: '折线图', area: '面积图', bar: '柱状图', pie: '环形图' };

    // spec（normalize 的结果）→ 图的 HTML：标题、SVG、注脚。options：width（像素）、dark（底色深）。
    function toHtml(spec, options = {}) {
        const width = Math.max(200, Math.round(Number(options.width) || 640));
        const dark = options.dark !== false;
        const drawn = spec.type === 'pie' ? pie(spec, width, dark) : cartesian(spec, width, dark);
        const title = spec.title
            ? `<figcaption style="margin:0 0 .5em;font-weight:600;font-size:.95em;line-height:1.4">`
                + `${escapeXml(spec.title)}</figcaption>`
            : '';
        const note = spec.note
            ? `<div class="uttu-chart-note" style="margin-top:.45em;font-size:.82em;line-height:1.5;opacity:.65">`
                + `${escapeXml(spec.note)}</div>`
            : '';
        if (!drawn) {
            return `${title}<div class="uttu-chart-empty" style="padding:2.4em 0;text-align:center;font-size:.9em;`
                + `opacity:.6;border:1px dashed color-mix(in srgb, currentColor 30%, transparent);border-radius:var(--uttu-r-s)">`
                + `还没有数据</div>${note}`;
        }
        const label = `${spec.title || '数据图'}：${KIND_NAMES[spec.type]}，${spec.data.length} 行数据`;
        return `${title}<svg xmlns="http://www.w3.org/2000/svg" class="uttu-chart-svg" viewBox="0 0 ${width} ${drawn.height}" `
            + `width="${width}" height="${drawn.height}" role="img" aria-label="${escapeXml(label)}" font-size="${FONT}" `
            + `style="display:block;max-width:100%;height:auto;overflow:visible;font-variant-numeric:tabular-nums">`
            + `${drawn.body}</svg>${note}`;
    }

    function errorHtml(id, message, source) {
        return `<div class="uttu-chart-error" style="padding:.7em .9em;border:1px solid currentColor;border-radius:var(--uttu-r-s);`
            + `font-size:.88em;opacity:.8">图表 ${escapeXml(id || '')} 画不出来：${escapeXml(message)}</div>`
            + `<pre class="vdoc-chart-source" style="margin-top:.5em;font-size:.8em;opacity:.7">${escapeXml(source)}</pre>`;
    }

    // ---- 页面里：找到编译出的占位图，量宽度、判深浅、画 ----

    function decodeSource(node) {
        try {
            return decodeURIComponent(node.dataset.vdocChart || '');
        } catch {
            return node.dataset.vdocChart || '';
        }
    }

    // 图所在处的底色深不深：看那里的文字颜色（和 Mermaid 同一个办法，见 mermaidTheme.js）。
    function surfaceIsDark(node) {
        const shared = typeof window !== 'undefined' ? window.UTTUMermaidTheme : null;
        if (shared?.surfaceIsDark) return shared.surfaceIsDark(node, true);
        const color = typeof getComputedStyle === 'function' ? getComputedStyle(node).color : '';
        const rgb = (String(color).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        if (rgb.length < 3) return true;
        return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.5;
    }

    let resizeObserver = null;
    const observed = new Set();

    function measure(node) {
        const width = Math.round(node.clientWidth || node.getBoundingClientRect?.().width || 0);
        return width >= 160 ? width : 0;
    }

    function renderNode(node, force = false) {
        const measured = measure(node);
        const width = measured || 640;
        const dark = surfaceIsDark(node);
        const stamp = `${width}:${dark ? 'dark' : 'light'}`;
        if (!force && node.dataset.vdocChartRendered === stamp) return node;
        const source = decodeSource(node);
        const id = node.dataset.vdocIsland || '';
        node.contentEditable = 'false';
        node.dataset.vdocAtomic = 'chart';
        if (!node.style.margin) node.style.margin = '1.4em 0';
        const result = parse(source);
        if (result.error) {
            node.dataset.vdocChartError = result.error;
            node.innerHTML = errorHtml(id, result.error, source);
        } else {
            node.removeAttribute('data-vdoc-chart-error');
            node.innerHTML = toHtml(result.spec, { width, dark });
        }
        node.dataset.vdocChartRendered = stamp;
        watch(node);
        return node;
    }

    // 容器变宽变窄（右栏展开、拖宽）时按新宽度重画，字号不跟着缩放。
    function watch(node) {
        if (typeof ResizeObserver !== 'function') return;
        if (!resizeObserver) {
            resizeObserver = new ResizeObserver((entries) => entries.forEach((entry) => {
                const target = entry.target;
                if (!target.isConnected) {
                    resizeObserver.unobserve(target);
                    observed.delete(target);
                    return;
                }
                const width = measure(target);
                const current = Number(String(target.dataset.vdocChartRendered || '').split(':')[0]);
                if (width && Math.abs(width - current) > 2) renderNode(target, true);
            }));
        }
        observed.forEach((target) => {
            if (!target.isConnected) {
                resizeObserver.unobserve(target);
                observed.delete(target);
            }
        });
        if (!observed.has(node)) {
            observed.add(node);
            resizeObserver.observe(node);
        }
    }

    function renderAll(root) {
        const nodes = [...(root?.querySelectorAll?.('[data-vdoc-chart]') || [])];
        nodes.forEach((node) => {
            try {
                renderNode(node);
            } catch (error) {
                node.dataset.vdocChartError = error.message;
            }
        });
        return nodes;
    }

    // ---- 源码里的图表块和只改数据 ----

    // 在 Markdown 源码里找 ```chart 图ID 围栏（别的代码块里举例写的不算）。行号从 1 开始。
    function findBlocks(source) {
        const text = String(source || '');
        const lines = text.split('\n');
        const blocks = [];
        let offset = 0;
        let open = null;
        lines.forEach((line, index) => {
            const bare = line.replace(/\r$/, '');
            const lineStart = offset;
            offset += line.length + 1;
            if (!open) {
                const match = bare.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
                if (!match || (match[1][0] === '`' && match[2].includes('`'))) return;
                open = {
                    marker: match[1],
                    info: match[2].trim().split(/\s+/),
                    line: index + 1,
                    start: lineStart,
                    bodyStart: offset,
                };
                return;
            }
            const close = bare.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
            if (!close || close[1][0] !== open.marker[0] || close[1].length < open.marker.length) return;
            if (String(open.info[0] || '').toLowerCase() === 'chart') {
                let bodyEnd = Math.max(open.bodyStart, lineStart - 1);
                if (bodyEnd > open.bodyStart && text[bodyEnd - 1] === '\r') bodyEnd -= 1;
                blocks.push({
                    id: open.info[1] || '',
                    line: open.line,
                    bodyLine: open.line + 1,
                    start: open.start,
                    end: lineStart + bare.length,
                    bodyStart: open.bodyStart,
                    bodyEnd,
                    body: text.slice(open.bodyStart, bodyEnd),
                });
            }
            open = null;
        });
        return blocks;
    }

    function stringEnd(text, start) {
        for (let index = start + 1; index < text.length; index += 1) {
            if (text[index] === '\\') index += 1;
            else if (text[index] === '"') return index;
        }
        return text.length - 1;
    }

    function valueEnd(text, start) {
        const first = text[start];
        if (first === '"') return stringEnd(text, start) + 1;
        if (first !== '{' && first !== '[') {
            const match = text.slice(start).match(/^[^,}\]\s]*/);
            return start + match[0].length;
        }
        let depth = 0;
        for (let index = start; index < text.length; index += 1) {
            const ch = text[index];
            if (ch === '"') index = stringEnd(text, index);
            else if (ch === '{' || ch === '[') depth += 1;
            else if (ch === '}' || ch === ']') {
                depth -= 1;
                if (depth === 0) return index + 1;
            }
        }
        return text.length;
    }

    // 顶层 "data" 的值在 JSON 文本里的起止；没有返回 null。
    function dataSpan(text) {
        let depth = 0;
        for (let index = 0; index < text.length; index += 1) {
            const ch = text[index];
            if (ch === '"') {
                const end = stringEnd(text, index);
                if (depth === 1) {
                    const after = text.slice(end + 1).match(/^\s*:\s*/);
                    if (after && JSON.parse(text.slice(index, end + 1)) === 'data') {
                        const start = end + 1 + after[0].length;
                        return { start, end: valueEnd(text, start) };
                    }
                }
                index = end;
            } else if (ch === '{' || ch === '[') {
                depth += 1;
            } else if (ch === '}' || ch === ']') {
                depth -= 1;
            }
        }
        return null;
    }

    function formatRow(row) {
        const entries = Object.entries(row);
        return entries.length
            ? `{ ${entries.map(([key, val]) => `${JSON.stringify(key)}: ${JSON.stringify(val)}`).join(', ')} }`
            : '{}';
    }

    // 数据一行一条：文脉的“看改动”只显示改了的那几行。
    function formatRows(rows, indent, newline) {
        if (!rows.length) return '[]';
        return `[${newline}${rows.map((row) => `${indent}  ${formatRow(row)}`).join(`,${newline}`)}${newline}${indent}]`;
    }

    function replaceData(body, rows) {
        const newline = body.includes('\r\n') ? '\r\n' : '\n';
        const span = dataSpan(body);
        if (span) {
            const lineStart = body.lastIndexOf('\n', span.start) + 1;
            const indent = body.slice(lineStart).match(/^[ \t]*/)[0];
            return body.slice(0, span.start) + formatRows(rows, indent, newline) + body.slice(span.end);
        }
        const close = body.lastIndexOf('}');
        const before = body.slice(0, close).replace(/\s*$/, '');
        const comma = before.endsWith('{') ? '' : ',';
        return `${before}${comma}${newline}  "data": ${formatRows(rows, '  ', newline)}${newline}${body.slice(close)}`;
    }

    function listOf(value, name) {
        if (value === undefined || value === null || value === '') return undefined;
        let parsed = value;
        if (typeof value === 'string') {
            try {
                parsed = JSON.parse(value);
            } catch (error) {
                throw new Error(`${name} 不是有效的 JSON：${error.message}`);
            }
        }
        if (isRow(parsed)) parsed = [parsed];
        if (!Array.isArray(parsed)) throw new Error(`${name} 必须是数组。`);
        return parsed;
    }

    // 改数据：data 整份替换；rows 按横轴值更新（已有就合并那行，没有就加在后面）；removeX 删掉这些横轴值；
    // keepLast 只留最近 N 行。返回 { body, before, after } 或 { error }。图形部分（data 以外）不动。
    function updateBody(body, change = {}) {
        let current;
        try {
            current = JSON.parse(body);
        } catch (error) {
            return fail(`图表 JSON 写错了，先用 SubmitSourcePr 修好：${error.message}`);
        }
        const normalized = normalize(current);
        if (normalized.error) return fail(normalized.error);
        const x = normalized.spec.x;
        let data;
        let rows;
        let removeX;
        try {
            data = listOf(change.data, 'data');
            rows = listOf(change.rows, 'rows');
            removeX = change.removeX === undefined || change.removeX === null || change.removeX === ''
                ? undefined
                : (Array.isArray(change.removeX)
                    ? change.removeX
                    : (String(change.removeX).trim().startsWith('[')
                        ? listOf(change.removeX, 'removeX')
                        : String(change.removeX).split(/[,，]/).map((item) => item.trim()).filter(Boolean)));
        } catch (error) {
            return fail(error.message);
        }
        const keepLast = change.keepLast === undefined || change.keepLast === null || change.keepLast === ''
            ? null
            : Number(change.keepLast);
        if (keepLast !== null && (!Number.isInteger(keepLast) || keepLast < 1)) return fail('keepLast 必须是正整数。');
        if (!data && !rows && !removeX && keepLast === null) {
            return fail('没有要改的：给 data（整份替换）、rows（按横轴值更新或追加）、removeX 或 keepLast。');
        }
        const before = normalized.spec.data;
        let next = data ? clone(data) : before.map(clone);
        const bad = next.findIndex((row) => !isRow(row));
        if (bad >= 0) return fail(`data 第 ${bad + 1} 行不是对象。`);
        const same = (a, b) => String(a) === String(b);
        if (rows) {
            for (const [index, row] of rows.entries()) {
                if (!isRow(row)) return fail(`rows 第 ${index + 1} 项不是对象。`);
                if (row[x] === undefined) return fail(`rows 第 ${index + 1} 项缺少横轴列 ${x}。`);
                const at = next.findIndex((item) => same(item[x], row[x]));
                if (at >= 0) next[at] = { ...next[at], ...clone(row) };
                else next.push(clone(row));
            }
        }
        if (removeX) next = next.filter((row) => !removeX.some((value) => same(row[x], value)));
        if (keepLast !== null && next.length > keepLast) next = next.slice(-keepLast);
        if (next.length > LIMITS.rows) return fail(`改完有 ${next.length} 行，超过 ${LIMITS.rows} 行；先汇总或带 keepLast。`);
        const nextBody = replaceData(body, next);
        const check = parse(nextBody);
        if (check.error) return fail(check.error);
        return { body: nextBody, before: before.length, after: next.length };
    }

    return Object.freeze({
        ID_PATTERN,
        LIMITS,
        SIGN_COLORS,
        PALETTES,
        parse,
        normalize,
        toHtml,
        formatValue,
        renderAll,
        renderNode,
        findBlocks,
        dataSpan,
        updateBody,
    });
});
