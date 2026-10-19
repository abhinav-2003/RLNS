const PDFParser = require('pdf2json');
const { extractPartyDetails } = require('../split_pdf_by_page');

/**
 * Extract text using robust pdf2json
 */
function extractTextFromPdf(filePath) {
  return new Promise((resolve) => {
    const parser = new PDFParser();
    parser.on('pdfParser_dataError', () => resolve(''));
    parser.on('pdfParser_dataReady', (pdfData) => {
      let fullText = '';
      if (pdfData && pdfData.Pages) {
        pdfData.Pages.forEach(page => {
          if (page.Texts) {
            page.Texts.forEach(t => {
              if (t.R) {
                t.R.forEach(r => {
                  try {
                    fullText += decodeURIComponent(r.T) + ' ';
                  } catch (e) {
                    fullText += r.T + ' ';
                  }
                });
              }
            });
          }
        });
      }
      resolve(fullText.trim());
    });
    try {
      parser.loadPDF(filePath);
    } catch (e) {
      resolve('');
    }
  });
}

/**
 * Extract metadata from PDF text and filename
 */
async function extractPdfMetadata(filePath, originalFilename) {
  const text = await extractTextFromPdf(filePath);
  const details = extractPartyDetails(`${originalFilename}\n${text}`);

  // Month pattern
  let extractedMonth = null;
  const monthMatch = `${originalFilename} ${text}`.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s*(\d{4})?/i);
  if (monthMatch) extractedMonth = monthMatch[0];

  // Email pattern
  let extractedEmail = null;
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) extractedEmail = emailMatch[0].toLowerCase();

  return {
    rawText: text.substring(0, 2000),
    partyCode: details.partyCode !== 'UNKNOWN_PARTY' ? details.partyCode : null,
    extractedUnit: details.unitNumber || null,
    extractedName: details.partyName || null,
    extractedAmount: details.amount || null,
    extractedMonth,
    extractedEmail
  };
}

module.exports = {
  extractPdfMetadata
};
