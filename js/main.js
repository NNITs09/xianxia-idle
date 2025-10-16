const VERSION = '1.0.1';
const SAVE_KEY = 'xianxiaIdleSaveV1';
const REALM_SKILL_BONUS = 0.12; // +12% per realm

// Balance configuration - loaded from balance.json or fallback to defaults
// BALANCE TWEAKS APPLIED: 
// - stageRequirement.stageScale reduced from 1.65 to 1.55 to ease late-game pacing
// - realmAdvanceReward increased from 1/0.5 to 1.5/0.75 for better progression feel
let BAL = {
  skills: {
    breath_control:   { base: 0.5,  cost: 25,  costScale: 1.25 },
    meridian_flow:    { base: 1,    cost: 50,  costScale: 1.27 },
    lotus_meditation: { base: 0.15, cost: 150, costScale: 1.35 },
    dantian_temps:    { base: 0.10, cost: 120, costScale: 1.33 },
    closed_door:      { base: 0.20, cost: 200, costScale: 1.40 }
  },
  stageRequirement: {
    realmBase: 100,
    realmBaseScale: 25,
    stageScale: 1.65 // fallback value, will be overridden by balance.json (1.55)
  },
  progression: {
    qpcBaseStart: 1,
    qpsBaseStart: 0,
    realmAdvanceReward: { qpcBaseAdd: 1, qpsBaseAdd: 0.5 } // fallback values, will be overridden by balance.json (1.5/0.75)
  },
  reincarnation: {
    karmaPerUnit: 0.05,
    lifetimeQiDivisor: 1000,
    realmKarmaFactor: 2,
    minKarma: 1
  },
  offline: {
    capHours: 12
  }
};

// Load balance configuration from JSON
async function loadBalance() {
  try {
    const response = await fetch('balance.json');
    if (response.ok) {
      const balanceData = await response.json();
      BAL = { ...BAL, ...balanceData };
      console.log('Balance configuration loaded from balance.json');
    }
  } catch (error) {
    console.log('Using default balance values (balance.json not found or invalid)');
  }
}

const realms = [
  { id:'qi_refining', name:'Qi Refining' },
  { id:'foundation_establishment', name:'Foundation Establishment' },
  { id:'golden_core', name:'Golden Core' },
  { id:'nascent_soul', name:'Nascent Soul' },
  { id:'spirit_transformation', name:'Spirit Transformation' },
];

function stageRequirement(realmIndex, stage){
  const realmBase = BAL.stageRequirement.realmBase * Math.pow(BAL.stageRequirement.realmBaseScale, realmIndex);
  const stageScale = Math.pow(BAL.stageRequirement.stageScale, stage-1);
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
  qpcBase: BAL.progression.qpcBaseStart,
  qpsBase: BAL.progression.qpsBaseStart,
  qpcMult: 1,
  qpsMult: 1,
  offlineMult: 1,
  realmIndex: 0,
  stage: 1,
  lastTick: now(),
  lastSave: null,
  skills: {},
  reinc: { times: 0, karma: 0, lifetimeQi: 0 }
});

// Dynamic skill catalog based on BAL configuration
function getSkillCatalog() {
  return [
    { id:'breath_control', name:'Breathing Control', desc:'+0.5 Qi/s', type:'qps', 
      base: BAL.skills.breath_control.base, cost: BAL.skills.breath_control.cost, costScale: BAL.skills.breath_control.costScale },
    { id:'meridian_flow', name:'Meridian Flow', desc:'+1 Qi/click', type:'qpc', 
      base: BAL.skills.meridian_flow.base, cost: BAL.skills.meridian_flow.cost, costScale: BAL.skills.meridian_flow.costScale },
    { id:'lotus_meditation', name:'Lotus Meditation', desc:'+15% Qi/s', type:'qps_mult', 
      base: BAL.skills.lotus_meditation.base, cost: BAL.skills.lotus_meditation.cost, costScale: BAL.skills.lotus_meditation.costScale },
    { id:'dantian_temps', name:'Dantian Expansion', desc:'+10% Qi/click', type:'qpc_mult', 
      base: BAL.skills.dantian_temps.base, cost: BAL.skills.dantian_temps.cost, costScale: BAL.skills.dantian_temps.costScale },
    { id:'closed_door', name:'Closed Door Cultivation', desc:'Qi offline + 20%', type:'offline_mult', 
      base: BAL.skills.closed_door.base, cost: BAL.skills.closed_door.cost, costScale: BAL.skills.closed_door.costScale },
  ];
}

