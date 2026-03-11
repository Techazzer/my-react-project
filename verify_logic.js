/**
 * verify_logic.js
 * ───────────────
 * Standalone audit script that re-runs EXACTLY the same logic as App.jsx.
 * Run with:  node verify_logic.js [OPTIONAL_SKU_FILTER]
 * Examples:
 *   node verify_logic.js                     → prints top 20 by urgency
 *   node verify_logic.js TB_UPSC_DY_EN       → deep-dive a single SKU
 *   node verify_logic.js ALL                 → prints every active SKU
 */

const fs = require("fs");
const path = require("path");
const dir = __dirname;

// ─── Config (must match App.jsx) ──────────────────────────────────────────────
const LEAD_TIME  = 15;
const PROJ_DAYS  = 60;
const SPIKE_THR  = 1.3;
const LOOSEN_THR = 0.5;

// ─── Robust CSV Parser (identical to App.jsx) ─────────────────────────────────
function parseCSV(text) {
  if (!text) return [];
  const results = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') { field += '"'; i++; }
      else if (char === '"') inQuotes = false;
      else field += char;
    } else {
      if (char === '"') inQuotes = true;
      else if (char === ',') { row.push(field); field = ""; }
      else if (char === '\n' || char === '\r') {
        row.push(field); results.push(row); row = []; field = "";
        if (char === '\r' && next === '\n') i++;
      } else field += char;
    }
  }
  if (field || row.length) { row.push(field); results.push(row); }
  if (!results.length) return [];
  const headers = results[0].map(h => h.trim().replace(/^"|"$/g, ""));
  return results.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] ?? "").trim().replace(/^"|"$/g, ""); });
    return obj;
  });
}

// ─── Load Files ───────────────────────────────────────────────────────────────
const invText    = fs.readFileSync(path.join(dir, "Current Inventory SR.csv"), "utf8");
const txnText    = fs.readFileSync(path.join(dir, "Total Transactions SR.csv"), "utf8");
const mapText    = fs.readFileSync(path.join(dir, "Mapped SKUs.csv"), "utf8");
const statusText = fs.readFileSync(path.join(dir, "SKU Status SR.csv"), "utf8");

const invRows    = parseCSV(invText);
const txnRows    = parseCSV(txnText);
const mapRows    = parseCSV(mapText);
const statusRows = parseCSV(statusText);

console.log(`\n📦 Loaded:  ${invRows.length} inventory rows | ${txnRows.length} transactions | ${mapRows.length} mapping rows\n`);

// ─── Build Many-to-Many Mapping Dict (child → [master, ...]) ─────────────────
const mappingDict = {};
for (const r of mapRows) {
  const master = (r.master_sku || "").trim();
  const mapped  = (r.mapped_skus || "").trim();
  if (!master || !mapped) continue;
  mapped.split(",").map(s => s.trim()).filter(Boolean).forEach(child => {
    mappingDict[child] = mappingDict[child] || [];
    if (!mappingDict[child].includes(master)) mappingDict[child].push(master);
  });
}

// Build reverseMap: master → [children]
const reverseMap = {};
for (const [child, masters] of Object.entries(mappingDict)) {
  masters.forEach(master => {
    reverseMap[master] = reverseMap[master] || [];
    if (!reverseMap[master].includes(child)) reverseMap[master].push(child);
  });
}

// ─── Build Status Lookup ──────────────────────────────────────────────────────
const statusLookup = {};
for (const r of statusRows) {
  const sku = (r["Master SKU"] || "").trim();
  if (sku) statusLookup[sku] = { name: r["Product Name"]?.trim(), status: r["Status"]?.trim() };
}

// ─── Build masterData from Inventory ─────────────────────────────────────────
const masterData = {};
for (const inv of invRows) {
  const sku = (inv["Master SKU"] || "").trim();
  if (!sku) continue;
  const info = statusLookup[sku] || {};
  masterData[sku] = {
    sku,
    name: (inv["Product Name"] || info.name || sku).trim().slice(0, 60),
    stock: parseFloat(inv["Available Inventory - Good"]) || 0,
    inv30d: parseInt(inv["Quantity used in the last 30 days"]) || 0, // ← Inventory CSV's own 30d number (ground truth)
    status_tag: info.status || "Active",
  };
}

// ─── Time Windows ─────────────────────────────────────────────────────────────
const today           = new Date();
const d30             = new Date(today); d30.setDate(today.getDate() - 30);
const d10             = new Date(today); d10.setDate(today.getDate() - 10);
const lastMonthObj    = new Date(today.getFullYear(), today.getMonth() - 1, 1);
const endLastMonth    = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59);
const daysLastMonth   = endLastMonth.getDate();
const prevMonthObj    = new Date(today.getFullYear(), today.getMonth() - 2, 1);
const endPrevMonth    = new Date(today.getFullYear(), today.getMonth() - 1, 0, 23, 59, 59);
const daysPrevMonth   = endPrevMonth.getDate();
const monthNames      = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const lastMonthName   = monthNames[lastMonthObj.getMonth()];
const prevMonthName   = monthNames[prevMonthObj.getMonth()];

