'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const fmt=(n,d=0)=>Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const vib=p=>{try{navigator.vibrate&&navigator.vibrate(p)}catch(e){}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const timeStr=d=>(d||new Date()).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});

window._csrf='';
const CAP_WH=5120,EFF=0.92;
const S={grid:true,gridV:0,gridHz:50,soc:0,storedWh:0,batW:0,load:0,
  pvPower:0,invTemp:0,batTemp:0,importToday:0,costToday:0,
  tariff:{day:4.32,night:2.16},devices:[],scenes:[],events:[],config:null};

const PRI={critical:{label:'Critical',color:'#FF453A',icon:'ph-shield-check'},
  essential:{label:'Essential',color:'#FFD60A',icon:'ph-star'},
  optional:{label:'Optional',color:'#8E8E93',icon:'ph-dots-three'}};

function getPriorities(){try{return JSON.parse(localStorage.getItem('strum_priorities')||'{}');}catch{return {};}}
function setPriority(id,p){const all=getPriorities();all[id]=p;localStorage.setItem('strum_priorities',JSON.stringify(all));}
function getDevicePriority(d){
  const stored=getPriorities();if(stored[d.id])return stored[d.id];
  const n=(d.name||'').toLowerCase();
  if(/fridge|freezer|boiler|router|pump|nas/i.test(n))return'critical';
  if(/light|lamp|laptop|charger/i.test(n))return'essential';
  return'optional';
}

const BANNER={info:['ph-info','#0A84FF'],success:['ph-check-circle','#30D158'],error:['ph-warning-circle','#FF453A'],warn:['ph-warning','#FF9F0A']};
function banner(title,msg,type='info',action){
  const[ic,c]=BANNER[type]||BANNER.info;
  const el=document.createElement('div');el.className='banner';
  el.innerHTML=`<span class="bn-ic" style="--c:${c}"><i class="ph-fill ${ic}"></i></span>
    <div class="bn-tx"><b>${title}</b><span>${msg}</span></div>
    ${action?`<button class="bn-act">${action.label}</button>`:''}<button class="bn-x"><i class="ph-bold ph-x"></i></button>`;
  $('#banners').appendChild(el);
  while($('#banners').children.length>2)$('#banners').firstChild.remove();
  let done=false;
  const kill=()=>{if(done)return;done=true;el.classList.add('out');setTimeout(()=>el.remove(),350);};
  el.querySelector('.bn-x').onclick=e=>{e.stopPropagation();kill();};
  if(action)el.querySelector('.bn-act').onclick=e=>{e.stopPropagation();action.fn();kill();};
  el.onclick=kill;
  setTimeout(kill,action?8000:4600);
  vib(type==='error'?[30,40,30]:10);
}

function openSheet(html){$('#sheetBody').innerHTML=html;$('#sheet').classList.add('open');$('#sheetBk').classList.add('open');}
function closeSheet(){$('#sheet').classList.remove('open');$('#sheetBk').classList.remove('open');}
$('#sheetBk').addEventListener('click',closeSheet);

async function api(path,opts={}){
  const headers={'Content-Type':'application/json'};
  if(window._csrf)headers['X-CSRF-Token']=window._csrf;
  try{
    const r=await fetch(path,{credentials:'same-origin',...opts,headers:{...headers,...opts.headers}});
    if(r.status===401||r.status===302){window.location.href='/login';return null;}
    return r.json();
  }catch(e){banner('Error',e.message,'error');return null;}
}

function addEvent(icon,color,text){S.events.unshift({t:timeStr(),icon,color,text});S.events=S.events.slice(0,8);renderEvents();}
function renderEvents(){
  const el=$('#eventsList');if(!el)return;
  el.innerHTML=S.events.map(e=>`<div class="ev-row"><span class="ev-ic" style="--c:${e.color}"><i class="ph-fill ${e.icon}"></i></span><span class="ev-tx">${e.text}</span><span class="ev-t">${e.t}</span></div>`).join('');
  const b=$('#evBadge');if(b)b.textContent=S.events.length;
}

// ─── Flow ──────────────────────────────────────────────────
function updateFlow(){
  const g=S.gridV>100,chg=S.batW<-5,dis=S.batW>5;
  $('#flGrid').classList.toggle('act',g);
  $('#flBat').classList.toggle('act',chg||dis);
  $('#pGrid').style.display=g?'':'none';
  $('#pBatC').style.display=chg?'':'none';
  $('#pBatD').style.display=dis?'':'none';
  $('#fnGridIc').classList.toggle('off',!g);
  const fg=$('#fnGrid');fg.textContent=g?fmt(S.gridV,1)+' V':'—';fg.classList.toggle('bad',!g);
  $('#fnGridIc').classList.toggle('has-val',g);
  $('#fnInv').textContent=fmt(S.load)+' W';
  $('#fnInv').closest('.fn-ic').classList.add('has-val');
  $('#fnHome').textContent=fmt(S.load)+' W';
  $('#fnHome').closest('.fn-ic').classList.add('has-val');
  $('#fnBat').textContent=fmt(S.soc)+'%';
  $('#fnBat').closest('.fn-ic').classList.add('has-val');
  $('#fImport').textContent=g?fmt(S.load+(chg?Math.abs(S.batW):0))+' W':'0 W';
  $('#fBat').textContent=(S.batW>0?'+':S.batW<0?'−':'')+(Math.abs(S.batW)/1000).toFixed(2)+' kWh';
  $('#fFreq').textContent=g?S.gridHz.toFixed(1)+' Hz':'—';
}

