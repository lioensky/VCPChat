import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeVcpDocument, transformVcpMarkdown } from '../modules/renderer/vcpDocumentScanner.js';
import { createContentPipeline } from '../modules/renderer/contentPipeline.js';
import { createStableBoundaryState, findExplicitStablePrefix } from '../modules/renderer/streamStableBoundary.js';

function checkPartition(source, options) {
    const regions = tokenizeVcpDocument(source, options);
    let cursor = 0;
    for (const region of regions) {
        assert.equal(region.start, cursor);
        assert.ok(region.end > region.start);
        cursor = region.end;
    }
    assert.equal(cursor, source.length);
    assert.equal(regions.map(r => source.slice(r.start, r.end)).join(''), source);
    return regions;
}

test('document regions losslessly partition opaque payloads and editable prose', () => {
    const source = [
        'prose `inline`',
        '~~~html',
        '<style>.code{}</style>',
        '~~~',
        '<!-- <style>.comment{}</style> -->',
        '<script>const s = `<style>.script{}</style>`;</script>',
        '<div data-example="<style>.attribute{}</style>">',
        '<style>.real{color:red}</style></div>',
        '<think>',
        '<style>.thought{}</style>',
        '</think>',
        '[[VCP调用结果信息汇总:',
        '<style>.result{}</style>',
        'VCP调用结果结束]]',
    ].join('\n');
    const regions = checkPartition(source);
    const styles = regions.filter(r => r.kind === 'style');
    assert.equal(styles.length, 1);
    assert.equal(source.slice(styles[0].start, styles[0].end), '<style>.real{color:red}</style>');
    assert.ok(regions.some(r => r.kind === 'thought-chain'));
    assert.ok(regions.some(r => r.kind === 'script'));
    assert.ok(regions.some(r => r.kind === 'tool-result'));
});

test('tool requests use field-aware ends; desktop pushes own their complete payload', () => {
    const request = '<<<[TOOL_REQUEST]>>>\ntext:「始ESCAPE」'
        + '<<<[END_TOOL_REQUEST]>>><style>.payload{}</style>「末ESCAPE」\n'
        + '<<<[END_TOOL_REQUEST]>>>';
    const push = '<<<[DESKTOP_PUSH]>>><style>.push{}</style><<<[DESKTOP_PUSH_END]>>>';
    const regions = checkPartition(request + '\n' + push);
    assert.equal(regions[0].kind, 'tool-request');
    assert.equal(regions[0].end, request.length);
    assert.equal(regions.at(-1).kind, 'desktop-push');
    assert.equal(regions.at(-1).closed, true);
    assert.equal(regions.filter(r => r.kind === 'style').length, 0);
});

test('authoritative tool data is a hard boundary even inside unfinished comments or fences', () => {
    const result = '[[VCP调用结果信息汇总:\n<style>.data{}</style>\nVCP调用结果结束]]';
    for (const prefix of ['<!-- unfinished\n', '~~~html\n']) {
        const source = prefix + result + '\n<style>.after{}</style>';
        const regions = checkPartition(source, { mode: 'stream' });
        assert.ok(regions.some(r => r.kind === 'tool-result' && r.start === prefix.length));
        assert.equal(transformVcpMarkdown(source, () => 'PROSE', { mode: 'stream' }).includes(result), true);
    }
});

test('atomic batch payloads cannot expose malformed legacy markers or executable HTML', () => {
    const batch = '<<<[VCP_TOOL_BATCH_START:stamp]>>>\n[[VCP调用结果信息汇总:\n'
        + '<style>.data{}</style>\n<<<[VCP_TOOL_BATCH_END:stamp]>>>';
    const regions = checkPartition(batch + '\n<style>.after{}</style>');
    assert.equal(regions[0].kind, 'tool-batch');
    assert.equal(regions[0].end, batch.length);
    assert.equal(regions.filter(r => r.kind === 'style').length, 1);
});

test('stream-only inline protection is released by final mode and paragraph boundaries', () => {
    const source = 'text `<style>.partial{}</style>';
    assert.equal(checkPartition(source, { mode: 'stream' }).at(-1).kind, 'inline-code');
    assert.equal(checkPartition(source).at(-1).kind, 'style');
    const bounded = checkPartition(source + '\n\n<style>.real{}</style>', { mode: 'stream' });
    assert.equal(bounded.filter(r => r.kind === 'style').length, 2);
});

test('URL normalization mutates prose and img tags but preserves code, scripts and tool parameters', () => {
    const pipeline = createContentPipeline({
        fixEmoticonUrlsInMarkdown: text => text.replaceAll('old.png', 'new.png'),
    });
    const source = '![prose](old.png)\n`old.png`\n<img src="old.png">\n'
        + '<script>const src="old.png";</script>\n'
        + '<<<[TOOL_REQUEST]>>>text:「始」old.png「末」<<<[END_TOOL_REQUEST]>>>';
    const processed = pipeline.process(source);
    const result = processed.text;
    assert.match(result, /!\[prose\]\(new\.png\)/);
    assert.match(result, /<img src="new\.png">/);
    assert.match(result, /`old\.png`/);
    assert.match([...processed.state.rawScriptMap.values()].join(''), /const src="old\.png"/);
    assert.match(result, /text:「始」old\.png「末」/);
});

