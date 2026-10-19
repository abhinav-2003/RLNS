/**
 * Host Oracle Bridge for RLNS Application
 * Listens on port 3005 and executes direct Oracle queries via node-oracledb (Thick mode with Instant Client)
 * Completely eliminates dependency on sqlplus.exe and SP2-0750 errors.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./backend/database');
const {
  fetchLeasedCustomersFromOracle,
  addLeasedCustomerToOracle,
  deleteLeasedCustomerFromOracle,
  fetchSettingsFromOracle,
  syncSettingsToOracle,
  fetchEmailTemplatesFromOracle,
  saveEmailTemplateToOracle,
  recreateJsonCache
} = require('./backend/oracleSync');

const PORT = 3005;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 1. Live Sync & Dump Endpoint
  if (req.method === 'GET' && (req.url === '/api/oracle/sync' || req.url === '/api/oracle/sync-dump')) {
    try {
      const rows = await fetchLeasedCustomersFromOracle();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
    } catch (err) {
      console.error('[Host Bridge] Sync error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 2. Insert Customer directly into LEASED_CUSTOMERS_DTLS
  if (req.method === 'POST' && req.url === '/api/oracle/insert') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { partyCode, partyName, email, unitNumber, phone, rentAmount } = JSON.parse(body);
        if (!partyCode) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Party Code is required.' }));
        }

        await addLeasedCustomerToOracle({ partyCode, partyName, email, unitNumber, phone, rentAmount });
        console.log(`[Host Bridge] ✅ Inserted/Updated customer ${partyCode} directly into LEASED_CUSTOMERS_DTLS!`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Inserted/Updated ${partyCode} into LEASED_CUSTOMERS_DTLS` }));
      } catch (e) {
        console.error('[Host Bridge] Error inserting customer:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // 3. Delete Customer from LEASED_CUSTOMERS_DTLS by party code
  if (req.method === 'POST' && req.url === '/api/oracle/delete') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { partyCode } = JSON.parse(body);
        if (!partyCode) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Party Code required.' }));
        }

        await deleteLeasedCustomerFromOracle(partyCode);
        console.log(`[Host Bridge] 🗑️ Deleted party code ${partyCode} from LEASED_CUSTOMERS_DTLS`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Deleted ${partyCode} from LEASED_CUSTOMERS_DTLS` }));
      } catch (e) {
        console.error('[Host Bridge] Error deleting customer:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // 4. Fetch Settings directly from LEASED_SETTINGS_DTLS
  if (req.method === 'GET' && req.url === '/api/oracle/settings') {
    try {
      const result = await fetchSettingsFromOracle();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[Host Bridge] Error fetching settings:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message, settings: {} }));
    }
    return;
  }

  // 5. Save Settings directly into LEASED_SETTINGS_DTLS in Oracle
  if (req.method === 'POST' && (req.url === '/api/oracle/settings' || req.url === '/api/oracle/save-settings')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const settings = JSON.parse(body);
        if (!settings || typeof settings !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Invalid settings payload' }));
        }

        await syncSettingsToOracle(settings);
        console.log('[Host Bridge] ✅ Successfully updated LEASED_SETTINGS_DTLS directly in Oracle DB!');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Updated LEASED_SETTINGS_DTLS in Oracle DB.' }));
      } catch (e) {
        console.error('[Host Bridge] Error updating settings:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // 6. Fetch Email Templates directly from Oracle EMAIL_TEMPLATES table
  if (req.method === 'GET' && req.url === '/api/oracle/templates') {
    try {
      const result = await fetchEmailTemplatesFromOracle();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[Host Bridge] Error fetching templates:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message, templates: [] }));
    }
    return;
  }

  // 7. Save Email Template directly into Oracle EMAIL_TEMPLATES table
  if (req.method === 'POST' && req.url === '/api/oracle/templates') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const template = JSON.parse(body);
        const result = await saveEmailTemplateToOracle(template);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error('[Host Bridge] Error saving template:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // 8. Universal Direct Oracle Query Gateway for Docker Containers
  if (req.method === 'POST' && req.url === '/api/oracle/query') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { sql, params, method } = JSON.parse(body);
        let result;
        if (method === 'get') {
          result = await db.get(sql, params);
        } else if (method === 'all') {
          result = await db.all(sql, params);
        } else if (method === 'closePool') {
          result = await db.closePool(2);
        } else {
          result = await db.run(sql, params);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result }));
      } catch (err) {
        console.error('[Host Bridge] Query error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 9. Dedicated Close / Suspend Pool endpoint
  if (req.method === 'POST' && (req.url === '/api/oracle/close-pool' || req.url === '/api/oracle/suspend')) {
    try {
      await db.closePool(2);
      console.log('[Host Bridge] 🛑 Suspended and closed all Oracle connections.');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Host bridge Oracle connections closed.' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 10. Pool status diagnostics endpoint
  if (req.method === 'GET' && req.url === '/api/oracle/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, metrics: db.getPoolMetrics() }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[Host Bridge] Port ${PORT} already in use. Existing bridge instance is already active.`);
    process.exit(0);
  } else {
    console.error('[Host Bridge] Server error:', err);
  }
});

process.on('uncaughtException', (err) => {
  console.error('[Host Bridge] Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Host Bridge] Unhandled Rejection:', reason);
});

async function gracefulShutdown(signal) {
  console.log(`\n[Host Bridge] Received ${signal}. Closing Oracle database connections...`);
  try {
    await db.closePool(1);
  } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🌉 RLNS Host Oracle Bridge running on port ${PORT}`);
  console.log(`📡 Direct native Oracle connection via oracledb (Thick mode)`);
  console.log(`=======================================================`);
});
