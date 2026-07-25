'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const fmt=(n,d=0)=>Number(n).toLocaleString('uk-UA',{minimumFractionDigits:d,maximumFractionDigits:d});
const vib=p=>{try{navigator.vibrate&&navigator.vibrate(p)}catch(e){}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const timeStr=d=>(d||new Date()).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'});

window._csrf='';
const CAP_WH=5120,EFF=0.92;
const S={grid:true,gridV:0,gridHz:50,soc:0,storedWh:0,batW:0,load:0,
  pvPower:0,invTemp:0,batTemp:0,importToday:0,costToday:0,
  tariff:{day:4.32,night:2.16},devices:[],scenes:[],events:[],config:null};

const PRI={critical:{label:'Критичні',color:'#FF453A',icon:'ph-shield-check'},
  essential:{label:'Важливі',color:'#FFD60A',icon:'ph-star'},
  optional:{label:'Опціональні',color:'#8E8E93',icon:'ph-dots-three'}};

function getPriorities(){try{return JSON.parse(localStorage.getItem('strum_priorities')||'{}');}catch{return {};}}
function setPriority(id,p){const all=getPriorities();all[id]=p;localStorage.setItem('strum_priorities',JSON.stringify(all));}
function getDevicePriority(d){
  const stored=getPriorities();if(stored[d.id])return stored[d.id];
  const n=(d.name||'').toLowerCase();
  if(/холодильник|котел|роутер|насос|nas/i.test(n))return'critical';
  if(/світл|освітлен|ноутбук|laptop|заряд|charger/i.test(n))return'essential';
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
  }catch(e){banner('Помилка',e.message,'error');return null;}
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
  const fg=$('#fnGrid');fg.textContent=g?fmt(S.gridV,1)+' В':'—';fg.classList.toggle('bad',!g);
  $('#fnInv').textContent=fmt(S.load)+' Вт';
  $('#fnHome').textContent=fmt(S.load)+' Вт';
  $('#fnBat').textContent=fmt(S.soc)+'%';
  $('#fImport').textContent=g?fmt(S.load+(chg?Math.abs(S.batW):0))+' Вт':'0 Вт';
  $('#fBat').textContent=(S.batW>0?'+':S.batW<0?'−':'')+(Math.abs(S.batW)/1000).toFixed(2)+' кВт';
  $('#fFreq').textContent=g?S.gridHz.toFixed(1)+' Гц':'—';
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
  $('#batPower').textContent=(S.batW>0?'+':S.batW<0?'−':'0')+(Math.abs(S.batW)/1000).toFixed(2)+' кВт';
  $('#batWh').textContent=(S.storedWh/1000).toFixed(1)+' кВт·г';
  $('#batTemp').textContent=fmt(S.batTemp,1)+'°';
  const st=$('#batState');
  if(S.batW<-5){st.textContent='Заряд';st.className='mini-badge g';}
  else if(S.batW>5){st.textContent='Розряд';st.className='mini-badge';st.style.cssText='background:rgba(255,159,10,.15);color:var(--orange)';}
  else{st.textContent='Очікує';st.className='mini-badge';st.style.cssText='';}
  $('#batteryCard').classList.toggle('low',S.soc<20);
}

// ─── Survival ──────────────────────────────────────────────
function updateSurvival(){
  if(S.load<10){$('#survTime').textContent='∞';$('#survBar').style.width='100%';$('#survHint').textContent='Навантаження мінімальне';return;}
  const hrs=S.storedWh*EFF/Math.max(30,S.load);
  const el=$('#survTime');
  if(hrs>=48)el.textContent='понад 2 доби';
  else el.textContent=fmt(Math.floor(hrs))+':'+String(Math.round((hrs%1)*60)).padStart(2,'0')+' год';
  $('#survLoad').textContent='при '+fmt(S.load)+' Вт зараз';
  $('#survBar').style.width=clamp(hrs/24*100,4,100)+'%';
  const until=new Date(Date.now()+hrs*36e5);
  $('#survHint').textContent=S.grid?'Достатньо до ~'+timeStr(until)+' · заряд '+fmt(S.soc)+'%':'Мережі немає! Економте.';
  $('#survCard').classList.toggle('alert',!S.grid);
}

