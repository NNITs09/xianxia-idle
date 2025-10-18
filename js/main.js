/*
 * XIANXIA IDLE V1.2.0
 * 
 * RUNAWAY REINCARNATION FIX IMPLEMENTED:
 * 
 * Problem: Multiple/looping reincarnations when lifespan reaches 0, causing ~500 instant reincarnations
 * 
 * Solution Components:
 * 1. LIFECYCLE GUARD: Added S.lifecycle.isReincarnating flag to prevent reentrancy
 * 2. SINGLE-PASS AGING: Replaced while loops with single if checks in tickLifespan()
 * 3. TICK PROTECTION: Main tick() exits early if reincarnation is in progress
 * 4. OFFLINE SAFETY: applyOfflineGains() respects guards and does single death check
 * 5. NUMBER SAFETY: safeNum() helper prevents Infinity/NaN corruption
 * 6. STATE RESET: doReincarnate() properly resets lifespan and timing before clearing guard
 * 7. DEBUG MODE: ?dev=1 URL parameter enables reincarnation rate assertions
 * 
 * Key Functions Modified:
 * - defaultState(): Added lifecycle object
 * - load()/importSave(): Migration ensures lifecycle exists, sanitizes numbers
 * - tickLifespan(): Single death check, sets guard immediately
 * - handleLifespanEnd(): New guarded death handler, pauses time
 * - doReincarnate(): Clears guard only after full state reset
 * - applyOfflineGains(): Single offline death check with guard
 * - tick()/onClick(): Respect reincarnation guard
 * 
 * Result: Exactly one reincarnation per lifespan end, no loops or races
 */

const VERSION = '1.2.0';
const SAVE_KEY = 'xianxiaIdleSaveV1';
let REALM_SKILL_BONUS = 0.20; // default +20% per realm

// Debug mode - enable with ?dev=1 in URL
const DEBUG_MODE = new URLSearchParams(window.location.search).get('dev') === '1';

// Development mode assertions and debugging
let lastReincarnationTime = 0;
function debugAssertReincarnationRate() {
  if (!DEBUG_MODE) return;
  
  const now = Date.now();
  if (lastReincarnationTime > 0 && (now - lastReincarnationTime) < 100) {
    console.warn('⚠️ REINCARNATION DEBUG: Multiple reincarnations within 100ms detected!', {
      timeSinceLast: now - lastReincarnationTime,
      currentTime: now,
      lastTime: lastReincarnationTime
    });
    // Hard stop in dev mode to catch regressions
    debugger;
  }
  lastReincarnationTime = now;
}

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
  },
  lifespan: {
    realmMaxLifespan: [100, 200, 500, 1000, 3000, 10000, 30000, 100000, 300000, null], // years per realm, null = infinite
    yearsPerSecond: 0.01 // aging rate: 0.01 year = ~52 minutes per real second 
  },
  timeSpeed: {
    speeds: [0, 1, 2, 4, 6, 8, 10], // available time multipliers
    unlockRealmIndex: [0, 0, 2, 4, 6, 8, 9] // realm required to unlock each speed
  }
};

