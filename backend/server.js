require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const axios = require("axios");
const { sendUrgentEmail } = require("./mailer");

// ── Global crash guards — prevent silent server death ─────────────────────────
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.stack || err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason?.stack || reason);
});

const app = express();
app.use(cors());
app.use(express.json());

const os = require("os");
const CONFIG_PATH = path.join(os.tmpdir(), "backend_config.json");
const CACHE_PATH = path.join(os.tmpdir(), "backend_cache.json");

const defaultCfg = {
  adminPassword: "Testbook_new",
  syncSchedule: "0 * * * *",
  emailSchedule: "0 10 * * *",
  emailTo: "",
  emailCc: "",
  lastSynced: null,
  lastPrintSynced: null,
  isSyncing: false
};

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...defaultCfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
    }
  } catch (e) { console.error("Error reading config", e); }
  return { ...defaultCfg };
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch(e) { console.error("Could not write config:", e.message); }
}

function getCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch (e) {}
  return { invCSV: "", txnCSV: "", printData: {}, printDataStaleSince: null };
}

let isSyncing = false;

// ── Published CSV (Print Mastersheet) ────────────────────────────────────────
// No credentials needed — sheet must be published: File → Share → Publish to web → CSV
async function fetchPrintMastersheet() {
  const csvUrl = process.env.GOOGLE_SHEET_PRINT_CSV_URL;
  if (!csvUrl) throw new Error("GOOGLE_SHEET_PRINT_CSV_URL env var not set");

  const res = await axios.get(csvUrl, { responseType: "text", timeout: 30000 });
  const lines = res.data.split(/\r?\n/);
  if (lines.length < 2) return {};

  // Cols: A=SKU, E=Status, I=Warehouse, M=QtyOrdered, N=SentDate, O=PrinterETA, P=PrintingDoneDate, Q=GRNDate
  // Index:  0     4         8             12              13            14                15               16

  const bySkuActive = {};

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    const sku = (row[0] || "").trim();
    const status = (row[4] || "").trim();
    const warehouse = (row[8] || "").trim();

    if (!sku || status !== "In Print" || warehouse !== "GGN") continue;

    const sentDateStr = (row[13] || "").trim();
    const sentDate = sentDateStr ? new Date(sentDateStr) : null;

    if (!bySkuActive[sku]) {
      bySkuActive[sku] = row;
    } else {
      const existingSentStr = (bySkuActive[sku][13] || "").trim();
      const existingSent = existingSentStr ? new Date(existingSentStr) : null;
      if (sentDate && (!existingSent || sentDate > existingSent)) {
        bySkuActive[sku] = row;
      }
    }
  }

  const printData = {};
  for (const [sku, row] of Object.entries(bySkuActive)) {
    printData[sku] = {
      qty: parseInt((row[12] || "0").replace(/,/g, ""), 10) || 0,
      sentDate: (row[13] || "").trim() || null,
      printerETA: (row[14] || "").trim() || null,
      printingDoneDate: (row[15] || "").trim() || null,
      grnDate: (row[16] || "").trim() || null,
    };
  }

  return printData;
}


// ── CSV Parser ───────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const result = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') { field += '"'; i++; }
      else if (char === '"') { inQuotes = false; }
      else { field += char; }
    } else {
      if (char === '"') { inQuotes = true; }
      else if (char === ',') { result.push(field.trim()); field = ""; }
      else { field += char; }
    }
  }
  result.push(field.trim());
  return result;
}

function parseGoogleSheetCSV(text) {
  if (!text) return [];
  const lines = [];
  let currentLine = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') { field += '"'; i++; }
      else if (char === '"') { inQuotes = false; }
      else { field += char; }
    } else {
      if (char === '"') { inQuotes = true; }
      else if (char === ',') { currentLine.push(field.trim()); field = ""; }
      else if (!inQuotes && (char === '\n' || (char === '\r' && next === '\n'))) {
        currentLine.push(field.trim()); lines.push(currentLine); currentLine = []; field = "";
        if (char === '\r') i++;
      } else if (!inQuotes && char === '\r') {
        currentLine.push(field.trim()); lines.push(currentLine); currentLine = []; field = "";
      } else { field += char; }
    }
  }
  if (field || currentLine.length > 0) { currentLine.push(field.trim()); lines.push(currentLine); }
  return lines;
}