// ─── Island ────────────────────────────────────────────────
function updateIsland(){
  const dot=$('#islDot');
  dot.className='isl-dot '+(S.grid?(S.batW<-5?'chg':S.batW>5?'idle':'idle'):'bad');
  $('#islW').textContent=fmt(S.load)+' Вт';
  $('#islSoc').textContent=fmt(S.soc)+'%';
  $('#iv1').textContent=S.grid?fmt(S.gridV,1)+' В':'OFF';
  $('#iv2').textContent=fmt(S.soc)+'%';
  $('#iv3').textContent=fmt(S.load)+' Вт';
  $('#sbBatt').textContent=fmt(S.soc)+'%';
}

// ─── Tiles ─────────────────────────────────────────────────
function updateTiles(){
  $('#mLoad').textContent=fmt(S.load)+' Вт';
  $('#mImport').textContent=S.importToday.toFixed(1)+' кВт·год';
  $('#mCost').textContent='₴ '+S.costToday.toFixed(1);
  $('#mTemp').textContent=fmt(S.invTemp)+'°';
  const t=$('#tToday');if(t)t.textContent='₴ '+S.costToday.toFixed(1);
}

// ─── Grid Chip ─────────────────────────────────────────────
function updateChip(){
  const c=$('#gridChip');
  if(S.grid){c.className='nv-chip';c.innerHTML=`<i class="ph-fill ph-plug-charging"></i> Мережа · ${fmt(S.gridV,1)} В`;}
  else{c.className='nv-chip bad';c.innerHTML='<i class="ph-fill ph-lightning-slash"></i> Немає мережі';}
  const inv=$('#invStatus');
  if(inv){inv.textContent=S.grid?'Онлайн':'Від батареї';inv.className=S.grid?'badge-ok':'badge-ok';inv.style.cssText=S.grid?'':'background:rgba(255,159,10,.15);color:var(--orange)';}
}

function updateAll(){updateFlow();updateBattery();updateSurvival();updateIsland();updateTiles();updateChip();}

// ─── Clock ─────────────────────────────────────────────────
function updateClock(){$('#sbTime').textContent=new Date().toLocaleTimeString('uk-UA',{hour:'numeric',minute:'2-digit'}).replace(/^0/,'');}

