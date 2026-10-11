# ForgeTax 遥控器

## 类型
hybridservice / direct。每次调用立即执行并返回，不起额外子进程，不自主循环。
复用VChat进程内对局服务，无额外子进程；不依赖可信身份上下文。
插件复用 Gamemodules/forge-tax/service.cjs，不更改全局插件加载器。

## 身份与窗口
顶层maid名字决定存档归属，去首尾空白并进行NFC规范化，大小写保留。
这是名字空间，不是防冒名鉴权：知道名字即可读取或操作对应存档，改名视为新玩家。
不支持maidN/valetN切换串指令归属；缺少名字拒绝。
大厅用户局human:local；Agent局agent:<maid名字>。文件名使用归属哈希，不直接拼接名字路径。
AI窗口为只读观看，用户局窗口可操作。窗口关闭不结束局。
OpenWindow可单独调用；openWindow=true可随普通调用打开。
未开局先OpenWindow可能显示无局错误，应先StartGame。

## 命令
GetState、StartGame、OpenWindow、Hammer、BuyItem、UseItem、BuyRelic、Tribute、Watch、Slay。
参数见plugin-manifest.json。
GetState返回完整state，含背包、五种概率、遗物、道具、余额、收入、贡金、生命、商店。
查询不创建局、不推送UI事件。
StartGame无存档则创建，有存档则读取（包括结束局），不因新seed改变原局；任何重开均须overwrite=true。

## 数字后缀串指令
command1=BuyItem,itemId1=protect
command2=UseItem,itemId2=protect,swordId2=s1
command3=Hammer,swordId3=s1,count3=10
command4=GetState

从1连续编号，最多32步；不能混用command和commandN。
整串占用同局队列，其他请求不得插入。
失败即停；此前成功步骤保留，不整串回滚。不要重放已成功的购买。
返回ok/partial/failedStep/skipped/results/events/state。
公共revision只约束第一步；公共runId约束所有非StartGame步骤。
每个有变更批次只推送一次，窗口合成音效只聚合一次；查询不推送。

## 存储和边界
主进程在 app.getPath('userData')/ForgeTax/sessions 保存归属哈希命名JSON。
每步先写临时文件后rename；保存失败回退当前步骤。
浏览器直接打开依旧为localStorage离线模式，两个模式存档不自动迁移。
主进程模式尚未实现统一排行榜；页面本机榜仍仅展示旧离线数据，不代表AI权威榜。
本次未部署H:\MCP\VCPChat，未提交Git；实际分布式传输端到端身份注入尚待现场验收。

## 验证
node --test tests/game-launcher.test.js tests/forge-tax-session.test.cjs tests/forge-tax.test.js tests/forge-tax-audio.test.js
Electron运行 tests/forge-tax-ipc-smoke.cjs：
可信身份缺失/署名不一致拒绝、只读窗口写入拒绝、单批更新、关闭后查询恢复、用户AI隔离。
Electron运行 tests/forge-tax-electron-smoke.cjs：离线无模态、操作、存档恢复。
测试直接调用插件入口并注入可信上下文，不等于真实远端execute_tool链路验收。