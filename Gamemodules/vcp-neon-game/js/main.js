import { AudioSystem } from "./audio.js";
import { BUFFS, ELITES, ENEMIES, FINAL_BOSS, FUSIONS, WEAPONS } from "./config.js";
import { Game, UI } from "./game.js";

const canvas = document.querySelector("#game-canvas");
const audio = new AudioSystem();
const ui = new UI();
const game = new Game(canvas, ui, audio);

ui.onChoose = (choice) => game.chooseUpgrade(choice);

document.querySelector("#start-button").addEventListener("click", () => {
  game.start();
});

document.querySelector("#restart-button").addEventListener("click", () => {
  game.start();
});

document.querySelector("#sound-button").addEventListener("click", (event) => {
  const enabled = audio.toggleAll();
  event.currentTarget.textContent = enabled ? "声音 ON" : "声音 OFF";
  game.say(enabled ? "Nova: 8bit 声卡上线，开始电子蹦迪。" : "Nova: 静音模式。现在只剩你和弹幕的沉默。");
});

const mobileControlButton = document.querySelector("#mobile-control-button");
const mobileControlLabels = {
  auto: "移动控制 自动",
  on: "移动控制 开",
  off: "移动控制 关",
};

function syncMobileControlButton() {
  mobileControlButton.textContent = mobileControlLabels[game.mobileControlsMode] || mobileControlLabels.auto;
}

mobileControlButton.addEventListener("click", () => {
  game.cycleMobileControlsMode();
  syncMobileControlButton();
});

syncMobileControlButton();

const codexButton = document.querySelector("#codex-button");
const codexScreen = document.querySelector("#codex-screen");
const codexCloseButton = document.querySelector("#codex-close-button");
const codexTabs = [...document.querySelectorAll(".codex-tab")];
const codexContent = document.querySelector("#codex-content");

const enemyHotTakes = {
  mosquito: "它看起来只是小蚊子，实际是把 8K 上下文咬成乱码的 Token 吸血鬼。击败它，等于给显存做驱蚊护理。",
  prompt: "移动提示词炮台，逮到你就开始直线输出废话。请及时打爆，避免它把战场变成需求评审会议。",
  shard: "上下文碎片成精，死了还会继续拆小号。早点清理，否则它会现场表演“一个 bug 开三张工单”。",
  charger: "经典 while(true) 健身狂魔，脑子里只有冲锋。击败它，是为了证明循环必须有退出条件。",
  eye: "幻觉之眼，专门把红弹幕撒成漂亮烟花骗你接。不要欣赏，欣赏就会进入事故复盘。",
  paradox: "提示词悖论会同时证明“你该站着”和“你不该站着”。最好别参与辩论，直接物理反驳。",
  tokenpile: "幻觉累积 Token，看起来像经验包，实际是模型开始一本正经胡说八道后的沉淀物。打爆它，给上下文减肥。",
  chunkmiss: "网络波动 ChunkMiss，移动像丢包，靠近像延迟补偿失败。别怪手感，它就是来表演抖动的。",
};

const eliteHotTakes = {
  SystemPromptHacker: "它试图把你的操作系统提示词改成“请站着别动”。建议用全部火力教它什么叫权限边界。",
  "RAG Kraken": "召回触手怪，疑似把十年前购物小票也检索进战斗上下文。击败它，给记忆库做一次海鲜清淤。",
  "Context Overflow Seraph": "上下文溢出大天使，翅膀一扇就是 Token 洪水。击败它，拯救还没被挤爆的注意力窗口。",
  "API云服务商跑路": "最终 BOSS。它不是怪，它是 SLA 事故、账单暴击和接口 502 的集合体。击败它，证明 Runtime 不能被云账单支配。",
};

const skillRoasts = {
  vexus: "VCP 里的 Vexus 是向量数据库；游戏里变成裂针，负责把敌人从“相似召回”升级为“精确扎穿”。",
  wave: "浪潮 V8 本来做语义动力学，到了战场就开始物理涟漪。逻辑联想很复杂，但清小怪这事很朴素。",
  onering: "OneRing 负责统一上下文；游戏里负责统一你周围的安全感。贴脸怪：已读，不敢近身。",
  model: "VCPModel 原本自动路由模型；这里自动路由炮弹。它不问你用哪个模型，只问哪个敌人最该被安排。",
  assistant: "AgentAssistant 在系统里跑异步委托；游戏里跑僚机打工。什么叫自主 Agent？就是你躲弹幕，它替你加班。",
  mail: "VCPSuperMail 是 AI 原生邮件协议；游戏里是带爆炸附件的快递。收件人通常没有机会点拒收。",
  chrome: "ChromeBridge 真实用途是浏览器控制；战场用途是页面切割。网页自动化的尽头，是把敌群切成标签页。",
  openher: "OpenHer 量化情绪；游戏里把低血压迫感折算成火力。越危险越来劲，像极了 deadline 前的开发者。",
  som: "VCP-SOM 本来用语义操控桌面窗口；这里改成抓怪机械臂。窗口能拖，怪也能拖，都是 UI 元素罢了。",
  chiyue: "池月 1 号追踪注意力稀疏分布；游戏里追踪谁该挨揍。被标记不是荣誉，是事故高亮。",
};

