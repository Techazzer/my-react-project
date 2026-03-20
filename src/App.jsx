import { useState, useMemo, useCallback, useEffect, useRef } from "react";

// ─── Config ───────────────────────────────────────────────────────────────────
const LEAD_TIME  = 15;
const PROJ_DAYS  = 60;
const SPIKE_THR  = 1.3;  // r10/r2mo ratio above which we declare a spike (demand surging)
const LOOSEN_THR = 0.5;  // r10/r2mo ratio below which we declare a slowdown (last 10d ≤50% of avg)

// ─── Download CSV ─────────────────────────────────────────────────────────────
function downloadCSV(data, type = "projections", reverseMap = {}) {
  let headers = [];
  let rows = [];
  let filename = `export_${new Date().toISOString().slice(0, 10)}.csv`;

  if (type === "projections") {
    headers = [
      "Reprint Decision", "Status", "SKU", "Product Name",
      "Current Stock", "Days to Stockout", "Reorder Qty",
      "Rate Last 10d", "Rate Last Month", "Rate Prev Month",
      "2Mo Avg Rate", "Actual 30d Units", "30d Rate (ADS)", "Spike Factor", "Spike Detected", "Loosen Detected",
      "Effective Rate", "60d Projected Demand", "Old 60d Demand", "Delta Spike Impact",
      "Channels (Last 30d)", "Mapped From"
    ];
    rows = data.map(r => {
      const channels = r.channels30d ? Object.entries(r.channels30d).map(([c, q]) => `${c}: ${q}`).join(" | ") : "";
      const mapped = reverseMap[r.sku] ? reverseMap[r.sku].join(", ") : "";
      return [
        r.status === "urgent" ? "REPRINT IMMEDIATELY" : r.status === "at_risk" ? "REPRINT SOON" : "SAFE - MONITOR",
        r.status.toUpperCase(), r.sku,
        `"${r.name.replace(/"/g, '""')}"`,
        r.stock,
        r.days_out < 1 ? "< 1" : r.days_out.toFixed(1),
        r.reorder_qty,
        r.r10, r.rm1, r.rm2, r.r2mo,
        r.total30d, r.r30,
        r.spike_factor, r.has_spike ? "YES" : "No", r.has_loosen ? "YES" : "No",
        r.eff_rate, r.proj60, r.old_proj60, r.proj60 - r.old_proj60,
        `"${channels}"`, `"${mapped}"`
      ];
    });
    filename = `projection_${new Date().toISOString().slice(0, 10)}.csv`;
  } else if (type === "dead") {
    headers = ["SKU", "Product Name", "Available Stock", "Status Tag"];
    rows = data.map(r => [r.sku, `"${r.name.replace(/"/g, '""')}"`, r.stock, r.status]);
    filename = `dead_stock_${new Date().toISOString().slice(0, 10)}.csv`;
  } else if (type === "mapped") {
    headers = ["Master SKU", "Mapped From / Child SKUs"];
    // For mapping, data is object like { Child: Master } we want Master -> [Children]
    const masterMap = {};
    for (const [child, master] of Object.entries(data)) {
      if (!masterMap[master]) masterMap[master] = [];
      masterMap[master].push(child);
    }
    rows = Object.entries(masterMap).map(([master, children]) => [master, `"${children.join(", ")}"`]);
    filename = `sku_mappings_${new Date().toISOString().slice(0, 10)}.csv`;
  }

  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Ghost SKU CSV Download ───────────────────────────────────────────────────
function downloadGhostCSV(ghostSkus) {
  const date = new Date().toISOString().slice(0, 10);

  // Collect all unique channels across all ghosts (for dynamic columns)
  const allChannels = [...new Set(
    ghostSkus.flatMap(g => Object.keys(g.channels30d || {}))
  )].sort();

  const headers = [
    "Raw SKU (from Transactions)",
    "Total Units (Last 30d)",
    "Status in Status CSV",
    ...allChannels.map(c => `${c} (30d)`),
    "Action Required",
  ];

  const rows = ghostSkus.map(g => [
    g.sku,
    g.units30d,
    g.status || "—",
    ...allChannels.map(c => g.channels30d?.[c] || 0),
    "\"Add to Inventory CSV + SKU Status CSV + Mapped SKUs (if combo/bundle)\"",
  ]);

  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ghost_skus_${date}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────
// Robust CSV Parser that handles quoted newlines and commas
function parseCSV(text) {
  if (!text) return [];
  const results = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n" || char === "\r") {
        row.push(field);
        results.push(row);
        row = [];
        field = "";
        if (char === "\r" && nextChar === "\n") i++;
      } else {
        field += char;
      }
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    results.push(row);
  }

  if (results.length === 0) return [];
  const headers = results[0].map(h => h.trim().replace(/^"|"$/g, ""));
  return results.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (r[i] ?? "").trim().replace(/^"|"$/g, "");
    });
    return obj;
  });
}

