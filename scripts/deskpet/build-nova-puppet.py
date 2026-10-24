# 把 assets/nova_button_light.png 做成桌宠用的网格立绘（vcp-puppet，DeskPetmodules/puppet.js 读取）。
# 用法：python3 -I scripts/deskpet/build-nova-puppet.py assets/nova_button_light.png <isnet-anime.onnx> <输出目录>
# 依赖：numpy、pillow、opencv-python-headless、onnxruntime；抠图模型 isnet-anime.onnx 来自
# https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-anime.onnx 。
# 眼睛、嘴、腮红的位置是对着这张图手工标的，换图需要重标。
import json, math, os, sys
import numpy as np, cv2, onnxruntime as ort
from PIL import Image, ImageDraw, ImageFilter

SRC, MODEL, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
CROP = (560, 0, 1792, 878)            # character area of nova_button_light.png
OX, OY = CROP[0], CROP[1]
SCALE = 0.75                          # ship at 924x659; plenty for a ~400px pet window

def P(x, y):                          # source coords -> output coords
    return [round((x - OX) * SCALE, 1), round((y - OY) * SCALE, 1)]

src = Image.open(SRC).convert('RGB').crop(CROP)
W0, H0 = src.size

# ---- 1. cutout (isnet-anime) ------------------------------------------------
x = np.asarray(src.resize((1024, 1024), Image.LANCZOS)).astype(np.float32) / 255.0
x = (x - np.array([0.485, 0.456, 0.406])).transpose(2, 0, 1)[None].astype(np.float32)
sess = ort.InferenceSession(MODEL, providers=['CPUExecutionProvider'])
p = sess.run(None, {sess.get_inputs()[0].name: x})[0][0, 0]
p = (p - p.min()) / (p.max() - p.min())
alpha = np.asarray(Image.fromarray((p * 255).astype(np.uint8)).resize((W0, H0), Image.LANCZOS)).astype(np.float32) / 255
# The picture is cropped at the top, right and bottom; fade those cut edges so the bust floats.
yy, xx = np.mgrid[0:H0, 0:W0].astype(np.float32)
def ramp(d, n): return np.clip(d / n, 0, 1) ** 1.5
alpha *= ramp(yy, 60) * ramp(H0 - 1 - yy, 140) * ramp(W0 - 1 - xx, 120)
rgba = np.dstack([np.asarray(src), (alpha * 255).astype(np.uint8)])
full = Image.fromarray(rgba, 'RGBA')
W, H = round(W0 * SCALE), round(H0 * SCALE)
base = full.resize((W, H), Image.LANCZOS)
base.save(os.path.join(OUT, 'base.png'), optimize=True)

def patch(box, img=None):
    """Crop a source-space box from the (unscaled) cutout, return scaled patch + its rect."""
    x0, y0, x1, y1 = box
    im = (img or full).crop((x0 - OX, y0 - OY, x1 - OX, y1 - OY))
    w, h = round((x1 - x0) * SCALE), round((y1 - y0) * SCALE)
    return im.resize((w, h), Image.LANCZOS), P(x0, y0) + [w, h]

def feather(im, n=6):
    """Fade a patch's border so it melts into the base layer underneath."""
    a = np.asarray(im).copy()
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.minimum(np.minimum(xx, w - 1 - xx), np.minimum(yy, h - 1 - yy)).astype(np.float32)
    a[..., 3] = (a[..., 3] * np.clip(d / n, 0, 1)).astype(np.uint8)
    return Image.fromarray(a, 'RGBA')

