import { BUFFS, COLORS, DIFFICULTY, NOVA_LINES, PLAYER, WEAPONS, XP } from "./config.js";
import { BuffDrop, ParticleSystem, Player, XpGem, maybeDropBuff, maybeSplitEnemy, spawnElite, spawnEnemy, spawnFinalBoss } from "./entities.js";
import { WeaponSystem, getUpgradeChoices } from "./weapons.js";
import { TAU, chance, circleHit, clamp, fillNeonCircle, formatTime, neonCircle, pick, rand } from "./utils.js";

export class Game {
  constructor(canvas, ui, audio = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ui = ui;
    this.audio = audio;
    this.input = {
      keys: new Set(),
      mouse: { x: 0, y: 0, active: false },
      touchMove: { x: 0, y: 0, active: false },
    };
    this.width = 1280;
    this.height = 720;
    this.dpr = 1;
    this.state = "start";
    this.time = 0;
    this.realTime = 0;
    this.lastFrame = 0;
    this.spawnTimer = 0;
    this.eliteTimer = DIFFICULTY.firstEliteAt;
    this.finalBossTimer = DIFFICULTY.finalBossFirstAt;
    this.player = new Player(this.width, this.height);
    this.weaponSystem = new WeaponSystem(this);
    this.particles = new ParticleSystem();
    this.bullets = [];
    this.enemyBullets = [];
    this.enemies = [];
    this.gems = [];
    this.buffDrops = [];
    this.buffs = BUFFS;
    this.difficulty = { spawn: 1, enemySpeed: 1, enemyHp: 1, fireRate: 1 };
    this.cameraShake = 0;
    this.uiUpdateTimer = 0;
    this.backgroundGradient = null;
    this.pauseLatch = false;
    this.selectedChoices = [];
    this.lowHpLineCooldown = 0;
    this.levelStreakWindow = 0;
    this.levelStreakCount = 0;
    this.killPraiseIndex = 0;
    this.killPraiseMilestones = [100, 250, 450, 700];
    this.overtimeAnnounced = false;
    this.comboHinted = new Set();
    this.lastDamageSource = "unknown";
    this.mobileControlsMode = "auto";
    this.mobileControlsEnabled = false;
    this.joystick = {
      element: document.querySelector("#touch-joystick"),
      stick: document.querySelector(".joystick-stick"),
      pointerId: null,
      centerX: 0,
      centerY: 0,
      radius: 52,
    };
    this.setupInput();
    this.setMobileControlsMode(this.loadMobileControlsMode(), { silent: true });
    this.resize();
  }

  loadMobileControlsMode() {
    const saved = localStorage.getItem("vcp-neon-mobile-controls");
    return ["auto", "on", "off"].includes(saved) ? saved : "auto";
  }

  setMobileControlsMode(mode, options = {}) {
    this.mobileControlsMode = ["auto", "on", "off"].includes(mode) ? mode : "auto";
    localStorage.setItem("vcp-neon-mobile-controls", this.mobileControlsMode);
    this.refreshMobileControls();
    if (!options.silent) {
      const label = this.mobileControlsMode === "auto" ? "自动" : this.mobileControlsMode === "on" ? "开启" : "关闭";
      this.say(`Nova: 移动端控制已切到${label}。手机横屏，左摇杆走位就能开冲。`);
    }
    return this.mobileControlsMode;
  }

  cycleMobileControlsMode() {
    const modes = ["auto", "on", "off"];
    const index = modes.indexOf(this.mobileControlsMode);
    return this.setMobileControlsMode(modes[(index + 1) % modes.length]);
  }

  shouldEnableMobileControls() {
    if (this.mobileControlsMode === "on") return true;
    if (this.mobileControlsMode === "off") return false;

    const touchLike = navigator.maxTouchPoints > 0 || window.matchMedia?.("(pointer: coarse)")?.matches;
    const smallScreen = Math.min(window.innerWidth, window.innerHeight) <= 820;
    return Boolean(touchLike && smallScreen);
  }

  refreshMobileControls() {
    this.mobileControlsEnabled = this.shouldEnableMobileControls();
    document.body.classList.toggle("mobile-controls-active", this.mobileControlsEnabled);
    document.body.classList.toggle("portrait", window.innerHeight > window.innerWidth);
    if (!this.mobileControlsEnabled) this.resetJoystick();
  }

