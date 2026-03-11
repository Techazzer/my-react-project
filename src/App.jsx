import { useState, useMemo, useCallback, useEffect } from "react";

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
  const headers = ["Master SKU", "Units Sold (Last 30d)", "Action Required", "Notes"];
  const rows = ghostSkus.map(g => [
    g.sku,
    g.units30d,
    "Add to Inventory CSV + SKU Status CSV",
    "SKU has live sales but is missing from Inventory CSV — invisible to projection engine",
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
    const sku = (inv["Master SKU"] || "").trim();
    if (!sku) continue;
    const info = statusLookup[sku] || {};
    masterData[sku] = {
      sku,
      name: (inv["Product Name"] || info.name || sku).trim(),
      stock: parseFloat(inv["Available Inventory - Good"]) || 0,
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

  // 4. Aggregate Transactions with Mapping
  for (const row of txnRows) {
    if ((row["Is Reverse"] || "").toLowerCase() === "yes") continue;
    if ((row["Status"] || "").toUpperCase() === "CANCELED") continue;

    let rawSku = (row["Master SKU"] || "").trim();
    const qty = parseFloat(row["Product Quantity"]) || 1;
    const dt = new Date(row["Shiprocket Created At"] || "");
    const channel = (row["Channel"] || "Unknown").toUpperCase();
    if (!rawSku || isNaN(dt)) continue;

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

  // Detect "ghost" SKUs: have recent sales in transactions but are NOT in Inventory CSV at all.
  // These are newly launched/unlisted books that are being sold but not tracked.
  const ghostSkus = [];
  for (const sku of Object.keys(s30)) {
    if (!masterData[sku] && s30[sku] > 0) {
      ghostSkus.push({ sku, units30d: s30[sku] });
    }
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
      className={`relative rounded-2xl border-2 border-dashed p-6 text-center cursor-pointer transition-all
        ${drag ? "border-indigo-400 bg-indigo-900/20" : loaded ? "border-emerald-600 bg-emerald-950/20" : "border-gray-700 bg-gray-900/30 hover:border-gray-500"}`}
    >
      <input type="file" accept=".csv" className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" onChange={e => read(e.target.files[0])} />
      <div className="text-3xl mb-2">{loaded ? "✅" : "📂"}</div>
      <p className="text-sm font-semibold text-white">{label}</p>
      {loaded ? <p className="text-xs text-emerald-400 mt-1 truncate">{fileName}</p>
        : <p className="text-xs text-gray-500 mt-1">{hint}</p>}
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

function SKUCard({ item, showPerSKU, mappedFrom, lastMonthName, prevMonthName }) {
  const cfg = statusCfg[item.status];
  const delta = item.proj60 - item.old_proj60;
  return (
    <div className={`rounded-xl border ${cfg.border} ${cfg.bg} p-4 hover:scale-[1.01] transition-transform`}>
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
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [invText, setInvText] = useState(null);
  const [txnText, setTxnText] = useState(null);
  const [invName, setInvName] = useState("");
  const [txnName, setTxnName] = useState("");
  const [data, setData] = useState(null);
  const [runError, setRunError] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showFormula, setShowFormula] = useState(false);
  const [showPerSKU, setShowPerSKU] = useState(false);

  // New Data States
  const [deadData, setDeadData] = useState([]);
  const [mapDict, setMapDict] = useState({});
  const [viewMode, setViewMode] = useState("projections"); // "projections" | "dead" | "mapped"
  const [lastMonthName, setLastMonthName] = useState("lastM");
  const [prevMonthName, setPrevMonthName] = useState("prevM");

  // Settings & Configuration States
  const [skuStatusText, setSkuStatusText] = useState(null);
  const [mappedSkusText, setMappedSkusText] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [ghostSkus, setGhostSkus] = useState([]);
  const [authPwd, setAuthPwd] = useState("");
  const [isAuth, setIsAuth] = useState(false);

  // Load Seeded CSVs on Mount
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
    };
    loadConfig();
  }, []);

  // ── Run projection ──────────────────────────────────────────────────────────
  const handleRun = useCallback(() => {
    setRunError(""); setData(null);
    try {
      if (!invText || !txnText) { setRunError("Upload both CSVs first."); return; }
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
          <p className="text-gray-500 text-xs mt-1">Adaptive Weighted Rate · {LEAD_TIME}d print lead time · {PROJ_DAYS}d planning window</p>
        </div>
        <button onClick={() => setShowSettings(true)} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-xl text-sm font-bold transition-all text-gray-300">
          ⚙️ Settings
        </button>
      </div>

      {/* Upload */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900/40 p-6 mb-6">
        <p className="text-gray-300 text-sm font-semibold mb-4">📁 Upload Data Files</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <DropZone
            label="Current Inventory CSV"
            hint="Needs: Master SKU · Available Inventory - Good · Product Name"
            onFile={(t, n) => { setInvText(t); setInvName(n); setData(null); }}
            loaded={!!invText} fileName={invName}
          />
          <DropZone
            label="Total Transactions CSV"
            hint="Needs: Master SKU · Shiprocket Created At · Product Quantity · Status · Is Reverse"
            onFile={(t, n) => { setTxnText(t); setTxnName(n); setData(null); }}
            loaded={!!txnText} fileName={txnName}
          />
        </div>
        {runError && <p className="text-red-400 text-xs mb-3 bg-red-950 border border-red-800 rounded-lg px-3 py-2">⚠ {runError}</p>}
        <button onClick={handleRun} disabled={!invText || !txnText}
          className={`w-full py-3 rounded-xl font-bold text-sm transition-all
            ${invText && txnText ? "bg-indigo-600 hover:bg-indigo-500 text-white" : "bg-gray-800 text-gray-600 cursor-not-allowed"}`}>
          {data ? "🔄 Re-run Projection" : "▶ Run Projection"}
        </button>
      </div>

      {/* Tabs / Sub-Views */}
      {data && (
        <div className="flex gap-2 border-b border-gray-800 pb-4 mb-6">
          <button onClick={() => setViewMode("projections")} className={`px-4 py-2 font-bold text-sm rounded-lg transition-all ${viewMode === "projections" ? "bg-indigo-900 text-indigo-200" : "text-gray-500 hover:bg-gray-900 hover:text-gray-300"}`}>
            📊 Projections
          </button>
          <button onClick={() => setViewMode("dead")} className={`px-4 py-2 font-bold text-sm rounded-lg transition-all ${viewMode === "dead" ? "bg-red-900/40 text-red-200" : "text-gray-500 hover:bg-gray-900 hover:text-gray-300"}`}>
            💀 Dead / Inactive Stock ({deadData.length})
          </button>
          <button onClick={() => setViewMode("mapped")} className={`px-4 py-2 font-bold text-sm rounded-lg transition-all ${viewMode === "mapped" ? "bg-gray-800 text-white" : "text-gray-500 hover:bg-gray-900 hover:text-gray-300"}`}>
            🔗 SKU Mappings
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
                      {ghostSkus.length} Ghost SKU{ghostSkus.length > 1 ? "s" : ""} Detected — Selling but NOT in Inventory CSV!
                    </p>
                    <button
                      onClick={() => downloadGhostCSV(ghostSkus)}
                      className="px-3 py-1.5 rounded-lg bg-orange-800 hover:bg-orange-700 border border-orange-600 text-orange-100 text-xs font-bold transition-all shrink-0"
                    >
                      ⬇ Download Ghost SKUs CSV
                    </button>
                  </div>
                  <p className="text-orange-400/70 text-xs mb-3">
                    These SKUs have transactions in the last 30 days but are missing from your Inventory CSV.
                    They are <strong>invisible to the projection engine</strong>. Add them to your Inventory CSV and Mapped SKUs sheet.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {ghostSkus.map(g => (
                      <span key={g.sku} className="px-2.5 py-1 rounded-lg bg-orange-900 border border-orange-700 font-mono text-xs text-orange-200">
                        {g.sku} <span className="text-orange-400 ml-1">({g.units30d} units/30d)</span>
                      </span>
                    ))}
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
            {filtered.map(item => <SKUCard key={item.sku} item={item} showPerSKU={showPerSKU} mappedFrom={reverseMap[item.sku]} lastMonthName={lastMonthName} prevMonthName={prevMonthName} />)}
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
      {viewMode === "mapped" && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden p-4">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold">SKU Mappings Dictionary</h2>
            <button onClick={() => downloadCSV(mapDict, "mapped")} className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm font-bold text-gray-300">
              ⬇ Download CSV
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-700 text-gray-400">
                  <th className="py-2 px-3 font-medium">Master SKU (Active)</th>
                  <th className="py-2 px-3 font-medium">Mapped From (Combo/Child SKUs)</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(reverseMap).map(([master, children]) => (
                  <tr key={master} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                    <td className="py-3 px-3"><span className="text-emerald-400 font-bold bg-emerald-950 px-2 py-1 rounded border border-emerald-900">{master}</span></td>
                    <td className="py-3 px-3">
                      <div className="flex flex-wrap gap-2">
                        {children.map(child => <span key={child} className="text-gray-400 font-mono text-xs bg-gray-800 px-2 py-0.5 rounded break-all">{child}</span>)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
                  <button onClick={() => { if (authPwd === "Testbook") setIsAuth(true); else alert("Incorrect password"); }}
                    className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 rounded-xl transition-all">
                    Unlock Settings
                  </button>
                </div>
              ) : (
                <div className="space-y-6">
                  <p className="text-sm border-b border-indigo-900 pb-2 text-indigo-300">Update the seeded CSV lists. Changes save directly to your browser.</p>

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