// ─── Data Processing ──────────────────────────────────────────────────────────
function processData(invRows, txnRows, statusText, mappedText) {
  // 1. Build Mapping Dictionary: mapped_skus -> Master SKU
  // Now supports many-to-many (e.g. child SKU maps to multiple master SKUs)
  const mappingDict = {}; 
  if (mappedText) {
    const mapRows = parseCSV(mappedText);
    for (const r of mapRows) {
      const master = (r.master_sku || "").trim();
      const mapped = (r.mapped_skus || "").trim();
      if (!master || !mapped) continue;
      
      const children = mapped.split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
      children.forEach(c => { 
        mappingDict[c] = mappingDict[c] || [];
        if (!mappingDict[c].includes(master)) mappingDict[c].push(master);
      });
    }
  }

  // 2. Build Inventory & Status Dictionary
  // 2. Build Inventory & Status Lookup
  const statusLookup = {};
  if (statusText) {
    const statusRows = parseCSV(statusText);
    for (const r of statusRows) {
      const sku = (r["Master SKU"] || "").trim();
      if (!sku) continue;
      statusLookup[sku] = {
        name: (r["Product Name"] || "").trim(),
        status: (r["Status"] || "").trim()
      };
    }
  }

  const masterData = {};
  // First, process the uploaded Inventory CSV (primary source of truth for stock)
  for (const inv of invRows) {
    const sku = (inv["Master SKU"] || inv["Channel SKU"] || inv["Product SKU"] || inv["SKU"] || "").trim();
    if (!sku) continue;
    const info = statusLookup[sku] || {};
    masterData[sku] = {
      sku,
      name: (inv["Name"] || inv["Product Name"] || info.name || sku).trim(),
      stock: parseFloat(inv["Available Inventory - Good"] || inv["Current Stock"] || inv["Available Inventory"] || inv["Quantity"]) || 0,
      status_tag: info.status || "Active"
    };
  }

  // Then, if any SKU exists in the Status CSV but was missing from the uploaded Inventory CSV,
  // we add it with 0 stock (so they appear in the right views).
  if (statusText) {
    for (const sku in statusLookup) {
      if (!masterData[sku]) {
        masterData[sku] = {
          sku,
          name: statusLookup[sku].name,
          stock: 0,
          status_tag: statusLookup[sku].status
        };
      }
    }
  }

  // 3. Time Windows (Last 10 Days & Calendar Months)
  const today = new Date();

  // Last 30 Days Window
  const d30 = new Date(today);
  d30.setDate(today.getDate() - 30);

  // Last 10 Days Window
  const d10 = new Date(today);
  d10.setDate(today.getDate() - 10);

  // Month Formatters
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Last Month (M-1)
  const lastMonthObj = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const startLastMonth = lastMonthObj;
  const endLastMonth = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59);
  const daysLastMonth = endLastMonth.getDate();
  const lastMonthName = monthNames[lastMonthObj.getMonth()];

  // Previous Month (M-2)
  const prevMonthObj = new Date(today.getFullYear(), today.getMonth() - 2, 1);
  const startPrevMonth = prevMonthObj;
  const endPrevMonth = new Date(today.getFullYear(), today.getMonth() - 1, 0, 23, 59, 59);
  const daysPrevMonth = endPrevMonth.getDate();
  const prevMonthName = monthNames[prevMonthObj.getMonth()];

  // Ongoing Month (M)
  const startOngoingMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const s10 = {}, s30 = {}, sM1 = {}, sM2 = {};
  // rawUnits30d / rawChannels30d: track units & channel breakdown per ORIGINAL
  // (pre-mapping) rawSku in last 30d — used for correct ghost detection and CSV export.
  const rawUnits30d = {};
  const rawChannels30d = {};

  // 4. Aggregate Transactions with Mapping
  for (const row of txnRows) {
    if ((row["Is Reverse"] || "").toLowerCase() === "yes") continue;
    if ((row["Status"] || row["Order Status"] || row["status"] || "").toUpperCase() === "CANCELED") continue;

    let rawSku = (row["Master SKU"] || row["Product SKU"] || row["Channel SKU"] || row["SKU"] || "").trim();
    const qty = parseFloat(row["Product Quantity"] || row["Quantity"]) || 1;
    let dtStr = row["Shiprocket Created At"] || row["Order Date"] || row["Date"] || row["created_at"] || "";
    // If Shiprocket sends DD-MM-YYYY format, converting to valid format for new Date()
    if (dtStr.includes("-") && dtStr.split("-")[0].length === 2) {
      const parts = dtStr.split(" ")[0].split("-");
      if (parts.length === 3) dtStr = `${parts[2]}-${parts[1]}-${parts[0]} ${dtStr.split(" ")[1] || ""}`;
    }
    const dt = new Date(dtStr);
    const channel = (row["Channel"] || row["Channel Name"] || "Unknown").toUpperCase();
    if (!rawSku || isNaN(dt)) continue;

    // Track raw units + channel breakdown before mapping (for ghost detection + CSV)
    if (dt >= d30) {
      rawUnits30d[rawSku] = (rawUnits30d[rawSku] || 0) + qty;
      rawChannels30d[rawSku] = rawChannels30d[rawSku] || {};
      rawChannels30d[rawSku][channel] = (rawChannels30d[rawSku][channel] || 0) + qty;
    }

    // Apply mapping to bundle/child SKUs (can be multiple masters)
    const masters = mappingDict[rawSku] || [rawSku];

    masters.forEach(sku => {
      // Initialize channel tracking on masterData if needed
      if (masterData[sku]) {
        masterData[sku].channels = masterData[sku].channels || {};
        masterData[sku].channels[channel] = (masterData[sku].channels[channel] || 0) + qty;

        if (dt >= d30) {
          masterData[sku].channels30d = masterData[sku].channels30d || {};
          masterData[sku].channels30d[channel] = (masterData[sku].channels30d[channel] || 0) + qty;
        }
      }

      // Aggregate s10, s30, sM1, sM2
      if (dt >= d10) s10[sku] = (s10[sku] || 0) + qty;
      if (dt >= d30) s30[sku] = (s30[sku] || 0) + qty;

      // Calendar month routing
      if (dt >= startLastMonth && dt <= endLastMonth) {
        sM1[sku] = (sM1[sku] || 0) + qty;
      } else if (dt >= startPrevMonth && dt <= endPrevMonth) {
        sM2[sku] = (sM2[sku] || 0) + qty;
      }
    });
  }

  // 5. Calculate Rates & Decisions
  const results = [];
  const deadStock = [];
  for (const sku in masterData) {
    const data = masterData[sku];
    // Segregate Dead Stock: NOT active, but has stock > 0
    if (data.status_tag.toLowerCase() !== "active") {
      if (data.stock > 0) {
        deadStock.push({ sku: data.sku, name: data.name, stock: data.stock, status: data.status_tag });
      }
      continue;
    }

    // Add mapped/combo consumption
    const v10 = s10[sku] || 0;
    const vM1 = sM1[sku] || 0;
    const vM2 = sM2[sku] || 0;

    const r10 = v10 / 10;
    const rm1 = vM1 / daysLastMonth;
    const rm2 = vM2 / daysPrevMonth;
    const r2mo = (rm1 + rm2) / 2;

    const total30d = s30[sku] || 0;
    const r30 = total30d / 30;

    if (r10 === 0 && r2mo === 0 && data.stock === 0) continue;

    const spikeFactor = r2mo > 0 ? r10 / r2mo : (r10 > 0 ? 9 : 0);
    const hasSpike   = spikeFactor > SPIKE_THR;
    // Loosen: last 10d rate is ≤50% of 2-month avg → demand is cooling down
    const hasLoosen  = r2mo > 0 && !hasSpike && spikeFactor < LOOSEN_THR;

    // Effective rate logic:
    // • Spike  → 60% recent (10d) + 40% historical (2mo)
    // • Loosen → 40% recent (10d) + 60% historical (2mo)  [pulls rate down but conservatively]
    // • Normal → pure 2-month avg
    let effRate;
    if (hasSpike)  effRate = 0.6 * r10 + 0.4 * r2mo;
    else if (hasLoosen) effRate = 0.4 * r10 + 0.6 * r2mo;
    else           effRate = r2mo;

    if (effRate === 0 && data.stock > 0) {
      results.push({
        ...data, name: data.name.slice(0, 70),
        r10: 0, rm1: 0, rm2: 0, r2mo: 0,
        spike_factor: 0, has_spike: false, has_loosen: false, eff_rate: 0,
        proj60: 0, old_proj60: 0, days_out: 999, reorder_qty: 0, status: "safe"
      });
      continue;
    }
    if (effRate === 0) continue;

    const proj60 = Math.round(effRate * 60);
    const daysOut = data.stock / effRate;
    const status = daysOut < LEAD_TIME ? "urgent" : daysOut < (PROJ_DAYS + LEAD_TIME) ? "at_risk" : "safe";

    results.push({
      ...data, name: data.name.slice(0, 70),
      total30d, r30: +r30.toFixed(2),
      r10: +r10.toFixed(2), rm1: +rm1.toFixed(2), rm2: +rm2.toFixed(2), r2mo: +r2mo.toFixed(2),
      spike_factor: +spikeFactor.toFixed(2), has_spike: hasSpike, has_loosen: hasLoosen,
      eff_rate: +effRate.toFixed(2),
      proj60, old_proj60: Math.round(r2mo * 60),
      days_out: +daysOut.toFixed(1), reorder_qty: Math.max(0, Math.round(proj60 - data.stock)), status,
    });
  }

  results.sort((a, b) => a.days_out - b.days_out);
  deadStock.sort((a, b) => b.stock - a.stock);

  // ── Ghost SKU Detection ───────────────────────────────────────────────────
  // RULE: A raw transaction SKU is a GHOST only if it has NO mapping AND
  // is NOT directly in the inventory CSV.
  //
  // KEY INSIGHT: If a combo (e.g. TBC_SB_BANK_EN) IS in mappingDict →
  // its sales are already attributed to its masters via the forEach loop.
  // Whether those masters are in inventory or not is a MASTER-level concern,
  // not a combo-level ghost. So mapped combos are NEVER ghosts.
  const ghostSkus = [];
  for (const rawSku of Object.keys(rawUnits30d)) {
    const isMapped     = !!(mappingDict[rawSku] && mappingDict[rawSku].length > 0);
    const isInInventory = !!masterData[rawSku];

    // Skip if already tracked in any way
    if (isMapped || isInInventory) continue;

    // True ghost: completely unknown — no mapping, not in inventory
    ghostSkus.push({
      sku: rawSku,
      units30d: rawUnits30d[rawSku],
      channels30d: rawChannels30d[rawSku] || {},
      status: statusLookup[rawSku]?.status || "—",
    });
  }
  ghostSkus.sort((a, b) => b.units30d - a.units30d);

  return { results, deadStock, mappingDict, lastMonthName, prevMonthName, ghostSkus };
}

// ─── UI Components ────────────────────────────────────────────────────────────
const statusCfg = {
  urgent: { badge: "bg-red-700 text-red-100", border: "border-red-700", bg: "bg-red-950", label: "🔴 URGENT" },
  at_risk: { badge: "bg-amber-700 text-amber-100", border: "border-amber-700", bg: "bg-amber-950", label: "🟡 AT RISK" },
  safe: { badge: "bg-green-700 text-green-100", border: "border-emerald-700", bg: "bg-emerald-950", label: "🟢 SAFE" },
};

function StockBar({ stock, proj60 }) {
  const pct = proj60 > 0 ? Math.min(100, (stock / proj60) * 100) : 0;
  const color = pct < 20 ? "#ef4444" : pct < 50 ? "#f59e0b" : "#22c55e";
  return (
    <div className="w-full bg-gray-800 rounded-full h-1.5 mt-2">
      <div style={{ width: `${Math.max(2, pct)}%`, backgroundColor: color }} className="h-1.5 rounded-full transition-all" />
    </div>
  );
}

function DropZone({ label, hint, onFile, loaded, fileName }) {
  const [drag, setDrag] = useState(false);
  const read = f => { if (!f) return; const r = new FileReader(); r.onload = e => onFile(e.target.result, f.name); r.readAsText(f); };
  
  return (
    <div
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); read(e.dataTransfer.files[0]); }}
      className={`relative p-6 border-2 border-dashed rounded-xl transition-all ${drag ? "border-indigo-500 bg-indigo-900/20" : loaded ? "border-emerald-500 bg-emerald-900/10" : "border-gray-700 bg-gray-800"}`}
    >
      <input type="file" accept=".csv" onChange={e => read(e.target.files[0])} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
      <div className="text-center pointer-events-none">
        {loaded ? <div className="text-green-400 font-bold mb-2 text-2xl">✅</div> : <div className="text-gray-500 text-2xl mb-2">📄</div>}
        <h3 className="font-bold text-gray-200">{label}</h3>
        <p className="text-xs mt-1 text-gray-400">{hint}</p>
        {loaded && fileName && <p className="text-xs mt-2 text-emerald-400 break-all">{fileName}</p>}
      </div>
    </div>
  );
}



