/**
 * Direct Oracle Synchronization & Data Quality Engine
 * Central Database: Oracle 10g @ 10.2.53.55:1521/DB10G (PAYTEMP)
 * Directly manages LEASED_CUSTOMERS_DTLS, LEASED_RECEIPTS_DTLS, LEASED_SETTINGS_DTLS, EMAIL_TEMPLATES
 */

const fs = require('fs');
const path = require('path');
const { run, get, all } = require('./database');
const { extractPartyCodeFromFilename } = require('./matchingEngine');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'oracle_tenants_cache.json');

/**
 * Recreate data/oracle_tenants_cache.json from current live database data
 */
async function recreateJsonCache() {
  try {
    const tenants = await all('SELECT tenant_code as party_code, name, email, unit_number, phone FROM tenants ORDER BY tenant_code ASC');
    const jsonContent = JSON.stringify(tenants, null, 2);
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, jsonContent, 'utf8');
    console.log(`[Cache] 📁 Refreshed oracle_tenants_cache.json with ${tenants.length} records.`);
    return tenants;
  } catch (err) {
    console.warn('[Cache] Notice recreating JSON cache:', err.message);
  }
}

/**
 * Fetch all tenant records directly from PAYTEMP.LEASED_CUSTOMERS_DTLS in Oracle DB
 */
async function fetchLeasedCustomersFromOracle() {
  try {
    const rows = await all(`
      SELECT 
        TRIM(PARTY_CODE) as party_code,
        NVL(TRIM(PARTY_NAME), '') as name,
        NVL(TRIM(PARTY_EMAIL_ID), '') as email,
        NVL(TRIM(UNIT_NUMBER), '') as unit_number,
        NVL(TRIM(PHONE), '') as phone,
        NVL(RENT_AMOUNT, 0) as rent_amount,
        TAGS as tags
      FROM LEASED_CUSTOMERS_DTLS
      ORDER BY PARTY_CODE ASC
    `);

    // Normalize emails and calculate data discrepancy tags
    const partyCodeFreq = {};
    const rowSignatures = {};

    for (const r of rows) {
      if (r.party_code) {
        partyCodeFreq[r.party_code] = (partyCodeFreq[r.party_code] || 0) + 1;
        const sig = `${r.party_code}|||${(r.unit_number || '').toLowerCase()}|||${(r.email || '').toLowerCase()}`;
        rowSignatures[sig] = (rowSignatures[sig] || 0) + 1;
      }
    }

    const processedRows = rows.map(e => {
      let email = (e.email || '').replace(/\s+/g, '');
      if (!email.includes('@') && email.includes('gmail.com')) {
        email = email.replace('gmail.com', '@gmail.com');
      }

      const tags = [];
      const isDupParty = (partyCodeFreq[e.party_code] || 0) > 1;
      const sig = `${e.party_code}|||${(e.unit_number || '').toLowerCase()}|||${(email || '').toLowerCase()}`;
      const isIdenticalRow = (rowSignatures[sig] || 0) > 1;

      if (isIdenticalRow) {
        tags.push(`exact_duplicate:Identical Row (${rowSignatures[sig]} copies)`);
      } else if (isDupParty) {
        tags.push(`duplicate_party:Duplicate Party Code (${partyCodeFreq[e.party_code]} entries)`);
      }

      if (!email || !email.includes('@')) {
        tags.push('no_email:Missing Email Address');
      }

      if (!e.unit_number || e.unit_number === 'N/A' || e.unit_number.trim() === '') {
        tags.push('missing_unit:Missing Unit / Flat No');
      }

      if (!e.name || e.name.startsWith('Party ') || e.name.trim() === '') {
        tags.push('missing_name:Missing Customer Name');
      }

      if (tags.length === 0) {
        tags.push('clean:Clean Record');
      }

      const finalTags = tags.join(';');
      const isChanged = (e.tags || '') !== finalTags ||
                        (e.email || '') !== email ||
                        (e.name || '') !== (e.name || `Party ${e.party_code}`) ||
                        (e.unit_number || '') !== (e.unit_number || 'N/A');

      return {
        party_code: e.party_code,
        name: e.name || `Party ${e.party_code}`,
        email: email,
        unit_number: e.unit_number || 'N/A',
        phone: e.phone || '',
        rent_amount: e.rent_amount || 0,
        tags: finalTags,
        isChanged
      };
    });

    console.log(`[Oracle] 🔄 Retrieved ${processedRows.length} customer records directly from LEASED_CUSTOMERS_DTLS.`);
    return processedRows;
  } catch (err) {
    console.error('[Oracle] Error querying LEASED_CUSTOMERS_DTLS:', err.message);
    throw err;
  }
}

