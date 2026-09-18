const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { json, parseBody, requireGymKey, method, institutionFrom } = require('./http');
const dynamo = require('./dynamo');
const reports = require('./reports');
const { ensureRenewalPayLink, resumeDueDateHolds } = require('./members');

const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const REMINDER_DAYS = 2;

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function addDaysYmd(ymd, days) {
  const [year, month, day] = String(ymd || '').split('-').map(Number);
  if (!year || !month || !day) return '';
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function prettyDate(ymd) {
  const [year, month, day] = String(ymd || '').split('-').map(Number);
  if (!year || !month || !day) return ymd || '';
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function indiaPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (String(raw || '').startsWith('+') && digits.length >= 10) return `+${digits}`;
  return digits.length >= 10 ? `+91${digits.slice(-10)}` : '';
}

function isMemberRow(row) {
  const id = String(row?.cognitoId || '');
  if (!id || id.startsWith('__')) return false;
  if (['plan', 'device-bridge'].includes(String(row.userType || ''))) return false;
  return Boolean(row.phoneNumber || row.userName || row.memberId);
}

function firstName(row) {
  const name = String(row.firstName || row.userName || row.name || 'Member').trim();
  return name.split(/\s+/)[0] || 'Member';
}

function companyNameFrom(row) {
  const extra = row?.companyInfo && typeof row.companyInfo === 'object' ? row.companyInfo : {};
  return String(row?.companyName || extra.companyName || row?.legalName || extra.legalName || '').trim()
    || 'Tekkzy Fit';
}

function wantsReminderPayLink(row) {
  const sub = String(row.subscriptionStatus || '').toUpperCase();
  const method = String(row.paymentMethod || '').toUpperCase();
  if (sub === 'ACTIVE' || sub === 'PAUSED') return false;
  return sub === 'CANCELLED' || sub === 'OFFLINE' || sub === 'PENDING'
    || method === 'CASH' || method === 'UPI' || method === 'OFFLINE';
}

function expiryMessage(row, company, end, payUrl = '') {
  const brand = company || 'Tekkzy Fit';
  const plan = String(row.planName || 'membership').trim() || 'membership';
  const when = prettyDate(end);
  const sub = String(row.subscriptionStatus || row.paymentMethod || '').toUpperCase();
  const name = firstName(row);
  const open = `Dear ${name}, greetings from ${brand}. Your ${plan} membership expires on ${when}.`;
  const link = String(payUrl || '').trim();

  if (sub === 'ACTIVE') {
    return `${open} Please maintain sufficient balance in your bank account so the auto-payment is processed smoothly. Thank you, ${brand}.`;
  }
  if (sub === 'PAUSED') {
    return `${open} Please unpause your subscription at the earliest to continue training without interruption. Thank you, ${brand}.`;
  }
  if (sub === 'CANCELLED') {
    return link
      ? `${open} Pay now to continue: ${link} Thank you, ${brand}.`
      : `${open} Kindly complete payment in advance for a smooth continuation of your membership. Thank you, ${brand}.`;
  }
  if (sub === 'OFFLINE' || sub === 'CASH' || sub === 'UPI') {
    return link
      ? `${open} Pay now to renew: ${link} Or renew at the reception desk. Thank you, ${brand}.`
      : `${open} Please renew at the reception desk to continue uninterrupted access. Thank you, ${brand}.`;
  }
  return link
    ? `${open} Pay now: ${link} Thank you, ${brand}.`
    : `${open} Kindly complete payment at the earliest to continue your membership without interruption. Thank you, ${brand}.`;
}

function phoneTail(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-4) || 'none';
}

async function sendSms(phone, message) {
  const out = await sns.send(new PublishCommand({
    PhoneNumber: phone,
    Message: message,
    MessageAttributes: {
      'AWS.SNS.SMS.SMSType': {
        DataType: 'String',
        StringValue: 'Transactional',
      },
    },
  }));
  return out.MessageId || '';
}

