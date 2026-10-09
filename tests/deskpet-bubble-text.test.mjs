import test from 'node:test';
import assert from 'node:assert/strict';
import { toBubbleText } from '../DeskPetmodules/bubbleText.js';

test('bubble text drops markdown markers but keeps the words', () => {
    const reply = [
        '## 第一部分：概览',
        '',
        '这是一段**比较长**的回复，有 *强调*、`行内代码`、~~删掉~~ 和 [一个链接](https://example.com)：',
        '',
        '![示意图](https://example.com/a.png)',
        '',
        '- 第一项',
        '* 第二项',
        '  + 缩进的第三项',
        '1. 有序的保留',
        '',
        '---',
        '> 引用一句话',
    ].join('\n');
    assert.equal(toBubbleText(reply), [
        '第一部分：概览',
        '这是一段比较长的回复，有 强调、行内代码、删掉 和 一个链接：',
        '[图片]',
        '• 第一项',
        '• 第二项',
        '  • 缩进的第三项',
        '1. 有序的保留',
        '引用一句话',
    ].join('\n'));
});

test('bubble text strips html tags and keeps plain comparisons and arithmetic', () => {
    assert.equal(toBubbleText('<div class="x">你好<br>世界</div><img src="a.png">'), '你好\n世界[图片]');
    assert.equal(toBubbleText('3 < 5 并且 2*3*4 = 24，a_b_c 不变'), '3 < 5 并且 2*3*4 = 24，a_b_c 不变');
    assert.equal(toBubbleText('&lt;tag&gt; &amp; 空格&nbsp;'), '<tag> & 空格');
});

test('bubble text leaves an unfinished marker alone while the reply is still streaming', () => {
    assert.equal(toBubbleText('这一点**很重'), '这一点**很重');
    assert.equal(toBubbleText('这一点**很重要**'), '这一点很重要');
    assert.equal(toBubbleText(''), '');
    assert.equal(toBubbleText(null), '');
});
