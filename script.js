/* =========================================================================
   MPB-01 MES DASHBOARD JAVASCRIPT
   Sesuai Spesifikasi API Backend MES Liquid Filling Machine
   (OEE, MLT, WIP, Cycle Time, Kapasitas, Kualitas/SPC, Inventori, Reliabilitas)
========================================================================= */

/* =================================
   0. KONFIGURASI API & KONSTANTA
================================= */

const REMOTE_API = "https://filling-machine-api.zamazzam.me";
const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";

// Identitas Mesin & Kunci API dari LocalStorage atau default
let machineId = localStorage.getItem("MES_MACHINE_ID") || window.MES_MACHINE_ID || "mesin-01";
let apiKey = localStorage.getItem("MES_API_KEY") || window.MES_API_KEY || "";
let apiBase = localStorage.getItem("MES_API_BASE") || window.MES_API_BASE || null;
let apiPrefix = window.MES_API_PREFIX || null;

// Interval Polling Terpisah (Live Telemetri 3 detik, Analitik Berat 30 detik)
const POLL_LIVE_MS = 3000;
const POLL_ANALYTICS_MS = 30000;
const STALE_MS = 30000;

// Kandidat host API untuk auto-discovery
const CANDIDATE_BASES = [
    apiBase,
    location.origin,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://filling-machine-api.zamazzam.me",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
].filter(Boolean);

// Spesifikasi Kapasitas Mesin
const SPEC = {
    idealCycleTime: 4.1,               // 1.5s putar + 2.6s diam (s/botol)
    theoreticalCapacityHour: 878.05,   // 3600 / 4.1 = 878.05 botol/jam
    qcMinPassLevel: 0.85,              // Batas Lulus QC level isi >= 0.85
    bufferCapacity: {
        infeed: 30,                    // Peti meja infeed maks 30 botol
        turret: 10,                    // Slot turret rotary 10
        boxOk: 30,                     // Kapasitas kotak OK penampung
        boxNg: 12,                     // Kapasitas wadah reject (peringatan jika >= 10)
        rackMax: 100,                  // Kapasitas rak atas default
    },
    defaultTarget: 30,
};

// Global State
let cfg = null;
let lastBottles = [];
let allBatches = [];
let latestStatus = null;
let latestOeeCalc = null;
let latestLaporan = null;
let latestDowntime = null;
let availableMachines = [];
let traceTimer = null;
let liveTimer = null;
let analyticsTimer = null;
let isRefreshingLive = false;
let isRefreshingAnalytics = false;

// DOM Helper
const $ = id => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const setColor = (id, c) => { const el = $(id); if (el) el.style.color = c; };
const setWidth = (id, p) => { const el = $(id); if (el) el.style.width = Math.max(0, Math.min(100, p || 0)) + "%"; };

const GREEN = "#16a34a", RED = "#dc2626", ORANGE = "#ea580c", GREY = "#6b7280", NAVY = "#3a3f7c";

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const show = v => (v === null || v === undefined || Number.isNaN(v) ? "--" : v);

function parseUTC(v) {
    if (!v) return null;
    const s = String(v);
    const ms = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
    return isNaN(ms) ? null : ms;
}

function fmtTime(v) {
    const ms = parseUTC(v);
    return ms === null ? "--:--:--" :
        new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Asia/Jakarta", hour12: false });
}

function fmtDateTime(ms) {
    if (!ms) return "--";
    const t = typeof ms === "number" ? ms : parseUTC(ms);
    if (!t) return "--";
    return new Date(t).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
}

function fmtDur(sec) {
    if (sec === null || sec === undefined || Number.isNaN(sec)) return "--";
    sec = Math.round(Number(sec) || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}j ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}


/* =================================
   1. KOMUNIKASI REST API & MANAJEMEN MESIN
================================= */

async function api(path, query) {
    if (!apiBase) await getHealth();
    const url = new URL((apiBase || REMOTE_API) + (apiPrefix || "/api") + path);
    Object.entries(query || {}).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "") {
            // Konversi Date ke ISO 8601 UTC jika ada filter tanggal
            if (v instanceof Date) url.searchParams.set(k, v.toISOString());
            else url.searchParams.set(k, String(v));
        }
    });

    const headers = {};
    if (apiKey) headers["X-Api-Key"] = apiKey;

    const t0 = performance.now();
    const res = await fetch(url, Object.keys(headers).length ? { headers } : undefined);
    if (!res.ok) {
        const err = new Error("HTTP " + res.status);
        err.status = res.status;
        throw err;
    }
    return { data: await res.json(), ms: Math.round(performance.now() - t0) };
}

async function getHealth() {
    // 1. Jika apiBase sudah diketahui, tes dulu
    if (apiBase) {
        for (const prefix of apiPrefix ? [apiPrefix] : ["/api", "/api/v1"]) {
            try {
                const url = new URL(apiBase.replace(/\/$/, "") + prefix + "/health");
                const t0 = performance.now();
                const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
                if (res.ok) {
                    apiPrefix = prefix;
                    return { data: await res.json(), ms: Math.round(performance.now() - t0), base: apiBase };
                }
            } catch (e) {}
        }
        apiBase = null; // reset jika tidak lagi merespons
    }

    // 2. Auto-discovery dari daftar kandidat host
    let lastErr = new Error("Semua endpoint API tidak dapat dijangkau");
    for (const base of CANDIDATE_BASES) {
        const cleanBase = base.replace(/\/$/, "");
        for (const prefix of ["/api", "/api/v1"]) {
            try {
                const url = new URL(cleanBase + prefix + "/health");
                const t0 = performance.now();
                const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
                if (res.ok) {
                    const data = await res.json();
                    apiBase = cleanBase;
                    apiPrefix = prefix;
                    console.log("MES Dashboard terhubung ke API:", apiBase + apiPrefix);
                    return { data, ms: Math.round(performance.now() - t0), base: apiBase };
                }
            } catch (err) {
                lastErr = err;
            }
        }
    }
    throw lastErr;
}

function unwrapObject(body) {
    if (!body) return null;
    if (Array.isArray(body)) return body[0] || null;
    for (const key of ["data", "telemetri", "item", "laporan", "detail"]) {
        const v = body && body[key];
        if (v && typeof v === "object") return Array.isArray(v) ? v[0] || null : v;
    }
    return body;
}

function unwrapList(body) {
    if (!body) return [];
    if (Array.isArray(body)) return body;
    for (const key of ["data", "items", "botol", "event", "events", "hasil", "kejadian", "mesin"]) {
        if (body && Array.isArray(body[key])) return body[key];
    }
    return [];
}

// Mengambil daftar mesin dari GET /api/mesin & memperbarui dropdown
async function fetchMachineList() {
    try {
        const res = await api("/mesin");
        const list = unwrapList(res.data);
        if (Array.isArray(list) && list.length > 0) {
            availableMachines = list;
        } else {
            availableMachines = [{ id: machineId, nama: "ROTARY FILLING MPB-01" }];
        }
    } catch (err) {
        console.warn("Gagal mengambil /api/mesin:", err.message);
        if (!availableMachines.length) {
            availableMachines = [{ id: machineId, nama: "ROTARY FILLING MPB-01" }];
        }
    }

    renderMachineDropdowns();
}

function renderMachineDropdowns() {
    machineId = "mesin-01";
    let mName = "ROTARY FILLING";
    if (Array.isArray(availableMachines) && availableMachines.length) {
        const m = availableMachines[0];
        if (m && typeof m === "object") {
            const rawName = m.nama || m.name || m.deskripsi;
            if (rawName && typeof rawName === "string") {
                mName = rawName;
            }
        }
    }
    setText("machineName", mName);
    setText("settingMachineName", mName);
    setText("settingMachineId", machineId);
}

function changeActiveMachine(newId) {
    machineId = "mesin-01";
    renderMachineDropdowns();
}

// Konfigurasi API dari Form Pengaturan
function saveApiBaseConfig() {
    const input = $("apiBaseInput");
    const val = input ? input.value.trim().replace(/\/$/, "") : "";
    if (val) {
        apiBase = val;
        localStorage.setItem("MES_API_BASE", apiBase);
    } else {
        apiBase = null;
        localStorage.removeItem("MES_API_BASE");
    }
    refreshAll(true);
    alert("Base URL berhasil disimpan: " + (apiBase || "Default (Auto-discovery)"));
}

function saveApiKeyConfig() {
    const input = $("apiKeyInput");
    apiKey = input ? input.value.trim() : "";
    if (apiKey) {
        localStorage.setItem("MES_API_KEY", apiKey);
    } else {
        localStorage.removeItem("MES_API_KEY");
    }
    updateApiKeyStatusPill();
    refreshAll(true);
    alert(apiKey ? "X-Api-Key berhasil disimpan di browser." : "X-Api-Key telah dikosongkan.");
}