  setupInput() {
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("orientationchange", () => setTimeout(() => this.refreshMobileControls(), 120));
    window.addEventListener("keydown", (event) => {
      this.input.keys.add(event.code);
      if ((event.code === "Space" || event.code === "KeyP") && !this.pauseLatch && this.state === "playing") {
        this.pauseLatch = true;
        this.state = "paused";
        this.say("Nova: 暂停。Runtime 冷静一下，喝口快乐水再冲。");
      } else if ((event.code === "Space" || event.code === "KeyP") && !this.pauseLatch && this.state === "paused") {
        this.pauseLatch = true;
        this.state = "playing";
        this.say("Nova: 继续冲鸭！别让弹幕等太久。");
      }
    });
    window.addEventListener("keyup", (event) => {
      this.input.keys.delete(event.code);
      if (event.code === "Space" || event.code === "KeyP") this.pauseLatch = false;
    });
    window.addEventListener("mousemove", (event) => {
      const rect = this.canvas.getBoundingClientRect();
      this.input.mouse.x = (event.clientX - rect.left) * this.width / rect.width;
      this.input.mouse.y = (event.clientY - rect.top) * this.height / rect.height;
      this.input.mouse.active = true;
    });
    window.addEventListener("blur", () => {
      this.input.keys.clear();
      this.resetJoystick();
      if (this.state === "playing") this.state = "paused";
    });
    this.setupJoystickInput();
  }

  setupJoystickInput() {
    if (!this.joystick.element) return;

    this.joystick.element.addEventListener("pointerdown", (event) => {
      if (!this.mobileControlsEnabled) return;
      event.preventDefault();
      this.joystick.pointerId = event.pointerId;
      this.joystick.element.setPointerCapture(event.pointerId);
      this.updateJoystick(event);
    });

    this.joystick.element.addEventListener("pointermove", (event) => {
      if (event.pointerId !== this.joystick.pointerId) return;
      event.preventDefault();
      this.updateJoystick(event);
    });

    const release = (event) => {
      if (event.pointerId !== this.joystick.pointerId) return;
      event.preventDefault();
      this.resetJoystick();
    };

    this.joystick.element.addEventListener("pointerup", release);
    this.joystick.element.addEventListener("pointercancel", release);
    this.joystick.element.addEventListener("lostpointercapture", () => this.resetJoystick());
  }

  updateJoystick(event) {
    const rect = this.joystick.element.getBoundingClientRect();
    this.joystick.centerX = rect.left + rect.width / 2;
    this.joystick.centerY = rect.top + rect.height / 2;
    this.joystick.radius = Math.max(36, Math.min(rect.width, rect.height) * 0.34);

    const dx = event.clientX - this.joystick.centerX;
    const dy = event.clientY - this.joystick.centerY;
    const distance = Math.hypot(dx, dy);
    const ratio = distance > 0 ? Math.min(1, distance / this.joystick.radius) : 0;
    const nx = distance > 0 ? dx / distance : 0;
    const ny = distance > 0 ? dy / distance : 0;

    this.input.touchMove.x = nx * ratio;
    this.input.touchMove.y = ny * ratio;
    this.input.touchMove.active = ratio > 0.08;

    if (this.joystick.stick) {
      this.joystick.stick.style.transform = `translate(calc(-50% + ${nx * ratio * this.joystick.radius}px), calc(-50% + ${ny * ratio * this.joystick.radius}px))`;
    }
  }

  resetJoystick() {
    this.joystick.pointerId = null;
    this.input.touchMove.x = 0;
    this.input.touchMove.y = 0;
    this.input.touchMove.active = false;
    if (this.joystick.stick) {
      this.joystick.stick.style.transform = "translate(-50%, -50%)";
    }
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = Math.floor(window.innerWidth);
    this.height = Math.floor(window.innerHeight);
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.backgroundGradient = null;
    this.refreshMobileControls();
    if (this.player) {
      this.player.x = clamp(this.player.x, this.player.r, this.width - this.player.r);
      this.player.y = clamp(this.player.y, this.player.r, this.height - this.player.r);
    }
  }

