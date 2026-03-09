import { useState, useMemo, useCallback } from "react";

// ─── Config ───────────────────────────────────────────────────────────────────
const LEAD_TIME = 15;
const PROJ_DAYS = 60;
const SPIKE_THR = 1.3;

// ─── Download CSV ─────────────────────────────────────────────────────────────
function downloadCSV(data) {
  const headers = [
    "Reprint Decision","Status","SKU","Product Name",
    "Current Stock","Days to Stockout","Reorder Qty",
    "Rate Last 10d","Rate Last 30d","Rate Prev 30d",
    "2Mo Avg Rate","Spike Factor","Spike Detected",
    "Effective Rate","60d Projected Demand","Old 60d Demand","Delta Spike Impact",
  ];
  const rows = data.map(r => [
    r.status === "urgent" ? "REPRINT IMMEDIATELY" : r.status === "at_risk" ? "REPRINT SOON" : "SAFE - MONITOR",
    r.status.toUpperCase(), r.sku,
    `"${r.name.replace(/"/g, '""')}"`,
    r.stock,
    r.days_out < 1 ? "< 1" : r.days_out.toFixed(1),
    r.reorder_qty,
    r.r10, r.r30, r.rp30, r.r2mo,
    r.spike_factor, r.has_spike ? "YES" : "No",
    r.eff_rate, r.proj60, r.old_proj60, r.proj60 - r.old_proj60,
  ]);
  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `projection_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map(line => {
    const cols = []; let cur = "", inQ = false;
    for (const c of line) {
      if (c === '"') inQ = !inQ;
      else if (c === "," && !inQ) { cols.push(cur.trim()); cur = ""; }
      else cur += c;
    }
    cols.push(cur.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = (cols[i] ?? "").replace(/^"|"$/g, ""); });
    return row;
  });
}

// ─── Data Processing ──────────────────────────────────────────────────────────
function processData(invRows, txnRows) {
  const today = new Date();
  const d10 = new Date(today); d10.setDate(today.getDate() - 10);
  const d30 = new Date(today); d30.setDate(today.getDate() - 30);
  const d60 = new Date(today); d60.setDate(today.getDate() - 60);
  const s10 = {}, s30 = {}, sp30 = {};

  for (const row of txnRows) {
    if ((row["Is Reverse"] || "").toLowerCase() === "yes") continue;
    if ((row["Status"] || "").toUpperCase() === "CANCELED") continue;
    const sku = (row["Master SKU"] || "").trim();
    const qty = parseFloat(row["Product Quantity"]) || 1;
    const dt  = new Date(row["Shiprocket Created At"] || "");
    if (!sku || isNaN(dt)) continue;
    if (dt >= d10)             s10[sku]  = (s10[sku]  || 0) + qty;
    if (dt >= d30)             s30[sku]  = (s30[sku]  || 0) + qty;
    if (dt >= d60 && dt < d30) sp30[sku] = (sp30[sku] || 0) + qty;
  }

  const results = [];
  for (const inv of invRows) {
    const sku   = (inv["Master SKU"] || "").trim();
    if (!sku) continue;
    const stock = parseFloat(inv["Available Inventory - Good"]) || 0;
    const r10   = (s10[sku]  || 0) / 10;
    const r30   = (s30[sku]  || 0) / 30;
    const rp30  = (sp30[sku] || 0) / 30;
    const r2mo  = (r30 + rp30) / 2;
    if (r10 === 0 && r2mo === 0) continue;
    const spikeFactor = r2mo > 0 ? r10 / r2mo : (r10 > 0 ? 9 : 0);
    const hasSpike    = spikeFactor > SPIKE_THR;
    const effRate     = hasSpike ? (0.6 * r10 + 0.4 * r2mo) : r2mo;
    if (effRate === 0) continue;
    const proj60  = Math.round(effRate * 60);
    const daysOut = stock / effRate;
    const status  = daysOut < LEAD_TIME ? "urgent" : daysOut < (PROJ_DAYS + LEAD_TIME) ? "at_risk" : "safe";
    results.push({
      sku, name: (inv["Product Name"] || sku).slice(0, 70),
      stock: Math.round(stock),
      r10: +r10.toFixed(2), r30: +r30.toFixed(2), rp30: +rp30.toFixed(2), r2mo: +r2mo.toFixed(2),
      spike_factor: +spikeFactor.toFixed(2), has_spike: hasSpike, eff_rate: +effRate.toFixed(2),
      proj60, old_proj60: Math.round(r2mo * 60),
      days_out: +daysOut.toFixed(1), reorder_qty: Math.max(0, Math.round(proj60 - stock)), status,
    });
  }
  results.sort((a, b) => a.days_out - b.days_out);
  return results;
}

// ─── UI Components ────────────────────────────────────────────────────────────
const statusCfg = {
  urgent:  { badge: "bg-red-700 text-red-100",     border: "border-red-700",     bg: "bg-red-950",     label: "🔴 URGENT"  },
  at_risk: { badge: "bg-amber-700 text-amber-100", border: "border-amber-700",   bg: "bg-amber-950",   label: "🟡 AT RISK" },
  safe:    { badge: "bg-green-700 text-green-100", border: "border-emerald-700", bg: "bg-emerald-950", label: "🟢 SAFE"    },
};

function StockBar({ stock, proj60 }) {
  const pct   = proj60 > 0 ? Math.min(100, (stock / proj60) * 100) : 0;
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
              ["rate_10d",  "= sales(last 10d) ÷ 10"],
              ["rate_30d",  "= sales(last 30d) ÷ 30"],
              ["rate_prev", "= sales(30–60d ago) ÷ 30"],
              ["rate_2mo",  "= (rate_30d + rate_prev) ÷ 2"],
            ],
          },
          {
            title: "Step 2 · Detect Spike",
            lines: [
              ["spike_factor", "= rate_10d ÷ rate_2mo"],
              ["threshold",    "> 1.3× (30%+ acceleration)"],
              ["spike = YES",  "if spike_factor > 1.3"],
            ],
          },
          {
            title: "Step 3 · Effective Rate",
            lines: [
              ["no spike",  "eff = rate_2mo"],
              ["spike ⚡",  "eff = 0.6 × rate_10d"],
              ["",          "    + 0.4 × rate_2mo"],
              ["why 60/40", "trusts spike, avoids overstock"],
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
              ["proj_60d",    "= eff_rate × 60"],
              ["reorder_qty", "= max(0, proj_60d − stock)"],
              ["days_out",    "= stock ÷ eff_rate"],
            ],
          },
          {
            title: "Step 5 · Reprint Decision",
            lines: [
              ["🔴 URGENT",  "days_out < 15d  →  REPRINT IMMEDIATELY"],
              ["🟡 AT RISK", "15d ≤ days_out < 75d  →  REPRINT SOON"],
              ["🟢 SAFE",    "days_out ≥ 75d  →  Monitor only"],
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
            ["Print Lead Time",      "15 days"],
            ["Planning Window",      "60 days"],
            ["Trigger Horizon",      "75 days  (15 + 60)"],
            ["Spike Threshold",      "> 1.3×"],
            ["Spike Weight (recent)","60%"],
            ["Spike Weight (hist.)", "40%"],
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

function SKUCard({ item, showPerSKU }) {
  const cfg   = statusCfg[item.status];
  const delta = item.proj60 - item.old_proj60;
  return (
    <div className={`rounded-xl border ${cfg.border} ${cfg.bg} p-4 hover:scale-[1.01] transition-transform`}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <p className="text-white font-semibold text-sm leading-snug" title={item.name}>{item.name}</p>
          <p className="text-gray-500 font-mono text-xs mt-0.5">{item.sku}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${cfg.badge}`}>{cfg.label}</span>
          {item.has_spike && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-purple-700 text-purple-100">⚡ ×{item.spike_factor}</span>}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-2">
        {[
          { l: "Stock",     v: item.stock.toLocaleString(),                          c: item.stock < 50 ? "text-red-400" : "text-white" },
          { l: "Days Left", v: item.days_out < 1 ? "< 1" : item.days_out.toFixed(0), c: item.days_out < 15 ? "text-red-400" : item.days_out < 45 ? "text-amber-400" : "text-green-400" },
          { l: "Reorder",   v: item.reorder_qty.toLocaleString(),                    c: "text-white" },
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
          <div className="flex justify-between"><span className="text-gray-500">rate 10d / 30d / prev:</span><span>{item.r10} / {item.r30} / {item.rp30}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">2-mo avg:</span><span>{item.r2mo} /day</span></div>
          {item.has_spike
            ? <div className="flex justify-between text-purple-400"><span>⚡ blended (60/40):</span><span>{item.eff_rate} /day</span></div>
            : <div className="flex justify-between"><span className="text-gray-500">eff rate:</span><span>{item.eff_rate} /day</span></div>}
          <div className="flex justify-between text-white border-t border-gray-700 pt-1">
            <span>60d forecast:</span>
            <span>{item.proj60}{delta > 0 && <span className="text-purple-400 ml-1">(+{delta} vs avg)</span>}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [invText,  setInvText]  = useState(null);
  const [txnText,  setTxnText]  = useState(null);
  const [invName,  setInvName]  = useState("");
  const [txnName,  setTxnName]  = useState("");
  const [data,     setData]     = useState(null);
  const [runError, setRunError] = useState("");
  const [filter,   setFilter]   = useState("all");
  const [search,   setSearch]   = useState("");
  const [showFormula, setShowFormula] = useState(false);
  const [showPerSKU,  setShowPerSKU]  = useState(false);

  // ── Run projection ──────────────────────────────────────────────────────────
  const handleRun = useCallback(() => {
    setRunError(""); setData(null);
    try {
      if (!invText || !txnText) { setRunError("Upload both files first."); return; }
      const inv = parseCSV(invText);
      const txn = parseCSV(txnText);
      if (!inv[0]?.["Master SKU"])            { setRunError("Inventory CSV missing 'Master SKU' column."); return; }
      if (!txn[0]?.["Shiprocket Created At"]) { setRunError("Transactions CSV missing 'Shiprocket Created At' column."); return; }
      const result = processData(inv, txn);
      if (!result.length) { setRunError("No active SKUs found — check Master SKU values match between files."); return; }
      setData(result);
    } catch (e) { setRunError("Processing error: " + e.message); }
  }, [invText, txnText]);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const counts = useMemo(() => data ? {
    urgent:  data.filter(r => r.status === "urgent").length,
    at_risk: data.filter(r => r.status === "at_risk").length,
    safe:    data.filter(r => r.status === "safe").length,
    spiked:  data.filter(r => r.has_spike).length,
    total:   data.length,
  } : null, [data]);

  const spikeImpact = useMemo(() =>
    data ? data.filter(r => r.has_spike).reduce((a, r) => a + (r.proj60 - r.old_proj60), 0) : 0
  , [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    let d = filter === "all"    ? data.filter(r => r.status !== "safe")
          : filter === "spiked" ? data.filter(r => r.has_spike)
          : data.filter(r => r.status === filter);
    if (search) d = d.filter(r =>
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.sku.toLowerCase().includes(search.toLowerCase())
    );
    return d;
  }, [data, filter, search]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-white p-4 md:p-8" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
      {/* Header */}
      <div className="mb-6">
        <p className="text-indigo-500 text-xs tracking-widest uppercase mb-1">Reprint Planning System</p>
        <h1 className="text-3xl font-bold">📦 Inventory Projection</h1>
        <p className="text-gray-500 text-xs mt-1">Adaptive Weighted Rate · {LEAD_TIME}d print lead time · {PROJ_DAYS}d planning window</p>
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

      {/* Results */}
      {data && counts && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            {[
              { l: "🔴 Urgent",  v: counts.urgent,  s: "Stockout < 15d",             c: "border-red-700 bg-red-950"        },
              { l: "🟡 At Risk", v: counts.at_risk, s: "Reprint decision needed",     c: "border-amber-700 bg-amber-950"    },
              { l: "⚡ Spikes",  v: counts.spiked,  s: `+${spikeImpact} units added`, c: "border-purple-700 bg-purple-950"  },
              { l: "🟢 Safe",    v: counts.safe,    s: "75+ day coverage",            c: "border-emerald-700 bg-emerald-950"},
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
            <button onClick={() => downloadCSV(data)}
              className="px-5 py-2.5 rounded-xl font-bold text-sm bg-indigo-700 hover:bg-indigo-600 text-white transition-all">
              ⬇ Download CSV
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

          {/* Filters + search */}
          <div className="flex gap-2 mb-4 flex-wrap items-center">
            {[
              { k: "all",     l: `All At-Risk (${counts.urgent + counts.at_risk})` },
              { k: "urgent",  l: `🔴 Urgent (${counts.urgent})`  },
              { k: "at_risk", l: `🟡 At Risk (${counts.at_risk})` },
              { k: "spiked",  l: `⚡ Spikes (${counts.spiked})`  },
              { k: "safe",    l: `🟢 Safe (${counts.safe})`      },
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
            {filtered.map(item => <SKUCard key={item.sku} item={item} showPerSKU={showPerSKU} />)}
          </div>

          {filtered.length === 0 && (
            <div className="text-center py-16 text-gray-600">
              <p className="text-4xl mb-3">🔍</p>
              <p>No SKUs match your filter or search</p>
            </div>
          )}

          <div className="mt-8 border border-gray-800 rounded-xl p-4 text-xs text-indigo-400/60">
            Spike: rate_10d &gt; {SPIKE_THR}× rate_2mo · Blend: 60% recent + 40% hist · Trigger: {PROJ_DAYS + LEAD_TIME}d · Active SKUs: {counts.total}
          </div>
        </>
      )}
    </div>
  );
}
