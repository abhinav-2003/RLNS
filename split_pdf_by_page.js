const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const PDFParser = require('pdf2json');
const pdfParse = require('pdf-parse');

/**
 * Robust party code, invoice number, acknowledgement number & metadata extractor
 */
function extractPartyDetails(text) {
  const cleanText = (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 1. Full Invoice Number (e.g. NN2627LR518044) or SAP Invoice No (e.g. 518044)
  let invoiceNo = null;
  let fullInvoiceCode = null;

  const fullInvMatch = cleanText.match(/(?:Invoice\s*No\.?|Tax\s*Invoice\s*No\.?|Invoice\s*Number)\s*[:\-]?\s*([A-Za-z0-9\-\/]{4,30})/i);
  if (fullInvMatch && fullInvMatch[1]) {
    const cand = fullInvMatch[1].trim();
    if (!/^(goods|services|date|amount|total|paid|month|cash|online)$/i.test(cand)) {
      fullInvoiceCode = cand;
      invoiceNo = cand;
    }
  }

  const sapMatch = cleanText.match(/(?:SAP\s*Invoice\s*No|Inv\s*No\.?)\s*[:\-]?\s*([A-Za-z0-9\-\/]{4,30})/i);
  if (sapMatch && sapMatch[1]) {
    const cand = sapMatch[1].trim();
    if (!invoiceNo) invoiceNo = cand;
  }

  // 2. Acknowledgement Number (only present on Page 2 or single-page 1-of-1)
  let ackNo = null;
  const ackMatch = cleanText.match(/(?:Acknowledgement\s*No\.?|Ack\s*No\.?|Acknowledgment\s*No\.?)\s*[:\-]?\s*([A-Za-z0-9\-\/]{6,40})/i);
  if (ackMatch && ackMatch[1]) {
    ackNo = ackMatch[1].trim();
  }

  // 3. Page count indicator (e.g. 1 of 2, 2 of 2, 1 of 1)
  let pageCurrent = null;
  let pageTotal = null;
  const pageOfMatch = cleanText.match(/\b(\d+)\s+of\s+(\d+)\b/i);
  if (pageOfMatch) {
    pageCurrent = parseInt(pageOfMatch[1], 10);
    pageTotal = parseInt(pageOfMatch[2], 10);
  }

  // 4. Party Code patterns (Only on Page 1)
  let partyCode = null;
  const partyCodePatterns = [
    /(?:Party\s*Code|Party\s*No\.?|Party\s*ID|Party\s*A\/c(?:\s*Code|\s*No)?|Party\s*Account|Party\s*Ref)\s*[:\-#]?\s*([A-Za-z0-9\-\/]{2,25})/i,
    /(?:Customer\s*Code|Cust\s*Code|Tenant\s*Code|Tenant\s*ID|Tenant\s*No\.?|Tenant\s*#|Client\s*Code|Acc(?:ount)?\s*Code)\s*[:\-#]?\s*([A-Za-z0-9\-\/]{2,25})/i,
    /(?:Party\s*:\s*)([A-Za-z0-9\-\/]{2,25})\b/i,
    /\bCode\s*[:\-#]\s*([A-Za-z0-9\-\/]{2,25})/i,
    /\b(?:TNT|PTY|CUST|TENANT|PARTY)[-_]\d{3,8}\b/i
  ];

  for (const regex of partyCodePatterns) {
    const match = cleanText.match(regex);
    if (match) {
      const candidate = (match[1] || match[0]).trim();
      if (!/^(invoice|receipt|date|total|amount|paid|month|cash|online|cheque|na|n\/a|none|null)$/i.test(candidate)) {
        partyCode = candidate;
        break;
      }
    }
  }

  // 5. Party Name patterns
  let partyName = null;
  const partyNamePatterns = [
    /(?:Party\s*Name|Customer\s*Name|Tenant\s*Name|Received\s*From)\s*[:\-]\s*([A-Za-z0-9\s.,&'\/()-]{2,40}?)(?:\s{2,}|\r|\n|,|$)/i,
    /(?:M\/s\.?)\s*([A-Za-z0-9\s.,&'\/()-]{2,40}?)(?:\s{2,}|\r|\n|,|$)/i
  ];
  for (const regex of partyNamePatterns) {
    const match = cleanText.match(regex);
    if (match && match[1]) {
      const candidate = match[1].trim();
      if (!/^(invoice|receipt|payment|amount|date|rent|unit|flat|code|party\s*code|uttar\s*pradesh|punjab|delhi|haryana|closing|opening)$/i.test(candidate)) {
        partyName = candidate;
        break;
      }
    }
  }

  // 6. Unit / Flat / Quarter Number
  let unitNumber = null;
  const unitPatterns = [
    /(?:Unit\s*[\/&]\s*Flat|Flat\s*[\/&]\s*Unit|Flat|Unit|Apt|Room|Shop|Block|House|Qtr\s*No\.?|QTR\.?\s*NO\.?|No\.?|#)\s*[:#-]?\s*([A-Za-z0-9\s\-,]{1,25}?)(?:\s{2,}|\r|\n|$)/i,
    /\b([A-Z]{1,2}[-\s]?\d{2,4})\b/i
  ];
  for (const regex of unitPatterns) {
    const match = cleanText.match(regex);
    if (match && match[1]) {
      unitNumber = match[1].trim();
      break;
    }
  }

  // 7. Amount
  let amount = null;
  const amountMatch = cleanText.match(/(?:Total\s*Invoice\s*Value|INVOICE\s*AMOUNT|Amount|Total|Rent|Paid|Net\s*Amount)\s*[:\-]?\s*(?:₹|Rs\.?|INR)?\s*([0-9.,]+)/i);
  if (amountMatch && amountMatch[1]) {
    const str = amountMatch[1].trim();
    if (str.includes(',') && str.includes('.')) {
      if (str.indexOf('.') < str.indexOf(',')) {
        amount = parseFloat(str.replace(/\./g, '').replace(',', '.'));
      } else {
        amount = parseFloat(str.replace(/,/g, ''));
      }
    } else {
      amount = parseFloat(str.replace(/,/g, ''));
    }
  }

  return {
    partyCode: partyCode || 'UNKNOWN_PARTY',
    partyName: partyName || '',
    unitNumber: unitNumber || '',
    amount: amount || 0,
    invoiceNo,
    fullInvoiceCode,
    ackNo,
    pageCurrent,
    pageTotal,
    hasPartyCode: !!partyCode && partyCode !== 'UNKNOWN_PARTY',
    hasInvoiceNo: !!invoiceNo,
    hasAckNo: !!ackNo,
    rawText: cleanText
  };
}

/**
 * Extract billing month-year format Mon-YYYY (e.g. Aug-2026, Sep-2026)
 */
function getMonYYYY(sampleText = '') {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  // 1. Match Date format: 31.08.2026 or 31/08/2026 or 31-08-2026
  const dateMatch = sampleText.match(/(?:Invoice\s*Date|Bill\s*Date|Date)\s*[:\-]?\s*(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/i);
  if (dateMatch) {
    const monthNum = parseInt(dateMatch[2], 10);
    const year = dateMatch[3];
    if (monthNum >= 1 && monthNum <= 12) {
      return `${months[monthNum - 1]}-${year}`;
    }
  }

  // 2. Match month name and 4-digit year: e.g. August 2026, Sep 2026
  const monthNameMatch = sampleText.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b[\s,\-_]*(\d{4})/i);
  if (monthNameMatch) {
    const rawMon = monthNameMatch[1].substring(0, 3).toLowerCase();
    const foundIdx = months.findIndex(m => m.toLowerCase() === rawMon);
    if (foundIdx !== -1) {
      return `${months[foundIdx]}-${monthNameMatch[2]}`;
    }
  }

  // 3. Fallback to current system month and year
  const now = new Date();
  return `${months[now.getMonth()]}-${now.getFullYear()}`;
}

/**
 * Isolated, non-blocking single page text reader (skips image streams to avoid flate errors)
 */
function readSinglePageText(filePath) {
  return new Promise((resolve) => {
    // 1 = raw text only mode (avoids evaluating image XObjects / flate streams)
    const parser = new PDFParser(null, 1);
    
    // Safety timeout in case parser hangs on a bad stream
    const timer = setTimeout(() => {
      resolve('');
    }, 4000);

    parser.on('pdfParser_dataError', (err) => {
      clearTimeout(timer);
      resolve('');
    });

    parser.on('pdfParser_dataReady', () => {
      clearTimeout(timer);
      try {
        const raw = parser.getRawTextContent();
        resolve(raw || '');
      } catch (e) {
        resolve('');
      }
    });

    try {
      parser.loadPDF(filePath);
    } catch (e) {
      clearTimeout(timer);
      resolve('');
    }
  });
}

/**
 * Fallback parser using pdf-parse if pdf2json returned empty
 */
async function fallbackReadText(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (e) {
    return '';
  }
}

/**
 * Group pages into receipts.
 * Architecture:
 * - Page 1 has Invoice Number (and Party Code).
 * - Page 2 has Acknowledgement Number whose prefix/pattern contains the Invoice Number from Page 1 (Page 2 has no invoice number).
 * - Page 2 is merged into Page 1.
 */
function groupPagesByInvoiceAndAck(pageMetadataList) {
  const documentGroups = [];
  const invoiceMap = new Map(); // invoice string (uppercase) -> documentGroup
  let currentGroup = null;

  for (let i = 0; i < pageMetadataList.length; i++) {
    const meta = pageMetadataList[i];
    const pageNumber = meta.pageNumber;

    // Condition A: This is Page 1 (has Invoice Number and/or Party Code)
    // Note: Page 2 does NOT have an invoice number or party code.
    const isPage1 = (meta.hasInvoiceNo && (!currentGroup || currentGroup.invoiceNo !== meta.invoiceNo)) ||
                    (meta.hasPartyCode && (!currentGroup || !currentGroup.hasPartyCode)) ||
                    (meta.pageCurrent === 1);

    if (isPage1) {
      currentGroup = {
        invoiceNo: meta.invoiceNo,
        fullInvoiceCode: meta.fullInvoiceCode,
        partyCode: meta.partyCode,
        partyName: meta.partyName,
        unitNumber: meta.unitNumber,
        amount: meta.amount,
        ackNo: meta.ackNo || null,
        pageIndices: [meta.pageIndex],
        pageNumbers: [pageNumber],
        rawTexts: [meta.rawText],
        expectedTotalPages: meta.pageTotal || 1,
        hasPartyCode: meta.hasPartyCode,
        status: meta.hasPartyCode ? 'FOUND' : 'MISSING_CODE'
      };
      documentGroups.push(currentGroup);

      if (meta.invoiceNo) {
        invoiceMap.set(meta.invoiceNo.toUpperCase().trim(), currentGroup);
      }
      if (meta.fullInvoiceCode) {
        invoiceMap.set(meta.fullInvoiceCode.toUpperCase().trim(), currentGroup);
      }
      console.log(`[+] Page 1 detected (Page ${pageNumber}) -> Invoice No: [${meta.invoiceNo || 'N/A'}], Party Code: [${meta.partyCode}]`);
      continue;
    }

    // Condition B: This is Page 2 with Acknowledgement Number
    // (Page 2 does not have Invoice Number; its Ack No begins with or contains Page 1's Invoice Number)
    if (meta.hasAckNo) {
      const ackClean = meta.ackNo.toUpperCase().trim();
      let matchedGroup = null;

      // Find Page 1 group whose invoice number is in this Acknowledgement Number
      for (const [invNo, grp] of invoiceMap.entries()) {
        if (ackClean.startsWith(invNo) || ackClean.includes(invNo)) {
          matchedGroup = grp;
          break;
        }
      }

      if (matchedGroup) {
        matchedGroup.pageIndices.push(meta.pageIndex);
        matchedGroup.pageNumbers.push(pageNumber);
        matchedGroup.rawTexts.push(meta.rawText);
        if (!matchedGroup.ackNo) matchedGroup.ackNo = meta.ackNo;
        if (!matchedGroup.amount && meta.amount) matchedGroup.amount = meta.amount;
        if (!matchedGroup.partyName && meta.partyName) matchedGroup.partyName = meta.partyName;
        if (!matchedGroup.unitNumber && meta.unitNumber) matchedGroup.unitNumber = meta.unitNumber;
        console.log(`📎 Page 2 (Page ${pageNumber}, Ack No: ${meta.ackNo}) matched to Page 1 Invoice [${matchedGroup.invoiceNo}] -> Merged! (Pages: ${matchedGroup.pageNumbers.join(', ')})`);
        continue;
      }
    }

    // Condition C: Continuation page without Ack No (e.g. Terms & Conditions)
    if (currentGroup) {
      currentGroup.pageIndices.push(meta.pageIndex);
      currentGroup.pageNumbers.push(pageNumber);
      currentGroup.rawTexts.push(meta.rawText);
      if (!currentGroup.partyName && meta.partyName) currentGroup.partyName = meta.partyName;
      if (!currentGroup.unitNumber && meta.unitNumber) currentGroup.unitNumber = meta.unitNumber;
      if (!currentGroup.amount && meta.amount) currentGroup.amount = meta.amount;
      if (!currentGroup.ackNo && meta.ackNo) currentGroup.ackNo = meta.ackNo;
      console.log(`📎 Page ${pageNumber} (Continuation) attached to Page 1 [${currentGroup.invoiceNo || currentGroup.partyCode}] (Pages: ${currentGroup.pageNumbers.join(', ')})`);
    } else {
      // Standalone unassigned page
      currentGroup = {
        invoiceNo: meta.invoiceNo,
        fullInvoiceCode: null,
        partyCode: 'UNKNOWN_PARTY',
        partyName: meta.partyName || '',
        unitNumber: meta.unitNumber || '',
        amount: meta.amount || 0,
        ackNo: meta.ackNo || null,
        pageIndices: [meta.pageIndex],
        pageNumbers: [pageNumber],
        rawTexts: [meta.rawText],
        expectedTotalPages: 1,
        hasPartyCode: false,
        status: 'MISSING_CODE'
      };
      documentGroups.push(currentGroup);
      console.log(`⚠️ Page ${pageNumber}: Standalone unassigned page.`);
    }
  }

  return documentGroups;
}

/**
 * Split master PDF into receipts with smart Invoice-Ack prefix matching.
 */
async function splitAndExtractPdf(masterPdfPath, outputDir = null, onProgress = null) {
  if (!fs.existsSync(masterPdfPath)) {
    throw new Error(`Master PDF file not found: ${masterPdfPath}`);
  }

  const defaultBaseDir = process.env.ESTATE_BILLS_DIR || 'D:\\estate_bills';
  const baseDir = outputDir ? path.resolve(outputDir) : defaultBaseDir;

  console.log(`================================================================`);
  console.log(`📄 KIRAIDAAR SMART PDF SPLITTER & ACK-INVOICE BUNDLER`);
  console.log(`================================================================`);
  console.log(`Input PDF:   ${masterPdfPath}`);
  console.log(`Loading master PDF structure...`);

  // Load master PDF structure using pdf-lib (immune to broken image streams)
  const fileBuffer = fs.readFileSync(masterPdfPath);
  const srcDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();

  console.log(`Total Pages in Master PDF: ${totalPages}`);
  console.log(`Scanning all pages for Party Codes, Invoice Nos & Ack Nos...\n`);

  const startTime = Date.now();
  const pageMetadataList = [];

  // -------------------------------------------------------------
  // Step 1: Blazing fast in-memory page text extraction
  // -------------------------------------------------------------
  let pageTexts = [];
  try {
    console.log(`Extracting text from all ${totalPages} pages in memory...`);
    await pdfParse(fileBuffer, {
      pagerender: function(pageData) {
        return pageData.getTextContent().then(textContent => {
          let text = '';
          for (const item of textContent.items) {
            text += item.str + ' ';
          }
          pageTexts.push(text);
          return text;
        });
      }
    });
    console.log(`✅ Text extracted from all ${pageTexts.length} pages in ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
  } catch (parseErr) {
    console.warn(`[!] In-memory fast parser warning: ${parseErr.message}`);
  }

  // -------------------------------------------------------------
  // Dynamic Folder: Mon-YYYY (e.g. Aug-2026, Sep-2026) inside estate_bills
  // -------------------------------------------------------------
  const sampleText = pageTexts.slice(0, 10).join(' ');
  const monYear = getMonYYYY(sampleText);

  // If baseDir already ends with Mon-YYYY, keep it; otherwise append Mon-YYYY subfolder
  const isAlreadyMonYear = new RegExp(`[\\\\/]${monYear}$`, 'i').test(baseDir);
  const resolvedOutputDir = isAlreadyMonYear ? baseDir : path.join(baseDir, monYear);

  if (!fs.existsSync(resolvedOutputDir)) {
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
  }

  console.log(`Bill Month:  ${monYear}`);
  console.log(`Output Dir:  ${resolvedOutputDir}`);
  console.log(`----------------------------------------------------------------`);

  for (let i = 0; i < totalPages; i++) {
    const pageNumber = i + 1;
    let pageText = pageTexts[i];

    // Fallback only if in-memory extraction missed this page
    if (!pageText || pageText.trim().length === 0) {
      let tempPath = null;
      try {
        const singleDoc = await PDFDocument.create();
        const [copiedPage] = await singleDoc.copyPages(srcDoc, [i]);
        singleDoc.addPage(copiedPage);
        const singleBytes = await singleDoc.save({ useObjectStreams: false });

        tempPath = path.join(resolvedOutputDir, `temp_scan_${String(pageNumber).padStart(4, '0')}_${Date.now()}.pdf`);
        fs.writeFileSync(tempPath, singleBytes);

        pageText = await readSinglePageText(tempPath);
        if (!pageText || pageText.trim().length === 0) {
          pageText = await fallbackReadText(tempPath);
        }
      } catch (e) {
        pageText = '';
      } finally {
        if (tempPath && fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch (e) {}
        }
      }
    }

    const details = extractPartyDetails(pageText || '');
    pageMetadataList.push({
      ...details,
      pageIndex: i,
      pageNumber
    });
  }

  // -------------------------------------------------------------
  // Step 2: Intelligent Grouping (Page 1 Invoice No <-> Page 2 Ack No Pattern)
  // -------------------------------------------------------------
  const documentGroups = groupPagesByInvoiceAndAck(pageMetadataList);
  const totalDocuments = documentGroups.length;

  console.log(`\nGenerating ${totalDocuments} consolidated PDF files from ${totalPages} pages...`);

  // -------------------------------------------------------------
  // Step 3: Generate the actual PDF files for each receipt group
  // -------------------------------------------------------------
  const results = [];
  const usedFilenames = new Map();

  for (let docIdx = 0; docIdx < totalDocuments; docIdx++) {
    const group = documentGroups[docIdx];
    const startPagePadded = String(group.pageNumbers[0]).padStart(4, '0');
    const hasValidPartyCode = group.partyCode && group.partyCode !== 'UNKNOWN_PARTY';
    const safePartyCode = hasValidPartyCode
      ? group.partyCode.replace(/[^a-zA-Z0-9_\-]/g, '_')
      : `UNKNOWN_PARTY_Page_${startPagePadded}`;
    
    // Naming convention as per party code: e.g. "9594.pdf", "TNT-1001.pdf"
    const baseFilename = `${safePartyCode}.pdf`;
    let finalFilename = baseFilename;

    if (usedFilenames.has(baseFilename)) {
      const count = usedFilenames.get(baseFilename) + 1;
      usedFilenames.set(baseFilename, count);
      finalFilename = `${safePartyCode}_${count}.pdf`;
    } else {
      usedFilenames.set(baseFilename, 1);
    }

    const finalFilePath = path.join(resolvedOutputDir, finalFilename);

    // Build multi-page PDF for this receipt group
    const newDoc = await PDFDocument.create();
    const copiedPages = await newDoc.copyPages(srcDoc, group.pageIndices);
    copiedPages.forEach(p => newDoc.addPage(p));
    const multiPdfBytes = await newDoc.save({ useObjectStreams: false });

    // Write file to disk
    if (fs.existsSync(finalFilePath)) {
      try { fs.unlinkSync(finalFilePath); } catch (e) {}
    }
    fs.writeFileSync(finalFilePath, multiPdfBytes);

    const combinedRawText = group.rawTexts.join('\n\n--- [PAGE BREAK] ---\n\n');

    const record = {
      page: group.pageNumbers[0],
      pageNumbers: group.pageNumbers,
      pageCount: group.pageNumbers.length,
      startPage: group.pageNumbers[0],
      endPage: group.pageNumbers[group.pageNumbers.length - 1],
      partyCode: group.partyCode,
      partyName: group.partyName,
      unitNumber: group.unitNumber,
      amount: group.amount,
      invoiceNo: group.invoiceNo,
      ackNo: group.ackNo,
      filename: finalFilename,
      filePath: finalFilePath,
      fileSize: multiPdfBytes.length,
      rawText: combinedRawText,
      status: group.hasPartyCode ? 'FOUND' : 'MISSING_CODE'
    };
    results.push(record);

    const percent = Math.round(((docIdx + 1) / totalDocuments) * 100);
    const pagesDesc = group.pageNumbers.length > 1 ? `(Pages ${group.pageNumbers.join(',')})` : `(Page ${group.pageNumbers[0]})`;
    const invTag = group.invoiceNo ? `[Inv: ${group.invoiceNo}]` : '';
    console.log(`[${String(percent).padStart(3, ' ')}%] Receipt ${docIdx + 1}/${totalDocuments} -> ${finalFilename} ${pagesDesc} ${invTag} [Party: ${group.partyCode}]`);

    if (onProgress) {
      onProgress({
        docIndex: docIdx + 1,
        totalDocuments,
        percent,
        partyCode: group.partyCode,
        filename: finalFilename,
        pageCount: group.pageNumbers.length
      });
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const foundCount = results.filter(r => r.partyCode !== 'UNKNOWN_PARTY').length;

  // Export JSON manifest
  const jsonPath = path.join(resolvedOutputDir, 'manifest.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  // Export CSV summary
  const csvPath = path.join(resolvedOutputDir, 'manifest.csv');
  const csvHeaders = 'StartPage,EndPage,PageCount,InvoiceNo,AckNo,PartyCode,PartyName,UnitNumber,Amount,Filename,Status\n';
  const csvRows = results.map(r => 
    `${r.startPage},${r.endPage},${r.pageCount},"${(r.invoiceNo || '').replace(/"/g, '""')}","${(r.ackNo || '').replace(/"/g, '""')}","${(r.partyCode || '').replace(/"/g, '""')}","${(r.partyName || '').replace(/"/g, '""')}","${(r.unitNumber || '').replace(/"/g, '""')}",${r.amount},"${r.filename}",${r.status}`
  ).join('\n');
  fs.writeFileSync(csvPath, csvHeaders + csvRows);

  console.log(`\n================================================================`);
  console.log(`✅ SPLIT & BUNDLE COMPLETE in ${durationSec}s!`);
  console.log(`Total Pages in Master:  ${totalPages}`);
  console.log(`Generated Receipts:     ${totalDocuments}`);
  console.log(`Party Codes Extracted:  ${foundCount} / ${totalDocuments} (${Math.round((foundCount / totalDocuments) * 100)}%)`);
  console.log(`Individual PDFs in:     ${resolvedOutputDir}`);
  console.log(`CSV Report:             ${csvPath}`);
  console.log(`JSON Manifest:          ${jsonPath}`);
  console.log(`================================================================\n`);

  return {
    totalPages,
    totalDocuments,
    foundCount,
    month: monYear,
    outputDir: resolvedOutputDir,
    csvPath,
    jsonPath,
    results
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`
Usage:
  node split_pdf_by_page.js <path_to_master_pdf> [output_directory]

Example:
  node split_pdf_by_page.js sample_master_multipage.pdf D:/estate_bills
    `);
    process.exit(1);
  }

  const masterPdf = args[0];
  const outDir = args[1] || 'D:\\estate_bills';

  splitAndExtractPdf(masterPdf, outDir).catch(err => {
    console.error('Fatal Error:', err);
    process.exit(1);
  });
}

module.exports = {
  splitAndExtractPdf,
  extractPartyDetails,
  getMonYYYY
};