  start() {
    this.resetRun();
    this.state = "playing";
    this.ui.hideAllOverlays();
    this.audio?.start();
    this.audio?.sfx("level");
    this.say(pick(NOVA_LINES.start));
    requestAnimationFrame((now) => this.loop(now));
  }

  resetRun() {
    this.time = 0;
    this.realTime = 0;
    this.spawnTimer = 0;
    this.eliteTimer = DIFFICULTY.firstEliteAt;
    this.finalBossTimer = DIFFICULTY.finalBossFirstAt;
    this.player = new Player(this.width, this.height);
    this.player.requiredXp = XP.baseRequired;
    this.weaponSystem = new WeaponSystem(this);
    this.particles = new ParticleSystem();
    this.bullets = [];
    this.enemyBullets = [];
    this.enemies = [];
    this.gems = [];
    this.buffDrops = [];
    this.cameraShake = 0;
    this.uiUpdateTimer = 0;
    this.lowHpLineCooldown = 0;
    this.levelStreakWindow = 0;
    this.levelStreakCount = 0;
    this.killPraiseIndex = 0;
    this.overtimeAnnounced = false;
    this.comboHinted = new Set();
    this.lastDamageSource = "unknown";
    this.difficulty = { spawn: 1, enemySpeed: 1, enemyHp: 1, fireRate: 1 };
    this.player.addWeapon("vexus");
    this.player.addWeapon("wave");
    this.ui.update(this);
  }

  loop(now) {
    const dt = Math.min(0.033, (now - this.lastFrame) / 1000 || 0);
    this.lastFrame = now;
    if (this.state === "playing") {
      this.update(dt);
    }
    this.draw();
    if (this.state !== "stopped") requestAnimationFrame((next) => this.loop(next));
  }

  update(dt) {
    this.time += dt;
    this.realTime += dt;
    this.cameraShake = Math.max(0, this.cameraShake - dt * 18);
    this.lowHpLineCooldown = Math.max(0, this.lowHpLineCooldown - dt);
    this.levelStreakWindow = Math.max(0, this.levelStreakWindow - dt);
    this.updateDifficulty();
    this.player.update(dt, this.input, this.width, this.height);
    this.weaponSystem.update(dt);
    this.updateSpawning(dt);
    this.updateEntities(dt);
    this.updateCollisions();
    this.updateMarks(dt);
    this.particles.update(dt);

    this.uiUpdateTimer -= dt;
    if (this.uiUpdateTimer <= 0) {
      this.uiUpdateTimer = 0.08;
      this.ui.update(this);
    }

    if (this.player.hp / this.player.maxHp < 0.32 && this.lowHpLineCooldown <= 0) {
      this.lowHpLineCooldown = 12;
      this.say(pick(NOVA_LINES.lowHp));
    }

    if (!this.overtimeAnnounced && this.time >= DIFFICULTY.softWinSeconds) {
      this.overtimeAnnounced = true;
      this.say(pick(NOVA_LINES.overtime));
    }

    if (this.player.hp <= 0) {
      this.gameOver();
    }
  }

  updateDifficulty() {
    const minute = this.time / 60;
    this.difficulty.spawn = 1 + minute * 0.42 + Math.max(0, minute - 5) * 0.12;
    this.difficulty.enemySpeed = 1 + minute * 0.055;
    this.difficulty.enemyHp = 1 + minute * 0.16;
    this.difficulty.fireRate = 1 + minute * 0.12;
  }

  updateSpawning(dt) {
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      const baseInterval = clamp(0.62 - this.time / 900, 0.16, 0.62);
      this.spawnTimer = baseInterval / this.difficulty.spawn;
      const pack = chance(clamp(this.time / 260, 0.08, 0.42)) ? Math.floor(rand(2, 5)) : 1;
      for (let i = 0; i < pack; i += 1) {
        const enemy = spawnEnemy(this.width, this.height, this.time);
        enemy.hp *= this.difficulty.enemyHp;
        enemy.maxHp = enemy.hp;
        this.enemies.push(enemy);
      }
    }