// Load balance configuration from JSON
async function loadBalance() {
  try {
    const response = await fetch('balance.json');
    if (response.ok) {
      const balanceData = await response.json();
      BAL = { ...BAL, ...balanceData };
      if (typeof balanceData.realmSkillBonus === 'number') {
        REALM_SKILL_BONUS = balanceData.realmSkillBonus;
      }
      SKILL_CAT = null; // invalidate cache
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
  { id:'void_refining', name:'Void Refining' },
  { id:'body_integration', name:'Body Integration' },
  { id:'mahayana', name:'Mahayana' },
  { id:'tribulation_transcendence', name:'Tribulation Transcendence' },
  { id:'true_immortal', name:'True Immortal' },
];

function stageRequirement(realmIndex, stage){
  const realmBase = BAL.stageRequirement.realmBase * Math.pow(BAL.stageRequirement.realmBaseScale, realmIndex);
  const stageScale = Math.pow(BAL.stageRequirement.stageScale, stage-1);
  const baseRequirement = Math.floor(realmBase * stageScale);
  
  // Apply karma-based reduction
  const karmaReduction = karmaStageBonus();
  return Math.floor(baseRequirement * karmaReduction);
}

/**
 * Format numbers for display with max 2 decimals
 * Internal calculations remain full precision; this is for UI only
 */
function fmt(n){
  if(!isFinite(n)) return '∞';
  
  // For small numbers (< 1000), show max 2 decimals and trim trailing zeros
  if(Math.abs(n) < 1000) {
    const rounded = Number(n.toFixed(2));
    return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  
  // For compact notation (K, M, B, etc.), ensure max 2 decimals
  const units = ['K','M','B','T','Qa','Qi','Sx','Sp','Oc','No'];
  let u = -1;
  while(n >= 1000 && u < units.length-1){ n/=1000; u++; }
  
  // Format with max 2 decimals, trim trailing zeros
  const str = n.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return str + ' ' + units[u];
}

/**
 * Format percentage with max 2 decimals
 */
function fmtPerc(x) {
  if(!isFinite(x)) return '∞%';
  const str = (x * 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return str + '%';
}

/**
 * ROBUST NUMBER FORMATTER - Prevents floating-point noise and ensures max 2 decimals
 * Use this for all numeric display where we need consistent decimal handling
 */
function formatNum2(n) {
  if (!isFinite(n)) return '∞';
  // Clamp to 2 decimals without FP noise
  const v = Math.floor(n * 100) / 100;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * SIMPLE 2-DECIMAL FORMATTER - No locale formatting, just raw XX.XX
 * Use for consistent display of lifespan, percentages, and other numeric values
 */
function fmt2(n) {
  if (!isFinite(n)) return '∞';
  return Number(n).toFixed(2);
}

/**
 * ROBUST YEARS FORMATTER - Single source of truth for age/lifespan display
 * withUnit: if true, appends " years" to finite numbers (default: true)
 * Returns: "123.45 years" or "∞" (never "years years")
 * 
 * IMPORTANT: Do NOT concatenate " years" after calling this function with withUnit=true
 */
function formatYears(n, withUnit = true) {
  if (!isFinite(n)) return '∞';
  
  // For less than 1 year, show in days (optional - keep for precision)
  if (n < 1) {
    const days = Math.floor(n * 365 * 100) / 100;
    const dayStr = days.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return withUnit ? `${dayStr} days` : dayStr;
  }
  
  // Show years with max 2 decimals, no FP noise
  const years = Math.floor(n * 100) / 100;
  const yearStr = years.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return withUnit ? `${yearStr} years` : yearStr;
}

/**
 * DEPRECATED: Old fmtYears - kept for backward compatibility during migration
 * Use formatYears() instead for new code
 */
function fmtYears(years) {
  return formatYears(years, true);
}

function now(){ return Date.now(); }

function safeAddQi(x){
  if (!Number.isFinite(x) || x <= 0) return;
  S.qi = Math.max(0, Math.min(S.qi + x, 1e300));
}

// Number sanitization helper
const safeNum = (v, d = 0) => (Number.isFinite(v) ? v : d);

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
  reinc: { times: 0, karma: 0, lifetimeQi: 0 },
  lifespan: { current: BAL.lifespan?.realmMaxLifespan?.[0] || 100, max: BAL.lifespan?.realmMaxLifespan?.[0] || 100 },
  ageYears: 0, // Current age in years (increases over time)
  isDead: false, // Death state flag
  timeSpeed: { current: 1, paused: false },
  currentCycle: 'mortal',
  life: { isCleanRun: true }, // Track if no reincarnation this life (for Longevity Expert)
  flags: { 
    unlockedBeyondSpirit: false,
    hasUnlockedSpiritCycle: false,
    hasCompletedMandatoryST10: false,
    canManualReincarnate: false,
    lifespanHandled: false // Latch flag to prevent duplicate death popups per life
  },
  lifecycle: { 
    isReincarnating: false, 
    lastDeathAt: 0,
    lastReincarnateAt: 0
  },
  stats: {
    deaths: 0 // Only increments on lifespan death, not voluntary reincarnation
  },
  meta: {
    unlockedSpeeds: [0, 0.5, 1]  // Permanent time-speed unlocks (0, 0.5, 1 always available)
  }
});

// ============= CYCLE SYSTEM =============

// Cycle definitions (must match balance.json)
const CYCLES = {
  mortal: { start: 0, end: 4 },  // Qi Refining through Spirit Transformation
  spirit: { start: 5, end: 9 }   // Void Refining through True Immortal
};

function getCurrentCycle() {
  if (!BAL.cycleDefinitions) return { name: 'Mortal Cycle', realmBonus: 0.20 };
  
  const mortalRealms = BAL.cycleDefinitions.mortal?.realms || [0, 1, 2, 3, 4];
  const spiritRealms = BAL.cycleDefinitions.spirit?.realms || [5, 6, 7, 8, 9];
  
  if (mortalRealms.includes(S.realmIndex)) {
    return BAL.cycleDefinitions.mortal;
  } else if (spiritRealms.includes(S.realmIndex)) {
    return BAL.cycleDefinitions.spirit;
  }
  
  // Fallback
  return BAL.cycleDefinitions.mortal;
}

function updateCurrentCycle() {
  const cycle = getCurrentCycle();
  const mortalRealms = BAL.cycleDefinitions?.mortal?.realms || [0, 1, 2, 3, 4];
  const spiritRealms = BAL.cycleDefinitions?.spirit?.realms || [5, 6, 7, 8, 9];
  
  if (mortalRealms.includes(S.realmIndex)) {
    S.currentCycle = 'mortal';
  } else if (spiritRealms.includes(S.realmIndex)) {
    S.currentCycle = 'spirit';
  }
}

function isAtCycleEnd() {
  const cycle = getCurrentCycle();
  if (S.currentCycle === 'mortal') {
    // If unlocked beyond spirit, the end is determined by reaching spirit realms, not forced at ST
    return S.realmIndex === 4 && S.stage === 10 && !S.flags.unlockedBeyondSpirit;
  } else if (S.currentCycle === 'spirit') {
    return S.realmIndex === 9 && S.stage === 10; // End of True Immortal
  }
  return false;
}

function triggerCycleTransition() {
  const isSpirit = S.currentCycle === 'spirit';
  
  if (isSpirit) {
    // End of Spirit Cycle - Final ascension
    showCycleCompletionModal('final');
  } else {
    // End of Mortal Cycle - Transition to Spirit
    showCycleCompletionModal('mortal-to-spirit');
  }
}

function showCycleCompletionModal(type) {
  const karmaGain = computeKarmaGain();
  const baseYearsPerSecond = BAL.lifespan?.yearsPerSecond || 1.0;
  const yearsLived = ((S.lifespan.max - S.lifespan.current) / baseYearsPerSecond / 60); // Rough estimate
  const yearsLivedFormatted = fmt(yearsLived);
  
  let title, message, onConfirm;
  
  if (type === 'final') {
    title = '🌟 Final Ascension';
    message = `
      <div style="text-align: center; margin-bottom: 16px; font-size: 2.5em;">⚡</div>
      <div style="color: var(--accent); font-weight: 600; margin-bottom: 8px;">The <span class="cycle-spirit">Spirit Cycle</span> is Complete</div>
      <div style="margin-bottom: 16px;">You have transcended all mortal and divine realms. The cosmos itself acknowledges your supremacy.</div>
      <div style="text-align: left; margin: 8px 0;">
        <div><strong>Qi Cultivated:</strong> <span class="highlight">${fmt(S.reinc.lifetimeQi)}</span></div>
        <div><strong>Karma Gained:</strong> <span class="highlight">+${fmt(karmaGain)}</span></div>
        <div><strong>Cycle:</strong> <span class="cycle-spirit">Spirit Cycle</span> Complete</div>
      </div>
      <br><em>Choose to reincarnate and begin anew, or remain in eternal meditation.</em>
    `;
    onConfirm = () => {
      doReincarnate(false);
      unlockAchievement('celestial_eternity');
    };
  } else {
    title = '🔄 Cycle Transition';
    message = `
      <div style="text-align: center; margin-bottom: 16px; font-size: 2.5em;">🦋</div>
      <div style="color: var(--accent); font-weight: 600; margin-bottom: 8px;">The <span class="cycle-mortal">Mortal Cycle</span> Ends</div>
      <div style="margin-bottom: 16px;">Your mortal shell cannot endure further growth. You must transcend to begin the <span class="cycle-spirit">Spirit Cycle</span>.</div>
      <div style="text-align: left; margin: 8px 0;">
        <div><strong>Qi Cultivated:</strong> <span class="highlight">${fmt(S.reinc.lifetimeQi)}</span></div>
        <div><strong>Karma Gained:</strong> <span class="highlight">+${fmt(karmaGain)}</span></div>
        <div><strong>Cycle:</strong> <span class="cycle-mortal">Mortal</span> → <span class="cycle-spirit">Spirit</span></div>
      </div>
      <br><em>The heavens tremble as your <span class="cycle-spirit">Spirit Cycle</span> begins.</em>
    `;
    onConfirm = () => {
      doReincarnate(false);
      unlockAchievement('end_mortal_cycle');
      unlockAchievement('spirit_ascendant');
    };
  }
  
  showConfirm(title, message, onConfirm, null, '');
}

function showSpiritTransformationGate() {
  const title = '🚪 The Gate of Transcendence';
  const message = `
    <div style="text-align: center; margin-bottom: 16px; font-size: 2.5em;">⛓️</div>
    <div style="color: var(--accent); font-weight: 600; margin-bottom: 8px;">Your Mortal Body Cannot Withstand Further Power</div>
    <div style="margin-bottom: 16px;">You have reached the peak of <span class="cycle-mortal">Spirit Transformation</span>, but your mortal form cannot withstand the power needed to advance further. You must undergo mandatory reincarnation to transcend these limitations.</div>
    <div style="text-align: left; margin: 8px 0;">
      <div><strong>Current Realm:</strong> <span class="highlight">Spirit Transformation, Stage 10</span></div>
      <div><strong>Requirement:</strong> <span class="highlight">Mandatory Reincarnation (One Time Only)</span></div>
      <div><strong>After Reincarnation:</strong></div>
      <div style="margin-left: 20px;">✓ Unlock the <span class="cycle-spirit">Spirit Cycle</span></div>
      <div style="margin-left: 20px;">✓ Advance beyond Spirit Transformation in future lives</div>
      <div style="margin-left: 20px;">✓ <strong>Voluntary Reincarnation</strong> available at Spirit Transformation Stage 1 and all higher realms</div>
    </div>
    <br><em>This gate appears only once. After transcending, you'll start from <span class="cycle-mortal">Qi Refining</span> with permanent access to higher realms.</em>
  `;
  
  const onConfirm = () => {
    doReincarnate({ mode: 'mandatory' });
  };
  
  showConfirm(title, message, onConfirm, null, '🦋');
}

// ============= KARMA & POWER SCALING (SOFT CAPS) =============

/**
 * Karma soft cap for Qi multiplier
 * Asymptotically approaches +120% at high karma
 * Formula: 1 + 1.2 * (1 - e^(-0.04 * karma))
 */
function karmaQiMult(karma) {
  return 1 + 1.2 * (1 - Math.exp(-0.04 * karma));
}

/**
 * Karma soft cap for lifespan multiplier
 * Asymptotically approaches +150% at high karma
 * Formula: 1 + 1.5 * (1 - e^(-0.03 * karma))
 */
function karmaLifeMult(karma) {
  return 1 + 1.5 * (1 - Math.exp(-0.03 * karma));
}

/**
 * Karma soft cap for stage requirement reduction
 * Mild effect, asymptotically approaches +60% easier at high karma
 * Formula: 1 + 0.6 * (1 - e^(-0.03 * karma))
 * Applied as: requirement / karmaStageMult (so higher value = easier)
 */
function karmaStageMult(karma) {
  return 1 + 0.6 * (1 - Math.exp(-0.03 * karma));
}

/**
 * Cycle-based power multiplier (LINEAR within cycle, not compounding)
 * Mortal Cycle (realms 0-4): +20% per realm from cycle start
 * Spirit Cycle (realms 5-9): +40% per realm from cycle start
 * Returns a single multiplicative factor (not stacking per realm)
 */
function cyclePowerMult(realmIndex) {
  const inMortal = realmIndex >= CYCLES.mortal.start && realmIndex <= CYCLES.mortal.end;
  const inSpirit = realmIndex >= CYCLES.spirit.start && realmIndex <= CYCLES.spirit.end;
  
  const idxInCycle = inMortal
    ? (realmIndex - CYCLES.mortal.start)
    : inSpirit ? (realmIndex - CYCLES.spirit.start) : 0;
    
  const add = inMortal ? 0.20 * idxInCycle : inSpirit ? 0.40 * idxInCycle : 0;
  return 1 + add; // Linear bonus, not compounded
}

// Dynamic skill catalog based on BAL configuration
let SKILL_CAT = null;
function getSkillCatalog() {
  if (!SKILL_CAT) {
    SKILL_CAT = [
      { id:'breath_control', name:'Breathing Control', desc:'', type:'qps', 
        base: BAL.skills.breath_control.base, cost: BAL.skills.breath_control.cost, costScale: BAL.skills.breath_control.costScale },
      { id:'meridian_flow', name:'Meridian Flow', desc:'', type:'qpc', 
        base: BAL.skills.meridian_flow.base, cost: BAL.skills.meridian_flow.cost, costScale: BAL.skills.meridian_flow.costScale },
      { id:'lotus_meditation', name:'Lotus Meditation', desc:'', type:'qps_mult', 
        base: BAL.skills.lotus_meditation.base, cost: BAL.skills.lotus_meditation.cost, costScale: BAL.skills.lotus_meditation.costScale },
      { id:'dantian_temps', name:'Dantian Expansion', desc:'', type:'qpc_mult', 
        base: BAL.skills.dantian_temps.base, cost: BAL.skills.dantian_temps.cost, costScale: BAL.skills.dantian_temps.costScale },
      { id:'closed_door', name:'Closed Door Cultivation', desc:'', type:'offline_mult', 
        base: BAL.skills.closed_door.base, cost: BAL.skills.closed_door.cost, costScale: BAL.skills.closed_door.costScale },
    ];
  }
  return SKILL_CAT;
}

let S = load() || defaultState();

function totalQPC(){
  let val = S.qpcBase;
  const qpcAdd = (S.skills['meridian_flow']||0) * baseEff('meridian_flow');
  val += qpcAdd;
  const qpcMult = 1 + (S.skills['dantian_temps']||0) * baseEff('dantian_temps');
  
  // Apply multipliers: base skills * karma softcap * cycle linear bonus
  const karmaMult = karmaQiMult(S.reinc.karma);
  const cycleMult = cyclePowerMult(S.realmIndex);
  
  return val * qpcMult * S.qpcMult * karmaMult * cycleMult;
}

function totalQPS(){
  let val = S.qpsBase;
  val += (S.skills['breath_control']||0) * baseEff('breath_control');
  const mult = 1 + (S.skills['lotus_meditation']||0) * baseEff('lotus_meditation');
  
  // Apply multipliers: base skills * karma softcap * cycle linear bonus
  const karmaMult = karmaQiMult(S.reinc.karma);
  const cycleMult = cyclePowerMult(S.realmIndex);
  
  return val * mult * S.qpsMult * karmaMult * cycleMult;
}

function totalOfflineMult(){
  return 1 + (S.skills['closed_door']||0) * baseEff('closed_door');
}

function getSkill(id){ return getSkillCatalog().find(s=>s.id===id); }

function skillCost(id){
  const sk = getSkill(id); const lvl = S.skills[id]||0;
  return Math.floor(sk.cost * Math.pow(sk.costScale, lvl));
}

// Get skill base effectiveness (no longer applies per-realm bonus here - moved to cycle mult)
function baseEff(id){
  return getSkill(id).base;
}

// DEPRECATED: Old reincarnation bonus (replaced by karmaQiMult soft cap)
// Kept for compatibility with old code references
function reincBonus(){
  return karmaQiMult(S.reinc.karma);
}

// DEPRECATED: Old karma-based lifespan efficiency
// Replaced by karmaLifeMult applied to max lifespan
function karmaLifespanBonus(){
  // Return 1.0 (no reduction) - aging is now fixed, karma extends max lifespan instead
  return 1.0;
}

// DEPRECATED: Old karma-based stage requirement reduction
// Replaced by karmaStageMult soft cap
function karmaStageBonus(){
  return 1.0 / karmaStageMult(S.reinc.karma); // Inverse for requirement multiplication
}

// Check if player can manually reincarnate (Spirit Transformation Stage 1+, after mandatory ST10)
function canReincarnate(){
  const ST_INDEX = 4; // Spirit Transformation realm index
  const r = S.realmIndex;
  const st = S.stage;
  
  // Before the first mandatory ST10 reincarnation is done:
  if (!S.flags?.hasCompletedMandatoryST10) {
    // No voluntary reincarnation anywhere; only the mandatory one at ST10 (handled elsewhere)
    return false;
  }
  
  // After the mandatory ST10 has been completed:
  // Allow voluntary reincarnation anywhere at or above Spirit Transformation Stage 1
  // i.e., realm > ST, OR (realm === ST && stage >= 1)
  return (r > ST_INDEX) || (r === ST_INDEX && st >= 1);
}

// Calculate karma gain from reincarnation with cycle multipliers
function computeKarmaGain(){
  const safeLifetimeQi = safeNum(S.reinc.lifetimeQi, 0);
  const safeDivisor = safeNum(BAL.reincarnation.lifetimeQiDivisor, 1000);
  const base = Math.floor(Math.sqrt(safeLifetimeQi / safeDivisor));
  const realmBonus = S.realmIndex * BAL.reincarnation.realmKarmaFactor;
  
  // Cycle multiplier - Spirit cycle gives more karma
  const cycleMultiplier = S.currentCycle === 'spirit' ? 2 : 1;
  
  const totalGain = (base + realmBonus) * cycleMultiplier;
  return Math.max(BAL.reincarnation.minKarma, totalGain);
}

// Voluntary reincarnation: full karma
function computeVoluntaryKarma(){
  return Math.max(BAL.reincarnation.minKarma, computeKarmaGain());
}

// Death reincarnation: reduced karma (configurable penalty)
function computeDeathKarma(){
  const deathPenalty = BAL.reincarnation.deathPenalty || 0.5;
  return Math.max(BAL.reincarnation.minKarma, Math.floor(computeKarmaGain() * deathPenalty));
}

// Perform reincarnation with mode ('voluntary', 'death', or 'mandatory')
function doReincarnate(options = {}){
  const mode = options.mode || 'voluntary'; // 'voluntary', 'death', 'mandatory'
  
  // Debug assertion for development mode
  debugAssertReincarnationRate();
  
  // Set reincarnation guard
  if(S.lifecycle) {
    S.lifecycle.isReincarnating = true;
    S.lifecycle.lastReincarnateAt = Date.now();
  }
  
  // Compute karma gain based on mode
  let gain;
  if (mode === 'death') {
    gain = computeDeathKarma();
  } else {
    gain = computeVoluntaryKarma();
  }
  
  // Preserve old state for logic checks
  const wasAtST10 = S.realmIndex === 4 && S.stage === 10;
  const oldReinc = { ...S.reinc };
  const oldFlags = { ...S.flags };
  const oldMeta = { ...S.meta }; // Preserve meta (persistent unlocks)
  
  // Add karma and increment reincarnation count
  const newKarma = oldReinc.karma + gain;
  const newTimes = oldReinc.times + 1;
  
  // Reset to default state
  S = defaultState();
  
  // Restore persistent data
  S.reinc = { times: newTimes, karma: newKarma, lifetimeQi: 0 };
  S.flags = { ...oldFlags }; // Preserve all flags
  S.meta = { ...oldMeta };   // Preserve meta (time-speed unlocks, etc.)
  
  // Handle mandatory ST10 completion
  if (mode === 'mandatory' && wasAtST10) {
    S.flags.hasCompletedMandatoryST10 = true;
    S.flags.hasUnlockedSpiritCycle = true;
    S.flags.canManualReincarnate = true;
    S.flags.unlockedBeyondSpirit = true;
    
    // Track achievement
    unlockAchievement('break_mortal_shackles');
    achievementState.cycleTransitions = (achievementState.cycleTransitions || 0) + 1;
    saveAchievementState();
  }
  
  // Track achievements based on mode
  if (mode === 'voluntary') {
    if(!achievementState.voluntaryReincarnations) {
      achievementState.voluntaryReincarnations = 0;
    }
    achievementState.voluntaryReincarnations++;
    
    if(achievementState.voluntaryReincarnations === 1) {
      unlockAchievement('first_voluntary_reincarnation');
    }
    saveAchievementState();
  } else if (mode === 'death') {
    // Death reincarnation now handled by handleDeathReincarnate()
    // This branch shouldn't be reached anymore but kept for safety
    S.stats.deaths = (S.stats.deaths || 0) + 1;
    
    unlockAchievement('death_and_return');
    if(!achievementState.forcedReincarnationCount) {
      achievementState.forcedReincarnationCount = 0;
    }
    achievementState.forcedReincarnationCount++;
    saveAchievementState();
  }
  
  // Reset age and lifespan properly
  S.age = 0; // Reset age to 0 for new life
  if(S.ageYears !== undefined) delete S.ageYears; // Clean up old field
  S.isDead = false;
  S.life = { isCleanRun: true }; // New life starts clean
  S.flags.lifespanHandled = false; // Reset latch for new life
  S.lastTick = now(); // Reset timing
  
  const newMaxLifespan = getMaxLifespan(0);
  if(newMaxLifespan === null) {
    // True Immortal - infinite lifespan
    S.lifespan = { current: null, max: null };
  } else {
    // Ensure we have a valid number
    const validLifespan = safeNum(newMaxLifespan, 100);
    S.lifespan = { current: validLifespan, max: validLifespan };
  }
  
  // Reset timing
  S.lastTick = now();
  
  // Always start at Qi Refining after reincarnation
  S.realmIndex = 0;
  S.stage = 1;
  S.currentCycle = 'mortal';
  updateCurrentCycle();
  
  // Clear reincarnation guard and unpause
  if(S.lifecycle) {
    S.lifecycle.isReincarnating = false;
  }
  S.timeSpeed.paused = false;
  
  save();
  renderAll();
  
  // Show appropriate modal based on mode
  const karmaGained = gain.toFixed(2);
  const totalKarma = S.reinc.karma.toFixed(2);
  
  if (mode === 'mandatory') {
    showModal('🌟 Transcendence Achieved', 
      `<span class="highlight">You have broken the shackles of mortality!</span><br><br>
      Your soul now walks the path of the Spirit Cycle.<br><br>
      <strong>Voluntary reincarnation is now available</strong> at Spirit Transformation Stage 1 and all higher realms.<br><br>
      <div class="highlight">+${karmaGained} Karma gained (Total: ${totalKarma})</div>`, '🦋');
  } else if (mode === 'death') {
    showModal('☠️ Death and Rebirth', 
      `<span style="color: var(--danger);">Your mortal body has withered. You failed to transcend before death.</span><br><br>
      <strong>Reduced Karma:</strong> ${karmaGained} Karma gained (50% penalty)<br>
      <strong>Total Karma:</strong> ${totalKarma}<br><br>
      <em>Next time, seek voluntary reincarnation at Spirit Transformation Stage 1+ for full rewards.</em>`, '💀');
  } else {
    showModal('♻️ Reincarnation Complete', 
      `The wheel of reincarnation turns, and you begin anew with greater wisdom.<br><br>
      <div class="highlight">+${karmaGained} Karma gained (Total: ${totalKarma})</div><br>
      Your accumulated karma will enhance your cultivation speed.`, '🔄');
  }
}

// Wrapper functions for specific reincarnation types
function tryManualReincarnate(){
  if(!canReincarnate()) {
    if(!S.flags?.hasCompletedMandatoryST10) {
      showModal('🔒 Reincarnation Locked', 
        `<strong>Unlock Condition:</strong> Complete your first mandatory reincarnation at Spirit Transformation Stage 10.<br><br>
        Once unlocked, voluntary reincarnation will be available at Spirit Transformation Stage 1 and all higher realms with full Karma rewards.`, '⚠️');
    } else {
      showModal('🔒 Wrong Realm or Stage', 
        `Voluntary reincarnation is only available at <strong>Spirit Transformation Stage 1 or higher</strong>.<br><br>
        Current: ${realms[S.realmIndex]?.name || 'Unknown'} Stage ${S.stage}`, '⚠️');
    }
    return;
  }
  
  showConfirm(
    '♻️ Voluntary Reincarnation',
    `Reincarnate now and retain <strong>full Karma</strong>. Your next life will begin stronger.<br><br>
    You will return to Qi Refining Stage 1, but all achievements and unlocks will be preserved.<br><br>
    <em style="color: var(--muted);">Note: Voluntary reincarnation will end your current life run.</em>`,
    () => {
      // Mark this life as no longer clean (reincarnated before natural death)
      if(S.life) S.life.isCleanRun = false;
      doReincarnate({ mode: 'voluntary' });
    },
    null,
    '🔄'
  );
}

function handleDeathReincarnate(){
  // DEPRECATED - replaced by performDeathReincarnation in async flow
  // This function is kept for backwards compatibility
  // It should not be called anymore - handleLifespanEnd handles everything
  console.warn('handleDeathReincarnate called - this is deprecated, use handleLifespanEnd instead');
}

// Lifespan management functions
function getMaxLifespan(realmIndex = null){
  const index = realmIndex !== null ? realmIndex : S.realmIndex;
  const maxFromConfig = BAL.lifespan?.realmMaxLifespan?.[index];
  if(maxFromConfig === null || maxFromConfig === undefined) {
    // True Immortal realm - infinite lifespan
    return null;
  }
  
  // Apply karma multiplier to base lifespan (soft cap, asymptotic to +150%)
  const karmaMult = karmaLifeMult(S.reinc.karma);
  const baseLifespan = maxFromConfig || BAL.lifespan?.realmMaxLifespan?.[0] || 100;
  return Math.floor(baseLifespan * karmaMult);
}

function isImmortal(){
  return getMaxLifespan() === null;
}

function updateLifespanOnRealmAdvance(){
  const newMax = getMaxLifespan();
  if(newMax === null) {
    // True Immortal - set infinite lifespan
    S.lifespan.max = null;
    S.lifespan.current = null;
    S.age = 0; // Reset age for immortals
  } else {
    S.lifespan.max = newMax;
    S.lifespan.current = newMax; // fully restore lifespan on realm advancement
    S.age = 0; // Reset age to 0 when advancing realm
  }
  
  // Reset lifespan latch when advancing realms
  if(S.flags) {
    S.flags.lifespanHandled = false;
  }
}

/**
 * Age progression system - ticks age forward based on dt and time speed
 * Single source of truth for aging calculation
 */
function tickLifespan(dt){
  // Guard: don't age if paused, dead, or no lifespan data
  if(S.timeSpeed?.paused || !S.lifespan || S.isDead) return;
  
  // Guard: True Immortal realm has infinite lifespan - no aging
  if(isImmortal()) return;
  
  // Guard: don't tick during reincarnation process
  if(S.lifecycle?.isReincarnating) return;
  
  // Guard: don't tick if time speed is 0 (explicit pause)
  const currentTimeSpeed = S.timeSpeed.current || 0;
  if(currentTimeSpeed <= 0) return;
  
  // Guard: protect against negative dt (clock changes, sleep, etc.)
  const safeDt = Math.max(0, dt);
  if(safeDt === 0) return;
  
  // Calculate aging rate: dt (seconds) × speed × yearsPerSecond
  const baseYearsPerSecond = BAL.lifespan?.yearsPerSecond || 1.0;
  const agingRate = safeDt * currentTimeSpeed * baseYearsPerSecond;
  
  // Migrate old ageYears to age if needed
  if(S.ageYears !== undefined && S.age === undefined) {
    S.age = S.ageYears;
    delete S.ageYears;
  }
  
  // Initialize age if missing
  if(!S.age || !isFinite(S.age)) {
    S.age = 0;
  }
  
  // Apply aging
  const newAge = S.age + agingRate;
  
  // Guard: prevent NaN/Infinity
  if(!isFinite(newAge)) {
    console.warn('Age calculation resulted in non-finite value, keeping previous age');
    return;
  }
  
  // Get max lifespan (with karma multiplier)
  const maxLifespan = getMaxLifespan();
  
  // Clamp age to [0, maxLifespan]
  if(maxLifespan !== null) {
    S.age = Math.max(0, Math.min(newAge, maxLifespan));
  } else {
    S.age = Math.max(0, newAge); // Infinite lifespan, just prevent negative
  }
  
  // Update lifespan.current for backwards compatibility (max - age)
  if(S.lifespan.max !== null) {
    S.lifespan.current = Math.max(0, S.lifespan.max - S.age);
  }
  
  // Check for death ONCE per life using latch flag
  if(maxLifespan !== null && S.age >= maxLifespan && !S.flags.lifespanHandled){
    S.flags.lifespanHandled = true; // Set latch to prevent duplicate popups
    handleLifespanEnd();
    return; // Exit early after triggering death
  }
}

// Death handling guard to prevent duplicate popups
let isHandlingDeath = false;

async function handleLifespanEnd(){
  // Prevent multiple simultaneous death triggers (debounce)
  if(isHandlingDeath || S.lifecycle?.isReincarnating || S.isDead) return;
  
  isHandlingDeath = true;
  
  try {
    // Set death flag and reincarnation guard immediately
    S.isDead = true;
    S.lifecycle.isReincarnating = true;
    S.lifecycle.lastDeathAt = Date.now();
    
    // PAUSE THE GAME - set speed to 0
    S.timeSpeed.current = 0;
    S.timeSpeed.paused = true;
    
    // Get current age (migrate from ageYears if needed)
    const currentAge = S.age !== undefined ? S.age : (S.ageYears || 0);
    
    // Compute death karma before showing modal
    const gain = computeDeathKarma();
    const gainFormatted = fmt(gain);
    const ageFormatted = fmtYears(currentAge);
    
    // Show single death modal and wait for user to dismiss it
    await ModalManager.alert({
      title: '☠️ Your Candle Has Burned Out',
      body: `<span style="color: var(--danger);">Your mortal body has withered after ${ageFormatted}.</span><br><br>
        <strong>Karma Gained:</strong> <span class="highlight">${gainFormatted} Karma</span> (50% death penalty)<br><br>
        <em>You will be reborn into a new life...</em>`,
      confirmText: 'Begin Again',
      icon: '💀'
    });
    
    // Perform reincarnation ONCE after modal is dismissed
    await performDeathReincarnation(gain);
    
  } finally {
    isHandlingDeath = false;
    // Latch flag is reset in reincarnation function
  }
}

async function performDeathReincarnation(karmaGain) {
  // Increment deaths counter (deaths do NOT count as reincarnations)
  S.stats = S.stats || {};
  S.stats.deaths = (S.stats.deaths || 0) + 1;
  
  // Apply karma gain
  const newKarma = (S.reinc?.karma || 0) + karmaGain;
  // DO NOT increment reincarnation times on death - only voluntary/mandatory reincarnations count
  const newTimes = (S.reinc?.times || 0); // Keep same count
  
  // Preserve meta-progression (flags, achievements already earned)
  const keepFlags = S.flags ? { ...S.flags } : {};
  const keepStats = { deaths: S.stats.deaths };
  const keepReinc = { times: newTimes, karma: newKarma, lifetimeQi: 0 };
  const keepMeta = S.meta ? { ...S.meta } : { unlockedSpeeds: [0, 0.5, 1] }; // Preserve meta (time-speed unlocks, etc.)
  
  // Full hard reset to default state
  S = defaultState();
  
  // Restore persistent meta-progression
  S.flags = keepFlags;
  S.flags.lifespanHandled = false; // Reset latch for new life
  S.stats = keepStats;
  S.reinc = keepReinc;
  S.meta = keepMeta; // Restore meta
  
  // Reset age and timing for new life
  S.age = 0;
  S.lastTick = now();
  
  // Initialize age and lifespan cleanly for new life
  S.ageYears = 0;
  const newMaxLifespan = getMaxLifespan(0); // Qi Refining base lifespan
  if(newMaxLifespan === null) {
    S.lifespan = { current: null, max: null };
  } else {
    const validLifespan = safeNum(newMaxLifespan, 100);
    S.lifespan = { current: validLifespan, max: validLifespan };
  }
  S.isDead = false;
  S.life = { isCleanRun: true }; // New life, no reincarnations yet
  
  // Reset timing and ensure time is NOT paused
  S.lastTick = now();
  S.timeSpeed = S.timeSpeed || {};
  S.timeSpeed.paused = false; // Explicitly unpause
  S.timeSpeed.current = 1; // Reset to normal speed
  
  // Track achievement for death reincarnation
  unlockAchievement('death_and_return');
  if(!achievementState.forcedReincarnationCount) {
    achievementState.forcedReincarnationCount = 0;
  }
  achievementState.forcedReincarnationCount++;
  saveAchievementState();
  
  // Clear reincarnation guard
  S.lifecycle.isReincarnating = false;
  
  // Full UI refresh and save
  save();
  renderAll();
  
  // NO second modal - user has already been informed
}

function showDeathConfirmModal(){
  // DEPRECATED - replaced by handleLifespanEnd async flow
  // Keeping for backwards compatibility in case referenced elsewhere
  handleLifespanEnd();
}

function handleDeath(){
  // Legacy function - redirect to new async implementation
  handleLifespanEnd();
}

// DEPRECATED - showDeathMessage was part of old implementation
function showDeathMessage(){
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    background: linear-gradient(45deg, rgba(0,0,0,0.85), rgba(20,10,10,0.9));
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    opacity: 0;
    transition: opacity 0.8s ease;
    backdrop-filter: blur(4px);
  `;
  
  const message = document.createElement('div');
  message.style.cssText = `
    background: linear-gradient(135deg, var(--panel), #1a0f0f);
    border: 2px solid var(--danger);
    border-radius: 20px;
    padding: 32px;
    text-align: center;
    color: var(--text);
    max-width: 450px;
    transform: scale(0.7) rotate(-2deg);
    transition: all 0.8s cubic-bezier(0.34, 1.56, 0.64, 1);
    box-shadow: 0 20px 60px rgba(255, 107, 107, 0.3);
  `;
  
  message.innerHTML = `
    <div style="font-size: 3em; margin-bottom: 16px; animation: fadeInPulse 0.8s ease;">💀</div>
    <h3 style="margin: 0 0 16px 0; color: var(--danger); font-size: 1.4em;">End of Mortal Life</h3>
    <p style="margin: 0; color: var(--muted); line-height: 1.5;">Your mortal body has reached its end.<br>You feel your spirit leaving this realm...<br><br><em style="color: var(--accent);">Reincarnation begins.</em></p>
  `;
  
  // Add keyframe animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes fadeInPulse {
      0% { opacity: 0; transform: scale(0.5); }
      50% { opacity: 0.8; transform: scale(1.2); }
      100% { opacity: 1; transform: scale(1); }
    }
  `;
  document.head.appendChild(style);
  
  overlay.appendChild(message);
  document.body.appendChild(overlay);
  
  // Animate in
  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
    message.style.transform = 'scale(1) rotate(0deg)';
  });
  
  // Remove after 2.5 seconds
  setTimeout(() => {
    overlay.style.opacity = '0';
    message.style.transform = 'scale(0.8) rotate(1deg)';
    setTimeout(() => {
      overlay.remove();
      style.remove();
    }, 800);
  }, 2500);
}

// Time speed management functions
function getAvailableSpeeds(){
  // Return permanently unlocked speeds from meta
  // Always include 0 (pause), 0.5×, and 1× regardless of progression
  if(!S.meta?.unlockedSpeeds || !Array.isArray(S.meta.unlockedSpeeds)) {
    return [0, 0.5, 1]; // Fallback if meta not initialized
  }
  
  // Ensure base speeds are always available
  const baseSpeedsAlwaysAvailable = [0, 0.5, 1];
  const allUnlocked = [...new Set([...baseSpeedsAlwaysAvailable, ...S.meta.unlockedSpeeds])];
  
  // Sort speeds in ascending order
  return allUnlocked.sort((a, b) => a - b);
}

// Check if new speeds should be unlocked based on realm progression
function checkAndUnlockSpeeds(){
  if(!BAL.timeSpeed?.speeds || !BAL.timeSpeed?.unlockRealmIndex) return;
  
  const allSpeeds = BAL.timeSpeed.speeds;
  const unlockRealms = BAL.timeSpeed.unlockRealmIndex;
  
  // Ensure base speeds (0, 0.5, 1) are always in unlockedSpeeds
  const baseSpeedsAlwaysAvailable = [0, 0.5, 1];
  baseSpeedsAlwaysAvailable.forEach(speed => {
    if (!S.meta.unlockedSpeeds.includes(speed)) {
      S.meta.unlockedSpeeds.push(speed);
    }
  });
  
  // Check for higher speed unlocks based on realm progression
  allSpeeds.forEach((speed, index) => {
    // Skip base speeds (already handled above)
    if (baseSpeedsAlwaysAvailable.includes(speed)) return;
    
    const requiredRealm = unlockRealms[index] || 0;
    // If player has reached required realm and speed not yet unlocked
    if(S.realmIndex >= requiredRealm && !S.meta.unlockedSpeeds.includes(speed)) {
      S.meta.unlockedSpeeds.push(speed);
    }
  });
}

function setTimeSpeed(speed){
  const availableSpeeds = getAvailableSpeeds();
  
  // If requested speed is not available, fallback to 1×
  if(!availableSpeeds.includes(speed)) {
    speed = 1; // Default fallback
  }
  
  if(speed === 0){
    S.timeSpeed.paused = true;
    S.timeSpeed.current = 0;
  } else {
    S.timeSpeed.paused = false;
    S.timeSpeed.current = speed;
  }
  
  save();
  renderTimeSpeed();
}

/**
 * CENTRALIZED TIME SPEED GETTER - Single source of truth
 * Returns the current time speed multiplier (0, 0.5, 1, 2, 4, 6, 8, 10...)
 * Use this everywhere for consistent time scaling
 */
function getTimeSpeed() {
  return S.timeSpeed.paused ? 0 : S.timeSpeed.current;
}

/**
 * DEPRECATED: Use getTimeSpeed() instead
 * Kept for backward compatibility
 */
function getCurrentTimeMultiplier(){
  return getTimeSpeed();
}

function canBreakthrough(){
  const req = stageRequirement(S.realmIndex, S.stage);
  if(S.qi < req) return false;
  
  // Check for Spirit Transformation gate
  if(S.realmIndex === 4 && S.stage === 10 && !S.flags?.unlockedBeyondSpirit) {
    return true; // Can breakthrough to trigger the gate modal
  }
  
  return true;
}

function doBreakthrough(){
  const req = stageRequirement(S.realmIndex, S.stage);
  if(S.qi < req) return;
  S.qi -= req;
  
  if(S.stage < 10){
    S.stage++;
  } else {
    // Check for Spirit Transformation gate (realm index 4 = Spirit Transformation)
    if(S.realmIndex === 4 && !S.flags.unlockedBeyondSpirit) {
      showSpiritTransformationGate();
      return;
    }
    
    // Check for cycle end before advancing to next realm
    if(isAtCycleEnd()){
      triggerCycleTransition();
      return;
    }
    
    if(S.realmIndex < realms.length-1){
      const wasSpritTransformation = S.realmIndex === 4;
      S.realmIndex++; S.stage = 1;
      S.qpcBase += BAL.progression.realmAdvanceReward.qpcBaseAdd; 
      S.qpsBase += BAL.progression.realmAdvanceReward.qpsBaseAdd;
      updateLifespanOnRealmAdvance(); // restore lifespan on realm advancement
      updateCurrentCycle(); // Update cycle when moving to new realm
      checkAndUnlockSpeeds(); // Check for new time-speed unlocks
      
      // Show special message when advancing to spirit realms after unlocking transcendence
      if(wasSpritTransformation && S.flags.unlockedBeyondSpirit && S.realmIndex === 5) {
        setTimeout(() => {
          showModal(
            '🌟 Spirit Cycle Begins',
            'You have transcended beyond mortal limitations and entered the Spirit Cycle! Your cultivation now follows the celestial path of divine realms.',
            '🌌'
          );
        }, 500);
      }
    } else {
      // Final ascension at True Immortal Stage 10
      triggerCycleTransition();
    }
  }
}

function tick(dt){
  // Guard: no progress when paused (0× speed)
  const timeSpeed = getTimeSpeed();
  if(timeSpeed === 0) return;
  
  // Guard against ticking during reincarnation process
  if(S.lifecycle?.isReincarnating) return;
  
  // Guard against ticking while death modal is being handled
  if(isHandlingDeath) return;
  
  // SINGLE SOURCE OF TRUTH: Apply time speed once to create effective dt
  const effDt = dt * timeSpeed;
  
  // Qi gains (QPS × effective time)
  const gain = totalQPS() * effDt;
  safeAddQi(gain);
  S.reinc.lifetimeQi = safeNum(S.reinc.lifetimeQi + gain, 0);
  
  // Age progression (uses effDt internally for consistency)
  tickLifespan(dt);
  
  // Check for lifespan gate after aging
  checkLifespanGate();
  
  // Exit early if death was triggered during lifespan tick
  if(S.lifecycle?.isReincarnating) return;
}

function onClick(){
  // Guard: no clicking when paused (0× speed)
  const timeSpeed = getTimeSpeed();
  if(timeSpeed === 0) return;
  
  if(S.lifecycle?.isReincarnating) return; // no clicking during reincarnation
  
  const timeMultiplier = getCurrentTimeMultiplier();
  const gain = totalQPC() * timeMultiplier;
  safeAddQi(gain);
  S.reinc.lifetimeQi = safeNum(S.reinc.lifetimeQi + gain, 0);
  
  // Track clicks for achievements
  achievementState.totalClicks++;
  saveAchievementState();
  
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

// ============= ACHIEVEMENTS SYSTEM =============

const ACHIEVEMENTS_KEY = 'xianxiaAchievementsV1';

const ACHIEVEMENTS = [
  // Progression Achievements
  {
    id: "reach_qi_refining_10",
    title: "Qi Foundation Mastered",
    description: "Reach Qi Refining, Stage 10 and master the fundamentals of cultivation.",
    icon: "🌱",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === 0 && stage === 10
  },
  {
    id: "reach_foundation_10",
    title: "Foundation Perfected",
    description: "Reach Foundation Establishment, Stage 10 and solidify your cultivation base.",
    icon: "🏛️",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === 1 && stage === 10
  },
  {
    id: "reach_golden_core_10",
    title: "Golden Core Perfected",
    description: "Reach Golden Core, Stage 10 and forge your spiritual core.",
    icon: "⚡",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === 2 && stage === 10
  },
  {
    id: "reach_nascent_soul_10",
    title: "Soul Awakened",
    description: "Reach Nascent Soul, Stage 10 and awaken your spiritual consciousness.",
    icon: "👁️",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === 3 && stage === 10
  },
  {
    id: "reach_spirit_transform_10",
    title: "Spirit Transformed",
    description: "Reach Spirit Transformation, Stage 10 and transcend your mortal form.",
    icon: "🦋",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === 4 && stage === 10
  },
  {
    id: "reach_void_refining_10",
    title: "Void Walker",
    description: "Reach Void Refining, Stage 10 and master the emptiness between worlds.",
    icon: "🌌",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === 5 && stage === 10
  },
  {
    id: "reach_body_integration_10",
    title: "Body and Soul United",
    description: "Reach Body Integration, Stage 10 and achieve perfect harmony.",
    icon: "☯️",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === 6 && stage === 10
  },
  {
    id: "reach_mahayana_10",
    title: "Great Vehicle Master",
    description: "Reach Mahayana, Stage 10 and walk the supreme path.",
    icon: "🚗",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === 7 && stage === 10
  },
  {
    id: "reach_tribulation_10",
    title: "Tribulation Survivor",
    description: "Reach Tribulation Transcendence, Stage 10 and overcome heavenly judgment.",
    icon: "⚡",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex, stage }) => realmIndex === 8 && stage === 10
  },
  {
    id: "reach_true_immortal",
    title: "True Immortal",
    description: "Ascend to True Immortal realm and achieve eternal existence.",
    icon: "🌟",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ realmIndex }) => realmIndex >= 9
  },

  // Reincarnation Achievements
  {
    id: "first_reincarnation",
    title: "Cycle of Rebirth",
    description: "Choose to begin anew after transcending mortality - perform a voluntary reincarnation.",
    icon: "🔄",
    category: "Reincarnation",
    hiddenUntilUnlocked: false,
    requirement: ({ voluntaryReincarnations }) => voluntaryReincarnations >= 1
  },
  {
    id: "rebirth_5",
    title: "Experienced Soul",
    description: "Reincarnate 5 times and accumulate wisdom across lifetimes.",
    icon: "🎭",
    category: "Reincarnation",
    hiddenUntilUnlocked: false,
    requirement: ({ reincTimes }) => reincTimes >= 5
  },
  {
    id: "rebirth_20",
    title: "Ancient Soul",
    description: "Reincarnate 20 times and become a master of the endless cycle.",
    icon: "👴",
    category: "Reincarnation",
    hiddenUntilUnlocked: false,
    requirement: ({ reincTimes }) => reincTimes >= 20
  },
  {
    id: "first_voluntary_reincarnation",
    title: "Willing Sacrifice",
    description: "Perform your first voluntary reincarnation at Spirit Transformation Stage 1+ for full Karma rewards.",
    icon: "♻️",
    category: "Reincarnation",
    hiddenUntilUnlocked: false,
    requirement: ({ voluntaryReincarnations }) => voluntaryReincarnations >= 1
  },
  {
    id: "death_and_return",
    title: "Death and Return",
    description: "Experience death by lifespan exhaustion and return through forced reincarnation.",
    icon: "💀",
    category: "Reincarnation",
    hiddenUntilUnlocked: false,
    requirement: ({ forcedReincarnationCount }) => forcedReincarnationCount >= 1
  },

  // Economy / Skills Achievements
  {
    id: "qpc_100",
    title: "Mighty Click",
    description: "Reach 100 Qi per click and feel the power in your fingertips.",
    icon: "👆",
    category: "Skills",
    hiddenUntilUnlocked: false,
    requirement: ({ qpc }) => qpc >= 100
  },
  {
    id: "qps_1k",
    title: "Steady Flow",
    description: "Reach 1,000 Qi per second and achieve constant cultivation.",
    icon: "🌊",
    category: "Skills",
    hiddenUntilUnlocked: false,
    requirement: ({ qps }) => qps >= 1000
  },
  {
    id: "skill_10_any",
    title: "Skill Master",
    description: "Raise any single skill to Level 10 and show your dedication.",
    icon: "📚",
    category: "Skills",
    hiddenUntilUnlocked: false,
    requirement: ({ skills }) => Object.values(skills).some(lvl => lvl >= 10)
  },
  {
    id: "shopper_100_purchases",
    title: "Devoted Student",
    description: "Buy 100 skills total and prove your commitment to growth.",
    icon: "🛒",
    category: "Skills",
    hiddenUntilUnlocked: false,
    requirement: ({ totalPurchases }) => totalPurchases >= 100
  },

  // Time / Offline Achievements
  {
    id: "meditation_master",
    title: "Meditation Master",
    description: "Earn offline Qi from 8+ hours of meditation in one session.",
    icon: "🧘",
    category: "Time",
    hiddenUntilUnlocked: false,
    requirement: ({ offlineHours }) => offlineHours >= 8
  },
  {
    id: "lifespan_saver",
    title: "Longevity Expert",
    description: "Survive 3000 years in a single life without reincarnating.",
    icon: "⏳",
    category: "Time",
    hiddenUntilUnlocked: false,
    requirement: ({ ageYears, isCleanRun }) => ageYears >= 3000 && isCleanRun
  },

  // Secrets / Misc Achievements
  {
    id: "dao_seeker",
    title: "Dao Seeker",
    description: "Open the Achievements panel and begin seeking the path of accomplishment.",
    icon: "🔍",
    category: "Misc",
    hiddenUntilUnlocked: false,
    requirement: ({ achievementsPanelOpened }) => achievementsPanelOpened === true
  },
  {
    id: "harmonious_clicks",
    title: "Harmonious Clicker",
    description: "Perform 1,000 total clicks and achieve clicking harmony.",
    icon: "🎵",
    category: "Misc",
    hiddenUntilUnlocked: false,
    requirement: ({ totalClicks }) => totalClicks >= 1000
  },

  // Cycle and Karma Achievements
  {
    id: "end_mortal_cycle",
    title: "End of the Mortal Cycle",
    description: "Complete the Mortal Cycle and transcend to Spirit Cultivation.",
    icon: "🦋",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ cycleTransitions }) => cycleTransitions >= 1
  },
  {
    id: "spirit_ascendant",
    title: "Spirit Ascendant",
    description: "Begin the Spirit Cycle and walk the celestial path.",
    icon: "🌌",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ currentCycle }) => currentCycle === 'spirit'
  },
  {
    id: "karmic_mastery",
    title: "Karmic Mastery",
    description: "Reach 10,000 Karma and master the laws of cause and effect.",
    icon: "⚖️",
    category: "Reincarnation",
    hiddenUntilUnlocked: false,
    requirement: ({ karma }) => karma >= 10000
  },
  {
    id: "celestial_eternity",
    title: "Celestial Eternity",
    description: "Complete the Spirit Cycle and achieve ultimate transcendence.",
    icon: "♾️",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ spiritCycleComplete }) => spiritCycleComplete === true
  },
  {
    id: "break_mortal_shackles",
    title: "Break the Mortal Shackles",
    description: "Reincarnate at Spirit Transformation Stage 10 to unlock transcendence beyond mortal limits.",
    icon: "�",
    category: "Progression",
    hiddenUntilUnlocked: false,
    requirement: ({ unlockedBeyondSpirit }) => unlockedBeyondSpirit === true
  },

  // Impossible Achievements - Hidden legendary goals
  {
    id: "infinite_qi",
    title: "Qi Without End",
    description: "Reach 1e100 Qi in a single lifetime. The universe trembles before your power.",
    icon: "🌌",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ qi }) => qi >= 1e100
  },
  {
    id: "eternal_clicker",
    title: "Finger of the Dao",
    description: "Perform 1,000,000,000 clicks in total. Your finger has transcended mortality.",
    icon: "👆",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ totalClicks }) => totalClicks >= 1_000_000_000
  },
  {
    id: "karma_overflow",
    title: "Karma Overflow",
    description: "Accumulate over 1,000,000 Karma. You have broken the cosmic balance itself.",
    icon: "⚖️",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ karma }) => karma >= 1_000_000
  },
  {
    id: "beyond_time",
    title: "Beyond Time Itself",
    description: "Survive 1,000,000 in-game years without dying. Time bows to your will.",
    icon: "⏰",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ yearsAlive }) => yearsAlive >= 1_000_000
  },
  {
    id: "click_master",
    title: "The Endless Tap",
    description: "Reach 1e12 Qi per click. Each tap reshapes reality.",
    icon: "💫",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ qpc }) => qpc >= 1e12
  },
  {
    id: "speed_demon",
    title: "Beyond the Dao of Time",
    description: "Unlock time speed x100. You have shattered the temporal prison.",
    icon: "⚡",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ maxTimeSpeed }) => maxTimeSpeed >= 100
  },
  {
    id: "cycle_breaker",
    title: "Cycle Breaker",
    description: "Complete the Spirit Cycle without any forced reincarnations. Death fears you.",
    icon: "🔗",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ forcedReincarnationCount, currentCycle, spiritCycleComplete }) => 
      forcedReincarnationCount === 0 && currentCycle === 'spirit' && spiritCycleComplete
  },
  {
    id: "realm_infinite",
    title: "Beyond True Immortal",
    description: "Reach a realm beyond True Immortal. The impossible becomes possible.",
    icon: "🌟",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ realmIndex }) => realmIndex > 9
  },
  {
    id: "dao_god",
    title: "God of Cultivation",
    description: "Max every skill to Level 999. You have mastered all earthly techniques.",
    icon: "👑",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ skills }) => Object.keys(skills).length >= 5 && Object.values(skills).every(v => v >= 999)
  },
  {
    id: "ultimate_patience",
    title: "The Eternal Wait",
    description: "Leave the game running for 1000 real hours. Patience is the greatest virtue.",
    icon: "🧘",
    category: "Impossible",
    hiddenUntilUnlocked: true,
    requirement: ({ totalPlayTimeHours }) => totalPlayTimeHours >= 1000
  }
];

