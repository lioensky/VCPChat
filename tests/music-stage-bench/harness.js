(() => {
  const q = new URLSearchParams(location.search);
  const fixtures = {
    lrc: () => {
      const rows = [
        [12.0,'夜色漫过了旧城的屋檐','Night spills over the eaves of the old town'],
        [16.5,'风把名字吹散在路边','The wind scatters a name along the road'],
        [21.2,'我数着灯火一盏一盏','I count the lanterns one by one'],
        [25.8,'等不到你回头的那天','Waiting for a day you never turn around'],
        [31.0,'如果星星会说话','If the stars could speak'],
        [34.6,'它会不会替我回答','Would they answer in my place'],
        [39.0,'穿过人海穿过岁月漫长的隧道去往有你在的远方我依然相信光','Through crowds and years and the long tunnel toward the faraway place where you are I still believe in light'],
        [46.0,'啦啦啦',''],
        [50.0,'夜色漫过了旧城的屋檐','Night spills over the eaves of the old town'],
        [54.5,'风把名字吹散在路边','The wind scatters a name along the road'],
        [90.0,'间奏之后的第一句','First line after the interlude'],
        [95.0,'最后一句歌词','The very last line']
      ];
      return rows.map(([time, original, translation]) => ({ time, original, translation }));
    },
    words: () => {
      const mk = (start, text, per=0.32, tr='') => {
        const chars = Array.from(text);
        const words = chars.map((c,i)=>({ text:c, startTime:start+i*per, endTime:start+(i+1)*per }));
        return { startTime:start, time:start, endTime:start+chars.length*per+0.2, fullText:text, original:text, translation:tr, romanization:'', words, isWordByWord:true };
      };
      return [ mk(5,'夜色漫过了旧城的屋檐',0.32,'Night spills over the eaves'), mk(10,'风把名字吹散在路边',0.3,'The wind scatters a name'),
        mk(15,'I will follow the light',0.12,'我会追随那束光'), mk(20,'如果星星会说话',0.35), mk(40,'长间奏之后',0.4,'After a long break'), mk(46,'最后一句歌词',0.4,'the last line') ];
    },
    song: () => { // 3.5-min LRC: verse(8) chorus(4) verse(8) chorus(4) 20s interlude, bridge(4) chorus(4)
      const verseA = ['清晨的站台还没有人','列车带走昨夜的梦','我把车票折成纸船','放进口袋慢慢地等','窗外的风景向后退','像谁没说完的那句话','铁轨尽头有一片海','海上漂着旧日的霞'];
      const verseB = ['路过的小镇灯还亮','有人在月台挥着手','我假装自己没看见','把名字写在玻璃上','雾气散了字也散了','只剩远山一点点蓝','原来告别不必开口','只要列车一直向前'];
      const chorus = ['带我去水天相接的地方','让星光替我照亮远方','就算终点没有人等待','我也要把这首歌唱完'];
      const bridge = ['如果有一天你也路过','请替我看看那片海','看浪花怎样开了又落','像我们来不及的未来'];
      const out = []; let t = 14;
      const add = (rows, gap) => rows.forEach(text => { out.push({ time: +t.toFixed(2), original: text, translation: 'Translation for: ' + text.length + ' chars line of the song' }); t += gap; });
      add(verseA, 4.2); add(chorus, 4.6); t += 4; add(verseB, 4.2); add(chorus, 4.6); t += 20; add(bridge, 4.4); add(chorus, 4.6);
      return out; },
    none: () => []
  };
  const lyricsKind = q.get('lyrics') || 'lrc';
  const duration = Number(q.get('duration') || 200);
  const bins = 128; const spectrum = new Array(bins).fill(0);
  const clock = { mode: q.get('clock') || 'ideal', pollMs: 250, jitterMs: Number(q.get('jitter')||0), engineT0: performance.now(), engineBase: Number(q.get('t')||0), playing: true };
  const engineTime = () => clock.playing ? clock.engineBase + (performance.now()-clock.engineT0)/1000 : clock.engineBase;
  const app = {
    volumeSlider: { value: '0.8' }, playModes: ['repeat','repeat-one','shuffle'], currentPlayMode: 0,
    api: { getThemes: async () => [], seekMusic: async (t) => { __h.seek(t); }, setMusicVolume(){} },
    formatTime: s => { s = Math.max(0, Math.floor(s||0)); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; },
    stripAudioExtension: t => String(t||'').replace(/\.(mp3|flac|wav|m4a|ogg)$/i,''),
    currentTheme: 'dark',
    playlist: [{ path: 'C:/music/demo-a.flac', title: '测试曲目 A.flac', artist: '测试歌手', album: '专辑', duration }, { path: 'C:/music/demo-b.flac', title: 'Second Track.flac', artist: 'Artist B', album: '', duration: 150 }],
    currentTrackIndex: 0, currentLyrics: fixtures[lyricsKind](), currentLyricIndex: -1,
    isPlaying: true, lastKnownCurrentTime: clock.engineBase, lastStateUpdateTime: Date.now(), lastKnownDuration: duration,
    currentVisualizerData: spectrum, isStageActive: false,
    pauseTrack(){ __h.pause(); }, playTrack(){ __h.play(); }, prevTrack(){ __h.track(0); }, nextTrack(){ __h.track(1); },
    destroyAmbientPixi(){}, createAmbientPixi(){}, scrollCurrentTrackToSidebarTop(){}
  };
  const push = (latencyMs=0) => { // emulate updateUIWithState: value sampled latencyMs ago
    const t = engineTime() - (clock.playing ? latencyMs/1000 : 0);
    app.lastKnownCurrentTime = Math.max(0,t); app.lastStateUpdateTime = Date.now(); app.isPlaying = clock.playing;
  };
  const __h = window.__h = {
    app, clock, fixtures, errors: [], frameTimes: [], engineTime,
    seek(t){ clock.engineBase = t; clock.engineT0 = performance.now(); push(0); },
    pause(){ clock.engineBase = engineTime(); clock.playing = false; push(0); },
    play(){ clock.engineT0 = performance.now(); clock.playing = true; push(0); },
    track(i){ app.currentTrackIndex = i; app.lastKnownDuration = app.playlist[i].duration; app.currentLyrics = []; __h.seek(0); setTimeout(()=>{ app.currentLyrics = fixtures[i===0?lyricsKind:'words'](); }, 300); },
    setLyrics(kind){ app.currentLyrics = fixtures[kind](); },
    snap(){ return app.stageHost.getDebugSnapshot(); },
    // faithful emulation of music-player.js: pause/play flip isPlaying and stop/start the 250ms poll, no state push
    realPoll: null, timeLog: [],
    startReal(latMin=4, latMax=4){ clock.mode='real'; clock.lat=[latMin,latMax]; __h.realPoll = setInterval(()=>{ const L = latMin + Math.random()*(latMax-latMin); const t = engineTime() - (clock.playing? L/1000 : 0); setTimeout(()=>{ app.lastKnownCurrentTime = Math.max(0,t); app.lastStateUpdateTime = Date.now(); }, L); }, 250); },
    pauseReal(){ clock.engineBase = engineTime(); clock.playing = false; app.isPlaying = false; clearInterval(__h.realPoll); __h.realPoll = null; },
    playReal(){ clock.engineT0 = performance.now(); clock.playing = true; app.isPlaying = true; __h.startReal(...clock.lat); }
  };
  window.addEventListener('error', e => __h.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => __h.errors.push('rej:'+String(e.reason?.stack||e.reason)));
  document.body.classList.add('dark-theme');
  setupMusicStage(app);
  if (clock.mode === 'poll') setInterval(() => push(Math.random()*clock.jitterMs), clock.pollMs);
  let last = 0;
  const loop = ts => {
    const t = engineTime();
    if (clock.mode === 'ideal') { /* single authoritative base, like one state push */ }
    // synthetic spectrum: kick every 0.5s + vocal band wobble
    const beat = Math.exp(-((t*2)%1)*6);
    for (let i=0;i<bins;i++){ const r=i/bins; spectrum[i] = clock.playing ? Math.min(1, (r<0.1?beat*0.9:0) + 0.25*Math.abs(Math.sin(t*3+i*0.3))*(1-r) + 0.1) : 0; }
    const a = performance.now();
    if (__h.logTime) __h.timeLog.push([+(performance.now()).toFixed(1), +MusicStageRuntime.resolvePlaybackTime(app, Date.now()).toFixed(3), +engineTime().toFixed(3)]);
    try { app.stageHost.updateFrame(ts); } catch (e) { __h.errors.push('frame:'+ (e.stack||e)); }
    const cost = performance.now()-a;
    if (last) __h.frameTimes.push([+(ts-last).toFixed(1), +cost.toFixed(1)]);
    if (__h.frameTimes.length>4000) __h.frameTimes.shift();
    last = ts; requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();