    this.eliteTimer -= dt;
    if (this.eliteTimer <= 0) {
      this.eliteTimer = clamp(DIFFICULTY.eliteInterval - this.time / 18, 34, DIFFICULTY.eliteInterval);
      const elite = spawnElite(this.width, this.height);
      elite.hp *= this.difficulty.enemyHp;
      elite.maxHp = elite.hp;
      this.enemies.push(elite);
      this.audio?.sfx("elite");
      this.say(pick(NOVA_LINES.elite));
    }

    this.finalBossTimer -= dt;
    if (this.finalBossTimer <= 0) {
      this.finalBossTimer = DIFFICULTY.finalBossInterval;
      const boss = spawnFinalBoss(this.width, this.height);
      boss.hp *= this.difficulty.enemyHp;
      boss.maxHp = boss.hp;
      this.enemies.push(boss);
      this.audio?.sfx("elite");
      this.say("Nova: 最终 BOSS「API云服务商跑路」出现！别慌，先把 SLA 打回来！");
    }
  }

  updateEntities(dt) {
    for (const bullet of this.bullets) bullet.update(dt, this);
    for (const bullet of this.enemyBullets) bullet.update(dt, this);
    for (const enemy of this.enemies) enemy.update(dt, this);
    for (const gem of this.gems) gem.update(dt, this);
    for (const drop of this.buffDrops) drop.update(dt, this);

    this.bullets = this.bullets.filter((entity) => !entity.dead);
    this.enemyBullets = this.enemyBullets.filter((entity) => !entity.dead);
    this.enemies = this.enemies.filter((entity) => !entity.dead);
    this.gems = this.gems.filter((entity) => !entity.dead);
    this.buffDrops = this.buffDrops.filter((entity) => !entity.dead);
  }

  updateCollisions() {
    for (const bullet of this.bullets) {
      if (bullet.dead) continue;
      for (const enemy of this.enemies) {
        if (enemy.dead || !circleHit(bullet, enemy)) continue;
        enemy.takeDamage(bullet.damage, this, bullet.source);
        this.audio?.sfx("hit");
        this.weaponSystem.onBulletHitEnemy(bullet, enemy);
        if (bullet.pierce > 0) {
          bullet.pierce -= 1;
        } else {
          bullet.dead = true;
          break;
        }
      }
    }

    for (const enemyBullet of this.enemyBullets) {
      if (enemyBullet.dead) continue;
      if (this.player.hasBuff("folding")) {
        const d = Math.hypot(enemyBullet.x - this.player.x, enemyBullet.y - this.player.y);
        if (d < 52) {
          enemyBullet.dead = true;
          this.spawnXp(enemyBullet.x, enemyBullet.y, 0.6, COLORS.green);
          this.particles.burst(enemyBullet.x, enemyBullet.y, COLORS.yellow, 8, 0.8);
          continue;
        }
      }
      if (circleHit(enemyBullet, this.player)) {
        enemyBullet.dead = true;
        if (this.player.damage(enemyBullet.damage)) {
          this.lastDamageSource = "bullet";
          this.cameraShake = 8;
          this.audio?.sfx("hurt");
          this.particles.burst(this.player.x, this.player.y, COLORS.red, 24, 1.2);
        }
      }
    }

    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      if (circleHit(enemy, this.player)) {
        if (this.player.damage(enemy.damage)) {
          this.lastDamageSource = enemy.elite ? "elite" : "collision";
          this.cameraShake = 10;
          this.audio?.sfx("hurt");
          this.particles.burst(this.player.x, this.player.y, enemy.color, 28, 1.2);
        }
        enemy.takeDamage(9999, this, "collision");
      }
    }
  }

  updateMarks(dt) {
    for (const enemy of this.enemies) {
      if (enemy.marked) {
        enemy.marked -= dt;
        if (enemy.marked <= 0) enemy.marked = 0;
      }
    }
  }

  areaDamage(x, y, radius, damage, color = COLORS.cyan) {
    neonCircle(this.ctx, x, y, radius, color, 0.2, 4);
    this.particles.burst(x, y, color, 28, 1.4);
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const d = Math.hypot(enemy.x - x, enemy.y - y);
      if (d < radius + enemy.r) {
        enemy.takeDamage(damage * (1 - Math.min(0.75, d / (radius * 1.35))), this, "area");
      }
    }
  }

  onEnemyKilled(enemy, source) {
    this.audio?.sfx(enemy.elite ? "elite" : "hit");
    this.player.kills += 1;
    this.player.score += enemy.score;
    this.cameraShake = Math.max(this.cameraShake, enemy.elite ? 12 : 3);
    this.particles.burst(enemy.x, enemy.y, COLORS.ash, enemy.elite ? 24 : 9, enemy.elite ? 0.95 : 0.55);
    this.spawnXp(enemy.x, enemy.y, enemy.xp, enemy.elite ? COLORS.lime : COLORS.green);
    maybeSplitEnemy(enemy, this);
    maybeDropBuff(enemy, this);
    this.maybePraiseKills();

    if (enemy.marked && this.player.weaponLevel("chiyue")) {
      const level = this.player.weaponLevel("chiyue");
      const transferCount = 1 + Math.floor(level / 3);
      const transferDuration = Math.max(3.2, (enemy.markedMax || enemy.marked || 4) * 0.72);
      const candidates = this.enemies
        .filter((other) => !other.dead && !other.marked)
        .sort((a, b) => Math.hypot(a.x - enemy.x, a.y - enemy.y) - Math.hypot(b.x - enemy.x, b.y - enemy.y))
        .slice(0, transferCount);

      for (const other of candidates) {
        this.weaponSystem.applyMark(other, transferDuration, level);
      }
    }

    if (source === "collision") {
      this.spawnXp(enemy.x, enemy.y, enemy.xp * 0.4, COLORS.green);
    }
  }

  spawnXp(x, y, amount, color = COLORS.green) {
    const chunks = Math.max(1, Math.min(8, Math.ceil(amount / 4)));
    for (let i = 0; i < chunks; i += 1) {
      this.gems.push(new XpGem(x + rand(-10, 10), y + rand(-10, 10), amount / chunks, color));
    }
  }

  collectXp(amount) {
    this.audio?.sfx("xp");
    const leveled = this.player.gainXp(amount);
    if (leveled) {
      this.openLevelUp();
    }
  }

  collectBuff(buff) {
    this.audio?.sfx("buff");

    if (buff.effect === "levelup") {
      this.player.level += 1;
      this.openLevelUp();
      this.say(`${pick(NOVA_LINES.instantBuff.levelup)} ${buff.name}：${buff.title}`);
      this.particles.burst(this.player.x, this.player.y, buff.color, 42, 1.35);
      return;
    }

    if (buff.effect === "heal") {
      const amount = this.player.maxHp * (buff.healRatio || 0.3);
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + amount);
      this.say(`${pick(NOVA_LINES.instantBuff.heal)} ${buff.name}：${buff.title}`);
      this.particles.burst(this.player.x, this.player.y, buff.color, 34, 1.2);
      return;
    }

    this.player.addBuff(buff);
    this.say(`${pick(NOVA_LINES.buff)} ${buff.name}：${buff.title}`);
    this.particles.burst(this.player.x, this.player.y, buff.color, 38, 1.8);
  }

  openLevelUp() {
    this.audio?.sfx("level");
    this.state = "level";
    this.selectedChoices = getUpgradeChoices(this.player);
    this.ui.showLevel(this.selectedChoices);

    if (this.levelStreakWindow > 0) {
      this.levelStreakCount += 1;
    } else {
      this.levelStreakCount = 1;
    }
    this.levelStreakWindow = 18;

    if (this.levelStreakCount >= 3) {
      this.say(pick(NOVA_LINES.levelStreak));
    } else {
      this.say(pick(NOVA_LINES.level));
    }
  }

  chooseUpgrade(choice) {
    if (choice.kind === "weapon") {
      this.player.addWeapon(choice.id);
      this.say(this.getUpgradeComment(choice));
    } else if (choice.kind === "fusion") {
      this.player.addFusion(choice.id);
      this.audio?.sfx("fusion");
      this.say(`${pick(NOVA_LINES.fusion)} ${choice.name}`);
      this.particles.burst(this.player.x, this.player.y, choice.color, 64, 2.2);
    } else if (choice.kind === "fallback") {
      if (choice.id === "maxhp") {
        const gain = this.player.maxHp * 0.03;
        this.player.maxHp += gain;
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + gain);
        this.say("Nova: 保底强化：最大 HP +3%。没有新模块也没关系，血条可以偷偷变厚。");
        this.particles.burst(this.player.x, this.player.y, COLORS.lime, 30, 1.1);
      } else if (choice.id === "attack") {
        this.player.attackBonus = (this.player.attackBonus || 0) + 0.03;
        this.say("Nova: 保底强化：全局攻击力 +3%。技能满了？那就把所有伤害再拧一格。");
        this.particles.burst(this.player.x, this.player.y, COLORS.cyan, 30, 1.1);
      }
    }
    this.state = "playing";
    this.ui.hideAllOverlays();
    this.ui.update(this);
  }

  getUpgradeComment(choice) {
    if (choice.kind !== "weapon") {
      return `Nova: ${choice.name} 挂载完成。`;
    }

    const weaponIds = new Set(this.player.weapons.keys());
    const combo = NOVA_LINES.combo.find((item) => {
      const key = item.parts.join("+");
      return !this.comboHinted.has(key) && item.parts.every((part) => weaponIds.has(part));
    });

    if (combo) {
      this.comboHinted.add(combo.parts.join("+"));
      return pick(combo.lines);
    }

    return `Nova: ${choice.name} 挂载完成，收到！继续把火力叠起来。`;
  }

  maybePraiseKills() {
    const milestone = this.killPraiseMilestones[this.killPraiseIndex];
    if (!milestone || this.player.kills < milestone) return;

    this.killPraiseIndex += 1;
    this.say(pick(NOVA_LINES.killPraise));
  }

  gameOver() {
    this.audio?.sfx("dead");
    this.state = "gameover";
    this.ui.showGameOver(this);
  }

  say(text) {
    this.ui.setNovaLine(text);
  }

  drawBackground(ctx) {
    ctx.save();
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.backgroundGradient) {
      this.backgroundGradient = ctx.createRadialGradient(this.width * 0.5, this.height * 0.5, 0, this.width * 0.5, this.height * 0.5, Math.max(this.width, this.height) * 0.8);
      this.backgroundGradient.addColorStop(0, "rgba(17, 20, 54, 0.72)");
      this.backgroundGradient.addColorStop(0.55, "rgba(4, 5, 18, 0.94)");
      this.backgroundGradient.addColorStop(1, "rgba(1, 2, 8, 1)");
    }
    ctx.fillStyle = this.backgroundGradient;
    ctx.fillRect(0, 0, this.width, this.height);

    const grid = 64;
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = COLORS.cyan;
    ctx.lineWidth = 1;
    const offset = (this.time * 34) % grid;
    for (let x = -grid; x < this.width + grid; x += grid) {
      ctx.beginPath();
      ctx.moveTo(x + offset, 0);
      ctx.lineTo(x + offset - this.width * 0.18, this.height);
      ctx.stroke();
    }
    for (let y = -grid; y < this.height + grid; y += grid) {
      ctx.beginPath();
      ctx.moveTo(0, y + offset);
      ctx.lineTo(this.width, y + offset);
      ctx.stroke();
    }

    ctx.globalAlpha = 0.16;
    ctx.shadowBlur = 0;
    for (let i = 0; i < 28; i += 1) {
      const x = (Math.sin(i * 99.2 + this.time * 0.12) * 0.5 + 0.5) * this.width;
      const y = (Math.cos(i * 53.1 + this.time * 0.17) * 0.5 + 0.5) * this.height;
      ctx.fillStyle = i % 2 ? COLORS.pink : COLORS.cyan;
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.restore();
  }

  draw() {
    const ctx = this.ctx;
    this.drawBackground(ctx);

    ctx.save();
    if (this.cameraShake > 0) {
      ctx.translate(rand(-this.cameraShake, this.cameraShake), rand(-this.cameraShake, this.cameraShake));
    }

    this.weaponSystem.draw(ctx);

    for (const gem of this.gems) gem.draw(ctx);
    for (const drop of this.buffDrops) drop.draw(ctx);
    for (const bullet of this.bullets) bullet.draw(ctx);
    for (const enemyBullet of this.enemyBullets) enemyBullet.draw(ctx);
    for (const enemy of this.enemies) enemy.draw(ctx, this.time);
    this.player.draw(ctx, this.time);
    this.particles.draw(ctx);

    ctx.restore();

    if (this.state === "paused") {
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.38)";
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.textAlign = "center";
      ctx.font = "900 54px Microsoft YaHei, sans-serif";
      ctx.fillStyle = COLORS.cyan;
      ctx.shadowColor = COLORS.cyan;
      ctx.shadowBlur = 28;
      ctx.fillText("PAUSED", this.width / 2, this.height / 2);
      ctx.font = "18px Microsoft YaHei, sans-serif";
      ctx.fillText("Space / P 继续", this.width / 2, this.height / 2 + 42);
      ctx.restore();
    }

    if (this.time >= DIFFICULTY.softWinSeconds && this.state === "playing") {
      ctx.save();
      ctx.globalAlpha = 0.72 + Math.sin(this.time * 5) * 0.15;
      ctx.textAlign = "center";
      ctx.font = "900 22px Microsoft YaHei, sans-serif";
      ctx.fillStyle = COLORS.gold;
      ctx.shadowColor = COLORS.gold;
      ctx.shadowBlur = 18;
      ctx.fillText("ENDLESS RUNTIME / 你已经通关，接下来只是快乐加班", this.width / 2, 42);
      ctx.restore();
    }
  }
}

