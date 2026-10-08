import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
const source = fs.readFileSync('modules/renderer/toolPresentation.js','utf8');
const {createToolPresentation,toolStatus} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const req=()=>`<div class="vcp-tool-use-bubble" data-vcp-block-type="tool-use"><div class="vcp-tool-summary"><span class="vcp-tool-label">VCP-ToolUse:</span><span class="vcp-tool-name-highlight">ProjectForge</span></div><div class="vcp-tool-details"></div><template class="vcp-tool-details-template"><pre>tool_name:「始」ProjectForge「末」\ncommand:「始」GetCode「末」\npath:「始」demo/index.html「末」</pre></template></div>`;
const res=(status='SUCCESS',hash='h',body='真实结果')=>`<div class="vcp-tool-result-bubble collapsible" data-vcp-block-type="tool-result" data-vcp-tool-result-index="2" data-vcp-tool-result-hash="${hash}"><div class="vcp-tool-result-header"><span class="vcp-tool-result-label">VCP-ToolResult</span><span class="vcp-tool-result-name">ProjectForge</span><span class="vcp-tool-result-status">${status}</span><span class="vcp-result-toggle-icon"></span><button class="vcp-tool-result-delete-btn">删除</button></div><div class="vcp-tool-result-collapsible-content"><div class="vcp-tool-result-details">${body}</div></div></div>`;
const summary='<div class="vcp-tool-call-summary-bubble" data-vcp-block-type="tool-call-summary"><div class="vcp-tool-call-summary-header"><span class="vcp-tool-call-summary-icon">图标</span><span class="vcp-tool-call-summary-title">本轮工具调用摘要</span></div><div class="vcp-tool-call-summary-list"><span>ProjectForge 成功</span></div></div>';
function fixture(html,p={toolPresentation:'grouped',toolExpansion:'attention'}){
 const dom=new JSDOM(`<html data-ui-mode="next"><body><div id="root"><article class="message-item"><div class="md-content">${html}</div></article></div></body></html>`,{url:'https://vcp.local/'});
 const root=dom.window.document.getElementById('root'),content=root.querySelector('.md-content');
 const presenter=createToolPresentation({root,getProfile:()=>p});
 return {dom,root,content,p,presenter,apply:()=>presenter.apply(content),close:()=>{presenter.dispose();dom.window.close();}};
}
test('unknown and misleading status never becomes success',()=>{
 assert.equal(toolStatus('SUCCESS'),'success');assert.equal(toolStatus('❌ ERROR'),'failed');assert.equal(toolStatus('success but error?'),'unknown');assert.equal(toolStatus(''),'unknown');
});
test('Legacy remains exact; new mode round-trips original headers and summary',()=>{
 const f=fixture(req()+res()+summary,{toolPresentation:'legacy'});const before=f.content.innerHTML;f.apply();assert.equal(f.content.innerHTML,before);
 f.p.toolPresentation='grouped';f.apply();assert.equal(f.content.querySelectorAll('.vcp-tool-row-toggle').length,3);
 f.p.toolPresentation='legacy';f.apply();assert.equal(f.content.innerHTML,before);f.close();
});
test('Classic and auxiliary documents keep the existing renderer even with a Next preference',()=>{
 const f=fixture(req()+res());f.dom.window.document.documentElement.dataset.uiMode='classic';const before=f.content.innerHTML;f.apply();assert.equal(f.content.innerHTML,before);f.close();
});
test('counts are requests/results, no fabricated pairing and no crossing text/roles',()=>{
 const f=fixture(req()+req()+res('ERROR')+'<p>说明文字</p>'+res('SUCCESS','b')+'<div data-vcp-block-type="role-divider">User</div>'+req());f.apply();
 const groups=[...f.content.querySelectorAll('.vcp-tool-process')];assert.equal(groups.length,3);assert.match(groups[0].textContent,/2 请求 1 结果/);assert.match(groups[0].textContent,/1 失败/);
 assert.equal(f.content.querySelectorAll('.vcp-tool-presented').length,5);f.close();
});
test('failures visible; unknown stays unknown; exact delete button preserved',()=>{
 const f=fixture(res('ERROR')+res('Unknown Status','b'));const original=f.content.querySelector('.vcp-tool-result-delete-btn');f.apply();
 const failed=f.content.querySelector('[data-vcp-tool-state="failed"]');assert.ok(failed.classList.contains('expanded'));assert.equal(failed.dataset.vcpToolResultHash,'h');assert.equal(failed.dataset.vcpToolResultIndex,'2');assert.equal(failed.querySelector('.vcp-tool-result-delete-btn'),original);assert.equal(failed.querySelector('.vcp-tool-row-toggle').contains(original),false);
 assert.match(f.content.querySelector('.vcp-tool-process-stats').textContent,/状态未知/);f.close();
});
test('request lazily mounts; repeated apply keeps name and user disclosure state',()=>{
 const f=fixture(req());f.apply();assert.equal(f.content.querySelector('.vcp-tool-details').childNodes.length,0);
 f.content.querySelector('.vcp-tool-row-toggle').click();assert.equal(f.content.querySelectorAll('.vcp-tool-details pre').length,1);f.apply();f.apply();assert.match(f.content.querySelector('.vcp-tool-row-title').textContent,/读取源码/);assert.equal(f.content.querySelectorAll('.vcp-tool-details pre').length,1);
 f.content.querySelector('.vcp-tool-row-toggle').click();assert.equal(f.content.querySelector('.vcp-tool-details').childNodes.length,0);f.close();
});
test('repeated identical requests remain separate and preserve their own states on terminal replacement',()=>{
 const html=req()+req();const f=fixture(html);f.apply();const buttons=f.content.querySelectorAll('.vcp-tool-row-toggle');buttons[1].click();f.presenter.capture(f.content);f.content.innerHTML=html;f.apply();const nodes=f.content.querySelectorAll('.vcp-tool-presented');assert.notEqual(nodes[0].dataset.vcpToolKey,nodes[1].dataset.vcpToolKey);assert.equal(nodes[0].classList.contains('expanded'),false);assert.equal(nodes[1].classList.contains('expanded'),true);f.close();
});
test('folded group keeps failure count and rich result entry outside body',()=>{
 const f=fixture(res('ERROR')+res('SUCCESS','img','<img class="vcp-tool-result-image" src="https://local.test/image.png" alt="图片">'),{toolPresentation:'grouped',toolExpansion:'none'});f.apply();
 assert.equal(f.content.querySelector('.vcp-tool-process-body').hidden,true);assert.match(f.content.querySelector('.vcp-tool-process-stats').textContent,/失败/);
 const artifact=f.content.querySelector('.vcp-tool-process-artifact');assert.equal(artifact.closest('.vcp-tool-process-body'),null);artifact.click();assert.equal(f.content.querySelector('.vcp-tool-process-body').hidden,false);assert.ok(f.content.querySelector('[data-vcp-tool-result-hash="img"]').classList.contains('expanded'));f.close();
});
test('summary details can collapse and dispose removes capture listeners',()=>{
 const f=fixture(summary);f.apply();assert.equal(f.content.querySelector('.vcp-tool-presented').classList.contains('expanded'),false);const b=f.content.querySelector('.vcp-tool-row-toggle');b.click();assert.equal(b.getAttribute('aria-expanded'),'true');f.presenter.dispose();b.click();assert.equal(b.getAttribute('aria-expanded'),'true');f.close();
});
test('appearance event immediately updates and cancels preview on existing DOM',()=>{
 const f=fixture(req(),{toolPresentation:'legacy'});f.apply();f.p.toolPresentation='compact';f.dom.window.dispatchEvent(new f.dom.window.Event('vcp-appearance-changed'));assert.equal(f.content.querySelectorAll('.vcp-tool-row-toggle').length,1);f.p.toolPresentation='legacy';f.dom.window.dispatchEvent(new f.dom.window.Event('vcp-appearance-changed'));assert.equal(f.content.querySelectorAll('.vcp-tool-row-toggle').length,0);f.close();
});
test('preview uses event payload even if getCurrent is published a moment later',()=>{
 const f=fixture(req(),{toolPresentation:'legacy'});f.apply();f.dom.window.dispatchEvent(new f.dom.window.CustomEvent('vcp-appearance-changed',{detail:{profile:{toolPresentation:'compact'}}}));assert.equal(f.content.querySelectorAll('.vcp-tool-row-toggle').length,1);f.close();
});
test('late file-change actions retain their identity and click handler across previews',()=>{
 const f=fixture(res());f.apply();let clicks=0;const badge=f.dom.window.document.createElement('button');badge.className='vcp-file-changes-counts';badge.textContent='+1 -1';badge.addEventListener('click',()=>clicks++);f.content.querySelector('.vcp-tool-result-header').append(badge);f.apply();assert.equal(f.content.querySelector('.vcp-file-changes-counts'),badge);badge.click();assert.equal(clicks,1);f.p.toolPresentation='legacy';f.apply();assert.equal(f.content.querySelector('.vcp-file-changes-counts'),badge);f.close();
});
test('stable stream segments retain individual choices when finalized into the canonical tree',()=>{
 const f=fixture(`<div class="vcp-stream-stable-block">${req()}</div><div class="vcp-stream-stable-block">${req()}</div>`);
 for(const block of f.content.querySelectorAll('.vcp-stream-stable-block'))f.presenter.apply(block);
 f.content.querySelectorAll('.vcp-tool-row-toggle')[1].click();f.presenter.capture(f.content);f.content.innerHTML=req()+req();f.apply();assert.equal(f.content.querySelectorAll('.vcp-tool-presented')[1].classList.contains('expanded'),true);f.close();
});

