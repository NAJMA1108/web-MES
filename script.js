/* =========================================================================
   MPB-01 MES DASHBOARD JAVASCRIPT
   Sesuai Spesifikasi API Key & Perhitungan Monitoring Web MES
   (OEE, MLT, WIP, Cycle Time, Kapasitas, Kualitas/SPC, Inventori, Reliabilitas)
========================================================================= */

/* =================================
   0. KONFIGURASI API & KONSTANTA
================================= */

const REMOTE_API = "https://filling-machine-api.zamazzam.me";
const MACHINE_ID = window.MES_MACHINE_ID || "mesin-01";
const API_KEY = window.MES_API_KEY || "";
const POLL_MS = 3000;
const STALE_MS = 30000;

// Kandidat host API yang akan dites secara otomatis
let apiBase = window.MES_API_BASE || null;
let apiPrefix = window.MES_API_PREFIX || null;

const CANDIDATE_BASES = [
    window.MES_API_BASE,
    location.origin,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://filling-machine-api.zamazzam.me",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
].filter(Boolean);

// Spesifikasi Kapasitas Mesin (Halaman 4 & 7 PDF)
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

let cfg = null;
let lastBottles = [];
let allBatches = [];
let traceTimer = null;

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
    sec = Math.round(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}j ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

async function api(path, query) {
    if (!apiBase) await getHealth();
    const url = new URL((apiBase || REMOTE_API) + (apiPrefix || "/api") + path);
    Object.entries(query || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v); });
    const t0 = performance.now();
    const res = await fetch(url, API_KEY ? { headers: { "X-Api-Key": API_KEY } } : undefined);
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
                const url = new URL(apiBase + prefix + "/health");
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
    if (Array.isArray(body)) return body[0] || null;
    for (const key of ["data", "telemetri", "item"]) {
        const v = body && body[key];
        if (v && typeof v === "object") return Array.isArray(v) ? v[0] || null : v;
    }
    return body;
}

function unwrapList(body) {
    if (Array.isArray(body)) return body;
    for (const key of ["data", "items", "botol", "event", "events", "hasil", "kejadian"]) {
        if (body && Array.isArray(body[key])) return body[key];
    }
    return [];
}


/* =================================
   1. NAVIGASI HALAMAN & SIDEBAR
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
    });
});

function toggleTheme() {
    document.body.classList.toggle("dark-mode");
    const isDark = document.body.classList.contains("dark-mode");
    $("themeToggle").textContent = isDark ? "☾" : "☼";
}
$("themeToggle")?.addEventListener("click", toggleTheme);

function inchTurret() {
    alert("Inching Turret: Mengirim sinyal langkah stepper manual (Khusus Kontrol Operator).");
}

function resetTurret() {
    alert("Reset Posisi Nol: Mengembalikan Homing Index Turret ke Slot 01.");
}


/* =================================
   2. PEMFORMAT DATA TABEL & BARIS
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

const eventRowTable = e => [
    fmtTime(e.waktu),
    e.jenis || "-",
    e.sumber || "sistem",
    e.kategori_downtime || (e.jenis === "estop_tekan" ? "UNPLANNED_BREAKDOWN" : "NORMAL_RUN"),
    [e.pesan, e.mode_sebelum && e.mode_sesudah ? `${e.mode_sebelum} → ${e.mode_sesudah}` : ""]
        .filter(Boolean).join(" · ") || e.pengguna || "-"
];

function fillTable(id, rows, cols, emptyText) {
    const body = $(id);
    if (!body) return;
    body.replaceChildren();

    if (!rows.length) {
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
            if (text === "OK" || text === "✓ Tertutup") {
                td.style.color = GREEN;
                td.style.fontWeight = "600";
            } else if (text === "TIDAK_PENUH" || text === "TANPA_TUTUP" || text === "✗ Terbuka" || text.includes("BREAKDOWN") || text.includes("estop_tekan")) {
                td.style.color = RED;
                td.style.fontWeight = "600";
            }
            tr.appendChild(td);
        });
        body.appendChild(tr);
    });
}


/* =================================
   3. PENCARIAN TRACEABILITY BOTOL
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
    // Coba temukan di data lokal dulu
    const localMatch = lastBottles.find(b => Number(b.nomor || b.nomor_botol) === num);

    try {
        let bottle = localMatch;
        let list = [];
        if (!bottle) {
            const res = await api(`/mesin/${encodeURIComponent(MACHINE_ID)}/botol`, { nomor: String(num) });
            list = unwrapList(res.data);
            bottle = list[0];
        } else {
            list = [bottle];
        }

        if (bottle) {
            fillTable("traceTable", list.map(qualityRowTable), 8, "");
            setText("traceInfo", `Ditemukan data spesifik botol #${String(num).padStart(5, "0")}.`);

            // Tampilkan Detail Card
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
                    statusEl.textContent = bottle.status || (bottle.level_isi >= SPEC.qcMinPassLevel ? "OK" : "TIDAK_PENUH");
                    statusEl.className = "pill " + (bottle.status === "OK" || bottle.level_isi >= SPEC.qcMinPassLevel ? "ok" : "danger");
                }
            }
        } else {
            if (card) card.style.display = "none";
            fillTable("traceTable", [], 8, `Botol #${num} tidak ditemukan di database.`);
            setText("traceInfo", `Tidak ada data botol dengan nomor #${num}.`);
        }
    } catch (err) {
        if (card) card.style.display = "none";
        setText("traceInfo", "Gagal menghubungi database botol: " + err.message);
    }
}

$("bottleSearch")?.addEventListener("input", searchBottleLive);
$("traceSearch")?.addEventListener("input", () => {
    clearTimeout(traceTimer);
    traceTimer = setTimeout(searchTrace, 350);
});


/* =================================
   4. LOGIKA PERHITUNGAN MES & RENDER
================================= */