# ---- 2. eyes: patches + lid curves + iris --------------------------------------
# "Character left" eye is the one on the viewer's right (Live2D naming).
EYES = {
    'L': dict(box=(1108, 268, 1262, 412),
              upper=[(1143, 336), (1158, 318), (1180, 311), (1200, 310), (1216, 316), (1228, 332)],
              lower=[(1143, 338), (1152, 365), (1170, 383), (1195, 389), (1214, 379), (1228, 346)],
              iris=(1191, 349, 34)),
    'R': dict(box=(868, 352, 1002, 482),
              upper=[(889, 416), (905, 398), (925, 391), (950, 390), (970, 396), (984, 410), (993, 424)],
              lower=[(889, 419), (900, 438), (915, 453), (940, 462), (962, 460), (978, 452), (993, 434)],
              iris=(957, 428, 30)),
}
def polyline_y(pts, x):
    xs = [q[0] for q in pts]; ys = [q[1] for q in pts]
    return float(np.interp(x, xs, ys))

eyes_json = []
for side, e in EYES.items():
    im, rect = patch(e['box'])
    stem = f'eye_{side.lower()}'
    feather(im).save(os.path.join(OUT, stem + '.png'), optimize=True)
    x0, y0, x1, y1 = e['box']
    pw, ph = x1 - x0, y1 - y0
    src_patch = np.asarray(full)[y0 - OY:y1 - OY, x0 - OX:x1 - OX].astype(np.float32)
    rgb = src_patch[..., :3]
    lum = rgb @ np.array([0.3, 0.59, 0.11])
    ux0, ux1 = int(e['upper'][0][0]), int(e['upper'][-1][0])
    lid = np.zeros((ph, pw, 4), np.float32)
    lash = np.zeros((ph, pw, 4), np.float32)
    lower = np.zeros((ph, pw, 4), np.float32)
    # 1) per column: find the upper lash (dark, not blue) right above the eye; U = its lower edge, top = its upper edge
    lashm = (lum < 125) & ((rgb[..., 2] - rgb[..., 0]) < 40)
    det = {}
    for xx in range(ux0, ux1 + 1):
        cx = xx - x0
        gu = int(polyline_y(e['upper'], xx)) - y0
        rows = [r for r in range(max(5, gu - 16), min(ph, gu + 14)) if lashm[r, cx] and lashm[r - 4:r + 1, cx].sum() >= 3]
        if not rows: continue
        U = max(rows) + 1
        t, miss = U - 1, 0
        while t > U - 30 and t > 0:
            if lashm[t, cx]: miss = 0
            else:
                miss += 1
                if miss > 2: break
            t -= 1
        det[xx] = (U + y0, t + miss + y0)
    dx = np.array(sorted(det)); dU = np.array([det[k][0] for k in dx], np.float32); dT = np.array([det[k][1] for k in dx], np.float32)
    def smooth1(v, k=5):
        pad = np.pad(v, k // 2, mode='edge')
        med = np.array([np.median(pad[i:i + k]) for i in range(len(v))])
        return np.convolve(np.pad(med, 2, mode='edge'), np.ones(5) / 5, mode='valid')
    dU, dT = smooth1(dU), smooth1(dT)
    allx = np.arange(ux0, ux1 + 1)
    Ucol = dict(zip(allx, np.interp(allx, dx, dU)))
    tops = dict(zip(allx, np.minimum(np.interp(allx, dx, dT), np.interp(allx, dx, dU) - 3)))
    e['upper'] = [(int(xx), float(Ucol[xx])) for xx in range(ux0, ux1 + 1, 3)] + [(ux1, float(Ucol[ux1]))]
    above_c, below_c = {}, {}
    for xx in range(ux0, ux1 + 1):
        cx = xx - x0
        L = polyline_y(e['lower'], xx); top = tops[xx]
        a = [rgb[r - y0, cx] for r in range(int(top) - 9, int(top) - 2) if 0 <= r - y0 < ph and lum[r - y0, cx] > 160]
        b = [rgb[r - y0, cx] for r in range(int(L) + 5, int(L) + 13) if 0 <= r - y0 < ph and lum[r - y0, cx] > 160]
        if a: above_c[xx] = np.median(a, axis=0)
        if b: below_c[xx] = np.median(b, axis=0)
    gb = np.median(list(below_c.values()), axis=0)
    ga = np.median(list(above_c.values()), axis=0) if above_c else gb * 0.95
    for xx in range(ux0, ux1 + 1):
        cx = xx - x0
        U = polyline_y(e['upper'], xx); L = polyline_y(e['lower'], xx); top = tops[xx]
        ca = above_c.get(xx, ga); cb = below_c.get(xx, gb)
        edge = min(1.0, (xx - ux0 + 1) / 5, (ux1 + 1 - xx) / 5)
        for yy in range(int(top) - 3, int(L) + 4):
            cy = yy - y0
            if not (0 <= cy < ph): continue
            t = np.clip((yy - top) / max(1, L - top), 0, 1)
            col = ca * (1 - t) + cb * t
            a = np.clip(min((yy - top + 4) / 2.5, (L + 3 - yy) / 2), 0, 1) * edge
            lid[cy, cx, :3] = col; lid[cy, cx, 3] = 255 * a
            if top - 1 <= yy <= U + 1:
                dk = np.clip((175 - lum[cy, cx]) / 50, 0, 1) * np.clip((60 - (rgb[cy, cx, 2] - rgb[cy, cx, 0])) / 30, 0, 1)
                lash[cy, cx, :3] = rgb[cy, cx]; lash[cy, cx, 3] = 255 * dk * edge
            if L - 2 <= yy <= L + 4:
                dk = np.clip((150 - lum[cy, cx]) / 50, 0, 1) * np.clip((60 - (rgb[cy, cx, 2] - rgb[cy, cx, 0])) / 30, 0, 1)
                lower[cy, cx, :3] = rgb[cy, cx]; lower[cy, cx, 3] = 255 * dk * edge
    # soften the skin band horizontally so columns don't show
    lid[..., :3] = cv2.GaussianBlur(lid[..., :3], (0, 0), sigmaX=7, sigmaY=1)
    # transparent pixels get a matching colour so resizing doesn't pull a dark fringe in
    for arr, fillc in ((lid, ga), (lash, np.array([60, 40, 45])), (lower, np.array([90, 60, 65]))):
        m = arr[..., 3] < 1
        arr[m, :3] = fillc
    lid[..., :3] = np.where(lid[..., 3:4] > 0, lid[..., :3], cv2.GaussianBlur(lid[..., :3], (0, 0), 4))
    names = {}
    for key, arr in (('lid', lid), ('lash', lash), ('lowerLash', lower)):
        img = Image.fromarray(arr.clip(0, 255).astype(np.uint8), 'RGBA').resize(im.size, Image.LANCZOS)
        names[key] = f'{stem}_{key.lower()}.png'
        img.save(os.path.join(OUT, names[key]), optimize=True)
    lash_top = [P(xx, tops[xx]) for xx in range(ux0, ux1 + 1, 4)] + [P(ux1, tops[ux1])]
    cx, cy, r = e['iris']
    eyes_json.append({
        'side': side, 'image': stem + '.png', 'rect': rect,
        'lid': names['lid'], 'lash': names['lash'], 'lowerLash': names['lowerLash'],
        'upper': [P(*q) for q in e['upper']], 'lower': [P(*q) for q in e['lower']], 'lashTop': lash_top,
        'iris': {'center': P(cx, cy), 'radius': round(r * SCALE, 1)},
    })

# ---- 3. mouth: inpaint the line away, then draw variants -------------------------
MBOX = (1018, 514, 1138, 592)
MC = (1078, 551)
MANG = math.atan2(540 - 562, 1121 - 1035)       # mouth axis tilt (head roll)
mx0, my0 = MBOX[0] - OX, MBOX[1] - OY
mrgb = np.asarray(full)[my0:my0 + MBOX[3] - MBOX[1], mx0:mx0 + MBOX[2] - MBOX[0], :3].copy()
skin = np.median(mrgb.reshape(-1, 3), axis=0)
dist = np.linalg.norm(mrgb.astype(np.float32) - skin, axis=2)
mask = (dist > 7).astype(np.uint8) * 255
mask = cv2.dilate(mask, np.ones((5, 5), np.uint8))
# Keep the mask to the mouth band so nose shading etc. stays.
band = np.zeros_like(mask)
cv2.line(band, (1029 - MBOX[0], 564 - MBOX[1]), (1128 - MBOX[0], 538 - MBOX[1]), 255, 22)
cv2.ellipse(band, (1080 - MBOX[0], 560 - MBOX[1]), (26, 9), math.degrees(MANG), 0, 360, 255, -1)
mask &= band
clean = cv2.inpaint(np.ascontiguousarray(mrgb[..., ::-1]), mask, 6, cv2.INPAINT_TELEA)[..., ::-1]
clean = cv2.GaussianBlur(clean, (0, 0), 1.2) * (mask[..., None] > 0) + clean * (mask[..., None] == 0)
clean = clean.astype(np.uint8)

SS = 8                                          # supersampling for drawing
LINE = (62, 30, 36, 255)
INSIDE = (128, 42, 54, 255)
TONGUE = (222, 118, 128, 255)
LIPPINK = (214, 132, 138, 120)

def mouth_canvas():
    h, w = clean.shape[:2]
    c = Image.new('RGBA', (w * SS, h * SS))
    return c, ImageDraw.Draw(c)

def L2S(px, py):
    """Mouth-local (x along the mouth, y down) to supersampled patch pixels."""
    ca, sa = math.cos(MANG), math.sin(MANG)
    X = MC[0] - MBOX[0] + px * ca - py * sa
    Y = MC[1] - MBOX[1] + px * sa + py * ca
    return (X * SS, Y * SS)

def curve(f, x0, x1, n=40):
    return [(x0 + (x1 - x0) * i / n, f(x0 + (x1 - x0) * i / n)) for i in range(n + 1)]

def stroke(d, pts, w_mid, w_end, color):
    """Tapered stroke: thick at the ends (anime mouth corners), thin in the middle — or reverse."""
    left, right = [], []
    n = len(pts)
    for i, (px, py) in enumerate(pts):
        a = pts[min(i + 1, n - 1)]; b = pts[max(i - 1, 0)]
        tx, ty = a[0] - b[0], a[1] - b[1]
        l = math.hypot(tx, ty) or 1
        nx, ny = -ty / l, tx / l
        t = abs(i / (n - 1) * 2 - 1)
        w = (w_mid + (w_end - w_mid) * t ** 3) / 2
        if i in (0, n - 1): w *= 0.6
        left.append(L2S(px + nx * w, py + ny * w)); right.append(L2S(px - nx * w, py - ny * w))
    d.polygon(left + right[::-1], fill=color)

def fill(d, pts, color):
    d.polygon([L2S(*q) for q in pts], fill=color)

def finish(c, name):
    h, w = clean.shape[:2]
    art = c.resize((w, h), Image.LANCZOS)
    base_im = Image.fromarray(np.dstack([clean, np.full(clean.shape[:2], 255, np.uint8)]), 'RGBA')
    base_im.alpha_composite(art)
    out = base_im.resize((round(w * SCALE), round(h * SCALE)), Image.LANCZOS)
    feather(out, 5).save(os.path.join(OUT, name), optimize=True)

# skin only (mouth removed): drawn under the variants so cross-fades never show the base's mouth
skin_im = Image.fromarray(np.dstack([clean, np.full(clean.shape[:2], 255, np.uint8)]), 'RGBA')
feather(skin_im.resize((round(skin_im.width * SCALE), round(skin_im.height * SCALE)), Image.LANCZOS), 5).save(os.path.join(OUT, 'mouth_skin.png'))
# original smile (untouched crop)
orig = Image.fromarray(np.dstack([mrgb, np.full(mrgb.shape[:2], 255, np.uint8)]), 'RGBA')
feather(orig.resize((round(orig.width * SCALE), round(orig.height * SCALE)), Image.LANCZOS), 5).save(os.path.join(OUT, 'mouth_smile.png'))

# flat: nearly straight, slight smile
c, d = mouth_canvas(); stroke(d, curve(lambda x: 1.5 * (1 - (x / 30) ** 2), -30, 30), 1.6, 3.6, LINE); finish(c, 'mouth_flat.png')
# frown: arched down, shorter
c, d = mouth_canvas(); stroke(d, curve(lambda x: -4.2 * (1 - (x / 22) ** 2) + 1.5, -22, 22), 1.8, 3.4, LINE); finish(c, 'mouth_frown.png')

def open_mouth(name, w, top, bot, tongue):
    c, d = mouth_canvas()
    up = curve(lambda x: -top * (1 - (x / w) ** 2), -w, w)
    lo = curve(lambda x: bot * max(0, 1 - (x / w) ** 2) ** 0.75, w, -w)
    fill(d, up + lo, INSIDE)
    if tongue:
        tw, th = tongue
        tp = [(math.cos(a) * tw, bot * 0.92 - (math.sin(a)) * th) for a in np.linspace(0, math.pi, 30)]
        lower = curve(lambda x: bot * max(0, 1 - (x / w) ** 2) ** 0.75 - 0.4, tw, -tw, 20)
        inner = Image.new('RGBA', c.size); di = ImageDraw.Draw(inner)
        di.polygon([L2S(*q) for q in tp + lower], fill=TONGUE)
        clip = Image.new('L', c.size, 0); ImageDraw.Draw(clip).polygon([L2S(*q) for q in up + lo], fill=255)
        inner.putalpha(Image.fromarray(np.minimum(np.asarray(inner)[..., 3], np.asarray(clip))))
        c.alpha_composite(inner)
    stroke(d, up, 1.5, 2.8, LINE)
    stroke(d, lo[::-1], 0.9, 0.9, (110, 50, 58, 200))
    finish(c, name)

open_mouth('mouth_talk.png', 17, 2, 10, (9, 5))
open_mouth('mouth_laugh.png', 25, 3, 16, (13, 7))
c, d = mouth_canvas()
o = [(math.cos(a) * 9, 3 + math.sin(a) * 11) for a in np.linspace(0, 2 * math.pi, 60)]
fill(d, o, INSIDE)
d.ellipse([L2S(-5.5, 7)[0], L2S(-5.5, 7)[1], L2S(5.5, 13.5)[0], L2S(5.5, 13.5)[1]], fill=TONGUE)
stroke(d, o[30:] + o[:1], 1.3, 1.6, LINE)
finish(c, 'mouth_o.png')

mrect = P(MBOX[0], MBOX[1]) + [round((MBOX[2] - MBOX[0]) * SCALE), round((MBOX[3] - MBOX[1]) * SCALE)]

# ---- 4. blush overlay ---------------------------------------------------------
BBOX = (850, 360, 1290, 560)
bw, bh = BBOX[2] - BBOX[0], BBOX[3] - BBOX[1]
blush = Image.new('RGBA', (bw, bh))
bd = ImageDraw.Draw(blush)
ca_, sa_ = math.cos(MANG), math.sin(MANG)
for (cx, cy) in [(948, 505), (1222, 438)]:
    lx, ly = cx - BBOX[0], cy - BBOX[1]
    rot = lambda u, v: (lx + u * ca_ - v * sa_, ly + u * sa_ + v * ca_)
    bd.polygon([rot(math.cos(t) * 44, math.sin(t) * 17) for t in np.linspace(0, 2 * math.pi, 48)], fill=(255, 92, 120, 115))
    for k in range(-1, 2):                      # hatch marks
        bd.line([rot(k * 13 + 5, -7), rot(k * 13 - 4, 7)], fill=(225, 70, 100, 90), width=2)
blush = blush.filter(ImageFilter.GaussianBlur(5))
# only on skin of the cutout
ba = np.asarray(blush).copy()
ca = np.asarray(full)[BBOX[1] - OY:BBOX[3] - OY, BBOX[0] - OX:BBOX[2] - OX, 3]
ba[..., 3] = (ba[..., 3].astype(np.float32) * (ca / 255.0)).astype(np.uint8)
blush = Image.fromarray(ba, 'RGBA').resize((round(bw * SCALE), round(bh * SCALE)), Image.LANCZOS)
blush.save(os.path.join(OUT, 'blush.png'), optimize=True)
brect = P(BBOX[0], BBOX[1]) + [blush.width, blush.height]

# ---- 5. weight maps (R head, G hair sway, B body) --------------------------------
MW, MH = 96, 69                                 # low-res; sampled bilinearly per vertex
gy, gx = np.mgrid[0:MH, 0:MW].astype(np.float32)
sx = gx / (MW - 1) * W0 + OX                    # back to source coords
sy = gy / (MH - 1) * H0 + OY
def smooth(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)
# head: ellipse around skull + face, soft falloff down to the neck
hc = (1075, 380)
dh = np.sqrt(((sx - hc[0]) / 360) ** 2 + ((sy - hc[1]) / 330) ** 2)
head = 1 - smooth(0.85, 1.35, dh)
head = np.maximum(head, (1 - smooth(560, 760, sy)) * (1 - smooth(0.9, 1.7, dh)))   # hair hanging from the head
# body polygon (neck, collar, shoulders) never follows the head
body = np.zeros((H0, W0), np.uint8)
poly = np.array([(960, 650), (1060, 690), (1140, 660), (1250, 640), (1420, 700), (1600, 735), (1792, 790),
                 (1792, 878), (860, 878), (900, 770), (930, 700)], np.float32)
cv2.fillPoly(body, [((poly - [OX, OY])).astype(np.int32)], 255)
body = cv2.GaussianBlur(body, (0, 0), 25).astype(np.float32) / 255
bodyS = cv2.resize(body, (MW, MH), interpolation=cv2.INTER_AREA)
head = head * (1 - bodyS)
# hair sway: away from the face axis, more toward the tips, not on the body
side = smooth(250, 420, np.abs(sx - 1080))
down = smooth(330, 760, sy)
hair = side * down * (1 - bodyS) * (np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).resize((MW, MH))) / 255.0)
wm = np.dstack([head, hair, bodyS, np.ones_like(head)])
Image.fromarray((np.clip(wm, 0, 1) * 255).astype(np.uint8), 'RGBA').save(os.path.join(OUT, 'weights.png'))

