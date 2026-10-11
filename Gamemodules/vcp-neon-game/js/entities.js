import { COLORS, ENEMIES, ELITES, FINAL_BOSS, PLAYER } from "./config.js";
import { TAU, angleTo, chance, fillNeonCircle, neonCircle, normalize, outsideScreen, pick, pointFromAngle, rand, weightedPick } from "./utils.js";

let nextId = 1;

export class Player {
  constructor(width, height) {
    this.x = width / 2;
    this.y = height / 2;
    this.r = PLAYER.radius;
    this.hp = PLAYER.maxHp;
    this.maxHp = PLAYER.maxHp;
    this.invuln = 0;
    this.level = 1;
    this.xp = 0;
    this.requiredXp = 18;
    this.kills = 0;
    this.score = 0;
    this.weapons = new Map();
    this.fusions = new Set();
    this.buffs = new Map();
    this.attackBonus = 0;
    this.fireAngle = -Math.PI / 2;
  }

  hasBuff(id) {
    return this.buffs.has(id);
  }

  weaponLevel(id) {
    return this.weapons.get(id) || 0;
  }

  addWeapon(id) {
    const current = this.weaponLevel(id);
    this.weapons.set(id, current + 1);
  }

  addFusion(id) {
    this.fusions.add(id);
  }

  addBuff(buff) {
    this.buffs.set(buff.id, { ...buff, time: buff.duration });
  }

  gainXp(amount) {
    this.xp += amount;
    let leveled = false;
    while (this.xp >= this.requiredXp) {
      this.xp -= this.requiredXp;
      this.level += 1;
      this.requiredXp = Math.floor(this.requiredXp * 1.24 + 6);
      leveled = true;
    }
    return leveled;
  }

  damage(amount) {
    if (this.invuln > 0) return false;
    this.hp = Math.max(0, this.hp - amount);
    this.invuln = PLAYER.invulnAfterHit;
    return true;
  }

  update(dt, input, width, height) {
    let mx = 0;
    let my = 0;
    if (input.keys.has("KeyW") || input.keys.has("ArrowUp")) my -= 1;
    if (input.keys.has("KeyS") || input.keys.has("ArrowDown")) my += 1;
    if (input.keys.has("KeyA") || input.keys.has("ArrowLeft")) mx -= 1;
    if (input.keys.has("KeyD") || input.keys.has("ArrowRight")) mx += 1;
    if (input.touchMove?.active) {
      mx += input.touchMove.x;
      my += input.touchMove.y;
    }

    const move = normalize(mx, my);
    const speed = PLAYER.speed * (this.hasBuff("flow") ? 1.12 : 1);
    this.x = Math.max(this.r, Math.min(width - this.r, this.x + move.x * speed * dt));
    this.y = Math.max(this.r, Math.min(height - this.r, this.y + move.y * speed * dt));

    if (input.mouse.active) {
      this.fireAngle = angleTo(this, input.mouse);
    } else if (mx || my) {
      this.fireAngle = Math.atan2(move.y, move.x);
    }

    this.invuln = Math.max(0, this.invuln - dt);
    for (const [id, buff] of this.buffs.entries()) {
      buff.time -= dt;
      if (buff.time <= 0) this.buffs.delete(id);
    }
  }

  draw(ctx, time) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.fireAngle);
    const blink = this.invuln > 0 ? 0.42 + Math.sin(time * 40) * 0.28 : 1;
    ctx.globalAlpha = blink;
    ctx.shadowColor = COLORS.cyan;
    ctx.shadowBlur = 20;
    ctx.strokeStyle = COLORS.cyan;
    ctx.fillStyle = "rgba(53, 248, 255, 0.16)";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.lineTo(-13, -13);
    ctx.lineTo(-8, 0);
    ctx.lineTo(-13, 13);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.shadowColor = COLORS.playerAlt;
    ctx.strokeStyle = COLORS.playerAlt;
    ctx.beginPath();
    ctx.arc(0, 0, 7 + Math.sin(time * 8) * 1.2, 0, TAU);
    ctx.stroke();

    ctx.restore();

    if (this.hasBuff("folding")) {
      const radius = 44 + Math.sin(time * 6) * 4;
      neonCircle(ctx, this.x, this.y, radius, COLORS.gold, 0.8, 3);
      for (let i = 0; i < 3; i += 1) {
        const p = pointFromAngle(time * 3 + i * TAU / 3, radius);
        fillNeonCircle(ctx, this.x + p.x, this.y + p.y, 5, COLORS.gold, 0.9);
      }
    }
  }
}