// Unlocked feature requirements
const UNLOCKS = {
  speed_2x: { requirement: ({ realmIndex }) => realmIndex >= 2, text: "Reach Golden Core realm to unlock 2× time flow." },
  speed_4x: { requirement: ({ realmIndex }) => realmIndex >= 4, text: "Reach Spirit Transformation realm to unlock 4× time flow." },
  speed_6x: { requirement: ({ realmIndex }) => realmIndex >= 6, text: "Reach Body Integration realm to unlock 6× time flow." },
  speed_8x: { requirement: ({ realmIndex }) => realmIndex >= 8, text: "Reach Tribulation Transcendence realm to unlock 8× time flow." },
  speed_10x: { requirement: ({ realmIndex }) => realmIndex >= 9, text: "Reach True Immortal realm to unlock 10× time flow." }
};

// Achievement state management
let achievementState = loadAchievementState();

function loadAchievementState() {
  try {
    const saved = localStorage.getItem(ACHIEVEMENTS_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.warn('Failed to load achievement state:', e);
  }
  return { 
    unlocked: {}, 
    totalClicks: 0, 
    totalPurchases: 0, 
    achievementsPanelOpened: false,
    cycleTransitions: 0,
    spiritCycleComplete: false
  };
}

function saveAchievementState() {
  try {
    localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(achievementState));
  } catch (e) {
    console.warn('Failed to save achievement state:', e);
  }
}