function FormulaPanel() {
  return (
    <div className="rounded-2xl border border-indigo-700 bg-indigo-950/60 p-6 mb-6">
      <p className="text-indigo-300 font-mono text-xs uppercase tracking-widest mb-5">
        📐 Projection Formula — Adaptive Weighted Rate
      </p>

      {/* Steps grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        {[
          {
            title: "Step 1 · Measure Rates",
            lines: [
              ["rate_10d", "= sales(last 10d) ÷ 10"],
              ["rate_lastM", "= sales(last cal. month) ÷ days"],
              ["rate_prevM", "= sales(prev cal. month) ÷ days"],
              ["rate_2mo", "= (rate_lastM + rate_prevM) ÷ 2"],
            ],
          },
          {
            title: "Step 2 · Detect Spike / Loosen",
            lines: [
              ["spike_factor", "= rate_10d ÷ rate_2mo"],
              ["⚡ SPIKE", "if factor > " + SPIKE_THR + " (surging)"],
              ["📉 LOOSEN", "if factor < " + LOOSEN_THR + " (cooling)"],
            ],
          },
          {
            title: "Step 3 · Effective Rate",
            lines: [
              ["normal",   "eff = rate_2mo"],
              ["spike ⚡",  "eff = 0.6 × rate_10d"],
              ["",         "    + 0.4 × rate_2mo"],
              ["loosen 📉", "eff = 0.4 × rate_10d"],
              ["",         "    + 0.6 × rate_2mo"],
              ["why",      "spike: trust recent surge"],
              ["",         "loosen: trust history, dampen dip"],
            ],
          },
        ].map(block => (
          <div key={block.title} className="bg-indigo-900/30 rounded-xl p-4">
            <p className="text-indigo-400 font-mono text-xs mb-3">{block.title}</p>
            <div className="space-y-1.5">
              {block.lines.map(([label, val], i) => (
                <div key={i} className="flex gap-2 font-mono text-xs">
                  <span className="text-gray-500 shrink-0 w-24 truncate">{label}</span>
                  <span className="text-white">{val}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {[
          {
            title: "Step 4 · 60-Day Forecast",
            lines: [
              ["proj_60d", "= eff_rate × 60"],
              ["reorder_qty", "= max(0, proj_60d − stock)"],
              ["days_out", "= stock ÷ eff_rate"],
            ],
          },
          {
            title: "Step 5 · Reprint Decision",
            lines: [
              ["🔴 URGENT", "days_out < 15d  →  REPRINT IMMEDIATELY"],
              ["🟡 AT RISK", "15d ≤ days_out < 75d  →  REPRINT SOON"],
              ["🟢 SAFE", "days_out ≥ 75d  →  Monitor only"],
            ],
          },
        ].map(block => (
          <div key={block.title} className="bg-indigo-900/30 rounded-xl p-4">
            <p className="text-indigo-400 font-mono text-xs mb-3">{block.title}</p>
            <div className="space-y-1.5">
              {block.lines.map(([label, val], i) => (
                <div key={i} className="flex gap-2 font-mono text-xs">
                  <span className="text-gray-500 shrink-0 w-24 truncate">{label}</span>
                  <span className="text-white">{val}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Parameters row */}
      <div className="bg-indigo-900/20 rounded-xl p-4 border border-indigo-800/40">
        <p className="text-indigo-400 font-mono text-xs mb-3">Parameters</p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-1.5 font-mono text-xs">
          {[
            ["Print Lead Time",       "15 days"],
            ["Planning Window",       "60 days"],
            ["Trigger Horizon",       "75 days  (15 + 60)"],
            ["Spike Threshold",       "> " + SPIKE_THR + "×"],
            ["Spike Weight (recent)", "60%"],
            ["Spike Weight (hist.)",  "40%"],
            ["Loosen Threshold",      "< " + LOOSEN_THR + "×"],
            ["Loosen Weight (recent)","40%"],
            ["Loosen Weight (hist.)", "60%"],
          ].map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <span className="text-gray-500">{k}:</span>
              <span className="text-white">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Print Helpers ────────────────────────────────────────────────────────────
function getPrintStatus(sku, printData, daysToStockout) {
  const pd = printData?.[sku];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!pd) {
    const urgentNoOrder = daysToStockout != null && daysToStockout <= 15;
    return { state: urgentNoOrder ? "reprint_needed" : "none", qty: 0,
      printerETA: null, warehouseETA: null, grnDate: null,
      printerDelayDays: 0, warehouseDelayDays: 0, hasDelays: false, noETA: false };
  }

  const parseDate = (s) => {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };

  const grnDate = parseDate(pd.grnDate);
  const printerETA = parseDate(pd.printerETA);
  const warehouseETA = parseDate(pd.printingDoneDate); // Col P = printing done / warehouse ETA
  const sentDate = parseDate(pd.sentDate);

  const daysDiff = (d) => {
    if (!d) return 0;
    const t = new Date(d); t.setHours(0,0,0,0);
    return Math.floor((today - t) / 86400000);
  };

  const printerDelayDays = printerETA ? Math.max(0, daysDiff(printerETA)) : 0;
  const warehouseDelayDays = warehouseETA ? Math.max(0, daysDiff(warehouseETA)) : 0;
  const hasDelays = (printerDelayDays > 0 || warehouseDelayDays > 0) && !grnDate;
  const noETA = pd.qty > 0 && !printerETA && !warehouseETA;
  const state = grnDate ? "received" : "in_print";

  return { state, qty: pd.qty, printerETA, warehouseETA, grnDate,
    printerDelayDays, warehouseDelayDays, hasDelays, noETA };
}

function fmtDate(d) {
  if (!d) return null;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function PrintStatusRow({ sku, printData, daysToStockout }) {
  const ps = getPrintStatus(sku, printData, daysToStockout);

  if (ps.state === "received") {
    return (
      <div className="mt-2 pt-2 border-t border-gray-700/50">
        <span className="text-emerald-400 text-xs font-mono">✓ Received — stock arriving soon</span>
      </div>
    );
  }

  if (ps.state === "reprint_needed") {
    return (
      <div className="mt-2 pt-2 border-t border-gray-700/50">
        <span className="text-amber-400 text-xs font-mono">⚡ Reprint needed — no active print order</span>
      </div>
    );
  }

  if (ps.state === "none") {
    return (
      <div className="mt-2 pt-2 border-t border-gray-700/50">
        <span className="text-gray-600 text-xs font-mono">🖨 In Print: — · Not tracked</span>
      </div>
    );
  }

  // in_print state
  const parts = [`🖨 In Print: ${ps.qty.toLocaleString()} qty`];

  const makeETAPart = (label, date, delayDays) => {
    if (!date) return null;
    const dateStr = fmtDate(date);
    const delay = delayDays > 0 ? (
      <span className="text-red-400 ml-1">⚠ Delayed {delayDays}d</span>
    ) : null;
    return <span>{label}: {dateStr}{delay}</span>;
  };

  if (ps.noETA) {
    return (
      <div className="mt-2 pt-2 border-t border-gray-700/50">
        <span className="text-gray-500 text-xs font-mono">
          🖨 In Print: {ps.qty.toLocaleString()} qty · <span className="text-red-400">No ETA added</span>
        </span>
      </div>
    );
  }

  const printerPart = makeETAPart("Printer", ps.printerETA, ps.printerDelayDays);
  const warehousePart = makeETAPart("Warehouse", ps.warehouseETA, ps.warehouseDelayDays);

  return (
    <div className="mt-2 pt-2 border-t border-gray-700/50">
      <span className="text-gray-500 text-xs font-mono flex flex-wrap gap-1 items-center">
        <span>🖨 In Print: {ps.qty.toLocaleString()} qty</span>
        {printerPart && <><span className="text-gray-600">·</span>{printerPart}</>}
        {warehousePart && <><span className="text-gray-600">·</span>{warehousePart}</>}
      </span>
    </div>
  );
}

function SKUCard({ item, showPerSKU, mappedFrom, lastMonthName, prevMonthName, printData }) {
  const cfg = statusCfg[item.status];
  const delta = item.proj60 - item.old_proj60;
  const ps = getPrintStatus(item.sku, printData, item.days_out);
  const delayAccent = ps.hasDelays && item.status !== "urgent" ? " border-l-4 border-l-red-600" : "";
  return (
    <div className={`rounded-xl border ${cfg.border} ${cfg.bg}${delayAccent} p-4 hover:scale-[1.01] transition-transform`}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <p className="text-white font-semibold text-sm leading-snug" title={item.name}>{item.name}</p>
          <p className="text-gray-500 font-mono text-xs mt-0.5 mb-1">{item.sku}</p>
          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-900 text-emerald-300">Active</span>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${cfg.badge}`}>{cfg.label}</span>
          {item.has_spike  && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-purple-700 text-purple-100">⚡ ×{item.spike_factor}</span>}
          {item.has_loosen && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-700 text-amber-100">📉 ×{item.spike_factor}</span>}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-2">
        {[
          { l: "Stock", v: item.stock.toLocaleString(), c: item.stock < 50 ? "text-red-400" : "text-white" },
          { l: "Days Left", v: item.days_out < 1 ? "< 1" : item.days_out.toFixed(0), c: item.days_out < 15 ? "text-red-400" : item.days_out < 45 ? "text-amber-400" : "text-green-400" },
          { l: "Reorder", v: item.reorder_qty.toLocaleString(), c: "text-white" },
        ].map(x => (
          <div key={x.l} className="text-center bg-gray-900/50 rounded-lg p-2">
            <p className="text-gray-400 text-xs">{x.l}</p>
            <p className={`font-bold text-base ${x.c}`}>{x.v}</p>
          </div>
        ))}
      </div>

      <StockBar stock={item.stock} proj60={item.proj60} />

      {showPerSKU && (
        <div className="mt-3 bg-gray-900/60 rounded-lg p-3 font-mono text-xs text-gray-300 space-y-1">
          <div className="flex justify-between"><span className="text-gray-500">rate 10d / {lastMonthName} / {prevMonthName}:</span><span>{item.r10} / {item.rm1} / {item.rm2}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">2-mo avg:</span><span>{item.r2mo} /day</span></div>
          {item.has_spike
            ? <div className="flex justify-between text-purple-400"><span>⚡ spike blended (60/40):</span><span>{item.eff_rate} /day</span></div>
            : item.has_loosen
              ? <div className="flex justify-between text-amber-400"><span>📉 loosen blended (40/60):</span><span>{item.eff_rate} /day</span></div>
              : <div className="flex justify-between"><span className="text-gray-500">eff rate:</span><span>{item.eff_rate} /day</span></div>}

          <div className="flex justify-between text-white border-t border-gray-700 pt-2 mt-2 mb-2 font-bold">
            <span>60d forecast:</span>
            <span>{item.proj60}{delta > 0 && <span className="text-purple-400 ml-1">(+{delta} vs avg)</span>}</span>
          </div>

          {/* Inline Channel Breakdown */}
          {item.channels30d && Object.keys(item.channels30d).length > 0 && (
            <div className="pt-2 mt-2 border-t border-gray-700">
              <span className="text-gray-500 mb-1 block">channels (last 30d):</span>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(item.channels30d).sort((a, b) => b[1] - a[1]).map(([ch, qty]) => {
                  const isShopify = ch.toLowerCase().includes("shopify");
                  return (
                    <span key={ch} className={`px-2 py-0.5 rounded-full text-white text-xs ${isShopify ? "bg-emerald-800" : "bg-gray-600"}`}>
                      {ch}: <span className="font-bold ml-1">{qty}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Mapped From — all child/combo SKUs contributing to this master's consumption */}
          {mappedFrom && mappedFrom.length > 0 && (
            <div className="pt-2 mt-2 border-t border-gray-700">
              <span className="text-gray-500 block mb-1">mapped from ({mappedFrom.length} SKUs):</span>
              <div className="flex flex-wrap gap-1">
                {mappedFrom.map(s => (
                  <span key={s} className="px-1.5 py-0.5 rounded bg-blue-950 text-blue-300 font-mono text-xs">{s}</span>
                ))}
              </div>
            </div>
          )}

        </div>
      )}

      {/* Print Status Row — always visible at bottom of card */}
      <PrintStatusRow sku={item.sku} printData={printData} daysToStockout={item.days_out} />
    </div>
  );
}

// ─── Print Timeline Tab ───────────────────────────────────────────────────────
const PRINT_SHEET_URL = `https://docs.google.com/spreadsheets/d/${import.meta.env.VITE_PRINT_SHEET_ID || "1jukH-tiSaUFicNcNCrpSOChL9OfPLkze0FYMTq7J4QE"}`;

function PrintTimelineTab({ data, printData }) {
  const today = new Date(); today.setHours(0,0,0,0);
  const next7 = new Date(today); next7.setDate(today.getDate() + 7);

  const activeOrders = Object.entries(printData || {}).filter(([, pd]) => !pd.grnDate);
  const totalInPrint = activeOrders.reduce((sum, [, pd]) => sum + (pd.qty || 0), 0);
  const activeSKUCount = activeOrders.length;

  const parseDate = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; };

  const delayedCount = activeOrders.filter(([, pd]) => {
    const pETA = parseDate(pd.printerETA);
    return pETA && pETA < today;
  }).length;

  const arrivingThisWeekCount = activeOrders.filter(([, pd]) => {
    const pETA = parseDate(pd.printerETA);
    return pETA && pETA >= today && pETA <= next7;
  }).length;

  // Urgency score table
  const urgencyRows = (data || []).map(item => {
    const score = item.stock === 0 ? Infinity : Math.pow(item.eff_rate, 2) / item.stock;
    const ps = getPrintStatus(item.sku, printData, item.days_out);
    const pData = printData?.[item.sku];
    const printerETA = pData ? parseDate(pData.printerETA) : null;
    const warehouseETA = pData ? parseDate(pData.printingDoneDate) : null;
    const grnDate = pData ? parseDate(pData.grnDate) : null;

    let badgeLabel = "Not Tracked"; let badgeCls = "text-gray-500 bg-gray-800";
    if (ps.state === "reprint_needed") { badgeLabel = "⚡ Reprint Needed"; badgeCls = "text-amber-300 bg-amber-900"; }
    else if (ps.state === "received" || grnDate) { badgeLabel = "Received ✓"; badgeCls = "text-emerald-300 bg-emerald-900"; }
    else if (ps.state === "in_print") {
      if (ps.noETA) { badgeLabel = "In Print · No ETA"; badgeCls = "text-amber-300 bg-amber-900"; }
      else if (ps.printerDelayDays > 0 && ps.warehouseDelayDays > 0) { badgeLabel = "Both Delayed"; badgeCls = "text-red-300 bg-red-900"; }
      else if (ps.printerDelayDays > 0) { badgeLabel = `Printer Delayed · ${ps.printerDelayDays}d`; badgeCls = "text-red-300 bg-red-900"; }
      else if (printerETA) {
        const daysLeft = Math.ceil((printerETA - today) / 86400000);
        badgeLabel = `In Print · ${daysLeft}d`; badgeCls = "text-blue-300 bg-blue-900";
      }
    }

    const rowHighlight = ps.hasDelays ? " bg-red-950/20" : "";

    return { ...item, score, ps, pData, printerETA, warehouseETA, grnDate, badgeLabel, badgeCls, rowHighlight };
  }).sort((a, b) => {
    if (b.score === Infinity && a.score === Infinity) return a.sku.localeCompare(b.sku);
    if (b.score === Infinity) return 1;
    if (a.score === Infinity) return -1;
    return b.score - a.score;
  });

  const urgencyLabel = (days) => {
    if (days <= 7)  return { label: "Critical", cls: "text-red-300 bg-red-900" };
    if (days <= 15) return { label: "High",     cls: "text-orange-300 bg-orange-900" };
    if (days <= 30) return { label: "Medium",   cls: "text-yellow-300 bg-yellow-900" };
    if (days <= 74) return { label: "Low",      cls: "text-emerald-400 bg-emerald-900/50" };
    return { label: "Safe", cls: "text-green-300 bg-green-900" };
  };

  const statCards = [
    { label: "📦 Total In Print", value: totalInPrint.toLocaleString(), sub: "qty ordered", color: "border-blue-700 bg-blue-950/30" },
    { label: "🖨 Active Orders", value: activeSKUCount, sub: "SKUs in print", color: "border-indigo-700 bg-indigo-950/30" },
    { label: "⚠ Delayed", value: delayedCount, sub: "printer ETA passed", color: "border-red-700 bg-red-950/30" },
    { label: "📬 Arriving This Week", value: arrivingThisWeekCount, sub: "within 7 days", color: "border-emerald-700 bg-emerald-950/30" },
  ];

  return (
    <div>
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {statCards.map(c => (
          <div key={c.label} className={`rounded-xl border ${c.color} p-4`}>
            <p className="text-xs text-gray-400">{c.label}</p>
            <p className="text-3xl font-bold mt-1">{c.value}</p>
            <p className="text-xs text-gray-500 mt-1">{c.sub}</p>
          </div>
        ))}
      </div>

      {/* Urgency table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-gray-800">
          <h2 className="text-sm font-bold text-gray-200">All Active SKUs — Print Urgency</h2>
          <p className="text-xs text-gray-500 mt-0.5">Sorted by urgency score (Effective Rate² ÷ Current Stock)</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-700 text-gray-400">
                {["#","SKU ID","Product Name","Stock","Daily Rate","Days Left","Urgency","In Print (qty)","Printer ETA","Warehouse ETA","Print Status","View"].map(h => (
                  <th key={h} className="py-2 px-3 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {urgencyRows.map((item, idx) => {
                const urg = urgencyLabel(item.days_out);
                return (
                  <tr key={item.sku} className={`border-b border-gray-800/50 hover:bg-gray-800/20${item.rowHighlight}`}>
                    <td className="py-2.5 px-3 text-gray-600">{idx + 1}</td>
                    <td className="py-2.5 px-3 font-mono text-gray-300 whitespace-nowrap">{item.sku}</td>
                    <td className="py-2.5 px-3 text-gray-300 max-w-[180px] truncate" title={item.name}>{item.name}</td>
                    <td className="py-2.5 px-3 font-bold text-white">{item.stock.toLocaleString()}</td>
                    <td className="py-2.5 px-3 text-gray-300">{item.eff_rate}/d</td>
                    <td className={`py-2.5 px-3 font-bold ${item.days_out <= 15 ? "text-red-400" : item.days_out <= 30 ? "text-amber-400" : "text-green-400"}`}>
                      {item.days_out < 1 ? "<1" : item.days_out.toFixed(0)}d
                    </td>
                    <td className="py-2.5 px-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${urg.cls}`}>{urg.label}</span>
                    </td>
                    <td className="py-2.5 px-3 text-gray-300">{item.pData?.qty ? item.pData.qty.toLocaleString() : "—"}</td>
                    <td className="py-2.5 px-3 text-gray-300 whitespace-nowrap">{item.printerETA ? fmtDate(item.printerETA) : "—"}</td>
                    <td className="py-2.5 px-3 text-gray-300 whitespace-nowrap">{item.warehouseETA ? fmtDate(item.warehouseETA) : "—"}</td>
                    <td className="py-2.5 px-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${item.badgeCls}`}>{item.badgeLabel}</span>
                    </td>
                    <td className="py-2.5 px-3">
                      <a href={PRINT_SHEET_URL} target="_blank" rel="noopener noreferrer"
                        className="text-indigo-400 hover:text-indigo-300 whitespace-nowrap">View in Sheet ↗</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function LogEntryCard({ entry }) {
  const [expanded, setExpanded] = useState(false);
  
  return (
    <div className={`rounded-lg border p-3 text-xs ${
      entry.type === "sync_error" ? "border-red-900 bg-red-950/30" : "border-gray-800 bg-gray-900"
    }`}>
      <div className="flex justify-between items-start mb-1">
        <span className={`font-bold ${
          entry.type === "sync_error" ? "text-red-400" :
          entry.type === "manual_sync" ? "text-indigo-400" : "text-gray-400"
        }`}>
          {entry.type === "sync_error" ? "⚠ Sync Error" :
           entry.type === "manual_sync" ? "Manual Sync" : "Auto Sync"}
        </span>
        <span className="text-gray-600 text-[10px]">{new Date(entry.timestamp).toLocaleString("en-IN", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" })}</span>
      </div>
      
      {entry.errorMessage ? (
        <p className="text-red-400">{entry.errorMessage}</p>
      ) : (
        <p className="text-gray-400">
          {entry.skuCount} SKUs refreshed
          {entry.printChanges?.length > 0 && (
            <span className="cursor-pointer text-blue-400 hover:text-blue-300 ml-1" onClick={() => setExpanded(!expanded)}>
              · {entry.printChanges.length} print change{entry.printChanges.length > 1 ? "s" : ""} {expanded ? "▲" : "▼"}
            </span>
          )}
        </p>
      )}
      
      {expanded && entry.printChanges?.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-800 space-y-0.5">
          {entry.printChanges.map((c, i) => (
            <p key={i} className="text-[10px] font-mono text-gray-500">
              <span className="text-gray-300">{c.sku}</span> → <span className="text-gray-400">{c.to}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Log Drawer ───────────────────────────────────────────────────────────────
function LogDrawer({ open, onClose, syncLog }) {
  return (
    <>
      {/* Overlay */}
      {open && <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />}
      {/* Drawer */}
      <div className={`fixed top-0 right-0 h-full w-80 z-50 bg-gray-950 border-l border-gray-800 shadow-2xl transition-transform duration-300 flex flex-col ${
        open ? "translate-x-0" : "translate-x-full"
      }`}>
        <div className="flex items-center justify-between px-4 py-4 border-b border-gray-800">
          <h2 className="text-sm font-bold text-gray-200">📋 Sync Log</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {syncLog.length === 0 && (
            <p className="text-gray-600 text-xs text-center pt-8">No sync events yet. Click Sync to start.</p>
          )}
          {syncLog.map(entry => (
            <LogEntryCard key={entry.id} entry={entry} />
          ))}
        </div>
      </div>
    </>
  );
}


// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";

  const [invText, setInvText] = useState(null);
  const [txnText, setTxnText] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [invName, setInvName] = useState("");
  const [txnName, setTxnName] = useState("");
  const [data, setData] = useState(null);
  const [apiData, setApiData] = useState(null);
  const [runError, setRunError] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showFormula, setShowFormula] = useState(false);
  const [showPerSKU, setShowPerSKU] = useState(false);

  // New Data States
  const [deadData, setDeadData] = useState([]);
  const [mapDict, setMapDict] = useState({});
  const [viewMode, setViewMode] = useState("projections"); // "projections" | "dead" | "mapped" | "print"
  const [lastMonthName, setLastMonthName] = useState("lastM");
  const [prevMonthName, setPrevMonthName] = useState("prevM");

  // Print Timeline States
  const [printData, setPrintData] = useState({});
  const [printDataStale, setPrintDataStale] = useState(false);
  const [printDataStaleSince, setPrintDataStaleSince] = useState(null);

  // Log Drawer States (permanent, persisted to localStorage)
  const [syncLog, setSyncLog] = useState(() => {
    try { return JSON.parse(localStorage.getItem("sync_log") || "[]"); } catch { return []; }
  });
  const [showLog, setShowLog] = useState(false);
  const prevPrintDataRef = useRef({});
  const isInitialFetch = useRef(true); // skip diff on very first load

  // Settings & Configuration States
  const [skuStatusText, setSkuStatusText] = useState(null);
  const [mappedSkusText, setMappedSkusText] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [ghostSkus, setGhostSkus] = useState([]);
  const [authPwd, setAuthPwd] = useState("");
  const [isAuth, setIsAuth] = useState(false);

  // API + Sync States
  const [sysStatus, setSysStatus] = useState({ 
    isSyncing: false, lastSynced: null, syncSchedule: "", emailSchedule: "", emailTo: "", emailCc: "" 
  });
  const [apiError, setApiError] = useState("");

  // Load Seeded CSVs and API Status on Mount — auto-run projection with cached data
  const autoRunRef = useRef(false);

  useEffect(() => {
    const loadConfig = async () => {
      let statusCSV = localStorage.getItem("sku_status_csv");
      if (!statusCSV) {
        try { const res = await fetch("/sku_status.csv"); statusCSV = await res.text(); } catch (e) { console.error(e); }
      }
      if (statusCSV) setSkuStatusText(statusCSV);

      let mappedCSV = localStorage.getItem("mapped_skus_csv");
      if (!mappedCSV) {
        try { const res = await fetch("/mapped_skus.csv"); mappedCSV = await res.text(); } catch (e) { console.error(e); }
      }
      if (mappedCSV) setMappedSkusText(mappedCSV);

      // Fetch backend status and initial data
      fetchStatus();
      await fetchApiData();  // await so data is ready before auto-run
    };
    loadConfig();

    // Poll sync status every 5 seconds
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/status`, { cache: "no-store" });
      if (res.ok) setSysStatus(await res.json());
    } catch(e) {}
  };

  const addLogEntry = (entry) => {
    setSyncLog(prev => {
      const next = [entry, ...prev];
      try { localStorage.setItem("sync_log", JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const fetchApiData = async (isManualSync = false) => {
    try {
      const res = await fetch(`${API_BASE}/api/data?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        const d = await res.json();
        if (d.invCSV && d.txnCSV) {
          setApiData({ invCSV: d.invCSV, txnCSV: d.txnCSV });
          setInvText(d.invCSV); setInvName("API: Shiprocket Inventory");
          setTxnText(d.txnCSV); setTxnName("API: Shiprocket Transactions (Cache)");
          // Signal auto-run AFTER data is set in state
          autoRunRef.current = true;
        }
        // Handle printData
        const newPrintData = d.printData || {};
        const staleSince = d.printDataStaleSince || null;
        setPrintData(newPrintData);
        setPrintDataStale(!!staleSince);
        setPrintDataStaleSince(staleSince);

        // Diff for log — skip on very first load to avoid false "22 new SKUs" entries
        const prevPrint = prevPrintDataRef.current || {};
        const printChanges = [];

        if (!isInitialFetch.current) {
          const allSKUs = new Set([...Object.keys(prevPrint), ...Object.keys(newPrintData)]);
          allSKUs.forEach(sku => {
            const wasIn = !!prevPrint[sku];
            const isIn = !!newPrintData[sku];
            const wasGRN = prevPrint[sku]?.grnDate;
            const isGRN = newPrintData[sku]?.grnDate;
            if (!wasIn && isIn) printChanges.push({ sku, to: "In Print (new order)" });
            else if (wasIn && !isIn) printChanges.push({ sku, to: "Not In Print" });
            else if (wasIn && isIn && !wasGRN && isGRN) printChanges.push({ sku, to: "Received ✓" });
            else if (wasIn && isIn) {
              const prevPrinterETA = prevPrint[sku]?.printerETA;
              const newPrinterETA = newPrintData[sku]?.printerETA;
              const today = new Date(); today.setHours(0,0,0,0);
              const isDelayed = newPrinterETA && new Date(newPrinterETA) < today && !isGRN;
              const wasDelayed = prevPrinterETA && new Date(prevPrinterETA) < today && !wasGRN;
              if (isDelayed && !wasDelayed) printChanges.push({ sku, to: "Printer Delayed" });
            }
          });
        }
        prevPrintDataRef.current = newPrintData;
        isInitialFetch.current = false;

        // Log entry
        const skuCount = d.invCSV ? d.invCSV.split("\n").length - 1 : 0;
        addLogEntry({
          id: Date.now().toString(),
          type: isManualSync ? "manual_sync" : "auto_sync",
          timestamp: new Date().toISOString(),
          skuCount,
          printChanges,
        });
      }
    } catch(e) {
      addLogEntry({
        id: Date.now().toString(),
        type: "sync_error",
        timestamp: new Date().toISOString(),
        skuCount: 0,
        printChanges: [],
        errorMessage: "Failed to fetch data from backend: " + e.message,
      });
    }
  };

  const handleApiSync = async () => {
    try {
      setApiError("");
      const res = await fetch(`${API_BASE}/api/sync`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        setApiError(err.message || "Failed to start sync");
      } else {
        setSysStatus(prev => ({ ...prev, isSyncing: true }));
        const pollSync = setInterval(async () => {
          try {
            const st = await fetch(`${API_BASE}/api/status`);
            if (st.ok) {
              const sd = await st.json();
              setSysStatus(sd);
              if (!sd.isSyncing) {
                clearInterval(pollSync);
                if (sd.lastSyncError) {
                  addLogEntry({
                    id: Date.now().toString(),
                    type: "sync_error",
                    timestamp: new Date().toISOString(),
                    skuCount: 0,
                    printChanges: [],
                    errorMessage: sd.lastSyncError,
                  });
                } else {
                  await fetchApiData(true); // manual sync = true
                  autoRunRef.current = true;
                }
              }
            }
          } catch(e) {}
        }, 3000);
      }
    } catch(e) {
      setApiError("Backend is not running.");
    }
  };

  const saveBackendSettings = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/settings`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminPwd: authPwd,
          syncSchedule: sysStatus.syncSchedule,
          emailSchedule: sysStatus.emailSchedule,
          emailTo: sysStatus.emailTo,
          emailCc: sysStatus.emailCc
        })
      });
      if (!res.ok) alert("Failed to save backend settings.");
      else alert("Backend Settings Saved!");
    } catch(e) { alert("Backend not reachable"); }
  };

  const triggerManualEmail = async () => {
    if (!data) return alert("Run projection first to calculate urgent SKUs.");
    const urgentData = data.filter(r => r.status === "urgent");
    if (!urgentData.length) return alert("No urgent SKUs right now!");
    try {
      const res = await fetch(`${API_BASE}/api/email_urgent`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urgentList: urgentData })
      });
      const d = await res.json();
      if (res.ok) alert("Email Sent!");
      else alert("Error: " + d.error);
    } catch(e) { alert("Backend Error"); }
  };

  const handleRun = useCallback(() => {
    setRunError(""); setData(null);
    try {
      if (!invText || !txnText) { setRunError("Upload both CSVs or Sync first."); return; }
      const inv = parseCSV(invText);
      const txn = parseCSV(txnText);
      const { results, deadStock, mappingDict, lastMonthName: lm, prevMonthName: pm, ghostSkus: gs } = processData(inv, txn, skuStatusText, mappedSkusText);
      if (!results.length) { setRunError("No Active SKUs found during processing."); return; }

      setData(results);
      setDeadData(deadStock);
      setMapDict(mappingDict);
      setLastMonthName(lm);
      setPrevMonthName(pm);
      setGhostSkus(gs || []);
      setViewMode("projections");
    } catch (e) { setRunError("Processing error: " + e.message); }
  }, [invText, txnText, skuStatusText, mappedSkusText]);

  // Auto-run projection when cached data is loaded
  useEffect(() => {
    if (autoRunRef.current && invText && txnText) {
      autoRunRef.current = false;
      handleRun();
    }
  }, [invText, txnText, handleRun]);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const counts = useMemo(() => data ? {
    urgent: data.filter(r => r.status === "urgent").length,
    at_risk: data.filter(r => r.status === "at_risk").length,
    safe: data.filter(r => r.status === "safe").length,
    spiked:  data.filter(r => r.has_spike).length,
    loosened: data.filter(r => r.has_loosen).length,
    total:   data.length,
  } : null, [data]);

  const spikeImpact = useMemo(() =>
    data ? data.filter(r => r.has_spike).reduce((a, r) => a + (r.proj60 - r.old_proj60), 0) : 0
    , [data]);

  const loosenSaved = useMemo(() =>
    data ? data.filter(r => r.has_loosen).reduce((a, r) => a + (r.old_proj60 - r.proj60), 0) : 0
    , [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    let d = filter === "all"     ? data.filter(r => r.status !== "safe")
      : filter === "spiked"  ? data.filter(r => r.has_spike)
      : filter === "loosened"? data.filter(r => r.has_loosen)
        : data.filter(r => r.status === filter);
    if (search) d = d.filter(r =>
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.sku.toLowerCase().includes(search.toLowerCase())
    );
    return d;
  }, [data, filter, search]);

  const globalChannels30d = useMemo(() => {
    if (!data) return null;
    const totals = {};
    let grandTotal = 0;
    for (const item of data) {
      if (!item.channels30d) continue;
      for (const [ch, qty] of Object.entries(item.channels30d)) {
        totals[ch] = (totals[ch] || 0) + qty;
        grandTotal += qty;
      }
    }
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    return { sorted, grandTotal };
  }, [data]);

  // ── Render ──────────────────────────────────────────────────────────────────
  // Reverse Map Dictionary for UI Table: Master -> [Children]
  // reverseMap: master_sku -> [all child/combo SKUs that roll into it]
  // mapDict is now child -> [master1, master2, ...] (many-to-many)
  const reverseMap = useMemo(() => {
    const rm = {};
    for (const [child, masters] of Object.entries(mapDict)) {
      const masterList = Array.isArray(masters) ? masters : [masters];
      masterList.forEach(master => {
        if (!rm[master]) rm[master] = [];
        if (!rm[master].includes(child)) rm[master].push(child);
      });
    }
    return rm;
  }, [mapDict]);

  return (
    <div className="min-h-screen bg-gray-950 text-white p-4 md:p-8" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <p className="text-indigo-500 text-xs tracking-widest uppercase mb-1">Reprint Planning System</p>
          <h1 className="text-3xl font-bold">📦 Inventory Projection</h1>
          <div className="flex items-center gap-3 mt-1">
            <p className="text-gray-500 text-xs">Adaptive Weighted Rate · {LEAD_TIME}d print lead time · {PROJ_DAYS}d planning window</p>
            {sysStatus.lastSynced && (
              <span className="text-emerald-600 text-xs font-mono">✓ Synced {(() => {
                const diff = Date.now() - new Date(sysStatus.lastSynced).getTime();
                const mins = Math.floor(diff / 60000);
                if (mins < 1) return 'just now';
                if (mins < 60) return `${mins}m ago`;
                const hrs = Math.floor(mins / 60);
                if (hrs < 24) return `${hrs}h ago`;
                return `${Math.floor(hrs / 24)}d ago`;
              })()}</span>
            )}
          </div>
        </div>
        <div className="flex gap-2 items-center">
          {apiError && <span className="text-red-400 text-xs">{apiError}</span>}
          <button 
            onClick={handleApiSync} 
            disabled={sysStatus.isSyncing}
            className={`px-4 py-2 rounded-xl text-sm font-bold shadow transition-all ${sysStatus.isSyncing ? "bg-indigo-900/50 text-indigo-400 cursor-not-allowed border border-indigo-900 animate-pulse" : "bg-indigo-600 hover:bg-indigo-500 text-white"}`}
          >
            {sysStatus.isSyncing ? "⏳ Syncing..." : "🔄 Sync"}
          </button>
          <button onClick={() => setShowLog(true)} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-xl text-sm font-bold transition-all text-gray-300 border border-gray-700">
            📋 Log{syncLog.length > 0 ? ` (${syncLog.length})` : ""}
          </button>
          <button onClick={() => setShowSettings(true)} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-xl text-sm font-bold transition-all text-gray-300 border border-gray-700">
            ⚙️ Settings
          </button>
        </div>
      </div>

      {/* Stale Print Data Banner */}
      {printDataStale && (
        <div className="mb-4 rounded-xl border border-amber-700 bg-amber-950/30 px-4 py-3 text-xs text-amber-300 flex items-center gap-2">
          <span>⚠</span>
          <span>Print data unavailable — last synced {printDataStaleSince ? new Date(printDataStaleSince).toLocaleString() : "unknown"}. Projection data is current.</span>
          <span className="ml-auto text-amber-600">(stale)</span>
        </div>
      )}

      {/* Log Drawer */}
      <LogDrawer open={showLog} onClose={() => setShowLog(false)} syncLog={syncLog} />

      {/* Tabs */}
      {data && (
        <div className="flex gap-2 border-b border-gray-800 pb-4 mb-6 flex-wrap">
          <button onClick={() => setViewMode("projections")} className={`px-4 py-2 font-bold text-sm rounded-lg transition-all ${viewMode === "projections" ? "bg-indigo-900 text-indigo-200" : "text-gray-500 hover:bg-gray-900 hover:text-gray-300"}`}>
            📊 Projections
          </button>
          <button onClick={() => setViewMode("dead")} className={`px-4 py-2 font-bold text-sm rounded-lg transition-all ${viewMode === "dead" ? "bg-red-900/40 text-red-200" : "text-gray-500 hover:bg-gray-900 hover:text-gray-300"}`}>
            💀 Dead / Inactive Stock ({deadData.length})
          </button>
          <button onClick={() => setViewMode("mapped")} className={`px-4 py-2 font-bold text-sm rounded-lg transition-all ${viewMode === "mapped" ? "bg-gray-800 text-white" : "text-gray-500 hover:bg-gray-900 hover:text-gray-300"}`}>
            🔗 SKU Mappings
          </button>
          <button onClick={() => setViewMode("print")} className={`px-4 py-2 font-bold text-sm rounded-lg transition-all ${viewMode === "print" ? "bg-blue-900/60 text-blue-200" : "text-gray-500 hover:bg-gray-900 hover:text-gray-300"}`}>
            🖨 Print Timeline
          </button>
        </div>
      )}

      {/* Results */}
      {viewMode === "projections" && data && counts && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
            {[
              { l: "🔴 Urgent",  v: counts.urgent,   s: "Stockout < 15d",                    c: "border-red-700 bg-red-950" },
              { l: "🟡 At Risk", v: counts.at_risk,  s: "Reprint decision needed",            c: "border-amber-700 bg-amber-950" },
              { l: "⚡ Spikes",  v: counts.spiked,   s: `+${spikeImpact} units added`,        c: "border-purple-700 bg-purple-950" },
              { l: "📉 Loosen",  v: counts.loosened, s: `-${Math.max(0,loosenSaved)} units saved`, c: "border-amber-600 bg-amber-950/60" },
              { l: "🟢 Safe",    v: counts.safe,     s: "75+ day coverage",                   c: "border-emerald-700 bg-emerald-950" },
            ].map(x => (
              <div key={x.l} className={`rounded-xl border ${x.c} p-4`}>
                <p className="text-xs text-gray-400">{x.l}</p>
                <p className="text-4xl font-bold mt-1">{x.v}</p>
                <p className="text-xs text-gray-500 mt-1">{x.s}</p>
              </div>
            ))}
          </div>

          {/* Action bar */}
          <div className="flex flex-wrap gap-2 mb-5">
            {/* Download CSV */}
            <button onClick={() => downloadCSV(data, "projections", reverseMap)}
              className="px-5 py-2.5 rounded-xl font-bold text-sm bg-indigo-700 hover:bg-indigo-600 text-white transition-all">
              ⬇ Download Projections CSV
            </button>

            {/* Show/Hide Projection Formula */}
            <button onClick={() => setShowFormula(p => !p)}
              className={`px-5 py-2.5 rounded-xl font-bold text-sm border transition-all
                ${showFormula ? "bg-indigo-900 border-indigo-500 text-indigo-300" : "border-indigo-700 text-indigo-400 hover:bg-indigo-900/40"}`}>
              {showFormula ? "▲ Hide Projection Formula" : "▼ Show Projection Formula"}
            </button>

            {/* Show/Hide Per-SKU Math */}
            <button onClick={() => setShowPerSKU(p => !p)}
              className={`px-5 py-2.5 rounded-xl font-bold text-sm border transition-all
                ${showPerSKU ? "bg-gray-800 border-gray-500 text-gray-300" : "border-gray-700 text-gray-400 hover:bg-gray-800/40"}`}>
              {showPerSKU ? "▲ Hide Per-SKU Math" : "▼ Show Per-SKU Math"}
            </button>
          </div>

          {/* Projection Formula Panel */}
          {showFormula && <FormulaPanel />}

          {/* Global Channel Split Progress Bar */}
          {globalChannels30d && globalChannels30d.grandTotal > 0 && (
            <div className="mb-6 rounded-2xl border border-gray-800 bg-gray-900/40 p-4">
              <p className="text-gray-400 text-xs font-mono tracking-widest uppercase mb-3 text-center sm:text-left">CHANNEL SPLIT – LAST 30 DAYS (ALL ACTIVE SKUS)</p>
              <div className="flex flex-wrap gap-2.5 mb-4 justify-center sm:justify-start">
                {globalChannels30d.sorted.map(([ch, qty], i) => {
                  const bgColors = ["bg-gray-600", "bg-gray-500", "bg-emerald-800", "bg-gray-700", "bg-indigo-700", "bg-purple-700"];
                  const bg = ch.toLowerCase().includes("shopify") ? "bg-emerald-800" : bgColors[i % bgColors.length];
                  const pct = ((qty / globalChannels30d.grandTotal) * 100).toFixed(0);
                  return (
                    <div key={ch} className="flex items-center gap-2 font-mono text-sm max-w-full">
                      <span className={`px-2.5 py-0.5 rounded-full text-white font-bold text-xs truncate max-w-[120px] sm:max-w-[200px] ${bg}`}>{ch}</span>
                      <span className="text-white font-bold">{qty.toLocaleString()}</span>
                      <span className="text-gray-500 text-xs">({pct}%)</span>
                    </div>
                  );
                })}
              </div>
              {/* Progress bar line */}
              <div className="flex w-full h-2.5 rounded-full overflow-hidden bg-gray-900">
                {globalChannels30d.sorted.map(([ch, qty], i) => {
                  const bgColors = ["bg-blue-500", "bg-blue-400", "bg-emerald-500", "bg-purple-500", "bg-amber-500", "bg-rose-500"];
                  const bg = bgColors[i % bgColors.length];
                  const pct = (qty / globalChannels30d.grandTotal) * 100;
                  return <div key={ch} style={{ width: `${pct}%` }} className={`h-full ${bg} transition-all`} title={`${ch}: ${qty}`} />
                })}
              </div>
            </div>
          )}

          {/* Ghost SKU Warning — SKUs with live sales but missing from Inventory CSV */}
          {ghostSkus.length > 0 && (
            <div className="mb-5 rounded-xl border border-orange-700 bg-orange-950/50 p-4">
              <div className="flex items-start gap-3">
                <span className="text-xl">👻</span>
                <div className="flex-1">
                  <div className="flex items-center justify-between gap-3 mb-1 flex-wrap">
                    <p className="text-orange-300 font-bold text-sm">
                      👻 {ghostSkus.length} Ghost SKU{ghostSkus.length > 1 ? "s" : ""} — Selling but NOT in Inventory or Mapping sheet
                    </p>
                    <button
                      onClick={() => downloadGhostCSV(ghostSkus)}
                      className="px-3 py-1.5 rounded-lg bg-orange-800 hover:bg-orange-700 border border-orange-600 text-orange-100 text-xs font-bold transition-all shrink-0"
                    >
                      ⬇ Download Ghost SKUs CSV
                    </button>
                  </div>
                  <p className="text-orange-400/70 text-xs mb-3">
                    These SKUs appear in raw transactions (last 30d) but have <strong>no mapping to any master</strong> and are <strong>not in Inventory CSV</strong>.
                    Hover any chip to see channel breakdown. Download CSV for full detail.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {ghostSkus.map(g => {
                      const chBreakdown = Object.entries(g.channels30d || {})
                        .sort((a, b) => b[1] - a[1])
                        .map(([ch, u]) => `${ch}: ${u}`)
                        .join(" | ");
                      const title = `Channels: ${chBreakdown || "—"}\nStatus: ${g.status}`;
                      return (
                        <span
                          key={g.sku}
                          title={title}
                          className="px-2.5 py-1 rounded-lg font-mono text-xs border bg-orange-900 border-orange-700 text-orange-200 cursor-help"
                        >
                          {g.sku}
                          <span className="opacity-70 ml-1">({g.units30d}u)</span>
                          {g.status && g.status !== "—" && (
                            <span className="ml-1.5 text-gray-400 text-[10px]">[{g.status}]</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Filters + search */}
          <div className="flex gap-2 mb-4 flex-wrap items-center">
            {[
              { k: "all",      l: `All At-Risk (${counts.urgent + counts.at_risk})` },
              { k: "urgent",   l: `🔴 Urgent (${counts.urgent})` },
              { k: "at_risk",  l: `🟡 At Risk (${counts.at_risk})` },
              { k: "spiked",   l: `⚡ Spikes (${counts.spiked})` },
              { k: "loosened", l: `📉 Loosen (${counts.loosened})` },
              { k: "safe",     l: `🟢 Safe (${counts.safe})` },
            ].map(f => (
              <button key={f.k} onClick={() => setFilter(f.k)}
                className={`text-xs px-4 py-2 rounded-full border transition
                  ${filter === f.k ? "bg-indigo-700 border-indigo-500 text-white" : "border-gray-700 text-gray-400 hover:bg-gray-800"}`}>
                {f.l}
              </button>
            ))}
            <input
              value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
              className="ml-auto text-xs bg-gray-900 border border-gray-700 rounded-full px-4 py-2 text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 w-44"
            />
          </div>

          {/* SKU Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map(item => <SKUCard key={item.sku} item={item} showPerSKU={showPerSKU} mappedFrom={reverseMap[item.sku]} lastMonthName={lastMonthName} prevMonthName={prevMonthName} printData={printData} />)}
          </div>

          {filtered.length === 0 && (
            <div className="text-center py-16 text-gray-600">
              <p className="text-4xl mb-3">🔍</p>
              <p>No SKUs match your filter or search</p>
            </div>
          )}

          <div className="mt-8 border border-gray-800 rounded-xl p-4 text-xs text-indigo-400/60">
            Spike: rate_10d &gt; {SPIKE_THR}× rate_2mo → blend 60/40 (recent/hist) ·
            Loosen: rate_10d &lt; {LOOSEN_THR}× rate_2mo → blend 40/60 (recent/hist) ·
            Trigger horizon: {PROJ_DAYS + LEAD_TIME}d · Active SKUs: {counts.total}
          </div>
        </>
      )}

      {/* Print Timeline Tab */}
      {viewMode === "print" && data && (
        <PrintTimelineTab data={data} printData={printData} />
      )}

      {/* Dead Stock View */}
      {viewMode === "dead" && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden p-4">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold">Dead / Inactive Stock with Inventory</h2>
            <button onClick={() => downloadCSV(deadData, "dead")} className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm font-bold text-gray-300">
              ⬇ Download CSV
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-700 text-gray-400">
                  <th className="py-2 px-3 font-medium">SKU</th>
                  <th className="py-2 px-3 font-medium">Product Name</th>
                  <th className="py-2 px-3 font-medium">Status Tag</th>
                  <th className="py-2 px-3 font-medium text-right">Available Stock</th>
                </tr>
              </thead>
              <tbody>
                {deadData.map(item => (
                  <tr key={item.sku} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                    <td className="py-3 px-3 relative"><span className="text-gray-300 font-mono text-xs">{item.sku}</span></td>
                    <td className="py-3 px-3"><span className="text-white">{item.name}</span></td>
                    <td className="py-3 px-3"><span className="px-2 py-0.5 rounded bg-gray-800 text-gray-400 text-xs font-bold">{item.status}</span></td>
                    <td className="py-3 px-3 text-right"><span className="text-red-400 font-bold">{item.stock.toLocaleString()}</span></td>
                  </tr>
                ))}
                {deadData.length === 0 && <tr><td colSpan="4" className="py-8 text-center text-gray-500">No dead stock found. Great job!</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Mapped SKUs View */}
      {viewMode === "mapped" && (() => {
        // Build the reverse map directly from the raw mappedSkusText CSV
        // so this view always works regardless of whether processData ran with it.
        const rm = {};
        if (mappedSkusText) {
          const mapRows = parseCSV(mappedSkusText);
          for (const r of mapRows) {
            const master = (r.master_sku || "").trim();
            const mapped  = (r.mapped_skus || "").trim();
            if (!master || !mapped) continue;
            if (!rm[master]) rm[master] = [];
            mapped.split(",").map(s => s.trim()).filter(Boolean).forEach(child => {
              if (!rm[master].includes(child)) rm[master].push(child);
            });
          }
        } else if (Object.keys(reverseMap).length > 0) {
          // Fallback: use the reverseMap from processData
          Object.assign(rm, reverseMap);
        }
        const entries = Object.entries(rm).sort((a, b) => a[0].localeCompare(b[0]));
        return (
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden p-4">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="text-lg font-bold">SKU Mappings Dictionary</h2>
                <p className="text-gray-500 text-xs mt-0.5">{entries.length} master SKUs · {Object.values(rm).reduce((a, v) => a + v.length, 0)} total child mappings</p>
              </div>
              <button onClick={() => downloadCSV(mapDict, "mapped")} className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm font-bold text-gray-300">
                ⬇ Download CSV
              </button>
            </div>
            {entries.length === 0 ? (
              <p className="text-gray-500 text-sm py-8 text-center">
                No mapping data found. Make sure <code className="text-orange-400">mapped_skus.csv</code> is in the Settings or that the public file is loaded.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-gray-700 text-gray-400">
                      <th className="py-2 px-3 font-medium w-48">Master SKU</th>
                      <th className="py-2 px-3 font-medium">Mapped From (Combo/Child SKUs)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(([master, children]) => (
                      <tr key={master} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                        <td className="py-3 px-3 align-top">
                          <span className="text-emerald-400 font-bold bg-emerald-950 px-2 py-1 rounded border border-emerald-900 font-mono text-xs">{master}</span>
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex flex-wrap gap-2">
                            {children.map(child => (
                              <span key={child} className={`font-mono text-xs px-2 py-0.5 rounded break-all
                                ${child === master ? "text-emerald-400 bg-emerald-950/50 border border-emerald-900" : "text-gray-400 bg-gray-800"}`}>
                                {child}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl">
            <div className="p-6 border-b border-gray-800 flex justify-between items-center bg-gray-900">
              <h2 className="text-xl font-bold">⚙️ Configuration Settings</h2>
              <button onClick={() => { setShowSettings(false); setAuthPwd(""); setIsAuth(false); }} className="text-gray-400 hover:text-white">✕</button>
            </div>

            <div className="p-6">
              {!isAuth ? (
                <div>
                  <p className="text-gray-400 text-sm mb-4">Please enter the administrator password to change system configurations.</p>
                  <input type="password" placeholder="Password" value={authPwd} onChange={e => setAuthPwd(e.target.value)}
                    className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-white mb-4 focus:border-indigo-500 focus:outline-none"
                  />
                  <button onClick={() => { if (authPwd === "Testbook_new") setIsAuth(true); else alert("Incorrect password"); }}
                    className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 rounded-xl transition-all">
                    Unlock Settings
                  </button>
                </div>
              ) : (
                <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-2">
                  <div className="border-b border-indigo-900/50 pb-4">
                    <h3 className="text-indigo-300 font-bold mb-3 flex items-center justify-between">
                      🔄 Auto-Sync & Email Alerts
                      <button onClick={saveBackendSettings} className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow">
                        Save Backend Settings
                      </button>
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">Shiprocket Sync Schedule (Cron)</label>
                        <input type="text" value={sysStatus.syncSchedule || ""} onChange={e => setSysStatus({...sysStatus, syncSchedule: e.target.value})}
                          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" placeholder="0 * * * * (Hourly)" />
                        <p className="text-[10px] text-gray-500 mt-1">Default runs every hour automatically.</p>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">Urgent Email Schedule (Cron)</label>
                        <input type="text" value={sysStatus.emailSchedule || ""} onChange={e => setSysStatus({...sysStatus, emailSchedule: e.target.value})}
                          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" placeholder="0 10 * * * (10 AM Daily)" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">Alert Email 'To' (comma separated)</label>
                        <input type="text" value={sysStatus.emailTo || ""} onChange={e => setSysStatus({...sysStatus, emailTo: e.target.value})}
                          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" placeholder="team@example.com" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">Alert Email 'CC' (comma separated)</label>
                        <input type="text" value={sysStatus.emailCc || ""} onChange={e => setSysStatus({...sysStatus, emailCc: e.target.value})}
                          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" placeholder="manager@example.com" />
                      </div>
                    </div>
                    <div className="mt-4 flex gap-3">
                      <button onClick={triggerManualEmail} className="px-3 py-1.5 bg-orange-900/40 border border-orange-800 text-orange-400 hover:bg-orange-900 rounded-lg text-xs font-bold transition-all">
                        ✉️ Send Urgent Email Now
                      </button>
                    </div>
                  </div>

                  <p className="text-sm font-bold text-gray-300">Seed Configuration Data</p>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <DropZone label="SKU Status CSV" hint="Upload latest active list"
                      loaded={!!skuStatusText} fileName="sku_status.csv (active)"
                      onFile={(t) => {
                        localStorage.setItem("sku_status_csv", t);
                        setSkuStatusText(t);
                      }} />
                    <DropZone label="Mapped SKUs CSV" hint="Upload active mappings"
                      loaded={!!mappedSkusText} fileName="mapped_skus.csv (active)"
                      onFile={(t) => {
                        localStorage.setItem("mapped_skus_csv", t);
                        setMappedSkusText(t);
                      }} />
                  </div>

                  <div className="flex gap-3 justify-end pt-4">
                    <button onClick={() => {
                      localStorage.removeItem("sku_status_csv"); localStorage.removeItem("mapped_skus_csv");
                      alert("Reset to defaults! Reloading..."); window.location.reload();
                    }} className="px-5 py-2.5 rounded-xl font-bold text-sm bg-red-900/50 hover:bg-red-800 text-red-200 border border-red-800 transition-all">
                      Reset to Defaults
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
