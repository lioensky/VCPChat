/* global PIXI */
// 网格变形的 2D 角色（*.puppet.json）：一张立绘切出底图、眼睛、嘴巴等几块贴图，
// 每块是一张三角网格，按 Live2D 同名参数（ParamAngleX、ParamEyeLOpen、ParamMouthForm…）逐帧挪顶点。
// 不需要 Cubism Core，也不需要 Cubism Editor 导出的 moc3；适合只有一张图的角色。
//
// 格式（坐标都是底图像素，原点左上，y 向下）：
//   size        [宽, 高]
//   base        底图（抠好透明背景的整张角色）
//   weights     { image, channels: { head, hair, body } }  低分辨率权重图，按通道取：头部跟随、头发摆动、身体
//   head        { pivot, center, radius: [rx, ry], turn, nod, roll }  转头的平移量（像素）和歪头系数
//   breath      { lift, widen, period }
//   hair        { sway, stiffness, damping }
//   eyes[]      { side: 'L'|'R', image, lid?, lash?, lowerLash?, rect: [x, y, w, h],
//                 upper: [[x, y]…], lower: [[x, y]…], lashTop?: [[x, y]…], iris: { center, radius } }
//               upper 是上睫毛下沿、lower 是下眼睑；lid 是盖住眼睛的肤色带，lash/lowerLash 是抠出来的上下睫毛。
//               闭眼时肤色带从上往下展开、上睫毛跟着落到下眼睑；笑眼时下眼皮往上抬。
//   mouth       { rect, center, angle, openSize: [w, h], skin?, closed: [{ image, form }], open: [{ image, form }] }
//               闭嘴按 ParamMouthForm 在 closed 之间插值，张嘴时换成 open，并按 ParamMouthOpenY 纵向拉开。
//   overlays[]  { image, rect, param }  按参数值调透明度（例如腮红 ParamCheek）

const DEFAULTS = { ParamEyeLOpen: 1, ParamEyeROpen: 1 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothstep = (e0, e1, v) => {
    const t = clamp((v - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
};

function loadImageData(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            resolve(ctx.getImageData(0, 0, c.width, c.height));
        };
        img.onerror = () => reject(new Error(`加载失败: ${url}`));
        img.src = url;
    });
}

// 折线在 x 处的 y（两端外按端点取值）。
function polyY(points, x) {
    if (x <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
        const [x1, y1] = points[i];
        if (x <= x1) {
            const [x0, y0] = points[i - 1];
            return y0 + (y1 - y0) * ((x - x0) / (x1 - x0 || 1));
        }
    }
    return points[points.length - 1][1];
}

// 一块贴图对应的规则网格；rest 是静止时的顶点坐标（底图像素）。
function gridMesh(texture, rect, cols, rows) {
    const [x, y, w, h] = rect;
    const count = (cols + 1) * (rows + 1);
    const rest = new Float32Array(count * 2);
    const uvs = new Float32Array(count * 2);
    const indices = new Uint32Array(cols * rows * 6);
    let k = 0;
    for (let j = 0; j <= rows; j++) {
        for (let i = 0; i <= cols; i++) {
            const n = j * (cols + 1) + i;
            uvs[n * 2] = i / cols;
            uvs[n * 2 + 1] = j / rows;
            rest[n * 2] = x + (w * i) / cols;
            rest[n * 2 + 1] = y + (h * j) / rows;
            if (i < cols && j < rows) {
                const a = n, b = n + 1, c = n + cols + 1, d = n + cols + 2;
                indices.set([a, b, c, b, d, c], k);
                k += 6;
            }
        }
    }
    const geometry = new PIXI.MeshGeometry({ positions: new Float32Array(rest), uvs, indices });
    const mesh = new PIXI.Mesh({ geometry, texture });
    return { mesh, rest, positions: geometry.positions, geometry };
}

