/**
 * Lease Billing Application - Client Application Logic
 */

// Application State
const state = {
  activeTab: 'tab-upload',
  receiptsPage: 1,
  receiptsLimit: 25,
  receiptsFilter: 'all',
  receiptsSearch: '',
  receiptsViewMode: 'individual', // 'individual' or 'grouped'
  selectedReceiptIds: new Set(),
  tenants: [],
  settings: {},
  activeRematchId: null,
  isDispatching: false,
  receiptsById: {}
};

// LocalStorage Utilities
function safeGetStorage(key, fallback = null) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch (e) {
    return fallback;
  }
}

function safeSetStorage(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch (e) {}
}

// ==========================================================
// AUTHENTICATION & SESSION MANAGEMENT
// ==========================================================
function getToken() {
  return safeGetStorage('nfl_auth_token', null);
}

function setToken(token) {
  safeSetStorage('nfl_auth_token', token);
}

function removeToken() {
  try { localStorage.removeItem('nfl_auth_token'); } catch(e){}
}

// Global fetch wrapper with Auth token injection & 401 handling
const originalFetch = window.fetch;
window.fetch = async function(url, options = {}) {
  options = options || {};
  options.headers = options.headers || {};
  
  const token = getToken();
  if (token && typeof url === 'string' && url.startsWith('/api/') && !url.includes('/api/auth/login')) {
    if (options.headers instanceof Headers) {
      options.headers.set('Authorization', `Bearer ${token}`);
    } else {
      options.headers['Authorization'] = `Bearer ${token}`;
    }
  }

  const res = await originalFetch(url, options);
  
  if (res.status === 401 && typeof url === 'string' && url.startsWith('/api/') && !url.includes('/api/auth/login')) {
    handleUnauthorized();
  }
  return res;
};

function handleUnauthorized() {
  removeToken();
  showLoginOverlay();
}

function showLoginOverlay() {
  const overlay = document.getElementById('login-overlay');
  if (overlay) overlay.style.display = 'flex';
  const profileBadge = document.getElementById('user-profile-badge');
  if (profileBadge) profileBadge.style.display = 'none';
}

function hideLoginOverlay() {
  const overlay = document.getElementById('login-overlay');
  if (overlay) overlay.style.display = 'none';
}

function updateUserProfileUI(user) {
  const profileBadge = document.getElementById('user-profile-badge');
  const displayName = document.getElementById('user-display-name');
  const displayRole = document.getElementById('user-display-role');
  const roleIcon = document.getElementById('user-role-icon');

  if (profileBadge && user) {
    profileBadge.style.display = 'flex';
    if (displayName) displayName.textContent = user.name || user.username;
    if (displayRole) displayRole.textContent = user.role;
    if (roleIcon) roleIcon.textContent = user.role === 'Admin' ? '👑' : '💻';
  }
}

async function checkAuthSession() {
  const token = getToken();
  if (!token) {
    showLoginOverlay();
    return false;
  }

  try {
    const res = await originalFetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.user) {
        updateUserProfileUI(data.user);
        hideLoginOverlay();
        return true;
      }
    }
  } catch (e) {}

  handleUnauthorized();
  return false;
}

async function handleLogin(e) {
  if (e) e.preventDefault();
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const alertBox = document.getElementById('login-alert');
  const submitBtn = document.getElementById('btn-login-submit');

  const username = usernameInput ? usernameInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value : '';

  if (!username || !password) {
    if (alertBox) {
      alertBox.textContent = 'Please enter both username and password.';
      alertBox.style.display = 'block';
    }
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '⌛ Signing in...';
  }
  if (alertBox) alertBox.style.display = 'none';

  try {
    const res = await originalFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Authentication failed');
    }

    setToken(data.token);
    updateUserProfileUI(data.user);
    hideLoginOverlay();
    showToast(`Welcome back, ${data.user.name}!`, 'success');

    // Initial data loads after authentication
    initSse();
    fetchStats();
    fetchReceipts();
    fetchTenants();
    fetchSettings();
    fetchLogs();
  } catch (err) {
    if (alertBox) {
      alertBox.textContent = err.message || 'Invalid login credentials.';
      alertBox.style.display = 'block';
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '🔐 Sign In';
    }
  }
}

let appEventSource = null;

async function handleLogout() {
  if (appEventSource) {
    try {
      appEventSource.close();
      appEventSource = null;
      console.log('[Auth] SSE event stream terminated on logout.');
    } catch(e) {}
  }
  const token = getToken();
  if (token) {
    try {
      await originalFetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
      });
    } catch(e){}
  }
  removeToken();
  showLoginOverlay();
  showToast('Logged out. All Oracle database connections suspended.', 'info');
}

function initAuthHandlers() {
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);
  }
  const btnLogout = document.getElementById('btn-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', handleLogout);
  }
}

// ==========================================================
// INITIALIZATION
// ==========================================================
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  initNavigation();
  initDragAndDrop();
  initEventHandlers();
  initAuthHandlers();

  const isAuthenticated = await checkAuthSession();
  if (isAuthenticated) {
    initSse();
    fetchStats();
    fetchReceipts();
    fetchTenants();
    fetchSettings();
    fetchLogs();
  }
});

// ==========================================================
// THEME
// ==========================================================
function initTheme() {
  const saved = safeGetStorage('kiraidaar-theme-v2', 'theme-light');
  document.body.className = saved;
  updateThemeIcon();

  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const isDark = document.body.classList.contains('theme-dark');
      document.body.className = isDark ? 'theme-light' : 'theme-dark';
      safeSetStorage('kiraidaar-theme-v2', document.body.className);
      safeSetStorage('kiraidaar-theme', document.body.className);
      updateThemeIcon();
    });
  }
}

function updateThemeIcon() {
  const isDark = document.body.classList.contains('theme-dark');
  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    toggleBtn.textContent = isDark ? '🌙' : '☀️';
  }
}

// ==========================================================
// NAVIGATION & TABS
// ==========================================================
function initNavigation() {
  const navBtns = document.querySelectorAll('.nav-btn');
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchTab(tabId);
    });
  });
}

function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === tabId);
  });

  if (tabId === 'tab-receipts') fetchReceipts();
  if (tabId === 'tab-tenants') fetchTenants();
  if (tabId === 'tab-upload') fetchStats();
  if (tabId === 'tab-dispatch') {
    fetchStats();
    fetchLogs();
  }
}

// ==========================================================
// STATS & METRICS
// ==========================================================
async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();

    document.getElementById('stat-total-receipts').textContent = data.totalReceipts.toLocaleString();
    document.getElementById('stat-matched-receipts').textContent = data.matchedReceipts.toLocaleString();
    document.getElementById('stat-match-rate').textContent = `${data.matchRate}%`;
    document.getElementById('stat-pending-receipts').textContent = data.pendingReceipts.toLocaleString();
    document.getElementById('stat-sent-receipts').textContent = data.sentReceipts.toLocaleString();
    document.getElementById('stat-failed-receipts').textContent = data.failedReceipts.toLocaleString();
    document.getElementById('stat-total-tenants').textContent = data.totalTenants.toLocaleString();

    document.getElementById('tab-receipt-count').textContent = data.totalReceipts;
    document.getElementById('tab-tenant-count').textContent = data.totalTenants;
    document.getElementById('receipts-badge-total').textContent = `${data.totalReceipts} PDFs`;

    document.getElementById('dispatch-ready-count').textContent = data.pendingReceipts;
    document.getElementById('dispatch-sent-count').textContent = data.sentReceipts;
    document.getElementById('dispatch-failed-count').textContent = data.failedReceipts;
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// ==========================================================
// PDF UPLOADER (MASTER MULTI-PAGE & BULK INDIVIDUAL)
// ==========================================================
function initDragAndDrop() {
  const masterDropZone = document.getElementById('master-drop-zone');
  const masterFileInput = document.getElementById('master-pdf-file-input');
  const individualDropZone = document.getElementById('drop-zone');
  const individualFileInput = document.getElementById('pdf-file-input');

  const modeMasterBtn = document.getElementById('upload-mode-master-btn');
  const modeIndividualBtn = document.getElementById('upload-mode-individual-btn');

  // Mode Switcher
  modeMasterBtn.addEventListener('click', () => {
    modeMasterBtn.classList.add('active');
    modeIndividualBtn.classList.remove('active');
    masterDropZone.style.display = 'block';
    individualDropZone.style.display = 'none';
  });

  modeIndividualBtn.addEventListener('click', () => {
    modeIndividualBtn.classList.add('active');
    modeMasterBtn.classList.remove('active');
    masterDropZone.style.display = 'none';
    individualDropZone.style.display = 'block';
  });

  // 1. MASTER MULTI-PAGE PDF HANDLERS
  ['dragenter', 'dragover'].forEach(eventName => {
    masterDropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      masterDropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    masterDropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      masterDropZone.classList.remove('dragover');
    });
  });

  masterDropZone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length > 0) {
      handleMasterPdfUpload(files[0]);
    } else {
      showToast('Please drop a valid PDF file.', 'error');
    }
  });

  masterFileInput.addEventListener('change', () => {
    if (masterFileInput.files.length > 0) {
      handleMasterPdfUpload(masterFileInput.files[0]);
      masterFileInput.value = '';
    }
  });

  // 2. INDIVIDUAL BULK PDF HANDLERS
  ['dragenter', 'dragover'].forEach(eventName => {
    individualDropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      individualDropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    individualDropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      individualDropZone.classList.remove('dragover');
    });
  });

  individualDropZone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length > 0) {
      handleBulkUpload(files);
    } else {
      showToast('Please drop valid PDF files.', 'error');
    }
  });

  individualFileInput.addEventListener('change', () => {
    const files = Array.from(individualFileInput.files);
    if (files.length > 0) {
      handleBulkUpload(files);
      individualFileInput.value = '';
    }
  });
}

