// admin.js (Part 1 - Theme, Tabs, Subtabs)

(function(){

/* ============================
   1. THEME TOGGLE
============================ */
function toggleTheme(){
  document.body.classList.toggle("theme-light");
  localStorage.setItem("theme", document.body.classList.contains("theme-light") ? "light" : "dark");
}
window.toggleTheme = toggleTheme;

// Load saved theme
if(localStorage.getItem("theme") === "light"){
  document.body.classList.add("theme-light");
}

/* ============================
   2. TOP TAB SWITCHING
============================ */
function switchTab(tab){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  const target = document.querySelector('#page-' + tab);
  if(target) target.classList.add('active');

  document.querySelectorAll('.top-tabs button').forEach(b=>b.classList.remove('active'));
  const btn = document.querySelector('#tab-' + tab);
  if(btn) btn.classList.add('active');

  window.activeTab = tab;
}
window.switchTab = switchTab;

/* ============================
   3. SUBTAB SWITCHING (Trade/Sell)
============================ */
function switchSubTab(which){
  document.querySelectorAll('.subtoggle button').forEach(b=>b.classList.remove('active'));

  if(which === "trade"){
    document.querySelector("#tradeBtn").classList.add("active");
    window.activeSubTab = "trade";
  } else {
    document.querySelector("#sellBtn").classList.add("active");
    window.activeSubTab = "sell";
  }
}
window.switchSubTab = switchSubTab;

/* Initialize default tabs */
window.activeTab = "overview";
window.activeSubTab = "trade";

})();

/* ============================
   4. STATE FETCH + OVERVIEW UPDATE
============================ */

async function fetchState(){
  try{
    const r = await fetch('/api/state');
    const data = await r.json();
    if(!data || !data.ok) return;

    updateOverviewUI(data);
  }catch(e){
    console.error('State fetch error:', e);
  }
}
window.fetchState = fetchState;

/* Update Overview Cards */
function updateOverviewUI(s){
  // Capital
  const cap = document.getElementById('capital_val');
  if(cap) cap.textContent = formatINR(s.capital || 0);

  // Balance
  const bal = document.getElementById('balance_val');
  if(bal) bal.textContent = formatINR(s.balance || 0);

  // Live MTM
  const mtm = document.getElementById('live_mtm');
  if(mtm) mtm.textContent = formatINR(s.unrealised || 0);

  // Total PnL (realised + unrealised)
  const total = document.getElementById('total_pnl');
  if(total) total.textContent = formatINR((s.realised||0) + (s.unrealised||0));

  // Max Loss
  const ml = document.getElementById('max_loss_val');
  const mlp = document.getElementById('max_loss_pct');
  if(ml) ml.textContent = formatINR(s.max_loss || 0);
  if(mlp) mlp.textContent = pctOf(s.max_loss, s.capital);

  // Max Profit
  const mp = document.getElementById('max_profit_val');
  const mpp = document.getElementById('max_profit_pct');
  if(mp) mp.textContent = formatINR(s.max_profit || 0);
  if(mpp) mpp.textContent = pctOf(s.max_profit, s.capital);

  // Consecutive Loss
  const cl = document.getElementById('consec_loss');
  if(cl) cl.textContent = s.consecutive_loss || 0;

  // Kill switch
  const ks = document.getElementById('kill_status');
  if(ks) ks.textContent = s.killed ? "ACTIVE" : "OFF";

  // System status
  const ss = document.getElementById('system_status');
  if(ss) ss.textContent = s.status || "OK";

  // Last update
  const lu = document.getElementById('last_update');
  if(lu) lu.textContent = toIST(Date.now());
}
window.updateOverviewUI = updateOverviewUI;

/* ============================
   HELPERS: INR + PERCENT + IST
============================ */
function formatINR(n){
  try{
    return Number(n).toLocaleString('en-IN', {maximumFractionDigits: 0});
  }catch(e){
    return n;
  }
}
window.formatINR = formatINR;

function pctOf(part, total){
  if(!total) return "0%";
  const p = (Number(part)/Number(total))*100;
  return p.toFixed(1) + "%";
}

function toIST(ts){
  try{
    return new Date(ts).toLocaleString('en-IN', {timeZone:'Asia/Kolkata'});
  }catch(e){
    return ts;
  }
}
window.toIST = toIST;

