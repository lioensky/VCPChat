import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('bubble mode avoids message paint containment while retaining its backdrop blur', () => {
    const css = fs.readFileSync('styles/chat.css', 'utf8');
    assert.match(css, /body:not\(\.chat-presentation-panel\):not\(\.chat-presentation-immersive\) \.message-item\s*\{[^}]*content-visibility:\s*visible;[^}]*contain-intrinsic-size:\s*auto;/);
    assert.match(css, /\.message-item\s*\{[^}]*content-visibility:\s*auto;/,
        'panel and immersive retain the default offscreen optimization');
    assert.match(css, /\.message-item \.md-content\s*\{[^}]*backdrop-filter:\s*blur\(12px\);/,
        'bubble surfaces retain real wallpaper blur');
});