// ─── Battery ───────────────────────────────────────────────
function socColor(){return S.soc>50?'#30D158':S.soc>20?'#FFD60A':'#FF453A';}
function updateBattery(){
  const C=326.7;
  $('#ringFg').style.strokeDashoffset=C*(1-S.soc/100);
  const c=socColor();
  $('#gb1').setAttribute('stop-color',c);
  $('#gb2').setAttribute('stop-color',S.soc>50?'#64D2FF':S.soc>20?'#FF9F0A':'#FF6961');
  $('#socVal').textContent=fmt(S.soc);
  $('#batPower').textContent=(S.batW>0?'+':S.batW<0?'−':'0')+(Math.abs(S.batW)/1000).toFixed(2)+' kWh';
  $('#batWh').textContent=(S.storedWh/1000).toFixed(1)+' kWh';
  $('#batTemp').textContent=fmt(S.batTemp,1)+'°';
  const st=$('#batState');
  if(S.batW<-5){st.textContent='Charging';st.className='mini-badge g';}
  else if(S.batW>5){st.textContent='Discharging';st.className='mini-badge';st.style.cssText='background:rgba(255,159,10,.15);color:var(--orange)';}
  else{st.textContent='Idle';st.className='mini-badge';st.style.cssText='';}
  $('#batteryCard').classList.toggle('low',S.soc<20);
}

// ─── Survival ──────────────────────────────────────────────
function updateSurvival(){
  if(S.load<10){$('#survTime').textContent='∞';$('#survBar').style.width='100%';$('#survHint').textContent='Load is minimal';return;}
  const hrs=S.storedWh*EFF/Math.max(30,S.load);
  const el=$('#survTime');
  if(hrs>=48)el.textContent='over 2 days';
  else el.textContent=fmt(Math.floor(hrs))+':'+String(Math.round((hrs%1)*60)).padStart(2,'0')+' hrs';
  $('#survLoad').textContent='at '+fmt(S.load)+' W now';
  $('#survBar').style.width=clamp(hrs/24*100,4,100)+'%';
  const until=new Date(Date.now()+hrs*36e5);
  $('#survHint').textContent=S.grid?'Enough until ~'+timeStr(until)+' · '+fmt(S.soc)+'% SOC':'Grid is down! Save energy.';
  $('#survCard').classList.toggle('alert',!S.grid);
}

// ─── Island ────────────────────────────────────────────────
function updateIsland(){
  const dot=$('#islDot');
  dot.className='isl-dot '+(S.grid?(S.batW<-5?'chg':S.batW>5?'idle':'idle'):'bad');
  $('#islW').textContent=fmt(S.load)+' W';
  $('#islSoc').textContent=fmt(S.soc)+'%';
  $('#iv1').textContent=S.grid?fmt(S.gridV,1)+' V':'OFF';
  $('#iv2').textContent=fmt(S.soc)+'%';
  $('#iv3').textContent=fmt(S.load)+' W';
  $('#sbBatt').textContent=fmt(S.soc)+'%';
}

// ─── Tiles ─────────────────────────────────────────────────
function updateTiles(){
  $('#mLoad').textContent=fmt(S.load)+' W';
  $('#mImport').textContent=S.importToday.toFixed(1)+' kWh';
  $('#mCost').textContent='$ '+S.costToday.toFixed(1);
  $('#mTemp').textContent=fmt(S.invTemp)+'°';
  const t=$('#tToday');if(t)t.textContent='$ '+S.costToday.toFixed(1);
}

// ─── Grid Chip ─────────────────────────────────────────────
function updateChip(){
  const c=$('#gridChip');
  if(S.grid){c.className='nv-chip';c.innerHTML=`<i class="ph-fill ph-plug-charging"></i> Grid · ${fmt(S.gridV,1)} V`;}
  else{c.className='nv-chip bad';c.innerHTML='<i class="ph-fill ph-lightning-slash"></i> No Grid';}
  const inv=$('#invStatus');
  if(inv){inv.textContent=S.grid?'Online':'On Battery';inv.className=S.grid?'badge-ok':'badge-ok';inv.style.cssText=S.grid?'':'background:rgba(255,159,10,.15);color:var(--orange)';}
}

function updateAll(){updateFlow();updateBattery();updateSurvival();updateIsland();updateTiles();updateChip();}

// ─── Clock ─────────────────────────────────────────────────
function updateClock(){$('#sbTime').textContent=new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}).replace(/^0/,'');}

