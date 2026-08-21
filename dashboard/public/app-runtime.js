function wirePage() {
  const root=$("#page-content"); if(!root)return;
  $$('[data-copy]',root).forEach(b=>b.onclick=()=>copyText(b.dataset.copy));
  $$('[data-open-url]',root).forEach(b=>b.onclick=()=>openUrl(b.dataset.openUrl));
  $$('[data-nav]',root).forEach(b=>b.onclick=()=>navigate(b.dataset.nav));
  $$('[data-scene]',root).forEach(b=>b.onclick=()=>{ try{ setScene(JSON.parse(b.dataset.scene)); }catch{} });
  $$('[data-edit-builtin]',root).forEach(b=>b.onclick=()=>openBuiltinModal(b.dataset.editBuiltin));
  $$('[data-create-or-switch-mode]',root).forEach(b=>b.onclick=()=>{ if(!b.disabled && b.dataset.createOrSwitchMode!==activeProfile()?.mode)openProfileModal(b.dataset.createOrSwitchMode); });
  $$('[data-add-profile-mode]',root).forEach(b=>b.onclick=()=>openProfileModal(b.dataset.addProfileMode));
  $$('[data-activate-profile]',root).forEach(b=>b.onclick=()=>activateProfile(b.dataset.activateProfile));
  $$('[data-edit-profile]',root).forEach(b=>b.onclick=()=>openProfileModal(null,S.profiles.find(p=>p.id===b.dataset.editProfile)));
  $$('[data-delete-profile]',root).forEach(b=>b.onclick=async()=>{ const p=S.profiles.find(x=>x.id===b.dataset.deleteProfile); if(!p)return; if(!(await confirmAction("Delete profile",`Delete ${p.name}? Its isolated music files remain on disk until server cleanup/migration tooling removes them.`)))return; if(p.id===S.activeProfileId)return toast("Switch to another profile first","error"); S.profiles=S.profiles.filter(x=>x.id!==p.id); await saveProfileStore(); renderProfileSelect(); renderPage(); toast("Profile deleted","success"); });
  $$('[data-edit-dest]',root).forEach(b=>b.onclick=()=>openDestinationModal((S.status.destinations||[]).find(d=>d.id===b.dataset.editDest)));
  $$('[data-delete-dest]',root).forEach(b=>b.onclick=async()=>{ const d=(S.status.destinations||[]).find(x=>x.id===b.dataset.deleteDest); if(!d)return; if(!(await confirmAction("Delete destination",`Remove ${d.name} from CastNexus?`)))return; try{ await api(`/api/destinations/${encodeURIComponent(d.id)}`,{method:"DELETE"}); await refreshAndRender(); toast("Destination deleted","success"); }catch(e){toast(e.message,"error");} });
  $$('[data-dest-toggle]',root).forEach(i=>i.onchange=async()=>{ try{ await api(`/api/destinations/${encodeURIComponent(i.dataset.destToggle)}/toggle`,{method:"POST",body:{enabled:i.checked}}); const p=activeProfile(); if(p){const ids=new Set(p.destinationEnabledIds||[]); i.checked?ids.add(i.dataset.destToggle):ids.delete(i.dataset.destToggle); p.destinationEnabledIds=[...ids]; await saveProfileStore();} await fetchCore(); updateChrome(); renderPage(); }catch(e){toast(e.message,"error");} });
  $$('[data-edit-overlay]',root).forEach(b=>b.onclick=()=>openOverlayModal(visibleOverlays().find(o=>o.id===b.dataset.editOverlay)));
  $$('[data-delete-overlay]',root).forEach(b=>b.onclick=async()=>{ const o=visibleOverlays().find(x=>x.id===b.dataset.deleteOverlay); if(!o)return; if(!(await confirmAction("Delete overlay",`Delete ${o.name}?`)))return; try{ await api(`/api/overlays/${encodeURIComponent(o.id)}`,{method:"DELETE"}); await refreshAndRender(); toast("Overlay deleted","success"); }catch(e){toast(e.message,"error");} });
  $$('[data-activate-overlay]',root).forEach(b=>b.onclick=()=>setScene({kind:"custom",overlayId:b.dataset.activateOverlay}));
  $$('[data-edit-track]',root).forEach(b=>b.onclick=()=>openTrackModal(S.tracks.find(t=>t.id===b.dataset.editTrack)));
  $$('[data-delete-track]',root).forEach(b=>b.onclick=async()=>{ const t=S.tracks.find(x=>x.id===b.dataset.deleteTrack); if(!t)return; if(!(await confirmAction("Delete track",`Remove ${t.title} from ${activeProfile()?.name || "this profile"}'s music library?`)))return; try{await api(musicApiUrl(`/tracks/${encodeURIComponent(t.id)}`, activeProfile()?.id),{method:"DELETE"});await refreshAndRender();toast("Track deleted","success");}catch(e){toast(e.message,"error");} });

  const comp=$("#compositor-toggle",root); if(comp)comp.onchange=async()=>{ try{await api("/api/compositor",{method:"POST",body:{enabled:comp.checked}});S.compositor.enabled=comp.checked;const p=activeProfile();if(p){p.compositorEnabled=comp.checked;await saveProfileStore();}toast(`Compositor ${comp.checked?"enabled":"disabled"}`,"success");}catch(e){comp.checked=!comp.checked;toast(e.message,"error");} };

  const file=$("#music-file-input",root); if(file)file.onchange=()=>uploadMusic(file.files);
  const shuffle=$("#music-shuffle",root), loop=$("#music-loop",root), vol=$("#music-volume",root);
  if(shuffle)shuffle.onchange=saveMusicSettings;
  if(loop)loop.onchange=saveMusicSettings;
  if(vol){ vol.oninput=()=>$("#music-volume-label").textContent=`${Math.round(Number(vol.value)*100)}%`; vol.onchange=saveMusicSettings; }

  const sceneMusic=$("#profile-scene-music",root);
  if(sceneMusic)sceneMusic.onchange=async()=>{
    const p=activeProfile(); if(!p)return;
    p.sceneMusicEnabled=sceneMusic.checked;
    try{await saveProfileStore();toast(sceneMusic.checked?"Profile music enabled for standby/BRB/Ending":"Profile scene music disabled","success");}catch(e){sceneMusic.checked=!sceneMusic.checked;toast(e.message,"error");}
  };

  $$('[data-action]',root).forEach(b=>{
    const a=b.dataset.action;
    if(a==="add-destination")b.onclick=()=>openDestinationModal();
    if(a==="add-overlay")b.onclick=()=>openOverlayModal();
    if(a==="save-profile")b.onclick=()=>snapshotActiveProfile(true).catch(e=>toast(e.message,"error"));
    if(a==="regen-pc-key")b.onclick=async()=>{if(!(await confirmAction("Regenerate PC key","OBS using the old key will stop connecting until you update it.","Regenerate")))return;try{await api("/api/pckey/regenerate",{method:"POST"});await refreshAndRender();toast("PC key regenerated","success");}catch(e){toast(e.message,"error");}};
    if(a==="change-stream-key")b.onclick=openStreamKeyModal;
    if(a==="save-music-visual")b.onclick=saveMusicVisual;
    if(a==="logout")b.onclick=logout;
  });
}

