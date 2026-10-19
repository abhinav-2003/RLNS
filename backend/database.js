/**
 * Direct Oracle Database Connection Module for RLNS (Lease Rent Billing System)
 * Central Database: Oracle 10g @ 10.2.53.55:1521 (SID: DB10G)
 * Schema: PAYTEMP
 * Completely replaces local SQLite - all application data is stored directly in Oracle DB.
 */

const oracledb = require('oracledb');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Auto-detect and initialize 64-bit Oracle Instant Client
const CLIENT_PATHS = [
  process.env.OCI_LIB_DIR,
  'C:\\oracle\\instantclient_19_23\\instantclient_23_0',
  'C:\\oracle\\instantclient_23_0',
  'C:\\instantclient_23_0',
  'C:\\instantclient_19_23',
  'C:\\oracle\\instantclient_19_23'
].filter(Boolean);

for (const p of CLIENT_PATHS) {
  if (fs.existsSync(path.join(p, 'oci.dll')) || fs.existsSync(path.join(p, 'libclntsh.so'))) {
    try {
      oracledb.initOracleClient({ libDir: p });
      console.log(`[Oracle] Initialized Oracle client library from: ${p}`);
      break;
    } catch (e) {
      if (!e.message.includes('already been initialized')) {
        console.warn(`[Oracle] Note initializing client from ${p}:`, e.message);
      }
    }
  }
}

// Convert CLOBs to normal JavaScript strings automatically
oracledb.fetchAsString = [ oracledb.CLOB ];

// Parse connection parameters safely from environment
let ORACLE_CONNECT_STR = process.env.ORACLE_CONNECT_STR || '(DESCRIPTION=(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(Host=10.2.53.55)(Port=1521)))(CONNECT_DATA=(SID=DB10G)))';
let ORACLE_USER = process.env.ORACLE_USER || 'PAYTEMP';
let ORACLE_PASSWORD = process.env.ORACLE_PASSWORD || 'paytemp';

if (ORACLE_CONNECT_STR.includes('@')) {
  const atIdx = ORACLE_CONNECT_STR.indexOf('@');
  const userPass = ORACLE_CONNECT_STR.slice(0, atIdx);
  ORACLE_CONNECT_STR = ORACLE_CONNECT_STR.slice(atIdx + 1);
  if (userPass.includes('/')) {
    const slashIdx = userPass.indexOf('/');
    const u = userPass.slice(0, slashIdx).trim();
    const p = userPass.slice(slashIdx + 1).trim();
    if (!process.env.ORACLE_USER && u) ORACLE_USER = u;
    if (!process.env.ORACLE_PASSWORD && p) ORACLE_PASSWORD = p;
  }
}

let useHostBridge = false;

/**
 * Establish a dedicated, standalone Oracle connection on demand.
 * This connection MUST be closed immediately after query execution is completed.
 */
async function getConnection() {
  if (useHostBridge) {
    throw new Error('HostBridgeMode: Thick client not available in current environment. Routing via Host Bridge.');
  }
  try {
    const conn = await oracledb.getConnection({
      user: ORACLE_USER,
      password: ORACLE_PASSWORD,
      connectString: ORACLE_CONNECT_STR
    });
    return conn;
  } catch (err) {
    if (err.message && (err.message.includes('DPI-') || err.message.includes('NJS-') || err.message.includes('Cannot locate') || err.message.includes('libclntsh') || err.message.includes('Easy Connect'))) {
      console.log(`[Oracle] Direct connection note (${err.message.split('\n')[0]}). Switching to Host Bridge mode.`);
      useHostBridge = true;
      throw err;
    }
    throw err;
  }
}

/**
 * Execute multiple statements in a single connection and close it IMMEDIATELY when done.
 */
async function withConnection(callback) {
  if (useHostBridge) {
    return await callback(null);
  }
  let conn = null;
  try {
    conn = await getConnection();
    return await callback(conn);
  } finally {
    if (conn) {
      try { await conn.close(); } catch (e) {}
    }
  }
}

/**
 * Backwards compatibility pool wrapper: yields connections that close immediately
 */
async function getPool() {
  return {
    getConnection,
    close: closePool
  };
}

/**
 * Explicit connection close / suspend trigger
 */
