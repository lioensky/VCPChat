import { calcDamage, skillHitChance, defaultReaction, canRespond, previewAttack, defenseDamage, hitChance } from './engine.js';

/** UI和实际结算共用的交换预览；不掷骰、不修改单位。 */
export function exchangePreview(b, actor, target, rules, skill = null, reaction = defaultReaction(b, actor, target, rules, skill)) {
    if (!skill) return { ...previewAttack(b, actor, target, rules, reaction), reaction };
    let damage = calcDamage(b, actor, target, skill.kind, skill.power, rules, Math.random, true);
    if (reaction === 'defend' && !target.object) damage = defenseDamage(damage, rules);
    const hit = skillHitChance(b, actor, skill, target, rules);
    const responds = reaction === 'counter' && canRespond(b, actor, target, rules, skill);
    const counter = responds ? calcDamage(b, target, actor, target.atkType, 100, rules, Math.random, true) : 0;
    const counterHit = responds ? hitChance(b, target, actor, rules) : 0;
    const survives = damage >= target.hp ? 1 - hit / 100 : 1;
    return { damage, hit, counter, counterHit, responds, expectedDamage: damage * hit / 100, expectedCounter: counter * counterHit / 100 * survives, reaction, firstStrike: false };
}