// ─── Aggregate Transactions ───────────────────────────────────────────────────
const s10 = {}, s30 = {}, sM1 = {}, sM2 = {};

let skipped = 0, counted = 0;
for (const row of txnRows) {
  if ((row["Is Reverse"] || "").toLowerCase() === "yes") { skipped++; continue; }
  if ((row["Status"] || "").toUpperCase() === "CANCELED")  { skipped++; continue; }
  const rawSku = (row["Master SKU"] || "").trim();
  const qty    = parseFloat(row["Product Quantity"]) || 1;
  const dt     = new Date(row["Shiprocket Created At"] || "");
  if (!rawSku || isNaN(dt)) { skipped++; continue; }

  const masters = mappingDict[rawSku] || [rawSku];
  counted++;
  masters.forEach(sku => {
    if (dt >= d10) s10[sku] = (s10[sku] || 0) + qty;
    if (dt >= d30) s30[sku] = (s30[sku] || 0) + qty;
    if (dt >= lastMonthObj && dt <= endLastMonth) sM1[sku] = (sM1[sku] || 0) + qty;
    else if (dt >= prevMonthObj && dt <= endPrevMonth) sM2[sku] = (sM2[sku] || 0) + qty;
  });
}
console.log(`✅ Processed: ${counted} valid transactions | ${skipped} skipped (cancelled/reverse)\n`);

// ─── Calculate Rates ─────────────────────────────────────────────────────────
const results = [];
for (const sku in masterData) {
  const data   = masterData[sku];
  if (data.status_tag.toLowerCase() !== "active") continue;

  const v10    = s10[sku] || 0;
  const v30    = s30[sku] || 0;
  const vM1    = sM1[sku] || 0;
  const vM2    = sM2[sku] || 0;

  const r10    = v10 / 10;
  const rm1    = vM1 / daysLastMonth;
  const rm2    = vM2 / daysPrevMonth;
  const r2mo   = (rm1 + rm2) / 2;

  if (r10 === 0 && r2mo === 0 && data.stock === 0) continue;

  const spikeFactor = r2mo > 0 ? r10 / r2mo : (r10 > 0 ? 9 : 0);
  const hasSpike    = spikeFactor > SPIKE_THR;
  const hasLoosen   = r2mo > 0 && !hasSpike && spikeFactor < LOOSEN_THR;

  let effRate;
  if (hasSpike)       effRate = 0.6 * r10 + 0.4 * r2mo;
  else if (hasLoosen) effRate = 0.4 * r10 + 0.6 * r2mo;
  else                effRate = r2mo;

  if (effRate === 0) continue;

  const daysOut = data.stock / effRate;
  const status  = daysOut < LEAD_TIME ? "URGENT" : daysOut < (PROJ_DAYS + LEAD_TIME) ? "AT_RISK" : "SAFE";

  // Drift = difference between our 30d calc and inventory CSV's own figure
  const drift = Math.abs(v30 - data.inv30d);

  results.push({
    sku, name: data.name, stock: data.stock, status,
    days_out: +daysOut.toFixed(1),
    v10, v30, inv30d: data.inv30d, drift,
    r10: +r10.toFixed(2), rm1: +rm1.toFixed(2), rm2: +rm2.toFixed(2),
    r2mo: +r2mo.toFixed(2), effRate: +effRate.toFixed(2),
    spikeFactor: +spikeFactor.toFixed(2), hasSpike, hasLoosen,
    proj60: Math.round(effRate * 60),
    mappedChildren: reverseMap[sku] || [],
  });
}
results.sort((a, b) => a.days_out - b.days_out);

// ─── Output ───────────────────────────────────────────────────────────────────
const skuFilter = process.argv[2] || "";
const toShow    = skuFilter.toUpperCase() === "ALL"
  ? results
  : skuFilter
    ? results.filter(r => r.sku.toLowerCase().includes(skuFilter.toLowerCase()))
    : results.slice(0, 30);

if (!toShow.length) {
  console.log("❌  No matching SKUs found.\n");
  process.exit(0);
}

// Header
console.log("═".repeat(130));
console.log(
  "STATUS".padEnd(10) +
  "SKU".padEnd(26) +
  "Stock".padStart(7) +
  "DaysOut".padStart(9) +
  "30d(calc)".padStart(11) +
  "30d(inv)".padStart(10) +
  "Drift%".padStart(8) +
  "r10".padStart(7) +
  `r(${lastMonthName})`.padStart(8) +
  `r(${prevMonthName})`.padStart(8) +
  "2moAvg".padStart(8) +
  "effRate".padStart(9) +
  "Mode".padStart(9) +
  "Reorder".padStart(9)
);
console.log("─".repeat(130));