test('stable boundary state memoizes exact source and invalidates edits, truncations and resets', () => {
    const scanner = createStableBoundaryState();
    const original = 'A\n\nB\n\nC';
    assert.deepEqual(scanner.update(original), { cutoff: 3, revised: false });
    assert.deepEqual(scanner.update(original), { cutoff: 3, revised: false });
    assert.equal(scanner.getDiagnostics().scans, 1);
    assert.equal(scanner.getDiagnostics().hits, 1);
    const edited = 'X\n\nY\n\nZ';
    assert.deepEqual(scanner.update(edited), { cutoff: 3, revised: true });
    assert.deepEqual(scanner.update('X'), { cutoff: 0, revised: true });
    assert.deepEqual(scanner.update(''), { cutoff: 0, revised: true });
    scanner.reset();
    assert.equal(scanner.getDiagnostics().retainedChars, 0);
    assert.equal(scanner.update(original).revised, false);
});

test('stateful compatibility path matches reference at every chunk split without assuming EOF closure', () => {
    for (const source of [
        'A\n\nB\n\n~~~js\nx\n~~~\nC',
        'A\n\nB\n\n`unfinished\n\nC\n\nD',
        '<<<[TOOL_REQUEST]>>>text:「始ESCAPE」x「末ESCAPE」<<<[END_TOOL_REQUEST]>>>tail',
        '<div><style>.a{}</style><script>const a=`x`;</script></div>tail',
        '[[VCP调用结果信息汇总:\n```\nVCP调用结果结束]]\n<<<[END_ROLE_DIVIDE_USER]>>>\ntail',
    ]) {
        const state = createStableBoundaryState();
        const trustedState = createStableBoundaryState();
        const appendEpoch = {};
        let cutoff = 0;
        for (let end = 1; end <= source.length; end++) {
            const text = source.slice(0, end);
            cutoff = findExplicitStablePrefix(text, cutoff);
            assert.equal(state.update(text).cutoff, cutoff);
            assert.equal(trustedState.update(text, { appendEpoch }).cutoff, cutoff);
        }
        assert.equal(trustedState.getDiagnostics().prefixChecks, 0);
    }
});

test('backticks opened in comments, scripts and attributes never escape their owning domain', () => {
    for (const opaque of [
        '<!-- ` -->',
        '<script>const s = "`";</script>',
        '<div data-example="`">',
    ]) {
        const source = opaque + '\n<style>.real{color:red}</style>\n`';
        const regions = checkPartition(source);
        assert.equal(regions.filter(r => r.kind === 'style').length, 1, opaque);
    }
});

test('owner append epochs skip prefix comparisons and memoize unchanged visible lengths', () => {
    const state = createStableBoundaryState();
    const appendEpoch = {};
    let cutoff = 0;
    for (const source of ['A\n\nB\n\nC', 'A\n\nB\n\nC more', 'A\n\nB\n\nC more\n\nD']) {
        cutoff = findExplicitStablePrefix(source, cutoff);
        assert.deepEqual(state.update(source, { appendEpoch }), { cutoff, revised: false });
    }
    const before = state.getDiagnostics();
    assert.deepEqual(state.update('A\n\nB\n\nC more\n\nD', { appendEpoch }), { cutoff, revised: false });
    const after = state.getDiagnostics();
    assert.equal(after.scans, before.scans);
    assert.equal(after.hits, before.hits + 1);
    assert.equal(after.prefixChecks, 0);
    assert.equal(after.trustedUpdates, 4);
});

test('owner epoch replacement invalidates equal-length edits and prefix-preserving replacements', () => {
    const state = createStableBoundaryState();
    assert.equal(state.update('A\n\nB\n\nC', { appendEpoch: {} }).cutoff, 3);
    assert.deepEqual(state.update('X\n\nY\n\nZ', { appendEpoch: {} }), { cutoff: 3, revised: true });
    assert.deepEqual(state.update('X\n\nY\n\nZ appended', { appendEpoch: {} }), { cutoff: 3, revised: true });
    assert.equal(state.getDiagnostics().prefixChecks, 0);
    assert.equal(state.getDiagnostics().revisions, 2);
});

test('visible rollback resets an owner cutoff while later expansion can reuse the epoch', () => {
    const state = createStableBoundaryState();
    const appendEpoch = {};
    const source = 'A\n\nB\n\nC';
    assert.equal(state.update(source, { appendEpoch }).cutoff, 3);
    assert.deepEqual(state.update('A', { appendEpoch }), { cutoff: 0, revised: true });
    assert.deepEqual(state.update(source, { appendEpoch }), { cutoff: 3, revised: false });
    assert.deepEqual(state.update('', { appendEpoch }), { cutoff: 0, revised: true });
    state.reset();
    assert.deepEqual(state.update(source, { appendEpoch }), { cutoff: 3, revised: false });
});

test('generic callers retain exact checks and cannot inherit a stale trusted chain', () => {
    const state = createStableBoundaryState();
    const appendEpoch = {};
    const original = 'A\n\nB\n\nC';
    state.update(original, { appendEpoch });
    state.update(original); // Even an exact generic hit breaks owner trust.
    assert.equal(state.update(original + ' more', { appendEpoch }).revised, true);
    assert.deepEqual(state.update('X\n\nY\n\nZ'), { cutoff: 3, revised: true });
    assert.deepEqual(state.update('X'), { cutoff: 0, revised: true });
    assert.deepEqual(state.update('Y', { appendEpoch: 'not-an-owner-token' }), { cutoff: 0, revised: true });
    assert.equal(state.getDiagnostics().prefixChecks, 3);
});