/**
 * Execute customer insertion/update directly into Oracle LEASED_CUSTOMERS_DTLS
 */
async function addLeasedCustomerToOracle(customer) {
  const { partyCode, partyName, email, unitNumber, phone, rentAmount } = customer;
  const cleanCode = (partyCode || '').toString().trim().slice(0, 20);
  const cleanEmail = (email || '').toString().trim().replace(/\s+/g, '').slice(0, 55);
  const cleanName = (partyName || `Party ${cleanCode}`).toString().trim().slice(0, 100);
  const cleanUnit = (unitNumber || 'N/A').toString().trim().slice(0, 100);
  const cleanPhone = (phone || '').toString().trim().slice(0, 50);
  const rent = parseFloat(rentAmount) || 0;

  if (!cleanCode) throw new Error('Party Code is required.');

  const mergeSql = `
    MERGE INTO LEASED_CUSTOMERS_DTLS dst
    USING (SELECT ? AS CODE FROM DUAL) src
    ON (TRIM(dst.PARTY_CODE) = TRIM(src.CODE))
    WHEN MATCHED THEN
      UPDATE SET
        dst.PARTY_NAME = ?,
        dst.PARTY_EMAIL_ID = ?,
        dst.UNIT_NUMBER = ?,
        dst.PHONE = ?,
        dst.RENT_AMOUNT = ?
    WHEN NOT MATCHED THEN
      INSERT (PARTY_CODE, PARTY_NAME, PARTY_EMAIL_ID, UNIT_NUMBER, PHONE, RENT_AMOUNT, TAGS)
      VALUES (?, ?, ?, ?, ?, ?, 'clean:Clean Record')
  `;

  await run(mergeSql, [cleanCode, cleanName, cleanEmail, cleanUnit, cleanPhone, rent, cleanCode, cleanName, cleanEmail, cleanUnit, cleanPhone, rent]);

  console.log(`[Oracle] ✅ Saved customer ${cleanCode} (${cleanName}) directly into LEASED_CUSTOMERS_DTLS!`);
  await recreateJsonCache().catch(() => {});
  return { success: true, partyCode: cleanCode };
}

/**
 * Delete customer directly from Oracle LEASED_CUSTOMERS_DTLS by party code
 */
async function deleteLeasedCustomerFromOracle(partyCode) {
  const cleanCode = (partyCode || '').toString().trim();
  if (!cleanCode) return false;

  try {
    const res = await run('DELETE FROM LEASED_CUSTOMERS_DTLS WHERE TRIM(PARTY_CODE) = ?', [cleanCode]);
    console.log(`[Oracle] 🗑️ Deleted party code ${cleanCode} directly from LEASED_CUSTOMERS_DTLS (${res.changes} affected).`);
    await recreateJsonCache().catch(() => {});
    return true;
  } catch (err) {
    console.error(`[Oracle] Error deleting party ${cleanCode}:`, err.message);
    return false;
  }
}

/**
 * Sync & evaluate all records in LEASED_CUSTOMERS_DTLS, update hygiene tags,
 * and auto-rematch receipts in LEASED_RECEIPTS_DTLS.
 */