// ─── Devices ───────────────────────────────────────────────
let devFilter='all',devQuery='';
function livePower(d){if(!d.switch||!d.online)return 0;return d.power||0;}
function dcardHTML(d){
  const p=getDevicePriority(d);
  return`<div class="dcard ${d.switch?'on':''}" data-dev="${d.id}">
    <div class="dic" style="--c:${PRI[p].color}"><i class="ph-fill ph-plugs"></i></div>
    <div class="dinfo">
      <div class="dname">${d.name||d.id}<span class="dbadge ${d.online?'loc':'cld'}"><i class="ph-bold ph-${d.online?'wifi-high':'cloud'}"></i>${d.online?'Online':'Offline'}</span></div>
      <div class="dsub">${fmt(livePower(d))} W · ${d.voltage?fmt(d.voltage,1)+' V':'—'} · ${d.current?fmt(d.current,2)+' A':'—'}</div>
    </div>
    <label class="sw"><input type="checkbox" data-sw="${d.id}" ${d.switch?'checked':''}><span class="knob"></span></label>
  </div>`;
}
function renderDevices(){
  const wrap=$('#devGroups');if(!wrap)return;
  let html='';
  for(const p of['critical','essential','optional']){
    if(devFilter!=='all'&&devFilter!==p)continue;
    const ds=S.devices.filter(d=>getDevicePriority(d)===p&&(d.name||'').toLowerCase().includes(devQuery));
    if(!ds.length)continue;
    const tot=ds.reduce((a,d)=>a+livePower(d),0);
    html+=`<div class="dgroup"><div class="dgroup-h"><span class="dg-ic" style="--c:${PRI[p].color}"><i class="ph-fill ${PRI[p].icon}"></i></span><b>${PRI[p].label}</b><span class="dg-meta">${ds.length} · ${fmt(tot)} W</span></div>
      <div class="dlist">${ds.map(dcardHTML).join('')}</div></div>`;
  }
  wrap.innerHTML=html||`<div class="empty">No devices found</div>`;
  updateDevSummary();
}
function updateDevSummary(){
  const on=S.devices.filter(d=>d.switch);
  const tot=on.reduce((a,d)=>a+livePower(d),0);
  const top=[...on].sort((a,b)=>livePower(b)-livePower(a))[0];
  const sw=$('#sumW');if(sw)sw.textContent=fmt(tot)+' W';
  const st=$('#sumTop');if(st)st.textContent=top?`${top.name} · ${fmt(livePower(top))} W`:'—';
  const dc=$('#devCountChip');if(dc)dc.textContent=S.devices.length+' devices';
  const sdc=$('#settingsDeviceCount');if(sdc)sdc.textContent=S.devices.length;
}
function renderQuick(){
  const el=$('#quickRow');if(!el)return;
  el.innerHTML=S.devices.slice(0,7).map(d=>{
    const p=livePower(d);
    return`<button class="qchip ${d.switch?'on':''}" data-q="${d.id}">
      <i class="ph-fill ph-plugs" style="color:${PRI[getDevicePriority(d)].color}"></i>
      <span class="qn">${(d.name||'?').split(' ')[0]}</span>
      <b class="qw">${d.switch?fmt(p)+' W':'off'}</b></button>`;
  }).join('');
}

async function setDevice(id,on){
  vib(12);
  const r=await api('/api/tuya-control',{method:'POST',body:JSON.stringify({deviceId:id,value:on})});
  if(r&&r.success!==false){
    const d=S.devices.find(x=>x.id===id);if(d)d.switch=on;
    $$(`input[data-sw="${id}"]`).forEach(i=>i.checked=on);
    const card=$(`[data-dev="${id}"]`);if(card)card.classList.toggle('on',on);
    renderQuick();updateDevSummary();
    addEvent('ph-plugs',on?'#30D158':'#FF453A',`${d?d.name:id} ${on?'turned on':'turned off'}`);
  }
}

function unloadOptional(){
  const prev=S.devices.filter(d=>getDevicePriority(d)==='optional'&&d.switch);
  if(!prev.length){banner('All Off','Optional devices are not drawing power','info');return;}
  prev.forEach(d=>setDevice(d.id,false));
  renderDevices();renderQuick();
  banner(`Turned off ${prev.length} device(s)`,'Battery autonomy increased','success');
}

function openDevice(id){
  vib(8);
  const d=S.devices.find(x=>x.id===id);if(!d)return;
  const p=livePower(d),pri=getDevicePriority(d);
  openSheet(`<div class="grab"></div>
    <div class="sh-head"><div class="dic big" style="--c:${PRI[pri].color}"><i class="ph-fill ph-plugs"></i></div>
      <div><b class="sh-title">${d.name||d.id}</b><span class="sh-sub">${d.switch?'on':'off'} · ${d.online?'online':'offline'}</span></div>
      <label class="sw"><input type="checkbox" data-sw="${d.id}" ${d.switch?'checked':''}><span class="knob"></span></label></div>
    <div class="sh-stats">
      <div><span>Now</span><b>${fmt(p)} W</b></div>
      <div><span>Voltage</span><b>${d.voltage?fmt(d.voltage,1)+' V':'—'}</b></div>
      <div><span>Current</span><b>${d.current?fmt(d.current,2)+' A':'—'}</b></div>
    </div>
    <div class="sh-row"><span>Protocol</span><b class="prot ${d.online?'loc':'cld'}"><i class="ph-bold ph-${d.online?'wifi-high':'cloud'}"></i> ${d.online?'Tuya Local':'Tuya Cloud'}</b></div>
    <div class="sh-lbl">Survival Priority</div>
    <div class="seg" id="priSeg">${['critical','essential','optional'].map(k=>`<button data-pri="${k}" class="${pri===k?'on':''}">${PRI[k].label}</button>`).join('')}</div>
    <button class="btn wide" id="shClose" style="margin-top:18px">Done</button>`);
  $('#shClose').onclick=closeSheet;
  $('#priSeg').onclick=e=>{
    const b=e.target.closest('button');if(!b)return;vib(8);
    setPriority(d.id,b.dataset.pri);
    $$('#priSeg button').forEach(x=>x.classList.toggle('on',x===b));
    renderDevices();renderQuick();
    banner('Priority Updated',`${d.name} → ${PRI[b.dataset.pri].label}`,'success');
  };
}

