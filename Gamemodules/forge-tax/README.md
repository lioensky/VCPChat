# ForgeTax · 锻造模拟器

## 启动
游戏大厅 gameId `forgeTax` 打开独立沙箱窗口。也可直接用现代浏览器打开 index.html。
源码主进程注册表变更需要重启源码版 VChat。没有自动复制到 H:\MCP\VCPChat 部署目录。
engine.js 无 DOM / Electron 依赖，CommonJS 与浏览器均可使用。

## 首版规则
- 每天3把价值100的铁剑，旧剑跨天保留；普通锤无限、免费。
- 初始贡金400，后续按1.58倍增长（首版调参值）。
- 当日上贡剑达到目标才达标；钱全额到账，旧现金不可补贡。
- 累计两天未达标死亡；+99剑均升格圣剑，可主动弑王结束。
- 独立单剑专注10格触发5安全锤；安全锤不充能。
- 安全锤仍抽取五种结果、累积风险及判定型遗物效果，仅拦截实际损坏/破碎。
- 24种遗物，固定8槽。每日3件，普通/稀有/传说兑换1/2/3把未敲过的基础铁剑。
- 满槽购买必须明确 replaceId，验证与扣材料原子执行；同名不重复。
- 道具商店第1/4/7…天刷新，周期内持续开放；每件限3，价格1/2/4倍。
- 怀表撤销最近操作末尾实际失败，含附带收益、随机状态；后续成功/操作关闭撤销窗口。
- 大成功强化+2，普通成功+1；进化最多两次，首版随机自动选择，无进化选择弹窗。
- 本机榜仅收录结束局，按上贡实际到账累计收入排序；花费不扣分，拾荒奖励不计。
- 金钱上限为 Number.MAX_SAFE_INTEGER。初版概率与数值尚需试玩平衡。

## 规则接口
```js
const { Engine } = require('./engine');
const game = new Engine({ seed: 123, player: 'Ryan' });
// 或 new Engine({ save: serializedSave })
game.getState();  // 深拷贝：背包、概率、八槽遗物、余额、收入、命、目标、两个商店等
game.exportSave(); // 含RNG、撤销快照等内部持久化状态
game.dispatch({ type: 'hammer', swordId: 's1', count: 3, revision: 0 });
```
动作成功：`{ ok: true, events: [...], state: {...} }`
动作失败：`{ ok: false, error: '...', events: [], state: {...} }`
失败不改变状态。revision可选；提供时拒绝过期动作，成功动作单调递增。

支持动作：
- hammer: swordId, count（1/3/5/10）
- use: itemId（protect/bless/trade）, swordId（前两者必需）
- watch
- buyItem: itemId（iron/watch/protect/bless/trade）
- buyRelic: relicId, swordIds（准确材料数量）, replaceId（满八槽必需）
- tribute: swordIds（可为空；数组顺序首剑适用魔王御印）
- slay

浏览器入口 `window.forgeTaxGame` 提供 getState/dispatch/exportSave；
dispatch 同时更新界面、日志和自动存档，不是外部鉴权入口。
事件包含逐锤 hammer、focus、evolution、relic、tribute、day、end 等。

## 存档与身份边界
localStorage：forge-tax-save-v1 / forge-tax-board-v1。
当前只有一个活动存档；用户名称用于展示，可自填。本机存档和榜单可修改。
尚无 maid 鉴权、AI IPC、可信公共榜、多身份存档、跨设备同步。
后续由主进程权威服务持有引擎，入口统一采用已验证 maid 身份；
用户按钮与AI操作共用规则，禁止并发写同局，前端只消费状态/事件。
不要把浏览器中的名字或本机收入直接当可信成绩。

## 验证
`node --test tests/forge-tax.test.js tests/game-launcher.test.js`
规则覆盖专注、破碎、怀表原子回退、商店、八槽、贡金、真结局。
真实Electron视觉、点玩与平衡性需要额外验收。