function renderMachineHeader(s, online, hasData, lastMs) {
    const mode = s.darurat ? "Darurat" : s.mode || "Mati";
    const sesi = s.sesi_id ? String(s.sesi_id) : "--";
    const batch = s.batch_ke || 1;
    const operatorMode = s.operator_mode || "Operasi";
    const qcLast = s.status_qc_terakhir || (s.botol_reject > 0 ? "REJECT" : "OK");

    setText("machineName", (cfg?.nama || cfg?.name || "ROTARY FILLING MPB-01").toUpperCase());
    setText("operatorName", s.pengguna || "Operator");
    setText("operatorShift", `SESI: ${sesi.slice(0, 14)}`);
    setText("shiftInfo", `◷ Sesi: ${sesi.slice(0, 18)}`);
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
        // Bila ada WIP di turret, tandai slot terisi
        const wipInTurret = s.wip_turret || 0;
        el.classList.toggle("filled", i <= wipInTurret);
    }
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

    // Production time: waktu efektif turret berjalan
    let operatingTime = s.production_time;
    if (operatingTime === undefined || operatingTime === null || operatingTime <= 0) {
        operatingTime = Math.max(0, plannedTime - (downtimeUnplanned + setupTime + starvationTime + packagingTime));
    }

    // Availability = operating_time / planned_production_time
    let availPct = oeeData?.availability_pct ?? (plannedTime > 0 ? (operatingTime / plannedTime) * 100 : 0);
    // Performance = (ideal_cycle_time * botol_selesai) / operating_time
    let perfPct = oeeData?.performance_pct ?? (operatingTime > 0 ? ((SPEC.idealCycleTime * botolSelesai) / operatingTime) * 100 : 0);
    // Quality = botol_ok / botol_selesai
    let qualPct = oeeData?.quality_pct ?? (s.first_pass_yield ?? (botolSelesai > 0 ? (botolOk / botolSelesai) * 100 : 100));

    // OEE = A * P * Q
    let oeePct = oeeData?.oee_pct ?? ((availPct / 100) * (perfPct / 100) * (qualPct / 100) * 100);

    // Batasi maksimum rasional
    availPct = Math.min(100, Math.max(0, availPct));
    perfPct = Math.min(120, Math.max(0, perfPct));
    qualPct = Math.min(100, Math.max(0, qualPct));
    oeePct = Math.min(100, Math.max(0, oeePct));

    // Six Big Losses
    const lossBreakdownVal = downtimeUnplanned;
    const lossSetupVal = setupTime;
    const lossStarvingWaitVal = starvationTime + packagingTime;
    const lossSpeedVal = Math.max(0, operatingTime - (SPEC.idealCycleTime * botolSelesai));
    const lossQualityVal = botolReject * SPEC.idealCycleTime;

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

    const mtbf = relData?.mtbf_detik ?? (breakdownCount > 0 ? operatingTime / breakdownCount : operatingTime);
    const mttr = relData?.mttr_detik ?? (breakdownCount > 0 ? totalDowntimeSec / breakdownCount : totalDowntimeSec);

    setText("totalDowntime", `Total Downtime: ${fmtDur(totalDowntimeSec)}`);
    setText("downtimeTotal", fmtDur(totalDowntimeSec));
    setText("downtimeMTBF", fmtDur(mtbf));
    setText("downtimeMTTR", fmtDur(mttr));
    setText("downtimeBreakdownCount", `${breakdownCount} kali`);

    const planned = oeeCalc.plannedTime || 240;
    const ratePct = planned > 0 ? Math.round((totalDowntimeSec / planned) * 100) : 0;
    setText("downtimeRate", `Rasio Downtime: ${ratePct}%`);

    // Kategori Downtime
    setText("catBreakdown", `${Math.round(totalDowntimeSec)} s`);
    setText("catSetup", `${Math.round(s.setup_time || 15)} s`);
    setText("catBlockedBin", "0 s");
    setText("catStarvation", `${Math.round(s.starvation_downtime || 5)} s`);
    setText("catPackaging", `${Math.round(s.packaging_time || 50)} s`);
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
        tr.innerHTML = `<td colspan="10" style="text-align:center">Belum ada arsip batch permanen. Batch disimpan setelah pengemasan selesai.</td>`;
        body.appendChild(tr);
        return;
    }

    batchList.forEach(b => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><b>#${b.batch_ke || 1}</b></td>
            <td>${fmtTime(b.waktu_selesai || b.waktu_mulai)}</td>
            <td>${b.target_qty || 30} / ${b.botol_selesai || 0}</td>
            <td><span style="color:${GREEN}">${b.botol_ok || 0} OK</span> / <span style="color:${RED}">${b.botol_reject || 0} NG</span></td>
            <td><b>${(b.oee_pct || 0).toFixed(1)}%</b></td>
            <td>${(b.availability_pct || 0).toFixed(1)}%</td>
            <td>${(b.performance_pct || 0).toFixed(1)}%</td>
            <td>${(b.quality_pct || 0).toFixed(1)}%</td>
            <td>${Math.round(b.mlt_batch || 240)} s</td>
            <td>${Math.round(b.effective_capacity_per_hour || 450)} bph</td>
        `;
        body.appendChild(tr);
    });
}

function renderReportPage(d, oeeCalc) {
    const s = d.status || {};
    const total = oeeCalc.botolSelesai;
    const good = oeeCalc.botolOk;
    const bad = oeeCalc.botolReject;
    const dur = oeeCalc.downtimeUnplanned;

    setText("reportOee", `${oeeCalc.oeePct}%`);
    setText("reportProduction", `${total} botol`);
    setText("reportQuality", `${oeeCalc.qualPct}%`);
    setText("reportDowntime", fmtDur(dur));

    setText("reportDescription",
        `Laporan Resmi Mesin MPB-01 · Sesi: ${s.sesi_id || "--"} · Operator: ${s.pengguna || "--"}. ` +
        `Dari ${total} botol produksi, diperoleh OEE ${oeeCalc.oeePct}% (Availability: ${oeeCalc.availPct}%, ` +
        `Performance: ${oeeCalc.perfPct}%, Quality: ${oeeCalc.qualPct}%). Total Downtime: ${fmtDur(dur)}.`);
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
    setText("plcStatus", !apiOk ? "API tidak terhubung" : machineOnline ? "Mesin terhubung" : "Mesin standby (menunggu telemetri)");
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
   5. POLLING & ORKESTRASI REFRESH
================================= */

async function refresh() {
    let health;
    try {
        health = await getHealth();
    } catch (err) {
        setConnectionStatus(false, false, 0, false, IS_LOCAL
            ? "API lokal dev_server.py tidak terjangkau."
            : "Koneksi ke backend API gagal.");
        return;
    }

    const id = encodeURIComponent(MACHINE_ID);
    if (!cfg) {
        try { cfg = (await api(`/mesin/${id}`)).data || {}; } catch (err) { cfg = {}; }
    }

    let status = null;
    try {
        status = unwrapObject((await api(`/mesin/${id}/status`)).data);
    } catch (err) { /* status tetap null bila belum ada data */ }

    const q = { sesi_id: status && status.sesi_id };

    // Panggil semua modul spesifikasi secara paralel
    const [
        oeeRes,
        wipRes,
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
        api(`/mesin/${id}/wip`, q),
        api(`/mesin/${id}/lead-time`, q),
        api(`/mesin/${id}/kapasitas`, q),
        api(`/mesin/${id}/kualitas`, q),
        api(`/mesin/${id}/inventori`, q),
        api(`/mesin/${id}/reliability`, q),
        api(`/mesin/${id}/batch`),
        api(`/mesin/${id}/ringkasan`, q),
        api(`/mesin/${id}/event`, { ...q, limit: 100 }),
        api(`/mesin/${id}/botol`, { ...q, limit: 50 }),
        api(`/mesin/${id}/downtime`, q),
        api(`/mesin/${id}/laporan`, q),
    ]);

    const val = r => (r.status === "fulfilled" ? r.value.data : null);

    const s = status || {};
    const hasData = !!status;
    const lastMs = parseUTC(s.diterima || s.waktu);
    const online = hasData && lastMs !== null && Date.now() - lastMs < STALE_MS;

    const oeeData = val(oeeRes);
    const wipData = val(wipRes);
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

    lastBottles = bottles;

    // 1. Header & Mesin
    renderMachineHeader(s, online, hasData, lastMs);
    renderTurretVisual(s, hasData);

    // 2. WIP Flow
    renderWipAndBuffers(s, wipData);

    // 3. OEE & Six Big Losses
    const oeeCalc = calculateOeeAndLosses(s, oeeData, summary, downtime);
    renderProductionAndOee(s, oeeCalc, capData, leadData);

    // 4. Kualitas & SPC
    renderQualityAndSpc(s, qualData, summary, bottles);

    // 5. Downtime & Reliability
    renderDowntimeAndReliability(s, relData, downtime, events, oeeCalc);

    // 6. Inventori & Material
    renderInventory(s, invData);

    // 7. Tabel Events & Botol
    fillTable("eventTable", events.slice(0, 8).map(eventRowTable), 4, "Belum ada event.");
    fillTable("downtimeTable", events.slice(0, 50).map(eventRowTable), 5, "Belum ada riwayat event.");
    setText("eventInfo", `${Math.min(events.length, 8)} dari ${events.length} event tersimpan.`);

    fillTable("bottleTable", bottles.slice(0, 10).map(bottleRowLive), 5, "Belum ada data botol.");
    setText("bottleInfo", `${Math.min(bottles.length, 10)} botol terakhir sesi ini`);
    fillTable("qualityTable", bottles.slice(0, 30).map(qualityRowTable), 8, "Belum ada data botol.");

    // Update Traceability table jika tidak sedang mengetik pencarian
    if (!$("traceSearch")?.value.trim()) {
        fillTable("traceTable", bottles.map(qualityRowTable), 8, "Belum ada data botol.");
    }

    // 8. Arsip Batch & Laporan
    renderBatchHistory(batchList);
    renderReportPage({ status, summary, laporan: val(lpRes) }, oeeCalc);

    // 9. Timeline bar
    const runPct = oeeCalc.operatingTime > 0 ? pct(oeeCalc.operatingTime, oeeCalc.plannedTime) : 0;
    const downPct = oeeCalc.downtimeUnplanned > 0 ? pct(oeeCalc.downtimeUnplanned, oeeCalc.plannedTime) : 0;
    const warnPct = Math.max(0, 100 - (runPct + downPct));
    setWidth("runningBar", runPct);
    setWidth("warningBar", warnPct);
    setWidth("downtimeBar", downPct);
    setText("runningPercentage", `🟢 Berjalan (${runPct}%)`);
    setText("warningPercentage", `🟠 Peringatan / Idle (${warnPct}%)`);
    setText("downtimePercentage", `🔴 Downtime (${downPct}%)`);

    // 10. Status Koneksi
    const dbText = health?.data?.database;
    const dbOk = /ok|connect|terhubung|sehat|up/i.test(String(dbText));
    setConnectionStatus(true, dbOk, health.ms, online, dbText);
}

function updateDate() {
    setText("currentDate", "▣ " + new Date().toLocaleDateString("id-ID", {
        weekday: "long", day: "numeric", month: "long", year: "numeric"
    }));
}

updateDate();
refresh();
setInterval(refresh, POLL_MS);
console.log("MPB-01 MES Dashboard dimuat. Base API:", API_BASE, "Mesin:", MACHINE_ID);
