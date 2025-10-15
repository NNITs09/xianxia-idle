const VERSION = '1.0.0';
const SAVE_KEY = 'xianxiaIdleSaveV1';

const realms = [
  { id:'qi_refining', name:'Qi Refining' },
  { id:'foundation_establishment', name:'Foundation Establishment' },
  { id:'golden_core', name:'Golden Core' },
  { id:'nascent_soul', name:'Nascent Soul' },
  { id:'spirit_transformation', name:'Spirit Transformation' },
];

function stageRequirement(realmIndex, stage){
  const realmBase = 100 * Math.pow(25, realmIndex);
  const stageScale = Math.pow(1.65, stage-1);
  return Math.floor(realmBase * stageScale);
}

function fmt(n){
  if(!isFinite(n)) return '∞';
  if(n < 1000) return n.toLocaleString('es-AR');
  const units = ['K','M','B','T','Qa','Qi','Sx','Sp','Oc','No'];
  let u = -1;
  while(n >= 1000 && u < units.length-1){ n/=1000; u++; }
  return n.toFixed(2).replace(/\.00$/, '') + ' ' + units[u];
}

function now(){ return Date.now(); }

const defaultState = () => ({
  version: VERSION,
  qi: 0,
  qpcBase: 1,
  qpsBase: 0,
  qpcMult: 1,
  qpsMult: 1,
  offlineMult: 1,
  realmIndex: 0,
  stage: 1,
  lastTick: now(),
  lastSave: null,
  skills: {}
});

const skillCatalog = [
  { id:'breath_control', name:'Breathing Control', desc:'+0.5 Qi/s', type:'qps', base:0.5, cost: 25, costScale: 1.25 },
  { id:'meridian_flow', name:'Meridian Flow', desc:'+1 Qi/click', type:'qpc', base:1, cost: 50, costScale: 1.27 },
  { id:'lotus_meditation', name:'Lotus Meditation', desc:'+15% Qi/s', type:'qps_mult', base:0.15, cost: 150, costScale: 1.35 },
  { id:'dantian_temps', name:'Dantian Expansion', desc:'+10% Qi/click', type:'qpc_mult', base:0.10, cost: 120, costScale: 1.33 },
  { id:'closed_door', name:'Closed Door Cultivation', desc:'Qi offline + 20%', type:'offline_mult', base:0.20, cost: 200, costScale: 1.4 },
];

let S = load() || defaultState();

function totalQPC(){
  let val = S.qpcBase;
  const qpcAdd = (S.skills['meridian_flow']||0) * getSkill('meridian_flow').base;
  val += qpcAdd;
  const qpcMult = 1 + (S.skills['dantian_temps']||0) * getSkill('dantian_temps').base;
  return val * qpcMult * S.qpcMult;
}

function totalQPS(){
  let val = S.qpsBase;
  val += (S.skills['breath_control']||0) * getSkill('breath_control').base;
  const mult = 1 + (S.skills['lotus_meditation']||0) * getSkill('lotus_meditation').base;
  return val * mult * S.qpsMult;
}

function totalOfflineMult(){
  return 1 + (S.skills['closed_door']||0) * getSkill('closed_door').base;
}

function getSkill(id){ return skillCatalog.find(s=>s.id===id); }

function skillCost(id){
  const sk = getSkill(id); const lvl = S.skills[id]||0;
  return Math.floor(sk.cost * Math.pow(sk.costScale, lvl));
}

function canBreakthrough(){
  const req = stageRequirement(S.realmIndex, S.stage);
  return S.qi >= req;
}

function doBreakthrough(){
  const req = stageRequirement(S.realmIndex, S.stage);
  if(S.qi < req) return;
  S.qi -= req;
  if(S.stage < 10){
    S.stage++;
  } else {
    if(S.realmIndex < realms.length-1){
      S.realmIndex++; S.stage = 1;
      S.qpcBase += 1; S.qpsBase += 0.5;
    } else {
      alert('You have reached Spirit Transformation, Stage 10! (End of DEMO)');
    }
  }
}

function tick(dt){
  const gain = totalQPS() * dt;
  S.qi += gain;
}

function onClick(){
  S.qi += totalQPC();
  flashNumber('+'+fmt(totalQPC()));
}

// Reemplazá tu flashNumber por este para posicionar cerca de la imagen
function flashNumber(text){
  const host = document.getElementById('clickBtn');
  const r = host.getBoundingClientRect();
  const el = document.createElement('div');
  el.textContent = text;
  el.style.position = 'fixed';
  el.style.left = (r.left + r.width/2 + (Math.random()*30-15)) + 'px';
  el.style.top  = (r.top  + r.height*0.35 + (Math.random()*20-10)) + 'px';
  el.style.transform = 'translate(-50%, -50%)';
  el.style.pointerEvents='none';
  el.style.fontWeight='800';
  el.style.opacity='1';
  el.style.transition='transform .8s ease, opacity .8s ease';
  document.body.appendChild(el);
  requestAnimationFrame(()=>{
    el.style.transform='translate(-50%, -90%)';
    el.style.opacity='0';
  });
  setTimeout(()=>el.remove(),850);

  // ping del halo
  host.classList.remove('ping');
  void host.offsetWidth; // reflow para reiniciar animación
  host.classList.add('ping');
}

// (Opcional pero recomendado) permitir activar con Enter/Espacio
const cultivatorEl = document.getElementById('clickBtn');
cultivatorEl.addEventListener('keydown', (e)=>{
  if(e.key === 'Enter' || e.key === ' '){
    e.preventDefault();
    onClick();
  }
});


function save(){
  S.version = VERSION;
  S.lastSave = now();
  localStorage.setItem(SAVE_KEY, JSON.stringify(S));
  updateLastSave();
}

