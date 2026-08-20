(() => {
    const title = document.querySelector('#title');
    const summary = document.querySelector('#summary');
    const bar = document.querySelector('#bar');
    const checks = document.querySelector('#checks');
    const log = document.querySelector('#log');
    const repairButton = document.querySelector('#repair');
    const safeButton = document.querySelector('#safe');
    const launchButton = document.querySelector('#launch');
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
    const refresh = async () => { try { renderDoctor(await window.vcpBootstrap.doctor(true)); } catch (error) { title.textContent = '检查失败'; summary.textContent = error.message; safeButton.hidden = false; } };
    window.vcpBootstrap.onOutput(detail => write(detail.text));
    repairButton.onclick = async () => { repairButton.disabled = true; write('\n开始受控修复…\n'); try { await window.vcpBootstrap.repair([]); } catch (error) { write(`${error.message}\n`); } finally { repairButton.disabled = false; await refresh(); } };
    safeButton.onclick = async () => { safeButton.disabled = true; write('\n尝试最小启动…\n'); try { await window.vcpBootstrap.launch(true); } catch (error) { write(`${error.message}\n`); safeButton.disabled = false; } };
    launchButton.onclick = async () => { launchButton.disabled = true; try { await window.vcpBootstrap.launch(false); } catch (error) { write(`${error.message}\n`); launchButton.disabled = false; } };
    document.querySelector('#logs').onclick = async () => { const entries = await window.vcpBootstrap.logs(); write(`${entries.map(entry => entry.path).join('\n') || '暂无诊断文件'}\n`); if (entries[0]) await window.vcpBootstrap.openLog(entries[0].path); };
    document.querySelector('#quit').onclick = () => window.vcpBootstrap.quit();
    refresh();
})();