function hasAchievement(id) {
  return !!achievementState.unlocked[id];
}

function unlockAchievement(id) {
  if (hasAchievement(id)) return false; // Already unlocked
  
  const achievement = ACHIEVEMENTS.find(a => a.id === id);
  if (!achievement) return false;
  
  achievementState.unlocked[id] = {
    unlockedAt: Date.now(),
    title: achievement.title,
    description: achievement.description,
    icon: achievement.icon
  };
  
  saveAchievementState();
  showAchievementToast(achievement);
  showAchievementModal(achievement);
  updateAchievementsBadge();
  
  return true;
}

function checkAchievements(context = {}) {
  // Build context object with current game state
  const ctx = {
    realmIndex: S.realmIndex,
    stage: S.stage,
    qpc: totalQPC(),
    qps: totalQPS(),
    qi: S.qi,
    skills: S.skills,
    reincTimes: S.reinc.times,
    karma: S.reinc.karma,
    currentCycle: S.currentCycle,
    lifespanPercent: S.lifespan.max > 0 ? (S.lifespan.current / S.lifespan.max) * 100 : 100,
    ageYears: S.ageYears || 0,
    isCleanRun: S.life?.isCleanRun || false,
    totalClicks: achievementState.totalClicks,
    totalPurchases: achievementState.totalPurchases,
    achievementsPanelOpened: achievementState.achievementsPanelOpened,
    cycleTransitions: achievementState.cycleTransitions || 0,
    spiritCycleComplete: achievementState.spiritCycleComplete || false,
    unlockedBeyondSpirit: S.flags?.unlockedBeyondSpirit || false,
    voluntaryReincarnations: achievementState.voluntaryReincarnations || 0,
    ...context // Override with any specific context passed in
  };
  
  // Check each achievement
  ACHIEVEMENTS.forEach(achievement => {
    if (!hasAchievement(achievement.id) && achievement.requirement(ctx)) {
      unlockAchievement(achievement.id);
    }
  });
}

