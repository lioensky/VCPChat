import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Notemodules/notes.css uses readable primary-text on active items and light dailynote-folder contrast', () => {
    const css = fs.readFileSync(path.resolve('Notemodules/notes.css'), 'utf8');
    const activeStart = css.indexOf('.note-list-panel .folder-header-row.active');
    const dragStart = css.indexOf('/* Styles for drag and drop */');
    assert.ok(activeStart !== -1 && dragStart > activeStart);
    const activeSection = css.slice(activeStart, dragStart);

    assert.doesNotMatch(activeSection, /--text-on-accent/);
    assert.match(activeSection, /color:\s*var\(--primary-text\)/);
    assert.match(css, /body\.light-theme \.note-list-panel \.dailynote-folder \.item-name[\s\S]*color:\s*var\(--primary-text\)/);
});
