(() => {
'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => n == null ? 'Price needed' : new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'}).format(n / 100);
const photoAccept = 'image/*,.heic,.heif,.arw,.dng,.nef,.cr2,.cr3,.raf,.orf,.rw2,.tif,.tiff';
const titles = {home:'The bench',quick:'Add one rock',video:'Capture video',inventory:'Your inventory',connections:'Store connections',ai:'AI & settings',orders:'Orders & shipments'};
const channelNames = {website:'Your website',etsy:'Etsy',ebay:'eBay',stripe:'Stripe',paypal:'PayPal'};
const discoveries = {};
let csrf = '', view = 'home', items = [], jobs = [], prefs = {}, connectionState = {}, serverStatus = {};
let capture = {id:null,transcript:'',photos:[]}, captureDirty = false, captureRevision = 0, savePromise = null, saveTimer;
let editing = null, editorDirty = false, editorPhotosDirty = false, latestMediaRecord = null, editorOpening = false, recorder = null, recordStream = null, recordTimer = null, recordStarted = 0, audioJob = null;
let recordCompletion = null, resolveRecording = null;
let videoState = {src:null,name:'',roi:null,cues:'',empty:0,threshold:.035,minEmpty:1,minSpecimen:1.5}, uploading = 0;
let pageDirty = false;
let filter = 'all', search = '', selected = new Set(), polling = false, routeBusy = false;
try { videoState = {...videoState,...JSON.parse(sessionStorage.getItem('mm-video-work') || '{}')}; } catch (_) {}
function rememberVideo() { try {sessionStorage.setItem('mm-video-work',JSON.stringify(videoState));} catch (_) {} }
async function api(path, data, method = 'POST') {
 const response = await fetch('/api/seller/' + path, {method:data === undefined ? 'GET' : method, headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, ...(data === undefined ? {} : {body:JSON.stringify(data)})});
 let result; try { result = await response.json(); } catch (_) { throw Error('The server did not respond correctly. Your open work is still here; try again.'); }
 if (!response.ok) {const e = Error(result.error || result.message || 'This could not finish. Try again.'); e.status = response.status; throw e;}
 return result;
}
function toast(message) {$('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 6500);}
function fail(error) {const message = error.message || String(error); const dialogs = $$('dialog[open]'), dialog = dialogs.at(-1); if(dialog){let target = $('.dialog-error',dialog); if(!target){target = document.createElement('p'); target.className = 'dialog-error notice error-text'; target.setAttribute('role','alert'); const head = $('.modal-head',dialog); head ? head.after(target) : dialog.prepend(target);} target.textContent = message;} toast(message);}
async function busy(button, action, label = 'Working…') {
 if (!button || button.disabled) return;
 const before = button.textContent; button.disabled = true; button.textContent = label;
 try {return await action();} catch (error) {fail(error);} finally {if(button.isConnected){button.disabled = false; button.textContent = before;}}
}
function safeURL(value) {if(!value || typeof value !== 'string') return ''; try {const u = new URL(value,location.origin); return ['http:','https:'].includes(u.protocol) ? u.href : '';} catch (_) {return '';}}
function setSaveState(message, error = false) {const el = $('#capture-save-state'); if(el){el.textContent = message; el.classList.toggle('error-text',error);}}
function changedCapture() {captureDirty = true; captureRevision++; setSaveState('Saving your work…'); clearTimeout(saveTimer); saveTimer = setTimeout(() => saveCapture().catch(() => {}),700);}
async function saveCapture() {
 clearTimeout(saveTimer);
 if(savePromise) {await savePromise; if(captureDirty) return saveCapture(); return;}
 if(!captureDirty || !csrf) return;
 const revision = captureRevision, payload = structuredClone(capture);
 savePromise = api('capture-draft',payload).then(saved => {capture.id = saved.id || capture.id; if(revision === captureRevision) captureDirty = false; setSaveState(captureDirty ? 'Saving your latest changes…' : 'Draft saved online.');}).catch(error => {setSaveState('Not saved yet. Keep this page open and retry.',true); throw error;}).finally(() => {savePromise = null;});
 await savePromise;
 if(captureDirty) return saveCapture();
}
async function refresh() {[items,jobs,prefs] = await Promise.all([api('items'),api('jobs'),api('settings')]);}
function showLogin() {csrf = ''; $('#login').hidden = false; $('#app').hidden = true; stopAudio();}
async function boot() {
 try {
  const session = await api('session'); csrf = session.csrf; await refresh();
  const extra = await Promise.allSettled([api('capture-draft'),api('connections'),api('status')]);
  if(extra[0].status === 'fulfilled') {const d = extra[0].value; if(d && (d.transcript || d.photos?.length)) capture = {id:d.id,transcript:d.transcript || '',photos:d.photos || []};}
  if(extra[1].status === 'fulfilled') connectionState = extra[1].value;
  if(extra[2].status === 'fulfilled') serverStatus = extra[2].value;
  $('#login').hidden = true; $('#app').hidden = false; renderEnvironment(); await applyRoute();
 } catch(error) {if(error.status === 401 || error.status === 403) showLogin(); else {showLogin(); $('#login-error').textContent = error.message;}}
}
async function logout() {if(pageDirty && !await confirmLeavePage()) return; if(editorDirty && !await confirmLeaveEditor()) return; if(captureDirty){try{await saveCapture();}catch(error){fail(error);return;}} await stopAudio(); location.assign('/signout-with-chatgpt?return_to=%2Fseller');}
$('#logout').onclick = logout; $('#header-logout').onclick = logout;
$('#settings-link').onclick = () => go('ai'); $('#back').onclick = () => go('home');
$$('[data-view]').forEach(button => button.onclick = () => go(button.dataset.view));
$('.brand').onclick = event => {event.preventDefault(); go('home');};
function renderEnvironment() {
 const cloud = serverStatus.cloud;
 $('#environment-note').innerHTML = `<span class="environment-label">${cloud ? 'PRIVATE WORKSPACE' : 'HOSTED ON YOUR MAC'}</span><span>${cloud ? esc(serverStatus.storage || 'Connected storage') : 'Your workspace is online. Video and RAW processing wait safely for your private Mac worker.'}</span>`;
}
function routeParts() {const [candidate,kind,id] = location.hash.slice(1).split('/'); return {view:titles[candidate] ? candidate : 'home',id:kind === 'item' ? id : null};}
async function applyRoute() {
 const route = routeParts(); if(routeBusy) return; routeBusy = true;
 try {
  if($('#editor').open && uploading){toast('Wait for your photographs to finish saving before leaving this specimen.');history.pushState({},'',`#${view}/item/${editing.id}`);return;}
  if(pageDirty && !await confirmLeavePage()){history.pushState({},'',`#${view}`);return;}
  if(editorDirty && (!route.id || route.id !== editing?.id)) {if(!await confirmLeaveEditor()){history.pushState({},'',`#${view}/item/${editing.id}`);return;}}
  if(!route.id && $('#editor').open) {$('#editor').close(); editing = null;}
  if(view === 'quick' && route.view !== 'quick') stopAudio();
  view = route.view; render();
  if(route.id) await openEditor(route.id,false);
 } finally {routeBusy = false;}
}
async function go(next) {
 if(!titles[next]) return;
 if($('#editor').open && uploading){fail(Error('Wait for your photographs to finish saving before leaving this specimen.'));return;}
 if(pageDirty && !await confirmLeavePage()) return;
 if(editorDirty && !await confirmLeaveEditor()) return;
 if(view === 'quick' && next !== 'quick') stopAudio();
 if($('#editor').open) $('#editor').close(); editing = null; editorDirty = false;
 view = next; history.pushState({},'',`#${next}`); render(); window.scrollTo({top:0,behavior:'instant'}); $('#heading').focus({preventScroll:true});
}
window.addEventListener('popstate',() => applyRoute());
window.addEventListener('beforeunload',event => {if(editorDirty || pageDirty || captureDirty || recorder || uploading){event.preventDefault(); event.returnValue = '';}});
window.addEventListener('pagehide',() => {if(recorder) stopAudio();});
function updateNetwork() {$('#connection-banner').hidden = navigator.onLine;}
window.addEventListener('online',() => {updateNetwork(); if(captureDirty) saveCapture().catch(fail); poll();}); window.addEventListener('offline',updateNetwork); updateNetwork();
function render() {
 pageDirty = false;
 $('#heading').textContent = titles[view]; document.title = titles[view] + ' · Mineral Murals Seller Hub'; $('#back').hidden = view === 'home';
 $$('#nav button').forEach(button => {const active = button.dataset.view === view; button.classList.toggle('active',active); if(active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');});
 ({home,quick,video,inventory,connections,ai,orders}[view])();
}
function recordHTML(record, check = false) {
 const photo = record.photos?.[0]?.src;
 return `<article class="record">${check ? `<input type="checkbox" data-select="${esc(record.id)}" aria-label="Select ${esc(record.title || record.id)}" ${selected.has(record.id) ? 'checked' : ''}>` : ''}${photo ? `<img src="${esc(photo)}" alt="${esc(record.material || record.title)}" loading="lazy">` : '<div class="no-photo" aria-label="No photo">◇</div>'}<div class="summary"><h3>${esc(record.title || record.material || 'Untitled specimen')}</h3><div class="sub">#${esc(record.specimen_number || record.id)}${record.locality ? ' · ' + esc(record.locality) : ''}</div><span class="badge ${esc(record.status)}${record.sale_platform ? ' · Sold on '+esc(channelNames[record.sale_platform]||record.sale_platform) : ''}">${esc(record.status)}${record.sale_platform ? ' · Sold on '+esc(channelNames[record.sale_platform]||record.sale_platform) : ''}</span>${record.video ? '<span class="badge">FROM VIDEO</span>' : ''}</div><span class="price">${money(record.price_cents)}</span><button data-edit="${esc(record.id)}">Review →</button></article>`;
}
function bindRecords(root = $('#content')) {
 $$('[data-edit]',root).forEach(button => button.onclick = () => openEditor(button.dataset.edit));
 $$('[data-select]',root).forEach(box => box.onchange = () => {box.checked ? selected.add(box.dataset.select) : selected.delete(box.dataset.select); updateSelection();});
}
function home() {
 const drafts = items.filter(item => item.status === 'draft'), imports = items.filter(item => item.status === 'imported');
 const running = jobs.filter(job => ['waiting_worker','queued','processing'].includes(job.status));
 $('#content').innerHTML = `<section class="welcome"><div><p class="eyebrow">YOUR COLLECTION. ONE INVENTORY.</p><h2>Show it. Say it. List it.</h2><p class="lead">Film your specimens or add a few photos. Your personal listing assistant makes a draft for you to check.</p></div><img src="/assets/logo-mark.png" alt="Mineral Murals agate mark"></section><div class="actions-grid primary-actions"><button class="action" data-go="video"><span class="glyph" aria-hidden="true">▷</span><p class="step">A WHOLE BATCH</p><h3>Capture video</h3><p>One recording → separate specimens, photos and listing drafts.</p></button><button class="action" data-go="quick"><span class="glyph" aria-hidden="true">＋</span><p class="step">ONE SPECIMEN</p><h3>Add one rock</h3><p>Add photos. Speak or type three simple facts. Review.</p></button></div>${capture.transcript || capture.photos.length ? '<div class="resume-card"><div><b>You have an unfinished capture.</b><p>Your photos and notes are saved for you.</p></div><button data-go="quick">Continue →</button></div>' : ''}${running.length ? `<div class="resume-card"><div><b>${running.length} ${running.length === 1 ? 'recording is' : 'recordings are'} processing.</b><p>Your recording is saved online. Your Mac worker processes it when available.</p></div><button data-go="video">View progress →</button></div>` : ''}<div class="stats"><div><b>${items.filter(r=>r.status !== 'archived').length}</b><small>inventory records</small></div><div><b>${drafts.length}</b><small>drafts to review</small></div><div><b>${items.filter(r=>r.status === 'published').length}</b><small>published records</small></div></div><div class="panel compact"><div class="section-title"><div><p class="step">CONNECT ONCE</p><h3>Your website + Etsy + eBay</h3></div><button data-go="connections">Connections →</button></div><p class="muted">Choose your shop defaults once. Reviewed listings use those defaults. Each channel shows its actual publishing and stock sync status.</p></div>${imports.length ? `<p class="notice">${imports.length} recovered catalog records are preserved. Confirm which specimens you still own before publishing.</p>` : ''}<div class="section-title"><h2>Ready for a look</h2><button class="quiet" data-go="inventory">All inventory →</button></div><div class="records">${drafts.slice(-5).reverse().map(record => recordHTML(record)).join('') || '<div class="empty">No drafts waiting. Your next specimen starts above.</div>'}</div><div class="toolbar"><button data-go="orders">Orders & shipments</button><button data-go="ai">AI & settings</button></div>`;
 $$('[data-go]').forEach(button => button.onclick = () => go(button.dataset.go)); bindRecords();
}
function photoHTML(list) {
 return list.map((photo,index) => `<div class="photo"><a href="${esc(photo.original || photo.src)}" target="_blank" rel="noopener" aria-label="Open original photograph ${index+1}"><img src="${esc(photo.src)}" alt="Specimen photo ${index+1}"></a><div class="photo-tools"><button data-move="${index}" aria-label="Move photo ${index+1} earlier" ${index === 0 ? 'disabled' : ''}>←</button><button data-crop="${index}" ${photo.preview_only ? 'disabled' : ''}>Crop</button><button data-remove="${index}" aria-label="Remove photo ${index+1}">×</button></div><small>${index === 0 ? 'Cover · ' : ''}<a href="${esc(photo.original || photo.src)}" target="_blank" rel="noopener">Original ↗</a></small>${photo.preview_only ? `<p class="photo-warning">${esc(photo.warning || 'Original saved. Add a JPEG or convert this file before listing.')}</p>` : ''}</div>`).join('');
}
function bindPhotos(root,list,target,onChange) {
 function paint() {const el = $(target); if(!el) return; el.innerHTML = photoHTML(list); bindPhotos(el,list,target,onChange); onChange?.();}
 $$('[data-remove]',root).forEach(button => button.onclick = () => {list.splice(+button.dataset.remove,1); paint();});
 $$('[data-move]',root).forEach(button => button.onclick = () => {const i = +button.dataset.move; if(i > 0) [list[i-1],list[i]] = [list[i],list[i-1]]; paint();});
 $$('[data-crop]',root).forEach(button => button.onclick = () => crop(list,+button.dataset.crop,paint));
}
async function upload(file,onProgress,meta={}) {
 if(file.size > 512*1024*1024) throw Error('Choose a file smaller than 512 MB.');
 uploading++;
 try {
  const started=await api('upload/start',{name:file.name||'image.png',content_type:file.type||'application/octet-stream',role:meta.role||'original',original:meta.original||null,w:meta.w,h:meta.h});
  const parts=[],size=started.part_size||8*1024*1024;
  for(let offset=0,n=1;offset<file.size;offset+=size,n++){
   const response=await fetch('/api/seller/upload/part?id='+encodeURIComponent(started.id)+'&part='+n,{method:'POST',headers:{'X-CSRF-Token':csrf,'Content-Type':'application/octet-stream'},body:file.slice(offset,offset+size)});
   const part=await response.json();if(!response.ok)throw Error(part.error||'This upload part failed. Keep the original file and retry.');parts.push(part);onProgress?.(Math.round(Math.min(file.size,offset+size)/file.size*100));
  }
  return await api('upload/complete',{id:started.id,parts});
 } finally {uploading--;}
}
async function displayImage(file) {
 let image,objectURL;try {
  if(window.createImageBitmap)image=await createImageBitmap(file);
  else {objectURL=URL.createObjectURL(file);image=new Image();image.src=objectURL;await image.decode();}
  const width=image.width||image.naturalWidth,height=image.height||image.naturalHeight;if(!width||!height)throw Error('Image dimensions unavailable');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d',{colorSpace:'srgb'}).drawImage(image,0,0);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('Full-resolution conversion unavailable');return {file:new File([blob],'display.png',{type:'image/png'}),w:width,h:height};
 } finally {image?.close?.();if(objectURL)URL.revokeObjectURL(objectURL);}
}
async function uploadPhotos(files,list,progress,after) {
 for(const file of files) {
  progress('Saving original '+file.name+'…');const original=await upload(file,p=>progress('Saving original · '+p+'%'));
  try {const display=await displayImage(file);progress('Saving full-resolution display image…');const photo=await upload(display.file,p=>progress('Saving display · '+p+'%'),{role:'display',original:original.original,w:display.w,h:display.h});list.push(photo);}
  catch(error){const job=await api('jobs',{kind:'image',media:original.original});list.push({...original,src:'/assets/conversion-needed.svg',original:original.original,preview_only:true,job_id:job.id});progress('Original saved online. Full-resolution preview is queued for your Mac.');}
  after();
 }
 progress('Originals saved online. Website display images keep full resolution.');
}
function quick() {
 $('#content').innerHTML = `<p class="lead">Photos + a short rundown. Your assistant fills the draft; you check the result.</p><div class="split-layout"><section class="panel"><p class="step">1 · ADD YOUR PHOTOS</p><label class="upload"><b>Choose photos or take one</b>Original files stay full quality. The first photo is your cover.<input id="quick-photos" type="file" accept="${photoAccept}" multiple></label><p id="photo-progress" class="muted" aria-live="polite"></p><div class="photos" id="quick-photo-list">${photoHTML(capture.photos)}</div><p class="step">2 · TELL ME ABOUT THIS ROCK</p><p class="muted">Say <b>material, price and condition</b>. Add locality or measurements if you know them.</p><div class="voice-controls"><button id="record">● Record notes</button><span id="record-state" class="muted" role="status">Voice notes are saved online, then transcribed by your private Mac worker.</span></div><label>Notes<textarea id="transcript" rows="5" placeholder="Number 12. Material is agate. Price is 45 dollars. Condition: small chip on the back.">${esc(capture.transcript)}</textarea></label><div class="toolbar"><button class="primary" id="generate">Make my listing draft →</button><button id="save-capture">Save for later</button></div><p id="capture-save-state" class="save-state" aria-live="polite">${captureDirty ? 'Saving your work…' : 'Your photos and notes are saved as you work.'}</p></section><div><section class="panel"><p class="step">ONLY THREE FACTS TO START</p><h3>Keep it natural.</h3><p class="spoken-example">“Number 12. Material: agate. Price: 45 dollars. Condition: small chip on the back.”</p><p class="muted">A specimen number is optional; we create a unique inventory ID. Mention chips, cracks, repairs and treatments. Unknown origin or weight can stay blank.</p><p class="muted">Your website keeps the original file. Camera RAW, HEIC and TIFF files need a browser preview; the untouched original is always linked.</p></section><details class="panel"><summary>How your personal AI works</summary><p>It listens for labeled facts, applies your saved mineral vocabulary and builds a factual description. It does not guess mineral identity, origin, weight or condition from a photo.</p><p>If speech is unavailable, your audio stays saved and you can type the same three facts. There is no paid AI subscription built into this workflow.</p><button id="quick-ai">Edit my vocabulary →</button></details></div></div>`;
 bindPhotos($('#quick-photo-list'),capture.photos,'#quick-photo-list',changedCapture);
 $('#transcript').oninput = event => {capture.transcript = event.target.value; changedCapture();};
 $('#quick-photos').onchange = async event => {const input = event.target, files = [...input.files]; input.disabled = true; try {await uploadPhotos(files,capture.photos,text => {if($('#photo-progress')) $('#photo-progress').textContent = text;},() => {changedCapture(); if(view === 'quick'){ $('#quick-photo-list').innerHTML = photoHTML(capture.photos); bindPhotos($('#quick-photo-list'),capture.photos,'#quick-photo-list',changedCapture);}});} catch(error) {fail(error);} finally {if(input.isConnected){input.disabled = false; input.value = '';}}};
 $('#record').onclick = recordAudio;
 $('#save-capture').onclick = event => busy(event.target,async () => {await saveCapture(); toast('Capture saved online. You can return from any device.');},'Saving…');
 $('#quick-ai').onclick = () => go('ai');
 $('#generate').onclick = event => busy(event.target,async () => {
  if(recorder) throw Error('Stop your recording first. Wait for the transcript, then make the draft.');
  if(audioJob) throw Error('Your notes are still being transcribed. You can keep working while you wait.');
  if(uploading) throw Error('Wait for your files to finish uploading first.');
  if(!capture.photos.length && !capture.transcript.trim()) throw Error('Add a photo or a few notes first.');
  await saveCapture(); const result = await api('generate',{transcript:capture.transcript,photos:capture.photos,capture_id:capture.id});
  capture = {id:null,transcript:'',photos:[]}; captureDirty = false; captureRevision++; clearTimeout(saveTimer); await refresh(); quick(); toast('Draft saved. Check four facts and a photo.'); await openEditor(result.id);
 },'Building your draft…');
 if(recorder) updateRecordUI();
}
function updateRecordUI() {
 if(!$('#record')) return; const active = !!recorder;
 $('#record').classList.toggle('recording',active); $('#record').textContent = active ? '■ Stop recording' : '● Record notes';
 if(active) $('#record-state').textContent = 'Recording · ' + Math.floor((Date.now()-recordStarted)/1000) + 's · microphone on';
}
function stopAudio() {if(recorder && recorder.state !== 'inactive') recorder.stop(); recordStream?.getTracks().forEach(track => track.stop()); clearInterval(recordTimer); return recordCompletion || Promise.resolve();}
async function recordAudio() {
 if(recorder) {stopAudio(); return;}
 if(audioJob) {toast('Your previous recording is still being transcribed.');return;}
 try {
  if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw Error('Microphone recording needs a supported browser over HTTPS or localhost. Type your notes instead.');
  const stream = await navigator.mediaDevices.getUserMedia({audio:true}); recordStream = stream; if(view !== 'quick'){stream.getTracks().forEach(track => track.stop());return;}
  const chunks = [], mime = ['audio/mp4','audio/webm;codecs=opus','audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
  const rec = new MediaRecorder(stream,mime ? {mimeType:mime} : {}); recorder = rec; recordStarted = Date.now(); recordCompletion = new Promise(resolve => resolveRecording = resolve);
  rec.ondataavailable = event => {if(event.data.size) chunks.push(event.data);};
  rec.onstop = async () => {
   recorder = null; stream.getTracks().forEach(track => track.stop()); clearInterval(recordTimer); updateRecordUI();
   if(!chunks.length) {resolveRecording?.(); recordCompletion = null; return;}
   try {if($('#record-state')) $('#record-state').textContent = 'Saving your audio…'; const type = rec.mimeType; const file = new File(chunks,'voice-note.' + (type.includes('mp4') ? 'm4a' : 'webm'),{type}); const saved = await upload(file); const job = await api('jobs',{kind:'audio',media:saved.src,options:{request_speech_authorization:true}}); audioJob = job.id; try {sessionStorage.setItem('mm-audio-job',audioJob);} catch (_) {} if($('#record-state')) $('#record-state').textContent = 'Audio saved · transcribing on your Mac…'; toast('Audio saved. The transcript will be added to your capture.');} catch(error) {fail(error);} finally {resolveRecording?.(); recordCompletion = null; resolveRecording = null;}
  };
  rec.onerror = () => {stopAudio(); fail(Error('Recording stopped unexpectedly. You can type your notes.'));};
  rec.start(); updateRecordUI(); recordTimer = setInterval(updateRecordUI,1000);
 } catch(error) {recordStream?.getTracks().forEach(track => track.stop()); recorder = null; clearInterval(recordTimer); resolveRecording?.(); recordCompletion = null; resolveRecording = null; updateRecordUI(); fail(error);}
}
function video() {
 $('#content').innerHTML = `<p class="lead">One recording. One rock at a time. A separate draft, cover photo and video timestamp for each.</p><section class="panel film-guide"><p class="step">THE RECORDING RECIPE</p><ol class="capture-steps"><li><b>Start empty.</b><span>Keep the camera fixed. Show the empty workspace for at least 1.5 seconds.</span></li><li><b>Show one whole rock.</b><span>Keep it fully in frame for at least 2 seconds. Turn it slowly and hold still for a sharp photo.</span></li><li><b>Say three facts.</b><span>“Number 12. Material: agate. Price: 45 dollars. Condition: small chip on the back.”</span></li><li><b>Clear the frame.</b><span>Remove the rock and your hands completely. Leave the same empty workspace for at least 1.5 seconds before the next rock, and again at the end.</span></li></ol><details><summary>What else will it recognize?</summary><p><b>Optional labels:</b> “locality,” “weight” with a unit, “dimensions,” “finish” and “category.” Say a label before its value. Your saved vocabulary helps with mineral names. Use one specimen number per interval.</p><p>Keep narration inside that rock’s interval. Locality, weight and condition come from your words or your review. Hand movement and changing light can affect segment boundaries; you can correct them before listing.</p><p>Categories currently in your vocabulary: ${esc((prefs.categories || ['Agates','Geodes','Mineral Specimens','Rough & Lapidary']).join(', '))}.</p></details></section><div class="split-layout"><section class="panel"><p class="step">1 · RECORD OR CHOOSE A VIDEO</p><div class="capture-file-actions"><label class="upload"><b>Record with this device</b>Use the camera, then upload the recording.<input id="video-camera" type="file" accept="video/*" capture="environment"></label><label class="upload"><b>Choose an existing video</b>MP4 or MOV · up to 512 MB per file.<input id="video-file" type="file" accept="video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v"></label></div><p id="video-progress" class="muted" role="status">${videoState.src ? esc(videoState.name || 'Original recording saved') : 'Keep this page open while the file uploads.'}</p><div id="video-preview"></div><details class="advanced"><summary>Optional: scale, detection & transcript settings</summary><p class="roi-note">The defaults work with the recording recipe above. Change them only when correcting a difficult recording.</p><div class="field-grid"><label>Empty reference time (seconds)<input id="empty-ref" type="number" min="0" step="0.1" value="${videoState.empty}"></label><label>Difference threshold (0–1)<input id="threshold" type="number" min="0.005" max="1" step="0.005" value="${videoState.threshold}"></label><label>Minimum empty interval (seconds)<input id="min-empty" type="number" min="0.3" step="0.1" value="${videoState.minEmpty}"></label><label>Minimum specimen interval (seconds)<input id="min-specimen" type="number" min="0.5" step="0.1" value="${videoState.minSpecimen}"></label></div><button id="select-scale" ${videoState.src ? '' : 'disabled'}>Select scale display in preview</button><button id="clear-scale">Clear scale selection</button><p class="roi-note" id="roi-state">${videoState.roi ? 'Scale region selected. Any reading still needs your confirmation.' : 'Optional: pause on a scale reading, tap Select, then drag over the display.'}</p><label>Timestamped transcript (only if needed)<textarea id="cues" rows="3" placeholder='[{"start":2,"end":7,"text":"Number 12. Material agate. Price 45 dollars. Condition small chip."}]'>${esc(videoState.cues)}</textarea></label><p class="roi-note">Times are seconds in the original video. This is a fallback for unavailable speech, and untimed narration is never guessed across several rocks.</p></details><div class="toolbar"><button class="primary" id="process-video" ${!videoState.src || videoState.submittedJobID ? 'disabled' : ''}>${videoState.submittedJobID ? 'Video queued — progress below' : 'Make my listing drafts →'}</button>${videoState.src ? '<button id="clear-video">Choose a different recording</button>' : ''}</div></section><section class="panel"><p class="step">2 · LET YOUR MAC WORK</p><h3>Then review and list.</h3><p>The assistant splits the recording, reads your narration and saves a cover image and source timestamp for each rock. Your original video stays attached.</p><p class="muted">After upload and queueing, you can leave this screen. Your upload stays queued online until your Mac worker is available. Each draft has one short review before you publish to your selected stores.</p><p class="notice">The website keeps your full original files. Video frames are limited by the recording’s resolution; add a still photo when you want more detail.</p></section></div><div class="section-title"><h2>Processing & batch review</h2></div><div id="jobs" aria-live="polite"></div>`;
 if(videoState.src) paintVideoPreview(videoState.src);
 const chooseVideo = async event => {
  const file = event.target.files[0]; if(!file) return;
  const inputs = $$('#video-camera,#video-file'); inputs.forEach(input => input.disabled = true); $('#process-video').disabled = true;
  try {const saved = await upload(file,percent => {if($('#video-progress')) $('#video-progress').textContent = 'Uploading original · ' + percent + '%';}); videoState = {...videoState,src:saved.src,name:file.name,roi:null,submittedJobID:null}; rememberVideo(); if(view === 'video') video(); toast('Original recording saved. Ready to make your drafts.');} catch(error) {fail(error); if($('#video-progress')) $('#video-progress').textContent = 'Upload did not finish. Choose the file again to retry.';} finally {inputs.forEach(input => {if(input.isConnected){input.disabled = false; input.value = '';}}); if($('#process-video')) $('#process-video').disabled = !videoState.src || !!videoState.submittedJobID;}
 };
 $('#video-file').onchange = chooseVideo; $('#video-camera').onchange = chooseVideo;
 const updateVideoOptions = () => {videoState.empty = +$('#empty-ref').value; videoState.threshold = +$('#threshold').value; videoState.minEmpty = +$('#min-empty').value; videoState.minSpecimen = +$('#min-specimen').value; videoState.cues = $('#cues').value; rememberVideo();};
 $$('#empty-ref,#threshold,#min-empty,#min-specimen,#cues').forEach(input => input.oninput = updateVideoOptions);
 $('#select-scale').onclick = () => {const v = $('#roi-video'); if(!v) return; v.pause(); $('#video-region').classList.add('selecting'); $('#roi-state').textContent = 'Drag a rectangle over the scale display in the preview above.'; $('#video-region').scrollIntoView({behavior:'smooth',block:'center'});};
 $('#clear-scale').onclick = () => {videoState.roi = null; rememberVideo(); if($('#roi-box')) $('#roi-box').hidden = true; $('#roi-state').textContent = 'No scale region selected.';};
 if($('#clear-video')) $('#clear-video').onclick = () => {if(uploading){toast('Wait until the current upload finishes.');return;} videoState.src = null; videoState.name = ''; videoState.roi = null; videoState.submittedJobID = null; rememberVideo(); video();};
 $('#process-video').onclick = event => busy(event.target,async () => {
  updateVideoOptions(); let cues = [];
  if(videoState.cues.trim()) {try {cues = JSON.parse(videoState.cues);} catch (_) {throw Error('The optional transcript must be valid JSON. Clear it to use automatic speech recognition.');} if(!Array.isArray(cues)) throw Error('Timestamped transcript must be a list of time ranges.');}
  const roi = videoState.roi;
  const options = {empty_reference_time:videoState.empty,difference_threshold:videoState.threshold,min_empty_seconds:videoState.minEmpty,min_specimen_seconds:videoState.minSpecimen,transcript_cues:cues,scale_roi:roi ? [roi[0],roi[1],roi[2]-roi[0],roi[3]-roi[1]] : null,request_speech_authorization:true};
  const job = await api('jobs',{kind:'video',media:videoState.src,options}); videoState.submittedJobID = job.id; rememberVideo(); await refresh(); if(view === 'video') video(); toast('Video queued. Your Mac will keep processing while you use the Hub.');
 },'Queueing your video…');
 paintJobs();
}
function paintVideoPreview(src) {
 const target = $('#video-preview'); if(!target) return;
 target.innerHTML = `<div class="cropper" id="video-region"><video class="video-preview" id="roi-video" src="${esc(src)}" controls playsinline preload="metadata"></video><div class="crop-box" id="roi-box" hidden></div></div><a class="source-link" href="${esc(src)}" target="_blank" rel="noopener">Open original recording ↗</a>`;
 const wrap = $('#video-region'); let start = null;
 wrap.onpointerdown = event => {if(!wrap.classList.contains('selecting')) return; const rect = wrap.getBoundingClientRect(); start = [(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height]; wrap.setPointerCapture(event.pointerId); event.preventDefault();};
 wrap.onpointermove = event => {if(!start) return; const rect = wrap.getBoundingClientRect(), end = [Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))]; videoState.roi = [Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.max(start[0],end[0]),Math.max(start[1],end[1])]; paintBox($('#roi-box'),videoState.roi);};
 wrap.onpointerup = () => {if(!start) return; start = null; wrap.classList.remove('selecting'); const roi = videoState.roi; if(!roi || roi[2]-roi[0] < .02 || roi[3]-roi[1] < .02){videoState.roi = null; $('#roi-box').hidden = true; $('#roi-state').textContent = 'That selection is too small. Tap Select and drag again.';} else $('#roi-state').textContent = 'Scale region saved. Confirm any suggested weight during review.'; rememberVideo();};
 wrap.onpointercancel = () => {start = null; wrap.classList.remove('selecting');};
 if(videoState.roi) paintBox($('#roi-box'),videoState.roi);
}
function paintBox(element,box) {element.hidden = false; element.style.cssText = `left:${box[0]*100}%;top:${box[1]*100}%;width:${(box[2]-box[0])*100}%;height:${(box[3]-box[1])*100}%`;}
function paintJobs() {
 const target = $('#jobs'); if(!target) return;
 target.innerHTML = jobs.filter(job => job.kind === 'video').map(job => `<article class="job"><h3><span class="badge ${esc(job.status)}">${esc(job.status)}</span> ${esc(job.message || 'Video processing')}</h3><progress aria-label="Video processing progress" max="100" value="${job.progress || 0}"></progress>${job.status === 'failed' ? `<p class="error-text">Your original recording is saved. Check the error above, then retry.</p><button data-retry="${esc(job.id)}">Retry processing</button>` : ''}${job.result?.warnings?.length ? `<p>${esc(job.result.warnings.join(' · '))}</p>` : ''}${job.item_ids?.length ? `<div class="toolbar"><button data-batch="${esc(job.id)}" class="primary">Review batch (${job.item_ids.length}) →</button></div>` : ''}<a href="${esc(job.media)}" target="_blank" rel="noopener">Original recording ↗</a></article>`).join('') || '<div class="empty">Your videos and their progress will appear here.</div>';
 $$('[data-retry]',target).forEach(button => button.onclick = () => busy(button,async () => {await api('retry',{id:button.dataset.retry}); await refresh(); paintJobs();},'Retrying…'));
 $$('[data-batch]',target).forEach(button => button.onclick = () => {filter = 'batch:' + button.dataset.batch; search = ''; go('inventory');});
}
function updateSelection() {
 const target = $('#selected-count'); if(target) target.textContent = selected.size ? selected.size + ' selected' : 'Select records for batch actions';
 const approve = $('#approve-selected'), publish = $('#publish-selected'), merge = $('#merge-selected');
 if(approve) approve.disabled = !selected.size; if(publish) publish.disabled = !selected.size; if(merge) merge.disabled = selected.size !== 2;
}
function inventory() {
 const visible = items.filter(record => record.status !== 'archived' && (filter === 'all' || (filter.startsWith('batch:') ? record.video?.job_id === filter.slice(6) : record.status === filter)) && (!search || JSON.stringify([record.title,record.material,record.locality,record.specimen_number]).toLowerCase().includes(search.toLowerCase()))).reverse();
 $('#content').innerHTML = `<p class="lead">One record for each rock. Its photos, video and store listings stay together.</p><div class="toolbar inventory-search"><input id="search" type="search" aria-label="Search inventory" placeholder="Search number, material, locality…" value="${esc(search)}"><select id="filter" aria-label="Inventory status"><option value="all">All inventory</option>${['draft','imported','approved','published','sold'].map(status => `<option value="${status}" ${status === filter ? 'selected' : ''}>${status[0].toUpperCase()+status.slice(1)}</option>`).join('')}${filter.startsWith('batch:') ? `<option selected value="${esc(filter)}">This video batch</option>` : ''}</select><button id="new-item">＋ Add one</button></div><div class="selection-panel"><div class="toolbar"><span id="selected-count"></span><button id="approve-selected">Approve reviewed</button><button id="publish-selected">Publish approved</button><button id="merge-selected">Merge 2 segments</button><button id="clear-selection" class="quiet">Clear selection</button></div><p class="roi-note">Open each draft to confirm its facts and availability before using batch actions.</p></div><p class="muted">${visible.length} ${visible.length === 1 ? 'specimen' : 'specimens'} in this view</p><div class="records">${visible.map(record => recordHTML(record,true)).join('') || '<div class="empty">No specimens in this view. Add one, or change the filter.</div>'}</div><details class="panel export-panel"><summary>Backups & exports</summary><p>Download a complete backup before moving this workspace to another machine.</p><div class="toolbar"><a href="/api/seller/backup.zip" download>Full backup</a><a href="/api/seller/export.json" download>Inventory JSON</a><a href="/api/seller/export.csv" download>Inventory CSV</a></div></details>`;
 bindRecords(); updateSelection();
 $('#search').oninput = event => {search = event.target.value; const position = event.target.selectionStart; inventory(); $('#search').focus(); $('#search').setSelectionRange(position,position);};
 $('#filter').onchange = event => {filter = event.target.value; inventory();}; $('#new-item').onclick = () => go('quick');
 $('#clear-selection').onclick = () => {selected.clear(); inventory();};
 $('#approve-selected').onclick = event => busy(event.target,async () => {await api('approve-batch',{ids:[...selected]}); selected.clear(); await refresh(); inventory(); toast('Reviewed drafts approved. Ready to publish.');});
 $('#publish-selected').onclick = () => publishDialog([...selected]);
 $('#merge-selected').onclick = event => busy(event.target,async () => {await api('merge',{ids:[...selected]}); selected.clear(); await refresh(); inventory(); toast('Segments merged. Review the combined facts and photos.');});
}
function providerInfo(name) {const providers = connectionState.providers || connectionState.channels || connectionState; return providers[name] || {};}
function fieldsFor(provider) {
 const source = provider.required_fields || provider.setup_fields || provider.fields || [];
 if(Array.isArray(source)) return source.map(field => typeof field === 'string' ? {key:field,label:field.replaceAll('_',' ')} : field);
 return Object.entries(source).map(([key,value]) => typeof value === 'object' ? {key,...value} : {key,label:key.replaceAll('_',' '),value});
}
function connectionLabel(provider,name) {if(name === 'website') return provider.label || (provider.status === 'connected' ? 'Ready' : 'Local storefront'); if(provider.connected || ['connected','ready','active'].includes(provider.status)) return 'Connected'; if(provider.configured || ['authorization_required','needs_authorization','disconnected'].includes(provider.status)) return 'Sign in required'; return 'One-time setup needed';}
async function connections() {
 if(pageDirty && view === 'connections' && !await confirmLeavePage()) return;
 $('#content').innerHTML = '<p class="lead">Link your shops once. Use one inventory and one publishing review.</p><div class="panel" role="status">Checking your actual store connections…</div>';
 try {connectionState = await api('connections'); if(view !== 'connections') return; paintConnections();} catch(error) {if(view === 'connections'){$('#content').innerHTML = `<div class="panel"><h2>Could not load connections.</h2><p role="alert">${esc(error.message)}</p><button id="retry-connections">Try again</button></div>`; $('#retry-connections').onclick = connections;}}
}
function discoveredOptions(name,key) {
 const data = discoveries[name] || {};
 const mappings = {
  shipping_profile_id:['shipping_profiles','shipping_profile_id','title'],readiness_state_id:['processing_profiles','readiness_state_id','name'],
  fulfillment_policy_id:['fulfillment_policies','fulfillmentPolicyId','name'],payment_policy_id:['payment_policies','paymentPolicyId','name'],return_policy_id:['return_policies','returnPolicyId','name'],merchant_location_key:['inventory_locations','merchantLocationKey','name']
 };
 const mapping = mappings[key]; if(!mapping) return [];
 return (data[mapping[0]] || []).map(row => ({value:row[mapping[1]] ?? row.id,label:row[mapping[2]] || row.title || row.name || String(row[mapping[1]])})).filter(row => row.value != null);
}
function setupFieldHTML(name,provider,field) {
 const key = field.key || field.name, sensitive = field.secret || field.type === 'password' || /secret|token/i.test(key);
 const value = field.value ?? provider.setup?.[key] ?? '', options = discoveredOptions(name,key);
 const input = options.length ? `<select name="${esc(key)}"><option value="">Choose a saved ${esc(field.label || 'setting')}</option>${options.map(option => `<option value="${esc(option.value)}" ${String(value) === String(option.value) ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>` : `<input name="${esc(key)}" type="${sensitive ? 'password' : ['number','url','email'].includes(field.type) ? field.type : 'text'}" ${sensitive ? 'autocomplete="new-password" data-secret' : ''} value="${sensitive ? '' : esc(value)}" placeholder="${esc(field.placeholder || (sensitive && field.configured ? 'Saved securely — leave blank to keep' : ''))}" ${field.required && !field.configured ? 'required' : ''}>`;
 return `<label>${esc(field.label || key.replaceAll('_',' '))}${field.description ? `<span class="field-help">${esc(field.description)}</span>` : ''}${input}</label>`;
}
function paintConnections() {
 const sync = connectionState.sync || {}, credentialKeys = new Set(['client_id','shared_secret','client_secret','redirect_name','callback_url']);
 $('#content').innerHTML = `<p class="lead">Connect each shop once. Then review a specimen and publish it to your selected stores together.</p><p class="notice">Etsy and eBay need a registered developer app before seller sign in. Your AI runs locally without a paid AI subscription; marketplace listing, transaction and payment fees still apply.</p><div class="connection-grid">${['website','etsy','ebay'].map(name => {
  const provider = providerInfo(name), fields = fieldsFor(provider);
  if(name === 'website') return `<section class="panel connection-card"><div class="section-title"><h2>${channelNames[name]}</h2><span class="badge approved">Hosted storefront ready</span></div><p>${esc(provider.reason || 'Publishes from your shared cloud inventory.')}</p><a href="/">Open customer storefront ↗</a></section>`;
  const credentials = fields.filter(field => credentialKeys.has(field.key || field.name)), defaults = fields.filter(field => !credentialKeys.has(field.key || field.name));
  const credentialValues = Object.values(provider.credentials_configured || {}), authReady = credentialValues.length && credentialValues.every(Boolean) && !!provider.callback_url;
  const registration = safeURL(provider.setup_url || (name === 'etsy' ? 'https://www.etsy.com/developers/register' : 'https://developer.ebay.com/'));
  const docs = safeURL(provider.docs_url || registration);
  return `<section class="panel connection-card"><div class="section-title"><h2>${channelNames[name]}</h2><span class="badge ${provider.connected ? 'approved' : ''}">${esc(connectionLabel(provider,name))}</span></div><p>${esc(provider.reason || 'Configure this shop once to enable listing and stock updates.')}</p><div class="connection-steps"><details ${!authReady ? 'open' : ''}><summary>1 · Register your developer app ${authReady ? '✓' : ''}</summary><p>Use the marketplace’s developer portal to register an app for this Seller Hub. Your registered callback must be an exact reachable HTTPS address.</p><div class="toolbar"><a href="${esc(registration)}" target="_blank" rel="noopener">Register app ↗</a><a href="${esc(docs)}" target="_blank" rel="noopener">API setup guide ↗</a></div>${credentials.length ? `<form data-provider-setup="${name}">${credentials.map(field => setupFieldHTML(name,provider,field)).join('')}<button type="submit">Save app credentials</button><p class="inline-status" role="status"></p></form>` : `<p class="muted">App credentials stored privately online.</p>${provider.callback_url ? `<label>Registered callback URL<input readonly value="${esc(provider.callback_url)}"></label>` : ''}`}</details><div class="connection-stage"><p><b>2 · Sign in to your shop ${provider.connected ? '✓' : ''}</b></p><button class="primary" data-connect="${name}" ${!authReady && !provider.connected ? 'disabled' : ''}>${provider.connected ? 'Reconnect ' : 'Sign in to '}${channelNames[name]}</button>${!authReady && !provider.connected ? '<p class="roi-note">Save the app credentials and callback in step 1 first.</p>' : ''}<p class="inline-status" id="connect-status-${name}" role="status"></p></div><div class="connection-stage"><p><b>3 · Save shop defaults once ${provider.ready ? '✓' : ''}</b></p>${provider.connected ? `<button data-discover="${name}">Find my saved shipping & shop settings</button><p id="discover-status-${name}" class="inline-status" role="status"></p>${defaults.length ? `<form data-provider-setup="${name}"><p class="roi-note">Choose your existing profiles where available. Any remaining category or eligibility setting is saved once and reused for listings.</p>${defaults.map(field => setupFieldHTML(name,provider,field)).join('')}<button type="submit">Save shop defaults</button><p class="inline-status" role="status"></p></form>` : '<p class="muted">The server reports your required shop defaults are saved.</p>'}` : '<p class="muted">After sign in, the Hub can find saved shipping profiles and shop policies for you.</p>'}</div></div>${provider.last_sync?.checked_at ? `<p class="roi-note">Last stock check: ${esc(provider.last_sync.checked_at)}</p>` : ''}</section>`;
 }).join('')}</div><section class="panel"><p class="step">ONE INVENTORY · CURRENT SYNC STATUS</p><h3>${esc(sync.label || 'Stock synchronization')}</h3><p>${esc(sync.message || sync.reason || 'Stock updates require connected stores and order notifications or polling. Check any blocked channel after a sale.')}</p><p class="roi-note">A successful connection alone does not mean every specimen is published. Each listing and stock update reports its own result in Channel activity.</p><div class="toolbar"><button id="refresh-connections">Check sales & refresh</button><button id="connection-orders">Orders & channel activity →</button></div></section>`;
 $$('[data-connect]').forEach(button => button.onclick = () => busy(button,async () => {const provider = button.dataset.connect, result = await api('connections/start',{provider}); const url = safeURL(result.authorization_url || result.url); if(url){location.assign(url);return;} const status = $('#connect-status-'+provider); if(status) status.textContent = result.message || result.reason || 'Finish the developer app setup above before signing in.';},'Preparing secure sign in…'));
 $$('[data-provider-setup]').forEach(form => form.onsubmit = event => {event.preventDefault(); const fields = Object.fromEntries(new FormData(form).entries()); $$('[data-secret]',form).forEach(input => {if(!input.value) delete fields[input.name];}); const button = $('button[type=submit]',form); busy(button,async () => {const result = await api('connections/setup',{provider:form.dataset.providerSetup,fields}); connectionState = await api('connections'); if(view === 'connections') {pageDirty = false; paintConnections();} toast(result.message || 'Store setup saved. Continue with the next step.');},'Saving securely…');});
 $$('[data-discover]').forEach(button => button.onclick = () => busy(button,async () => {if(pageDirty && !await confirmLeavePage()) return; const name = button.dataset.discover; discoveries[name] = await api('connections/discover',{provider:name}); connectionState = await api('connections'); if(view === 'connections') paintConnections(); const count = Object.values(discoveries[name]).reduce((total,value) => total + (Array.isArray(value) ? value.length : 0),0); const status = $('#discover-status-'+name); if(status) status.textContent = count ? 'Found your saved settings. Choose them below and save once.' : 'No saved profiles were found. Create them in your marketplace account, then try again.';},'Finding your saved settings…'));
 const candidates = connectionState.existing_candidates || [], links = connectionState.links || [];
 if(candidates.length || links.length) {
  $('#content').insertAdjacentHTML('beforeend',`<details class="panel existing-links"><summary>Recovered marketplace listings · ${candidates.length} to verify · ${links.length} linked</summary><p>These matches come from your recovered catalog URLs. Verifying a link checks the authorized shop’s ownership and connects the same physical piece to this inventory. It does not publish a duplicate listing.</p>${['etsy','ebay'].map(name => {const list = candidates.filter(row => row.provider === name); if(!list.length) return ''; return `<section class="connection-stage"><h3>${channelNames[name]} · ${list.length} recovered ${list.length === 1 ? 'listing' : 'listings'}</h3><button data-link-existing="${name}" ${providerInfo(name).connected ? '' : 'disabled'}>Verify & link my ${channelNames[name]} listings</button><p class="roi-note">${providerInfo(name).connected ? 'Only listings confirmed by your authorized shop are linked.' : 'Connect this shop first. The recovered records stay private and unverified until you review them.'}</p><p class="inline-status" id="link-progress-${name}" role="status"></p><details><summary>See recovered matches</summary><ul>${list.map(row => `<li>${esc(items.find(item => item.id === row.item_id)?.title || row.item_id)} · <a href="${esc(safeURL(row.url))}" target="_blank" rel="noopener">${esc(row.listing_id)} ↗</a></li>`).join('')}</ul></details></section>`;}).join('')}${links.length ? `<p class="muted">${links.length} ${links.length === 1 ? 'listing is' : 'listings are'} already linked. Sale updates can match those records after synchronization is active.</p>` : ''}</details>`);
  $$('[data-link-existing]').forEach(button => button.onclick = () => busy(button,async () => {
   if(pageDirty && !await confirmLeavePage()) return;
   const name = button.dataset.linkExisting, list = candidates.filter(row => row.provider === name); let done = 0;
   for(const row of list) {$('#link-progress-'+name).textContent = `Verifying ${done+1} of ${list.length}…`; await api('connections/link',{provider:name,item_id:row.item_id,listing_id:row.listing_id}); done++;}
   connectionState = await api('connections'); if(view === 'connections') paintConnections(); toast(`${done} ${channelNames[name]} listings verified and linked.`);
  },'Verifying ownership…'));
 }
 $('#content').insertAdjacentHTML('afterbegin','<section class="panel" id="payment-settings"><h2>Website payments · Stripe</h2><p>Loading secure payment settings…</p></section>');loadPaymentSettings();
 $('#refresh-connections').onclick = event => busy(event.target,async()=>{await api('marketplace-tick',{});await refresh();await connections();toast('Sale check finished. Review each store’s status.');},'Checking sales…'); $('#connection-orders').onclick = () => go('orders');
}
async function openEditor(id,push = true) {
 if(editorOpening) return; if(editorDirty && editing?.id !== id && !await confirmLeaveEditor()) return;
 const found = items.find(record => record.id === id); if(!found){toast('That specimen is no longer available in this view.');return;}
 editorOpening = true;
 try {
  editing = structuredClone(found); editing.photos ||= []; const record = editing;
  if(push) history.pushState({},'',`#${view}/item/${id}`);
  const eligible = record.etsy_eligibility || prefs.default_etsy_eligibility || 'seller_made_altered';
  const isLocked = ['sold','reserved','archived'].includes(record.status);
  const reviewed = record.reviewed && record.stock_verified;
  $('#editor-body').innerHTML = `<div class="modal-head"><div><p class="eyebrow">SPECIMEN ${esc(record.specimen_number || record.id)}</p><h2 id="editor-title">Check it. Then list it.</h2></div><button id="close-editor" class="icon-button" aria-label="Close specimen review">×</button></div>${isLocked ? '<p class="notice">This specimen is sold, reserved or archived. Its saved record is protected.</p>' : ''}${record.warnings?.length ? `<p class="notice">${esc(record.warnings.join(' · '))}</p>` : ''}${record.weight_candidate ? `<p class="notice">Scale suggestion: ${esc(record.weight_candidate.value)} ${esc(record.weight_candidate.unit)}. Confirm the original display before adding a weight.</p>` : ''}<div id="media-review-state" role="status" hidden></div><div class="split-layout"><section><div class="photos" id="edit-photos">${photoHTML(record.photos)}</div><div id="media-candidates"></div>${!isLocked ? `<label class="upload small-upload"><b>Add photos</b>Full originals are kept.<input id="e-add-photos" type="file" accept="${photoAccept}" multiple></label><p id="edit-upload-state" class="muted" aria-live="polite"></p>` : ''}${record.video ? `<div class="source-video"><video class="video-preview" id="segment-video" src="${esc(record.video.original)}#t=${record.video.start},${record.video.end}" controls playsinline preload="metadata"></video><p class="roi-note">This specimen starts at <b>${formatTime(record.video.start)}</b> in your original recording.</p><details><summary>Adjust video segment</summary><div class="field-grid"><label>Start (seconds)<input id="e-start" type="number" min="0" step="0.1" value="${record.video.start}" ${isLocked ? 'disabled' : ''}></label><label>End (seconds)<input id="e-end" type="number" min="0" step="0.1" value="${record.video.end}" ${isLocked ? 'disabled' : ''}></label></div><div class="toolbar"><a href="${esc(record.video.original)}" target="_blank" rel="noopener">Full private original ↗</a>${record.video.clip ? `<a href="${esc(record.video.clip)}" target="_blank" rel="noopener">Specimen clip ↗</a>` : ''}${!isLocked ? '<button id="split-segment">Split at playhead</button>' : ''}</div><p class="roi-note">Only this specimen’s clip may appear publicly. Your full batch recording stays private.</p></details></div>` : ''}</section><section><p class="step">THE LISTING FACTS</p><div class="field-grid essential-fields"><label>Specimen number<input id="e-number" value="${esc(record.specimen_number)}" placeholder="12" ${isLocked ? 'disabled' : ''}></label><label>Price · USD<input id="e-price" inputmode="decimal" type="number" min="0.01" step="0.01" value="${record.price_cents == null ? '' : record.price_cents/100}" ${isLocked ? 'disabled' : ''}></label><label class="wide">Material<input id="e-material" value="${esc(record.material)}" placeholder="Your known mineral or material" ${isLocked ? 'disabled' : ''}></label><label class="wide">Condition & disclosures<textarea id="e-condition" rows="3" placeholder="Describe chips, cracks, repairs, treatments or the condition you observed." ${isLocked ? 'disabled' : ''}>${esc(record.condition)}</textarea></label></div><details class="advanced"><summary>Optional details & title</summary><label>Listing title<input id="e-title" value="${esc(record.title)}" ${isLocked ? 'disabled' : ''}></label><div class="field-grid"><label class="wide">Verified locality<input id="e-locality" value="${esc(record.locality)}" ${isLocked ? 'disabled' : ''}></label><label>Weight with unit<input id="e-weight" value="${esc(record.weight)}" ${isLocked ? 'disabled' : ''}></label><label>Finish<input id="e-finish" value="${esc(record.finish)}" ${isLocked ? 'disabled' : ''}></label><label class="wide">Measured dimensions<input id="e-dimensions" value="${esc(record.dimensions || record.size || '')}" ${isLocked ? 'disabled' : ''}></label><label class="wide">Category<input id="e-category" value="${esc(record.category || record.form || '')}" ${isLocked ? 'disabled' : ''}></label><label class="wide">Etsy eligibility<select id="e-etsy-eligibility" ${isLocked ? 'disabled' : ''}><option value="seller_made_altered" ${eligible === 'seller_made_altered' ? 'selected' : ''}>I cut, polish or make this piece</option><option value="seller_made" ${eligible === 'seller_made' ? 'selected' : ''}>I made this piece</option><option value="craft_supply" ${eligible === 'craft_supply' ? 'selected' : ''}>A qualifying craft supply</option><option value="personally_found_natural" ${eligible === 'personally_found_natural' ? 'selected' : ''}>A natural item I personally found</option><option value="documented_vintage" ${eligible === 'documented_vintage' ? 'selected' : ''}>A documented vintage item</option><option value="not_eligible" ${eligible === 'not_eligible' ? 'selected' : ''}>Not eligible for Etsy</option></select></label><label class="wide">Vintage evidence · only for a vintage claim<input id="e-vintage-evidence" value="${esc(record.vintage_evidence || '')}" ${isLocked ? 'disabled' : ''} placeholder="Documented item age and source"></label></div><p class="roi-note">Use the handmade preset only for pieces you personally make or alter. Other Etsy categories need their own eligibility and setup.</p></details></section></div><section class="draft-preview"><div class="section-title"><h3>Your listing draft</h3><div class="tab-buttons" role="group" aria-label="Channel draft"><button data-channel="website">Website</button><button data-channel="etsy">Etsy</button><button data-channel="ebay">eBay</button></div></div><div id="channel-draft"></div><p class="roi-note">Saving refreshes the draft from your facts. Every stated defect stays attached to the specimen.</p></section><details class="advanced"><summary>Original notes & source record</summary>${record.source === 'existing_catalog' ? `<p class="listing-pre">${esc(record.legacy?.description || '')}</p>` : ''}<label>Your narration<textarea id="e-transcript" rows="5" ${isLocked ? 'disabled' : ''}>${esc(record.transcript || record.notes || '')}</textarea></label>${!isLocked ? '<button id="reparse">Read facts from corrected narration</button>' : ''}<button id="download-listings">Download all channel drafts</button></details>${!isLocked ? `<section class="publish-section"><p class="step">PUBLISH TO</p><div class="channel-choices">${['website','etsy','ebay'].map(name => `<label><input type="checkbox" data-publish-channel="${name}" ${(connectionState.default_channels || ['website','etsy','ebay']).includes(name) ? 'checked' : ''}>${channelNames[name]}<small>${esc(connectionLabel(providerInfo(name),name))}</small></label>`).join('')}</div><div class="checks"><label><input type="checkbox" id="e-reviewed" ${reviewed && (!['seller_made_altered','seller_made'].includes(eligible) || record.seller_work_confirmed) ? 'checked' : ''}><span id="review-label"></span></label></div><p id="editor-error" class="error-text" role="alert"></p><div class="sticky-actions"><button id="save-item">Save draft</button><button class="primary" id="approve-publish">Approve & publish →</button><span id="editor-save-state" class="muted">Saved specimen · ${esc(record.status)}${record.sale_platform ? ' · Sold on '+esc(channelNames[record.sale_platform]||record.sale_platform) : ''}</span></div></section>` : ''}${!isLocked ? `<details class="advanced sale-details"><summary>Record a sale made elsewhere</summary><p class="notice">Record the exact piece as sold. Connected stores receive stock removal jobs; check any blocked channel shown afterward.</p><label>Sale platform<select id="sale-platform"><option value="etsy">Etsy</option><option value="ebay">eBay</option><option value="cash">Cash / show</option><option value="other">Other</option></select></label><label>Actual sale amount · USD<input id="sale-total" type="number" inputmode="decimal" min="0.01" step="0.01" value="${record.price_cents == null ? '' : record.price_cents/100}"></label><label>Order reference (optional)<input id="sale-reference"></label><button id="record-sale">Record sale & update inventory</button></details>` : ''}<div class="toolbar review-navigation" id="review-navigation"></div>`;
  const dialog = $('#editor'); if(!dialog.open) dialog.showModal();
  $('#close-editor').onclick = requestCloseEditor;
  dialog.oncancel = event => {event.preventDefault(); requestCloseEditor();};
  dialog.onclose = () => {$$('video',dialog).forEach(video => video.pause());};
  if(isLocked) $$('.photo-tools button',dialog).forEach(button => button.disabled = true);
  showChannel('website'); $$('[data-channel]',dialog).forEach(button => button.onclick = () => showChannel(button.dataset.channel));
  $('#download-listings').onclick = () => download('mineral-murals-'+record.id+'.json',JSON.stringify(editing.listings,null,2),'application/json');
  if(!isLocked) {
   bindPhotos($('#edit-photos'),editing.photos,'#edit-photos',markEditorPhotosDirty);
   $('#e-add-photos').onchange = async event => {const input = event.target, files = [...input.files]; input.disabled = true; try {await uploadPhotos(files,editing.photos,text => {if($('#edit-upload-state')) $('#edit-upload-state').textContent = text;},() => {markEditorPhotosDirty(); $('#edit-photos').innerHTML = photoHTML(editing.photos); bindPhotos($('#edit-photos'),editing.photos,'#edit-photos',markEditorPhotosDirty);});} catch(error){fail(error);} finally {if(input.isConnected){input.disabled = false; input.value = '';}}};
   $('#save-item').onclick = event => busy(event.target,async () => {await persistEditor({},true); toast('Draft saved. Come back whenever you’re ready.');},'Saving…');
   $('#approve-publish').onclick = event => busy(event.target,async () => {
    const channels = $$('[data-publish-channel]:checked',dialog).map(box => box.dataset.publishChannel);
    if(!channels.length) throw Error('Choose at least one store, or save the draft for later.');
    if(editing.media_pending) throw Error('Wait for the updated video frames, then load and review them before publishing.');
    validateEditor(); const saved = await persistEditor({approve:true},false); await publishDialog([saved.id],channels,true);
   },'Saving reviewed listing…');
   $('#reparse').onclick = event => busy(event.target,async () => {await persistEditor({reparse:true,regenerate:true},true); toast('Narration read again. Check the extracted facts.');},'Reading your notes…');
   $('#record-sale').onclick = event => busy(event.target,async () => {
    if(editorDirty && !await confirmLeaveEditor()) return;
    const total = Math.round(Number($('#sale-total').value)*100); if(!total || total < 1) throw Error('Enter the actual sale amount.');
    await api('sale',{id:record.id,platform:$('#sale-platform').value,total_cents:total,reference:$('#sale-reference').value}); editorDirty = false; await refresh(); $('#editor').close(); editing = null; await go('orders'); toast('Sale recorded. Review the channel activity for any stock update that needs attention.');
   },'Recording sale…');
   if($('#split-segment')) $('#split-segment').onclick = event => busy(event.target,async () => {if(editorDirty && !await confirmLeaveEditor()) return; await api('split',{id:record.id,at:$('#segment-video').currentTime}); editorDirty = false; await refresh(); $('#editor').close(); editing = null; await go('inventory'); toast('Split into two drafts. Review each rock’s notes and cover photo.');});
   $$('input,textarea,select',dialog).forEach(input => {if(input.matches('[data-publish-channel]')) input.onchange = () => updateReviewLabel(true); else input.addEventListener('input',markEditorDirty);});
   $('#e-etsy-eligibility').onchange = () => {$('#e-reviewed').checked = false; markEditorDirty(); updateReviewLabel();};
   updateReviewLabel();
  }
  if($('#segment-video')) {const video = $('#segment-video'); video.addEventListener('loadedmetadata',() => video.currentTime = record.video.start,{once:true}); video.ontimeupdate = () => {if(video.currentTime > record.video.end){video.pause(); video.currentTime = record.video.end;}};}
  const related = record.video ? items.filter(item => item.video?.job_id === record.video.job_id && item.status !== 'archived') : [];
  const index = related.findIndex(item => item.id === id);
  if(related.length > 1) {$('#review-navigation').innerHTML = `<button id="previous-item" ${index <= 0 ? 'disabled' : ''}>← Previous rock</button><span class="muted">${index+1} of ${related.length} in this recording</span><button id="next-item" ${index >= related.length-1 ? 'disabled' : ''}>Next rock →</button>`; $('#previous-item').onclick = () => openEditor(related[index-1].id); $('#next-item').onclick = () => openEditor(related[index+1].id);}
  editorDirty = false; editorPhotosDirty = false; latestMediaRecord = null; paintMediaReview();
 } finally {editorOpening = false;}
}
function paintMediaReview() {
 if(!editing || !$('#media-review-state')) return;
 const status = $('#media-review-state'), pending = !!editing.media_pending;
 status.hidden = !pending; status.className = 'notice';
 if(pending && latestMediaRecord) {status.innerHTML = '<b>Updated video frames are ready.</b><p>Your open facts are still here. Load the updated media, check the cover and confirm your review again.</p><button id="load-updated-media">Load updated media</button>'; $('#load-updated-media').onclick = loadUpdatedMedia;}
 else if(pending) status.innerHTML = '<b>Updating this video segment…</b><p>You can keep editing the facts. Wait for the refreshed photos and clip before approving this specimen.</p>';
 if($('#approve-publish')) $('#approve-publish').disabled = pending;
 const candidates = editing.candidate_photos || [], panel = $('#media-candidates');
 if(!panel) return;
 panel.innerHTML = candidates.length ? `<details class="advanced"><summary>New video frame choices (${candidates.length})</summary><p class="roi-note">Your current photo choices were kept. These frames came from the corrected segment.</p><div class="photos">${candidates.map((photo,index) => `<div class="photo"><a href="${esc(photo.original || photo.src)}" target="_blank" rel="noopener"><img src="${esc(photo.src)}" alt="New video frame ${index+1}"></a></div>`).join('')}</div><button id="use-video-frames">Use these video frames</button></details>` : '';
 if($('#use-video-frames')) $('#use-video-frames').onclick = () => {editing.photos = structuredClone(candidates); editing.candidate_photos = []; editing.clear_candidate_photos = true; $('#edit-photos').innerHTML = photoHTML(editing.photos); bindPhotos($('#edit-photos'),editing.photos,'#edit-photos',markEditorPhotosDirty); $('#e-reviewed').checked = false; markEditorPhotosDirty(); paintMediaReview();};
}
function loadUpdatedMedia() {
 const fresh = latestMediaRecord; if(!fresh || fresh.id !== editing?.id) return;
 const factKeys = ['title','material','specimen_number','price_cents','condition','locality','weight','finish','dimensions','category','status'];
 if(factKeys.some(key => JSON.stringify(fresh[key]) !== JSON.stringify(editing[key]))) {fail(Error('This specimen also changed elsewhere. Keep a copy of your open notes, then close and reopen it to review the latest saved record.'));return;}
 if(editorPhotosDirty) editing.candidate_photos = structuredClone(fresh.candidate_photos?.length ? fresh.candidate_photos : fresh.photos || []);
 else {editing.photos = structuredClone(fresh.photos || []); editing.candidate_photos = structuredClone(fresh.candidate_photos || []); $('#edit-photos').innerHTML = photoHTML(editing.photos); bindPhotos($('#edit-photos'),editing.photos,'#edit-photos',markEditorPhotosDirty);}
 editing.version = fresh.version; editing.media_pending = false; editing.video = structuredClone(fresh.video); latestMediaRecord = null;
 if($('#e-reviewed')) $('#e-reviewed').checked = false; markEditorDirty(); paintMediaReview(); toast('Updated media loaded. Your open fact edits are preserved.');
}
function formatTime(seconds) {const n = Math.floor(Number(seconds)||0); return Math.floor(n/60) + ':' + String(n%60).padStart(2,'0');}
function markEditorPhotosDirty() {editorPhotosDirty = true; markEditorDirty();}
function markEditorDirty() {editorDirty = true; if($('#editor-save-state')) $('#editor-save-state').textContent = 'Unsaved changes';}
function updateReviewLabel(clear = false) {
 const label = $('#review-label'); if(!label) return;
 const etsy = $('[data-publish-channel="etsy"]')?.checked, ownWork = ['seller_made_altered','seller_made'].includes($('#e-etsy-eligibility').value);
 label.textContent = etsy && ownWork ? 'I checked the facts, photos and stock, and I personally cut, polished or made this piece for my Etsy handmade listing.' : 'I checked the facts and photos, and this exact specimen is in stock.';
 if(clear) {$('#e-reviewed').checked = false; markEditorDirty();}
}
function validateEditor() {
 const required = [['e-number','Add a specimen number so this exact piece can be tracked.'],['e-material','Add the material or mineral identity you know.'],['e-price','Add an asking price.'],['e-condition','Add the condition you observed, including any defects.']];
 for(const [id,message] of required) if(!$('#'+id).value.trim()){ $('#editor-error').textContent = message; $('#'+id).focus(); throw Error(message);}
 if(!editing.photos.some(photo => !photo.preview_only)) throw Error('Add at least one usable photograph before publishing. A saved RAW placeholder needs a JPEG or supported conversion.');
 if(!$('#e-reviewed').checked) {$('#editor-error').textContent = 'Check the review confirmation before publishing.'; $('#e-reviewed').focus(); throw Error('Review the specimen and confirm the facts and stock.');}
}
function editorPayload(extra = {}) {
 const value = id => $('#'+id)?.value || '', price = value('e-price');
 const etsySelected = $('[data-publish-channel="etsy"]')?.checked, reviewed = $('#e-reviewed')?.checked || false, eligibility = value('e-etsy-eligibility');
 const body = {id:editing.id,version:editing.version,specimen_number:value('e-number'),title:value('e-title'),price_cents:price === '' ? null : Math.round(Number(price)*100),material:value('e-material'),locality:value('e-locality'),weight:value('e-weight'),finish:value('e-finish'),dimensions:value('e-dimensions'),category:value('e-category'),condition:value('e-condition'),transcript:value('e-transcript'),photos:editing.photos,clear_candidate_photos:!!editing.clear_candidate_photos,reviewed,stock_verified:reviewed,etsy_eligibility:eligibility,vintage_evidence:value('e-vintage-evidence'),seller_work_confirmed:!!(reviewed && etsySelected && ['seller_made_altered','seller_made'].includes(eligibility)),...extra};
 if(editing.video) {const start = +value('e-start'),end = +value('e-end'); if(start !== editing.video.start || end !== editing.video.end) body.video = {start,end};}
 return body;
}
async function persistEditor(extra = {},reopen = false) {
 if(uploading) throw Error('Wait for your photographs to finish uploading before saving.');
 const saved = await api('items',editorPayload(extra),'PATCH'); editorDirty = false; editing = structuredClone(saved); await refresh();
 if(reopen) {await openEditor(saved.id,false);} else {if($('#editor-save-state')) $('#editor-save-state').textContent = 'Reviewed listing saved';}
 return saved;
}
async function confirmLeaveEditor() {
 if(!editorDirty) return true;
 const choice = await choiceDialog('Keep your changes?', 'This specimen has changes that have not been saved.',[{value:'save',label:'Save draft',primary:true},{value:'stay',label:'Keep editing'},{value:'discard',label:'Discard changes'}]);
 if(choice === 'stay') return false;
 if(choice === 'discard') {editorDirty = false; return true;}
 try {await persistEditor({},false); return true;} catch(error) {fail(error);return false;}
}
async function requestCloseEditor() {
 if(uploading){fail(Error('Wait for your photographs to finish saving before leaving this specimen.'));return;}
 if(!await confirmLeaveEditor()) return;
 $('#editor').close(); editorDirty = false; editing = null; history.replaceState({},'',`#${view}`);
 if(view === 'inventory' || view === 'home') render();
}
function choiceDialog(title,message,choices) {
 return new Promise(resolve => {const dialog = document.createElement('dialog'); dialog.className = 'decision-dialog'; dialog.setAttribute('aria-label',title); dialog.innerHTML = `<h2>${esc(title)}</h2><p>${esc(message)}</p><div class="toolbar">${choices.map(choice => `<button data-choice="${esc(choice.value)}" ${choice.primary ? 'class="primary"' : ''}>${esc(choice.label)}</button>`).join('')}</div>`; document.body.append(dialog); const finish = value => {dialog.close(); dialog.remove(); resolve(value);}; $$('[data-choice]',dialog).forEach(button => button.onclick = () => finish(button.dataset.choice)); dialog.oncancel = event => {event.preventDefault(); finish('stay');}; dialog.showModal();});
}
function showChannel(channel) {
 const draft = editing.listings?.[channel], target = $('#channel-draft');
 $$('[data-channel]',$('#editor')).forEach(button => {button.classList.toggle('active',button.dataset.channel === channel); button.setAttribute('aria-pressed',String(button.dataset.channel === channel));});
 if(!draft){target.innerHTML = '<p class="muted">Save your facts to generate this store’s draft.</p>';return;}
 target.innerHTML = `<h3>${esc(draft.title || editing.title)}</h3><p class="preview-price">${money(draft.price_cents ?? editing.price_cents)}</p><div class="description-preview">${esc(draft.description || editing.description || 'Save the facts to generate a description.')}</div>${draft.tags?.length ? `<p class="roi-note">Tags: ${esc(draft.tags.join(', '))}</p>` : ''}${draft.warnings?.length ? `<p class="notice">${esc(draft.warnings.join(' · '))}</p>` : ''}<details><summary>Store-specific details</summary><pre class="listing-pre">${esc(JSON.stringify(draft,null,2))}</pre></details>`;
}
async function publishDialog(ids,channels = null,immediate = false) {
 const records = ids.map(id => items.find(record => record.id === id)).filter(Boolean);
 if(!records.length){toast('Select at least one approved specimen first.');return;}
 if(records.some(record => record.media_pending)){toast('Wait for updated video frames and review them before publishing.');return;}
 if(records.some(record => !['approved','published'].includes(record.status))){toast('Review and approve each selected specimen before publishing.');return;}
 const dialog = document.createElement('dialog'); dialog.className = 'publish-dialog'; dialog.setAttribute('aria-label','Publish to your stores');
 const defaults = channels || connectionState.default_channels || ['website','etsy','ebay'];
 dialog.innerHTML = `<div class="modal-head"><div><p class="eyebrow">ONE INVENTORY</p><h2>Publish ${ids.length === 1 ? 'this specimen' : ids.length + ' specimens'}</h2></div><button data-close class="icon-button" aria-label="Close publishing">×</button></div><p>Each store reports its own result. A store that needs setup will stay blocked until you connect it.</p><div class="channel-choices">${['website','etsy','ebay'].map(name => `<label><input type="checkbox" data-channel-choice="${name}" ${defaults.includes(name) ? 'checked' : ''}>${channelNames[name]}<small>${esc(connectionLabel(providerInfo(name),name))}</small></label>`).join('')}</div><button class="primary" data-publish>Publish to selected stores →</button><div class="publish-results" aria-live="polite"></div><div class="toolbar" data-after hidden><button data-setup>Connections & setup →</button><button data-activity>Channel activity →</button><button data-done>Done</button></div>`;
 document.body.append(dialog); dialog.showModal(); let active = false;
 const close = () => {if(active){toast('Publishing is being queued. Wait for the result before closing.');return;} dialog.close(); dialog.remove(); if(view === 'inventory' || view === 'home') render();};
 $('[data-close]',dialog).onclick = close; dialog.oncancel = event => {event.preventDefault(); close();};
 $('[data-setup]',dialog).onclick = async () => {close(); await requestCloseEditor(); go('connections');}; $('[data-activity]',dialog).onclick = async () => {close(); await requestCloseEditor(); go('orders');}; $('[data-done]',dialog).onclick = close;
 const run = async () => {
  const chosen = $$('[data-channel-choice]:checked',dialog).map(input => input.dataset.channelChoice);
  if(!chosen.length) throw Error('Choose at least one store.'); active = true;
  try {const result = await api('publish-all',{ids,channels:chosen}); await refresh(); selected.clear(); const results = result.results || (Array.isArray(result) ? result : []);
   $('.publish-results',dialog).innerHTML = `<h3>Publishing results</h3>${results.length ? results.map(row => `<div class="publish-result"><b>${esc(channelNames[row.channel] || row.channel || row.provider || 'Store')}</b><span class="badge ${esc(row.status)}">${esc(row.status || 'queued')}</span><p>${esc(row.message || row.reason || 'Check channel activity for the final result.')}</p></div>`).join('') : `<p>${esc(result.message || 'Requests saved. Check channel activity for each store’s result.')}</p>`}<p class="roi-note">Queued means the request is saved. Only a confirmed published result means a listing is live on that store.</p>`;
   $('[data-after]',dialog).hidden = false; $('[data-publish]',dialog).hidden = true; $$('[data-channel-choice]',dialog).forEach(input => input.disabled = true);
  } finally {active = false;}
 };
 $('[data-publish]',dialog).onclick = event => busy(event.target,run,'Publishing…');
 if(immediate) await busy($('[data-publish]',dialog),run,'Publishing…');
}
function download(name,text,type) {const url = URL.createObjectURL(new Blob([text],{type})); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url),5000);}
function crop(list,index,onSave) {
 const original = list[index]; const dialog = document.createElement('dialog'); dialog.className = 'crop-dialog'; dialog.setAttribute('aria-label','Crop specimen photograph');
 dialog.innerHTML = `<div class="modal-head"><h2>Crop photograph</h2><button data-close class="icon-button" aria-label="Close crop tool">×</button></div><p>Drag a rectangle around the whole specimen. Leave a small margin.</p><div class="cropper selecting"><img src="${esc(original.src)}" alt="Photograph to crop" draggable="false"><div class="crop-box" hidden></div></div><p class="roi-note">Your original file is kept. No color or lighting adjustments are applied.</p><div class="toolbar"><button class="primary" data-save>Use crop</button><button data-reset>Reset selection</button><button data-cancel>Cancel</button></div>`;
 document.body.append(dialog); dialog.showModal(); dialog.onclose = () => dialog.remove(); $('[data-close]',dialog).onclick = () => dialog.close(); $('[data-cancel]',dialog).onclick = () => dialog.close();
 let start = null, box = null; const wrap = $('.cropper',dialog);
 wrap.onpointerdown = event => {const rect = wrap.getBoundingClientRect(); start = [(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height]; wrap.setPointerCapture(event.pointerId); event.preventDefault();};
 wrap.onpointermove = event => {if(!start) return; const rect = wrap.getBoundingClientRect(),end = [Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))]; box = [Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.max(start[0],end[0]),Math.max(start[1],end[1])]; paintBox($('.crop-box',dialog),box);};
 wrap.onpointerup = () => start = null; wrap.onpointercancel = () => start = null;
 $('[data-reset]',dialog).onclick = () => {box = null; $('.crop-box',dialog).hidden = true;};
 $('[data-save]',dialog).onclick = event => busy(event.target,async () => {if(!box || box[2]-box[0] < .03 || box[3]-box[1] < .03) throw Error('Draw a larger crop around the specimen first.'); const decoded=await createImageBitmap(await fetch(original.src).then(r=>r.blob()));const c=document.createElement('canvas');c.width=Math.round((box[2]-box[0])*decoded.width);c.height=Math.round((box[3]-box[1])*decoded.height);c.getContext('2d').drawImage(decoded,Math.round(box[0]*decoded.width),Math.round(box[1]*decoded.height),c.width,c.height,0,0,c.width,c.height);decoded.close();const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));if(!blob)throw Error('This device could not create the crop. The original is unchanged.');const result=await upload(new File([blob],'crop.png',{type:'image/png'}),null,{role:'display',original:original.original||original.src,w:c.width,h:c.height}); list[index] = {...original,...result,original:original.original || original.src}; onSave(); dialog.close();},'Saving crop…');
}
async function ai() {
 const corrections = Object.entries(prefs.corrections || {}).map(([heard,fixed]) => heard + ' → ' + fixed).join('\n');
 $('#content').innerHTML = `<p class="lead">Your mineral vocabulary and writing preferences. Facts still come from you; your assistant organizes them into a listing.</p><div class="split-layout"><section class="panel settings"><p class="step">YOUR PERSONAL ASSISTANT</p><h2>Make it sound like your shop.</h2><label>Material names · one per line<textarea id="terms" rows="5">${esc((prefs.terminology || []).map(term => typeof term === 'string' ? term : JSON.stringify(term)).join('\n'))}</textarea></label><label>Known locality names · optional<textarea id="localities" rows="3">${esc((prefs.localities || []).map(term => typeof term === 'string' ? term : JSON.stringify(term)).join('\n'))}</textarea></label><p class="roi-note">A saved name helps match your words. It never assigns an origin to an unnamed specimen.</p><label>Recurring speech corrections<textarea id="corrections" rows="3" placeholder="What it hears → what you mean">${esc(corrections)}</textarea></label><p class="roi-note">One correction per line: the words it hears, an arrow →, then the correct name.</p><label>Description style<input id="ai-tone" value="${esc(prefs.style?.tone || '')}"></label><label>Shipping note · reused for future drafts<textarea id="shipping-note" rows="2">${esc(prefs.shipping?.note || '')}</textarea></label><details><summary>Advanced reference settings</summary><label>Complete settings · JSON<textarea id="all-settings" class="code" rows="16">${esc(JSON.stringify(prefs,null,2))}</textarea></label><p class="roi-note">Prices do not change when you save your writing preferences. Existing listings keep their reviewed facts.</p></details><button class="primary" id="save-settings">Save my preferences</button></section><div><section class="panel"><p class="step">ONLINE WORKSPACE · PRIVATE AI WORKER</p><h3>Local, with no AI subscription.</h3><div id="capabilities" role="status">Checking your actual processing tools…</div><p class="muted">Your saved vocabulary and structured facts keep descriptions grounded. An available local language model can improve phrasing. No paid cloud inference is required.</p><p class="roi-note">Microphone permission is requested when you record. Local speech uses language assets already installed on your Mac; typing stays available if speech is unavailable.</p></section><section class="panel"><p class="step">APP ON YOUR HOME SCREEN</p><h3>Open straight to the Hub.</h3><ol><li>Open the reachable Seller Hub address in Safari on your iPhone.</li><li>Tap Share, then <b>Add to Home Screen</b>.</li><li>Open Seller Hub from its icon and sign in.</li></ol><p class="roi-note">This hosted HTTPS address works away from your Mac. Your inventory, uploads and drafts stay online. Your Mac is only the private AI processor.</p><p class="roi-note">When you’re offline, keep open work on screen. Uploading, saving and publishing need an internet connection.</p></section><section class="panel"><h3>Private access</h3><p>Your owner account protects the Seller Hub. Customer pages do not require an account.</p><div class="toolbar"><button id="ai-connections">Store connections →</button><button id="ai-logout">Sign out</button></div></section></div></div>`;
 $('#save-settings').onclick = event => busy(event.target,async () => {
  let settings; try {settings = JSON.parse($('#all-settings').value);} catch (_) {throw Error('Advanced reference settings must be valid JSON.');}
  settings.terminology = $('#terms').value.split('\n').map(line => line.trim()).filter(Boolean); settings.localities = $('#localities').value.split('\n').map(line => line.trim()).filter(Boolean);
  settings.corrections = {}; for(const line of $('#corrections').value.split('\n').filter(line => line.trim())) {const parts = line.split(/\s*(?:→|=>|->)\s*/); if(parts.length !== 2 || !parts.every(part => part.trim())) throw Error('Use one correction per line, like: heard words → correct mineral.'); settings.corrections[parts[0].trim()] = parts[1].trim();}
  settings.style = {...settings.style,tone:$('#ai-tone').value}; settings.shipping = {...settings.shipping,note:$('#shipping-note').value}; prefs = await api('settings',settings); pageDirty = false; toast('Preferences saved for your next listing drafts.'); ai();
 },'Saving preferences…');
 $('#ai-connections').onclick = () => go('connections'); $('#ai-logout').onclick = logout;
 try {const status = await api('status'); serverStatus = status; if(view !== 'ai') return; const media = status.media || {}, speech = media.speech || {}, generation = status.ai || status.foundation_models || status.local_ai || {};
  $('#capabilities').innerHTML = `<ul class="capability-list"><li><span>Video processing</span><b>${esc(media.video || 'Check server status')}</b></li><li><span>On-device speech</span><b>${esc(speech.status || 'Not checked')}</b></li><li><span>Factual listing drafts</span><b>Built in</b></li><li><span>Local phrasing model</span><b>${esc(generation.status || generation.availability || 'See details')}</b></li></ul><details><summary>Processing details</summary><pre class="listing-pre">${esc(JSON.stringify(status,null,2))}</pre></details>`;
 } catch(error) {if(view === 'ai' && $('#capabilities')) $('#capabilities').textContent = error.message;}
}
async function orders() {
 if(pageDirty && view === 'orders' && !await confirmLeavePage()) return;
 $('#content').innerHTML = '<p class="lead">Sales, shipments and the actual results from your store connections.</p><div id="orders-list" aria-live="polite">Loading orders…</div><div class="section-title"><h2>Channel activity</h2><button id="orders-refresh">Refresh</button></div><div id="attempts-list"></div><div class="toolbar"><button id="orders-connections">Manage connections →</button><button id="orders-inventory">Inventory →</button></div>';
 $('#orders-refresh').onclick = orders; $('#orders-connections').onclick = () => go('connections'); $('#orders-inventory').onclick = () => go('inventory');
 try {const [records,attempts] = await Promise.all([api('orders'),api('attempts')]); if(view !== 'orders') return;
  $('#orders-list').innerHTML = records.map(order => `<article class="panel"><h3>${esc(order.id)} <span class="badge">${esc(order.status)}${order.sale_platform ? ' · '+esc(channelNames[order.sale_platform]||order.sale_platform) : ''}${order.payment_mode ? ' · ' + esc(order.payment_mode) : ''}</span></h3><p>${money(order.total_cents)} · ${esc(order.created_at)}</p>${orderContactHTML(order)}<p class="muted">Specimens: ${esc((order.item_ids || []).join(', '))}</p>${['seller_recorded_sale','marketplace_paid','website_paid','shipped'].includes(order.status) ? `<div class="field-grid"><label>Carrier<input id="carrier-${esc(order.id)}" value="${esc(order.shipping?.carrier || '')}"></label><label>Tracking number<input id="tracking-${esc(order.id)}" value="${esc(order.shipping?.tracking || '')}"></label></div><button data-ship="${esc(order.id)}">Save shipment</button>` : ''}</article>`).join('') || '<div class="panel"><h3>No orders yet.</h3><p>Orders and sales you record will appear here. Check Connections for checkout and marketplace readiness.</p></div>';
  $('#attempts-list').innerHTML = attempts.map(attempt => `<article class="panel activity-row"><span class="badge ${esc(attempt.status)}">${esc(attempt.status)}</span><h3>${esc(channelNames[attempt.channel] || attempt.channel)}</h3><p>${esc(attempt.message || attempt.reason || '')}</p>${attempt.created_at ? `<small>${esc(attempt.created_at)}</small>` : ''}</article>`).join('') || '<div class="empty">No channel activity yet. Publishing and stock update results appear here.</div>';
  $$('[data-ship]').forEach(button => button.onclick = () => busy(button,async () => {await api('shipment',{id:button.dataset.ship,carrier:$('#carrier-'+button.dataset.ship).value,tracking:$('#tracking-'+button.dataset.ship).value}); pageDirty = false; toast('Shipment saved.'); orders();},'Saving shipment…'));
 } catch(error) {if(view === 'orders') $('#orders-list').innerHTML = `<div class="panel"><p role="alert">${esc(error.message)}</p><p>Use Refresh above to try again.</p></div>`;}
}
async function poll() {
 if(!csrf || polling) return; polling = true;
 try {
  const next = await api('jobs'); const changed = JSON.stringify(next) !== JSON.stringify(jobs); jobs = next;
  if(changed) {items = await api('items'); if(!captureDirty&&!uploading&&capture.photos.some(p=>p.preview_only)){const saved=await api('capture-draft');if(saved?.id===capture.id){capture=saved;if(view==='quick')quick();}} if(editing && $('#editor').open){const latest = items.find(item => item.id === editing.id); if(latest && editing.media_pending && !latest.media_pending){latestMediaRecord = latest; paintMediaReview();}} if(view === 'video') paintJobs(); if(view === 'home') home(); if(view === 'inventory' && !$('#editor').open){const focused = document.activeElement?.id === 'search', position = focused ? $('#search').selectionStart : null; inventory(); if(focused){$('#search').focus({preventScroll:true}); $('#search').setSelectionRange(position,position);}}}
  if(audioJob) {
   const job = jobs.find(record => record.id === audioJob);
   if(job && ['complete','failed'].includes(job.status)) {
    audioJob = null; try {sessionStorage.removeItem('mm-audio-job');} catch (_) {}
    const result = job.result || job;
    if(result.text) {capture.transcript = [capture.transcript,result.text].filter(Boolean).join('\n'); changedCapture(); if(view === 'quick' && $('#transcript')) {$('#transcript').value = capture.transcript; $('#record-state').textContent = 'Transcript ready. Check the names and price.';} else toast('Your voice notes are ready in Add one rock.');}
    else {if($('#record-state')) $('#record-state').textContent = 'Audio saved. Type your three facts below.'; toast(result.message || 'Audio saved. Speech recognition was unavailable; type the three facts to continue.');}
   }
  }
 } catch (_) { /* Retry automatically without replacing an open form. */ } finally {polling = false;}
}
async function confirmLeavePage() {
 if(!pageDirty) return true;
 const choice = await choiceDialog('Unsaved changes', 'Save the form before leaving to keep your changes.',[{value:'stay',label:'Keep editing',primary:true},{value:'discard',label:'Discard changes'}]);
 if(choice !== 'discard') return false; pageDirty = false; return true;
}
$('#content').addEventListener('input',() => {if(['ai','connections','orders'].includes(view)) pageDirty = true;});
setInterval(()=>{if(!document.hidden)poll();},5000);
setInterval(()=>{if(csrf&&!document.hidden)api('marketplace-tick',{}).catch(()=>{});},30000);
try {audioJob = sessionStorage.getItem('mm-audio-job');} catch (_) {}
boot();

