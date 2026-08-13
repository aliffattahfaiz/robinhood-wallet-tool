"use strict";
const E = ethers;

/* ---------- helpers ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function $(id) { return document.getElementById(id); }
function log(msg, cls) {
  const el = $("log");
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

/* ---------- chain presets ---------- */
const CHAINS = {
  mainnet: { rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com" },
  testnet: { rpc: "https://rpc.testnet.chain.robinhood.com", explorer: "https://robinhoodchain-testnet.blockscout.com" }
};

let provider = null;
let mode = "consolidate";
let ethUsdPrice = 0;
let ethIdrPrice = 0;
let priceWarned = false;

function onChainChange() {
  const v = $("chainSelect").value;
  if (v === "custom") {
    $("rpcUrl").value = "";
    $("rpcUrl").disabled = false;
    $("rpcHint").textContent = "Enter any EVM-compatible RPC endpoint.";
  } else {
    $("rpcUrl").value = CHAINS[v].rpc;
    $("rpcUrl").disabled = false;
    $("rpcHint").textContent = "Explorer: " + CHAINS[v].explorer;
  }
}
onChainChange();

function saveNetworkPrefs() {
  try {
    localStorage.setItem("rhwt_chain", $("chainSelect").value);
    localStorage.setItem("rhwt_rpc", $("rpcUrl").value);
  } catch (e) { /* storage unavailable */ }
  const params = new URLSearchParams();
  params.set("chain", $("chainSelect").value);
  if ($("rpcUrl").value) params.set("rpc", $("rpcUrl").value);
  history.replaceState(null, "", "?" + params.toString());
  $("rpcHint").textContent = "RPC saved — will be restored on reload.";
}

function restoreNetworkPrefs() {
  const params = new URLSearchParams(location.search);
  let chain = params.get("chain");
  let rpc = params.get("rpc");
  if (!chain && !rpc) {
    try {
      chain = localStorage.getItem("rhwt_chain");
      rpc = localStorage.getItem("rhwt_rpc");
    } catch (e) { /* storage unavailable */ }
  }
  if (chain && (chain === "custom" || CHAINS[chain])) $("chainSelect").value = chain;
  onChainChange();
  if (rpc) $("rpcUrl").value = rpc;
}

function getProvider() {
  const url = $("rpcUrl").value.trim();
  if (!url) throw new Error("Set an RPC URL first.");
  if (!provider || provider._rmtUrl !== url) {
    provider = new E.JsonRpcProvider(url);
    provider._rmtUrl = url;
  }
  return provider;
}

async function getFeeOverrides() {
  const fee = await getProvider().getFeeData();
  if (fee.maxFeePerGas == null) return { gasPrice: fee.gasPrice };
  return {
    maxFeePerGas: fee.maxFeePerGas * 2n,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 1000000000n
  };
}

function setMode(m) {
  mode = m;
  $("tabConsolidate").classList.toggle("active", m === "consolidate");
  $("tabSpread").classList.toggle("active", m === "spread");
  $("panelConsolidate").style.display = m === "consolidate" ? "" : "none";
  $("panelSpread").style.display = m === "spread" ? "" : "none";
  $("tableWrap").innerHTML = '<span class="hint">Nothing loaded yet.</span>';
}

/* ---------- consolidate mode ---------- */
let sourceWallets = []; // { wallet, address, balance }

function loadSourceWallets() {
  const raw = $("srcKeys").value;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const p = getProvider();
  const next = [];
  let bad = 0;
  for (const k of lines) {
    try {
      const w = new E.Wallet(k, p);
      next.push({ wallet: w, address: w.address, balance: null });
    } catch (e) {
      bad++;
    }
  }
  sourceWallets = next;
  $("srcKeys").value = ""; // clear key material from the DOM immediately after loading
  $("srcSummary").innerHTML =
    '<span class="ok">' + next.length + " wallet(s) loaded.</span>" +
    (bad ? ' <span class="bad">' + bad + " invalid line(s) skipped.</span>" : "") +
    ' <span class="kv">— key field cleared, held in memory only</span>';
  $("btnRefresh").disabled = next.length === 0;
  $("btnConsolidate").disabled = next.length === 0;
  renderSourceTable();
  log(next.length + " source wallet(s) loaded" + (bad ? ", " + bad + " invalid skipped" : "") + ".", "ok");
}

async function refreshBalances() {
  const p = getProvider();
  for (const w of sourceWallets) {
    try {
      w.balance = await p.getBalance(w.address);
    } catch (e) {
      w.balance = null;
      log("Balance check failed for " + w.address + ": " + esc(e.message || String(e)), "bad");
    }
  }
  renderSourceTable();
}

function renderSourceTable() {
  if (!sourceWallets.length) {
    $("tableWrap").innerHTML = '<span class="hint">Nothing loaded yet.</span>';
    return;
  }
  let rows = "";
  for (const w of sourceWallets) {
    const bal = w.balance === null ? '<span class="kv">—</span>' : E.formatEther(w.balance);
    rows += "<tr><td>" + esc(w.address) + "</td><td>" + bal + "</td></tr>";
  }
  $("tableWrap").innerHTML =
    "<table><thead><tr><th>Address</th><th>Balance</th></tr></thead><tbody>" + rows + "</tbody></table>";
}

async function runConsolidate() {
  const dest = $("destAddr").value.trim();
  if (!E.isAddress(dest)) { log("Destination address is not valid.", "bad"); return; }
  let bufferWei = 0n;
  if ($("bufferToggle").checked) {
    try { bufferWei = E.parseEther(($("gasBuffer").value || "0").trim()); }
    catch (e) { log("Invalid gas buffer value.", "bad"); return; }
  }
  const p = getProvider();
  $("btnConsolidate").disabled = true;
  let gasFees = 0n;

  for (const w of sourceWallets) {
    try {
      const balance = await p.getBalance(w.address);
      w.balance = balance;
      const overrides = await getFeeOverrides();
      const gasPrice = overrides.gasPrice ?? overrides.maxFeePerGas;
      const gasLimit = await estimateTransferGas(p, w.address, dest);
      const txCost = gasPrice * gasLimit;
      const sendable = balance - txCost - bufferWei;

      if (sendable <= 0n) {
        log(esc(w.address) + ": balance too low to sweep (needs > gas + buffer). Skipped.", "warn");
        continue;
      }

      const tx = await w.wallet.sendTransaction({
        to: dest,
        value: sendable,
        gasLimit,
        ...overrides
      });
      log(esc(w.address) + " → " + esc(dest) + " : sent " + E.formatEther(sendable) + " — tx " + tx.hash, "ok");
      const receipt = await tx.wait();
      gasFees += receipt.fee;
      log(esc(w.address) + " : confirmed.", "ok");
    } catch (e) {
      log(esc(w.address) + " : failed — " + esc(e.message || String(e)), "bad");
    }
  }
  $("btnConsolidate").disabled = false;
  showGasSummary(gasFees);
  if (gasFees > 0n) log(gasCostSummary(gasFees), "ok");
  refreshBalances();
}

/* ---------- spread mode ---------- */
let fundWallet = null;
let recipientList = []; // { address, amount }

function loadFundWallet() {
  const key = $("fundKey").value.trim();
  const p = getProvider();
  try {
    fundWallet = new E.Wallet(key, p);
    $("fundKey").value = "";
    $("fundSummary").innerHTML = '<span class="ok">Loaded ' + esc(fundWallet.address) + '</span> <span class="kv">— key field cleared, held in memory only</span>';
    log("Funding wallet loaded: " + fundWallet.address, "ok");
    checkSpreadReady();
  } catch (e) {
    $("fundSummary").innerHTML = '<span class="bad">Invalid private key.</span>';
  }
}

function updateRecipientUI() {
  const same = $("spreadMode").value === "same";
  const usd = $("unitSelect").value === "usd";
  const unit = usd ? "USD" : "ETH";
  $("sameAmount").style.display = same ? "" : "none";
  $("sameAmountLabel").style.display = same ? "" : "none";
  $("sameAmountLabel").textContent = "Amount in " + unit + " (sent to each address)";
  $("sameAmount").placeholder = usd ? "5.00" : "0.01";
  $("ethPriceLabel").style.display = usd ? "" : "none";
  $("ethPrice").style.display = usd ? "" : "none";
  $("recipLabel").innerHTML = same
    ? "One address per line:"
    : 'One per line: <span class="kv">address,amount(' + unit + ')</span>';
  $("recipients").placeholder = same
    ? "0xaaa...\n0xbbb..."
    : "0xaaa...,0.01\n0xbbb...,0.02";
}

async function fetchEthPrices() {
  const sources = [
    async () => {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd,idr");
      const d = await r.json();
      return { usd: Number(d.ethereum && d.ethereum.usd), idr: Number(d.ethereum && d.ethereum.idr) };
    },
    async () => {
      const r = await fetch("https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD,IDR");
      const d = await r.json();
      return { usd: Number(d.USD), idr: Number(d.IDR) };
    }
  ];
  for (const src of sources) {
    try {
      const v = await src();
      if (isFinite(v.usd) && v.usd > 0) {
        ethUsdPrice = v.usd;
        ethIdrPrice = isFinite(v.idr) && v.idr > 0 ? v.idr : 0;
        $("ethPrice").value = String(v.usd);
        priceWarned = false;
        return;
      }
    } catch (e) { /* try next source */ }
  }
  if (!priceWarned) {
    log("Could not fetch ETH price. Will keep retrying.", "warn");
    priceWarned = true;
  }
}

async function estimateTransferGas(p, from, to) {
  try {
    const est = await p.estimateGas({ from, to, value: 0n });
    const buffered = (est * 120n) / 100n;
    return buffered < 21000n ? 21000n : buffered;
  } catch (e) {
    return 21000n;
  }
}

function gasCostSummary(gasFees) {
  if (gasFees <= 0n) return "";
  const eth = parseFloat(E.formatEther(gasFees));
  let s = "Gas used: " + eth.toFixed(6) + " ETH";
  if (ethUsdPrice > 0) s += " ≈ $" + (eth * ethUsdPrice).toFixed(2);
  if (ethIdrPrice > 0) s += " (≈ Rp " + Math.round(eth * ethIdrPrice).toLocaleString("id-ID") + ")";
  return s;
}

function showGasSummary(gasFees) {
  const el = $("gasSummary");
  if (gasFees <= 0n) {
    el.textContent = "No transactions yet.";
    el.className = "kv";
    return;
  }
  const eth = parseFloat(E.formatEther(gasFees));
  let s = eth.toFixed(6) + " ETH";
  if (ethUsdPrice > 0) s += " ≈ $" + (eth * ethUsdPrice).toFixed(2);
  if (ethIdrPrice > 0) s += " (≈ Rp " + Math.round(eth * ethIdrPrice).toLocaleString("id-ID") + ")";
  el.textContent = s;
  el.className = "ok";
}

function parseAmountToWei(str) {
  if ($("unitSelect").value === "usd") {
    const usd = Number(str);
    const price = Number($("ethPrice").value);
    if (!isFinite(usd) || !isFinite(price) || price <= 0) return null;
    return E.parseUnits((usd / price).toFixed(18), 18);
  }
  try { return E.parseEther(str); } catch (e) { return null; }
}

function parseRecipients() {
  const same = $("spreadMode").value === "same";
  let sameAmount = null;
  if (same) {
    sameAmount = parseAmountToWei(($("sameAmount").value || "").trim());
    if (sameAmount === null) { $("recipSummary").innerHTML = '<span class="bad">Enter a valid amount.</span>'; return; }
  }
  const raw = $("recipients").value;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const next = [];
  let bad = 0;
  for (const line of lines) {
    if (same) {
      if (!E.isAddress(line)) { bad++; continue; }
      next.push({ address: line, amount: sameAmount });
      continue;
    }
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length !== 2 || !E.isAddress(parts[0])) { bad++; continue; }
    const amount = parseAmountToWei(parts[1]);
    if (amount === null) { bad++; continue; }
    next.push({ address: parts[0], amount });
  }
  recipientList = next;
  $("recipSummary").innerHTML =
    '<span class="ok">' + next.length + " recipient(s) parsed.</span>" +
    (bad ? ' <span class="bad">' + bad + " invalid line(s) skipped.</span>" : "");
  renderRecipientTable();
  checkSpreadReady();
}

