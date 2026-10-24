// 按这个助手有什么形象依次挑后端：Live2D → 网格立绘 → 精灵动画 → 差分立绘 / 头像，
// 哪一步起不来就说一声原因再往下退。设置页卡片的快照（?preview=1）也在这里拍。
import { CONTEXT_LOSS_LIMIT, recentContextLosses } from 'vcp-deskpet://pet/app/petStage.js';
import { createLive2DBackend, live2DFailureText } from 'vcp-deskpet://pet/app/live2dBackend.js';
import { createPuppetBackend } from 'vcp-deskpet://pet/app/puppetBackend.js';
import { createImageBackend } from 'vcp-deskpet://pet/app/imageBackend.js';
import { createSpriteBackend } from 'vcp-deskpet://pet/app/spriteBackend.js';

export function createPetBackendPick(ctx) {
    const { api, $ } = ctx;

    // Live2D、网格立绘后端从页面拿的东西：画在哪、嘴张多大、元音口形、命中报到哪、显卡渲染中断时怎么告诉人
    function pixiEnv() {
        return {
            canvas: $('live2dCanvas'),
            talkLevel: ctx.talkLevel,
            vowels: () => ctx.speech.vowels(),
            onHit: ctx.reportHit,
            activity: () => ({ approval: !$('approvalCard').hidden, walk: ctx.walking || '' }),
            onContextLost: () => ctx.notice('显卡渲染中断，正在重新载入桌宠…', { ms: 4000 }),
        };
    }

    async function pickBackend(assets) {
        if (assets.live2d && assets.coreUrl && recentContextLosses().length >= CONTEXT_LOSS_LIMIT) {
            ctx.notice('显卡渲染反复中断，这次先用立绘代替 Live2D。重新打开桌宠会再试。', { error: true, ms: 10000 });
        } else if (assets.live2d && assets.coreUrl) {
            try {
                ctx.backend = await createLive2DBackend(assets, pixiEnv());
            } catch (error) {
                console.error('[DeskPet] Live2D 加载失败，改用立绘：', error);
                $('live2dCanvas').hidden = true;
                ctx.notice(error.userFacing ? error.message : live2DFailureText(error), { error: true, ms: 8000 });
            }
        } else if (assets.live2d && !assets.coreUrl && !assets.puppet && !assets.outfit?.builtIn) {
            // 内置 Nova 自带立绘：不每次打开都弹红字，设置页卡片和「Live2D 支持」上写着
            ctx.notice('这套是 Live2D 模型，还缺 Cubism Core，先用立绘代替。右键「桌宠设置…」里的「Live2D 支持」可以一键装好。', { error: true, ms: 12000 });
        }
        if (!ctx.backend && assets.puppet && recentContextLosses().length >= CONTEXT_LOSS_LIMIT) {
            ctx.notice('显卡渲染反复中断，这次先用普通立绘。重新打开桌宠会再试。', { error: true, ms: 10000 });
        } else if (!ctx.backend && assets.puppet) {
            try {
                ctx.backend = await createPuppetBackend(assets, pixiEnv());
            } catch (error) {
                console.error('[DeskPet] 网格立绘加载失败，改用立绘：', error);
                $('live2dCanvas').hidden = true;
                ctx.notice(error.userFacing ? error.message : `网格立绘加载失败：${error.message}`, { error: true, ms: 8000 });
            }
        }
        if (!ctx.backend && assets.sprite) {
            try {
                ctx.backend = await createSpriteBackend(assets, pixiEnv());
            } catch (error) {
                console.error('[DeskPet] 精灵动画加载失败：', error);
                $('live2dCanvas').hidden = true;
                ctx.notice(`精灵动画加载失败：${error.message}`, { error: true, ms: 8000 });
            }
        }
        if (!ctx.backend) ctx.backend = createImageBackend(assets, { onHit: ctx.reportHit, frame: ctx.frame });
        document.body.dataset.backend = ctx.backend.kind;
        return ctx.backend;
    }

    // 设置页卡片的快照：摆好默认表情，等形象量完、物理和待机动作稳下来，把角色的包围盒报给主进程截图
    async function renderPreview(assets) {
        document.body.classList.add('is-preview');
        ctx.backend.apply({ state: null, emotion: 'neutral', intensity: 0, source: 'idle' }, { changed: true, motion: false });
        const aspect = await Promise.race([
            Promise.resolve(ctx.backend.figureReady).catch(() => null),
            new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const bounds = ctx.backend.bounds();
        window.__deskPetPreview = { outfit: assets.outfit?.id || null, bounds, aspect };
        api.previewReady?.({ bounds, aspect });
    }

    return { pickBackend, renderPreview };
}