function updateApiKeyStatusPill() {
    const pill = $("apiKeyStatus");
    if (!pill) return;
    if (apiKey) {
        pill.textContent = "✓ Aktif Terpasang";
        pill.className = "pill ok";
    } else {
        pill.textContent = "Belum Diset (Publik)";
        pill.className = "pill warning";
    }
}


/* =================================
   2. NAVIGASI HALAMAN & SIDEBAR
================================= */

const dashboard = $("dashboard");
const toggleButton = $("toggleSidebar");

function toggleSidebar() {
    dashboard?.classList.toggle("collapsed");
}
toggleButton?.addEventListener("click", toggleSidebar);

const navLinks = document.querySelectorAll(".nav-link");
const pages = document.querySelectorAll(".page");

navLinks.forEach(link => {
    link.addEventListener("click", function () {
        const selectedPage = this.dataset.page;
        navLinks.forEach(item => item.classList.remove("active"));
        this.classList.add("active");

        pages.forEach(page => page.classList.remove("active"));
        const targetPage = $("page-" + selectedPage);
        if (targetPage) targetPage.classList.add("active");

        window.scrollTo({ top: 0, behavior: "smooth" });

        // Trigger on-demand data refresh saat pengguna membuka tab analitik
        if (selectedPage !== "live") {
            refreshAnalytics(false);
        }
    });
});

function toggleTheme() {
    document.body.classList.toggle("dark-mode");
    const isDark = document.body.classList.contains("dark-mode");
    const btn = $("themeToggle");
    if (btn) btn.textContent = isDark ? "☾" : "☼";
}
$("themeToggle")?.addEventListener("click", toggleTheme);


/* =================================
   3. PEMFORMAT DATA TABEL & BARIS
================================= */

const noOf = b => "#" + String(b.nomor || b.nomor_botol || 0).padStart(5, "0");
const fillOf = b => (typeof b.level_isi === "number" ? Math.round(b.level_isi * 100) + "%" : "--");

function cycleOf(b) {
    if (typeof b.unit_mlt_detik === "number") return b.unit_mlt_detik.toFixed(1) + " s";
    if (typeof b.durasi_isi_detik === "number") return b.durasi_isi_detik.toFixed(2) + " s";
    if (b.waktu_keluar && b.waktu_masuk) {
        const d = (parseUTC(b.waktu_keluar) - parseUTC(b.waktu_masuk)) / 1000;
        if (Number.isFinite(d)) return d.toFixed(1) + " s";
    }
    return "--";
}

function fillDurationOf(b) {
    if (typeof b.durasi_isi_detik === "number") return b.durasi_isi_detik.toFixed(2) + " s";
    if (b.waktu_isi_selesai && b.waktu_isi_mulai) {
        const d = (parseUTC(b.waktu_isi_selesai) - parseUTC(b.waktu_isi_mulai)) / 1000;
        if (Number.isFinite(d)) return d.toFixed(2) + " s";
    }
    return "--";
}

const bottleRowLive = b => [
    noOf(b),
    "Slot " + (b.slot !== undefined ? b.slot : "--"),
    fillOf(b),
    b.status || (b.level_isi >= SPEC.qcMinPassLevel ? "OK" : "TIDAK_PENUH"),
    cycleOf(b)
];

const qualityRowTable = b => [
    noOf(b),
    b.slot !== undefined ? b.slot : "--",
    fillOf(b),
    b.bertutup ? "✓ Tertutup" : "✗ Terbuka",
    b.status || (b.level_isi >= SPEC.qcMinPassLevel ? "OK" : "TIDAK_PENUH"),
    fillDurationOf(b),
    cycleOf(b),
    fmtTime(b.waktu_keluar || b.waktu_masuk || b.waktu)
];

// Tabel Event 5 Kolom: Waktu, Jenis, Sumber, Kategori, Keterangan
const eventRowTable = e => [
    fmtTime(e.waktu),
    e.jenis || "-",
    e.sumber || "sistem",
    e.kategori_downtime || (e.jenis === "estop_tekan" ? "UNPLANNED_BREAKDOWN" : "NORMAL_RUN"),
    [e.pesan, e.mode_sebelum && e.mode_sesudah ? `${e.mode_sebelum} → ${e.mode_sesudah}` : ""]
        .filter(Boolean).join(" · ") || e.pengguna || "-"
];

// Tabel Downtime 5 Kolom: Waktu, Durasi, Kategori, Penyebab/Pesan, Sumber/Operator
const downtimeRowTable = k => [
    fmtTime(k.waktu_mulai || k.waktu),
    k.durasi_detik !== undefined ? fmtDur(k.durasi_detik) : "--",
    k.kategori || k.kategori_downtime || "UNPLANNED_BREAKDOWN",
    k.penyebab || k.pesan || k.keterangan || "E-Stop ditekan / Gangguan mekanik",
    k.sumber || k.operator || k.pengguna || (k.mode_sebelum ? `${k.mode_sebelum} → ${k.mode_sesudah}` : "sistem")
];

function fillTable(id, rows, cols, emptyText) {
    const body = $(id);
    if (!body) return;
    body.replaceChildren();

    if (!rows || !rows.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = cols;
        td.style.textAlign = "center";
        td.textContent = emptyText;
        tr.appendChild(td);
        body.appendChild(tr);
        return;
    }

    rows.forEach(cells => {
        const tr = document.createElement("tr");
        cells.forEach(cell => {
            const td = document.createElement("td");
            const text = String(cell);
            td.textContent = text;
            if (text === "OK" || text === "✓ Tertutup" || text === "NORMAL_RUN") {
                td.style.color = GREEN;
                td.style.fontWeight = "600";
            } else if (text === "TIDAK_PENUH" || text === "TANPA_TUTUP" || text === "✗ Terbuka" || text.includes("BREAKDOWN") || text.includes("estop_tekan")) {
                td.style.color = RED;
                td.style.fontWeight = "600";
            } else if (text.includes("SETUP") || text.includes("BLOCKED")) {
                td.style.color = ORANGE;
                td.style.fontWeight = "600";
            }
            tr.appendChild(td);
        });
        body.appendChild(tr);
    });
}


/* =================================
   4. PENCARIAN TRACEABILITY BOTOL (GET /api/mesin/{id}/botol/{nomor})
================================= */

function searchBottleLive() {
    const input = ($("bottleSearch")?.value || "").toLowerCase();
    document.querySelectorAll("#bottleTable tr").forEach(row => {
        row.style.display = row.textContent.toLowerCase().includes(input) ? "" : "none";
    });
}

async function searchTrace() {
    const rawVal = $("traceSearch")?.value.trim() || "";
    const digits = rawVal.replace(/\D/g, "");
    const card = $("bottleDetailCard");

    if (!digits) {
        if (card) card.style.display = "none";
        fillTable("traceTable", lastBottles.map(qualityRowTable), 8, "Belum ada data botol.");
        setText("traceInfo", `${lastBottles.length} botol terakhir sesi ini. Masukkan nomor botol untuk mencari detail.`);
        return;
    }

    const num = Number(digits);
    try {
        setText("traceInfo", `Mencari botol #${String(num).padStart(5, "0")} ke database API...`);
        // Memanggil endpoint spesifik GET /api/mesin/{id}/botol/{nomor}
        const res = await api(`/mesin/${encodeURIComponent(machineId)}/botol/${num}`);
        const bottle = unwrapObject(res.data);

        if (bottle && (bottle.nomor || bottle.nomor_botol || bottle.id || bottle.slot !== undefined)) {
            fillTable("traceTable", [bottle].map(qualityRowTable), 8, "");
            setText("traceInfo", `Ditemukan data spesifik botol #${String(num).padStart(5, "0")} dari API.`);

            if (card) {
                card.style.display = "block";
                setText("cardBottleNo", `Botol #${String(num).padStart(5, "0")}`);
                setText("cardSlot", `Slot ${bottle.slot !== undefined ? bottle.slot : "--"}`);
                setText("cardFill", fillOf(bottle));
                setText("cardCapping", bottle.bertutup ? "✓ Terpasang Rapat" : "✗ Tanpa Tutup");
                setText("cardFillingDuration", fillDurationOf(bottle));
                setText("cardUnitMlt", cycleOf(bottle));
                setText("cardBatch", `Batch #${bottle.batch_ke || 1}`);
                setText("cardTimeIn", fmtTime(bottle.waktu_masuk));
                setText("cardTimeOut", fmtTime(bottle.waktu_keluar));

                const statusEl = $("cardBottleStatus");
                if (statusEl) {
                    const st = bottle.status || (bottle.level_isi >= SPEC.qcMinPassLevel ? "OK" : "TIDAK_PENUH");
                    statusEl.textContent = st;
                    statusEl.className = "pill " + (st === "OK" ? "ok" : "danger");
                }
            }
        } else {
            if (card) card.style.display = "none";
            fillTable("traceTable", [], 8, `Botol #${num} tidak ditemukan di database.`);
            setText("traceInfo", `Tidak ada data botol dengan nomor #${num}.`);
        }
    } catch (err) {
        if (card) card.style.display = "none";
        fillTable("traceTable", [], 8, `Botol #${num} tidak ditemukan.`);
        setText("traceInfo", err.status === 404
            ? `Botol #${num} tidak ditemukan di database (404).`
            : "Gagal menghubungi database botol: " + err.message);
    }
}

