/* =================================
   0. KONFIGURASI API
   Bisa ditimpa dari index.html sebelum script.js dimuat, mis.:
   <script>window.MES_MACHINE_ID = "mesin-01";</script>
================================= */

const REMOTE_API = "https://filling-machine-api.zamazzam.me";
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
// Lokal: lewat dev_server.py (proxy, menghindari CORS). Di server asli: langsung ke API.
const API_BASE = (window.MES_API_BASE || (IS_LOCAL ? location.origin : REMOTE_API)).replace(/\/$/, "");
const MACHINE_ID = window.MES_MACHINE_ID || "mesin-01";
const API_KEY = window.MES_API_KEY || "";           // kosong = header X-Api-Key tidak dikirim
const PREFIX_CANDIDATES = window.MES_API_PREFIX ? [window.MES_API_PREFIX] : ["/api", "/api/v1"];
const POLL_MS = 4000;
const STALE_MS = 30000;                              // telemetri lebih tua dari ini = mesin dianggap terputus

// Dipakai bila konfigurasi mesin dari API tidak memuat angkanya
const STATIC = {
    target: Number(window.MES_TARGET) || 100,                  // target botol per sesi
    boxCap: Number(window.MES_BOX_CAPACITY) || 12,             // kapasitas botol per kotak
    palletCap: Number(window.MES_PALLET_CAPACITY) || null,     // null = ikut jumlah sisa peti tertinggi
};

let apiPrefix = null;
let cfg = null;            // konfigurasi mesin (diambil sekali)
let lastBottles = [];
let traceTimer = null;

const $ = id => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const setColor = (id, c) => { const el = $(id); if (el) el.style.color = c; };
const setWidth = (id, p) => { const el = $(id); if (el) el.style.width = Math.max(0, Math.min(100, p || 0)) + "%"; };

const GREEN = "#16a34a", RED = "#dc2626", ORANGE = "#ea580c", GREY = "#6b7280";

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const show = v => (v === null || v === undefined || Number.isNaN(v) ? "--" : v);

// Waktu dari API berformat UTC; tambahkan "Z" bila tidak ada zona waktu
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
    return new Date(ms).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
}

function fmtDur(sec) {
    sec = Math.round(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}j ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

async function api(path, query) {
    const url = new URL(API_BASE + apiPrefix + path);
    Object.entries(query || {}).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
    const t0 = performance.now();
    const res = await fetch(url, API_KEY ? { headers: { "X-Api-Key": API_KEY } } : undefined);
    if (!res.ok) {
        const err = new Error("HTTP " + res.status);
        err.status = res.status;
        throw err;
    }
    return { data: await res.json(), ms: Math.round(performance.now() - t0) };
}

// Cari prefix yang benar (/api atau /api/v1) lewat endpoint health
async function getHealth() {
    let lastErr;
    for (const prefix of apiPrefix ? [apiPrefix] : PREFIX_CANDIDATES) {
        apiPrefix = prefix;
        try { return await api("/health"); } catch (err) { lastErr = err; }
    }
    apiPrefix = null;
    throw lastErr;
}

// Bentuk respons status/event/botol tidak ditentukan skema; terima objek langsung atau dibungkus
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
    for (const key of ["data", "items", "botol", "event", "events", "hasil"]) {
        if (body && Array.isArray(body[key])) return body[key];
    }
    return [];
}

// Cari angka di konfigurasi mesin berdasarkan pola nama field
function findNum(obj, re) {
    let found = null;
    (function walk(o) {
        if (found !== null || !o || typeof o !== "object") return;
        for (const [k, v] of Object.entries(o)) {
            if (typeof v === "number" && re.test(k)) { found = v; return; }
            if (v && typeof v === "object") walk(v);
        }
    })(obj);
    return found;
}

function limitsOf(s) {
    const slots = findNum(cfg, /jumlah_slot/i) ?? 10;   // botol per peti = jumlah slot turret
    const petiCap = findNum(cfg, /kapasitas.*peti|peti.*(kapasitas|maks|awal|total)/i);
    return {
        target: findNum(cfg, /target/i) ?? STATIC.target,
        box: Math.max(findNum(cfg, /kapasitas.*kotak|kotak.*(kapasitas|maks)/i) ?? STATIC.boxCap, s.isi_kotak || 0),
        slots,
        // kapasitas peti dalam satuan peti; sisa_peti dari API dalam satuan botol
        peti: petiCap ?? STATIC.palletCap ?? (Math.ceil((s.sisa_peti || 0) / slots) || null),
    };
}