function load(){
  try{
    const raw = localStorage.getItem(SAVE_KEY);
    if(!raw) return null;
    const data = JSON.parse(raw);
    if(!data.version) data.version = '0.0.0';
    return data;
  }catch(e){ console.error('Error loading', e); return null; }
}

function reset(){
  if(!confirm('Are you sure you want to reset your progress?')) return;
  S = defaultState();
  save();
  renderAll();
}

function exportSave(){
  const json = JSON.stringify(S);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  ioArea.value = b64;
}

function importSave(){
  try{
    const b64 = ioArea.value.trim();
    const json = decodeURIComponent(escape(atob(b64)));
    const data = JSON.parse(json);
    S = { ...defaultState(), ...data };
    save();
    renderAll();
    alert('Saved imported successfully');
  }catch(e){
    alert('Error importing saved code, Make sure you paste the entire code');
  }
}

function applyOfflineGains(){
  if(!S.lastSave) return;
  const elapsedMs = now() - S.lastSave;
  const elapsedSec = Math.max(0, Math.floor(elapsedMs/1000));
  const capped = Math.min(elapsedSec, 12*3600);
  const gains = totalQPS() * capped * totalOfflineMult();
  if (gains > 0){
    S.qi += gains;
    const hrs = (capped/3600).toFixed(2);
    setTimeout(()=>{
      alert(`Offline earnings in ${hrs} h: +${fmt(Math.floor(gains))} Qi (x${totalOfflineMult().toFixed(2)})`);
    }, 100);
  }
}

const qiDisplay = document.getElementById('qiDisplay');
const qpcEl = document.getElementById('qpc');
const qpsEl = document.getElementById('qps');
const offlineMultEl = document.getElementById('offlineMult');
const realmNameEl = document.getElementById('realmName');
const realmStageEl = document.getElementById('realmStage');
const realmProgEl = document.getElementById('realmProg');
const realmReqTextEl = document.getElementById('realmReqText');
const breakthroughBtn = document.getElementById('breakthroughBtn');
const saveBtn = document.getElementById('saveBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const resetBtn = document.getElementById('resetBtn');
const clickBtn = document.getElementById('clickBtn');
const shopEl = document.getElementById('shop');
const ioArea = document.getElementById('ioArea');
const verEl = document.getElementById('ver');
const lastSaveEl = document.getElementById('lastSave');

function updateLastSave(){
  if(!S.lastSave){ lastSaveEl.textContent = 'Last Save: —'; return; }
  const d = new Date(S.lastSave);
  lastSaveEl.textContent = 'Last Save: ' + d.toLocaleString();
}

function renderStats(){
  qiDisplay.textContent = 'Qi: ' + fmt(Math.floor(S.qi));
  qpcEl.textContent = fmt(totalQPC());
  qpsEl.textContent = fmt(totalQPS());
  offlineMultEl.textContent = totalOfflineMult().toFixed(2) + '×';
}

function renderRealm(){
  const r = realms[S.realmIndex];
  realmNameEl.textContent = r.name;
  realmStageEl.textContent = S.stage + ' / 10';
  const req = stageRequirement(S.realmIndex, S.stage);
  const pct = Math.max(0, Math.min(100, (S.qi / req) * 100));
  realmProgEl.style.width = pct + '%';
  realmReqTextEl.textContent = `Requirement to advance: ${fmt(req)} Qi`;
  breakthroughBtn.disabled = !canBreakthrough();
}

function renderShop(){
  shopEl.innerHTML = '';
  for(const sk of skillCatalog){
    const lvl = S.skills[sk.id]||0;
    const cost = skillCost(sk.id);
    const can = S.qi >= cost;
    const wrap = document.createElement('div');
    wrap.className = 'shop-item';
    wrap.innerHTML = `
      <div>
        <h4>${sk.name} <span class="muted">(Level ${lvl})</span></h4>
        <div class="desc">${sk.desc}</div>
        <div class="small muted">Cost: ${fmt(cost)} Qi</div>
      </div>
      <div>
        <button class="btn ${can?'primary':''}" ${can?'':'disabled'} data-skill="${sk.id}">Buy</button>
      </div>`;
    shopEl.appendChild(wrap);
  }
  shopEl.querySelectorAll('button[data-skill]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-skill');
      const cost = skillCost(id);
      if(S.qi < cost) return;
      S.qi -= cost;
      S.skills[id] = (S.skills[id]||0) + 1;
      save();
      renderAll();
    });
  });
}

function renderAll(){
  verEl.textContent = VERSION;
  renderStats();
  renderRealm();
  renderShop();
  updateLastSave();
}

let last = now();
function loop(){
  const t = now();
  const dt = (t - last)/1000;
  last = t;
  tick(dt);
  renderStats();
  renderRealm();
  requestAnimationFrame(loop);
  updateShopButtons();
}

clickBtn.addEventListener('click', onClick);
breakthroughBtn.addEventListener('click', ()=>{ doBreakthrough(); save(); renderAll(); });
saveBtn.addEventListener('click', save);
exportBtn.addEventListener('click', exportSave);
importBtn.addEventListener('click', importSave);
resetBtn.addEventListener('click', reset);
document.addEventListener('keydown', (e)=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){ e.preventDefault(); save(); }
});

(function init(){
  S = { ...defaultState(), ...S, skills: { ...defaultState().skills, ...S.skills } };
  renderAll();
  applyOfflineGains();
  loop();
  setInterval(save, 15000);
})();

function updateShopButtons(){
  document.querySelectorAll('#shop button[data-skill]').forEach(btn=>{
    const id = btn.getAttribute('data-skill');
    const cost = skillCost(id);
    const can = S.qi >= cost;
    btn.disabled = !can;
    btn.classList.toggle('primary', can);
  });
}