test('none expansion keeps rich rows folded until explicitly opened',()=>{
 const f=fixture(res('SUCCESS','media','<img class="vcp-tool-result-image" src="https://local.test/image.png">'),{toolPresentation:'compact',toolExpansion:'none'});f.apply();const block=f.content.querySelector('.vcp-tool-presented');assert.equal(block.classList.contains('expanded'),false);f.content.querySelector('.vcp-tool-row-toggle').click();assert.equal(block.classList.contains('expanded'),true);f.close();
});
test('unknown command names cannot inherit object prototype summaries',()=>{
 const f=fixture(req().replace('GetCode','constructor'));f.apply();assert.match(f.content.querySelector('.vcp-tool-row-title').textContent,/ProjectForge · constructor/);f.close();
});
const shell=(cmd)=>req().replaceAll('ProjectForge','PowerShellExecutor').replace('GetCode','ExecutePowerShell').replace('path:「始」demo/index.html「末」',`powershell:「始」${cmd}「末」`);
const shellRes=(status,hash,body)=>res(status,hash,body).replaceAll('ProjectForge','PowerShellExecutor');
const search=()=>req().replace('GetCode','SearchProjects').replace('path:「始」demo/index.html「末」','query:「始」createToolPresentation「末」');
test('single-line merge folds only the adjacent same-name result into the request row',()=>{
 const f=fixture(req()+res()+req()+shellRes('SUCCESS','x')+res('SUCCESS','late'),{toolPresentation:'inline',toolExpansion:'attention'});const del=f.content.querySelector('.vcp-tool-result-delete-btn');f.apply();
 const blocks=[...f.content.querySelectorAll('.vcp-tool-presented')];
 assert.equal(blocks[1].dataset.vcpToolMerged,'true');assert.equal(blocks[3].dataset.vcpToolMerged,undefined);assert.equal(blocks[4].dataset.vcpToolMerged,undefined);
 assert.notEqual(blocks[0].dataset.vcpToolKey,blocks[1].dataset.vcpToolKey);assert.equal(blocks[1].querySelector('.vcp-tool-result-delete-btn'),del);
 const row=blocks[0].querySelector('.vcp-tool-row-toggle');assert.match(row.textContent,/已读取/);assert.match(row.textContent,/demo\/index\.html/);
 assert.equal(blocks[2].dataset.vcpToolPending,'true');assert.match(blocks[2].querySelector('.vcp-tool-row-toggle').textContent,/^读取/);
 row.click();assert.ok(blocks[0].classList.contains('expanded'));assert.ok(blocks[1].classList.contains('expanded'));
 blocks[1].querySelector('.vcp-tool-row-toggle').click();assert.equal(blocks[0].classList.contains('expanded'),false);assert.equal(blocks[1].classList.contains('expanded'),false);f.close();
});
test('single-line merge shows failures as a problem label with the first error line, and opens the pair',()=>{
 const f=fixture(shell('npm test')+shellRes('ERROR','e','<p>Error: exit code 1</p><p>more</p>'),{toolPresentation:'inline',toolExpansion:'attention'});f.apply();
 const [request,result]=f.content.querySelectorAll('.vcp-tool-presented');const state=request.querySelector('.vcp-tool-row-state');
 assert.equal(state.textContent,'执行失败');assert.equal(state.title,'Error: exit code 1');assert.match(request.querySelector('.vcp-tool-row-resource').textContent,/npm test/);
 assert.ok(request.classList.contains('expanded'));assert.ok(result.classList.contains('expanded'));f.close();
});
test('single-line merge groups consecutive commands and lookups, but not across text or kinds',()=>{
 const f=fixture(shell('a')+shellRes('SUCCESS','1')+shell('b')+shellRes('ERROR','2')+req()+res('SUCCESS','3')+search()+'<p>说明</p>'+req(),{toolPresentation:'inline',toolExpansion:'none'});f.apply();
 const groups=[...f.content.querySelectorAll('.vcp-tool-process')];assert.equal(groups.length,2);
 assert.equal(groups[0].dataset.variant,'inline');assert.match(groups[0].querySelector('.vcp-tool-process-toggle').textContent,/终端2 个命令，1 个失败/);
 assert.match(groups[1].querySelector('.vcp-tool-process-toggle').textContent,/查阅1 个文件，1 次搜索/);
 assert.equal(f.content.lastElementChild.closest('.vcp-tool-process'),null);f.close();
});
test('turn fold collapses the finished process but keeps it out while streaming',()=>{
 const html=req()+res()+'<p>中间说明</p>'+shell('dir')+shellRes('ERROR','e','<p>denied</p>')+'<p>最终回答</p>';
 const f=fixture(html,{toolPresentation:'process',toolExpansion:'attention'});const message=f.content.closest('.message-item');message.classList.add('streaming');f.apply();
 assert.equal(f.content.querySelector('.vcp-tool-process'),null);
 message.classList.remove('streaming');f.presenter.capture(f.content);f.content.innerHTML=html;f.apply();
 const fold=f.content.querySelector('.vcp-tool-process');assert.equal(fold.dataset.variant,'turn');assert.equal(fold.dataset.vcpBlockType,undefined);
 assert.equal(fold.querySelector('.vcp-tool-process-toggle').dataset.vcpBlockType,'tool-process');
 assert.match(fold.textContent,/已处理 · 2 次工具调用/);assert.match(fold.querySelector('.vcp-tool-process-stats').textContent,/1 个失败/);
 assert.equal(fold.querySelector('.vcp-tool-process-body').hidden,true);assert.ok(fold.querySelector('.vcp-tool-process-body').textContent.includes('中间说明'));
 assert.equal(f.content.lastElementChild.textContent,'最终回答');
 const failedRow=fold.querySelector('[data-vcp-tool-call-state="failed"] .vcp-tool-row-resource');assert.equal(failedRow.textContent,'denied');f.close();
});
test('switching modes clears merge marks and legacy still restores the exact markup',()=>{
 const f=fixture(req()+res()+shell('a')+shellRes('SUCCESS','x'),{toolPresentation:'inline'});const before=f.content.innerHTML;f.apply();
 assert.ok(f.content.querySelector('[data-vcp-tool-merged]'));
 f.p.toolPresentation='grouped';f.apply();assert.equal(f.content.querySelector('[data-vcp-tool-merged], [data-vcp-tool-kind], [data-vcp-tool-pending]'),null);
 f.p.toolPresentation='process';f.apply();assert.ok(f.content.querySelector('.vcp-tool-process[data-variant="turn"]'));
 f.p.toolPresentation='legacy';f.apply();assert.equal(f.content.innerHTML,before);f.close();
});
const chip=(tool,key,label)=>`<span class="vcp-tool-call-summary-chip status-${key}"><span class="vcp-tool-call-summary-tool">${tool}</span><span class="vcp-tool-call-summary-status">${label}</span></span>`;
const chipSummary=(...chips)=>`<div class="vcp-tool-call-summary-bubble" data-vcp-block-type="tool-call-summary"><div class="vcp-tool-call-summary-header"><span class="vcp-tool-call-summary-icon">图标</span><span class="vcp-tool-call-summary-title">本轮工具调用摘要</span></div><div class="vcp-tool-call-summary-list">${chips.join('')}</div></div>`;
test('call summary renders as an ordinary row with a tool count and the problem counts',()=>{
 for(const style of ['process','inline']){
  const f=fixture(chipSummary(chip('FileOperator','success','成功'),chip('LocalSearchController','failure','失败')),{toolPresentation:style,toolExpansion:'none'});f.apply();
  const block=f.content.querySelector('.vcp-tool-call-summary-bubble');const row=block.querySelector('.vcp-tool-row-toggle');
  assert.equal(row.querySelector('.vcp-tool-row-title').textContent,'调用摘要');assert.equal(row.querySelector('.vcp-tool-row-resource').textContent,'2 个工具，1 个失败');
  assert.equal(row.querySelector('.vcp-tool-row-state'),null);assert.equal(block.dataset.vcpToolCallState,'failed');assert.equal(row.querySelectorAll('.vcp-tool-row-chevron svg').length,1);
  row.click();assert.ok(block.classList.contains('expanded'));assert.equal(block.querySelectorAll('.vcp-tool-call-summary-content .vcp-tool-call-summary-chip').length,2);f.close();
 }
 const f=fixture(chipSummary(chip('FileOperator','success','成功')),{toolPresentation:'process'});f.apply();
 assert.equal(f.content.querySelector('.vcp-tool-call-summary-bubble').dataset.vcpToolCallState,undefined);assert.equal(f.content.querySelector('.vcp-tool-row-resource').textContent,'1 个工具');f.close();
});
test('rows without a known verb keep the tool name as title and the command as summary',()=>{
 const list=req().replaceAll('ProjectForge','FileOperator').replace('GetCode','ListDirectory').replace('\npath:「始」demo/index.html「末」','');
 const f=fixture(list,{toolPresentation:'process'});f.apply();const row=f.content.querySelector('.vcp-tool-row-toggle');
 assert.equal(row.querySelector('.vcp-tool-row-title').textContent,'FileOperator');assert.equal(row.querySelector('.vcp-tool-row-resource').textContent,'ListDirectory');
 assert.equal(row.title,'FileOperator · ListDirectory');f.close();
});
test('result-only rows take their kind from the tool name',()=>{
 const f=fixture(res('ERROR','s','<p>refused</p>').replaceAll('ProjectForge','LocalSearchController'),{toolPresentation:'process'});f.apply();
 const block=f.content.querySelector('.vcp-tool-presented');assert.equal(block.dataset.vcpToolKind,'search');assert.equal(block.querySelector('.vcp-tool-row-title').textContent,'LocalSearchController');
 assert.equal(block.querySelector('.vcp-tool-row-resource').textContent,'refused');f.close();
});
test('grouped titles read cleanly, carry no filler badge, and the summary row says what ran',()=>{
 const f=fixture(res('SUCCESS','a')+res('SUCCESS','b')+'<p>说明</p>'+req()+req());f.apply();
 const [results,requests]=f.content.querySelectorAll('.vcp-tool-process');
 assert.equal(results.querySelector('.vcp-tool-process-title').textContent,'工具过程 · 2 结果');assert.equal(requests.querySelector('.vcp-tool-process-stats').textContent,'');f.close();
 const s=fixture(chipSummary(chip('FileOperator','success','成功'),chip('LocalSearchController','failure','失败')));s.apply();
 const row=s.content.querySelector('.vcp-tool-call-summary-bubble .vcp-tool-row-toggle');
 assert.equal(row.querySelector('.vcp-tool-row-title').textContent,'调用摘要');assert.equal(row.querySelector('.vcp-tool-row-resource').textContent,'2 个工具，1 个失败');assert.equal(row.querySelector('.vcp-tool-row-state'),null);s.close();
});
test('a divider pair that wraps only results is a result shell; any other divider still ends a group',()=>{
 const wrap=(role,inner)=>`<div class="vcp-role-divider role-${role} type-start" data-vcp-block-type="role-divider">s</div>${inner}<div class="vcp-role-divider role-${role} type-end" data-vcp-block-type="role-divider">e</div>`;
 const html=req()+wrap('user',res())+req()+wrap('user','<p>用户插话</p>'+res('SUCCESS','b'))+req()+wrap('user',res('SUCCESS','c')).replace('role-user type-end','role-system type-end');
 const f=fixture(html);const before=f.content.innerHTML;f.apply();
 const shells=[...f.content.querySelectorAll('[data-vcp-tool-wrapper="true"]')];assert.equal(shells.length,2);assert.ok(shells.every(n=>n.closest('.vcp-tool-process')===f.content.querySelector('.vcp-tool-process')));
 assert.match(f.content.querySelector('.vcp-tool-process-title').textContent,/2 请求 1 结果/);
 f.p.toolPresentation='legacy';f.apply();assert.equal(f.content.innerHTML,before);f.close();
});