// ── performSync ───────────────────────────────────────────────────────────────
async function performSync() {
  if (isSyncing) return;
  isSyncing = true;

  const cache = getCache();

  try {
    console.log("Starting full sync...");

    const invUrl = process.env.GOOGLE_SHEET_INVENTORY_CSV_URL;
    const txnUrl = process.env.GOOGLE_SHEET_TRANSACTIONS_CSV_URL;
    if (!invUrl || !txnUrl) throw new Error("Google Sheets CSV URLs missing in .env");

    let txnSyncOk = true;
    let printSyncOk = true;

    // ── Fetch Inventory + Transactions CSVs ──────────────────────────────────
    const [invRes, txnRes] = await Promise.all([
      axios.get(invUrl),
      axios.get(txnUrl)
    ]);

    const invCSV = invRes.data.trim();
    const txnCSVRaw = txnRes.data.trim();

    const txnRows = parseGoogleSheetCSV(txnCSVRaw);
    if (txnRows.length < 2) throw new Error("Transaction sheet is empty");

    const headers = txnRows[0].map(h => h.trim().toLowerCase());
    const findIdx = (names) => {
      for (const name of names) {
        const idx = headers.indexOf(name.toLowerCase());
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const skuIdx = findIdx(["Master SKU", "SKU", "Channel SKU", "Product SKU"]);
    const qtyIdx = findIdx(["Product Quantity", "Quantity", "Qty", "Total Units"]);
    const dateIdx = findIdx(["Shiprocket Created At", "Order Date", "Date", "Created At"]);
    const channelIdx = findIdx(["Channel Name", "Channel", "Source", "Store"]);
    const statusIdx = findIdx(["Status", "Order Status", "State"]);
    const isReverseIdx = findIdx(["Is Reverse", "Reverse"]);

    if (skuIdx === -1 || dateIdx === -1) {
      throw new Error(`Required headers not found. Got: ${headers.slice(0, 8).join(", ")}`);
    }

    let normalizedTxns = ["Master SKU,Product Quantity,Shiprocket Created At,Channel,Status,Is Reverse"];
    for (let i = 1; i < txnRows.length; i++) {
      const row = txnRows[i];
      if (row.length < Math.max(skuIdx, dateIdx)) continue;
      const sku = (row[skuIdx] || "").trim();
      if (!sku || sku.toLowerCase() === "master sku") continue;
      const qty = (row[qtyIdx] || "1").trim();
      const dateRaw = (row[dateIdx] || "").trim();
      const channel = (channelIdx !== -1 ? row[channelIdx] : "Unknown").trim();
      const status = (statusIdx !== -1 ? row[statusIdx] : "NEW").trim();
      const isReverse = (isReverseIdx !== -1 ? row[isReverseIdx] : "No").trim();
      const quote = (s) => `"${(s || "").replace(/"/g, '""')}"`;
      normalizedTxns.push(`${quote(sku)},${qty},${quote(dateRaw)},${quote(channel)},${quote(status)},${quote(isReverse)}`);
    }
    const txnCSV = normalizedTxns.join("\n");

    // ── Fetch Print Mastersheet ───────────────────────────────────────────────
    let printData = cache.printData || {};
    let printDataStaleSince = null;

    try {
      printData = await fetchPrintMastersheet();
      console.log(`Print Mastersheet synced: ${Object.keys(printData).length} active SKUs`);
    } catch (printErr) {
      console.error("Print Mastersheet sync failed:", printErr.message);
      printSyncOk = false;
      printDataStaleSince = cache.printDataStaleSince || new Date().toISOString();
    }

    // ── Save to cache ─────────────────────────────────────────────────────────
    const newCache = {
      invCSV,
      txnCSV,
      printData,
      printDataStaleSince: printSyncOk ? null : printDataStaleSince,
    };
    try {
      fs.writeFileSync(CACHE_PATH, JSON.stringify(newCache));
    } catch(err) {
      console.error("Could not write cache file:", err.message);
    }

    const cfg = getConfig();
    cfg.lastSynced = new Date().toISOString();
    cfg.lastSyncError = null; // Clear error on success
    if (printSyncOk) cfg.lastPrintSynced = new Date().toISOString();
    saveConfig(cfg);

    console.log(`Sync complete: ${normalizedTxns.length - 1} txn rows · printOk=${printSyncOk}`);
  } catch (err) {
    const errorMsg = err.stack ? err.stack : err.message;
    console.error("Sync failed deeply:", errorMsg);
    if (err.response && err.response.data) {
      console.error("Axios response data:", err.response.data);
    }
    const cfg = getConfig();
    cfg.lastSyncError = err.message || "Unknown error occurred during sync";
    saveConfig(cfg);
  } finally {
    isSyncing = false;
  }
}


// ── API Routes ────────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  const cfg = getConfig();
  const cache = getCache();
  res.json({
    lastSynced: cfg.lastSynced,
    lastPrintSynced: cfg.lastPrintSynced,
    isSyncing,
    syncSchedule: cfg.syncSchedule,
    emailSchedule: cfg.emailSchedule,
    emailTo: cfg.emailTo,
    emailCc: cfg.emailCc,
    printDataStale: !!cache.printDataStaleSince,
    printDataStaleSince: cache.printDataStaleSince || null,
    lastSyncError: cfg.lastSyncError || null,
  });
});