/* ============================
   5. TRADEBOOK + SELLBOOK LOGIC
============================ */

/* ---------- Fetch Tradebook ---------- */
async function loadTradebook(){
  try{
    const r = await fetch('/api/trades');
    const data = await r.json();
    if(!data || !data.ok || !Array.isArray(data.trades)) return;

    renderTradeTable(data.trades);
  }catch(e){
    console.error("Tradebook error:", e);
  }
}
window.loadTradebook = loadTradebook;

/* ---------- Fetch Sellbook ---------- */
async function loadSellbook(){
  try{
    const r = await fetch('/api/sellbook');
    const data = await r.json();
    if(!data || !data.ok || !Array.isArray(data.sellbook)) return;

    renderSellTable(data.sellbook);
  }catch(e){
    console.error("Sellbook error:", e);
  }
}
window.loadSellbook = loadSellbook;

/* ---------- Render Tradebook ---------- */
function renderTradeTable(list){
  const div = document.getElementById("tradesTable");
  if(!div) return;

  let html = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Order ID</th>
          <th>Instrument</th>
          <th>Qty</th>
          <th>Price</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
  `;

  for(const t of list){
    html += `
      <tr>
        <td>${toIST(t.time)}</td>
        <td>${t.order_id}</td>
        <td>${t.instrument}</td>
        <td>${t.qty}</td>
        <td>${formatINR(t.price)}</td>
        <td>${t.type}</td>
      </tr>
    `;
  }

  html += `</tbody></table>`;
  div.innerHTML = html;
}
window.renderTradeTable = renderTradeTable;

/* ---------- Render Sellbook ---------- */
function renderSellTable(list){
  const div = document.getElementById("tradesTable");
  if(!div) return;

  let html = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Order ID</th>
          <th>Instrument</th>
          <th>MTM</th>
          <th>Change</th>
        </tr>
      </thead>
      <tbody>
  `;

  for(const s of list){
    const cls = Number(s.change) < 0 ? "red" : "green";

    html += `
      <tr>
        <td>${toIST(s.time)}</td>
        <td>${s.order_id}</td>
        <td>${s.instrument}</td>
        <td>${formatINR(s.mtm)}</td>
        <td class="${cls}">${formatINR(s.change)}</td>
      </tr>
    `;
  }

  html += `</tbody></table>`;
  div.innerHTML = html;
}
window.renderSellTable = renderSellTable;

/* ---------- Subtab Auto Loader ---------- */
function loadActiveTradeSection(){
  if(window.activeSubTab === "trade"){
    loadTradebook();
  } else {
    loadSellbook();
  }
}
window.loadActiveTradeSection = loadActiveTradeSection;


/* ============================
   6. ADMIN ACTIONS
============================ */

/* ---- Admin Token ---- */
function saveAdminToken(){
  const token = document.getElementById("admin_token").value.trim();
  localStorage.setItem("admin_token", token);
}
window.saveAdminToken = saveAdminToken;

function authHeaders(){
  const t = localStorage.getItem("admin_token") || "";
  return { "Content-Type": "application/json", "x-admin-token": t };
}