async function saveMusicSettings() {
  const p=activeProfile();
  const body={ shuffle:!!$("#music-shuffle")?.checked, loop:!!$("#music-loop")?.checked, volume:Number($("#music-volume")?.value ?? S.musicSettings.volume) };
  try{ const r=await api(musicApiUrl("/settings",p?.id),{method:"POST",body}); S.musicSettings=r.musicSettings; if(p){p.musicSettings={...S.musicSettings};await saveProfileStore();}toast(`Music settings saved for ${p?.name || "profile"}`,"success"); }catch(e){toast(e.message,"error");}
}

async function saveMusicVisual() {
  const p=activeProfile(); if(!p)return;
  p.musicVisual={ accent:$("#music-visual-accent").value, station:$("#music-visual-station").value.trim(), background:$("#music-visual-background").value.trim(), title:$("#music-visual-title").value.trim(), cover:$("#music-visual-cover").value.trim() };
  try{await saveProfileStore();toast("Music appearance saved. The profile renderer will reload it automatically.","success");renderPage();}catch(e){toast(e.message,"error");}
}

async function uploadMusic(files) {
  if(!files?.length)return;
  const p=activeProfile();
  let ok=0;
  for(const file of files){ const fd=new FormData();fd.append("file",file);try{await api(musicApiUrl("/tracks",p?.id),{method:"POST",body:fd});ok++;toast(`Uploaded ${file.name} to ${p?.name || "profile"}`,"success");}catch(e){toast(`${file.name}: ${e.message}`,"error");} }
  if(ok)await refreshAndRender();
}