/* =================================
   1. SIDEBAR COLLAPSE / EXPAND
================================= */

const dashboard = document.getElementById("dashboard");
const toggleButton = document.getElementById("toggleSidebar");

function toggleSidebar() {
    dashboard.classList.toggle("collapsed");
}

toggleButton.addEventListener("click", toggleSidebar);


/* =================================
   2. NAVIGASI HALAMAN SIDEBAR
================================= */

const navLinks = document.querySelectorAll(".nav-link");
const pages = document.querySelectorAll(".page");

navLinks.forEach(link => {
    link.addEventListener("click", function () {
        const selectedPage = this.dataset.page;

        navLinks.forEach(item => item.classList.remove("active"));
        this.classList.add("active");

        pages.forEach(page => page.classList.remove("active"));
        const targetPage = document.getElementById("page-" + selectedPage);
        if (targetPage) targetPage.classList.add("active");

        window.scrollTo({ top: 0, behavior: "smooth" });
    });
});


/* =================================
   3. TOMBOL TURRET (API belum punya endpoint kontrol mesin)
================================= */

function inchTurret() {
    alert("Perintah Inching belum tersedia: API belum memiliki endpoint kontrol mesin.");
}

function resetTurret() {
    alert("Reset Posisi Nol belum tersedia: API belum memiliki endpoint kontrol mesin.");
}


/* =================================
   4. TABEL & PENCARIAN
================================= */

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
            td.textContent = text;   // textContent: aman dari injeksi HTML
            if (text === "OK") td.style.color = GREEN;
            else if (text === "TIDAK_PENUH" || text === "TANPA_TUTUP" || text.startsWith("estop_tekan")) td.style.color = RED;
            tr.appendChild(td);
        });
        body.appendChild(tr);
    });
}

const CYCLE_KEYS = ["durasi_siklus_detik", "durasi_detik", "durasi_siklus", "durasi"];

function cycleOf(b) {
    let d = CYCLE_KEYS.map(k => b[k]).find(v => typeof v === "number");
    if (d === undefined) d = (parseUTC(b.waktu_keluar) - parseUTC(b.waktu_masuk)) / 1000;
    return Number.isFinite(d) ? d.toFixed(1) + " s" : "--";
}

const noOf = b => "#" + String(b.nomor).padStart(5, "0");
const fillOf = b => (typeof b.level_isi === "number" ? Math.round(b.level_isi * 100) + "%" : "--");
const bottleRow = b => [noOf(b), show(b.slot), fillOf(b), b.status || "--", cycleOf(b)];
const qualityRow = b => [noOf(b), fillOf(b), b.status || "--", cycleOf(b)];
const eventRow = e => [
    fmtTime(e.waktu),
    e.jenis || "-",
    e.sumber || "-",
    [e.pesan, e.mode_sebelum && e.mode_sesudah ? `${e.mode_sebelum} → ${e.mode_sesudah}` : ""]
        .filter(Boolean).join(" · ") || e.pengguna || "-",
];

// Filter tabel Live (di sisi browser)
function searchBottle() {
    const input = ($("bottleSearch").value || "").toLowerCase();
    document.querySelectorAll("#bottleTable tr").forEach(row => {
        row.style.display = row.textContent.toLowerCase().includes(input) ? "" : "none";
    });
}

// Pencarian Traceability: ke API (parameter nomor), mencakup semua sesi
async function searchTrace() {
    const digits = ($("traceSearch").value || "").replace(/\D/g, "");
    if (!digits) {
        fillTable("traceTable", lastBottles.map(bottleRow), 5, "Belum ada data botol.");
        setText("traceInfo", `${lastBottles.length} botol terakhir sesi ini. Ketik nomor untuk mencari.`);
        return;
    }
    try {
        const { data } = await api(`/mesin/${encodeURIComponent(MACHINE_ID)}/botol`, { nomor: String(Number(digits)) });
        const list = unwrapList(data);
        fillTable("traceTable", list.map(bottleRow), 5, "Botol tidak ditemukan.");
        setText("traceInfo", `${list.length} hasil untuk nomor ${Number(digits)}.`);
    } catch (err) {
        setText("traceInfo", "Gagal mencari botol.");
    }
}