export class Bullet {
  constructor(options) {
    Object.assign(this, {
      id: nextId++,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      r: 4,
      damage: 5,
      color: COLORS.cyan,
      life: 4,
      pierce: 0,
      enemy: false,
      homing: 0,
      target: null,
      chain: 0,
      source: "player",
    }, options);
  }

  update(dt, game) {
    if (this.homing && this.target && !this.target.dead) {
      const desired = angleTo(this, this.target);
      const current = Math.atan2(this.vy, this.vx);
      let diff = desired - current;
      while (diff > Math.PI) diff -= TAU;
      while (diff < -Math.PI) diff += TAU;
      const next = current + diff * Math.min(1, this.homing * dt);
      const speed = Math.hypot(this.vx, this.vy);
      this.vx = Math.cos(next) * speed;
      this.vy = Math.sin(next) * speed;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.life -= dt;
    if (this.life <= 0 || outsideScreen(this, game.width, game.height, 110)) this.dead = true;
  }

  draw(ctx) {
    fillNeonCircle(ctx, this.x, this.y, this.r, this.color, 0.92);
    ctx.save();
    ctx.globalAlpha = 0.38;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(this.x, this.y);
    ctx.lineTo(this.x - this.vx * 0.035, this.y - this.vy * 0.035);
    ctx.stroke();
    ctx.restore();
  }
}

export class Enemy {
  constructor(type, width, height, elite = null) {
    const data = elite || ENEMIES[type];
    const edge = Math.floor(rand(0, 4));
    let x = 0;
    let y = 0;
    if (edge === 0) {
      x = rand(0, width);
      y = -50;
    } else if (edge === 1) {
      x = width + 50;
      y = rand(0, height);
    } else if (edge === 2) {
      x = rand(0, width);
      y = height + 50;
    } else {
      x = -50;
      y = rand(0, height);
    }

    Object.assign(this, {
      id: nextId++,
      type,
      elite: Boolean(elite),
      name: data.name,
      x,
      y,
      r: data.radius,
      hp: data.hp,
      maxHp: data.hp,
      speed: data.speed,
      color: data.color,
      xp: data.xp,
      damage: data.damage,
      score: data.score,
      shooter: data.shooter,
      splitter: data.splitter,
      charge: data.charge,
      radial: data.radial,
      paradox: data.paradox,
      jitter: data.jitter,
      pattern: data.pattern,
      finalBoss: data.id === FINAL_BOSS.id,
      shootTimer: rand(0.8, 2.2),
      pulse: rand(0, TAU),
      chargeCooldown: rand(1.5, 3.2),
      chargeTime: 0,
    });
  }