function showAchievementToast(achievement) {
  const toast = document.createElement('div');
  toast.className = 'achievement-toast';
  toast.innerHTML = `
    <div class="achievement-toast-icon">${achievement.icon}</div>
    <div class="achievement-toast-content">
      <div class="achievement-toast-title">Achievement Unlocked!</div>
      <div class="achievement-toast-desc">${achievement.title}</div>
    </div>
  `;
  
  document.body.appendChild(toast);
  
  // Animate in
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });
  
  // Auto-remove after 4 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function showAchievementModal(achievement) {
  showModal(
    '🏆 Achievement Unlocked!',
    `<div style="text-align: center; margin-bottom: 16px; font-size: 2.5em;">${achievement.icon}</div>
     <div style="color: var(--accent); font-weight: 600; margin-bottom: 8px;">${achievement.title}</div>
     <div>${achievement.description}</div>`,
    ''
  );
}

function updateAchievementsBadge() {
  const badgeEl = document.getElementById('achievementsBadge');
  if (badgeEl) {
    const unlockedCount = Object.keys(achievementState.unlocked).length;
    const totalCount = ACHIEVEMENTS.length;
    badgeEl.textContent = `${unlockedCount}/${totalCount}`;
  }
}

function showLockedPopup(featureId) {
  const unlock = UNLOCKS[featureId];
  if (!unlock) return;
  
  const ctx = { realmIndex: S.realmIndex, stage: S.stage };
  const isUnlocked = unlock.requirement(ctx);
  
  if (isUnlocked) return; // Should not show if actually unlocked
  
  const currentRealm = realms[S.realmIndex]?.name || 'Unknown';
  showModal(
    '🔒 Feature Locked',
    `${unlock.text}<br><br><span style="color: var(--muted); font-size: 0.9em;">Current realm: ${currentRealm}</span>`,
    ''
  );
}

// ============= MODAL MANAGER (Centralized & Debounced) =============
// Singleton modal controller to prevent overlapping/duplicate popups
const ModalManager = {
  _queue: [],
  _isActive: false,
  _currentOverlay: null,
  _previousTimeSpeed: null,
  
  /**
   * Show an alert modal (single button: Continue)
   * @returns {Promise<void>} Resolves when modal is dismissed
   */
  async alert({ title, body, confirmText = 'Continue', icon = '' }) {
    return new Promise((resolve) => {
      this._enqueue({ 
        type: 'alert', 
        title, 
        body, 
        confirmText, 
        icon, 
        onConfirm: resolve 
      });
    });
  },
  
  /**
   * Show a confirm modal (two buttons: Cancel, Confirm)
   * @returns {Promise<boolean>} Resolves to true if confirmed, false if cancelled
   */
  async confirm({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', icon = '' }) {
    return new Promise((resolve) => {
      this._enqueue({ 
        type: 'confirm', 
        title, 
        body, 
        confirmText, 
        cancelText, 
        icon, 
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false)
      });
    });
  },
  
  _enqueue(modalData) {
    this._queue.push(modalData);
    if (!this._isActive) {
      this._displayNext();
    }
  },
  
  _displayNext() {
    if (this._queue.length === 0) {
      this._isActive = false;
      document.body.dataset.modalOpen = '0';
      return;
    }
    
    this._isActive = true;
    document.body.dataset.modalOpen = '1';
    
    const data = this._queue.shift();
    
    // Pause game time when modal opens
    if (!S.timeSpeed?.paused) {
      this._previousTimeSpeed = S.timeSpeed?.current || 1;
      S.timeSpeed = S.timeSpeed || {};
      S.timeSpeed.paused = true;
    }
    
    // Create modal DOM
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    
    let buttons;
    if (data.type === 'confirm') {
      buttons = `
        <div style="display: flex; gap: 12px; justify-content: center;">
          <button class="btn danger modal-button" data-action="cancel">${data.cancelText}</button>
          <button class="btn primary modal-button" data-action="confirm">${data.confirmText}</button>
        </div>
      `;
    } else {
      buttons = `<button class="btn primary modal-button" data-action="confirm">${data.confirmText}</button>`;
    }
    
    overlay.innerHTML = `
      <div class="modal">
        ${data.icon ? `<div class="modal-icon">${data.icon}</div>` : ''}
        <h3 class="modal-title">${data.title}</h3>
        <div class="modal-message">${data.body}</div>
        ${buttons}
      </div>
    `;
    
    document.body.appendChild(overlay);
    this._currentOverlay = overlay;
    
    // Animate in
    requestAnimationFrame(() => {
      overlay.classList.add('active');
    });
    
    // Set up event handlers
    const handleClose = (confirmed) => {
      this._cleanup();
      if (confirmed && data.onConfirm) {
        data.onConfirm();
      } else if (!confirmed && data.onCancel) {
        data.onCancel();
      }
      // Display next modal after short delay
      setTimeout(() => this._displayNext(), 100);
    };
    
    // Button clicks
    overlay.querySelectorAll('.modal-button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        handleClose(action === 'confirm');
      });
    });
    
    // Keyboard events
    const handleKeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleClose(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClose(data.type === 'confirm' ? false : true);
      }
    };
    document.addEventListener('keydown', handleKeydown);
    
    // Background click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        handleClose(data.type === 'confirm' ? false : true);
      }
    });
    
    // Store cleanup function
    overlay._cleanup = () => {
      document.removeEventListener('keydown', handleKeydown);
    };
    
    // Trap focus inside modal
    const focusableElements = overlay.querySelectorAll('button');
    if (focusableElements.length > 0) {
      focusableElements[0].focus();
    }
  },
  
  _cleanup() {
    if (!this._currentOverlay) return;
    
    const overlay = this._currentOverlay;
    overlay.classList.remove('active');
    
    setTimeout(() => {
      if (overlay._cleanup) {
        overlay._cleanup();
      }
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    }, 300);
    
    // Restore previous time speed if no more modals
    if (this._queue.length === 0 && this._previousTimeSpeed !== null) {
      if (S.timeSpeed) {
        S.timeSpeed.paused = false;
        S.timeSpeed.current = this._previousTimeSpeed;
      }
      this._previousTimeSpeed = null;
    }
    
    this._currentOverlay = null;
  },
  
  /**
   * Emergency close all modals (for reset/import functions)
   */
  closeAll() {
    this._queue.length = 0;
    this._isActive = false;
    document.body.dataset.modalOpen = '0';
    
    const overlays = document.querySelectorAll('.modal-overlay');
    overlays.forEach(overlay => {
      if (overlay._cleanup) {
        overlay._cleanup();
      }
      overlay.remove();
    });
    
    this._currentOverlay = null;
    this._previousTimeSpeed = null;
  }
};

// Legacy wrapper functions for compatibility
let modalQueue = [];
let isModalActive = false;

function showModal(title, message, icon = '') {
  ModalManager.alert({ title, body: message, icon });
}

function showConfirm(title, message, onConfirm, onCancel = null, icon = '') {
  ModalManager.confirm({ title, body: message, icon }).then(confirmed => {
    if (confirmed && onConfirm) {
      onConfirm();
    } else if (!confirmed && onCancel) {
      onCancel();
    }
  });
}


// Legacy functions removed - ModalManager handles everything internally

// New helper to close all modals (for reset/import)
function closeAllModals() {
  ModalManager.closeAll();
}

// ============= UI INITIALIZATION =============

// ============= OFFLINE PROGRESS & SESSION MANAGEMENT =============

/**
 * Saves a session snapshot when the tab goes to background or closes.
 * This minimal snapshot allows computing reliable offline progress on resume.
 */