$("bottleSearch").addEventListener("input", searchBottle);
$("traceSearch").addEventListener("input", () => {
    clearTimeout(traceTimer);
    traceTimer = setTimeout(searchTrace, 300);
});


/* =================================
   5. DARK MODE
================================= */

function toggleTheme() {
    document.body.classList.toggle("dark-mode");
    $("themeToggle").textContent = document.body.classList.contains("dark-mode") ? "☾" : "☼";
}

$("themeToggle").addEventListener("click", toggleTheme);


/* =================================
   6. RENDER
================================= */

const MODE_COLOR = { Berjalan: GREEN, Siap: ORANGE, Mati: GREY, Darurat: RED };
const MODE_BUCKET = { Berjalan: "running", Darurat: "down" };   // Siap & Mati = peringatan
const GPIO_MAP = [["Step", "step"], ["Dir", "dir"], ["Enable", "en"], ["Pump", "pompa"],
["Buzzer", "buzzer"], ["IR", "ir"], ["Start", "start"], ["Limit", "limit"]];
const FAIL_LABEL = { TIDAK_PENUH: "Kurang isi", TANPA_TUTUP: "Tanpa tutup" };

function setIndicator(id, on) {
    const el = $(id);
    if (!el) return;
    el.classList.toggle("inactive", !on);
    el.classList.toggle("active", on);
    el.style.background = on ? GREEN : "";
}

// Donut CSS (conic-gradient); aman bila elemen donut tidak ada di HTML
function setDonut(id, parts) {
    const el = $(id);
    if (!el) return;
    const total = parts.reduce((sum, p) => sum + (p[0] || 0), 0);
    if (!total) { el.style.background = ""; return; }
    let acc = 0;
    const stops = parts.map(([v, c]) => {
        const from = (acc / total) * 100;
        acc += v || 0;
        return `${c} ${from}% ${(acc / total) * 100}%`;
    });
    el.style.background = `conic-gradient(${stops.join(",")})`;
}

// Durasi per mode dari event yang memuat mode_sesudah
function modeDurations(events, endMs) {
    const points = events
        .filter(e => e.mode_sesudah && parseUTC(e.waktu))
        .map(e => ({ t: parseUTC(e.waktu), mode: e.mode_sesudah }))
        .sort((a, b) => a.t - b.t);
    if (!points.length) return null;

    const acc = { running: 0, warning: 0, down: 0 };
    points.forEach((p, i) => {
        const next = i + 1 < points.length ? points[i + 1].t : Math.max(endMs, p.t);
        acc[MODE_BUCKET[p.mode] || "warning"] += (next - p.t) / 1000;
    });
    acc.start = points[0].t;
    acc.end = Math.max(endMs, points[points.length - 1].t);
    return acc;
}

function renderMachine(s, online, hasData, lastMs) {
    const mode = s.darurat ? "Darurat" : s.mode || "Mati";
    const label = !hasData ? "TIDAK ADA DATA" : online ? mode.toUpperCase() : "TERPUTUS";
    const color = !hasData || !online ? GREY : MODE_COLOR[mode] || GREY;
    const sesi = s.sesi_id ? String(s.sesi_id) : "--";
    const tahap = hasData ? (/^\d+$/.test(String(s.tahap)) ? "Tahap " + s.tahap : show(s.tahap)) : "Menunggu data mesin";

    setText("operatorName", s.pengguna || "--");
    setText("operatorShift", "SESI " + sesi.slice(0, 14));
    setText("shiftInfo", "◷ Sesi: " + sesi.slice(0, 18));
    setText("simulationStatus", online ? "LIVE DATA" : hasData ? "DATA LAMA" : "NO DATA");
    setText("machineStatus", "● " + label);
    setColor("machineStatus", color);
    setText("activeProcess", tahap);
    setText("machineTask", !hasData ? "--" : online
        ? s.operator_tugas || (s.langkah != null ? "Langkah " + s.langkah : "--")
        : "Telemetri terakhir: " + fmtDateTime(lastMs));
    setText("batchNumber", "Sesi: " + sesi);
    setText("downtimeMachineStatus", label);
    setColor("downtimeMachineStatus", color);

    const mcb = s.mcb || {};
    [["mcbMain", "utama", "Utama"], ["mcbMachine", "mesin", "Mesin"],
    ["mcbControl", "kontrol", "Kontrol"], ["mcbLamp", "lampu", "Lampu"]].forEach(([id, key, name]) => {
        const on = mcb[key];
        setText(id, `● ${on === undefined ? "--" : on ? "ON" : "OFF"} ${name}`);
        setColor(id, on ? GREEN : on === false ? RED : "");
    });

    const gpio = s.gpio || {};
    GPIO_MAP.forEach(([name, key]) => {
        const on = !!gpio[key];
        setText("gpio" + name, hasData ? (on ? "ON" : "OFF") : "MENUNGGU DATA");
        setIndicator("indicator" + name, hasData && on);
    });
    setText("busVoltage", "-- V DC");   // tidak ada di API
}

