'use strict';

/* =========================================================
   TABUNGAN NIKAH BERSAMA — app.js
   Backend: Supabase (Auth + Postgres + Realtime)
   ========================================================= */

/* ---------------------------------------------------------
   0. SUPABASE CLIENT
   --------------------------------------------------------- */
const CONFIG = window.SUPABASE_CONFIG || {};
const CONFIG_IS_MISSING =
  !CONFIG.url ||
  !CONFIG.anonKey ||
  CONFIG.url.includes('YOUR-PROJECT-REF') ||
  CONFIG.anonKey.includes('YOUR-ANON-PUBLIC-KEY');

let supabaseClient = null;
if (!CONFIG_IS_MISSING && window.supabase && typeof window.supabase.createClient === 'function') {
  supabaseClient = window.supabase.createClient(CONFIG.url, CONFIG.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}

/* ---------------------------------------------------------
   1. KONSTANTA
   --------------------------------------------------------- */
const WEDDING_DATE = new Date('2027-12-04T00:00:00');
const SETTINGS_ROW_ID = 1;
const SAFETY_POLL_MS = 20000; // fallback polling kalau realtime terputus
const NET_TIMEOUT_MS = 10000; // batas waktu semua panggilan jaringan (data & auth)
const BOOT_WATCHDOG_MS = 12000; // pengaman: layar boot tidak boleh macet melebihi ini

/* ---------------------------------------------------------
   2. STATE APLIKASI
   --------------------------------------------------------- */
let transactions = [];
let targetAmount = 0;
let activeTab = 'gabungan';               // 'pria' | 'wanita' | 'gabungan'
let jenisFilter = 'semua';                // 'semua' | 'pendapatan' | 'pengeluaran'
let kategoriPengeluaranFilter = 'semua';  // 'semua' | 'Kebutuhan' | 'Keinginan'
let editingId = null;
let pendingDeleteId = null;
let currentSession = null;
let dashboardBooted = false;
let realtimeChannel = null;
let safetyPollTimer = null;
let realtimeConnected = false;
let bootSettled = false;

/* ---------------------------------------------------------
   3. ELEMEN DOM
   --------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const bootLoader = $('bootLoader');
const loginScreen = $('loginScreen');
const dashboardScreen = $('dashboardScreen');
const loginForm = $('loginForm');
const loginEmail = $('loginEmail');
const loginPassword = $('loginPassword');
const loginError = $('loginError');
const loginSubmitBtn = $('loginSubmitBtn');
const togglePasswordBtn = $('togglePassword');
const logoutBtn = $('logoutBtn');

const editTargetBtn = $('editTargetBtn');
const targetDisplay = $('targetDisplay');
const targetForm = $('targetForm');
const targetInput = $('targetInput');
const cancelTargetBtn = $('cancelTargetBtn');
const saveTargetBtn = $('saveTargetBtn');

const progressFill = $('progressFill');
const progressPercent = $('progressPercent');
const progressLabel = $('progressLabel');

const sumTotal = $('sumTotal');
const sumRemaining = $('sumRemaining');
const sumPria = $('sumPria');
const sumWanita = $('sumWanita');

const tabButtons = document.querySelectorAll('.tab-btn');
const filterJenis = $('filterJenis');
const filterKategoriPengeluaran = $('filterKategoriPengeluaran');

const tableTitle = $('tableTitle');
const tableCount = $('tableCount');
const txTableBody = $('txTableBody');
const emptyState = $('emptyState');
const loadingState = $('loadingState');

const fabAdd = $('fabAdd');
const modalOverlay = $('modalOverlay');
const modalTitle = $('modalTitle');
const closeModalBtn = $('closeModalBtn');
const cancelModalBtn = $('cancelModalBtn');
const txForm = $('txForm');
const txId = $('txId');
const kategoriPendapatanWrap = $('kategoriPendapatanWrap');
const kategoriPengeluaranWrap = $('kategoriPengeluaranWrap');
const kategoriPendapatanInput = $('kategoriPendapatanInput');
const kategoriPengeluaranInput = $('kategoriPengeluaranInput');
const nominalInput = $('nominalInput');
const tanggalInput = $('tanggalInput');
const keteranganInput = $('keteranganInput');
const submitTxBtn = $('submitTxBtn');

const confirmOverlay = $('confirmOverlay');
const cancelDeleteBtn = $('cancelDeleteBtn');
const confirmDeleteBtn = $('confirmDeleteBtn');

const toastEl = $('toast');
let toastTimer = null;

/* ---------------------------------------------------------
   4. UTILITAS UMUM
   --------------------------------------------------------- */
function formatRupiah(number) {
  const n = Number(number) || 0;
  return 'Rp ' + n.toLocaleString('id-ID', { maximumFractionDigits: 0 });
}

function parseRupiahInput(str) {
  const digits = String(str || '').replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

function formatNumberLive(str) {
  const digits = String(str || '').replace(/\D/g, '');
  return digits ? Number(digits).toLocaleString('id-ID') : '';
}

function formatTanggalDisplay(isoDate) {
  if (!isoDate) return '-';
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

function todayISO() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}

// Sanitasi output: selalu lewat textContent, tidak pernah menaruh input
// pengguna langsung ke innerHTML tanpa escape.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function showToast(message, isError) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.toggle('toast-error', !!isError);
  toastEl.hidden = false;
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, isError ? 3200 : 2200);
}

