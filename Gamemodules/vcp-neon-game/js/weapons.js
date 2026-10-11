import { BUFFS, COLORS, FUSIONS, WEAPONS } from "./config.js";
import { Bullet } from "./entities.js";
import { TAU, angleTo, chance, closestEntity, fillNeonCircle, neonCircle, pointFromAngle, rand } from "./utils.js";

export class WeaponSystem {
  constructor(game) {
    this.game = game;
    this.timers = new Map();
    this.lasers = [];
    this.shockwaves = [];
    this.grabs = [];
    this.futureBombs = [];
    this.fusionTimers = new Map();
    this.assistantDrones = [];
  }

  reset() {
    this.timers.clear();
    this.lasers = [];
    this.shockwaves = [];
    this.grabs = [];
    this.futureBombs = [];
    this.fusionTimers.clear();
    this.assistantDrones = [];
  }

  getTimer(id) {
    return this.timers.get(id) || 0;
  }

  setTimer(id, value) {
    this.timers.set(id, value);
  }

  tickTimer(id, dt) {
    const value = Math.max(0, this.getTimer(id) - dt);
    this.setTimer(id, value);
    return value;
  }

  update(dt) {
    const player = this.game.player;

    for (const [id, level] of player.weapons.entries()) {
      if (level <= 0) continue;
      const method = this[`update_${id}`];
      if (method) method.call(this, dt, level);
    }

    for (const id of player.fusions) {
      const method = this[`fusion_${id}`];
      if (method) method.call(this, dt);
    }

    this.updateLasers(dt);
    this.updateShockwaves(dt);
    this.updateGrabs(dt);
    this.updateFutureBombs(dt);
    this.updateAssistantDrones(dt);
  }

  updateAssistantDrones(dt) {
    const level = this.game.player.weaponLevel("assistant");
    const swarmActive = this.game.player.fusions.has("swarm");
    const desired = swarmActive ? 4 : Math.min(5, level > 0 ? 1 + Math.floor(level * 0.85) : 0);

    while (this.assistantDrones.length < desired) {
      this.assistantDrones.push({
        slot: this.assistantDrones.length,
        x: this.game.player.x,
        y: this.game.player.y,
        angle: rand(0, TAU),
        color: swarmActive ? [COLORS.cyan, COLORS.sky, COLORS.playerAlt, COLORS.ice][this.assistantDrones.length % 4] : COLORS.ice,
      });
    }

    if (this.assistantDrones.length > desired) {
      this.assistantDrones.length = desired;
    }

    const radius = swarmActive ? 82 : 64;
    for (let i = 0; i < this.assistantDrones.length; i += 1) {
      const drone = this.assistantDrones[i];
      drone.slot = i;
      drone.color = swarmActive ? [COLORS.cyan, COLORS.sky, COLORS.playerAlt, COLORS.ice][i % 4] : COLORS.ice;
      const targetAngle = this.game.time * (swarmActive ? 2 : 1.8) + i * TAU / Math.max(1, desired);
      const orbit = pointFromAngle(targetAngle, radius);
      const targetX = this.game.player.x + orbit.x;
      const targetY = this.game.player.y + orbit.y;
      drone.x += (targetX - drone.x) * Math.min(1, dt * 10);
      drone.y += (targetY - drone.y) * Math.min(1, dt * 10);
      const target = closestEntity(drone, this.game.enemies, (e) => !e.dead);
      drone.angle = target ? angleTo(drone, target) : this.game.player.fireAngle;
    }
  }