function renderTurret(s, hasData) {
    const angle = hasData ? Number(s.sudut_turret_deg) || 0 : null;
    setText("turretAngle", angle === null ? "--°" : Math.round(angle) + "°");
    setText("turretSync", "--");
    setText("servoTorque", "-- Nm");
    setText("servoRPM", "--");
    setText("homingStatus", "● Homing Index: tidak tersedia di API");

    const active = angle === null ? 0 : (Math.round((angle % 360) / 36) % 10) + 1;
    for (let i = 1; i <= 10; i++) {
        const el = document.querySelector(".station.s" + i);
        if (!el) continue;
        el.classList.remove("filled");   // isi per slot tidak ada di API
        el.classList.toggle("active-station", i === active);
    }
}

function renderProduction(s, sum, lim) {
    const total = sum ? sum.jumlah_botol : s.botol_selesai;
    const avg = sum ? sum.rata_rata_waktu_siklus_detik : 0;
    const percent = pct(total, lim.target);
    const rate = avg > 0 ? Math.round(3600 / avg) : null;

    setText("totalProduction", show(total));
    setText("productionTarget", lim.target);
    setText("prodTarget", lim.target);
    setText("productionRate", rate === null ? "-- bph" : rate + " bph");
    setText("productionPercentage", percent === null ? "Shift: --" : `Shift: ${percent}%`);

    const boxPct = pct(s.isi_kotak, lim.box);
    setText("boxFilled", show(s.isi_kotak));
    setText("boxCapacity", lim.box);
    setWidth("boxProgress", boxPct);
    setText("boxPercentage", boxPct === null ? "--% terisi" : Math.round(boxPct) + "% terisi");
    setText("boxNumber", s.botol_selesai != null && lim.box ? "Kotak: #" + (Math.floor(s.botol_selesai / lim.box) + 1) : "Kotak: --");

    const petiPct = lim.peti ? pct(s.sisa_peti, lim.peti * lim.slots) : null;   // persen dihitung dari botol
    setText("palletRemaining", s.sisa_peti == null ? "--" : Math.ceil(s.sisa_peti / lim.slots));   // peti yang masih berisi
    setText("palletCapacity", show(lim.peti));
    setWidth("palletProgress", petiPct);
    setText("palletPercentage", petiPct === null ? "--% sisa" : Math.round(petiPct) + "% sisa");

    setText("prodTotal", show(total));
    setText("prodRemaining", total == null ? "--" : Math.max(lim.target - total, 0));
    setText("prodPercentage", percent === null ? "--" : percent + "%");
    setWidth("prodProgress", percent);
    setText("prodDescription", total == null ? "Belum ada data produksi."
        : `${total} botol selesai pada sesi ini dari target ${lim.target}.`);
    setText("productionMachineInfo",
        `Mesin ${MACHINE_ID} · Operator ${s.pengguna || "--"} · Waktu siklus rata-rata ${avg ? avg.toFixed(1) + " s" : "--"}`);
}

function failText(cats) {
    return Object.entries(cats || {}).filter(([, n]) => n > 0)
        .map(([k, n]) => `${FAIL_LABEL[k] || k} ${n}`).join(" · ");
}

function renderQuality(sum) {
    const total = sum ? sum.jumlah_botol : null;
    const bad = sum ? sum.botol_gagal : null;
    const good = total === null ? null : total - bad;
    const yieldPct = total ? pct(good, total) : null;
    const cats = sum ? failText(sum.kategori_kegagalan) : "";

    setText("qualityYield", yieldPct === null ? "--" : yieldPct);
    setText("rejectCount", "Reject: " + show(bad));
    setText("volumeTolerance", cats || (sum ? "Tanpa kegagalan" : "--"));
    setText("qualityPageYield", yieldPct === null ? "--" : yieldPct + "%");
    setText("qualityGood", show(good));
    setText("qualityReject", show(bad));
    setText("qualityTolerance", cats || "--");
    setDonut("donutQuality", [[good || 0, "#7b82d4"], [bad || 0, "#f0707f"]]);
    setText("donutQualityValue", yieldPct === null ? "--%" : yieldPct + "%");
}