// Terjemahkan pesan error Supabase yang umum ke Bahasa Indonesia yang
// ramah pengguna. Error asli tetap dicatat ke console untuk debugging.
function friendlyErrorMessage(error, fallback) {
  const msg = (error && error.message) || '';
  if (String(msg).startsWith('TIMEOUT')) return 'Koneksi ke server lambat atau terputus. Periksa jaringan Anda dan coba lagi.';
  if (/invalid login credentials/i.test(msg)) return 'Email atau kata sandi salah.';
  if (/email not confirmed/i.test(msg)) return 'Email belum dikonfirmasi. Cek kotak masuk email Anda.';
  if (/failed to fetch/i.test(msg) || /networkerror/i.test(msg)) return 'Tidak ada koneksi internet. Periksa jaringan Anda.';
  if (/row-level security/i.test(msg) || /permission denied/i.test(msg)) return 'Anda tidak memiliki izin untuk melakukan aksi ini.';
  if (/jwt|token/i.test(msg) && /expired|invalid/i.test(msg)) return 'Sesi Anda berakhir. Silakan masuk kembali.';
  return fallback || 'Terjadi kesalahan. Silakan coba lagi.';
}

function logAndToastError(context, error, fallback) {
  console.error(`[TabunganNikah] ${context}:`, error);
  showToast(friendlyErrorMessage(error, fallback), true);
}

/* ---------------------------------------------------------
   5. KONFIGURASI HILANG — TAMPILKAN PESAN JELAS
   --------------------------------------------------------- */
function renderConfigMissing() {
  bootSettled = true;
  bootLoader.hidden = false;
  bootLoader.textContent = '';
  const box = document.createElement('div');
  box.style.maxWidth = '420px';
  box.style.textAlign = 'center';
  box.style.padding = '0 20px';
  box.innerHTML = `
    <p style="font-weight:700;margin-bottom:8px;">Supabase belum dikonfigurasi</p>
    <p style="color:var(--color-text-muted);font-size:0.88rem;">
      Buka file <code>config.js</code>, isi <code>url</code> dan <code>anonKey</code>
      dengan nilai dari project Supabase Anda. Lihat <code>SETUP.md</code> untuk panduan lengkap.
    </p>`;
  bootLoader.appendChild(box);
}

// Tampilkan pesan error di layar boot lengkap dengan tombol "Coba Lagi",
// supaya aplikasi TIDAK PERNAH macet selamanya di "Memuat…".
function showBootError(message) {
  bootSettled = true;
  bootLoader.hidden = false;
  bootLoader.textContent = '';
  const box = document.createElement('div');
  box.style.maxWidth = '380px';
  box.style.textAlign = 'center';
  box.style.padding = '0 20px';
  const msg = document.createElement('p');
  msg.style.fontWeight = '600';
  msg.style.marginBottom = '16px';
  msg.textContent = message;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-primary';
  retry.textContent = 'Coba Lagi';
  retry.addEventListener('click', () => location.reload());
  box.append(msg, retry);
  bootLoader.appendChild(box);
}

// Pengaman global: jika app masih juga belum memutuskan menampilkan
// login/dashboard/error dalam BOOT_WATCHDOG_MS, tampilkan pesan + tombol
// coba lagi. Menutup semua kemungkinan "hang" yang tak tertangkap.
function armBootWatchdog() {
  setTimeout(() => {
    if (!bootSettled) {
      console.error('[TabunganNikah] Boot watchdog: app tidak selesai dimuat dalam batas waktu.');
      showBootError('Aplikasi tidak dapat selesai dimuat. Periksa koneksi internet Anda, lalu coba lagi.');
    }
  }, BOOT_WATCHDOG_MS);
}