  fireBullet(angle, speed, options = {}) {
    const player = this.game.player;
    const spread = options.offset || 0;
    const muzzle = pointFromAngle(angle, player.r + 8);
    const bullet = new Bullet({
      x: player.x + muzzle.x,
      y: player.y + muzzle.y,
      vx: Math.cos(angle + spread) * speed,
      vy: Math.sin(angle + spread) * speed,
      r: options.r || 4,
      damage: options.damage || 6,
      color: options.color || COLORS.cyan,
      life: options.life || 4,
      pierce: options.pierce || 0,
      homing: options.homing || 0,
      target: options.target || null,
      chain: options.chain || 0,
      source: options.source || "player",
    });
    this.game.bullets.push(bullet);
    this.game.audio?.sfx("shoot");

    if (player.hasBuff("tools")) {
      const miniA = angle + rand(-0.55, 0.55);
      this.game.bullets.push(new Bullet({
        x: player.x + muzzle.x * 0.8,
        y: player.y + muzzle.y * 0.8,
        vx: Math.cos(miniA) * speed * 0.82,
        vy: Math.sin(miniA) * speed * 0.82,
        r: 2.5,
        damage: 2.2,
        color: COLORS.ice,
        life: 2.2,
        pierce: 0,
        source: "tools",
      }));
    }
  }

  update_vexus(dt, level) {
    if (this.tickTimer("vexus", dt) > 0) return;
    const rate = (0.22 - level * 0.018) * (this.game.player.hasBuff("tools") ? 0.55 : 1);
    this.setTimer("vexus", Math.max(0.075, rate));
    const count = level >= 4 ? 3 : level >= 2 ? 2 : 1;
    const base = this.game.player.fireAngle;
    for (let i = 0; i < count; i += 1) {
      const offset = count === 1 ? 0 : (i - (count - 1) / 2) * 0.12;
      this.fireBullet(base, 620 + level * 28, {
        r: 3.5,
        damage: 6 + level * 2.3,
        color: COLORS.cyan,
        pierce: level >= 3 ? 1 : 0,
        source: "vexus",
        offset,
      });
    }
  }

  update_wave(dt, level) {
    if (this.tickTimer("wave", dt) > 0) return;
    this.setTimer("wave", Math.max(1.05, 2.55 - level * 0.22));
    const waves = level >= 5 ? 2 : 1;
    for (let w = 0; w < waves; w += 1) {
      this.shockwaves.push({
        x: this.game.player.x,
        y: this.game.player.y,
        r: 8,
        maxR: 105 + level * 26 + w * 28,
        damage: 11 + level * 4,
        color: COLORS.blue,
        life: 0.75,
        hit: new Set(),
        width: 12 + level * 2,
      });
    }
  }

  update_onering(dt, level) {
    const count = 1 + Math.floor(level / 2);
    const radius = 48 + level * 7;
    for (let i = 0; i < count; i += 1) {
      const angle = this.game.time * (2.5 + level * 0.25) + i * TAU / count;
      const p = pointFromAngle(angle, radius);
      const orb = { x: this.game.player.x + p.x, y: this.game.player.y + p.y, r: 11 + level };
      for (const enemy of this.game.enemies) {
        if (enemy.dead) continue;
        const d = Math.hypot(enemy.x - orb.x, enemy.y - orb.y);
        if (d < enemy.r + orb.r) {
          enemy.takeDamage((18 + level * 6) * dt, this.game, "onering");
        }
      }

      for (const bullet of this.game.enemyBullets) {
        if (bullet.dead) continue;
        const d = Math.hypot(bullet.x - orb.x, bullet.y - orb.y);
        if (d < bullet.r + orb.r) {
          bullet.dead = true;
          this.game.particles.burst(bullet.x, bullet.y, COLORS.sky, 5, 0.45);
          if (chance(0.18 + level * 0.04)) {
            this.game.spawnXp(bullet.x, bullet.y, 0.25, COLORS.gold);
          }
        }
      }
    }
  }