$("bottleSearch")?.addEventListener("input", searchBottleLive);
$("traceSearch")?.addEventListener("input", () => {
    clearTimeout(traceTimer);
    traceTimer = setTimeout(searchTrace, 350);
});


/* =================================
   5. DETAIL ARSIP BATCH (GET /api/mesin/{id}/batch/{batch_ke})
================================= */

async function showBatchDetail(batchKe) {
    const modal = $("batchModal");
    if (!modal) return;
    modal.style.display = "flex";

    setText("modalBatchTitle", `Detail Batch #${batchKe}`);
    setText("modalBatchKe", `#${batchKe}`);
    setText("modalBatchSesi", "Memuat...");
    setText("modalBatchQty", "Memuat...");
    setText("modalBatchQuality", "Memuat...");
    setText("modalBatchOee", "--%");
    setText("modalBatchAvail", "--%");
    setText("modalBatchPerf", "--%");
    setText("modalBatchQual", "--%");
    setText("modalBatchMlt", "-- s");
    setText("modalBatchCap", "-- bph");
    setText("modalBatchStart", "--:--:--");
    setText("modalBatchEnd", "--:--:--");

    try {
        const res = await api(`/mesin/${encodeURIComponent(machineId)}/batch/${batchKe}`);
        const b = unwrapObject(res.data) || {};

        setText("modalBatchTitle", `Detail Batch #${b.batch_ke || batchKe}`);
        setText("modalBatchKe", `#${b.batch_ke || batchKe}`);
        setText("modalBatchSesi", b.sesi_id ? String(b.sesi_id).slice(0, 16) : "--");
        setText("modalBatchQty", `${b.target_qty || SPEC.defaultTarget} Target / ${b.botol_selesai || 0} Selesai`);
        setText("modalBatchQuality", `${b.botol_ok || 0} OK / ${b.botol_reject || 0} NG`);
        setText("modalBatchOee", `${(b.oee_pct || 0).toFixed(1)}%`);
        setText("modalBatchAvail", `${(b.availability_pct || 0).toFixed(1)}%`);
        setText("modalBatchPerf", `${(b.performance_pct || 0).toFixed(1)}%`);
        setText("modalBatchQual", `${(b.quality_pct || 0).toFixed(1)}%`);
        setText("modalBatchMlt", `${Math.round(b.mlt_batch || 240)} s`);
        setText("modalBatchCap", `${Math.round(b.effective_capacity_per_hour || 450)} bph`);
        setText("modalBatchStart", fmtTime(b.waktu_mulai));
        setText("modalBatchEnd", fmtTime(b.waktu_selesai));
    } catch (err) {
        setText("modalBatchSesi", "Gagal memuat detail dari API: " + err.message);
    }
}

function closeBatchModal() {
    const modal = $("batchModal");
    if (modal) modal.style.display = "none";
}


/* =================================
   6. LOGIKA PERHITUNGAN MES & RENDER
================================= */

function renderMachineHeader(s, online, hasData, lastMs) {
    const mode = s.darurat ? "Darurat" : s.mode || "Mati";
    const sesi = s.sesi_id ? String(s.sesi_id) : "--";
    const batch = s.batch_ke || 1;
    const operatorMode = s.operator_mode || "Operasi";
    const qcLast = s.status_qc_terakhir || (s.botol_reject > 0 ? "REJECT" : "OK");

    const mName = cfg?.nama || cfg?.name || "ROTARY FILLING";
    const shortName = mName.length > 24 ? mName.slice(0, 24) + "..." : mName;
    const sessionName = s.nama_sesi || s.sesi_nama || s.nama || s.pengguna || s.operator || "Operator";
    setText("machineName", shortName.toUpperCase());
    const shortSesi = s.nama_sesi ? s.nama_sesi : (s.sesi_id ? `#${String(s.sesi_id).slice(-6)}` : "--");
    setText("operatorName", s.pengguna || "Operator");
    setText("operatorShift", `Sesi: ${shortSesi}`);
    setText("shiftInfo", `◷ Sesi: ${sessionName}`);
    if ($("shiftInfo")) {
        $("shiftInfo").title = s.sesi_id ? `ID Sesi: ${s.sesi_id}` : "Tidak ada sesi aktif";
    }
    setText("simulationStatus", online ? "LIVE TELEMETRY" : hasData ? "DATA LAMA" : "OFFLINE");

    // Status Mesin Badge
    const statusLabel = !hasData ? "● NO DATA" : online ? `● ${mode.toUpperCase()}` : "● TERPUTUS";
    const statusColor = !hasData || !online ? GREY : (mode === "Berjalan" ? GREEN : mode === "Darurat" ? RED : ORANGE);
    setText("machineStatus", statusLabel);
    setColor("machineStatus", statusColor);

    // Tahap & Tugas Operator
    const tahap = hasData ? (s.tahap || "Operasi Normal") : "Menunggu telemetri";
    setText("activeProcess", tahap);
    setText("machineTask", s.operator_tugas || `Operator Mode: ${operatorMode}`);
    setText("liveBatchBadge", `Batch: #${batch}`);

    const qcBadge = $("liveQcBadge");
    if (qcBadge) {
        qcBadge.style.display = "inline-block";
        qcBadge.textContent = `QC: ${qcLast}`;
        qcBadge.style.background = qcLast === "OK" ? "#dcfce7" : "#fee2e2";
        qcBadge.style.color = qcLast === "OK" ? "#15803d" : "#b91c1c";
    }

    setText("lastQcStatusText", qcLast);
    setText("batchNumber", `Sesi: ${sesi.slice(0, 12)} · Batch #${batch}`);
    setText("downtimeMachineStatus", `Mesin: ${mode}`);
    setColor("downtimeMachineStatus", statusColor);

    // MCB Status
    const mcb = s.mcb || {};
    [["mcbMain", "utama", "Utama"], ["mcbMachine", "mesin", "Mesin"],
    ["mcbControl", "kontrol", "Kontrol"], ["mcbLamp", "lampu", "Lampu"]].forEach(([id, key, name]) => {
        const on = mcb[key];
        setText(id, `● ${on === undefined ? "--" : on ? "ON" : "OFF"} ${name}`);
        setColor(id, on ? GREEN : on === false ? RED : "");
    });

    // GPIO Digital Twin
    const gpio = s.gpio || {};
    const GPIO_MAP = [["Step", "step"], ["Dir", "dir"], ["Enable", "en"], ["Pump", "pompa"],
    ["Buzzer", "buzzer"], ["IR", "ir"], ["Start", "start"], ["Limit", "limit"]];
    GPIO_MAP.forEach(([name, key]) => {
        const on = !!gpio[key];
        setText("gpio" + name, hasData ? (on ? "ON" : "OFF") : "MENUNGGU DATA");
        const ind = $("indicator" + name);
        if (ind) {
            ind.classList.toggle("inactive", !on);
            ind.classList.toggle("active", on);
            ind.style.background = on ? GREEN : "";
        }
    });

    // Peringatan sistem (Alert Banner)
    const alertBanner = $("liveAlertBanner");
    const alertMsg = $("alertMessage");
    const boxNg = s.isi_kotak_reject || 0;
    const isStarving = !!s.sedang_starving;
    const rackLow = (s.sisa_stok_rak_atas !== undefined && s.sisa_stok_rak_atas <= 2);

    if (alertBanner && alertMsg) {
        if (boxNg >= 10) {
            alertBanner.className = "alert-banner danger";
            alertBanner.style.display = "flex";
            alertMsg.textContent = `PERINGATAN: Wadah Reject Hampir Penuh (${boxNg}/12 botol)! Segera kosongkan wadah reject.`;
        } else if (isStarving) {
            alertBanner.className = "alert-banner warning";
            alertBanner.style.display = "flex";
            alertMsg.textContent = "PERINGATAN MESIN STARVING: Meja Infeed kehabisan botol kosong. Harap isi kembali peti.";
        } else if (rackLow) {
            alertBanner.className = "alert-banner warning";
            alertBanner.style.display = "flex";
            alertMsg.textContent = `PERINGATAN: Sisa stok rak atas menipis (${s.sisa_stok_rak_atas} peti). Siapkan restock.`;
        } else {
            alertBanner.style.display = "none";
        }
    }
}

