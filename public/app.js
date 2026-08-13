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
  return fee.gasPrice
    ? { gasPrice: fee.gasPrice }
    : { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas };
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
  const bufferWei = E.parseEther(($("gasBuffer").value || "0").trim());
  const p = getProvider();
  $("btnConsolidate").disabled = true;

  for (const w of sourceWallets) {
    try {
      const balance = await p.getBalance(w.address);
      w.balance = balance;
      const overrides = await getFeeOverrides();
      const gasPrice = overrides.gasPrice ?? overrides.maxFeePerGas;
      const gasLimit = 21000n;
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
      await tx.wait();
      log(esc(w.address) + " : confirmed.", "ok");
    } catch (e) {
      log(esc(w.address) + " : failed — " + esc(e.message || String(e)), "bad");
    }
  }
  $("btnConsolidate").disabled = false;
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

async function fetchEthUsdPrice() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const data = await res.json();
    const price = Number(data.ethereum && data.ethereum.usd);
    if (isFinite(price) && price > 0) $("ethPrice").value = String(price);
  } catch (e) {
    log("Could not fetch ETH price. Retrying…", "warn");
  }
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
  const overrides = await getFeeOverrides();
  const gasPrice = overrides.gasPrice ?? overrides.maxFeePerGas;
  const gasLimit = 21000n;
  const gasTotal = gasPrice * gasLimit * BigInt(recipientList.length);

  let total = 0n;
  for (const r of recipientList) total += r.amount;

  const balance = await p.getBalance(fundWallet.address);
  if (balance < total + gasTotal) {
    log("Insufficient funds: need " + E.formatEther(total + gasTotal) + " (amounts + gas), have " + E.formatEther(balance) + ". Aborted.", "bad");
    $("btnSpread").disabled = false;
    return;
  }

  let nonce = await p.getTransactionCount(fundWallet.address, "pending");
  let sent = 0;
  let failed = 0;
  for (const r of recipientList) {
    try {
      const tx = await fundWallet.sendTransaction({
        to: r.address,
        value: r.amount,
        gasLimit,
        ...overrides,
        nonce
      });
      nonce++;
      sent++;
      log("→ " + esc(r.address) + " : broadcast " + E.formatEther(r.amount) + " — tx " + tx.hash, "ok");
      await tx.wait();
      log("→ " + esc(r.address) + " : confirmed.", "ok");
    } catch (e) {
      failed++;
      log("→ " + esc(r.address) + " : failed — " + esc(e.message || String(e)), "bad");
    }
  }
  $("btnSpread").disabled = false;
  log("Spread run complete: " + sent + " sent, " + failed + " failed.", sent && !failed ? "ok" : "warn");
}

/* ---------- wiring (CSP: script-src 'self', no inline handlers) ---------- */
$("tabConsolidate").addEventListener("click", () => setMode("consolidate"));
$("tabSpread").addEventListener("click", () => setMode("spread"));
$("chainSelect").addEventListener("change", onChainChange);
$("btnLoadSource").addEventListener("click", loadSourceWallets);
$("btnRefresh").addEventListener("click", refreshBalances);
$("btnConsolidate").addEventListener("click", runConsolidate);
$("btnLoadFund").addEventListener("click", loadFundWallet);
$("spreadMode").addEventListener("change", updateRecipientUI);
$("unitSelect").addEventListener("change", updateRecipientUI);
$("btnParseRecipients").addEventListener("click", parseRecipients);
$("btnSpread").addEventListener("click", runSpread);
updateRecipientUI();
fetchEthUsdPrice();
setInterval(fetchEthUsdPrice, 60000);
