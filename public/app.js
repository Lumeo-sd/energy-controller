'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const fmt=(n,d=0)=>Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const vib=p=>{try{navigator.vibrate&&navigator.vibrate(p)}catch(e){}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const timeStr=d=>(d||new Date()).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});

window._csrf='';
const CAP_WH=5120,EFF=0.92;
const S={grid:true,gridV:0,gridHz:50,soc:0,storedWh:0,batW:0,batDir:'',load:0,
  pvPower:0,invTemp:0,batTemp:0,importToday:0,costToday:0,
  tariff:{day:4.32,night:2.16},devices:[],scenes:[],events:[],config:null,
  notifications:[],unreadCount:0,currency:'$',calmMode:false};

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
function banner(title,msg,type='info',action,requireTap){
  const[ic,c]=BANNER[type]||BANNER.info;
  if(type==='error'&&!requireTap)requireTap=true;
  const el=document.createElement('div');el.className='banner';
  if(requireTap)el.classList.add('critical');
  el.innerHTML=`<span class="bn-ic" style="--c:${c}"><i class="ph-fill ${ic}"></i></span>
    <div class="bn-tx"><b>${title}</b><span>${msg}</span></div>
    ${action?`<button class="bn-act">${action.label}</button>`:''}<button class="bn-x"><i class="ph-bold ph-x"></i></button>`;
  $('#banners').appendChild(el);
  while($('#banners').children.length>2)$('#banners').firstChild.remove();
  let done=false;
  const kill=()=>{if(done)return;done=true;el.classList.add('out');setTimeout(()=>el.remove(),350);};
  el.querySelector('.bn-x').onclick=e=>{e.stopPropagation();kill();};
  if(action)el.querySelector('.bn-act').onclick=e=>{e.stopPropagation();action.fn();kill();};
  if(!requireTap){el.onclick=kill;setTimeout(kill,action?8000:4600);}
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
  const t=$('#sbBatt');if(t)t.textContent=fmt(S.soc)+'%';
}

// ─── Tiles ─────────────────────────────────────────────────
function updateTiles(){
  $('#mLoad').textContent=fmt(S.load)+' W';
  $('#mImport').textContent=S.importToday.toFixed(1)+' kWh';
  $('#mCost').textContent=S.currency+' '+S.costToday.toFixed(1);
  $('#mTemp').textContent=fmt(S.invTemp)+'°';
  const t=$('#tToday');if(t)t.textContent=S.currency+' '+S.costToday.toFixed(1);
  // Weather tile placeholder
  const mw=$('#mWeather');if(mw)mw.textContent='—';
  // Next outage placeholder
  const mo=$('#mOutage');if(mo)mo.textContent='—';
}

// ─── Recommendations ───────────────────────────────────────
function renderRecommendations(){
  const el=$('#recsList');if(!el)return;
  const recs=[];
  if(!S.grid){
    recs.push({icon:'ph-lightning-slash',color:'#FF453A',text:'Grid is down — save energy, critical loads only'});
  }
  if(S.grid&&S.soc<30){
    recs.push({icon:'ph-battery-charging',color:'#FFD60A',text:'SOC below 30% — charge battery before possible outage'});
  }
  if(!S.grid&&S.soc>80){
    recs.push({icon:'ph-plugs',color:'#30D158',text:'Battery nearly full — consider turning on high-power devices'});
  }
  if(S.importToday>5){
    recs.push({icon:'ph-arrow-down-to-line',color:'#FF9F0A',text:'High grid import today ('+S.importToday.toFixed(1)+' kWh) — check tariff optimization'});
  }
  const criticalOn=S.devices.filter(d=>getDevicePriority(d)==='critical'&&d.switch).length;
  const optionalOn=S.devices.filter(d=>getDevicePriority(d)==='optional'&&d.switch).length;
  if(!S.grid&&criticalOn===0){
    recs.push({icon:'ph-warning',color:'#FF453A',text:'No critical loads active during outage'});
  }
  if(optionalOn>3){
    recs.push({icon:'ph-dots-three',color:'#8E8E93',text:optionalOn+' optional devices running — unload to extend autonomy'});
  }
  if(recs.length===0){
    recs.push({icon:'ph-check-circle',color:'#30D158',text:'Everything looks good — no action needed'});
  }
  el.innerHTML=recs.slice(0,3).map(r=>
    `<div class="rec-item"><span class="rec-ic" style="--c:${r.color}"><i class="ph-fill ${r.icon}"></i></span><span class="rec-text">${r.text}</span></div>`
  ).join('');
}

// ─── SOC Forecast mini chart ───────────────────────────────
let forecastChart=null;
async function initForecastChart(){
  const ctx=$('#forecastMini');if(!ctx)return;
  const d=await api('/api/history?period=6h');
  if(!d||!d.points||d.points.length<2)return;
  const pts=d.points;
  const labels=pts.map(p=>timeStr(new Date(p.ts)));
  const socData=pts.map(p=>p.soc||0);
  // Simple linear extrapolation for next 2 hours (8 points at ~15min intervals)
  const lastSoc=socData[socData.length-1]||S.soc;
  const firstSoc=socData[0]||S.soc;
  const rate=(lastSoc-firstSoc)/Math.max(1,socData.length-1);
  for(let i=1;i<=8;i++){
    socData.push(clamp(lastSoc+rate*i,0,100));
    const future=new Date(Date.now()+i*15*60000);
    labels.push(timeStr(future));
  }
  // Update forecast meta
  const fn=$('#fcNow');if(fn)fn.textContent=fmt(S.soc)+'%';
  const f4=$('#fc4h');if(f4)f4.textContent=fmt(Math.round(socData[Math.min(socData.length-1,socData.length-9)]))+'%';
  const f8=$('#fc8h');if(f8)f8.textContent=fmt(Math.round(lastSoc+rate*8))+'%';
  if(forecastChart){forecastChart.data.labels=labels;forecastChart.data.datasets[0].data=socData;forecastChart.update();return;}
  forecastChart=new Chart(ctx.getContext('2d'),{type:'line',
    data:{labels,datasets:[{data:socData,borderColor:'#30D158',borderWidth:2,tension:.35,pointRadius:0,fill:true,
      backgroundColor:function(c){const{ctx:cc,chartArea}=c.chart;if(!chartArea)return'rgba(48,209,88,.1)';
        const g=cc.createLinearGradient(0,chartArea.top,0,chartArea.bottom);g.addColorStop(0,'rgba(48,209,88,.25)');g.addColorStop(1,'rgba(48,209,88,0)');return g;},
      segment:{borderDash:ctx2=>ctx2.p0DataIndex>=pts.length-2?[5,5]:undefined}}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:400},
      plugins:{legend:{display:false},tooltip:{enabled:false}},
      scales:{x:{display:false},y:{min:0,max:100,display:false}}}});
}