function renderTurretVisual(s, hasData) {
    const angle = hasData ? Number(s.sudut_turret_deg) || 0 : null;
    setText("turretAngle", angle === null ? "--°" : Math.round(angle) + "°");
    setText("turretAngleHeader", angle === null ? "0°" : Math.round(angle) + "°");
    setText("turretPitch", `Sudut: ${angle !== null ? Math.round(angle) : "--"}°`);
    setText("turretSync", hasData ? "SINKRON DENGAN SERVO" : "MENUNGGU DATA");

    const activeSlot = angle === null ? 0 : (Math.round((angle % 360) / 36) % 10) + 1;
    for (let i = 1; i <= 10; i++) {
        const el = document.querySelector(".station.s" + i);
        if (!el) continue;
        el.classList.toggle("active-station", i === activeSlot);
        const wipInTurret = s.wip_turret || 0;
        el.classList.toggle("filled", i <= wipInTurret);
    }
}

// Simulasi Inching & Reset Posisi Turret untuk keperluan inspeksi slot visual
function inchTurret() {
    const current = Number(latestStatus?.sudut_turret_deg || 0);
    const nextAngle = (current + 36) % 360;
    if (!latestStatus) latestStatus = {};
    latestStatus.sudut_turret_deg = nextAngle;
    renderTurretVisual(latestStatus, true);
}

function resetTurret() {
    if (!latestStatus) latestStatus = {};
    latestStatus.sudut_turret_deg = 0;
    renderTurretVisual(latestStatus, true);
}

function renderWipAndBuffers(s, wipData) {
    const sisaPeti = s.sisa_peti ?? (wipData?.sisa_peti ?? 0);
    const wipTurret = s.wip_turret ?? (wipData?.wip_turret ?? 0);
    const isiKotak = s.isi_kotak ?? (wipData?.isi_kotak ?? 0);
    const isiKotakReject = s.isi_kotak_reject ?? (wipData?.isi_kotak_reject ?? 0);
    const totalWip = wipData?.wip_total ?? (sisaPeti + wipTurret + isiKotak);

    // Live Top Card WIP
    setText("liveWipTotal", totalWip);
    const wipPct = Math.round((totalWip / 52) * 100);
    setWidth("liveWipProgress", wipPct);
    setText("liveWipPercentage", `${wipPct}% Buffer`);
    setText("liveWipStatus", wipData?.warning ? "⚠️ Bottleneck Buffer" : "Aliran Normal");

    // 1. Infeed Station
    setText("palletRemaining", sisaPeti);
    const infeedPct = Math.round((sisaPeti / SPEC.bufferCapacity.infeed) * 100);
    setWidth("palletProgress", infeedPct);
    setText("palletPercentage", `${infeedPct}% sisa (${sisaPeti}/30 botol)`);
    setText("infeedStatus", sisaPeti === 0 ? "Starving" : "Normal");

    // 2. Turret Rotary
    setText("liveTurretWip", wipTurret);
    const turretPct = Math.round((wipTurret / SPEC.bufferCapacity.turret) * 100);
    setWidth("turretWipProgress", turretPct);
    setText("turretWipBadge", `${wipTurret} Botol Aktif`);

    // 3. Kotak OK Penampung
    setText("boxFilled", isiKotak);
    const boxOkPct = Math.round((isiKotak / SPEC.bufferCapacity.boxOk) * 100);
    setWidth("boxProgress", boxOkPct);
    const boxNum = Math.floor((s.botol_ok || s.botol_selesai || 0) / SPEC.bufferCapacity.boxOk) + 1;
    setText("boxPercentage", `${boxOkPct}% terisi (Kotak #${boxNum})`);

    // 4. Wadah Reject (NG)
    setText("liveBoxNg", isiKotakReject);
    const boxNgPct = Math.round((isiKotakReject / SPEC.bufferCapacity.boxNg) * 100);
    setWidth("boxNgProgress", boxNgPct);
    const ngEl = $("stationBoxNg");
    if (ngEl) ngEl.classList.toggle("danger-station", isiKotakReject >= 10);
    setText("boxNgStatus", isiKotakReject >= 10 ? "⚠️ HAMPIR PENUH!" : `${isiKotakReject}/12 botol`);
}

function calculateOeeAndLosses(s, oeeData, sum, dt) {
    const botolSelesai = s.botol_selesai ?? (sum?.jumlah_botol ?? 0);
    const botolOk = s.botol_ok ?? (sum?.botol_ok ?? Math.max(0, botolSelesai - (s.botol_reject || 0)));
    const botolReject = s.botol_reject ?? (sum?.botol_gagal ?? 0);

    const plannedTime = s.planned_production_time || s.batch_cycle_time || 240.0;
    const setupTime = s.setup_time || 15.0;
    const starvationTime = s.starvation_downtime || 5.0;
    const downtimeUnplanned = s.downtime_unplanned ?? (dt?.total_durasi_downtime_detik ?? 0.0);
    const packagingTime = s.packaging_time || 50.0;

    let operatingTime = s.production_time;
    if (operatingTime === undefined || operatingTime === null || operatingTime <= 0) {
        operatingTime = Math.max(0, plannedTime - (downtimeUnplanned + setupTime + starvationTime + packagingTime));
    }

    // Availability, Performance, Quality, OEE
    // Prioritaskan nilai dari API jika > 0, jika API mengirim 0 atau belum menghitung otomatis jalankan rumus pabrik
    let availPct = (typeof oeeData?.availability_pct === "number" && oeeData.availability_pct > 0)
        ? oeeData.availability_pct
        : (oeeData?.availability && oeeData.availability > 0
            ? oeeData.availability * 100
            : (plannedTime > 0 ? (operatingTime / plannedTime) * 100 : 0));

    let perfPct = (typeof oeeData?.performance_pct === "number" && oeeData.performance_pct > 0)
        ? oeeData.performance_pct
        : (oeeData?.performance && oeeData.performance > 0
            ? oeeData.performance * 100
            : (operatingTime > 0 ? ((SPEC.idealCycleTime * botolSelesai) / operatingTime) * 100 : 0));

    let qualPct = (typeof oeeData?.quality_pct === "number" && oeeData.quality_pct > 0)
        ? oeeData.quality_pct
        : (oeeData?.quality && oeeData.quality > 0
            ? oeeData.quality * 100
            : (s.first_pass_yield ?? (botolSelesai > 0 ? (botolOk / botolSelesai) * 100 : 100)));

    let oeePct = (typeof oeeData?.oee_pct === "number" && oeeData.oee_pct > 0)
        ? oeeData.oee_pct
        : (oeeData?.oee && oeeData.oee > 0
            ? oeeData.oee * 100
            : ((availPct / 100) * (perfPct / 100) * (qualPct / 100) * 100));

    availPct = Math.min(100, Math.max(0, availPct));
    perfPct = Math.min(120, Math.max(0, perfPct));
    qualPct = Math.min(100, Math.max(0, qualPct));
    oeePct = Math.min(100, Math.max(0, oeePct));

    // Six Big Losses dari field losses API (/oee) atau fallback lokal
    const losses = oeeData?.losses || {};
    const lossBreakdownVal = losses.breakdown_detik ?? losses.unplanned_breakdown_detik ?? downtimeUnplanned;
    const lossSetupVal = losses.setup_detik ?? losses.planned_setup_detik ?? setupTime;
    const lossStarvingWaitVal = losses.starvation_packaging_detik ?? losses.idling_minor_stoppage_detik ?? (starvationTime + packagingTime);
    const lossSpeedVal = losses.speed_loss_detik ?? losses.reduced_speed_detik ?? Math.max(0, operatingTime - (SPEC.idealCycleTime * botolSelesai));
    const lossQualityVal = losses.quality_loss_detik ?? losses.defect_detik ?? (botolReject * SPEC.idealCycleTime);

    return {
        availPct: Number(availPct.toFixed(1)),
        perfPct: Number(perfPct.toFixed(1)),
        qualPct: Number(qualPct.toFixed(1)),
        oeePct: Number(oeePct.toFixed(1)),
        plannedTime,
        operatingTime,
        setupTime,
        starvationTime,
        packagingTime,
        downtimeUnplanned,
        lossBreakdownVal,
        lossSetupVal,
        lossStarvingWaitVal,
        lossSpeedVal,
        lossQualityVal,
        botolSelesai,
        botolOk,
        botolReject
    };
}

