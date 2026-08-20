(() => {
    const title = document.querySelector('#title');
    const summary = document.querySelector('#summary');
    const bar = document.querySelector('#bar');
    const checks = document.querySelector('#checks');
    const log = document.querySelector('#log');
    const repairButton = document.querySelector('#repair');
    const safeButton = document.querySelector('#safe');
    const launchButton = document.querySelector('#launch');
    const cancelButton = document.querySelector('#cancel');
    const plan = document.querySelector('#plan');
    let operationActive = false;
    const write = text => { log.hidden = false; log.textContent += text; log.scrollTop = log.scrollHeight; };
    const renderDoctor = report => {
        checks.textContent = '';
        report.checks.forEach(item => {
            const row = document.createElement('div'); row.className = 'check';
            const name = document.createElement('span'); name.textContent = `${item.status === 'pass' ? '✓' : item.status === 'warn' ? '!' : '✗'} ${item.id}`;
            const message = document.createElement('small'); message.textContent = item.message;
            row.append(name, message); checks.append(row);
        });
        const blocked = !report.ok;
        title.textContent = blocked ? '需要处理运行环境' : '可以启动 VCPChat';
        summary.textContent = blocked ? '修复是显式操作；在确认前不会安装、重建或修改项目。' : '核心检查已通过，托管入口可以等待真实 renderer ready。';
        repairButton.hidden = !blocked; safeButton.hidden = !blocked; launchButton.hidden = blocked;
        bar.style.width = `${Math.max(8, Math.round((report.summary.pass / Math.max(1, report.checks.length)) * 100))}%`;
        return blocked;
    };
    const renderPlan = async blocked => {
        if (!blocked) { plan.hidden = true; return; }
        try {
            const value = await window.vcpBootstrap.plan();
            plan.textContent = '';
            const heading = document.createElement('h2'); heading.textContent = '修复计划';
            const list = document.createElement('ul');
            (value.stages || []).forEach(stage => { const item = document.createElement('li'); item.textContent = `${stage.mutates ? '修改' : '检查'}：${stage.id}`; list.append(item); });
            plan.append(heading, list);
            plan.hidden = false;
        } catch (error) { write(`\n无法读取修复计划：${error.message}\n`); }
    };
    const refresh = async () => { try { const blocked = renderDoctor(await window.vcpBootstrap.doctor(true)); await renderPlan(blocked); } catch (error) { title.textContent = '检查失败'; summary.textContent = error.message; safeButton.hidden = false; } };
    const setOperation = active => { operationActive = active; cancelButton.hidden = !active; repairButton.disabled = active; safeButton.disabled = active; launchButton.disabled = active; };
    const releaseOutput = window.vcpBootstrap.onOutput(detail => write(detail.text));
    repairButton.onclick = async () => { setOperation(true); write('\n开始受控修复…\n'); try { await window.vcpBootstrap.repair([]); } catch (error) { write(`${error.message}\n`); } finally { setOperation(false); await refresh(); } };
    safeButton.onclick = async () => { setOperation(true); write('\n尝试最小启动…\n'); try { await window.vcpBootstrap.launch(true); await window.vcpBootstrap.quit(); } catch (error) { write(`${error.message}\n`); setOperation(false); } };
    launchButton.onclick = async () => { setOperation(true); try { await window.vcpBootstrap.launch(false); await window.vcpBootstrap.quit(); } catch (error) { write(`${error.message}\n`); setOperation(false); } };
    cancelButton.onclick = async () => { if (operationActive) { cancelButton.disabled = true; await window.vcpBootstrap.cancel(); write('\n已请求取消当前操作。\n'); } };
    document.querySelector('#logs').onclick = async () => { const entries = await window.vcpBootstrap.logs(); write(`${entries.map(entry => entry.path).join('\n') || '暂无诊断文件'}\n`); if (entries[0]) await window.vcpBootstrap.openLog(entries[0].path); };
    document.querySelector('#quit').onclick = () => window.vcpBootstrap.quit();
    window.addEventListener('beforeunload', () => { releaseOutput?.(); });
    refresh();
})();