// ─── Rules ─────────────────────────────────────────────────
function renderRules(){
  const el=$('#rulesList');if(!el)return;
  el.innerHTML=S.scenes.map(r=>{
    const en=r.enabled!==false;
    const cond=r.if&&r.if.conditions?r.if.conditions.map(c=>{
      if(c.type==='grid')return'Grid is down';
      if(c.type==='battery')return'SOC '+c.operator+' '+c.value+'%';
      if(c.type==='time')return c.after+'–'+c.before;
      if(c.type==='weekday')return'Weekdays';
      return c.type;
    }).join(', '):'—';
    const act=r.then&&r.then.actions?r.then.actions.map(a=>{
      if(a.type==='tuya')return'Device';
      if(a.type==='notify')return'Notification';
      return a.type;
    }).join(', '):'—';
    return`<div class="rcard ${en?'':'dis'} rv in">
      <div class="ric" style="--c:${en?'#0A84FF':'#8E8E93'}"><i class="ph-fill ph-flow-arrow"></i></div>
      <div class="rinfo"><div class="rname">${r.name}</div><div class="rsub">If <b>${cond}</b> → ${act}</div>
      <div class="rmeta">${en?'Active':'Disabled'}</div></div>
      <label class="sw"><input type="checkbox" data-rule="${r.name}" ${en?'checked':''}><span class="knob"></span></label></div>`;
  }).join('');
  const n=S.scenes.filter(r=>r.enabled!==false).length;
  const chip=$('#rulesChip');if(chip)chip.textContent=n+' active';
}

async function toggleScene(name,en){
  vib(10);
  await api('/api/scenes/'+encodeURIComponent(name),{method:'PATCH',body:JSON.stringify({enabled:en})});
}
async function runScene(name){
  vib(15);
  const r=await api('/api/scenes/'+encodeURIComponent(name)+'/run',{method:'POST'});
  if(r&&r.success)banner('Executed',`Rule "${name}" executed`,'success');
  else banner('Error',r?.message||'Failed to execute','error');
}
async function deleteScene(name){
  if(!confirm(`Delete "${name}"?`))return;
  await api('/api/scenes/'+encodeURIComponent(name),{method:'DELETE'});
  S.scenes=S.scenes.filter(r=>r.name!==name);renderRules();
  banner('Deleted',`Rule "${name}" deleted`,'success');
}

function openAddRule(){
  openSheet(`<div class="grab"></div><b class="sh-title" style="display:block;text-align:center;margin:4px 0 14px">New Rule</b>
    <div class="sh-lbl" style="margin-top:0">Name</div><input class="sinput2" id="nrName" placeholder="e.g. Evening Savings" maxlength="40">
    <div class="sh-lbl">Condition · IF</div><select class="ssel" id="nrWhen">
      <option value="grid">Grid goes down</option>
      <option value="soc_low">Battery SOC below 20%</option>
      <option value="soc_high">Battery SOC above 80%</option>
    </select>
    <div class="sh-lbl">Action · THEN</div><select class="ssel" id="nrThen">
      <option value="notify">Send notification</option>
      <option value="off_optional">Turn off optional devices</option>
    </select>
    <button class="btn wide" id="nrSave" style="margin-top:18px"><i class="ph-bold ph-check"></i> Create</button>`);
  $('#nrSave').onclick=async()=>{
    const name=$('#nrName').value.trim()||'My Rule';
    const whenVal=$('#nrWhen').value;
    const thenVal=$('#nrThen').value;
    const conditions=[];
    if(whenVal==='grid')conditions.push({type:'grid',value:false});
    else if(whenVal==='soc_low')conditions.push({type:'battery',operator:'<',value:20});
    else if(whenVal==='soc_high')conditions.push({type:'battery',operator:'>',value:80});
    const actions=[];
    if(thenVal==='notify')actions.push({type:'notify',title:name,message:'Rule triggered'});
    else if(thenVal==='off_optional')actions.push({type:'tuya',device:'*',value:false});
    const r=await api('/api/scenes',{method:'POST',body:JSON.stringify({name,if:{logic:'AND',conditions},then:{actions}})});
    if(r&&r.success!==false){
      S.scenes.push({name,enabled:true,if:{logic:'AND',conditions},then:{actions}});
      renderRules();closeSheet();vib(15);
      banner('Rule Created',`"${name}" activated`,'success');
      addEvent('ph-flow-arrow','#BF5AF2',`Rule "${name}" created`);
    }
  };
}