function startMusicNowPolling() {
  stopMusicNowPolling();
  const tick=async()=>{
    if(S.page!=="music"||!S.status?.twitchLogin)return;
    const p=activeProfile();
    try{
      const profilePart=p?.id?`/${encodeURIComponent(p.id)}`:"";
      const now=await api(`/overlay/${encodeURIComponent(S.status.twitchLogin)}/music${profilePart}/now.json`);
      const card=$("#music-now-card"), badge=$("#music-now-mode"); if(!card||!badge)return;
      if(now?.mode!=="playing"||!now.track){badge.textContent="IDLE";badge.className="badge";card.innerHTML=`<div class="music-cover">♫</div><div><strong>No track playing</strong><div class="muted" style="font-size:.75rem;margin-top:4px">This profile has its own isolated library.</div><div class="progress"><span style="width:0"></span></div><div class="stat-sub">00:00 / 00:00</div></div>`;return;}
      badge.textContent="PLAYING";badge.className="badge green";
      const pct=now.durationS?Math.max(0,Math.min(100,Number(now.positionS||0)/Number(now.durationS)*100)):0;
      card.innerHTML=`<div class="music-cover">♫</div><div><strong>${esc(now.track.title||"Untitled")}</strong><div class="muted" style="font-size:.75rem;margin-top:4px">${esc(now.track.artist||"Unknown artist")}</div><div class="progress"><span style="width:${pct}%"></span></div><div class="stat-sub">${fmtDuration(now.positionS)} / ${fmtDuration(now.durationS)}</div></div>`;
    }catch{}
  };
  tick();S.musicNowTimer=setInterval(tick,1000);
}
function stopMusicNowPolling(){if(S.musicNowTimer){clearInterval(S.musicNowTimer);S.musicNowTimer=null;}}

async function pollStatus() {
  try {
    S.status=await api("/api/status");
    updateChrome();
    if(S.page==="overview"){
      const ls=liveState();
      const pill=$(".big-status");if(pill)pill.innerHTML=`<span class="status-dot ${ls.key!=="idle"?ls.key:""}"></span>${esc(ls.title)}`;
    }
  } catch(e){ if(e.status===401){clearInterval(S.pollTimer);setView("login-view");} }
}

async function logout() {
  try{await api("/api/logout",{method:"POST"});}catch{}
  if(S.pollTimer)clearInterval(S.pollTimer);stopMusicNowPolling();setView("login-view");
}

async function setupMode(mode) {
  const error=$("#setup-error");error.textContent="";
  try{
    await api("/api/source-mode",{method:"POST",body:{sourceMode:modeSource(mode)}});
    S.status=await api("/api/status");
    S.overlays=(await api("/api/overlays")).overlays||[];
    await ensureProfileStore(mode);
    const p=activeProfile(); if(p){p.mode=mode;p.name=mode==="pc"?"PC Gaming":mode==="console"?"Console Gaming":"24/7 Music";p.color=PROFILE_COLORS[mode];p.musicAutostart=mode==="music";p.sceneMusicEnabled=mode==="music";p.compositorEnabled=mode!=="music";await saveProfileStore();}
    if(S.status.needsStreamKey){setView("streamkey-view");return;}
    await enterApp();
  }catch(e){error.textContent=e.message;}
}

async function enterApp() {
  await fetchCore();
  await ensureProfileStore(S.status.sourceMode==="console"?"console":"pc");
  loadProfileStoreFromOverlays();
  // A brand-new account creates the profile after the first fetch; refresh so
  // the newly created profile gets its own music bucket immediately.
  if(S.activeProfileId) await fetchCore();
  setView("app-view");
  updateChrome();renderProfileSelect();renderPage();
  if(S.pollTimer)clearInterval(S.pollTimer);S.pollTimer=setInterval(pollStatus,2500);
}

async function boot() {
  try {
    S.status=await api("/api/status");
    if(S.status.needsSourceMode){setView("setup-view");return;}
    if(S.status.needsStreamKey){setView("streamkey-view");return;}
    await enterApp();
  } catch(e) {
    if(e.status===401)setView("login-view");
    else {setView("login-view");toast(e.message,"error");}
  }
}

$$('[data-setup-mode]').forEach(b=>b.addEventListener("click",()=>setupMode(b.dataset.setupMode)));
$("#streamkey-form")?.addEventListener("submit",async e=>{e.preventDefault();const err=$("#streamkey-error");err.textContent="";try{await api("/api/streamkey",{method:"POST",body:{streamKey:$("#streamkey-input").value.trim()}});await enterApp();}catch(ex){err.textContent=ex.message;}});
$("#streamkey-back")?.addEventListener("click",()=>setView("setup-view"));
$("#logout-btn")?.addEventListener("click",logout);
$("#main-nav")?.addEventListener("click",e=>{const b=e.target.closest("[data-page]");if(b)navigate(b.dataset.page);});
$("#profile-select")?.addEventListener("change",e=>activateProfile(e.target.value));
$("#profile-quick-add")?.addEventListener("click",()=>openProfileModal("pc"));
$("#mobile-menu")?.addEventListener("click",()=>$(".sidebar")?.classList.toggle("open"));

document.addEventListener("keydown",e=>{if(e.key==="Escape")closeModal();});

boot();
