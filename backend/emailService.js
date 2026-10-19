const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { run, get, all } = require('./database');

class EmailService {
  constructor() {
    this.isDispatching = false;
    this.isPaused = false;
    this.stopRequested = false;
    this.sseClients = [];
    this.stats = {
      total: 0,
      processed: 0,
      sent: 0,
      failed: 0,
      currentFilename: '',
      currentTenant: '',
      status: 'idle'
    };
  }

  // Register SSE client for live progress stream
  addSseClient(res) {
    this.sseClients.push(res);
    this.broadcastState();
  }

  removeSseClient(res) {
    this.sseClients = this.sseClients.filter(c => c !== res);
  }

  broadcast(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.sseClients.forEach(client => {
      try {
        client.write(message);
      } catch (err) { }
    });
  }

  broadcastState() {
    this.broadcast('progress', this.stats);
  }

  // Synchronize settings directly in Oracle LEASED_SETTINGS_DTLS
  async syncSettings(updates = null) {
    if (updates && typeof updates === 'object') {
      if (updates.email_body_template) {
        updates.email_body_template = this.sanitizeBodyText(updates.email_body_template);
      }
      for (const [key, val] of Object.entries(updates)) {
        await run(`
          INSERT INTO settings (key, value) VALUES (?, ?)
        `, [key, String(val)]);
      }
      if (updates.email_subject || updates.email_body_template) {
        const sub = (updates.email_subject || 'Monthly Lease Rent Invoice - {{month}} (Unit: {{unit_number}})').trim();
        const body = (updates.email_body_template || '').trim();
        try {
          await run(`
            INSERT INTO email_templates (template_key, name, subject, body_html, is_default, updated_at)
            VALUES ('monthly_lease_invoice', 'Monthly Lease Rent Invoice', ?, ?, 1, CURRENT_TIMESTAMP)
          `, [sub, body]);
        } catch (e) {
          console.warn('[EmailService] Error updating DB email_templates:', e.message);
        }

        try {
          const { saveEmailTemplateToOracle } = require('./oracleSync');
          saveEmailTemplateToOracle({
            template_key: 'monthly_lease_invoice',
            name: 'Monthly Lease Rent Invoice',
            subject: sub,
            body_html: body,
            is_default: 1
          }).catch(e => console.warn('[EmailService] Notice saving Oracle EMAIL_TEMPLATES:', e.message));
        } catch (e) { }
      }
    }

    const rows = await all('SELECT key, value FROM settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });

    // Push to Oracle LEASED_SETTINGS_DTLS in background (non-blocking)
    try {
      const { syncSettingsToOracle } = require('./oracleSync');
      syncSettingsToOracle(settings).then(res => {
        if (res && res.success) {
          console.log('[EmailService] 🌐 Synced updated settings to Oracle LEASED_SETTINGS_DTLS successfully.');
        }
      }).catch(err => {
        console.warn('[EmailService] Notice syncing to Oracle:', err.message);
      });
    } catch (oracleErr) {
      console.warn('[EmailService] Oracle sync helper error:', oracleErr.message);
    }

    console.log('[EmailService] Settings synced directly to database:', Object.keys(settings).length, 'keys');
    return settings;
  }

  // Always fetch live settings directly from the database without any stale cache
  async getSettings() {
    const rows = await all('SELECT key, value FROM settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    return settings;
  }

  // Build SMTP transporter based on DB settings
  async createTransporter() {
    const settings = await this.getSettings();

    const isSimulation = settings.simulation_mode === 'true';

    if (isSimulation) {
      return {
        isSimulation: true,
        settings,
        sendMail: async (options) => {
          return new Promise(resolve => setTimeout(() => resolve({ messageId: 'sim-' + Date.now() }), 80));
        }
      };
    }

    const port = parseInt(settings.smtp_port || '587', 10);
    const isSecure = settings.smtp_secure === 'true' || port === 465;

    const transporter = nodemailer.createTransport({
      host: settings.smtp_host || 'smtp.gmail.com',
      port: port,
      secure: isSecure,
      auth: {
        user: settings.smtp_user,
        pass: settings.smtp_pass
      },
      tls: {
        rejectUnauthorized: false
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000
    });

    return {
      isSimulation: false,
      settings,
      transporter
    };
  }

  interpolate(template, vars) {
    let result = template || '';
    for (const [key, val] of Object.entries(vars)) {
      const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
      result = result.replace(regex, val !== undefined && val !== null ? val : '');
    }
    return result;
  }

  // Convert HTML body to clean plain-text alternative (crucial for anti-spam filters)
  stripHtmlToText(html) {
    if (!html) return '';
    return html
      .replace(/<br\s*[\/]?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<td[^>]*>/gi, '  ')
      .replace(/<[^>]+>/gi, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();
  }

  // Remove literal '/n' and '\n' and stray newline characters from email body
  sanitizeBodyText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .replace(/\\+n/gi, '')
      .replace(/\/n/gi, '')
      .replace(/\\+r/gi, '')
      .replace(/\/r/gi, '')
      .replace(/>\s*[\r\n]+\s*</g, '><')
      .replace(/[\r\n]+/g, ' ')
      .trim();
  }

  // Wrap raw HTML body in an RFC/CSS-compliant email envelope
  formatHtmlEmail(rawBody, title) {
    if (!rawBody) return '';
    const cleanBody = this.sanitizeBodyText(rawBody);
    if (cleanBody.includes('<html') || cleanBody.includes('<!DOCTYPE')) {
      return cleanBody;
    }
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${title || 'Monthly Lease Rent Invoice'}</title>
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; color: #334155; }
    .email-wrapper { width: 100%; background-color: #f1f5f9; padding: 25px 0; }
    .email-container { max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
    .email-header { background: #1e293b; color: #ffffff; padding: 18px 24px; }
    .email-header h2 { margin: 0; font-size: 18px; font-weight: 600; }
    .email-body { padding: 24px; font-size: 15px; line-height: 1.6; }
    .email-footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 24px; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <div class="email-container">
      <div class="email-header">
        <h2>Monthly Lease Rent Invoice</h2>
      </div>
      <div class="email-body">
        ${cleanBody}
      </div>
      <div class="email-footer">
        This is an official invoice notification. Please keep this email and attached documents for your records.
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  resolveAttachmentPath(r, configuredBasePath = null) {
    // 1. Direct file_path from DB if it exists on disk
    if (r.file_path && fs.existsSync(r.file_path)) {
      return r.file_path;
    }

    const baseDir = configuredBasePath || process.env.ESTATE_BILLS_DIR || 'D:\\estate_bills';
    const filename = r.original_name || r.filename || (r.party_code ? `${r.party_code}.pdf` : '');

    if (!filename) return r.file_path;

    // 2. Direct inside baseDir (e.g. D:\estate_bills\9594.pdf)
    const directPath = path.join(baseDir, filename);
    if (fs.existsSync(directPath)) {
      return directPath;
    }

    // 3. In any subfolder inside baseDir (e.g. D:\estate_bills\Aug-2026\9594.pdf)
    if (fs.existsSync(baseDir)) {
      try {
        const entries = fs.readdirSync(baseDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subPath = path.join(baseDir, entry.name, filename);
            if (fs.existsSync(subPath)) {
              return subPath;
            }
          }
        }
      } catch (e) { }
    }

    // 4. Fallback to local uploads directory
    const local = path.join(__dirname, '..', 'uploads', 'receipts', filename);
    if (fs.existsSync(local)) {
      return local;
    }

    return r.file_path;
  }

  /**
   * Group receipts by tenant/email so multiple receipts (Main Rent + Recoverable)
   * are clubbed into ONE email with multiple attachments!
   */
  groupReceiptsForDispatch(receiptRows, configuredBasePath = null) {
    const map = new Map();

    for (const r of receiptRows) {
      const groupKey = r.tenant_id ? `tenant_${r.tenant_id}` : `email_${r.tenant_email || r.party_code}`;
      if (!map.has(groupKey)) {
        map.set(groupKey, {
          tenantId: r.tenant_id,
          tenantName: r.tenant_name,
          tenantEmail: r.tenant_email,
          tenantUnit: r.tenant_unit || r.extracted_unit,
          receipts: [],
          totalAmount: 0,
          attachments: []
        });
      }

      const group = map.get(groupKey);
      group.receipts.push(r);
      group.totalAmount += (parseFloat(r.extracted_amount) || 0);

      const resolvedFilePath = this.resolveAttachmentPath(r, configuredBasePath);

      group.attachments.push({
        filename: r.original_name,
        path: resolvedFilePath
      });
    }

    return Array.from(map.values());
  }

  // Start bulk dispatch campaign (clubbed by party/tenant)
  async startDispatch({ receiptIds = null, onlyPending = true, customSubject = null, customBody = null, saveAsDefault = false } = {}) {
    if (this.isDispatching) {
      throw new Error('A dispatch campaign is already running.');
    }

    if (saveAsDefault) {
      if (customSubject) {
        await run(`INSERT INTO settings (key, value) VALUES ('email_subject', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [customSubject]);
      }
      if (customBody) {
        await run(`INSERT INTO settings (key, value) VALUES ('email_body_template', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [customBody]);
      }
    }

    this.isDispatching = true;
    this.isPaused = false;
    this.stopRequested = false;

    let query = `
      SELECT r.*, t.name as tenant_name, t.email as tenant_email, t.unit_number as tenant_unit, t.rent_amount as tenant_rent
      FROM receipts r
      JOIN tenants t ON r.tenant_id = t.id
      WHERE 1=1
    `;
    const params = [];

    if (receiptIds && receiptIds.length > 0) {
      query += ` AND r.id IN (${receiptIds.map(() => '?').join(',')})`;
      params.push(...receiptIds);
    } else if (onlyPending) {
      query += ` AND (r.email_status = 'pending' OR r.email_status = 'failed') AND r.match_confidence = 100`;
    }

    query += ` ORDER BY r.party_code ASC, r.id ASC`;

    const rawReceipts = await all(query, params);

    const rows = await all('SELECT key, value FROM settings');
    const settingsMap = {};
    rows.forEach(r => { settingsMap[r.key] = r.value; });
    const bulkMailPath = settingsMap.bulk_mail_path || process.env.ESTATE_BILLS_DIR || 'D:\\estate_bills';

    const groups = this.groupReceiptsForDispatch(rawReceipts, bulkMailPath);

    this.stats = {
      total: groups.length, // Total distinct tenant emails to send
      processed: 0,
      sent: 0,
      failed: 0,
      currentFilename: '',
      currentTenant: '',
      status: groups.length > 0 ? 'running' : 'completed'
    };
    this.broadcastState();

    if (groups.length === 0) {
      this.isDispatching = false;
      return { message: 'No matched pending receipts to dispatch.' };
    }

    this.runQueue(groups, { customSubject, customBody }).catch(err => {
      console.error('Dispatch queue error:', err);
      this.isDispatching = false;
      this.stats.status = 'error';
      this.broadcastState();
    });

    return {
      message: `Started dispatch for ${groups.length} tenant recipients (${rawReceipts.length} total clubbed documents).`
    };
  }

  async runQueue(groups, { customSubject = null, customBody = null } = {}) {
    const { isSimulation, settings, transporter, sendMail } = await this.createTransporter();
    const delayMs = parseInt(settings.rate_limit_delay_ms || '600', 10);

    let subjectTemplate = customSubject;
    let bodyTemplate = customBody;

    if (!subjectTemplate || !bodyTemplate) {
      try {
        const activeTpl = await get('SELECT subject, body_html FROM email_templates WHERE is_default = 1 ORDER BY id DESC LIMIT 1');
        if (activeTpl) {
          if (!subjectTemplate && activeTpl.subject) subjectTemplate = activeTpl.subject;
          if (!bodyTemplate && activeTpl.body_html) bodyTemplate = activeTpl.body_html;
        }
      } catch (e) { }
    }

    subjectTemplate = subjectTemplate || settings.email_subject || 'Monthly Lease Rent Invoice - {{month}} (Unit: {{unit_number}})';
    bodyTemplate = bodyTemplate || settings.email_body_template || '<p>Attached is your monthly lease rent invoice.</p>';
    const fromName = settings.smtp_from_name || 'Lease Billing Application';
    const fromEmail = settings.smtp_from_email || settings.smtp_user || 'noreply@leasebilling.com';

    for (let i = 0; i < groups.length; i++) {
      if (this.stopRequested) {
        this.stats.status = 'stopped';
        break;
      }

      while (this.isPaused) {
        this.stats.status = 'paused';
        this.broadcastState();
        await new Promise(r => setTimeout(r, 1000));
      }

      const grp = groups[i];
      const docCount = grp.receipts.length;
      const docNames = grp.receipts.map(r => r.original_name).join(', ');

      this.stats.currentFilename = `${docCount} document(s): ${docNames}`;
      this.stats.currentTenant = grp.tenantName;
      this.stats.status = 'running';
      this.broadcastState();

      const templateVars = {
        tenant_name: grp.tenantName,
        unit_number: (grp.tenantUnit && grp.tenantUnit !== 'N/A' && grp.tenantUnit !== 'Amount') ? grp.tenantUnit : 'N/A',
        month: grp.receipts[0]?.extracted_month || new Date().toLocaleString('default', { month: 'long', year: 'numeric' }),
        amount: grp.totalAmount > 0 ? grp.totalAmount.toFixed(2) : '0.00',
        date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
        document_count: String(docCount)
      };

      let subject = this.interpolate(subjectTemplate, templateVars);
      // Clean up empty or N/A unit tags from subject e.g. " (Unit: )" or " (Unit: N/A)" or " (Unit: Amount)"
      subject = subject.replace(/\s*\(\s*Unit:\s*(?:N\/A|Amount)?\s*\)/gi, '').trim();
      const htmlBody = this.interpolate(bodyTemplate, templateVars);
      const textBody = this.stripHtmlToText(htmlBody);
      const fullHtml = this.formatHtmlEmail(htmlBody, subject);

      const mailOptions = {
        from: `"${fromName}" <${fromEmail}>`,
        replyTo: fromEmail,
        to: grp.tenantEmail,
        subject: subject,
        text: textBody,
        html: fullHtml,
        attachments: grp.attachments,
        headers: {
          'X-Priority': '3',
          'Importance': 'Normal'
        }
      };

      const receiptIds = grp.receipts.map(r => r.id);
      const placeholders = receiptIds.map(() => '?').join(',');

      // If tenant has no valid email, fail gracefully without crashing transporter
      if (!grp.tenantEmail || !grp.tenantEmail.includes('@')) {
        const missingEmailMsg = 'Tenant has no email address configured in Oracle / Directory';
        await run(`
          UPDATE receipts 
          SET email_status = 'failed', error_message = ? 
          WHERE id IN (${placeholders})
        `, [missingEmailMsg, ...receiptIds]);

        for (const r of grp.receipts) {
          await run(`
            INSERT INTO email_logs (receipt_id, tenant_id, recipient_email, subject, status, error_message)
            VALUES (?, ?, ?, ?, 'failed', ?)
          `, [r.id, grp.tenantId, 'No Email', subject, missingEmailMsg]);
        }

        this.stats.failed++;
        this.broadcast('log', {
          type: 'error',
          tenant: grp.tenantName,
          email: 'No Email',
          file: `${docCount} Documents (${docNames})`,
          error: missingEmailMsg,
          time: new Date().toLocaleTimeString()
        });
        continue;
      }

      try {
        if (isSimulation) {
          await sendMail(mailOptions);
        } else {
          await transporter.sendMail(mailOptions);
        }

        // Mark all clubbed receipts in this group as sent!
        await run(`
          UPDATE receipts 
          SET email_status = 'sent', sent_at = CURRENT_TIMESTAMP, error_message = NULL 
          WHERE id IN (${placeholders})
        `, receiptIds);

        for (const r of grp.receipts) {
          await run(`
            INSERT INTO email_logs (receipt_id, tenant_id, recipient_email, subject, status, error_message)
            VALUES (?, ?, ?, ?, 'success', NULL)
          `, [r.id, grp.tenantId, grp.tenantEmail, subject]);
        }

        this.stats.sent++;
        this.broadcast('log', {
          type: 'success',
          tenant: grp.tenantName,
          email: grp.tenantEmail,
          file: `${docCount} Documents (${docNames})`,
          time: new Date().toLocaleTimeString()
        });

      } catch (err) {
        console.error(`Failed to send to ${grp.tenantEmail}:`, err.message);

        await run(`
          UPDATE receipts 
          SET email_status = 'failed', error_message = ? 
          WHERE id IN (${placeholders})
        `, [err.message, ...receiptIds]);

        for (const r of grp.receipts) {
          await run(`
            INSERT INTO email_logs (receipt_id, tenant_id, recipient_email, subject, status, error_message)
            VALUES (?, ?, ?, ?, 'failed', ?)
          `, [r.id, grp.tenantId, grp.tenantEmail, subject, err.message]);
        }

        this.stats.failed++;
        this.broadcast('log', {
          type: 'error',
          tenant: grp.tenantName,
          email: grp.tenantEmail,
          file: `${docCount} Documents (${docNames})`,
          error: err.message,
          time: new Date().toLocaleTimeString()
        });
      }

      this.stats.processed++;
      this.broadcastState();

      if (delayMs > 0 && i < groups.length - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    this.isDispatching = false;
    this.stats.status = this.stopRequested ? 'stopped' : 'completed';
    this.broadcastState();
  }

  // Get live interpolated email preview for a group of receipts
  async getEmailPreview({ receiptIds }) {
    if (!receiptIds || receiptIds.length === 0) {
      throw new Error('No receipt IDs provided.');
    }

    const placeholders = receiptIds.map(() => '?').join(',');
    const rawReceipts = await all(`
      SELECT r.*, t.name as tenant_name, t.email as tenant_email, t.unit_number as tenant_unit, t.rent_amount as tenant_rent
      FROM receipts r
      JOIN tenants t ON r.tenant_id = t.id
      WHERE r.id IN (${placeholders})
    `, receiptIds);

    if (rawReceipts.length === 0) {
      throw new Error('These receipts must be linked to a tenant with an email address before previewing.');
    }

    const rows = await all('SELECT key, value FROM settings');
    const settingsMap = {};
    rows.forEach(r => { settingsMap[r.key] = r.value; });
    const bulkMailPath = settingsMap.bulk_mail_path || process.env.ESTATE_BILLS_DIR || 'D:\\estate_bills';

    const grp = this.groupReceiptsForDispatch(rawReceipts, bulkMailPath)[0];
    const docCount = grp.receipts.length;

    const templateVars = {
      tenant_name: grp.tenantName,
      unit_number: (grp.tenantUnit && grp.tenantUnit !== 'N/A' && grp.tenantUnit !== 'Amount') ? grp.tenantUnit : 'N/A',
      month: grp.receipts[0]?.extracted_month || new Date().toLocaleString('default', { month: 'long', year: 'numeric' }),
      amount: grp.totalAmount > 0 ? grp.totalAmount.toFixed(2) : '0.00',
      date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
      document_count: String(docCount)
    };

    let rawTplSub = settingsMap.email_subject || 'Monthly Lease Rent Invoice - {{month}} (Unit: {{unit_number}})';
    let rawTplBody = settingsMap.email_body_template || '<p>Attached is your monthly lease rent invoice.</p>';
    try {
      const { fetchActiveTemplateFromOracle } = require('./oracleSync');
      const activeTpl = await fetchActiveTemplateFromOracle();
      if (activeTpl) {
        if (activeTpl.subject) rawTplSub = activeTpl.subject;
        if (activeTpl.body_html) rawTplBody = activeTpl.body_html;
      }
    } catch (e) { }

    let subject = this.interpolate(rawTplSub, templateVars);
    subject = subject.replace(/\s*\(\s*Unit:\s*(?:N\/A|Amount)?\s*\)/gi, '').trim();
    const htmlBody = this.interpolate(rawTplBody, templateVars);

    return {
      tenantId: grp.tenantId,
      tenantName: grp.tenantName,
      tenantEmail: grp.tenantEmail,
      tenantUnit: grp.tenantUnit,
      totalAmount: grp.totalAmount,
      subject,
      body: htmlBody,
      rawTemplateSubject: rawTplSub,
      rawTemplateBody: rawTplBody,
      attachments: grp.receipts.map(r => ({ id: r.id, name: r.original_name }))
    };
  }

  // Send email for a single party group (called from the "Send Both PDFs" button or custom edit modal)
  async sendSingleGroup({ receiptIds, customSubject = null, customBody = null, customRecipientEmail = null, saveAsDefault = false } = {}) {
    if (!receiptIds || receiptIds.length === 0) {
      throw new Error('No receipt IDs provided.');
    }

    if (saveAsDefault && (customSubject || customBody)) {
      try {
        const { saveEmailTemplateToOracle } = require('./oracleSync');
        await saveEmailTemplateToOracle({
          template_key: 'monthly_lease_invoice',
          name: 'Monthly Lease Rent Invoice',
          subject: customSubject || 'Monthly Lease Rent Invoice - {{month}} (Unit: {{unit_number}})',
          body_html: customBody || '<p>Attached is your monthly lease rent invoice.</p>',
          is_default: 1
        });
      } catch (e) { }
      await this.syncSettings({
        email_subject: customSubject,
        email_body_template: customBody
      });
    }

    const placeholders = receiptIds.map(() => '?').join(',');
    const rawReceipts = await all(`
      SELECT r.*, t.name as tenant_name, t.email as tenant_email, t.unit_number as tenant_unit, t.rent_amount as tenant_rent
      FROM receipts r
      JOIN tenants t ON r.tenant_id = t.id
      WHERE r.id IN (${placeholders})
    `, receiptIds);

    if (rawReceipts.length === 0) {
      throw new Error('These receipts must be linked to a tenant with an email address before sending.');
    }

    const rows = await all('SELECT key, value FROM settings');
    const settingsMap = {};
    rows.forEach(r => { settingsMap[r.key] = r.value; });
    const bulkMailPath = settingsMap.bulk_mail_path || process.env.ESTATE_BILLS_DIR || 'D:\\estate_bills';

    const grp = this.groupReceiptsForDispatch(rawReceipts, bulkMailPath)[0];
    const { isSimulation, settings, transporter, sendMail } = await this.createTransporter();

    const fromName = settings.smtp_from_name || 'Lease Billing Application';
    const fromEmail = settings.smtp_from_email || settings.smtp_user || 'noreply@leasebilling.com';
    const toEmail = (customRecipientEmail && customRecipientEmail.trim()) || grp.tenantEmail;
    const docCount = grp.receipts.length;
    const docNames = grp.receipts.map(r => r.original_name).join(', ');

    const templateVars = {
      tenant_name: grp.tenantName,
      unit_number: (grp.tenantUnit && grp.tenantUnit !== 'N/A' && grp.tenantUnit !== 'Amount') ? grp.tenantUnit : 'N/A',
      month: grp.receipts[0]?.extracted_month || new Date().toLocaleString('default', { month: 'long', year: 'numeric' }),
      amount: grp.totalAmount > 0 ? grp.totalAmount.toFixed(2) : '0.00',
      date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
      document_count: String(docCount)
    };

    let tplSub = customSubject;
    let tplBody = customBody;
    if (!tplSub || !tplBody) {
      try {
        const activeTpl = await get('SELECT subject, body_html FROM email_templates WHERE is_default = 1 ORDER BY id DESC LIMIT 1');
        if (activeTpl) {
          if (!tplSub && activeTpl.subject) tplSub = activeTpl.subject;
          if (!tplBody && activeTpl.body_html) tplBody = activeTpl.body_html;
        }
      } catch (e) { }
    }
    tplSub = tplSub || settings.email_subject || 'Monthly Lease Rent Invoice - {{month}} (Unit: {{unit_number}})';
    tplBody = tplBody || settings.email_body_template || '<p>Attached is your monthly lease rent invoice.</p>';

    let subject = this.interpolate(tplSub, templateVars);
    subject = subject.replace(/\s*\(\s*Unit:\s*(?:N\/A|Amount)?\s*\)/gi, '').trim();

    const htmlBody = this.interpolate(tplBody, templateVars);
    const textBody = this.stripHtmlToText(htmlBody);
    const fullHtml = this.formatHtmlEmail(htmlBody, subject);

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      replyTo: fromEmail,
      to: toEmail,
      subject,
      text: textBody,
      html: fullHtml,
      attachments: grp.attachments,
      headers: {
        'X-Priority': '3',
        'Importance': 'Normal'
      }
    };

    try {
      if (isSimulation) {
        await sendMail(mailOptions);
      } else {
        await transporter.sendMail(mailOptions);
      }

      await run(`
        UPDATE receipts 
        SET email_status = 'sent', sent_at = CURRENT_TIMESTAMP, error_message = NULL 
        WHERE id IN (${placeholders})
      `, receiptIds);

      for (const r of grp.receipts) {
        await run(`
          INSERT INTO email_logs (receipt_id, tenant_id, recipient_email, subject, status, error_message)
          VALUES (?, ?, ?, ?, 'success', NULL)
        `, [r.id, grp.tenantId, grp.tenantEmail, subject]);
      }

      this.broadcast('log', {
        type: 'success',
        tenant: grp.tenantName,
        email: grp.tenantEmail,
        file: `${docCount} Documents (${docNames})`,
        time: new Date().toLocaleTimeString()
      });

      return {
        success: true,
        message: `Sent 1 email with ${docCount} attached document(s) to ${grp.tenantName} (${grp.tenantEmail})!`
      };
    } catch (err) {
      console.error(`Failed to send to ${grp.tenantEmail}:`, err.message);

      await run(`
        UPDATE receipts 
        SET email_status = 'failed', error_message = ? 
        WHERE id IN (${placeholders})
      `, [err.message, ...receiptIds]);

      for (const r of grp.receipts) {
        await run(`
          INSERT INTO email_logs (receipt_id, tenant_id, recipient_email, subject, status, error_message)
          VALUES (?, ?, ?, ?, 'failed', ?)
        `, [r.id, grp.tenantId, grp.tenantEmail, subject, err.message]);
      }

      this.broadcast('log', {
        type: 'error',
        tenant: grp.tenantName,
        email: grp.tenantEmail,
        file: `${docCount} Documents (${docNames})`,
        error: err.message,
        time: new Date().toLocaleTimeString()
      });

      throw err;
    }
  }

  pause() {
    if (this.isDispatching) this.isPaused = true;
  }

  resume() {
    if (this.isDispatching) this.isPaused = false;
  }

  stop() {
    this.stopRequested = true;
    this.isPaused = false;
  }
}

module.exports = new EmailService();
