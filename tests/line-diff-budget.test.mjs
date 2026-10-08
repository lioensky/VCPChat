import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {computeLineDiff,DIFF_LIMITS} from '../modules/ui-system/line-diff.js';
import {createCodeViewerSideProvider} from '../modules/ui-system/side-pane/codeViewerSideProvider.js';
const lines=(prefix,n)=>Array.from({length:n},(_,i)=>prefix+i);
const reconstruct=(result,side)=>result.rows.filter(r=>side==='old'?r.type!=='add':r.type!=='del').map(r=>r.text);
test('large disjoint files stay below the matrix budget and preserve both complete sides',()=>{
    const old=lines('old-',3000),next=lines('new-',3000),before=process.memoryUsage().arrayBuffers;
    const result=computeLineDiff(old.join('\n'),next.join('\n'));
    assert.ok(process.memoryUsage().arrayBuffers-before<1024*1024,'does not allocate a 3001 x 3001 matrix');
    assert.equal(result.approximate,true);assert.equal(result.addedCount,3000);assert.equal(result.deletedCount,3000);
    assert.deepEqual(reconstruct(result,'old'),old);assert.deepEqual(reconstruct(result,'new'),next);
});
test('unique-line anchors preserve unchanged hunks across distant edits in a large file',()=>{
    const old=lines('shared-',6000),next=[...old];next[2]='edited-start';next[5900]='edited-end';
    const result=computeLineDiff(old.join('\n'),next.join('\n'));
    assert.equal(result.addedCount,2);assert.equal(result.deletedCount,2);assert.equal(result.approximate,false);
    assert.deepEqual(reconstruct(result,'old'),old);assert.deepEqual(reconstruct(result,'new'),next);
});
test('line and character budgets reject before unbounded computation',()=>{
    assert.throws(()=>computeLineDiff('x'.repeat(DIFF_LIMITS.textChars+1),''),/文件过大/);
    assert.throws(()=>computeLineDiff('x\n'.repeat(DIFF_LIMITS.lines+1),''),/行数过多/);
    assert.deepEqual(computeLineDiff('a\nb\n','').rows.map(r=>r.type),['del','del']);
});
test('small repeated-line diffs reconstruct input and use a minimal LCS edit count',()=>{
    let seed=42;const random=()=>((seed=(seed*1664525+1013904223)>>>0)%4);
    for(let k=0;k<100;k++){
        const old=Array.from({length:12},()=>String(random())),next=Array.from({length:13},()=>String(random()));
        const result=computeLineDiff(old.join('\n'),next.join('\n'));let prev=new Int32Array(next.length+1);
        for(const value of old){const row=new Int32Array(next.length+1);for(let j=1;j<=next.length;j++)row[j]=value===next[j-1]?prev[j-1]+1:Math.max(prev[j],row[j-1]);prev=row;}
        assert.deepEqual(reconstruct(result,'old'),old);assert.deepEqual(reconstruct(result,'new'),next);
        assert.equal(result.addedCount+result.deletedCount,old.length+next.length-2*prev[next.length]);
    }
});
test('diff viewer pages DOM rows and preserves an intentionally empty new side',async()=>{
    const dom=new JSDOM('<div id="view"></div>');const view=dom.window.document.getElementById('view');
    const provider=createCodeViewerSideProvider({document:dom.window.document,api:{}});
    let handle=await provider.mountTab({id:'diff',payload:{mode:'diff',oldCode:lines('before-',1000).join('\n'),newCode:lines('after-',1000).join('\n')}},view);
    assert.equal(view.querySelectorAll('.side-diff-row').length,500);const more=[...view.querySelectorAll('button')].find(b=>b.textContent.includes('显示更多行'));more.click();assert.equal(view.querySelectorAll('.side-diff-row').length,1000);
    await handle.dispose();handle=await provider.mountTab({id:'delete',payload:{mode:'diff',code:'old',oldCode:'old',newCode:''}},view);
    assert.equal(view.querySelector('.side-diff-badge.add').textContent,'+0');assert.equal(view.querySelector('.side-diff-badge.del').textContent,'-1');
    await handle.dispose();dom.window.close();
});