/* ---- Save Config ---- */
async function saveConfig(){
  const body = {
    max_loss: Number(document.getElementById("cfg_max_loss").value || 0),
    max_profit: Number(document.getElementById("cfg_max_profit").value || 0),
    max_consec_loss: Number(document.getElementById("cfg_max_loss_trades").value || 0)
  };
  await fetch("/api/set-config", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
}
window.saveConfig = saveConfig;

/* ---- Save Capital ---- */
async function saveCapital(){
  const body = {
    capital: Number(document.getElementById("capital_input").value || 0)
  };
  await fetch("/api/set-capital", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
}
window.saveCapital = saveCapital;

/* ---- Kill Switch ---- */
async function killSwitch(){
  await fetch("/api/admin/kill", {
    method: "POST",
    headers: authHeaders()
  });
}
window.killSwitch = killSwitch;

/* ---- Reset Day ---- */
async function resetDay(){
  await fetch("/api/reset-day", {
    method: "POST",
    headers: authHeaders()
  });
}
window.resetDay = resetDay;

/* ---- Enforcement ---- */
async function saveEnforce(){
  const body = {
    mode: document.getElementById("enforce_mode").value,
    mtm_source: document.getElementById("enforce_mtm_source").value
  };
  await fetch("/api/enforce", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
}
window.saveEnforce = saveEnforce;

/* ---- Ping ---- */
async function pingServer(){
  const r = await fetch("/api/ping");
  const txt = await r.text();
  document.getElementById("ping_msg").textContent = txt;
}
window.pingServer = pingServer;


/* ============================
   7. OPTIMIZED POLLING ENGINE
============================ */

/* Polling intervals */
let stateTimer = null;
let tradesTimer = null;

/* Stop all timers */
function stopAllTimers(){
  if(stateTimer) clearInterval(stateTimer);
  if(tradesTimer) clearInterval(tradesTimer);
}

/* Start polling based on active tab */
function startPolling(){
  stopAllTimers();

  if(window.activeTab === "overview"){
    // State refresh every 20s
    fetchState();
    stateTimer = setInterval(fetchState, 20000);
  }

  if(window.activeTab === "trades"){
    // Refresh tradebook/sellbook only when visible
    loadActiveTradeSection();
    tradesTimer = setInterval(loadActiveTradeSection, 20000);
  }

  // Admin tab → no auto polling
}
window.startPolling = startPolling;

/* Monkey-patch switchTab to restart polling */
const _origSwitchTab = window.switchTab;
window.switchTab = function(tab){
  _origSwitchTab(tab);
  startPolling();
};

/* Monkey-patch switchSubTab to reload table immediately */
const _origSwitchSubTab = window.switchSubTab;
window.switchSubTab = function(which){
  _origSwitchSubTab(which);
  loadActiveTradeSection();
};

/* ============================
   8. INITIALIZATION
============================ */

document.addEventListener("DOMContentLoaded", ()=>{
  // Load saved admin token
  const savedToken = localStorage.getItem("admin_token");
  if(savedToken){
    const el = document.getElementById("admin_token");
    if(el) el.value = savedToken;
  }

  // Start initial polling
  startPolling();
});
// admin.js (Part 1 - Theme, Tabs, Subtabs)

(function(){

/* ============================
   1. THEME TOGGLE
============================ */
function toggleTheme(){
  document.body.classList.toggle("theme-light");
  localStorage.setItem("theme", document.body.classList.contains("theme-light") ? "light" : "dark");
}
window.toggleTheme = toggleTheme;

// Load saved theme
if(localStorage.getItem("theme") === "light"){
  document.body.classList.add("theme-light");
}

/* ============================
   2. TOP TAB SWITCHING
============================ */
function switchTab(tab){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  const target = document.querySelector('#page-' + tab);
  if(target) target.classList.add('active');

  document.querySelectorAll('.top-tabs button').forEach(b=>b.classList.remove('active'));
  const btn = document.querySelector('#tab-' + tab);
  if(btn) btn.classList.add('active');

  window.activeTab = tab;
}
window.switchTab = switchTab;

/* ============================
   3. SUBTAB SWITCHING (Trade/Sell)
============================ */
function switchSubTab(which){
  document.querySelectorAll('.subtoggle button').forEach(b=>b.classList.remove('active'));

  if(which === "trade"){
    document.querySelector("#tradeBtn").classList.add("active");
    window.activeSubTab = "trade";
  } else {
    document.querySelector("#sellBtn").classList.add("active");
    window.activeSubTab = "sell";
  }
}
window.switchSubTab = switchSubTab;

/* Initialize default tabs */
window.activeTab = "overview";
window.activeSubTab = "trade";

})();

/* ============================
   4. STATE FETCH + OVERVIEW UPDATE
============================ */

async function fetchState(){
  try{
    const r = await fetch('/api/state');
    const data = await r.json();
    if(!data || !data.ok) return;

    updateOverviewUI(data);
  }catch(e){
    console.error('State fetch error:', e);
  }
}
window.fetchState = fetchState;

/* Update Overview Cards */
function updateOverviewUI(s){
  // Capital
  const cap = document.getElementById('capital_val');
  if(cap) cap.textContent = formatINR(s.capital || 0);

  // Balance
  const bal = document.getElementById('balance_val');
  if(bal) bal.textContent = formatINR(s.balance || 0);

  // Live MTM
  const mtm = document.getElementById('live_mtm');
  if(mtm) mtm.textContent = formatINR(s.unrealised || 0);

  // Total PnL (realised + unrealised)
  const total = document.getElementById('total_pnl');
  if(total) total.textContent = formatINR((s.realised||0) + (s.unrealised||0));

  // Max Loss
  const ml = document.getElementById('max_loss_val');
  const mlp = document.getElementById('max_loss_pct');
  if(ml) ml.textContent = formatINR(s.max_loss || 0);
  if(mlp) mlp.textContent = pctOf(s.max_loss, s.capital);

  // Max Profit
  const mp = document.getElementById('max_profit_val');
  const mpp = document.getElementById('max_profit_pct');
  if(mp) mp.textContent = formatINR(s.max_profit || 0);
  if(mpp) mpp.textContent = pctOf(s.max_profit, s.capital);

  // Consecutive Loss
  const cl = document.getElementById('consec_loss');
  if(cl) cl.textContent = s.consecutive_loss || 0;

  // Kill switch
  const ks = document.getElementById('kill_status');
  if(ks) ks.textContent = s.killed ? "ACTIVE" : "OFF";

  // System status
  const ss = document.getElementById('system_status');
  if(ss) ss.textContent = s.status || "OK";

  // Last update
  const lu = document.getElementById('last_update');
  if(lu) lu.textContent = toIST(Date.now());
}
window.updateOverviewUI = updateOverviewUI;

/* ============================
   HELPERS: INR + PERCENT + IST
============================ */
function formatINR(n){
  try{
    return Number(n).toLocaleString('en-IN', {maximumFractionDigits: 0});
  }catch(e){
    return n;
  }
}
window.formatINR = formatINR;

function pctOf(part, total){
  if(!total) return "0%";
  const p = (Number(part)/Number(total))*100;
  return p.toFixed(1) + "%";
}

function toIST(ts){
  try{
    return new Date(ts).toLocaleString('en-IN', {timeZone:'Asia/Kolkata'});
  }catch(e){
    return ts;
  }
}
window.toIST = toIST;

/* ============================
   5. TRADEBOOK + SELLBOOK LOGIC
============================ */

/* ---------- Fetch Tradebook ---------- */
async function loadTradebook(){
  try{
    const r = await fetch('/api/trades');
    const data = await r.json();
    if(!data || !data.ok || !Array.isArray(data.trades)) return;

    renderTradeTable(data.trades);
  }catch(e){
    console.error("Tradebook error:", e);
  }
}
window.loadTradebook = loadTradebook;

/* ---------- Fetch Sellbook ---------- */
async function loadSellbook(){
  try{
    const r = await fetch('/api/sellbook');
    const data = await r.json();
    if(!data || !data.ok || !Array.isArray(data.sellbook)) return;

    renderSellTable(data.sellbook);
  }catch(e){
    console.error("Sellbook error:", e);
  }
}
window.loadSellbook = loadSellbook;

/* ---------- Render Tradebook ---------- */
function renderTradeTable(list){
  const div = document.getElementById("tradesTable");
  if(!div) return;

  let html = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Order ID</th>
          <th>Instrument</th>
          <th>Qty</th>
          <th>Price</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
  `;

  for(const t of list){
    html += `
      <tr>
        <td>${toIST(t.time)}</td>
        <td>${t.order_id}</td>
        <td>${t.instrument}</td>
        <td>${t.qty}</td>
        <td>${formatINR(t.price)}</td>
        <td>${t.type}</td>
      </tr>
    `;
  }

  html += `</tbody></table>`;
  div.innerHTML = html;
}
window.renderTradeTable = renderTradeTable;

/* ---------- Render Sellbook ---------- */
function renderSellTable(list){
  const div = document.getElementById("tradesTable");
  if(!div) return;

  let html = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Order ID</th>
          <th>Instrument</th>
          <th>MTM</th>
          <th>Change</th>
        </tr>
      </thead>
      <tbody>
  `;

  for(const s of list){
    const cls = Number(s.change) < 0 ? "red" : "green";

    html += `
      <tr>
        <td>${toIST(s.time)}</td>
        <td>${s.order_id}</td>
        <td>${s.instrument}</td>
        <td>${formatINR(s.mtm)}</td>
        <td class="${cls}">${formatINR(s.change)}</td>
      </tr>
    `;
  }

  html += `</tbody></table>`;
  div.innerHTML = html;
}
window.renderSellTable = renderSellTable;

/* ---------- Subtab Auto Loader ---------- */
function loadActiveTradeSection(){
  if(window.activeSubTab === "trade"){
    loadTradebook();
  } else {
    loadSellbook();
  }
}
window.loadActiveTradeSection = loadActiveTradeSection;


/* ============================
   6. ADMIN ACTIONS
============================ */

/* ---- Admin Token ---- */
function saveAdminToken(){
  const token = document.getElementById("admin_token").value.trim();
  localStorage.setItem("admin_token", token);
}
window.saveAdminToken = saveAdminToken;

function authHeaders(){
  const t = localStorage.getItem("admin_token") || "";
  return { "Content-Type": "application/json", "x-admin-token": t };
}

/* ---- Save Config ---- */
async function saveConfig(){
  const body = {
    max_loss: Number(document.getElementById("cfg_max_loss").value || 0),
    max_profit: Number(document.getElementById("cfg_max_profit").value || 0),
    max_consec_loss: Number(document.getElementById("cfg_max_loss_trades").value || 0)
  };
  await fetch("/api/set-config", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
}
window.saveConfig = saveConfig;

/* ---- Save Capital ---- */
async function saveCapital(){
  const body = {
    capital: Number(document.getElementById("capital_input").value || 0)
  };
  await fetch("/api/set-capital", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
}
window.saveCapital = saveCapital;

/* ---- Kill Switch ---- */
async function killSwitch(){
  await fetch("/api/admin/kill", {
    method: "POST",
    headers: authHeaders()
  });
}
window.killSwitch = killSwitch;

/* ---- Reset Day ---- */
async function resetDay(){
  await fetch("/api/reset-day", {
    method: "POST",
    headers: authHeaders()
  });
}
window.resetDay = resetDay;

/* ---- Enforcement ---- */
async function saveEnforce(){
  const body = {
    mode: document.getElementById("enforce_mode").value,
    mtm_source: document.getElementById("enforce_mtm_source").value
  };
  await fetch("/api/enforce", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
}
window.saveEnforce = saveEnforce;

/* ---- Ping ---- */
async function pingServer(){
  const r = await fetch("/api/ping");
  const txt = await r.text();
  document.getElementById("ping_msg").textContent = txt;
}
window.pingServer = pingServer;


/* ============================
   7. OPTIMIZED POLLING ENGINE
============================ */

/* Polling intervals */
let stateTimer = null;
let tradesTimer = null;

/* Stop all timers */
function stopAllTimers(){
  if(stateTimer) clearInterval(stateTimer);
  if(tradesTimer) clearInterval(tradesTimer);
}

/* Start polling based on active tab */
function startPolling(){
  stopAllTimers();

  if(window.activeTab === "overview"){
    // State refresh every 20s
    fetchState();
    stateTimer = setInterval(fetchState, 20000);
  }

  if(window.activeTab === "trades"){
    // Refresh tradebook/sellbook only when visible
    loadActiveTradeSection();
    tradesTimer = setInterval(loadActiveTradeSection, 20000);
  }

  // Admin tab → no auto polling
}
window.startPolling = startPolling;

/* Monkey-patch switchTab to restart polling */
const _origSwitchTab = window.switchTab;
window.switchTab = function(tab){
  _origSwitchTab(tab);
  startPolling();
};

/* Monkey-patch switchSubTab to reload table immediately */
const _origSwitchSubTab = window.switchSubTab;
window.switchSubTab = function(which){
  _origSwitchSubTab(which);
  loadActiveTradeSection();
};

/* ============================
   8. INITIALIZATION
============================ */

document.addEventListener("DOMContentLoaded", ()=>{
  // Load saved admin token
  const savedToken = localStorage.getItem("admin_token");
  if(savedToken){
    const el = document.getElementById("admin_token");
    if(el) el.value = savedToken;
  }

  // Start initial polling
  startPolling();
});


<script src="/admin.js"></script>