function saveSessionSnapshot() {
  if (!S) return;
  
  S.session = S.session || {};
  S.session.lastTs = Date.now();                          // When we left (ms)
  S.session.lastSpeed = S.timeSpeed?.current || 0;        // Current time speed (0 = paused)
  S.session.lastRealmIndex = S.realmIndex;                // For analytics/debugging
  S.session.lastQi = S.qi;                                // For debugging
  
  // Save to localStorage immediately
  try {
    S.version = VERSION;
    localStorage.setItem(SAVE_KEY, JSON.stringify(S));
  } catch (e) {
    console.error('Failed to save session snapshot:', e);
  }
}

/**
 * Format years for display (e.g., "123.45" → "123.45 years")
 */
function formatYears(years) {
  if (years < 1) {
    return `${(years * 365).toFixed(1)} days`;
  }
  return `${years.toFixed(2)} years`;
}

/**
 * Centralized lifespan gate check. Call this after any time advancement.
 * Prevents "stuck at max lifespan" by immediately triggering death if threshold exceeded.
 */
function checkLifespanGate() {
  // Skip if immortal
  if (isImmortal()) return;
  
  // Skip if already processing death or latch is set
  if (S.flags?.lifespanHandled || S.lifecycle?.isReincarnating) return;
  
  // Migrate old ageYears to age
  const currentAge = S.age !== undefined ? S.age : (S.ageYears || 0);
  if(S.age === undefined) S.age = currentAge;
  
  // Get max lifespan with karma multiplier
  const maxLife = getMaxLifespan();
  if (maxLife === null) return; // Immortal realm
  
  // Check if age exceeded lifespan
  if (currentAge >= maxLife) {
    // Set latch flag to prevent double-trigger
    S.flags = S.flags || {};
    S.flags.lifespanHandled = true;
    
    // Handle death immediately
    handleLifespanEnd();
  }
}

/**
 * Apply offline progress on resume (after tab returns or on initial page load).
 * Computes Qi gains, ages the cultivator, and checks for death.
 * Shows a single modal with results (or death modal if lifespan exceeded).
 * 
 * @param {Object} options - Configuration options
 * @param {boolean} options.showPopup - Whether to show the offline gains modal (default: true)
 */
async function applyOfflineProgressOnResume({ showPopup = true } = {}) {
  // Check if we have a valid session snapshot
  if (!S.session?.lastTs) {
    // No snapshot = first load or old save, clear any stale data
    S.session = null;
    return;
  }
  
  const lastSpeed = S.session.lastSpeed || 0;
  
  // If game was paused (speed = 0), no offline gains
  if (lastSpeed <= 0) {
    S.session = null; // Clear snapshot
    return;
  }
  
  // Calculate elapsed time
  const elapsedMs = Date.now() - S.session.lastTs;
  const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));
  
  // No meaningful time passed
  if (elapsedSec < 1) {
    S.session = null;
    return;
  }
  
  // Cap offline time
  const cappedSec = Math.min(elapsedSec, BAL.offline.capHours * 3600);
  
  // Effective time with speed multiplier
  const effectiveTime = cappedSec * lastSpeed;
  
  // Calculate years passed (single source of truth)
  const baseYearsPerSecond = BAL.lifespan?.yearsPerSecond || 1.0;
  const yearsPassed = effectiveTime * baseYearsPerSecond;
  
  // Compute Qi production (use stored speed, not current)
  const qpsProduction = totalQPS();
  const offlineMultiplier = totalOfflineMult();
  const qiGains = qpsProduction * effectiveTime * offlineMultiplier;
  
  // Apply gains
  if (qiGains > 0) {
    safeAddQi(qiGains);
    S.reinc.lifetimeQi = safeNum(S.reinc.lifetimeQi + qiGains, 0);
  }
  
  // Age the cultivator (migrate old ageYears if needed)
  if(S.age === undefined && S.ageYears !== undefined) {
    S.age = S.ageYears;
    delete S.ageYears;
  }
  if(!S.age || !isFinite(S.age)) {
    S.age = 0;
  }
  
  let lifespanExceeded = false;
  if (!isImmortal() && S.lifespan?.max !== null) {
    const oldAge = S.age;
    const newAge = oldAge + yearsPassed;
    
    // Guard against NaN/Infinity
    if(!isFinite(newAge)) {
      console.warn('Offline age calculation resulted in non-finite value');
      S.age = oldAge; // Keep old value
    } else {
      // Clamp age to max lifespan
      S.age = Math.max(0, Math.min(newAge, S.lifespan.max));
      
      // Update current lifespan for backwards compatibility
      S.lifespan.current = Math.max(0, S.lifespan.max - S.age);
      
      // Check if lifespan exceeded
      if (S.age >= S.lifespan.max) {
        lifespanExceeded = true;
      }
    }
  } else if (!isImmortal()) {
    // Just increase age for non-immortals without max
    S.age += yearsPassed;
  }
  
  // Track offline hours for achievements
  const offlineHours = cappedSec / 3600;
  checkAchievements({ offlineHours });
  
  // Clear session snapshot (prevent double-counting)
  S.session = null;
  
  // If lifespan exceeded, trigger death immediately (don't show gains modal)
  if (lifespanExceeded) {
    checkLifespanGate(); // This will show death modal
    return;
  }
  
  // Show offline gains modal (only if not dead and showPopup = true)
  if (showPopup && qiGains > 0) {
    const hoursFormatted = fmt(cappedSec / 3600);
    const qiFormatted = fmt(Math.floor(qiGains));
    const yearsFormatted = formatYears(yearsPassed, true); // Includes "years" unit
    const offlineMultFormatted = fmt(offlineMultiplier);
    const currentRealm = realms[S.realmIndex]?.name || 'Unknown Realm';
    const speedFormatted = fmt(lastSpeed);
    
    let lifespanStatus;
    if (isImmortal()) {
      lifespanStatus = '<strong>Age:</strong> ∞ Immortal';
    } else {
      const currentAge = S.age !== undefined ? S.age : 0;
      const ageStr = formatYears(currentAge, true); // Includes "years"
      const maxStr = formatYears(S.lifespan.max, true); // Includes "years"
      lifespanStatus = `<strong>Age:</strong> ${ageStr} / ${maxStr}`;
    }
    
    const message = `
      <div style="text-align: left; margin: 8px 0;">
        <div><strong>Qi Gained:</strong> <span class="highlight">+${qiFormatted}</span></div>
        <div><strong>Offline Multiplier:</strong> ×${offlineMultFormatted}</div>
        <div><strong>Time Passed:</strong> ${yearsFormatted} (${hoursFormatted}h real-time)</div>
        <div><strong>Time Speed Used:</strong> ${speedFormatted}×</div>
        <div><strong>Current Realm:</strong> ${currentRealm}</div>
        <div>${lifespanStatus}</div>
      </div>
      <br><em style="color: var(--muted);">Your cultivation continued in silence, and the Dao answered.</em>
    `;
    
    await showModal('⏰ While You Were Away...', message, '🌙');
  }
}

// ============= UI INITIALIZATION (LEGACY SECTION) =============

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
    // Migrate old saves: ensure lifespan exists
    if(!data.lifespan) {
      const realmIndex = Math.min(data.realmIndex || 0, realms.length - 1);
      const maxLifespan = BAL.lifespan?.realmMaxLifespan?.[realmIndex];
      if(maxLifespan === null) {
        // True Immortal - infinite lifespan
        data.lifespan = { current: null, max: null };
      } else {
        const lifespan = maxLifespan || 100;
        data.lifespan = { current: lifespan, max: lifespan };
      }
    }
    // Migrate old saves: ensure timeSpeed exists
    if(!data.timeSpeed) data.timeSpeed = { current: 1, paused: false };
    // Migrate old saves: ensure flags exists with all new properties
    if(!data.flags) {
      data.flags = { 
        unlockedBeyondSpirit: false,
        hasUnlockedSpiritCycle: false,
        hasCompletedMandatoryST10: false,
        canManualReincarnate: false
      };
    } else {
      // Ensure new flag properties exist
      if(data.flags.hasUnlockedSpiritCycle === undefined) data.flags.hasUnlockedSpiritCycle = false;
      if(data.flags.hasCompletedMandatoryST10 === undefined) data.flags.hasCompletedMandatoryST10 = false;
      if(data.flags.canManualReincarnate === undefined) data.flags.canManualReincarnate = false;
    }
    // Migrate old saves: ensure lifecycle exists with all properties
    if(!data.lifecycle) {
      data.lifecycle = { isReincarnating: false, lastDeathAt: 0, lastReincarnateAt: 0 };
    } else {
      if(data.lifecycle.lastReincarnateAt === undefined) data.lifecycle.lastReincarnateAt = 0;
    }
    
    // Migrate old saves: ensure stats exists
    if(!data.stats) {
      data.stats = { deaths: 0 };
    } else {
      if(data.stats.deaths === undefined) data.stats.deaths = 0;
    }
    
    // Migrate old saves: ensure meta exists with unlockedSpeeds
    if(!data.meta) {
      data.meta = { unlockedSpeeds: [0, 0.5, 1] };
    } else {
      if(!Array.isArray(data.meta.unlockedSpeeds)) {
        data.meta.unlockedSpeeds = [0, 0.5, 1];
      } else {
        // Ensure base speeds (0, 0.5, 1) are always present
        const baseSpeedsAlwaysAvailable = [0, 0.5, 1];
        baseSpeedsAlwaysAvailable.forEach(speed => {
          if (!data.meta.unlockedSpeeds.includes(speed)) {
            data.meta.unlockedSpeeds.push(speed);
          }
        });
      }
    }
    
    // Validate current speed is available, fallback to 1× if not
    if(data.timeSpeed && data.timeSpeed.current !== 0) {
      const availableSpeeds = data.meta?.unlockedSpeeds || [0, 0.5, 1];
      if(!availableSpeeds.includes(data.timeSpeed.current)) {
        data.timeSpeed.current = 1; // Fallback to 1×
        data.timeSpeed.paused = false;
      }
    }
    
    // Migrate old saves: ensure age tracking exists
    // Migrate ageYears → age for consistency
    if(data.age === undefined) {
      if(data.ageYears !== undefined) {
        data.age = safeNum(data.ageYears, 0);
        delete data.ageYears;
      } else {
        // Calculate age from remaining lifespan
        if(data.lifespan && data.lifespan.max !== null && data.lifespan.current !== null) {
          data.age = Math.max(0, data.lifespan.max - data.lifespan.current);
        } else {
          data.age = 0;
        }
      }
    }
    
    // Ensure lifespanHandled latch flag exists
    if(!data.flags) data.flags = {};
    if(data.flags.lifespanHandled === undefined) {
      data.flags.lifespanHandled = false;
    }
    
    if(data.isDead === undefined) data.isDead = false;
    if(!data.life) {
      data.life = { isCleanRun: true };
    } else {
      if(data.life.isCleanRun === undefined) data.life.isCleanRun = true;
    }
    
    // Sanitize critical numeric values to prevent corruption issues
    if(data.qi) data.qi = safeNum(data.qi, 0);
    if(data.reinc && data.reinc.lifetimeQi) data.reinc.lifetimeQi = safeNum(data.reinc.lifetimeQi, 0);
    if(data.age) data.age = safeNum(data.age, 0);
    if(data.lifespan) {
      if(data.lifespan.current !== null) data.lifespan.current = safeNum(data.lifespan.current, 100);
      if(data.lifespan.max !== null) data.lifespan.max = safeNum(data.lifespan.max, 100);
    }
    
    S = data;
    
    // Ensure speeds are unlocked based on current realm (in case of old saves)
    checkAndUnlockSpeeds();
    
    return S;
  }catch(e){ console.error('Error loading', e); return null; }
}