// ─── Charts ────────────────────────────────────────────────
let mainChart=null,costChart=null,anaInit=false;
async function initAnalytics(){
  if(anaInit){mainChart&&mainChart.resize();costChart&&costChart.resize();return;}
  anaInit=true;
  Chart.defaults.font.family="'Figtree Variable',sans-serif";
  Chart.defaults.color='rgba(235,235,245,.5)';
  const mainCtx=$('#mainChart');if(!mainCtx)return;
  mainChart=new Chart(mainCtx.getContext('2d'),{type:'line',data:{labels:[],datasets:[
    {label:'Load, W',data:[],borderColor:'#0A84FF',borderWidth:2,tension:.35,pointRadius:0,fill:true,yAxisID:'y',
      backgroundColor:c=>{const{ctx:cc,chartArea}=c.chart;if(!chartArea)return'rgba(10,132,255,.1)';
        const g=cc.createLinearGradient(0,chartArea.top,0,chartArea.bottom);g.addColorStop(0,'rgba(10,132,255,.32)');g.addColorStop(1,'rgba(10,132,255,0)');return g;}},
    {label:'Battery, %',data:[],borderColor:'#30D158',borderWidth:1.6,tension:.35,pointRadius:0,fill:false,yAxisID:'y1'}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:450},interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:true,position:'top',align:'end',labels:{boxWidth:7,boxHeight:7,usePointStyle:true,pointStyle:'circle',color:'rgba(235,235,245,.6)',font:{size:10,weight:'600'}}},
        tooltip:{backgroundColor:'rgba(28,28,32,.96)',borderColor:'rgba(255,255,255,.12)',borderWidth:.5,cornerRadius:12,padding:10}},
      scales:{x:{ticks:{maxTicksLimit:6,font:{size:9.5}},grid:{display:false}},
        y:{ticks:{font:{size:9.5},callback:v=>v>=1000?(v/1000)+'k':v},grid:{color:'rgba(255,255,255,.05)'}},
        y1:{position:'right',min:0,max:100,ticks:{color:'rgba(48,209,88,.75)',font:{size:9.5},callback:v=>v+'%'},grid:{display:false}}}}});
  drawMain('day');
  const costCtx=$('#costChart');
  if(costCtx){
    const days=[...Array(7)].map((_,i)=>new Date(Date.now()-(6-i)*864e5).toLocaleDateString('en-US',{weekday:'short'}));
    costChart=new Chart(costCtx.getContext('2d'),{type:'bar',
      data:{labels:days,datasets:[{data:Array(7).fill(0),backgroundColor:'rgba(10,132,255,.65)',hoverBackgroundColor:'#0A84FF',borderRadius:7,maxBarThickness:26,borderSkipped:false}]},
      options:{responsive:true,maintainAspectRatio:false,animation:{duration:450},
        plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,32,.96)',borderColor:'rgba(255,255,255,.12)',borderWidth:.5,cornerRadius:12,callbacks:{label:c=>'$'+c.raw.toFixed(2)}}},
        scales:{x:{grid:{display:false},ticks:{font:{size:10,weight:'600'}}},y:{ticks:{font:{size:9.5},callback:v=>'$'+v},grid:{color:'rgba(255,255,255,.05)'}}}}});
  }
}

async function drawMain(period){
  if(!mainChart)return;
  const d=await api('/api/history?period='+encodeURIComponent(period));
  if(!d||!d.points||d.points.length<2)return;
  const pts=d.points;
  const labels=pts.map(p=>{const dt=new Date(p.ts);return period==='week'?dt.toLocaleDateString('en-US',{day:'2-digit',month:'2-digit'}):timeStr(dt);});
  mainChart.data.labels=labels;
  mainChart.data.datasets[0].data=pts.map(p=>p.load||0);
  mainChart.data.datasets[1].data=pts.map(p=>p.soc||0);
  mainChart.update();
  const loads=pts.map(p=>p.load||0);
  const avg=loads.reduce((a,b)=>a+b,0)/loads.length;
  const peak=Math.max(...loads);
  const stepH=(pts[1].ts-pts[0].ts)/36e5;
  const kwh=loads.reduce((a,b)=>a+b,0)*stepH/1000;
  const rate=(S.tariff.day+S.tariff.night)/2;
  $('#stAvg').textContent=fmt(avg)+' W';
  $('#stPeak').textContent=fmt(peak)+' W';
  $('#stKwh').textContent=kwh.toFixed(1)+' kWh';
  $('#stCost').textContent='$'+(kwh*rate).toFixed(1);
}

// ─── Events from notifications ─────────────────────────────
async function pollNotifications(){
  const d=await api('/api/logs');
}

