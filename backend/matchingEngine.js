const path = require('path');

/**
 * Extract party code from a filename.
 * Handles:
 * - "9594.pdf" -> "9594"
 * - "9594_1.pdf", "9594_2.pdf" -> "9594"
 * - "102036.pdf" -> "102036"
 * - "102036_2.pdf" -> "102036"
 * - "PRT-1001.pdf" -> "PRT-1001"
 * - "Page_0001_PRT-1001.pdf" -> "PRT-1001"
 * - "REC_9594.pdf" -> "9594"
 */
function extractPartyCodeFromFilename(filename) {
  if (!filename) return null;
  let rawBase = path.basename(filename, path.extname(filename)).trim();

  // 1. If it has Page_XXXX_ prefix, remove it first
  const pageMatch = rawBase.match(/^Page_\d+_(.+)$/i);
  if (pageMatch && pageMatch[1]) {
    rawBase = pageMatch[1].trim();
  }

  // 2. Strip duplicate copy suffix like _1, _2, (1) but NOT a long number (only 1-2 digits or copy)
  let cleanBase = rawBase.replace(/_\d{1,2}$/, '').replace(/\s*\(\d+\)$/, '').trim();

  // 3. Prefix pattern: e.g. "Party_9594", "REC-9594", "Invoice_9594", "Cust-1210001541"
  const prefixMatch = cleanBase.match(/^(?:Party|Receipt|REC|Inv|Invoice|Tenant|Cust)[-_ ]+([A-Za-z0-9\-_]{2,25})$/i);
  if (prefixMatch && prefixMatch[1]) {
    return prefixMatch[1].trim();
  }

  // 4. Direct alphanumeric code e.g. "1210001541", "9594", "8637", "TNT-101"
  if (/^[A-Za-z0-9\-_]{2,30}$/.test(cleanBase) && !/^page_\d+$/i.test(cleanBase)) {
    return cleanBase;
  }

  return null;
}

function normalize(str) {
  if (!str) return '';
  return str.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Match a receipt to a tenant strictly by exact Party Code from LEASED_CUSTOMERS_DTLS.
 * Only returns a match if receipt.party_code (or filename party code) matches tenant.tenant_code.
 */
function matchReceiptToTenant(receipt, tenants) {
  if (!tenants || tenants.length === 0) return null;

  const originalName = receipt.original_name || receipt.filename || '';
  const partyCodeFromFilename = extractPartyCodeFromFilename(originalName);
  const effectivePartyCode = (receipt.party_code || partyCodeFromFilename || '').trim();

  if (!effectivePartyCode) {
    return null;
  }

  const partyCodeNorm = normalize(effectivePartyCode);
  const partyCodeClean = partyCodeNorm.replace(/^0+/, '');

  for (const tenant of tenants) {
    const tenantCode = (tenant.tenant_code || '').trim();
    if (!tenantCode) continue;

    const tenantCodeNorm = normalize(tenantCode);
    const tenantCodeClean = tenantCodeNorm.replace(/^0+/, '');

    // Exact Match on Party Code
    if (tenantCodeNorm === partyCodeNorm || (tenantCodeClean && tenantCodeClean === partyCodeClean)) {
      return {
        tenantId: tenant.id,
        tenantCode: tenant.tenant_code,
        tenantName: tenant.name,
        tenantEmail: tenant.email,
        tenantUnit: tenant.unit_number,
        confidence: 100,
        reason: `Exact Party Code Match (${effectivePartyCode} === ${tenant.tenant_code})`
      };
    }
  }

  return null;
}

module.exports = {
  matchReceiptToTenant,
  extractPartyCodeFromFilename,
  normalize
};