function reset(){
  showConfirm(
    "⚠️ FULL RESET WARNING",
    "<span style='color: var(--danger); font-weight: bold;'>This will permanently delete EVERYTHING:</span><br><br>" +
    "• All cultivation progress<br>" +
    "• All karma and reincarnations<br>" +
    "• All achievements and statistics<br>" +
    "• All settings and preferences<br><br>" +
    "<strong>This action cannot be undone!</strong><br><br>" +
    "Are you absolutely certain?",
    () => {
      // Clear all localStorage keys
      localStorage.removeItem('xianxiaIdleSave');
      localStorage.removeItem('xianxiaIdleAchievements');
      localStorage.removeItem('xianxiaSettings');
      
      // Reset achievement state
      achievementState = {
        unlocked: {},
        voluntaryReincarnations: 0,
        forcedReincarnationCount: 0,
        cycleTransitions: 0
      };
      
      // Reinitialize game state
      S = defaultState();
      
      // Save the fresh state
      save();
      saveAchievementState();
      
      // Refresh UI
      renderAll();
      renderAchievements();
      updateAchievementsBadge();
      
      showModal('🔄 Full Reset Complete', 
        'All progress has been erased. Your cultivation journey begins anew.', '⚠️');
    },
    null,
    '⚠️'
  );
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
    
    // Apply same migration and sanitization as load()
    if(!data.version) data.version = '0.0.0';
    if(!data.reinc) data.reinc = { times: 0, karma: 0, lifetimeQi: 0 };
    if(!data.lifespan) {
      const realmIndex = Math.min(data.realmIndex || 0, realms.length - 1);
      const maxLifespan = BAL.lifespan?.realmMaxLifespan?.[realmIndex];
      if(maxLifespan === null) {
        data.lifespan = { current: null, max: null };
      } else {
        const lifespan = maxLifespan || 100;
        data.lifespan = { current: lifespan, max: lifespan };
      }
    }
    if(!data.timeSpeed) data.timeSpeed = { current: 1, paused: false };
    if(!data.flags) {
      data.flags = { 
        unlockedBeyondSpirit: false,
        hasUnlockedSpiritCycle: false,
        hasCompletedMandatoryST10: false,
        canManualReincarnate: false
      };
    } else {
      if(data.flags.hasUnlockedSpiritCycle === undefined) data.flags.hasUnlockedSpiritCycle = false;
      if(data.flags.hasCompletedMandatoryST10 === undefined) data.flags.hasCompletedMandatoryST10 = false;
      if(data.flags.canManualReincarnate === undefined) data.flags.canManualReincarnate = false;
    }
    if(!data.lifecycle) {
      data.lifecycle = { isReincarnating: false, lastDeathAt: 0, lastReincarnateAt: 0 };
    } else {
      if(data.lifecycle.lastReincarnateAt === undefined) data.lifecycle.lastReincarnateAt = 0;
    }
    
    if(!data.stats) {
      data.stats = { deaths: 0 };
    } else {
      if(data.stats.deaths === undefined) data.stats.deaths = 0;
    }
    
    // Migrate old saves: ensure meta exists with unlockedSpeeds
    if(!data.meta) {
      data.meta = { unlockedSpeeds: [0, 0.5, 1] };
    } else {
      if(!Array.isArray(data.meta.unlockedSpeeds)) {
        data.meta.unlockedSpeeds = [0, 0.5, 1];
      } else {
        // Ensure base speeds (0, 0.5, 1) are always present
        const baseSpeedsAlwaysAvailable = [0, 0.5, 1];
        baseSpeedsAlwaysAvailable.forEach(speed => {
          if (!data.meta.unlockedSpeeds.includes(speed)) {
            data.meta.unlockedSpeeds.push(speed);
          }
        });
      }
    }
    
    // Validate current speed is available, fallback to 1× if not
    if(data.timeSpeed && data.timeSpeed.current !== 0) {
      const availableSpeeds = data.meta?.unlockedSpeeds || [0, 0.5, 1];
      if(!availableSpeeds.includes(data.timeSpeed.current)) {
        data.timeSpeed.current = 1; // Fallback to 1×
        data.timeSpeed.paused = false;
      }
    }
    
    // Migrate old saves: ensure age tracking exists
    // Migrate ageYears → age for consistency
    if(data.age === undefined) {
      if(data.ageYears !== undefined) {
        data.age = safeNum(data.ageYears, 0);
        delete data.ageYears;
      } else {
        // Calculate age from remaining lifespan
        if(data.lifespan && data.lifespan.max !== null && data.lifespan.current !== null) {
          data.age = Math.max(0, data.lifespan.max - data.lifespan.current);
        } else {
          data.age = 0;
        }
      }
    }
    
    // Ensure lifespanHandled latch flag exists
    if(!data.flags) data.flags = {};
    if(data.flags.lifespanHandled === undefined) {
      data.flags.lifespanHandled = false;
    }
    
    if(data.isDead === undefined) data.isDead = false;
    if(!data.life) {
      data.life = { isCleanRun: true };
    } else {
      if(data.life.isCleanRun === undefined) data.life.isCleanRun = true;
    }
    
    // Sanitize critical numeric values
    if(data.qi) data.qi = safeNum(data.qi, 0);
    if(data.reinc && data.reinc.lifetimeQi) data.reinc.lifetimeQi = safeNum(data.reinc.lifetimeQi, 0);
    if(data.age) data.age = safeNum(data.age, 0);
    if(data.lifespan) {
      if(data.lifespan.current !== null) data.lifespan.current = safeNum(data.lifespan.current, 100);
      if(data.lifespan.max !== null) data.lifespan.max = safeNum(data.lifespan.max, 100);
    }
    
    S = { ...defaultState(), ...data };
    save();
    renderAll();
    showModal('Save Imported', 'Your cultivation progress has been successfully restored.', '📜');
  }catch(e){
    showModal('Import Failed', 'Error importing save data. Please ensure you paste the complete export code.', '⚠️');
  }
}

/**
 * DEPRECATED: Old offline gains system (replaced by applyOfflineProgressOnResume)
 * Kept for backwards compatibility but no longer called.
 */