function renderRecipientTable() {
  if (!recipientList.length) {
    $("tableWrap").innerHTML = '<span class="hint">Nothing loaded yet.</span>';
    return;
  }
  let rows = "";
  for (const r of recipientList) {
    rows += "<tr><td>" + esc(r.address) + "</td><td>" + E.formatEther(r.amount) + "</td></tr>";
  }
  $("tableWrap").innerHTML =
    "<table><thead><tr><th>Recipient</th><th>Amount</th></tr></thead><tbody>" + rows + "</tbody></table>";
}

function checkSpreadReady() {
  $("btnSpread").disabled = !(fundWallet && recipientList.length);
}

async function runSpread() {
  if (!fundWallet || !recipientList.length) return;
  $("btnSpread").disabled = true;
  const p = getProvider();

  let total = 0n;
  for (const r of recipientList) total += r.amount;
  const balance = await p.getBalance(fundWallet.address);
  const estimate = await getFeeOverrides();
  const gasPrice = estimate.gasPrice ?? estimate.maxFeePerGas;
  const gasLimit = await estimateTransferGas(p, fundWallet.address, recipientList[0].address);
  const gasTotal = gasPrice * gasLimit * BigInt(recipientList.length);
  if (balance < total + gasTotal) {
    log("Insufficient funds: need " + E.formatEther(total + gasTotal) + " (amounts + gas), have " + E.formatEther(balance) + ". Aborted.", "bad");
    $("btnSpread").disabled = false;
    return;
  }

  let nonce = await p.getTransactionCount(fundWallet.address, "pending");
  let sent = 0;
  let failed = 0;
  let gasFees = 0n;
  for (const r of recipientList) {
    let done = false;
    for (let attempt = 1; attempt <= 4 && !done; attempt++) {
      try {
        const overrides = await getFeeOverrides();
        const tx = await fundWallet.sendTransaction({
          to: r.address,
          value: r.amount,
          gasLimit,
          ...overrides,
          nonce
        });
        done = true;
        nonce++;
        sent++;
        log("→ " + esc(r.address) + " : broadcast " + E.formatEther(r.amount) + " — tx " + tx.hash, "ok");
        try {
          const receipt = await tx.wait();
          gasFees += receipt.fee;
          log("→ " + esc(r.address) + " : confirmed.", "ok");
        } catch (e) {
          log("→ " + esc(r.address) + " : broadcast but confirmation uncertain — " + esc(e.message || String(e)), "warn");
        }
      } catch (e) {
        const msg = e.message || String(e);
        if (/base fee|intrinsic|underpriced|replacement|gas price/i.test(msg) && attempt < 4) {
          log("→ " + esc(r.address) + " : fee rejected (" + msg + "), retrying…", "warn");
        } else {
          failed++;
          done = true;
          log("→ " + esc(r.address) + " : failed — " + esc(msg), "bad");
        }
      }
    }
  }
  $("btnSpread").disabled = false;
  showGasSummary(gasFees);
  log("Spread run complete: " + sent + " sent, " + failed + " failed.", sent && !failed ? "ok" : "warn");
  if (gasFees > 0n) log(gasCostSummary(gasFees), "ok");
}