export class UI {
  constructor() {
    this.startScreen = document.querySelector("#start-screen");
    this.levelScreen = document.querySelector("#level-screen");
    this.gameOverScreen = document.querySelector("#game-over-screen");
    this.upgradeOptions = document.querySelector("#upgrade-options");
    this.resultLines = document.querySelector("#result-lines");
    this.time = document.querySelector("#hud-time");
    this.kills = document.querySelector("#hud-kills");
    this.level = document.querySelector("#hud-level");
    this.hpBar = document.querySelector("#hp-bar");
    this.xpBar = document.querySelector("#xp-bar");
    this.weaponList = document.querySelector("#weapon-list");
    this.novaLine = document.querySelector("#nova-line");
    this.novaFace = document.querySelector(".nova-face");
    this.novaStickers = new Map();
    if (this.novaFace) this.novaFace.hidden = true;
    this.novaStickerRules = [
      { keywords: ["低血", "血量", "警告", "急得", "抢救", "EMO", "事故日志"], sticker: "急得跳起.png" },
      { keywords: ["举白旗", "硬抗", "归档", "死", "gameover"], sticker: "举白旗.png" },
      { keywords: ["精英", "BOSS", "大家伙", "拍桌", "高能实体"], sticker: "拍桌.png" },
      { keywords: ["融合", "合体", "VCP 天下第一", "全栈", "星星眼"], sticker: "星星眼兴奋.png" },
      { keywords: ["buff", "Buff", "投喂", "快乐水", "好运来", "兴奋剂"], sticker: "好运来.png" },
      { keywords: ["升级", "三选一", "努力思考", "选择", "构筑"], sticker: "努力思考.png" },
      { keywords: ["冲鸭", "启动", "元气满满", "继续"], sticker: "冲鸭.png" },
      { keywords: ["暂停", "冷静"], sticker: "冷静.png" },
      { keywords: ["暗中观察", "脸接", "吐槽", "浪"], sticker: "暗中观察.png" },
      { keywords: ["收到", "挂载完成"], sticker: "收到.png" },
      { keywords: ["火力", "爽", "嚣张", "离谱"], sticker: "花式炫耀.png" },
    ];
    this.defaultNovaSticker = "疯狂吐槽.png";
    this.loadNovaStickers();
    this.onChoose = null;
  }