function orderContactHTML(order) {
 const shipping=order.shipping_address||{},a=shipping.address||{},name=typeof shipping.name==='string'?shipping.name:shipping.name?.full_name||order.customer?.name;
 const lines=[typeof name==='string'?name:'',a.line1||a.address_line_1,a.line2||a.address_line_2,[a.city||a.admin_area_2,a.state||a.admin_area_1,a.postal_code].filter(Boolean).join(', '),a.country||a.country_code].filter(Boolean);
 return `${order.status==='paid_needs_review'?'<p class="notice error-text">Payment received · stock conflict needs your attention. Review this sale and resolve the buyer’s order before shipping.</p>':''}${lines.length?'<details><summary>Delivery address & customer</summary><address>'+lines.map(esc).join('<br>')+'</address>'+(order.customer?.email?'<p>'+esc(order.customer.email)+'</p>':'')+'</details>':''}`;
}

async function loadPaymentSettings() {
 const panel = $('#payment-settings');if(!panel)return;
 try {
  const p = await api('payments');if(!panel.isConnected)return;const s=p.settings;
  panel.innerHTML = `<div class="section-title"><div><p class="step">SIMPLE GUEST CHECKOUT</p><h2>Website payments · Stripe</h2></div><span class="badge ${p.enabled?'approved':''}">${p.enabled?(p.mode==='test'?'Test checkout configured':'Live checkout configured'):'Setup needed'}</span></div><p>Cards, Apple Pay, Google Pay and Link through Stripe. Add PayPal to offer PayPal and eligible US Venmo. Each buyer sees the options available to their device and account.</p><p class="roi-note">No customer store account required. Transaction fees apply. Test payments leave real inventory unchanged.</p><form id="payment-form"><details ${!p.stripe_configured?'open':''}><summary>1 · Connect Stripe</summary><p><a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener">Stripe dashboard ↗</a> · <a href="https://dashboard.stripe.com/settings/payment_methods" target="_blank" rel="noopener">Enable wallet methods ↗</a></p><label>Stripe secret key ${p.stripe_configured?'· saved':''}<input type="password" name="stripe_key" autocomplete="new-password" placeholder="Leave blank to keep saved key"></label><label>Webhook signing secret ${p.webhook_configured?'· saved':''}<input type="password" name="stripe_webhook" autocomplete="new-password" placeholder="whsec_…"></label><label>Webhook destination<input readonly value="${esc(location.origin+'/api/payments/stripe/webhook')}"></label><p class="roi-note">Subscribe to checkout.session.completed, checkout.session.expired, checkout.session.async_payment_succeeded and checkout.session.async_payment_failed. Register the endpoint on the public host before launch. A private preview cannot receive provider webhooks.</p></details><details><summary>2 · Add PayPal & Venmo ${p.paypal_configured?'· saved':''}</summary><p><a href="https://developer.paypal.com/dashboard/applications" target="_blank" rel="noopener">PayPal Business app credentials ↗</a></p><label>PayPal client ID<input name="paypal_id" autocomplete="off" placeholder="Leave blank to keep saved ID"></label><label>PayPal client secret<input name="paypal_secret" type="password" autocomplete="new-password" placeholder="Leave blank to keep saved secret"></label><p class="roi-note">Use sandbox credentials with test mode and live credentials with live mode. Venmo requires eligible US merchant and buyer accounts; buttons appear only when PayPal confirms eligibility.</p></details><details open><summary>3 · Confirm checkout defaults once</summary><div class="field-grid"><label>Mode<select name="mode"><option value="test" ${s.mode==='test'?'selected':''}>Test · no real charges</option><option value="live" ${s.mode==='live'?'selected':''}>Live · real charges</option></select></label><label>Shipping per order · USD<input name="shipping" type="number" min="0" step="0.01" inputmode="decimal" value="${s.shipping_cents===null?'':s.shipping_cents/100}" placeholder="Your rate" required></label><label>Shipping label<input name="shipping_label" maxlength="80" value="${esc(s.shipping_label)}"></label><label>Ship to · country codes<input name="countries" value="${esc(s.countries.join(', '))}" placeholder="US"></label></div><label><input name="shipping_reviewed" type="checkbox" ${s.shipping_reviewed?'checked':''}> I confirmed the shipping rate and destinations.</label><label><input name="tax_reviewed" type="checkbox" ${s.tax_reviewed?'checked':''}> I reviewed my tax obligations. This checkout does not add sales tax automatically.</label><p class="roi-note">Live payments also need the host’s MM_PAYMENTS_LIVE setting enabled after a successful test. Keep test mode selected until then.</p></details><p class="notice">${esc(p.missing.length?p.missing.join(' · '):'Defaults saved. Complete the provider connection and test a checkout before launch.')}</p><div class="toolbar"><button class="primary" type="submit">Save payment settings</button><button type="button" id="reconcile-payments">Check pending payments</button></div><p id="payment-save-status" class="inline-status" role="status"></p></form>`;
  $('#payment-form').onsubmit=event=>{event.preventDefault();const form=event.currentTarget,values=new FormData(form),payload={mode:values.get('mode'),shipping_cents:Math.round(Number(values.get('shipping'))*100),shipping_label:values.get('shipping_label'),countries:values.get('countries').split(',').map(c=>c.trim().toUpperCase()).filter(Boolean),shipping_reviewed:values.has('shipping_reviewed'),tax_reviewed:values.has('tax_reviewed'),stripe:{secret_key:values.get('stripe_key'),webhook_secret:values.get('stripe_webhook')},paypal:{client_id:values.get('paypal_id'),client_secret:values.get('paypal_secret')}};busy($('button[type=submit]',form),async()=>{await api('payments',payload);pageDirty=false;await loadPaymentSettings();toast('Payment settings saved privately.');},'Saving securely…');};
  $('#reconcile-payments').onclick=event=>busy(event.target,async()=>{const result=await api('payments/reconcile',{});$('#payment-save-status').textContent=result.results.length?'Pending payment statuses checked. See Orders for confirmed payments.':'No pending payments to check.';},'Checking providers…');
 } catch(e){panel.innerHTML='<h2>Website payments · Stripe</h2><p role="alert">'+esc(e.message)+'</p>';}
}

})();
