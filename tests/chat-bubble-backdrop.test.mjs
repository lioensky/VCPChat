import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('all chat modes keep the composer overlay free of backdrop-breaking masks', () => {
    const css = fs.readFileSync('styles/chat.css', 'utf8');
    const insetCss = fs.readFileSync('styles/ui-system/chat-composer-inset.css', 'utf8');
    const scrollerRule = insetCss.match(/html \.vcp-chat-composer-overlay > \.chat-messages-container:where\([^{}]+\)\s*\{([^}]+)\}/);
    assert.ok(scrollerRule);
    assert.doesNotMatch(scrollerRule[1], /(?:-webkit-)?mask-(?:image|size|position|repeat)\s*:/,
        'the message scroller must not receive a gradient mask');
    assert.match(insetCss, /\.vcp-chat-composer-backdrop-fade:where\([^{}]+\)\s*\{[^}]*pointer-events:\s*none;[^}]*mask-image:/,
        'only the sibling background copy receives the fade mask');
    assert.match(insetCss, /body:not\(\.chat-presentation-panel\):not\(\.chat-presentation-immersive\)/,
        'the background copy is enabled only in bubble mode');
    assert.match(css, /\.message-item\s*\{[^}]*content-visibility:\s*auto;/,
        'message offscreen optimization remains unchanged');
    assert.match(css, /\.message-item \.md-content\s*\{[^}]*backdrop-filter:\s*blur\(12px\);/,
        'bubble surfaces retain real wallpaper blur');
    assert.match(insetCss, /padding-bottom:\s*calc\(var\(--vcp-chat-composer-inset/,
        'composer overlay retains its message clearance');
});

test('presentation modes share composer width and padding', () => {
    const css = fs.readFileSync('styles/chat.css', 'utf8');
    const shellCss = fs.readFileSync('styles/ui-next.css', 'utf8');
    assert.match(shellCss, /html body \.chat-input-area\s*\{[^}]*padding-left:\s*clamp\(12px, [^;]+, 52px\);[^}]*padding-right:\s*clamp\(12px, [^;]+, 52px\);/);
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const [, selectors, declarations] = match;
        if (!/chat-presentation-(?:panel|immersive)/.test(selectors)) continue;
        if (!/\.chat-input-(?:area|card)/.test(selectors)) continue;
        assert.doesNotMatch(declarations, /(?:^|;)\s*(?:width|max-width|min-width|padding(?:-left|-right)?)\s*:/,
            'presentation-specific composer rules must not override shared geometry');
    }
});

test('flat reading modes retain one shared surface without extra composer or message plates', () => {
    const css = fs.readFileSync('styles/chat.css', 'utf8');
    const inputCss = fs.readFileSync('styles/ui-system/chat-input.css', 'utf8');
    assert.match(css, /html body\.light-theme:is\(\.chat-presentation-panel, \.chat-presentation-immersive\) \.message-item \.md-content\s*\{[^}]*background:\s*transparent !important;[^}]*backdrop-filter:\s*none !important;/);
    assert.match(css, /body\.chat-presentation-panel \.chat-messages-container,\s*body\.chat-presentation-immersive \.chat-messages-container\s*\{[^}]*background:\s*var\(--chat-presentation-surface\);[^}]*backdrop-filter:\s*var\(--chat-presentation-surface-filter\);/);
    assert.doesNotMatch(css, /body\.chat-presentation-(?:panel|immersive) \.chat-input-area\s*[,{]/);
    assert.doesNotMatch(inputCss, /body:is\(\.chat-presentation-panel, \.chat-presentation-immersive\)[^{]*\.chat-input-card\s*\{/);
});

test('main composer shares notification material without changing side composer or blur', () => {
    const css = fs.readFileSync('styles/ui-system/chat-input.css', 'utf8');
    const shellCss = fs.readFileSync('styles/ui-next.css', 'utf8');
    const rule = css.match(/html main\.main-content > \.chat-input-area\.vcp-ui-scope \.chat-input-card\s*\{([^}]+)\}/);
    assert.ok(rule, 'notification material is scoped to the main composer');
    assert.match(rule[1], /background:\s*var\(--next-shell-bg, var\(--panel-bg\)\);/);
    assert.match(rule[1], /background-image:\s*var\(--next-material-sheen, none\);/);
    assert.doesNotMatch(rule[1], /(?:backdrop-filter|padding|border-radius)\s*:/);
    assert.match(shellCss, /\.notifications-list \.notification-item\s*\{[^}]*background-color:\s*var\(--next-shell-bg\);[^}]*background-image:\s*var\(--next-material-sheen\);/);
    assert.match(css, /html \.vcp-ui-scope \.chat-input-card\s*\{[^}]*backdrop-filter:\s*blur\(10px\) saturate\(112%\);/);
});