// ─── Settings ──────────────────────────────────────────────
async function loadSettings(){
  const d=await api('/api/plugin-config');
  if(!d||!d.config)return;
  S.config=d.config;
  if(d.config.tariff){
    S.tariff.day=d.config.tariff.dayRate||S.tariff.day;
    S.tariff.night=d.config.tariff.nightRate||S.tariff.night;
    const td=$('#tDay');if(td)td.value=S.tariff.day;
    const tn=$('#tNight');if(tn)tn.value=S.tariff.night;
  }
  const v=await api('/api/app-version');
  if(v){const sv=$('#sysVersion');if(sv)sv.textContent=v.version||'—';}
  const inv=$('#invIp');if(inv)inv.textContent=S.config.inverter?.ip||'—';
  const sn=$('#invSerial');if(sn)sn.textContent=S.config.inverter?.serial||'—';
  const ts=$('#tuyaStatus');if(ts){const hasTuya=!!(S.config.tuya?.username);ts.textContent=hasTuya?'Configured':'Not Set';ts.className=hasTuya?'badge-ok':'badge-ok';ts.style.cssText=hasTuya?'':'background:rgba(255,69,58,.15);color:var(--red)';}
  const ta=$('#tuyaAccessId');if(ta)ta.textContent=S.config.tuya?.accessId||'—';
  const tu=$('#tuyaUsername');if(tu)tu.textContent=S.config.tuya?.username||'—';
  const tc=$('#tuyaDeviceCount');if(tc)tc.textContent=S.devices.length||0;
  const modeResult=await api('/api/tuya-mode');
  if(modeResult&&modeResult.mode){
    $$('#tuyaModeSeg button').forEach(b=>b.classList.toggle('on',b.dataset.mode===modeResult.mode));
    updateTuyaModeHint(modeResult.mode);
  }
  // Auto-scan
  const as=await api('/api/inverter/autoscan');
  if(as&&as.success!==false){
    $$('#invScanSeg button').forEach(b=>b.classList.toggle('on',b.dataset.scan===(as.enabled?'auto':'off')));
    updateInvScanHint(as.enabled?'auto':'off');
  }
  // NetBird
  const nb=await api('/api/netbird/status');
  if(nb){
    const ns=$('#nbStatus');if(ns){ns.textContent=nb.success?'Connected':'Disconnected';ns.className='badge-ok';ns.style.cssText=nb.success?'':'background:rgba(255,69,58,.15);color:var(--red)';}
    const nip=$('#nbIp');if(nip)nip.textContent=nb.status?nb.status.match(/IP:\s*(\S+)/)?.[1]||'—':'—';
  }
  // Notifications
  const ncfg=S.config.notifications||{};
  const ntfyOn=ncfg.ntfyEnabled!==false&&ncfg.notifEnabled!==false;
  const tgOn=ncfg.telegramEnabled!==false&&ncfg.notifEnabled!==false;
  $$('#ntfySeg button').forEach(b=>b.classList.toggle('on',b.dataset.ntfy===(ntfyOn?'on':'off')));
  $$('#tgSeg button').forEach(b=>b.classList.toggle('on',b.dataset.tg===(tgOn?'on':'off')));
  const ntopic=$('#ntfyTopic');if(ntopic)ntopic.textContent=ncfg.ntfyTopic||'—';
  const nls=$('#ntfyLowSoc');if(nls)nls.value=ncfg.lowSocAlert||20;
  const tcid=$('#tgChatId');if(tcid)tcid.textContent=ncfg.telegramChatId||'—';
}

const MODE_HINTS={local:'LAN only — no cloud fallback',auto:'Local-first with cloud fallback',cloud:'Cloud only — no local control'};
function updateTuyaModeHint(mode){const el=$('#tuyaModeHint');if(el)el.textContent=MODE_HINTS[mode]||'';}

const SCAN_HINTS={off:'Off — manual scan only',auto:'Auto — scan on connection failure'};
function updateInvScanHint(mode){const el=$('#invScanHint');if(el)el.textContent=SCAN_HINTS[mode]||'';}

