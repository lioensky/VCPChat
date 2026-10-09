// 模型自己标的点击区（model3.json 的 HitAreas）：点在哪儿按模型说的算，比按轮廓估头的位置准
// （歪头、低头、抬手挡住脸时估的会偏）。没有标点击区的模型照旧按轮廓估。

const HEAD = /head|face|hair|頭|头|顔|脸/i;
const BODY = /body|chest|bust|belly|torso|体|身/i;

/** hitTest 返回的点击区名字 → 'head' / 'body'；都不认识或没点中返回 null。头优先（身体的框常常把头也包进去）。 */
export function zoneOf(names) {
    if (!Array.isArray(names) || !names.length) return null;
    if (names.some((name) => HEAD.test(String(name)))) return 'head';
    if (names.some((name) => BODY.test(String(name)))) return 'body';
    return null;
}

/** 模型有没有认得出的点击区（有才用它判断，没有就按轮廓估）。 */
export function hasZones(names) {
    return Array.isArray(names) && names.some((name) => HEAD.test(String(name)));
}
