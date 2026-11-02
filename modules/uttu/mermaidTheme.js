// Mermaid 的配色跟 VCP 走。对话、文本查看器用深色（墨底）；
// 渲染前看图所在处的底色深浅（surfaceIsDark）：深底画深色图，浅底（文坊纸本、浅色主题）画浅色图。只给具体颜色值——Mermaid 要从这些颜色推算
// 别的颜色，不认 var(--...)。颜色取自 styles/ui-system/uttu-tokens.css。
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UTTUMermaidTheme = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const FONT = '"MiSans", "Noto Sans SC", "Microsoft YaHei", sans-serif';
    const SERIES = ['#c35f2c', '#dea06c', '#93ad6b', '#6d8fa6', '#b4a893', '#9b795d', '#d8a443', '#8a6f9e'];

    const DARK = {
        darkMode: true,
        background: '#1b1814',
        fontFamily: FONT,
        fontSize: '14px',
        primaryColor: '#231f1a',
        primaryTextColor: '#ece3d3',
        primaryBorderColor: '#5a4f42',
        secondaryColor: '#2d2822',
        secondaryTextColor: '#ece3d3',
        secondaryBorderColor: '#5a4f42',
        tertiaryColor: '#1f1b17',
        tertiaryTextColor: '#b4a893',
        tertiaryBorderColor: '#3b342b',
        mainBkg: '#231f1a',
        nodeBorder: '#5a4f42',
        nodeTextColor: '#ece3d3',
        textColor: '#ece3d3',
        titleColor: '#ece3d3',
        lineColor: '#9a8e7c',
        clusterBkg: '#1f1b17',
        clusterBorder: '#3b342b',
        edgeLabelBackground: '#1b1814',
        actorBkg: '#231f1a',
        actorBorder: '#5a4f42',
        actorTextColor: '#ece3d3',
        actorLineColor: '#7d7262',
        signalColor: '#b4a893',
        signalTextColor: '#ece3d3',
        labelBoxBkgColor: '#231f1a',
        labelBoxBorderColor: '#5a4f42',
        labelTextColor: '#ece3d3',
        loopTextColor: '#ece3d3',
        noteBkgColor: '#2d2822',
        noteTextColor: '#ece3d3',
        noteBorderColor: '#c35f2c',
        activationBkgColor: '#2d2822',
        activationBorderColor: '#c35f2c',
        pieTitleTextColor: '#ece3d3',
        pieSectionTextColor: '#14110e',
        pieLegendTextColor: '#ece3d3',
        pieStrokeColor: '#1b1814',
        pieOuterStrokeColor: '#3b342b',
    };

    const LIGHT = {
        darkMode: false,
        background: '#f7f5f0',
        fontFamily: FONT,
        fontSize: '14px',
        primaryColor: '#efebe3',
        primaryTextColor: '#22201c',
        primaryBorderColor: '#a39b8d',
        secondaryColor: '#f4efe5',
        secondaryTextColor: '#22201c',
        secondaryBorderColor: '#a39b8d',
        tertiaryColor: '#faf8f3',
        tertiaryTextColor: '#6b655b',
        tertiaryBorderColor: '#e3ddd2',
        mainBkg: '#efebe3',
        nodeBorder: '#a39b8d',
        nodeTextColor: '#22201c',
        textColor: '#22201c',
        titleColor: '#22201c',
        lineColor: '#6b655b',
        clusterBkg: '#f4efe5',
        clusterBorder: '#e3ddd2',
        edgeLabelBackground: '#f7f5f0',
        actorBkg: '#efebe3',
        actorBorder: '#a39b8d',
        actorTextColor: '#22201c',
        actorLineColor: '#a39b8d',
        signalColor: '#6b655b',
        signalTextColor: '#22201c',
        labelBoxBkgColor: '#efebe3',
        labelBoxBorderColor: '#a39b8d',
        labelTextColor: '#22201c',
        loopTextColor: '#22201c',
        noteBkgColor: '#f4efe5',
        noteTextColor: '#22201c',
        noteBorderColor: '#b4532a',
        activationBkgColor: '#f4efe5',
        activationBorderColor: '#b4532a',
        pieTitleTextColor: '#22201c',
        pieSectionTextColor: '#ffffff',
        pieLegendTextColor: '#22201c',
        pieStrokeColor: '#f7f5f0',
        pieOuterStrokeColor: '#e3ddd2',
    };

    function withSeries(vars) {
        const pie = Object.fromEntries(SERIES.map((color, index) => [`pie${index + 1}`, color]));
        return {
            ...vars,
            ...pie,
            pieOpacity: '1', // 默认 0.7，扇区和图例颜色对不上
            xyChart: {
                backgroundColor: vars.background,
                titleColor: vars.textColor,
                xAxisLabelColor: vars.textColor,
                xAxisTitleColor: vars.textColor,
                xAxisTickColor: vars.lineColor,
                xAxisLineColor: vars.lineColor,
                yAxisLabelColor: vars.textColor,
                yAxisTitleColor: vars.textColor,
                yAxisTickColor: vars.lineColor,
                yAxisLineColor: vars.lineColor,
                plotColorPalette: SERIES.join(', '),
            },
        };
    }

    // dark 为 true 用墨底配色，否则用浅色。extra 合进返回的配置（比如 securityLevel）。
    function config(dark = true, extra = {}) {
        return {
            startOnLoad: false,
            theme: 'base',
            themeVariables: withSeries(dark ? DARK : LIGHT),
            ...extra,
        };
    }

    // 认 #rgb、#rrggbb、rgb()/rgba()、color(srgb ...)，返回 0–1 的亮度；认不出返回 null。
    function luminance(value) {
        const text = String(value || '').trim();
        let rgb = null;
        const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
        if (hex) {
            const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
            rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
        } else if (/^rgba?\(/i.test(text)) {
            rgb = (text.match(/[\d.]+/g) || []).slice(0, 3).map((n) => Number(n) / 255);
        } else if (/^color\(srgb\s/i.test(text)) {
            rgb = (text.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        }
        if (!rgb || rgb.length < 3 || rgb.some((n) => !Number.isFinite(n))) return null;
        return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    }

    function isDarkColor(value) {
        const lum = luminance(value);
        return lum !== null && lum < 0.5;
    }

    // 图所在处的底色深不深：看那里的文字颜色——字是浅色，底就是深色。比找背景可靠：文坊编辑面是透明的，
    // 底色来自外层工作区，阅读面才是纸色。读不到颜色时按 fallback。
    function surfaceIsDark(element, fallback = true) {
        if (!element || typeof getComputedStyle !== 'function') return fallback;
        const lum = luminance(getComputedStyle(element).color);
        return lum === null ? fallback : lum > 0.5;
    }

    // 上游 10-24 起用 Pele 画 ```mermaid 图（c2481a97）。Pele 认 CSS 变量，同一套颜色写成 --pele-*，
    // 直接设在图的容器上；深浅照旧看图所在处的底色。
    function peleVars(dark = true) {
        const v = dark ? DARK : LIGHT;
        return {
            '--pele-bg': 'transparent',
            '--pele-fg': v.textColor,
            '--pele-muted': v.tertiaryTextColor,
            '--pele-line': v.lineColor,
            '--pele-border': v.primaryBorderColor,
            '--pele-surface': v.primaryColor,
            '--pele-surface-alt': v.secondaryColor,
            '--pele-accent': SERIES[0],
            '--pele-critical': SERIES[0],
            '--pele-font': FONT,
            ...Object.fromEntries(SERIES.map((color, index) => [`--pele-series-${index + 1}`, color])),
        };
    }

    function applyPele(element, fallback = true) {
        if (!element?.style) return;
        const vars = peleVars(surfaceIsDark(element, fallback));
        for (const [name, value] of Object.entries(vars)) element.style.setProperty(name, value);
    }

    return Object.freeze({ config, isDarkColor, surfaceIsDark, peleVars, applyPele });
});