async function handleMasterPdfUpload(file) {
  const progressBox = document.getElementById('upload-progress-box');
  const progressText = document.getElementById('upload-progress-text');
  const progressPercent = document.getElementById('upload-progress-percent');
  const progressFill = document.getElementById('upload-progress-fill');
  const progressSub = document.getElementById('upload-progress-sub');

  progressBox.style.display = 'block';
  progressFill.style.width = '20%';
  progressPercent.textContent = '20%';
  progressText.textContent = `Uploading master PDF (${file.name})...`;
  progressSub.textContent = `Splitting each page, parsing text, and extracting party codes...`;

  const formData = new FormData();
  formData.append('masterPdf', file);

  try {
    progressFill.style.width = '55%';
    progressPercent.textContent = '55%';

    const res = await fetch('/api/receipts/upload-master-pdf', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Master PDF split failed');

    progressText.textContent = `Splitting complete!`;
    progressSub.textContent = `Generated ${data.totalPages} receipts for ${data.month || 'period'}. Saved in ${data.outputDir || 'D:\\estate_bills'}. (${data.matchedTenants} linked to tenants).`;

    showToast(data.message, 'success');
    fetchStats();
    fetchReceipts();

    setTimeout(() => {
      progressBox.style.display = 'none';
      switchTab('tab-receipts');
    }, 2500);
  } catch (err) {
    progressBox.style.display = 'none';
    showToast(`Master PDF processing error: ${err.message}`, 'error');
  }
}

async function handleBulkUpload(files) {
  const totalFiles = files.length;
  const CHUNK_SIZE = 40; // 40 files per HTTP request
  const totalChunks = Math.ceil(totalFiles / CHUNK_SIZE);

  const progressBox = document.getElementById('upload-progress-box');
  const progressText = document.getElementById('upload-progress-text');
  const progressPercent = document.getElementById('upload-progress-percent');
  const progressFill = document.getElementById('upload-progress-fill');
  const progressSub = document.getElementById('upload-progress-sub');

  progressBox.style.display = 'block';
  progressFill.style.width = '0%';
  progressPercent.textContent = '0%';

  let uploadedCount = 0;
  let totalMatched = 0;

  for (let i = 0; i < totalChunks; i++) {
    const chunk = files.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const formData = new FormData();
    chunk.forEach(f => formData.append('receipts', f));

    progressText.textContent = `Uploading chunk ${i + 1} of ${totalChunks} (${uploadedCount} / ${totalFiles} PDFs)...`;
    progressSub.textContent = `Extracting metadata and linking flat numbers...`;

    try {
      const res = await fetch('/api/receipts/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      uploadedCount += chunk.length;
      totalMatched += data.matched || 0;

      const percent = Math.round((uploadedCount / totalFiles) * 100);
      progressFill.style.width = `${percent}%`;
      progressPercent.textContent = `${percent}%`;
    } catch (err) {
      showToast(`Error uploading chunk ${i + 1}: ${err.message}`, 'error');
    }
  }

  progressText.textContent = `Upload complete!`;
  progressSub.textContent = `Successfully processed ${uploadedCount} receipts (${totalMatched} auto-linked to tenants).`;
  showToast(`Uploaded ${uploadedCount} PDFs successfully!`, 'success');

  fetchStats();
  fetchReceipts();

  setTimeout(() => {
    progressBox.style.display = 'none';
  }, 4000);
}

// ==========================================================
// RECEIPTS CATALOG
// ==========================================================
async function fetchReceipts() {
  try {
    const query = new URLSearchParams({
      page: state.receiptsPage,
      limit: state.receiptsLimit,
      status: state.receiptsFilter,
      search: state.receiptsSearch
    });

    const res = await fetch(`/api/receipts?${query.toString()}`);
    const data = await res.json();
    renderReceiptsTable(data.receipts, data.pagination);

    if (state.receiptsViewMode === 'grouped') {
      fetchGroupedReceipts();
    }
  } catch (err) {
    console.error('Failed to fetch receipts:', err);
  }
}

function renderReceiptsTable(receipts, pagination) {
  const tbody = document.getElementById('receipts-table-body');
  if (!state.receiptsById) state.receiptsById = {};
  (receipts || []).forEach(r => { state.receiptsById[r.id] = r; });

  if (!receipts || receipts.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" class="text-center py-5">
          <div class="empty-state">
            <span class="empty-icon">📂</span>
            <p>No ${state.receiptsFilter === 'matched' ? '100% matched ' : ''}receipts found${state.receiptsSearch ? ` matching "${escapeHtml(state.receiptsSearch)}"` : ''}.</p>
          </div>
        </td>
      </tr>
    `;
    updatePagination(pagination);
    return;
  }

  tbody.innerHTML = receipts.map((r, idx) => {
    const rowNum = (pagination.page - 1) * pagination.limit + idx + 1;
    const formattedSize = (r.file_size / 1024).toFixed(1) + ' KB';

    // Status Badge
    let statusBadge = '';
    if (r.email_status === 'sent') {
      statusBadge = `<span class="badge badge-success" title="Sent at ${r.sent_at || ''}">Sent</span>`;
    } else if (r.email_status === 'failed') {
      statusBadge = `<span class="badge badge-danger" title="${escapeHtml(r.error_message || 'Failed')}">Failed</span>`;
    } else {
      statusBadge = `<span class="badge badge-warning">Pending</span>`;
    }

    // Matched Tenant Info
    let tenantInfo = '';
    if (r.tenant_id) {
      const emailHtml = (r.tenant_email && r.tenant_email.includes('@'))
        ? `<div class="text-xs text-muted">${escapeHtml(r.tenant_email)}</div>`
        : `<div class="text-xs"><span class="badge badge-warning text-xs" style="cursor: pointer;" onclick="openEditTenantModal(${r.tenant_id})" title="Click to add email address">⚠️ No Email</span></div>`;

      tenantInfo = `
        <div>
          <strong>${escapeHtml(r.tenant_name)}</strong>
          <div class="text-xs" style="color: #10b981; font-family: var(--font-mono); font-weight: 600;">
            Party Code: ${escapeHtml(r.tenant_party_code || r.party_code || '')}
          </div>
          <div class="text-xs text-muted">Unit: ${escapeHtml(r.tenant_unit || 'N/A')}</div>
          ${emailHtml}
        </div>
      `;
    } else {
      tenantInfo = `<span class="text-muted text-xs">⚠️ No Tenant Linked</span>`;
    }

    // Confidence Badge
    let confidenceBadge = '';
    if (r.tenant_id) {
      const conf = r.match_confidence || 0;
      const isExactCode = (r.party_code && r.tenant_party_code && String(r.party_code).trim().toLowerCase() === String(r.tenant_party_code).trim().toLowerCase());
      const badgeText = isExactCode ? 'Exact Party Match' : `${conf}% Match`;
      confidenceBadge = `<span class="badge badge-success" title="${escapeHtml(r.match_reason || '')}">✓ ${badgeText}</span>`;
    } else {
      confidenceBadge = `<span class="badge badge-danger">Unmatched</span>`;
    }

    // Extracted metadata preview
    const metaList = [];
    if (r.extracted_unit) metaList.push(`Unit: <strong>${escapeHtml(r.extracted_unit)}</strong>`);
    if (r.extracted_amount) metaList.push(`₹${r.extracted_amount.toLocaleString('en-IN')}`);
    if (r.extracted_month) metaList.push(escapeHtml(r.extracted_month));
    const metaHtml = metaList.length > 0 ? metaList.join(' • ') : '<span class="text-muted text-xs">No text detected</span>';

    return `
      <tr>
        <td style="text-align: center;">
          <input type="checkbox" class="receipt-row-checkbox" data-id="${r.id}" ${state.selectedReceiptIds.has(r.id) ? 'checked' : ''} title="Select receipt #${rowNum}">
        </td>
        <td class="text-muted text-xs">${rowNum}</td>
        <td>
          <div class="d-flex align-center gap-2">
            <span style="font-size: 1.2rem;">📄</span>
            <div>
              <strong class="text-sm">${escapeHtml(r.original_name)}</strong>
              <div class="text-xs text-muted">${formattedSize}</div>
            </div>
          </div>
        </td>
        <td>
          ${r.party_code ? `<span class="badge badge-purple" style="font-family: var(--font-mono);">${escapeHtml(r.party_code)}</span>` : '<span class="text-muted text-xs">—</span>'}
        </td>
        <td class="text-xs">${metaHtml}</td>
        <td>${tenantInfo}</td>
        <td>${confidenceBadge}</td>
        <td id="receipt-status-cell-${r.id}">${statusBadge}</td>
        <td style="text-align: right; white-space: nowrap;">
          ${r.tenant_id 
            ? ((r.tenant_email && r.tenant_email.includes('@'))
                ? `
                    <button class="btn btn-outline btn-sm" onclick="openEditEmailModal([${r.id}])" title="Edit email text or subject before sending">✏️ Edit & Send</button>
                    ${r.email_status === 'sent' 
                      ? `<button class="btn btn-outline btn-sm" onclick="sendIndividualReceipt(${r.id}, this)" title="Resend email">🔄 Resend</button>` 
                      : `<button class="btn btn-primary btn-sm" onclick="sendIndividualReceipt(${r.id}, this)" title="Send receipt email now">📧 Send</button>`}
                  `
                : `<button class="btn btn-warning btn-sm" onclick="openEditTenantModal(${r.tenant_id})" title="Customer has no email configured. Click to add email.">⚠️ Add Email</button>`)
            : `<button class="btn btn-outline btn-sm text-muted" onclick="openRematchModal(${r.id})" title="Link tenant to send email">⚠️ Link</button>`
          }
          <button class="btn btn-secondary btn-sm" onclick="openPdfViewer(${r.id})">
            👁️ View
          </button>
          <button class="btn btn-outline btn-sm" onclick="openRematchModal(${r.id})">
            🔗 Link
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteReceipt(${r.id})">
            🗑️
          </button>
        </td>
      </tr>
    `;
  }).join('');

  attachReceiptCheckboxHandlers(receipts);
  updatePagination(pagination);
  updateBulkSelectedToolbar();
}

function updatePagination(pagination) {
  const info = document.getElementById('receipts-pagination-info');
  const container = document.getElementById('receipts-pagination-btns');
  if (!pagination || pagination.total === 0) {
    info.textContent = 'Showing 0 of 0';
    container.innerHTML = '';
    return;
  }

  const start = (pagination.page - 1) * pagination.limit + 1;
  const end = Math.min(pagination.page * pagination.limit, pagination.total);
  info.textContent = `Showing ${start}-${end} of ${pagination.total} receipts`;

  let html = '';
  if (pagination.page > 1) {
    html += `<button class="page-btn" onclick="setPage(${pagination.page - 1})">Previous</button>`;
  }

  const maxPages = Math.min(pagination.totalPages, 7);
  for (let i = 1; i <= maxPages; i++) {
    html += `<button class="page-btn ${i === pagination.page ? 'active' : ''}" onclick="setPage(${i})">${i}</button>`;
  }

  if (pagination.totalPages > maxPages) {
    html += `<span class="text-muted text-xs">... (${pagination.totalPages})</span>`;
  }

  if (pagination.page < pagination.totalPages) {
    html += `<button class="page-btn" onclick="setPage(${pagination.page + 1})">Next</button>`;
  }

  container.innerHTML = html;
}

function setPage(p) {
  state.receiptsPage = p;
  fetchReceipts();
}

// ==========================================================
// GROUPED RECEIPTS (CLUBBED BY PARTY CODE)
// ==========================================================
async function fetchGroupedReceipts() {
  try {
    const query = new URLSearchParams({
      status: state.receiptsFilter,
      search: state.receiptsSearch
    });

    const res = await fetch(`/api/receipts/grouped?${query.toString()}`);
    const data = await res.json();
    renderGroupedReceipts(data.groups, data.totalReceipts);
  } catch (err) {
    console.error('Failed to fetch grouped receipts:', err);
  }
}

function renderGroupedReceipts(groups, totalReceipts) {
  const container = document.getElementById('grouped-cards-container');
  const countBadge = document.getElementById('grouped-badge-count');
  const receiptsBadge = document.getElementById('grouped-badge-receipts');

  if (countBadge) countBadge.textContent = `${groups ? groups.length : 0} Parties / Groups`;
  if (receiptsBadge) receiptsBadge.textContent = `${totalReceipts || 0} total receipts`;

  if (!container) return;

  if (!state.receiptsById) state.receiptsById = {};
  (groups || []).forEach(grp => {
    (grp.receipts || []).forEach(r => {
      state.receiptsById[r.id] = {
        ...r,
        tenant_id: grp.tenantId,
        original_name: r.originalName || r.original_name
      };
    });
  });

  if (!groups || groups.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 3rem;">
        <span class="empty-icon">📦</span>
        <p>No grouped receipts match the current filter or search criteria.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = groups.map((grp, gIdx) => {
    const docCount = grp.receipts.length;
    const isMultiDoc = docCount > 1;
    const cardStatusClass = grp.allSent ? 'group-sent' : (grp.anyFailed ? 'group-failed' : 'group-pending');

    // Status Badge
    let statusBadge = '';
    if (grp.allSent) {
      statusBadge = `<span class="badge badge-success">All Sent</span>`;
    } else if (grp.anyFailed) {
      statusBadge = `<span class="badge badge-danger">Failed</span>`;
    } else {
      statusBadge = `<span class="badge badge-warning">Pending Send</span>`;
    }

    // Party Code Tag
    const partyCodeTag = grp.partyCode
      ? `<span class="badge badge-purple" style="font-family: var(--font-mono); font-size: 0.8rem;">${escapeHtml(grp.partyCode)}</span>`
      : `<span class="badge badge-info text-xs">Ungrouped</span>`;

    // Tenant info
    let tenantDisplay = '';
    if (grp.tenantName) {
      const emailChip = (grp.tenantEmail && grp.tenantEmail.includes('@'))
        ? `<span>📧 ${escapeHtml(grp.tenantEmail)}</span>`
        : `<span class="badge badge-warning text-xs" style="cursor: pointer;" onclick="openEditTenantModal(${grp.tenantId})" title="Click to add email address">⚠️ No Email (Click to Add)</span>`;

      tenantDisplay = `
        <span class="group-name">${escapeHtml(grp.tenantName)}</span>
        <div class="group-meta">
          ${partyCodeTag}
          <span>Unit: <strong>${escapeHtml(grp.tenantUnit || 'N/A')}</strong></span>
          ${emailChip}
          <span class="badge badge-info">${docCount} Document${isMultiDoc ? 's (Clubbed)' : ''}</span>
        </div>
      `;
    } else {
      tenantDisplay = `
        <span class="group-name text-muted">⚠️ Unlinked Tenant</span>
        <div class="group-meta">
          ${partyCodeTag}
          <span>Unit: ${escapeHtml(grp.tenantUnit || 'N/A')}</span>
          <span class="badge badge-danger">No Email Mapped</span>
          <span class="badge badge-info">${docCount} Document${isMultiDoc ? 's' : ''}</span>
        </div>
      `;
    }

    // Sub-document rows
    const docsHtml = grp.receipts.map((r, rIdx) => {
      const docAmount = r.extractedAmount ? `₹${parseFloat(r.extractedAmount).toLocaleString('en-IN')}` : '—';
      let rBadge = '';
      if (r.emailStatus === 'sent') {
        rBadge = `<span class="badge badge-success text-xs">Sent</span>`;
      } else if (r.emailStatus === 'failed') {
        rBadge = `<span class="badge badge-danger text-xs" title="${escapeHtml(r.errorMessage || '')}">Failed</span>`;
      } else {
        rBadge = `<span class="badge badge-warning text-xs">Pending</span>`;
      }

      return `
        <div class="group-doc-row">
          <div class="group-doc-left">
            <span class="doc-icon">📄</span>
            <div>
              <span class="doc-name">${escapeHtml(r.originalName)}</span>
              <span class="text-muted text-xs" style="margin-left: 0.5rem;">${r.extractedMonth || ''}</span>
            </div>
          </div>
          <div class="group-doc-right">
            <span class="doc-amount">${docAmount}</span>
            ${rBadge}
            <button class="btn btn-secondary btn-sm" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;" onclick="openPdfViewer(${r.id})">
              👁️ View
            </button>
            <button class="btn btn-outline btn-sm" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;" onclick="openRematchModal(${r.id})">
              🔗 Link
            </button>
            <button class="btn btn-danger btn-sm" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;" onclick="deleteReceipt(${r.id})">
              🗑️
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Send Button
    const receiptIdsParam = JSON.stringify(grp.receipts.map(r => r.id));
    let sendBtn = '';
    if (grp.tenantEmail && grp.tenantEmail.includes('@')) {
      const btnText = isMultiDoc ? `🚀 Send Both Documents in 1 Email` : `🚀 Send Receipt Email`;
      sendBtn = `
        <button class="btn btn-outline btn-sm" onclick='openEditEmailModal(${receiptIdsParam})' title="Edit email text or subject before sending">
          ✏️ Edit & Send
        </button>
        <button class="btn btn-primary btn-sm" onclick='sendSingleGroupEmail(${receiptIdsParam}, this)'>
          ${btnText}
        </button>
      `;
    } else if (grp.tenantId) {
      sendBtn = `
        <button class="btn btn-warning btn-sm" onclick="openEditTenantModal(${grp.tenantId})" title="Customer has no email address. Click to add email.">
          ⚠️ Add Email to Send
        </button>
      `;
    } else {
      sendBtn = `
        <button class="btn btn-outline btn-sm" disabled title="Link to a tenant with email address first">
          ⚠️ Link Tenant to Send
        </button>
      `;
    }

    return `
      <div class="group-card ${cardStatusClass} expanded" id="group-card-${gIdx}">
        <div class="group-card-header" onclick="toggleGroupCard('group-card-${gIdx}')">
          <div class="group-card-left">
            <span class="group-card-icon">📂</span>
            <div class="group-card-info">
              ${tenantDisplay}
            </div>
          </div>
          <div class="group-card-right">
            <div class="text-right">
              <div class="group-amount">₹${grp.totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              <div class="text-xs text-muted">Combined Total</div>
            </div>
            ${statusBadge}
            <span class="group-chevron">▶</span>
          </div>
        </div>

        <div class="group-card-body">
          ${docsHtml}
          <div class="group-action-bar">
            <span class="text-xs text-muted" style="margin-right: auto;">
              ${isMultiDoc ? `✨ <strong>Clubbed:</strong> 2 documents attached to a single email for ${escapeHtml(grp.tenantName || 'tenant')}` : `Single document receipt`}
            </span>
            ${sendBtn}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function toggleGroupCard(cardId) {
  const card = document.getElementById(cardId);
  if (card) {
    card.classList.toggle('expanded');
  }
}

async function sendSingleGroupEmail(receiptIds, btn) {
  if (!receiptIds || receiptIds.length === 0) return;
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ Sending Email...';

  try {
    const res = await fetch('/api/email/send-group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiptIds })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast(data.message || 'Email sent successfully!', 'success');
    btn.innerHTML = '✓ Sent!';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-success');

    fetchStats();
    fetchReceipts();
    fetchGroupedReceipts();
  } catch (err) {
    showToast(`Failed to send email: ${err.message}`, 'error');
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// Send single individual receipt
async function sendIndividualReceipt(receiptId, btn) {
  if (!receiptId) return;
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ Sending...';

  try {
    const res = await fetch('/api/email/send-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiptId })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast(data.message || 'Email sent successfully!', 'success');
    btn.innerHTML = '✓ Sent!';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-success');

    // Update status cell in table
    const cell = document.getElementById(`receipt-status-cell-${receiptId}`);
    if (cell) {
      cell.innerHTML = `<span class="badge badge-success" title="Sent at ${new Date().toLocaleTimeString()}">Sent</span>`;
    }

    fetchStats();
    fetchLogs();
  } catch (err) {
    showToast(`Failed to send: ${err.message}`, 'error');
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// Checkbox selection & bulk action helpers
function handleSelectAllToggle(isChecked) {
  const rowCheckboxes = document.querySelectorAll('.receipt-row-checkbox');
  rowCheckboxes.forEach(cb => {
    cb.checked = isChecked;
    const id = parseInt(cb.getAttribute('data-id'), 10);
    if (!isNaN(id)) {
      if (isChecked) {
        state.selectedReceiptIds.add(id);
      } else {
        state.selectedReceiptIds.delete(id);
      }
    }
  });
  updateBulkSelectedToolbar();
}

function handleRowCheckboxToggle(cb) {
  const id = parseInt(cb.getAttribute('data-id'), 10);
  if (!isNaN(id)) {
    if (cb.checked) {
      state.selectedReceiptIds.add(id);
    } else {
      state.selectedReceiptIds.delete(id);
    }
  }
  const selectAll = document.getElementById('receipts-select-all');
  if (selectAll) {
    const rowCheckboxes = document.querySelectorAll('.receipt-row-checkbox');
    selectAll.checked = rowCheckboxes.length > 0 && Array.from(rowCheckboxes).every(c => c.checked);
  }
  updateBulkSelectedToolbar();
}

function selectAllOnCurrentPage() {
  const selectAll = document.getElementById('receipts-select-all');
  if (selectAll) selectAll.checked = true;
  handleSelectAllToggle(true);
}

function deselectAllReceipts() {
  state.selectedReceiptIds.clear();
  const selectAll = document.getElementById('receipts-select-all');
  if (selectAll) selectAll.checked = false;
  document.querySelectorAll('.receipt-row-checkbox').forEach(cb => {
    cb.checked = false;
  });
  updateBulkSelectedToolbar();
}

function attachReceiptCheckboxHandlers(receipts) {
  const selectAll = document.getElementById('receipts-select-all');
  const pageReceipts = receipts || [];
  if (selectAll) {
    const allChecked = pageReceipts.length > 0 && pageReceipts.every(r => state.selectedReceiptIds.has(r.id));
    const someChecked = pageReceipts.some(r => state.selectedReceiptIds.has(r.id));
    selectAll.checked = allChecked;
    selectAll.indeterminate = !allChecked && someChecked;
  }
  updateBulkSelectedToolbar();
}

function updateBulkSelectedToolbar() {
  const btnSendSelected = document.getElementById('btn-bulk-send-selected');
  const btnDeleteSelected = document.getElementById('btn-bulk-delete-selected');
  const btnDeselectAll = document.getElementById('btn-deselect-all');
  const countSpan = document.getElementById('selected-count');
  const deleteCountSpan = document.getElementById('delete-selected-count');
  const totalCount = state.selectedReceiptIds.size;

  if (countSpan) countSpan.textContent = totalCount;
  if (deleteCountSpan) deleteCountSpan.textContent = totalCount;

  if (btnSendSelected) {
    btnSendSelected.style.display = totalCount > 0 ? 'inline-flex' : 'none';
  }
  if (btnDeleteSelected) {
    btnDeleteSelected.style.display = totalCount > 0 ? 'inline-flex' : 'none';
  }
  if (btnDeselectAll) {
    btnDeselectAll.style.display = totalCount > 0 ? 'inline-flex' : 'none';
  }
}

// Bulk delete selected receipts
async function deleteSelectedReceipts() {
  const ids = Array.from(state.selectedReceiptIds);
  if (ids.length === 0) {
    showToast('Please select at least one receipt to delete.', 'warning');
    return;
  }

  showConfirmModal({
    title: 'Delete Selected Receipts',
    message: `Are you sure you want to permanently delete <strong>${ids.length}</strong> selected receipt(s)? This will remove them from the database and permanently delete their PDF files from disk.`,
    confirmText: `Yes, Delete (${ids.length})`,
    confirmClass: 'btn-danger',
    onConfirm: async () => {
      const btn = document.getElementById('btn-bulk-delete-selected');
      const originalText = btn ? btn.innerHTML : '';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `⏳ Deleting (${ids.length})...`;
      }

      try {
        const res = await fetch('/api/receipts/delete-selected', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ receiptIds: ids })
        });

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete selected receipts');

        state.selectedReceiptIds.clear();
        showToast(data.message || `Deleted ${ids.length} receipt(s).`, 'success');
        updateBulkSelectedToolbar();
        fetchStats();
        fetchReceipts();
      } catch (err) {
        showToast(`Delete failed: ${err.message}`, 'error');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
      }
    }
  });
}

// Bulk send selected receipts
async function sendSelectedReceipts() {
  const ids = Array.from(state.selectedReceiptIds);
  if (ids.length === 0) {
    showToast('Please select at least one matched receipt to send.', 'warning');
    return;
  }

  const btn = document.getElementById('btn-bulk-send-selected');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `⏳ Sending (${ids.length})...`;

  try {
    const res = await fetch('/api/email/send-selected', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiptIds: ids })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast(data.message || `Dispatched ${ids.length} selected receipts!`, 'success');
    state.selectedReceiptIds.clear();
    updateBulkSelectedToolbar();
    btn.disabled = false;
    btn.innerHTML = originalText;

    switchTab('tab-dispatch');
  } catch (err) {
    showToast(`Bulk send error: ${err.message}`, 'error');
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// Bulk send all pending matched receipts
async function sendAllMatchedReceipts() {
  const res = await fetch('/api/stats');
  const stats = await res.json();

  if (!stats.pendingReceipts || stats.pendingReceipts === 0) {
    showToast('No pending matched receipts to send.', 'info');
    return;
  }

  showConfirmModal({
    title: 'Bulk Send All Matched Receipts',
    message: `Are you sure you want to send all <strong>${stats.pendingReceipts}</strong> pending matched receipts in bulk via email?`,
    confirmText: `Yes, Send (${stats.pendingReceipts})`,
    confirmClass: 'btn-primary',
    onConfirm: async () => {
      try {
        const startRes = await fetch('/api/email/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ onlyPending: true })
        });

        const data = await startRes.json();
        if (!startRes.ok) throw new Error(data.error);

        showToast(data.message, 'success');
        switchTab('tab-dispatch');
      } catch (err) {
        showToast(`Bulk send error: ${err.message}`, 'error');
      }
    }
  });
}

// ==========================================================
// TENANT DATABASE & EMAIL REGISTRY
// ==========================================================
async function fetchTenants() {
  try {
    const searchInput = document.getElementById('tenant-search-input');
    const search = searchInput ? searchInput.value : '';
    const currentFilter = state.tenantsFilter || 'all';

    // 1. Fetch filtered tenants
    const res = await fetch(`/api/tenants?search=${encodeURIComponent(search)}&filter=${encodeURIComponent(currentFilter)}`);
    const data = await res.json();
    state.tenants = Array.isArray(data) ? data : (data.tenants || []);
    renderTenantsTable(state.tenants);
    populateRematchDropdown(state.tenants);

    // 2. Refresh sync status & counters
    updateTenantSyncMetrics();
  } catch (err) {
    console.error('Failed to load tenants:', err);
  }
}

async function updateTenantSyncMetrics() {
  try {
    const res = await fetch('/api/oracle/sync-status');
    const data = await res.json();
    if (!data.success) return;

    const { total, withEmail, noEmail, duplicates, discrepancies } = data.counts || {};
    const totalEl = document.getElementById('tenant-stat-total');
    const withEmailEl = document.getElementById('tenant-stat-with-email');
    const noEmailEl = document.getElementById('tenant-stat-no-email');
    const duplicatesEl = document.getElementById('tenant-stat-duplicates');
    const discrepanciesEl = document.getElementById('tenant-stat-discrepancies');

    const countAllEl = document.getElementById('count-filter-all');
    const countWithEl = document.getElementById('count-filter-with-email');
    const countMissingEl = document.getElementById('count-filter-missing-email');
    const countDupEl = document.getElementById('count-filter-duplicates');
    const countDiscrepEl = document.getElementById('count-filter-discrepancies');
    const syncTimeEl = document.getElementById('tenant-last-sync-time');

    if (totalEl) totalEl.textContent = (total || 0).toLocaleString('en-IN');
    if (withEmailEl) withEmailEl.textContent = (withEmail || 0).toLocaleString('en-IN');
    if (noEmailEl) noEmailEl.textContent = (noEmail || 0).toLocaleString('en-IN');
    if (duplicatesEl) duplicatesEl.textContent = (duplicates || 0).toLocaleString('en-IN');
    if (discrepanciesEl) discrepanciesEl.textContent = (discrepancies || 0).toLocaleString('en-IN');

    if (countAllEl) countAllEl.textContent = (total || 0).toLocaleString('en-IN');
    if (countWithEl) countWithEl.textContent = (withEmail || 0).toLocaleString('en-IN');
    if (countMissingEl) countMissingEl.textContent = (noEmail || 0).toLocaleString('en-IN');
    if (countDupEl) countDupEl.textContent = (duplicates || 0).toLocaleString('en-IN');
    if (countDiscrepEl) countDiscrepEl.textContent = (discrepancies || 0).toLocaleString('en-IN');

    if (syncTimeEl && data.lastSyncTime) {
      const dt = new Date(data.lastSyncTime);
      syncTimeEl.textContent = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) + ', ' + dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    }
  } catch (err) {
    console.warn('Failed to update tenant sync metrics:', err);
  }
}

function renderTenantsTable(tenants) {
  const tbody = document.getElementById('tenants-table-body');
  if (!tenants || tenants.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center py-5">
          <div class="empty-state">
            <span class="empty-icon">👥</span>
            <p>No tenant records match the selected criteria. Click <strong>All Entries</strong> or <strong>Sync Oracle DB</strong>.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = tenants.map((t, idx) => {
    const hasEmail = t.email && t.email.includes('@');
    const emailHtml = hasEmail
      ? `<a href="mailto:${escapeHtml(t.email)}" class="text-muted">${escapeHtml(t.email)}</a>`
      : `<button class="badge badge-warning" onclick="openEditTenantModal(${t.id})" title="Click to enter customer email" style="border: none; cursor: pointer; text-decoration: underline;">⚠️ No Email (Add)</button>`;

    const unitText = t.unit_number || 'N/A';
    const isMultiUnit = unitText.includes(',') || unitText.length > 35;
    const unitHtml = isMultiUnit
      ? `<span class="badge badge-accent" title="${escapeHtml(unitText)}" style="max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block;">${escapeHtml(unitText)}</span>`
      : `<span class="badge badge-accent">${escapeHtml(unitText)}</span>`;

    // Render Tag Badges (Duplicate, Missing Email, Missing Unit, Missing Name, Clean)
    const rawTags = (t.tags || '').split(';').map(s => s.trim()).filter(Boolean);
    let tagsHtml = '';
    if (rawTags.length === 0 || rawTags.some(tag => tag.startsWith('clean'))) {
      tagsHtml = '<span class="badge badge-success" title="Clean record directly from Oracle DB">✓ Clean</span>';
    } else {
      tagsHtml = rawTags.map(tagItem => {
        const [tagKey, tagDesc] = tagItem.split(':');
        const desc = tagDesc || tagKey;
        if (tagKey === 'exact_duplicate') {
          return `<span class="badge badge-danger" title="${escapeHtml(desc)}" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3);">⚠️ Identical Entry</span>`;
        } else if (tagKey === 'duplicate_party') {
          return `<span class="badge badge-danger" title="${escapeHtml(desc)}" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3);">${escapeHtml(desc)}</span>`;
        } else if (tagKey === 'no_email') {
          return `<span class="badge badge-warning" title="${escapeHtml(desc)}" style="background: rgba(245, 158, 11, 0.15); color: #d97706; border: 1px solid rgba(245, 158, 11, 0.3);">📧 No Email</span>`;
        } else if (tagKey === 'missing_unit') {
          return `<span class="badge badge-warning" title="${escapeHtml(desc)}" style="background: rgba(245, 158, 11, 0.15); color: #d97706; border: 1px solid rgba(245, 158, 11, 0.3);">🏠 No Unit</span>`;
        } else if (tagKey === 'missing_name') {
          return `<span class="badge badge-purple" title="${escapeHtml(desc)}" style="background: rgba(139, 92, 246, 0.15); color: #8b5cf6; border: 1px solid rgba(139, 92, 246, 0.3);">👤 No Name</span>`;
        } else {
          return `<span class="badge badge-info" title="${escapeHtml(desc)}">${escapeHtml(desc)}</span>`;
        }
      }).join(' ');
    }

    return `
      <tr>
        <td class="text-muted text-xs" style="font-weight: 600;">${idx + 1}</td>
        <td><code>${escapeHtml(t.tenant_code || '—')}</code></td>
        <td><strong>${escapeHtml(t.name)}</strong></td>
        <td>${unitHtml}</td>
        <td>${emailHtml}</td>
        <td class="text-sm text-muted">${escapeHtml(t.phone || '—')}</td>
        <td>${tagsHtml}</td>
        <td style="text-align: right; white-space: nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="openEditTenantModal(${t.id})">✏️ Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteTenant(${t.id})">🗑️</button>
        </td>
      </tr>
    `;
  }).join('');
}