for (const r of toShow) {
  const mode    = r.hasSpike ? "⚡SPIKE" : r.hasLoosen ? "📉LOOSEN" : "NORMAL";
  const driftPct = r.inv30d > 0 ? `${Math.round((r.drift / r.inv30d) * 100)}%` : "N/A";

  console.log(
    r.status.padEnd(10) +
    r.sku.padEnd(26) +
    String(r.stock).padStart(7) +
    String(r.days_out).padStart(9) +
    String(r.v30).padStart(11) +
    String(r.inv30d).padStart(10) +
    driftPct.padStart(8) +
    String(r.r10).padStart(7) +
    String(r.rm1).padStart(8) +
    String(r.rm2).padStart(8) +
    String(r.r2mo).padStart(8) +
    String(r.effRate).padStart(9) +
    mode.padStart(9) +
    String(Math.max(0, r.proj60 - r.stock)).padStart(9)
  );

  // Deep-dive: show child SKUs and per-child 30d contribution
  if (skuFilter && skuFilter.toUpperCase() !== "ALL") {
    console.log();
    console.log(`  📌 Mapped children (${r.mappedChildren.length}):`);
    r.mappedChildren.forEach(child => {
      const childRaw = (mappingDict[child] || []).join(", ");
      const childTxns = txnRows.filter(row => {
        if ((row["Is Reverse"] || "").toLowerCase() === "yes") return false;
        if ((row["Status"] || "").toUpperCase() === "CANCELED") return false;
        if ((row["Master SKU"] || "").trim() !== child) return false;
        const dt = new Date(row["Shiprocket Created At"] || "");
        return !isNaN(dt) && dt >= d30;
      });
      const childQty = childTxns.reduce((acc, row) => acc + (parseFloat(row["Product Quantity"]) || 1), 0);
      console.log(`    → ${child.padEnd(28)} 30d contrib: ${String(childQty).padStart(5)}`);
    });
    console.log();
    console.log(`  📊 Rate breakdown:`);
    console.log(`     10d  window : ${r.v10} units → ${r.r10}/day`);
    console.log(`     ${lastMonthName} window : ${sM1[r.sku] || 0} units over ${daysLastMonth}d → ${r.rm1}/day`);
    console.log(`     ${prevMonthName} window : ${sM2[r.sku] || 0} units over ${daysPrevMonth}d → ${r.rm2}/day`);
    console.log(`     2-mo avg    : ${r.r2mo}/day`);
    console.log(`     spike factor: ${r.spikeFactor}  (threshold ${SPIKE_THR})`);
    if (r.hasSpike)  console.log(`     ⚡ SPIKE — blending 60% r10 + 40% r2mo = ${r.effRate}/day`);
    if (r.hasLoosen) console.log(`     📉 LOOSEN (factor < ${LOOSEN_THR}) — blending 40% r10 + 60% r2mo = ${r.effRate}/day`);
    if (!r.hasSpike && !r.hasLoosen) console.log(`     NORMAL — using pure 2mo avg = ${r.effRate}/day`);
    console.log(`     60d proj    : ${r.proj60} units  |  reorder: ${Math.max(0, r.proj60 - r.stock)}`);
    console.log();
    console.log(`  🔍 Drift check:`);
    console.log(`     Our 30d calc : ${r.v30} units`);
    console.log(`     Inventory CSV: ${r.inv30d} units (\"Quantity used in the last 30 days\")`);
    console.log(`     Difference   : ${r.drift} units (${r.inv30d > 0 ? Math.round((r.drift/r.inv30d)*100) : "N/A"}%)`);
    if (r.drift > r.inv30d * 0.3) {
      console.log(`     ⚠️  Large drift! Possible double-counting or date window mismatch.`);
    } else {
      console.log(`     ✅ Within 30% tolerance — looks correct.`);
    }
  }
}

console.log("─".repeat(130));
console.log(`\n📋 Total active SKUs shown: ${toShow.length} of ${results.length}`);
console.log(`   Date window: last 30d = ${d30.toDateString()} → ${today.toDateString()}`);
console.log(`   ${lastMonthName} = ${lastMonthObj.toDateString()} → ${endLastMonth.toDateString()} (${daysLastMonth}d)`);
console.log(`   ${prevMonthName} = ${prevMonthObj.toDateString()} → ${endPrevMonth.toDateString()} (${daysPrevMonth}d)`);
console.log();
console.log("💡 Usage:");
console.log("   node verify_logic.js                  → top 30 by urgency (summary)");
console.log("   node verify_logic.js TB_UPSC_DY_EN    → deep-dive single SKU");
console.log("   node verify_logic.js ALL               → all active SKUs");
console.log();