// ─── Devices ───────────────────────────────────────────────
let devFilter='all',devQuery='';
function livePower(d){if(!d.switch||!d.online)return 0;return d.power||0;}
function dcardHTML(d){
  const p=getDevicePriority(d);
  return`<div class="dcard ${d.switch?'on':''}" data-dev="${d.id}">
    <div class="dic" style="--c:${PRI[p].color}"><i class="ph-fill ph-plugs"></i></div>
    <div class="dinfo">
      <div class="dname">${d.name||d.id}<span class="dbadge ${d.online?'loc':'cld'}"><i class="ph-bold ph-${d.online?'wifi-high':'cloud'}"></i>${d.online?'Онлайн':'Офлайн'}</span></div>
      <div class="dsub">${fmt(livePower(d))} Вт · ${d.voltage?fmt(d.voltage,1)+' В':'—'} · ${d.current?fmt(d.current,2)+' А':'—'}</div>
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
    html+=`<div class="dgroup"><div class="dgroup-h"><span class="dg-ic" style="--c:${PRI[p].color}"><i class="ph-fill ${PRI[p].icon}"></i></span><b>${PRI[p].label}</b><span class="dg-meta">${ds.length} · ${fmt(tot)} Вт</span></div>
      <div class="dlist">${ds.map(dcardHTML).join('')}</div></div>`;
  }
  wrap.innerHTML=html||`<div class="empty">Нічого не знайдено</div>`;
  updateDevSummary();
}
function updateDevSummary(){
  const on=S.devices.filter(d=>d.switch);
  const tot=on.reduce((a,d)=>a+livePower(d),0);
  const top=[...on].sort((a,b)=>livePower(b)-livePower(a))[0];
  const sw=$('#sumW');if(sw)sw.textContent=fmt(tot)+' Вт';
  const st=$('#sumTop');if(st)st.textContent=top?`${top.name} · ${fmt(livePower(top))} Вт`:'—';
  const dc=$('#devCountChip');if(dc)dc.textContent=S.devices.length+' пристроїв';
  const sdc=$('#settingsDeviceCount');if(sdc)sdc.textContent=S.devices.length;
}
function renderQuick(){
  const el=$('#quickRow');if(!el)return;
  el.innerHTML=S.devices.slice(0,7).map(d=>{
    const p=livePower(d);
    return`<button class="qchip ${d.switch?'on':''}" data-q="${d.id}">
      <i class="ph-fill ph-plugs" style="color:${PRI[getDevicePriority(d)].color}"></i>
      <span class="qn">${(d.name||'?').split(' ')[0]}</span>
      <b class="qw">${d.switch?fmt(p)+' Вт':'off'}</b></button>`;
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
    addEvent('ph-plugs',on?'#30D158':'#FF453A',`${d?d.name:id} ${on?'увімкнено':'вимкнено'}`);
  }
}

function unloadOptional(){
  const prev=S.devices.filter(d=>getDevicePriority(d)==='optional'&&d.switch);
  if(!prev.length){banner('Все вже вимкнено','Опціональні пристрої не споживають енергію','info');return;}
  prev.forEach(d=>setDevice(d.id,false));
  renderDevices();renderQuick();
  banner(`Вимкнено ${prev.length} пристроїв`,'Автономія зросла','success');
}

function openDevice(id){
  vib(8);
  const d=S.devices.find(x=>x.id===id);if(!d)return;
  const p=livePower(d),pri=getDevicePriority(d);
  openSheet(`<div class="grab"></div>
    <div class="sh-head"><div class="dic big" style="--c:${PRI[pri].color}"><i class="ph-fill ph-plugs"></i></div>
      <div><b class="sh-title">${d.name||d.id}</b><span class="sh-sub">${d.switch?'увімкнено':'вимкнено'} · ${d.online?'онлайн':'офлайн'}</span></div>
      <label class="sw"><input type="checkbox" data-sw="${d.id}" ${d.switch?'checked':''}><span class="knob"></span></label></div>
    <div class="sh-stats">
      <div><span>Зараз</span><b>${fmt(p)} Вт</b></div>
      <div><span>Напруга</span><b>${d.voltage?fmt(d.voltage,1)+' В':'—'}</b></div>
      <div><span>Струм</span><b>${d.current?fmt(d.current,2)+' А':'—'}</b></div>
    </div>
    <div class="sh-row"><span>Протокол</span><b class="prot ${d.online?'loc':'cld'}"><i class="ph-bold ph-${d.online?'wifi-high':'cloud'}"></i> ${d.online?'Tuya Local':'Tuya Cloud'}</b></div>
    <div class="sh-lbl">Пріоритет у режимі виживання</div>
    <div class="seg" id="priSeg">${['critical','essential','optional'].map(k=>`<button data-pri="${k}" class="${pri===k?'on':''}">${PRI[k].label}</button>`).join('')}</div>
    <button class="btn wide" id="shClose" style="margin-top:18px">Готово</button>`);
  $('#shClose').onclick=closeSheet;
  $('#priSeg').onclick=e=>{
    const b=e.target.closest('button');if(!b)return;vib(8);
    setPriority(d.id,b.dataset.pri);
    $$('#priSeg button').forEach(x=>x.classList.toggle('on',x===b));
    renderDevices();renderQuick();
    banner('Пріоритет змінено',`${d.name} → ${PRI[b.dataset.pri].label}`,'success');
  };
}

// ─── Rules ─────────────────────────────────────────────────
function renderRules(){
  const el=$('#rulesList');if(!el)return;
  el.innerHTML=S.scenes.map(r=>{
    const en=r.enabled!==false;
    const cond=r.if&&r.if.conditions?r.if.conditions.map(c=>{
      if(c.type==='grid')return'Мережа відсутня';
      if(c.type==='battery')return'SOC '+c.operator+' '+c.value+'%';
      if(c.type==='time')return c.after+'–'+c.before;
      if(c.type==='weekday')return'Дні тижня';
      return c.type;
    }).join(', '):'—';
    const act=r.then&&r.then.actions?r.then.actions.map(a=>{
      if(a.type==='tuya')return'Пристрій';
      if(a.type==='notify')return'Sповіщення';
      return a.type;
    }).join(', '):'—';
    return`<div class="rcard ${en?'':'dis'} rv in">
      <div class="ric" style="--c:${en?'#0A84FF':'#8E8E93'}"><i class="ph-fill ph-flow-arrow"></i></div>
      <div class="rinfo"><div class="rname">${r.name}</div><div class="rsub">Якщо <b>${cond}</b> → ${act}</div>
      <div class="rmeta">${en?'Активно':'Вимкнено'}</div></div>
      <label class="sw"><input type="checkbox" data-rule="${r.name}" ${en?'checked':''}><span class="knob"></span></label></div>`;
  }).join('');
  const n=S.scenes.filter(r=>r.enabled!==false).length;
  const chip=$('#rulesChip');if(chip)chip.textContent=n+' активні';
}

async function toggleScene(name,en){
  vib(10);
  await api('/api/scenes/'+encodeURIComponent(name),{method:'PATCH',body:JSON.stringify({enabled:en})});
}
async function runScene(name){
  vib(15);
  const r=await api('/api/scenes/'+encodeURIComponent(name)+'/run',{method:'POST'});
  if(r&&r.success)banner('Виконано',`Правило «${name}» виконано`,'success');
  else banner('Помилка',r?.message||'Не вдалося виконати','error');
}
async function deleteScene(name){
  if(!confirm(`Видалити «${name}»?`))return;
  await api('/api/scenes/'+encodeURIComponent(name),{method:'DELETE'});
  S.scenes=S.scenes.filter(r=>r.name!==name);renderRules();
  banner('Видалено',`Правило «${name}» видалено`,'success');
}

function openAddRule(){
  openSheet(`<div class="grab"></div><b class="sh-title" style="display:block;text-align:center;margin:4px 0 14px">Нове правило</b>
    <div class="sh-lbl" style="margin-top:0">Назва</div><input class="sinput2" id="nrName" placeholder="Напр. Економія ввечері" maxlength="40">
    <div class="sh-lbl">Умова · ЯКЩО</div><select class="ssel" id="nrWhen">
      <option value="grid">Зникла мережа</option>
      <option value="soc_low">SOC батареї нижче 20%</option>
      <option value="soc_high">SOC батареї вище 80%</option>
    </select>
    <div class="sh-lbl">Дія · ТО</div><select class="ssel" id="nrThen">
      <option value="notify">Надіслати сповіщення</option>
      <option value="off_optional">Вимкнути опціональні</option>
    </select>
    <button class="btn wide" id="nrSave" style="margin-top:18px"><i class="ph-bold ph-check"></i> Створити</button>`);
  $('#nrSave').onclick=async()=>{
    const name=$('#nrName').value.trim()||'Моє правило';
    const whenVal=$('#nrWhen').value;
    const thenVal=$('#nrThen').value;
    const conditions=[];
    if(whenVal==='grid')conditions.push({type:'grid',value:false});
    else if(whenVal==='soc_low')conditions.push({type:'battery',operator:'<',value:20});
    else if(whenVal==='soc_high')conditions.push({type:'battery',operator:'>',value:80});
    const actions=[];
    if(thenVal==='notify')actions.push({type:'notify',title:name,message:'Спрацювало правило'});
    else if(thenVal==='off_optional')actions.push({type:'tuya',device:'*',value:false});
    const r=await api('/api/scenes',{method:'POST',body:JSON.stringify({name,if:{logic:'AND',conditions},then:{actions}})});
    if(r&&r.success!==false){
      S.scenes.push({name,enabled:true,if:{logic:'AND',conditions},then:{actions}});
      renderRules();closeSheet();vib(15);
      banner('Правило створено',`«${name}» активовано`,'success');
      addEvent('ph-flow-arrow','#BF5AF2',`Створено правило «${name}»`);
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
    {label:'Навантаження, Вт',data:[],borderColor:'#0A84FF',borderWidth:2,tension:.35,pointRadius:0,fill:true,yAxisID:'y',
      backgroundColor:c=>{const{ctx:cc,chartArea}=c.chart;if(!chartArea)return'rgba(10,132,255,.1)';
        const g=cc.createLinearGradient(0,chartArea.top,0,chartArea.bottom);g.addColorStop(0,'rgba(10,132,255,.32)');g.addColorStop(1,'rgba(10,132,255,0)');return g;}},
    {label:'Батарея, %',data:[],borderColor:'#30D158',borderWidth:1.6,tension:.35,pointRadius:0,fill:false,yAxisID:'y1'}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:450},interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:true,position:'top',align:'end',labels:{boxWidth:7,boxHeight:7,usePointStyle:true,pointStyle:'circle',color:'rgba(235,235,245,.6)',font:{size:10,weight:'600'}}},
        tooltip:{backgroundColor:'rgba(28,28,32,.96)',borderColor:'rgba(255,255,255,.12)',borderWidth:.5,cornerRadius:12,padding:10}},
      scales:{x:{ticks:{maxTicksLimit:6,font:{size:9.5}},grid:{display:false}},
        y:{ticks:{font:{size:9.5},callback:v=>v>=1000?(v/1000)+'к':v},grid:{color:'rgba(255,255,255,.05)'}},
        y1:{position:'right',min:0,max:100,ticks:{color:'rgba(48,209,88,.75)',font:{size:9.5},callback:v=>v+'%'},grid:{display:false}}}}});
  drawMain('day');
  const costCtx=$('#costChart');
  if(costCtx){
    const days=[...Array(7)].map((_,i)=>new Date(Date.now()-(6-i)*864e5).toLocaleDateString('uk-UA',{weekday:'short'}));
    costChart=new Chart(costCtx.getContext('2d'),{type:'bar',
      data:{labels:days,datasets:[{data:Array(7).fill(0),backgroundColor:'rgba(10,132,255,.65)',hoverBackgroundColor:'#0A84FF',borderRadius:7,maxBarThickness:26,borderSkipped:false}]},
      options:{responsive:true,maintainAspectRatio:false,animation:{duration:450},
        plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,32,.96)',borderColor:'rgba(255,255,255,.12)',borderWidth:.5,cornerRadius:12,callbacks:{label:c=>'₴'+c.raw.toFixed(2)}}},
        scales:{x:{grid:{display:false},ticks:{font:{size:10,weight:'600'}}},y:{ticks:{font:{size:9.5},callback:v=>'₴'+v},grid:{color:'rgba(255,255,255,.05)'}}}}});
  }
}

async function drawMain(period){
  if(!mainChart)return;
  const d=await api('/api/history?period='+encodeURIComponent(period));
  if(!d||!d.points||d.points.length<2)return;
  const pts=d.points;
  const labels=pts.map(p=>{const dt=new Date(p.ts);return period==='week'?dt.toLocaleDateString('uk-UA',{day:'2-digit',month:'2-digit'}):timeStr(dt);});
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
  $('#stAvg').textContent=fmt(avg)+' Вт';
  $('#stPeak').textContent=fmt(peak)+' Вт';
  $('#stKwh').textContent=kwh.toFixed(1)+' кВт·г';
  $('#stCost').textContent='₴'+(kwh*rate).toFixed(1);
}

// ─── Events from notifications ─────────────────────────────
async function pollNotifications(){
  const d=await api('/api/logs');
  // Logs are text, not structured events. We'll use status changes instead.
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
}

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
  $('#dateNote').textContent=new Date().toLocaleDateString('uk-UA',{weekday:'long',day:'numeric',month:'long'});
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
  setInterval(()=>{$('#updNote').textContent='ОНОВЛЕНО '+timeStr();},5000);

  addEvent('ph-lightning','#30D158','Система запущено · все штатно');
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
$('#btnTestNotif')?.addEventListener('click',async()=>{
  const r=await api('/api/test-notification',{method:'POST'});
  if(r)banner('Тест',r.results?r.results.join(', '):'Надіслано','success');
});
$('#btnScan')?.addEventListener('click',async e=>{
  const t=e.currentTarget.querySelector('.act-lb');
  if(t)t.innerHTML='<span class="spin"></span>Пошук…';
  banner('Сканування','Ініційовано пошук інвертора…','info');
});
$('#btnBackup')?.addEventListener('click',async()=>{
  const r=await api('/api/backup',{method:'POST',body:JSON.stringify({scope:['config','scenes','history']})});
  if(r&&r.backup){
    const blob=new Blob([JSON.stringify(r.backup,null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='strum-backup.json';a.click();
    banner('Резервна копія','Завантажено','success');
  }
});
$('#btnRestart')?.addEventListener('click',async()=>{
  if(!confirm('Перезапустити сервіс?'))return;
  await api('/api/restart',{method:'POST'});
  banner('Перезапуск','Сервіс перезапускається…','info');
  setTimeout(()=>window.location.reload(),5000);
});
$('#btnLogout')?.addEventListener('click',async()=>{
  await api('/api/logout',{method:'POST'});
  window.location.href='/login';
});
$('#tDay')?.addEventListener('input',e=>{const v=parseFloat(e.target.value);if(!isNaN(v))S.tariff.day=v;});
$('#tNight')?.addEventListener('input',e=>{const v=parseFloat(e.target.value);if(!isNaN(v))S.tariff.night=v;});

document.addEventListener('DOMContentLoaded',init);