// ==========================================================
// EMAIL DISPATCH & SERVER-SENT EVENTS (SSE)
// ==========================================================
function initSse() {
  if (appEventSource) {
    try { appEventSource.close(); } catch(e) {}
  }
  const token = getToken();
  const sseUrl = token ? `/api/email/stream?token=${encodeURIComponent(token)}` : '/api/email/stream';
  appEventSource = new EventSource(sseUrl);

  appEventSource.addEventListener('progress', (e) => {
    const stats = JSON.parse(e.data);
    updateDispatchUI(stats);
  });

  appEventSource.addEventListener('log', (e) => {
    const log = JSON.parse(e.data);
    appendTerminalLog(log);
  });

  appEventSource.onerror = () => {
    document.getElementById('live-indicator').textContent = 'RECONNECTING';
    document.getElementById('live-indicator').className = 'badge badge-warning';
  };

  appEventSource.onopen = () => {
    document.getElementById('live-indicator').textContent = 'LIVE STREAM';
    document.getElementById('live-indicator').className = 'badge badge-pulse';
  };
}

function updateDispatchUI(stats) {
  const percent = stats.total > 0 ? Math.round((stats.processed / stats.total) * 100) : 0;
  document.getElementById('dispatch-progress-percent').textContent = `${percent}%`;
  document.getElementById('dispatch-progress-fill').style.width = `${percent}%`;

  const title = document.getElementById('dispatch-status-title');
  const currentItem = document.getElementById('dispatch-current-item');
  const btnStart = document.getElementById('btn-start-dispatch');
  const btnPause = document.getElementById('btn-pause-dispatch');
  const btnResume = document.getElementById('btn-resume-dispatch');
  const btnStop = document.getElementById('btn-stop-dispatch');

  if (stats.status === 'running') {
    title.textContent = `Dispatching (${stats.processed} / ${stats.total})...`;
    currentItem.textContent = `Sending receipt to: ${stats.currentTenant || ''} (${stats.currentFilename || ''})`;
    btnStart.style.display = 'none';
    btnPause.style.display = 'inline-flex';
    btnResume.style.display = 'none';
    btnStop.style.display = 'inline-flex';
  } else if (stats.status === 'paused') {
    title.textContent = `Dispatch Paused (${stats.processed} / ${stats.total})`;
    btnPause.style.display = 'none';
    btnResume.style.display = 'inline-flex';
  } else if (stats.status === 'completed') {
    title.textContent = `Dispatch Completed! (${stats.sent} sent, ${stats.failed} failed)`;
    currentItem.textContent = `All queued rent payment receipts processed.`;
    btnStart.style.display = 'inline-flex';
    btnPause.style.display = 'none';
    btnResume.style.display = 'none';
    btnStop.style.display = 'none';
    fetchStats();
    fetchReceipts();
  } else {
    title.textContent = `Dispatch Engine Ready`;
    btnStart.style.display = 'inline-flex';
    btnPause.style.display = 'none';
    btnResume.style.display = 'none';
    btnStop.style.display = 'none';
  }
}