export async function createPuppet(rigUrl) {
    const rig = await (await fetch(rigUrl)).json();
    if (rig.format !== 'vcp-puppet') throw new Error('不是 vcp-puppet 格式');
    const url = (name) => new URL(name, rigUrl).href;
    const textures = {};
    const names = new Set([rig.base, ...(rig.eyes || []).flatMap((e) => [e.image, e.lid, e.lash, e.lowerLash].filter(Boolean)),
        ...(rig.overlays || []).map((o) => o.image)]);
    if (rig.mouth) {
        if (rig.mouth.skin) names.add(rig.mouth.skin);
        for (const v of [...rig.mouth.closed, ...rig.mouth.open]) names.add(v.image);
    }
    await Promise.all([...names].map(async (n) => { textures[n] = await PIXI.Assets.load(url(n)); }));

    // 权重图：低分辨率，按顶点双线性采样一次，存起来。
    const wImg = rig.weights ? await loadImageData(url(rig.weights.image)) : null;
    const channelIndex = { r: 0, g: 1, b: 2, a: 3 };
    const [W, H] = rig.size;
    function sampleWeight(channel, x, y) {
        if (!wImg || !channel) return 0;
        const c = channelIndex[channel];
        const fx = clamp((x / W) * (wImg.width - 1), 0, wImg.width - 1);
        const fy = clamp((y / H) * (wImg.height - 1), 0, wImg.height - 1);
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const x1 = Math.min(x0 + 1, wImg.width - 1), y1 = Math.min(y0 + 1, wImg.height - 1);
        const tx = fx - x0, ty = fy - y0;
        const at = (xx, yy) => wImg.data[(yy * wImg.width + xx) * 4 + c] / 255;
        return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
    }

    const root = new PIXI.Container();
    const parts = [];
    function addPart(texture, rect, cols, rows, local = null) {
        const part = gridMesh(texture, rect, cols, rows);
        const n = part.rest.length / 2;
        part.wHead = new Float32Array(n);
        part.wHair = new Float32Array(n);
        part.wBody = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const x = part.rest[i * 2], y = part.rest[i * 2 + 1];
            part.wHead[i] = sampleWeight(rig.weights?.channels.head, x, y);
            part.wHair[i] = sampleWeight(rig.weights?.channels.hair, x, y);
            part.wBody[i] = sampleWeight(rig.weights?.channels.body, x, y);
        }
        part.local = local;
        root.addChild(part.mesh);
        parts.push(part);
        return part;
    }

    addPart(textures[rig.base], [0, 0, W, H], 48, 36);

    // ---- 眼睛：上眼皮带着睫毛落下（闭眼）、下眼睑抬起（笑眼）、瞳孔移动 ----
    // 每只眼睛叠五层，都和 rect 对齐：眼睛原图 → 下眼皮 → 上眼皮 → 上睫毛 → 下睫毛。
    // 眼皮贴图是一条肤色带（覆盖上睫毛到下眼睑），按列压到需要的高度。
    for (const eye of rig.eyes || []) {
        const [ex, ey, ew, eh] = eye.rect;
        const xs = [eye.upper[0][0], eye.upper[eye.upper.length - 1][0]];
        const side = eye.side === 'L' ? 'L' : 'R';
        const cols = Math.round(ew / 3), rows = Math.round(eh / 2);
        const taperAt = (x) => smoothstep(xs[0] - 2, xs[0] + 6, x) * (1 - smoothstep(xs[1] - 6, xs[1] + 2, x));
        // 这一列的眼皮位置：down 是上睫毛下落的距离，up 是下眼睑抬起的距离。
        const lids = (p, x) => {
            const U = polyY(eye.upper, x), L = polyY(eye.lower, x);
            const top = eye.lashTop ? Math.min(polyY(eye.lashTop, x), U - 2) : U - 8;
            const gap = Math.max(0, L - U);
            const open = p[`ParamEye${side}Open`];
            // 笑眼：下眼皮抬起一截，上眼皮也压下来一点，眼睛成月牙。
            const smile = clamp(p[`ParamEye${side}Smile`], 0, 1);
            const up = smile * 0.3 * gap;
            const closeBy = Math.max(1 - clamp(open, 0, 1), smile * 0.5);
            let down = closeBy * Math.max(0, gap - up + 1.5);
            if (open > 1) down = -(open - 1) * 0.3 * gap;
            const t = taperAt(x);
            return { U, L, top, down: down * t, up: up * t, shut: gap > 0 ? clamp(down / gap, 0, 1) * t : 0 };
        };
        const content = (p, x, y, out) => {
            const ic = eye.iris.center, ir = eye.iris.radius;
            const d = Math.hypot(x - ic[0], y - ic[1]) / ir;
            const wi = 1 - smoothstep(0.55, 1.35, d);
            out[0] = x + wi * p.ParamEyeBallX * ir * 0.28;
            out[1] = y - wi * p.ParamEyeBallY * ir * 0.2;
        };
        // 肤色带 [睫毛上沿, L] 压进 [睫毛上沿, 睫毛上沿 + down]（上眼皮）。
        const upperLid = (p, x, y, out) => {
            const { L, top, down } = lids(p, x);
            out[0] = x;
            out[1] = y <= top ? y : y >= L ? top + Math.max(0, down) : top + ((y - top) / (L - top)) * Math.max(0, down);
        };
        // 同一条肤色带压进 [L - up, L]（下眼皮）。
        const lowerLid = (p, x, y, out) => {
            const { L, top, up } = lids(p, x);
            out[0] = x;
            out[1] = y <= top ? L - up : y >= L ? y : L - up + ((y - top) / (L - top)) * up;
        };
        // 睫毛跟着落下，越接近闭合越扁一点（闭着的睫毛看起来更细）。
        const lash = (p, x, y, out) => {
            const { U, down, shut } = lids(p, x);
            out[0] = x;
            out[1] = U + down - (U - y) * (1 - 0.4 * shut);
        };
        const lowerLash = (p, x, y, out) => { out[0] = x; out[1] = y - lids(p, x).up; };
        addPart(textures[eye.image], eye.rect, cols, rows, content);
        if (eye.lid) {
            addPart(textures[eye.lid], eye.rect, cols, rows, lowerLid);
            addPart(textures[eye.lid], eye.rect, cols, rows, upperLid);
        }
        if (eye.lash) addPart(textures[eye.lash], eye.rect, cols, rows, lash);
        if (eye.lowerLash) addPart(textures[eye.lowerLash], eye.rect, cols, rows, lowerLash);
    }

    // ---- 嘴：闭嘴差分按 form 插值；张嘴差分按 open 纵向拉开 ----
    const mouthParts = { closed: [], open: [], skin: null };
    if (rig.mouth) {
        const m = rig.mouth;
        const ang = (m.angle * Math.PI) / 180, ca = Math.cos(ang), sa = Math.sin(ang);
        const [ow, oh] = m.openSize;
        const openLocal = (p, x, y, out) => {
            const dx = x - m.center[0], dy = y - m.center[1];
            const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
            const r = Math.hypot(u / ow, v / oh);
            const w = 1 - smoothstep(0.75, 1.5, r);
            const s = 0.15 + 0.85 * clamp(p.ParamMouthOpenY / 0.75, 0, 1.15);
            const v2 = v + w * (v * s - v);
            out[0] = m.center[0] + u * ca - v2 * sa;
            out[1] = m.center[1] + u * sa + v2 * ca;
        };
        const cols = Math.round(m.rect[2] / 4), rows = Math.round(m.rect[3] / 3);
        if (m.skin) mouthParts.skin = addPart(textures[m.skin], m.rect, 4, 4);
        for (const v of m.closed) mouthParts.closed.push({ form: v.form, part: addPart(textures[v.image], m.rect, 4, 4) });
        for (const v of m.open) mouthParts.open.push({ form: v.form, part: addPart(textures[v.image], m.rect, cols, rows, openLocal) });
        mouthParts.closed.sort((a, b) => a.form - b.form);
        mouthParts.open.sort((a, b) => a.form - b.form);
    }
    const overlays = (rig.overlays || []).map((o) => ({ param: o.param, part: addPart(textures[o.image], o.rect, 8, 6) }));

    // 在相邻两个 form 之间线性插值，其余为 0。
    function formWeights(list, form) {
        const ws = list.map(() => 0);
        if (!list.length) return ws;
        if (form <= list[0].form) { ws[0] = 1; return ws; }
        if (form >= list[list.length - 1].form) { ws[list.length - 1] = 1; return ws; }
        for (let i = 1; i < list.length; i++) {
            if (form <= list[i].form) {
                const t = (form - list[i - 1].form) / (list[i].form - list[i - 1].form);
                ws[i - 1] = 1 - t; ws[i] = t;
                break;
            }
        }
        return ws;
    }

    // ---- 每帧 ----
    const head = rig.head || {};
    const breath = rig.breath || {};
    const hair = rig.hair || {};
    const pivot = head.pivot || [W / 2, H];
    const hc = head.center || [W / 2, H / 3];
    const hr = head.radius || [W / 3, H / 3];
    const spring = { x: 0, v: 0 };
    let time = 0;
    const tmp = [0, 0];

    function globalDeform(p, part, i, x, y, out) {
        const wh = part.wHead[i], wr = part.wHair[i], wb = part.wBody[i];
        const ax = clamp(p.ParamAngleX / 30, -1, 1), ay = clamp(p.ParamAngleY / 30, -1, 1);
        // 转头：脸中间挪得多、轮廓挪得少，近似绕竖轴转动的视差。
        const u = clamp((x - hc[0]) / hr[0], -1, 1), v = clamp((y - hc[1]) / hr[1], -1, 1);
        const par = 0.35 + 0.65 * Math.cos((u * Math.PI) / 2) * Math.cos((v * Math.PI) / 2);
        let hx = x + (head.turn || 0) * ax * par;
        let hy = y - (head.nod || 0) * ay * par;
        // 歪头：绕脖子转。
        const rz = ((p.ParamAngleZ * (head.roll ?? 1)) * Math.PI) / 180;
        const cz = Math.cos(rz), sz = Math.sin(rz);
        const rx = pivot[0] + (hx - pivot[0]) * cz - (hy - pivot[1]) * sz;
        const ry = pivot[1] + (hx - pivot[0]) * sz + (hy - pivot[1]) * cz;
        let ox = x + wh * (rx - x);
        let oy = y + wh * (ry - y);
        // 呼吸：上半身微微抬起、变宽，底边不动。
        const b = p.ParamBreath;
        oy -= (breath.lift || 0) * b * (1 - y / H);
        ox += (x - W / 2) * (breath.widen || 0) * b * wb;
        // 头发：跟着转头甩一下，再加一点风。
        ox += wr * ((hair.sway || 0) * spring.x + 1.6 * Math.sin(time * 1.3 + y * 0.012));
        out[0] = ox; out[1] = oy;
    }

    function update(p, dt) {
        time += dt;
        // 头发弹簧：目标是转头角度的反方向，转得快甩得远。
        const k = hair.stiffness || 26, c = hair.damping || 5;
        const target = -clamp(p.ParamAngleX / 30, -1, 1) * 0.6 - clamp(p.ParamAngleZ / 30, -1, 1) * 0.6;
        spring.v += (k * (target - spring.x) - c * spring.v) * dt;
        spring.x += spring.v * dt;

        for (const part of parts) {
            const { rest, positions, local } = part;
            const n = rest.length / 2;
            for (let i = 0; i < n; i++) {
                let x = rest[i * 2], y = rest[i * 2 + 1];
                if (local) { local(p, x, y, tmp); x = tmp[0]; y = tmp[1]; }
                globalDeform(p, part, i, x, y, tmp);
                positions[i * 2] = tmp[0];
                positions[i * 2 + 1] = tmp[1];
            }
            part.geometry.getBuffer('aPosition').update();
        }

        if (rig.mouth) {
            const openA = smoothstep(0.06, 0.2, p.ParamMouthOpenY);
            const cw = formWeights(mouthParts.closed, p.ParamMouthForm);
            const ow = formWeights(mouthParts.open, p.ParamMouthForm);
            mouthParts.closed.forEach((m, i) => { m.part.mesh.alpha = cw[i] * (1 - openA); m.part.mesh.visible = m.part.mesh.alpha > 0.01; });
            mouthParts.open.forEach((m, i) => { m.part.mesh.alpha = ow[i] * openA; m.part.mesh.visible = m.part.mesh.alpha > 0.01; });
        }
        for (const o of overlays) {
            o.part.mesh.alpha = clamp(p[o.param] || 0, 0, 1);
            o.part.mesh.visible = o.part.mesh.alpha > 0.01;
        }
    }

    return {
        root,
        width: W,
        height: H,
        headCenter: hc,
        defaults: { ...DEFAULTS },
        update,
        info: { name: rig.name || null, parts: parts.length },
    };
}