  update_model(dt, level) {
    if (this.tickTimer("model", dt) > 0) return;
    this.setTimer("model", Math.max(0.42, 1.18 - level * 0.09));
    const shots = level >= 5 ? 3 : level >= 3 ? 2 : 1;
    for (let i = 0; i < shots; i += 1) {
      const target = closestEntity(this.game.player, this.game.enemies, (e) => !e.dead);
      const angle = target ? angleTo(this.game.player, target) + (i - (shots - 1) / 2) * 0.18 : this.game.player.fireAngle;
      this.fireBullet(angle, 360 + level * 24, {
        r: 6,
        damage: 11 + level * 3.2,
        color: COLORS.playerAlt,
        homing: 5 + level * 0.8,
        target,
        life: 4.8,
        source: "model",
      });
    }
  }

  update_assistant(dt, level) {
    if (this.tickTimer("assistant", dt) > 0) return;
    this.setTimer("assistant", Math.max(0.34, 0.82 - level * 0.055));
    const drones = this.assistantDrones.length ? this.assistantDrones : [{ x: this.game.player.x, y: this.game.player.y, angle: this.game.player.fireAngle }];
    for (const origin of drones) {
      const target = closestEntity(origin, this.game.enemies, (e) => !e.dead);
      const angle = target ? angleTo(origin, target) : origin.angle;
      this.game.bullets.push(new Bullet({
        x: origin.x,
        y: origin.y,
        vx: Math.cos(angle) * 500,
        vy: Math.sin(angle) * 500,
        r: 3.5,
        damage: 5.5 + level * 1.4,
        color: COLORS.ice,
        life: 3.2,
        source: "assistant",
      }));
    }
  }

  update_mail(dt, level) {
    if (this.tickTimer("mail", dt) > 0) return;
    this.setTimer("mail", Math.max(1.1, 2.25 - level * 0.16));
    const target = closestEntity(this.game.player, this.game.enemies, (e) => !e.dead);
    const angle = target ? angleTo(this.game.player, target) : this.game.player.fireAngle;
    this.fireBullet(angle, 250 + level * 16, {
      r: 8,
      damage: 18 + level * 4,
      color: COLORS.deepBlue,
      homing: 2.4,
      target,
      life: 5,
      source: "mail",
    });
  }

  update_chrome(dt, level) {
    if (this.tickTimer("chrome", dt) > 0) return;
    this.setTimer("chrome", Math.max(2.2, 4.8 - level * 0.38));
    const count = level >= 5 ? 3 : level >= 3 ? 2 : 1;
    for (let i = 0; i < count; i += 1) {
      this.lasers.push({
        vertical: chance(0.5),
        pos: chance(0.5) ? this.game.player.x + rand(-220, 220) : this.game.player.y + rand(-160, 160),
        width: 10 + level * 2,
        damage: 18 + level * 6,
        color: COLORS.blue,
        warn: 0.42,
        life: 0.26,
        hit: new Set(),
      });
    }
  }

  update_openher(dt, level) {
    if (this.tickTimer("openher", dt) > 0) return;
    const hpRatio = this.game.player.hp / this.game.player.maxHp;
    this.setTimer("openher", hpRatio < 0.35 ? 0.34 : hpRatio < 0.7 ? 0.52 : 0.72);
    const base = this.game.player.fireAngle;
    const count = hpRatio < 0.35 ? 7 : hpRatio < 0.7 ? 5 : 3;
    const color = hpRatio < 0.35 ? COLORS.deepBlue : hpRatio < 0.7 ? COLORS.playerAlt : COLORS.sky;
    for (let i = 0; i < count; i += 1) {
      const offset = (i - (count - 1) / 2) * (hpRatio < 0.35 ? 0.22 : 0.16);
      this.fireBullet(base, 460, {
        r: 4.4,
        damage: 5.5 + level * 2.1 + (hpRatio < 0.35 ? 4 : 0),
        color,
        pierce: hpRatio < 0.35 ? 1 : 0,
        source: "openher",
        offset,
      });
    }
  }

  update_som(dt, level) {
    if (this.tickTimer("som", dt) > 0) return;
    this.setTimer("som", Math.max(1.65, 3.5 - level * 0.25));
    const target = closestEntity(this.game.player, this.game.enemies, (e) => !e.dead);
    if (!target) return;
    this.grabs.push({
      target,
      life: 0.55,
      maxLife: 0.55,
      damage: 30 + level * 10,
      color: COLORS.ice,
      done: false,
    });
  }

