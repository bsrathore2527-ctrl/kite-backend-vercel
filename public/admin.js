
// admin.js (Clean Rebuild - FINAL)

(function(){

/* ===== 1. Theme Toggle ===== */
function toggleTheme(){
  document.body.classList.toggle("theme-light");
  localStorage.setItem("theme", document.body.classList.contains("theme-light")?"light":"dark");
}
window.toggleTheme = toggleTheme;
if(localStorage.getItem("theme")==="light") document.body.classList.add("theme-light");

/* ===== 2. Tab Switching ===== */
function switchTab(tab){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelector('#page-'+tab).classList.add('active');
  document.querySelectorAll('.top-tabs button').forEach(b=>b.classList.remove('active'));
  document.querySelector('#tab-'+tab).classList.add('active');
  window.activeTab = tab;
  startPolling();
}
window.switchTab = switchTab;

/* ===== 3. Subtabs ===== */
function switchSubTab(which){
  document.querySelectorAll('.subtoggle button').forEach(b=>b.classList.remove('active'));
  if(which==="trade") document.querySelector("#tradeBtn").classList.add("active");
  else document.querySelector("#sellBtn").classList.add("active");
  window.activeSubTab = which;
  loadActiveTradeSection();
}
window.switchSubTab = switchSubTab;
window.activeTab="overview";
window.activeSubTab="trade";

/* ===== 4. State Fetch ===== */
async function fetchState(){
  try{
    const r = await fetch('/api/state'); 
    const s = await r.json();
    if(!s.ok) return;
    updateOverviewUI(s);
  }catch(e){}
}
window.fetchState = fetchState;

function updateOverviewUI(s){
  setTxt('capital_val', fmt(s.capital));
  setTxt('balance_val', fmt(s.balance));
  setTxt('live_mtm', fmt(s.unrealised));
  setTxt('total_pnl', fmt((s.realised||0)+(s.unrealised||0)));
  setTxt('max_loss_val', fmt(s.max_loss));
  setTxt('max_loss_pct', pct(s.max_loss,s.capital));
  setTxt('max_profit_val', fmt(s.max_profit));
  setTxt('max_profit_pct', pct(s.max_profit,s.capital));
  setTxt('consec_loss', s.consecutive_loss);
  setTxt('kill_status', s.killed?"ACTIVE":"OFF");
  setTxt('system_status', s.status);
  setTxt('last_update', toIST(Date.now()));
}
function setTxt(id,val){ const el=document.getElementById(id); if(el) el.textContent = val??"--"; }

/* ===== 5. Tradebook ===== */
async function loadTradebook(){
  try{
    const r = await fetch('/api/trades');
    const d = await r.json();
    if(!d.ok) return;
    renderTrades(d.trades);
  }catch(e){}
}
function renderTrades(list){
  const div=document.getElementById("tradesTable");
  if(!div) return;
  let h=`<table><thead><tr>
  <th>Time</th><th>Order</th><th>Instrument</th><th>Qty</th><th>Price</th><th>Type</th>
  </tr></thead><tbody>`;
  for(const t of list){
    h+=`<tr>
    <td>${toIST(t.time)}</td>
    <td>${t.order_id}</td>
    <td>${t.instrument}</td>
    <td>${t.qty}</td>
    <td>${fmt(t.price)}</td>
    <td>${t.type}</td>
    </tr>`;
  }
  h+="</tbody></table>";
  div.innerHTML=h;
}

/* ===== 6. Sellbook ===== */
async function loadSellbook(){
  try{
    const r = await fetch('/api/sellbook');
    const d = await r.json();
    if(!d.ok) return;
    renderSell(d.sellbook);
  }catch(e){}
}
function renderSell(list){
  const div=document.getElementById("tradesTable");
  if(!div) return;
  let h=`<table><thead><tr>
  <th>Time</th><th>Order</th><th>Instrument</th><th>MTM</th><th>Change</th>
  </tr></thead><tbody>`;
  for(const s of list){
    const cls = Number(s.change)<0?"red":"green";
    h+=`<tr>
    <td>${toIST(s.time)}</td>
    <td>${s.order_id}</td>
    <td>${s.instrument}</td>
    <td>${fmt(s.mtm)}</td>
    <td class="${cls}">${fmt(s.change)}</td>
    </tr>`;
  }
  h+="</tbody></table>";
  div.innerHTML=h;
}

function loadActiveTradeSection(){
  if(window.activeSubTab==="trade") loadTradebook();
  else loadSellbook();
}
window.loadActiveTradeSection=loadActiveTradeSection;

/* ===== 7. Admin Actions ===== */
function auth(){ return {"Content-Type":"application/json","x-admin-token":localStorage.getItem("admin_token")||""}; }
function saveAdminToken(){ localStorage.setItem("admin_token",document.getElementById("admin_token").value.trim()); }
window.saveAdminToken=saveAdminToken;

async function saveConfig(){
  const body={
    max_loss:Number(cfg_max_loss.value),
    max_profit:Number(cfg_max_profit.value),
    max_consec_loss:Number(cfg_max_loss_trades.value)
  };
  await fetch('/api/set-config',{method:'POST',headers:auth(),body:JSON.stringify(body)});
}
window.saveConfig=saveConfig;

async function saveCapital(){
  const body={ capital:Number(capital_input.value) };
  await fetch('/api/set-capital',{method:'POST',headers:auth(),body:JSON.stringify(body)});
}
window.saveCapital=saveCapital;

async function killSwitch(){ await fetch('/api/admin/kill',{method:'POST',headers:auth()}); }
window.killSwitch=killSwitch;

async function resetDay(){ await fetch('/api/reset-day',{method:'POST',headers:auth()}); }
window.resetDay=resetDay;

async function saveEnforce(){
  const body={
    mode:enforce_mode.value,
    mtm_source:enforce_mtm_source.value
  };
  await fetch('/api/enforce',{method:'POST',headers:auth(),body:JSON.stringify(body)});
}
window.saveEnforce=saveEnforce;

/* ===== 8. Helpers ===== */
function fmt(n){ try{return Number(n).toLocaleString('en-IN',{maximumFractionDigits:0});}catch(_){return n;} }
function pct(v,cap){ if(!cap) return "0%"; return ((v/cap)*100).toFixed(1)+"%"; }
function toIST(t){ return new Date(t).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}); }

/* ===== 9. Polling ===== */
let stateT=null,tradesT=null;
function stopPoll(){ if(stateT)clearInterval(stateT); if(tradesT)clearInterval(tradesT); }

function startPolling(){
  stopPoll();
  if(window.activeTab==="overview"){
    fetchState();
    stateT=setInterval(fetchState,20000);
  }else if(window.activeTab==="trades"){
    loadActiveTradeSection();
    tradesT=setInterval(loadActiveTradeSection,20000);
  }
}
window.startPolling=startPolling;

/* ===== 10. Init ===== */
document.addEventListener("DOMContentLoaded",()=>{
  const t=localStorage.getItem("admin_token"); if(t) admin_token.value=t;
  startPolling();
});

})();