const fusionRoasts = {
  geodesic: "测地线洪流：Vexus 和浪潮 V8 握手后，子弹开始沿语义地形找人。敌人：我躲的是弹幕，不是论文。",
  soulmoat: "单一灵魂护城河：OneRing 把安全边界画成霓虹圆环。贴脸单位终于理解了“统一上下文不可侵犯”。",
  swarm: "多模型蜂群调度：VCPModel 负责分工，AgentAssistant 负责群殴。系统架构突然变成空中施工队。",
  futuremail: "未来邮差轰炸链：邮件排程 + 页面扫描 = 延迟爆破办公流。附件已送达，附带爆炸回执。",
  collapse: "情绪注意力坍缩：OpenHer 和池月联动，把情绪波动变成标记爆发。压力越大，敌人越像 KPI。",
};

const buffRecommendations = {
  tools: "看到就拿。工具过载就是临时把 ToolBox 塞满兴奋剂，适合所有“我现在只想爽”的构筑。",
  folding: "弹幕多时优先级极高。ContextFoldingV2 把危险折成经验，堪称把坏消息压缩成成长素材。",
  flow: "跑图、补刀、救场都好用。FlowInvite 像未来的自己发来支援：别问，问就是异步心跳很可靠。",
  levelup: "总 Buff 掉落中的 5% 稀有直升补丁。捡到就像 Runtime 偷偷热更新，立刻多一次三选一构筑机会，看到请尖叫。",
  heal: "总 Buff 掉落中的 3% 欧皇级救命回滚点。30% 最大生命回复，抽到就是 Nova 认证的 SSR 抢救机会。",
};

function monsterPreviewClass(item) {
  return `monster-preview monster-preview-${item.id || item.pattern || "default"}`;
}

const codexData = {
  monsters: [
    ...Object.entries(ENEMIES).map(([id, enemy]) => ({
      id,
      title: enemy.name,
      tag: enemy.shooter ? "直线弹幕" : enemy.splitter ? "死亡分裂" : enemy.charge ? "循环冲锋" : enemy.radial ? "环形幻觉" : enemy.paradox ? "提示词悖论" : enemy.jitter ? "网络抖动" : id === "tokenpile" ? "幻觉堆积" : "基础骚扰",
      desc: enemyHotTakes[id],
      meta: `HP ${enemy.hp} / XP ${enemy.xp} / DAMAGE ${enemy.damage}`,
      preview: true,
    })),
    ...ELITES.map((enemy) => ({
      id: enemy.pattern,
      title: enemy.name,
      tag: `精英 · ${enemy.pattern}`,
      desc: eliteHotTakes[enemy.name],
      meta: `HP ${enemy.hp} / XP ${enemy.xp} / SCORE ${enemy.score}`,
      preview: true,
    })),
    {
      id: FINAL_BOSS.id,
      title: FINAL_BOSS.name,
      tag: "最终 BOSS · 每 8 分钟",
      desc: eliteHotTakes[FINAL_BOSS.name],
      meta: `HP ${FINAL_BOSS.hp} / XP ${FINAL_BOSS.xp} / SCORE ${FINAL_BOSS.score}`,
      preview: true,
    },
  ],
  buffs: BUFFS.map((buff) => ({
    title: `${buff.name} / ${buff.title}`,
    tag: `${buff.duration}s 推荐`,
    desc: buffRecommendations[buff.id],
    meta: buff.desc,
  })),
  skills: WEAPONS.map((weapon) => ({
    title: `${weapon.name} / ${weapon.title}`,
    tag: weapon.tag,
    desc: skillRoasts[weapon.id],
    meta: weapon.desc,
  })),
  fusions: FUSIONS.map((fusion) => ({
    title: fusion.name,
    tag: fusion.parts.map((part) => WEAPONS.find((weapon) => weapon.id === part)?.name || part).join(" + "),
    desc: fusionRoasts[fusion.id],
    meta: fusion.desc,
  })),
};

const codexIntro = {
  monsters: "怪物不是坏，它们只是失控上下文、过度召回和循环 bug 的实体化。为了 Runtime 清爽，请礼貌地把它们打爆。",
  buffs: "Buff 都是临时快乐，不带出本局。看见黄色就像看见免费云额度：别犹豫，先领再说。",
  skills: "这些技能都来自 VCP 系统真实模块，但战场解释权归弹幕所有。技术很严肃，开火很胡闹。",
  fusions: "当两个模块互相耦合，工程师会写文档；游戏会直接给你一件融合神器。",
};

function renderCodex(tab = "monsters") {
  const items = codexData[tab] || codexData.monsters;
  codexTabs.forEach((button) => {
    const active = button.dataset.codexTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  codexContent.innerHTML = `
    <p class="codex-intro">${codexIntro[tab]}</p>
    <div class="codex-grid">
      ${items.map((item) => `
        <article class="codex-card">
          ${item.preview ? `<div class="${monsterPreviewClass(item)}" aria-hidden="true"><i></i><b></b><em></em></div>` : ""}
          <span class="tag">${item.tag}</span>
          <h3>${item.title}</h3>
          <p>${item.desc}</p>
          <small>${item.meta}</small>
        </article>
      `).join("")}
    </div>
  `;
}

function openCodex() {
  ui.hideAllOverlays();
  renderCodex();
  codexScreen.classList.add("active");
  game.say("Nova: 图鉴已打开。先研究敌人，再研究怎么优雅地把它们从上下文里删掉。");
}

function closeCodex() {
  codexScreen.classList.remove("active");
  if (game.state === "start") {
    ui.startScreen.classList.add("active");
  }
}

codexButton.addEventListener("click", openCodex);
codexCloseButton.addEventListener("click", closeCodex);
codexTabs.forEach((button) => {
  button.addEventListener("click", () => renderCodex(button.dataset.codexTab));
});

window.addEventListener("keydown", (event) => {
  if (event.code === "Escape" && codexScreen.classList.contains("active")) {
    closeCodex();
  }
});

game.draw();