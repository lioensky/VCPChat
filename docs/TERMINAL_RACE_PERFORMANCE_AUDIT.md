# 终端竞态与性能审计
日期：2026-11-15。工程：pczkh。
范围：侧栏终端、共享 PowerShell PTY、独立窗口。仅审计，未修改业务代码或部署、重启运行客户端。

## 基线与环境
源码 H:\VCP\VCPMain\VCPChat；当前 Electron 运行 H:\MCP\VCPChat。
terminalSideProvider.js 与 PowerShellExecutor.js 两区 SHA256 一致，其余文件未全面核对。
现有终端相关回归 87 passed / 0 failed，退出码 0。
日志 H:\VCP\VCPMain\terminal-pczkh-baseline.log。
真实 ExecutePowerShell 和 QueryVisible 正常返回。
3 秒采样主进程 CPU 增量约 0.02 秒、GPU 约 1 秒，不能归因于终端；没有窗口帧时间或 Electron profile。

## 已验证缺口
1. PowerShellExecutor.js applyPtyResize 同尺寸不去重。抽取实际函数 VM 桩探针：80x24 重复 100 次导致 100 次原生 resize 调用、0 次镜像通知。证明多余原生调用，不证明 ConPTY 必然重绘或当前卡顿。
2. createNewPtySession 中 guiDataListener 未核对 currentPtyProcess 身份，并读取共享 terminalProjection。实际回调片段 VM 桩模拟旧实例回调：触碰新投影 1 次并派发旧数据。onExit 已有实例保护；输出缺口不是退出缺口。未做完整 Electron 重启时序复现。
3. terminalLinks.js trimTerminalUrlCandidate 每删除一个多余闭括号都重新 countChar 全串，最坏二次复杂度。实际模块 Node 单次探针：https://example.com/ 后接 1000/4000/12000 个右括号，耗时分别约 6.63/58.58/523.94ms。非 Electron 帧测，不是稳态 benchmark。
4. terminalLinks.js 每次请求扫描完整折行并逐字符建立 positions 对象，即使没有 URL。80 列、100/1000/5000 行模拟 buffer：8100/81000/405000 次 getCell，耗时约 1.6/10.22/32.66ms。模拟单元格，不是实际 xterm buffer 性能基准。

## 结构风险，尚未量测
- 侧栏桥 16ms 合并/64Ki 字符阈值只是批处理；无解析消费 ACK，阈值到达可持续发 IPC；侧栏 term.write 异步队列无显式背压。
- 独立窗口 dispatchPtyData 逐块发送，Viewer 逐块 term.write；缺少同等级批处理和消费背压。
- 隐藏侧栏保留 xterm 输出解析，属于现有语义；不能直接暂停/丢 ANSI 片段。
- 独立窗口 query-visible-text 直接读 buffer，terminal-paste-request 不等解析屏障；侧栏已用空 write 回调屏障。可能读旧屏幕/旧粘贴模式，未构造真实异步解析复现。
- 独立窗口 fit 每次发送尺寸，不受焦点约束；侧栏已有焦点认领。尚未构造窗口竞争现场。
- 命令采集每 100ms 主进程 fs.readFileSync 全读输出。运行记录 RAW 上限 512Ki 字符；本次未进一步核验 capture writer 的确切注入上限，未量测该轮询耗时，不列为当前主因。

## 已有防护，勿误报
控制器 pendingTabMounts 合并同标签挂载；取消后释放迟到 handle。
侧栏 occurrence abort、generation、重复 attach/restart 合并和视图休眠清理已有测试。
关闭镜像不终止共享 PTY。PTY onExit 已防旧实例清理新会话。

## 建议修复顺序
1. 旧 PTY 输出身份隔离，核对启动探针和订阅释放；增加旧事件迟到测试。
2. 链接括号清理改为线性、保持现有混合括号语义；长折行扫描加入明确预算并减少逐字符对象分配。测试超长无 URL、混合尾括号、宽字符、跨行链接及预算降级。
3. 底层 resize 有效参数校验及同尺寸去重；明确独立窗口/侧栏尺寸所有权。
4. 独立窗口 query/paste 增加解析屏障和生命周期取消。
5. 多消费者背压先设计：ACK、流量预算、隐藏/销毁消费者和超时策略；不得任意丢控制序列，不得让隐藏消费者无限阻塞共享执行。补峰值队列、事件循环和帧时间量测。

修复后需跑既有回归、新边界测试及真实窗口负载观察。源码测试通过不等于部署验收。

## 修复落地（用户授权后）
- PowerShellExecutor 输出回调增加当前 PTY 实例身份检查，拒绝旧实例迟到数据访问共享投影与启动缓存。
- applyPtyResize 拒绝无效尺寸，跳过同尺寸原生调用，保留启动前几何设置能力。
- terminalLinks 尾括号清理改为一次计数与尾指针剥离；字符坐标改为数值编码。完整折行扫描预算为 16384 单元格，超预算整条不自动识别链接，不截断文本或生成部分 URL。
- 新增 tests/terminal-race-performance.test.js；扩展链接测试，更新原有 resize 重复调用断言。链接测试包含4681组短后缀与旧算法语义对照、12000个尾括号、跨行宽字符/组合字符、零坐标和预算边界。
- 首轮94测试92通过2失败：旧resize断言依赖重复调用、新测试URL终点少数一列；校准断言后最终94/94通过，0失败/跳过/取消，TEST_EXIT=0。
- JS语法检查通过，git diff --check通过。最终日志 H:\VCP\VCPMain\terminal-pczkh-final.log。
- 修复后单次Node隔离探针：1020/4020/12020字符异常URL耗时0.314/0.451/1.865ms；5000行80列折行在204次行读取后预算退出，0次单元格读取，0.308ms。基线对应12020字符523.94ms、折行405000次单元格读取32.66ms。非稳态基准、非Electron帧率量测，折行提速包含取消超预算自动链接的功能取舍。
- 运行目录未同步、客户端未重启、未Git提交推送。输出背压、独立窗口解析屏障和尺寸所有权仍在本轮范围外。需部署后真实窗口验收。