# ---- 6. rig ------------------------------------------------------------------
rig = {
    'format': 'vcp-puppet', 'version': 1,
    'name': 'Nova', 'size': [W, H],
    'source': 'assets/nova_button_light.png (VCPChat), cut out with isnet-anime; parts hand-placed',
    'base': 'base.png',
    'weights': {'image': 'weights.png', 'channels': {'head': 'r', 'hair': 'g', 'body': 'b'}},
    'head': {'pivot': P(1095, 705), 'center': P(1075, 410), 'radius': [round(300 * SCALE), round(300 * SCALE)],
             'turn': 14, 'nod': 9, 'roll': 1.0},
    'breath': {'lift': 3.0, 'widen': 0.006, 'period': 3.6},
    'hair': {'sway': 9, 'stiffness': 26, 'damping': 5},
    'eyes': eyes_json,
    'mouth': {'rect': mrect, 'center': P(*MC), 'angle': round(math.degrees(MANG), 2),
              'skin': 'mouth_skin.png', 'openSize': [round(44 * SCALE), round(26 * SCALE)],
              # the art's own mouth is a gentle smile, so it is the neutral (form 0) shape
              'closed': [{'image': 'mouth_frown.png', 'form': -1}, {'image': 'mouth_flat.png', 'form': -0.45},
                         {'image': 'mouth_smile.png', 'form': 0}],
              'open': [{'image': 'mouth_o.png', 'form': -1}, {'image': 'mouth_talk.png', 'form': 0},
                       {'image': 'mouth_laugh.png', 'form': 1}]},
    'overlays': [{'image': 'blush.png', 'rect': brect, 'param': 'ParamCheek'}],
}
with open(os.path.join(OUT, 'nova.puppet.json'), 'w') as f:
    json.dump(rig, f, ensure_ascii=False, indent=2)
print('ok', W, H)
