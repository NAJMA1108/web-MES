/* =========================================================================
   MPB-01 MES DASHBOARD JAVASCRIPT
   Sesuai Spesifikasi API & Perhitungan Monitoring Web MES
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

// Spesifikasi Kapasitas Mesin
const SPEC = {
    idealCycleTime: 4.1,               // 1.5s putar + 2.6s diam (s/botol)
    theoreticalCapacityHour: 878.05,   // 3600 / 4.1 = 878.05 botol/jam
    qcMinPassLevel: 0.85,              // Batas Lulus QC level isi >= 0.85
    bufferCapacity: {
        infeed: 30,                    // Peti meja infeed maks 30 botol
        turret: 10,                    // Slot turret rotary 10
        boxOk: 30,                     // Kapasitas kotak OK penampung
        boxNg: 12                      // Kapasitas wadah reject (peringatan jika >= 10)
    }
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
    if (sec === null || sec === undefined || isNaN(sec)) return "--";
    sec = Math.round(sec);
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
    "Slot " + (b.slot !== undefined && b.slot !== null ? b.slot : "--"),
    fillOf(b),
    b.status || (typeof b.level_isi === "number" ? (b.level_isi >= SPEC.qcMinPassLevel ? "OK" : "TIDAK_PENUH") : "--"),
    cycleOf(b)
];

const qualityRowTable = b => [
    noOf(b),
    b.slot !== undefined && b.slot !== null ? b.slot : "--",
    fillOf(b),
    typeof b.bertutup === "boolean" ? (b.bertutup ? "✓ Tertutup" : "✗ Terbuka") : "--",
    b.status || (typeof b.level_isi === "number" ? (b.level_isi >= SPEC.qcMinPassLevel ? "OK" : "TIDAK_PENUH") : "--"),
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
    const rawVal = ($("traceSearch")?.value || "").trim();
    const digits = rawVal.replace(/\D/g, "");
    const card = $("bottleDetailCard");

    if (!digits) {
        if (card) card.style.display = "none";
        fillTable("traceTable", lastBottles.map(qualityRowTable), 8, "Belum ada data botol.");
        setText("traceInfo", `${lastBottles.length} botol terakhir sesi ini. Masukkan nomor botol untuk mencari detail.`);
        return;
    }

    const num = Number(digits);
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

            if (card) {
                card.style.display = "block";
                setText("cardBottleNo", `Botol #${String(num).padStart(5, "0")}`);
                setText("cardSlot", `Slot ${bottle.slot !== undefined && bottle.slot !== null ? bottle.slot : "--"}`);
                setText("cardFill", fillOf(bottle));
                setText("cardCapping", typeof bottle.bertutup === "boolean" ? (bottle.bertutup ? "✓ Terpasang Rapat" : "✗ Tanpa Tutup") : "--");
                setText("cardFillingDuration", fillDurationOf(bottle));
                setText("cardUnitMlt", cycleOf(bottle));
                setText("cardBatch", `Batch #${bottle.batch_ke || 1}`);
                setText("cardTimeIn", fmtTime(bottle.waktu_masuk));
                setText("cardTimeOut", fmtTime(bottle.waktu_keluar));

                const statusEl = $("cardBottleStatus");
                if (statusEl) {
                    const statusText = bottle.status || (typeof bottle.level_isi === "number" ? (bottle.level_isi >= SPEC.qcMinPassLevel ? "OK" : "TIDAK_PENUH") : "--");
                    statusEl.textContent = statusText;
                    statusEl.className = "pill " + (statusText === "OK" ? "ok" : statusText === "--" ? "" : "danger");
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
    const qcLast = s.status_qc_terakhir || (s.botol_reject > 0 ? "REJECT" : (hasData ? "OK" : "--"));

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
    setText("liveBatchBadge", s.batch_ke ? `Batch: #${batch}` : "Batch: #--");

    const qcBadge = $("liveQcBadge");
    if (qcBadge) {
        if (s.status_qc_terakhir) {
            qcBadge.style.display = "inline-block";
            qcBadge.textContent = `QC: ${s.status_qc_terakhir}`;
            qcBadge.style.background = s.status_qc_terakhir === "OK" ? "#dcfce7" : "#fee2e2";
            qcBadge.style.color = s.status_qc_terakhir === "OK" ? "#15803d" : "#b91c1c";
        } else {
            qcBadge.style.display = "none";
        }
    }

    setText("lastQcStatusText", s.status_qc_terakhir || "--");
    setText("batchNumber", `Sesi: ${sesi.slice(0, 12)} · Batch #${s.batch_ke || "--"}`);

    // MCB Status
    const mcb = s.mcb;
    [["mcbMain", "utama", "Utama"], ["mcbMachine", "mesin", "Mesin"],
    ["mcbControl", "kontrol", "Kontrol"], ["mcbLamp", "lampu", "Lampu"]].forEach(([id, key, name]) => {
        const on = mcb ? mcb[key] : undefined;
        setText(id, `● ${on === undefined ? "--" : on ? "ON" : "OFF"} ${name}`);
        setColor(id, on === true ? GREEN : on === false ? RED : GREY);
    });

    // Peringatan sistem (Alert Banner)
    const alertBanner = $("liveAlertBanner");
    const alertMsg = $("alertMessage");
    const boxNg = s.isi_kotak_reject || 0;
    const isStarving = !!s.sedang_starving;
    const rackLow = (typeof s.sisa_stok_rak_atas === "number" && s.sisa_stok_rak_atas <= 2);

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
    const angle = (hasData && typeof s.sudut_turret_deg === "number") ? Number(s.sudut_turret_deg) : null;
    setText("turretPitch", `Sudut: ${angle !== null ? Math.round(angle) : "--"}°`);
}

function renderWipAndBuffers(s, wipData) {
    const hasPeti = typeof s.sisa_peti === "number" || typeof wipData?.sisa_peti === "number";
    const sisaPeti = s.sisa_peti ?? wipData?.sisa_peti ?? null;

    const hasTurret = typeof s.wip_turret === "number" || typeof wipData?.wip_turret === "number";
    const wipTurret = s.wip_turret ?? wipData?.wip_turret ?? null;

    const hasBoxOk = typeof s.isi_kotak === "number" || typeof wipData?.isi_kotak === "number";
    const isiKotak = s.isi_kotak ?? wipData?.isi_kotak ?? null;

    const hasBoxNg = typeof s.isi_kotak_reject === "number" || typeof wipData?.isi_kotak_reject === "number";
    const isiKotakReject = s.isi_kotak_reject ?? wipData?.isi_kotak_reject ?? null;

    const totalWip = typeof wipData?.wip_total === "number"
        ? wipData.wip_total
        : (typeof s.wip_total === "number"
            ? s.wip_total
            : (hasPeti && hasTurret && hasBoxOk ? (sisaPeti || 0) + (wipTurret || 0) + (isiKotak || 0) : null));

    // Live Top Card WIP
    if (totalWip !== null) {
        setText("liveWipTotal", totalWip);
        const wipPct = Math.round((totalWip / 52) * 100);
        setWidth("liveWipProgress", wipPct);
        setText("liveWipPercentage", `${wipPct}% Buffer`);
        setText("liveWipStatus", wipData?.warning ? "⚠️ Bottleneck Buffer" : "Aliran Normal");
    } else {
        setText("liveWipTotal", "--");
        setWidth("liveWipProgress", 0);
        setText("liveWipPercentage", "--% Buffer");
        setText("liveWipStatus", "Menunggu data");
    }

    // 1. Infeed Station
    if (hasPeti && sisaPeti !== null) {
        setText("palletRemaining", sisaPeti);
        const infeedPct = Math.round((sisaPeti / SPEC.bufferCapacity.infeed) * 100);
        setWidth("palletProgress", infeedPct);
        setText("palletPercentage", `${infeedPct}% sisa (${sisaPeti}/30 botol)`);
        setText("infeedStatus", sisaPeti === 0 ? "Starving" : "Normal");
    } else {
        setText("palletRemaining", "--");
        setWidth("palletProgress", 0);
        setText("palletPercentage", "--% sisa bahan");
        setText("infeedStatus", "Menunggu data");
    }

    // 2. Turret Rotary
    if (hasTurret && wipTurret !== null) {
        setText("liveTurretWip", wipTurret);
        const turretPct = Math.round((wipTurret / SPEC.bufferCapacity.turret) * 100);
        setWidth("turretWipProgress", turretPct);
        setText("turretWipBadge", `${wipTurret} Botol Aktif`);
    } else {
        setText("liveTurretWip", "--");
        setWidth("turretWipProgress", 0);
        setText("turretWipBadge", "10 Slot");
    }

    // 3. Kotak OK Penampung
    if (hasBoxOk && isiKotak !== null) {
        setText("boxFilled", isiKotak);
        const boxOkPct = Math.round((isiKotak / SPEC.bufferCapacity.boxOk) * 100);
        setWidth("boxProgress", boxOkPct);
        const okTotal = s.botol_ok ?? s.botol_selesai;
        const boxNum = typeof okTotal === "number" ? Math.floor(okTotal / SPEC.bufferCapacity.boxOk) + 1 : 1;
        setText("boxPercentage", `${boxOkPct}% terisi (Kotak #${boxNum})`);
    } else {
        setText("boxFilled", "--");
        setWidth("boxProgress", 0);
        setText("boxPercentage", "--% terisi");
    }

    // 4. Wadah Reject (NG)
    if (hasBoxNg && isiKotakReject !== null) {
        setText("liveBoxNg", isiKotakReject);
        const boxNgPct = Math.round((isiKotakReject / SPEC.bufferCapacity.boxNg) * 100);
        setWidth("boxNgProgress", boxNgPct);
        const ngEl = $("stationBoxNg");
        if (ngEl) ngEl.classList.toggle("danger-station", isiKotakReject >= 10);
        setText("boxNgStatus", isiKotakReject >= 10 ? "⚠️ HAMPIR PENUH!" : `${isiKotakReject}/12 botol`);
    } else {
        setText("liveBoxNg", "--");
        setWidth("boxNgProgress", 0);
        setText("boxNgStatus", "Menunggu data");
    }
}

function calculateOeeAndLosses(s, oeeData, sum, dt) {
    const botolSelesai = typeof s.botol_selesai === "number"
        ? s.botol_selesai
        : (typeof sum?.jumlah_botol === "number" ? sum.jumlah_botol : null);
    const botolOk = typeof s.botol_ok === "number"
        ? s.botol_ok
        : (typeof sum?.botol_ok === "number"
            ? sum.botol_ok
            : (botolSelesai !== null && typeof s.botol_reject === "number" ? Math.max(0, botolSelesai - s.botol_reject) : null));
    const botolReject = typeof s.botol_reject === "number"
        ? s.botol_reject
        : (typeof sum?.botol_gagal === "number"
            ? sum.botol_gagal
            : (botolSelesai !== null && botolOk !== null ? Math.max(0, botolSelesai - botolOk) : null));

    const plannedTime = typeof oeeData?.planned_time_detik === "number"
        ? oeeData.planned_time_detik
        : (typeof s.planned_production_time === "number"
            ? s.planned_production_time
            : (typeof s.batch_cycle_time === "number" ? s.batch_cycle_time : null));

    const setupTime = typeof oeeData?.losses?.setup === "number"
        ? oeeData.losses.setup
        : (typeof s.setup_time === "number" ? s.setup_time : null);

    const starvationTime = typeof oeeData?.losses?.starvation === "number"
        ? oeeData.losses.starvation
        : (typeof s.starvation_downtime === "number" ? s.starvation_downtime : null);

    const packagingTime = typeof oeeData?.losses?.packaging === "number"
        ? oeeData.losses.packaging
        : (typeof s.packaging_time === "number" ? s.packaging_time : null);

    const downtimeUnplanned = typeof oeeData?.losses?.breakdown === "number"
        ? oeeData.losses.breakdown
        : (typeof s.downtime_unplanned === "number"
            ? s.downtime_unplanned
            : (typeof dt?.total_durasi_downtime_detik === "number" ? dt.total_durasi_downtime_detik : null));

    // Operating time: dari API oee, atau s.production_time, atau dikalkulasi jika SEMUA komponen tersedia
    let operatingTime = typeof oeeData?.operating_time_detik === "number"
        ? oeeData.operating_time_detik
        : (typeof s.production_time === "number" ? s.production_time : null);

    if (operatingTime === null && plannedTime !== null && downtimeUnplanned !== null && setupTime !== null && starvationTime !== null && packagingTime !== null) {
        operatingTime = Math.max(0, plannedTime - (downtimeUnplanned + setupTime + starvationTime + packagingTime));
    }

    // Availability = operating_time / planned_production_time
    let availPct = null;
    if (typeof oeeData?.availability_pct === "number") {
        availPct = oeeData.availability_pct;
    } else if (operatingTime !== null && plannedTime !== null && plannedTime > 0) {
        availPct = Math.min(100, Math.max(0, (operatingTime / plannedTime) * 100));
    }

    // Performance = (ideal_cycle_time * botol_selesai) / operating_time
    let perfPct = null;
    if (typeof oeeData?.performance_pct === "number") {
        perfPct = oeeData.performance_pct;
    } else if (operatingTime !== null && operatingTime > 0 && botolSelesai !== null) {
        perfPct = Math.min(120, Math.max(0, ((SPEC.idealCycleTime * botolSelesai) / operatingTime) * 100));
    }

    // Quality = botol_ok / botol_selesai
    let qualPct = null;
    if (typeof oeeData?.quality_pct === "number") {
        qualPct = oeeData.quality_pct;
    } else if (typeof s.first_pass_yield === "number") {
        qualPct = Math.min(100, Math.max(0, s.first_pass_yield));
    } else if (botolSelesai !== null && botolOk !== null && botolSelesai > 0) {
        qualPct = Math.min(100, Math.max(0, (botolOk / botolSelesai) * 100));
    } else if (botolSelesai === 0) {
        qualPct = 100;
    }

    // OEE = A * P * Q
    let oeePct = null;
    if (typeof oeeData?.oee_pct === "number") {
        oeePct = oeeData.oee_pct;
    } else if (availPct !== null && perfPct !== null && qualPct !== null) {
        oeePct = Math.min(100, Math.max(0, (availPct / 100) * (perfPct / 100) * (qualPct / 100) * 100));
    }

    // Six Big Losses: hanya dari API atau formula jika data riil tersedia
    const lossBreakdownVal = typeof oeeData?.losses?.breakdown === "number" ? oeeData.losses.breakdown : downtimeUnplanned;
    const lossSetupVal = typeof oeeData?.losses?.setup === "number" ? oeeData.losses.setup : setupTime;
    const lossStarvingWaitVal = typeof oeeData?.losses?.starving_packaging === "number"
        ? oeeData.losses.starving_packaging
        : (starvationTime !== null && packagingTime !== null ? starvationTime + packagingTime : (starvationTime !== null ? starvationTime : (packagingTime !== null ? packagingTime : null)));
    const lossSpeedVal = typeof oeeData?.losses?.speed_loss === "number"
        ? oeeData.losses.speed_loss
        : (operatingTime !== null && botolSelesai !== null ? Math.max(0, operatingTime - (SPEC.idealCycleTime * botolSelesai)) : null);
    const lossQualityVal = typeof oeeData?.losses?.quality_loss === "number"
        ? oeeData.losses.quality_loss
        : (botolReject !== null ? botolReject * SPEC.idealCycleTime : null);

    return {
        availPct: availPct !== null ? Number(availPct.toFixed(1)) : null,
        perfPct: perfPct !== null ? Number(perfPct.toFixed(1)) : null,
        qualPct: qualPct !== null ? Number(qualPct.toFixed(1)) : null,
        oeePct: oeePct !== null ? Number(oeePct.toFixed(1)) : null,
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
    const target = typeof s.target_qty === "number"
        ? s.target_qty
        : (allBatches.length > 0 && typeof allBatches[0].target_qty === "number" ? allBatches[0].target_qty : null);
    const total = oeeCalc.botolSelesai;
    const good = oeeCalc.botolOk;

    const finishedBoxes = typeof s.kardus_selesai === "number"
        ? s.kardus_selesai
        : (typeof good === "number" ? Math.floor(good / 30) : null);
    const packedBottles = typeof s.total_dikemas === "number"
        ? s.total_dikemas
        : (finishedBoxes !== null ? finishedBoxes * 30 : null);

    const hasTarget = target !== null && target > 0;
    const progPct = (hasTarget && total !== null) ? pct(total, target) : null;

    // Live Card OEE
    setText("liveOee", oeeCalc.oeePct !== null ? oeeCalc.oeePct : "--");
    setText("liveOeeComponents",
        `A: ${oeeCalc.availPct !== null ? oeeCalc.availPct + "%" : "--%"} | ` +
        `P: ${oeeCalc.perfPct !== null ? oeeCalc.perfPct + "%" : "--%"} | ` +
        `Q: ${oeeCalc.qualPct !== null ? oeeCalc.qualPct + "%" : "--%"}`
    );

    // Live Card Production
    setText("totalProduction", show(total));
    setText("productionTarget", show(target));
    setText("productionPercentage", progPct !== null ? `Kemajuan: ${progPct}%` : "Kemajuan: --%");

    // Page Produksi Cards
    setText("prodTotal", show(total));
    setText("prodTarget", show(target));
    setText("prodRemaining", (hasTarget && total !== null) ? Math.max(0, target - total) : "--");
    setText("prodPercentage", progPct !== null ? `${progPct}%` : "--%");
    setText("prodPacked", show(packedBottles));
    setText("prodBoxesFinished", finishedBoxes !== null ? `${finishedBoxes} Kardus Jadi` : "-- Kardus Jadi");

    // Cycle Time (Actual vs Ideal)
    const actualCt = typeof capData?.actual_cycle_time_avg === "number"
        ? capData.actual_cycle_time_avg
        : (typeof s.actual_cycle_time_avg === "number" && s.actual_cycle_time_avg > 0
            ? s.actual_cycle_time_avg
            : (total !== null && total > 0 && oeeCalc.operatingTime !== null ? oeeCalc.operatingTime / total : null));

    setText("actualCycleDisplay", actualCt !== null ? actualCt.toFixed(1) + " s" : "-- s");
    setText("prodActualCycle", actualCt !== null ? actualCt.toFixed(2) : "--");
    if (actualCt !== null) {
        const diffCt = actualCt - SPEC.idealCycleTime;
        setText("prodCycleDiff", diffCt > 0 ? `+${diffCt.toFixed(2)}s (Loss)` : "Optimal (0s)");
    } else {
        setText("prodCycleDiff", "Deviasi: --");
    }

    // Kapasitas Produksi
    const effectiveCap = typeof capData?.kapasitas_efektif_per_jam === "number"
        ? capData.kapasitas_efektif_per_jam
        : (typeof s.production_capacity_per_hour === "number"
            ? s.production_capacity_per_hour
            : (typeof s.batch_cycle_time === "number" && hasTarget ? (target / s.batch_cycle_time) * 3600 : null));

    const capUtil = typeof capData?.utilisasi_kapasitas_pct === "number"
        ? capData.utilisasi_kapasitas_pct
        : (effectiveCap !== null ? (effectiveCap / SPEC.theoreticalCapacityHour) * 100 : null);

    setText("prodEffectiveCapacity", effectiveCap !== null ? Math.round(effectiveCap) : "--");
    setText("prodCapacityUtil", capUtil !== null ? `Utilisasi: ${Math.round(capUtil)}%` : "Utilisasi: --%");
    setText("productionRate", effectiveCap !== null ? `${Math.round(effectiveCap)} bph` : "-- bph");

    // OEE Cards
    setText("oeeScore", oeeCalc.oeePct !== null ? `${oeeCalc.oeePct}%` : "--%");
    setText("oeeAvailability", oeeCalc.availPct !== null ? `${oeeCalc.availPct}%` : "--%");
    setText("oeePerformance", oeeCalc.perfPct !== null ? `${oeeCalc.perfPct}%` : "--%");
    setText("oeeQuality", oeeCalc.qualPct !== null ? `${oeeCalc.qualPct}%` : "--%");
    const oeeBadge = $("oeeScoreBadge");
    if (oeeBadge) {
        oeeBadge.textContent = oeeCalc.oeePct !== null
            ? (oeeCalc.oeePct >= 85 ? "🌟 World Class (≥85%)" : oeeCalc.oeePct >= 60 ? "✓ Beroperasi Baik" : "⚠️ Perlu Perbaikan")
            : "Data tidak tersedia";
    }

    // Waktu Kumulatif
    setText("timePlanned", oeeCalc.plannedTime !== null ? `${Math.round(oeeCalc.plannedTime)} s` : "--");
    setText("timeOperating", oeeCalc.operatingTime !== null ? `${Math.round(oeeCalc.operatingTime)} s` : "--");
    setText("timeSetup", oeeCalc.setupTime !== null ? `${Math.round(oeeCalc.setupTime)} s` : "--");
    setText("timeStarvation", oeeCalc.starvationTime !== null ? `${Math.round(oeeCalc.starvationTime)} s` : "--");
    setText("timePackaging", oeeCalc.packagingTime !== null ? `${Math.round(oeeCalc.packagingTime)} s` : "--");
    setText("timeDowntime", oeeCalc.downtimeUnplanned !== null ? `${Math.round(oeeCalc.downtimeUnplanned)} s` : "--");

    // Six Big Losses
    setText("lossBreakdown", oeeCalc.lossBreakdownVal !== null ? `${Math.round(oeeCalc.lossBreakdownVal)} s` : "--");
    setText("lossSetup", oeeCalc.lossSetupVal !== null ? `${Math.round(oeeCalc.lossSetupVal)} s` : "--");
    setText("lossStarvingPackaging", oeeCalc.lossStarvingWaitVal !== null ? `${Math.round(oeeCalc.lossStarvingWaitVal)} s` : "--");
    setText("lossSpeed", oeeCalc.lossSpeedVal !== null ? `${Math.round(oeeCalc.lossSpeedVal)} s` : "--");
    setText("lossQuality", oeeCalc.lossQualityVal !== null ? `${oeeCalc.lossQualityVal.toFixed(1)} s` : "--");

    // Lead Time (MLT)
    const unitMlt = typeof leadData?.unit_mlt_avg_detik === "number"
        ? leadData.unit_mlt_avg_detik
        : (typeof s.actual_cycle_time_avg === "number" && s.actual_cycle_time_avg > 0 ? s.actual_cycle_time_avg * 6 : null);
    const fillDur = typeof leadData?.durasi_isi_avg_detik === "number" ? leadData.durasi_isi_avg_detik : null;
    const batchMlt = typeof leadData?.batch_mlt_avg_detik === "number"
        ? leadData.batch_mlt_avg_detik
        : (typeof s.batch_cycle_time === "number" ? s.batch_cycle_time : (typeof s.mlt_batch === "number" ? s.mlt_batch : null));
    const bottlesCount = typeof leadData?.total_botol_dianalisis === "number" ? leadData.total_botol_dianalisis : total;

    setText("mltUnitAvg", unitMlt !== null ? `${unitMlt.toFixed(1)} s` : "--");
    setText("mltFillingAvg", fillDur !== null ? `${fillDur.toFixed(2)} s` : "--");
    setText("mltBatchAvg", batchMlt !== null ? `${Math.round(batchMlt)} s` : "--");
    setText("mltBottlesCount", bottlesCount !== null ? `${bottlesCount} botol` : "--");
}

function renderQualityAndSpc(s, qualData, sum, bottles) {
    const total = typeof qualData?.total_botol === "number"
        ? qualData.total_botol
        : (typeof s.botol_selesai === "number" ? s.botol_selesai : (bottles.length ? bottles.length : null));
    const good = typeof qualData?.botol_ok === "number"
        ? qualData.botol_ok
        : (typeof s.botol_ok === "number"
            ? s.botol_ok
            : (bottles.length ? bottles.filter(b => b.status === "OK" || b.level_isi >= SPEC.qcMinPassLevel).length : null));
    const bad = typeof qualData?.botol_reject === "number"
        ? qualData.botol_reject
        : (typeof s.botol_reject === "number"
            ? s.botol_reject
            : (total !== null && good !== null ? Math.max(0, total - good) : null));
    const fpy = typeof qualData?.first_pass_yield_pct === "number"
        ? qualData.first_pass_yield_pct
        : (typeof s.first_pass_yield === "number"
            ? s.first_pass_yield
            : (total !== null && total > 0 && good !== null ? (good / total) * 100 : null));

    // Live Card Quality
    setText("qualityYield", fpy !== null ? fpy.toFixed(1) : "--");
    setText("rejectCount", bad !== null ? `Reject: ${bad}` : "Reject: --");
    setText("volumeTolerance", bad !== null ? (bad === 0 ? "QC 100% Lulus" : `${bad} botol cacat`) : "Menunggu data");

    // Page Kualitas KPI
    setText("qualityPageYield", fpy !== null ? `${fpy.toFixed(1)}%` : "--%");
    setText("qualityGood", show(good));
    setText("qualityGoodPct", (total !== null && total > 0 && good !== null) ? `${Math.round((good / total) * 100)}% dari total` : "--%");
    setText("qualityReject", show(bad));
    setText("qualityRejectPct", (total !== null && total > 0 && bad !== null) ? `${Math.round((bad / total) * 100)}% cacat` : "--%");

    // Pareto Defect
    const underfill = typeof qualData?.pareto_reject?.TIDAK_PENUH === "number"
        ? qualData.pareto_reject.TIDAK_PENUH
        : (typeof s.reject_isi_kurang === "number" ? s.reject_isi_kurang : null);
    const noCap = typeof qualData?.pareto_reject?.TANPA_TUTUP === "number"
        ? qualData.pareto_reject.TANPA_TUTUP
        : (typeof s.reject_tanpa_tutup === "number" ? s.reject_tanpa_tutup : null);

    if (underfill !== null) {
        setText("paretoUnderfillCount", `${underfill} unit`);
        const underfillPct = (bad !== null && bad > 0) ? Math.round((underfill / bad) * 100) : 0;
        setWidth("paretoUnderfillProgress", underfillPct);
        setText("paretoUnderfillPct", (bad !== null && bad > 0) ? `${underfillPct}% dari total reject` : "0% dari total reject");
    } else {
        setText("paretoUnderfillCount", "--");
        setWidth("paretoUnderfillProgress", 0);
        setText("paretoUnderfillPct", "Data tidak tersedia");
    }

    if (noCap !== null) {
        setText("paretoNoCapCount", `${noCap} unit`);
        const noCapPct = (bad !== null && bad > 0) ? Math.round((noCap / bad) * 100) : 0;
        setWidth("paretoNoCapProgress", noCapPct);
        setText("paretoNoCapPct", (bad !== null && bad > 0) ? `${noCapPct}% dari total reject` : "0% dari total reject");
    } else {
        setText("paretoNoCapCount", "--");
        setWidth("paretoNoCapProgress", 0);
        setText("paretoNoCapPct", "Data tidak tersedia");
    }

    // SPC Level Isi: Hanya dari API data statistik yang valid
    const spc = qualData?.level_isi_stats;
    const hasValidSpc = spc && typeof spc.mean === "number" && typeof spc.std === "number";

    if (hasValidSpc) {
        setText("spcMean", spc.mean.toFixed(3));
        setText("spcStd", spc.std.toFixed(4));
        setText("spcRange", (typeof spc.min === "number" && typeof spc.max === "number") ? `${spc.min.toFixed(2)} – ${spc.max.toFixed(2)}` : "--");
        setText("spcUcl", typeof spc.ucl === "number" ? spc.ucl.toFixed(3) : "--");
        setText("spcLcl", typeof spc.lcl === "number" ? spc.lcl.toFixed(3) : "--");
        setText("spcBelowSpec", typeof spc.jumlah_kurang_dari_batas === "number" ? `${spc.jumlah_kurang_dari_batas} unit` : (underfill !== null ? `${underfill} unit` : "--"));
    } else {
        setText("spcMean", "--");
        setText("spcStd", "--");
        setText("spcRange", "--");
        setText("spcUcl", "--");
        setText("spcLcl", "--");
        setText("spcBelowSpec", underfill !== null ? `${underfill} unit` : "--");
    }

    // Audit Defect Per Slot Turret (0..9)
    const slotGrid = $("slotAuditGrid");
    if (slotGrid) {
        slotGrid.replaceChildren();
        const slotCounts = Array(10).fill(0);
        let hasSlotData = false;
        bottles.forEach(b => {
            if (b.slot !== undefined && b.slot !== null) {
                hasSlotData = true;
                if (b.status === "TIDAK_PENUH" || b.status === "TANPA_TUTUP" || (typeof b.level_isi === "number" && b.level_isi < SPEC.qcMinPassLevel)) {
                    slotCounts[b.slot] = (slotCounts[b.slot] || 0) + 1;
                }
            }
        });
        for (let i = 0; i < 10; i++) {
            const div = document.createElement("div");
            div.className = "slot-box" + (slotCounts[i] > 0 ? " has-defect" : "");
            const label = hasSlotData ? `${slotCounts[i]} NG` : "--";
            div.innerHTML = `<small>Slot ${i}</small><strong>${label}</strong>`;
            slotGrid.appendChild(div);
        }
    }
}

function renderDowntimeAndReliability(s, relData, dt, events, oeeCalc) {
    const totalDowntimeSec = typeof relData?.total_downtime_detik === "number"
        ? relData.total_downtime_detik
        : (typeof dt?.total_durasi_downtime_detik === "number"
            ? dt.total_durasi_downtime_detik
            : (typeof s.downtime_unplanned === "number" ? s.downtime_unplanned : null));

    setText("totalDowntime", totalDowntimeSec !== null ? `Total Downtime: ${fmtDur(totalDowntimeSec)}` : "Total Downtime: --");
}

function renderInventory(s, invData) {
    const rackRemain = typeof invData?.sisa_stok_rak_atas === "number"
        ? invData.sisa_stok_rak_atas
        : (typeof s.sisa_stok_rak_atas === "number" ? s.sisa_stok_rak_atas : null);

    const rackCap = typeof invData?.kapasitas_stok_rak_atas === "number"
        ? invData.kapasitas_stok_rak_atas
        : (typeof s.kapasitas_stok_rak_atas === "number" ? s.kapasitas_stok_rak_atas : null);

    const restockCount = typeof invData?.jumlah_restock === "number"
        ? invData.jumlah_restock
        : (typeof s.jumlah_restock === "number" ? s.jumlah_restock : null);

    const autoReplenish = typeof invData?.jumlah_auto_replenish_rak === "number"
        ? invData.jumlah_auto_replenish_rak
        : (typeof s.jumlah_auto_replenish_rak === "number" ? s.jumlah_auto_replenish_rak : null);

    const infeedRemain = typeof s.sisa_peti === "number" ? s.sisa_peti : null;

    setText("invRackRemaining", show(rackRemain));
    setText("invRackCapacity", show(rackCap));

    if (rackRemain !== null && rackCap !== null && rackCap > 0) {
        const rackPct = Math.round((rackRemain / rackCap) * 100);
        setText("invRackPercentage", `${rackPct}% Kapasitas`);
        setText("invRackBarVal", `${rackPct}%`);
        setWidth("invRackProgress", rackPct);
    } else {
        setText("invRackPercentage", "--%");
        setText("invRackBarVal", "--%");
        setWidth("invRackProgress", 0);
    }

    setText("invInfeedRemaining", show(infeedRemain));
    setText("invAutoReplenishCount", show(autoReplenish));
    setText("invRestockCount", show(restockCount));

    const alertPill = $("invRackAlertPill");
    const statusBadge = $("invRestockStatusBadge");
    if (rackRemain !== null) {
        const needRestock = typeof invData?.butuh_restock === "boolean"
            ? invData.butuh_restock
            : rackRemain <= 2;
        if (alertPill) {
            alertPill.textContent = needRestock ? "Perlu Restock" : "Aman";
            alertPill.className = "pill " + (needRestock ? "danger" : "ok");
        }
        if (statusBadge) {
            statusBadge.textContent = needRestock ? "Perlu Restock" : "Stok Cukup";
            statusBadge.className = "pill " + (needRestock ? "danger" : "ok");
        }
    } else {
        if (alertPill) {
            alertPill.textContent = "Data tidak tersedia";
            alertPill.className = "pill";
        }
        if (statusBadge) {
            statusBadge.textContent = "--";
            statusBadge.className = "pill";
        }
    }

    // Konsumsi Bahan
    const bottlesUsed = typeof s.botol_selesai === "number"
        ? s.botol_selesai + (s.wip_turret || 0)
        : null;
    const capsUsed = bottlesUsed !== null
        ? Math.max(0, bottlesUsed - (s.reject_tanpa_tutup || 0))
        : null;

    setText("invBottlesUsed", show(bottlesUsed));
    setText("invCapsUsed", show(capsUsed));
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
        const targetText = b.target_qty !== undefined && b.target_qty !== null ? b.target_qty : "--";
        const botolText = b.botol_selesai !== undefined && b.botol_selesai !== null ? b.botol_selesai : "--";
        const mltText = typeof b.mlt_batch === "number" ? Math.round(b.mlt_batch) + " s" : "--";
        const capText = typeof b.effective_capacity_per_hour === "number" ? Math.round(b.effective_capacity_per_hour) + " bph" : "--";
        const oeeText = typeof b.oee_pct === "number" ? b.oee_pct.toFixed(1) + "%" : "--";
        const aText = typeof b.availability_pct === "number" ? b.availability_pct.toFixed(1) + "%" : "--";
        const pText = typeof b.performance_pct === "number" ? b.performance_pct.toFixed(1) + "%" : "--";
        const qText = typeof b.quality_pct === "number" ? b.quality_pct.toFixed(1) + "%" : "--";

        tr.innerHTML = `
            <td><b>#${b.batch_ke || 1}</b></td>
            <td>${fmtTime(b.waktu_selesai || b.waktu_mulai)}</td>
            <td>${targetText} / ${botolText}</td>
            <td><span style="color:${GREEN}">${b.botol_ok ?? 0} OK</span> / <span style="color:${RED}">${b.botol_reject ?? 0} NG</span></td>
            <td><b>${oeeText}</b></td>
            <td>${aText}</td>
            <td>${pText}</td>
            <td>${qText}</td>
            <td>${mltText}</td>
            <td>${capText}</td>
        `;
        body.appendChild(tr);
    });
}

function renderReportPage(d, oeeCalc) {
    const s = d.status || {};
    const total = oeeCalc.botolSelesai;
    const dur = oeeCalc.downtimeUnplanned;

    setText("reportOee", oeeCalc.oeePct !== null ? `${oeeCalc.oeePct}%` : "--%");
    setText("reportProduction", total !== null ? `${total} botol` : "--");
    setText("reportQuality", oeeCalc.qualPct !== null ? `${oeeCalc.qualPct}%` : "--%");
    setText("reportDowntime", dur !== null ? fmtDur(dur) : "--");

    if (s.sesi_id) {
        setText("reportDescription",
            `Laporan Resmi Mesin MPB-01 · Sesi: ${s.sesi_id} · Operator: ${s.pengguna || "--"}. ` +
            `Dari ${total !== null ? total : 0} botol produksi, diperoleh OEE ${oeeCalc.oeePct !== null ? oeeCalc.oeePct + "%" : "--%"} ` +
            `(Availability: ${oeeCalc.availPct !== null ? oeeCalc.availPct + "%" : "--%"}, ` +
            `Performance: ${oeeCalc.perfPct !== null ? oeeCalc.perfPct + "%" : "--%"}, ` +
            `Quality: ${oeeCalc.qualPct !== null ? oeeCalc.qualPct + "%" : "--%"}). ` +
            `Total Downtime: ${dur !== null ? fmtDur(dur) : "--"}.`);
    } else {
        setText("reportDescription", "Data laporan belum tersedia. Menunggu telemetri sesi aktif.");
    }
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
        setConnectionStatus(false, false, 0, false, "Koneksi ke backend API gagal.");
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

    // Panggil modul spesifikasi aktif secara paralel (tanpa endpoint /laporan yang tidak digunakan frontend)
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
        dtRes
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
        api(`/mesin/${id}/downtime`, q)
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
    setText("eventInfo", `${Math.min(events.length, 8)} dari ${events.length} event tersimpan.`);

    fillTable("bottleTable", bottles.slice(0, 10).map(bottleRowLive), 5, "Belum ada data botol.");
    setText("bottleInfo", `${Math.min(bottles.length, 10)} botol terakhir sesi ini`);
    fillTable("qualityTable", bottles.slice(0, 30).map(qualityRowTable), 8, "Belum ada data botol.");

    // Update Traceability table jika tidak sedang mengetik pencarian
    if (!($("traceSearch")?.value || "").trim()) {
        fillTable("traceTable", bottles.map(qualityRowTable), 8, "Belum ada data botol.");
    }

    // 8. Arsip Batch & Laporan
    renderBatchHistory(batchList);
    renderReportPage({ status, summary }, oeeCalc);

    // 9. Timeline bar
    if (oeeCalc.plannedTime && oeeCalc.plannedTime > 0) {
        const runPct = oeeCalc.operatingTime !== null && oeeCalc.operatingTime > 0 ? pct(oeeCalc.operatingTime, oeeCalc.plannedTime) : 0;
        const downPct = oeeCalc.downtimeUnplanned !== null && oeeCalc.downtimeUnplanned > 0 ? pct(oeeCalc.downtimeUnplanned, oeeCalc.plannedTime) : 0;
        const warnPct = Math.max(0, 100 - (runPct + downPct));
        setWidth("runningBar", runPct);
        setWidth("warningBar", warnPct);
        setWidth("downtimeBar", downPct);
        setText("runningPercentage", `🟢 Berjalan (${runPct}%)`);
        setText("warningPercentage", `🟠 Peringatan / Idle (${warnPct}%)`);
        setText("downtimePercentage", `🔴 Downtime (${downPct}%)`);
    } else {
        setWidth("runningBar", 0);
        setWidth("warningBar", 0);
        setWidth("downtimeBar", 0);
        setText("runningPercentage", "🟢 Berjalan (--%)");
        setText("warningPercentage", "🟠 Peringatan / Starving (--%)");
        setText("downtimePercentage", "🔴 Downtime (--%)");
    }

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
console.log("MPB-01 MES Dashboard dimuat. Base API:", apiBase || REMOTE_API, "Mesin:", MACHINE_ID);