function onBufferToggle() {
  $("gasBuffer").disabled = !$("bufferToggle").checked;
}

function wipeMemory() {
  sourceWallets = [];
  fundWallet = null;
  recipientList = [];
  for (const id of ["srcKeys", "fundKey", "recipients", "sameAmount", "destAddr", "gasBuffer"]) {
    $(id).value = "";
  }
  $("log").innerHTML = "";
  $("tableWrap").innerHTML = '<span class="hint">Nothing loaded yet.</span>';
  $("srcSummary").innerHTML = "";
  $("fundSummary").innerHTML = "";
  $("recipSummary").innerHTML = "";
  $("btnRefresh").disabled = true;
  $("btnConsolidate").disabled = true;
  $("btnSpread").disabled = true;
  showGasSummary(0n);
  log("Memory wiped. All keys, wallets, and recipient data cleared.", "ok");
}

/* ---------- wiring (CSP: script-src 'self', no inline handlers) ---------- */
$("tabConsolidate").addEventListener("click", () => setMode("consolidate"));
$("tabSpread").addEventListener("click", () => setMode("spread"));
$("chainSelect").addEventListener("change", () => { onChainChange(); saveNetworkPrefs(); });
$("rpcUrl").addEventListener("input", saveNetworkPrefs);
$("rpcUrl").addEventListener("blur", saveNetworkPrefs);
$("btnLoadSource").addEventListener("click", loadSourceWallets);
$("btnRefresh").addEventListener("click", refreshBalances);
$("btnConsolidate").addEventListener("click", runConsolidate);
$("btnLoadFund").addEventListener("click", loadFundWallet);
$("spreadMode").addEventListener("change", updateRecipientUI);
$("unitSelect").addEventListener("change", updateRecipientUI);
$("btnParseRecipients").addEventListener("click", parseRecipients);
$("btnSpread").addEventListener("click", runSpread);
$("btnWipe").addEventListener("click", wipeMemory);
$("bufferToggle").addEventListener("change", onBufferToggle);
restoreNetworkPrefs();
updateRecipientUI();
onBufferToggle();
fetchEthPrices();
setInterval(fetchEthPrices, 10000);