async function syncOracleTenants() {
  console.log('🔄 Evaluating live customer records directly in Oracle PAYTEMP.LEASED_CUSTOMERS_DTLS...');
  const oracleTenants = await fetchLeasedCustomersFromOracle();
  console.log(`✅ Analyzed ${oracleTenants.length} customer entries in Oracle.`);

  // 1. Update TAGS and amounts directly in LEASED_CUSTOMERS_DTLS only for modified records
  let updatedTenantsCount = 0;
  for (const t of oracleTenants) {
    if (t.isChanged) {
      await run(`
        UPDATE LEASED_CUSTOMERS_DTLS
        SET TAGS = ?, PARTY_EMAIL_ID = ?, UNIT_NUMBER = ?, PARTY_NAME = ?
        WHERE TRIM(PARTY_CODE) = ?
      `, [t.tags, t.email, t.unit_number, t.name, t.party_code]);
      updatedTenantsCount++;
    }
  }
  if (updatedTenantsCount > 0) {
    console.log(`[Oracle] 💾 Updated ${updatedTenantsCount} changed customer records in Oracle DB.`);
  }

  // 2. Auto-rematch receipts strictly by exact party_code against LEASED_CUSTOMERS_DTLS
  const updatedTenants = await all('SELECT id, tenant_code, name, email, unit_number FROM tenants');
  const receipts = await all('SELECT id, party_code, original_name, extracted_unit, tenant_id, match_confidence, match_reason FROM receipts');
  let matchedCount = 0;
  let updatedReceiptsCount = 0;

  for (const r of receipts) {
    const effectiveCode = (r.party_code || extractPartyCodeFromFilename(r.original_name) || '').trim();
    if (!effectiveCode) {
      if (r.tenant_id !== null || r.match_confidence !== 0) {
        await run(`
          UPDATE LEASED_RECEIPTS_DTLS
          SET TENANT_ID = NULL, MATCH_CONFIDENCE = 0, MATCH_REASON = 'Pending Match (No party code detected)'
          WHERE ID = ?
        `, [r.id]);
        updatedReceiptsCount++;
      }
      continue;
    }

    const matchingTenants = updatedTenants.filter(t => {
      const tc = String(t.tenant_code || '').trim().toLowerCase();
      const rc = effectiveCode.toLowerCase();
      return tc === rc || (tc.replace(/^0+/, '') === rc.replace(/^0+/, '') && tc.replace(/^0+/, '').length > 0);
    });

    if (matchingTenants.length > 0) {
      let tenant = matchingTenants[0];
      if (matchingTenants.length > 1 && r.extracted_unit) {
        const normExt = (r.extracted_unit || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const unitMatch = matchingTenants.find(t => {
          const normU = (t.unit_number || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          return normExt && normU && (normU.includes(normExt) || normExt.includes(normU));
        });
        if (unitMatch) tenant = unitMatch;
      }
      if ((!tenant.email || !tenant.email.includes('@')) && matchingTenants.some(t => t.email && t.email.includes('@'))) {
        tenant = matchingTenants.find(t => t.email && t.email.includes('@')) || tenant;
      }

      matchedCount++;
      const reason = `Exact Party Code Match (${effectiveCode} === ${tenant.tenant_code})`;
      if (r.tenant_id !== tenant.id || r.match_confidence !== 100 || r.party_code !== effectiveCode) {
        await run(`
          UPDATE LEASED_RECEIPTS_DTLS
          SET TENANT_ID = ?, MATCH_CONFIDENCE = 100, MATCH_REASON = ?, PARTY_CODE = ?
          WHERE ID = ?
        `, [tenant.id, reason, effectiveCode, r.id]);
        updatedReceiptsCount++;
      }
    } else {
      if (r.tenant_id !== null || r.party_code !== effectiveCode) {
        await run(`
          UPDATE LEASED_RECEIPTS_DTLS
          SET TENANT_ID = NULL, MATCH_CONFIDENCE = 0, MATCH_REASON = 'No matching party code in LEASED_CUSTOMERS_DTLS', PARTY_CODE = ?
          WHERE ID = ?
        `, [effectiveCode, r.id]);
        updatedReceiptsCount++;
      }
    }
  }
  if (updatedReceiptsCount > 0) {
    console.log(`[Oracle] 💾 Updated ${updatedReceiptsCount} changed receipt records in Oracle DB.`);
  }

  // Refresh disk cache
  await recreateJsonCache();

  const withEmailCount = (await get("SELECT COUNT(*) as cnt FROM tenants WHERE email IS NOT NULL AND email LIKE '%@%'")).cnt;
  const noEmailCount = (await get("SELECT COUNT(*) as cnt FROM tenants WHERE email IS NULL OR email NOT LIKE '%@%'")).cnt;
  const duplicatesCount = (await get("SELECT COUNT(*) as cnt FROM tenants WHERE tags LIKE '%duplicate%'")).cnt;
  const discrepanciesCount = (await get("SELECT COUNT(*) as cnt FROM tenants WHERE tags NOT LIKE '%clean%' AND tags IS NOT NULL")).cnt;
  const cleanCount = (await get("SELECT COUNT(*) as cnt FROM tenants WHERE tags LIKE '%clean%'")).cnt;
  const totalCount = (await get("SELECT COUNT(*) as cnt FROM tenants")).cnt;

  const syncTimestamp = new Date().toISOString();
  const syncStats = {
    total: totalCount,
    withEmail: withEmailCount,
    noEmail: noEmailCount,
    duplicates: duplicatesCount,
    discrepancies: discrepanciesCount,
    clean: cleanCount,
    matchedReceipts: matchedCount,
    timestamp: syncTimestamp
  };

  await run(`
    MERGE INTO LEASED_SETTINGS_DTLS dst
    USING (SELECT 'last_oracle_sync_time' AS K, ? AS V FROM DUAL) src
    ON (dst.SETTING_KEY = src.K)
    WHEN MATCHED THEN UPDATE SET dst.SETTING_VALUE = src.V, dst.UPDATED_AT = SYSDATE
    WHEN NOT MATCHED THEN INSERT (SETTING_KEY, SETTING_VALUE, UPDATED_AT) VALUES (src.K, src.V, SYSDATE)
  `, [syncTimestamp]);

  await run(`
    MERGE INTO LEASED_SETTINGS_DTLS dst
    USING (SELECT 'last_oracle_sync_stats' AS K, ? AS V FROM DUAL) src
    ON (dst.SETTING_KEY = src.K)
    WHEN MATCHED THEN UPDATE SET dst.SETTING_VALUE = src.V, dst.UPDATED_AT = SYSDATE
    WHEN NOT MATCHED THEN INSERT (SETTING_KEY, SETTING_VALUE, UPDATED_AT) VALUES (src.K, src.V, SYSDATE)
  `, [JSON.stringify(syncStats)]);

  console.log(`🎉 Oracle Sync Complete: ${totalCount} entries directly in Oracle LEASED_CUSTOMERS_DTLS, ${matchedCount} receipts matched!`);

  return {
    success: true,
    totalFromOracle: oracleTenants.length,
    syncedCount: oracleTenants.length,
    totalTenants: totalCount,
    withEmailCount,
    noEmailCount,
    duplicatesCount,
    discrepanciesCount,
    cleanCount,
    matchedReceipts: matchedCount,
    lastSyncTime: syncTimestamp,
    tenants: oracleTenants
  };
}

/**
 * Fetch settings directly from LEASED_SETTINGS_DTLS in Oracle
 */
async function fetchSettingsFromOracle() {
  try {
    const rows = await all('SELECT SETTING_KEY as key, SETTING_VALUE as value FROM LEASED_SETTINGS_DTLS');
    const settings = {};
    for (const r of rows) {
      if (r.key) settings[r.key] = r.value || '';
    }
    return { success: true, settings };
  } catch (err) {
    console.error('[Oracle] Error fetching settings:', err.message);
    return { success: false, settings: {} };
  }
}

/**
 * Save settings directly into LEASED_SETTINGS_DTLS in Oracle
 */
async function syncSettingsToOracle(settings) {
  if (!settings || typeof settings !== 'object') return { success: false, error: 'Invalid settings' };

  try {
    for (const [key, val] of Object.entries(settings)) {
      if (val === undefined || val === null) continue;
      await run(`
        MERGE INTO LEASED_SETTINGS_DTLS dst
        USING (SELECT ? AS K, ? AS V FROM DUAL) src
        ON (dst.SETTING_KEY = src.K)
        WHEN MATCHED THEN UPDATE SET dst.SETTING_VALUE = src.V, dst.UPDATED_AT = SYSDATE
        WHEN NOT MATCHED THEN INSERT (SETTING_KEY, SETTING_VALUE, UPDATED_AT) VALUES (src.K, src.V, SYSDATE)
      `, [String(key), String(val)]);
    }
    console.log('[Oracle] ✅ Successfully updated LEASED_SETTINGS_DTLS in Oracle DB!');
    return { success: true };
  } catch (err) {
    console.error('[Oracle] Error updating LEASED_SETTINGS_DTLS:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Fetch email templates directly from EMAIL_TEMPLATES in Oracle
 */
async function fetchEmailTemplatesFromOracle() {
  try {
    const templates = await all(`
      SELECT ID, TEMPLATE_KEY, NAME, SUBJECT, IS_DEFAULT, BODY_HTML
      FROM EMAIL_TEMPLATES
      ORDER BY IS_DEFAULT DESC, ID ASC
    `);
    return { success: true, templates };
  } catch (err) {
    console.error('[Oracle] Error fetching EMAIL_TEMPLATES:', err.message);
    return { success: false, templates: [] };
  }
}

/**
 * Fetch default active email template from Oracle
 */
async function fetchActiveTemplateFromOracle() {
  try {
    const tpl = await get(`
      SELECT ID, TEMPLATE_KEY, NAME, SUBJECT, IS_DEFAULT, BODY_HTML
      FROM EMAIL_TEMPLATES
      WHERE IS_DEFAULT = 1
      ORDER BY ID DESC
    `);
    return tpl || null;
  } catch (err) {
    console.warn('[Oracle] Notice fetching active template:', err.message);
    return null;
  }
}

/**
 * Save email template directly into EMAIL_TEMPLATES in Oracle
 */
async function saveEmailTemplateToOracle(template) {
  const { template_key, name, subject, body_html, is_default } = template;
  if (!template_key || !name || !subject || !body_html) {
    return { success: false, error: 'template_key, name, subject, and body_html are required' };
  }

  try {
    if (is_default) {
      await run('UPDATE EMAIL_TEMPLATES SET IS_DEFAULT = 0', []);
    }

    const mergeSql = `
      MERGE INTO EMAIL_TEMPLATES dst
      USING (SELECT ? AS K FROM DUAL) src
      ON (dst.TEMPLATE_KEY = src.K)
      WHEN MATCHED THEN
        UPDATE SET
          dst.NAME = ?,
          dst.SUBJECT = ?,
          dst.BODY_HTML = ?,
          dst.IS_DEFAULT = ?,
          dst.UPDATED_AT = SYSDATE
      WHEN NOT MATCHED THEN
        INSERT (TEMPLATE_KEY, NAME, SUBJECT, BODY_HTML, IS_DEFAULT, CREATED_AT, UPDATED_AT)
        VALUES (?, ?, ?, ?, ?, SYSDATE, SYSDATE)
    `;

    const defVal = is_default ? 1 : 0;
    await run(mergeSql, [
      String(template_key).trim(),
      String(name).trim(),
      String(subject).trim(),
      String(body_html).trim(),
      defVal,
      String(template_key).trim(),
      String(name).trim(),
      String(subject).trim(),
      String(body_html).trim(),
      defVal
    ]);

    console.log('[Oracle] ✅ Successfully saved template into EMAIL_TEMPLATES directly in Oracle DB!');
    return { success: true, message: 'Saved directly into Oracle EMAIL_TEMPLATES table.' };
  } catch (err) {
    console.error('[Oracle] Error saving EMAIL_TEMPLATES:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  fetchLeasedCustomersFromOracle,
  syncOracleTenants,
  addLeasedCustomerToOracle,
  deleteLeasedCustomerFromOracle,
  fetchSettingsFromOracle,
  syncSettingsToOracle,
  fetchEmailTemplatesFromOracle,
  fetchActiveTemplateFromOracle,
  saveEmailTemplateToOracle,
  recreateJsonCache
};