async function closePool(drainTime = 0) {
  if (useHostBridge) {
    try {
      await queryHostBridge('closePool', '', []);
    } catch (e) {}
    return true;
  }
  console.log('[Oracle] 🛑 Oracle connections closed & suspended (Immediate Close Mode Active).');
  return true;
}

/**
 * Diagnostic metrics showing immediate close strategy
 */
function getPoolMetrics() {
  if (useHostBridge) {
    return {
      mode: 'HostBridge',
      status: 'BRIDGED (Immediate Disconnect On Query End)'
    };
  }
  return {
    strategy: 'STANDALONE_IMMEDIATE_CLOSE',
    status: 'IDLE (Closed)',
    connectionsOpen: 0,
    connectionsInUse: 0,
    description: 'Connections open strictly on demand and close immediately after each query.'
  };
}

/**
 * Recursively normalize all Oracle column names in result objects to lowercase
 * for complete compatibility with application callers (e.g. row.id, row.cnt, row.tenant_code).
 */
function lowerKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(lowerKeys);
  const res = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === 'rnum') continue; // omit internal Oracle pagination helper column
    res[k.toLowerCase()] = (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) ? lowerKeys(v) : v;
  }
  return res;
}

/**
 * SQL Preprocessor: Translates standard application SQL into Oracle 10g dialect
 * - Replaces ? parameter placeholders with :1, :2, :3
 * - Converts double-quoted string literals (="sent") to single quotes (='sent')
 * - Converts empty string comparisons (!= '' or != "") to IS NOT NULL (in Oracle, '' is NULL)
 * - Implements ROWNUM pagination for LIMIT/OFFSET
 * - Handles ON CONFLICT clauses
 */
