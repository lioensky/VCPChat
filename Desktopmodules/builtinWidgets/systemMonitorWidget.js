/**
 * VCPdesktop - 内置系统指标挂件模块
 * 负责：按组件生成 CPU / RAM / 磁盘 / 网络 / GPU / 电池 / Docker / 传感器 / 进程监控挂件
 */

'use strict';

(function () {
    const { state, CONSTANTS, widget } = window.VCPDesktop;
    const METRIC_WIDGETS = [
        { key: 'cpu', exportKey: 'builtinCpuMonitor', widgetId: 'builtin-monitor-cpu', title: 'CPU 监控', icon: '🧠', subtitle: '占用 / 负载 / 中断', width: 320, height: 260, includeProcesses: false, includeDocker: false, refreshMs: 3000 },
        { key: 'memory', exportKey: 'builtinMemoryMonitor', widgetId: 'builtin-monitor-memory', title: 'RAM 监控', icon: '🧮', subtitle: '内存 / Swap / 页面错误', width: 320, height: 260, includeProcesses: false, includeDocker: false, refreshMs: 3000 },
        { key: 'disk', exportKey: 'builtinDiskMonitor', widgetId: 'builtin-monitor-disk', title: '磁盘监控', icon: '🗄️', subtitle: '容量 / 分区占用', width: 360, height: 320, includeProcesses: false, includeDocker: false, refreshMs: 5000 },
        { key: 'network', exportKey: 'builtinNetworkMonitor', widgetId: 'builtin-monitor-network', title: '网络监控', icon: '🌐', subtitle: '吞吐 / 网卡速率', width: 360, height: 320, includeProcesses: false, includeDocker: false, refreshMs: 3000 },
        { key: 'gpu', exportKey: 'builtinGpuMonitor', widgetId: 'builtin-monitor-gpu', title: 'GPU 监控', icon: '🎮', subtitle: '占用 / 温度 / 功耗', width: 340, height: 280, includeProcesses: false, includeDocker: false, refreshMs: 3000 },
        { key: 'battery', exportKey: 'builtinBatteryMonitor', widgetId: 'builtin-monitor-battery', title: '电池监控', icon: '🔋', subtitle: '电量 / 充电 / 功耗', width: 320, height: 260, includeProcesses: false, includeDocker: false, refreshMs: 5000 },
        { key: 'docker', exportKey: 'builtinDockerMonitor', widgetId: 'builtin-monitor-docker', title: 'Docker 监控', icon: '🐳', subtitle: '容器 / CPU / 内存', width: 360, height: 340, includeProcesses: false, includeDocker: true, refreshMs: 5000 },
        { key: 'sensors', exportKey: 'builtinSensorsMonitor', widgetId: 'builtin-monitor-sensors', title: '传感器监控', icon: '🌡️', subtitle: '温度 / 风扇 / 电压 / 功耗', width: 360, height: 340, includeProcesses: false, includeDocker: false, refreshMs: 5000 },
        { key: 'processes', exportKey: 'builtinProcessMonitor', widgetId: 'builtin-monitor-processes', title: '进程监视器', icon: '🧾', subtitle: '运行数 / Top CPU', width: 380, height: 360, includeProcesses: true, includeDocker: false, refreshMs: 5000 },
    ];
    const METRIC_WIDGET_MAP = METRIC_WIDGETS.reduce((acc, item) => {
        acc[item.key] = item;
        return acc;
    }, {});

    function normalizeMetricWidgetKey(component) {
        const metricsApi = window.VCPDesktop && window.VCPDesktop.metrics;
        return metricsApi && metricsApi.normalizeComponentKey
            ? metricsApi.normalizeComponentKey(component)
            : String(component || '').trim().toLowerCase();
    }

    function getMetricWidgetDefinition(component) {
        const key = normalizeMetricWidgetKey(component);
        return key ? METRIC_WIDGET_MAP[key] : null;
    }

    function getDefaultPosition(definition) {
        const index = METRIC_WIDGETS.findIndex((item) => item.key === definition.key);
        const offsetX = (index % 3) * 28;
        const offsetY = Math.floor(index / 3) * 28;
        return {
            x: 40 + offsetX,
            y: CONSTANTS.TITLE_BAR_HEIGHT + 20 + offsetY,
        };
    }

    function buildMetricWidgetHtml(definition) {
        const configJson = JSON.stringify({
            component: definition.key,
            includeProcesses: !!definition.includeProcesses,
            includeDocker: !!definition.includeDocker,
            refreshMs: definition.refreshMs || 5000,
            title: definition.title,
            subtitle: definition.subtitle,
        });

        return [
            '<style>',
            '.vdmc-root { height: 100%; min-width: 280px; color: #fff; font-family: "Segoe UI", -apple-system, sans-serif; }',
            '.vdmc-panel { height: 100%; display: flex; flex-direction: column; background: linear-gradient(135deg, rgba(18, 22, 34, 0.92), rgba(30, 18, 42, 0.88)); border-radius: 18px; padding: 16px; backdrop-filter: blur(16px); box-shadow: 0 16px 48px rgba(0,0,0,0.24); }',
            '.vdmc-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }',
            '.vdmc-title { font-size: 16px; font-weight: 600; }',
            '.vdmc-subtitle { font-size: 11px; opacity: 0.62; margin-top: 2px; line-height: 1.4; white-space: pre-line; }',
            '.vdmc-badge { font-size: 11px; padding: 4px 8px; border-radius: 999px; background: rgba(255,255,255,0.08); white-space: nowrap; }',
            '.vdmc-main { font-size: 30px; font-weight: 600; line-height: 1.1; margin-bottom: 8px; }',
            '.vdmc-main-sub { font-size: 11px; opacity: 0.68; line-height: 1.5; white-space: pre-line; margin-bottom: 12px; }',
            '.vdmc-list { display: flex; flex-direction: column; gap: 6px; overflow: auto; min-height: 0; flex: 1; }',
            '.vdmc-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 11px; padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.04); }',
            '.vdmc-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.78; }',
            '.vdmc-row-value { flex-shrink: 0; font-weight: 600; }',
            '.vdmc-empty { font-size: 11px; opacity: 0.5; padding: 8px 0; }',
            '.vdmc-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 12px; font-size: 10px; opacity: 0.56; }',
            '.vdmc-refresh { border: none; background: rgba(255,255,255,0.1); color: #fff; border-radius: 999px; padding: 5px 10px; cursor: pointer; font-size: 10px; }',
            '.vdmc-refresh:hover { background: rgba(255,255,255,0.18); }',
            '</style>',
            `<div class="vdmc-root" data-component="${definition.key}">`,
            '  <div class="vdmc-panel">',
            '    <div class="vdmc-header">',
            '      <div>',
            `        <div class="vdmc-title">${definition.icon} ${definition.title}</div>`,
            `        <div class="vdmc-subtitle" id="vdmc-route">${definition.subtitle}</div>`,
            '      </div>',
            '      <div class="vdmc-badge" id="vdmc-platform">--</div>',
            '    </div>',
            '    <div class="vdmc-main" id="vdmc-main">--</div>',
            '    <div class="vdmc-main-sub" id="vdmc-main-sub">正在获取宿主指标...</div>',
            '    <div class="vdmc-list" id="vdmc-list"></div>',
            '    <div class="vdmc-footer">',
            '      <span id="vdmc-updated">--</span>',
            '      <button class="vdmc-refresh" id="vdmc-refresh">刷新</button>',
            '    </div>',
            '  </div>',
            '</div>',
            '<script>',
            '(function() {',
            `  var config = ${configJson};`,
            '  var metricsApi = window.VCPDesktop && window.VCPDesktop.metrics;',
            '  var refreshBtn = document.getElementById("vdmc-refresh");',
            '  var platformEl = document.getElementById("vdmc-platform");',
            '  var routeEl = document.getElementById("vdmc-route");',
            '  var mainEl = document.getElementById("vdmc-main");',
            '  var subEl = document.getElementById("vdmc-main-sub");',
            '  var updatedEl = document.getElementById("vdmc-updated");',
            '  var listEl = document.getElementById("vdmc-list");',
            '  var refreshTimer = null;',
            '  var routeHideTimer = null;',
            '',
            '  function setMain(value, subText) {',
            '    if (mainEl) mainEl.textContent = value;',
            '    if (subEl) subEl.textContent = subText;',
            '  }',
            '',
            '  function escapeHtml(text) {',
            '    return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");',
            '  }',
            '',
            '  function renderList(items, emptyText) {',
            '    if (!listEl) return;',
            '    if (!items || !items.length) {',
            '      listEl.innerHTML = \'<div class="vdmc-empty">\' + escapeHtml(emptyText || "暂无数据") + \'</div>\';',
            '      return;',
            '    }',
            '    listEl.innerHTML = items.map(function(item) {',
            '      return \'<div class="vdmc-row"><span class="vdmc-row-name">\' + escapeHtml(item.name) + \'</span><span class="vdmc-row-value">\' + escapeHtml(item.value) + \'</span></div>\';',
            '    }).join("");',
            '  }',
            '',
            '  function formatBytes(value) { return metricsApi && metricsApi.formatBytes ? metricsApi.formatBytes(value) : "--"; }',
            '  function formatRate(value) { return metricsApi && metricsApi.formatRate ? metricsApi.formatRate(value) : "--"; }',
            '  function formatPercent(value) { return metricsApi && metricsApi.formatPercent ? metricsApi.formatPercent(value) : "--"; }',
            '  function formatDuration(value) { return metricsApi && metricsApi.formatDuration ? metricsApi.formatDuration(value) : "--"; }',
            '  function summarizeStatus(status) { return metricsApi && metricsApi.summarizeStatus ? metricsApi.summarizeStatus(status) : (status || "--"); }',
            '',
            '  function renderMeta(payload) {',
            '    if (platformEl) platformEl.textContent = payload.platform || "unknown";',
            '    if (routeEl) routeEl.textContent = (payload.route && payload.route.detail) ? payload.route.detail : config.subtitle;',
            '    if (!updatedEl) return;',
            '    var stamp = payload.collectedAt ? new Date(payload.collectedAt) : null;',
            '    if (!stamp || isNaN(stamp.getTime())) {',
            '      updatedEl.textContent = "未获取到快照";',
            '      return;',
            '    }',
            '    updatedEl.textContent = "更新于 " + String(stamp.getHours()).padStart(2, "0") + ":" + String(stamp.getMinutes()).padStart(2, "0") + ":" + String(stamp.getSeconds()).padStart(2, "0");',
            '  }',
            '',
            '  function renderCpu(payload) {',
            '    var cpu = payload.data || null;',
            '    if (!cpu) { setMain("--", "CPU 数据不可用"); renderList([], "未返回 CPU 数据"); return; }',
            '    var subLines = [(cpu.coreCount || "--") + " 核", cpu.model || "未知处理器"];',
            '    var rows = [];',
            '    if (payload.snapshot && payload.snapshot.system) {',
            '      var system = payload.snapshot.system;',
            '      if (Array.isArray(system.loadAverage) && system.loadAverage.length) {',
            '        subLines.push("Load " + system.loadAverage.map(function(v) { return typeof v === "number" ? v.toFixed(2) : "--"; }).join(" / "));',
            '      } else if (payload.capabilities && payload.capabilities.metrics && payload.capabilities.metrics.loadAverage) {',
            '        subLines.push("Load Avg: " + summarizeStatus(payload.capabilities.metrics.loadAverage));',
            '      }',
            '      if (typeof system.interruptsPerSec === "number") rows.push({ name: "中断/s", value: system.interruptsPerSec.toFixed(1) });',
            '      if (typeof system.uptimeSec === "number") rows.push({ name: "运行时长", value: formatDuration(system.uptimeSec) });',
            '    }',
            '    setMain(formatPercent(cpu.usagePct), subLines.join("\\n"));',
            '    renderList(rows, "暂无额外 CPU 指标");',
            '  }',
            '',
            '  function renderMemory(payload) {',
            '    var memory = payload.data || null;',
            '    if (!memory) { setMain("--", "内存数据不可用"); renderList([], "未返回 RAM 数据"); return; }',
            '    setMain(formatPercent(memory.usagePct), formatBytes(memory.usedBytes) + " / " + formatBytes(memory.totalBytes));',
            '    var rows = [];',
            '    if (typeof memory.freeBytes === "number") rows.push({ name: "可用", value: formatBytes(memory.freeBytes) });',
            '    if (typeof memory.swapTotalBytes === "number" && memory.swapTotalBytes > 0) {',
            '      rows.push({ name: "Swap", value: formatBytes(memory.swapUsedBytes) + " / " + formatBytes(memory.swapTotalBytes) });',
            '    } else if (payload.capabilities && payload.capabilities.metrics && payload.capabilities.metrics.swap) {',
            '      rows.push({ name: "Swap", value: summarizeStatus(payload.capabilities.metrics.swap) });',
            '    }',
            '    if (payload.snapshot && payload.snapshot.system) {',
            '      var system = payload.snapshot.system;',
            '      if (typeof system.pageFaultsPerSec === "number") rows.push({ name: "页面错误/s", value: system.pageFaultsPerSec.toFixed(1) });',
            '      if (typeof system.majorPageFaultsPerSec === "number") rows.push({ name: "主缺页/s", value: system.majorPageFaultsPerSec.toFixed(1) });',
            '    }',
            '    renderList(rows, "暂无额外 RAM 指标");',
            '  }',
            '',
            '  function renderDisk(payload) {',
            '    var disk = payload.data || null;',
            '    if (!disk || !disk.summary) { setMain("--", "磁盘数据不可用"); renderList([], "未返回磁盘数据"); return; }',
            '    setMain(formatPercent(disk.summary.usagePct), formatBytes(disk.summary.usedBytes) + " / " + formatBytes(disk.summary.totalBytes));',
            '    var rows = (disk.items || []).slice(0, 8).map(function(item) {',
            '      var name = item.name || item.mount || "--";',
            '      return { name: name, value: formatPercent(item.usagePct) + " · " + formatBytes(item.usedBytes) + " / " + formatBytes(item.totalBytes) };',
            '    });',
            '    renderList(rows, "暂无分区数据");',
            '  }',
            '',
            '  function renderNetwork(payload) {',
            '    var network = payload.data || null;',
            '    if (!network || !network.totals) { setMain("--", "网络数据不可用"); renderList([], "未返回网络数据"); return; }',
            '    setMain("↓ " + formatRate(network.totals.rxPerSec), "↑ " + formatRate(network.totals.txPerSec));',
            '    var rows = (network.items || []).slice(0, 8).map(function(item) {',
            '      return { name: item.name || "--", value: formatRate(item.rxPerSec) + " / " + formatRate(item.txPerSec) };',
            '    });',
            '    renderList(rows, "暂无网卡吞吐数据");',
            '  }',
            '',
            '  function renderGpu(payload) {',
            '    var gpu = payload.data || null;',
            '    if (!gpu || !gpu.available || !gpu.cards || !gpu.cards.length) {',
            '      setMain(summarizeStatus(payload.status), "GPU 扩展链路未启用");',
            '      renderList([], "可启用 nvidia-smi 以补充 GPU 指标");',
            '      return;',
            '    }',
            '    var primary = gpu.cards[0];',
            '    setMain(formatPercent(primary.utilizationGpuPct), primary.name || "GPU");',
            '    var rows = gpu.cards.slice(0, 6).map(function(card, index) {',
            '      var parts = [];',
            '      if (typeof card.temperatureC === "number") parts.push(card.temperatureC.toFixed(0) + "°C");',
            '      if (typeof card.powerWatts === "number") parts.push(card.powerWatts.toFixed(0) + "W");',
            '      if (typeof card.memoryUsedMB === "number" && typeof card.memoryTotalMB === "number") parts.push(card.memoryUsedMB.toFixed(0) + "/" + card.memoryTotalMB.toFixed(0) + "MB");',
            '      return { name: card.name || ("GPU " + (index + 1)), value: (parts.length ? parts.join(" · ") : formatPercent(card.utilizationGpuPct)) };',
            '    });',
            '    renderList(rows, "暂无 GPU 卡片数据");',
            '  }',
            '',
            '  function renderBattery(payload) {',
            '    var battery = payload.data || null;',
            '    if (!battery || !battery.present) {',
            '      setMain("无电池", "桌面机或宿主未暴露电池状态");',
            '      renderList([], "当前宿主未返回电池信息");',
            '      return;',
            '    }',
            '    var subParts = [(battery.isCharging ? "充电中" : "电池供电")];',
            '    if (battery.timeRemainingSec) subParts.push(formatDuration(battery.timeRemainingSec));',
            '    setMain(formatPercent(battery.percent), subParts.join(" · "));',
            '    var rows = [];',
            '    if (typeof battery.powerWatts === "number") rows.push({ name: "功耗", value: battery.powerWatts.toFixed(1) + " W" });',
            '    if (battery.status) rows.push({ name: "状态", value: String(battery.status) });',
            '    if (battery.source) rows.push({ name: "来源", value: String(battery.source) });',
            '    renderList(rows, "暂无额外电池指标");',
            '  }',
            '',
            '  function renderDocker(payload) {',
            '    var docker = payload.data || null;',
            '    if (!docker || !docker.available) {',
            '      setMain(summarizeStatus(payload.status), "Docker 采集链路不可用");',
            '      renderList([], docker && docker.reason ? ("状态: " + docker.reason) : "请确认 docker CLI 可用");',
            '      return;',
            '    }',
            '    setMain((docker.containersRunning || 0) + "/" + (docker.containersTotal || 0), "运行中 / 总容器数");',
            '    var rows = (docker.stats || []).slice(0, 6).map(function(item) {',
            '      var parts = [];',
            '      if (typeof item.cpuPercent === "number") parts.push(formatPercent(item.cpuPercent));',
            '      if (typeof item.memPercent === "number") parts.push(formatPercent(item.memPercent));',
            '      if (item.memUsage) parts.push(String(item.memUsage));',
            '      return { name: item.name || "container", value: parts.join(" · ") || "--" };',
            '    });',
            '    renderList(rows, "暂无容器统计");',
            '  }',
            '',
            '  function renderSensors(payload) {',
            '    var sensors = payload.data || null;',
            '    if (!sensors) {',
            '      setMain("--", "传感器数据不可用");',
            '      renderList([], "未返回传感器数据");',
            '      return;',
            '    }',
            '    var rows = [];',
            '    var hasTemperatures = Array.isArray(sensors.temperatures) && sensors.temperatures.length > 0;',
            '    var hasFans = Array.isArray(sensors.fans) && sensors.fans.length > 0;',
            '    var hasVoltages = Array.isArray(sensors.voltages) && sensors.voltages.length > 0;',
            '    var hasPowers = Array.isArray(sensors.powers) && sensors.powers.length > 0;',
            '    (sensors.temperatures || []).slice(0, 3).forEach(function(item) { rows.push({ name: item.name || "温度", value: (typeof item.valueC === "number" ? item.valueC.toFixed(1) + "°C" : "--") }); });',
            '    (sensors.fans || []).slice(0, 2).forEach(function(item) { rows.push({ name: item.name || "风扇", value: (typeof item.rpm === "number" ? item.rpm.toFixed(0) + " RPM" : "--") }); });',
            '    (sensors.voltages || []).slice(0, 2).forEach(function(item) { rows.push({ name: item.name || "电压", value: (typeof item.volts === "number" ? item.volts.toFixed(3) + " V" : "--") }); });',
            '    (sensors.powers || []).slice(0, 2).forEach(function(item) { rows.push({ name: item.name || "功耗", value: (typeof item.watts === "number" ? item.watts.toFixed(1) + " W" : "--") }); });',
            '    if (!rows.length) {',
            '      var emptyKinds = [];',
            '      if (!hasTemperatures) emptyKinds.push("温度");',
            '      if (!hasFans) emptyKinds.push("风扇");',
            '      if (!hasVoltages) emptyKinds.push("电压");',
            '      if (!hasPowers) emptyKinds.push("功耗");',
            '      if (payload.status !== "supported") {',
            '        setMain(summarizeStatus(payload.status), [',
            '          sensors.source ? ("来源: " + sensors.source) : "来源未标识",',
            '          "传感器链路尚未接通" ',
            '        ].join("\\n"));',
            '        var hint = "当前未检测到可读取的传感器提供方；Windows 请确认已放置 LibreHardwareMonitorLib.dll，或已运行 LibreHardwareMonitor 暴露 WMI";',
            '        if (sensors.error) hint += ("\\n" + String(sensors.error));',
            '        renderList([], hint);',
            '        return;',
            '      }',
            '      setMain("无读数", [',
            '        sensors.source ? ("来源: " + sensors.source) : "来源未标识",',
            '        "链路状态: " + summarizeStatus(payload.status)',
            '      ].join("\\n"));',
            '      renderList([], "已接入传感器链路，但当前未返回 " + (emptyKinds.length ? emptyKinds.join(" / ") : "传感器") + " 数值");',
            '      return;',
            '    }',
            '    setMain(String(rows.length), sensors.source ? ("来源: " + sensors.source) : "传感器链路状态");',
            '    renderList(rows, "传感器链路状态: " + summarizeStatus(payload.status));',
            '  }',
            '',
            '  function renderProcesses(payload) {',
            '    var processes = payload.data || null;',
            '    if (!processes) { setMain("--", "进程统计不可用"); renderList([], "未返回进程数据"); return; }',
            '    setMain(processes.running != null ? String(processes.running) : "--", "运行进程总数");',
            '    var rows = (processes.topCpu || []).slice(0, 5).map(function(item) {',
            '      var cpuText = typeof item.cpuPercent === "number" ? formatPercent(item.cpuPercent) : "采样中";',
            '      var memText = typeof item.memoryBytes === "number" ? formatBytes(item.memoryBytes) : "--";',
            '      return { name: item.name || ("PID " + item.pid), value: cpuText + " · " + memText };',
            '    });',
            '    renderList(rows, "暂无 Top 进程数据");',
            '  }',
            '',
            '  function renderPayload(payload) {',
            '    renderMeta(payload);',
            '    switch (config.component) {',
            '      case "cpu": renderCpu(payload); break;',
            '      case "memory": renderMemory(payload); break;',
            '      case "disk": renderDisk(payload); break;',
            '      case "network": renderNetwork(payload); break;',
            '      case "gpu": renderGpu(payload); break;',
            '      case "battery": renderBattery(payload); break;',
            '      case "docker": renderDocker(payload); break;',
            '      case "sensors": renderSensors(payload); break;',
            '      case "processes": renderProcesses(payload); break;',
            '      default:',
            '        setMain("--", "未知组件: " + config.component);',
            '        renderList([], "无法渲染该组件");',
            '        break;',
            '    }',
            '  }',
            '',
            '  var refreshInFlight = false;',
            '  async function refreshPayload(forceRefresh) {',
            '    if (refreshInFlight) return;',
            '    refreshInFlight = true;',
            '    if (!metricsApi || !metricsApi.getComponentSnapshot) {',
            '      setMain("--", "桌面指标服务未加载");',
            '      renderList([], "缺少 metrics.getComponentSnapshot()");',
            '      refreshInFlight = false;',
            '      return;',
            '    }',
            '    refreshBtn.disabled = true;',
            '    try {',
            '      var payload = await metricsApi.getComponentSnapshot(config.component, { includeProcesses: !!config.includeProcesses, includeDocker: !!config.includeDocker, forceRefresh: !!forceRefresh });',
            '      renderPayload(payload);',
            '    } catch (err) {',
            '      setMain("--", "刷新失败: " + err.message);',
            '      renderList([], "组件刷新失败");',
            '    } finally {',
            '      refreshBtn.disabled = false;',
            '      refreshInFlight = false;',
            '    }',
            '  }',
            '',
            '  function scheduleRouteHide() {',
            '    if (!routeEl || routeHideTimer) return;',
            '    routeHideTimer = setTimeout(function() {',
            '      routeEl.style.display = "none";',
            '    }, 3000);',
            '  }',
            '',
            '  refreshBtn.addEventListener("click", function() { refreshPayload(true); });',
            '  scheduleRouteHide();',
            '  refreshPayload(false);',
            '  refreshTimer = setInterval(function() {',
            '    if (!document.querySelector(".vdmc-root")) { clearInterval(refreshTimer); return; }',
            '    refreshPayload(false);',
            '  }, config.refreshMs || 5000);',
            '})();',
            '<\/script>'
        ].join('\n');
    }

    function spawnMetricWidget(component, options) {
        const definition = getMetricWidgetDefinition(component);
        if (!definition) {
            throw new Error(`未知监控组件: ${component}`);
        }

        const settings = options || {};
        const widgetId = settings.widgetId || definition.widgetId;
        if (state.widgets.has(widgetId)) {
            return {
                widgetId,
                component: definition.key,
                reused: true,
            };
        }

        const position = getDefaultPosition(definition);
        const widgetData = widget.create(widgetId, {
            x: settings.x != null ? settings.x : position.x,
            y: settings.y != null ? settings.y : position.y,
            width: settings.width || definition.width,
            height: settings.height || definition.height,
        });

        const html = buildMetricWidgetHtml(definition);
        widgetData.fixedSize = true;
        widgetData.contentBuffer = html;
        widgetData.contentContainer.innerHTML = html;
        widget.processInlineStyles(widgetData);
        widgetData.isConstructing = false;
        widgetData.element.classList.remove('constructing');

        setTimeout(function () {
            widget.processInlineScripts(widgetData);
        }, 100);

        return {
            widgetId,
            component: definition.key,
            reused: false,
        };
    }

    function spawnMetricWidgets(components, options) {
        return (Array.isArray(components) ? components : []).map((component, index) => {
            const baseOptions = options && typeof options === 'object' ? { ...options } : {};
            if (baseOptions.x != null) baseOptions.x += index * 24;
            if (baseOptions.y != null) baseOptions.y += index * 24;
            return spawnMetricWidget(component, baseOptions);
        });
    }

    function listMetricWidgets() {
        return METRIC_WIDGETS.map((item) => ({
            key: item.key,
            exportKey: item.exportKey,
            widgetId: item.widgetId,
            title: item.title,
            icon: item.icon,
            subtitle: item.subtitle,
        }));
    }

    window.VCPDesktop = window.VCPDesktop || {};
    METRIC_WIDGETS.forEach((item) => {
        window.VCPDesktop[item.exportKey] = {
            spawn: function (options) {
                return spawnMetricWidget(item.key, options);
            },
        };
    });
    window.VCPDesktop.builtinSystemMonitor = {
        spawn: function (component, options) {
            if (typeof component === 'string') {
                return spawnMetricWidget(component, options);
            }
            return spawnMetricWidget('cpu', component);
        },
        list: listMetricWidgets,
        spawnMany: spawnMetricWidgets,
    };
    window.VCPDesktop.metricWidgets = {
        list: listMetricWidgets,
        spawn: spawnMetricWidget,
        spawnMany: spawnMetricWidgets,
    };
    window.VCPDesktop.agentAPI = window.VCPDesktop.agentAPI || {};
    window.VCPDesktop.agentAPI.metrics = {
        listComponents: function () {
            return window.VCPDesktop.metrics && window.VCPDesktop.metrics.listComponents
                ? window.VCPDesktop.metrics.listComponents()
                : [];
        },
        getCapabilities: function (forceRefresh) {
            return window.VCPDesktop.metrics.getCapabilities(forceRefresh);
        },
        getSnapshot: function (options) {
            return window.VCPDesktop.metrics.getSnapshot(options);
        },
        getComponent: function (component, options) {
            return window.VCPDesktop.metrics.getComponentSnapshot(component, options);
        },
        spawnWidget: spawnMetricWidget,
        spawnWidgets: spawnMetricWidgets,
        listWidgets: listMetricWidgets,
    };
})();