let S = load() || defaultState();

function totalQPC(){
  let val = S.qpcBase;
  const qpcAdd = (S.skills['meridian_flow']||0) * baseEff('meridian_flow');
  val += qpcAdd;
  const qpcMult = 1 + (S.skills['dantian_temps']||0) * baseEff('dantian_temps');
  return val * qpcMult * S.qpcMult * reincBonus();
}

function totalQPS(){
  let val = S.qpsBase;
  val += (S.skills['breath_control']||0) * baseEff('breath_control');
  const mult = 1 + (S.skills['lotus_meditation']||0) * baseEff('lotus_meditation');
  return val * mult * S.qpsMult * reincBonus();
}

function totalOfflineMult(){
  return 1 + (S.skills['closed_door']||0) * baseEff('closed_door');
}

function getSkill(id){ return getSkillCatalog().find(s=>s.id===id); }

function skillCost(id){
  const sk = getSkill(id); const lvl = S.skills[id]||0;
  return Math.floor(sk.cost * Math.pow(sk.costScale, lvl));
}

// Skill power multiplier based on current realm
function skillPowerMult(){
  return 1 + (S.realmIndex * REALM_SKILL_BONUS);
}

// Get skill base effectiveness with realm bonus applied
function baseEff(id){
  return getSkill(id).base * skillPowerMult();
}

// Reincarnation bonus calculation
function reincBonus(){
  return 1 + (S.reinc.karma * BAL.reincarnation.karmaPerUnit);
}

// Check if player can reincarnate (Golden Core stage 10 or higher)
function canReincarnate(){
  return (S.realmIndex > 2) || (S.realmIndex === 2 && S.stage === 10);
}

// Calculate karma gain from reincarnation
function computeKarmaGain(){
  const base = Math.floor(Math.sqrt(S.reinc.lifetimeQi / BAL.reincarnation.lifetimeQiDivisor));
  const realmBonus = S.realmIndex * BAL.reincarnation.realmKarmaFactor;
  return Math.max(BAL.reincarnation.minKarma, base + realmBonus);
}

// Perform reincarnation
function doReincarnate(){
  if(!canReincarnate()) return;
  
  const gain = computeKarmaGain();
  S.reinc.karma += gain;
  S.reinc.times += 1;
  
  // Preserve reinc object but reset the rest of the progression
  const oldReinc = { ...S.reinc };
  S = defaultState();
  S.reinc = { times: oldReinc.times, karma: oldReinc.karma, lifetimeQi: 0 };
  
  save();
  renderAll();
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
      S.qpcBase += BAL.progression.realmAdvanceReward.qpcBaseAdd; 
      S.qpsBase += BAL.progression.realmAdvanceReward.qpsBaseAdd;
    } else {
      alert('You have reached Spirit Transformation, Stage 10! (End of DEMO)');
    }
  }
}

function tick(dt){
  const gain = totalQPS() * dt;
  S.qi += gain;
  S.reinc.lifetimeQi += gain;
}

function onClick(){
  const gain = totalQPC();
  S.qi += gain;
  S.reinc.lifetimeQi += gain;
  flashNumber('+'+fmt(gain));
  
  // Blue halo pulse effect
  const host = document.getElementById('clickBtn');
  host.classList.remove('pulse');
  void host.offsetWidth; // reflow to restart animation
  host.classList.add('pulse');
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
    // Migrate old saves: ensure reinc exists (backward compatibility)
    if(!data.reinc) data.reinc = { times: 0, karma: 0, lifetimeQi: 0 };
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
  const capped = Math.min(elapsedSec, BAL.offline.capHours * 3600);
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
const karmaValEl = document.getElementById('karmaVal');
const reincBonusEl = document.getElementById('reincBonus');
const reincTimesEl = document.getElementById('reincTimes');
const reincBtn = document.getElementById('reincBtn');
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
  if(karmaValEl) karmaValEl.textContent = S.reinc.karma;
  if(reincBonusEl) reincBonusEl.textContent = reincBonus().toFixed(2) + '×';
  if(reincTimesEl) reincTimesEl.textContent = S.reinc.times;
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
  if(reincBtn) reincBtn.disabled = !canReincarnate();
}

