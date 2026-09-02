<style>
@import url("https://fonts.googleapis.com/css2?family=Ma+Shan+Zheng&family=Noto+Serif+SC:wght@400;600;800&display=swap");

#ultimate-test-title {
    position: relative;
    margin: 1.2em 0;
    padding: 0.72em 1em;
    overflow: hidden;
    color: #fffdf7;
    font-family: "Ma Shan Zheng", "STKaiti", cursive;
    font-size: clamp(2rem, 7vw, 4.8rem);
    letter-spacing: 0.08em;
    text-align: center;
    text-shadow: 0 3px 18px rgba(20, 28, 26, 0.42);
    background:
        radial-gradient(circle at 20% 30%, rgba(255, 226, 144, 0.92), transparent 23%),
        linear-gradient(120deg, #2e7567, #945f85, #d97745, #2e7567);
    background-size: 220% 220%;
    border: 1px solid rgba(255, 255, 255, 0.42);
    border-radius: 24px;
    box-shadow: 0 20px 70px rgba(46, 117, 103, 0.24);
    animation: ultimate-title-background 9s ease-in-out infinite;
}

#ultimate-test-title::after {
    content: "";
    position: absolute;
    inset: -60% -20%;
    background: linear-gradient(
        100deg,
        transparent 38%,
        rgba(255, 255, 255, 0.48),
        transparent 62%
    );
    transform: translateX(-70%) rotate(8deg);
    animation: ultimate-title-shine 4.6s ease-in-out infinite;
    pointer-events: none;
}

@keyframes ultimate-title-background {
    0%, 100% { background-position: 0% 45%; }
    50% { background-position: 100% 55%; }
}

@keyframes ultimate-title-shine {
    0%, 35% { transform: translateX(-75%) rotate(8deg); }
    75%, 100% { transform: translateX(75%) rotate(8deg); }
}