// ─── Source chart (Grid vs Battery) ────────────────────────
let sourceChart=null;
async function initSourceChart(){
  const ctx=$('#sourceChart');if(!ctx)return;
  const d=await api('/api/history?period=week');
  if(!d||!d.points||d.points.length<2)return;
  const pts=d.points;
  // Aggregate by day
  const days={};
  pts.forEach(p=>{
    const day=new Date(p.ts).toLocaleDateString('en-US',{day:'2-digit',month:'short'});
    if(!days[day])days[day]={grid:0,bat:0};
    days[day].grid+=(p.gridImport||0);
    days[day].bat+=(p.batteryPower>0?Math.abs(p.batteryPower)*0.25:0)/1000; // approx kWh
  });
  const labels=Object.keys(days).slice(-7);
  const gridData=labels.map(l=>Math.round(days[l].grid*10)/10);
  const batData=labels.map(l=>Math.round(days[l].bat*10)/10);
  if(sourceChart){sourceChart.data.labels=labels;sourceChart.data.datasets[0].data=gridData;sourceChart.data.datasets[1].data=batData;sourceChart.update();return;}
  sourceChart=new Chart(ctx.getContext('2d'),{type:'bar',
    data:{labels,datasets:[
      {label:'Grid',data:gridData,backgroundColor:'rgba(10,132,255,.65)',borderRadius:4,maxBarThickness:18,borderSkipped:false},
      {label:'Battery',data:batData,backgroundColor:'rgba(48,209,88,.65)',borderRadius:4,maxBarThickness:18,borderSkipped:false}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:400},
      plugins:{legend:{display:true,position:'top',align:'end',labels:{boxWidth:6,boxHeight:6,usePointStyle:true,pointStyle:'circle',color:'rgba(235,235,245,.5)',font:{size:9,weight:'600'}}},
        tooltip:{backgroundColor:'rgba(28,28,32,.96)',borderColor:'rgba(255,255,255,.12)',borderWidth:.5,cornerRadius:12}},
      scales:{x:{stacked:true,grid:{display:false},ticks:{font:{size:9,weight:'600'}}},
        y:{stacked:true,ticks:{font:{size:9},callback:v=>v+' kWh'},grid:{color:'rgba(255,255,255,.05)'}}}}});
}

// ─── Device Breakdown ──────────────────────────────────────
async function renderDeviceBreakdown(){
  const el=$('#deviceBreakdown');if(!el)return;
  const d=await api('/api/socket-history?period=day');
  if(!d||!d.points||!d.points.length){el.innerHTML='<div class="rec-empty">No device data yet</div>';return;}
  // Aggregate per device
  const devEnergy={};
  const names=d.deviceNames||{};
  d.points.forEach(p=>{
    if(!p.devices)return;
    for(const[devId,watts] of Object.entries(p.devices)){
      if(!devEnergy[devId])devEnergy[devId]=0;
      devEnergy[devId]+=Math.abs(watts||0)*0.25/1000; // approx kWh
    }
  });
  const sorted=Object.entries(devEnergy).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const maxVal=sorted.length?sorted[0][1]:1;
  const colors=['#0A84FF','#30D158','#FF9F0A','#BF5AF2','#FF453A','#64D2FF'];
  el.innerHTML=sorted.map(([devId,kwh],i)=>{
    const name=names[devId]||devId.slice(-6);
    const pct=Math.max(4,kwh/maxVal*100);
    return`<div class="bd-row"><span class="bd-name">${name}</span>
      <div class="bd-bar"><div class="bd-bar-i" style="width:${pct}%;background:${colors[i%colors.length]}"></div></div>
      <span class="bd-val">${kwh.toFixed(1)} kWh</span></div>`;
  }).join('')||'<div class="rec-empty">No device data yet</div>';
}

// ─── Grid Chip ─────────────────────────────────────────────
function updateChip(){
  const c=$('#gridChip');
  if(S.grid){c.className='nv-chip';c.innerHTML=`<i class="ph-fill ph-plug-charging"></i> Grid · ${fmt(S.gridV,1)} V`;}
  else{c.className='nv-chip bad';c.innerHTML='<i class="ph-fill ph-lightning-slash"></i> No Grid';}
  const inv=$('#invStatus');
  if(inv){inv.textContent=S.grid?'Online':'On Battery';inv.className=S.grid?'badge-ok':'badge-ok';inv.style.cssText=S.grid?'':'background:rgba(255,159,10,.15);color:var(--orange)';}
}

function updateAll(){updateFlow();updateBattery();updateSurvival();updateIsland();updateTiles();updateChip();renderRecommendations();}