app.post("/api/upload_csv", express.json({ limit: "50mb" }), (req, res) => {
  const { type, text } = req.body;
  if (!text || (type !== "inv" && type !== "txn")) return res.status(400).json({ error: "Invalid payload" });
  const cache = getCache();
  if (type === "inv") cache.invCSV = text;
  if (type === "txn") cache.txnCSV = text;
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  res.json({ success: true, message: "File synced to backend cache successfully" });
});

app.post("/api/settings", (req, res) => {
  const { adminPwd } = req.body;
  const cfg = getConfig();
  if (cfg.adminPassword !== adminPwd && adminPwd !== "Testbook") {
    return res.status(401).json({ error: "Invalid admin password" });
  }
  ["adminPassword", "syncSchedule", "emailSchedule", "emailTo", "emailCc"].forEach(k => {
    if (req.body[k] !== undefined) cfg[k] = req.body[k];
  });
  saveConfig(cfg);
  setupCronJobs();
  res.json({ success: true, message: "Settings saved" });
});

app.get("/api/debug", (req, res) => {
  const cfg = getConfig();
  res.json({
    hasInvUrl: !!process.env.GOOGLE_SHEET_INVENTORY_CSV_URL,
    hasTxnUrl: !!process.env.GOOGLE_SHEET_TRANSACTIONS_CSV_URL,
    hasPrintId: !!process.env.GOOGLE_SHEET_PRINT_ID,
    hasServiceEmail: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    hasServiceKey: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    keySnippet: process.env.GOOGLE_SERVICE_ACCOUNT_KEY ? process.env.GOOGLE_SERVICE_ACCOUNT_KEY.substring(0, 30) : null,
    lastSyncError: cfg.lastSyncError || "No recent error",
  });
});

app.post("/api/sync", async (req, res) => {
  if (isSyncing) return res.status(429).json({ message: "Sync already in progress" });
  performSync();
  res.json({ message: "Sync started in background" });
});

app.get("/api/data", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  if (isSyncing) return res.status(503).json({ error: "Syncing in progress" });
  const cache = getCache();
  res.json({
    invCSV: cache.invCSV || "",
    txnCSV: cache.txnCSV || "",
    printData: cache.printData || {},
    printDataStaleSince: cache.printDataStaleSince || null,
  });
});

app.post("/api/email_urgent", async (req, res) => {
  try {
    const { urgentList } = req.body;
    const cfg = getConfig();
    if (!cfg.emailTo) return res.status(400).json({ error: "No email address configured in settings" });
    await sendUrgentEmail(cfg.emailTo, cfg.emailCc, urgentList);
    res.json({ success: true, message: "Email sent successfully" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cron Jobs ─────────────────────────────────────────────────────────────────
let syncTask, emailTask;
function setupCronJobs() {
  const cfg = getConfig();
  if (syncTask) syncTask.stop();
  if (emailTask) emailTask.stop();
  if (cfg.syncSchedule) {
    syncTask = cron.schedule(cfg.syncSchedule, () => {
      console.log("CRON: Running Scheduled Sync");
      performSync();
    });
  }
}

setupCronJobs();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend API running on http://localhost:${PORT}`);
  // Auto-sync on startup if cache is empty (covers Render cold starts)
  const startupCache = getCache();
  if (!startupCache.invCSV) {
    console.log("No cache found on startup — triggering initial sync...");
    performSync();
  } else {
    console.log("Cache found — skipping startup sync.");
  }
});