  update_chiyue(dt, level) {
    if (this.tickTimer("chiyue", dt) > 0) return;

    const interval = Math.max(0.78, 2.35 - level * 0.22);
    this.setTimer("chiyue", interval);

    const maxMarks = 1 + Math.floor(level / 2);
    const duration = 5 + level * 1.2;
    const alreadyMarked = this.game.enemies.filter((e) => e.marked && !e.dead).length;
    const slots = Math.max(1, maxMarks - alreadyMarked);

    const targets = [...this.game.enemies]
      .filter((e) => !e.dead && !e.marked)
      .sort((a, b) => {
        const da = Math.hypot(a.x - this.game.player.x, a.y - this.game.player.y) - (a.elite ? 120 : 0);
        const db = Math.hypot(b.x - this.game.player.x, b.y - this.game.player.y) - (b.elite ? 120 : 0);
        return da - db;
      })
      .slice(0, slots);

    for (const target of targets) {
      this.applyMark(target, duration, level);
    }
  }

  applyMark(target, duration, level) {
    target.marked = duration;
    target.markedMax = duration;
    target.markLevel = level;

    const markedCount = this.game.enemies.reduce((sum, enemy) => sum + (enemy.marked && !enemy.dead ? 1 : 0), 0);
    const count = Math.max(4, Math.floor((10 + level) / Math.max(1, markedCount * 0.45)));
    this.game.particles.burst(target.x, target.y, COLORS.enemyHot, count, 0.72);
  }

  fusion_geodesic(dt) {
    if (this.tickTimer("fusion_geodesic", dt) > 0) return;
    this.setTimer("fusion_geodesic", 0.42);
    const target = closestEntity(this.game.player, this.game.enemies, (e) => !e.dead);
    const angle = target ? angleTo(this.game.player, target) : this.game.player.fireAngle;
    this.fireBullet(angle, 560, {
      r: 8,
      damage: 24,
      color: COLORS.cyan,
      homing: 7,
      target,
      chain: 4,
      life: 5,
      source: "geodesic",
    });
  }

  fusion_soulmoat(dt) {
    const radius = 86 + Math.sin(this.game.time * 2) * 5;
    for (const enemy of this.game.enemies) {
      const d = Math.hypot(enemy.x - this.game.player.x, enemy.y - this.game.player.y);
      if (d < radius + enemy.r && d > radius - 30) {
        enemy.takeDamage(58 * dt, this.game, "soulmoat");
      }
    }
    for (const bullet of this.game.enemyBullets) {
      const d = Math.hypot(bullet.x - this.game.player.x, bullet.y - this.game.player.y);
      if (d < radius + bullet.r && d > radius - 22) {
        bullet.dead = true;
        this.game.spawnXp(bullet.x, bullet.y, 0.5, COLORS.gold);
      }
    }
  }

  fusion_swarm(dt) {
    if (this.tickTimer("fusion_swarm", dt) > 0) return;
    this.setTimer("fusion_swarm", 0.72);
    const colors = [COLORS.cyan, COLORS.sky, COLORS.playerAlt, COLORS.ice];
    for (let i = 0; i < 4; i += 1) {
      const origin = this.assistantDrones[i] || {
        x: this.game.player.x + Math.cos(this.game.time * 2 + i * TAU / 4) * 82,
        y: this.game.player.y + Math.sin(this.game.time * 2 + i * TAU / 4) * 82,
      };
      const target = closestEntity(origin, this.game.enemies, (e) => !e.dead);
      const angle = target ? angleTo(origin, target) : this.game.player.fireAngle;
      this.game.bullets.push(new Bullet({
        x: origin.x,
        y: origin.y,
        vx: Math.cos(angle) * (460 + i * 40),
        vy: Math.sin(angle) * (460 + i * 40),
        r: 5 + i * 0.8,
        damage: 14 + i * 3,
        color: colors[i],
        homing: i === 1 ? 4 : 0,
        target,
        pierce: i === 3 ? 1 : 0,
        life: 4,
        source: "swarm",
      }));
    }
  }

