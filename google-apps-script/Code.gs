/**
 * EcoSwitch — Contact form backend (Google Apps Script).
 * Bind this script to the Google Sheet that should store messages
 * (Sheet → Extensions → Apps Script), then deploy as a Web App.
 */
const SHEET_NAME = 'Contact Submissions';
const NOTIFY_EMAIL = '';          // optional: e.g. 'you@example.com' to get an email per message
const THROTTLE_SECONDS = 30;      // minimum gap between messages from the same email
const HEADERS = ['Timestamp', 'Name', 'Email', 'Mobile', 'Message'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const p = (e && e.parameter) || {};

    // Honeypot: real users never fill this hidden field.
    if (p.website) return respond_({ ok: true });

    const name = clean_(p.name, 80);
    const email = clean_(p.email, 120);
    const mobile = clean_(p.mobile, 20);
    const message = clean_(p.message, 1000);

    if (name.length < 2) return respond_({ ok: false, error: 'Invalid name' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return respond_({ ok: false, error: 'Invalid email' });
    const digits = mobile.replace(/\D/g, '');
    if (!/^\+?[0-9\s\-().]+$/.test(mobile) || digits.length < 7 || digits.length > 15) {
      return respond_({ ok: false, error: 'Invalid mobile number' });
    }
    if (message.length < 10) return respond_({ ok: false, error: 'Message too short' });

    // Simple per-email throttle.
    const cache = CacheService.getScriptCache();
    const key = 'last_' + email.toLowerCase();
    if (cache.get(key)) return respond_({ ok: false, error: 'Please wait before sending another message' });

    lock.waitLock(10000);

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    // Plain-text format blocks formula injection (=, +, -, @) and keeps "+91…" intact.
    const row = sheet.getLastRow() + 1;
    sheet.getRange(row, 2, 1, 4).setNumberFormat('@');
    sheet.getRange(row, 1, 1, HEADERS.length).setValues([[new Date(), name, email, mobile, message]]);

    cache.put(key, '1', THROTTLE_SECONDS);

    if (NOTIFY_EMAIL) {
      MailApp.sendEmail({
        to: NOTIFY_EMAIL,
        replyTo: email,
        subject: 'EcoSwitch contact: ' + name,
        body: 'Name: ' + name + '\nEmail: ' + email + '\nMobile: ' + mobile + '\n\n' + message
      });
    }
    return respond_({ ok: true });
  } catch (err) {
    console.error(err);
    return respond_({ ok: false, error: 'Server error' });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// Visiting the /exec URL in a browser confirms the deployment is live.
function doGet() {
  return respond_({ ok: true, service: 'EcoSwitch contact endpoint' });
}

function clean_(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
