/*
 * 町景：城寨街区的坐标数据。纯数据、确定性，浏览器和 node 都能用。
 *
 * 单位米，y 向上。街区占 x∈[-100,100]、z∈[-60,60]；南面 z=+60 是正立面，
 * 外面是外街。楼体、招牌、巷道三个模块都从这里取坐标，挂点的用途
 * （招牌 / 空调 / 窗笼 / 空）也在这里统一分配，免得互相打架。
 */
(function (global) {
    'use strict';

    const FLOOR = 2.85;
    const BAY = 2.05;
    // 实景约 210×120 米；这里取 200×120。
    const HX = 100;
    const HZ = 60;
    const STREET = Object.freeze({
        south: { z0: HZ, z1: HZ + 12 },
        east: { x0: HX, x1: HX + 10 },
        west: { x0: -HX - 10, x1: -HX },
        north: { z0: -HZ - 10, z1: -HZ }
    });

    const hash = (text) => {
        let h = 2166136261;
        for (let i = 0; i < text.length; i += 1) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    };
    const rng = (seed) => {
        let a = typeof seed === 'number' ? seed >>> 0 : hash(String(seed));
        return () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    };

    // 巷道。axis 'x' = 东西走向（中心 z=c），'z' = 南北走向（中心 x=c）。
    // from/to 是沿走向的范围；短巷是死胡同。
    // 三楼以上大多被跨巷加建盖住（见 bridges），巷子从天上几乎看不见。
    const ALLEYS = Object.freeze([
        { id: 'A', axis: 'x', c: 0, w: 2.6, from: -HX, to: HX, main: true },
        { id: 'N', axis: 'x', c: -32, w: 1.8, from: -HX, to: HX },
        { id: 'S', axis: 'x', c: 30, w: 2.0, from: -HX, to: HX },
        { id: 'B', axis: 'z', c: -14, w: 2.2, from: -HZ, to: HZ, main: true },
        { id: 'W', axis: 'z', c: -62, w: 1.6, from: -HZ, to: 0 },
        { id: 'V', axis: 'z', c: -40, w: 1.5, from: 0, to: HZ },
        { id: 'E', axis: 'z', c: 30, w: 2.4, from: 0, to: HZ },
        { id: 'F', axis: 'z', c: 48, w: 1.8, from: -HZ, to: 30 },
        { id: 'K', axis: 'z', c: 74, w: 1.6, from: -HZ, to: HZ },
        { id: 'G', axis: 'z', c: 4, w: 1.4, from: -32, to: 0 },
        { id: 'H', axis: 'x', c: 16, w: 1.4, from: -14, to: 30 },
        { id: 'J', axis: 'x', c: -16, w: 1.3, from: 48, to: HX }
    ]);

    // 主屏所在的楼和屏幕尺寸。屏幕挂在南立面上，这几栋楼的南立面挂点都留给它。
    const SCREENS = Object.freeze([
        { id: 'main', center: [10, 24, 60.3], size: [18, 10], normal: [0, 0, 1], primary: true },
        { id: 'east', center: [HX + 0.3, 28, 14], size: [8, 14], normal: [1, 0, 0] },
        { id: 'alleyA', center: [-6, 9.5, 1.32], size: [2.4, 6], normal: [0, 0, 1], alley: 'A' }
    ]);

    // 楼高：外圈一圈 13–15 层板楼像城墙一样围住，里面高低参差、
    // 屋顶层层加建；西南角和东北角各有一栋更高的塔楼。
    const floorsAt = (x, z, r) => {
        const edge = Math.min(HX - Math.abs(x), HZ - Math.abs(z));
        let f = edge < 9 ? 13.5 + r() * 2 : 10 + r() * 4.5;
        if (edge >= 9 && r() < 0.18) f -= 3 + r() * 2;
        if (edge >= 9 && r() < 0.1) f += 2;
        return Math.max(6, Math.min(17, Math.round(f)));
    };

    // 某条巷子在给定区间里占用的 [lo, hi]。
    const alleyCuts = (axis, along0, along1, cross) => ALLEYS
        .filter(a => a.axis === axis && a.from < along1 && a.to > along0)
        .map(a => [a.c - a.w / 2, a.c + a.w / 2, a])
        .filter(([lo, hi]) => hi > cross[0] && lo < cross[1])
        .sort((p, q) => p[0] - q[0]);

    const splitRange = (lo, hi, cuts) => {
        const spans = [];
        let cursor = lo;
        cuts.forEach(([a, b]) => {
            if (a > cursor + 0.5) spans.push([cursor, a]);
            cursor = Math.max(cursor, b);
        });
        if (hi > cursor + 0.5) spans.push([cursor, hi]);
        return spans;
    };

    const buildLots = (r) => {
        const lots = [];
        // 先按东西巷切出带，再按穿过该带的南北巷切块，最后切成地块。
        const bands = splitRange(-HZ, HZ, ALLEYS.filter(a => a.axis === 'x' && a.from <= -HX && a.to >= HX)
            .map(a => [a.c - a.w / 2, a.c + a.w / 2]).sort((p, q) => p[0] - q[0]));
        bands.forEach(([z0, z1]) => {
            const cuts = ALLEYS.filter(a => a.axis === 'z' && a.from < z1 - 0.5 && a.to > z0 + 0.5)
                .map(a => [a.c - a.w / 2, a.c + a.w / 2]).sort((p, q) => p[0] - q[0]);
            splitRange(-HX, HX, cuts).forEach(([x0, x1]) => {
                // 短的东西巷只切它覆盖的那几块。
                const partial = ALLEYS.filter(a => a.axis === 'x' && !(a.from <= -HX && a.to >= HX)
                    && a.from < x1 && a.to > x0 && a.c > z0 && a.c < z1);
                const zSpans = splitRange(z0, z1, partial.map(a => [a.c - a.w / 2, a.c + a.w / 2]));
                zSpans.forEach(([bz0, bz1]) => {
                    let x = x0;
                    while (x < x1 - 0.5) {
                        let w = 3.6 + r() * 5;
                        if (x1 - (x + w) < 3.2) w = x1 - x;
                        const lx1 = Math.min(x1, x + w);
                        const depth = bz1 - bz0;
                        const rows = Math.max(1, Math.round(depth / (7 + r() * 4)));
                        let z = bz0;
                        for (let i = 0; i < rows; i += 1) {
                            const rest = bz1 - z;
                            const d = i === rows - 1 ? rest : rest / (rows - i) * (0.8 + r() * 0.4);
                            lots.push({ x0: x, x1: lx1, z0: z, z1: z + d });
                            z += d;
                        }
                        x = lx1;
                    }
                });
            });
        });
        lots.forEach((lot, index) => {
            lot.id = index;
            const cx = (lot.x0 + lot.x1) / 2, cz = (lot.z0 + lot.z1) / 2;
            lot.floors = floorsAt(cx, cz, r);
            // 主屏背后的楼要够高够宽。
            if (lot.z1 > 59 && lot.x1 > -1 && lot.x0 < 21) lot.floors = Math.max(lot.floors, 13);
            if (lot.x1 > HX - 1 && lot.z1 > 5 && lot.z0 < 23) lot.floors = Math.max(lot.floors, 15);
            if ((cx < -88 && cz > 48) || (cx > 88 && cz < -48)) lot.floors = Math.max(lot.floors, 17);
            lot.height = lot.floors * FLOOR;
            lot.well = false;
            lot.seed = hash(`lot:${index}`);
        });
        // 天井：街区内部挑几块不建楼，做成采光井。
        lots.forEach(lot => {
            const inner = lot.x0 > -HX + 12 && lot.x1 < HX - 12 && lot.z0 > -HZ + 12 && lot.z1 < HZ - 12;
            const small = (lot.x1 - lot.x0) * (lot.z1 - lot.z0) < 70;
            if (inner && small && r() < 0.1) { lot.well = true; lot.floors = 0; lot.height = 0; }
        });
        return lots;
    };

    const SIDES = Object.freeze({
        south: { normal: [0, 0, 1] }, north: { normal: [0, 0, -1] },
        east: { normal: [1, 0, 0] }, west: { normal: [-1, 0, 0] }
    });

    // 相邻地块挡住的高度：与这一面贴着的邻楼最高处。
    const blockedHeight = (lot, side, lots) => {
        let h = 0;
        const eps = 0.3;
        lots.forEach(other => {
            if (other === lot || other.height <= 0) return;
            let touch = false;
            if (side === 'south') touch = Math.abs(other.z0 - lot.z1) < eps && other.x0 < lot.x1 - eps && other.x1 > lot.x0 + eps;
            if (side === 'north') touch = Math.abs(other.z1 - lot.z0) < eps && other.x0 < lot.x1 - eps && other.x1 > lot.x0 + eps;
            if (side === 'east') touch = Math.abs(other.x0 - lot.x1) < eps && other.z0 < lot.z1 - eps && other.z1 > lot.z0 + eps;
            if (side === 'west') touch = Math.abs(other.x1 - lot.x0) < eps && other.z0 < lot.z1 - eps && other.z1 > lot.z0 + eps;
            if (touch) h = Math.max(h, other.height);
        });
        return h;
    };

    const facing = (lot, side, lots) => {
        // 这一面对着什么：外街、巷、天井，或者只是高出邻楼的部分（顶部）。
        if (side === 'south' && lot.z1 >= HZ - 0.01) return 'street';
        if (side === 'north' && lot.z0 <= -HZ + 0.01) return 'street';
        if (side === 'east' && lot.x1 >= HX - 0.01) return 'street';
        if (side === 'west' && lot.x0 <= -HX + 0.01) return 'street';
        const p = side === 'south' ? [(lot.x0 + lot.x1) / 2, lot.z1 + 0.6]
            : side === 'north' ? [(lot.x0 + lot.x1) / 2, lot.z0 - 0.6]
                : side === 'east' ? [lot.x1 + 0.6, (lot.z0 + lot.z1) / 2] : [lot.x0 - 0.6, (lot.z0 + lot.z1) / 2];
        const well = lots.find(o => o.well && p[0] > o.x0 && p[0] < o.x1 && p[1] > o.z0 && p[1] < o.z1);
        if (well) return 'well';
        const alley = ALLEYS.find(a => a.axis === 'x'
            ? Math.abs(p[1] - a.c) < a.w / 2 + 0.7 && p[0] > a.from && p[0] < a.to
            : Math.abs(p[0] - a.c) < a.w / 2 + 0.7 && p[1] > a.from && p[1] < a.to);
        if (alley) return `alley:${alley.id}`;
        return 'upper';
    };

    const screenHit = (pos, normal) => SCREENS.some(s => {
        if (s.normal[0] !== normal[0] || s.normal[2] !== normal[2]) return false;
        const dx = s.normal[0] ? Math.abs(pos[2] - s.center[2]) : Math.abs(pos[0] - s.center[0]);
        const dy = Math.abs(pos[1] - s.center[1]);
        const dn = s.normal[0] ? Math.abs(pos[0] - s.center[0]) : Math.abs(pos[2] - s.center[2]);
        return dn < 2 && dx < s.size[0] / 2 + 1.2 && dy < s.size[1] / 2 + 1.6;
    });

    const buildFacades = (lots, r) => {
        const facades = [];
        lots.forEach(lot => {
            if (lot.height <= 0) return;
            Object.keys(SIDES).forEach(side => {
                const y0 = Math.min(lot.height, blockedHeight(lot, side, lots));
                if (lot.height - y0 < FLOOR * 0.9) return;
                const normal = SIDES[side].normal;
                const p0 = side === 'south' ? [lot.x0, lot.z1] : side === 'north' ? [lot.x1, lot.z0]
                    : side === 'east' ? [lot.x1, lot.z1] : [lot.x0, lot.z0];
                const p1 = side === 'south' ? [lot.x1, lot.z1] : side === 'north' ? [lot.x0, lot.z0]
                    : side === 'east' ? [lot.x1, lot.z0] : [lot.x0, lot.z1];
                const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
                const tangent = [(p1[0] - p0[0]) / length, 0, (p1[1] - p0[1]) / length];
                const kind = facing(lot, side, lots);
                const facade = {
                    id: facades.length, lot: lot.id, side, kind, p0, p1, length,
                    normal, tangent, y0, y1: lot.height, slots: []
                };
                const cols = Math.max(1, Math.floor(length / BAY));
                const bay = length / cols;
                const firstFloor = Math.ceil(y0 / FLOOR - 0.01);
                const exposed = kind === 'street' || kind.startsWith('alley');
                for (let f = firstFloor; f < lot.floors; f += 1) {
                    for (let c = 0; c < cols; c += 1) {
                        const t = (c + 0.5) * bay;
                        const pos = [p0[0] + tangent[0] * t, f * FLOOR + 1.55, p0[1] + tangent[2] * t];
                        const world = [pos[0], pos[1], pos[2]];
                        let use = 'free';
                        let kindSlot = 'flat';
                        const roll = r();
                        if (screenHit(world, normal)) use = 'screen';
                        else if (f === 0) use = exposed && roll < 0.55 ? 'sign' : 'free';
                        else if (exposed && f <= 7 && roll < 0.2) { use = 'sign'; kindSlot = r() < 0.6 ? 'blade' : 'flat'; }
                        else if (exposed && f > 7 && roll < 0.06) { use = 'sign'; kindSlot = 'flat'; }
                        else if (roll < (kind === 'well' ? 0.18 : 0.42)) use = 'ac';
                        else if (roll < 0.62) use = 'cage';
                        facade.slots.push({
                            facade: facade.id, floor: f, col: c, pos: world, normal, tangent,
                            width: bay, kind: f === 0 ? 'shop' : kindSlot, use
                        });
                    }
                }
                // 屋顶招牌位：对外的立面屋顶上一到两个。
                if (exposed && length > 5) {
                    const n = length > 9 && r() < 0.5 ? 2 : 1;
                    for (let i = 0; i < n; i += 1) {
                        const t = length * (n === 1 ? 0.5 : (i ? 0.72 : 0.28));
                        const pos = [p0[0] + tangent[0] * t, lot.height + 0.4, p0[1] + tangent[2] * t];
                        facade.slots.push({
                            facade: facade.id, floor: lot.floors, col: -1, pos, normal, tangent,
                            width: Math.min(8, length * 0.8 / n), kind: 'roof', use: r() < 0.55 ? 'sign' : 'free'
                        });
                    }
                }
                facades.push(facade);
            });
        });
        return facades;
    };

    // 外街对面和东西两侧的低矮外圈楼，只做剪影和窗灯。
    const buildOuter = (r) => {
        const out = [];
        // 南面外街对面是主镜头的前景，压低到三到七层，免得挡住城寨正面。
        const row = (axis, fixed, dir, from, to, low = false) => {
            let s = from;
            while (s < to) {
                const w = 6 + r() * 10;
                const depth = 10 + r() * 8;
                const h = (low ? 3 + Math.floor(r() * 5) : 5 + Math.floor(r() * 9)) * FLOOR;
                const a = fixed + dir * 0.0, b = fixed + dir * depth;
                const box = axis === 'x'
                    ? { x0: s, x1: Math.min(to, s + w), z0: Math.min(a, b), z1: Math.max(a, b) }
                    : { x0: Math.min(a, b), x1: Math.max(a, b), z0: s, z1: Math.min(to, s + w) };
                out.push({ ...box, height: h, seed: hash(`outer:${out.length}`) });
                s += w + 0.6 + r() * 1.5;
            }
        };
        row('x', STREET.south.z1, 1, -150, 150, true);
        row('z', STREET.east.x1, 1, -110, STREET.south.z1);
        row('z', STREET.west.x0, -1, -110, STREET.south.z1);
        row('x', STREET.north.z0, -1, -150, 150);
        return out;
    };

    // 跨巷加建：主巷 A、B 只零星盖，其余巷子三楼以上大多被盖住。
    const buildBridges = (lots, r) => {
        const out = [];
        ALLEYS.forEach(a => {
            let s = a.from + 2;
            while (s < a.to - 2) {
                const len = 2 + r() * (a.main ? 4 : 9);
                const covered = r() < (a.main ? 0.22 : 0.62);
                if (covered) {
                    const e = Math.min(a.to - 1, s + len);
                    const box = a.axis === 'x'
                        ? { x0: s, x1: e, z0: a.c - a.w / 2, z1: a.c + a.w / 2 }
                        : { x0: a.c - a.w / 2, x1: a.c + a.w / 2, z0: s, z1: e };
                    // 两侧楼里较矮的那栋决定加建能盖多高。
                    const probe = a.axis === 'x'
                        ? [[(s + e) / 2, a.c - a.w / 2 - 0.5], [(s + e) / 2, a.c + a.w / 2 + 0.5]]
                        : [[a.c - a.w / 2 - 0.5, (s + e) / 2], [a.c + a.w / 2 + 0.5, (s + e) / 2]];
                    const heights = probe.map(([px, pz]) => (lots.find(l => px > l.x0 && px < l.x1 && pz > l.z0 && pz < l.z1) || {}).floors || 0);
                    const top = Math.min(...heights) - Math.floor(r() * 3);
                    const bottom = a.main ? 3 + Math.floor(r() * 3) : 2 + Math.floor(r() * 2);
                    if (top - bottom >= 2) out.push({ ...box, alley: a.id, y0: bottom * FLOOR, y1: top * FLOOR, floors: top - bottom });
                }
                s += len + 1 + r() * (a.main ? 10 : 4);
            }
        });
        return out;
    };

    const CAMERA = Object.freeze({
        iso: { position: [78, 62, 128], target: [6, 20, 46], fov: 38, orbit: 22 },
        street: { from: [-34, 2.4, 67.6], to: [50, 5.5, 67.6], target: [10, 13, 60], fov: 62 },
        roof: { from: [-90, 56, 40], to: [60, 50, -40], fov: 55 },
        screen: { position: [10, 22, 80], target: [10, 22.4, 60], fov: 45 }
    });

    // 主入口：主巷 B 的南口，牌楼和集市雨棚（巷道模块画）。招牌避开 keepOut 这个盒子。
    const GATE = Object.freeze({ x: -14, z: 61.2, width: 7.2, height: 7.3,
        plaque: { center: [-14, 5.05, 61.46], width: 2.6, height: 0.9 },
        keepOut: { x0: -28, x1: -1, z0: 50, z1: 64, y1: 9 } });

    const build = (seed = 'kowloon') => {
        const r = rng(`layout:${seed}`);
        const lots = buildLots(r);
        const facades = buildFacades(lots, r);
        const outer = buildOuter(r);
        const bridges = buildBridges(lots, r);
        const slotCount = facades.reduce((n, f) => n + f.slots.length, 0);
        return {
            FLOOR, BAY, HX, HZ, STREET, ALLEYS, SCREENS, CAMERA, GATE,
            lots, facades, outer, bridges, slotCount,
            slots(filter) {
                const list = [];
                facades.forEach(f => f.slots.forEach(s => { if (!filter || filter(s, f)) list.push(s); }));
                return list;
            }
        };
    };

    const api = Object.freeze({ build, hash, rng, FLOOR, BAY, HX, HZ });
    global.MusicStageKowloonLayout = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