// ─── Tab switching ─────────────────────────────────────────
function switchTab(id){
  vib(8);
  $$('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===id));
  $$('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+id));
  if(id==='analytics')setTimeout(()=>{initAnalytics();drawMain('day');},80);
  if(id==='settings')loadSettings();
  if(id==='rules')renderRules();
}

// ─── Init ──────────────────────────────────────────────────
async function init(){
  $('#dateNote').textContent=new Date().toLocaleDateString('en-US',{weekday:'long',day:'numeric',month:'long'});
  updateClock();

  // Auth check
  const r=await api('/api/status');
  if(!r)return;
  if(r.csrfToken)window._csrf=r.csrfToken;

  // Parse status
  S.grid=r.gridPower!==undefined?r.gridPower!==0||r.gridVoltage>100:true;
  S.gridV=r.gridVoltage||0;
  S.gridHz=50+r.gridRaw*0.01||50;
  S.soc=r.batterySOC||0;
  S.storedWh=CAP_WH*S.soc/100;
  S.batW=r.batteryPower||0;
  S.load=r.loadPower||0;
  S.pvPower=r.pvPower||0;
  S.invTemp=r.envTemp||0;
  S.batTemp=r.batteryTemp||0;
  S.importToday=r.dayGridImport||0;
  S.costToday=r.costToday?.day+r.costToday?.night||0;
  if(r.tariff){S.tariff.day=r.tariff.dayRate||S.tariff.day;S.tariff.night=r.tariff.nightRate||S.tariff.night;}
  if(r.tuyaDevices)S.devices=r.tuyaDevices;
  if(r.scenes)S.scenes=r.scenes;

  renderDevices();renderQuick();renderRules();
  updateAll();

  // Polling
  setInterval(async()=>{
    const d=await api('/api/status');if(!d)return;
    if(d.csrfToken)window._csrf=d.csrfToken;
    S.grid=d.gridPower!==undefined?d.gridPower!==0||d.gridVoltage>100:true;
    S.gridV=d.gridVoltage||0;
    S.soc=d.batterySOC||0;
    S.storedWh=CAP_WH*S.soc/100;
    S.batW=d.batteryPower||0;
    S.load=d.loadPower||0;
    S.pvPower=d.pvPower||0;
    S.invTemp=d.envTemp||0;
    S.batTemp=d.batteryTemp||0;
    S.importToday=d.dayGridImport||0;
    S.costToday=d.costToday?.day+d.costToday?.night||0;
    if(d.tuyaDevices)S.devices=d.tuyaDevices;
    if(d.scenes)S.scenes=d.scenes;
    updateAll();
  },5000);

  setInterval(async()=>{
    const d=await api('/api/tuya-devices');
    if(Array.isArray(d)){S.devices=d;renderDevices();renderQuick();}
  },30000);

  setInterval(async()=>{
    const d=await api('/api/scenes');
    if(Array.isArray(d)){S.scenes=d;renderRules();}
  },30000);

  setInterval(updateClock,10000);

  // Update note
  setInterval(()=>{$('#updNote').textContent='UPDATED '+timeStr();},5000);

  addEvent('ph-lightning','#30D158','System started · all OK');
}

// ─── Global events ─────────────────────────────────────────
document.addEventListener('change',e=>{
  const sw=e.target.closest('input[data-sw]');
  if(sw){setDevice(sw.dataset.sw,sw.checked);vib(12);return;}
  const rl=e.target.closest('input[data-rule]');
  if(rl){toggleScene(rl.dataset.rule,rl.checked);vib(10);return;}
});
document.addEventListener('click',e=>{
  const q=e.target.closest('[data-q]');
  if(q){const d=S.devices.find(x=>x.id===q.dataset.q);if(d)setDevice(d.id,!d.switch);vib(15);return;}
  const dc=e.target.closest('[data-dev]');
  if(dc&&!e.target.closest('.sw')){openDevice(dc.dataset.dev);vib(8);return;}
  const f=e.target.closest('[data-filter]');
  if(f){devFilter=f.dataset.filter;$$('[data-filter]').forEach(x=>x.classList.toggle('on',x===f));renderDevices();vib(8);return;}
  const cp=e.target.closest('[data-period]');
  if(cp){$$('[data-period]').forEach(x=>x.classList.toggle('on',x===cp));drawMain(cp.dataset.period);vib(8);return;}
  const tm=e.target.closest('#tuyaModeSeg button');
  if(tm){const m=tm.dataset.mode;vib(10);
    $$('#tuyaModeSeg button').forEach(b=>b.classList.toggle('on',b===tm));
    updateTuyaModeHint(m);
    api('/api/tuya-mode',{method:'POST',body:JSON.stringify({mode:m})}).then(r=>{
      if(r&&r.success)banner('Mode','Control mode: '+m,'success');
      else banner('Error',r?.message||'Failed','error');
    });
    return;
  }
  const is=e.target.closest('#invScanSeg button');
  if(is){const m=is.dataset.scan;vib(10);
    $$('#invScanSeg button').forEach(b=>b.classList.toggle('on',b===is));
    updateInvScanHint(m);
    api('/api/inverter/autoscan',{method:'POST',body:JSON.stringify({enabled:m==='auto'})}).then(r=>{
      if(r&&r.success)banner('Auto-Scan',m==='auto'?'Enabled — scans on failure':'Disabled','success');
      else banner('Error',r?.message||'Failed','error');
    });
    return;
  }
  const nbUp=e.target.closest('#btnNbUp');
  if(nbUp){vib(12);banner('VPN','Connecting to NetBird…','info');
    api('/api/netbird/up',{method:'POST'}).then(r=>{
      if(r&&r.success)banner('VPN','Connected','success');
      else banner('VPN',r?.message||'Failed','error');
      loadSettings();
    });return;}
  const nbDown=e.target.closest('#btnNbDown');
  if(nbDown){vib(12);banner('VPN','Disconnecting…','info');
    api('/api/netbird/down',{method:'POST'}).then(r=>{
      if(r&&r.success)banner('VPN','Disconnected','success');
      else banner('VPN',r?.message||'Failed','error');
      loadSettings();
    });return;}
  const nf=e.target.closest('#ntfySeg button');
  if(nf){const on=nf.dataset.ntfy==='on';vib(10);
    $$('#ntfySeg button').forEach(b=>b.classList.toggle('on',b===nf));
    api('/api/plugin-config',{method:'POST',body:JSON.stringify({config:{notifications:{ntfyEnabled:on,notifEnabled:on}}})}).then(r=>{
      if(r&&r.success)banner('ntfy',on?'Enabled':'Disabled','success');
    });return;}
  const tg=e.target.closest('#tgSeg button');
  if(tg){const on=tg.dataset.tg==='on';vib(10);
    $$('#tgSeg button').forEach(b=>b.classList.toggle('on',b===tg));
    api('/api/plugin-config',{method:'POST',body:JSON.stringify({config:{notifications:{telegramEnabled:on,notifEnabled:on}}})}).then(r=>{
      if(r&&r.success)banner('Telegram',on?'Enabled':'Disabled','success');
    });return;}
  const tn=e.target.closest('#btnTestNtfy');
  if(tn){vib(10);banner('ntfy','Sending test…','info');
    api('/api/test-notification',{method:'POST'}).then(r=>{
      if(r)banner('ntfy',r.results?r.results.join(', '):'Sent','success');
    });return;}
  const tt=e.target.closest('#btnTestTg');
  if(tt){vib(10);banner('Telegram','Sending test…','info');
    api('/api/test-notification',{method:'POST'}).then(r=>{
      if(r)banner('Telegram',r.results?r.results.join(', '):'Sent','success');
    });return;}
  const g=e.target.closest('[data-goto]');
  if(g){const t=$(`.tab[data-tab="${g.dataset.goto}"]`);if(t)t.click();return;}
});
$('#devSearch')?.addEventListener('input',e=>{devQuery=e.target.value.trim().toLowerCase();renderDevices();});
$$('.tab').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
$$('.scroll').forEach(sc=>{
  const nav=sc.querySelector('.navglass');if(!nav)return;
  sc.addEventListener('scroll',()=>nav.classList.toggle('scrolled',sc.scrollTop>26),{passive:true});
});
const io=new IntersectionObserver(es=>es.forEach(en=>{if(en.isIntersecting){en.target.classList.add('in');io.unobserve(en.target);}}),{threshold:.06});
$$('.rv').forEach((el,i)=>{el.style.transitionDelay=(i%7)*45+'ms';io.observe(el);});
$('#island').addEventListener('click',()=>{
  const isl=$('#island');isl.classList.toggle('expanded');vib(8);
  clearTimeout(isl._t);
  if(isl.classList.contains('expanded'))isl._t=setTimeout(()=>isl.classList.remove('expanded'),4500);
});
$('#btnUnload')?.addEventListener('click',unloadOptional);
$('#btnUnloadAll')?.addEventListener('click',unloadOptional);
$('#btnAddRule')?.addEventListener('click',openAddRule);
$('#btnScan')?.addEventListener('click',async e=>{
  const t=e.currentTarget.querySelector('.act-lb');
  if(t)t.innerHTML='<span class="spin"></span>Searching…';
  banner('Scanning','Inverter network scan initiated…','info');
});
$('#btnSyncTuya')?.addEventListener('click',async e=>{
  const t=e.currentTarget.querySelector('.act-lb');
  if(t)t.innerHTML='<span class="spin"></span>Syncing…';
  try{
    const r=await api('/api/sync-tuya',{method:'POST'});
    if(r&&r.success){banner('Tuya',r.message||'Synced','success');const d=await api('/api/tuya-devices');if(Array.isArray(d)){S.devices=d;const tc=$('#tuyaDeviceCount');if(tc)tc.textContent=d.length;}}
    else banner('Tuya',r?.message||'Sync failed','error');
  }catch(err){banner('Tuya','Sync failed: '+err.message,'error');}
  if(t)t.innerHTML='Sync Devices';
});
$('#btnBackup')?.addEventListener('click',async()=>{
  const r=await api('/api/backup',{method:'POST',body:JSON.stringify({scope:['config','scenes','history']})});
  if(r&&r.backup){
    const blob=new Blob([JSON.stringify(r.backup,null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='strum-backup.json';a.click();
    banner('Backup','Downloaded','success');
  }
});
$('#btnRestart')?.addEventListener('click',async()=>{
  if(!confirm('Restart the service?'))return;
  await api('/api/restart',{method:'POST'});
  banner('Restarting','Service is restarting…','info');
  setTimeout(()=>window.location.reload(),5000);
});
$('#btnLogout')?.addEventListener('click',async()=>{
  await api('/api/logout',{method:'POST'});
  window.location.href='/login';
});
$('#tDay')?.addEventListener('input',e=>{const v=parseFloat(e.target.value);if(!isNaN(v))S.tariff.day=v;});
$('#tNight')?.addEventListener('input',e=>{const v=parseFloat(e.target.value);if(!isNaN(v))S.tariff.night=v;});
$('#ntfyLowSoc')?.addEventListener('change',e=>{
  const v=parseInt(e.target.value);if(isNaN(v))return;
  api('/api/plugin-config',{method:'POST',body:JSON.stringify({config:{notifications:{lowSocAlert:v}}})});
});

document.addEventListener('DOMContentLoaded',init);