/* ---------------------------------------------------------
   6. AUTENTIKASI (Supabase Auth)
   --------------------------------------------------------- */
function showLoginScreen() {
  bootSettled = true;
  bootLoader.hidden = true;
  dashboardScreen.hidden = true;
  loginScreen.hidden = false;
  teardownDashboard();
}

function showDashboardScreen() {
  bootSettled = true;
  bootLoader.hidden = true;
  loginScreen.hidden = true;
  dashboardScreen.hidden = false;
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  loginError.hidden = true;
  const email = loginEmail.value.trim();
  const password = loginPassword.value;

  if (!email || !password) {
    loginError.textContent = 'Isi email dan kata sandi.';
    loginError.hidden = false;
    return;
  }

  loginSubmitBtn.disabled = true;
  loginSubmitBtn.textContent = 'Memproses…';

  try {
    const { error } = await withTimeout(
      supabaseClient.auth.signInWithPassword({ email, password }),
      NET_TIMEOUT_MS,
      'signIn'
    );
    if (error) {
      loginError.textContent = friendlyErrorMessage(error, 'Gagal masuk. Silakan coba lagi.');
      loginError.hidden = false;
      console.error('[TabunganNikah] signInWithPassword:', error);
      return;
    }
    // Sukses: onAuthStateChange akan menangani transisi ke dashboard.
    loginForm.reset();
  } catch (err) {
    loginError.textContent = friendlyErrorMessage(err, 'Gagal masuk. Silakan coba lagi.');
    loginError.hidden = false;
    console.error('[TabunganNikah] signInWithPassword (exception):', err);
  } finally {
    loginSubmitBtn.disabled = false;
    loginSubmitBtn.textContent = 'Masuk';
  }
}

async function handleLogout() {
  logoutBtn.disabled = true;
  try {
    const { error } = await withTimeout(supabaseClient.auth.signOut(), NET_TIMEOUT_MS, 'signOut');
    if (error) {
      logAndToastError('signOut', error, 'Gagal keluar. Coba lagi.');
    }
    // onAuthStateChange akan menampilkan layar login setelah SIGNED_OUT.
  } finally {
    logoutBtn.disabled = false;
  }
}

if (togglePasswordBtn) {
  togglePasswordBtn.addEventListener('click', () => {
    const isPassword = loginPassword.type === 'password';
    loginPassword.type = isPassword ? 'text' : 'password';
    togglePasswordBtn.textContent = isPassword ? 'Sembunyikan' : 'Tampilkan';
  });
}

/* ---------------------------------------------------------
   7. AKSES DATA (Supabase Postgres)
   --------------------------------------------------------- */
async function fetchSettings() {
  const { data, error } = await withTimeout(
    supabaseClient
      .from('settings')
      .select('target_amount')
      .eq('id', SETTINGS_ROW_ID)
      .maybeSingle(),
    NET_TIMEOUT_MS,
    'fetchSettings'
  );

  if (error) throw error;
  return data ? Number(data.target_amount) || 0 : 0;
}

async function fetchTransactions() {
  const { data, error } = await withTimeout(
    supabaseClient
      .from('transactions')
      .select('id, penabung, jenis, kategori, nominal, tanggal, keterangan, created_at, updated_at')
      .order('tanggal', { ascending: false })
      .order('created_at', { ascending: false }),
    NET_TIMEOUT_MS,
    'fetchTransactions'
  );

  if (error) throw error;
  return data || [];
}

async function insertTransactionRemote(payload) {
  const { data, error } = await withTimeout(
    supabaseClient
      .from('transactions')
      .insert(payload)
      .select()
      .single(),
    NET_TIMEOUT_MS,
    'insertTransaction'
  );
  if (error) throw error;
  return data;
}

async function updateTransactionRemote(id, payload) {
  const { data, error } = await withTimeout(
    supabaseClient
      .from('transactions')
      .update(payload)
      .eq('id', id)
      .select()
      .single(),
    NET_TIMEOUT_MS,
    'updateTransaction'
  );
  if (error) throw error;
  return data;
}