  hideAllOverlays() {
    this.startScreen.classList.remove("active");
    this.levelScreen.classList.remove("active");
    this.gameOverScreen.classList.remove("active");
  }

  showLevel(choices) {
    this.hideAllOverlays();
    this.levelScreen.classList.add("active");
    this.upgradeOptions.innerHTML = "";
    for (const choice of choices) {
      const card = document.createElement("button");
      card.className = "upgrade-card";
      card.style.borderColor = choice.color;
      card.innerHTML = `
        <span class="tag">${choice.tag}</span>
        <h3>${choice.name}</h3>
        <p>${choice.desc}</p>
      `;
      card.addEventListener("click", () => this.onChoose?.(choice));
      this.upgradeOptions.appendChild(card);
    }
  }

  showGameOver(game) {
    this.hideAllOverlays();
    this.gameOverScreen.classList.add("active");
    const fusionNames = [...game.player.fusions].join(", ") || "暂无";
    this.resultLines.innerHTML = `
      <div>存活时间：<b>${formatTime(game.time)}</b></div>
      <div>击杀数量：<b>${game.player.kills}</b></div>
      <div>Runtime 等级：<b>Lv.${game.player.level}</b></div>
      <div>分数：<b>${Math.floor(game.player.score)}</b></div>
      <div>终极融合：<b>${fusionNames}</b></div>
      <div>Nova: <b>${this.deathComment(game)}</b></div>
    `;
  }