function appendTerminalLog(log) {
  const terminal = document.getElementById('terminal-feed');
  const div = document.createElement('div');
  div.className = `terminal-line ${log.type}`;

  if (log.type === 'success') {
    div.innerHTML = `<span class="time">[${log.time}]</span> ✅ Sent <strong>${escapeHtml(log.file)}</strong> to <strong>${escapeHtml(log.tenant)}</strong> (${escapeHtml(log.email)})`;
  } else {
    div.innerHTML = `<span class="time">[${log.time}]</span> ❌ Failed sending <strong>${escapeHtml(log.file)}</strong> to <strong>${escapeHtml(log.tenant)}</strong>: ${escapeHtml(log.error || '')}`;
  }

  terminal.appendChild(div);
  terminal.scrollTop = terminal.scrollHeight;
}

async function fetchLogs() {
  try {
    const res = await fetch('/api/email/logs');
    const logs = await res.json();
    const terminal = document.getElementById('terminal-feed');

    if (logs.length === 0) {
      terminal.innerHTML = `<div class="terminal-line text-muted"><span class="time">[System]</span> Dispatch engine ready. No prior logs recorded.</div>`;
      return;
    }

    terminal.innerHTML = logs.map(l => {
      const time = new Date(l.attempted_at).toLocaleTimeString();
      if (l.status === 'success') {
        return `<div class="terminal-line success"><span class="time">[${time}]</span> ✅ Sent <strong>${escapeHtml(l.file_name || 'Receipt')}</strong> to <strong>${escapeHtml(l.tenant_name || '')}</strong> (${escapeHtml(l.recipient_email)})</div>`;
      } else {
        return `<div class="terminal-line error"><span class="time">[${time}]</span> ❌ Failed to <strong>${escapeHtml(l.recipient_email)}</strong>: ${escapeHtml(l.error_message || 'Unknown error')}</div>`;
      }
    }).join('');
    terminal.scrollTop = terminal.scrollHeight;
  } catch (err) {
    console.error('Failed to load logs:', err);
  }
}

