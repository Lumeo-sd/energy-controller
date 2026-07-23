document.getElementById('cfg-inverter-autoResolve').addEventListener('change',function(){document.getElementById('resolveAfterFails-row').style.display=this.checked?'block':'none';});


let tuyaDevices=[];
let _csrfToken=null;
document.querySelectorAll('.menu-item').forEach(item=>{
item.addEventListener('click',function(){
const tab=this.dataset.tab;
document.querySelectorAll('.menu-item').forEach(m=>m.classList.remove('active'));
this.classList.add('active');
document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
const pane=document.getElementById('tab-'+tab);
if(pane)pane.classList.add('active');
const titles={status:'Status',devices:'Devices',automations:'Automations',server:'Server',settings:'Settings'};
const h1=pane.querySelector('.page-header h1');
if(h1)h1.textContent=titles[tab]||tab;
if(tab==='status'){loadStatus();loadLogs();loadHistory();loadSocketHistory();loadOtherHistory();}
if(tab==='devices')loadTuyaDevices();
if(tab==='automations'){loadScenes();populateDeviceSelects();}
if(tab==='server')loadServerInfo();
if(tab==='settings'){loadPluginConfig();loadAppVersion();}
if(tab==='notifications')loadNotifications();
});
});
function showToast(t,b,e,undoCb,undoLabel){
  haptic(e?40:10);
  const el=document.getElementById('toast');
  document.getElementById('toastTitle').textContent=t;
  document.getElementById('toastBody').textContent=b;
  const actions=document.getElementById('toastActions');
  const undoBtn=document.getElementById('toastUndoBtn');
  if(undoCb){
    actions.style.display='flex';
    undoBtn.textContent=undoLabel||'Undo';
    undoBtn.onclick=function(){undoCb();el.classList.remove('show');};
  }else{
    actions.style.display='none';
  }
  el.className='hb-toast show'+(e?' error':'');
  clearTimeout(el._hide);
  el._hide=setTimeout(()=>el.classList.remove('show'),4000);
  try{fetch('/api/notifications/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:t,message:b||'',type:e?'error':'info'})});}catch(ee){}}
var _lastNotifId=0,_unreadNotifCount=0;
function playNotifSound(){
  try{var ac=new(window.AudioContext||window.webkitAudioContext)();var osc=ac.createOscillator();var g=ac.createGain();osc.connect(g);g.connect(ac.destination);osc.frequency.setValueAtTime(880,ac.currentTime);osc.frequency.setValueAtTime(1100,ac.currentTime+.08);g.gain.setValueAtTime(.08,ac.currentTime);g.gain.exponentialRampToValueAtTime(.001,ac.currentTime+.25);osc.start(ac.currentTime);osc.stop(ac.currentTime+.25);}catch(ee){}
}
function notifGroupKey(n){return n.title+'|'+n.type;}
async function loadNotifications(){
  try{
    var r=await apiGet('/api/notifications');
    if(!r.success)return;
    var list=r.notifications||[];
    var unread=r.unread||0;
    var newCount=_lastNotifId?list.filter(function(n){return n.id>_lastNotifId&&n.type!=='info';}).length:0;
    if(newCount>0)playNotifSound();
    if(list.length)_lastNotifId=list[0].id;
    _unreadNotifCount=unread;
    var badElUnread=document.getElementById('sidebar-notif-unread');
    if(badElUnread){
      badElUnread.textContent=unread;
      badElUnread.style.display=unread?'':'none';
    }
    var con=document.getElementById('notif-list');
    if(!con)return;
    if(!list.length){
      con.innerHTML='<div class="notif-empty">No notifications</div>';
      return;
    }
    var html='';
    html+='<div class="notif-group-header">Latest</div>';
    var groups={};
    for(var i=0;i<list.length;i++){
      var n=list[i];
      var gk=notifGroupKey(n);
      if(!groups[gk])groups[gk]=[];
      groups[gk].push(n);
    }
    var sortedGroups=Object.keys(groups).sort(function(a,b){return groups[b][0].id-groups[a][0].id;});
    for(var gi=0;gi<sortedGroups.length;gi++){
      var gk=sortedGroups[gi];
      var items=groups[gk];
      var first=items[0];
      var groupUnread=items.some(function(x){return !x.read;});
      if(items.length>1){
        html+='<div class="notif-item'+(groupUnread?' unread':'')+'" onclick="toggleNotifGroup(this)" style="cursor:pointer">';
        html+='<span class="notif-expand-icon" style="flex-shrink:0;width:16px;text-align:center;font-size:.6rem;color:var(--muted);margin-top:6px"><i class="bi bi-chevron-right"></i></span>';
        html+='<div class="notif-icon '+(first.type||'info')+'">'+(first.type==='error'?'!':first.type==='warn'?'\u26a0':'\u2713')+'</div>';
        html+='<div class="notif-body">';
        html+='<div class="notif-title">'+_esc(first.title)+'</div>';
        html+='<div class="notif-msg">'+items.length+'x</div>';
        html+='<div class="notif-time">'+new Date(first.time).toLocaleString()+'</div>';
        html+='</div>';
        var gucid=items.filter(function(x){return !x.read;}).length;if(gucid)html+='<div class="notif-count-badge" style="background:var(--primary);color:#000;border-radius:10px;padding:0 6px;font-size:.65rem;font-weight:700;line-height:18px;min-width:18px;text-align:center;margin-top:4px;flex-shrink:0">'+gucid+'</div>';
        html+='<div class="notif-actions">';
        if(groupUnread)html+='<button class="btn-hb btn-hb-outline btn-hb-sm" data-nft="'+_escAttr(first.title)+'" data-nftype="'+_escAttr(first.type||'info')+'" onclick="event.stopPropagation();markNotifGroup(this.dataset.nft,this.dataset.nftype)" style="font-size:.7rem;padding:.15rem .5rem"><i class="bi bi-check-all"></i> Mark read</button>';
        html+='<button class="btn-hb btn-hb-outline btn-hb-sm" data-nft="'+_escAttr(first.title)+'" data-nftype="'+_escAttr(first.type||'info')+'" onclick="event.stopPropagation();dismissNotifGroup(this.dataset.nft,this.dataset.nftype)" style="font-size:.7rem;padding:.15rem .5rem"><i class="bi bi-trash3"></i> Dismiss</button>';
        html+='</div>';
        html+='<div class="notif-sub-list" style="display:none;width:100%;padding-top:4px;border-top:1px solid rgba(255,255,255,.05);margin-top:4px">';
        var unreadItems=items.filter(function(x){return !x.read;});
        for(var si=0;si<unreadItems.length;si++){
          var sn=unreadItems[si];
          html+='<div class="notif-sub-item'+(sn.read?'':' notif-sub-unread')+'">';
          html+='<div class="notif-sub-time">'+new Date(sn.time).toLocaleString()+'</div>';
          html+=(sn.message?'<div class="notif-sub-msg">'+_esc(sn.message)+'</div>':'');
          html+='</div>';
        }
        html+='</div>';
        html+='</div>';
      }else{
        html+='<div class="notif-item'+(groupUnread?' unread':'')+'">';
        html+='<div class="notif-icon '+(first.type||'info')+'">'+(first.type==='error'?'!':first.type==='warn'?'\u26a0':'\u2713')+'</div>';
        html+='<div class="notif-body">';
        html+='<div class="notif-title">'+_esc(first.title)+'</div>';
        html+=(first.message?'<div class="notif-msg">'+_esc(first.message)+'</div>':'');
        html+='<div class="notif-time">'+new Date(first.time).toLocaleString()+'</div>';
        html+='</div>';
        html+='<div class="notif-actions">';
        if(groupUnread)html+='<button class="btn-hb btn-hb-outline btn-hb-sm" data-nft="'+_escAttr(first.title)+'" data-nftype="'+_escAttr(first.type||'info')+'" onclick="markNotifGroup(this.dataset.nft,this.dataset.nftype)" style="font-size:.7rem;padding:.15rem .5rem"><i class="bi bi-check-all"></i> Mark read</button>';
        html+='<button class="btn-hb btn-hb-outline btn-hb-sm" data-nft="'+_escAttr(first.title)+'" data-nftype="'+_escAttr(first.type||'info')+'" onclick="dismissNotifGroup(this.dataset.nft,this.dataset.nftype)" style="font-size:.7rem;padding:.15rem .5rem"><i class="bi bi-trash3"></i> Dismiss</button>';
        html+='</div>';
        html+='</div>';
      }
    }
    con.innerHTML=html;
  }catch(e){console.error('loadNotifications',e);}
}
function _esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function _escAttr(s){return _esc(s).replace(/"/g,'&quot;');}
function toggleNotifGroup(el){
  var icon=el.querySelector('.notif-expand-icon i');
  var sub=el.querySelector('.notif-sub-list');
  if(!sub)return;
  var expanded=sub.style.display!='none';
  sub.style.display=expanded?'none':'block';
  if(icon)icon.className=expanded?'bi bi-chevron-right':'bi bi-chevron-down';
}
async function dismissNotifGroup(title,type){try{await apiPost('/api/notifications/dismiss',{title:title,type:type||'info'});loadNotifications();}catch(e){}}
async function markNotifGroup(title,type){try{await apiPost('/api/notifications/mark-read',{title:title,type:type||'info'});loadNotifications();}catch(e){}}
async function dismissAllNotif(){try{await apiPost('/api/notifications/dismiss-all',{});loadNotifications();}catch(e){}}
async function markAllRead(){try{await apiPost('/api/notifications/mark-read',{});loadNotifications();}catch(e){}}

function handleAuthStatus(r){if(r.status===401){window.location.href='/login';throw new Error('Unauthorized');}return r;}
async function apiGet(p){const r=handleAuthStatus(await fetch(p));if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
async function apiPost(p,b){const h={'Content-Type':'application/json'};if(_csrfToken)h['X-CSRF-Token']=_csrfToken;const r=handleAuthStatus(await fetch(p,{method:'POST',headers:h,body:JSON.stringify(b)}));if(!r.ok){let msg='HTTP '+r.status;try{const e=await r.json();if(e.message)msg=e.message;}catch{}throw new Error(msg);}return r.json();}
async function apiDelete(p){const h={};if(_csrfToken)h['X-CSRF-Token']=_csrfToken;const r=handleAuthStatus(await fetch(p,{method:'DELETE',headers:h}));if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
async function apiPatch(p,b){const h={'Content-Type':'application/json'};if(_csrfToken)h['X-CSRF-Token']=_csrfToken;const r=handleAuthStatus(await fetch(p,{method:'PATCH',headers:h,body:JSON.stringify(b)}));if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
async function loadStatus(){
try{
const d=await apiGet('/api/status');
if(d.csrfToken)_csrfToken=d.csrfToken;
updateTiles(d,d.debug||{});
window._lastData=d;renderEnergyFlow(d);
const dg=d.debug||{};
const dgEl=document.getElementById('debug-grid');
if(dgEl){
const groups=[
{title:'DC Block (48-111)',items:[
['reg59 overallState',dg.overallState],['reg60 dayActive',dg.dayActiveEnergy+' kWh'],
['reg65 monthPV',dg.monthPV+' kWh'],['reg66 monthLoad',dg.monthLoad+' kWh'],['reg67 monthGrid',dg.monthGrid+' kWh'],
['reg70 dayBatChg',dg.dayBatCharge+' kWh'],['reg71 dayBatDisch',dg.dayBatDischarge+' kWh'],
['reg72-73 totalBatChg',dg.totalBatCharge+' kWh'],['reg74-75 totalBatDisch',dg.totalBatDischarge+' kWh'],
['reg76 dayGridImp',dg.dayGridImport+' kWh'],['reg77 dayGridExp',dg.dayGridExport+' kWh'],
['reg79 gridFreq',dg.gridFreq+' Hz'],['reg81-82 totalGridExp',dg.totalGridExport+' kWh'],
['reg84 dayLoad',dg.dayLoadEnergy+' kWh'],['reg85-86 totalLoad',dg.totalLoadEnergy+' kWh'],
['reg90 dcTransfTemp',dg.dcTransfTemp+' °C'],['reg91 radiatorTemp',dg.radiatorTemp+' °C'],
['reg95 envTemp',dg.envTemp+' °C'],['reg96-97 totalPV',dg.totalPV+' kWh'],
['reg98-99 yearGridExp',dg.yearGridExport+' kWh'],['reg78+80 totalGridImp',dg.totalGridImport+' kWh'],
['reg103 fault1',dg.fault1],['reg104 fault2',dg.fault2],['reg105 fault3',dg.fault3],['reg106 fault4',dg.fault4],
['reg108 dayPV',dg.dayPV+' kWh'],['reg109 pv1V',dg.pv1Voltage+' V'],['reg110 pv1A',dg.pv1Current+' A'],['reg111 pv2V',dg.pv2Voltage+' V']
]},
{title:'AC Block (150-249)',items:[
['reg150 gridV',dg.gridVoltage+' V'],['reg154 invV',dg.inverterVoltage+' V'],
['reg160 gridI1',dg.gridCurrent1],['reg161 gridI2',dg.gridCurrent2],
['reg164 invI',dg.inverterCurrent+' A'],['reg166 auxPower',dg.auxPower+' W'],
['reg167 gridL1',dg.gridL1Power+' W'],['reg169 gridPwr',dg.gridPower+' W'],
['reg172 gridCT',dg.gridCTPower+' W'],['reg175 invPwr',dg.inverterPower+' W'],
['reg178 loadPwr',dg.loadPower+' W'],['reg179 offGridMode',dg.offGridMode],
['reg182 batTemp',dg.batteryTemp+' °C'],['reg183 batV',dg.batteryVoltage+' V'],
['reg184 batSOC',dg.batterySOC+' %'],['reg186 pv1Pwr',dg.pv1Power+' W'],
['reg187 pv2Pwr',dg.pv2Power+' W'],['reg190 batPwr',dg.batteryPower+' W'],
['reg191 batI',dg.batteryCurrent+' A'],['reg192 loadFreq',dg.loadFreq+' Hz'],
['reg193 invFreq',dg.inverterFreq+' Hz'],['reg194 gridConn',dg.gridConnected]
]},
{title:'Settings (200-249)',items:[
['reg200 ctrlMode',dg.controlMode],['reg201 batEqV',dg.batteryEqVoltage+' V'],
['reg202 batAbsV',dg.batteryAbsVoltage+' V'],['reg203 batFloatV',dg.batteryFloatVoltage+' V'],
['reg209 upsDelay',dg.upsDelayTime],['reg210 batMaxChgI',dg.batMaxChargeCurrent],
['reg211 batMaxDisI',dg.batMaxDischargeCurrent],['reg217 batShdSOC',dg.batShutdownSOC],
['reg218 batRstSOC',dg.batRestartSOC],['reg219 batLowSOC',dg.batLowSOC],
['reg220 batShdV',dg.batShutdownVoltage+' V'],['reg221 batRstV',dg.batRestartVoltage+' V'],
['reg222 batLowV',dg.batLowVoltage+' V'],['reg228 remoteCfg',dg.remoteConfig],
['reg230 gridChg',dg.gridChargeEnabled],['reg243 priorityLoad',dg.priorityLoad],
['reg244 loadLimit',dg.loadLimit],['reg245 maxSell',dg.maxSellPower],
['reg247 solarExport',dg.solarExport],['reg248 useTimer',dg.useTimer]
]}
];
const dgHash=JSON.stringify(dg);
if(dgEl._lastHash!==dgHash){dgEl._lastHash=dgHash;
dgEl.innerHTML=groups.map(g=>'<div style="grid-column:1/-1;font-weight:600;margin-top:.35rem;color:var(--accent)">'+g.title+'</div>'+
g.items.map(([k,v])=>'<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span style="color:var(--muted)">'+k+':</span> <b>'+(v==null?'—':v)+'</b></div>').join('')).join('');
}}
}catch(e){console.error('loadStatus',e);}
}
async function loadLogs(){
try{
const d=await apiGet('/api/logs');
const c=document.getElementById('log-container');
if(d.success&&d.logs){
const lines=d.logs.split('\\n').slice(-50);
const html=lines.map(l=>'<div class="log-line">'+escHtml(l)+'</div>').join('');
if(c._lastHtml!==html){c._lastHtml=html;c.innerHTML=html;c.scrollTop=c.scrollHeight;}
}else c.innerHTML='<div class="log-line">No logs available</div>';
}catch(e){document.getElementById('log-container').innerHTML='<div class="log-line">Error loading logs</div>';}
}
async function loadTuyaDevices(){
try{
const list=document.getElementById('devices-list');
list.innerHTML='<div class="device-grid">'
+'<div class="entity-card skeleton-card">'
+'<div class="device-card-top"><span class="skeleton skeleton-dot"></span><span class="skeleton skeleton-line" style="flex:1;height:16px"></span><span class="skeleton skeleton-btn" style="width:50px"></span></div>'
+'<div class="skeleton skeleton-line-sm" style="width:40%"></div>'
+'<div class="device-toggle-group"><span class="skeleton skeleton-btn"></span><span class="skeleton skeleton-btn"></span></div></div>'
+'<div class="entity-card skeleton-card">'
+'<div class="device-card-top"><span class="skeleton skeleton-dot"></span><span class="skeleton skeleton-line" style="flex:1;height:16px"></span><span class="skeleton skeleton-btn" style="width:50px"></span></div>'
+'<div class="skeleton skeleton-line-sm" style="width:40%"></div>'
+'<div class="device-toggle-group"><span class="skeleton skeleton-btn"></span><span class="skeleton skeleton-btn"></span></div></div>'
+'<div class="entity-card skeleton-card">'
+'<div class="device-card-top"><span class="skeleton skeleton-dot"></span><span class="skeleton skeleton-line" style="flex:1;height:16px"></span><span class="skeleton skeleton-btn" style="width:50px"></span></div>'
+'<div class="skeleton skeleton-line-sm" style="width:40%"></div>'
+'<div class="device-toggle-group"><span class="skeleton skeleton-btn"></span><span class="skeleton skeleton-btn"></span></div></div>'
+'</div>';
tuyaDevices=await apiGet('/api/tuya-devices');
document.getElementById('device-count-badge').textContent=tuyaDevices.length;
document.getElementById('sidebar-device-count').textContent=tuyaDevices.length;
if(tuyaDevices.length===0){list.innerHTML='<div class="empty-state"><i class="bi bi-inbox"></i><p>No devices synced yet.</p></div>';populateDeviceSelects();return;}
const groups={};
for(const d of tuyaDevices){const g=d.group||'';if(!groups[g])groups[g]=[];groups[g].push(d);}
const groupKeys=Object.keys(groups).sort((a,b)=>a.localeCompare(b));
let html='';
for(const gk of groupKeys){
const devs=groups[gk];
if(gk){
html+='<div class="device-group-header"><span class="device-group-icon"><i class="bi bi-folder2"></i></span><span class="device-group-name">'+escHtml(gk)+'</span><span class="badge-hb purple">'+devs.length+'</span></div>';
}else{
html+='<div class="device-group-header"><span class="device-group-icon"><i class="bi bi-inbox"></i></span><span class="device-group-name">Other</span><span class="badge-hb purple">'+devs.length+'</span></div>';
}
html+='<div class="device-grid">'+devs.map(d=>{
const onlineBadge=d.online?'<span class="badge-hb online">Online</span>':'<span class="badge-hb offline">Offline</span>';
const iconClass=d.switch===true?'on':(d.switch===false?'off':'unknown');
const activeOn=d.switch===true?' active':'';
const activeOff=d.switch===false?' active':'';
const idSafe=escHtml(d.id);
const gSafe=escHtml(d.group||'');
return '<div class="entity-card device-card'+(d.switch===true?' is-on':'')+'">'
+'<div class="device-card-top"><span class="device-icon '+iconClass+'"></span><span class="device-name">'+escHtml(d.name)+'</span>'+onlineBadge+'<button class="btn-hb btn-hb-sm btn-hb-icon device-group-btn" onclick="editDeviceGroup(\''+idSafe+'\',this)" title="Edit group"><i class="bi bi-pencil"></i></button></div>'
+'<div class="device-info">ID: '+idSafe+'</div>'
+'<div class="device-info"><span class="device-group-lbl">Group: </span><span class="device-group-val" data-device-id="'+idSafe+'">'+escHtml(gSafe||'\u2014')+'</span></div>'
+'<div class="device-toggle-group">'
+'<button class="device-toggle-btn on'+activeOn+'" onclick="controlDevice(\''+idSafe+'\',true,this)"><i class="bi bi-power"></i> ON</button>'
+'<button class="device-toggle-btn off'+activeOff+'" onclick="controlDevice(\''+idSafe+'\',false,this)"><i class="bi bi-power"></i> OFF</button>'
+'</div></div>';
}).join('')+'</div>';
}
list.innerHTML=html;
populateDeviceSelects();
}catch(e){console.error('loadTuyaDevices',e);}
}
async function editDeviceGroup(id,btn){
const curGroup=tuyaDevices.find(d=>d.id===id)?.group||'';
const groups=new Set();
for(const d of tuyaDevices){if(d.group)groups.add(d.group);}
const sorted=[...groups].sort();
const newGroup=prompt('Enter group name for this device:'+(sorted.length?'\n\nExisting groups:\n'+sorted.join('\n'):''),curGroup);
if(newGroup===null)return;
const trimmed=newGroup.trim();
if(trimmed===curGroup)return;
try{
const r=await apiPatch('/api/tuya-devices/'+encodeURIComponent(id)+'/group',{group:trimmed});
if(r.success){
const dev=tuyaDevices.find(d=>d.id===id);
if(dev)dev.group=trimmed;
loadTuyaDevices();
showToast('Group updated','Device moved to "'+(trimmed||'Other')+'"');
}else showToast('Error',r.message||'Failed',true);
}catch(e){showToast('Error',e.message,true);
}
}
async function controlDevice(id,value,btnEl){
const card=btnEl?btnEl.closest('.device-card'):null;
let iconEl=null,prevClass='';
if(card){
card.querySelectorAll('.device-toggle-btn').forEach(b=>b.classList.remove('active'));
const targetBtn=card.querySelector('.device-toggle-btn.'+(value?'on':'off'));
if(targetBtn)targetBtn.classList.add('active');
card.classList.toggle('is-on',value);
iconEl=card.querySelector('.device-icon');
if(iconEl){prevClass=iconEl.className;iconEl.className='device-icon '+(value?'on':'off')+' pulse';}
}
const dev=tuyaDevices.find(d=>d.id===id);
if(dev)dev.switch=value;
haptic(value?20:15);
try{
const r=await apiPost('/api/tuya-control',{deviceId:id,value});
if(!r.success){showToast('Error',r.message||'Control failed',true);if(iconEl)iconEl.className=prevClass;}
}catch(e){showToast('Error',e.message,true);if(iconEl)iconEl.className=prevClass;}
finally{if(iconEl)setTimeout(()=>iconEl.classList.remove('pulse'),600);}
}
async function syncTuya(){
const btn=document.getElementById('syncBtn');
btn.disabled=true;btn.innerHTML='<span class="spinner-hb"></span> Syncing...';
try{const d=await apiPost('/api/sync-tuya',{});if(d.success){await loadTuyaDevices();}else showToast('Sync error',d.message||'Unknown error',true);}
catch(e){showToast('Sync error',e.message,true);}
finally{btn.disabled=false;btn.innerHTML='<i class="bi bi-arrow-repeat"></i> Sync Devices';}
}
async function loadScenes(){
try{
const list=document.getElementById('scenes-list');
list.innerHTML='<div class="automation-grid">'
+'<div class="entity-card skeleton-card"><div class="automation-card-top"><span class="skeleton skeleton-dot"></span><span class="skeleton skeleton-line" style="flex:1;height:16px"></span><span class="skeleton skeleton-btn" style="width:50px"></span></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line-sm" style="width:70%"></div></div>'
+'<div class="entity-card skeleton-card"><div class="automation-card-top"><span class="skeleton skeleton-dot"></span><span class="skeleton skeleton-line" style="flex:1;height:16px"></span><span class="skeleton skeleton-btn" style="width:50px"></span></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line-sm" style="width:70%"></div></div>'
+'</div>';
const scenes=await apiGet('/api/scenes');
const traceRes=await fetch('/api/scene-traces');
const traceData=traceRes.ok?await traceRes.json():{traces:{}};
const allTraces=traceData.traces||{};
document.getElementById('scene-count-badge2').textContent=scenes.length;
document.getElementById('sidebar-scene-count').textContent=scenes.length;
if(scenes.length===0){list.innerHTML='<div class="empty-state"><i class="bi bi-diagram-3"></i><p>No automations yet.</p></div>';return;}
list.innerHTML='<div class="automation-grid">'+scenes.map(s=>{
const lg=s.if&&s.if.logic==='OR'?' OR ':' AND ';
const ifT=(s.if&&s.if.conditions)?s.if.conditions.map(c=>{
if(c.type==='grid')return 'Grid '+(c.value?'ON':'OFF');
if(c.type==='battery')return 'Battery '+(c.operator||'=')+' '+c.value+'%';
if(c.type==='time')return 'Time '+c.after+'-'+c.before;
if(c.type==='weekday'&&c.days){const wd=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];return c.days.map(d=>wd[d]).join('/');}
if(c.type==='device_online'){const dev=tuyaDevices.find(d=>d.id===c.value);return (dev?dev.name:'Device')+' '+(c.expectedStatus?'Online':'Offline');}
return '';
}).join(lg):'\\u2014';
const thenT=(s.then&&s.then.actions)?s.then.actions.map(a=>{
if(a.type==='notify')return '\ud83d\udd14 '+(a.title||a.message||'Notify');
const dev=tuyaDevices.find(d=>d.id===a.device);
const dn=dev?dev.name:a.device;
let t=dn+' \\u2192 '+(a.value?'ON':'OFF');
if(a.duration>0)t+=' for '+a.duration+'min';
if(a.interval>0)t+=' every '+a.interval+'min';
return t;
}).join(', '):'\\u2014';
const en=s.enabled!==false;
const toggleBtn=en
?'<button class="btn-hb btn-hb-sm btn-hb-icon" style="background:rgba(255,69,58,.15);color:var(--danger)" onclick="toggleScene(\''+escHtml(s.name)+'\',false,this)" title="Pause"><i class="bi bi-pause-fill"></i></button>'
:'<button class="btn-hb btn-hb-sm btn-hb-icon" style="background:rgba(48,209,88,.15);color:var(--success)" onclick="toggleScene(\''+escHtml(s.name)+'\',true,this)" title="Resume"><i class="bi bi-play-fill"></i></button>';
const sceneT=allTraces[s.name];
let traceHtml='';
if(sceneT&&sceneT.length){
const last=sceneT.slice(-3).reverse();
traceHtml='<div class="scene-traces">'+last.map(t=>{
const d=new Date(t.ts);
const tm=d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0')+':'+d.getSeconds().toString().padStart(2,'0');
let lbl=t.action;
if(t.action==='apply')lbl='Applied';
else if(t.action==='revert (timeout)')lbl='Revert (timeout)';
else if(t.action==='revert (conditions)')lbl='Revert (changed)';
else if(t.action.endsWith(':error'))lbl='Error';
const err=t.action.endsWith(':error');
return '<span class="trace-item'+(err?' trace-err':'')+'"><span class="trace-ts">'+tm+'</span><span class="trace-act">'+lbl+'</span><span class="trace-d">'+(t.detail||'')+'</span></span>';
}).join('')+'</div>';
}
return '<div class="entity-card automation-card'+(en?' is-active':'')+'">'
+'<div class="automation-card-top"><span class="automation-dot '+(en?'on':'off')+'"></span><span class="automation-name">'+escHtml(s.name)+'</span><span class="badge-hb '+(en?'active':'inactive')+'">'+(en?'Active':'Paused')+'</span></div>'
+'<div class="automation-rule"><b>IF</b> '+escHtml(ifT)+' <b>\u2192 THEN</b> '+escHtml(thenT)+'</div>'
+traceHtml
+'<div class="automation-footer">'+toggleBtn+'<button class="btn-hb btn-hb-outline btn-hb-sm btn-hb-icon" onclick="runSceneNow(\''+escHtml(s.name)+'\',this)" title="Run now"><i class="bi bi-play-circle"></i></button><button class="btn-hb btn-hb-outline btn-hb-sm btn-hb-icon" onclick="deleteScene(\''+escHtml(s.name)+'\')"><i class="bi bi-trash"></i></button></div>'
+'</div>';
}).join('')+'</div>';
}catch(e){console.error('loadScenes',e);}
}
async function toggleScene(name,enabled,btnEl){
const card=btnEl?btnEl.closest('.automation-card'):null;
if(card){
card.classList.toggle('is-active',enabled);
const dot=card.querySelector('.automation-dot');
if(dot){dot.classList.remove('on','off');dot.classList.add(enabled?'on':'off');}
const badge=card.querySelector('.badge-hb.active,.badge-hb.inactive');
if(badge){badge.classList.remove('active','inactive');badge.classList.add(enabled?'active':'inactive');badge.textContent=enabled?'Active':'Paused';}
}
try{const r=await apiPatch('/api/scenes/'+encodeURIComponent(name),{enabled});if(!r.success)showToast('Error',r.message||'Toggle failed',true);loadScenes();}
catch(e){showToast('Error',e.message,true);loadScenes();}
}
async function deleteScene(n){
if(!confirm('Delete automation "'+n+'"?'))return;
try{await apiDelete('/api/scenes/'+encodeURIComponent(n));loadScenes();}
catch(e){showToast('Error',e.message,true);}
}
async function runSceneNow(name,btnEl){
haptic(10);
if(btnEl)btnEl.disabled=true;
try{
const r=await apiPost('/api/scenes/'+encodeURIComponent(name)+'/run',{});
if(r.success){
const failed=(r.results||[]).filter(x=>!x.ok);
showToast(failed.length?'Ran with errors':'Ran','"'+name+'" applied'+(failed.length?' ('+failed.length+' failed)':''),!!failed.length);
}else{showToast('Error',r.message||'Run failed',true);}
loadScenes();
}catch(e){showToast('Error',e.message,true);}
finally{if(btnEl)btnEl.disabled=false;}
}
function toggleNewAutomation(){
document.getElementById('new-automation-card').classList.toggle('collapsed');
}
function expandNewAutomation(){
const card=document.getElementById('new-automation-card');
if(card.classList.contains('collapsed'))card.classList.remove('collapsed');
}
function addCondition(btn){
expandNewAutomation();
openTypeSheet('Add Condition', CONDITION_TYPES, function(type){
var c=document.getElementById('if-conditions');
var r=document.createElement('div');r.className='rule-sentence';r.dataset.type=type;
renderConditionRow(r,type);
c.appendChild(r);
renderAutomationSummary();
},btn);
}
function renderConditionRow(r,type){
var meta=CONDITION_TYPES.find(function(t){return t.value===type;});
var body='<span class="chip-label type-'+type+'"><i class="bi '+meta.icon+'"></i> '+meta.label+'</span>';
if(type==='battery'){
body+='<select class="chip-select condition-operator"><option value="<">is below</option><option value=">">is above</option><option value="=">equals</option></select><input type="number" class="chip-input condition-value" placeholder="20" min="0" max="100" />%';
}else if(type==='grid'){
body+='<select class="chip-select condition-value"><option value="true">is ON</option><option value="false">is OFF</option></select>';
}else if(type==='time'){
body+='<span class="text-muted-hb" style="font-size:.78rem">between</span><input type="time" class="chip-input condition-after" value="00:00" /><span class="text-muted-hb" style="font-size:.78rem">and</span><input type="time" class="chip-input condition-before" value="23:59" />';
}else if(type==='weekday'){
body+='<span class="wdays">'+["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(function(d,i){return '<label class="wday-lbl"><input type="checkbox" class="wday-cb" value="'+i+'"'+(i>0&&i<6?' checked':'')+' />'+d+'</label>';}).join('')+'</span>';
}else if(type==='device_online'){
body+='<select class="chip-select condition-device"><option value="">\u2014 device \u2014</option>'+tuyaDevices.map(function(d){return '<option value="'+d.id+'">'+d.name+'</option>';}).join('')+'</select><select class="chip-select condition-device-status"><option value="true">Online</option><option value="false">Offline</option></select>';
}
body+='<button class="rule-remove-x btn-hb btn-hb-sm btn-hb-icon btn-hb-outline" onclick="this.closest(\'.rule-sentence\').remove();renderAutomationSummary()"><i class="bi bi-x"></i></button>';
r.innerHTML=body;
r.querySelectorAll('select,input').forEach(function(el){el.addEventListener('input',renderAutomationSummary);});
}
function addAction(btn){
expandNewAutomation();
openTypeSheet('Add Action', ACTION_TYPES, function(type){
var c=document.getElementById('then-actions');
var r=document.createElement('div');r.className='rule-sentence';r.dataset.type=type;
renderActionRow(r,type);
c.appendChild(r);
renderAutomationSummary();
},btn);
}
function renderActionRow(r,type){
var body;
if(type==='tuya'){
var opts=tuyaDevices.map(function(d){return '<option value="'+escHtml(d.id)+'">'+escHtml(d.name)+'</option>';}).join('');
body='<select class="chip-select action-device"><option value="">\u2014 device \u2014</option>'+opts+'</select><select class="chip-select action-value"><option value="true">turn ON</option><option value="false">turn OFF</option></select><details class="advanced-fields"><summary><i class="bi bi-chevron-right"></i> duration / interval <span class="text-muted-hb" style="font-weight:400;font-size:.75rem">(optional)</span></summary><div style="display:flex;gap:.5rem;margin-top:.3rem"><input type="number" class="chip-input action-duration" placeholder="min" min="0" style="width:70px" /><input type="number" class="chip-input action-interval" placeholder="min" min="0" style="width:70px" /></div></details>';
}else{

}
body+='<button class="rule-remove-x btn-hb btn-hb-sm btn-hb-icon btn-hb-outline" onclick="this.closest(\'.rule-sentence\').remove();renderAutomationSummary()"><i class="bi bi-x"></i></button>';
r.innerHTML=body;
r.querySelectorAll('select,input').forEach(function(el){el.addEventListener('input',renderAutomationSummary);});
}
function renderAutomationSummary(){
var el=document.getElementById('automation-summary');
if(!el)return;
var logicSel=document.getElementById('scene-logic');
var isOr=logicSel&&logicSel.value==='OR';
var condParts=[];
document.querySelectorAll('#if-conditions > .rule-sentence').forEach(function(r){
var type=r.dataset.type;
if(type==='battery'){
var op=r.querySelector('.condition-operator').value;
var val=r.querySelector('.condition-value').value||'0';
var opText=op==='<'?'below':op==='>'?'above':'equal to';
condParts.push('Battery is '+opText+' '+val+'%');
}else if(type==='grid'){
condParts.push('Grid is '+(r.querySelector('.condition-value').value==='true'?'ON':'OFF'));
}else if(type==='time'){
condParts.push('time is between '+r.querySelector('.condition-after').value+' and '+r.querySelector('.condition-before').value);
}else if(type==='weekday'){
var days=[].map.call(r.querySelectorAll('.wday-cb:checked'),function(c){return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][+c.value];});
condParts.push('day is '+(days.join(', ')||'\u2014'));
}else if(type==='device_online'){
var dev=r.querySelector('.condition-device');
var dn=dev.options[dev.selectedIndex]?dev.options[dev.selectedIndex].text:'\u2026';
condParts.push(dn+' is '+(r.querySelector('.condition-device-status').value==='true'?'Online':'Offline'));
}
});
var actionParts=[];
document.querySelectorAll('#then-actions > .rule-sentence').forEach(function(r){
var type=r.dataset.type;
if(type==='notify'){
}else{
var devSel=r.querySelector('.action-device');
var dn=devSel.options[devSel.selectedIndex]?devSel.options[devSel.selectedIndex].textContent:'\u2026';
var val=r.querySelector('.action-value').value==='true'?'ON':'OFF';
actionParts.push('turn '+dn+' '+val);
}
});
if(!condParts.length&&!actionParts.length){
el.innerHTML='<span class=\"text-muted-hb\">Add a condition and an action to see a preview here.</span>';
return;
}
var joiner=isOr?' <span class=\"text-muted-hb\">or</span> ':' <span class=\"text-muted-hb\">and</span> ';
el.innerHTML='When <b>'+(condParts.join(joiner)||'\u2026')+'</b>, then <b>'+(actionParts.join(', ')||'\u2026')+'</b>.';
}
function closeTypeSheet(){
var sheet=document.getElementById('typeSheetBackdrop');
if(sheet)sheet.classList.remove('show');
var dd=document.querySelector('.type-dropdown');
if(dd)dd.remove();
}
var CONDITION_TYPES=[{value:'battery',icon:'bi-battery-half',label:'Battery Level'},{value:'grid',icon:'bi-plug-fill',label:'City Grid'},{value:'time',icon:'bi-clock-fill',label:'Time of Day'},{value:'weekday',icon:'bi-calendar-week',label:'Day of Week'},{value:'device_online',icon:'bi-wifi',label:'Device Online'}];
var ACTION_TYPES=[{value:'tuya',icon:'bi-toggle-on',label:'Device'}];
function openTypeSheet(title,options,onPick,anchor){
if(window.innerWidth>=770&&anchor){
var old=document.querySelector('.type-dropdown');
if(old)old.remove();
var dd=document.createElement('div');
dd.className='type-dropdown show';
dd.innerHTML='<div class="type-dd-head">'+escHtml(title)+'</div>'+options.map(function(o,i){return '<div class="type-dd-item" data-i="'+i+'"><i class="bi '+o.icon+'"></i>'+escHtml(o.label)+'</div>';}).join('');
anchor.parentNode.appendChild(dd);
var rect=anchor.getBoundingClientRect();
var top=rect.bottom+4;
if(top+dd.offsetHeight>window.innerHeight)top=rect.top-dd.offsetHeight-4;
dd.style.top=top+'px';
dd.style.left=Math.min(rect.left,window.innerWidth-260)+'px';
dd.querySelectorAll('.type-dd-item').forEach(function(t){t.onclick=function(){onPick(options[+t.dataset.i].value);dd.remove();};});
function close(e){if(!dd.contains(e.target)&&e.target!==anchor){dd.remove();document.removeEventListener('click',close);}}
setTimeout(function(){document.addEventListener('click',close);},0);
return;
}
var sheet=document.getElementById('typeSheetBackdrop');
if(!sheet){
sheet=document.createElement('div');
sheet.id='typeSheetBackdrop';
sheet.className='type-sheet-backdrop';
sheet.onclick=function(e){if(e.target===sheet)closeTypeSheet();};
document.body.appendChild(sheet);
}
sheet.innerHTML='<div class="type-sheet"><h4>'+escHtml(title)+'</h4><div class="type-grid">'+options.map(function(o,i){return '<div class="type-tile" data-i="'+i+'"><i class="bi '+o.icon+'"></i><span>'+escHtml(o.label)+'</span></div>';}).join('')+'</div></div>';
sheet.classList.add('show');
sheet.querySelectorAll('.type-tile').forEach(function(t){t.onclick=function(){onPick(options[+t.dataset.i].value);closeTypeSheet();};});
}
function populateDeviceSelects(){
const sels=document.querySelectorAll('.action-device');
const opts=tuyaDevices.map(d=>'<option value="'+escHtml(d.id)+'">'+escHtml(d.name)+'</option>').join('');
sels.forEach(s=>{const cur=s.value;s.innerHTML='<option value="">\\u2014 Device \\u2014</option>'+opts;if(cur)s.value=cur;});
}
async function saveScene(){
const name=document.getElementById('scene-name').value.trim();
if(!name)return;
const logic=document.getElementById('scene-logic').value;
const conds=[];
document.querySelectorAll('#if-conditions > .rule-sentence').forEach(r=>{
var t=r.dataset.type;
const v=r.querySelector('.condition-value');
const o=r.querySelector('.condition-operator');
if(!t)return;
let c;
if(t==='time'){
const after=r.querySelector('.condition-after');
const before=r.querySelector('.condition-before');
c={type:'time',after:after?after.value:'00:00',before:before?before.value:'23:59'};
}else if(t==='weekday'){
const cbs=r.querySelectorAll('.wday-cb:checked');
const days=Array.from(cbs).map(cb=>parseInt(cb.value));
c={type:'weekday',days};
}else{
let val=v?v.value:'';
if(t==='grid')val=val==='true';
else if(t==='battery')val=parseInt(val)||0;
else if(t==='device_online'){const dev=r.querySelector('.condition-device').value;const st=r.querySelector('.condition-device-status').value;val=dev;}
c={type:t,value:val};
if(t==='device_online')c.expectedStatus=r.querySelector('.condition-device-status').value==='true';
if(o&&o.value)c.operator=o.value;
}
conds.push(c);
});
if(conds.length===0)return;
const acts=[];
document.querySelectorAll('#then-actions > .rule-sentence').forEach(r=>{
var atype=r.dataset.type||'tuya';
if(atype==='notify'){
const title=r.querySelector('.action-title').value.trim();
const message=r.querySelector('.action-message').value.trim();
if(title||message)acts.push({type:'notify',title,message});
}else{
const d=r.querySelector('.action-device').value;
const v=r.querySelector('.action-value').value==='true';
const dur=parseInt(r.querySelector('.action-duration').value)||0;
const int=parseInt(r.querySelector('.action-interval').value)||0;
if(d)acts.push({type:'tuya',device:d,value:v,duration:dur,interval:int});
}
});
if(acts.length===0)return;
try{
await apiPost('/api/scenes',{name,if:{logic,conditions:conds},then:{actions:acts}});
document.getElementById('scene-name').value='';
document.getElementById('if-conditions').innerHTML='';
document.getElementById('then-actions').innerHTML='';
loadScenes();
}catch(e){showToast('Error',e.message,true);}
}
function escHtml(s){if(!s)return '';const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function haptic(p){try{if(navigator.vibrate)navigator.vibrate(typeof p==='number'?p:10);}catch(e){}}
function setAccent(name,save){
  if(!name)return;
  document.documentElement.dataset.accent=name;
  document.querySelectorAll(".accent-swatch").forEach(function(s){
    s.classList.toggle("active",s.dataset.accent===name);
  });
  if(!save)try{localStorage.setItem("ecmAccent",name);}catch(e){}
}
var ACCENTS=["purple","blue","green","orange","pink","cyan"];
function loadAccent(){try{var a=localStorage.getItem('ecmAccent')||'purple';setAccent(a,true);}catch(e){}}

// Load saved accent on DOM ready
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',loadAccent);}else{loadAccent();}
async function logout(){try{await apiPost('/api/logout',{});}catch(e){}window.location.href='/login';}
function resetRestartOverlay(){const ov=document.getElementById('restartOverlay');ov.classList.remove('show');const sp=ov.querySelector('.restart-spinner');if(sp)sp.style.display='';const ci=ov.querySelector('.check-icon');if(ci)ci.remove();ov.querySelector('h3').innerHTML='Restarting<span class="restart-dots"></span>';ov.querySelector('p').textContent='Waiting for server to come back online';}
async function restartApp(){
  resetRestartOverlay();
  document.getElementById('restartModal').classList.remove('show');
  document.getElementById('restartOverlay').classList.add('show');
  try{await apiPost('/api/restart',{});}catch(e){}
  const start=Date.now();
  const iv=setInterval(async()=>{
    if(Date.now()-start>60000){clearInterval(iv);document.getElementById('restartOverlay').classList.remove('show');showToast('Restart timed out','Server did not respond. Check the device.',true);return;}
    try{const r=await fetch('/healthz',{signal:AbortSignal.timeout(3000)});if(r.ok){clearInterval(iv);window.location.reload();}}catch{}
  },2000);
}
function toggleSidebar(){if(window.innerWidth<=768)return;const s=document.querySelector('.sidebar');const isOpen=s.classList.contains('open');s.classList.toggle('open');localStorage.setItem('sidebarOpen',isOpen?'0':'1');const btn=document.querySelector('.sidebar-toggle i');if(btn)btn.className=isOpen?'bi bi-chevron-right':'bi bi-chevron-left';}


// ============================================================

// ============================================================
// HISTORY CHART
// ============================================================
let historyChart=null;
let currentPeriod='day';

const gridBandsPlugin={id:'gridBands',beforeDraw(chart){const{ctx,chartArea,scales}=chart;if(!chartArea)return;const xScale=scales.x;const ds=chart.data.datasets.find(d=>d._isGrid);if(!ds||!ds.data.length)return;ctx.save();for(let i=0;i<ds.data.length;i++){const val=ds.data[i];if(val===null||val===undefined)continue;const x1=xScale.getPixelForValue(i);const x2=i<ds.data.length-1?xScale.getPixelForValue(i+1):xScale.right;ctx.fillStyle=val?'rgba(34,197,94,0.1)':'rgba(239,68,68,0.1)';ctx.fillRect(x1,chartArea.top,x2-x1,chartArea.height);}ctx.restore();}};

const lineLabelsPlugin={id:'lineLabels',afterDraw(chart){const{ctx,chartArea,scales}=chart;if(!chartArea)return;const xScale=scales.x;const yScale=scales.y;ctx.save();chart.data.datasets.forEach((ds,di)=>{if(!ds._lineLabel||!ds.data.length)return;const meta=chart.getDatasetMeta(di);if(meta.hidden)return;const firstPt=meta.data[0];if(!firstPt)return;const x=firstPt.x;const y=firstPt.y;if(y<chartArea.top-10||y>chartArea.bottom+10)return;ctx.font='bold 11px -apple-system,BlinkMacSystemFont,sans-serif';ctx.textBaseline='middle';const lbl=ds._lineLabel;const col=typeof ds.borderColor==='string'?ds.borderColor:'#98989f';ctx.fillStyle=col;const m=ctx.measureText(lbl);const px=Math.max(chartArea.left+2,Math.min(x-m.width-6,chartArea.right-m.width-4));ctx.fillRect(px-3,y-9,m.width+10,18);ctx.fillStyle='rgba(28,28,30,0.85)';ctx.fillRect(px-3,y-9,m.width+10,18);ctx.fillStyle=col;ctx.fillText(lbl,px,y);});ctx.restore();}};

function renderCurrentValues(elId,items){const el=document.getElementById(elId);if(!el)return;el.innerHTML=items.map(i=>'<span class="cc-item"><span class="cc-dot" style="background:'+i.color+'"></span>'+i.label+': <span class="cc-val">'+i.value+'</span></span>').join('');}
async function loadHistory(period){
currentPeriod=period||currentPeriod;
try{
const r=await fetch('/api/history?period='+currentPeriod);
const d=await r.json();
if(!d.success||!d.points||d.points.length===0){if(historyChart){historyChart.destroy();historyChart=null;}return;}
const labels=d.points.map(p=>{const dt=new Date(p.ts);if(currentPeriod==='day'||currentPeriod==='1h'||currentPeriod==='3h'||currentPeriod==='6h'||currentPeriod==='12h')return dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});if(currentPeriod==='week')return dt.toLocaleDateString([],{weekday:'short',hour:'2-digit',minute:'2-digit'});if(currentPeriod==='month')return dt.toLocaleDateString([],{day:'numeric',hour:'2-digit'});return dt.toLocaleDateString([],{month:'short',day:'numeric'});});
const loadData=d.points.map(p=>p.load);
const batData=d.points.map(p=>p.bat);
const gridData=d.points.map(p=>p.grid);
const ctx=document.getElementById('historyChart');
if(!ctx)return;
if(historyChart)historyChart.destroy();
historyChart=new Chart(ctx,{type:'line',plugins:[lineLabelsPlugin],data:{labels,datasets:[
{label:'Load (W)',data:loadData,_lineLabel:'Load',borderColor:'#3b82f6',backgroundColor:'rgba(59,130,246,0.06)',fill:true,tension:0.3,pointRadius:0,borderWidth:2,order:1,segment:{borderColor:ctx2=>{const gi=gridData[ctx2.p0DataIndex];return gi?'#3b82f6':'#333333';}}},
{label:'Battery (W)',data:batData,_lineLabel:'Battery',borderColor:'#22c55e',fill:false,tension:0.3,pointRadius:0,borderWidth:2,order:2,segment:{borderColor:ctx2=>{const v=batData[ctx2.p0DataIndex];return v>=0?'#22c55e':'#ef4444';}}}
]},options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,30,0.95)',titleColor:'#f5f5f7',bodyColor:'#f5f5f7',borderColor:'rgba(255,255,255,0.09)',borderWidth:0.5,cornerRadius:10,padding:10,displayColors:true,callbacks:{label:function(ctx2){if(ctx2.dataset.label==='Load (W)')return 'Load: '+ctx2.raw+'W';if(ctx2.dataset.label==='Battery (W)')return 'Battery: '+(ctx2.raw>=0?'+':'')+ctx2.raw+'W';return ctx2.dataset.label+': '+ctx2.raw;},title:function(items){if(!items.length)return '';const idx=items[0].dataIndex;const pt=d.points[idx];const gridTxt=pt?'Grid: '+(pt.grid?'ON':'OFF'):'';return items[0].label+(gridTxt?' | '+gridTxt:'');}}}},scales:{x:{ticks:{color:'#98989f',font:{size:10},maxTicksLimit:currentPeriod==='day'||currentPeriod==='1h'||currentPeriod==='3h'||currentPeriod==='6h'||currentPeriod==='12h'?12:currentPeriod==='week'?14:currentPeriod==='month'?12:12,maxRotation:0},grid:{color:'rgba(255,255,255,0.04)'}},y:{ticks:{color:'#98989f',font:{size:10},callback:v=>v+'W'},grid:{color:'rgba(255,255,255,0.04)'}}}}});
const lp=d.points[d.points.length-1];
renderCurrentValues('historyCurrent',[
{label:'Load',value:lp.load+'W',color:'#3b82f6'},
{label:'Battery',value:(lp.bat>=0?'+':'')+lp.bat+'W',color:lp.bat>=0?'#22c55e':'#ef4444'},
{label:'Grid',value:lp.grid?'ON':'OFF',color:lp.grid?'#22c55e':'#ef4444'}
]);
}catch(e){console.error('loadHistory',e);}
}

document.querySelectorAll('#chartTabs .chart-tab').forEach(tab=>{
tab.addEventListener('click',function(){
document.querySelectorAll('#chartTabs .chart-tab').forEach(t=>t.classList.remove('active'));
this.classList.add('active');
loadHistory(this.dataset.period);
});
});

// ============================================================
// SOCKET POWER CHART
// ============================================================
let socketChart=null;
let socketPeriod='day';
const socketColors=['#3b82f6','#f59e0b','#a855f7','#ef4444','#22c55e','#06b6d4','#f97316','#ec4899','#14b8a6','#8b5cf6'];
let socketColorMap={};
let socketColorIdx=0;
function getSocketColor(id){if(!socketColorMap[id]){socketColorMap[id]=socketColors[socketColorIdx%socketColors.length];socketColorIdx++;}return socketColorMap[id];}

async function loadSocketHistory(period){
socketPeriod=period||socketPeriod;
try{
const r=await fetch('/api/socket-history?period='+socketPeriod);
const d=await r.json();
if(!d.success||!d.points||d.points.length===0){if(socketChart){socketChart.destroy();socketChart=null;}document.getElementById('socketChart').parentElement.style.display='none';return;}
document.getElementById('socketChart').parentElement.style.display='';
const allIds=new Set();
d.points.forEach(p=>{if(p.devices)Object.keys(p.devices).forEach(k=>allIds.add(k));});
if(allIds.size===0){if(socketChart){socketChart.destroy();socketChart=null;}return;}
const labels=d.points.map(p=>{const dt=new Date(p.ts);if(socketPeriod==='day'||socketPeriod==='1h'||socketPeriod==='3h'||socketPeriod==='6h'||socketPeriod==='12h')return dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});if(socketPeriod==='week')return dt.toLocaleDateString([],{weekday:'short',hour:'2-digit',minute:'2-digit'});if(socketPeriod==='month')return dt.toLocaleDateString([],{day:'numeric',hour:'2-digit'});return dt.toLocaleDateString([],{month:'short',day:'numeric'});});
const datasets=[];
for(const id of allIds){
const data=d.points.map(p=>p.devices&&p.devices[id]!=null?p.devices[id]:null);
const name=d.deviceNames&&d.deviceNames[id]?d.deviceNames[id]:id.slice(-6);
const col=getSocketColor(id);
datasets.push({label:name,data,borderColor:col,backgroundColor:col+'15',fill:false,tension:0.3,pointRadius:0,borderWidth:2,spanGaps:true,_lineLabel:name});
}
const ctx=document.getElementById('socketChart');
if(!ctx)return;
if(socketChart)socketChart.destroy();
socketChart=new Chart(ctx,{type:'line',plugins:[lineLabelsPlugin],data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,30,0.95)',titleColor:'#f5f5f7',bodyColor:'#f5f5f7',borderColor:'rgba(255,255,255,0.09)',borderWidth:0.5,cornerRadius:10,padding:10,displayColors:true,callbacks:{label:function(ctx2){return ctx2.dataset.label+': '+ctx2.raw+'W';}}}},scales:{x:{ticks:{color:'#98989f',font:{size:10},maxTicksLimit:socketPeriod==='day'||socketPeriod==='1h'||socketPeriod==='3h'||socketPeriod==='6h'||socketPeriod==='12h'?12:socketPeriod==='week'?14:12,maxRotation:0},grid:{color:'rgba(255,255,255,0.04)'}},y:{ticks:{color:'#98989f',font:{size:10},callback:v=>v+'W'},grid:{color:'rgba(255,255,255,0.04)'}}}}});
const lastPt=d.points[d.points.length-1];
const siItems=[];
for(const id of allIds){const nm=d.deviceNames&&d.deviceNames[id]?d.deviceNames[id]:id.slice(-6);const val=lastPt.devices&&lastPt.devices[id]!=null?lastPt.devices[id]:0;siItems.push({label:nm,value:val+'W',color:getSocketColor(id)});}
renderCurrentValues('socketCurrent',siItems);
}catch(e){console.error('loadSocketHistory',e);}
}
document.querySelectorAll('#socketChartTabs .chart-tab').forEach(tab=>{
tab.addEventListener('click',function(){
document.querySelectorAll('#socketChartTabs .chart-tab').forEach(t=>t.classList.remove('active'));
this.classList.add('active');
loadSocketHistory(this.dataset.period);
});
});

// ============================================================
// OTHER LOAD CHART (load minus sockets)
// ============================================================
let otherChart=null;
let otherPeriod='day';

async function loadOtherHistory(period){
otherPeriod=period||otherPeriod;
try{
const d=await(await fetch('/api/history?period='+otherPeriod)).json();
if(!d.success||!d.points||d.points.length===0){if(otherChart){otherChart.destroy();otherChart=null;}document.getElementById('otherChart').parentElement.style.display='none';return;}
document.getElementById('otherChart').parentElement.style.display='';
const labels=d.points.map(p=>{const dt=new Date(p.ts);if(otherPeriod==='day'||otherPeriod==='1h'||otherPeriod==='3h'||otherPeriod==='6h'||otherPeriod==='12h')return dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});if(otherPeriod==='week')return dt.toLocaleDateString([],{weekday:'short',hour:'2-digit',minute:'2-digit'});if(otherPeriod==='month')return dt.toLocaleDateString([],{day:'numeric',hour:'2-digit'});return dt.toLocaleDateString([],{month:'short',day:'numeric'});});
const loadData=d.points.map(p=>p.load);
const otherData=d.points.map(p=>p.otherLoad!=null?p.otherLoad:0);
const sumData=d.points.map(p=>Math.max(0,Math.round((p.load-(p.otherLoad||0))*10)/10));
const ctx=document.getElementById('otherChart');
if(!ctx)return;
if(otherChart)otherChart.destroy();
otherChart=new Chart(ctx,{type:'line',plugins:[lineLabelsPlugin],data:{labels,datasets:[
{label:'Load (W)',data:loadData,borderColor:'#6366f1',backgroundColor:'rgba(99,102,241,0.06)',fill:true,tension:0.3,pointRadius:0,borderWidth:2,order:1,_lineLabel:'Load'},
{label:'Socket Sum (W)',data:sumData,borderColor:'#00e5ff',backgroundColor:'rgba(0,229,255,0.06)',fill:false,tension:0.3,pointRadius:0,borderWidth:2,order:2,_lineLabel:'Sockets'},
{label:'Other Load (W)',data:otherData,borderColor:'#f59e0b',backgroundColor:'rgba(245,158,11,0.06)',fill:true,tension:0.3,pointRadius:0,borderWidth:2,order:3,_lineLabel:'Other'}
]},options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,30,0.95)',titleColor:'#f5f5f7',bodyColor:'#f5f5f7',borderColor:'rgba(255,255,255,0.09)',borderWidth:0.5,cornerRadius:10,padding:10,displayColors:true,callbacks:{label:function(ctx2){return ctx2.dataset.label.split(' (')[0]+': '+ctx2.raw+'W';}}}},scales:{x:{ticks:{color:'#98989f',font:{size:10},maxTicksLimit:otherPeriod==='day'||otherPeriod==='1h'||otherPeriod==='3h'||otherPeriod==='6h'||otherPeriod==='12h'?12:otherPeriod==='week'?14:12,maxRotation:0},grid:{color:'rgba(255,255,255,0.04)'}},y:{ticks:{color:'#98989f',font:{size:10},callback:v=>v+'W'},grid:{color:'rgba(255,255,255,0.04)'}}}}});
const olp=d.points[d.points.length-1];
const lastSum=sumData[sumData.length-1]||0;
renderCurrentValues('otherCurrent',[
{label:'Load',value:olp.load+'W',color:'#6366f1'},
{label:'Sockets',value:lastSum+'W',color:'#00e5ff'},
{label:'Other',value:(olp.otherLoad||0)+'W',color:'#f59e0b'}
]);
}catch(e){console.error('loadOtherHistory',e);}
}
document.querySelectorAll('#otherChartTabs .chart-tab').forEach(tab=>{
tab.addEventListener('click',function(){
document.querySelectorAll('#otherChartTabs .chart-tab').forEach(t=>t.classList.remove('active'));
this.classList.add('active');
loadOtherHistory(this.dataset.period);
});
});

async function changePassword(){
const cur=document.getElementById('cp-current').value;
const nw=document.getElementById('cp-new').value;
const cf=document.getElementById('cp-confirm').value;
if(!cur||!nw){showToast('Error','Fill in all fields.',true);return;}
if(nw.length<6){showToast('Error','New password must be at least 6 characters.',true);return;}
if(nw!==cf){showToast('Error','Passwords do not match.',true);return;}
const btn=document.querySelector('[onclick="changePassword()"]');
if(btn){btn.disabled=true;btn.innerHTML='<i class="bi bi-hourglass-split"></i> Saving...';}
try{const h={'Content-Type':'application/json'};if(_csrfToken)h['X-CSRF-Token']=_csrfToken;const r=await fetch('/api/change-password',{method:'POST',headers:h,body:JSON.stringify({currentPassword:cur,newPassword:nw})});const d=await r.json();if(d.success){resetRestartOverlay();const ov=document.getElementById('restartOverlay');ov.querySelector('.restart-spinner').style.display='none';const ci=document.createElement('div');ci.className='check-icon';ci.innerHTML='<i class="bi bi-check-lg"></i>';ov.querySelector('.restart-spinner').parentNode.insertBefore(ci,ov.querySelector('h3'));ov.querySelector('h3').textContent='Password changed';ov.querySelector('p').textContent='Please log in with your new password';ov.classList.add('show');setTimeout(()=>{window.location.href='/login';},2500);}else{showToast('Error',d.message||'Failed.',true);if(btn){btn.disabled=false;btn.innerHTML='<i class="bi bi-shield-lock"></i> Change Password';}}}
catch(e){showToast('Error',e.message,true);if(btn){btn.disabled=false;btn.innerHTML='<i class="bi bi-shield-lock"></i> Change Password';}}
}
async function loadPluginConfig(){
try{
const d=await apiGet('/api/plugin-config');
if(!d.success){showToast('Error',d.message||'Failed to load config',true);return;}
const c=d.config;
document.getElementById('cfg-inverter-ip').value=(c.inverter&&c.inverter.ip)||'';
document.getElementById('cfg-inverter-serial').value=(c.inverter&&c.inverter.serial)||'';
document.getElementById('cfg-inverter-port').value=(c.inverter&&c.inverter.port)||8899;document.getElementById('cfg-inverter-mac').value=(c.inverter&&c.inverter.mac)||'';document.getElementById('cfg-inverter-autoResolve').checked=!!(c.inverter&&c.inverter.autoResolve);document.getElementById('cfg-inverter-resolveAfterFails').value=(c.inverter&&c.inverter.resolveAfterFails)||10;if(document.getElementById('cfg-inverter-autoResolve').checked)document.getElementById('resolveAfterFails-row').style.display='block';
document.getElementById('cfg-tuya-accessId').value=(c.tuya&&c.tuya.accessId)||'';
document.getElementById('cfg-tuya-accessKey').value=(c.tuya&&c.tuya.accessKey)||'';
document.getElementById('cfg-tuya-countryCode').value=(c.tuya&&c.tuya.countryCode)||48;
document.getElementById('cfg-tuya-username').value=(c.tuya&&c.tuya.username)||'';
document.getElementById('cfg-tuya-password').value=(c.tuya&&c.tuya.password)||'';
document.getElementById('cfg-tuya-appSchema').value=(c.tuya&&c.tuya.appSchema)||'tuyaSmart';
 document.getElementById('cfg-webPort').value=c.webPort||8583;
 document.getElementById('cfg-ntfy-topic').value=(c.notifications&&c.notifications.ntfyTopic)||'';
 document.getElementById('cfg-ntfy-enabled').checked=(c.notifications&&c.notifications.ntfyEnabled!==false);
 document.getElementById('cfg-tg-token').value=(c.notifications&&c.notifications.telegramToken)||'';
 document.getElementById('cfg-tg-chat').value=(c.notifications&&c.notifications.telegramChatId)||'';
 document.getElementById('cfg-tg-enabled').checked=(c.notifications&&c.notifications.telegramEnabled!==false);
 document.getElementById('cfg-notif-enabled').checked=(c.notifications&&c.notifications.notifEnabled!==false);
 document.getElementById('cfg-ntfy-notif-enabled').checked=(c.notifications&&c.notifications.ntfyNotifEnabled!==false);
 document.getElementById('cfg-tg-notif-enabled').checked=(c.notifications&&c.notifications.telegramNotifEnabled!==false);
 const ntfye=document.getElementById('notif-ntfy-row');if(ntfye)ntfye.style.display=(c.notifications&&c.notifications.ntfyEnabled!==false)?'flex':'none';
 const tge=document.getElementById('notif-tg-row');if(tge)tge.style.display=(c.notifications&&c.notifications.telegramEnabled!==false)?'flex':'none';
 document.getElementById('cfg-notif-critical-enabled').checked=(c.notifications&&c.notifications.criticalEnabled!==false);
 document.getElementById('cfg-soc-alert').value=(c.notifications&&c.notifications.lowSocAlert)||20;
 document.getElementById('cfg-conn-timeout').value=(c.notifications&&c.notifications.connTimeout)||10;
 document.getElementById('critical-fields').style.display=(c.notifications&&c.notifications.criticalEnabled!==false)?'block':'none';
 document.getElementById('cfg-notif-grid-outage').checked=(c.notifications&&c.notifications.gridOutageReport!==false);
 const ha=c.healthAlerts||{};
 document.getElementById('cfg-health-enabled').checked=ha.enabled!==false;
 document.getElementById('cfg-health-disk').value=ha.diskThreshold||20;
 document.getElementById('cfg-health-cpu-temp').value=ha.cpuTempThreshold||80;
 document.getElementById('cfg-health-cpu-load').value=ha.cpuLoadThreshold||5;
 document.getElementById('cfg-health-mem').value=ha.memThreshold||15;
 document.getElementById('health-fields').style.display=ha.enabled!==false?'block':'none';
 document.getElementById('ntfy-fields').style.display=(c.notifications&&c.notifications.ntfyEnabled!==false)?'block':'none';
 document.getElementById('tg-fields').style.display=(c.notifications&&c.notifications.telegramEnabled!==false)?'block':'none';
 const tf=c.tariff||{};
 document.getElementById('cfg-tariff-currency').value=tf.currency||'UAH';
 document.getElementById('cfg-tariff-type').value=tf.type||'daynight';
 document.getElementById('cfg-tariff-flat-rate').value=tf.flatRate||0;
 document.getElementById('cfg-tariff-day-rate').value=tf.dayRate||0;
 document.getElementById('cfg-tariff-night-rate').value=tf.nightRate||0;
 document.getElementById('cfg-tariff-day-start').value=tf.dayStart||'07:00';
 document.getElementById('cfg-tariff-night-start').value=tf.nightStart||'23:00';
  document.getElementById('cfg-netbird-setupKey').value=(c.netbird&&c.netbird.setupKey)||'';
 document.getElementById('cfg-netbird-managementUrl').value=(c.netbird&&c.netbird.managementUrl)||'';
 document.getElementById('cfg-netbird-enabled').checked=!!(c.netbird&&c.netbird.enabled);
 document.getElementById('netbird-fields').style.display=(c.netbird&&c.netbird.enabled)?'block':'none';
toggleTariffFields();

}catch(e){}
}
async function scanInverterNetwork(){const st=document.getElementById('scan-status');const btn=document.getElementById('btn-scan-inv');st.textContent='Scanning...';btn.disabled=true;try{const r=await apiPost('/api/inverter/scan',{});if(r.success){if(r.ip){st.innerHTML='Found: <b>'+r.ip+'</b>'+(r.updated?' (saved, reconnecting...)':'');if(r.updated)setTimeout(()=>{if(window._lastData)loadStatus();},2000);}else st.textContent='Not found';}else st.textContent=r.message||'Failed';}catch(e){st.textContent=e.message;}btn.disabled=false;setTimeout(()=>{st.textContent='';},8000);}

async function savePluginConfig(){
try{
const cfg={
inverter:{ip:document.getElementById('cfg-inverter-ip').value.trim(),serial:document.getElementById('cfg-inverter-serial').value.trim(),port:parseInt(document.getElementById('cfg-inverter-port').value)||8899,mac:(function(){const r=document.getElementById('cfg-inverter-mac').value.replace(/[^a-fA-F0-9]/g,'').toUpperCase();return r.length===12?r.replace(/(..)/g,'$1:').slice(0,-1):r;})(),autoResolve:document.getElementById('cfg-inverter-autoResolve').checked,resolveAfterFails:parseInt(document.getElementById('cfg-inverter-resolveAfterFails').value)||10},
tuya:{accessId:document.getElementById('cfg-tuya-accessId').value.trim(),accessKey:document.getElementById('cfg-tuya-accessKey').value,countryCode:parseInt(document.getElementById('cfg-tuya-countryCode').value)||48,username:document.getElementById('cfg-tuya-username').value.trim(),password:document.getElementById('cfg-tuya-password').value,appSchema:document.getElementById('cfg-tuya-appSchema').value},
webPort:parseInt(document.getElementById('cfg-webPort').value)||8583,
netbird:{setupKey:document.getElementById('cfg-netbird-setupKey').value,managementUrl:document.getElementById('cfg-netbird-managementUrl').value.trim(),enabled:document.getElementById('cfg-netbird-enabled').checked},
notifications:{ntfyEnabled:document.getElementById('cfg-ntfy-enabled').checked,ntfyNotifEnabled:document.getElementById('cfg-ntfy-notif-enabled').checked,ntfyTopic:document.getElementById('cfg-ntfy-topic').value.trim(),telegramEnabled:document.getElementById('cfg-tg-enabled').checked,telegramNotifEnabled:document.getElementById('cfg-tg-notif-enabled').checked,telegramToken:document.getElementById('cfg-tg-token').value,telegramChatId:document.getElementById('cfg-tg-chat').value.trim(),criticalEnabled:document.getElementById('cfg-notif-critical-enabled').checked,lowSocAlert:parseInt(document.getElementById('cfg-soc-alert').value)||20,connTimeout:parseInt(document.getElementById('cfg-conn-timeout').value)||10,gridOutageReport:document.getElementById('cfg-notif-grid-outage').checked}
};
const r=await apiPost('/api/plugin-config',{config:cfg});
if(r.success){document.getElementById('restartModal').classList.add('show');}else showToast('Error',r.message||'Save failed',true);
}catch(e){showToast('Error',e.message,true);}
}
async function saveNotifConfig(){
const cfg={
notifications:{notifEnabled:document.getElementById('cfg-notif-enabled').checked,ntfyNotifEnabled:document.getElementById('cfg-ntfy-notif-enabled').checked,telegramNotifEnabled:document.getElementById('cfg-tg-notif-enabled').checked,criticalEnabled:document.getElementById('cfg-notif-critical-enabled').checked,gridOutageReport:document.getElementById('cfg-notif-grid-outage').checked,lowSocAlert:parseInt(document.getElementById('cfg-soc-alert').value)||20,connTimeout:parseInt(document.getElementById('cfg-conn-timeout').value)||10},
healthAlerts:{enabled:document.getElementById('cfg-health-enabled').checked,diskThreshold:parseInt(document.getElementById('cfg-health-disk').value)||20,cpuTempThreshold:parseInt(document.getElementById('cfg-health-cpu-temp').value)||80,cpuLoadThreshold:parseFloat(document.getElementById('cfg-health-cpu-load').value)||5,memThreshold:parseInt(document.getElementById('cfg-health-mem').value)||15}
};
const st=document.getElementById('notif-status');st.style.display='block';st.innerHTML='<i class="bi bi-hourglass-split"></i> Saving...';
try{const r=await apiPost('/api/plugin-config',{config:cfg});if(r.success){st.innerHTML='<i class="bi bi-check-circle" style="color:#22c55e"></i> Saved.';setTimeout(()=>st.style.display='none',3000);}else st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+(r.message||'Error');}catch(e){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+e.message;}
}
async function testNotification(){
const st=document.getElementById('notif-status');st.style.display='block';st.innerHTML='<i class="bi bi-hourglass-split"></i> Sending...';
try{const r=await apiPost('/api/test-notification',{});st.innerHTML=r.results&&r.results.length?'<span style="color:var(--text)">'+r.results.join('<br>')+'</span>':'<span style="color:#22c55e">Sent</span>';}catch(e){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+e.message;}
}
function toggleTariffFields(){const t=document.getElementById('cfg-tariff-type').value;document.getElementById('tariff-flat-fields').style.display=t==='flat'?'block':'none';document.getElementById('tariff-daynight-fields').style.display=t==='daynight'?'block':'none';}
async function saveTariffConfig(){
const cfg={tariff:{
currency:document.getElementById('cfg-tariff-currency').value.trim()||'UAH',
type:document.getElementById('cfg-tariff-type').value||'daynight',
flatRate:parseFloat(document.getElementById('cfg-tariff-flat-rate').value)||0,
dayRate:parseFloat(document.getElementById('cfg-tariff-day-rate').value)||0,
nightRate:parseFloat(document.getElementById('cfg-tariff-night-rate').value)||0,
dayStart:document.getElementById('cfg-tariff-day-start').value||'07:00',
nightStart:document.getElementById('cfg-tariff-night-start').value||'23:00'
}};
const st=document.getElementById('tariff-status');st.style.display='block';st.innerHTML='<i class="bi bi-hourglass-split"></i> Saving...';
try{const r=await apiPost('/api/plugin-config',{config:cfg});if(r.success){st.innerHTML='<i class="bi bi-check-circle" style="color:#22c55e"></i> Saved';setTimeout(()=>st.style.display='none',3000);}else st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+(r.message||'Error');}catch(e){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+e.message;}
}
async function netbirdUp(){
const st=document.getElementById('netbird-status');st.style.display='block';st.innerHTML='<i class="bi bi-hourglass-split"></i> Connecting...';st.style.color='#3b82f6';
try{const r=await apiPost('/api/netbird/up',{});if(r.success){st.innerHTML='<i class="bi bi-check-circle" style="color:#22c55e"></i> '+r.message;document.getElementById('cfg-netbird-enabled').checked=true;document.getElementById('netbird-fields').style.display='block';}else{st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+(r.message||'Failed');st.style.color='#ef4444';}}catch(e){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+e.message;st.style.color='#ef4444';}
}
async function netbirdDown(){
const st=document.getElementById('netbird-status');st.style.display='block';st.innerHTML='<i class="bi bi-hourglass-split"></i> Disconnecting...';st.style.color='#f59e0b';
try{const r=await apiPost('/api/netbird/down',{});if(r.success){st.innerHTML='<i class="bi bi-check-circle" style="color:#22c55e"></i> '+r.message;document.getElementById('cfg-netbird-enabled').checked=false;document.getElementById('netbird-fields').style.display='none';}else{st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+(r.message||'Failed');st.style.color='#ef4444';}}catch(e){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+e.message;st.style.color='#ef4444';}
}
async function refreshNetbirdStatus(){
try{const r=await apiGet('/api/netbird/status');const st=document.getElementById('netbird-status');if(r.success){const lines=r.status.split('\\n').filter(l=>l.trim());const brief=lines.filter(l=>l.includes('Daemon')||l.includes('Status')||l.includes('IP')||l.includes('Peers')).join('\\n')||r.status;st.style.display='block';st.style.color='var(--text)';st.textContent=brief||(r.enabled?'Connected':'Disconnected');}else{if(st){st.style.display='block';st.style.color='#ef4444';st.textContent=r.status||'Disconnected';}document.getElementById('cfg-netbird-enabled').checked=false;}}catch{}
}
function copyMetricsUrl(){
const el=document.getElementById('cfg-metrics-url');
if(!el||!el.value)return;
el.select();
try{navigator.clipboard.writeText(el.value);showToast('Copied','Metrics URL copied to clipboard');}catch(e){document.execCommand('copy');}
}
// Tile registry
const TILE_REGISTRY=[
// Main tiles
{id:'tile-grid',label:'City Grid',icon:'bi-plug',cat:'main',def:true,update:d=>{const on=d.gridPower===true;return{value:on?'ON':'OFF',sub:(on&&d.gridVoltage>0)?d.gridVoltage.toFixed(1)+'V':'\u2014',cls:on?'on':'off'};}},
{id:'tile-battery',label:'Battery',icon:'bi-battery-half',cat:'main',def:true,update:d=>{const bp=d.batteryPower||0;return{value:(d.batterySOC||0)+'%',sub:bp>0?'+'+bp+'W':bp<0?bp+'W':'0W'};}},
{id:'tile-pv',label:'Solar PV',icon:'bi-sun',cat:'main',def:true,update:d=>{const pv1=d.pvPower||0,pv2=d.pvPower2||0;return{value:(pv1+pv2)?(pv1+pv2)+'W':'0W',sub:pv2>0?'PV1='+pv1+'W PV2='+pv2+'W':'PV='+pv1+'W'};}},
{id:'tile-load',label:'Load',icon:'bi-laptop',cat:'main',def:true,update:d=>({value:d.loadPower?d.loadPower+'W':'0W',sub:new Date().toLocaleTimeString()})},
{id:'tile-day-pv',label:'Solar Today',icon:'bi-sun',cat:'main',def:true,update:d=>({value:(d.dayPV||0).toFixed(1)+' kWh',sub:''})},
{id:'tile-day-import',label:'Grid Import',icon:'bi-box-arrow-in-down',cat:'main',def:true,update:d=>({value:(d.dayGridImport||0).toFixed(1)+' kWh',sub:'today'})},
{id:'tile-day-export',label:'Grid Export',icon:'bi-box-arrow-up',cat:'main',def:true,update:d=>({value:(d.dayGridExport||0).toFixed(1)+' kWh',sub:'today'})},
{id:'tile-day-load',label:'Load Today',icon:'bi-lightning',cat:'main',def:true,update:d=>({value:(d.dayLoadEnergy||0).toFixed(1)+' kWh',sub:'consumed'})},
{id:'tile-day-batcharge',label:'Bat Charge',icon:'bi-battery-charging',cat:'main',def:true,update:d=>({value:(d.dayBatCharge||0).toFixed(1)+' kWh',sub:'today'})},
{id:'tile-day-batdischarge',label:'Bat Discharge',icon:'bi-battery',cat:'main',def:true,update:d=>({value:(d.dayBatDischarge||0).toFixed(1)+' kWh',sub:'today'})},
{id:'tile-battemp',label:'Battery Temp',icon:'bi-thermometer-half',cat:'main',def:true,update:d=>({value:(d.batteryTemp||0).toFixed(1)+' °C',sub:''})},
{id:'tile-envtemp',label:'Environment',icon:'bi-thermometer',cat:'main',def:true,update:d=>({value:(d.envTemp||0).toFixed(1)+' °C',sub:'temperature'})},
// DC Block debug tiles
{id:'tile-d-overall',label:'Overall State',icon:'bi-gear',cat:'dc',def:false,update:(_,g)=>({value:g.overallState??'--',sub:'reg59'})},
{id:'tile-d-dayActive',label:'Day Active',icon:'bi-graph-up',cat:'dc',def:false,update:(_,g)=>({value:(g.dayActiveEnergy??0)+' kWh',sub:'reg60'})},
{id:'tile-d-monthPV',label:'Month PV',icon:'bi-sun',cat:'dc',def:false,update:(_,g)=>({value:(g.monthPV??0)+' kWh',sub:'reg65'})},
{id:'tile-d-monthLoad',label:'Month Load',icon:'bi-lightning',cat:'dc',def:false,update:(_,g)=>({value:(g.monthLoad??0)+' kWh',sub:'reg66'})},
{id:'tile-d-monthGrid',label:'Month Grid',icon:'bi-plug',cat:'dc',def:false,update:(_,g)=>({value:(g.monthGrid??0)+' kWh',sub:'reg67'})},
{id:'tile-d-totalBatChg',label:'Total Bat Charge',icon:'bi-battery-charging',cat:'dc',def:false,update:(_,g)=>({value:(g.totalBatCharge??0)+' kWh',sub:'reg72-73'})},
{id:'tile-d-totalBatDisch',label:'Total Bat Discharge',icon:'bi-battery',cat:'dc',def:false,update:(_,g)=>({value:(g.totalBatDischarge??0)+' kWh',sub:'reg74-75'})},
{id:'tile-d-totalGridImp',label:'Total Grid Import',icon:'bi-box-arrow-in-down',cat:'dc',def:false,update:(_,g)=>({value:(g.totalGridImport??0)+' kWh',sub:'reg78+80'})},
{id:'tile-d-totalGridExp',label:'Total Grid Export',icon:'bi-box-arrow-up',cat:'dc',def:false,update:(_,g)=>({value:(g.totalGridExport??0)+' kWh',sub:'reg81-82'})},
{id:'tile-d-gridFreq',label:'Grid Frequency',icon:'bi-activity',cat:'dc',def:false,update:(_,g)=>({value:(g.gridFreq??0)+' Hz',sub:'reg79'})},
{id:'tile-d-totalLoad',label:'Total Load',icon:'bi-graph-down',cat:'dc',def:false,update:(_,g)=>({value:(g.totalLoadEnergy??0)+' kWh',sub:'reg85-86'})},
{id:'tile-d-totalPV',label:'Total PV',icon:'bi-sun',cat:'dc',def:false,update:(_,g)=>({value:(g.totalPV??0)+' kWh',sub:'reg96-97'})},
{id:'tile-d-yearGridExp',label:'Year Grid Export',icon:'bi-calendar',cat:'dc',def:false,update:(_,g)=>({value:(g.yearGridExport??0)+' kWh',sub:'reg98-99'})},
{id:'tile-d-dcTransfTemp',label:'DC Transformer',icon:'bi-thermometer-half',cat:'dc',def:false,update:(_,g)=>({value:(g.dcTransfTemp??0)+' °C',sub:'reg90'})},
{id:'tile-d-radiator',label:'Radiator Temp',icon:'bi-thermometer',cat:'dc',def:false,update:(_,g)=>({value:(g.radiatorTemp??0)+' °C',sub:'reg91'})},
{id:'tile-d-pv1V',label:'PV1 Voltage',icon:'bi-lightning',cat:'dc',def:false,update:(_,g)=>({value:(g.pv1Voltage??0)+' V',sub:'reg109'})},
{id:'tile-d-pv1A',label:'PV1 Current',icon:'bi-lightning',cat:'dc',def:false,update:(_,g)=>({value:(g.pv1Current??0)+' A',sub:'reg110'})},
{id:'tile-d-pv2V',label:'PV2 Voltage',icon:'bi-lightning',cat:'dc',def:false,update:(_,g)=>({value:(g.pv2Voltage??0)+' V',sub:'reg111'})},
{id:'tile-d-fault1',label:'Fault Code 1',icon:'bi-exclamation-triangle',cat:'dc',def:false,update:(_,g)=>({value:g.fault1??'--',sub:'reg103'})},
{id:'tile-d-fault2',label:'Fault Code 2',icon:'bi-exclamation-triangle',cat:'dc',def:false,update:(_,g)=>({value:g.fault2??'--',sub:'reg104'})},
{id:'tile-d-fault3',label:'Fault Code 3',icon:'bi-exclamation-triangle',cat:'dc',def:false,update:(_,g)=>({value:g.fault3??'--',sub:'reg105'})},
{id:'tile-d-fault4',label:'Fault Code 4',icon:'bi-exclamation-triangle',cat:'dc',def:false,update:(_,g)=>({value:g.fault4??'--',sub:'reg106'})},
// AC Block debug tiles
{id:'tile-a-invV',label:'Inverter Voltage',icon:'bi-plug',cat:'ac',def:false,update:(_,g)=>({value:(g.inverterVoltage??0)+' V',sub:'reg154'})},
{id:'tile-a-gridI1',label:'Grid Current 1',icon:'bi-graph-up',cat:'ac',def:false,update:(_,g)=>({value:g.gridCurrent1??'--',sub:'reg160'})},
{id:'tile-a-gridI2',label:'Grid Current 2',icon:'bi-graph-up',cat:'ac',def:false,update:(_,g)=>({value:g.gridCurrent2??'--',sub:'reg161'})},
{id:'tile-a-invI',label:'Inverter Current',icon:'bi-graph-up',cat:'ac',def:false,update:(_,g)=>({value:(g.inverterCurrent??0)+' A',sub:'reg164'})},
{id:'tile-a-auxPower',label:'Aux Power',icon:'bi-lightning',cat:'ac',def:false,update:(_,g)=>({value:(g.auxPower??0)+' W',sub:'reg166'})},
{id:'tile-a-gridL1',label:'Grid L1 Power',icon:'bi-plug',cat:'ac',def:false,update:(_,g)=>({value:(g.gridL1Power??0)+' W',sub:'reg167'})},
{id:'tile-a-gridCT',label:'Grid CT Power',icon:'bi-plug',cat:'ac',def:false,update:(_,g)=>({value:(g.gridCTPower??0)+' W',sub:'reg172'})},
{id:'tile-a-invPower',label:'Inverter Power',icon:'bi-lightning',cat:'ac',def:false,update:(_,g)=>({value:(g.inverterPower??0)+' W',sub:'reg175'})},
{id:'tile-a-offGrid',label:'Off-Grid Mode',icon:'bi-power',cat:'ac',def:false,update:(_,g)=>({value:g.offGridMode??'--',sub:'reg179'})},
{id:'tile-a-batV',label:'Battery Voltage',icon:'bi-battery-half',cat:'ac',def:false,update:(_,g)=>({value:(g.batteryVoltage??0)+' V',sub:'reg183'})},
{id:'tile-a-batI',label:'Battery Current',icon:'bi-battery-half',cat:'ac',def:false,update:(_,g)=>({value:(g.batteryCurrent??0)+' A',sub:'reg191'})},
{id:'tile-a-pv1Pwr',label:'PV1 Power',icon:'bi-sun',cat:'ac',def:false,update:(_,g)=>({value:(g.pv1Power??0)+' W',sub:'reg186'})},
{id:'tile-a-pv2Pwr',label:'PV2 Power',icon:'bi-sun',cat:'ac',def:false,update:(_,g)=>({value:(g.pv2Power??0)+' W',sub:'reg187'})},
{id:'tile-a-loadFreq',label:'Load Frequency',icon:'bi-activity',cat:'ac',def:false,update:(_,g)=>({value:(g.loadFreq??0)+' Hz',sub:'reg192'})},
{id:'tile-a-invFreq',label:'Inverter Frequency',icon:'bi-activity',cat:'ac',def:false,update:(_,g)=>({value:(g.inverterFreq??0)+' Hz',sub:'reg193'})},
{id:'tile-a-gridConn',label:'Grid Connected',icon:'bi-plug',cat:'ac',def:false,update:(_,g)=>({value:g.gridConnected??'--',sub:'reg194'})},
// Settings debug tiles
{id:'tile-s-ctrlMode',label:'Control Mode',icon:'bi-gear',cat:'settings',def:false,update:(_,g)=>({value:g.controlMode??'--',sub:'reg200'})},
{id:'tile-s-batEqV',label:'Bat EQ Voltage',icon:'bi-battery-half',cat:'settings',def:false,update:(_,g)=>({value:(g.batteryEqVoltage??0)+' V',sub:'reg201'})},
{id:'tile-s-batAbsV',label:'Bat Abs Voltage',icon:'bi-battery-half',cat:'settings',def:false,update:(_,g)=>({value:(g.batteryAbsVoltage??0)+' V',sub:'reg202'})},
{id:'tile-s-batFloatV',label:'Bat Float Voltage',icon:'bi-battery-half',cat:'settings',def:false,update:(_,g)=>({value:(g.batteryFloatVoltage??0)+' V',sub:'reg203'})},
{id:'tile-s-upsDelay',label:'UPS Delay',icon:'bi-clock',cat:'settings',def:false,update:(_,g)=>({value:g.upsDelayTime??'--',sub:'reg209'})},
{id:'tile-s-maxChgI',label:'Max Charge Current',icon:'bi-battery-charging',cat:'settings',def:false,update:(_,g)=>({value:g.batMaxChargeCurrent??'--',sub:'reg210'})},
{id:'tile-s-maxDisI',label:'Max Discharge Current',icon:'bi-battery',cat:'settings',def:false,update:(_,g)=>({value:g.batMaxDischargeCurrent??'--',sub:'reg211'})},
{id:'tile-s-shdSOC',label:'Shutdown SOC',icon:'bi-exclamation-triangle',cat:'settings',def:false,update:(_,g)=>({value:g.batShutdownSOC??'--',sub:'reg217'})},
{id:'tile-s-rstSOC',label:'Restart SOC',icon:'bi-arrow-clockwise',cat:'settings',def:false,update:(_,g)=>({value:g.batRestartSOC??'--',sub:'reg218'})},
{id:'tile-s-lowSOC',label:'Low SOC',icon:'bi-exclamation',cat:'settings',def:false,update:(_,g)=>({value:g.batLowSOC??'--',sub:'reg219'})},
{id:'tile-s-shdV',label:'Shutdown Voltage',icon:'bi-exclamation-triangle',cat:'settings',def:false,update:(_,g)=>({value:(g.batShutdownVoltage??0)+' V',sub:'reg220'})},
{id:'tile-s-rstV',label:'Restart Voltage',icon:'bi-arrow-clockwise',cat:'settings',def:false,update:(_,g)=>({value:(g.batRestartVoltage??0)+' V',sub:'reg221'})},
{id:'tile-s-lowV',label:'Low Voltage',icon:'bi-exclamation',cat:'settings',def:false,update:(_,g)=>({value:(g.batLowVoltage??0)+' V',sub:'reg222'})},
{id:'tile-s-remoteCfg',label:'Remote Config',icon:'bi-gear',cat:'settings',def:false,update:(_,g)=>({value:g.remoteConfig??'--',sub:'reg228'})},
{id:'tile-s-gridChg',label:'Grid Charge',icon:'bi-plug',cat:'settings',def:false,update:(_,g)=>({value:g.gridChargeEnabled??'--',sub:'reg230'})},
{id:'tile-s-priority',label:'Priority Load',icon:'bi-lightning',cat:'settings',def:false,update:(_,g)=>({value:g.priorityLoad??'--',sub:'reg243'})},
{id:'tile-s-loadLimit',label:'Load Limit',icon:'bi-speedometer',cat:'settings',def:false,update:(_,g)=>({value:g.loadLimit??'--',sub:'reg244'})},
{id:'tile-s-maxSell',label:'Max Sell Power',icon:'bi-cash',cat:'settings',def:false,update:(_,g)=>({value:g.maxSellPower??'--',sub:'reg245'})},
{id:'tile-s-solarExport',label:'Solar Export',icon:'bi-box-arrow-up',cat:'settings',def:false,update:(_,g)=>({value:g.solarExport??'--',sub:'reg247'})},
{id:'tile-s-useTimer',label:'Use Timer',icon:'bi-clock',cat:'settings',def:false,update:(_,g)=>({value:g.useTimer??'--',sub:'reg248'})}
];
const TILE_IDS=TILE_REGISTRY.map(t=>t.id);
const TILE_MAP={};TILE_REGISTRY.forEach(t=>{TILE_MAP[t.id]=t;});
const TILE_METRIC_MAP={'tile-battery':{key:'soc',label:'Battery SOC',unit:'%'},'tile-pv':{key:'pv',label:'Solar PV',unit:'W'},'tile-load':{key:'load',label:'Load',unit:'W'}};
const TILE_CATEGORIES=[{id:'main',label:'Main'},{id:'dc',label:'DC Block (48-111)'},{id:'ac',label:'AC Block (150-249)'},{id:'settings',label:'Settings (200-249)'}];
function buildTiles(){const c=document.getElementById('tilesContainer');c.innerHTML='';TILE_REGISTRY.forEach(t=>{const tile=document.createElement('div');tile.className='tile';tile.id=t.id;tile.innerHTML='<span class="icon"><i class="bi '+t.icon+'"></i></span><div class="label">'+t.label+'</div><div class="value">--</div><div class="sub"></div>';if(TILE_METRIC_MAP[t.id]){tile.style.cursor='pointer';tile.onclick=()=>openTileDetail(t.id);}c.appendChild(tile);});}
function updateTiles(d,g){const dg=g||{};TILE_REGISTRY.forEach(t=>{const el=document.getElementById(t.id);if(!el)return;try{const r=t.update(d,dg);if(!r)return;const v=el.querySelector('.value');const s=el.querySelector('.sub');if(v)v.textContent=r.value;if(s)s.textContent=r.sub;el.classList.remove('on','off');if(r.cls)el.classList.add(r.cls);}catch{}})}
function loadTilePrefs(){try{return JSON.parse(localStorage.getItem('tileVis')||'null')||{}}catch{return{}}}
function saveTilePrefs(p){localStorage.setItem('tileVis',JSON.stringify(p));}
function loadTileOrder(){try{const o=JSON.parse(localStorage.getItem('tileOrder')||'null');if(Array.isArray(o)){const ids=TILE_IDS.filter(id=>o.includes(id));TILE_IDS.forEach(id=>{if(!ids.includes(id))ids.push(id);});return ids;}}catch{}return[...TILE_IDS];}
function saveTileOrder(o){localStorage.setItem('tileOrder',JSON.stringify(o));}
function applyTileVisibility(){const p=loadTilePrefs();TILE_IDS.forEach(id=>{const el=document.getElementById(id);if(!el)return;const t=TILE_MAP[id];const vis=t?(p[id]!==undefined?p[id]:t.def):true;el.style.display=vis===false?'none':'';});}
function applyTileOrder(){const order=loadTileOrder();const c=document.getElementById('tilesContainer');order.forEach(id=>{const el=document.getElementById(id);if(el)c.appendChild(el);});}
function moveTile(id,dir){const order=loadTileOrder();const idx=order.indexOf(id);if(idx<0)return;const ni=idx+dir;if(ni<0||ni>=order.length)return;[order[idx],order[ni]]=[order[ni],order[idx]];saveTileOrder(order);applyTileOrder();}
function buildTileEditor(){const p=loadTilePrefs();const order=loadTileOrder();const g=document.getElementById('tileEditGrid');g.innerHTML='';TILE_CATEGORIES.forEach(cat=>{const catTiles=order.filter(id=>{const t=TILE_MAP[id];return t&&t.cat===cat.id;});if(!catTiles.length)return;const hdr=document.createElement('div');hdr.className='tile-edit-cat';hdr.textContent=cat.label;g.appendChild(hdr);catTiles.forEach(id=>{const t=TILE_MAP[id];const lbl=t?t.label:id;const vis=p[id]!==undefined?p[id]:t?t.def:true;const d=document.createElement('label');d.className='tile-edit-item'+(vis?'':' hidden-tile');d.dataset.tile=id;d.innerHTML='<input type="checkbox" '+(vis?'checked':'')+' data-tile="'+id+'">'+lbl+'<div class="tile-edit-arrows"><button type="button" title="Move up" class="tile-arrow-btn" data-dir="-1">\u25B2</button><button type="button" title="Move down" class="tile-arrow-btn" data-dir="1">\u25BC</button></div>';d.querySelector('input').addEventListener('change',function(){const pp=loadTilePrefs();pp[this.dataset.tile]=this.checked;saveTilePrefs(pp);d.classList.toggle('hidden-tile',!this.checked);applyTileVisibility();});d.querySelectorAll('.tile-arrow-btn').forEach(btn=>{btn.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();moveTile(id,parseInt(this.dataset.dir));buildTileEditor();});});g.appendChild(d);});});}
// Pull-to-refresh (improved with haptic)
let _pullStart=0,_pulling=false,_pullTriggered=false,_swipeStartX=0,_swipeStartY=0,_swiping=false;
const _pullEl=document.getElementById('pull-indicator');
const _pullIcon=_pullEl?_pullEl.querySelector('i'):null;
const mainEl=document.querySelector('.main');
if(mainEl){mainEl.addEventListener('touchstart',function(e){_pullStart=e.touches[0].clientY;_swipeStartX=e.touches[0].clientX;_swipeStartY=e.touches[0].clientY;_pulling=mainEl.scrollTop<=0;_pullTriggered=false;_swiping=false;},{passive:true});mainEl.addEventListener('touchmove',function(e){const dy=e.touches[0].clientY-_pullStart;const dx=e.touches[0].clientX-_swipeStartX;if(_pulling&&dy>0&&mainEl.scrollTop<=0){const pct=Math.min(dy/100,1);_pullEl.classList.add('show');_pullIcon.style.transform='rotate('+pct*180+'deg)';if(pct>=1){if(!_pullTriggered){_pullTriggered=true;haptic(15);}_pullEl.classList.add('pulling');}else{_pullEl.classList.remove('pulling');_pullTriggered=false;}}else if(Math.abs(dx)>30&&Math.abs(dy)<50){_swiping=true;}},{passive:true});mainEl.addEventListener('touchend',function(e){if(_pulling){_pulling=false;if(_pullEl.classList.contains('pulling')){haptic(10);_pullEl.classList.remove('pulling');_pullEl.classList.add('refreshing');_pullIcon.className='bi bi-arrow-clockwise';loadStatus();loadLogs();loadHistory();loadSocketHistory();loadOtherHistory();loadTuyaDevices();loadScenes();loadPluginConfig();loadAppVersion();setTimeout(function(){_pullEl.classList.remove('show','refreshing');_pullIcon.className='bi bi-arrow-down';},800);}else{_pullEl.classList.remove('show','pulling');}}if(_swiping){_swiping=false;var dx2=e.changedTouches[0].clientX-_swipeStartX;if(Math.abs(dx2)>=50){var tabs=['status','devices','automations','server','notifications','settings'];var curItem=document.querySelector('.menu-item.active');var idx=tabs.indexOf(curItem?curItem.dataset.tab:'status');if(idx>=0){var dir=dx2>0?-1:1;var ni=idx+dir;if(ni>=0&&ni<tabs.length){haptic(10);var target=document.querySelector('.menu-item[data-tab="'+tabs[ni]+'"]');if(target)target.click();}}}}},{passive:true});}

function renderEnergyFlow(d){
const svg=document.getElementById('energyFlow');if(!svg)return;
if(!svg._rdy){
var h='';
var p1='M94,49 C156,60 196,81 226,101',p2='M94,175 C156,164 196,129 226,120',p3='M276,110 C299,110 350,110 409,110',p1r='M226,101 C196,81 156,60 94,49',p2r='M226,120 C196,129 156,164 94,175',p3r='M409,110 C350,110 299,110 276,110';
h+='<path d="'+p1+'" stroke="#0ea5e9" stroke-width="5" fill="none" opacity="0.15" stroke-linecap="round"/>';
h+='<path d="'+p1+'" stroke="#0ea5e9" stroke-width="2" fill="none" opacity="0.75" stroke-linecap="round"/>';
h+='<circle r="3.5" fill="#0ea5e9" id="grdD"><animateMotion dur="3s" repeatCount="indefinite" path="'+p1+'"/></circle>';h+='<circle r="3.5" fill="#0ea5e9" id="grdE" style="display:none"><animateMotion dur="3s" repeatCount="indefinite" path="'+p1r+'"/></circle>';
h+='<path d="'+p2+'" stroke="#f59e0b" stroke-width="5" fill="none" opacity="0.15" stroke-linecap="round"/>';
h+='<path d="'+p2+'" stroke="#f59e0b" stroke-width="2" fill="none" opacity="0.75" stroke-linecap="round"/>';
h+='<circle r="3.5" fill="#f59e0b" id="batD"><animateMotion dur="3s" repeatCount="indefinite" path="'+p2+'"/></circle>';h+='<circle r="3.5" fill="#f59e0b" id="batC" style="display:none"><animateMotion dur="3s" repeatCount="indefinite" path="'+p2r+'"/></circle>';
h+='<path d="'+p3+'" stroke="#a855f7" stroke-width="5" fill="none" opacity="0.15" stroke-linecap="round"/>';
h+='<path d="'+p3+'" stroke="#a855f7" stroke-width="2" fill="none" opacity="0.75" stroke-linecap="round"/>';
h+='<circle r="3.5" fill="#a855f7" id="homD"><animateMotion dur="3s" repeatCount="indefinite" path="'+p3+'"/></circle>';h+='<circle r="3.5" fill="#a855f7" id="homE" style="display:none"><animateMotion dur="3s" repeatCount="indefinite" path="'+p3r+'"/></circle>';
function N(cx,cy,cl,ic,id1,id2,id3){
h+='<circle cx="'+cx+'" cy="'+cy+'" r="34" fill="'+cl+'" opacity="0.08"/>';
h+='<circle cx="'+cx+'" cy="'+cy+'" r="26" fill="none" stroke="'+cl+'" stroke-width="2.5" opacity="0.85"/>';
h+='<circle cx="'+cx+'" cy="'+cy+'" r="22" fill="none" stroke="var(--border)" stroke-width="0.5"/>';
h+='<text id="'+id1+'" x="'+cx+'" y="'+(cy+5)+'" text-anchor="middle" fill="'+cl+'" font-size="13" font-weight="800"></text>';
h+='<text id="'+id2+'" x="'+cx+'" y="'+(cy+17)+'" text-anchor="middle" fill="'+cl+'" font-size="8" font-weight="600"></text>';
if(id3){h+='<text id="'+id3+'" x="'+cx+'" y="'+(cy+27)+'" text-anchor="middle" fill="'+cl+'" font-size="7"></text>';}}
N(70,40,'#0ea5e9','\u26A1','egp1','egp2','egp3');
N(70,185,'#f59e0b','\uD83D\uDD0B','ebt1','ebt2',null);
N(435,110,'#a855f7','\uD83C\uDFE0','ehm1','ehm2',null);
var gc='#22c55e';
h+='<circle id="egr" cx="250" cy="110" r="34" fill="#22c55e" opacity="0.08"/>';
h+='<circle id="egs" cx="250" cy="110" r="26" fill="none" stroke="#22c55e" stroke-width="2.5" opacity="0.85"/>';
h+='<circle cx="250" cy="110" r="22" fill="none" stroke="var(--border)" stroke-width="0.5"/>';
h+='<text id="egr1" x="250" y="115" text-anchor="middle" fill="'+gc+'" font-size="15" font-weight="800"></text>';
svg.innerHTML=h;
svg._rdy=true;}
var gc=d.gridPower?'#22c55e':'#ef4444';
document.getElementById('egr').setAttribute('fill',gc);
document.getElementById('egr').setAttribute('fill-opacity','0.07');
document.getElementById('egs').setAttribute('stroke',gc);
document.getElementById('egr1').setAttribute('fill',gc);

var gp=(d.debug&&d.debug.gridPower)||0,sc=d.batterySOC||0,ld=d.loadPower||0,bp=d.batteryPower||0;
document.getElementById('egp1').textContent=gp+'W';
document.getElementById('egp2').textContent='Grid';
document.getElementById('egp3').textContent='';
document.getElementById('ebt1').textContent=sc+'%';
document.getElementById('ebt2').textContent=bp?bp+'W':'0W';
document.getElementById('ehm1').textContent=ld+'W';
document.getElementById('ehm2').textContent='Home';
document.getElementById('egr1').textContent=d.gridPower?'ON':'OFF';
var gd=document.getElementById('grdD'),ge=document.getElementById('grdE');if(gd&&ge){gd.style.display=gp>0?'':'none';ge.style.display=gp<0?'':'none';}var bd=document.getElementById('batD'),bc=document.getElementById('batC');if(bd&&bc){bd.style.display=bp>0?'':'none';bc.style.display=bp<0?'':'none';}var hd=document.getElementById('homD'),he=document.getElementById('homE');if(hd&&he){hd.style.display=ld>0?'':'none';he.style.display=ld<0?'':'none';}
const scEl=document.getElementById('flowMetrics');
if(scEl){
const tariff=d.tariff||{};
const costToday=d.costToday||{day:0,night:0};
function gCost(dk,nk){if(tariff.type==='flat')return(dk+nk)*(tariff.flatRate||0);return dk*(tariff.dayRate||0)+nk*(tariff.nightRate||0);}
const todayC=gCost(costToday.day,costToday.night);
const cur=tariff.currency||'';
const tgi=d.totalGridImport||0;
const tle=d.totalLoadEnergy||0;
const allTimeC=gCost(tgi,0);
const standbyLoss=Math.max(0,tgi-tle);
const standbyC=gCost(standbyLoss,0);
const efficiency=tgi>0?((tle/tgi)*100).toFixed(1):'—';
scEl.innerHTML='<div class="metric-card"><span class="metric-lbl">Cost Today</span><span class="metric-val">'+todayC.toFixed(2)+' '+cur+'</span><span class="metric-sub">'+costToday.day.toFixed(1)+' day + '+costToday.night.toFixed(1)+' night kWh</span></div>'
+'<div class="metric-card"><span class="metric-lbl">All-Time Cost</span><span class="metric-val">'+allTimeC.toFixed(2)+' '+cur+'</span><span class="metric-sub">'+tgi.toFixed(1)+' kWh total import</span></div>'
+'<div class="metric-card"><span class="metric-lbl">Standby Loss</span><span class="metric-val">'+standbyC.toFixed(2)+' '+cur+'</span><span class="metric-sub">'+standbyLoss.toFixed(1)+' kWh lost · efficiency '+efficiency+'%</span></div>';}
}

let _tileDetailChart=null;
async function openTileDetail(tileId){
const m=TILE_METRIC_MAP[tileId];
if(!m)return;
document.getElementById('tileDetailTitle').textContent=m.label+' \u2014 last 24h';
document.getElementById('tileDetailModal').classList.add('show');
document.getElementById('tileDetailStats').innerHTML='<span>Loading\u2026</span>';
try{
const d=await apiGet('/api/history?period=day');
const pts=(d.points||[]).filter(p=>p[m.key]!==undefined&&p[m.key]!==null);
if(!pts.length){document.getElementById('tileDetailStats').innerHTML='<span>No history yet</span>';return;}
const vals=pts.map(p=>p[m.key]);
const min=Math.min(...vals),max=Math.max(...vals);
const avg=vals.reduce((a,b)=>a+b,0)/vals.length;
document.getElementById('tileDetailStats').innerHTML=
'<span><b>Min</b> '+min.toFixed(1)+m.unit+'</span><span><b>Avg</b> '+avg.toFixed(1)+m.unit+'</span><span><b>Max</b> '+max.toFixed(1)+m.unit+'</span>';
const labels=pts.map(p=>{const dt=new Date(p.ts);return dt.getHours().toString().padStart(2,'0')+':'+dt.getMinutes().toString().padStart(2,'0');});
if(_tileDetailChart){_tileDetailChart.destroy();_tileDetailChart=null;}
const ctx=document.getElementById('tileDetailChart').getContext('2d');
_tileDetailChart=new Chart(ctx,{type:'line',data:{labels,datasets:[{data:vals,borderColor:'#0a84ff',backgroundColor:'rgba(10,132,255,.12)',fill:true,pointRadius:0,borderWidth:1.5,tension:.3}]},options:{responsive:true,maintainAspectRatio:false,animation:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,30,0.95)',titleColor:'#f5f5f7',bodyColor:'#f5f5f7',cornerRadius:8,padding:8,callbacks:{label:c=>c.raw+m.unit}}},scales:{x:{ticks:{color:'#98989f',font:{size:9},maxTicksLimit:6,maxRotation:0},grid:{display:false}},y:{ticks:{color:'#98989f',font:{size:9}},grid:{color:'rgba(255,255,255,0.04)'}}}}});
}catch(e){document.getElementById('tileDetailStats').innerHTML='<span>Failed to load: '+e.message+'</span>';}
}
function closeTileDetail(){
document.getElementById('tileDetailModal').classList.remove('show');
if(_tileDetailChart){_tileDetailChart.destroy();_tileDetailChart=null;}
}
async function loadAppVersion(){try{const r=await fetch('/api/app-version');const d=await r.json();if(d.success){const el=document.getElementById('update-info');if(el){el.innerHTML=d.isGit?'Version <strong>'+d.version+'</strong> ('+d.gitHash+') · Branch: '+d.gitBranch:'Version <strong>'+d.version+'</strong> (not a git repo)';if(!d.isGit)document.getElementById('btn-check-update').style.display='none';}const sv=document.getElementById('sidebar-version');if(sv)sv.textContent='v'+d.version;}}catch(e){}}
async function createBackup(){const st=document.getElementById('backup-status');st.style.display='block';st.innerHTML='<i class="bi bi-hourglass-split"></i> Creating backup...';try{const r=await apiPost('/api/backup',{scope:['config','scenes','auth','history']});if(!r.success||!r.backup)throw new Error(r.message||'Backup failed');const bk=r.backup;bk.data.tilePrefs=loadTilePrefs();bk.data.tileOrder=loadTileOrder();const blob=new Blob([JSON.stringify(bk,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='energy-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();URL.revokeObjectURL(a.href);st.innerHTML='<i class="bi bi-check-circle" style="color:#22c55e"></i> Backup downloaded.';setTimeout(()=>st.style.display='none',4000);}catch(e){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+e.message;}}
async function loadServerInfo(){const el=document.getElementById('server-info-body');el.innerHTML='<div style="text-align:center;padding:1rem"><i class="bi bi-hourglass-split"></i> Loading...</div>';try{const d=await apiGet('/api/system-info');let html='<table style="width:100%;font-size:.85rem;border-collapse:collapse">';const fmt=function(b){if(b>=1073741824)return (b/1073741824).toFixed(2)+' GB';if(b>=1048576)return (b/1048576).toFixed(1)+' MB';if(b>=1024)return (b/1024).toFixed(0)+' KB';return b+' B';};const dur=function(s){const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);const m=Math.floor((s%3600)/60);return d+'d '+h+'h '+m+'m';};const row=function(l,v){return '<tr><td style="padding:.5rem .3rem;color:var(--text-secondary)">'+l+'</td><td style="padding:.5rem .3rem;text-align:right">'+v+'</td></tr>';};html+=row('Hostname',d.hostname);html+=row('Platform',d.platform);html+=row('Node.js',d.nodeVersion);html+=row('Uptime',dur(d.uptime));html+=row('CPU',d.cpuModel+' ('+d.cpuCores+' cores)');const bar=function(pct){const col=pct>0.7?'#ef4444':pct>0.4?'#eab308':'#22c55e';return '<div style="display:flex;align-items:center;gap:.5rem"><span style="width:3rem;text-align:right">'+pct.toFixed(2)+'</span><div style="flex:1;height:6px;background:var(--border);border-radius:4px;overflow:hidden"><div style="width:'+(pct*100)+'%;height:100%;background:'+col+';border-radius:4px;transition:width .5s"></div></div></div>';};html+=row('CPU Load (1m)',bar(d.cpuLoad[0]));html+=row('CPU Load (5m)',bar(d.cpuLoad[1]));html+=row('CPU Load (15m)',bar(d.cpuLoad[2]));if(d.cpuTemp)html+=row('CPU Temp','<span style="color:'+(parseFloat(d.cpuTemp)>70?'#ef4444':'#22c55e')+'">'+d.cpuTemp+'\u00b0C</span>');if(d.cpuFreq)html+=row('CPU Freq',d.cpuFreq+' MHz');const memPct=(d.usedMem/d.totalMem*100).toFixed(1);html+=row('Memory','<div style="display:flex;justify-content:space-between;gap:.5rem;margin-bottom:4px"><span>Used: '+fmt(d.usedMem)+' / '+fmt(d.totalMem)+'</span><span style="color:'+(parseFloat(memPct)>80?'#ef4444':'')+'">'+memPct+'%</span></div><div style="height:4px;background:var(--border);border-radius:4px;overflow:hidden"><div style="width:'+memPct+'%;height:100%;background:'+(parseFloat(memPct)>80?'#ef4444':'var(--primary)')+';border-radius:4px;transition:width .5s"></div></div>');if(d.diskInfo&&d.diskInfo.total){const diskPct=(d.diskInfo.used/d.diskInfo.total*100).toFixed(1);html+=row('Disk','<div style="display:flex;justify-content:space-between;gap:.5rem;margin-bottom:4px"><span>Used: '+fmt(d.diskInfo.used)+' / '+fmt(d.diskInfo.total)+'</span><span style="color:'+(parseFloat(diskPct)>80?'#ef4444':'')+'">'+diskPct+'%</span></div><div style="height:4px;background:var(--border);border-radius:4px;overflow:hidden"><div style="width:'+diskPct+'%;height:100%;background:'+(parseFloat(diskPct)>80?'#ef4444':'var(--primary)')+';border-radius:4px;transition:width .5s"></div></div>');}html+='</table>';el.innerHTML=html;}catch(e){el.innerHTML='<div style="color:#ef4444;padding:1rem;text-align:center"><i class="bi bi-exclamation-circle"></i> '+e.message+'</div>';}}
async function restoreBackup(file){const st=document.getElementById('backup-status');st.style.display='block';st.innerHTML='<i class="bi bi-hourglass-split"></i> Restoring...';try{const text=await file.text();const bk=JSON.parse(text);if(!bk.data)throw new Error('Invalid backup file');const overwrite=[];if(bk.data.config)overwrite.push('config');if(bk.data.scenes)overwrite.push('scenes');if(bk.data.auth)overwrite.push('auth');if(bk.data.history)overwrite.push('history');
let confirmPassword=null;
if(overwrite.includes('auth')){
  confirmPassword=prompt('This backup contains authentication settings. Enter your current password to confirm:');
  if(!confirmPassword){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> Restore cancelled: password required';return;}
}
const r=await apiPost('/api/backup/restore',{data:bk.data,overwrite,confirmPassword});
if(!r.success)throw new Error(r.message||'Restore failed');
if(bk.data.tilePrefs)saveTilePrefs(bk.data.tilePrefs);
if(bk.data.tileOrder)saveTileOrder(bk.data.tileOrder);
st.innerHTML='<i class="bi bi-check-circle" style="color:#22c55e"></i> '+r.message;
loadScenes();loadTuyaDevices();loadStatus();buildTiles();applyTileOrder();applyTileVisibility();buildTileEditor();
document.getElementById('restoreInput').value='';}catch(e){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+e.message;}}
let _updateTarget=null;
async function checkForUpdates(){const btn=document.getElementById('btn-check-update');const st=document.getElementById('update-status');const tagsEl=document.getElementById('update-tags');const branchesEl=document.getElementById('update-branches');st.style.display='none';tagsEl.style.display='none';branchesEl.style.display='none';btn.disabled=true;btn.innerHTML='<i class="bi bi-hourglass-split"></i>';_updateTarget=null;document.getElementById('btn-apply-update').style.display='none';try{const d=await apiPost('/api/update-check',{});if(!d.isGit){st.style.display='block';st.style.color='var(--text-secondary)';st.textContent='Not a git repository. Install via git clone to enable updates.';btn.disabled=false;btn.innerHTML='<i class="bi bi-arrow-clockwise"></i>';return;}if(d.branches&&d.branches.length){branchesEl.style.display='block';let html='<label style="font-size:.78rem;color:var(--muted);display:block;margin-bottom:.5rem">Branches:</label>';d.branches.forEach(b=>{const active=d.currentBranch===b.name;b.name=b.name.replace('origin/','');const style=active?'background:var(--primary);color:#fff;border-color:var(--primary)':'';html+='<div class="update-tag'+(active?' active':'')+'" data-type="branch" data-branch="'+b.name+'" onclick="selectUpdateTarget(this)" style="cursor:pointer;padding:.5rem .75rem;border:1px solid var(--border);border-radius:6px;margin-bottom:.35rem;font-size:.82rem;display:flex;justify-content:space-between;align-items:center;'+style+'"><span><strong>'+b.name+'</strong>'+(active?' <span style="font-size:.7rem;opacity:.7">(current)</span>':'')+'</span><span style="font-size:.7rem;color:var(--muted)">'+b.commit+' &middot; '+b.date.split('T')[0]+'</span></div>';});branchesEl.innerHTML=html;}if(d.tags&&d.tags.length){tagsEl.style.display='block';let html='<label style="font-size:.78rem;color:var(--muted);display:block;margin-bottom:.5rem">Tags (stable releases):</label>';d.tags.forEach(t=>{const active=d.currentTag===t;const style=active?'background:var(--primary);color:#fff;border-color:var(--primary)':'';html+='<div class="update-tag'+(active?' active':'')+'" data-type="tag" data-tag="'+t+'" onclick="selectUpdateTarget(this)" style="cursor:pointer;padding:.5rem .75rem;border:1px solid var(--border);border-radius:6px;margin-bottom:.35rem;font-size:.82rem;'+style+'"><span>'+t+'</span>'+(active?' <span style="font-size:.7rem;opacity:.7">(current)</span>':'')+'</div>';});tagsEl.innerHTML=html;}if((d.branches&&d.branches.length)||(d.tags&&d.tags.length)){document.getElementById('btn-apply-update').style.display='';}else{st.style.display='block';st.style.color='var(--text-secondary)';st.textContent='No branches or tags found.';}}catch(e){st.style.display='block';st.style.color='#ef4444';st.textContent='Error: '+e.message;}btn.disabled=false;btn.innerHTML='<i class="bi bi-arrow-clockwise"></i>';}
function selectUpdateTarget(el){document.querySelectorAll('.update-tag').forEach(t=>{t.classList.remove('active');t.style.background='';t.style.color='';t.style.borderColor='';});el.classList.add('active');el.style.background='var(--primary)';el.style.color='#fff';el.style.borderColor='var(--primary)';const type=el.dataset.type;_updateTarget=type==='branch'?{branch:el.dataset.branch}:{tag:el.dataset.tag};document.getElementById('btn-apply-update').disabled=false;}
async function applyUpdate(){const btn=document.getElementById('btn-apply-update');const st=document.getElementById('update-status');if(!_updateTarget){st.style.display='block';st.style.color='#f59e0b';st.textContent='Select a branch or tag first.';return;}const label=_updateTarget.branch||_updateTarget.tag;if(!confirm('Update to '+label+' and restart?'))return;btn.disabled=true;btn.innerHTML='<i class="bi bi-hourglass-split"></i> Updating...';st.style.display='block';st.style.color='#3b82f6';st.textContent='Checking out '+label+'...';try{await apiPost('/api/update-apply',_updateTarget);st.textContent='Updated! Reconnecting...';setTimeout(()=>{let tries=0;const iv=setInterval(async()=>{tries++;try{const r=await fetch('/');if(r.ok){clearInterval(iv);location.reload();}}catch{}if(tries>30){clearInterval(iv);st.textContent='Restart timed out. Refresh the page manually.';}},1500);},3000);}catch(e){st.style.color='#ef4444';st.textContent='Update failed: '+e.message;btn.disabled=false;btn.innerHTML='<i class="bi bi-download"></i> Update & Restart';}}
loadAppVersion();

loadStatus();loadTuyaDevices();loadScenes();loadLogs();loadHistory('day');loadSocketHistory('day');loadOtherHistory('day');loadNotifications();setInterval(loadNotifications,15000);
buildTiles();applyTileOrder();applyTileVisibility();buildTileEditor();
(function(){const s=document.querySelector('.sidebar');if(!s||window.innerWidth<=768)return;const ls=localStorage.getItem('sidebarOpen');const isOpen=ls!==null?ls==='1':true;s.classList.toggle('open',isOpen);const btn=document.querySelector('.sidebar-toggle i');if(btn)btn.className=isOpen?'bi bi-chevron-left':'bi bi-chevron-right';})();
setInterval(loadStatus,10000);
setInterval(loadLogs,30000);
setInterval(()=>loadHistory(),60000);
setInterval(()=>loadSocketHistory(),60000);
setInterval(()=>loadOtherHistory(),60000);
setInterval(loadTuyaDevices,30000);
if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js?v=6').catch(()=>{});}