  update(dt, game) {
    const toPlayer = angleTo(this, game.player);
    let speed = this.speed * game.difficulty.enemySpeed;

    if (this.charge) {
      this.chargeCooldown -= dt;
      if (this.chargeCooldown <= 0 && this.chargeTime <= 0) {
        this.chargeTime = 0.72;
        this.chargeCooldown = rand(2.2, 4.2);
      }
      if (this.chargeTime > 0) {
        this.chargeTime -= dt;
        speed *= 3.1;
      }
    }

    if (this.elite) {
      this.pulse += dt;
      this.x += Math.cos(toPlayer) * speed * dt + Math.sin(this.pulse * 2) * 18 * dt;
      this.y += Math.sin(toPlayer) * speed * dt + Math.cos(this.pulse * 1.7) * 18 * dt;
    } else {
      const jitterAngle = this.jitter ? this.pulse * 5.2 : 0;
      const jitterX = this.jitter ? Math.cos(jitterAngle) * 54 * dt : 0;
      const jitterY = this.jitter ? Math.sin(jitterAngle * 1.3) * 54 * dt : 0;
      this.pulse += this.jitter ? dt : 0;
      this.x += Math.cos(toPlayer) * speed * dt + jitterX;
      this.y += Math.sin(toPlayer) * speed * dt + jitterY;
    }

    this.shootTimer -= dt;
    if (this.shootTimer <= 0) {
      this.shootTimer = this.elite ? rand(0.8, 1.4) : rand(1.8, 3.2) / game.difficulty.fireRate;
      this.shoot(game);
    }
  }

  shoot(game) {
    if (this.shooter) {
      const angle = angleTo(this, game.player);
      game.enemyBullets.push(new Bullet({
        x: this.x,
        y: this.y,
        vx: Math.cos(angle) * 185,
        vy: Math.sin(angle) * 185,
        r: 5,
        damage: 10,
        color: COLORS.red,
        enemy: true,
        life: 5,
      }));
    }

    if (this.paradox) {
      const base = angleTo(this, game.player);
      for (let i = 0; i < 2; i += 1) {
        const angle = base + i * Math.PI;
        game.enemyBullets.push(new Bullet({
          x: this.x,
          y: this.y,
          vx: Math.cos(angle) * 142,
          vy: Math.sin(angle) * 142,
          r: 5,
          damage: 9,
          color: i ? COLORS.enemyPink : COLORS.violet,
          enemy: true,
          life: 5,
        }));
      }
    }

    if (this.radial) {
      for (let i = 0; i < 9; i += 1) {
        const angle = i * TAU / 9 + game.time * 0.8;
        game.enemyBullets.push(new Bullet({
          x: this.x,
          y: this.y,
          vx: Math.cos(angle) * 130,
          vy: Math.sin(angle) * 130,
          r: 4,
          damage: 8,
          color: COLORS.enemyPink,
          enemy: true,
          life: 5,
        }));
      }
    }

    if (this.elite) {
      if (this.pattern === "spiral") {
        for (let i = 0; i < 16; i += 1) {
          const angle = i * TAU / 16 + game.time * 1.9;
          game.enemyBullets.push(new Bullet({
            x: this.x,
            y: this.y,
            vx: Math.cos(angle) * 168,
            vy: Math.sin(angle) * 168,
            r: 4,
            damage: 11,
            color: this.color,
            enemy: true,
            life: 6,
          }));
        }
        const snipe = angleTo(this, game.player);
        game.enemyBullets.push(new Bullet({
          x: this.x,
          y: this.y,
          vx: Math.cos(snipe) * 235,
          vy: Math.sin(snipe) * 235,
          r: 5,
          damage: 12,
          color: COLORS.red,
          enemy: true,
          life: 5,
        }));
      } else if (this.pattern === "burst") {
        for (let i = 0; i < 5; i += 1) {
          const base = angleTo(this, game.player) + (i - 2) * 0.22;
          for (let j = 0; j < 2; j += 1) {
            const speed = 128 + j * 78;
            game.enemyBullets.push(new Bullet({
              x: this.x,
              y: this.y,
              vx: Math.cos(base) * speed,
              vy: Math.sin(base) * speed,
              r: 5,
              damage: 13,
              color: this.color,
              enemy: true,
              life: 6,
            }));
          }
        }
      } else if (this.pattern === "rings") {
        for (let ring = 0; ring < 2; ring += 1) {
          const count = ring ? 14 : 10;
          for (let i = 0; i < count; i += 1) {
            const angle = i * TAU / count + game.time * 0.28 + ring * TAU / (count * 2);
            const speed = ring ? 178 : 118;
            game.enemyBullets.push(new Bullet({
              x: this.x,
              y: this.y,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              r: ring ? 4 : 6,
              damage: 10,
              color: ring ? COLORS.enemyPink : this.color,
              enemy: true,
              life: 7,
            }));
          }
        }
      } else if (this.pattern === "cloudOutage") {
        for (let i = 0; i < 20; i += 1) {
          const angle = i * TAU / 20 + Math.sin(game.time * 0.9) * 0.45;
          const speed = i % 2 ? 128 : 194;
          game.enemyBullets.push(new Bullet({
            x: this.x,
            y: this.y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            r: i % 3 === 0 ? 7 : 5,
            damage: 15,
            color: i % 2 ? COLORS.enemyPink : COLORS.crimson,
            enemy: true,
            life: 7,
          }));
        }
        for (let i = 0; i < 4; i += 1) {
          const angle = angleTo(this, game.player) + (i - 1.5) * 0.18;
          game.enemyBullets.push(new Bullet({
            x: this.x,
            y: this.y,
            vx: Math.cos(angle) * 250,
            vy: Math.sin(angle) * 250,
            r: 6,
            damage: 18,
            color: COLORS.red,
            enemy: true,
            life: 5,
          }));
        }
      }
    }
  }