async function runExpiryReminders(institution) {
  const gym = await dynamo.getCodegen(institution).catch(() => null);
  const gymName = companyNameFrom(gym);
  const target = addDaysYmd(istToday(), REMINDER_DAYS);
  const rows = (await dynamo.listProfiles(institution)).filter(isMemberRow);
  let sent = 0;
  let skipped = 0;
  let matched = 0;
  const errors = [];

  console.log('expiry reminders start', JSON.stringify({
    institution,
    gymName,
    target,
    members: rows.length,
  }));

  for (const row of rows) {
    const end = String(row.renewDate || row.deviceEnd || '').slice(0, 10);
    if (!end || end !== target) continue;
    matched += 1;
    if (row.expiryReminderOn === end) {
      skipped += 1;
      console.log('expiry reminder skip already sent', JSON.stringify({
        member: firstName(row),
        phone: phoneTail(row.phoneNumber || row.phone),
        end,
      }));
      continue;
    }
    const phone = indiaPhone(row.phoneNumber || row.phone);
    if (!phone) {
      skipped += 1;
      console.log('expiry reminder skip no phone', JSON.stringify({ member: firstName(row), end }));
      continue;
    }
    let current = row;
    let payUrl = '';
    if (wantsReminderPayLink(row)) {
      try {
        const ensured = await ensureRenewalPayLink(row);
        current = ensured.profile;
        payUrl = ensured.url || '';
        console.log('expiry reminder pay link', JSON.stringify({
          member: firstName(row),
          phone: phoneTail(phone),
          reused: Boolean(ensured.reused),
          hasLink: Boolean(payUrl),
        }));
      } catch (err) {
        console.error('expiry reminder pay link failed', JSON.stringify({
          member: firstName(row),
          phone: phoneTail(phone),
          detail: err instanceof Error ? err.message : 'link failed',
        }));
      }
    }
    const message = expiryMessage(current, gymName, end, payUrl);
    try {
      const messageId = await sendSms(phone, message);
      await dynamo.putProfile({
        ...current,
        expiryReminderOn: end,
        expiryReminderAt: new Date().toISOString(),
      });
      sent += 1;
      console.log('expiry reminder sent', JSON.stringify({
        member: firstName(row),
        phone: phoneTail(phone),
        end,
        messageId,
        hasLink: Boolean(payUrl),
      }));
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'SMS failed';
      errors.push({ member: firstName(row), phone: phoneTail(phone), detail });
      console.error('expiry reminder failed', JSON.stringify({
        member: firstName(row),
        phone: phoneTail(phone),
        detail,
      }));
    }
  }

  const summary = { ok: true, target, matched, sent, skipped, errors: errors.slice(0, 8), gymName };
  console.log('expiry reminders done', JSON.stringify(summary));
  return summary;
}

exports.runExpiryReminders = runExpiryReminders;
exports.expiryMessage = expiryMessage;

exports.daily = async () => {
  const institution = dynamo.fallbackInstitution();
  let report = null;
  let reportError = null;
  try {
    report = await reports.runDailyReport(institution);
  } catch (err) {
    reportError = err instanceof Error ? err.message : 'Report failed';
    console.error('daily report', err);
  }
  const reminders = await runExpiryReminders(institution);
  let billing = null;
  try {
    billing = { resumed: await resumeDueDateHolds(institution) };
  } catch (err) {
    console.error('resume due date holds', err);
    billing = { error: err instanceof Error ? err.message : 'resume failed' };
  }
  const result = { ok: true, report, reportError, reminders, billing };
  console.log('daily job done', JSON.stringify({
    reportOk: Boolean(report) && !reportError,
    reportError,
    reminders,
  }));
  return result;
};

exports.handler = async (event) => {
  if (method(event) === 'OPTIONS') return json(200, { ok: true });
  if (!requireGymKey(event)) return json(401, { error: 'Unauthorized' });
  try {
    if (method(event) !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = parseBody(event);
    const institution = institutionFrom(event, body);
    return json(200, await runExpiryReminders(institution));
  } catch (err) {
    console.error('reminders', err);
    return json(500, { error: err instanceof Error ? err.message : 'Server error' });
  }
};