function renderProductionAndOee(s, oeeCalc, capData, leadData) {
    const target = s.target_qty || SPEC.defaultTarget;
    const total = oeeCalc.botolSelesai;
    const good = oeeCalc.botolOk;
    const finishedBoxes = s.kardus_selesai || Math.floor(good / 30);
    const packedBottles = s.total_dikemas || (finishedBoxes * 30);
    const progPct = pct(total, target);

    // Live Card OEE
    setText("liveOee", oeeCalc.oeePct);
    setText("liveOeeComponents", `A: ${oeeCalc.availPct}% | P: ${oeeCalc.perfPct}% | Q: ${oeeCalc.qualPct}%`);

    // Live Card Production
    setText("totalProduction", total);
    setText("productionTarget", target);
    setText("productionPercentage", `Kemajuan: ${progPct}%`);

    // Page Produksi Cards
    setText("prodTotal", total);
    setText("prodTarget", target);
    setText("prodRemaining", Math.max(0, target - total));
    setText("prodPercentage", `${progPct}%`);
    setText("prodPacked", packedBottles);
    setText("prodBoxesFinished", `${finishedBoxes} Kardus Jadi`);

    // Cycle Time (Actual vs Ideal)
    const actualCt = s.actual_cycle_time_avg || (total > 0 ? oeeCalc.operatingTime / total : SPEC.idealCycleTime);
    setText("actualCycleDisplay", actualCt ? actualCt.toFixed(1) + " s" : "4.1 s");
    setText("prodActualCycle", actualCt ? actualCt.toFixed(2) : "4.1");
    const diffCt = actualCt - SPEC.idealCycleTime;
    setText("prodCycleDiff", diffCt > 0 ? `+${diffCt.toFixed(2)}s (Loss)` : "Optimal (0s)");

    // Kapasitas Produksi
    const effectiveCap = capData?.kapasitas_efektif_per_jam ||
        (s.batch_cycle_time ? (target / s.batch_cycle_time) * 3600 : 450);
    const capUtil = capData?.utilisasi_kapasitas_pct ||
        ((effectiveCap / SPEC.theoreticalCapacityHour) * 100);
    setText("prodEffectiveCapacity", Math.round(effectiveCap));
    setText("prodCapacityUtil", `Utilisasi: ${Math.round(capUtil)}%`);
    setText("productionRate", `${Math.round(effectiveCap)} bph`);

    // OEE Cards
    setText("oeeScore", `${oeeCalc.oeePct}%`);
    setText("oeeAvailability", `${oeeCalc.availPct}%`);
    setText("oeePerformance", `${oeeCalc.perfPct}%`);
    setText("oeeQuality", `${oeeCalc.qualPct}%`);
    const oeeBadge = $("oeeScoreBadge");
    if (oeeBadge) {
        oeeBadge.textContent = oeeCalc.oeePct >= 85 ? "🌟 World Class (≥85%)" : oeeCalc.oeePct >= 60 ? "✓ Beroperasi Baik" : "⚠️ Perlu Perbaikan";
    }

    // Waktu Kumulatif
    setText("timePlanned", `${Math.round(oeeCalc.plannedTime)} s`);
    setText("timeOperating", `${Math.round(oeeCalc.operatingTime)} s`);
    setText("timeSetup", `${Math.round(oeeCalc.setupTime)} s`);
    setText("timeStarvation", `${Math.round(oeeCalc.starvationTime)} s`);
    setText("timePackaging", `${Math.round(oeeCalc.packagingTime)} s`);
    setText("timeDowntime", `${Math.round(oeeCalc.downtimeUnplanned)} s`);

    // Six Big Losses
    setText("lossBreakdown", `${Math.round(oeeCalc.lossBreakdownVal)} s`);
    setText("lossSetup", `${Math.round(oeeCalc.lossSetupVal)} s`);
    setText("lossStarvingPackaging", `${Math.round(oeeCalc.lossStarvingWaitVal)} s`);
    setText("lossSpeed", `${Math.round(oeeCalc.lossSpeedVal)} s`);
    setText("lossQuality", `${oeeCalc.lossQualityVal.toFixed(1)} s`);

    // Lead Time (MLT)
    const unitMlt = leadData?.unit_mlt_avg_detik || (s.actual_cycle_time_avg ? s.actual_cycle_time_avg * 6 : 28.1);
    const fillDur = leadData?.durasi_isi_avg_detik || 0.72;
    const batchMlt = leadData?.batch_mlt_avg_detik || s.batch_cycle_time || s.mlt_batch || 240.0;
    setText("mltUnitAvg", `${unitMlt.toFixed(1)} s`);
    setText("mltFillingAvg", `${fillDur.toFixed(2)} s`);
    setText("mltBatchAvg", `${Math.round(batchMlt)} s`);
    setText("mltBottlesCount", `${leadData?.total_botol_dianalisis || total} botol`);
}

function renderQualityAndSpc(s, qualData, sum, bottles) {
    const total = s.botol_selesai ?? (qualData?.total_botol ?? bottles.length);
    const good = s.botol_ok ?? (qualData?.botol_ok ?? bottles.filter(b => b.status === "OK" || b.level_isi >= SPEC.qcMinPassLevel).length);
    const bad = s.botol_reject ?? (qualData?.botol_reject ?? (total - good));
    const fpy = qualData?.first_pass_yield_pct ?? (s.first_pass_yield ?? (total > 0 ? (good / total) * 100 : 100));

    // Live Card Quality
    setText("qualityYield", fpy.toFixed(1));
    setText("rejectCount", `Reject: ${bad}`);
    setText("volumeTolerance", bad === 0 ? "QC 100% Lulus" : `${bad} botol cacat`);

    // Page Kualitas KPI
    setText("qualityPageYield", `${fpy.toFixed(1)}%`);
    setText("qualityGood", good);
    setText("qualityGoodPct", total > 0 ? `${Math.round((good / total) * 100)}% dari total` : "100%");
    setText("qualityReject", bad);
    setText("qualityRejectPct", total > 0 ? `${Math.round((bad / total) * 100)}% cacat` : "0%");

    // Pareto Defect
    const underfill = s.reject_isi_kurang ?? (qualData?.pareto_reject?.TIDAK_PENUH ?? 0);
    const noCap = s.reject_tanpa_tutup ?? (qualData?.pareto_reject?.TANPA_TUTUP ?? 0);
    setText("paretoUnderfillCount", `${underfill} unit`);
    setText("paretoNoCapCount", `${noCap} unit`);
    const underfillPct = bad > 0 ? Math.round((underfill / bad) * 100) : 0;
    const noCapPct = bad > 0 ? Math.round((noCap / bad) * 100) : 0;
    setWidth("paretoUnderfillProgress", underfillPct);
    setWidth("paretoNoCapProgress", noCapPct);
    setText("paretoUnderfillPct", `${underfillPct}% dari total reject`);
    setText("paretoNoCapPct", `${noCapPct}% dari total reject`);

    // SPC Level Isi
    const spc = qualData?.level_isi_stats;
    const mean = spc?.mean ?? (bottles.length ? bottles.reduce((acc, b) => acc + (b.level_isi || 0.95), 0) / bottles.length : 0.95);
    const std = spc?.std ?? 0.045;
    const min = spc?.min ?? 0.82;
    const max = spc?.max ?? 1.02;
    const ucl = spc?.ucl ?? (mean + 3 * std);
    const lcl = spc?.lcl ?? Math.max(0, mean - 3 * std);
    const belowSpec = spc?.jumlah_kurang_dari_batas ?? underfill;
    const totalLiquid = spc?.total_cairan ?? (good * 0.5);

    setText("qualityTotalLiquid", totalLiquid.toFixed(1));
    setText("spcMean", mean.toFixed(3));
    setText("spcStd", std.toFixed(4));
    setText("spcRange", `${min.toFixed(2)} – ${max.toFixed(2)}`);
    setText("spcUcl", ucl.toFixed(3));
    setText("spcLcl", lcl.toFixed(3));
    setText("spcBelowSpec", `${belowSpec} unit`);

    // Audit Defect Per Slot Turret (0..9)
    const slotGrid = $("slotAuditGrid");
    if (slotGrid) {
        slotGrid.replaceChildren();
        const slotCounts = Array(10).fill(0);
        bottles.forEach(b => {
            if (b.slot !== undefined && (b.status === "TIDAK_PENUH" || b.status === "TANPA_TUTUP" || b.level_isi < SPEC.qcMinPassLevel)) {
                slotCounts[b.slot] = (slotCounts[b.slot] || 0) + 1;
            }
        });
        for (let i = 0; i < 10; i++) {
            const div = document.createElement("div");
            div.className = "slot-box" + (slotCounts[i] > 0 ? " has-defect" : "");
            div.innerHTML = `<small>Slot ${i}</small><strong>${slotCounts[i]} NG</strong>`;
            slotGrid.appendChild(div);
        }
    }
}