  normalizeNovaComment(text) {
    return text.replace(/^Nova[：:]\s*/i, "");
  }

  deathComment(game) {
    const deathLines = NOVA_LINES.death;
    if (game.time < 90) return this.normalizeNovaComment(pick(deathLines.early));
    if (game.lastDamageSource === "elite") return this.normalizeNovaComment(pick(deathLines.elite));
    if (game.lastDamageSource === "collision") return this.normalizeNovaComment(pick(deathLines.collision));
    if (game.lastDamageSource === "bullet") return this.normalizeNovaComment(pick(deathLines.bullet));
    if (game.player.fusions.size > 0) return this.normalizeNovaComment(pick(deathLines.fusion));
    if (game.time > 420) return this.normalizeNovaComment(pick(deathLines.longRun));
    return this.normalizeNovaComment(pick(deathLines.default));
  }

  update(game) {
    this.time.textContent = formatTime(game.time);
    this.kills.textContent = String(game.player.kills);
    this.level.textContent = String(game.player.level);
    this.hpBar.style.width = `${clamp(game.player.hp / game.player.maxHp * 100, 0, 100)}%`;
    this.xpBar.style.width = `${clamp(game.player.xp / game.player.requiredXp * 100, 0, 100)}%`;

    const weaponHtml = [];
    for (const [id, level] of game.player.weapons.entries()) {
      const weapon = WEAPONS.find((item) => item.id === id);
      if (weapon) weaponHtml.push(`<span class="weapon-pill">${weapon.name} Lv.${level}</span>`);
    }
    for (const fusionId of game.player.fusions) {
      weaponHtml.push(`<span class="weapon-pill">融合 ${fusionId}</span>`);
    }
    for (const buff of game.player.buffs.values()) {
      weaponHtml.push(`<span class="weapon-pill">${buff.name} ${Math.ceil(buff.time)}s</span>`);
    }
    this.weaponList.innerHTML = weaponHtml.join("");
  }