function renderDowntime(dt, sum, events, modes) {
    const total = dt ? dt.total_durasi_downtime_detik : sum ? sum.total_durasi_darurat_detik : null;
    const count = dt ? dt.jumlah_kejadian_downtime : events.filter(e => e.jenis === "estop_tekan").length;
    const span = modes ? modes.running + modes.warning + modes.down : 0;

    setText("totalDowntime", "Total Downtime: " + (total === null ? "--" : fmtDur(total)));
    setText("downtimeTotal", total === null ? "--" : fmtDur(total));
    setText("downtimeMTBF", modes && count ? fmtDur(modes.running / count) : "—");
    setText("downtimeRate", total !== null && span ? pct(total, span) + "%" : "--");

    const run = span ? pct(modes.running, span) : 0;
    const warn = span ? pct(modes.warning, span) : 0;
    const down = span ? pct(modes.down, span) : 0;
    setWidth("runningBar", run);
    setWidth("warningBar", warn);
    setWidth("downtimeBar", down);
    setText("runningPercentage", `🟢 Berjalan (${span ? run : "--"}%)`);
    setText("warningPercentage", `🟠 Peringatan (${span ? warn : "--"}%)`);
    setText("downtimePercentage", `🔴 Downtime (${span ? down : "--"}%)`);
    setText("shiftStart", modes ? fmtTime(new Date(modes.start).toISOString()) : "--:--");
    setText("shiftEnd", modes ? fmtTime(new Date(modes.end).toISOString()) : "--:--");
    setDonut("donutTime", [[run, "#5b61b8"], [warn, "#f2b46d"], [down, "#f0707f"]]);
    setText("donutTimeValue", span ? run + "%" : "--%");
}

function renderTables(events, bottles) {
    const rows = events.map(eventRow);
    fillTable("eventTable", rows.slice(0, 8), 4, "Belum ada event.");
    fillTable("downtimeTable", rows.slice(0, 50), 4, "Belum ada riwayat event.");
    setText("eventInfo", `${Math.min(rows.length, 8)} dari ${rows.length} event terakhir · diperbarui ${new Date().toLocaleTimeString("en-GB")}`);

    fillTable("bottleTable", bottles.slice(0, 10).map(bottleRow), 5, "Belum ada data botol.");
    setText("bottleInfo", `${Math.min(bottles.length, 10)} botol terakhir sesi ini`);
    searchBottle();
    fillTable("qualityTable", bottles.map(qualityRow), 4, "Belum ada data kualitas.");

    $("bottleSearch").disabled = false;
    $("traceSearch").disabled = false;
    if (!$("traceSearch").value.trim()) searchTrace();   // jangan menimpa hasil pencarian yang sedang diketik
}

// Ambil angka terbesar yang tersedia (laporan & ringkasan bisa berbeda / terlambat sinkron)
const maxNum = (...v) => {
    const n = v.filter(x => typeof x === "number" && Number.isFinite(x));
    return n.length ? Math.max(...n) : null;
};