function renderShop(){
  shopEl.innerHTML = '';
  const realmBonus = skillPowerMult();
  const realmBonusText = realmBonus > 1 ? `<div class="small muted">Realm Bonus: +${((realmBonus-1)*100).toFixed(0)}% power</div>` : '';
  
  for(const sk of getSkillCatalog()){
    const lvl = S.skills[sk.id]||0;
    const cost = skillCost(sk.id);
    const can = S.qi >= cost;
    const wrap = document.createElement('div');
    wrap.className = 'shop-item';
    wrap.innerHTML = `
      <div>
        <img src="assets/${sk.id}.png" alt="${sk.name}" class="skill-icon">
        <div>
          <h4>${sk.name} <span class="muted">(Level ${lvl})</span></h4>
          <div class="desc">${sk.desc}</div>
          <div class="small muted">Cost: ${fmt(cost)} Qi</div>
          ${realmBonusText}
        </div>
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
// Touch responsiveness for mobile (no ~300ms delay)
clickBtn.addEventListener('touchstart', (e)=>{ e.preventDefault(); onClick(); }, {passive:false});
breakthroughBtn.addEventListener('click', ()=>{ doBreakthrough(); save(); renderAll(); });
if(reincBtn){
  reincBtn.addEventListener('click', ()=>{
    if(!canReincarnate()) return;
    if(confirm(`Reincarnate and gain ${computeKarmaGain()} karma? This will reset your progress for a permanent bonus.`)){
      doReincarnate();
    }
  });
}
saveBtn.addEventListener('click', save);
exportBtn.addEventListener('click', exportSave);
importBtn.addEventListener('click', importSave);
resetBtn.addEventListener('click', reset);
document.addEventListener('keydown', (e)=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){ e.preventDefault(); save(); }
});

(async function init(){
  await loadBalance(); // Load balance configuration first
  S = { ...defaultState(), ...S, skills: { ...defaultState().skills, ...S.skills } };
  renderAll();
  applyOfflineGains();
  loop();
  setInterval(save, 15000);
  initDebugPanel(); // Initialize debug panel if in dev mode
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

// ============= SIMULATION & DEBUG SYSTEM =============

function simulateProgress({seconds = 3600, clickRate = 3, buyStrategy = "greedy_qps"} = {}) {
  // Create simulation state (copy of defaultState with current BAL values)
  let simS = {
    ...defaultState(),
    qi: 0,
    qpcBase: BAL.progression.qpcBaseStart,
    qpsBase: BAL.progression.qpsBaseStart,
    qpcMult: 1,
    qpsMult: 1,
    offlineMult: 1,
    realmIndex: 0,
    stage: 1,
    skills: {},
    reinc: { times: 0, karma: 0, lifetimeQi: 0 }
  };
  
  let totalQi = 0;
  let stagesReached = 0;
  let purchases = {};
  let timePerStage = [];
  let currentTime = 0;
  
  // Simulation helper functions using simS instead of S
  const simTotalQPC = () => {
    let val = simS.qpcBase;
    const qpcAdd = (simS.skills['meridian_flow']||0) * BAL.skills.meridian_flow.base * (1 + (simS.realmIndex * REALM_SKILL_BONUS));
    val += qpcAdd;
    const qpcMult = 1 + (simS.skills['dantian_temps']||0) * BAL.skills.dantian_temps.base * (1 + (simS.realmIndex * REALM_SKILL_BONUS));
    return val * qpcMult * simS.qpcMult * (1 + (simS.reinc.karma * BAL.reincarnation.karmaPerUnit));
  };
  
  const simTotalQPS = () => {
    let val = simS.qpsBase;
    val += (simS.skills['breath_control']||0) * BAL.skills.breath_control.base * (1 + (simS.realmIndex * REALM_SKILL_BONUS));
    const mult = 1 + (simS.skills['lotus_meditation']||0) * BAL.skills.lotus_meditation.base * (1 + (simS.realmIndex * REALM_SKILL_BONUS));
    return val * mult * simS.qpsMult * (1 + (simS.reinc.karma * BAL.reincarnation.karmaPerUnit));
  };
  
  const simSkillCost = (id) => {
    const skill = BAL.skills[id];
    const lvl = simS.skills[id] || 0;
    return Math.floor(skill.cost * Math.pow(skill.costScale, lvl));
  };
  
  // Simulation loop
  let dt = 1; // 1 second steps
  for (let time = 0; time < seconds; time += dt) {
    currentTime = time;
    
    // Generate Qi (QPS + clicks)
    const qpsGain = simTotalQPS() * dt;
    const clickGain = simTotalQPC() * clickRate * dt;
    const totalGain = qpsGain + clickGain;
    
    simS.qi += totalGain;
    totalQi += totalGain;
    
    // Check for stage advancement
    const req = stageRequirement(simS.realmIndex, simS.stage);
    if (simS.qi >= req) {
      simS.qi -= req;
      timePerStage.push(time);
      stagesReached++;
      
      if (simS.stage < 10) {
        simS.stage++;
      } else if (simS.realmIndex < realms.length - 1) {
        simS.realmIndex++;
        simS.stage = 1;
        simS.qpcBase += BAL.progression.realmAdvanceReward.qpcBaseAdd;
        simS.qpsBase += BAL.progression.realmAdvanceReward.qpsBaseAdd;
      }
    }
    
    // Buy strategy
    if (buyStrategy === "greedy_qps") {
      // Prioritize QPS skills first, then QPC
      const skillPriority = ['breath_control', 'lotus_meditation', 'meridian_flow', 'dantian_temps', 'closed_door'];
      
      for (const skillId of skillPriority) {
        const cost = simSkillCost(skillId);
        if (simS.qi >= cost) {
          simS.qi -= cost;
          simS.skills[skillId] = (simS.skills[skillId] || 0) + 1;
          purchases[skillId] = (purchases[skillId] || 0) + 1;
          break; // Only buy one skill per second
        }
      }
    }
  }
  
  const estimatedKarma = Math.max(BAL.reincarnation.minKarma, 
    Math.floor(Math.sqrt(totalQi / BAL.reincarnation.lifetimeQiDivisor)) + 
    (simS.realmIndex * BAL.reincarnation.realmKarmaFactor));
  
  return {
    totalQi,
    stagesReached,
    purchases,
    qpc: simTotalQPC(),
    qps: simTotalQPS(),
    timePerStage,
    estimatedKarma,
    finalRealm: simS.realmIndex,
    finalStage: simS.stage
  };
}

function applyRecommendedTweaks(originalBAL) {
  const tweaked = JSON.parse(JSON.stringify(originalBAL));
  
  // Example tweaks based on simulation results
  tweaked.stageRequirement.stageScale *= 0.95; // 5% easier progression
  tweaked.skills.breath_control.costScale *= 0.98; // Slightly cheaper scaling
  tweaked.skills.meridian_flow.costScale *= 0.98;
  
  return tweaked;
}

function runSimulationReport() {
  console.log("=== XIANXIA IDLE SIMULATION REPORT ===");
  console.log("Balance Values:", BAL);
  
  // Run 1-hour simulation
  const sim1h = simulateProgress({seconds: 3600, clickRate: 3, buyStrategy: "greedy_qps"});
  console.log("\n--- 1 HOUR SIMULATION ---");
  console.log(`Stages reached: ${sim1h.stagesReached}`);
  console.log(`Final realm: ${realms[sim1h.finalRealm]?.name || 'Unknown'} (${sim1h.finalStage}/10)`);
  console.log(`Total Qi generated: ${fmt(sim1h.totalQi)}`);
  console.log(`Final QPC: ${fmt(sim1h.qpc)}, QPS: ${fmt(sim1h.qps)}`);
  console.log(`Estimated karma if reincarnating: ${sim1h.estimatedKarma}`);
  console.log("Skill purchases:", sim1h.purchases);
  
  // Run 3-hour simulation
  const sim3h = simulateProgress({seconds: 10800, clickRate: 3, buyStrategy: "greedy_qps"});
  console.log("\n--- 3 HOUR SIMULATION ---");
  console.log(`Stages reached: ${sim3h.stagesReached}`);
  console.log(`Final realm: ${realms[sim3h.finalRealm]?.name || 'Unknown'} (${sim3h.finalStage}/10)`);
  console.log(`Total Qi generated: ${fmt(sim3h.totalQi)}`);
  console.log(`Final QPC: ${fmt(sim3h.qpc)}, QPS: ${fmt(sim3h.qps)}`);
  console.log(`Estimated karma if reincarnating: ${sim3h.estimatedKarma}`);
  console.log("Skill purchases:", sim3h.purchases);
  
  // Analyze pacing
  const qiRefiningTime = sim1h.timePerStage[9]; // Time to complete Qi Refining (stage 10)
  const foundationReached = sim1h.finalRealm >= 1;
  
  console.log("\n--- PACING ANALYSIS ---");
  console.log(`Time to complete Qi Refining: ${qiRefiningTime ? (qiRefiningTime/60).toFixed(1) + ' minutes' : 'Not reached in 1h'}`);
  console.log(`Foundation Establishment reached in 1h: ${foundationReached ? 'YES' : 'NO'}`);
  
  // Recommendations
  if (qiRefiningTime && qiRefiningTime > 1800) { // If taking more than 30 minutes
    console.log("\n--- RECOMMENDED TWEAKS ---");
    console.log("Progression seems slow. Consider:");
    console.log("- Reducing stageRequirement.stageScale from", BAL.stageRequirement.stageScale, "to", (BAL.stageRequirement.stageScale * 0.9).toFixed(3));
    console.log("- Reducing skill cost scaling by ~2%");
    
    const tweakedBAL = applyRecommendedTweaks(BAL);
    console.log("Tweaked balance:", tweakedBAL);
  } else if (qiRefiningTime && qiRefiningTime < 600) { // If taking less than 10 minutes
    console.log("\n--- RECOMMENDED TWEAKS ---");
    console.log("Progression seems too fast. Consider:");
    console.log("- Increasing stageRequirement.stageScale from", BAL.stageRequirement.stageScale, "to", (BAL.stageRequirement.stageScale * 1.1).toFixed(3));
  } else {
    console.log("\n--- BALANCE STATUS ---");
    console.log("Pacing seems reasonable!");
  }
}

function initDebugPanel() {
  // Only show debug panel if ?dev=1 is in URL
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('dev') !== '1') return;
  
  const debugPanel = document.createElement('div');
  debugPanel.id = 'devDebugPanel';
  debugPanel.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: rgba(18, 25, 35, 0.85);
    border: 1px solid #2a3748;
    border-radius: 8px;
    padding: 10px;
    font-size: 12px;
    color: #e6edf3;
    z-index: 1000;
    max-width: 280px;
    opacity: 0.8;
  `;
  
  debugPanel.innerHTML = `
    <h4 style="margin: 0 0 8px 0; color: #7ee787;">Dev Tools</h4>
    <button id="runSim6hBtn" style="margin: 2px; padding: 4px 8px; background: #0f1a13; border: 1px solid #35533d; color: #7ee787; cursor: pointer; border-radius: 4px; font-size: 11px;">
      Run Sim (6h)
    </button>
    <button id="runEstimateBtn" style="margin: 2px; padding: 4px 8px; background: #120f1a; border: 1px solid #3a3553; color: #a18aff; cursor: pointer; border-radius: 4px; font-size: 11px;">
      Run Estimate Set
    </button>
    <div id="devResult" style="margin-top: 6px; font-size: 10px; color: #9fb0c3; min-height: 14px;"></div>
  `;
  
  document.body.appendChild(debugPanel);
  
  // Run 6h simulation button
  document.getElementById('runSim6hBtn').addEventListener('click', () => {
    try {
      const result = simulateCompletion({seconds: 6*3600, clickRate: 3});
      const summary = `${result.finished ? 'Finished' : 'Not finished'} at ${result.finalRealm} ${result.finalStage}/10 (${(result.timeSec/3600).toFixed(1)}h)`;
      document.getElementById('devResult').textContent = summary;
      console.log('6h Simulation Result:', result);
    } catch (error) {
      console.error('Simulation error:', error);
      document.getElementById('devResult').textContent = 'Error - check console';
    }
  });
  
  // Run estimate set button
  document.getElementById('runEstimateBtn').addEventListener('click', () => {
    try {
      runCompletionEstimate();
      document.getElementById('devResult').textContent = 'See console for full estimate results';
    } catch (error) {
      console.error('Estimate error:', error);
      document.getElementById('devResult').textContent = 'Error - check console';
    }
  });
}
// =====================
// Simulador de tiempo a "completarse" (sin reencarnar)
// =====================

// Helpers puros que operan sobre un "estado" pasado por parámetro (no mutan S real)
function totalQPC_for(st){
  let val = st.qpcBase;
  val += (st.skills['meridian_flow']||0) * baseEff('meridian_flow');
  const mult = 1 + (st.skills['dantian_temps']||0) * baseEff('dantian_temps');
  const reinc = 1; // sin reencarnación en la simulación
  return val * mult * st.qpcMult * reinc;
}

function totalQPS_for(st){
  let val = st.qpsBase;
  val += (st.skills['breath_control']||0) * baseEff('breath_control');
  const mult = 1 + (st.skills['lotus_meditation']||0) * baseEff('lotus_meditation');
  const reinc = 1; // sin reencarnación en la simulación
  return val * mult * st.qpsMult * reinc;
}

function skillCostFor(st, id){
  const sk = getSkill(id); const lvl = st.skills[id]||0;
  return Math.floor(sk.cost * Math.pow(sk.costScale, lvl));
}

function cloneStateForSim(){
  const st = defaultState();
  // importante: copiar también skills
  st.skills = { ...defaultState().skills };
  return st;
}

// Estrategia de compra: valora cuánto sube la producción por costo
function bestPurchase(st, clickRate){
  const candidates = [
    { id:'breath_control', kind:'qps_add' },
    { id:'lotus_meditation', kind:'qps_mult' },
    { id:'meridian_flow', kind:'qpc_add' },
    { id:'dantian_temps', kind:'qpc_mult' },
    // Nota: ignoramos "closed_door" en la simulación (afecta offline).
  ];
  const qps0 = totalQPS_for(st);
  const qpc0 = totalQPC_for(st);
  const eff0 = qps0 + qpc0 * clickRate; // producción efectiva por segundo

  let best = null;

  for(const c of candidates){
    const cost = skillCostFor(st, c.id);
    if(st.qi < cost) continue;

    // simular +1 nivel
    const st2 = JSON.parse(JSON.stringify(st));
    st2.skills[c.id] = (st2.skills[c.id]||0) + 1;
    const qps1 = totalQPS_for(st2);
    const qpc1 = totalQPC_for(st2);
    const eff1 = qps1 + qpc1 * clickRate;

    const delta = eff1 - eff0;          // ganancia de producción por segundo
    const valuePerCost = delta / cost;  // eficiencia

    if(!best || valuePerCost > best.vpc){
      best = { id: c.id, cost, delta, vpc: valuePerCost };
    }
  }

  return best; // o null si no alcanza para nada
}

/**
 * Simula progreso hasta completar Spirit Transformation 10 o hasta "seconds" de tiempo.
 * @param {object} opt
 *  - seconds: duración máxima (por defecto 8h)
 *  - clickRate: clicks por segundo (ej: 3)
 *  - dt: tamaño de paso en segundos (ej: 0.1)
 *  - buyEvery: cada cuántos segundos intentar comprar (ej: 0.25)
 * @returns {object} { finished, timeSec, finalRealm, finalStage, purchases, summary }
 */
function simulateCompletion(opt={}){
  const seconds  = opt.seconds  ?? 8*3600;
  const clickRate= opt.clickRate?? 3;
  const dt       = opt.dt       ?? 0.1;
  const buyEvery = opt.buyEvery ?? 0.25;

  const st = cloneStateForSim();
  let t = 0, accBuy = 0;
  let purchases = { breath_control:0, lotus_meditation:0, meridian_flow:0, dantian_temps:0 };

  function breakthroughIfPossible(){
    const req = stageRequirement(st.realmIndex, st.stage);
    if(st.qi >= req){
      st.qi -= req;
      if(st.stage < 10){
        st.stage++;
      } else {
        if(st.realmIndex < realms.length-1){
          st.realmIndex++; st.stage = 1;
          // Use BAL values for consistency with main game
          st.qpcBase += BAL.progression.realmAdvanceReward.qpcBaseAdd; 
          st.qpsBase += BAL.progression.realmAdvanceReward.qpsBaseAdd;
        } else {
          // Spirit Transformation 10 alcanzado
          return true;
        }
      }
    }
    return false;
  }

  while(t < seconds){
    // producción continua
    st.qi += totalQPS_for(st) * dt;
    st.qi += totalQPC_for(st) * clickRate * dt;

    // intentar breakthrough (puede ser más de uno si acumula mucho)
    while (breakthroughIfPossible()){
      return {
        finished: true,
        timeSec: t,
        finalRealm: realms[st.realmIndex].name,
        finalStage: st.stage,
        purchases,
        summary: `Finished at ${t.toFixed(1)}s`
      };
    }

    // intentar compras periódicamente
    accBuy += dt;
    if(accBuy >= buyEvery){
      accBuy = 0;
      const best = bestPurchase(st, clickRate);
      if(best){
        st.qi -= best.cost;
        st.skills[best.id] = (st.skills[best.id]||0) + 1;
        purchases[best.id] = (purchases[best.id]||0) + 1;
      }
    }

    t += dt;
  }

  // no se completó dentro del tiempo
  return {
    finished: false,
    timeSec: seconds,
    finalRealm: realms[st.realmIndex].name,
    finalStage: st.stage,
    purchases,
    summary: `Not finished after ${seconds}s`
  };
}

// Helper para correr varios escenarios y loguear lindo
function runCompletionEstimate(){
  const cases = [
    { label:'Casual (2 cps, 6h)',    seconds:6*3600, clickRate:2 },
    { label:'Normal (3 cps, 6h)',    seconds:6*3600, clickRate:3 },
    { label:'Dedicated (5 cps, 6h)', seconds:6*3600, clickRate:5 },
    { label:'Grinder (3 cps, 10h)',  seconds:10*3600, clickRate:3 },
  ];
  console.log('%c=== Completion Simulator ===','color:#7ee787');
  for(const c of cases){
    const r = simulateCompletion(c);
    console.log(`${c.label} -> finished: ${r.finished}, time:${(r.timeSec/3600).toFixed(2)}h, progress: ${r.finalRealm} ${r.finalStage}/10, purchases:`, r.purchases);
  }
  console.log('Tip: tweak clickRate/seconds in runCompletionEstimate().');
}

// === DEV MODE CONTROL ===
// Define allowed conditions for developer mode
const urlParams = new URLSearchParams(window.location.search);
const devKey = urlParams.get('key');
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const isDevParam = window.location.search.includes('dev=1');
const isSecretKey = (devKey === 'SANTI_SECRET_777');

// Final condition: allowed only if local, ?dev=1, or correct secret key
const isAllowedDev = isLocal || isDevParam || isSecretKey;

if (isAllowedDev) {
  window.runCompletionEstimate = runCompletionEstimate;
  window.simulateCompletion = simulateCompletion;
  console.log("🧪 Dev mode enabled — simulator active");
  // Optionally: createDevPanel();
} else {
  console.log("🔒 Dev mode disabled in production.");
}