function transformSqlAndParams(sql, params = []) {
  let cleanSql = sql.trim();

  // Gracefully skip PRAGMA commands and standalone transaction controls (handled via connection autoCommit)
  if (/^\s*PRAGMA/i.test(cleanSql) || /^\s*(BEGIN(\s+TRANSACTION)?|COMMIT|ROLLBACK)\s*;?$/i.test(cleanSql)) {
    return { skip: true };
  }

  // Replace double quotes in string comparisons
  cleanSql = cleanSql.replace(/=\s*"([^"]*)"/g, "='$1'");
  cleanSql = cleanSql.replace(/LIKE\s*"([^"]*)"/gi, "LIKE '$1'");

  // Fix Oracle empty string != '' or != "" (in Oracle '' is NULL, so != '' is always false!)
  cleanSql = cleanSql.replace(/([a-zA-Z0-9_\.]+)\s*!=\s*['"]\s*['"]/gi, "$1 IS NOT NULL");
  cleanSql = cleanSql.replace(/([a-zA-Z0-9_\.]+)\s*=\s*['"]\s*['"]/gi, "$1 IS NULL");

  // Strip ON CONFLICT clauses (underlying tables and views have automatic UPSERT triggers)
  if (/ON\s+CONFLICT/i.test(cleanSql)) {
    cleanSql = cleanSql.replace(/ON\s+CONFLICT\s*\([^\)]*\)\s*DO\s*UPDATE\s*SET[\s\S]*$/i, '');
  }

  let finalParams = [...params];

  // Handle LIMIT ? OFFSET ?
  const limitOffsetMatch = cleanSql.match(/LIMIT\s+\?\s+OFFSET\s+\?\s*$/i);
  if (limitOffsetMatch) {
    const baseSql = cleanSql.slice(0, limitOffsetMatch.index).trim();
    const offset = Number(finalParams[finalParams.length - 1]);
    const limit = Number(finalParams[finalParams.length - 2]);
    finalParams = finalParams.slice(0, -2);
    cleanSql = `SELECT * FROM (SELECT a.*, ROWNUM rnum FROM (${baseSql}) a WHERE ROWNUM <= ?) WHERE rnum > ?`;
    finalParams.push(offset + limit, offset);
  } else {
    // Handle LIMIT ?
    const limitParamMatch = cleanSql.match(/LIMIT\s+\?\s*$/i);
    if (limitParamMatch) {
      const baseSql = cleanSql.slice(0, limitParamMatch.index).trim();
      const limit = Number(finalParams[finalParams.length - 1]);
      finalParams = finalParams.slice(0, -1);
      cleanSql = `SELECT * FROM (${baseSql}) WHERE ROWNUM <= ?`;
      finalParams.push(limit);
    } else {
      // Handle LIMIT <number>
      const limitNumMatch = cleanSql.match(/LIMIT\s+(\d+)\s*$/i);
      if (limitNumMatch) {
        const num = limitNumMatch[1];
        const baseSql = cleanSql.slice(0, limitNumMatch.index).trim();
        cleanSql = `SELECT * FROM (${baseSql}) WHERE ROWNUM <= ${num}`;
      }
    }
  }

  // Convert ? to :1, :2, :3...
  let bindIdx = 1;
  cleanSql = cleanSql.replace(/\?/g, () => `:${bindIdx++}`);

  // Convert undefined to null, boolean to 1/0
  const binds = finalParams.map(p => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });

  return { sql: cleanSql, binds, skip: false };
}

const http = require('http');

function queryHostBridge(method, sql, params) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ method, sql, params });
    const req = http.request({
      hostname: process.env.HOST_BRIDGE_HOST || 'host.docker.internal',
      port: parseInt(process.env.HOST_BRIDGE_PORT || '3005', 10),
      path: '/api/oracle/query',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.success) {
            resolve(parsed.result);
          } else {
            reject(new Error(parsed.error || `Host bridge returned status ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse host bridge query response: ${data.slice(0, 100)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Host bridge query timed out')); });
    req.write(postData);
    req.end();
  });
}

/**
 * Execute query and return affected count and inserted ID
 */
async function run(sql, params = []) {
  if (useHostBridge) {
    return queryHostBridge('run', sql, params);
  }
  const transformed = transformSqlAndParams(sql, params);
  if (transformed.skip) return { lastID: null, changes: 0 };

  let conn = null;
  try {
    conn = await getConnection();
    let executeSql = transformed.sql;
    let binds = transformed.binds;
    let hasReturning = false;

    // Auto-capture generated ID for INSERT statements if table is a physical table with ID sequence
    // Note: In Oracle, views with INSTEAD OF triggers (like TENANTS) do NOT support RETURNING clause (ORA-22816)
    if (/^\s*INSERT\s+INTO\s+(receipts|email_logs|email_templates|users|leased_receipts_dtls|leased_email_logs_dtls|leased_users_dtls)\b/i.test(executeSql) && !/RETURNING\s+id/i.test(executeSql)) {
      executeSql += ' RETURNING id INTO :ret_id';
      binds = [...binds, { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }];
      hasReturning = true;
    }

    const res = await conn.execute(executeSql, binds, { autoCommit: true });
    let lastID = null;
    if (hasReturning && res.outBinds && res.outBinds.length > 0) {
      const lastBind = res.outBinds[res.outBinds.length - 1];
      lastID = Array.isArray(lastBind) ? lastBind[0] : lastBind;
    } else if (/^\s*INSERT\s+INTO\s+tenants\b/i.test(executeSql) && binds.length > 0) {
      try {
        const idQuery = await conn.execute('SELECT id FROM tenants WHERE tenant_code = :1', [binds[0]], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        if (idQuery.rows && idQuery.rows.length > 0) {
          lastID = idQuery.rows[0].ID;
        }
      } catch (e) {}
    }
    return { lastID, changes: res.rowsAffected || 0 };
  } catch (err) {
    if (useHostBridge || (err.message && (err.message.includes('DPI-') || err.message.includes('NJS-') || err.message.includes('Cannot locate') || err.message.includes('libclntsh') || err.message.includes('Easy Connect') || err.message.includes('HostBridgeMode')))) {
      useHostBridge = true;
      return queryHostBridge('run', sql, params);
    }
    throw err;
  } finally {
    // CRITICAL: Close the Oracle connection immediately after the operation is complete
    if (conn) {
      try { await conn.close(); } catch (e) {}
    }
  }
}

/**
 * Execute query and return a single row object with lowercase property keys
 */
async function get(sql, params = []) {
  if (useHostBridge) {
    return queryHostBridge('get', sql, params);
  }
  const transformed = transformSqlAndParams(sql, params);
  if (transformed.skip) return null;

  let conn = null;
  try {
    conn = await getConnection();
    const res = await conn.execute(transformed.sql, transformed.binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      maxRows: 1
    });
    if (res.rows && res.rows.length > 0) {
      return lowerKeys(res.rows[0]);
    }
    return null;
  } catch (err) {
    if (useHostBridge || (err.message && (err.message.includes('DPI-') || err.message.includes('NJS-') || err.message.includes('Cannot locate') || err.message.includes('libclntsh') || err.message.includes('Easy Connect') || err.message.includes('HostBridgeMode')))) {
      useHostBridge = true;
      return queryHostBridge('get', sql, params);
    }
    throw err;
  } finally {
    // CRITICAL: Close the Oracle connection immediately after the operation is complete
    if (conn) {
      try { await conn.close(); } catch (e) {}
    }
  }
}

/**
 * Execute query and return an array of row objects with lowercase property keys
 */
async function all(sql, params = []) {
  if (useHostBridge) {
    return queryHostBridge('all', sql, params);
  }
  const transformed = transformSqlAndParams(sql, params);
  if (transformed.skip) return [];

  let conn = null;
  try {
    conn = await getConnection();
    const res = await conn.execute(transformed.sql, transformed.binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });
    return (res.rows || []).map(lowerKeys);
  } catch (err) {
    if (useHostBridge || (err.message && (err.message.includes('DPI-') || err.message.includes('NJS-') || err.message.includes('Cannot locate') || err.message.includes('libclntsh') || err.message.includes('Easy Connect') || err.message.includes('HostBridgeMode')))) {
      useHostBridge = true;
      return queryHostBridge('all', sql, params);
    }
    throw err;
  } finally {
    // CRITICAL: Close the Oracle connection immediately after the operation is complete
    if (conn) {
      try { await conn.close(); } catch (e) {}
    }
  }
}

const hashPassword = (p) => crypto.createHash('sha256').update(p + 'NFL_SALT_2026').digest('hex');

/**
 * Ensure all tables, views, sequences, triggers, synonyms and default seed records
 * exist directly in the Oracle database.
 */
async function initDb() {
  console.log(`[Oracle] Initializing tables and schema directly in Oracle DB (10.2.53.55:1521/DB10G)...`);
  let conn = null;
  try {
    conn = await getConnection();
  } catch (err) {
    if (useHostBridge || (err.message && (err.message.includes('NJS-') || err.message.includes('DPI-') || err.message.includes('Cannot locate') || err.message.includes('libclntsh') || err.message.includes('Easy Connect') || err.message.includes('HostBridgeMode')))) {
      useHostBridge = true;
      console.log(`[Oracle] Direct native thick client not available in current environment (${err.message.split('\n')[0]}). Routing queries through Host Bridge.`);
      try {
        await queryHostBridge('get', 'SELECT 1 AS alive FROM DUAL', []);
        console.log(`[Oracle] ✅ Host Bridge connection verified directly with Oracle DB.`);
        return;
      } catch (bridgeErr) {
        console.warn(`[Oracle] Host Bridge query check notice:`, bridgeErr.message);
        return;
      }
    }
    throw err;
  }

  async function execSafe(statement) {
    try {
      await conn.execute(statement);
    } catch (err) {
      // 955: table/view/index already exists
      // 1430: column being added already exists
      // 2275: referential constraint already exists
      // 4080: trigger already exists
      // 1408: column list already indexed
      if (![955, 1430, 2275, 4080, 1408, 942].includes(err.errorNum)) {
        console.warn(`[Oracle DDL Notice] ${statement.slice(0, 60)}:`, err.message);
      }
    }
  }

  try {
    // 1. Ensure LEASED_CUSTOMERS_DTLS has ID, RENT_AMOUNT, TAGS, CREATED_AT
    await execSafe('ALTER TABLE LEASED_CUSTOMERS_DTLS ADD (ID NUMBER, RENT_AMOUNT NUMBER(12, 2) DEFAULT 0, TAGS VARCHAR2(500), CREATED_AT DATE DEFAULT SYSDATE)');
    await execSafe('CREATE SEQUENCE SEQ_LEASED_CUSTOMERS START WITH 1 INCREMENT BY 1 NOCACHE');
    try {
      await conn.execute(`UPDATE LEASED_CUSTOMERS_DTLS SET ID = SEQ_LEASED_CUSTOMERS.NEXTVAL WHERE ID IS NULL`, [], { autoCommit: true });
    } catch (e) {}
    await execSafe(`
      CREATE OR REPLACE TRIGGER TRG_LEASED_CUSTOMERS_ID
      BEFORE INSERT ON LEASED_CUSTOMERS_DTLS
      FOR EACH ROW
      WHEN (NEW.ID IS NULL)
      BEGIN
        SELECT SEQ_LEASED_CUSTOMERS.NEXTVAL INTO :NEW.ID FROM DUAL;
      END;
    `);
    await execSafe('CREATE INDEX IDX_LEASED_CUST_CODE ON LEASED_CUSTOMERS_DTLS(PARTY_CODE)');

    // 2. VIEW TENANTS with INSTEAD OF triggers for transparent read/write mapping
    await execSafe(`
      CREATE OR REPLACE VIEW TENANTS AS
      SELECT
        ID,
        PARTY_CODE AS TENANT_CODE,
        PARTY_NAME AS NAME,
        UNIT_NUMBER,
        PARTY_EMAIL_ID AS EMAIL,
        PHONE,
        RENT_AMOUNT,
        TAGS,
        CREATED_AT
      FROM LEASED_CUSTOMERS_DTLS
    `);

    await execSafe(`
      CREATE OR REPLACE TRIGGER TRG_TENANTS_IO_INS
      INSTEAD OF INSERT ON TENANTS
      FOR EACH ROW
      BEGIN
        MERGE INTO LEASED_CUSTOMERS_DTLS dst
        USING (SELECT :NEW.TENANT_CODE AS CODE FROM DUAL) src
        ON (TRIM(dst.PARTY_CODE) = TRIM(src.CODE))
        WHEN MATCHED THEN
          UPDATE SET
            dst.PARTY_NAME = NVL(:NEW.NAME, dst.PARTY_NAME),
            dst.UNIT_NUMBER = NVL(:NEW.UNIT_NUMBER, dst.UNIT_NUMBER),
            dst.PARTY_EMAIL_ID = NVL(:NEW.EMAIL, dst.PARTY_EMAIL_ID),
            dst.PHONE = NVL(:NEW.PHONE, dst.PHONE),
            dst.RENT_AMOUNT = NVL(:NEW.RENT_AMOUNT, dst.RENT_AMOUNT),
            dst.TAGS = NVL(:NEW.TAGS, dst.TAGS)
        WHEN NOT MATCHED THEN
          INSERT (PARTY_CODE, PARTY_NAME, UNIT_NUMBER, PARTY_EMAIL_ID, PHONE, RENT_AMOUNT, TAGS)
          VALUES (:NEW.TENANT_CODE, :NEW.NAME, :NEW.UNIT_NUMBER, :NEW.EMAIL, :NEW.PHONE, NVL(:NEW.RENT_AMOUNT, 0), :NEW.TAGS);
      END;
    `);

    await execSafe(`
      CREATE OR REPLACE TRIGGER TRG_TENANTS_IO_UPD
      INSTEAD OF UPDATE ON TENANTS
      FOR EACH ROW
      BEGIN
        UPDATE LEASED_CUSTOMERS_DTLS
        SET
          PARTY_CODE = NVL(:NEW.TENANT_CODE, PARTY_CODE),
          PARTY_NAME = NVL(:NEW.NAME, PARTY_NAME),
          UNIT_NUMBER = NVL(:NEW.UNIT_NUMBER, UNIT_NUMBER),
          PARTY_EMAIL_ID = :NEW.EMAIL,
          PHONE = :NEW.PHONE,
          RENT_AMOUNT = NVL(:NEW.RENT_AMOUNT, RENT_AMOUNT),
          TAGS = NVL(:NEW.TAGS, TAGS)
        WHERE ID = :OLD.ID OR TRIM(PARTY_CODE) = TRIM(:OLD.TENANT_CODE);
      END;
    `);

    await execSafe(`
      CREATE OR REPLACE TRIGGER TRG_TENANTS_IO_DEL
      INSTEAD OF DELETE ON TENANTS
      FOR EACH ROW
      BEGIN
        DELETE FROM LEASED_CUSTOMERS_DTLS
        WHERE ID = :OLD.ID OR TRIM(PARTY_CODE) = TRIM(:OLD.TENANT_CODE);
      END;
    `);

    // 3. LEASED_RECEIPTS_DTLS & Synonym RECEIPTS
    await execSafe(`
      CREATE TABLE LEASED_RECEIPTS_DTLS (
        ID NUMBER PRIMARY KEY,
        FILENAME VARCHAR2(255) NOT NULL,
        ORIGINAL_NAME VARCHAR2(255) NOT NULL,
        FILE_PATH VARCHAR2(500) NOT NULL,
        FILE_SIZE NUMBER NOT NULL,
        PARTY_CODE VARCHAR2(50),
        EXTRACTED_TEXT CLOB,
        EXTRACTED_NAME VARCHAR2(255),
        EXTRACTED_UNIT VARCHAR2(100),
        EXTRACTED_AMOUNT NUMBER(12, 2),
        EXTRACTED_MONTH VARCHAR2(100),
        TENANT_ID NUMBER,
        MATCH_CONFIDENCE NUMBER DEFAULT 0,
        MATCH_REASON VARCHAR2(500),
        EMAIL_STATUS VARCHAR2(50) DEFAULT 'pending',
        SENT_AT DATE,
        ERROR_MESSAGE VARCHAR2(2000),
        CREATED_AT DATE DEFAULT SYSDATE
      )
    `);
    await execSafe('CREATE SEQUENCE SEQ_LEASED_RECEIPTS START WITH 1 INCREMENT BY 1 NOCACHE');
    await execSafe(`
      CREATE OR REPLACE TRIGGER TRG_LEASED_RECEIPTS_ID
      BEFORE INSERT ON LEASED_RECEIPTS_DTLS
      FOR EACH ROW
      WHEN (NEW.ID IS NULL)
      BEGIN
        SELECT SEQ_LEASED_RECEIPTS.NEXTVAL INTO :NEW.ID FROM DUAL;
      END;
    `);
    await execSafe('CREATE INDEX IDX_LEASED_RCPT_CODE ON LEASED_RECEIPTS_DTLS(PARTY_CODE)');
    await execSafe('CREATE INDEX IDX_LEASED_RCPT_STATUS ON LEASED_RECEIPTS_DTLS(EMAIL_STATUS)');
    await execSafe('CREATE OR REPLACE SYNONYM RECEIPTS FOR LEASED_RECEIPTS_DTLS');

    // 4. LEASED_EMAIL_LOGS_DTLS & Synonym EMAIL_LOGS
    await execSafe(`
      CREATE TABLE LEASED_EMAIL_LOGS_DTLS (
        ID NUMBER PRIMARY KEY,
        RECEIPT_ID NUMBER,
        TENANT_ID NUMBER,
        RECIPIENT_EMAIL VARCHAR2(255) NOT NULL,
        SUBJECT VARCHAR2(500),
        STATUS VARCHAR2(50) NOT NULL,
        ERROR_MESSAGE VARCHAR2(2000),
        ATTEMPTED_AT DATE DEFAULT SYSDATE
      )
    `);
    await execSafe('CREATE SEQUENCE SEQ_LEASED_EMAIL_LOGS START WITH 1 INCREMENT BY 1 NOCACHE');
    await execSafe(`
      CREATE OR REPLACE TRIGGER TRG_LEASED_EMAIL_LOGS_ID
      BEFORE INSERT ON LEASED_EMAIL_LOGS_DTLS
      FOR EACH ROW
      WHEN (NEW.ID IS NULL)
      BEGIN
        SELECT SEQ_LEASED_EMAIL_LOGS.NEXTVAL INTO :NEW.ID FROM DUAL;
      END;
    `);
    await execSafe('CREATE OR REPLACE SYNONYM EMAIL_LOGS FOR LEASED_EMAIL_LOGS_DTLS');

    // 5. LEASED_SETTINGS_DTLS & VIEW SETTINGS with UPSERT trigger
    await execSafe(`
      CREATE TABLE LEASED_SETTINGS_DTLS (
        SETTING_KEY VARCHAR2(100) PRIMARY KEY,
        SETTING_VALUE VARCHAR2(4000),
        UPDATED_AT DATE DEFAULT SYSDATE
      )
    `);
    await execSafe(`
      CREATE OR REPLACE VIEW SETTINGS AS
      SELECT SETTING_KEY AS "KEY", SETTING_VALUE AS "VALUE", UPDATED_AT FROM LEASED_SETTINGS_DTLS
    `);
    await execSafe(`
      CREATE OR REPLACE TRIGGER TRG_SETTINGS_IO_INS
      INSTEAD OF INSERT ON SETTINGS
      FOR EACH ROW
      BEGIN
        MERGE INTO LEASED_SETTINGS_DTLS dst
        USING (SELECT :NEW."KEY" AS K, :NEW."VALUE" AS V FROM DUAL) src
        ON (dst.SETTING_KEY = src.K)
        WHEN MATCHED THEN
          UPDATE SET dst.SETTING_VALUE = src.V, dst.UPDATED_AT = SYSDATE
        WHEN NOT MATCHED THEN
          INSERT (SETTING_KEY, SETTING_VALUE, UPDATED_AT) VALUES (src.K, src.V, SYSDATE);
      END;
    `);
    await execSafe(`
      CREATE OR REPLACE TRIGGER TRG_SETTINGS_IO_UPD
      INSTEAD OF UPDATE ON SETTINGS
      FOR EACH ROW
      BEGIN
        UPDATE LEASED_SETTINGS_DTLS
        SET SETTING_VALUE = :NEW."VALUE", UPDATED_AT = SYSDATE
        WHERE SETTING_KEY = :OLD."KEY";
      END;
    `);

    // 6. EMAIL_TEMPLATES
    await execSafe(`
      CREATE TABLE EMAIL_TEMPLATES (
        ID NUMBER PRIMARY KEY,
        TEMPLATE_KEY VARCHAR2(100) UNIQUE NOT NULL,
        NAME VARCHAR2(150) NOT NULL,
        SUBJECT VARCHAR2(300) NOT NULL,
        BODY_HTML VARCHAR2(4000) NOT NULL,
        IS_DEFAULT NUMBER(1) DEFAULT 1,
        CREATED_AT DATE DEFAULT SYSDATE,
        UPDATED_AT DATE DEFAULT SYSDATE
      )
    `);
    await execSafe('CREATE SEQUENCE SEQ_EMAIL_TEMPLATES START WITH 1 INCREMENT BY 1 NOCACHE');
    await execSafe(`
      CREATE OR REPLACE TRIGGER TRG_EMAIL_TEMPLATES_ID
      BEFORE INSERT ON EMAIL_TEMPLATES
      FOR EACH ROW
      WHEN (NEW.ID IS NULL)
      BEGIN
        SELECT SEQ_EMAIL_TEMPLATES.NEXTVAL INTO :NEW.ID FROM DUAL;
      END;
    `);

    // 7. LEASED_USERS_DTLS & Synonym USERS
    await execSafe(`
      CREATE TABLE LEASED_USERS_DTLS (
        ID NUMBER PRIMARY KEY,
        USERNAME VARCHAR2(100) UNIQUE NOT NULL,
        PASSWORD_HASH VARCHAR2(255) NOT NULL,
        NAME VARCHAR2(150) NOT NULL,
        ROLE VARCHAR2(100) NOT NULL,
        CREATED_AT DATE DEFAULT SYSDATE
      )
    `);
    await execSafe('CREATE SEQUENCE SEQ_LEASED_USERS START WITH 1 INCREMENT BY 1 NOCACHE');
    await execSafe(`
      CREATE OR REPLACE TRIGGER TRG_LEASED_USERS_ID
      BEFORE INSERT ON LEASED_USERS_DTLS
      FOR EACH ROW
      WHEN (NEW.ID IS NULL)
      BEGIN
        SELECT SEQ_LEASED_USERS.NEXTVAL INTO :NEW.ID FROM DUAL;
      END;
    `);
    await execSafe('CREATE OR REPLACE SYNONYM USERS FOR LEASED_USERS_DTLS');

    // Seed default administrative users if not present
    const defaultUsers = [
      ['admin', hashPassword('Admin@NFL2026'), 'System Administrator', 'Admin'],
      ['it_engineering', hashPassword('IT@NFL2026'), 'IT Engineering Team', 'IT Engineering']
    ];
    for (const [u, p, n, r] of defaultUsers) {
      try {
        const chk = await conn.execute('SELECT COUNT(*) AS CNT FROM LEASED_USERS_DTLS WHERE LOWER(USERNAME) = LOWER(:1)', [u], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        if (chk.rows[0].CNT === 0) {
          await conn.execute('INSERT INTO LEASED_USERS_DTLS (USERNAME, PASSWORD_HASH, NAME, ROLE) VALUES (:1, :2, :3, :4)', [u, p, n, r], { autoCommit: true });
        }
      } catch (e) {}
    }

    // Seed default settings if not present
    const defaultEmailBody = `<p>Dear <strong>{{tenant_name}}</strong>,</p>
<p>Please find attached your monthly lease rent invoice.</p>
<ul>
  <li><strong>Unit / Flat:</strong> {{unit_number}}</li>
  <li><strong>Amount:</strong> Rs. {{amount}}</li>
  <li><strong>Date:</strong> {{date}}</li>
</ul>
<p>Warm regards,<br><strong>Estate Department, NFL Nangal Unit</strong></p>`;

    const defaultSettings = [
      ['smtp_host', 'smtp.mgovcloud.in'],
      ['smtp_port', '465'],
      ['smtp_secure', 'true'],
      ['smtp_user', 'amcnl@nfl.co.in'],
      ['smtp_pass', 'Bx6nNvAxibsG'],
      ['smtp_from_name', 'Lease Rent Billing System NFL Nangal'],
      ['smtp_from_email', 'amcnl@nfl.co.in'],
      ['email_subject', 'Monthly Lease Rent Invoice - {{month}} (Unit: {{unit_number}})'],
      ['email_body_template', defaultEmailBody],
      ['rate_limit_delay_ms', '1000'],
      ['simulation_mode', 'false'],
      ['bulk_mail_path', 'D:\\estate_bills']
    ];

    for (const [key, val] of defaultSettings) {
      try {
        const chk = await conn.execute('SELECT COUNT(*) AS CNT FROM LEASED_SETTINGS_DTLS WHERE SETTING_KEY = :1', [key], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        if (chk.rows[0].CNT === 0) {
          await conn.execute('INSERT INTO LEASED_SETTINGS_DTLS (SETTING_KEY, SETTING_VALUE) VALUES (:1, :2)', [key, val], { autoCommit: true });
        }
      } catch (e) {}
    }

    // Seed default email template if not present
    try {
      const chkTpl = await conn.execute("SELECT COUNT(*) AS CNT FROM EMAIL_TEMPLATES WHERE TEMPLATE_KEY = 'monthly_lease_invoice'", [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      if (chkTpl.rows[0].CNT === 0) {
        await conn.execute(
          `INSERT INTO EMAIL_TEMPLATES (TEMPLATE_KEY, NAME, SUBJECT, BODY_HTML, IS_DEFAULT) VALUES ('monthly_lease_invoice', 'Monthly Lease Rent Invoice', 'Monthly Lease Rent Invoice - {{month}} (Unit: {{unit_number}})', :1, 1)`,
          [defaultEmailBody],
          { autoCommit: true }
        );
      }
    } catch (e) {}

    console.log(`[Oracle] ✅ Central Oracle Database (10.2.53.55:1521/DB10G) initialized and verified successfully!`);
  } finally {
    if (conn) {
      try { await conn.close(); } catch (e) {}
      console.log(`[Oracle] 🛑 Schema initialization complete. Direct Oracle connection closed immediately.`);
    }
  }
}

// Transparent DB proxy object for any legacy callers
const db = {
  run: (sql, params, cb) => {
    run(sql, params)
      .then(res => cb && cb.call({ lastID: res.lastID, changes: res.changes }, null))
      .catch(err => cb && cb(err));
  },
  get: (sql, params, cb) => {
    get(sql, params).then(row => cb && cb(null, row)).catch(err => cb && cb(err));
  },
  all: (sql, params, cb) => {
    all(sql, params).then(rows => cb && cb(null, rows)).catch(err => cb && cb(err));
  },
  getConnection,
  withConnection,
  closePool,
  getPoolMetrics
};

module.exports = {
  db,
  run,
  get,
  all,
  initDb,
  hashPassword,
  getConnection,
  withConnection,
  getPool,
  closePool,
  getPoolMetrics,
  oracledb
};