// Tabel laporan dibuat lewat JS memakai style tabel yang sudah ada (tanpa CSS/HTML baru)
function reportTable(title, headers, rows, emptyText) {
    const box = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = title;
    h.style.marginTop = "22px";
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    table.setAttribute("border", "1");        // garis kotak ala Excel (atribut HTML, bukan CSS)
    table.setAttribute("cellpadding", "8");

    const head = document.createElement("tr");
    headers.forEach(t => {
        const th = document.createElement("th");
        th.textContent = t;
        head.appendChild(th);
    });
    const thead = document.createElement("thead");
    thead.appendChild(head);

    const tbody = document.createElement("tbody");
    if (!rows.length) rows = [[emptyText].concat(Array(headers.length - 1).fill(""))];
    rows.forEach(cells => {
        const tr = document.createElement("tr");
        cells.forEach(c => {
            const td = document.createElement("td");
            td.textContent = String(c);
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });

    table.append(thead, tbody);
    wrap.appendChild(table);
    box.append(h, wrap);
    return box;
}

function renderReport(d, modes, info) {
    const s = d.status || {};
    const lap = d.laporan, sum = d.summary;
    const prod = lap ? lap.produksi : null;
    const kual = lap ? lap.kualitas : null;
    const down = lap ? lap.downtime : null;

    const total = maxNum(prod && prod.total_botol, sum && sum.jumlah_botol);
    const bad = maxNum(kual && kual.botol_gagal, sum && sum.botol_gagal);
    const good = total === null ? null : Math.max(total - (bad || 0), 0);
    const ok = total ? pct(good, total) : null;      // 0 botol -> belum ada persentase, bukan 0%
    const dur = maxNum(down && down.total_durasi_detik, sum && sum.total_durasi_darurat_detik);
    const events = down ? down.jumlah_kejadian : null;
    const avg = (prod && prod.rata_rata_waktu_siklus_detik) || (sum && sum.rata_rata_waktu_siklus_detik) || 0;
    const cats = (kual && kual.kategori_kegagalan) || (sum && sum.kategori_kegagalan) || {};
    const lim = limitsOf(s);
    const rate = avg > 0 ? Math.round(3600 / avg) : null;
    const target = total === null ? null : pct(total, lim.target);
    const span = modes ? modes.running + modes.warning + modes.down : 0;

    // Kartu ringkas (elemen yang sudah ada)
    setText("reportProduction", show(total));
    setText("reportQuality", ok === null ? "--%" : ok + "%");
    setText("reportReject", show(bad));
    setText("reportDowntime", dur === null ? "--" : fmtDur(dur));
    setText("reportDescription", total === null ? "Belum ada data laporan."
        : total === 0 ? `Sesi ${s.sesi_id || "--"} belum mencatat botol.` +
            (info.online ? "" : " Mesin tidak mengirim data; ini data terakhir yang tersimpan.")
            : `Sesi ${s.sesi_id || "--"}: ${total} botol diproduksi, ${good} OK, ${bad} reject.`);

    // Wadah tabel: dibuat sekali, di dalam panel laporan, sebelum tombol cetak
    const desc = $("reportDescription");
    let box = $("reportTables");
    if (!box) {
        box = document.createElement("div");
        box.id = "reportTables";
        desc.parentNode.insertBefore(box, desc.nextSibling);
    }

    const yn = v => (v === null || v === undefined ? "--" : v);
    const tables = [
        reportTable("Data Laporan", ["PARAMETER", "NILAI"], [
            ["Mesin", MACHINE_ID],
            ["Sesi", s.sesi_id || "--"],
            ["Operator", s.pengguna || "--"],
            ["Status data", info.label],
            ["Periode", modes ? `${fmtDateTime(modes.start)} – ${fmtDateTime(modes.end)}` : "--"],
            ["Dibuat", fmtDateTime(Date.now())],
        ], ""),
        reportTable("Produksi & Kualitas", ["PARAMETER", "NILAI"], [
            ["Target produksi", lim.target + " botol"],
            ["Total produksi", yn(total) + " botol"],
            ["Pencapaian target", target === null ? "--" : target + "%"],
            ["Botol OK", yn(good) + " botol"],
            ["Botol reject", yn(bad) + " botol"],
            ["Yield kualitas", ok === null ? "--" : ok + "%"],
            ["Waktu siklus rata-rata", avg ? avg.toFixed(1) + " detik" : "--"],
            ["Kapasitas aktual", rate === null ? "--" : rate + " botol/jam"],
        ], ""),
        reportTable("Rincian Reject", ["KATEGORI", "JUMLAH", "% DARI REJECT", "% DARI PRODUKSI"],
            Object.entries(cats).filter(([, n]) => n > 0)
                .map(([k, n]) => [FAIL_LABEL[k] || k, n, pct(n, bad) + "%", total ? pct(n, total) + "%" : "--"]),
            total ? "Tidak ada reject" : "Belum ada data"),
        reportTable("Downtime & Waktu Operasi", ["PARAMETER", "DURASI", "PERSEN"], [
            ["Total downtime", dur === null ? "--" : fmtDur(dur), span && dur !== null ? pct(dur, span) + "%" : "--"],
            ["Jumlah kejadian downtime", events != null ? events + " kali" : "--", ""],
            ...(span ? [
                ["Mode Berjalan", fmtDur(modes.running), pct(modes.running, span) + "%"],
                ["Mode Siap / Mati", fmtDur(modes.warning), pct(modes.warning, span) + "%"],
                ["Mode Darurat", fmtDur(modes.down), pct(modes.down, span) + "%"],
            ] : []),
        ], ""),
        reportTable("Event Terakhir", ["WAKTU", "JENIS", "SUMBER", "KETERANGAN"],
            d.events.slice(0, 10).map(eventRow), "Belum ada event"),
    ];
    box.replaceChildren(...tables);
}

function setConnection(apiOk, dbOk, ms, machineOnline, healthText) {
    const badge = $("apiConnection");
    badge.textContent = apiOk && dbOk ? "● LIVE" : "● OFFLINE";
    badge.style.color = apiOk && dbOk ? GREEN : RED;

    setText("apiSettingStatus", apiOk ? `Terhubung · ${ms} ms` : healthText || "Terputus");
    setText("databaseSettingStatus", apiOk ? (healthText || (dbOk ? "Terhubung" : "Terputus")) : "--");
    setText("apiLatency", apiOk ? ms + " ms" : "--");
    setText("plcStatus", !apiOk ? "API tidak terhubung" : machineOnline ? "Mesin terhubung" : "Mesin tidak mengirim data");
    setText("plcAddress", new URL(API_BASE).host);
    const dot = $("plcIndicator");
    if (dot) dot.style.background = machineOnline ? GREEN : RED;
    setText("lastUpdated", new Date().toLocaleTimeString("en-GB"));
}

function render(d) {
    const s = d.status || {};
    const hasData = !!d.status;
    const lastMs = parseUTC(s.diterima || s.waktu);
    const online = hasData && lastMs !== null && Date.now() - lastMs < STALE_MS;
    const modes = modeDurations(d.events, online ? Date.now() : lastMs || Date.now());

    renderMachine(s, online, hasData, lastMs);
    renderTurret(s, hasData);
    renderProduction(s, d.summary, limitsOf(s));
    renderQuality(d.summary);
    renderDowntime(d.downtime, d.summary, d.events, modes);
    lastBottles = d.bottles;
    renderTables(d.events, d.bottles);
    renderReport(d, modes, {
        online,
        label: online ? "Data langsung" : hasData ? "Data lama · " + fmtDateTime(lastMs) : "Tidak ada data",
    });

    const dbText = d.health.database;
    setConnection(true, /ok|connect|terhubung|sehat|up/i.test(String(dbText)), d.ms, online, dbText);
}


/* =================================
   7. PENGAMBILAN DATA & POLLING
================================= */

async function refresh() {
    let health;
    try {
        health = await getHealth();
    } catch (err) {
        setConnection(false, false, 0, false, IS_LOCAL
            ? "API tidak terjangkau. Jalankan dev_server.py lalu buka lewat port-nya (bukan Live Server)"
            : "Tidak dapat terhubung (cek alamat API / CORS)");
        return;
    }

    const id = encodeURIComponent(MACHINE_ID);
    if (!cfg) {
        try { cfg = (await api(`/mesin/${id}`)).data || {}; } catch (err) { cfg = {}; }
    }

    let status = null;
    try {
        status = unwrapObject((await api(`/mesin/${id}/status`)).data);   // 404 = belum ada telemetri
    } catch (err) { /* status tetap null */ }

    // Semua data dibatasi ke sesi telemetri terakhir agar sinkron dengan status
    const q = { sesi_id: status && status.sesi_id };
    const [sum, ev, bt, dt, lp] = await Promise.allSettled([
        api(`/mesin/${id}/ringkasan`, q),
        api(`/mesin/${id}/event`, { ...q, limit: 500 }),
        api(`/mesin/${id}/botol`, { ...q, limit: 50 }),
        api(`/mesin/${id}/downtime`, q),
        api(`/mesin/${id}/laporan`, q),
    ]);
    const val = r => (r.status === "fulfilled" ? r.value.data : null);

    render({
        health: health.data,
        ms: health.ms,
        status,
        summary: val(sum),
        events: ev.status === "fulfilled" ? unwrapList(ev.value.data) : [],
        bottles: bt.status === "fulfilled" ? unwrapList(bt.value.data) : [],
        downtime: val(dt),
        laporan: val(lp),
    });
}

function updateDate() {
    setText("currentDate", "▣ " + new Date().toLocaleDateString("id-ID", {
        weekday: "long", day: "numeric", month: "long", year: "numeric"
    }));
}

updateDate();
refresh();
setInterval(refresh, POLL_MS);
console.log("MPB-01 MES Dashboard berjalan. API:", API_BASE, "Mesin:", MACHINE_ID);