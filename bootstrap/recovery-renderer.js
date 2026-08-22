(() => {
    const welcome = document.querySelector('#welcome');
    const workspace = document.querySelector('#workspace');
    const success = document.querySelector('#success');
    const failure = document.querySelector('#failure');
    const beginButton = document.querySelector('#begin');
    const successLaunchButton = document.querySelector('#successLaunch');
    const title = document.querySelector('#title');
    const bar = document.querySelector('#bar');
    const progress = document.querySelector('.progress-track');
    const progressCount = document.querySelector('#progressCount');
    const stageSpinner = document.querySelector('#stageSpinner');
    const stages = document.querySelector('#stages');
    const plan = document.querySelector('#plan');
    const checkDetails = document.querySelector('#checkDetails');
    const checks = document.querySelector('#checks');
    const liveOutput = document.querySelector('#liveOutput');
    const log = document.querySelector('#log');
    const logCount = document.querySelector('#logCount');
    const detailsButton = document.querySelector('#logs');
    const detailsLabel = document.querySelector('#detailsLabel');
    const repairButton = document.querySelector('#repair');
    const safeButton = document.querySelector('#safe');
    const launchButton = document.querySelector('#launch');
    const cancelButton = document.querySelector('#cancel');
    const failureMessage = document.querySelector('#failureMessage');
    let operationActive = false;
    let logLines = 0;
    let currentStages = [];

    const labels = {
        project: '项目文件', node: 'Node.js', npm: 'npm', lockfile: '依赖锁定', dependencies: '项目依赖',
        electron: 'Electron', 'native-abi': '原生模块', 'rust-runtime': '聊天数据服务',
        'vendor-closure': '界面资源', filesystem: '文件权限', 'operation-lock': '启动状态',
    };
    const stageLabels = {
        'validate-lockfile': '验证依赖锁定', 'install-dependencies': '安装项目依赖',
        'probe-native-modules': '检查原生模块', 'rebuild-native-modules': '重建原生模块',
        'build-rust-runtime': '准备聊天数据服务', 'repair-vendor-closure': '修复界面资源',
        'verify-vendor-closure': '验证界面资源', 'publish-fingerprint': '保存环境指纹',
    };

    function showRoute(route) {
        welcome.hidden = route !== 'welcome';
        workspace.hidden = route !== 'workspace';
        success.hidden = route !== 'success';
        failure.hidden = route !== 'failure';
    }

    function setProgress(done, total) {
        const safeTotal = Math.max(1, total);
        const percent = Math.round((done / safeTotal) * 100);
        progressCount.textContent = `${done} / ${total} 步骤`;
        bar.style.width = `${Math.max(done > 0 ? 2 : 0, percent)}%`;
        progress.setAttribute('aria-valuenow', String(percent));
    }

    function setStages(items, { reset = true } = {}) {
        if (reset) currentStages = items.map(item => ({ ...item }));
        stages.textContent = '';
        currentStages.forEach(item => {
            const row = document.createElement('li');
            row.className = 'stage';
            row.dataset.state = item.state || 'pending';
            row.dataset.stageId = item.id;
            const marker = document.createElement('i');
            marker.className = 'stage-marker';
            const name = document.createElement('span');
            name.className = 'stage-name';
            name.textContent = item.title || stageLabels[item.id] || item.id;
            row.append(marker, name);
            if (item.meta) {
                const meta = document.createElement('small');
                meta.className = 'stage-meta';
                meta.textContent = item.meta;
                row.append(meta);
            }
            stages.append(row);
        });
        const done = currentStages.filter(item => item.state === 'succeeded').length;
        setProgress(done, currentStages.length);
    }

    function updateStage(id, state) {
        const item = currentStages.find(entry => entry.id === id);
        if (!item) return;
        item.state = state;
        setStages(currentStages, { reset: false });
    }

    function appendLog(text) {
        if (!text) return;
        log.textContent += text;
        log.scrollTop = log.scrollHeight;
        logLines += String(text).split('\n').filter(Boolean).length;
        logCount.textContent = `${logLines} 行`;
    }

    function write(text, reveal = false) {
        appendLog(text);
        if (reveal) {
            liveOutput.hidden = false;
            detailsButton.setAttribute('aria-expanded', 'true');
            detailsLabel.textContent = '隐藏详情';
        }
    }

    function renderDoctor(report) {
        const items = report.checks.map(item => ({
            id: item.id,
            title: labels[item.id] || item.id,
            state: item.status === 'fail' ? 'failed' : 'succeeded',
            meta: item.status === 'warn' ? '可选' : '',
        }));
        setStages(items);
        checks.textContent = '';
        report.checks.forEach(item => {
            const row = document.createElement('div');
            row.className = 'check';
            row.dataset.state = item.status;
            const name = document.createElement('span');
            name.className = 'check-name';
            const dot = document.createElement('i');
            dot.className = 'check-dot';
            dot.textContent = item.status === 'pass' ? '✓' : item.status === 'warn' ? '!' : '×';
            name.append(dot, document.createTextNode(labels[item.id] || item.id));
            const message = document.createElement('small');
            message.textContent = item.message;
            row.append(name, message);
            checks.append(row);
        });

        const blocked = !report.ok;
        title.textContent = blocked ? '需要处理运行环境' : '环境检查通过';
        stageSpinner.hidden = true;
        repairButton.hidden = !blocked;
        safeButton.hidden = true;
        launchButton.hidden = blocked;
        checkDetails.hidden = !blocked;
        if (blocked) checkDetails.hidden = false;
        return blocked;
    }

    async function renderPlan(blocked) {
        if (!blocked) { plan.hidden = true; return; }
        try {
            const value = await window.vcpBootstrap.plan();
            const planned = value.stages || [];
            setStages(planned.map(stage => ({ id: stage.id, title: stageLabels[stage.id] || stage.id, state: 'pending' })));
            plan.textContent = '';
            const heading = document.createElement('h2');
            heading.textContent = '系统准备';
            const list = document.createElement('ul');
            planned.forEach(stage => {
                const item = document.createElement('li');
                item.textContent = stageLabels[stage.id] || stage.id;
                list.append(item);
            });
            plan.append(heading, list);
            plan.hidden = false;
        } catch (error) { write(`${error.message}\n`, true); }
    }

    async function refresh() {
        setOperation(false);
        showRoute('workspace');
        title.textContent = '正在检查系统';
        stageSpinner.hidden = false;
        repairButton.hidden = true;
        launchButton.hidden = true;
        checkDetails.hidden = true;
        plan.hidden = true;
        try {
            const blocked = renderDoctor(await window.vcpBootstrap.doctor(true));
            await renderPlan(blocked);
        } catch (error) {
            showFailure(error.message);
        }
    }

    function showFailure(message) {
        operationActive = false;
        failureMessage.textContent = message || 'VCPChat 没有完成这次准备。';
        showRoute('failure');
    }

    function setOperation(active, mode = '') {
        operationActive = active;
        cancelButton.hidden = !active;
        cancelButton.disabled = false;
        repairButton.disabled = active;
        safeButton.disabled = active;
        launchButton.disabled = active;
        stageSpinner.hidden = !active;
        if (active) title.textContent = mode === 'repair' ? '正在准备系统环境' : '正在启动 VCPChat';
    }

    async function launch(safe = false) {
        setOperation(true, 'launch');
        try { await window.vcpBootstrap.launch(safe); await window.vcpBootstrap.quit(); }
        catch (error) {
            setOperation(false);
            showFailure(error.message);
        }
    }

    beginButton.onclick = () => refresh();
    successLaunchButton.onclick = () => launch(false);
    repairButton.onclick = async () => {
        setOperation(true, 'repair');
        write('开始受控修复…\n');
        try { await window.vcpBootstrap.repair([]); setOperation(false); await refresh(); }
        catch (error) { setOperation(false); showFailure(error.message); }
    };
    safeButton.onclick = () => launch(true);
    launchButton.onclick = () => launch(false);
    document.querySelector('#failureRetry').onclick = () => refresh();
    document.querySelector('#failureLogs').onclick = async () => {
        const entries = await window.vcpBootstrap.logs();
        if (entries[0]) await window.vcpBootstrap.openLog(entries[0].path);
    };
    cancelButton.onclick = async () => {
        if (!operationActive) return;
        cancelButton.disabled = true;
        await window.vcpBootstrap.cancel();
        write('已请求取消当前操作。\n');
    };
    detailsButton.onclick = () => {
        const open = liveOutput.hidden;
        liveOutput.hidden = !open;
        detailsButton.setAttribute('aria-expanded', String(open));
        detailsLabel.textContent = open ? '隐藏详情' : '显示详情';
    };

    const releaseOutput = window.vcpBootstrap.onOutput(detail => {
        const text = String(detail.text || '');
        text.split(/(?=→ |✓ )/).forEach(chunk => {
            const start = chunk.match(/^→ ([\w-]+)/);
            const done = chunk.match(/^✓ ([\w-]+)/);
            if (start) updateStage(start[1], 'running');
            if (done) updateStage(done[1], 'succeeded');
            appendLog(chunk);
        });
    });
    window.addEventListener('beforeunload', () => { releaseOutput?.(); });
    showRoute('welcome');
})();
