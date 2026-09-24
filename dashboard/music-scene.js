const { escapeHtml, cssUrl, SCENE_BASE_CSS, sceneStyleVars, normaliseEffects, scenePerfCss } = require("./scenes");

function rateParam(value, fallback, max = 60) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : fallback;
}

// Page-side render rates. No query = the original OBS-browser-source look
// (30 Hz spectrum, full effects). music24.js passes the Music Performance Mode
// through ?spectrumHz=&progressHz=&effects= for the server-side renderer.
function musicScenePerf(query = {}, cfg = {}) {
  const spectrumHz = rateParam(query.spectrumHz ?? cfg.spectrumHz, 30);
  return {
    spectrumHz,
    progressHz:Math.min(spectrumHz, rateParam(query.progressHz ?? cfg.progressHz, 10, 30)),
    effects:normaliseEffects(query.effects ?? cfg.effects),
  };
}

function musicSceneFragment(login, cfg = {}, query = {}, account, profileId = null) {
  const perf = musicScenePerf(query, cfg);
  const eventsUrl = `/overlay/${encodeURIComponent(login)}/events`;
  const accent = query.accent || cfg.accent || "#00f0ff";
  const backgroundUrl = query.background || query.bg || cfg.backgroundUrl || cfg.background || "";
  const station = query.station || cfg.station || `${account?.displayName || account?.twitchLogin || "CastNexus"} Radio`;
  const fallbackTitle = query.title || cfg.title || "CastNexus Radio";
  const coverUrl = query.cover || cfg.coverUrl || account?.profileImageUrl || "";
  const layout = String(query.layout || cfg.layout || "landscape") === "vertical" ? "vertical" : "landscape";
  const audioOnly = String(query.audioOnly || "") === "1";
  const bg = backgroundUrl ? `<div class="rn-music-bg" style="background-image:url(${cssUrl(backgroundUrl)})"></div>` : "";
  const publicBase = `/overlay/${encodeURIComponent(login)}/music${profileId ? `/${encodeURIComponent(profileId)}` : ""}`;

  return `
    <style>
      ${SCENE_BASE_CSS}
      .rn-music-stage{position:relative;display:grid;grid-template-rows:minmax(0,1fr) auto;min-height:100vh;overflow:hidden;background:#04050a;padding:clamp(18px,4vh,70px) clamp(20px,4vw,80px) clamp(16px,3vh,48px)}
      .rn-music-bg{position:absolute;inset:0;z-index:-4;background-size:cover;background-position:center;filter:saturate(.9) contrast(1.04);transform:scale(1.02)}
      .rn-music-bg::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(4,5,10,.82),rgba(4,5,10,.48) 55%,rgba(4,5,10,.68))}
      .rn-music-stage::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:0;background:repeating-linear-gradient(0deg,rgba(0,240,255,.018) 0 1px,transparent 1px 5px);mix-blend-mode:screen}
      .rn-music-main{position:relative;z-index:2;min-height:0;display:grid;grid-template-columns:minmax(0,.82fr) minmax(0,1.18fr);gap:clamp(28px,5vw,92px);align-items:center}
      .rn-art-column{min-width:0;display:grid;place-items:center}.rn-cover-wrap{position:relative;width:min(34vw,48vh,500px);min-width:0;aspect-ratio:1;border-radius:50%}
      .rn-cover-halo{position:absolute;inset:-12%;z-index:-2;border-radius:50%;background:radial-gradient(circle,var(--rn-accent-glow),transparent 64%);filter:blur(18px);opacity:.62}
      .rn-cover{position:absolute;inset:13%;z-index:3;width:74%;height:74%;object-fit:cover;object-position:center;border-radius:50%;border:2px solid var(--rn-accent-line);box-shadow:0 16px 54px rgba(0,0,0,.52),0 0 34px var(--rn-accent-glow),0 0 0 7px rgba(5,8,14,.72),inset 0 1px rgba(255,255,255,.10);background:linear-gradient(135deg,var(--rn-accent),rgba(138,43,255,.18))}
      .rn-cover-placeholder{position:absolute;inset:13%;z-index:2;border-radius:50%;border:2px solid var(--rn-accent-line);display:flex;align-items:center;justify-content:center;font-size:clamp(42px,6vw,96px);color:var(--rn-accent-solid);background:radial-gradient(circle at 42% 36%,var(--rn-accent),rgba(5,6,10,.96) 66%);box-shadow:0 0 0 7px rgba(5,8,14,.72);text-shadow:0 0 24px var(--rn-accent-glow)}
      .rn-vinyl{position:absolute;z-index:1;inset:0;width:100%;aspect-ratio:1;border-radius:50%;opacity:.94;border:1px solid var(--rn-accent-line);box-shadow:0 24px 70px rgba(0,0,0,.66),0 0 42px rgba(0,240,255,.08),inset 0 0 0 1px rgba(255,255,255,.025);background:radial-gradient(circle at 50% 50%,var(--rn-accent-solid) 0 2.2%,#06080d 2.8% 10%,#171c29 10.5% 12%,#070910 12.5% 21%,#151a25 21.5% 30%,#070910 30.5% 32%,#151a25 32.5% 43%,#070910 43.5% 45%,#111621 45.5% 58%,#06080d 58.5% 60%,#11151e 60.5% 100%);animation:rn-vinyl-spin 16s linear infinite}
      .rn-vinyl::after{content:"";position:absolute;inset:5%;border-radius:50%;border:1px solid rgba(255,255,255,.035);box-shadow:inset 0 0 0 1px rgba(0,240,255,.025),inset 0 0 28px rgba(0,0,0,.28)}
      @keyframes rn-vinyl-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
      .rn-music-meta{min-width:0;display:flex;flex-direction:column;justify-content:center;gap:clamp(5px,1vh,13px)}
      .rn-music-badge{width:fit-content;display:inline-flex;align-items:center;gap:8px;padding:clamp(5px,.7vh,8px) clamp(10px,1.2vw,16px);border:1px solid var(--rn-accent-line);border-radius:999px;background:rgba(5,6,10,.58);color:var(--rn-accent-solid);font-size:clamp(8px,.72vw,12px);font-weight:800;letter-spacing:.24em;text-transform:uppercase}
      .rn-music-title{max-width:100%;font-size:clamp(22px,4.2vw,78px);font-weight:850;line-height:1.02;letter-spacing:-.035em;text-shadow:0 0 22px var(--rn-accent-glow);overflow:hidden;text-overflow:clip;white-space:nowrap}
      .rn-music-artist{max-width:100%;font-size:clamp(12px,1.55vw,28px);color:rgba(230,247,255,.72);letter-spacing:.035em;overflow:hidden;text-overflow:clip;white-space:nowrap}
      .rn-progress{width:min(760px,100%);height:clamp(3px,.45vh,6px);background:rgba(255,255,255,.10);border-radius:999px;overflow:hidden;margin-top:clamp(2px,.7vh,8px)}
      .rn-progress>span{display:block;width:100%;height:100%;transform:scaleX(0);transform-origin:0 50%;border-radius:inherit;background:linear-gradient(90deg,var(--rn-accent-solid),#8a2bff,#ff2bd6,var(--rn-accent-solid));background-size:220% 100%;box-shadow:0 0 16px var(--rn-accent-glow);will-change:transform}
      .rn-time{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:clamp(8px,.68vw,12px);letter-spacing:.10em;color:rgba(230,247,255,.42)}
      .rn-spectrum-shell{contain:layout paint;width:100%;min-width:0;height:clamp(64px,18vh,190px);margin-top:clamp(7px,1.3vh,16px);padding:clamp(8px,1.2vh,14px) clamp(10px,1.2vw,18px) clamp(8px,1vh,12px);position:relative;overflow:hidden;border:1px solid rgba(255,255,255,.075);border-radius:clamp(10px,1vw,18px);background:linear-gradient(180deg,rgba(7,11,21,.66),rgba(3,6,13,.42));box-shadow:inset 0 1px rgba(255,255,255,.025),0 14px 38px rgba(0,0,0,.16)}
      .rn-spectrum-shell::before{content:"LIVE SPECTRUM";position:absolute;top:clamp(5px,.7vh,9px);left:clamp(8px,1vw,14px);z-index:2;font-size:clamp(6px,.52vw,9px);font-weight:800;letter-spacing:.22em;color:rgba(230,247,255,.28)}
      .rn-spectrum-shell::after{content:"";position:absolute;left:clamp(10px,1.2vw,18px);right:clamp(10px,1.2vw,18px);bottom:clamp(8px,1vh,12px);height:1px;background:linear-gradient(90deg,transparent,var(--rn-accent-line),transparent)}
      #rn-spectrum{width:100%;height:100%;display:block;will-change:transform;filter:drop-shadow(0 0 9px var(--rn-accent-glow))}
      .rn-music-footer{position:relative;z-index:3;min-width:0;display:flex;align-items:center;justify-content:space-between;gap:18px;padding-top:clamp(8px,1.8vh,22px)}
      .rn-station{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:clamp(7px,.66vw,11px);font-weight:800;letter-spacing:.34em;text-transform:uppercase;color:rgba(230,247,255,.34)}
      .rn-clock{flex:0 0 auto;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:clamp(8px,.7vw,12px);letter-spacing:.16em;color:rgba(230,247,255,.42)}

      .rn-layout-vertical{padding:clamp(42px,4vh,78px) clamp(34px,6vw,72px) clamp(30px,3vh,54px)}
      .rn-layout-vertical .rn-music-bg::after{background:linear-gradient(180deg,rgba(4,5,10,.72),rgba(4,5,10,.46) 48%,rgba(4,5,10,.78))}
      .rn-layout-vertical .rn-music-main{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr);gap:clamp(42px,4vh,76px);align-content:center}
      .rn-layout-vertical .rn-cover-wrap{width:min(76vw,35vh,720px)}
      .rn-layout-vertical .rn-vinyl{inset:0;width:100%}
      .rn-layout-vertical .rn-music-meta{align-items:center;text-align:center;justify-content:flex-start;gap:clamp(12px,1.2vh,22px)}
      .rn-layout-vertical .rn-music-title{font-size:clamp(44px,9vw,108px);white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
      .rn-layout-vertical .rn-music-artist{font-size:clamp(24px,4vw,48px)}
      .rn-layout-vertical .rn-progress{width:min(880px,92%);height:8px}
      .rn-layout-vertical .rn-time{font-size:clamp(15px,2vw,24px)}
      .rn-layout-vertical .rn-spectrum-shell{width:100%;height:clamp(190px,16vh,330px);margin-top:clamp(18px,2vh,34px);padding:22px 20px 16px;border-radius:24px}
      .rn-layout-vertical .rn-spectrum-shell::before{font-size:13px;top:12px;left:18px}
      .rn-layout-vertical .rn-music-footer{padding-top:clamp(18px,2vh,34px)}
      .rn-layout-vertical .rn-station{font-size:clamp(12px,1.7vw,19px);letter-spacing:.28em}.rn-layout-vertical .rn-clock{font-size:clamp(13px,1.7vw,20px)}

      .rn-audio-only{background:transparent!important;padding:0!important;min-height:1px!important;width:1px!important;height:1px!important;overflow:hidden!important}
      .rn-audio-only::after,.rn-audio-only .rn-music-bg,.rn-audio-only .rn-wash,.rn-audio-only .rn-grid,.rn-audio-only .rn-scanlines,.rn-audio-only .rn-music-main,.rn-audio-only .rn-music-footer{display:none!important}

      @media (max-height:360px) and (min-aspect-ratio:4/3){.rn-music-stage{padding-top:12px;padding-bottom:10px}.rn-cover-wrap{width:min(30vw,43vh,360px)}.rn-spectrum-shell{height:58px;margin-top:4px}.rn-music-badge{padding:4px 9px}.rn-music-footer{padding-top:6px}}
      ${scenePerfCss(perf.effects)}
      ${perf.effects !== "full" ? "#rn-spectrum{filter:none!important}.rn-cover-halo{filter:none!important;opacity:.5}.rn-vinyl{will-change:transform}" : ""}
    </style>

    <main class="rn-music-stage rn-layout-${layout}${audioOnly ? " rn-audio-only" : ""}" data-effects="${perf.effects}" style="${sceneStyleVars(accent)}">
      ${bg}<div class="rn-wash"></div><div class="rn-grid"></div><div class="rn-scanlines"></div>
      <div class="rn-music-main">
        <div class="rn-art-column"><div class="rn-cover-wrap"><div class="rn-cover-halo"></div><div class="rn-vinyl"></div><div id="rn-cover-placeholder" class="rn-cover-placeholder">&#9835;</div><img id="rn-cover" class="rn-cover" src="${escapeHtml(coverUrl)}" alt=""${coverUrl ? "" : " style=\"display:none\""}></div></div>
        <div class="rn-music-meta">
          <span class="rn-music-badge"><span class="rn-pulse"></span><span id="rn-mode">ON AIR · NOW PLAYING</span></span>
          <div id="rn-track-title" class="rn-music-title">${escapeHtml(fallbackTitle)}</div>
          <div id="rn-track-artist" class="rn-music-artist">—</div>
          <div class="rn-progress"><span id="rn-progress-bar"></span></div>
          <div id="rn-track-time" class="rn-time">00:00 / 00:00</div>
          <div class="rn-spectrum-shell"><canvas id="rn-spectrum"></canvas></div>
        </div>
      </div>
      <div class="rn-music-footer"><span class="rn-station">${escapeHtml(station)}</span><span id="rn-clock" class="rn-clock"></span></div>
      <audio id="rn-music-audio" playsinline preload="auto" crossorigin="anonymous"></audio>
    </main>

    <script>
      (function(){
        // Rates are decoupled on purpose (see performance-modes.js):
        //   spectrum / motion  SPECTRUM_HZ   (one timer drives every moving pixel)
        //   progress bar       PROGRESS_HZ   (piggybacks on the spectrum tick)
        //   clock              1 Hz
        //   track metadata     event driven over SSE, slow poll only as fallback
        var CFG=${JSON.stringify(perf)};
        var SPECTRUM_HZ=CFG.spectrumHz,PROGRESS_EVERY=Math.max(1,Math.round(CFG.spectrumHz/CFG.progressHz)),EFFECTS=CFG.effects,BAR_COUNT=48;
        var FALLBACK_POLL_MS=15000,EVENTS_URL=${JSON.stringify(eventsUrl)},PROFILE_ID=${JSON.stringify(profileId || null)};
        var audio=document.getElementById("rn-music-audio"),canvas=document.getElementById("rn-spectrum"),vinyl=document.querySelector(".rn-vinyl");
        var analyser=null,audioContext=null,source=null,gain=null,loadedTrackId=null,loadedCoverKey=null,currentNow=null,currentNowAt=performance.now(),lastTimeLabel="",lastProgress=-1,freq=null,grad=null,gradH=0,ticks=0,ctx=null,idleDrawn=false;
        var displayBars=new Array(BAR_COUNT).fill(.03);
        var PUBLIC_BASE=${JSON.stringify(publicBase)};
        var FALLBACK_COVER=${JSON.stringify(coverUrl)};
        function fmt(sec){sec=Math.max(0,Number(sec)||0);var m=Math.floor(sec/60),s=Math.floor(sec%60);return String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")}
        function fitMetaText(){requestAnimationFrame(function(){var stage=document.querySelector(".rn-music-stage"),vertical=stage&&stage.classList.contains("rn-layout-vertical"),title=document.getElementById("rn-track-title"),artist=document.getElementById("rn-track-artist");fitText(title,vertical?2:1,vertical?28:18);fitText(artist,1,vertical?16:10)})}
        function fitText(el,lines,minPx){if(!el||!el.clientWidth)return;el.style.fontSize="";var style=getComputedStyle(el),size=parseFloat(style.fontSize)||24,floor=Math.min(size,Number(minPx)||10),oldWhite=el.style.whiteSpace,oldDisplay=el.style.display,oldClamp=el.style.webkitLineClamp,oldOrient=el.style.webkitBoxOrient;el.style.fontSize=size+"px";el.style.whiteSpace="nowrap";el.style.display="block";el.style.webkitLineClamp="unset";el.style.webkitBoxOrient="initial";while(size>floor&&el.scrollWidth>el.clientWidth*Math.max(1,lines)+1){size=Math.max(floor,size-1);el.style.fontSize=size+"px"}el.style.whiteSpace=oldWhite;el.style.display=oldDisplay;el.style.webkitLineClamp=oldClamp;el.style.webkitBoxOrient=oldOrient}
        function ensureGraph(){if(audioContext){if(audioContext.state==="suspended")audioContext.resume().catch(function(){});return}try{var AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;audioContext=new AC();analyser=audioContext.createAnalyser();analyser.fftSize=256;analyser.smoothingTimeConstant=.72;analyser.minDecibels=-88;analyser.maxDecibels=-18;gain=audioContext.createGain();gain.gain.value=0;source=audioContext.createMediaElementSource(audio);source.connect(analyser);analyser.connect(gain);gain.connect(audioContext.destination);freq=new Uint8Array(analyser.frequencyBinCount);if(audioContext.state==="suspended")audioContext.resume().catch(function(){})}catch(e){analyser=null}}
        function fallbackCover(cover){if(!cover)return;cover.dataset.fallback="1";if(FALLBACK_COVER){cover.style.display="block";cover.src=FALLBACK_COVER}else{cover.removeAttribute("src");cover.style.display="none"}}
        function syncCover(playing,track){var cover=document.getElementById("rn-cover");if(!cover)return;var key=playing&&track?track.id+":"+(track.coverEmbedded?"embedded":"fallback"):"standby";if(key===loadedCoverKey)return;loadedCoverKey=key;cover.onerror=function(){if(this.dataset.fallback!=="1"&&FALLBACK_COVER){this.dataset.fallback="1";this.style.display="block";this.src=FALLBACK_COVER}else this.style.display="none"};if(playing&&track&&track.coverEmbedded){cover.dataset.fallback="0";cover.style.display="block";cover.src=PUBLIC_BASE+"/cover/"+encodeURIComponent(track.id)}else fallbackCover(cover)}
        function setText(id,value){var el=document.getElementById(id);if(el&&el.textContent!==value){el.textContent=value;return true}return false}
        function apply(now){var prevId=currentNow&&currentNow.track?currentNow.track.id:null;currentNow=now;currentNowAt=performance.now();idleDrawn=false;var playing=now&&now.mode==="playing"&&now.track;setText("rn-mode",playing?"ON AIR · NOW PLAYING":"ON AIR · STANDBY");var changed=setText("rn-track-title",playing?(now.track.title||"Untitled"):${JSON.stringify(fallbackTitle)});changed=setText("rn-track-artist",playing?(now.track.artist||"—"):"Waiting for the next track")||changed;if(changed||(playing&&now.track.id!==prevId))fitMetaText();syncCover(playing,playing?now.track:null);var pos=playing?Number(now.positionS||0):0;if(!playing){renderTimeline(true);if(!audio.paused)audio.pause();return}ensureGraph();var vol=Math.max(0,Math.min(1,Number(now.volume == null ? .7 : now.volume)));audio.volume=vol;if(gain)gain.gain.value=0;if(now.track.id!==loadedTrackId){loadedTrackId=now.track.id;audio.src=PUBLIC_BASE+"/file/"+encodeURIComponent(now.track.id);var wanted=Math.max(0,Number(now.positionS||0));var seek=function(){try{audio.currentTime=Number.isFinite(audio.duration)&&audio.duration>0?Math.min(wanted,Math.max(0,audio.duration-.05)):wanted}catch(e){}audio.play().catch(function(){});audio.removeEventListener("loadedmetadata",seek)};audio.addEventListener("loadedmetadata",seek);audio.play().catch(function(){})}else if(Math.abs((audio.currentTime||0)-pos)>2.5){try{audio.currentTime=pos}catch(e){}}renderTimeline(true)}
        function renderTimeline(force){var playing=currentNow&&currentNow.mode==="playing"&&currentNow.track,pos=playing?Number(currentNow.positionS||0)+(performance.now()-currentNowAt)/1000:0,dur=playing?Number(currentNow.durationS||0):0;pos=Math.max(0,dur>0?Math.min(dur,pos):pos);var bar=document.getElementById("rn-progress-bar");var pct=dur>0?Math.max(0,Math.min(1,pos/dur)):0;if(bar&&(force||Math.abs(pct-lastProgress)>.0005)){lastProgress=pct;bar.style.transform="scaleX("+pct.toFixed(4)+")";if(EFFECTS==="full")bar.style.backgroundPosition=((performance.now()/18)%220)+"% 0"}var label=fmt(pos)+" / "+fmt(dur);if(label!==lastTimeLabel){lastTimeLabel=label;setText("rn-track-time",label)}if(playing&&dur>0&&pos>=dur-.05&&!window.__rnMusicEndFetch){window.__rnMusicEndFetch=setTimeout(function(){window.__rnMusicEndFetch=null;poll()},600)}}
        function poll(){fetch(PUBLIC_BASE+"/now.json",{cache:"no-store"}).then(function(r){return r.json()}).then(apply).catch(function(){})}
        function analyseBars(data,n){var bars=[],usable=Math.max(8,Math.floor(data.length*.82));for(var i=0;i<n;i++){var p0=i/n,p1=(i+1)/n,start=Math.floor(Math.pow(p0,1.55)*usable),end=Math.max(start+1,Math.floor(Math.pow(p1,1.55)*usable)),sum=0,count=0;for(var j=start;j<end&&j<data.length;j++){sum+=data[j];count++}var raw=count?(sum/count)/255:0,comp=.82+(i/Math.max(1,n-1))*.58;bars.push(Math.min(1,Math.pow(raw*comp,.82)))}return bars}
        function procedural(n){var t=performance.now()/160,bars=[];for(var i=0;i<n;i++){var env=.34+.12*Math.sin(i*.19+.8),wave=.11*Math.sin(t*.72+i*.39)+.07*Math.sin(t*.41-i*.21);bars.push(Math.max(.055,Math.min(.58,env+wave)))}return bars}
        function smoothBars(target){for(var i=0;i<BAR_COUNT;i++){var next=Number(target[i]||0),current=displayBars[i]||0,speed=next>current?.72:.46;displayBars[i]=current+(next-current)*speed}return displayBars}
        function liveMotion(target){var t=performance.now()/1000;return target.map(function(value,i){var motion=.11*Math.sin(t*18+i*.47)+.055*Math.sin(t*27-i*.31);return Math.max(.035,Math.min(1,Number(value||0)+motion))})}
        function roundedBar(c,x,y,w,h,r){if(h<=0||w<=0)return;if(typeof c.roundRect==="function"){c.beginPath();c.roundRect(x,y,w,h,Math.min(r,w/2,h/2));c.fill()}else c.fillRect(x,y,w,h)}
        function drawBars(c,bars,w,h,dpr){var padX=2*dpr,padTop=14*dpr,padBottom=3*dpr,drawH=Math.max(1,h-padTop-padBottom),gap=Math.max(2,3.2*dpr),barW=Math.max(1,(w-padX*2-gap*(bars.length-1))/bars.length);if(!grad||gradH!==h){gradH=h;grad=c.createLinearGradient(0,h,0,padTop);grad.addColorStop(0,"rgba(0,240,255,.96)");grad.addColorStop(.55,"rgba(111,88,255,.92)");grad.addColorStop(1,"rgba(255,43,214,.92)")}c.fillStyle=grad;if(EFFECTS==="full"){c.shadowColor="rgba(0,240,255,.22)";c.shadowBlur=7*dpr}for(var i=0;i<bars.length;i++){var level=Math.max(.025,Math.min(1,bars[i])),barH=Math.max(2*dpr,level*drawH),x=padX+i*(barW+gap),y=h-padBottom-barH;roundedBar(c,x,y,barW,barH,2.5*dpr)}c.shadowBlur=0}
        function spinVinyl(){if(!vinyl||EFFECTS==="full"||EFFECTS==="minimal")return;vinyl.style.transform="rotate("+((performance.now()/16000*360)%360).toFixed(1)+"deg)"}
        function playingNow(){return analyser&&audioContext&&audioContext.state==="running"&&!audio.paused&&audio.readyState>=2&&currentNow&&currentNow.mode==="playing"}
        function draw(){ticks++;if(ticks%PROGRESS_EVERY===0)renderTimeline(false);spinVinyl();if(!canvas)return;if(!ctx)ctx=canvas.getContext("2d");if(!ctx)return;ensureGraph();var live=playingNow();
          // Minimal mode keeps the idle spectrum static: nothing moves, so
          // Chromium produces no new frames at all until music is playing.
          if(!live&&EFFECTS==="minimal"&&idleDrawn)return;var dpr=Math.min(2,window.devicePixelRatio||1),w=Math.max(1,Math.floor(canvas.clientWidth*dpr)),h=Math.max(1,Math.floor(canvas.clientHeight*dpr));if(canvas.width!==w){canvas.width=w;grad=null}if(canvas.height!==h){canvas.height=h;grad=null}ctx.clearRect(0,0,w,h);var target;if(live){analyser.getByteFrequencyData(freq);target=analyseBars(freq,BAR_COUNT)}else target=procedural(BAR_COUNT);drawBars(ctx,smoothBars(EFFECTS==="minimal"&&!live?target:liveMotion(target)),w,h,dpr);idleDrawn=!live}
        function clock(){var label=new Date().toLocaleTimeString("en-GB",{hour12:false});setText("rn-clock",label);var pulse=document.querySelector(".rn-music-badge .rn-pulse");if(pulse&&EFFECTS!=="full")pulse.style.opacity=(Math.floor(Date.now()/800)%2)?".35":"1"}
        function connectEvents(){if(!window.EventSource||!EVENTS_URL)return;try{if(window.__rnMusicEvents)window.__rnMusicEvents.close();var es=new EventSource(EVENTS_URL);window.__rnMusicEvents=es;es.onmessage=function(e){try{var msg=JSON.parse(e.data);if(msg&&msg.type==="music"&&(!PROFILE_ID||!msg.profileId||msg.profileId===PROFILE_ID))poll()}catch(err){}}}catch(e){}}
        audio.addEventListener("ended",function(){setTimeout(poll,150)});
        poll();clock();fitMetaText();connectEvents();window.addEventListener("resize",fitMetaText);
        window.__rnMusicPoll&&clearInterval(window.__rnMusicPoll);window.__rnMusicPoll=setInterval(poll,FALLBACK_POLL_MS);
        window.__rnMusicDraw&&clearInterval(window.__rnMusicDraw);window.__rnMusicDraw=setInterval(draw,Math.round(1000/SPECTRUM_HZ));
        window.__rnMusicClock&&clearInterval(window.__rnMusicClock);window.__rnMusicClock=setInterval(clock,1000);draw();
      })();
    </script>`;
}

module.exports = { musicSceneFragment, musicScenePerf };