// ==========================================================
// EVENT HANDLERS & MODAL BINDINGS
// ==========================================================
function initEventHandlers() {
  // Search receipt
  const searchInput = document.getElementById('receipt-search-input');
  const clearSearch = document.getElementById('search-clear-btn');
  searchInput.addEventListener('input', debounce(() => {
    state.receiptsSearch = searchInput.value.trim();
    state.receiptsPage = 1;
    clearSearch.style.display = state.receiptsSearch ? 'block' : 'none';
    fetchReceipts();
  }, 300));

  clearSearch.addEventListener('click', () => {
    searchInput.value = '';
    state.receiptsSearch = '';
    clearSearch.style.display = 'none';
    fetchReceipts();
  });

  // Filter pills
  document.querySelectorAll('.filter-pills .pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pills .pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.receiptsFilter = pill.getAttribute('data-filter');
      state.receiptsPage = 1;
      fetchReceipts();
    });
  });

  // Overview Matched Card Click Handler -> Jumps directly to 100% Matched section
  const matchedStatCard = document.getElementById('stat-matched-receipts')?.closest('.metric-card');
  if (matchedStatCard) {
    matchedStatCard.style.cursor = 'pointer';
    matchedStatCard.title = 'Click to view 100% Matched Receipts';
    matchedStatCard.addEventListener('click', () => {
      switchTab('tab-receipts');
      const matchedPill = document.querySelector('.filter-pills .pill[data-filter="matched"]');
      if (matchedPill) matchedPill.click();
    });
  }

  // View Mode Toggle (Individual vs Grouped)
  const btnIndiv = document.getElementById('view-individual-btn');
  const btnGroup = document.getElementById('view-grouped-btn');
  const indivView = document.getElementById('individual-view');
  const groupView = document.getElementById('grouped-view');
  const paginationFooter = document.querySelector('.pagination-footer');

  if (btnIndiv && btnGroup) {
    btnIndiv.addEventListener('click', () => {
      state.receiptsViewMode = 'individual';
      btnIndiv.classList.add('active');
      btnGroup.classList.remove('active');
      if (indivView) indivView.style.display = 'block';
      if (groupView) groupView.style.display = 'none';
      if (paginationFooter) paginationFooter.style.display = 'flex';
      fetchReceipts();
    });

    btnGroup.addEventListener('click', () => {
      state.receiptsViewMode = 'grouped';
      btnGroup.classList.add('active');
      btnIndiv.classList.remove('active');
      if (indivView) indivView.style.display = 'none';
      if (groupView) groupView.style.display = 'block';
      if (paginationFooter) paginationFooter.style.display = 'none';
      fetchGroupedReceipts();
    });
  }

  // Re-match all
  document.getElementById('btn-rematch-all').addEventListener('click', async () => {
    const res = await fetch('/api/receipts/rematch-all', { method: 'POST' });
    const data = await res.json();
    showToast(data.message, 'success');
    fetchStats();
    fetchReceipts();
  });

  // Clear all receipts
  const btnClearReceipts = document.getElementById('btn-clear-receipts');
  if (btnClearReceipts) {
    btnClearReceipts.addEventListener('click', clearAllReceipts);
  }

  // Tenant search
  document.getElementById('tenant-search-input').addEventListener('input', debounce(fetchTenants, 300));

  // Add Tenant Modal
  document.getElementById('btn-add-tenant').addEventListener('click', () => {
    document.getElementById('tenant-modal-title').textContent = 'Add New Tenant';
    document.getElementById('tenant-form-id').value = '';
    document.getElementById('tenant-form-code').value = '';
    document.getElementById('tenant-form-name').value = '';
    document.getElementById('tenant-form-unit').value = '';
    document.getElementById('tenant-form-email').value = '';
    document.getElementById('tenant-form-phone').value = '';
    document.getElementById('tenant-form-rent').value = '';
    openModal('tenant-modal');
  });

  document.getElementById('btn-save-tenant').addEventListener('click', saveTenant);

  // Export Tenant Database to Excel (.xlsx)
  const btnExportTenants = document.getElementById('btn-export-tenants');
  if (btnExportTenants) {
    btnExportTenants.addEventListener('click', async () => {
      showToast('📥 Downloading Tenant Database Excel spreadsheet...', 'info');
      try {
        const res = await fetch('/api/tenants/export');
        if (!res.ok) throw new Error('Failed to export tenant database');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'NFL_Tenant_Database_Export.xlsx';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Download Sample Template for Tenant Import
  const btnDownloadTemplate = document.getElementById('btn-download-import-template');
  if (btnDownloadTemplate) {
    btnDownloadTemplate.addEventListener('click', async () => {
      showToast('📥 Downloading Sample Tenant Import Template...', 'info');
      try {
        const res = await fetch('/api/tenants/template');
        if (!res.ok) throw new Error('Failed to download template');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'Tenants_Party_Template.xlsx';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Sync Oracle PAYTEMP LEASED_CUSTOMERS_DTLS
  const btnSyncOracle = document.getElementById('btn-sync-oracle');
  if (btnSyncOracle) {
    btnSyncOracle.addEventListener('click', async () => {
      const origText = btnSyncOracle.innerHTML;
      btnSyncOracle.disabled = true;
      btnSyncOracle.innerHTML = '⏳ Syncing Oracle...';
      try {
        const res = await fetch('/api/oracle/sync', { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to sync from Oracle');
        const withEmail = data.withEmailCount || 0;
        const noEmail = data.noEmailCount || 0;
        showToast(`✅ Synced ${data.totalFromOracle} parties from Oracle PAYTEMP (${withEmail} ready with email, ${noEmail} missing email)! Matched ${data.matchedReceipts} receipts.`, 'success');
        fetchStats();
        fetchTenants();
        fetchReceipts();
      } catch (err) {
        showToast(`Oracle Sync Error: ${err.message}`, 'error');
      } finally {
        btnSyncOracle.disabled = false;
        btnSyncOracle.innerHTML = origText;
      }
    });
  }

  // Tenant Filter Buttons (All, Duplicates, Discrepancies, With Email, Missing Email)
  const tenantFilterBtns = document.querySelectorAll('#tenant-filter-btn-group button');
  tenantFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tenantFilterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.tenantsFilter = btn.getAttribute('data-filter') || 'all';
      fetchTenants();
    });
  });

  // Make metric cards clickable to activate filters
  const setupMetricClick = (id, filterName) => {
    const el = document.getElementById(id)?.closest('.metric-item');
    if (el) {
      el.style.cursor = 'pointer';
      el.title = `Click to filter by ${filterName}`;
      el.addEventListener('click', () => {
        const targetBtn = document.querySelector(`#tenant-filter-btn-group button[data-filter="${filterName}"]`);
        if (targetBtn) targetBtn.click();
      });
    }
  };
  setupMetricClick('tenant-stat-total', 'all');
  setupMetricClick('tenant-stat-duplicates', 'duplicates');
  setupMetricClick('tenant-stat-discrepancies', 'discrepancies');
  setupMetricClick('tenant-stat-with-email', 'with_email');
  setupMetricClick('tenant-stat-no-email', 'missing_email');

  // Open Oracle Customer Entry Modal
  const btnOpenOracleModal = document.getElementById('btn-open-oracle-modal');
  if (btnOpenOracleModal) {
    btnOpenOracleModal.addEventListener('click', () => {
      document.getElementById('oracle-form-party-code').value = '';
      document.getElementById('oracle-form-party-name').value = '';
      document.getElementById('oracle-form-email').value = '';
      openModal('oracle-customer-modal');
      setTimeout(() => document.getElementById('oracle-form-party-code').focus(), 150);
    });
  }

  // Save Customer directly to LEASED_CUSTOMERS_DTLS in Oracle DB
  const btnSaveOracleCustomer = document.getElementById('btn-save-oracle-customer');
  if (btnSaveOracleCustomer) {
    btnSaveOracleCustomer.addEventListener('click', async () => {
      const partyCode = document.getElementById('oracle-form-party-code').value.trim();
      const partyName = document.getElementById('oracle-form-party-name').value.trim();
      const email = document.getElementById('oracle-form-email').value.trim();
      const unitNumber = (document.getElementById('oracle-form-unit-number')?.value || '').trim();
      const phone = (document.getElementById('oracle-form-phone')?.value || '').trim();

      if (!partyCode) {
        showToast('Please enter a valid Party Code.', 'error');
        document.getElementById('oracle-form-party-code').focus();
        return;
      }
      if (email && !email.includes('@')) {
        showToast('Please enter a valid Email Address containing @.', 'error');
        document.getElementById('oracle-form-email').focus();
        return;
      }

      const origText = btnSaveOracleCustomer.innerHTML;
      btnSaveOracleCustomer.disabled = true;
      btnSaveOracleCustomer.innerHTML = '⏳ Saving to Oracle DB...';

      try {
        const res = await fetch('/api/oracle/customers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ partyCode, partyName, email, unitNumber, phone })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to save customer to Oracle DB');
        }

        showToast(`✅ Customer ${partyCode} saved to LEASED_CUSTOMERS_DTLS and synchronized!`, 'success');
        closeModal('oracle-customer-modal');

        // Reset form fields
        document.getElementById('oracle-form-party-code').value = '';
        document.getElementById('oracle-form-party-name').value = '';
        document.getElementById('oracle-form-email').value = '';
        if (document.getElementById('oracle-form-unit-number')) document.getElementById('oracle-form-unit-number').value = '';
        if (document.getElementById('oracle-form-phone')) document.getElementById('oracle-form-phone').value = '';

        await fetchStats();
        await fetchTenants();
        await fetchReceipts();
      } catch (err) {
        showToast(`Oracle Insert Error: ${err.message}`, 'error');
      } finally {
        btnSaveOracleCustomer.disabled = false;
        btnSaveOracleCustomer.innerHTML = origText;
      }
    });
  }

  // Import Modal
  document.getElementById('btn-import-tenants').addEventListener('click', () => {
    document.getElementById('import-file-input').value = '';
    document.getElementById('import-file-selected-name').textContent = 'No file selected';
    openModal('import-modal');
  });

  document.getElementById('import-drop-zone').addEventListener('click', () => {
    document.getElementById('import-file-input').click();
  });

  document.getElementById('import-file-input').addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      document.getElementById('import-file-selected-name').textContent = e.target.files[0].name;
    }
  });

  document.getElementById('btn-submit-import').addEventListener('click', async () => {
    const fileInput = document.getElementById('import-file-input');
    if (!fileInput.files.length) {
      showToast('Please choose a CSV or Excel file', 'error');
      return;
    }
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    try {
      const res = await fetch('/api/tenants/import', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showToast(data.message, 'success');
      closeModal('import-modal');
      fetchStats();
      fetchTenants();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Rematch Save
  document.getElementById('btn-rematch-save').addEventListener('click', async () => {
    const tenantId = document.getElementById('rematch-tenant-select').value;
    if (!state.activeRematchId) return;

    await fetch(`/api/receipts/${state.activeRematchId}/rematch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: tenantId ? parseInt(tenantId, 10) : null })
    });

    closeModal('rematch-modal');
    showToast('Receipt mapping updated!', 'success');
    fetchStats();
    fetchReceipts();
  });

  document.getElementById('btn-rematch-unlink').addEventListener('click', async () => {
    if (!state.activeRematchId) return;
    await fetch(`/api/receipts/${state.activeRematchId}/rematch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: null })
    });
    closeModal('rematch-modal');
    showToast('Receipt unlinked from tenant.', 'info');
    fetchStats();
    fetchReceipts();
  });

  // Dispatch Controls
  document.getElementById('btn-start-dispatch').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/email/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onlyPending: true })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showToast(data.message, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-pause-dispatch').addEventListener('click', async () => {
    await fetch('/api/email/pause', { method: 'POST' });
  });

  document.getElementById('btn-resume-dispatch').addEventListener('click', async () => {
    await fetch('/api/email/resume', { method: 'POST' });
  });

  document.getElementById('btn-stop-dispatch').addEventListener('click', async () => {
    await fetch('/api/email/stop', { method: 'POST' });
  });

  document.getElementById('btn-clear-logs').addEventListener('click', async () => {
    await fetch('/api/email/logs', { method: 'DELETE' });
    document.getElementById('terminal-feed').innerHTML = '';
  });

  // Bulk action buttons in Tab 2
  const btnSelectAllPage = document.getElementById('btn-select-all-page');
  if (btnSelectAllPage) {
    btnSelectAllPage.addEventListener('click', selectAllOnCurrentPage);
  }

  const btnDeselectAll = document.getElementById('btn-deselect-all');
  if (btnDeselectAll) {
    btnDeselectAll.addEventListener('click', deselectAllReceipts);
  }

  const btnBulkSelected = document.getElementById('btn-bulk-send-selected');
  if (btnBulkSelected) {
    btnBulkSelected.addEventListener('click', sendSelectedReceipts);
  }

  const btnBulkDeleteSelected = document.getElementById('btn-bulk-delete-selected');
  if (btnBulkDeleteSelected) {
    btnBulkDeleteSelected.addEventListener('click', deleteSelectedReceipts);
  }

  const btnBulkAll = document.getElementById('btn-bulk-send-all');
  if (btnBulkAll) {
    btnBulkAll.addEventListener('click', sendAllMatchedReceipts);
  }

  // Delegated listener for checkbox changes on receipts table
  const receiptsTable = document.getElementById('receipts-table');
  if (receiptsTable) {
    receiptsTable.addEventListener('change', (e) => {
      if (e.target && e.target.id === 'receipts-select-all') {
        handleSelectAllToggle(e.target.checked);
      } else if (e.target && e.target.classList.contains('receipt-row-checkbox')) {
        handleRowCheckboxToggle(e.target);
      }
    });
  }

  // Settings
  document.getElementById('open-settings-btn').addEventListener('click', () => {
    openModal('settings-modal');
  });

  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

  // SMTP Testing
  const btnTestSmtp = document.getElementById('btn-test-smtp');
  if (btnTestSmtp) {
    btnTestSmtp.addEventListener('click', () => testSmtpConnection(false));
  }

  const btnSendTestEmail = document.getElementById('btn-send-test-email');
  if (btnSendTestEmail) {
    btnSendTestEmail.addEventListener('click', () => testSmtpConnection(true));
  }
}