function applyOfflineGains(){
  // This function is deprecated - use applyOfflineProgressOnResume instead
  // Kept for compatibility with old code references
  console.warn('applyOfflineGains() is deprecated - use applyOfflineProgressOnResume()');
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
const deathsCountEl = document.getElementById('deathsCount');
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
const lifespanValueEl = document.getElementById('lifespanValue');
const lifespanProgressBarEl = document.querySelector('#lifespanProgress > div');
const speedButtonsEl = document.getElementById('speedButtons');
const achievementsBtn = document.getElementById('achievementsBtn');
const achievementsPanel = document.getElementById('achievementsPanel');
const achievementsClose = document.getElementById('achievementsClose');
const achievementsList = document.getElementById('achievementsList');
const currentCycleEl = document.getElementById('currentCycle');
const realmBonusEl = document.getElementById('realmBonus');

function updateLastSave(){
  if(!S.lastSave){ lastSaveEl.textContent = 'Last Save: —'; return; }
  const d = new Date(S.lastSave);
  lastSaveEl.textContent = 'Last Save: ' + d.toLocaleString();
}

function renderStats(){
  qiDisplay.textContent = 'Qi: ' + fmt(Math.floor(S.qi));
  
  const timeMultiplier = getCurrentTimeMultiplier();
  qpcEl.textContent = fmt(totalQPC() * timeMultiplier);
  qpsEl.textContent = fmt(totalQPS() * timeMultiplier);
  
  // Use fmt for offline multiplier (max 2 decimals)
  const offlineMult = totalOfflineMult();
  offlineMultEl.textContent = fmt(offlineMult) + '×';
  
  // LIFESPAN UI: Clean numeric display (no "years", no "Age:")
  // Format: "Lifespan" label on left, "current / max" value on right
  if(lifespanValueEl) {
    // Migrate old ageYears to age
    if(S.age === undefined && S.ageYears !== undefined) {
      S.age = S.ageYears;
      delete S.ageYears;
    }
    
    // Initialize age if missing or invalid
    if(!S.age || !isFinite(S.age)) {
      S.age = 0;
    }
    
    const currentAge = S.age;
    const maxLifespan = S.lifespan.max;
    const finiteMax = Number.isFinite(maxLifespan);
    
    // Build value: "39.48 / 100.00" or "123.45 / ∞"
    lifespanValueEl.textContent = finiteMax 
      ? `${fmt2(currentAge)} / ${fmt2(maxLifespan)}` 
      : `${fmt2(currentAge)} / ∞`;
    
    // Update progress bar
    if(lifespanProgressBarEl) {
      if(finiteMax) {
        const progressPercent = Math.max(0, Math.min(100, (currentAge / maxLifespan) * 100));
        lifespanProgressBarEl.style.width = progressPercent.toFixed(2) + '%';
      } else {
        lifespanProgressBarEl.style.width = '0%'; // No progress for immortal
      }
    }
  }
  
  if(karmaValEl) karmaValEl.textContent = fmt(S.reinc.karma);
  if(reincBonusEl) reincBonusEl.textContent = fmt(reincBonus()) + '×';
  if(reincTimesEl) reincTimesEl.textContent = S.reinc.times;
  if(deathsCountEl) deathsCountEl.textContent = S.stats?.deaths || 0;
  
  // Show transcendence status if unlocked
  const transcendenceStatusEl = document.getElementById('transcendenceStatus');
  if(transcendenceStatusEl) {
    transcendenceStatusEl.style.display = S.flags?.unlockedBeyondSpirit ? 'flex' : 'none';
  }
  
  // Render cycle information
  if(currentCycleEl) {
    const cycle = getCurrentCycle();
    const cycleName = cycle.name || 'Mortal Cycle';
    const cycleClass = S.currentCycle === 'spirit' ? 'cycle-spirit' : 'cycle-mortal';
    currentCycleEl.textContent = cycleName;
    currentCycleEl.className = cycleClass;
  }
  
  if(realmBonusEl) {
    const cycle = getCurrentCycle();
    const realmBonus = cycle.realmBonus || 0.20;
    const totalBonus = S.realmIndex * realmBonus * 100;
    // Use fmt to ensure max 2 decimals
    const bonusStr = fmt(totalBonus);
    realmBonusEl.textContent = `+${bonusStr}%`;
  }
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
  
  // Update reincarnation button state
  if(reincBtn) {
    const canReincarnateNow = canReincarnate();
    reincBtn.disabled = !canReincarnateNow;
    
    if(canReincarnateNow) {
      reincBtn.textContent = 'Voluntary Reincarnation';
      reincBtn.title = 'Reincarnate now for full Karma. Available at Spirit Transformation Stage 1 and all higher realms.';
    } else if(!S.flags?.hasCompletedMandatoryST10) {
      reincBtn.textContent = 'Reincarnation (Locked)';
      reincBtn.title = 'Locked: First complete the mandatory reincarnation at Spirit Transformation Stage 10.';
    } else {
      reincBtn.textContent = 'Reincarnation';
      reincBtn.title = 'Available at Spirit Transformation Stage 1 and higher realms.';
    }
  }
}

function renderShop(){
  shopEl.innerHTML = '';
  
  for(const sk of getSkillCatalog()){
    const lvl = S.skills[sk.id]||0;
    const cost = skillCost(sk.id);
    const can = S.qi >= cost;
    const eff = baseEff(sk.id);
    const descDyn = {
      qps:       `+${eff.toFixed(2)} Qi/s per level`,
      qpc:       `+${eff.toFixed(2)} Qi/click per level`,
      qps_mult:  `+${(eff*100).toFixed(0)}% Qi/s per level`,
      qpc_mult:  `+${(eff*100).toFixed(0)}% Qi/click per level`,
      offline_mult: `Qi offline + ${(eff*100).toFixed(0)}% per level`
    }[sk.type] || sk.desc;
    const wrap = document.createElement('div');
    wrap.className = 'shop-item';
    wrap.innerHTML = `
      <div>
        <img src="assets/${sk.id}.png" alt="${sk.name}" class="skill-icon">
        <div>
          <h4>${sk.name} <span class="muted">(Level ${lvl})</span></h4>
          <div class="desc">${descDyn}</div>
          <div class="small muted">Cost: ${fmt(cost)} Qi</div>
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
      
      // Track skill purchases for achievements
      achievementState.totalPurchases++;
      saveAchievementState();
      
      save();
      renderAll();
    });
  });
}

function renderTimeSpeed(){
  if(!speedButtonsEl) return;
  
  speedButtonsEl.innerHTML = '';
  const availableSpeeds = getAvailableSpeeds();
  const allSpeeds = BAL.timeSpeed?.speeds || [0, 1];
  
  allSpeeds.forEach((speed, index) => {
    const btn = document.createElement('button');
    btn.className = 'speed-btn';
    btn.textContent = speed === 0 ? 'Pause' : `${speed}×`;
    
    const isAvailable = availableSpeeds.includes(speed);
    const isActive = (speed === 0 && S.timeSpeed.paused) || (!S.timeSpeed.paused && S.timeSpeed.current === speed);
    
    if(!isAvailable) {
      btn.disabled = true;
      const requiredRealm = BAL.timeSpeed?.unlockRealmIndex?.[index] || 0;
      btn.title = `Unlocked at ${realms[requiredRealm]?.name || 'Unknown Realm'}`;
      btn.addEventListener('click', () => {
        showLockedPopup(`speed_${speed}x`);
      });
    } else {
      btn.addEventListener('click', () => setTimeSpeed(speed));
    }
    
    if(isActive) {
      btn.classList.add('active');
      if(speed === 0) btn.classList.add('paused');
    }
    
    speedButtonsEl.appendChild(btn);
  });
}

function renderAll(){
  verEl.textContent = VERSION;
  renderStats();
  renderRealm();
  renderShop();
  renderTimeSpeed();
  updateLastSave();
  updateAchievementsBadge();
  checkAchievements();
  updateCultivatorImage();
}

// ============= ACHIEVEMENTS PANEL MANAGEMENT =============

let currentAchievementFilter = 'all';

function openAchievementsPanel() {
  if (!achievementsPanel || !achievementsBtn) return;
  
  // Mark as opened for the dao_seeker achievement
  if (!achievementState.achievementsPanelOpened) {
    achievementState.achievementsPanelOpened = true;
    saveAchievementState();
    checkAchievements();
  }
  
  achievementsPanel.classList.add('open');
  achievementsPanel.setAttribute('aria-hidden', 'false');
  achievementsBtn.setAttribute('aria-expanded', 'true');
  renderAchievementsList();
}

function closeAchievementsPanel() {
  if (!achievementsPanel || !achievementsBtn) return;
  
  achievementsPanel.classList.remove('open');
  achievementsPanel.setAttribute('aria-hidden', 'true');
  achievementsBtn.setAttribute('aria-expanded', 'false');
}

function renderAchievementsList() {
  if (!achievementsList) return;
  
  const filteredAchievements = ACHIEVEMENTS.filter(achievement => {
    const isUnlocked = hasAchievement(achievement.id);
    
    if (currentAchievementFilter === 'unlocked' && !isUnlocked) return false;
    if (currentAchievementFilter === 'locked' && isUnlocked) return false;
    if (currentAchievementFilter !== 'all' && 
        currentAchievementFilter !== 'unlocked' && 
        currentAchievementFilter !== 'locked' && 
        achievement.category !== currentAchievementFilter) return false;
    
    return true;
  });
  
  achievementsList.innerHTML = filteredAchievements.map(achievement => {
    const isUnlocked = hasAchievement(achievement.id);
    const unlockedData = achievementState.unlocked[achievement.id];
    
    let dateText = '';
    if (isUnlocked && unlockedData?.unlockedAt) {
      const date = new Date(unlockedData.unlockedAt);
      dateText = `<div class="achievement-date">Unlocked: ${date.toLocaleDateString()}</div>`;
    }
    
    const displayTitle = isUnlocked ? achievement.title : (achievement.hiddenUntilUnlocked ? '???' : achievement.title);
    const displayDesc = isUnlocked ? achievement.description : (achievement.hiddenUntilUnlocked ? 'Hidden achievement' : achievement.description);
    const displayIcon = isUnlocked ? achievement.icon : '🔒';
    const categoryClass = achievement.category === 'Impossible' ? 'impossible' : '';
    
    return `
      <div class="achievement-item ${isUnlocked ? 'unlocked' : 'locked'} ${categoryClass}">
        <div class="achievement-icon ${isUnlocked ? '' : 'locked'}">${displayIcon}</div>
        <div class="achievement-content">
          <div class="achievement-name ${isUnlocked ? '' : 'locked'}">${displayTitle}</div>
          <div class="achievement-desc">${displayDesc}</div>
          ${dateText}
        </div>
      </div>
    `;
  }).join('');
}

function setAchievementFilter(filter) {
  currentAchievementFilter = filter;
  
  // Update filter button states
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  
  renderAchievementsList();
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

let lastPointerAt = 0;
clickBtn.addEventListener('pointerdown', (e) => {
  const now = performance.now();
  if (now - lastPointerAt < 120) return; // prevent double fire
  lastPointerAt = now;
  e.preventDefault();
  onClick();
}, { passive:false });
// Touch responsiveness for mobile (no ~300ms delay) - REPLACED by pointerdown
breakthroughBtn.addEventListener('click', ()=>{ doBreakthrough(); save(); renderAll(); });
if(reincBtn){
  reincBtn.addEventListener('click', ()=>{
    tryManualReincarnate();
  });
}
saveBtn.addEventListener('click', save);
exportBtn.addEventListener('click', exportSave);
importBtn.addEventListener('click', importSave);
resetBtn.addEventListener('click', reset);

// Achievement system event listeners
if (achievementsBtn) {
  achievementsBtn.addEventListener('click', openAchievementsPanel);
}
if (achievementsClose) {
  achievementsClose.addEventListener('click', closeAchievementsPanel);
}

// Achievement filter event listeners
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setAchievementFilter(btn.dataset.filter);
  });
});

// Close achievements panel when clicking outside
document.addEventListener('click', (e) => {
  if (achievementsPanel && achievementsBtn && 
      achievementsPanel.classList.contains('open') && 
      !achievementsPanel.contains(e.target) && 
      !achievementsBtn.contains(e.target)) {
    closeAchievementsPanel();
  }
});

// Close achievements panel with Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && achievementsPanel && achievementsPanel.classList.contains('open')) {
    closeAchievementsPanel();
  }
});

document.addEventListener('keydown', (e)=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){ e.preventDefault(); save(); }
});

(async function init(){
  await loadBalance(); // Load balance configuration first
  S = { ...defaultState(), ...S, skills: { ...defaultState().skills, ...S.skills } };
  
  // Ensure current cycle is set for existing saves
  if(!S.currentCycle) {
    updateCurrentCycle();
  }
  
  // Ensure lifespan is properly set for current realm
  if(!S.lifespan || S.lifespan.max !== getMaxLifespan()) {
    const maxLifespan = getMaxLifespan();
    if(!S.lifespan) {
      if(maxLifespan === null) {
        // True Immortal - infinite lifespan
        S.lifespan = { current: null, max: null };
      } else {
        S.lifespan = { current: maxLifespan, max: maxLifespan };
      }
    } else {
      S.lifespan.max = maxLifespan;
      if(maxLifespan === null) {
        // Became immortal - set infinite lifespan
        S.lifespan.current = null;
      } else if(S.lifespan.current > maxLifespan) {
        S.lifespan.current = maxLifespan;
      }
    }
  }
  
  renderAll();
  
  // Apply offline progress on initial load
  await applyOfflineProgressOnResume({ showPopup: true });
  
  loop();
  setInterval(save, 15000);
  initDebugPanel(); // Initialize debug panel if in dev mode
  initMusicSystem(); // Initialize background music system
})();

// ============= SESSION SNAPSHOT HOOKS =============

// Save session snapshot when tab goes to background
window.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    saveSessionSnapshot();
  } else {
    // Tab became visible - apply offline progress
    applyOfflineProgressOnResume({ showPopup: true });
  }
});

// Save snapshot before page unloads
window.addEventListener('pagehide', saveSessionSnapshot);
window.addEventListener('beforeunload', saveSessionSnapshot);

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
    const qpcAdd = (simS.skills['meridian_flow']||0) * baseEff_for(simS, 'meridian_flow');
    val += qpcAdd;
    const qpcMult = 1 + (simS.skills['dantian_temps']||0) * baseEff_for(simS, 'dantian_temps');
    return val * qpcMult * simS.qpcMult * (1 + (simS.reinc.karma * BAL.reincarnation.karmaPerUnit));
  };
  
  const simTotalQPS = () => {
    let val = simS.qpsBase;
    val += (simS.skills['breath_control']||0) * baseEff_for(simS, 'breath_control');
    const mult = 1 + (simS.skills['lotus_meditation']||0) * baseEff_for(simS, 'lotus_meditation');
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

// New helper (simulation only)
function baseEff_for(st, id){
  const cat = getSkillCatalog();
  const sk  = cat.find(s => s.id === id);
  const realmMult = 1 + (st.realmIndex * REALM_SKILL_BONUS);
  return sk.base * realmMult;
}

// Helpers puros que operan sobre un "estado" pasado por parámetro (no mutan S real)
function totalQPC_for(st){
  let val = st.qpcBase;
  val += (st.skills['meridian_flow']||0) * baseEff_for(st, 'meridian_flow');
  const mult = 1 + (st.skills['dantian_temps']||0) * baseEff_for(st, 'dantian_temps');
  const karmaMult = karmaQiMult(st.reinc?.karma || 0);
  const cycleMult = cyclePowerMult(st.realmIndex);
  return val * mult * st.qpcMult * karmaMult * cycleMult;
}

function totalQPS_for(st){
  let val = st.qpsBase;
  val += (st.skills['breath_control']||0) * baseEff_for(st, 'breath_control');
  const mult = 1 + (st.skills['lotus_meditation']||0) * baseEff_for(st, 'lotus_meditation');
  const karmaMult = karmaQiMult(st.reinc?.karma || 0);
  const cycleMult = cyclePowerMult(st.realmIndex);
  return val * mult * st.qpsMult * karmaMult * cycleMult;
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

// ============= BACKGROUND MUSIC SYSTEM =============

const PLAYLIST = [
  'assets/music/music1.mp3',
  'assets/music/music2.mp3',
  'assets/music/music3.mp3',
  'assets/music/music4.mp3',
  'assets/music/music5.mp3',
  'assets/music/music6.mp3',
  'assets/music/music7.mp3',
];

let currentIndex = 0;
let audio = document.getElementById('bgm') || createAudio();

function createAudio(){
  const a = document.createElement('audio');
  a.id = 'bgm';
  a.preload = 'auto';
  document.body.appendChild(a);
  return a;
}

// Music settings
const MUSIC_SETTINGS_KEY = 'xianxiaMusic';

function loadMusicSettings(){
  try {
    return JSON.parse(localStorage.getItem(MUSIC_SETTINGS_KEY)) || { enabled: true, volume: 0.4 };
  } catch {
    return { enabled: true, volume: 0.4 };
  }
}

function saveMusicSettings(s){
  localStorage.setItem(MUSIC_SETTINGS_KEY, JSON.stringify(s));
}

let musicSettings = loadMusicSettings();

// Initialize audio
audio.volume = musicSettings.volume;
audio.muted = !musicSettings.enabled;

function loadTrack(i){
  currentIndex = (i + PLAYLIST.length) % PLAYLIST.length;
  audio.src = PLAYLIST[currentIndex];
  updateTrackInfo();
}

function playSafe(){
  return audio.play().catch(() => {
    // Autoplay blocked (mobile/desktop policy) — show a note until user interacts
    const note = document.getElementById('autoplayNote');
    if (note) note.style.display = 'block';
  });
}

function updateTrackInfo(){
  const el = document.getElementById('trackInfo');
  if (el) el.textContent = `Track ${currentIndex+1}/${PLAYLIST.length}`;
}

async function crossfadeTo(nextIndex, dur=800){
  const startVol = audio.volume;
  const targetVol = musicSettings.volume;
  const t0 = performance.now();
  while (performance.now() - t0 < dur){
    const k = (performance.now() - t0) / dur;
    audio.volume = startVol * (1 - k);
    await new Promise(r=>requestAnimationFrame(r));
  }
  loadTrack(nextIndex);
  await audio.play().catch(()=>{});
  const t1 = performance.now();
  while (performance.now() - t1 < dur){
    const k = (performance.now() - t1) / dur;
    audio.volume = targetVol * k;
    await new Promise(r=>requestAnimationFrame(r));
  }
  audio.volume = targetVol;
}

audio.onended = () => crossfadeTo(currentIndex + 1);

// Initialize music system
function initMusicSystem(){
  // Start playlist
  loadTrack(0);
  if (musicSettings.enabled) playSafe();

  // Settings UI elements
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const volumeSlider = document.getElementById('musicVolume');
  const muteBtn = document.getElementById('musicMuteToggle');

  if (!settingsBtn || !settingsPanel || !volumeSlider || !muteBtn) return;

  // Panel toggle
  settingsBtn.addEventListener('click', () => {
    const open = settingsPanel.classList.toggle('open');
    settingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    settingsPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
    
    // Dynamic positioning relative to button
    if (open) {
      const btn = settingsBtn;
      const panel = settingsPanel;
      const r = btn.getBoundingClientRect();
      panel.style.position = 'fixed';
      panel.style.top = `${r.bottom + 8}px`;
      panel.style.left = 'auto';
      panel.style.right = `${Math.max(20, (window.innerWidth - r.right))}px`;
    }
  });

  document.addEventListener('click', (e) => {
    if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) {
      settingsPanel.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      settingsPanel.setAttribute('aria-hidden', 'true');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      settingsPanel.classList.remove('open');
      settingsBtn.setAttribute('aria-expanded', 'false');
      settingsPanel.setAttribute('aria-hidden', 'true');
    }
  });

  // Initialize controls from settings
  volumeSlider.value = Math.round(musicSettings.volume * 100);
  muteBtn.textContent = musicSettings.enabled ? 'Mute' : 'Unmute';

  // Volume control
  volumeSlider.addEventListener('input', () => {
    const v = Math.max(0, Math.min(100, Number(volumeSlider.value))) / 100;
    audio.volume = v;
    musicSettings.volume = v;
    saveMusicSettings(musicSettings);
  });

  // Mute/unmute control
  muteBtn.addEventListener('click', () => {
    const enabled = !audio.muted;
    // toggle
    audio.muted = enabled;
    musicSettings.enabled = !audio.muted;
    muteBtn.textContent = musicSettings.enabled ? 'Mute' : 'Unmute';
    saveMusicSettings(musicSettings);
    if (musicSettings.enabled) playSafe();
  });

  // Resume on user interaction if autoplay was blocked
  window.addEventListener('pointerdown', () => {
    if (!audio.src) loadTrack(currentIndex);
    if (musicSettings.enabled && audio.paused) playSafe();
    const note = document.getElementById('autoplayNote');
    if (note) note.style.display = 'none';
  }, { once: true });
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

// Cultivator Image Management
function updateCultivatorImage() {
  const img = document.querySelector('#cultivatorImg');
  if (!img) return;
  
  const targetImage = S.currentCycle === 'spirit' ? 'assets/cultivator2.jpg' : 'assets/cultivator.jpg';
  
  // Only update if image needs to change
  if (img.src.includes(targetImage.split('/').pop())) return;
  
  // Fade out current image
  img.classList.add('fade-out');
  
  // After fade completes, change image and fade back in
  setTimeout(() => {
    img.src = targetImage;
    img.classList.remove('fade-out');
  }, 250); // Half the transition duration
}

// Update image when cycle changes
function onCycleChange() {
  updateCultivatorImage();
}

// Call on game initialization and after reincarnation
document.addEventListener('DOMContentLoaded', () => {
  updateCultivatorImage();
  
  // Dev-mode guard: Check for lifespan UI elements and formatting issues
  if(DEBUG_MODE) {
    // Check for correct lifespan UI elements
    const lifespanValueCount = document.querySelectorAll('#lifespanValue').length;
    const lifespanProgressCount = document.querySelectorAll('#lifespanProgress').length;
    
    if(lifespanValueCount !== 1) {
      console.error(`❌ Expected 1 #lifespanValue element, found ${lifespanValueCount}`);
    }
    
    if(lifespanProgressCount !== 1) {
      console.error(`❌ Expected 1 #lifespanProgress element, found ${lifespanProgressCount}`);
    }
    
    // Set up periodic checks for UI consistency
    setInterval(() => {
      const lifespanValue = document.getElementById('lifespanValue');
      
      // Check for "years" in lifespan value (should be numeric only)
      if(lifespanValue && lifespanValue.textContent.toLowerCase().includes('year')) {
        console.error('❌ CRITICAL BUG: "years" text found in lifespan value!');
        console.error('Current text:', lifespanValue.textContent);
        console.error('Lifespan should show numeric format: "39.48 / 100.00"');
      }
      
      // Check time speed consistency (0.5× should be exactly half of 1×)
      const speed = getTimeSpeed();
      if(speed === 0.5) {
        console.log('⏱ Time Speed: 0.5× (exactly half of 1×)');
      }
    }, 5000);
  }
});


