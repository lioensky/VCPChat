# ForgeTax · AI 简明手册

你是给魔王锻剑的铁匠。锤子免费，剑是筹码。目标是获得尽可能高的累计收入；背包有+99圣剑时，也可选择弑王取得真结局。

## 一分钟理解玩法
- 每天获得3把价值100的铁剑，旧剑跨天保留。
- 锻造无限次、无费用。可敲1/3/5/10下；批量仍逐锤判定，碎剑立即停。
- 结果有破碎、损坏、维持、成功、大成功。成功+1，大成功+2，提升价值；成功也可能自动进化，改变后续锻造特性。
- 破碎失去整把剑；损坏降低价值并增加裂痕。持续锻造也累积危险，实际概率看该剑probabilities，不能拿初始概率估算旧剑。
- 每把剑独立累积10格专注，触发5次安全锤。安全锤不充能、不实际破碎或损坏，但风险与判定型遗物效果仍累积；退出专注并不安全。
- 每天选任意数量的剑上贡：认定总价达到target则达标，售剑现金到账，上贡的剑消失。旧现金不能补今日贡金。
- 累计两天不达标死亡，成功不会清除此前失败；空上贡也会结束当天。
- 累计收入不是现金余额：买东西不扣收入。当前口径为上贡实际到账金额，拾荒现金不计收入。
- 任意可强化剑达到+99即圣剑。Slay主动结束游戏；不调用则可以继续玩。

## 商店与道具
遗物机每日3件，普通/稀有/传说用1/2/3把从未敲过的基础铁剑兑换。
材料须：type=iron、level=0、hits=0、broken=false。
固定8槽，满槽购买必须提供replaceId；同名不能重复持有。效果看description。

道具商店第1、4、7…天刷新，期间持续开放。每件每轮最多买3个，价格依次为基础价1/2/4倍；看shops.items的price与bought。
- iron：买一把基础铁剑。
- protect：保护石，绑定一把剑，下一普通锤拦截实际损坏/破碎，风险仍累积。
- bless：祝福石，绑定一把剑，下一普通锤成功与大成功权重翻倍，不是必成功。
- trade：交易卷，下一天额外获得2把铁剑。
- watch：怀表，通过Watch使用，撤销最近操作末尾可回退的实际失败，恢复附带收益及随机状态。只有canUndo=true才可用；继续操作可能关闭撤销窗口，重复同样锤打不能免费重抽。

## 决策提示，不是保胜公式
先保证今天有可交付的剑，再决定剩余剑赌多大。
达标剑可以留在背包作为退路，未必需要全部卖掉。
防碎提高容错，但后期贡金上涨需要增值/暴击；八槽满后转型要牺牲旧组件。
专注快满是机会，不是免死承诺；进入专注前那一普通锤仍可能碎。
十连省调用但不能中途停手，也不能逐锤使用怀表。高价值、高风险或想及时止盈时用1/3下。

## 插件与身份
tool_name = ForgeTax。
顶层maid名字决定存档；始终使用自己的相同名字。无需可信Agent上下文。这不是防冒名鉴权：改名字会读取另一名字的存档。
用户与AI独立存档。AI窗口只读观看，关闭窗口不结束游戏。
先StartGame再OpenWindow；GetState不会自动开局。
当前主进程统一排行榜尚未接入，不要把离线页面本机榜当AI公共榜。

## 单步命令速查
| command | 参数 |
|---|---|
| StartGame | 无存档新建，有存档续读（包括结束局）；重开须overwrite=true；seed只在新建时有效 |
| GetState | 可选runId、revision |
| OpenWindow | 单独调用，打开/聚焦自己的观看窗口 |
| Hammer | swordId，count=1/3/5/10 |
| BuyItem | itemId=iron/watch/protect/bless/trade |
| UseItem | itemId=protect/bless/trade；前两者需swordId |
| BuyRelic | relicId，swordIds；满8槽需replaceId |
| Tribute | swordIds；空交明确传[] |
| Watch | 无动作参数，先确认canUndo |
| Slay | 背包须有+99圣剑，执行即结束 |

swordIds可传JSON数组字符串或逗号分隔ID。剑ID只取回执，不猜。
普通调用可带openWindow=true；查询无需开窗。
动作可带runId/revision避免旧状态误操作。跨局后必须更新runId与剑ID。

## 省Token操作法
1. 首次GetState，或StartGame直接取返回state。成功动作已经返回最新完整state，不必再接GetState。
2. 熟悉命令后，只传command及必要参数；不写长reason，不复述全部背包。
3. 将确定的购物与用道具合成串指令。锻造中途需要决策时，拆成下一次调用。
4. 用一条Hammer(count=3/5/10)替代多条Hammer(count=1)，但只在愿意承担整段风险时这样做。
5. 每步结果含state，长串会扩大回执；只串真正连贯的短操作链，不为了“省调用”堆满32步。
6. 当前没有compact、字段投影或省略state参数。不要发不存在的精简选项；减少冗余查询和步骤才是现有接口的省Token方式。

### 串指令例子
以下是参数示意，不是可直接执行的工具请求。实际调用按VCP工具格式包裹各字段。
```text
tool_name = ForgeTax
maid = 自己固定使用的名字
command1 = BuyItem
itemId1 = protect
command2 = UseItem
itemId2 = protect
swordId2 = s7
command3 = Hammer
swordId3 = s7
count3 = 3
```
仅在现金足够、商店未售罄、s7存在且未绑定保护时使用这条链。

编号必须从1连续，最多32步；不能混用command与commandN。
公共参数可继承，带编号参数覆盖公共参数。公共revision仅约束第一步；公共runId约束所有非StartGame步骤。
整串锁定同局执行顺序，其他操作不会插入。整串只推送一包事件、播放一段聚合音效。

## 如何读回执
- state：本次结束后的最新完整状态。
- results：每一步的ok/error/events/state。
- events：整串汇总事件，hammer包含逐锤结果及blocked标记。
- ok=false：有一步失败。看failedStep、error与skipped。
- partial=true：此前有成功步骤，已提交，不会整串回滚。
- 不要原样重放整串！先看state，修正失败步骤，后续操作另起调用。
- 状态过期：重新GetState后决策；钱不足、材料不足等业务错误则从失败回执state即可判断。
- 超时或连接中断意味着结果未知，先查询核对，不盲目重买。

### 常用状态字段
runId/revision；day/target/nextTarget/lives/status；
cash/income；swords（id/value/level/type/hits/focus/cracks/probabilities/broken）；
relics及description；items/canUndo/pendingIron；shops.relics/items。
probabilities顺序：破碎、损坏、维持、成功、大成功；数值0~1。