// ==========================================================
// SETTINGS
// ==========================================================
async function fetchSettings() {
  try {
    const res = await fetch('/api/settings');
    state.settings = await res.json();

    document.getElementById('setting-simulation-mode').checked = state.settings.simulation_mode === 'true';
    document.getElementById('setting-smtp-host').value = state.settings.smtp_host || '';
    document.getElementById('setting-smtp-port').value = state.settings.smtp_port || '587';
    const port = parseInt(state.settings.smtp_port || '587', 10);
    document.getElementById('setting-smtp-secure').checked = state.settings.smtp_secure === 'true' || port === 465;
    document.getElementById('setting-smtp-from-name').value = state.settings.smtp_from_name || '';
    document.getElementById('setting-smtp-from-email').value = state.settings.smtp_from_email || '';
    document.getElementById('setting-smtp-user').value = state.settings.smtp_user || '';
    document.getElementById('setting-smtp-pass').value = state.settings.smtp_pass || '';
    document.getElementById('setting-rate-limit').value = state.settings.rate_limit_delay_ms || '600';
    document.getElementById('setting-bulk-mail-path').value = state.settings.bulk_mail_path || 'D:\\estate_bills';
    document.getElementById('setting-email-subject').value = state.settings.email_subject || '';
    document.getElementById('setting-email-body').value = state.settings.email_body_template || '';

    updateSimulationBadge(state.settings.simulation_mode === 'true');

    // Update dispatch template preview card
    const prevSub = document.getElementById('dispatch-preview-subject');
    if (prevSub) prevSub.textContent = state.settings.email_subject || 'Monthly Lease Rent Invoice - {{month}} (Unit: {{unit_number}})';
    const prevSnip = document.getElementById('dispatch-preview-snippet');
    if (prevSnip) {
      const cleanSnippet = (state.settings.email_body_template || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      prevSnip.textContent = cleanSnippet || 'Please find your official monthly invoice attached.';
    }

    // Auto-toggle SSL/TLS when port changes
    const portInput = document.getElementById('setting-smtp-port');
    portInput.removeEventListener('change', autoToggleSmtpSecure);
    portInput.addEventListener('change', autoToggleSmtpSecure);
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

function autoToggleSmtpSecure() {
  const port = parseInt(document.getElementById('setting-smtp-port').value, 10);
  document.getElementById('setting-smtp-secure').checked = (port === 465);
}

async function saveSettings() {
  const updates = {
    simulation_mode: document.getElementById('setting-simulation-mode').checked ? 'true' : 'false',
    smtp_host: document.getElementById('setting-smtp-host').value,
    smtp_port: document.getElementById('setting-smtp-port').value,
    smtp_secure: document.getElementById('setting-smtp-secure').checked ? 'true' : 'false',
    smtp_from_name: document.getElementById('setting-smtp-from-name').value,
    smtp_from_email: document.getElementById('setting-smtp-from-email').value,
    smtp_user: document.getElementById('setting-smtp-user').value,
    smtp_pass: document.getElementById('setting-smtp-pass').value,
    rate_limit_delay_ms: document.getElementById('setting-rate-limit').value,
    bulk_mail_path: document.getElementById('setting-bulk-mail-path').value.trim(),
    email_subject: document.getElementById('setting-email-subject').value,
    email_body_template: (document.getElementById('setting-email-body').value || '')
      .replace(/\\+n/gi, '')
      .replace(/\/n/gi, '')
      .replace(/\\+r/gi, '')
      .replace(/\/r/gi, '')
      .replace(/>\s*[\r\n]+\s*</g, '><')
      .replace(/[\r\n]+/g, ' ')
      .trim()
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const data = await res.json();
    if (!res.ok || (data && data.success === false)) {
      throw new Error(data.error || 'Failed to save settings to database');
    }
    state.settings = { ...state.settings, ...updates };

    // Update dispatch template preview card
    const prevSub = document.getElementById('dispatch-preview-subject');
    if (prevSub) prevSub.textContent = updates.email_subject || 'Monthly Lease Rent Invoice - {{month}} (Unit: {{unit_number}})';
    const prevSnip = document.getElementById('dispatch-preview-snippet');
    if (prevSnip) {
      const cleanSnippet = (updates.email_body_template || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      prevSnip.textContent = cleanSnippet || 'Please find your official monthly invoice attached.';
    }

    // Keep email template modal inputs in sync as well
    const tplSub = document.getElementById('tpl-email-subject');
    if (tplSub) tplSub.value = updates.email_subject || '';
    const tplBody = document.getElementById('tpl-email-body');
    if (tplBody) tplBody.value = updates.email_body_template || '';

    showToast(data.message || 'Settings saved directly to database successfully!', 'success');
    closeModal('settings-modal');
    updateSimulationBadge(updates.simulation_mode === 'true');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function updateSimulationBadge(isSimulation) {
  const container = document.getElementById('simulation-badge-container');
  if (isSimulation) {
    container.innerHTML = `<span class="badge badge-warning" title="Emails are logged safely without external SMTP">🧪 Simulation Mode: Active</span>`;
  } else {
    container.innerHTML = `<span class="badge badge-success" title="Live SMTP is sending real emails">⚡ Live SMTP: Active</span>`;
  }
}

// ==========================================================
// TENANT CRUD
// ==========================================================
async function saveTenant() {
  const id = document.getElementById('tenant-form-id').value;
  const saveBtn = document.getElementById('btn-save-tenant');
  const payload = {
    tenant_code: document.getElementById('tenant-form-code').value.trim(),
    name: document.getElementById('tenant-form-name').value.trim(),
    unit_number: document.getElementById('tenant-form-unit').value.trim(),
    email: document.getElementById('tenant-form-email').value.trim(),
    phone: document.getElementById('tenant-form-phone').value.trim(),
    rent_amount: parseFloat(document.getElementById('tenant-form-rent').value) || 0
  };

  if (!payload.name || !payload.unit_number || !payload.email) {
    showToast('Name, Unit Number, and Email are required!', 'error');
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }

  try {
    const url = id ? `/api/tenants/${id}` : '/api/tenants';
    const method = id ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast(data.message, 'success');
    closeModal('tenant-modal');
    fetchStats();
    fetchTenants();
    fetchReceipts();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Tenant';
    }
  }
}

function openEditTenantModal(tenantOrId) {
  let t = tenantOrId;
  if (typeof tenantOrId === 'number' || typeof tenantOrId === 'string') {
    t = (state.tenants || []).find(item => item.id == tenantOrId);
  }
  if (!t) return;
  document.getElementById('tenant-modal-title').textContent = 'Edit Tenant Details';
  document.getElementById('tenant-form-id').value = t.id;
  document.getElementById('tenant-form-code').value = t.tenant_code || '';
  document.getElementById('tenant-form-name').value = t.name || '';
  document.getElementById('tenant-form-unit').value = t.unit_number || '';
  document.getElementById('tenant-form-email').value = t.email || '';
  document.getElementById('tenant-form-phone').value = t.phone || '';
  document.getElementById('tenant-form-rent').value = t.rent_amount || '';
  openModal('tenant-modal');
}

async function deleteTenant(id) {
  showConfirmModal({
    title: 'Delete Tenant Record',
    message: 'Are you sure you want to permanently delete this tenant? Any receipts linked to this tenant will become unlinked.',
    confirmText: 'Yes, Delete Tenant',
    confirmClass: 'btn-danger',
    onConfirm: async () => {
      try {
        const res = await fetch(`/api/tenants/${id}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Failed to delete tenant');
        }
        showToast(data.message || 'Tenant deleted successfully.', 'info');
        fetchStats();
        fetchTenants();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  });
}

// ==========================================================
// RECEIPT ACTIONS (PREVIEW, REMATCH, DELETE)
// ==========================================================
function openPdfViewer(id, filename) {
  const r = (state.receiptsById && state.receiptsById[id]) ? state.receiptsById[id] : null;
  const name = filename || (r ? (r.original_name || r.originalName) : `Receipt #${id}`);
  document.getElementById('pdf-modal-title').textContent = name;
  const token = getToken();
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
  const pdfUrl = `/api/receipts/${id}/pdf${tokenQuery}`;
  document.getElementById('pdf-modal-iframe').src = pdfUrl;
  document.getElementById('pdf-modal-download').href = pdfUrl;
  openModal('pdf-viewer-modal');
}

function openRematchModal(receiptId, filename, currentTenantId) {
  state.activeRematchId = receiptId;
  const r = (state.receiptsById && state.receiptsById[receiptId]) ? state.receiptsById[receiptId] : null;
  const name = filename || (r ? (r.original_name || r.originalName) : `Receipt #${receiptId}`);
  const tid = (currentTenantId !== undefined && currentTenantId !== null) ? currentTenantId : (r ? (r.tenant_id || r.tenantId) : '');
  document.getElementById('rematch-receipt-filename').textContent = name;
  document.getElementById('rematch-tenant-select').value = tid || '';
  openModal('rematch-modal');
}

function populateRematchDropdown(tenants) {
  const select = document.getElementById('rematch-tenant-select');
  if (!select) return;
  select.innerHTML = `<option value="">-- Choose Tenant / Customer --</option>` +
    (tenants || []).map(t => `<option value="${t.id}">[${escapeHtml(t.tenant_code || '')}] ${escapeHtml(t.name)} (${escapeHtml(t.unit_number || 'N/A')}) - ${escapeHtml(t.email || 'No Email')}</option>`).join('');
}

async function deleteReceipt(id) {
  if (!id) return;
  showConfirmModal({
    title: 'Delete Receipt',
    message: 'Are you sure you want to permanently delete this receipt? This will remove the receipt from the database and permanently delete its file from disk.',
    confirmText: 'Yes, Delete',
    confirmClass: 'btn-danger',
    onConfirm: async () => {
      try {
        const res = await fetch(`/api/receipts/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete receipt');
        state.selectedReceiptIds.delete(parseInt(id, 10));
        showToast('Receipt deleted successfully.', 'info');
        updateBulkSelectedToolbar();
        fetchStats();
        fetchReceipts();
      } catch (err) {
        showToast(`Delete failed: ${err.message}`, 'error');
      }
    }
  });
}

async function clearAllReceipts() {
  showConfirmModal({
    title: 'Clear All Receipts',
    message: 'Are you sure you want to permanently clear <strong>ALL</strong> uploaded receipts? This will delete all files from disk and empty your receipts catalog. This action cannot be undone.',
    confirmText: 'Yes, Clear All Receipts',
    confirmClass: 'btn-danger',
    onConfirm: async () => {
      const btn = document.getElementById('btn-clear-receipts');
      const origText = btn ? btn.innerHTML : '';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '⏳ Clearing...';
      }
      try {
        const res = await fetch('/api/receipts', { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to clear receipts');
        state.selectedReceiptIds.clear();
        updateBulkSelectedToolbar();
        showToast('All receipts have been permanently removed.', 'info');
        fetchStats();
        fetchReceipts();
      } catch (err) {
        showToast(`Clear failed: ${err.message}`, 'error');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = origText;
        }
      }
    }
  });
}

// Global exports
window.deleteReceipt = deleteReceipt;
window.deleteSelectedReceipts = deleteSelectedReceipts;
window.clearAllReceipts = clearAllReceipts;
window.selectAllOnCurrentPage = selectAllOnCurrentPage;
window.deselectAllReceipts = deselectAllReceipts;

// ==========================================================
// MODAL HELPERS
// ==========================================================
let activeConfirmCallback = null;

function showConfirmModal({ title, message, confirmText, confirmClass, onConfirm }) {
  const modal = document.getElementById('confirm-modal');
  if (!modal) {
    const plainText = (message || '').replace(/<[^>]*>/g, '');
    if (window.confirm(plainText)) {
      if (typeof onConfirm === 'function') onConfirm();
    }
    return;
  }

  const titleEl = document.getElementById('confirm-modal-title');
  const msgEl = document.getElementById('confirm-modal-message');
  const actionBtn = document.getElementById('confirm-modal-action-btn');

  if (titleEl) titleEl.textContent = title || 'Confirm Action';
  if (msgEl) msgEl.innerHTML = message || 'Are you sure?';
  if (actionBtn) {
    actionBtn.textContent = confirmText || 'Confirm';
    actionBtn.className = `btn ${confirmClass || 'btn-danger'}`;
  }

  activeConfirmCallback = onConfirm;
  openModal('confirm-modal');
}

function closeConfirmModal(confirmed = false) {
  closeModal('confirm-modal');
  if (confirmed && typeof activeConfirmCallback === 'function') {
    const cb = activeConfirmCallback;
    activeConfirmCallback = null;
    cb();
  } else {
    activeConfirmCallback = null;
  }
}
window.showConfirmModal = showConfirmModal;
window.closeConfirmModal = closeConfirmModal;

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('active');
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('active');
  if (modalId === 'pdf-viewer-modal') {
    const iframe = document.getElementById('pdf-modal-iframe');
    if (iframe) iframe.src = '';
  }
}

// Close on outside click
document.querySelectorAll('.modal-overlay').forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal(modal.id);
    }
  });
});

// ==========================================================
// TOAST NOTIFICATIONS
// ==========================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icon = type === 'success' ? '✅' : (type === 'error' ? '❌' : 'ℹ️');
  toast.innerHTML = `<span>${icon}</span> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

// ==========================================================
// UTILITIES
// ==========================================================
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// ==========================================================
// SMTP TESTING
// ==========================================================
async function testSmtpConnection(sendActualEmail = false) {
  const host = document.getElementById('setting-smtp-host').value.trim();
  const port = document.getElementById('setting-smtp-port').value.trim();
  const user = document.getElementById('setting-smtp-user').value.trim();
  const pass = document.getElementById('setting-smtp-pass').value.trim();
  const fromName = document.getElementById('setting-smtp-from-name').value.trim();
  const fromEmail = document.getElementById('setting-smtp-from-email').value.trim();
  const testRecipient = document.getElementById('setting-test-recipient').value.trim();

  const feedbackBox = document.getElementById('smtp-test-feedback');
  const btnTest = document.getElementById('btn-test-smtp');
  const btnSend = document.getElementById('btn-send-test-email');

  if (!host || !user || !pass) {
    showToast('Please enter SMTP Host, Username (Email), and Password.', 'error');
    if (feedbackBox) {
      feedbackBox.style.display = 'block';
      feedbackBox.className = 'smtp-feedback-box error';
      feedbackBox.innerHTML = '⚠️ <strong>Missing Credentials:</strong> Please fill in the SMTP Host, Username (Email), and Password before testing.';
    }
    return;
  }

  if (sendActualEmail && !testRecipient) {
    showToast('Please enter a recipient email address to send a test email to.', 'warning');
    const recipientInput = document.getElementById('setting-test-recipient');
    if (recipientInput) recipientInput.focus();
    return;
  }

  const activeBtn = sendActualEmail ? btnSend : btnTest;
  const originalText = activeBtn.innerHTML;
  activeBtn.disabled = true;
  activeBtn.innerHTML = '⏳ Testing...';

  if (feedbackBox) {
    feedbackBox.style.display = 'block';
    feedbackBox.className = 'smtp-feedback-box loading';
    feedbackBox.innerHTML = `⏳ Connecting to <strong>${escapeHtml(host)}:${escapeHtml(port)}</strong> and verifying credentials...`;
  }

  try {
    const res = await fetch('/api/email/test-smtp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        smtp_host: host,
        smtp_port: port,
        smtp_secure: document.getElementById('setting-smtp-secure').checked ? 'true' : 'false',
        smtp_user: user,
        smtp_pass: pass,
        smtp_from_name: fromName,
        smtp_from_email: fromEmail,
        test_recipient: sendActualEmail ? testRecipient : ''
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast(data.message, 'success');
    if (feedbackBox) {
      feedbackBox.className = 'smtp-feedback-box success';
      feedbackBox.innerHTML = `✅ <strong>Success:</strong> ${escapeHtml(data.message)}`;
    }
  } catch (err) {
    showToast(`SMTP Error: ${err.message}`, 'error');
    if (feedbackBox) {
      feedbackBox.className = 'smtp-feedback-box error';
      feedbackBox.innerHTML = `❌ <strong>Connection Failed:</strong><br>${escapeHtml(err.message)}`;
    }
  } finally {
    activeBtn.disabled = false;
    activeBtn.innerHTML = originalText;
  }
}

// ==========================================================
// EDIT & SEND EMAIL MODAL (Custom Single / Group Dispatch)
// ==========================================================
async function openEditEmailModal(receiptIds) {
  if (!receiptIds || receiptIds.length === 0) return;

  try {
    const res = await fetch('/api/email/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiptIds })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const prev = data.preview;

    document.getElementById('edit-mail-receipt-ids').value = JSON.stringify(receiptIds);
    document.getElementById('edit-mail-recipient-name').value = prev.tenantName || 'Tenant';
    document.getElementById('edit-mail-recipient-email').value = prev.tenantEmail || '';
    document.getElementById('edit-mail-subject').value = prev.subject || '';
    document.getElementById('edit-mail-body').value = prev.body || '';
    document.getElementById('edit-mail-save-as-default').checked = false;

    // Attachments pills
    const attList = document.getElementById('edit-mail-attachments-list');
    if (attList) {
      attList.innerHTML = (prev.attachments || []).map(att => `
        <span class="badge badge-info" style="font-size: 0.8rem; padding: 4px 8px;">
          📎 ${escapeHtml(att.name)}
        </span>
      `).join('');
    }

    // Hide preview box initially
    const prevBox = document.getElementById('edit-mail-preview-box');
    if (prevBox) prevBox.style.display = 'none';
    const toggleBtn = document.getElementById('btn-toggle-edit-preview');
    if (toggleBtn) toggleBtn.innerHTML = '👁️ Preview HTML';

    openModal('edit-send-email-modal');
  } catch (err) {
    showToast(`Cannot open email editor: ${err.message}`, 'error');
  }
}

function toggleEditMailPreview() {
  const box = document.getElementById('edit-mail-preview-box');
  const btn = document.getElementById('btn-toggle-edit-preview');
  if (!box) return;

  if (box.style.display === 'none' || !box.style.display) {
    const rawBody = document.getElementById('edit-mail-body').value;
    const subject = document.getElementById('edit-mail-subject').value;
    const recipient = document.getElementById('edit-mail-recipient-email').value;

    document.getElementById('edit-mail-preview-render').innerHTML = `
      <div style="border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 12px; font-size: 0.85rem; color: #475569;">
        <div><strong>To:</strong> ${escapeHtml(recipient)}</div>
        <div><strong>Subject:</strong> ${escapeHtml(subject)}</div>
      </div>
      <div>${rawBody}</div>
    `;
    box.style.display = 'block';
    if (btn) btn.innerHTML = '✕ Hide Preview';
  } else {
    box.style.display = 'none';
    if (btn) btn.innerHTML = '👁️ Preview HTML';
  }
}

function insertTokenIntoEditMail(token) {
  const textarea = document.getElementById('edit-mail-body');
  if (!textarea) return;
  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const text = textarea.value;
  textarea.value = text.substring(0, start) + token + text.substring(end);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + token.length;
}

async function submitEditMailSend() {
  const receiptIdsRaw = document.getElementById('edit-mail-receipt-ids').value;
  if (!receiptIdsRaw) return;

  const receiptIds = JSON.parse(receiptIdsRaw);
  const customRecipientEmail = document.getElementById('edit-mail-recipient-email').value.trim();
  const customSubject = document.getElementById('edit-mail-subject').value.trim();
  let customBody = (document.getElementById('edit-mail-body').value || '')
    .replace(/\\+n/gi, '')
    .replace(/\/n/gi, '')
    .replace(/\\+r/gi, '')
    .replace(/\/r/gi, '')
    .replace(/>\s*[\r\n]+\s*</g, '><')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  const saveAsDefault = document.getElementById('edit-mail-save-as-default').checked;

  if (!customRecipientEmail) {
    showToast('Recipient email is required!', 'error');
    return;
  }
  if (!customSubject) {
    showToast('Email subject is required!', 'error');
    return;
  }
  if (!customBody) {
    showToast('Email body is required!', 'error');
    return;
  }

  const btn = document.getElementById('btn-submit-edit-send');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ Sending Email...';

  try {
    const res = await fetch('/api/email/send-group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiptIds,
        customSubject,
        customBody,
        customRecipientEmail,
        saveAsDefault
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast(data.message || 'Email sent successfully!', 'success');
    closeModal('edit-send-email-modal');

    if (saveAsDefault) {
      await fetchSettings();
    }

    fetchStats();
    fetchReceipts();
    fetchGroupedReceipts();
  } catch (err) {
    showToast(`Failed to send email: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// ==========================================================
// DEDICATED EMAIL TEMPLATE MODAL (Quick Global Template Editor)
// ==========================================================
async function openEmailTemplateModal() {
  try {
    const res = await fetch('/api/templates/active');
    const data = await res.json();
    if (data && data.success && data.template) {
      document.getElementById('tpl-email-subject').value = data.template.subject || '';
      document.getElementById('tpl-email-body').value = data.template.body_html || '';
    } else if (state.settings) {
      document.getElementById('tpl-email-subject').value = state.settings.email_subject || 'Monthly Lease Rent Invoice - {{month}} (Unit: {{unit_number}})';
      document.getElementById('tpl-email-body').value = state.settings.email_body_template || '';
    }
  } catch (e) {
    if (state.settings) {
      document.getElementById('tpl-email-subject').value = state.settings.email_subject || 'Monthly Lease Rent Invoice - {{month}} (Unit: {{unit_number}})';
      document.getElementById('tpl-email-body').value = state.settings.email_body_template || '';
    }
  }

  const prevBox = document.getElementById('tpl-preview-box');
  if (prevBox) prevBox.style.display = 'none';
  const toggleBtn = document.getElementById('btn-tpl-toggle-preview');
  if (toggleBtn) toggleBtn.innerHTML = '👁️ Preview HTML';

  openModal('email-template-modal');
}

function insertTokenIntoTemplate(token) {
  const textarea = document.getElementById('tpl-email-body');
  if (!textarea) return;
  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const text = textarea.value;
  textarea.value = text.substring(0, start) + token + text.substring(end);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + token.length;
}

function toggleTemplatePreview() {
  const box = document.getElementById('tpl-preview-box');
  const btn = document.getElementById('btn-tpl-toggle-preview');
  if (!box) return;

  if (box.style.display === 'none' || !box.style.display) {
    let rawBody = document.getElementById('tpl-email-body').value;
    let subject = document.getElementById('tpl-email-subject').value;

    const sampleVars = {
      tenant_name: 'Laxman NFL HR',
      unit_number: 'Flat 402',
      month: 'Aug-2026',
      amount: '5202.00',
      date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    };

    for (const [k, v] of Object.entries(sampleVars)) {
      subject = subject.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'gi'), v);
      rawBody = rawBody.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'gi'), v);
    }

    document.getElementById('tpl-preview-render').innerHTML = `
      <div style="border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 12px; font-size: 0.85rem; color: #475569;">
        <div><strong>Sample Subject:</strong> ${escapeHtml(subject)}</div>
      </div>
      <div>${rawBody}</div>
    `;
    box.style.display = 'block';
    if (btn) btn.innerHTML = '✕ Hide Preview';
  } else {
    box.style.display = 'none';
    if (btn) btn.innerHTML = '👁️ Preview HTML';
  }
}

async function saveEmailTemplateFromModal() {
  const subject = document.getElementById('tpl-email-subject').value.trim();
  let body = (document.getElementById('tpl-email-body').value || '')
    .replace(/\\+n/gi, '')
    .replace(/\/n/gi, '')
    .replace(/\\+r/gi, '')
    .replace(/\/r/gi, '')
    .replace(/>\s*[\r\n]+\s*</g, '><')
    .replace(/[\r\n]+/g, ' ')
    .trim();

  if (!subject) {
    showToast('Email subject is required!', 'error');
    return;
  }
  if (!body) {
    showToast('Email body is required!', 'error');
    return;
  }

  const btn = document.getElementById('btn-save-tpl');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ Saving to Database...';

  try {
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_key: 'monthly_lease_invoice',
        name: 'Monthly Lease Rent Invoice',
        subject: subject,
        body_html: body,
        is_default: 1
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed saving email template');

    if (state.settings) {
      state.settings.email_subject = subject;
      state.settings.email_body_template = body;
    }

    // Sync settings modal inputs as well
    const sSub = document.getElementById('setting-email-subject');
    if (sSub) sSub.value = subject;
    const sBody = document.getElementById('setting-email-body');
    if (sBody) sBody.value = body;

    // Sync dispatch preview card
    const prevSub = document.getElementById('dispatch-preview-subject');
    if (prevSub) prevSub.textContent = subject;
    const prevSnip = document.getElementById('dispatch-preview-snippet');
    if (prevSnip) {
      prevSnip.textContent = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    showToast('Email template saved directly to database!', 'success');
    closeModal('email-template-modal');
  } catch (err) {
    showToast(`Failed to save template: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