// ─── Clock ─────────────────────────────────────────────────
function updateClock(){const el=$('#sbTime');if(el)el.textContent=new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}).replace(/^0/,'');}

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
  const dailyKwh=d.dailyEnergy!=null?(d.dailyEnergy).toFixed(2):'—';
  openSheet(`<div class="grab"></div>
    <div class="sh-head"><div class="dic big" style="--c:${PRI[pri].color}"><i class="ph-fill ph-plugs"></i></div>
      <div><b class="sh-title">${d.name||d.id}</b><span class="sh-sub">${d.switch?'on':'off'} · ${d.online?'online':'offline'}</span></div>
      <label class="sw"><input type="checkbox" data-sw="${d.id}" ${d.switch?'checked':''}><span class="knob"></span></label></div>
    <div class="spark"><canvas id="devSparkline"></canvas></div>
    <div class="sh-stats">
      <div><span>Now</span><b>${fmt(p)} W</b></div>
      <div><span>Voltage</span><b>${d.voltage?fmt(d.voltage,1)+' V':'—'}</b></div>
      <div><span>Current</span><b>${d.current?fmt(d.current,2)+' A':'—'}</b></div>
    </div>
    <div class="sh-row"><span>Daily Energy</span><b>${dailyKwh} kWh</b></div>
    <div class="sh-row"><span>Protocol</span><b class="prot ${d.online?'loc':'cld'}"><i class="ph-bold ph-${d.online?'wifi-high':'cloud'}"></i> ${d.online?'Tuya Local':'Tuya Cloud'}</b></div>
    <div class="sh-row"><span>Device ID</span><b class="mono" style="font-size:11px">${d.id}</b></div>
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
  // Draw sparkline
  loadDeviceSparkline(d.id);
}

async function loadDeviceSparkline(devId){
  const ctx=$('#devSparkline');if(!ctx)return;
  const d=await api('/api/socket-history?period=6h');
  if(!d||!d.points||!d.points.length)return;
  const data=d.points.map(p=>Math.abs(p.devices?.[devId]||0));
  if(!data.some(v=>v>0))return;
  const labels=d.points.map(p=>timeStr(new Date(p.ts)));
  new Chart(ctx.getContext('2d'),{type:'line',
    data:{labels,datasets:[{data,borderColor:'#0A84FF',borderWidth:1.5,tension:.35,pointRadius:0,fill:true,
      backgroundColor:c=>{const{ctx:cc,chartArea}=c.chart;if(!chartArea)return'rgba(10,132,255,.1)';
        const g=cc.createLinearGradient(0,chartArea.top,0,chartArea.bottom);g.addColorStop(0,'rgba(10,132,255,.3)');g.addColorStop(1,'rgba(10,132,255,0)');return g;}}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},
      plugins:{legend:{display:false},tooltip:{enabled:false}},
      scales:{x:{display:false},y:{display:false}}}});
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
let mainChart=null,costChart=null,compareChart=null,anaInit=false;
let currentAnaSeg='charts';
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
        plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,32,.96)',borderColor:'rgba(255,255,255,.12)',borderWidth:.5,cornerRadius:12,callbacks:{label:c=>S.currency+' '+c.raw.toFixed(2)}}},
        scales:{x:{grid:{display:false},ticks:{font:{size:10,weight:'600'}}},y:{ticks:{font:{size:9.5},callback:v=>S.currency+' '+v},grid:{color:'rgba(255,255,255,.05)'}}}}});
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
  $('#stCost').textContent=S.currency+(kwh*rate).toFixed(1);
}

// ─── Analytics sub-views ───────────────────────────────────
function switchAnaSeg(seg){
  currentAnaSeg=seg;
  $$('.ana-view').forEach(v=>v.classList.toggle('active',v.id==='ana-'+seg));
  $$('[data-aseg]').forEach(b=>b.classList.toggle('on',b.dataset.aseg===seg));
  if(seg==='compare')initCompareChart();
  if(seg==='data')loadExportData();
}

async function initCompareChart(){
  const ctx=$('#compareChart');if(!ctx)return;
  const today=await api('/api/history?period=day');
  if(!today||!today.points||today.points.length<2)return;
  // Compute yesterday's data by fetching a longer range and slicing
  const allPts=today.points;
  const todayStart=new Date();todayStart.setHours(0,0,0,0);
  const yesterdayPts=allPts.filter(p=>p.ts<todayStart.getTime());
  const todayPts=allPts.filter(p=>p.ts>=todayStart.getTime());
  const todayKwh=todayPts.reduce((a,p)=>a+(p.load||0),0)*((allPts[1]?.ts-allPts[0]?.ts||900000)/36e5)/1000;
  const yesterdayKwh=yesterdayPts.reduce((a,p)=>a+(p.load||0),0)*((allPts[1]?.ts-allPts[0]?.ts||900000)/36e5)/1000;
  const delta=todayKwh-yesterdayKwh;
  const pct=yesterdayKwh>0?((delta/yesterdayKwh)*100).toFixed(0):'0';
  const dt=$('#compToday');if(dt)dt.textContent=todayKwh.toFixed(1)+' kWh';
  const dy=$('#compYesterday');if(dy)dy.textContent=yesterdayKwh.toFixed(1)+' kWh';
  const dv=$('#compDeltaVal');if(dv)dv.textContent=(delta>0?'+':'')+delta.toFixed(1)+' kWh';
  const dd=$('#compDelta');if(dd){dd.textContent=(delta>0?'↑':'↓')+' '+Math.abs(pct)+'%';dd.className=delta>0?'mini-badge':'mini-badge g';}
  const tr=$('#compTrend');if(tr)tr.textContent=delta>0?'↑ Higher':'↓ Lower';
  // Build labels from 24h time
  const labels=[...Array(24)].map((_,i)=>i+':00');
  const ytData=labels.map((_,i)=>{const pt=yesterdayPts[Math.floor(i/24*yesterdayPts.length)];return pt?(pt.load||0):0;});
  const tdData=labels.map((_,i)=>{const pt=todayPts[Math.floor(i/24*Math.max(1,todayPts.length))];return pt?(pt.load||0):0;});
  if(compareChart){compareChart.data.labels=labels;compareChart.data.datasets[0].data=ytData;compareChart.data.datasets[1].data=tdData;compareChart.update();return;}
  compareChart=new Chart(ctx.getContext('2d'),{type:'line',
    data:{labels,datasets:[
      {label:'Yesterday',data:ytData,borderColor:'rgba(235,235,245,.25)',borderWidth:1.5,tension:.35,pointRadius:0,fill:false,borderDash:[4,4]},
      {label:'Today',data:tdData,borderColor:'#0A84FF',borderWidth:2,tension:.35,pointRadius:0,fill:true,
        backgroundColor:c=>{const{ctx:cc,chartArea}=c.chart;if(!chartArea)return'rgba(10,132,255,.1)';
          const g=cc.createLinearGradient(0,chartArea.top,0,chartArea.bottom);g.addColorStop(0,'rgba(10,132,255,.32)');g.addColorStop(1,'rgba(10,132,255,0)');return g;}}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:450},interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:true,position:'top',align:'end',labels:{boxWidth:7,boxHeight:7,usePointStyle:true,pointStyle:'circle',color:'rgba(235,235,245,.6)',font:{size:10,weight:'600'}}},
        tooltip:{backgroundColor:'rgba(28,28,32,.96)',borderColor:'rgba(255,255,255,.12)',borderWidth:.5,cornerRadius:12,padding:10}},
      scales:{x:{ticks:{maxTicksLimit:8,font:{size:9.5}},grid:{display:false}},
        y:{ticks:{font:{size:9.5},callback:v=>v>=1000?(v/1000)+'k':v},grid:{color:'rgba(255,255,255,.05)'}}}}});
}

function initCostProjection(){
  const day=S.costToday||0;
  const daysInMonth=new Date(new Date().getFullYear(),new Date().getMonth()+1,0).getDate();
  const dayOfMonth=new Date().getDate();
  const avgPerDay=dayOfMonth>0?day/dayOfMonth:0;
  const monthProj=avgPerDay*daysInMonth;
  const pt=$('#projToday');if(pt)pt.textContent=S.currency+' '+day.toFixed(1);
  const pm=$('#projMonth');if(pm)pm.textContent=S.currency+' '+monthProj.toFixed(1);
  const pa=$('#projAvg');if(pa)pa.textContent=S.currency+' '+avgPerDay.toFixed(1)+'/day';
}

async function loadExportData(){
  const pt=$('#promToken');
  if(pt){const cfg=S.config||{};pt.textContent=cfg.metricsToken||'(set in config)';}
}

async function exportCSV(period){
  const d=await api('/api/history?period='+period);
  if(!d||!d.points)return;
  let csv='Time,Load (W),SOC (%),Grid Voltage (V),Battery Power (W)\n';
  d.points.forEach(p=>{
    csv+=new Date(p.ts).toISOString()+','+(p.load||0)+','+(p.soc||0)+','+(p.gridV||0)+','+(p.batW||0)+'\n';
  });
  downloadFile(csv,'strum-'+period+'.csv','text/csv');
}

async function exportDevicesCSV(){
  const d=await api('/api/socket-history?period=day');
  if(!d||!d.points)return;
  let csv='Time';
  const names=d.deviceNames||{};
  const devIds=[...new Set(d.points.flatMap(p=>Object.keys(p.devices||{})))];
  devIds.forEach(id=>csv+=','+(names[id]||id));
  csv+='\n';
  d.points.forEach(p=>{
    csv+=new Date(p.ts).toISOString();
    devIds.forEach(id=>csv+=','+(p.devices?.[id]||0));
    csv+='\n';
  });
  downloadFile(csv,'strum-devices.csv','text/csv');
}

async function exportJSON(){
  const [status,devices]=await Promise.all([api('/api/status'),api('/api/tuya-devices')]);
  const data={exported:new Date().toISOString(),status:status||{},devices:devices||[]};
  downloadFile(JSON.stringify(data,null,2),'strum-full.json','application/json');
}

function downloadFile(content,filename,type){
  const blob=new Blob([content],{type});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();
  banner('Export',filename+' downloaded','success');
}

// ─── Events from notifications ─────────────────────────────
let _notifPollTimer=null;
async function pollNotifications(){
  try{
    const d=await api('/api/notifications');
    if(!d||!d.notifications)return;
    S.notifications=d.notifications;
    S.unreadCount=d.unread||0;
    const badge=$('#notifBadge');
    if(badge){
      badge.textContent=S.unreadCount;
      badge.classList.toggle('show',S.unreadCount>0);
    }
  }catch(e){}
}

function renderNotifSheet(){
  const list=S.notifications||[];
  if(!list.length){
    openSheet(`<div class="grab"></div><b class="sh-title" style="display:block;margin:4px 0 14px">Notifications</b>
      <div class="notif-empty"><i class="ph-fill ph-bell-simple" style="font-size:28px;color:var(--label3);display:block;margin-bottom:8px"></i>No notifications</div>`);
    return;
  }
  const now=Date.now();
  const today=[],earlier=[];
  list.forEach(n=>{
    const age=now-(n.ts||0);
    if(age<864e5)today.push(n);else earlier.push(n);
  });
  const itemHTML=n=>{
    const colors={info:'#0A84FF',success:'#30D158',error:'#FF453A',warn:'#FF9F0A',warning:'#FF9F0A'};
    const icons={info:'ph-info',success:'ph-check-circle',error:'ph-warning-circle',warn:'ph-warning',warning:'ph-warning'};
    const c=colors[n.type]||colors.info;
    const ic=icons[n.type]||icons.info;
    const t=n.ts?new Date(n.ts).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):'';
    return`<div class="notif-item" data-nid="${n.id||''}">
      <span class="notif-ic" style="--c:${c}"><i class="ph-fill ${ic}"></i></span>
      <div class="notif-body"><b>${n.title||'Notification'}</b><span>${n.message||''}</span></div>
      <span class="notif-time">${t}</span>
      <button class="notif-dismiss" data-dismiss="${n.id||''}"><i class="ph-bold ph-x"></i></button>
    </div>`;
  };
  let html=`<div class="grab"></div><b class="sh-title" style="display:block;margin:4px 0 14px">Notifications</b>`;
  if(today.length){
    html+=`<div class="notif-group">Today</div><div class="notif-list">${today.map(itemHTML).join('')}</div>`;
  }
  if(earlier.length){
    html+=`<div class="notif-group">Earlier</div><div class="notif-list">${earlier.map(itemHTML).join('')}</div>`;
  }
  html+=`<div class="notif-actions">
    <button id="notifMarkAll"><i class="ph-bold ph-check"></i> Mark All Read</button>
    <button id="notifClearAll" class="danger"><i class="ph-bold ph-trash"></i> Clear All</button>
  </div>`;
  openSheet(html);
  // dismiss handlers
  $$('[data-dismiss]').forEach(btn=>{
    btn.onclick=async e=>{
      e.stopPropagation();
      const id=btn.dataset.dismiss;
      await api('/api/notifications/dismiss',{method:'POST',body:JSON.stringify({id})});
      S.notifications=(S.notifications||[]).filter(n=>String(n.id)!==String(id));
      S.unreadCount=(S.notifications||[]).filter(n=>!n.read).length;
      const badge=$('#notifBadge');if(badge){badge.textContent=S.unreadCount;badge.classList.toggle('show',S.unreadCount>0);}
      const item=btn.closest('.notif-item');if(item)item.remove();
    };
  });
  const markAll=$('#notifMarkAll');
  if(markAll)markAll.onclick=async()=>{
    await api('/api/notifications/mark-read',{method:'POST',body:JSON.stringify({})});
    (S.notifications||[]).forEach(n=>n.read=true);
    S.unreadCount=0;
    const badge=$('#notifBadge');if(badge){badge.textContent='0';badge.classList.remove('show');}
    banner('Notifications','All marked as read','success');
  };
  const clearAll=$('#notifClearAll');
  if(clearAll)clearAll.onclick=async()=>{
    await api('/api/notifications/dismiss-all',{method:'POST'});
    S.notifications=[];S.unreadCount=0;
    const badge=$('#notifBadge');if(badge){badge.textContent='0';badge.classList.remove('show');}
    closeSheet();
    banner('Notifications','All cleared','success');
  };
}

// ─── Settings ──────────────────────────────────────────────
async function loadSettings(){
  const d=await api('/api/plugin-config');
  if(!d||!d.config)return;
  S.config=d.config;
  if(d.config.tariff){
    S.tariff.day=d.config.tariff.dayRate||S.tariff.day;
    S.tariff.night=d.config.tariff.nightRate||S.tariff.night;
  }
  const v=await api('/api/app-version');
  if(v){const sv=$('#sysVersion');if(sv)sv.textContent=v.version||'—';}

  // Summary rows
  const invOk=!!S.config.inverter?.ip;
  const si=$('#setInvSt');if(si)si.textContent=invOk?'Online':'Offline';
  const tuyaOk=!!S.config.tuya?.username;
  const st=$('#setTuyaSt');if(st)st.textContent=tuyaOk?'Configured':'Not set';

  // Tuya mode
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
    const snb=$('#setNbSt');if(snb)snb.textContent=nb.success?'Connected':'Disconnected';
  }
  // Notifications
  const ncfg=S.config.notifications||{};
  const ntfyOn=ncfg.ntfyEnabled!==false&&ncfg.notifEnabled!==false;
  const tgOn=ncfg.telegramEnabled!==false&&ncfg.notifEnabled!==false;
  $$('#ntfySeg button').forEach(b=>b.classList.toggle('on',b.dataset.ntfy===(ntfyOn?'on':'off')));
  $$('#tgSeg button').forEach(b=>b.classList.toggle('on',b.dataset.tg===(tgOn?'on':'off')));
  const snn=$('#setNotifSt');if(snn)snn.textContent=(ntfyOn||tgOn)?'On':'Off';

  // Tariff summary
  const sty=$('#setTariffSt');if(sty)sty.textContent=S.currency+' '+S.tariff.day+'/'+S.tariff.night;

  // Integrations grid status
  const intTuya=$('#intTuya');if(intTuya){intTuya.textContent=tuyaOk?'Connected':'Not set';intTuya.className='int-st'+(tuyaOk?'':' off');}
  const intNb=$('#intNb');if(intNb){const ok=nb&&nb.success;intNb.textContent=ok?'Connected':'Disconnected';intNb.className='int-st'+(ok?'':' off');}
  const intTg=$('#intTg');if(intTg){const ok=tgOn&&ncfg.telegramChatId;intTg.textContent=ok?'Connected':'Not set';intTg.className='int-st'+(ok?'':' off');}
  const intNtfy=$('#intNtfy');if(intNtfy){const ok=ntfyOn&&ncfg.ntfyTopic;intNtfy.textContent=ok?'Connected':'Not set';intNtfy.className='int-st'+(ok?'':' off');}
  const intProm=$('#intProm');if(intProm){const ok=!!S.config.metricsToken;intProm.textContent=ok?'Configured':'Not set';intProm.className='int-st'+(ok?'':' off');}
  const intInv=$('#intInv');if(intInv){intInv.textContent=invOk?'Online':'Offline';intInv.className='int-st'+(invOk?'':' off');}

  // Currency
  const saved=localStorage.getItem('strum_currency')||'$';
  S.currency=saved;
  $$('#currencySeg button').forEach(b=>b.classList.toggle('on',b.dataset.cur===saved));

  // Calm mode
  S.calmMode=localStorage.getItem('strum_calm')==='true'||window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  applyCalmMode();
  $$('#calmSeg button').forEach(b=>b.classList.toggle('on',b.dataset.calm===(S.calmMode?'on':'off')));
}

const MODE_HINTS={local:'LAN only — no cloud fallback',auto:'Local-first with cloud fallback',cloud:'Cloud only — no local control'};
function updateTuyaModeHint(mode){const el=$('#tuyaModeHint');if(el)el.textContent=MODE_HINTS[mode]||'';}
function applyCalmMode(){document.documentElement.classList.toggle('calm',S.calmMode);}

const SCAN_HINTS={off:'Off — manual scan only',auto:'Auto — scan on connection failure'};
function updateInvScanHint(mode){const el=$('#invScanHint');if(el)el.textContent=SCAN_HINTS[mode]||'';}

// ─── Tab switching ─────────────────────────────────────────
function switchTab(id){
  vib(8);
  $$('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===id));
  $$('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+id));
  if(id==='overview')setTimeout(()=>{initForecastChart();initSourceChart();renderDeviceBreakdown();},80);
  if(id==='analytics')setTimeout(()=>{initAnalytics();drawMain('day');initCostProjection();},80);
  if(id==='settings')loadSettings();
  if(id==='rules')renderRules();
}

// ─── Init ──────────────────────────────────────────────────
async function init(){
  // Dismiss splash screen
  const splash=$('#splash');
  if(splash){setTimeout(()=>splash.classList.add('hide'),1200);setTimeout(()=>splash.remove(),1800);}

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
  // Initial chart loading for overview
  setTimeout(()=>{initForecastChart();initSourceChart();renderDeviceBreakdown();},200);
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

  // Notification polling
  pollNotifications();
  setInterval(pollNotifications,30000);

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

function openSettingsSheet(section){
  const sheets={
    inverter:()=>{
      const inv=S.config?.inverter||{};
      return`<div class="grab"></div><b class="sh-title" style="display:block;margin:4px 0 14px">Inverter</b>
        <div class="sgroup">
          <div class="sh-row"><span>Status</span><span class="badge-ok" id="invStatus">${inv.ip?'Online':'Offline'}</span></div>
          <div class="sh-row"><span>IP Address</span><b class="mono" style="font-size:12px">${inv.ip||'—'}</b></div>
          <div class="sh-row"><span>Serial</span><b class="mono" style="font-size:12px">${inv.serial||'—'}</b></div>
        </div>
        <button class="btn wide" id="btnScanSheet" style="margin-top:14px"><i class="ph-bold ph-magnifying-glass"></i> Scan Network</button>
        <div class="sgroup" style="margin-top:14px">
          <div class="sh-row"><span>Auto-Scan</span>
            <div class="seg" id="invScanSeg"><button data-scan="off" class="on">Off</button><button data-scan="auto">Auto</button></div>
          </div>
          <div class="sh-row" style="font-size:12px;color:var(--label2)">${inv.autoScan?'Auto — scans on failure':'Off — manual scan only'}</div>
        </div>
        <button class="btn wide" id="shClose" style="margin-top:18px">Done</button>`;
    },
    tuya:()=>{
      const ty=S.config?.tuya||{};
      return`<div class="grab"></div><b class="sh-title" style="display:block;margin:4px 0 14px">Tuya Cloud</b>
        <div class="sgroup">
          <div class="sh-row"><span>Status</span><span class="badge-ok">${ty.accessId?'Connected':'Not configured'}</span></div>
          <div class="sh-row"><span>Access ID</span><b class="mono" style="font-size:12px">${ty.accessId||'—'}</b></div>
          <div class="sh-row"><span>Username</span><b>${ty.username||'—'}</b></div>
          <div class="sh-row"><span>Devices</span><b>${S.devices.length}</b></div>
        </div>
        <button class="btn wide" id="btnSyncTuyaSheet" style="margin-top:14px"><i class="ph-bold ph-arrows-clockwise"></i> Sync Devices</button>
        <div class="sgroup" style="margin-top:14px">
          <div class="sh-row"><span>Control Mode</span>
            <div class="seg" id="tuyaModeSeg"><button data-mode="local">Local</button><button data-mode="auto" class="${ty.controlMode==='auto'?'on':''}">Auto</button><button data-mode="cloud">Cloud</button></div>
          </div>
          <div class="sh-row" style="font-size:12px;color:var(--label2)" id="tuyaModeHint">${MODE_HINTS[ty.controlMode||'auto']||''}</div>
        </div>
        <button class="btn wide" id="shClose" style="margin-top:18px">Done</button>`;
    },
    vpn:()=>{
      const nb=S.config?.netbird||{};
      return`<div class="grab"></div><b class="sh-title" style="display:block;margin:4px 0 14px">VPN · NetBird</b>
        <div class="sgroup">
          <div class="sh-row"><span>Status</span><span class="badge-ok">${nb.connected?'Connected':'Disconnected'}</span></div>
          <div class="sh-row"><span>IP Address</span><b class="mono" style="font-size:12px">${nb.ip||'—'}</b></div>
        </div>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn" id="btnNbUpSheet" style="flex:1"><i class="ph-bold ph-play"></i> Connect</button>
          <button class="btn danger" id="btnNbDownSheet" style="flex:1"><i class="ph-bold ph-stop"></i> Disconnect</button>
        </div>
        <button class="btn wide" id="shClose" style="margin-top:18px">Done</button>`;
    },
    tariff:()=>{
      return`<div class="grab"></div><b class="sh-title" style="display:block;margin:4px 0 14px">Tariff</b>
        <div class="sgroup">
          <div class="sh-row"><span>Currency</span>
            <div class="seg" id="currencySeg">
              <button data-cur="₴" class="${S.currency==='₴'?'on':''}">₴ UAH</button>
              <button data-cur="$" class="${S.currency==='$'?'on':''}">$ USD</button>
              <button data-cur="€" class="${S.currency==='€'?'on':''}">€ EUR</button>
              <button data-cur="zł" class="${S.currency==='zł'?'on':''}">zł PLN</button>
            </div>
          </div>
          <div class="sh-row"><span>Day Rate</span><input class="sinput" id="tDay" type="number" step="0.01" value="${S.tariff.day}"><span class="sunit">${S.currency}/kWh</span></div>
          <div class="sh-row"><span>Night Rate</span><input class="sinput" id="tNight" type="number" step="0.01" value="${S.tariff.night}"><span class="sunit">${S.currency}/kWh</span></div>
          <div class="sh-row"><span>Today</span><b>${S.currency} ${S.costToday.toFixed(1)}</b></div>
        </div>
        <button class="btn wide" id="shClose" style="margin-top:18px">Done</button>`;
    },
    notifications:()=>{
      const ntfy=S.config?.notifications?.ntfy||{};
      const tg=S.config?.notifications?.telegram||{};
      return`<div class="grab"></div><b class="sh-title" style="display:block;margin:4px 0 14px">Notifications</b>
        <div class="slabel">ntfy</div>
        <div class="sgroup">
          <div class="sh-row"><span>Enabled</span>
            <div class="seg" id="ntfySeg"><button data-ntfy="off" class="${ntfy.enabled?'':'on'}">Off</button><button data-ntfy="on" class="${ntfy.enabled?'on':''}">On</button></div>
          </div>
          <div class="sh-row"><span>Topic</span><b class="mono" style="font-size:12px">${ntfy.topic||'—'}</b></div>
          <div class="sh-row"><span>Low SOC Alert</span><input class="sinput sm" id="ntfyLowSoc" type="number" min="5" max="50" step="5" value="${ntfy.lowSoc||15}"><span class="sunit">%</span></div>
          <button class="btn" id="btnTestNtfySheet"><i class="ph-bold ph-paper-plane-tilt"></i> Send Test</button>
        </div>
        <div class="slabel" style="margin-top:14px">Telegram</div>
        <div class="sgroup">
          <div class="sh-row"><span>Enabled</span>
            <div class="seg" id="tgSeg"><button data-tg="off" class="${tg.enabled?'':'on'}">Off</button><button data-tg="on" class="${tg.enabled?'on':''}">On</button></div>
          </div>
          <div class="sh-row"><span>Chat ID</span><b class="mono" style="font-size:12px">${tg.chatId||'—'}</b></div>
          <button class="btn" id="btnTestTgSheet"><i class="ph-bold ph-paper-plane-tilt"></i> Send Test</button>
        </div>
        <button class="btn wide" id="shClose" style="margin-top:18px">Done</button>`;
    },
    system:()=>{
      return`<div class="grab"></div><b class="sh-title" style="display:block;margin:4px 0 14px">System</b>
        <div class="sgroup">
          <div class="sh-row"><span>Version</span><b class="mono">${$('#sysVersion')?.textContent||'—'}</b></div>
          <div class="sh-row"><span>Calm Mode</span>
            <div class="seg" id="calmSeg"><button data-calm="off" class="${S.calmMode?'':'on'}">Off</button><button data-calm="on" class="${S.calmMode?'on':''}">On</button></div>
          </div>
        </div>
        <button class="btn wide" id="btnUpdateSheet" style="margin-top:14px"><i class="ph-bold ph-arrow-circle-up"></i> Check for Updates</button>
        <button class="btn wide" id="btnBackupSheet" style="margin-top:8px"><i class="ph-bold ph-download-simple"></i> Create Backup</button>
        <button class="btn wide" id="btnRestartSheet" style="margin-top:8px"><i class="ph-bold ph-arrows-clockwise"></i> Restart</button>
        <button class="btn wide danger" id="btnLogoutSheet" style="margin-top:8px"><i class="ph-bold ph-sign-out"></i> Log Out</button>
        <button class="btn wide" id="shClose" style="margin-top:18px">Done</button>`;
    }
  };
  const gen=sheets[section];if(!gen)return;
  openSheet(gen());
  $('#shClose').onclick=closeSheet;
  if(section==='inverter'){$('#btnScanSheet').onclick=()=>{api('/api/inverter/scan').then(()=>banner('Scan','Scan initiated','info'));};
    const seg=$('#invScanSeg');if(seg)seg.onclick=e=>{const b=e.target.closest('button');if(!b)return;vib(8);
      $$('#invScanSeg button').forEach(x=>x.classList.toggle('on',x===b));api('/api/inverter/scan-mode',{method:'POST',body:JSON.stringify({mode:b.dataset.scan})});};}
  if(section==='tuya'){$('#btnSyncTuyaSheet').onclick=()=>{api('/api/tuya-sync',{method:'POST'}).then(r=>{if(r?.success)banner('Sync','Devices synced','success');else banner('Error',r?.message||'Failed','error');});};
    const seg=$('#tuyaModeSeg');if(seg)seg.onclick=e=>{const b=e.target.closest('button');if(!b)return;vib(8);
      $$('#tuyaModeSeg button').forEach(x=>x.classList.toggle('on',x===b));
      const h=$('#tuyaModeHint');if(h)h.textContent=MODE_HINTS[b.dataset.mode]||'';
      api('/api/tuya-mode',{method:'POST',body:JSON.stringify({mode:b.dataset.mode})}).then(r=>{if(r?.success)banner('Mode','Control: '+b.dataset.mode,'success');});};}
  if(section==='vpn'){$('#btnNbUpSheet').onclick=()=>{api('/api/netbird/connect',{method:'POST'}).then(r=>{if(r?.success)banner('VPN','Connected','success');});};
    $('#btnNbDownSheet').onclick=()=>{api('/api/netbird/disconnect',{method:'POST'}).then(r=>{if(r?.success)banner('VPN','Disconnected','success');});};}
  if(section==='tariff'){$('#tDay').onchange=e=>{S.tariff.day=parseFloat(e.target.value)||0;api('/api/tariff',{method:'POST',body:JSON.stringify(S.tariff)});};
    $('#tNight').onchange=e=>{S.tariff.night=parseFloat(e.target.value)||0;api('/api/tariff',{method:'POST',body:JSON.stringify(S.tariff)});};
    const cur=$('#currencySeg');if(cur)cur.onclick=e=>{const b=e.target.closest('button');if(!b)return;vib(8);S.currency=b.dataset.cur;localStorage.setItem('strum_currency',b.dataset.cur);
      $$('#currencySeg button').forEach(x=>x.classList.toggle('on',x===b));updateTiles();};}
  if(section==='notifications'){const bTN=$('#btnTestNtfySheet');if(bTN)bTN.onclick=()=>{api('/api/ntfy/test',{method:'POST'}).then(r=>{if(r)banner('ntfy','Sent','success');});};
    const bTT=$('#btnTestTgSheet');if(bTT)bTT.onclick=()=>{api('/api/tg/test',{method:'POST'}).then(r=>{if(r)banner('Telegram','Sent','success');});};
    const ns=$('#ntfySeg');if(ns)ns.onclick=e=>{const b=e.target.closest('button');if(!b)return;vib(8);$$('#ntfySeg button').forEach(x=>x.classList.toggle('on',x===b));
      api('/api/ntfy',{method:'POST',body:JSON.stringify({enabled:b.dataset.ntfy==='on'})});};
    const ts=$('#tgSeg');if(ts)ts.onclick=e=>{const b=e.target.closest('button');if(!b)return;vib(8);$$('#tgSeg button').forEach(x=>x.classList.toggle('on',x===b));
      api('/api/tg',{method:'POST',body:JSON.stringify({enabled:b.dataset.tg==='on'})});};}
  if(section==='system'){const bU=$('#btnUpdateSheet');if(bU)bU.onclick=()=>banner('Update','Checking…','info');
    const bB=$('#btnBackupSheet');if(bB)bB.onclick=()=>{api('/api/backup',{method:'POST'}).then(()=>banner('Backup','Downloaded','success'));};
    const bR=$('#btnRestartSheet');if(bR)bR.onclick=()=>{api('/api/restart',{method:'POST'}).then(()=>banner('Restarting','…','info'));};
    const bL=$('#btnLogoutSheet');if(bL)bL.onclick=()=>{api('/api/logout',{method:'POST'}).then(()=>location.reload());};
    const cs=$('#calmSeg');if(cs)cs.onclick=e=>{const b=e.target.closest('button');if(!b)return;vib(8);S.calmMode=b.dataset.calm==='on';localStorage.setItem('strum_calm',S.calmMode);
      $$('#calmSeg button').forEach(x=>x.classList.toggle('on',x===b));applyCalmMode();banner('Calm Mode',S.calmMode?'Animations reduced':'Animations enabled','success');};}
}

document.addEventListener('click',e=>{
  const q=e.target.closest('[data-q]');
  if(q){const d=S.devices.find(x=>x.id===q.dataset.q);if(d)setDevice(d.id,!d.switch);vib(15);return;}
  const dc=e.target.closest('[data-dev]');
  if(dc&&!e.target.closest('.sw')){openDevice(dc.dataset.dev);vib(8);return;}
  const f=e.target.closest('[data-filter]');
  if(f){devFilter=f.dataset.filter;$$('[data-filter]').forEach(x=>x.classList.toggle('on',x===f));renderDevices();vib(8);return;}
  const cp=e.target.closest('[data-period]');
  if(cp){$$('[data-period]').forEach(x=>x.classList.toggle('on',x===cp));drawMain(cp.dataset.period);vib(8);return;}
  const as=e.target.closest('[data-aseg]');
  if(as){switchAnaSeg(as.dataset.aseg);vib(8);return;}
  const ec=e.target.closest('#expCsvDay');
  if(ec){exportCSV('day');return;}
  const ew=e.target.closest('#expCsvWeek');
  if(ew){exportCSV('week');return;}
  const ej=e.target.closest('#expJson');
  if(ej){exportJSON();return;}
  const ed=e.target.closest('#expDevices');
  if(ed){exportDevicesCSV();return;}
  const cur=e.target.closest('#currencySeg button');
  if(cur){const c=cur.dataset.cur;vib(8);S.currency=c;localStorage.setItem('strum_currency',c);
    $$('#currencySeg button').forEach(b=>b.classList.toggle('on',b===cur));
    updateTiles();initCostProjection();banner('Currency','Set to '+c,'success');return;}
  const ic=e.target.closest('.int-card');
  if(ic){const id=ic.dataset.int;vib(8);
    const targets={tuya:'page-settings',netbird:'page-settings',telegram:'page-settings',ntfy:'page-settings',solarman:'page-settings'};
    if(targets[id])switchTab('settings');
    return;}
  const sr=e.target.closest('[data-settings]');
  if(sr){vib(8);openSettingsSheet(sr.dataset.settings);return;}
  const cm=e.target.closest('#calmSeg button');
  if(cm){const on=cm.dataset.calm==='on';vib(8);S.calmMode=on;localStorage.setItem('strum_calm',on);
    $$('#calmSeg button').forEach(b=>b.classList.toggle('on',b===cm));
    applyCalmMode();banner('Calm Mode',on?'Animations reduced':'Animations enabled','success');return;}
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
$('#notifBtn')?.addEventListener('click',()=>{vib(8);renderNotifSheet();});
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
