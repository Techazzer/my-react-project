require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const axios = require("axios");
const { google } = require("googleapis");
const { sendUrgentEmail } = require("./mailer");

const app = express();
app.use(cors());
app.use(express.json());

const CONFIG_PATH = path.join(__dirname, "../backend_config.json");
const CACHE_PATH = path.join(__dirname, "../backend_cache.json");

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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function getCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch (e) {}
  return { invCSV: "", txnCSV: "", printData: {}, printDataStaleSince: null };
}

let isSyncing = false;

// ── Google Sheets API (Print Mastersheet) ───────────────────────────────────
async function fetchPrintMastersheet() {
  const sheetId = process.env.GOOGLE_SHEET_PRINT_ID;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (!sheetId || !email || !keyRaw) {
    throw new Error("Print Mastersheet env vars not configured");
  }

  const privateKey = keyRaw.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const printTab = process.env.GOOGLE_SHEET_PRINT_TAB || "";
  const printRange = printTab ? `${printTab}!A:Q` : "A:Q";

  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: printRange,
  });

  const rows = response.data.values || [];
  if (rows.length < 2) return {};

  // Skip header row. Build printData map:
  // For each SKU, filter Col E = "In Print" AND Col I = "GGN"
  // Then pick most recent by Col N (Sent to Printing Date)
  // Cols: A=SKU, E=Status, I=Warehouse, M=QtyOrdered, N=SentDate, O=PrinterETA, P=PrintingDoneDate, Q=GRNDate
  // Index:  0     4         8             12              13            14                15               16

  const allRows = rows.slice(1); // skip header

  const bySkuActive = {}; // sku -> best row

  for (const row of allRows) {
    const sku = (row[0] || "").trim();
    const status = (row[4] || "").trim();
    const warehouse = (row[8] || "").trim();

    if (!sku || status !== "In Print" || warehouse !== "GGN") continue;

    const sentDateStr = (row[13] || "").trim();
    const sentDate = sentDateStr ? new Date(sentDateStr) : null;

    if (!bySkuActive[sku]) {
      bySkuActive[sku] = row;
    } else {
      // Pick most recent Sent to Printing date
      const existingSentStr = (bySkuActive[sku][13] || "").trim();
      const existingSent = existingSentStr ? new Date(existingSentStr) : null;
      if (sentDate && (!existingSent || sentDate > existingSent)) {
        bySkuActive[sku] = row;
      }
    }
  }

  // Build normalized printData map
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
    console.log("[SYNC] Starting full sync at", new Date().toISOString());

    const invUrl = process.env.GOOGLE_SHEET_INVENTORY_CSV_URL;
    const txnUrl = process.env.GOOGLE_SHEET_TRANSACTIONS_CSV_URL;
    console.log("[SYNC] invUrl present:", !!invUrl, "| txnUrl present:", !!txnUrl);
    if (!invUrl || !txnUrl) throw new Error("Google Sheets CSV URLs missing in .env");

    let printSyncOk = true;

    // ── Fetch Inventory + Transactions CSVs ──────────────────────────────────
    console.log("[SYNC] Fetching inventory CSV...");
    const [invRes, txnRes] = await Promise.all([
      axios.get(invUrl),
      axios.get(txnUrl)
    ]);
    console.log("[SYNC] Inventory response status:", invRes.status, "| bytes:", invRes.data?.length);
    console.log("[SYNC] Transactions response status:", txnRes.status, "| bytes:", txnRes.data?.length);

    const invCSV = invRes.data.trim();
    const txnCSVRaw = txnRes.data.trim();
    console.log("[SYNC] invCSV lines:", invCSV.split("\n").length, "| txnCSV raw lines:", txnCSVRaw.split("\n").length);

    const txnRows = parseGoogleSheetCSV(txnCSVRaw);
    if (txnRows.length < 2) throw new Error("Transaction sheet is empty after parsing");
    console.log("[SYNC] Parsed txn rows:", txnRows.length, "| Headers:", txnRows[0].slice(0, 6).join(", "));

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
    console.log("[SYNC] Column indices — SKU:", skuIdx, "Qty:", qtyIdx, "Date:", dateIdx, "Channel:", channelIdx, "Status:", statusIdx);

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
      const quote = (s) => `"${(s || "").replace(/"/g, '""')}`;
      normalizedTxns.push(`${quote(sku)}",${qty},${quote(dateRaw)}",${quote(channel)}",${quote(status)}",${quote(isReverse)}"`);
    }
    const txnCSV = normalizedTxns.join("\n");
    console.log("[SYNC] Normalized txn rows:", normalizedTxns.length - 1);

    // ── Fetch Print Mastersheet ───────────────────────────────────────────────
    let printData = cache.printData || {};
    let printDataStaleSince = null;
    try {
      console.log("[SYNC] Fetching Print Mastersheet via Sheets API...");
      console.log("[SYNC] GOOGLE_SHEET_PRINT_ID present:", !!process.env.GOOGLE_SHEET_PRINT_ID);
      console.log("[SYNC] GOOGLE_SERVICE_ACCOUNT_EMAIL present:", !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
      console.log("[SYNC] GOOGLE_SERVICE_ACCOUNT_KEY present:", !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      console.log("[SYNC] GOOGLE_SHEET_PRINT_TAB:", process.env.GOOGLE_SHEET_PRINT_TAB || "(blank - using first sheet)");
      printData = await fetchPrintMastersheet();
      console.log("[SYNC] Print Mastersheet OK — active SKUs:", Object.keys(printData).length);
    } catch (printErr) {
      console.error("[SYNC] Print Mastersheet FAILED:", printErr.message);
      if (printErr.message.includes("403") || printErr.message.includes("PERMISSION")) {
        console.error("[SYNC] → Check sheet is shared with:", process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
      }
      if (printErr.message.includes("404")) {
        console.error("[SYNC] → Check GOOGLE_SHEET_PRINT_ID is correct:", process.env.GOOGLE_SHEET_PRINT_ID);
      }
      if (printErr.message.includes("range") || printErr.message.includes("tab")) {
        console.error("[SYNC] → Check GOOGLE_SHEET_PRINT_TAB is the exact tab name in the sheet");
      }
      printSyncOk = false;
      printDataStaleSince = cache.printDataStaleSince || new Date().toISOString();
    }

    // ── Save cache ────────────────────────────────────────────────────────────
    const newCache = { invCSV, txnCSV, printData, printDataStaleSince: printSyncOk ? null : printDataStaleSince };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(newCache));
    const cfg = getConfig();
    cfg.lastSynced = new Date().toISOString();
    if (printSyncOk) cfg.lastPrintSynced = new Date().toISOString();
    saveConfig(cfg);
    console.log(`[SYNC] Done! invCSV:${invCSV.split("\n").length}lines txn:${normalizedTxns.length - 1}rows print:${Object.keys(printData).length}SKUs printOk:${printSyncOk}`);
  } catch (err) {
    console.error("[SYNC] FAILED:", err.message);
    console.error("[SYNC] Stack:", err.stack?.split("\n").slice(0, 3).join(" | "));
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
    printSheetId: process.env.GOOGLE_SHEET_PRINT_ID || "",
    printSheetGid: process.env.GOOGLE_SHEET_PRINT_GID || "",
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
  const invLines = cache.invCSV ? cache.invCSV.split("\n").length - 1 : 0;
  const txnLines = cache.txnCSV ? cache.txnCSV.split("\n").length - 1 : 0;
  const printSKUs = cache.printData ? Object.keys(cache.printData).length : 0;
  console.log(`[DATA] Serving cache: inv=${invLines} rows, txn=${txnLines} rows, print=${printSKUs} SKUs`);
  res.json({
    invCSV: cache.invCSV || "",
    txnCSV: cache.txnCSV || "",
    printData: cache.printData || {},
    printDataStaleSince: cache.printDataStaleSince || null,
    _meta: { invLines, txnLines, printSKUs },
  });
});

app.get("/api/debug", (req, res) => {
  const cache = getCache();
  const cfg = getConfig();
  res.json({
    timestamp: new Date().toISOString(),
    isSyncing,
    lastSynced: cfg.lastSynced,
    lastPrintSynced: cfg.lastPrintSynced,
    env: {
      hasInvUrl: !!process.env.GOOGLE_SHEET_INVENTORY_CSV_URL,
      hasTxnUrl: !!process.env.GOOGLE_SHEET_TRANSACTIONS_CSV_URL,
      hasPrintId: !!process.env.GOOGLE_SHEET_PRINT_ID,
      printId: process.env.GOOGLE_SHEET_PRINT_ID || "(not set)",
      printTab: process.env.GOOGLE_SHEET_PRINT_TAB || "(blank - first sheet)",
      hasServiceEmail: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      serviceEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "(not set)",
      hasServiceKey: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    },
    cache: {
      invCSV_lines: cache.invCSV ? cache.invCSV.split("\n").length : 0,
      txnCSV_lines: cache.txnCSV ? cache.txnCSV.split("\n").length : 0,
      printData_skus: cache.printData ? Object.keys(cache.printData).length : 0,
      printDataStaleSince: cache.printDataStaleSince || null,
    },
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
});