async function deleteTransactionRemote(id) {
  const { error } = await withTimeout(
    supabaseClient
      .from('transactions')
      .delete()
      .eq('id', id),
    NET_TIMEOUT_MS,
    'deleteTransaction'
  );
  if (error) throw error;
}

async function updateTargetRemote(amount) {
  const { data, error } = await withTimeout(
    supabaseClient
      .from('settings')
      .update({ target_amount: amount })
      .eq('id', SETTINGS_ROW_ID)
      .select('target_amount')
      .single(),
    NET_TIMEOUT_MS,
    'updateTarget'
  );
  if (error) throw error;
  return Number(data.target_amount) || 0;
}

/* ---------------------------------------------------------
   8. COUNTDOWN TIMER
   --------------------------------------------------------- */
function updateCountdown() {
  const now = new Date();
  let diff = WEDDING_DATE.getTime() - now.getTime();
  if (diff < 0) diff = 0;

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const minutes = Math.floor((diff / (1000 * 60)) % 60);
  const seconds = Math.floor((diff / 1000) % 60);

  $('cdDays').textContent = String(days).padStart(2, '0');
  $('cdHours').textContent = String(hours).padStart(2, '0');
  $('cdMinutes').textContent = String(minutes).padStart(2, '0');
  $('cdSeconds').textContent = String(seconds).padStart(2, '0');
}

let countdownInterval = null;
function startCountdown() {
  updateCountdown();
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(updateCountdown, 1000);
}
function stopCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = null;
}

/* ---------------------------------------------------------
   9. TARGET DANA NIKAH (EDITABLE)
   --------------------------------------------------------- */
function renderTarget() {
  targetDisplay.textContent = formatRupiah(targetAmount);
}

editTargetBtn.addEventListener('click', () => {
  targetInput.value = targetAmount.toLocaleString('id-ID');
  targetDisplay.hidden = true;
  targetForm.hidden = false;
  targetInput.focus();
});

cancelTargetBtn.addEventListener('click', () => {
  targetForm.hidden = true;
  targetDisplay.hidden = false;
});

targetInput.addEventListener('input', (e) => {
  e.target.value = formatNumberLive(e.target.value);
});

targetForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = parseRupiahInput(targetInput.value);
  if (value <= 0) {
    showToast('Target harus lebih dari Rp 0', true);
    return;
  }

  saveTargetBtn.disabled = true;
  saveTargetBtn.textContent = 'Menyimpan…';
  try {
    const saved = await updateTargetRemote(value);
    targetAmount = saved;
    targetForm.hidden = true;
    targetDisplay.hidden = false;
    renderTarget();
    renderSummary();
    showToast('Target dana nikah diperbarui');
  } catch (error) {
    // Jangan ubah targetAmount lokal — database belum berhasil diperbarui.
    logAndToastError('updateTarget', error, 'Gagal menyimpan target. Coba lagi.');
  } finally {
    saveTargetBtn.disabled = false;
    saveTargetBtn.textContent = 'Simpan';
  }
});

/* ---------------------------------------------------------
   10. PERHITUNGAN RINGKASAN
   --------------------------------------------------------- */
function computeTotals() {
  let totalPria = 0;
  let totalWanita = 0;

  transactions.forEach((tx) => {
    const sign = tx.jenis === 'pendapatan' ? 1 : -1;
    const nominal = Number(tx.nominal) || 0;
    if (tx.penabung === 'pria') totalPria += sign * nominal;
    else if (tx.penabung === 'wanita') totalWanita += sign * nominal;
  });

  const total = totalPria + totalWanita;
  const remaining = Math.max(targetAmount - total, 0);
  return { totalPria, totalWanita, total, remaining };
}

function renderSummary() {
  const { totalPria, totalWanita, total, remaining } = computeTotals();

  sumTotal.textContent = formatRupiah(total);
  sumRemaining.textContent = formatRupiah(remaining);
  sumPria.textContent = formatRupiah(totalPria);
  sumWanita.textContent = formatRupiah(totalWanita);

  const percent = targetAmount > 0 ? Math.min((total / targetAmount) * 100, 100) : 0;
  const percentClamped = Math.max(percent, 0);
  progressFill.style.width = percentClamped.toFixed(1) + '%';
  progressPercent.textContent = percentClamped.toFixed(1) + '%';
  progressLabel.textContent = `${formatRupiah(total)} dari ${formatRupiah(targetAmount)}`;
}