  fusion_futuremail(dt) {
    if (this.tickTimer("fusion_futuremail", dt) > 0) return;
    this.setTimer("fusion_futuremail", 3.2);
    for (let i = 0; i < 8; i += 1) {
      this.futureBombs.push({
        delay: 0.8 + i * 0.11,
        x: rand(80, this.game.width - 80),
        y: rand(80, this.game.height - 80),
        color: COLORS.deepBlue,
        r: 70,
        damage: 52,
        exploded: false,
      });
    }
  }

  fusion_collapse(dt) {
    if (this.tickTimer("fusion_collapse", dt) > 0) return;
    this.setTimer("fusion_collapse", this.game.player.hp / this.game.player.maxHp < 0.36 ? 4.2 : 6.2);
    const marked = this.game.enemies.filter((e) => e.marked && !e.dead);
    if (!marked.length) return;
    const particleBudget = 42;
    const perEnemyParticles = Math.max(3, Math.floor(particleBudget / marked.length));
    for (const enemy of marked) {
      enemy.takeDamage(42, this.game, "collapse");
      this.game.particles.burst(enemy.x, enemy.y, COLORS.playerAlt, perEnemyParticles, 0.95);
    }
  }

  updateLasers(dt) {
    for (const laser of this.lasers) {
      if (laser.warn > 0) {
        laser.warn -= dt;
      } else {
        laser.life -= dt;
        for (const enemy of this.game.enemies) {
          if (laser.hit.has(enemy.id) || enemy.dead) continue;
          const hit = laser.vertical
            ? Math.abs(enemy.x - laser.pos) < laser.width + enemy.r
            : Math.abs(enemy.y - laser.pos) < laser.width + enemy.r;
          if (hit) {
            laser.hit.add(enemy.id);
            enemy.takeDamage(laser.damage, this.game, "chrome");
          }
        }
      }
    }
    this.lasers = this.lasers.filter((laser) => laser.warn > 0 || laser.life > 0);
  }

  updateShockwaves(dt) {
    for (const wave of this.shockwaves) {
      wave.r += wave.maxR * dt / wave.life;
      wave.life -= dt;
      for (const enemy of this.game.enemies) {
        if (wave.hit.has(enemy.id) || enemy.dead) continue;
        const d = Math.hypot(enemy.x - wave.x, enemy.y - wave.y);
        if (Math.abs(d - wave.r) < wave.width + enemy.r) {
          wave.hit.add(enemy.id);
          enemy.takeDamage(wave.damage, this.game, "wave");
        }
      }
    }
    this.shockwaves = this.shockwaves.filter((wave) => wave.life > 0 && wave.r < wave.maxR + 20);
  }

  updateGrabs(dt) {
    for (const grab of this.grabs) {
      grab.life -= dt;
      if (grab.target && !grab.target.dead) {
        grab.target.x += (this.game.player.x - grab.target.x) * dt * 1.8;
        grab.target.y += (this.game.player.y - grab.target.y) * dt * 1.8;
      }
      if (!grab.done && grab.life <= grab.maxLife * 0.2) {
        grab.done = true;
        if (grab.target && !grab.target.dead) {
          grab.target.takeDamage(grab.damage, this.game, "som");
          this.game.areaDamage(grab.target.x, grab.target.y, 46, grab.damage * 0.45, COLORS.ice);
        }
      }
    }
    this.grabs = this.grabs.filter((grab) => grab.life > 0);
  }

