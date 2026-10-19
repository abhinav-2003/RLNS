const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { run, get, all, initDb } = require('./database');
const { extractPdfMetadata } = require('./pdfProcessor');
const { matchReceiptToTenant, extractPartyCodeFromFilename } = require('./matchingEngine');
const emailService = require('./emailService');
const nodemailer = require('nodemailer');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 5178;
const HOST = process.env.HOST || '0.0.0.0';

// Setup directories
const UPLOADS_DIR = process.env.ESTATE_BILLS_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
const TEMP_UPLOADS_DIR = path.join(UPLOADS_DIR, 'temp');
if (!fs.existsSync(TEMP_UPLOADS_DIR)) {
  fs.mkdirSync(TEMP_UPLOADS_DIR, { recursive: true });
}

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    // Keep clean filename with timestamp to prevent collisions
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-]/g, '_');
    cb(null, `${Date.now()}-${base}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB per PDF
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'), false);
    }
  }
});

const uploadDoc = multer({
  dest: TEMP_UPLOADS_DIR,
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

// Authentication Token & Session Management
const crypto = require('crypto');
const activeSessions = new Map(); // token -> user object
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours session expiry

// Periodic session cleanup
setInterval(async () => {
  const now = Date.now();
  for (const [t, s] of activeSessions.entries()) {
    if (s.createdAt && (now - new Date(s.createdAt).getTime() > SESSION_TTL_MS)) {
      activeSessions.delete(t);
    }
  }
  if (activeSessions.size === 0) {
    try {
      const { closePool } = require('./database');
      await closePool(2);
      console.log('[Auth] 💤 All sessions expired/cleared. Suspended Oracle connection pool.');
    } catch (e) {}
  }
}, 60 * 60 * 1000).unref();

function authenticateToken(req, res, next) {
  // Allow public static assets and auth login endpoint
  if (!req.path.startsWith('/api/') || req.path === '/api/auth/login' || req.path === '/api/health') {
    return next();
  }

  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.substring(7) : (req.query.token || req.body?.token);

  if (!token || !activeSessions.has(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized. Please sign in to access Lease Billing Application.' });
  }

  const session = activeSessions.get(token);
  if (session && session.createdAt && (Date.now() - new Date(session.createdAt).getTime() > SESSION_TTL_MS)) {
    activeSessions.delete(token);
    return res.status(401).json({ success: false, error: 'Session expired. Please sign in again.' });
  }

  req.user = session;
  next();
}

app.use(authenticateToken);

// Login API Endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required.' });
    }

    const { hashPassword } = require('./database');
    const hashed = hashPassword(password);
    const user = await get('SELECT id, username, name, role FROM users WHERE LOWER(username) = LOWER(?) AND password_hash = ?', [username.trim(), hashed]);

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid username or password.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const sessionData = { id: user.id, username: user.username, name: user.name, role: user.role, createdAt: new Date() };
    activeSessions.set(token, sessionData);

    console.log(`[Auth] User '${user.username}' (${user.role}) logged in successfully.`);
    res.json({ success: true, token, user: sessionData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Current User API Endpoint
app.get('/api/auth/me', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  res.json({ success: true, user: req.user });
});

// Logout API Endpoint - revokes token and closes ALL Oracle connections immediately
app.post('/api/auth/logout', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.substring(7) : req.body?.token;
    if (token) {
      activeSessions.delete(token);
    }

    // Always close and suspend all Oracle DB connections on user logout
    const { closePool } = require('./database');
    await closePool(2);
    console.log('[Auth] 🚪 User logged out. All Oracle database connections closed and suspended.');

    res.json({ success: true, message: 'Logged out successfully. All Oracle DB connections closed.' });
  } catch (err) {
    console.error('[Auth] Error during logout/connection teardown:', err.message);
    res.json({ success: true, message: 'Logged out successfully' });
  }
});

// Oracle Connection Diagnostics & Pool Status Endpoint
app.get('/api/oracle/connection-status', (req, res) => {
  const { getPoolMetrics } = require('./database');
  const metrics = getPoolMetrics();
  res.json({
    success: true,
    oracle: metrics,
    activeSessions: activeSessions.size,
    timestamp: new Date().toISOString()
  });
});

// Explicit Manual Suspend Endpoint (Admin or maintenance)
app.post('/api/oracle/suspend', async (req, res) => {
  try {
    const { closePool } = require('./database');
    await closePool(2);
    res.json({ success: true, message: 'All Oracle database connections suspended and server processes released.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Healthcheck endpoint for Docker container and intranet monitoring
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'rlns-backend',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// 1. STATS & OVERVIEW
// ==========================================
app.get('/api/stats', async (req, res) => {
  try {
    const totalReceipts = (await get('SELECT COUNT(*) as cnt FROM receipts')).cnt;
    const matchedReceipts = (await get('SELECT COUNT(*) as cnt FROM receipts WHERE tenant_id IS NOT NULL AND match_confidence = 100')).cnt;
    const unmatchedReceipts = (await get('SELECT COUNT(*) as cnt FROM receipts WHERE tenant_id IS NULL OR match_confidence < 100')).cnt;
    const sentReceipts = (await get("SELECT COUNT(*) as cnt FROM receipts WHERE email_status = 'sent'")).cnt;
    const failedReceipts = (await get("SELECT COUNT(*) as cnt FROM receipts WHERE email_status = 'failed'")).cnt;
    const pendingReceipts = (await get("SELECT COUNT(*) as cnt FROM receipts WHERE email_status = 'pending' AND tenant_id IS NOT NULL AND match_confidence = 100")).cnt;
    const totalTenants = (await get('SELECT COUNT(*) as cnt FROM tenants')).cnt;
    const uniqueParties = (await get('SELECT COUNT(DISTINCT tenant_code) as cnt FROM tenants')).cnt;
    const duplicateParties = (await get("SELECT COUNT(*) as cnt FROM tenants WHERE tags LIKE '%duplicate%'")).cnt;
    const discrepancies = (await get("SELECT COUNT(*) as cnt FROM tenants WHERE tags NOT LIKE '%clean%' AND tags IS NOT NULL")).cnt;

    res.json({
      totalReceipts,
      matchedReceipts,
      unmatchedReceipts,
      sentReceipts,
      failedReceipts,
      pendingReceipts,
      totalTenants,
      uniqueParties,
      duplicateParties,
      discrepancies,
      matchRate: totalReceipts > 0 ? Math.round((matchedReceipts / totalReceipts) * 100) : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. RECEIPT BULK UPLOADS & MANAGEMENT
// ==========================================
// Bulk upload endpoint (handles up to 1500 files via batched client requests)
app.post('/api/receipts/upload', upload.array('receipts', 150), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No PDF files were uploaded.' });
    }

    const allTenants = await all('SELECT * FROM tenants');
    const results = [];

    for (const file of req.files) {
      // Extract text & metadata from PDF
      const meta = await extractPdfMetadata(file.path, file.originalname);
      const partyCode = meta.partyCode || extractPartyCodeFromFilename(file.originalname);

      // Attempt auto-matching
      const match = matchReceiptToTenant({
        original_name: file.originalname,
        filename: file.filename,
        party_code: partyCode,
        extracted_text: meta.rawText,
        extracted_name: meta.extractedName,
        extracted_unit: meta.extractedUnit,
        extracted_email: meta.extractedEmail
      }, allTenants);

      const insertResult = await run(`
        INSERT INTO receipts (
          filename, original_name, file_path, file_size,
          party_code, extracted_text, extracted_name, extracted_unit, extracted_amount, extracted_month,
          tenant_id, match_confidence, match_reason, email_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `, [
        file.filename,
        file.originalname,
        file.path,
        file.size,
        partyCode,
        meta.rawText,
        meta.extractedName,
        meta.extractedUnit,
        meta.extractedAmount,
        meta.extractedMonth,
        match ? match.tenantId : null,
        match ? match.confidence : 0,
        match ? match.reason : null
      ]);

      results.push({
        id: insertResult.lastID,
        filename: file.originalname,
        matched: !!match,
        tenantName: match ? match.tenantName : null
      });
    }

    res.json({
      message: `Successfully processed ${req.files.length} receipts`,
      processed: results.length,
      matched: results.filter(r => r.matched).length
    });
  } catch (err) {
    console.error('Upload processing error:', err);
    res.status(500).json({ error: err.message });
  }
});

const { splitAndExtractPdf } = require('../split_pdf_by_page');

const uploadMaster = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const tempDir = TEMP_UPLOADS_DIR;
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      cb(null, tempDir);
    },
    filename: (req, file, cb) => {
      cb(null, `master-${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9_\.-]/g, '_')}`);
    }
  }),
  limits: { fileSize: 350 * 1024 * 1024 } // Up to 350 MB for ~1500 page PDF
});

// Master Multi-Page PDF upload & split endpoint
app.post('/api/receipts/upload-master-pdf', uploadMaster.single('masterPdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a master PDF file.' });
    }

    const masterPath = req.file.path;
    console.log(`Processing multi-page master PDF: ${req.file.originalname}`);

    // Split pages into UPLOADS_DIR
    const splitResult = await splitAndExtractPdf(masterPath, UPLOADS_DIR);
    // Auto-sync Oracle customer records so receipts link immediately
    try {
      await syncOracleTenants();
    } catch (e) {
      console.warn('Oracle auto-sync warning:', e.message);
    }

    const allTenants = await all('SELECT * FROM tenants');
    let matchedCount = 0;
    await run('BEGIN TRANSACTION');
    try {
      for (const item of splitResult.results) {
        const match = matchReceiptToTenant({
          original_name: item.filename,
          party_code: item.partyCode,
          extracted_text: item.rawText,
          extracted_name: item.partyName,
          extracted_unit: item.unitNumber,
          extracted_email: ''
        }, allTenants);

        if (match) matchedCount++;

        await run(`
          INSERT INTO receipts (
            filename, original_name, file_path, file_size,
            party_code, extracted_text, extracted_name, extracted_unit, extracted_amount,
            extracted_month,
            tenant_id, match_confidence, match_reason, email_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `, [
          item.filename,
          item.filename,
          item.filePath,
          item.fileSize,
          item.partyCode,
          item.rawText,
          item.partyName,
          item.unitNumber,
          item.amount,
          splitResult.month || null,
          match ? match.tenantId : null,
          match ? match.confidence : 0,
          match ? match.reason : null
        ]);
      }
      await run('COMMIT');
    } catch (insertErr) {
      await run('ROLLBACK');
      throw insertErr;
    }

    // Clean up temporary master upload
    try { fs.unlinkSync(masterPath); } catch (e) { }

    res.json({
      success: true,
      message: `Successfully split master PDF into ${splitResult.totalPages} individual receipts! Extracted ${splitResult.foundCount} party codes. Saved to ${splitResult.outputDir}.`,
      totalPages: splitResult.totalPages,
      partyCodesExtracted: splitResult.foundCount,
      matchedTenants: matchedCount,
      month: splitResult.month,
      outputDir: splitResult.outputDir
    });
  } catch (err) {
    console.error('Master PDF split error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List receipts with pagination and search
app.get('/api/receipts', async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '50', 10);
    const search = req.query.search || '';
    const status = req.query.status || 'all'; // all, matched, unmatched, sent, failed, pending
    const offset = (page - 1) * limit;

    let whereConditions = ['1=1'];
    let params = [];

    if (search) {
      whereConditions.push('(r.original_name LIKE ? OR r.party_code LIKE ? OR t.tenant_code LIKE ? OR r.extracted_name LIKE ? OR r.extracted_unit LIKE ? OR t.name LIKE ? OR t.email LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s, s, s, s);
    }

    if (status === 'matched') {
      whereConditions.push('r.tenant_id IS NOT NULL AND r.match_confidence = 100');
    } else if (status === 'unmatched') {
      whereConditions.push('(r.tenant_id IS NULL OR r.match_confidence < 100)');
    } else if (status === 'sent') {
      whereConditions.push("r.email_status = 'sent'");
    } else if (status === 'failed') {
      whereConditions.push("r.email_status = 'failed'");
    } else if (status === 'pending') {
      whereConditions.push("r.email_status = 'pending'");
    }

    const whereClause = whereConditions.join(' AND ');

    const countRow = await get(`
      SELECT COUNT(*) as count 
      FROM receipts r
      LEFT JOIN tenants t ON r.tenant_id = t.id
      WHERE ${whereClause}
    `, params);

    const total = countRow.count;

    const receipts = await all(`
      SELECT 
        r.id, r.filename, r.original_name, r.file_size, r.party_code,
        r.extracted_name, r.extracted_unit, r.extracted_amount, r.extracted_month,
        r.match_confidence, r.match_reason, r.email_status, r.sent_at, r.error_message, r.created_at,
        t.id as tenant_id, t.tenant_code as tenant_party_code, t.name as tenant_name, t.email as tenant_email, t.unit_number as tenant_unit
      FROM receipts r
      LEFT JOIN tenants t ON r.tenant_id = t.id
      WHERE ${whereClause}
      ORDER BY r.id DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({
      receipts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve PDF file directly for browser preview
app.get('/api/receipts/:id/pdf', async (req, res) => {
  try {
    const receipt = await get('SELECT file_path, original_name FROM receipts WHERE id = ?', [req.params.id]);
    if (!receipt || !fs.existsSync(receipt.file_path)) {
      return res.status(404).send('PDF file not found on disk');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${receipt.original_name}"`);
    fs.createReadStream(receipt.file_path).pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Manually link / remap a receipt to a tenant
app.post('/api/receipts/:id/rematch', async (req, res) => {
  try {
    const { tenantId } = req.body;
    if (tenantId === null || tenantId === undefined || tenantId === '') {
      // Unlink
      await run('UPDATE receipts SET tenant_id = NULL, match_confidence = 0, match_reason = "Manually unlinked" WHERE id = ?', [req.params.id]);
      return res.json({ success: true, message: 'Receipt unlinked from tenant' });
    }

    const tenant = await get('SELECT * FROM tenants WHERE id = ?', [tenantId]);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    await run(`
      UPDATE receipts 
      SET tenant_id = ?, match_confidence = 100, match_reason = 'Manually linked by user' 
      WHERE id = ?
    `, [tenantId, req.params.id]);

    res.json({ success: true, message: `Linked to ${tenant.name}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-run matching algorithm across all unmatched receipts
app.post('/api/receipts/rematch-all', async (req, res) => {
  try {
    const receiptsToMatch = await all('SELECT * FROM receipts');
    const tenants = await all('SELECT * FROM tenants');
    let newlyMatched = 0;

    for (const receipt of receiptsToMatch) {
      if (!receipt.party_code) {
        receipt.party_code = extractPartyCodeFromFilename(receipt.original_name);
      }

      const match = matchReceiptToTenant(receipt, tenants);
      if (match) {
        await run(`
          UPDATE receipts 
          SET tenant_id = ?, match_confidence = ?, match_reason = ?, party_code = COALESCE(party_code, ?)
          WHERE id = ?
        `, [match.tenantId, match.confidence, match.reason, receipt.party_code, receipt.id]);
        newlyMatched++;
      }
    }

    res.json({
      success: true,
      message: `Smart matching completed. ${newlyMatched} receipts linked to tenants.`,
      matchedCount: newlyMatched
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk delete selected receipts
app.post('/api/receipts/delete-selected', async (req, res) => {
  try {
    const { receiptIds } = req.body;
    if (!receiptIds || !Array.isArray(receiptIds) || receiptIds.length === 0) {
      return res.status(400).json({ error: 'No receipt IDs provided for deletion.' });
    }

    const numericIds = receiptIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    if (numericIds.length === 0) {
      return res.status(400).json({ error: 'No valid numeric receipt IDs provided for deletion.' });
    }

    console.log(`[DELETE-SELECTED] Request to delete ${numericIds.length} receipts:`, numericIds.slice(0, 10));

    const placeholders = numericIds.map(() => '?').join(',');
    const files = await all(`SELECT file_path FROM receipts WHERE id IN (${placeholders})`, numericIds);
    for (const f of files) {
      if (f.file_path && fs.existsSync(f.file_path)) {
        try { fs.unlinkSync(f.file_path); } catch (e) { }
      }
    }

    const result = await run(`DELETE FROM receipts WHERE id IN (${placeholders})`, numericIds);
    console.log(`[DELETE-SELECTED] Successfully deleted ${result.changes || numericIds.length} receipts.`);
    res.json({
      success: true,
      message: `Deleted ${result.changes || numericIds.length} receipt(s).`,
      deletedCount: result.changes || numericIds.length
    });
  } catch (err) {
    console.error('[DELETE-SELECTED] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete single receipt
app.delete('/api/receipts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    console.log(`[DELETE-SINGLE] Request to delete receipt #${id}`);
    const receipt = await get('SELECT file_path FROM receipts WHERE id = ?', [id]);
    if (receipt && receipt.file_path && fs.existsSync(receipt.file_path)) {
      try { fs.unlinkSync(receipt.file_path); } catch (e) { }
    }
    await run('DELETE FROM receipts WHERE id = ?', [id]);
    console.log(`[DELETE-SINGLE] Successfully deleted receipt #${id}.`);
    res.json({ success: true, message: 'Receipt deleted' });
  } catch (err) {
    console.error(`[DELETE-SINGLE] Error on #${req.params.id}:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Clear all receipts
app.delete('/api/receipts', async (req, res) => {
  try {
    console.log('[CLEAR-ALL] Request to clear all receipts');
    const allFiles = await all('SELECT file_path FROM receipts');
    for (const r of allFiles) {
      if (r.file_path && fs.existsSync(r.file_path)) {
        try { fs.unlinkSync(r.file_path); } catch (e) { }
      }
    }
    const result = await run('DELETE FROM receipts');
    console.log(`[CLEAR-ALL] Successfully cleared all receipts (${result.changes} deleted).`);
    res.json({ success: true, message: 'All receipts cleared' });
  } catch (err) {
    console.error('[CLEAR-ALL] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. TENANT DIRECTORY (DB, CSV/EXCEL IMPORT)
// ==========================================
// List all tenants (supports search and filter=all|with_email|missing_email|duplicates|discrepancies|clean)
app.get('/api/tenants', async (req, res) => {
  try {
    const search = req.query.search || '';
    const filter = req.query.filter || 'all';
    let query = 'SELECT * FROM tenants WHERE 1=1';
    let params = [];

    if (filter === 'with_email') {
      query += " AND email IS NOT NULL AND email != '' AND email LIKE '%@%'";
    } else if (filter === 'missing_email') {
      query += " AND (email IS NULL OR email = '' OR email NOT LIKE '%@%')";
    } else if (filter === 'duplicates') {
      query += " AND (tags LIKE '%duplicate%')";
    } else if (filter === 'discrepancies') {
      query += " AND (tags NOT LIKE '%clean%' AND tags IS NOT NULL AND tags != '')";
    } else if (filter === 'clean') {
      query += " AND (tags LIKE '%clean%')";
    }

    if (search) {
      query += ' AND (name LIKE ? OR unit_number LIKE ? OR email LIKE ? OR tenant_code LIKE ? OR tags LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }

    query += ' ORDER BY tenant_code ASC, unit_number ASC';
    const tenants = await all(query, params);
    res.json(tenants);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new tenant
app.post('/api/tenants', async (req, res) => {
  try {
    const { name, unit_number, email, phone, tenant_code, rent_amount } = req.body;
    if (!name || !unit_number) {
      return res.status(400).json({ error: 'Name and Unit Number are required!' });
    }

    const code = (tenant_code || `TNT-${Date.now().toString().slice(-4)}`).trim();
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanName = name.trim();

    // Check if tenant_code is already in use to prevent silent overwrites
    const existing = await get('SELECT id, name FROM tenants WHERE tenant_code = ?', [code]);
    if (existing) {
      return res.status(409).json({ error: `Party Code "${code}" is already assigned to tenant "${existing.name}". Please use a unique Party Code.` });
    }

    const result = await run(`
      INSERT INTO tenants (tenant_code, name, unit_number, email, phone, rent_amount)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [code, cleanName, unit_number.trim(), cleanEmail, phone || '', rent_amount || 0]);

    // Push real-time to Oracle in background if valid email provided
    if (cleanEmail && cleanEmail.includes('@')) {
      addLeasedCustomerToOracle({ partyCode: code, partyName: cleanName, email: cleanEmail, unitNumber: unit_number.trim(), phone: phone || '' })
        .catch(oe => console.warn('Oracle push notice:', oe.message));
    }
    recreateJsonCache().catch(() => {});

    res.json({ id: result.lastID, success: true, message: `Tenant ${cleanName} saved successfully!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update tenant
app.put('/api/tenants/:id', async (req, res) => {
  try {
    const { name, unit_number, email, phone, tenant_code, rent_amount } = req.body;
    if (!name || !unit_number) {
      return res.status(400).json({ error: 'Name and Unit Number are required!' });
    }

    const cleanCode = (tenant_code || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanName = name.trim();

    if (cleanCode) {
      const existing = await get('SELECT id, name FROM tenants WHERE tenant_code = ? AND id != ?', [cleanCode, req.params.id]);
      if (existing) {
        return res.status(409).json({ error: `Party Code "${cleanCode}" is already assigned to tenant "${existing.name}".` });
      }
    }

    await run(`
      UPDATE tenants 
      SET tenant_code = ?, name = ?, unit_number = ?, email = ?, phone = ?, rent_amount = ?
      WHERE id = ?
    `, [cleanCode, cleanName, unit_number.trim(), cleanEmail, phone || '', rent_amount || 0, req.params.id]);

    // Push real-time update to Oracle in background if valid email provided
    if (cleanCode && cleanEmail && cleanEmail.includes('@')) {
      addLeasedCustomerToOracle({ partyCode: cleanCode, partyName: cleanName, email: cleanEmail, unitNumber: unit_number.trim(), phone: phone || '' })
        .catch(oe => console.warn('Oracle update notice:', oe.message));
    }
    recreateJsonCache().catch(() => {});

    res.json({ success: true, message: 'Tenant updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete tenant
app.delete('/api/tenants/:id', async (req, res) => {
  try {
    // Get tenant_code before deleting so we can also remove from Oracle
    const tenant = await get('SELECT tenant_code FROM tenants WHERE id = ?', [req.params.id]);
    await run('DELETE FROM tenants WHERE id = ?', [req.params.id]);

    // Also delete from Oracle LEASED_CUSTOMERS_DTLS immediately
    if (tenant && tenant.tenant_code) {
      try {
        await deleteLeasedCustomerFromOracle(tenant.tenant_code);
      } catch (oe) {
        console.warn('Oracle delete notice:', oe.message);
      }
    }

    await recreateJsonCache();
    res.json({ success: true, message: 'Tenant deleted from local database and Oracle.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all tenants - DISABLED for safety
app.delete('/api/tenants', async (req, res) => {
  return res.status(403).json({ 
    success: false, 
    error: 'Clearing the tenant database is disabled to prevent accidental data loss.' 
  });
});

// Export all tenant database records as an Excel spreadsheet (.xlsx)
app.get('/api/tenants/export', async (req, res) => {
  try {
    const tenants = await all('SELECT tenant_code, name, unit_number, email, phone, rent_amount FROM tenants ORDER BY tenant_code ASC');

    const formattedData = (tenants && tenants.length > 0) ? tenants.map(t => ({
      'Party Code': t.tenant_code || '',
      'Party / Tenant Name': t.name || '',
      'Unit / Flat No': t.unit_number || '',
      'Email Address': t.email || '',
      'Phone Number': t.phone || '',
      'Rent Amount (₹)': t.rent_amount || 0
    })) : [
      {
        'Party Code': '1210001001',
        'Party / Tenant Name': 'Sample Tenant Name',
        'Unit / Flat No': 'A-101',
        'Email Address': 'sample.tenant@gmail.com',
        'Phone Number': '+91 9876543210',
        'Rent Amount (₹)': 25000
      }
    ];

    const worksheet = xlsx.utils.json_to_sheet(formattedData);
    
    // Set column widths for clean presentation
    worksheet['!cols'] = [
      { wch: 18 }, // Party Code
      { wch: 32 }, // Party Name
      { wch: 16 }, // Unit / Flat No
      { wch: 35 }, // Email Address
      { wch: 18 }, // Phone Number
      { wch: 18 }  // Rent Amount
    ];

    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'NFL Tenant Roster');

    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="NFL_Tenant_Database_Export.xlsx"');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import tenants from CSV / Excel (.xlsx)
app.post('/api/tenants/import', uploadDoc.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a CSV or Excel file' });

    const filePath = req.file.path;
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    // Clean up temporary file
    try { fs.unlinkSync(filePath); } catch (e) { }

    let importedCount = 0;
    let skippedCount = 0;

    for (const row of rows) {
      // Detect column keys case-insensitively
      const getVal = (candidates) => {
        for (const key of Object.keys(row)) {
          const norm = key.toLowerCase().replace(/[^a-z]/g, '');
          if (candidates.includes(norm)) return row[key];
        }
        return '';
      };

      const name = getVal(['name', 'tenantname', 'fullname', 'tenant', 'partyname']);
      const email = getVal(['email', 'emailaddress', 'mail']);
      const unit = getVal(['unit', 'unitnumber', 'flat', 'flatno', 'flatnumber', 'apt', 'room', 'apartment']) || 'N/A';
      const phone = getVal(['phone', 'mobile', 'contact', 'cell']);
      const code = getVal(['code', 'partycode', 'party_code', 'party', 'tenantcode', 'id', 'tenantid', 'partyno', 'partyid', 'customercode', 'custcode']) || `TNT-${Math.floor(1000 + Math.random() * 9000)}`;
      const rent = parseFloat(getVal(['rent', 'rentamount', 'amount', 'monthlyrent'])) || 0;

      if (name && email) {
        try {
          await run(`
            INSERT INTO tenants (tenant_code, name, unit_number, email, phone, rent_amount)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_code) DO UPDATE SET
              name=excluded.name,
              unit_number=excluded.unit_number,
              email=excluded.email,
              phone=excluded.phone,
              rent_amount=excluded.rent_amount
          `, [code.toString(), name.toString().trim(), unit.toString().trim(), email.toString().trim().toLowerCase(), phone.toString().trim(), rent]);
          importedCount++;
        } catch (e) {
          skippedCount++;
        }
      } else {
        skippedCount++;
      }
    }

    // Auto trigger rematch after import
    const allTenants = await all('SELECT * FROM tenants');
    const receiptsToRematch = await all('SELECT * FROM receipts WHERE tenant_id IS NULL');
    let autoMatched = 0;
    for (const r of receiptsToRematch) {
      if (!r.party_code) r.party_code = extractPartyCodeFromFilename(r.original_name);
      const m = matchReceiptToTenant(r, allTenants);
      if (m) {
        await run(`UPDATE receipts SET tenant_id = ?, match_confidence = ?, match_reason = ?, party_code = COALESCE(party_code, ?) WHERE id = ?`, [m.tenantId, m.confidence, m.reason, r.party_code, r.id]);
        autoMatched++;
      }
    }

    res.json({
      success: true,
      message: `Imported ${importedCount} tenants successfully (${skippedCount} skipped). Auto-linked ${autoMatched} receipts!`,
      importedCount,
      autoMatched
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download sample Excel template for tenant import
app.get('/api/tenants/template', (req, res) => {
  try {
    const sampleRows = [
      { 'Party Code': '9594', 'Tenant Name': 'Yash Pal', 'Unit Number': 'Unit-101', 'Email Address': 'yashpal@example.com', 'Phone': '+91 9811122233', 'Monthly Rent': 25000 },
      { 'Party Code': '8637', 'Tenant Name': 'Pawan Kumar', 'Unit Number': 'Unit-102', 'Email Address': 'pawankumar@example.com', 'Phone': '+91 9822233344', 'Monthly Rent': 28000 },
      { 'Party Code': '8579', 'Tenant Name': 'Rajiv Kumar Dawra', 'Unit Number': 'Unit-103', 'Email Address': 'rajiv.dawra@example.com', 'Phone': '+91 9833344455', 'Monthly Rent': 32000 },
      { 'Party Code': '8317', 'Tenant Name': 'Namit Dhavan', 'Unit Number': 'Unit-104', 'Email Address': 'namit.dhavan@example.com', 'Phone': '+91 9844455566', 'Monthly Rent': 24000 },
      { 'Party Code': '9908', 'Tenant Name': 'Sanjeev Kumar', 'Unit Number': 'Unit-105', 'Email Address': 'sanjeev.kumar@example.com', 'Phone': '+91 9855566677', 'Monthly Rent': 26000 }
    ];

    const ws = xlsx.utils.json_to_sheet(sampleRows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Tenants_Template');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="Tenants_Party_Template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Seed realistic sample tenants matching actual receipts
app.post('/api/tenants/seed-samples', async (req, res) => {
  try {
    // Check if receipts exist to generate matching sample tenants
    const distinctReceipts = await all(`
      SELECT DISTINCT party_code, extracted_name, extracted_unit, extracted_amount 
      FROM receipts 
      WHERE party_code IS NOT NULL AND party_code != '' 
      LIMIT 30
    `);

    let samples = [];
    if (distinctReceipts && distinctReceipts.length > 0) {
      samples = distinctReceipts.map((r, idx) => {
        const cleanName = (r.extracted_name || `Party ${r.party_code}`).replace(/[^a-zA-Z\s]/g, '').trim() || `Party ${r.party_code}`;
        const emailSlug = cleanName.toLowerCase().replace(/\s+/g, '.');
        return {
          code: r.party_code,
          name: cleanName,
          unit: r.extracted_unit || `Unit-${100 + idx}`,
          email: `${emailSlug}@example.com`,
          phone: `+91 98${Math.floor(10000000 + Math.random() * 90000000)}`,
          rent: r.extracted_amount || 25000
        };
      });
    } else {
      // Fallback
      samples = [
        { code: '9594', name: 'Yash Pal', unit: 'Unit-101', email: 'yash.pal@example.com', phone: '+91 98111 23451', rent: 25000 },
        { code: '8637', name: 'Pawan Kumar', unit: 'Unit-102', email: 'pawan.kumar@example.com', phone: '+91 98222 34562', rent: 28000 },
        { code: '8579', name: 'Rajiv Kumar Dawra', unit: 'Unit-103', email: 'rajiv.dawra@example.com', phone: '+91 98333 45673', rent: 24000 },
        { code: '8317', name: 'Namit Dhavan', unit: 'Unit-104', email: 'namit.dhavan@example.com', phone: '+91 98444 56784', rent: 32000 },
        { code: '9908', name: 'Sanjeev Kumar', unit: 'Unit-105', email: 'sanjeev.kumar@example.com', phone: '+91 98555 67895', rent: 30000 },
        { code: '8597', name: 'Inderpreet Singh', unit: 'Unit-106', email: 'inderpreet.singh@example.com', phone: '+91 98666 78906', rent: 29000 },
        { code: '8824', name: 'Jagdeep Sharma', unit: 'Unit-107', email: 'jagdeep.sharma@example.com', phone: '+91 98777 89017', rent: 35000 },
        { code: '9104', name: 'Rajan Kumar', unit: 'Unit-108', email: 'rajan.kumar@example.com', phone: '+91 98888 90128', rent: 36000 },
        { code: '8513', name: 'Prem Chand', unit: 'Unit-109', email: 'prem.chand@example.com', phone: '+91 98999 01239', rent: 31000 },
        { code: '3216', name: 'Bharat Bhushan Goel', unit: 'Unit-110', email: 'bharat.goel@example.com', phone: '+91 98123 45678', rent: 27000 }
      ];
    }

    let inserted = 0;
    for (const t of samples) {
      await run(`
        INSERT INTO tenants (tenant_code, name, unit_number, email, phone, rent_amount)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_code) DO UPDATE SET
          name=excluded.name,
          unit_number=excluded.unit_number,
          email=excluded.email,
          phone=excluded.phone,
          rent_amount=excluded.rent_amount
      `, [t.code, t.name, t.unit, t.email, t.phone, t.rent]);
      inserted++;
    }

    // Immediately trigger rematch for all receipts with new tenants!
    const allTenants = await all('SELECT * FROM tenants');
    const allReceipts = await all('SELECT * FROM receipts WHERE tenant_id IS NULL');
    let matchedCount = 0;
    for (const r of allReceipts) {
      if (!r.party_code) r.party_code = extractPartyCodeFromFilename(r.original_name);
      const m = matchReceiptToTenant(r, allTenants);
      if (m) {
        await run(`UPDATE receipts SET tenant_id = ?, match_confidence = ?, match_reason = ?, party_code = COALESCE(party_code, ?) WHERE id = ?`, [m.tenantId, m.confidence, m.reason, r.party_code, r.id]);
        matchedCount++;
      }
    }

    res.json({
      success: true,
      message: `Loaded ${inserted} sample tenants matching uploaded receipts! Linked ${matchedCount} receipts automatically.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const { syncOracleTenants, addLeasedCustomerToOracle, deleteLeasedCustomerFromOracle, recreateJsonCache } = require('./oracleSync');

// Sync tenant records directly from Oracle PAYTEMP.LEASED_CUSTOMERS_DTLS
app.post('/api/oracle/sync', async (req, res) => {
  try {
    const result = await syncOracleTenants();
    res.json(result);
  } catch (err) {
    console.error('Oracle sync error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Oracle sync status and customer counts
app.get('/api/oracle/sync-status', async (req, res) => {
  try {
    const timeRow = await get("SELECT value FROM settings WHERE key = 'last_oracle_sync_time'");
    const statsRow = await get("SELECT value FROM settings WHERE key = 'last_oracle_sync_stats'");
    let stats = null;
    if (statsRow && statsRow.value) {
      try { stats = JSON.parse(statsRow.value); } catch (e) {}
    }
    const withEmail = await get("SELECT COUNT(*) as cnt FROM tenants WHERE email IS NOT NULL AND email != '' AND email LIKE '%@%'");
    const noEmail = await get("SELECT COUNT(*) as cnt FROM tenants WHERE email IS NULL OR email = '' OR email NOT LIKE '%@%'");
    const duplicates = await get("SELECT COUNT(*) as cnt FROM tenants WHERE tags LIKE '%duplicate%'");
    const discrepancies = await get("SELECT COUNT(*) as cnt FROM tenants WHERE tags NOT LIKE '%clean%' AND tags IS NOT NULL AND tags != ''");
    const clean = await get("SELECT COUNT(*) as cnt FROM tenants WHERE tags LIKE '%clean%'");
    const totalTenants = await get("SELECT COUNT(*) as cnt FROM tenants");

    res.json({
      success: true,
      lastSyncTime: timeRow ? timeRow.value : (stats ? stats.timestamp : null),
      counts: {
        total: totalTenants ? totalTenants.cnt : 0,
        withEmail: withEmail ? withEmail.cnt : 0,
        noEmail: noEmail ? noEmail.cnt : 0,
        duplicates: duplicates ? duplicates.cnt : 0,
        discrepancies: discrepancies ? discrepancies.cnt : 0,
        clean: clean ? clean.cnt : 0
      },
      stats
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Scheduled background auto-sync from Oracle (every 60 minutes)
const AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000;
setInterval(async () => {
  // CRITICAL: Only run background auto-sync if an active user session is authenticated.
  // When users are logged out, Oracle connections remain completely closed/suspended.
  if (activeSessions.size === 0) {
    console.log('[Auto-Sync] 💤 No active logged-in user sessions. Skipping scheduled Oracle sync to keep DB connections suspended.');
    return;
  }
  try {
    console.log('[Auto-Sync] ⏰ Running scheduled Oracle tenancy sync...');
    await syncOracleTenants();
  } catch (err) {
    console.warn('[Auto-Sync] Scheduled sync deferred:', err.message);
  }
}, AUTO_SYNC_INTERVAL_MS);

// Insert/Update customer directly into Oracle table LEASED_CUSTOMERS_DTLS
app.post('/api/oracle/customers', async (req, res) => {
  try {
    const { partyCode, partyName, email, unitNumber, phone } = req.body;
    if (!partyCode) {
      return res.status(400).json({ success: false, error: 'Party Code is required.' });
    }

    const cleanCode = partyCode.toString().trim().slice(0, 20);
    const cleanEmail = (email || '').toString().trim().toLowerCase().slice(0, 55);
    const cleanName = (partyName || `Party ${cleanCode}`).toString().trim().slice(0, 100);
    const cleanUnit = (unitNumber || 'N/A').toString().trim().slice(0, 100);
    const cleanPhone = (phone || '').toString().trim().slice(0, 50);

    if (cleanEmail && !cleanEmail.includes('@')) {
      return res.status(400).json({ success: false, error: 'Email Address must be a valid email containing @.' });
    }

    // 1. Immediately insert/update in Oracle DB table LEASED_CUSTOMERS_DTLS
    const oracleResult = await addLeasedCustomerToOracle({
      partyCode: cleanCode,
      partyName: cleanName,
      email: cleanEmail,
      unitNumber: cleanUnit,
      phone: cleanPhone
    });

    if (!oracleResult || !oracleResult.success) {
      return res.status(500).json({
        success: false,
        error: oracleResult?.error || 'Failed to save customer to Oracle LEASED_CUSTOMERS_DTLS'
      });
    }

    // 2. Save in local SQLite tenants table
    const existing = await get('SELECT id, unit_number, phone FROM tenants WHERE tenant_code = ?', [cleanCode]);
    if (existing) {
      let finalUnit = cleanUnit;
      if (cleanUnit === 'N/A' || !cleanUnit) {
        finalUnit = existing.unit_number || 'N/A';
      }
      let finalPhone = cleanPhone || existing.phone || '';

      await run(`
        UPDATE tenants
        SET name = ?,
            email = ?,
            unit_number = ?,
            phone = ?
        WHERE tenant_code = ?
      `, [cleanName, cleanEmail, finalUnit, finalPhone, cleanCode]);
    } else {
      await run(`
        INSERT INTO tenants (tenant_code, name, unit_number, email, phone, rent_amount)
        VALUES (?, ?, ?, ?, ?, 0)
      `, [cleanCode, cleanName, cleanUnit, cleanEmail, cleanPhone]);
    }

    // 3. Recreate oracle_tenants_cache.json from updated database
    await recreateJsonCache();

    // 4. Trigger match engine rematch for any receipts belonging to this party code
    try {
      const allTenants = await all('SELECT * FROM tenants');
      const unmatchedReceipts = await all('SELECT * FROM receipts WHERE tenant_id IS NULL AND (party_code = ? OR original_name LIKE ?)', [cleanCode, `%${cleanCode}%`]);
      for (const r of unmatchedReceipts) {
        if (!r.party_code) r.party_code = cleanCode;
        const m = matchReceiptToTenant(r, allTenants);
        if (m.tenant) {
          await run(`
            UPDATE receipts
            SET tenant_id = ?, match_confidence = ?, match_reason = ?, party_code = ?
            WHERE id = ?
          `, [m.tenant.id, m.confidence, m.reason, m.tenant.tenant_code, r.id]);
        }
      }
    } catch (me) {
      console.warn('Auto-match notice after customer insert:', me.message);
    }

    res.json({
      success: true,
      message: `Customer ${cleanCode} (${cleanName}) saved directly to Oracle LEASED_CUSTOMERS_DTLS!`,
      partyCode: cleanCode
    });
  } catch (err) {
    console.error('Oracle customer insert error:', err);
    res.status(500).json({
      success: false,
      error: `Error saving customer: ${err.message}`
    });
  }
});

// ==========================================
// 4. SAMPLE RENT RECEIPT PDF GENERATOR (TESTING UTILITY)
// ==========================================
app.post('/api/demo/generate-sample-pdfs', async (req, res) => {
  try {
    const count = parseInt(req.body.count || '12', 10);
    const tenants = await all('SELECT * FROM tenants LIMIT ?', [count]);

    if (tenants.length === 0) {
      return res.status(400).json({ error: 'Please add or seed tenants first so we can generate matching PDFs!' });
    }

    const months = ['September 2026', 'August 2026', 'October 2026'];
    let generatedCount = 0;

    for (let i = 0; i < Math.min(count, tenants.length); i++) {
      const t = tenants[i];
      const month = months[i % months.length];
      const receiptNo = `REC-2026-${1000 + i}`;
      const amount = t.rent_amount || 25000;

      // Create PDF using pdf-lib
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595.28, 841.89]); // A4
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      // Draw modern header bar
      page.drawRectangle({
        x: 0,
        y: 740,
        width: 595.28,
        height: 102,
        color: rgb(0.12, 0.16, 0.28)
      });

      page.drawText('NATIONAL FERTILIZERS LIMITED', {
        x: 40,
        y: 805,
        size: 16,
        font: fontBold,
        color: rgb(1, 1, 1)
      });

      page.drawText('LEASE BILLING APPLICATION • RENT RECEIPT', {
        x: 40,
        y: 775,
        size: 11,
        font,
        color: rgb(0.6, 0.75, 0.95)
      });

      // Embed NFL logo image into PDF header
      try {
        const logoPath = path.join(__dirname, '..', 'frontend', 'nfl_logo.png');
        if (fs.existsSync(logoPath)) {
          const logoBytes = fs.readFileSync(logoPath);
          const logoImage = await pdfDoc.embedPng(logoBytes);
          page.drawImage(logoImage, {
            x: 495,
            y: 750,
            width: 55,
            height: 68
          });
        }
      } catch (e) {
        console.warn('PDF logo embed warning:', e.message);
      }

      // Receipt Box
      page.drawRectangle({
        x: 40,
        y: 620,
        width: 515,
        height: 90,
        borderColor: rgb(0.85, 0.88, 0.92),
        borderWidth: 1,
        color: rgb(0.97, 0.98, 1)
      });

      page.drawText(`Receipt No: ${receiptNo}`, { x: 60, y: 680, size: 12, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
      page.drawText(`Payment Date: 05 ${month.split(' ')[0]} 2026`, { x: 60, y: 655, size: 11, font, color: rgb(0.3, 0.3, 0.3) });
      page.drawText(`Payment Status: PAID & VERIFIED`, { x: 60, y: 635, size: 10, font: fontBold, color: rgb(0.1, 0.6, 0.2) });

      // Tenant Details Section
      page.drawText('TENANT DETAILS', { x: 40, y: 580, size: 14, font: fontBold, color: rgb(0.12, 0.16, 0.28) });

      const details = [
        ['Tenant Name:', t.name],
        ['Flat / Unit No:', t.unit_number],
        ['Tenant ID:', t.tenant_code || `TNT-${t.id}`],
        ['Email Address:', t.email],
        ['Rental Period:', `Month of ${month}`]
      ];

      let yPos = 550;
      for (const [label, val] of details) {
        page.drawText(label, { x: 40, y: yPos, size: 11, font: fontBold, color: rgb(0.3, 0.3, 0.3) });
        page.drawText(String(val), { x: 180, y: yPos, size: 11, font, color: rgb(0.05, 0.05, 0.05) });
        yPos -= 24;
      }

      // Financial breakdown table
      page.drawRectangle({
        x: 40,
        y: 330,
        width: 515,
        height: 80,
        color: rgb(0.95, 0.96, 0.98)
      });

      page.drawText('Description', { x: 60, y: 385, size: 11, font: fontBold, color: rgb(0.2, 0.2, 0.2) });
      page.drawText('Amount (INR)', { x: 440, y: 385, size: 11, font: fontBold, color: rgb(0.2, 0.2, 0.2) });

      page.drawText(`Monthly Apartment Rent (${month})`, { x: 60, y: 355, size: 11, font, color: rgb(0.1, 0.1, 0.1) });
      page.drawText(`Rs. ${amount.toLocaleString('en-IN')}`, { x: 440, y: 355, size: 11, font: fontBold, color: rgb(0.1, 0.1, 0.1) });

      // Total Banner
      page.drawRectangle({
        x: 40,
        y: 260,
        width: 515,
        height: 50,
        color: rgb(0.15, 0.22, 0.4)
      });
      page.drawText('TOTAL AMOUNT RECEIVED:', { x: 60, y: 280, size: 12, font: fontBold, color: rgb(1, 1, 1) });
      page.drawText(`Rs. ${amount.toLocaleString('en-IN')}`, { x: 430, y: 280, size: 14, font: fontBold, color: rgb(0.4, 0.9, 0.5) });

      // Footer note
      page.drawText('This is a computer-generated rent payment acknowledgment receipt by Lease Billing Application.', {
        x: 40,
        y: 180,
        size: 9,
        font,
        color: rgb(0.5, 0.5, 0.5)
      });

      const pdfBytes = await pdfDoc.save();
      const sanitizedName = t.name.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `Rent_Receipt_${t.unit_number}_${sanitizedName}.pdf`;
      const filePath = path.join(UPLOADS_DIR, `${Date.now()}-${filename}`);

      fs.writeFileSync(filePath, pdfBytes);

      // Auto ingest into DB
      const meta = await extractPdfMetadata(filePath, filename);
      const match = matchReceiptToTenant({
        original_name: filename,
        extracted_text: meta.rawText,
        extracted_name: meta.extractedName,
        extracted_unit: meta.extractedUnit,
        extracted_email: meta.extractedEmail
      }, tenants);

      await run(`
        INSERT INTO receipts (
          filename, original_name, file_path, file_size,
          extracted_text, extracted_name, extracted_unit, extracted_amount, extracted_month,
          tenant_id, match_confidence, match_reason, email_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `, [
        path.basename(filePath),
        filename,
        filePath,
        pdfBytes.length,
        meta.rawText,
        meta.extractedName,
        meta.extractedUnit,
        amount,
        month,
        match ? match.tenantId : t.id,
        match ? match.confidence : 100,
        match ? match.reason : 'Direct Generated Match'
      ]);

      generatedCount++;
    }

    res.json({
      success: true,
      message: `Generated and cataloged ${generatedCount} realistic rent receipt PDFs!`
    });
  } catch (err) {
    console.error('Demo generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. EMAIL DISPATCH & REAL-TIME SSE
// ==========================================
app.post('/api/email/start', async (req, res) => {
  try {
    const { receiptIds, onlyPending, customSubject, customBody, saveAsDefault } = req.body;
    const result = await emailService.startDispatch({
      receiptIds,
      onlyPending: onlyPending !== false,
      customSubject,
      customBody,
      saveAsDefault
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Preview email text before sending
app.post('/api/email/preview', async (req, res) => {
  try {
    const { receiptIds } = req.body;
    if (!receiptIds || receiptIds.length === 0) {
      return res.status(400).json({ error: 'Receipt ID(s) are required for preview.' });
    }
    const preview = await emailService.getEmailPreview({ receiptIds });
    res.json({ success: true, preview });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Send email for a single individual receipt
app.post('/api/email/send-receipt', async (req, res) => {
  try {
    const { receiptId, customSubject, customBody, customRecipientEmail, saveAsDefault } = req.body;
    if (!receiptId) {
      return res.status(400).json({ error: 'Receipt ID is required.' });
    }
    const result = await emailService.sendSingleGroup({ 
      receiptIds: [receiptId],
      customSubject,
      customBody,
      customRecipientEmail,
      saveAsDefault
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Bulk send email for multiple selected receipts
app.post('/api/email/send-selected', async (req, res) => {
  try {
    const { receiptIds, customSubject, customBody, saveAsDefault } = req.body;
    if (!receiptIds || !receiptIds.length) {
      return res.status(400).json({ error: 'Please select at least one receipt to send.' });
    }
    const result = await emailService.startDispatch({ 
      receiptIds, 
      onlyPending: false,
      customSubject,
      customBody,
      saveAsDefault
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Send email for a single party group (clubbed documents)
app.post('/api/email/send-group', async (req, res) => {
  try {
    const { receiptIds, customSubject, customBody, customRecipientEmail, saveAsDefault } = req.body;
    if (!receiptIds || receiptIds.length === 0) {
      return res.status(400).json({ error: 'No receipt IDs provided.' });
    }
    const result = await emailService.sendSingleGroup({ 
      receiptIds,
      customSubject,
      customBody,
      customRecipientEmail,
      saveAsDefault
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Grouped receipts by party_code (clubs Main Rent + Recoverable under same party)
app.get('/api/receipts/grouped', async (req, res) => {
  try {
    const search = req.query.search || '';
    const status = req.query.status || 'all';

    let whereConditions = ['1=1'];
    let params = [];

    if (search) {
      whereConditions.push('(r.original_name LIKE ? OR r.party_code LIKE ? OR r.extracted_name LIKE ? OR r.extracted_unit LIKE ? OR t.name LIKE ? OR t.email LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s, s, s);
    }

    if (status === 'matched') {
      whereConditions.push('r.tenant_id IS NOT NULL AND r.match_confidence = 100');
    } else if (status === 'unmatched') {
      whereConditions.push('(r.tenant_id IS NULL OR r.match_confidence < 100)');
    } else if (status === 'sent') {
      whereConditions.push("r.email_status = 'sent'");
    } else if (status === 'failed') {
      whereConditions.push("r.email_status = 'failed'");
    } else if (status === 'pending') {
      whereConditions.push("r.email_status = 'pending'");
    }

    const whereClause = whereConditions.join(' AND ');

    const receipts = await all(`
      SELECT 
        r.id, r.filename, r.original_name, r.file_size, r.party_code,
        r.extracted_name, r.extracted_unit, r.extracted_amount, r.extracted_month,
        r.match_confidence, r.match_reason, r.email_status, r.sent_at, r.error_message, r.created_at,
        t.id as tenant_id, t.name as tenant_name, t.email as tenant_email, t.unit_number as tenant_unit
      FROM receipts r
      LEFT JOIN tenants t ON r.tenant_id = t.id
      WHERE ${whereClause}
      ORDER BY r.party_code ASC, r.id ASC
    `, params);

    // Group by party_code
    const groupMap = new Map();
    for (const r of receipts) {
      const key = r.party_code || `ungrouped_${r.id}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          partyCode: r.party_code,
          tenantId: r.tenant_id,
          tenantName: r.tenant_name,
          tenantEmail: r.tenant_email,
          tenantUnit: r.tenant_unit || r.extracted_unit,
          matchConfidence: r.match_confidence,
          matchReason: r.match_reason,
          receipts: [],
          totalAmount: 0,
          allSent: true,
          anyFailed: false
        });
      }
      const grp = groupMap.get(key);
      grp.receipts.push({
        id: r.id,
        filename: r.filename,
        originalName: r.original_name,
        fileSize: r.file_size,
        extractedAmount: r.extracted_amount,
        extractedMonth: r.extracted_month,
        extractedUnit: r.extracted_unit,
        emailStatus: r.email_status,
        sentAt: r.sent_at,
        errorMessage: r.error_message,
        createdAt: r.created_at
      });
      grp.totalAmount += (parseFloat(r.extracted_amount) || 0);
      if (r.email_status !== 'sent') grp.allSent = false;
      if (r.email_status === 'failed') grp.anyFailed = true;
      // Prefer tenant info from any linked receipt
      if (r.tenant_id && !grp.tenantId) {
        grp.tenantId = r.tenant_id;
        grp.tenantName = r.tenant_name;
        grp.tenantEmail = r.tenant_email;
        grp.tenantUnit = r.tenant_unit;
      }
    }

    const groups = Array.from(groupMap.values());

    res.json({
      groups,
      totalGroups: groups.length,
      totalReceipts: receipts.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/email/pause', (req, res) => {
  emailService.pause();
  res.json({ success: true, message: 'Email queue paused' });
});

app.post('/api/email/resume', (req, res) => {
  emailService.resume();
  res.json({ success: true, message: 'Email queue resumed' });
});

app.post('/api/email/stop', (req, res) => {
  emailService.stop();
  res.json({ success: true, message: 'Email queue stopped' });
});

// Server-Sent Events (SSE) stream for live progress
app.get('/api/email/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': connected\n\n');

  emailService.addSseClient(res);

  req.on('close', () => {
    emailService.removeSseClient(res);
  });
});

// Delivery audit logs
app.get('/api/email/logs', async (req, res) => {
  try {
    const logs = await all(`
      SELECT l.*, r.original_name as file_name, t.name as tenant_name
      FROM email_logs l
      LEFT JOIN receipts r ON l.receipt_id = r.id
      LEFT JOIN tenants t ON l.tenant_id = t.id
      ORDER BY l.id DESC
      LIMIT 100
    `);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/email/logs', async (req, res) => {
  try {
    await run('DELETE FROM email_logs');
    res.json({ success: true, message: 'Email logs cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. SYSTEM SETTINGS (SMTP & TEMPLATES)
// ==========================================
app.get('/api/settings', async (req, res) => {
  try {
    // Directly fetch live settings from the database (settings table)
    const rows = await all('SELECT key, value FROM settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });

    // Also check email_templates table in database to guarantee template presence
    try {
      const activeTpl = await get('SELECT subject, body_html FROM email_templates WHERE is_default = 1 ORDER BY id DESC LIMIT 1');
      if (activeTpl) {
        if (!settings.email_subject && activeTpl.subject) settings.email_subject = activeTpl.subject;
        if (!settings.email_body_template && activeTpl.body_html) settings.email_body_template = activeTpl.body_html;
      }
    } catch (tplErr) {}

    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid settings payload' });
    }

    if (updates.email_body_template) {
      updates.email_body_template = String(updates.email_body_template)
        .replace(/\\+n/gi, '')
        .replace(/\/n/gi, '')
        .replace(/\\+r/gi, '')
        .replace(/\/r/gi, '')
        .replace(/>\s*[\r\n]+\s*</g, '><')
        .replace(/[\r\n]+/g, ' ')
        .trim();
    }

    // 1. Directly save all settings into SQLite database 'settings' table
    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined && val !== null) {
        await run(`
          INSERT INTO settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `, [key, String(val)]);
      }
    }

    // 2. Also directly save email_subject & email_body_template into database 'email_templates' table
    if (updates.email_subject || updates.email_body_template) {
      const subject = (updates.email_subject || 'Monthly Lease Rent Invoice - {{month}} (Unit: {{unit_number}})').trim();
      const body = (updates.email_body_template || '').trim();
      await run(`
        INSERT INTO email_templates (template_key, name, subject, body_html, is_default, updated_at)
        VALUES ('monthly_lease_invoice', 'Monthly Lease Rent Invoice', ?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(template_key) DO UPDATE SET
          subject = excluded.subject,
          body_html = excluded.body_html,
          is_default = 1,
          updated_at = CURRENT_TIMESTAMP
      `, [subject, body]);
    }

    // 3. Immediately persist in memory and sync WAL
    const syncedSettings = await emailService.syncSettings(updates);
    res.json({ 
      success: true, 
      message: 'Settings saved directly to database successfully!',
      settings: syncedSettings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6.1 EMAIL TEMPLATES DATABASE API
// Directly reads from & writes to SQLite database (email_templates & settings)
// ==========================================
// Get all email templates directly from database
app.get('/api/templates', async (req, res) => {
  try {
    const templates = await all('SELECT id, template_key, name, subject, body_html, is_default, updated_at FROM email_templates ORDER BY is_default DESC, id ASC');
    res.json({ success: true, templates: templates || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get active default email template directly from database
app.get('/api/templates/active', async (req, res) => {
  try {
    let tpl = await get('SELECT id, template_key, name, subject, body_html, is_default FROM email_templates WHERE is_default = 1 ORDER BY id DESC LIMIT 1');
    if (!tpl) {
      const sSub = await get('SELECT value FROM settings WHERE key = ?', ['email_subject']);
      const sBody = await get('SELECT value FROM settings WHERE key = ?', ['email_body_template']);
      tpl = {
        template_key: 'monthly_lease_invoice',
        name: 'Monthly Lease Rent Invoice',
        subject: sSub?.value || 'Monthly Lease Rent Invoice - {{month}} (Unit: {{unit_number}})',
        body_html: sBody?.value || '<p>Attached is your monthly lease rent invoice.</p>',
        is_default: 1
      };
    }
    res.json({ success: true, template: tpl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save or update an email template directly into database
app.post('/api/templates', async (req, res) => {
  try {
    const { template_key, name, subject, body_html, is_default } = req.body;
    if (!template_key || !name || !subject || !body_html) {
      return res.status(400).json({ success: false, error: 'template_key, name, subject, and body_html are required.' });
    }

    const cleanBody = String(body_html)
      .replace(/\\+n/gi, '')
      .replace(/\/n/gi, '')
      .replace(/\\+r/gi, '')
      .replace(/\/r/gi, '')
      .replace(/>\s*[\r\n]+\s*</g, '><')
      .replace(/[\r\n]+/g, ' ')
      .trim();
    const cleanSub = String(subject).trim();
    const cleanKey = String(template_key).trim();
    const cleanName = String(name).trim();
    const defVal = (is_default === undefined || is_default === null) ? 1 : (Number(is_default) ? 1 : 0);

    if (defVal === 1) {
      await run('UPDATE email_templates SET is_default = 0');
    }

    // 1. Save directly into Oracle EMAIL_TEMPLATES table
    const { saveEmailTemplateToOracle } = require('./oracleSync');
    const tplResult = await saveEmailTemplateToOracle({
      template_key: cleanKey,
      name: cleanName,
      subject: cleanSub,
      body_html: cleanBody,
      is_default: defVal
    });
    if (!tplResult.success) {
      throw new Error(tplResult.error || 'Failed to save email template into Oracle DB.');
    }

    // 2. Also directly update settings table in database if default
    if (defVal === 1) {
      await run(`INSERT INTO settings (key, value) VALUES ('email_subject', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [cleanSub]);
      await run(`INSERT INTO settings (key, value) VALUES ('email_body_template', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [cleanBody]);
      await emailService.syncSettings({
        email_subject: cleanSub,
        email_body_template: cleanBody
      });
    }

    res.json({ 
      success: true, 
      message: 'Template saved directly into database!' 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test SMTP connection ping & optional test email dispatch
app.post('/api/email/test-smtp', async (req, res) => {
  try {
    const rows = await all('SELECT key, value FROM settings');
    const saved = {};
    rows.forEach(r => { saved[r.key] = r.value; });

    const host = (req.body?.smtp_host || saved.smtp_host || 'smtp.gmail.com').trim();
    const port = parseInt(req.body?.smtp_port || saved.smtp_port || '587', 10);
    const secure = req.body?.smtp_secure !== undefined
      ? (req.body.smtp_secure === 'true' || req.body.smtp_secure === true)
      : (saved.smtp_secure === 'true' || port === 465);
    const user = (req.body?.smtp_user !== undefined ? req.body.smtp_user : (saved.smtp_user || '')).trim();
    const pass = req.body?.smtp_pass !== undefined ? req.body.smtp_pass : (saved.smtp_pass || '');
    const fromName = (req.body?.smtp_from_name || saved.smtp_from_name || 'Lease Billing Application').trim();
    const fromEmail = (req.body?.smtp_from_email || saved.smtp_from_email || user || 'billing@leasebilling.com').trim();
    const testRecipient = (req.body?.test_recipient || '').trim();

    if (!host) {
      return res.status(400).json({ success: false, error: 'SMTP Host is required.' });
    }
    if (!user || !pass) {
      return res.status(400).json({
        success: false,
        error: 'SMTP Username and Password are required to test connection.'
      });
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      tls: {
        rejectUnauthorized: false
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000
    });

    // 1. Verify connection handshake
    await transporter.verify();

    // 2. Optionally send actual test email if recipient requested
    if (testRecipient) {
      await transporter.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        replyTo: fromEmail,
        to: testRecipient,
        subject: 'Lease Billing Application - SMTP Configuration Test Successful',
        text: `Hello,\n\nThis is a live test email confirming that your SMTP server settings in Lease Billing Application are functioning properly.\n\nSMTP Host: ${host}:${port}\nSender: ${fromName} (${fromEmail})\nTime: ${new Date().toLocaleString('en-IN')}\n\nYour bulk dispatch engine is ready to deliver receipts to tenants.`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 10px;">
            <div style="background: #10b981; color: white; padding: 12px 20px; border-radius: 6px; margin-bottom: 20px;">
              <h2 style="margin: 0; font-size: 18px;">✅ SMTP Connection Verified!</h2>
            </div>
            <p>Hello,</p>
            <p>This is a live test email confirming that your SMTP server settings in <strong>Lease Billing Application</strong> are functioning properly.</p>
            <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
              <tr><td style="padding: 6px 0; color: #64748b; width: 140px;">SMTP Host:</td><td><strong>${host}:${port}</strong></td></tr>
              <tr><td style="padding: 6px 0; color: #64748b;">Sender:</td><td><strong>${fromName} (${fromEmail})</strong></td></tr>
              <tr><td style="padding: 6px 0; color: #64748b;">Security:</td><td><strong>${secure ? 'SSL/TLS' : 'STARTTLS'}</strong></td></tr>
              <tr><td style="padding: 6px 0; color: #64748b;">Time:</td><td><strong>${new Date().toLocaleString('en-IN')}</strong></td></tr>
            </table>
            <p style="color: #64748b; font-size: 13px;">Your bulk dispatch engine is ready to deliver receipts to tenants.</p>
          </div>
        `,
        headers: {
          'X-Priority': '3',
          'Importance': 'Normal'
        }
      });

      return res.json({
        success: true,
        message: `SMTP connection verified and test email successfully sent to ${testRecipient}!`
      });
    }

    res.json({
      success: true,
      message: `SMTP connection to ${host}:${port} verified successfully! Server is ready to send.`
    });
  } catch (err) {
    console.error('SMTP test error:', err);
    let friendlyMessage = err.message;

    if (err.message && (err.message.includes('534') || err.message.includes('Application-specific password') || err.message.includes('InvalidSecondFactor'))) {
      friendlyMessage = `Google Security Notice: Gmail requires a 16-character 'App Password' instead of your regular password. Go to Google Account > Security > 2-Step Verification > App passwords, create a password, and paste it into the SMTP Password field.`;
    } else if (err.code === 'EAUTH' || (err.message && err.message.includes('535'))) {
      friendlyMessage = `Authentication Failed (535): Incorrect username or password. If using Gmail, ensure the username is your full email address (e.g. name@gmail.com) and you are using an App Password.`;
    } else if (err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
      friendlyMessage = `Network Error (${err.code}): Could not connect to ${req.body?.smtp_host || 'host'}. Please check host name, port, and internet connection.`;
    }

    res.status(400).json({ success: false, error: friendlyMessage });
  }
});

// Fallback for non-API routes to serve index.html (SPA support)
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    return next();
  }
  const indexPath = path.join(__dirname, '..', 'frontend', 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  next();
});

// Start Server & Self-Repair Stale File Paths
initDb().then(async () => {
  try {
    // Check and repair any stale paths from project copies
    const receipts = await all('SELECT id, filename, file_path FROM receipts');
    let repaired = 0;
    for (const r of receipts) {
      if (!fs.existsSync(r.file_path)) {
        const local = path.join(UPLOADS_DIR, r.filename);
        if (fs.existsSync(local)) {
          await run('UPDATE receipts SET file_path = ? WHERE id = ?', [local, r.id]);
          repaired++;
        }
      }
    }
    if (repaired > 0) {
      console.log(`[+] Auto-repaired ${repaired} receipt local file paths.`);
    }
  } catch (repairErr) {
    console.warn('[!] Path repair notice:', repairErr.message);
  }

  app.listen(PORT, HOST, () => {
    console.log(`=======================================================`);
    console.log(`🏢 RLNS Lease Billing Application running at:`);
    console.log(`👉 Local:    http://localhost:${PORT}`);
    console.log(`👉 Intranet: http://${HOST}:${PORT}`);
    console.log(`📡 Server explicitly bound to host '${HOST}' (All Interfaces)`);
    console.log(`=======================================================`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
});

// Graceful shutdown: close all Oracle DB connections when server terminates
async function gracefulShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Terminating Oracle connections cleanly...`);
  try {
    const { closePool } = require('./database');
    await closePool(1);
  } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
