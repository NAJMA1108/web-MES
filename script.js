
/* =================================
   1. SIDEBAR COLLAPSE / EXPAND
================================= */

const dashboard = document.getElementById("dashboard");
const toggleButton = document.getElementById("toggleSidebar");

function toggleSidebar() {
    dashboard.classList.toggle("collapsed");
}

// Tombol hamburger
toggleButton.addEventListener("click", toggleSidebar);


/* =================================
   2. NAVIGASI HALAMAN SIDEBAR
================================= */

const navLinks = document.querySelectorAll(".nav-link");
const pages = document.querySelectorAll(".page");

navLinks.forEach(link => {

    link.addEventListener("click", function () {

        // Ambil nama halaman dari data-page
        const selectedPage = this.dataset.page;

        // Hilangkan status aktif dari semua menu
        navLinks.forEach(item => {
            item.classList.remove("active");
        });

        // Aktifkan menu yang dipilih
        this.classList.add("active");

        // Sembunyikan seluruh halaman
        pages.forEach(page => {
            page.classList.remove("active");
        });

        // Tampilkan halaman yang dipilih
        const targetPage = document.getElementById(
            "page-" + selectedPage
        );

        if (targetPage) {
            targetPage.classList.add("active");
        }

        // Kembali ke posisi atas
        window.scrollTo({
            top: 0,
            behavior: "smooth"
        });

    });

});


/* =================================
   3. SIMULASI TURret
================================= */

let turretAngle = 288;

function updateTurretAngle() {

    document.getElementById("turretAngle").textContent =
        turretAngle + "°";

}

function inchTurret() {

    turretAngle = (turretAngle + 36) % 360;

    updateTurretAngle();

}

function resetTurret() {

    turretAngle = 0;

    updateTurretAngle();

}


/* =================================
   4. PENCARIAN BOTOL DI LIVE
================================= */

function searchBottle() {

    const input = document.getElementById("bottleSearch")
        .value.toLowerCase();

    const rows = document.querySelectorAll(
        "#bottleTable tr"
    );

    rows.forEach(row => {

        const text = row.textContent.toLowerCase();

        row.style.display = text.includes(input)
            ? ""
            : "none";

    });

}


/* =================================
   5. PENCARIAN TRACEABILITY
================================= */

function searchTrace() {

    const input = document.getElementById("traceSearch")
        .value.toLowerCase();

    const rows = document.querySelectorAll(
        "#traceTable tr"
    );

    rows.forEach(row => {

        const text = row.textContent.toLowerCase();

        row.style.display = text.includes(input)
            ? ""
            : "none";

    });

}


/* =================================
   6. DARK MODE
================================= */

function toggleTheme() {

    document.body.classList.toggle("dark-mode");

    const isDark = document.body.classList.contains(
        "dark-mode"
    );

    document.getElementById("themeToggle").textContent =
        isDark ? "☾" : "☼";

}

document.getElementById("themeToggle")
    .addEventListener("click", toggleTheme);


/* =================================
   7. INFORMASI KONSOL
================================= */

console.log("MPB-01 MES Dashboard berhasil dijalankan.");
console.log("Navigasi sidebar aktif.");
console.log("Sidebar collapse/expand aktif.");
console.log("Mode gelap aktif.");