  updateFutureBombs(dt) {
    for (const bomb of this.futureBombs) {
      bomb.delay -= dt;
      if (bomb.delay <= 0 && !bomb.exploded) {
        bomb.exploded = true;
        this.game.areaDamage(bomb.x, bomb.y, bomb.r, bomb.damage, COLORS.deepBlue);
      }
    }
    this.futureBombs = this.futureBombs.filter((bomb) => !bomb.exploded || bomb.delay > -0.25);
  }

  drawAssistantDrones(ctx) {
    if (!this.assistantDrones.length) return;

    ctx.save();
    for (const drone of this.assistantDrones) {
      ctx.save();
      ctx.translate(drone.x, drone.y);
      ctx.rotate(drone.angle);
      ctx.shadowColor = drone.color;
      ctx.shadowBlur = 12;
      ctx.strokeStyle = drone.color;
      ctx.fillStyle = "rgba(120, 231, 255, 0.12)";
      ctx.lineWidth = 2;

      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.lineTo(-6, -5);
      ctx.lineTo(-3, 0);
      ctx.lineTo(-6, 5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(-8, -2.5);
      ctx.lineTo(-15, 0);
      ctx.lineTo(-8, 2.5);
      ctx.stroke();

      ctx.globalAlpha = 0.35 + Math.sin(this.game.time * 8 + drone.slot) * 0.12;
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  draw(ctx) {
    const player = this.game.player;

    this.drawAssistantDrones(ctx);

    const ringLevel = player.weaponLevel("onering");
    if (ringLevel) {
      const count = 1 + Math.floor(ringLevel / 2);
      const radius = 48 + ringLevel * 7;
      neonCircle(ctx, player.x, player.y, radius, COLORS.sky, 0.18, 1.5);
      for (let i = 0; i < count; i += 1) {
        const angle = this.game.time * (2.5 + ringLevel * 0.25) + i * TAU / count;
        const p = pointFromAngle(angle, radius);
        fillNeonCircle(ctx, player.x + p.x, player.y + p.y, 10 + ringLevel, COLORS.sky, 0.9);
      }
    }

    if (player.fusions.has("soulmoat")) {
      neonCircle(ctx, player.x, player.y, 86 + Math.sin(this.game.time * 2) * 5, COLORS.sky, 0.55, 5);
    }

    for (const wave of this.shockwaves) {
      neonCircle(ctx, wave.x, wave.y, wave.r, wave.color, Math.max(0, wave.life), 4);
    }

    for (const laser of this.lasers) {
      ctx.save();
      const alpha = laser.warn > 0 ? 0.3 + Math.sin(this.game.time * 45) * 0.16 : 0.92;
      ctx.globalAlpha = alpha;
      ctx.shadowColor = laser.color;
      ctx.shadowBlur = 26;
      ctx.strokeStyle = laser.color;
      ctx.lineWidth = laser.warn > 0 ? 2 : laser.width * 2;
      ctx.beginPath();
      if (laser.vertical) {
        ctx.moveTo(laser.pos, 0);
        ctx.lineTo(laser.pos, this.game.height);
      } else {
        ctx.moveTo(0, laser.pos);
        ctx.lineTo(this.game.width, laser.pos);
      }
      ctx.stroke();
      ctx.restore();
    }

    for (const grab of this.grabs) {
      if (!grab.target || grab.target.dead) continue;
      ctx.save();
      ctx.globalAlpha = Math.max(0, grab.life / grab.maxLife);
      ctx.shadowColor = grab.color;
      ctx.shadowBlur = 18;
      ctx.strokeStyle = grab.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(player.x, player.y);
      ctx.quadraticCurveTo((player.x + grab.target.x) / 2, player.y - 80, grab.target.x, grab.target.y);
      ctx.stroke();
      ctx.restore();
    }

    for (const bomb of this.futureBombs) {
      ctx.save();
      ctx.globalAlpha = bomb.delay > 0 ? 0.35 + Math.sin(this.game.time * 20) * 0.12 : 0.75;
      ctx.strokeStyle = bomb.color;
      ctx.shadowColor = bomb.color;
      ctx.shadowBlur = 20;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bomb.x, bomb.y, bomb.r * Math.max(0.2, 1 - Math.max(0, bomb.delay)), 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    if (player.fusions.has("collapse")) {
      const marked = this.game.enemies.filter((e) => e.marked && !e.dead);
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = COLORS.playerAlt;
      ctx.shadowColor = COLORS.playerAlt;
      ctx.shadowBlur = 18;
      for (const enemy of marked) {
        ctx.beginPath();
        ctx.moveTo(player.x, player.y);
        ctx.lineTo(enemy.x, enemy.y);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  onBulletHitEnemy(bullet, enemy) {
    if (bullet.source === "mail" || bullet.source === "futuremail") {
      this.explodeMail(bullet.x, bullet.y, bullet.damage * 0.8);
    }

    if (bullet.chain > 0) {
      const next = closestEntity(enemy, this.game.enemies, (e) => !e.dead && e.id !== enemy.id);
      if (next) {
        const angle = angleTo(enemy, next);
        this.game.bullets.push(new Bullet({
          x: enemy.x,
          y: enemy.y,
          vx: Math.cos(angle) * 520,
          vy: Math.sin(angle) * 520,
          r: Math.max(4, bullet.r * 0.88),
          damage: bullet.damage * 0.82,
          color: bullet.color,
          homing: 6,
          target: next,
          chain: bullet.chain - 1,
          life: 3.5,
          source: bullet.source,
        }));
      }
    }
  }

  explodeMail(x, y, damage) {
    this.game.areaDamage(x, y, 54, damage, COLORS.deepBlue);
    const shards = 8;
    for (let i = 0; i < shards; i += 1) {
      const angle = i * TAU / shards;
      this.game.bullets.push(new Bullet({
        x,
        y,
        vx: Math.cos(angle) * 320,
        vy: Math.sin(angle) * 320,
        r: 3.2,
        damage: damage * 0.26,
        color: COLORS.sky,
        life: 1.4,
        pierce: 0,
        source: "mail-shard",
      }));
    }
  }
}

export function getUpgradeChoices(player) {
  const fusionChoices = FUSIONS.filter((fusion) => {
    if (player.fusions.has(fusion.id)) return false;
    return fusion.parts.every((id) => player.weaponLevel(id) >= 5);
  }).map((fusion) => ({
    kind: "fusion",
    id: fusion.id,
    name: fusion.name,
    tag: "终极融合",
    desc: fusion.desc,
    color: fusion.color,
  }));

  if (fusionChoices.length) return fusionChoices.slice(0, 3);

  const weaponChoices = WEAPONS
    .filter((weapon) => player.weaponLevel(weapon.id) < weapon.maxLevel)
    .map((weapon) => {
      const current = player.weaponLevel(weapon.id);
      return {
        kind: "weapon",
        id: weapon.id,
        name: current ? `${weapon.name} Lv.${current + 1}` : weapon.name,
        tag: current ? `升级 / ${weapon.title}` : `新模块 / ${weapon.tag}`,
        desc: current ? `强化 ${weapon.title}。${weapon.desc}` : weapon.desc,
        color: weapon.color,
      };
    });

  const shuffled = weaponChoices.sort(() => Math.random() - 0.5);
  const choices = shuffled.slice(0, 3);
  if (choices.length) return choices;

  return [
    {
      kind: "fallback",
      id: "maxhp",
      name: "Runtime 耐久扩容",
      tag: "保底强化 / 最大 HP +3%",
      desc: "所有模块已满载时出现。最大生命提升 3%，当前生命也小幅补回。",
      color: COLORS.lime,
    },
    {
      kind: "fallback",
      id: "attack",
      name: "全局火力调参",
      tag: "保底强化 / 攻击力 +3%",
      desc: "所有模块已满载时出现。所有玩家伤害永久提升 3%。",
      color: COLORS.cyan,
    },
  ];
}

export { BUFFS, WEAPONS, FUSIONS };