function renderDowntimeAndReliability(s, relData, dt, events, oeeCalc) {
    const totalDowntimeSec = relData?.total_downtime_detik ?? (dt?.total_durasi_downtime_detik ?? s.downtime_unplanned ?? 0);
    const breakdownCount = relData?.jumlah_breakdown ?? (dt?.jumlah_kejadian_downtime ?? events.filter(e => e.jenis === "estop_tekan").length);
    const operatingTime = relData?.total_operating_time_detik ?? oeeCalc.operatingTime;

    // MTBF & MTTR: Saat nilai dari API null (tidak ada breakdown), tampilkan "--"
    let mtbfDisplay = "--";
    if (typeof relData?.mtbf_detik === "number") {
        mtbfDisplay = fmtDur(relData.mtbf_detik);
    } else if (relData?.mtbf_detik === null) {
        mtbfDisplay = "--";
    } else if (breakdownCount > 0 && operatingTime > 0) {
        mtbfDisplay = fmtDur(operatingTime / breakdownCount);
    }

    let mttrDisplay = "--";
    if (typeof relData?.mttr_detik === "number") {
        mttrDisplay = fmtDur(relData.mttr_detik);
    } else if (relData?.mttr_detik === null) {
        mttrDisplay = "--";
    } else if (breakdownCount > 0 && totalDowntimeSec > 0) {
        mttrDisplay = fmtDur(totalDowntimeSec / breakdownCount);
    }

    setText("totalDowntime", `Total Downtime: ${fmtDur(totalDowntimeSec)}`);
    setText("downtimeTotal", fmtDur(totalDowntimeSec));
    setText("downtimeMTBF", mtbfDisplay);
    setText("downtimeMTTR", mttrDisplay);
    setText("downtimeBreakdownCount", `${breakdownCount} kali`);

    const planned = oeeCalc.plannedTime || 240;
    const ratePct = planned > 0 ? Math.round((totalDowntimeSec / planned) * 100) : 0;
    setText("downtimeRate", `Rasio Downtime: ${ratePct}%`);

    // Kategori Downtime Resmi API
    const durPerCat = dt?.durasi_per_kategori || {};
    setText("catBreakdown", fmtDur(durPerCat.UNPLANNED_BREAKDOWN ?? totalDowntimeSec));
    setText("catSetup", fmtDur(durPerCat.PLANNED_SETUP ?? (s.setup_time || 15)));
    setText("catBlockedBin", fmtDur(durPerCat.BLOCKED_FULL_BIN ?? 0));
    setText("catPowerOff", fmtDur(durPerCat.POWER_OFF ?? 0));
    setText("catNormalRun", fmtDur(durPerCat.NORMAL_RUN ?? operatingTime));
}

function renderInventory(s, invData) {
    const rackRemain = invData?.sisa_stok_rak_atas ?? (s.sisa_stok_rak_atas ?? 12);
    const rackCap = invData?.kapasitas_stok_rak_atas ?? (s.kapasitas_stok_rak_atas ?? 100);
    const restockCount = invData?.jumlah_restock ?? (s.jumlah_restock ?? 0);
    const autoReplenish = invData?.jumlah_auto_replenish_rak ?? (s.jumlah_auto_replenish_rak ?? 0);
    const infeedRemain = s.sisa_peti ?? 0;

    setText("invRackRemaining", rackRemain);
    setText("invRackCapacity", rackCap);
    const rackPct = Math.round((rackRemain / rackCap) * 100);
    setText("invRackPercentage", `${rackPct}% Kapasitas`);
    setText("invInfeedRemaining", infeedRemain);
    setText("invAutoReplenishCount", autoReplenish);
    setText("invRestockCount", restockCount);

    const needRestock = invData?.butuh_restock ?? (rackRemain <= 2);
    const alertPill = $("invRackAlertPill");
    if (alertPill) {
        alertPill.textContent = needRestock ? "Perlu Restock" : "Aman";
        alertPill.className = "pill " + (needRestock ? "danger" : "ok");
    }

    setText("invRackBarVal", `${rackPct}%`);
    setWidth("invRackProgress", rackPct);

    // Konsumsi Bahan
    const bottlesUsed = (s.botol_selesai || 0) + (s.wip_turret || 0);
    const capsUsed = bottlesUsed - (s.reject_tanpa_tutup || 0);
    const liquidUsed = ((s.botol_ok || 0) * 0.5).toFixed(1);

    setText("invBottlesUsed", bottlesUsed);
    setText("invCapsUsed", capsUsed);
    setText("invLiquidUsed", liquidUsed);
}