/* ---------------------------------------------------------
   11. TAB SWITCHER
   --------------------------------------------------------- */
const TAB_LABELS = {
  pria: 'Tabungan Pria',
  wanita: 'Tabungan Wanita',
  gabungan: 'Tabungan Gabungan',
};

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    tabButtons.forEach((b) => {
      const isActive = b === btn;
      b.classList.toggle('is-active', isActive);
      b.setAttribute('aria-selected', String(isActive));
    });
    tableTitle.textContent = TAB_LABELS[activeTab];
    renderTable();
  });
});

/* ---------------------------------------------------------
   12. FILTER
   --------------------------------------------------------- */
filterJenis.addEventListener('change', () => {
  jenisFilter = filterJenis.value;
  const isPengeluaran = jenisFilter === 'pengeluaran';
  filterKategoriPengeluaran.disabled = !isPengeluaran;
  if (!isPengeluaran) {
    filterKategoriPengeluaran.value = 'semua';
    kategoriPengeluaranFilter = 'semua';
  }
  renderTable();
});

filterKategoriPengeluaran.addEventListener('change', () => {
  kategoriPengeluaranFilter = filterKategoriPengeluaran.value;
  renderTable();
});

/* ---------------------------------------------------------
   13. RENDER TABEL TRANSAKSI
   --------------------------------------------------------- */
function getFilteredTransactions() {
  return transactions
    .filter((tx) => (activeTab === 'gabungan' ? true : tx.penabung === activeTab))
    .filter((tx) => (jenisFilter === 'semua' ? true : tx.jenis === jenisFilter))
    .filter((tx) => {
      if (jenisFilter !== 'pengeluaran' || kategoriPengeluaranFilter === 'semua') return true;
      return tx.jenis === 'pengeluaran' && tx.kategori === kategoriPengeluaranFilter;
    })
    .sort((a, b) => (a.tanggal < b.tanggal ? 1 : a.tanggal > b.tanggal ? -1 : 0));
}

