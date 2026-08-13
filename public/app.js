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
      const fee = await p.getFeeData();
      const gasPrice = fee.gasPrice ?? fee.maxFeePerGas;
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
        gasPrice
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

function parseRecipients() {
  const raw = $("recipients").value;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const next = [];
  let bad = 0;
  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length !== 2 || !E.isAddress(parts[0])) { bad++; continue; }
    let amount;
    try { amount = E.parseEther(parts[1]); } catch (e) { bad++; continue; }
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
  let nonce = await p.getTransactionCount(fundWallet.address, "pending");
  const fee = await p.getFeeData();
  const gasPrice = fee.gasPrice ?? fee.maxFeePerGas;

  for (const r of recipientList) {
    try {
      const tx = await fundWallet.sendTransaction({
        to: r.address,
        value: r.amount,
        gasLimit: 21000n,
        gasPrice,
        nonce
      });
      nonce++;
      log("→ " + esc(r.address) + " : sent " + E.formatEther(r.amount) + " — tx " + tx.hash, "ok");
    } catch (e) {
      log("→ " + esc(r.address) + " : failed — " + esc(e.message || String(e)), "bad");
    }
  }
  $("btnSpread").disabled = false;
  log("Spread run complete.", "ok");
}
