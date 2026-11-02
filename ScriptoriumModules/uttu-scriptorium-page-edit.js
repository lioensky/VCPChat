// 网页的“修改”模式。
// 点元素选中，双击改字，拖动挪位置，栏上改颜色、字号。框里先变，改动再写进源码编辑器（主进程 webPages/edit.js 只算换哪几个字符）：
// 能撤销，存法和手改源码一样，存完不用刷新网页，滚动和选中都留着。脚本生成的元素文件里没有，选中时就说明。
// 拖动写 CSS 的 translate 属性：和元素自己的定位、transform 都不冲突。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    const host = UI?.pageHost;
    if (!host) return;
    const { make, button, icon, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const { layer, stage } = host;
    const REASONS = {
        generated: '这个元素是脚本生成的，文件里没有，不能在这里改。',
        ambiguous: '页面里有几个一样的元素，认不准是哪一个。到源码里改。',
    };
    const reasonOf = (reply) => REASONS[reply?.reason] || reply?.error || '写不进源码。';

    let on = false;
    let selected = null; // 框里问来的元素描述（webPages/pick.js 的 describe）
    let refused = '';
    let press = null;
    let writing = false;
    let dragFrame = 0;
    let scrollFrame = 0;

    const hint = make('span', 'uttu-page-edit-hint', '点元素选中，双击改字，拖动挪位置');
    hint.hidden = true;
    host.tool.after(hint);

    // ---------- 选中后跟在元素旁边的一条 ----------
    const bar = make('div', 'uttu-page-editbar uttu-ctl');
    bar.hidden = true;
    const tagLabel = make('span', 'tag');
    const note = make('span', 'note');
    const tools = make('span', 'tools');
    const hex = (value) => {
        const part = String(value).match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/);
        return part ? `#${part.slice(1, 4).map((item) => Number(item).toString(16).padStart(2, '0')).join('')}` : '#000000';
    };
    const clear = (value) => /^rgba\(.*[, /]\s*0\)$/.test(String(value).replace(/\s+/g, ' ')) || value === 'transparent';
    function swatch(label, prop) {
        const wrap = make('label', 'uttu-page-swatch');
        const input = make('input');
        input.type = 'color';
        input.setAttribute('aria-label', label);
        wrap.append(make('span', '', label), input);
        input.addEventListener('input', () => void host.askFrame('style', { path: selected?.path, props: { [prop]: input.value } }));
        input.addEventListener('change', () => void setStyle({ [prop]: input.value }));
        return input;
    }
    const textColor = swatch('文字', 'color');
    const backColor = swatch('底色', 'background-color');
    const sizeValue = make('span', 'size');
    const stepSize = (delta) => void setStyle({ 'font-size': `${Math.max(1, Math.round(parseFloat(selected?.look.size) || 16) + delta)}px` });
    const home = button('uttu-tb-drop plain', '', '回到原位', () => void setStyle({ translate: '' }));
    const writeButton = button('uttu-tb-drop plain', '', '改字', () => void startWriting());
    tools.append(writeButton, textColor.parentElement, backColor.parentElement,
        button('uttu-tb', '字号小一点', icon('i-minus'), () => stepSize(-1)), sizeValue, button('uttu-tb', '字号大一点', icon('i-plus'), () => stepSize(1)), home);
    bar.append(tagLabel, button('uttu-tb-drop plain', '', '上一层', () => void selectParent()), note, tools);
    bar.addEventListener('pointerdown', (event) => event.stopPropagation());
    stage.append(bar);

    function placeBar() {
        const k = host.scale();
        const { rect } = selected;
        const width = bar.offsetWidth;
        const height = bar.offsetHeight;
        let top = rect.y * k - height - 6;
        if (top < 4) top = rect.y * k + rect.height * k + 6;
        if (top + height > stage.clientHeight - 4) top = 4; // 元素比窗口还大：贴在上边
        bar.style.left = `${Math.round(Math.max(4, Math.min(rect.x * k, stage.clientWidth - width - 4)))}px`;
        bar.style.top = `${Math.round(top)}px`;
    }
    function paint() {
        layer.querySelectorAll('.sel').forEach((node) => node.remove());
        bar.hidden = !selected || writing;
        hint.hidden = !on || Boolean(selected);
        if (!selected) return;
        layer.append(host.markBox(selected.rect, 'sel'));
        if (writing) return;
        setText(tagLabel, selected.tag);
        setText(note, refused);
        note.hidden = !refused;
        tools.hidden = Boolean(refused);
        writeButton.hidden = !selected.canText;
        textColor.value = hex(selected.look.color);
        backColor.value = clear(selected.look.background) ? '#ffffff' : hex(selected.look.background);
        setText(sizeValue, String(Math.round(parseFloat(selected.look.size) || 0)));
        home.hidden = !selected.look.translate || selected.look.translate === 'none';
        placeBar();
    }
    async function select(item) {
        selected = item;
        refused = '';
        paint();
        if (!item) return;
        const reply = await api().page('element-patch', { text: host.editor().getValue(), picked: item }).catch(() => null);
        if (selected !== item) return;
        refused = reply?.success ? '' : reasonOf(reply);
        paint();
    }
    async function refresh() {
        if (!selected) return;
        const reply = await host.askFrame('describe', { path: selected.path });
        if (reply?.answer) selected = reply.answer;
        paint();
    }
    async function selectParent() {
        const reply = await host.askFrame('parent', { path: selected?.path });
        if (reply?.answer) await select(reply.answer);
    }
    const askAt = async (at) => (await host.askFrame('at', at))?.answer || null;

    // ---------- 写回源码 ----------
    async function commit(item, change) {
        const cm = host.editor();
        if (!cm || !host.page()) return false;
        const reply = await api().page('element-patch', { text: cm.getValue(), picked: item, change }).catch((error) => ({ success: false, error: error.message }));
        if (!reply?.success) {
            UI.toast(reasonOf(reply), 'error', 5000);
            host.reload();
            return false;
        }
        if (reply.from === reply.to && !reply.insert) return true;
        const from = cm.posFromIndex(reply.from);
        cm.replaceRange(reply.insert, from, cm.posFromIndex(reply.to), 'uttu-element'); // 不带 +：一次改动一步撤销，不和前后的合并
        cm.scrollIntoView(from, 60); // 开着双栏时源码跟到这里
        host.markLive();
        return true;
    }
    async function setStyle(props) {
        const item = selected;
        if (!item || refused) return;
        await host.askFrame('style', { path: item.path, props });
        if (await commit(item, { kind: 'style', props })) await refresh();
    }

    // ---------- 改字：框里改，改好回一条消息 ----------
    async function startWriting() {
        if (!selected?.canText || refused) return;
        writing = true;
        layer.classList.remove('on');
        paint();
        host.frame()?.focus();
        const reply = await host.askFrame('write', { path: selected.path });
        if (!reply?.answer) textDone({ html: null });
    }
    async function textDone({ html }) {
        if (!writing) return;
        writing = false;
        layer.classList.toggle('on', on);
        if (on) layer.focus({ preventScroll: true });
        if (typeof html === 'string') await commit(selected, { kind: 'text', html });
        if (on) await refresh();
        else await select(null);
    }

    // ---------- 点、拖、双击 ----------
    const inside = (item, at) => item && at.x >= item.rect.x && at.x <= item.rect.x + item.rect.width && at.y >= item.rect.y && at.y <= item.rect.y + item.rect.height;
    const offsetOf = (item) => {
        const part = String(item.look.translate).match(/^(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?/);
        return part ? { x: Number(part[1]), y: Number(part[2] || 0) } : { x: 0, y: 0 };
    };
    const translateOf = (offset) => (offset.x || offset.y ? `${offset.x}px ${offset.y}px` : '');
    layer.addEventListener('pointerdown', (event) => {
        if (!on || writing || event.button !== 0) return;
        event.preventDefault();
        layer.focus({ preventScroll: true });
        layer.setPointerCapture(event.pointerId);
        host.clearHover();
        const at = host.point(event);
        const current = { start: at, last: at, moved: false, offset: null, item: inside(selected, at) ? selected : null, ask: null };
        if (!current.item) current.ask = askAt(at).then((item) => { current.item = item; return item; });
        press = current;
    });
    layer.addEventListener('pointermove', (event) => {
        if (!press || !on) return;
        press.last = host.point(event);
        if (!press.moved) {
            if (Math.hypot(press.last.x - press.start.x, press.last.y - press.start.y) < 4 / host.scale()) return;
            press.moved = true;
            layer.classList.add('moving');
            bar.hidden = true;
        }
        cancelAnimationFrame(dragFrame);
        dragFrame = requestAnimationFrame(() => {
            const current = press;
            if (!current?.item) return;
            if (selected !== current.item) void select(current.item);
            if (refused) return;
            const base = offsetOf(current.item);
            current.offset = { x: Math.round(base.x + current.last.x - current.start.x), y: Math.round(base.y + current.last.y - current.start.y) };
            void host.askFrame('style', { path: current.item.path, props: { translate: translateOf(current.offset) } }).then((reply) => {
                if (reply?.answer && press === current) {
                    selected = reply.answer;
                    current.item = { ...current.item, rect: reply.answer.rect };
                    selected = current.item;
                    paint();
                    bar.hidden = true;
                }
            });
        });
    });
    async function release() {
        const current = press;
        press = null;
        cancelAnimationFrame(dragFrame);
        layer.classList.remove('moving');
        if (!current) return;
        if (current.moved) {
            if (current.offset && !refused) {
                const translate = translateOf(current.offset);
                await host.askFrame('style', { path: current.item.path, props: { translate } });
                if (await commit(current.item, { kind: 'style', props: { translate } })) selected = current.item;
                await refresh();
            } else paint();
            return;
        }
        const item = current.item || await current.ask;
        if (item !== selected) await select(item);
    }
    layer.addEventListener('pointerup', () => void release());
    layer.addEventListener('pointercancel', () => void release());
    layer.addEventListener('dblclick', async (event) => {
        if (!on || writing) return;
        const item = await askAt(host.point(event));
        if (!item) return;
        if (selected?.path.join() !== item.path.join()) await select(item);
        await startWriting();
    });

    document.addEventListener('keydown', (event) => {
        if (!on || writing || !selected || event.key !== 'Escape' || event.target?.closest?.('.CodeMirror, input, textarea')) return;
        event.preventDefault();
        void select(null);
    }, true);

    layer.tabIndex = -1;
    host.edit = {
        setOn(value) {
            on = value;
            layer.classList.toggle('editing', on);
            if (!on && !writing) void select(null);
            paint();
        },
        frameChanged() {
            writing = false;
            selected = null;
            refused = '';
            paint();
            layer.classList.toggle('on', on || layer.classList.contains('on'));
        },
        scrolled() {
            if (!selected || scrollFrame) return;
            scrollFrame = requestAnimationFrame(() => {
                scrollFrame = 0;
                void refresh();
            });
        },
        textDone,
        // Ctrl Z 撤的是源码编辑器里的改动（uttu-scriptorium-page.js 转来），撤完马上存，框才看得到。
        undo(redo) {
            if (!on || writing) return;
            if (redo) host.editor()?.redo();
            else host.editor()?.undo();
            host.saveNow();
        },
    };
})();
