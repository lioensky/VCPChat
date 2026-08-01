/*
 * VCP Loom · Bing 轻量移动首页
 *
 * 仅替换 www.bing.com 的根路径首页。搜索提交后直接进入 Bing 原生
 * /search 结果页；其他 Bing 页面完全不做 DOM 干预。
 */

(() => {
    const isBingHost = /(^|\.)bing\.com$/i.test(location.hostname);
    const isHomePath = location.pathname === '/' || location.pathname === '';

    if (!isBingHost || !isHomePath) return;

    document.documentElement.dataset.vcpLoomApp = 'example-mobile';
    document.documentElement.dataset.vcpBingHome = 'true';

    document.title = 'Bing 搜索';

    const viewport = document.querySelector('meta[name="viewport"]')
        || document.head.appendChild(document.createElement('meta'));
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1, viewport-fit=cover';

    const app = document.createElement('main');
    app.className = 'vcp-bing-home';

    const backdrop = document.createElement('div');
    backdrop.className = 'vcp-bing-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');

    const glowPrimary = document.createElement('div');
    glowPrimary.className = 'vcp-bing-glow vcp-bing-glow-primary';

    const glowSecondary = document.createElement('div');
    glowSecondary.className = 'vcp-bing-glow vcp-bing-glow-secondary';

    backdrop.append(glowPrimary, glowSecondary);

    const header = document.createElement('header');
    header.className = 'vcp-bing-header';

    const brand = document.createElement('a');
    brand.className = 'vcp-bing-brand';
    brand.href = 'https://www.bing.com/';
    brand.setAttribute('aria-label', 'Bing 首页');

    const mark = document.createElement('span');
    mark.className = 'vcp-bing-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = '<i></i><i></i><i></i>';

    const brandText = document.createElement('span');
    brandText.className = 'vcp-bing-brand-text';
    brandText.textContent = 'Bing';

    brand.append(mark, brandText);

    const account = document.createElement('a');
    account.className = 'vcp-bing-account';
    account.href = 'https://www.bing.com/fd/auth/signin?action=interactive';
    account.textContent = '登录';

    header.append(brand, account);

    const hero = document.createElement('section');
    hero.className = 'vcp-bing-hero';

    const eyebrow = document.createElement('p');
    eyebrow.className = 'vcp-bing-eyebrow';
    eyebrow.textContent = '探索，从一个问题开始';

    const title = document.createElement('h1');
    title.className = 'vcp-bing-title';
    title.textContent = '今天想搜索什么？';

    const subtitle = document.createElement('p');
    subtitle.className = 'vcp-bing-subtitle';
    subtitle.textContent = '搜索网页、图片、新闻与更多内容';

    const form = document.createElement('form');
    form.className = 'vcp-bing-search';
    form.action = 'https://www.bing.com/search';
    form.method = 'get';
    form.setAttribute('role', 'search');

    const searchIcon = document.createElement('span');
    searchIcon.className = 'vcp-bing-search-icon';
    searchIcon.setAttribute('aria-hidden', 'true');

    const input = document.createElement('input');
    input.className = 'vcp-bing-input';
    input.type = 'search';
    input.name = 'q';
    input.placeholder = '输入搜索内容';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', '搜索内容');

    const submit = document.createElement('button');
    submit.className = 'vcp-bing-submit';
    submit.type = 'submit';
    submit.setAttribute('aria-label', '搜索');
    submit.innerHTML = '<span></span>';

    form.append(searchIcon, input, submit);

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const query = input.value.trim();
        if (!query) {
            input.focus();
            form.classList.remove('vcp-bing-search-shake');
            void form.offsetWidth;
            form.classList.add('vcp-bing-search-shake');
            return;
        }

        const target = new URL('https://www.bing.com/search');
        target.searchParams.set('q', query);
        location.assign(target.toString());
    });

    const quickLinks = document.createElement('nav');
    quickLinks.className = 'vcp-bing-quick-links';
    quickLinks.setAttribute('aria-label', 'Bing 快捷入口');

    const links = [
        ['图片', 'https://www.bing.com/images'],
        ['新闻', 'https://www.bing.com/news'],
        ['视频', 'https://www.bing.com/videos'],
        ['地图', 'https://www.bing.com/maps'],
    ];

    for (const [label, href] of links) {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = label;
        quickLinks.appendChild(link);
    }

    const suggestions = document.createElement('section');
    suggestions.className = 'vcp-bing-suggestions';

    const suggestionsTitle = document.createElement('h2');
    suggestionsTitle.textContent = '试试搜索';

    const suggestionList = document.createElement('div');
    suggestionList.className = 'vcp-bing-suggestion-list';

    const suggestionItems = [
        '今日热点',
        '天气预报',
        '科技新发现',
        '附近美食',
    ];

    for (const query of suggestionItems) {
        const link = document.createElement('a');
        const target = new URL('https://www.bing.com/search');
        target.searchParams.set('q', query);
        link.href = target.toString();

        const text = document.createElement('span');
        text.textContent = query;

        const arrow = document.createElement('i');
        arrow.setAttribute('aria-hidden', 'true');

        link.append(text, arrow);
        suggestionList.appendChild(link);
    }

    suggestions.append(suggestionsTitle, suggestionList);
    hero.append(eyebrow, title, subtitle, form, quickLinks, suggestions);

    const footer = document.createElement('footer');
    footer.className = 'vcp-bing-footer';

    const copyright = document.createElement('span');
    copyright.textContent = `© ${new Date().getFullYear()} Microsoft`;

    const privacy = document.createElement('a');
    privacy.href = 'https://go.microsoft.com/fwlink/?LinkId=521839';
    privacy.textContent = '隐私';

    footer.append(copyright, privacy);

    app.append(backdrop, header, hero, footer);

    // 删除 Bing 原首页。其延迟脚本即使继续运行，也无法再命中原布局节点。
    document.body.replaceChildren(app);
    document.body.removeAttribute('id');
    document.body.className = 'vcp-bing-home-body';

    requestAnimationFrame(() => input.focus({ preventScroll: true }));
})();