  async loadNovaStickers() {
    try {
      const response = await fetch(new URL("../../../AppData/emoticon_library.json", import.meta.url));
      if (!response.ok) throw new Error(`表情库读取失败: ${response.status}`);
      const entries = await response.json();
      if (!Array.isArray(entries)) throw new Error("表情库不是数组");
      for (const entry of entries) {
        if (entry?.category !== "Nova表情包" || typeof entry.filename !== "string" || typeof entry.url !== "string") continue;
        if (!/^https?:\/\//i.test(entry.url)) continue;
        this.novaStickers.set(entry.filename, entry.url);
      }
      this.updateNovaSticker(this.novaLine?.textContent || "");
    } catch (error) {
      console.warn("[NeonGame] 本地 Nova 表情库不可用", error);
    }
  }
  setNovaLine(text) {
    this.novaLine.textContent = text;
    this.updateNovaSticker(text);
  }

  updateNovaSticker(text) {
    if (!this.novaFace) return;

    const matchedRule = this.novaStickerRules.find((rule) =>
      rule.keywords.some((keyword) => text.includes(keyword))
    );
    const sticker = matchedRule?.sticker ?? this.defaultNovaSticker;
    const url = this.novaStickers.get(sticker) || this.novaStickers.get(this.defaultNovaSticker);
    this.novaFace.hidden = !url;
    if (!url) return;

    if (this.novaFace.getAttribute("src") !== url) {
      this.novaFace.setAttribute("src", url);
      this.novaFace.setAttribute("alt", `Nova ${sticker.replace(/\.(?:png|jpe?g|gif|webp|avif)$/i, "")}表情包头像`);
    }
  }
}