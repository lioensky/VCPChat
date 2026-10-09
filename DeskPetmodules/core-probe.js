// 加载暂存的 Cubism Core，把 csmGetVersion() 写进标题：core-version:<数字>，加载不了是 0。
(function probe() {
    const report = (version) => { document.title = `core-version:${version}`; };
    const script = document.createElement('script');
    // 每次试加载的都是新文件，地址带上页面给的随机数，不拿缓存里的上一份
    script.src = `vcp-deskpet://pet/core/staged.js?n=${encodeURIComponent(new URLSearchParams(location.search).get('n') || Date.now())}`;
    script.onload = () => {
        let version = 0;
        try { version = Number(window.Live2DCubismCore?.Version?.csmGetVersion?.()) || 0; } catch { version = 0; }
        report(version);
    };
    script.onerror = () => report(0);
    document.head.appendChild(script);
}());