  takeDamage(amount, game, source = null) {
    let final = amount * (1 + (game.player.attackBonus || 0));
    if (this.marked) final *= 1.28;
    this.hp -= final;
    game.particles.burst(this.x, this.y, COLORS.ash, 2, 0.42);
    if (this.hp <= 0) {
      this.dead = true;
      game.onEnemyKilled(this, source);
    }
  }

  draw(ctx, time) {
    if (this.marked) {
      const markRatio = Math.max(0, Math.min(1, this.marked / Math.max(1, this.markedMax || this.marked)));
      const pulse = 0.5 + Math.sin(time * 8 + this.id) * 0.5;
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.shadowColor = COLORS.enemyHot;
      ctx.shadowBlur = this.elite ? 18 : 10;
      ctx.strokeStyle = COLORS.enemyHot;
      ctx.lineWidth = this.elite ? 2.6 : 2;
      ctx.globalAlpha = this.elite ? 0.78 : 0.62;
      ctx.beginPath();
      ctx.arc(0, 0, this.r + 9 + pulse * 3, -Math.PI / 2, -Math.PI / 2 + TAU * markRatio);
      ctx.stroke();

      if (this.elite || this.finalBoss) {
        ctx.globalAlpha = 0.26;
        ctx.setLineDash([7, 8]);
        ctx.beginPath();
        ctx.arc(0, 0, this.r + 18, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(time * (this.elite ? 0.9 : 1.5));
    ctx.shadowColor = this.color;
    ctx.shadowBlur = this.elite ? 28 : 16;
    ctx.strokeStyle = this.marked ? COLORS.enemyHot : this.color;
    ctx.fillStyle = this.elite ? "rgba(255,255,255,0.06)" : "rgba(255,73,109,0.08)";
    ctx.lineWidth = this.elite ? 3 : 2;
    const sides = this.elite ? 7 : this.charge ? 3 : this.shooter ? 5 : 4;
    ctx.beginPath();
    for (let i = 0; i < sides; i += 1) {
      const a = i * TAU / sides;
      const rr = this.r * (i % 2 ? 0.72 : 1);
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (this.elite) {
      ctx.rotate(-time * 1.8);
      ctx.strokeStyle = COLORS.white;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      if (this.pattern === "spiral") {
        for (let i = 0; i < 3; i += 1) {
          ctx.arc(0, 0, this.r + 7 + i * 6 + Math.sin(time * 5 + i) * 2, i * TAU / 3, i * TAU / 3 + TAU * 0.42);
        }
      } else if (this.pattern === "burst") {
        for (let i = 0; i < 8; i += 1) {
          const a = i * TAU / 8;
          ctx.moveTo(Math.cos(a) * (this.r + 4), Math.sin(a) * (this.r + 4));
          ctx.lineTo(Math.cos(a) * (this.r + 18), Math.sin(a) * (this.r + 18));
        }
      } else if (this.pattern === "rings") {
        ctx.arc(0, 0, this.r + 9 + Math.sin(time * 5) * 3, 0, TAU);
        ctx.moveTo(this.r + 20, 0);
        ctx.arc(0, 0, this.r + 20, 0, TAU);
      } else if (this.pattern === "cloudOutage") {
        for (let i = 0; i < 5; i += 1) {
          const a = i * TAU / 5 + time * 0.7;
          ctx.moveTo(Math.cos(a) * (this.r + 6), Math.sin(a) * (this.r + 6));
          ctx.quadraticCurveTo(0, 0, Math.cos(a + 0.7) * (this.r + 26), Math.sin(a + 0.7) * (this.r + 26));
        }
      }
      ctx.stroke();
    }
    ctx.restore();

    if (this.hp < this.maxHp || this.elite) {
      ctx.save();
      const w = this.r * 2.2;
      ctx.globalAlpha = this.elite ? 0.9 : 0.55;
      ctx.fillStyle = "rgba(0,0,0,0.48)";
      ctx.fillRect(this.x - w / 2, this.y - this.r - 12, w, 4);
      ctx.fillStyle = this.marked ? COLORS.enemyHot : this.color;
      ctx.fillRect(this.x - w / 2, this.y - this.r - 12, w * Math.max(0, this.hp / this.maxHp), 4);
      ctx.restore();
    }
  }
}

export class XpGem {
  constructor(x, y, amount, color = COLORS.green) {
    this.id = nextId++;
    this.x = x;
    this.y = y;
    this.r = 5 + Math.min(8, amount * 0.15);
    this.amount = amount;
    this.color = color;
    this.vx = rand(-28, 28);
    this.vy = rand(-28, 28);
    this.life = 20;
  }

  update(dt, game) {
    const d = Math.hypot(game.player.x - this.x, game.player.y - this.y);
    const magnet = PLAYER.magnetRadius * (game.player.hasBuff("flow") ? 1.45 : 1);
    if (d < magnet) {
      const angle = angleTo(this, game.player);
      const speed = 280 + (magnet - d) * 4;
      this.vx = Math.cos(angle) * speed;
      this.vy = Math.sin(angle) * speed;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.life -= dt;
    if (d < game.player.r + this.r) {
      this.dead = true;
      game.collectXp(this.amount);
    }
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.life);
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.moveTo(0, -this.r);
    ctx.lineTo(this.r, 0);
    ctx.lineTo(0, this.r);
    ctx.lineTo(-this.r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

export class BuffDrop {
  constructor(x, y, buff) {
    this.id = nextId++;
    this.x = x;
    this.y = y;
    this.r = 15;
    this.buff = buff;
    this.color = buff.color;
    this.life = 13;
    this.spin = rand(0, TAU);
  }

  update(dt, game) {
    this.spin += dt * 4;
    this.life -= dt;
    const d = Math.hypot(game.player.x - this.x, game.player.y - this.y);
    if (d < 96) {
      const angle = angleTo(this, game.player);
      this.x += Math.cos(angle) * 240 * dt;
      this.y += Math.sin(angle) * 240 * dt;
    }
    if (d < game.player.r + this.r) {
      this.dead = true;
      game.collectBuff(this.buff);
    }
    if (this.life <= 0) this.dead = true;
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.spin);
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 24;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 3;
    ctx.strokeRect(-this.r, -this.r, this.r * 2, this.r * 2);
    ctx.rotate(-this.spin * 1.7);
    ctx.strokeStyle = COLORS.yellow;
    ctx.globalAlpha = 0.55;
    ctx.strokeRect(-this.r * 0.52, -this.r * 0.52, this.r * 1.04, this.r * 1.04);
    ctx.restore();
  }
}

export class ParticleSystem {
  constructor() {
    this.items = [];
    this.maxItems = 260;
    this.softLimit = 190;
  }

  burst(x, y, color, count = 10, power = 1) {
    const pressure = this.items.length / this.maxItems;
    let budget = count;

    if (this.items.length > this.softLimit) {
      budget = Math.ceil(count * 0.45);
      power *= 0.75;
    }

    if (this.items.length > this.maxItems * 0.92) {
      budget = Math.ceil(count * 0.22);
      power *= 0.55;
    }

    budget = Math.min(budget, this.maxItems - this.items.length);
    if (budget <= 0) return;

    for (let i = 0; i < budget; i += 1) {
      const angle = rand(0, TAU);
      const speed = rand(36, 205) * power * (1 - Math.min(0.4, pressure * 0.25));
      const life = rand(0.22, 0.72) * power;
      this.items.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: Math.max(0.8, rand(1, 3.3) * power),
        color,
        life,
        maxLife: life,
      });
    }
  }

  update(dt) {
    let write = 0;
    for (let read = 0; read < this.items.length; read += 1) {
      const p = this.items[read];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.98;
      p.vy *= 0.98;
      p.life -= dt;
      if (p.life > 0) {
        this.items[write] = p;
        write += 1;
      }
    }
    this.items.length = write;
  }

  draw(ctx) {
    ctx.save();
    ctx.shadowBlur = 0;
    for (const p of this.items) {
      const alpha = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}

export function randomEnemyType(time) {
  const minute = time / 60;
  return weightedPick([
    { value: "mosquito", weight: Math.max(3.2, 10 - minute) },
    { value: "prompt", weight: 2.4 + minute * 0.52 },
    { value: "shard", weight: 1.2 + minute * 0.42 },
    { value: "charger", weight: 0.85 + minute * 0.55 },
    { value: "eye", weight: Math.max(0.18, minute * 0.35) },
    { value: "paradox", weight: Math.max(0, minute - 0.8) * 0.34 },
    { value: "tokenpile", weight: Math.max(0, minute - 1.4) * 0.26 },
    { value: "chunkmiss", weight: 0.55 + Math.min(1.8, minute * 0.24) },
  ]);
}

export function spawnElite(width, height) {
  return new Enemy("elite", width, height, pick(ELITES));
}

export function spawnFinalBoss(width, height) {
  return new Enemy("finalBoss", width, height, FINAL_BOSS);
}

export function spawnEnemy(width, height, time) {
  return new Enemy(randomEnemyType(time), width, height);
}

export function maybeSplitEnemy(enemy, game) {
  if (!enemy.splitter) return;
  for (let i = 0; i < 3; i += 1) {
    const child = new Enemy("mosquito", game.width, game.height);
    child.x = enemy.x + rand(-14, 14);
    child.y = enemy.y + rand(-14, 14);
    child.hp *= 0.55;
    child.maxHp = child.hp;
    child.r *= 0.8;
    child.speed *= 1.35;
    game.enemies.push(child);
  }
}

export function maybeDropBuff(enemy, game) {
  const probability = enemy.elite ? 0.9 : 0.035;
  if (!chance(probability)) return;

  const roll = rand(0, 1);
  if (roll < 0.05) {
    game.buffDrops.push(new BuffDrop(enemy.x, enemy.y, game.buffs.find((buff) => buff.id === "levelup")));
    return;
  }

  if (roll < 0.08) {
    game.buffDrops.push(new BuffDrop(enemy.x, enemy.y, game.buffs.find((buff) => buff.id === "heal")));
    return;
  }

  const timedBuffs = game.buffs.filter((buff) => !buff.instant);
  game.buffDrops.push(new BuffDrop(enemy.x, enemy.y, pick(timedBuffs)));
}