function renderTable() {
  loadingState.hidden = true;
  const list = getFilteredTransactions();
  tableCount.textContent = `${list.length} transaksi`;

  if (list.length === 0) {
    txTableBody.innerHTML = '';
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  // Semua nilai yang berasal dari input pengguna (kategori, keterangan)
  // di-escape lewat escapeHtml() sebelum dimasukkan ke innerHTML.
  txTableBody.innerHTML = list.map((tx) => {
    const penabungLabel = tx.penabung === 'pria' ? 'Pria' : 'Wanita';
    const penabungBadge = tx.penabung === 'pria' ? 'badge-pria' : 'badge-wanita';
    const jenisLabel = tx.jenis === 'pendapatan' ? 'Pendapatan' : 'Pengeluaran';
    const jenisBadge = tx.jenis === 'pendapatan' ? 'badge-pendapatan' : 'badge-pengeluaran';
    const nominalSign = tx.jenis === 'pendapatan' ? '+' : '-';
    const nominalColor = tx.jenis === 'pendapatan' ? 'var(--color-success)' : 'var(--color-danger)';
    const keterangan = tx.keterangan
      ? escapeHtml(tx.keterangan)
      : '<span style="color:var(--color-text-muted)">—</span>';

    return `
      <tr>
        <td data-label="Tanggal">${escapeHtml(formatTanggalDisplay(tx.tanggal))}</td>
        <td data-label="Oleh"><span class="badge ${penabungBadge}">${penabungLabel}</span></td>
        <td data-label="Jenis"><span class="badge ${jenisBadge}">${jenisLabel}</span></td>
        <td data-label="Kategori">${escapeHtml(tx.kategori || '-')}</td>
        <td data-label="Nominal" class="col-nominal" style="color:${nominalColor}">${nominalSign} ${escapeHtml(formatRupiah(tx.nominal))}</td>
        <td data-label="Keterangan" class="col-keterangan">${keterangan}</td>
        <td class="col-aksi">
          <div class="row-actions">
            <button type="button" class="action-btn edit-btn" data-id="${escapeHtml(tx.id)}">Edit</button>
            <button type="button" class="action-btn delete-btn" data-id="${escapeHtml(tx.id)}">Hapus</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  txTableBody.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => openEditModal(btn.dataset.id));
  });
  txTableBody.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => openDeleteConfirm(btn.dataset.id));
  });
}

/* ---------------------------------------------------------
   14. MODAL: TAMBAH / EDIT TRANSAKSI
   --------------------------------------------------------- */
function openAddModal() {
  editingId = null;
  modalTitle.textContent = 'Tambah Transaksi';
  txForm.reset();
  txId.value = '';
  kategoriPendapatanWrap.hidden = true;
  kategoriPengeluaranWrap.hidden = true;
  tanggalInput.value = todayISO();
  modalOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
}

function openEditModal(id) {
  const tx = transactions.find((t) => t.id === id);
  if (!tx) return;
  editingId = id;
  modalTitle.textContent = 'Edit Transaksi';
  txForm.reset();
  txId.value = tx.id;

  const penabungRadio = txForm.querySelector(`input[name="penabung"][value="${tx.penabung}"]`);
  if (penabungRadio) penabungRadio.checked = true;

  const jenisRadio = txForm.querySelector(`input[name="jenis"][value="${tx.jenis}"]`);
  if (jenisRadio) jenisRadio.checked = true;

  toggleKategoriFields(tx.jenis);
  if (tx.jenis === 'pendapatan') {
    kategoriPendapatanInput.value = tx.kategori || '';
  } else {
    kategoriPengeluaranInput.value = tx.kategori || '';
  }

  nominalInput.value = Number(tx.nominal).toLocaleString('id-ID');
  tanggalInput.value = tx.tanggal;
  keteranganInput.value = tx.keterangan || '';

  modalOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modalOverlay.hidden = true;
  document.body.style.overflow = '';
  editingId = null;
}

function toggleKategoriFields(jenis) {
  if (jenis === 'pendapatan') {
    kategoriPendapatanWrap.hidden = false;
    kategoriPengeluaranWrap.hidden = true;
    kategoriPengeluaranInput.value = '';
  } else if (jenis === 'pengeluaran') {
    kategoriPengeluaranWrap.hidden = false;
    kategoriPendapatanWrap.hidden = true;
    kategoriPendapatanInput.value = '';
  } else {
    kategoriPendapatanWrap.hidden = true;
    kategoriPengeluaranWrap.hidden = true;
  }
}

txForm.querySelectorAll('input[name="jenis"]').forEach((radio) => {
  radio.addEventListener('change', (e) => toggleKategoriFields(e.target.value));
});

nominalInput.addEventListener('input', (e) => {
  e.target.value = formatNumberLive(e.target.value);
});

fabAdd.addEventListener('click', openAddModal);
closeModalBtn.addEventListener('click', closeModal);
cancelModalBtn.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

txForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const penabungEl = txForm.querySelector('input[name="penabung"]:checked');
  const jenisEl = txForm.querySelector('input[name="jenis"]:checked');

  if (!penabungEl) { showToast('Pilih penabung terlebih dahulu (Pria/Wanita)', true); return; }
  if (!jenisEl) { showToast('Pilih jenis transaksi terlebih dahulu', true); return; }

  const jenis = jenisEl.value;
  let kategori = '';
  if (jenis === 'pendapatan') {
    kategori = kategoriPendapatanInput.value.trim();
    if (!kategori) { showToast('Isi kategori pendapatan', true); return; }
  } else {
    kategori = kategoriPengeluaranInput.value;
    if (!kategori) { showToast('Pilih kategori pengeluaran', true); return; }
  }

  const nominal = parseRupiahInput(nominalInput.value);
  if (nominal <= 0) { showToast('Nominal harus lebih dari Rp 0', true); return; }

  const tanggal = tanggalInput.value;
  if (!tanggal) { showToast('Isi tanggal transaksi', true); return; }

  const keterangan = keteranganInput.value.trim();

  const payload = {
    penabung: penabungEl.value,
    jenis,
    kategori,
    nominal,
    tanggal,
    keterangan: keterangan || null,
  };

  submitTxBtn.disabled = true;
  submitTxBtn.textContent = 'Menyimpan…';

  try {
    if (editingId) {
      const updated = await updateTransactionRemote(editingId, payload);
      const idx = transactions.findIndex((t) => t.id === editingId);
      if (idx !== -1) transactions[idx] = updated;
      else transactions.unshift(updated);
      showToast('Transaksi berhasil diperbarui');
    } else {
      const inserted = await insertTransactionRemote(payload);
      transactions.unshift(inserted);
      showToast('Transaksi berhasil ditambahkan');
    }

    closeModal();
    renderSummary();
    renderTable();
  } catch (error) {
    // State lokal TIDAK diubah karena operasi database gagal.
    logAndToastError(editingId ? 'updateTransaction' : 'insertTransaction', error,
      editingId ? 'Gagal menyimpan perubahan. Coba lagi.' : 'Gagal menyimpan transaksi. Coba lagi.');
  } finally {
    submitTxBtn.disabled = false;
    submitTxBtn.textContent = 'Simpan Transaksi';
  }
});

/* ---------------------------------------------------------
   15. HAPUS TRANSAKSI (dengan konfirmasi)
   --------------------------------------------------------- */
function openDeleteConfirm(id) {
  pendingDeleteId = id;
  confirmOverlay.hidden = false;
}

function closeDeleteConfirm() {
  pendingDeleteId = null;
  confirmOverlay.hidden = true;
}

cancelDeleteBtn.addEventListener('click', closeDeleteConfirm);
confirmOverlay.addEventListener('click', (e) => {
  if (e.target === confirmOverlay) closeDeleteConfirm();
});

confirmDeleteBtn.addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  const idToDelete = pendingDeleteId;

  confirmDeleteBtn.disabled = true;
  confirmDeleteBtn.textContent = 'Menghapus…';

  try {
    await deleteTransactionRemote(idToDelete);
    transactions = transactions.filter((t) => t.id !== idToDelete);
    closeDeleteConfirm();
    renderSummary();
    renderTable();
    showToast('Transaksi berhasil dihapus');
  } catch (error) {
    // Jangan hapus dari state lokal — database belum berhasil menghapus.
    logAndToastError('deleteTransaction', error, 'Gagal menghapus transaksi. Coba lagi.');
  } finally {
    confirmDeleteBtn.disabled = false;
    confirmDeleteBtn.textContent = 'Ya, Hapus';
  }
});

/* ---------------------------------------------------------
   16. REALTIME SYNC (Supabase Realtime, fallback polling)
   --------------------------------------------------------- */
function upsertLocalTransaction(row) {
  const idx = transactions.findIndex((t) => t.id === row.id);
  if (idx !== -1) transactions[idx] = row;
  else transactions.unshift(row);
}

function removeLocalTransaction(id) {
  transactions = transactions.filter((t) => t.id !== id);
}

function handleTransactionChange(payload) {
  if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
    upsertLocalTransaction(payload.new);
  } else if (payload.eventType === 'DELETE') {
    removeLocalTransaction(payload.old.id);
  }
  renderSummary();
  renderTable();
  updateSyncStatus();
}

function handleSettingsChange(payload) {
  if (payload.new && typeof payload.new.target_amount !== 'undefined') {
    targetAmount = Number(payload.new.target_amount) || 0;
    renderTarget();
    renderSummary();
  }
  updateSyncStatus();
}

function startRealtime() {
  stopRealtime();
  realtimeChannel = supabaseClient
    .channel('wn-shared-data')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, handleTransactionChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, handleSettingsChange)
    .subscribe((status) => {
      realtimeConnected = status === 'SUBSCRIBED';
      updateSyncStatus();
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        // Realtime bermasalah — safety-net polling tetap berjalan di bawah.
        console.warn('[TabunganNikah] Realtime status:', status);
      }
    });

  // Safety-net polling: jaga-jaga jika koneksi realtime terputus tanpa
  // memicu event, data tetap ter-sinkron dalam interval yang wajar.
  if (safetyPollTimer) clearInterval(safetyPollTimer);
  safetyPollTimer = setInterval(safetyPoll, SAFETY_POLL_MS);
}

function stopRealtime() {
  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  if (safetyPollTimer) {
    clearInterval(safetyPollTimer);
    safetyPollTimer = null;
  }
  realtimeConnected = false;
}

let safetyPollInFlight = false;
async function safetyPoll() {
  if (safetyPollInFlight) return;
  safetyPollInFlight = true;
  try {
    const [remoteTx, remoteTarget] = await withTimeout(
      Promise.all([fetchTransactions(), fetchSettings()]),
      NET_TIMEOUT_MS,
      'safetyPoll'
    );
    transactions = remoteTx;
    targetAmount = remoteTarget;
    renderTarget();
    renderSummary();
    renderTable();
    updateSyncStatus();
  } catch (error) {
    console.error('[TabunganNikah] safetyPoll:', error);
    // Tidak menampilkan toast di sini agar tidak mengganggu jika hanya
    // gangguan jaringan sesaat; status akan terlihat dari indikator sync.
  } finally {
    safetyPollInFlight = false;
  }
}

function updateSyncStatus() {
  const el = $('syncStatus');
  if (!el) return;
  const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  if (realtimeConnected) {
    el.textContent = `Realtime aktif · ${time}`;
    el.classList.remove('is-offline', 'is-connecting');
  } else {
    el.textContent = `Tersinkron ${time}`;
    el.classList.add('is-connecting');
    el.classList.remove('is-offline');
  }
}

/* ---------------------------------------------------------
   17. BOOTSTRAP / TEARDOWN DASHBOARD
   --------------------------------------------------------- */
async function bootDashboard() {
  if (dashboardBooted) return;
  dashboardBooted = true;

  loadingState.hidden = false;
  emptyState.hidden = true;
  txTableBody.innerHTML = '';

  try {
    const [settingsTarget, txList] = await withTimeout(
      Promise.all([fetchSettings(), fetchTransactions()]),
      NET_TIMEOUT_MS,
      'bootDashboard'
    );
    targetAmount = settingsTarget;
    transactions = txList;
  } catch (error) {
    logAndToastError('bootDashboard', error, 'Gagal memuat data. Periksa koneksi dan coba muat ulang halaman.');
    transactions = [];
    targetAmount = 0;
  }

  loadingState.hidden = true;
  renderTarget();
  renderSummary();
  renderTable();
  startCountdown();
  startRealtime();
  updateSyncStatus();
}

function teardownDashboard() {
  dashboardBooted = false;
  stopCountdown();
  stopRealtime();
  transactions = [];
  targetAmount = 0;
  activeTab = 'gabungan';
  jenisFilter = 'semua';
  kategoriPengeluaranFilter = 'semua';
  editingId = null;
  pendingDeleteId = null;
}

/* ---------------------------------------------------------
   18. INISIALISASI APLIKASI
   --------------------------------------------------------- */
function wireStaticListeners() {
  loginForm.addEventListener('submit', handleLoginSubmit);
  logoutBtn.addEventListener('click', handleLogout);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!modalOverlay.hidden) closeModal();
      if (!confirmOverlay.hidden) closeDeleteConfirm();
    }
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT:${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function initApp() {
  console.info('[TabunganNikah] initApp() mulai berjalan.');
  armBootWatchdog();

  if (CONFIG_IS_MISSING) {
    console.error('[TabunganNikah] config.js belum diisi dengan benar.');
    renderConfigMissing();
    return;
  }
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error('[TabunganNikah] Pustaka supabase-js gagal dimuat dari vendor. Cek tab Network di DevTools.');
    showBootError('Gagal memuat pustaka Supabase. Muat ulang halaman. Jika tetap terjadi, hubungi pengelola aplikasi.');
    return;
  }
  if (!supabaseClient) {
    console.error('[TabunganNikah] Supabase client gagal dibuat.');
    renderConfigMissing();
    return;
  }
  console.info('[TabunganNikah] Supabase client OK, memasang listener auth…');

  wireStaticListeners();

  supabaseClient.auth.onAuthStateChange((event, session) => {
    currentSession = session;
    if (session) {
      showDashboardScreen();
      bootDashboard();
    } else {
      showLoginScreen();
    }
  });

  try {
    console.info('[TabunganNikah] Memanggil getSession()…');
    const { data, error } = await withTimeout(
      supabaseClient.auth.getSession(),
      8000,
      'getSession'
    );
    if (error) {
      console.error('[TabunganNikah] getSession:', error);
    }
    currentSession = data ? data.session : null;
    console.info('[TabunganNikah] getSession() selesai. Session:', currentSession ? 'ADA' : 'TIDAK ADA');
    if (currentSession) {
      showDashboardScreen();
      bootDashboard();
    } else {
      showLoginScreen();
    }
  } catch (error) {
    console.error('[TabunganNikah] getSession (exception/timeout):', error);
    if (String(error && error.message).startsWith('TIMEOUT')) {
      showBootError('Gagal terhubung ke Supabase (timeout). Periksa url/anon key di config.js dan koneksi internet, lalu coba lagi.');
    } else {
      showLoginScreen();
    }
  }
}

// Jaga-jaga jika app.js dimuat setelah DOMContentLoaded sudah terjadi
// (mis. dengan beberapa konfigurasi live-server/cache), tetap jalankan initApp.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}