function renderBatchHistory(batchList) {
    allBatches = batchList;
    const body = $("batchHistoryTable");
    if (!body) return;
    body.replaceChildren();

    if (!batchList.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="11" style="text-align:center">Belum ada arsip batch permanen. Batch disimpan setelah pengemasan selesai.</td>`;
        body.appendChild(tr);
        return;
    }

    batchList.forEach(b => {
        const tr = document.createElement("tr");
        const bKe = b.batch_ke || 1;
        tr.innerHTML = `
            <td><b>#${bKe}</b></td>
            <td>${fmtTime(b.waktu_selesai || b.waktu_mulai)}</td>
            <td>${b.target_qty || 30} / ${b.botol_selesai || 0}</td>
            <td><span style="color:${GREEN}">${b.botol_ok || 0} OK</span> / <span style="color:${RED}">${b.botol_reject || 0} NG</span></td>
            <td><b>${(b.oee_pct || 0).toFixed(1)}%</b></td>
            <td>${(b.availability_pct || 0).toFixed(1)}%</td>
            <td>${(b.performance_pct || 0).toFixed(1)}%</td>
            <td>${(b.quality_pct || 0).toFixed(1)}%</td>
            <td>${Math.round(b.mlt_batch || 240)} s</td>
            <td>${Math.round(b.effective_capacity_per_hour || 450)} bph</td>
            <td><button class="btn-sm" onclick="showBatchDetail(${bKe})">Detail</button></td>
        `;
        body.appendChild(tr);
    });
}

function renderReportPage(d, oeeCalc) {
    const s = d.status || {};
    const lp = d.laporan || {};
    const sum = d.summary || {};

    latestLaporan = lp;
    latestSummary = sum;

    // Prioritaskan nilai resmi dari endpoint /api/mesin/{id}/laporan
    const oeeVal = lp.oee_pct ?? lp.oee?.oee_pct ?? lp.oee ?? oeeCalc.oeePct;
    const total = lp.total_botol ?? lp.produksi?.total_botol ?? lp.jumlah_botol ?? sum.jumlah_botol ?? oeeCalc.botolSelesai;
    const qualVal = lp.first_pass_yield_pct ?? lp.kualitas?.first_pass_yield_pct ?? lp.yield_pct ?? oeeCalc.qualPct;
    const dur = lp.total_downtime_detik ?? lp.downtime?.total_durasi_detik ?? lp.durasi_downtime_detik ?? oeeCalc.downtimeUnplanned;

    setText("reportOee", typeof oeeVal === "number" ? `${oeeVal.toFixed(1)}%` : `${oeeVal}%`);
    setText("reportProduction", `${total} botol`);
    setText("reportQuality", typeof qualVal === "number" ? `${qualVal.toFixed(1)}%` : `${qualVal}%`);
    setText("reportDowntime", fmtDur(dur));

    // Tampilkan pratinjau tabel Excel murni tanpa CSS di halaman
    const previewContainer = $("excelPreviewContainer");
    if (previewContainer) {
        previewContainer.innerHTML = generateReportPureTableHtml();
    }
}

/* =========================================================================
   FUNGSI EKSPOR TABEL EXCEL (.XLS) & CSV MURNI TANPA CSS SEDIKITPUN
========================================================================= */

function generateReportPureTableHtml() {
    const s = latestStatus || {};
    const o = latestOeeCalc || {};
    const lp = latestLaporan || {};
    const dt = latestDowntime || {};
    const batches = allBatches || [];

    const oeeVal = lp.oee_pct ?? lp.oee?.oee_pct ?? o.oeePct ?? 0;
    const availVal = lp.availability_pct ?? lp.oee?.availability_pct ?? o.availPct ?? 0;
    const perfVal = lp.performance_pct ?? lp.oee?.performance_pct ?? o.perfPct ?? 0;
    const qualVal = lp.quality_pct ?? lp.first_pass_yield_pct ?? o.qualPct ?? 0;
    const totalProd = lp.total_botol ?? o.botolSelesai ?? 0;
    const goodProd = lp.botol_ok ?? o.botolOk ?? 0;
    const badProd = lp.botol_reject ?? o.botolReject ?? 0;
    const downSec = lp.total_downtime_detik ?? o.downtimeUnplanned ?? 0;

    let html = "<table border=\"1\">\n";

    // Header Laporan
    html += "<tr><th colspan=\"4\">LAPORAN RESMI PRODUKSI DAN KPI MESIN ROTARY FILLING</th></tr>\n";
    html += `<tr><th>Mesin ID</th><td>${machineId}</td><th>Waktu Ekspor</th><td>${new Date().toLocaleString("id-ID")}</td></tr>\n`;
    html += `<tr><th>Sesi ID</th><td>${s.sesi_id || "--"}</td><th>Operator</th><td>${s.pengguna || "Operator"}</td></tr>\n`;
    html += `<tr><th>Mode Operasi</th><td>${s.mode || "Standby"}</td><th>Batch Aktif</th><td>Batch #${s.batch_ke || 1}</td></tr>\n`;
    html += "<tr><td colspan=\"4\"></td></tr>\n";

    // Ringkasan KPI Utama
    html += "<tr><th colspan=\"4\">RINGKASAN METRIK UTAMA (OEE DAN PRODUKSI)</th></tr>\n";
    html += "<tr><th>Indikator</th><th>Nilai</th><th>Target / Standar</th><th>Status Evaluasi</th></tr>\n";
    html += `<tr><td>Overall Equipment Effectiveness (OEE)</td><td>${oeeVal}%</td><td>&gt;= 85.0% (World Class)</td><td>${oeeVal >= 85 ? "LULUS" : "PERLU PERBAIKAN"}</td></tr>\n`;
    html += `<tr><td>Availability (Ketersediaan)</td><td>${availVal}%</td><td>&gt;= 90.0%</td><td>${availVal >= 90 ? "LULUS" : "PERIKSA DOWNTIME"}</td></tr>\n`;
    html += `<tr><td>Performance (Kinerja Mesin)</td><td>${perfVal}%</td><td>&gt;= 95.0%</td><td>${perfVal >= 95 ? "LULUS" : "PERIKSA CYCLE TIME"}</td></tr>\n`;
    html += `<tr><td>Quality (First Pass Yield)</td><td>${qualVal}%</td><td>&gt;= 99.0%</td><td>${qualVal >= 99 ? "LULUS" : "PERIKSA REJECT"}</td></tr>\n`;
    html += `<tr><td>Total Botol Selesai</td><td>${totalProd} unit</td><td>${s.target_qty || SPEC.defaultTarget} unit</td><td>Pencapaian: ${pct(totalProd, s.target_qty || SPEC.defaultTarget)}%</td></tr>\n`;
    html += `<tr><td>Botol Lulus QC (OK)</td><td>${goodProd} unit</td><td>-</td><td>-</td></tr>\n`;
    html += `<tr><td>Botol Cacat (Reject / NG)</td><td>${badProd} unit</td><td>0 unit (Zero Defect)</td><td>${badProd === 0 ? "SEMPURNA" : "CACAT"}</td></tr>\n`;
    html += `<tr><td>Total Waktu Downtime</td><td>${downSec} detik</td><td>0 detik</td><td>${fmtDur(downSec)}</td></tr>\n`;
    html += "<tr><td colspan=\"4\"></td></tr>\n";

    // Six Big Losses & Waktu
    html += "<tr><th colspan=\"4\">RINCIAN SIX BIG LOSSES DAN WAKTU (DETIK)</th></tr>\n";
    html += "<tr><th>Komponen Six Big Losses</th><th>Durasi (Detik)</th><th>Kategori Standar</th><th>Klasifikasi Dampak</th></tr>\n";
    html += `<tr><td>1. Unplanned Equipment Failure (Breakdown)</td><td>${Math.round(o.lossBreakdownVal || 0)}</td><td>Availability Loss</td><td>Downtime Tak Terencana</td></tr>\n`;
    html += `<tr><td>2. Setup and Adjustment</td><td>${Math.round(o.lossSetupVal || 0)}</td><td>Availability Loss</td><td>Persiapan Awal Batch / Rak</td></tr>\n`;
    html += `<tr><td>3. Idling &amp; Minor Stoppage (Starvation / Wait)</td><td>${Math.round(o.lossStarvingWaitVal || 0)}</td><td>Availability Loss</td><td>Menunggu Botol / Packaging Kardus</td></tr>\n`;
    html += `<tr><td>4. Reduced Speed (Speed Loss)</td><td>${Math.round(o.lossSpeedVal || 0)}</td><td>Performance Loss</td><td>Deviasi Cycle Time Aktual vs 4.1s</td></tr>\n`;
    html += `<tr><td>5. Process Defects (Quality Defects)</td><td>${Number((o.lossQualityVal || 0).toFixed(1))}</td><td>Quality Loss</td><td>Waktu Terbuang Produk Cacat</td></tr>\n`;
    html += `<tr><td>Waktu Operasi Bersih (Operating Time)</td><td>${Math.round(o.operatingTime || 0)}</td><td>-</td><td>Waktu Mesin Berputar Efektif</td></tr>\n`;
    html += `<tr><td>Waktu Terencana (Planned Production Time)</td><td>${Math.round(o.plannedTime || 0)}</td><td>-</td><td>Total Waktu Siklus Sesi</td></tr>\n`;
    html += "<tr><td colspan=\"4\"></td></tr>\n";

    // Arsip Batch
    if (batches.length) {
        html += "<tr><th colspan=\"4\">ARSIP RIWAYAT BATCH</th></tr>\n";
        html += "<tr><th>Batch #</th><th>Waktu</th><th>Output (OK / NG)</th><th>Skor OEE</th></tr>\n";
        batches.forEach(b => {
            html += `<tr><td>Batch #${b.batch_ke || 1}</td><td>${fmtTime(b.waktu_selesai || b.waktu_mulai)}</td><td>${b.botol_ok || 0} OK / ${b.botol_reject || 0} NG</td><td>${(b.oee_pct || 0).toFixed(1)}%</td></tr>\n`;
        });
        html += "<tr><td colspan=\"4\"></td></tr>\n";
    }

    // Riwayat Downtime
    const dtEvents = (dt && Array.isArray(dt.kejadian) && dt.kejadian.length) ? dt.kejadian : [];
    if (dtEvents.length) {
        html += "<tr><th colspan=\"4\">RIWAYAT KEJADIAN DOWNTIME</th></tr>\n";
        html += "<tr><th>Waktu</th><th>Durasi (Detik)</th><th>Kategori</th><th>Penyebab / Pesan</th></tr>\n";
        dtEvents.forEach(k => {
            html += `<tr><td>${fmtTime(k.waktu_mulai || k.waktu)}</td><td>${k.durasi_detik ?? "--"}</td><td>${k.kategori || k.kategori_downtime || "BREAKDOWN"}</td><td>${k.penyebab || k.pesan || k.keterangan || "-"}</td></tr>\n`;
        });
    }

    html += "</table>";
    return html;
}

function exportReportToExcel() {
    const tableHtml = generateReportPureTableHtml();
    // Dokumen XML/HTML standar Excel tanpa CSS sedikitpun
    const excelDoc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8">
<!--[if gte mso 9]>
<xml>
  <x:ExcelWorkbook>
    <x:ExcelWorksheets>
      <x:ExcelWorksheet>
        <x:Name>Laporan MES MPB-01</x:Name>
        <x:WorksheetOptions>
          <x:DisplayGridlines/>
        </x:WorksheetOptions>
      </x:ExcelWorksheet>
    </x:ExcelWorksheets>
  </x:ExcelWorkbook>
</xml>
<![endif]-->
</head>
<body>
${tableHtml}
</body>
</html>`;

    const blob = new Blob([excelDoc], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `Laporan_MES_${machineId}_${dateStr}.xls`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function setConnectionStatus(apiOk, dbOk, ms, machineOnline, healthText) {
    const badge = $("apiConnection");
    if (badge) {
        badge.textContent = apiOk && dbOk ? "● LIVE" : "● OFFLINE";
        badge.style.color = apiOk && dbOk ? GREEN : RED;
    }

    const currentUrl = apiBase || REMOTE_API;
    setText("apiSettingUrl", currentUrl);
    setText("apiSettingStatus", apiOk ? `Terhubung · ${ms} ms (${currentUrl})` : healthText || "Terputus");
    setText("databaseSettingStatus", apiOk ? (dbOk ? "Terhubung (MongoDB OK)" : "Database Terputus") : "--");
    setText("apiLatency", apiOk ? ms + " ms" : "--");
    setText("plcStatus", !apiOk ? "API Terputus" : machineOnline ? "Mesin Terhubung" : "Mesin Standby");
    try {
        setText("plcAddress", new URL(currentUrl).host);
    } catch (e) {
        setText("plcAddress", currentUrl);
    }

    const dot = $("plcIndicator");
    if (dot) dot.style.background = machineOnline ? GREEN : (apiOk ? ORANGE : RED);
    setText("lastUpdated", new Date().toLocaleTimeString("en-GB"));
}


/* =================================
   7. ORKESTRASI POLLING TERPISAH (LIVE VS ANALITIK)
================================= */

// 7a. Polling Live Telemetri (Ringan, tiap 3 detik)
async function refreshLive(force = false) {
    if (isRefreshingLive && !force) return;
    isRefreshingLive = true;

    try {
        let health;
        try {
            health = await getHealth();
        } catch (err) {
            setConnectionStatus(false, false, 0, false, IS_LOCAL
                ? "API lokal dev_server.py tidak terjangkau."
                : "Koneksi ke backend API gagal.");
            return;
        }

        const id = encodeURIComponent(machineId);
        if (!cfg) {
            try { cfg = (await api(`/mesin/${id}`)).data || {}; } catch (err) { cfg = {}; }
        }

        // Ambil status live dan WIP buffer
        const [stRes, wpRes] = await Promise.allSettled([
            api(`/mesin/${id}/status`),
            api(`/mesin/${id}/wip`, { sesi_id: latestStatus?.sesi_id })
        ]);

        const status = stRes.status === "fulfilled" ? unwrapObject(stRes.value.data) : latestStatus;
        const wipData = wpRes.status === "fulfilled" ? unwrapObject(wpRes.value.data) : null;
        latestStatus = status;

        const s = status || {};
        const hasData = !!status;
        const lastMs = parseUTC(s.diterima || s.waktu);
        const online = hasData && lastMs !== null && Date.now() - lastMs < STALE_MS;

        // Render komponen Live
        renderMachineHeader(s, online, hasData, lastMs);
        renderTurretVisual(s, hasData);
        renderWipAndBuffers(s, wipData);

        // Perbarui Timeline Bar jika OEE calc sudah ada
        if (latestOeeCalc) {
            const runPct = latestOeeCalc.operatingTime > 0 ? pct(latestOeeCalc.operatingTime, latestOeeCalc.plannedTime) : 0;
            const downPct = latestOeeCalc.downtimeUnplanned > 0 ? pct(latestOeeCalc.downtimeUnplanned, latestOeeCalc.plannedTime) : 0;
            const warnPct = Math.max(0, 100 - (runPct + downPct));
            setWidth("runningBar", runPct);
            setWidth("warningBar", warnPct);
            setWidth("downtimeBar", downPct);
            setText("runningPercentage", `🟢 Berjalan (${runPct}%)`);
            setText("warningPercentage", `🟠 Peringatan / Idle (${warnPct}%)`);
            setText("downtimePercentage", `🔴 Downtime (${downPct}%)`);
        }

        const dbText = health?.data?.database;
        const dbOk = /ok|connect|terhubung|sehat|up/i.test(String(dbText));
        setConnectionStatus(true, dbOk, health.ms, online, dbText);

    } catch (err) {
        console.error("Error pada refreshLive:", err);
    } finally {
        isRefreshingLive = false;
    }
}

// 7b. Polling Analitik (Berat, tiap 30 detik atau on-demand)
async function refreshAnalytics(silent = false, force = false) {
    if (isRefreshingAnalytics && !force) return;
    isRefreshingAnalytics = true;

    try {
        const id = encodeURIComponent(machineId);
        const q = { sesi_id: latestStatus && latestStatus.sesi_id };

        const [
            oeeRes,
            leadRes,
            capRes,
            qualRes,
            invRes,
            relRes,
            batchRes,
            sumRes,
            evRes,
            btRes,
            dtRes,
            lpRes
        ] = await Promise.allSettled([
            api(`/mesin/${id}/oee`, q),
            api(`/mesin/${id}/lead-time`, q),
            api(`/mesin/${id}/kapasitas`, q),
            api(`/mesin/${id}/kualitas`, q),
            api(`/mesin/${id}/inventori`, q),
            api(`/mesin/${id}/reliability`, q),
            api(`/mesin/${id}/batch`, { limit: 100, wrap: true }),
            api(`/mesin/${id}/ringkasan`, q),
            api(`/mesin/${id}/event`, { ...q, limit: 100, wrap: true }),
            api(`/mesin/${id}/botol`, { ...q, limit: 50, wrap: true }),
            api(`/mesin/${id}/downtime`, q),
            api(`/mesin/${id}/laporan`, q)
        ]);

        const val = r => (r.status === "fulfilled" ? r.value.data : null);

        const s = latestStatus || {};
        const oeeData = val(oeeRes);
        const leadData = val(leadRes);
        const capData = val(capRes);
        const qualData = val(qualRes);
        const invData = val(invRes);
        const relData = val(relRes);
        const batchList = unwrapList(val(batchRes));
        const summary = val(sumRes);
        const events = unwrapList(val(evRes));
        const bottles = unwrapList(val(btRes));
        const downtime = val(dtRes);
        const laporan = val(lpRes);

        lastBottles = bottles;
        latestLaporan = laporan;
        latestDowntime = downtime;

        // Hitung dan render OEE & Six Big Losses
        const oeeCalc = calculateOeeAndLosses(s, oeeData, summary, downtime);
        latestOeeCalc = oeeCalc;
        renderProductionAndOee(s, oeeCalc, capData, leadData);

        // Kualitas & SPC
        renderQualityAndSpc(s, qualData, summary, bottles);

        // Downtime & Reliability
        renderDowntimeAndReliability(s, relData, downtime, events, oeeCalc);

        // Inventori
        renderInventory(s, invData);

        // Tabel Event 5 Kolom: WAKTU, JENIS EVENT, SUMBER, KATEGORI, KETERANGAN
        fillTable("eventTable", events.slice(0, 8).map(eventRowTable), 5, "Belum ada event.");
        setText("eventInfo", `${Math.min(events.length, 8)} dari ${events.length} event tersimpan.`);

        // Tabel Downtime dari downtime.kejadian[]
        const downtimeEvents = (downtime && Array.isArray(downtime.kejadian) && downtime.kejadian.length)
            ? downtime.kejadian
            : events.filter(e => e.kategori_downtime && e.kategori_downtime !== "NORMAL_RUN");
        fillTable("downtimeTable", downtimeEvents.slice(0, 50).map(downtimeRowTable), 5, "Belum ada riwayat downtime.");

        // Tabel Botol
        fillTable("bottleTable", bottles.slice(0, 10).map(bottleRowLive), 5, "Belum ada data botol.");
        setText("bottleInfo", `${Math.min(bottles.length, 10)} botol terakhir sesi ini`);
        fillTable("qualityTable", bottles.slice(0, 30).map(qualityRowTable), 8, "Belum ada data botol.");

        // Update Traceability jika user tidak sedang mencari
        if (!$("traceSearch")?.value.trim()) {
            fillTable("traceTable", bottles.map(qualityRowTable), 8, "Belum ada data botol.");
        }

        // Arsip Batch & Laporan Resmi
        renderBatchHistory(batchList);
        renderReportPage({ status: s, summary, laporan }, oeeCalc);

        if (!silent) console.log("Data analitik MES berhasil diperbarui.");

    } catch (err) {
        console.error("Error pada refreshAnalytics:", err);
    } finally {
        isRefreshingAnalytics = false;
    }
}

// Rekursif timer untuk mencegah request stacking
function scheduleLive() {
    clearTimeout(liveTimer);
    refreshLive().finally(() => {
        liveTimer = setTimeout(scheduleLive, POLL_LIVE_MS);
    });
}

function scheduleAnalytics() {
    clearTimeout(analyticsTimer);
    refreshAnalytics().finally(() => {
        analyticsTimer = setTimeout(scheduleAnalytics, POLL_ANALYTICS_MS);
    });
}

async function refreshAll(force = true) {
    const btn = $("topRefreshBtn");
    if (btn) btn.classList.add("spinning");
    clearTimeout(liveTimer);
    clearTimeout(analyticsTimer);
    isRefreshingLive = false;
    isRefreshingAnalytics = false;
    try {
        await Promise.allSettled([
            refreshLive(true),
            refreshAnalytics(false, true)
        ]);
    } catch (err) {
        console.error("Gagal menyegarkan data:", err);
    } finally {
        if (btn) {
            setTimeout(() => btn.classList.remove("spinning"), 600);
        }
        scheduleLive();
        scheduleAnalytics();
    }
}

function updateDate() {
    setText("currentDate", "▣ " + new Date().toLocaleDateString("id-ID", {
        day: "numeric", month: "short", year: "numeric"
    }));
}


/* =================================
   8. INISIALISASI DASHBOARD
================================= */

function init() {
    updateDate();
    updateApiKeyStatusPill();

    // Isi input di settings jika sudah tersimpan
    const apiKeyInput = $("apiKeyInput");
    if (apiKeyInput && apiKey) apiKeyInput.value = apiKey;
    const apiBaseInput = $("apiBaseInput");
    if (apiBaseInput && apiBase) apiBaseInput.value = apiBase;

    // Listener tombol refresh di bar atas
    $("topRefreshBtn")?.addEventListener("click", () => refreshAll(true));

    // Ambil daftar mesin & mulai polling terpisah
    fetchMachineList().finally(() => {
        scheduleLive();
        scheduleAnalytics();
    });

    console.log("MPB-01 MES Dashboard dimuat. Base API:", apiBase || REMOTE_API, "Mesin:", machineId);
}

// Jalankan inisialisasi saat DOM siap
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