.vdoc-inline-magic {
    padding: 0.08em 0.34em;
    color: #704227;
    font-weight: 800;
    background: linear-gradient(90deg, #ffe4a8, #ffd1df, #c9f4e8, #ffe4a8);
    background-size: 260% 100%;
    border-radius: 0.35em;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
    animation: inline-magic-flow 4s linear infinite;
}

@keyframes inline-magic-flow {
    to { background-position: 260% 0; }
}

.vdoc-test-signature {
    margin-top: 3rem;
    padding: 1.2rem 1.4rem;
    color: #f9f4e8;
    font-family: "Ma Shan Zheng", "STKaiti", cursive;
    font-size: 1.35rem;
    text-align: right;
    background: linear-gradient(135deg, #243d37, #5e4268);
    border-radius: 18px;
}
</style>

<h1 id="ultimate-test-title">Scriptorium 混合富文档终极测试</h1>

> 这是一份用于验证 Markdown-first、原生 HTML、LaTeX、Mermaid、网络媒体、Anime.js、CSS 3D、动态表格与局部文字特效能否在同一份源码中稳定共存的测试文档。

> **岛闭合规则：** 每个可编程岛从带有 `data-vdoc-island` 的根 `<div>` 开始，到与该根匹配的最后一个 `</div>` 结束。岛的结构、局部样式、依赖声明和执行脚本必须全部位于这个范围内，任何岛内状态都不得泄漏到后续 Markdown 正文。

## 1. 网络图片与普通 Markdown

下面的猫咪图片直接使用远程 `src`，用于测试网络资源解析、缓存、导出本地化、离线降级和图片说明语义。

![一只近距离面对镜头的漂亮猫咪](https://img.magnific.com/free-photo/close-up-portrait-beautiful-cat_23-2149214373.jpg "猫咪肖像")

**图片说明：** 猫咪的近距离肖像。渲染器应保留替代文字，并在网络不可用时提供可读降级。点击图片应当可以编辑链接。

这一段完全由 Markdown 编写。它包含 **粗体**、*斜体*、~~删除线~~、`行内代码` 和一个 [示例链接](https://example.com)。

- 第一项用于测试无序列表。
- 第二项包含 **嵌套强调**。
- 第三项提醒我们：普通正文不需要永久 DOM ID。

## 2. LaTeX 公式

行内公式展示质能关系：\(E = mc^2\)。

块级公式展示高斯积分：

$$
\int_{-\infty}^{+\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

再测试一个矩阵：

\[
A =
\begin{bmatrix}
1 & 2 \\
3 & 4
\end{bmatrix},
\qquad
\det(A) = -2
\]

## 3. Mermaid 图

```mermaid
flowchart LR
    A[Markdown 原始源码] --> B{混合语法仲裁器}
    B --> C[Markdown 块]
    B --> D[LaTeX 块]
    B --> E[Mermaid 块]
    B --> F[HTML 动画岛]
    C --> G[稳定 HTML]
    D --> G
    E --> G
    F --> H[受控运行时]
    G --> I[独立 HTML 导出]
    H --> I
```

## 4. 原生 Anime.js 动画岛

下面整个根元素是一个完整动画岛。外部依赖声明和初始化脚本都位于岛根内部，最后的根闭合标签是生命周期边界。

<div data-vdoc-island="anime-orbit-garden" id="anime-orbit-garden">
    <style>
        [data-vdoc-island="anime-orbit-garden"] {
            position: relative;
            min-height: 310px;
            margin: 2rem 0;
            overflow: hidden;
            border-radius: 24px;
            background:
                radial-gradient(circle at center, #254f49 0%, #172724 62%, #0c1513 100%);
            box-shadow: 0 24px 80px rgba(20, 50, 44, 0.28);
        }

        [data-vdoc-island="anime-orbit-garden"] .anime-orbit-title {
            position: absolute;
            top: 22px;
            right: 0;
            left: 0;
            color: #fff;
            font: 700 1.1rem system-ui;
            letter-spacing: 0.16em;
            text-align: center;
        }

        [data-vdoc-island="anime-orbit-garden"] .anime-core {
            position: absolute;
            top: 50%;
            left: 50%;
            width: 70px;
            height: 70px;
            margin: -35px;
            border-radius: 50%;
            background: radial-gradient(
                circle at 32% 28%,
                #fff8c8,
                #ffb86b 36%,
                #d65d57 72%
            );
            box-shadow: 0 0 44px rgba(255, 184, 107, 0.78);
        }

        [data-vdoc-island="anime-orbit-garden"] .anime-petal {
            position: absolute;
            width: 22px;
            height: 22px;
            border-radius: 70% 20% 70% 20%;
        }

        [data-vdoc-island="anime-orbit-garden"] .anime-petal:nth-of-type(1) {
            background: #8de5c4;
        }

        [data-vdoc-island="anime-orbit-garden"] .anime-petal:nth-of-type(2) {
            width: 18px;
            height: 18px;
            background: #ffd38a;
        }

        [data-vdoc-island="anime-orbit-garden"] .anime-petal:nth-of-type(3) {
            width: 26px;
            height: 26px;
            background: #eca8d6;
        }

        [data-vdoc-island="anime-orbit-garden"] .anime-petal:nth-of-type(4) {
            width: 16px;
            height: 16px;
            background: #9ec9ff;
        }

        [data-vdoc-island="anime-orbit-garden"] .anime-replay {
            position: absolute;
            right: 18px;
            bottom: 16px;
            padding: 0.65rem 1rem;
            border: 1px solid rgba(255, 255, 255, 0.34);
            border-radius: 999px;
            color: #fff;
            background: rgba(255, 255, 255, 0.1);
            cursor: pointer;
        }
    </style>

    <div class="anime-orbit-title">ANIME.JS ORBIT GARDEN</div>
    <div class="anime-core"></div>
    <div class="anime-petal"></div>
    <div class="anime-petal"></div>
    <div class="anime-petal"></div>
    <div class="anime-petal"></div>
    <button type="button" class="anime-replay">重新绽放</button>

    <script
        src="https://cdn.jsdelivr.net/npm/animejs@3.2.2/lib/anime.min.js"
        data-vdoc-library="anime"></script>

    <script>
    (() => {
        const island = document.querySelector(
            '[data-vdoc-island="anime-orbit-garden"]'
        );
        if (!island || island.dataset.vdocInitialized === 'true') return;
        island.dataset.vdocInitialized = 'true';

        const petals = [...island.querySelectorAll('.anime-petal')];
        const core = island.querySelector('.anime-core');

        const play = () => {
            if (!globalThis.anime) return;

            anime.remove([...petals, core]);

            petals.forEach((petal, index) => {
                const angle = index * Math.PI / 2;
                petal.style.left = '50%';
                petal.style.top = '50%';

                anime({
                    targets: petal,
                    translateX: [
                        Math.cos(angle) * 48,
                        Math.cos(angle + Math.PI * 2) * 112
                    ],
                    translateY: [
                        Math.sin(angle) * 48,
                        Math.sin(angle + Math.PI * 2) * 112
                    ],
                    rotate: '2turn',
                    scale: [0.35, 1.18, 0.72],
                    opacity: [0, 1, 0.78],
                    duration: 4200 + index * 260,
                    delay: index * 160,
                    easing: 'easeInOutSine',
                    direction: 'alternate',
                    loop: true
                });
            });

            anime({
                targets: core,
                scale: [0.88, 1.12],
                boxShadow: [
                    '0 0 24px rgba(255,184,107,.45)',
                    '0 0 72px rgba(255,184,107,.95)'
                ],
                direction: 'alternate',
                duration: 1300,
                easing: 'easeInOutQuad',
                loop: true
            });
        };

        island.querySelector('.anime-replay')?.addEventListener('click', play);
        play();
    })();
    </script>
</div>

上一个动画岛已经在根闭合标签处结束。这一行必须重新由 Markdown 解析器解释，不能被视为动画岛的一部分。
点击文本动画应当被暂停，文本编辑应该映射到源码，源码变动应当不刷新动画状态，文本编辑应当改变动画文本。

## 5. 基于 Div 的 3D 文本块

<div
    data-vdoc-island="three-dimensional-text-card"
    id="three-dimensional-text-card">
    <style>
        [data-vdoc-island="three-dimensional-text-card"] {
            display: grid;
            min-height: 420px;
            margin: 2rem 0;
            overflow: hidden;
            place-items: center;
            perspective: 1100px;
            border-radius: 24px;
            background:
                radial-gradient(circle at 72% 32%, rgba(255, 255, 255, 0.82), transparent 24%),
                linear-gradient(145deg, #e8f5ef, #f9e8dc);
        }

        [data-vdoc-island="three-dimensional-text-card"] .three-d-card {
            position: relative;
            width: min(80%, 620px);
            padding: 3rem 2rem;
            border: 1px solid rgba(255, 255, 255, 0.78);
            border-radius: 22px;
            background: linear-gradient(
                135deg,
                rgba(255, 255, 255, 0.86),
                rgba(255, 255, 255, 0.42)
            );
            box-shadow: 34px 34px 55px rgba(65, 87, 79, 0.25);
            transform: rotateX(10deg) rotateY(-14deg);
            transform-style: preserve-3d;
            transition: transform 0.22s ease;
        }

        [data-vdoc-island="three-dimensional-text-card"] .three-d-title {
            color: #254f49;
            font: 800 clamp(1.8rem, 5vw, 3.8rem) / 1.08 "Noto Serif SC", serif;
            text-shadow: 0 12px 18px rgba(37, 79, 73, 0.2);
            transform: translateZ(72px);
        }

        [data-vdoc-island="three-dimensional-text-card"] .three-d-copy {
            margin: 1rem 0 0;
            color: #624e45;
            font-size: 1.05rem;
            transform: translateZ(38px);
        }

        [data-vdoc-island="three-dimensional-text-card"] .three-d-depth {
            position: absolute;
            inset: 18px;
            border: 2px solid rgba(217, 119, 69, 0.34);
            border-radius: 18px;
            transform: translateZ(-28px);
        }

        [data-vdoc-island="three-dimensional-text-card"] .three-d-cube-stage {
            position: absolute;
            right: 12%;
            bottom: 30px;
            width: 112px;
            height: 112px;
            perspective: 700px;
        }

        [data-vdoc-island="three-dimensional-text-card"] .three-d-cube {
            position: relative;
            width: 100%;
            height: 100%;
            transform-style: preserve-3d;
            animation: three-d-cube-spin 10s linear infinite;
        }

        [data-vdoc-island="three-dimensional-text-card"] .three-d-cube-face {
            position: absolute;
            display: grid;
            width: 112px;
            height: 112px;
            place-items: center;
            padding: 0.7rem;
            box-sizing: border-box;
            border: 1px solid rgba(255, 255, 255, 0.7);
            color: #fffdf7;
            font: 700 0.9rem "Noto Serif SC", serif;
            letter-spacing: 0.08em;
            text-align: center;
            text-shadow: 0 2px 8px rgba(35, 47, 44, 0.32);
            background: linear-gradient(135deg, rgba(46, 117, 103, 0.9), rgba(148, 95, 133, 0.84));
            box-shadow: inset 0 0 24px rgba(255, 255, 255, 0.16);
            backface-visibility: visible;
        }

        [data-vdoc-island="three-dimensional-text-card"] .cube-front {
            transform: rotateY(0deg) translateZ(56px);
        }

        [data-vdoc-island="three-dimensional-text-card"] .cube-back {
            transform: rotateY(180deg) translateZ(56px);
        }

        [data-vdoc-island="three-dimensional-text-card"] .cube-right {
            transform: rotateY(90deg) translateZ(56px);
        }

        [data-vdoc-island="three-dimensional-text-card"] .cube-left {
            transform: rotateY(-90deg) translateZ(56px);
        }

        [data-vdoc-island="three-dimensional-text-card"] .cube-top {
            transform: rotateX(90deg) translateZ(56px);
        }

        [data-vdoc-island="three-dimensional-text-card"] .cube-bottom {
            transform: rotateX(-90deg) translateZ(56px);
        }

        [data-vdoc-island="three-dimensional-text-card"] .three-d-sphere-stage {
            position: absolute;
            bottom: 18px;
            left: 7%;
            width: 174px;
            height: 174px;
            filter: drop-shadow(0 18px 18px rgba(20, 55, 64, 0.34));
        }

        [data-vdoc-island="three-dimensional-text-card"] .three-d-sphere-canvas {
            display: block;
            width: 100%;
            height: 100%;
            outline: none;
        }

        [data-vdoc-island="three-dimensional-text-card"] .sphere-text-source {
            position: absolute;
            width: 1px;
            height: 1px;
            overflow: hidden;
            clip-path: inset(50%);
            white-space: nowrap;
        }

        [data-vdoc-island="three-dimensional-text-card"] .sphere-runtime-status {
            position: absolute;
            right: 5px;
            bottom: 1px;
            padding: 0.22rem 0.48rem;
            border-radius: 999px;
            color: #285b52;
            background: rgba(255, 255, 255, 0.78);
            font: 700 9px system-ui;
            letter-spacing: 0.06em;
            pointer-events: none;
        }

        @keyframes three-d-cube-spin {
            from { transform: rotateX(-18deg) rotateY(0deg) rotateZ(0deg); }
            to { transform: rotateX(342deg) rotateY(360deg) rotateZ(18deg); }
        }

        @media (max-width: 700px) {
            [data-vdoc-island="three-dimensional-text-card"] .three-d-cube-stage {
                right: 8%;
                bottom: 18px;
                transform: scale(0.72);
                transform-origin: bottom right;
            }

            [data-vdoc-island="three-dimensional-text-card"] .three-d-sphere-stage {
                bottom: 16px;
                left: 5%;
                transform: scale(0.72);
                transform-origin: bottom left;
            }
        }
    </style>

    <div class="three-d-card" tabindex="0">
        <div class="three-d-title">文字也可以拥有空间</div>
        <p class="three-d-copy">
            移动鼠标观察景深；离屏后它应保持静态且不产生后台 I/O。
        </p>
        <div class="three-d-depth"></div>
    </div>

    <div class="three-d-cube-stage" aria-label="通过 JavaScript 注入文字的旋转 3D 立方体">
        <div class="three-d-cube">
            <div class="three-d-cube-face cube-front"></div>
            <div class="three-d-cube-face cube-back"></div>
            <div class="three-d-cube-face cube-right"></div>
            <div class="three-d-cube-face cube-left"></div>
            <div class="three-d-cube-face cube-top"></div>
            <div class="three-d-cube-face cube-bottom"></div>
        </div>
    </div>

    <div
        class="three-d-sphere-stage"
        aria-label="持续旋转的 Three.js 真实球面文本贴图">
        <canvas class="three-d-sphere-canvas"></canvas>
        <span class="sphere-text-source" data-sphere-text="front">曲面印刷 A</span>
        <span class="sphere-text-source" data-sphere-text="back">真实贴图 B</span>
        <span class="sphere-runtime-status">THREE.JS · UV TEXTURE</span>
    </div>

    <script
        src="https://cdn.jsdelivr.net/npm/three@0.167.1/build/three.min.js"
        data-vdoc-library="three"></script>

    <script>
    (() => {
        const island = document.querySelector(
            '[data-vdoc-island="three-dimensional-text-card"]'
        );
        const card = island?.querySelector('.three-d-card');
        const sphereStage = island?.querySelector('.three-d-sphere-stage');
        const sphereCanvas = island?.querySelector('.three-d-sphere-canvas');

        if (
            !island ||
            !card ||
            !sphereStage ||
            !sphereCanvas ||
            !globalThis.THREE ||
            island.dataset.vdocInitialized === 'true'
        ) {
            return;
        }

        island.dataset.vdocInitialized = 'true';

        const cubeTexts = [
            ['cube-front', '文字'],
            ['cube-back', '空间'],
            ['cube-right', '旋转'],
            ['cube-left', '注入'],
            ['cube-top', 'CSS 3D'],
            ['cube-bottom', 'JS TEXT']
        ];

        cubeTexts.forEach(([faceClass, text]) => {
            const face = island.querySelector(`.${faceClass}`);
            if (face) face.textContent = text;
        });

        const textureCanvas = document.createElement('canvas');
        textureCanvas.width = 1536;
        textureCanvas.height = 768;
        const textureContext = textureCanvas.getContext('2d');

        const paintSphereTexture = () => {
            const width = textureCanvas.width;
            const height = textureCanvas.height;
            const frontText = island
                .querySelector('[data-sphere-text="front"]')
                ?.textContent?.trim() || '曲面印刷 A';
            const backText = island
                .querySelector('[data-sphere-text="back"]')
                ?.textContent?.trim() || '真实贴图 B';

            const ocean = textureContext.createLinearGradient(0, 0, width, height);
            ocean.addColorStop(0, '#123f5b');
            ocean.addColorStop(0.38, '#217f79');
            ocean.addColorStop(0.7, '#4caf91');
            ocean.addColorStop(1, '#173d5e');
            textureContext.fillStyle = ocean;
            textureContext.fillRect(0, 0, width, height);

            textureContext.strokeStyle = 'rgba(218,255,242,.22)';
            textureContext.lineWidth = 3;
            for (let x = 0; x <= width; x += width / 24) {
                textureContext.beginPath();
                textureContext.moveTo(x, 0);
                textureContext.lineTo(x, height);
                textureContext.stroke();
            }
            for (let y = 0; y <= height; y += height / 12) {
                textureContext.beginPath();
                textureContext.moveTo(0, y);
                textureContext.lineTo(width, y);
                textureContext.stroke();
            }

            const paintLabel = (text, x, y, color) => {
                textureContext.save();
                textureContext.textAlign = 'center';
                textureContext.textBaseline = 'middle';
                textureContext.font =
                    '800 100px "Noto Serif SC", "Microsoft YaHei", sans-serif';
                textureContext.lineJoin = 'round';
                textureContext.lineWidth = 18;
                textureContext.strokeStyle = 'rgba(5,27,39,.72)';
                textureContext.strokeText(text, x, y);
                textureContext.fillStyle = color;
                textureContext.fillText(text, x, y);
                textureContext.strokeStyle = 'rgba(232,255,244,.7)';
                textureContext.lineWidth = 5;
                textureContext.beginPath();
                textureContext.moveTo(x - 245, y + 72);
                textureContext.lineTo(x + 245, y + 72);
                textureContext.stroke();
                textureContext.restore();
            };

            paintLabel(frontText, width * 0.25, height * 0.5, '#f4ffe9');
            paintLabel(backText, width * 0.75, height * 0.5, '#ffe7b0');
        };

        paintSphereTexture();

        const renderer = new THREE.WebGLRenderer({
            canvas: sphereCanvas,
            alpha: true,
            antialias: true
        });
        renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
        renderer.setSize(174, 174, false);
        renderer.outputColorSpace = THREE.SRGBColorSpace;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
        camera.position.set(0, 0, 5.2);

        const texture = new THREE.CanvasTexture(textureCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(
            8,
            renderer.capabilities.getMaxAnisotropy()
        );

        const geometry = new THREE.SphereGeometry(1.55, 96, 64);
        const material = new THREE.MeshStandardMaterial({
            map: texture,
            roughness: 0.58,
            metalness: 0.06
        });
        const sphere = new THREE.Mesh(geometry, material);
        sphere.rotation.x = -0.16;
        scene.add(sphere);

        scene.add(new THREE.HemisphereLight(0xe9fff8, 0x10283c, 2.15));
        const keyLight = new THREE.DirectionalLight(0xfff4d3, 3.1);
        keyLight.position.set(-3, 4, 5);
        scene.add(keyLight);
        const rimLight = new THREE.DirectionalLight(0x79dfff, 2.2);
        rimLight.position.set(4, -1, -3);
        scene.add(rimLight);

        let previousTime = performance.now();
        let animationFrame = 0;

        const renderSphere = (time) => {
            const delta = Math.min(50, time - previousTime);
            previousTime = time;
            sphere.rotation.y += delta * 0.00042;
            renderer.render(scene, camera);
            animationFrame = requestAnimationFrame(renderSphere);
        };

        animationFrame = requestAnimationFrame(renderSphere);
        island.vdocSphereRuntime = {
            renderer,
            scene,
            sphere,
            texture,
            repaint() {
                paintSphereTexture();
                texture.needsUpdate = true;
            },
            dispose() {
                cancelAnimationFrame(animationFrame);
                geometry.dispose();
                material.dispose();
                texture.dispose();
                renderer.dispose();
            }
        };

        const move = (event) => {
            const rect = island.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width - 0.5;
            const y = (event.clientY - rect.top) / rect.height - 0.5;
            card.style.transform =
                `rotateX(${-y * 22}deg) rotateY(${x * 28}deg)`;
        };

        const reset = () => {
            card.style.transform = 'rotateX(10deg) rotateY(-14deg)';
        };

        island.addEventListener('pointermove', move);
        island.addEventListener('pointerleave', reset);
    })();
    </script>
</div>

3D 岛也已闭合。后续标题和正文不属于 3D 岛。
立方体文本仍属于独立 DOM 节点。球体使用 Three.js 的真实 `SphereGeometry` 和 Canvas UV 纹理：两个源文本节点保留在 DOM 中供编辑器映射，渲染文本通过纹理贴合曲面并接受透视、遮挡和光照。文档组件不实现任何点击暂停或恢复逻辑；选择文本、进入编辑及离开视口时，动画的冻结与原状态恢复必须完全由引擎接管。源文本变动后，引擎可调用岛运行时的 `repaint()` 更新贴图且不重建球体状态。

## 6. 动态高级表格

在一切开始前我随便输入一个`<div>`和`<style>`只会无事发生。表格正式开始。

<div
    data-vdoc-island="interactive-paginated-table"
    id="interactive-paginated-table">
    <style>
        [data-vdoc-island="interactive-paginated-table"] {
            margin: 2rem 0;
            padding: 1.25rem;
            border: 1px solid #d8d0c2;
            border-radius: 20px;
            background: #fffdf8;
            box-shadow: 0 18px 55px rgba(61, 50, 41, 0.12);
        }

        [data-vdoc-island="interactive-paginated-table"] .table-header {
            display: flex;
            gap: 1rem;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 1rem;
        }

        [data-vdoc-island="interactive-paginated-table"] .table-title {
            font: 800 1.25rem "Noto Serif SC", serif;
        }

        [data-vdoc-island="interactive-paginated-table"] .table-description {
            margin-top: 0.2rem;
            color: #756a61;
            font: 13px system-ui;
        }

        [data-vdoc-island="interactive-paginated-table"] .table-status {
            padding: 0.4rem 0.7rem;
            border-radius: 999px;
            color: #27594e;
            background: #e7f3ee;
            font: 700 12px system-ui;
        }

        [data-vdoc-island="interactive-paginated-table"] .table-scroll {
            overflow: auto;
        }

        [data-vdoc-island="interactive-paginated-table"] table {
            width: 100%;
            border-collapse: collapse;
            font-family: system-ui, sans-serif;
        }

        [data-vdoc-island="interactive-paginated-table"] thead {
            color: #fff;
            background: #315f54;
        }

        [data-vdoc-island="interactive-paginated-table"] th,
        [data-vdoc-island="interactive-paginated-table"] td {
            padding: 0.75rem;
            text-align: left;
        }

        [data-vdoc-island="interactive-paginated-table"] td {
            border-bottom: 1px solid #e8dfd2;
        }

        [data-vdoc-island="interactive-paginated-table"] .table-pagination {
            display: flex;
            gap: 0.75rem;
            align-items: center;
            justify-content: center;
            margin-top: 1rem;
        }

        [data-vdoc-island="interactive-paginated-table"] button {
            padding: 0.6rem 0.9rem;
            border: 0;
            border-radius: 10px;
            color: #fff;
            background: #315f54;
            cursor: pointer;
        }

        [data-vdoc-island="interactive-paginated-table"] button:disabled {
            cursor: not-allowed;
            opacity: 0.42;
        }

        [data-vdoc-island="interactive-paginated-table"] .table-page {
            min-width: 90px;
            text-align: center;
            font: 700 13px system-ui;
        }
    </style>

    <div class="table-header">
        <div>
            <strong class="table-title">猫咪观测数据</strong>
            <div class="table-description">
                按钮、分页、状态和动态 DOM 的综合测试
            </div>
        </div>
        <span class="table-status" aria-live="polite"></span>
    </div>

    <div class="table-scroll">
        <table>
            <thead>
                <tr>
                    <th>编号</th>
                    <th>名字</th>
                    <th>毛色</th>
                    <th>状态</th>
                    <th>评分</th>
                </tr>
            </thead>
            <tbody class="table-body"></tbody>
        </table>
    </div>

    <div class="table-pagination">
        <button type="button" data-table-action="previous">← 上一页</button>
        <span class="table-page"></span>
        <button type="button" data-table-action="next">下一页 →</button>
    </div>

    <script>
    (() => {
        const island = document.querySelector(
            '[data-vdoc-island="interactive-paginated-table"]'
        );

        if (!island || island.dataset.vdocInitialized === 'true') return;
        island.dataset.vdocInitialized = 'true';

        const rows = [
            ['C-001', '琥珀', '橘白', '正在观察窗外', 98],
            ['C-002', '墨墨', '纯黑', '藏在纸箱中', 94],
            ['C-003', '雪球', '纯白', '正在晒太阳', 97],
            ['C-004', '花卷', '狸花', '巡视书架', 96],
            ['C-005', '芝麻', '奶牛色', '等待零食', 93],
            ['C-006', '银杏', '银渐层', '轻拍键盘', 95],
            ['C-007', '栗子', '金渐层', '趴在文档旁', 99],
            ['C-008', '云朵', '布偶色', '认真打哈欠', 92],
            ['C-009', '团子', '三花', '追逐光点', 97],
            ['C-010', '可可', '巧克力色', '守护显示器', 96]
        ];

        const pageSize = 4;
        let page = 0;

        const body = island.querySelector('.table-body');
        const status = island.querySelector('.table-status');
        const pageLabel = island.querySelector('.table-page');
        const previous = island.querySelector('[data-table-action="previous"]');
        const next = island.querySelector('[data-table-action="next"]');

        const render = () => {
            const pageCount = Math.ceil(rows.length / pageSize);
            page = Math.max(0, Math.min(pageCount - 1, page));

            const visible = rows.slice(
                page * pageSize,
                (page + 1) * pageSize
            );

            body.replaceChildren(...visible.map((row, rowIndex) => {
                const tr = document.createElement('tr');
                tr.style.background = rowIndex % 2 ? '#f7f1e7' : '#fffdf8';

                row.forEach((value) => {
                    const td = document.createElement('td');
                    td.textContent = String(value);
                    tr.appendChild(td);
                });

                return tr;
            }));

            pageLabel.textContent = `${page + 1} / ${pageCount}`;
            status.textContent = `第 ${page + 1} 页 · 共 ${rows.length} 条`;
            previous.disabled = page === 0;
            next.disabled = page === pageCount - 1;
        };

        island.addEventListener('click', (event) => {
            const action = event.target
                .closest('[data-table-action]')
                ?.dataset.tableAction;

            if (action === 'previous') page -= 1;
            if (action === 'next') page += 1;
            if (action) render();
        });

        render();
    })();
    </script>
</div>

动态表格岛在上一个根闭合标签处结束。表格的按钮、脚本和动态行不得吞入下面的 Markdown 段落。

## 7. Markdown 正文与 HTML 文字特效混排

这是一段普通 Markdown 正文，前半部分应当保持朴素、稳定并且易于编辑；<span class="vdoc-inline-magic">这一小段文字由 HTML 加入流动背景、粗体和局部颜色特效</span>；随后文本重新回到 Markdown 的自然书写方式。编辑器应只修改被操作的最小源码区间，而不是把整个段落转换成冗长 HTML。

### 继续测试普通正文

当复杂组件离开视口时，它们的动画、计时器、媒体和主动测量应被冻结，但已经完成渲染的静态结构仍然可以供全文搜索和 AI 语义阅读使用。

AI 阅读这份文档时，应当能够理解：

1. 猫咪图片的地址、替代文字和说明。
2. 公式的原始 LaTeX 语义。
3. Mermaid 图表达的处理流程。
4. Anime.js 岛是一个绕核心运动的花瓣动画。
5. 3D 文本块表达“文字也可以拥有空间”。
6. 动态表格拥有十条数据和分页交互。
7. 局部文字特效不改变周围 Markdown 的可读性。

> 终极测试的目标不是让所有语法进入同一解析器，而是验证每个语法域都拥有确定边界、完整闭合、局部生命周期和可读降级。

## 8. 最后一段 Markdown

文档的最后一段仍然是普通 Markdown。它用于验证经过多个完整闭合的 HTML 岛、局部样式和岛内脚本之后，Markdown 解析器仍能恢复到正确的正文状态。

如果这句话可以被直接选中、修改、保存、撤销、重新渲染和导出，且前面的动画岛不被无关地重新启动，那么新的源码范式就通过了最关键的一项测试。

<div class="vdoc-test-signature">
    作者：VCP Scriptorium 架构测试组<br>
    <span style="font-family:'Noto Serif SC',serif;font-size:.8em;opacity:.76;">
        Human × AI · Markdown-first Programmable Document
    </span>
</div>