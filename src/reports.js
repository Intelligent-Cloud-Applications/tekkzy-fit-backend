const { json, parseBody, requireGymKey, method, institutionFrom } = require('./http');
const dynamo = require('./dynamo');

function monthKey(date = new Date()) {
  return date.toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).replace(' ', '-');
}

function monthRange(key) {
  const parsed = new Date(`${String(key || '').replace('-', ' ')} 1`);
  if (Number.isNaN(parsed.getTime())) {
    const now = new Date();
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
    };
  }
  return {
    start: new Date(parsed.getFullYear(), parsed.getMonth(), 1),
    end: new Date(parsed.getFullYear(), parsed.getMonth() + 1, 1),
  };
}

function punchKey(row) {
  const raw = String(row.memberCode || row.memberId || row.id || '').replace(/\D/g, '');
  const enroll = raw ? String(Number(raw)) : String(row.id || '');
  return `${enroll}|${String(row.timestamp || '')}`;
}

function compactPunch(row) {
  return {
    id: String(row.id || ''),
    memberId: String(row.memberId || ''),
    memberName: String(row.memberName || ''),
    memberCode: String(row.memberCode || ''),
    timestamp: String(row.timestamp || ''),
    type: String(row.type || 'ENTRY'),
    status: String(row.status || 'GRANTED'),
    reason: String(row.reason || ''),
    deviceName: String(row.deviceName || ''),
    deletedAt: row.deletedAt || new Date().toISOString(),
  };
}

function mergeDeleted(existing, body) {
  const rows = Array.isArray(existing?.deletedAttendance) ? [...existing.deletedAttendance] : [];
  const incoming = [];
  if (body.archiveAttendance) incoming.push(body.archiveAttendance);
  if (Array.isArray(body.deletedAttendance)) incoming.push(...body.deletedAttendance);
  let addedGranted = 0;
  for (const row of incoming) {
    if (!row) continue;
    const key = punchKey(row);
    if (rows.some((item) => punchKey(item) === key)) continue;
    rows.push(compactPunch(row));
    if (String(row.status || 'GRANTED').toUpperCase() === 'GRANTED') addedGranted += 1;
  }
  return { deletedAttendance: rows.slice(-2000), addedGranted };
}

function compactReimbursement(row) {
  return {
    id: String(row?.id || ''),
    date: String(row?.date || '').slice(0, 10),
    amount: Number(row?.amount || 0),
    paidTo: String(row?.paidTo || '').trim(),
    reason: String(row?.reason || '').trim(),
    method: String(row?.method || 'CASH').toUpperCase() === 'ONLINE' ? 'ONLINE' : 'CASH',
    createdAt: String(row?.createdAt || new Date().toISOString()),
  };
}

function mergeReimbursements(existing, body) {
  let rows = Array.isArray(existing?.reimbursements) ? [...existing.reimbursements] : [];
  if (Array.isArray(body.reimbursements)) {
    rows = body.reimbursements.map(compactReimbursement).filter((row) => row.id && row.amount > 0);
  }
  if (body.addReimbursement) {
    const next = compactReimbursement(body.addReimbursement);
    if (next.id && next.amount > 0 && !rows.some((row) => row.id === next.id)) {
      rows.push(next);
    }
  }
  if (body.removeReimbursementId) {
    rows = rows.filter((row) => row.id !== String(body.removeReimbursementId));
  }
  return rows.slice(-500);
}

function toRow(item) {
  return {
    month: item.month || item.monthAndYear || item.cognitoIdAndMonth,
    totalAttendance: Number(item.totalAttendance || 0),
    totalMembers: Number(item.totalMembers || 0),
    cashPayment: Number(item.cashPayment || item.incomes?.cash || 0),
    upiPayment: Number(item.upiPayment || item.incomes?.upi || 0),
    razorpayPayment: Number(item.razorpayPayment || item.incomes?.razorpay || 0),
    totalDiscontinued: Number(item.totalDiscontinued || 0),
    deletedAttendance: Array.isArray(item.deletedAttendance) ? item.deletedAttendance : [],
    reimbursements: Array.isArray(item.reimbursements) ? item.reimbursements : [],
    updatedAt: item.updatedAt || '',
  };
}

function isPaid(row) {
  return String(row.paymentStatus || row.status || '').toUpperCase() === 'PAID';
}

function paidAmount(row) {
  const mode = String(row.paymentMode || row.method || '').toUpperCase();
  if (mode === 'CASH' || mode === 'UPI') return Number(row.amount || row.netAmount || 0);
  return Number(row.netAmount != null ? row.netAmount : row.amount || 0);
}

function paymentInMonth(row, start, end) {
  const raw = Number(row.paymentDate || row.paidAt || row.updatedAt || 0);
  const day = raw > 1e12 || raw > 1e10
    ? new Date(raw)
    : /^\d{4}-\d{2}-\d{2}/.test(String(row.date || ''))
      ? new Date(`${String(row.date).slice(0, 10)}T00:00:00`)
      : new Date(raw);
  return day >= start && day < end;
}

function isDiscontinued(profile) {
  const status = String(profile.status || profile.membershipStatus || '').toUpperCase();
  const pay = String(profile.paymentStatus || '').toUpperCase();
  const sub = String(profile.subscriptionStatus || '').toUpperCase();
  const end = String(profile.renewDate || profile.rePaymentDate || profile.deviceEnd || '').slice(0, 10);
  const todayIst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const expired = Boolean(end && end < todayIst);
  if (['EXPIRED', 'CANCELLED', 'INACTIVE', 'DELETED'].includes(status)) return true;
  if (['CANCELLED', 'EXPIRED', 'HALTED'].includes(sub)) return true;
  if (pay === 'PENDING' || pay === 'FAILED') return true;
  if (expired && pay !== 'PAID') return true;
  if (expired) return true;
  return false;
}

function fromBody(institution, body, existing) {
  const month = String(body.month || existing?.cognitoIdAndMonth || monthKey()).trim();
  const merged = mergeDeleted(existing, body);
  const stored = body.totalAttendance != null
    ? Number(body.totalAttendance)
    : Number(existing?.totalAttendance ?? 0) + merged.addedGranted;
  return {
    ...(existing || {}),
    institution,
    cognitoIdAndMonth: month,
    month,
    monthAndYear: month,
    type: 'gym',
    totalAttendance: stored,
    totalMembers: Number(body.totalMembers ?? existing?.totalMembers ?? 0),
    cashPayment: Number(body.cashPayment ?? existing?.cashPayment ?? 0),
    upiPayment: Number(body.upiPayment ?? existing?.upiPayment ?? 0),
    razorpayPayment: Number(body.razorpayPayment ?? existing?.razorpayPayment ?? 0),
    totalDiscontinued: Number(body.totalDiscontinued ?? existing?.totalDiscontinued ?? 0),
    deletedAttendance: merged.deletedAttendance,
    reimbursements: mergeReimbursements(existing, body),
    incomes: {
      ...(existing?.incomes || {}),
      cash: Number(body.cashPayment ?? existing?.cashPayment ?? 0),
      upi: Number(body.upiPayment ?? existing?.upiPayment ?? 0),
      razorpay: Number(body.razorpayPayment ?? existing?.razorpayPayment ?? 0),
    },
    updatedAt: new Date().toISOString(),
  };
}

async function computeCloudSnapshot(institution, month, extras = {}) {
  const { start, end } = monthRange(month);
  const [members, payments] = await Promise.all([
    dynamo.listProfiles(institution),
    dynamo.listPayments(institution),
  ]);
  const monthPays = payments.filter((row) => isPaid(row) && paymentInMonth(row, start, end));
  const cashPayment = monthPays
    .filter((row) => String(row.paymentMode || row.method || '').toUpperCase() === 'CASH')
    .reduce((sum, row) => sum + paidAmount(row), 0);
  const upiPayment = monthPays
    .filter((row) => String(row.paymentMode || row.method || '').toUpperCase() === 'UPI')
    .reduce((sum, row) => sum + paidAmount(row), 0);
  const razorpayPayment = monthPays
    .filter((row) => !['CASH', 'UPI'].includes(String(row.paymentMode || row.method || '').toUpperCase()))
    .reduce((sum, row) => sum + paidAmount(row), 0);
  return {
    month,
    totalAttendance: extras.totalAttendance != null ? Number(extras.totalAttendance) : undefined,
    totalMembers: members.length,
    cashPayment,
    upiPayment,
    razorpayPayment,
    totalDiscontinued: members.filter(isDiscontinued).length,
  };
}

async function saveSnapshot(institution, body) {
  const month = String(body.month || monthKey()).trim();
  const existing = await dynamo.getReport(institution, month);
  const computed = await computeCloudSnapshot(institution, month, body);
  const saved = await dynamo.putReport(fromBody(institution, { ...computed, ...body, month }, existing));
  return toRow(saved);
}

exports.computeCloudSnapshot = computeCloudSnapshot;
exports.saveSnapshot = saveSnapshot;
exports.monthKey = monthKey;

exports.handler = async (event) => {
  if (method(event) === 'OPTIONS') return json(200, { ok: true });
  if (!requireGymKey(event)) return json(401, { error: 'Unauthorized' });

  try {
    const verb = method(event);
    const body = verb === 'GET' ? {} : parseBody(event);
    const institution = institutionFrom(event, body);

    if (verb === 'GET') {
      const rows = (await dynamo.listReports(institution))
        .map(toRow)
        .sort((a, b) => String(b.updatedAt || b.month).localeCompare(String(a.updatedAt || a.month)));
      return json(200, rows);
    }

    if (verb === 'POST' || verb === 'PUT') {
      return json(200, await saveSnapshot(institution, body));
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('reports', err);
    return json(500, { error: err instanceof Error ? err.message : 'Server error' });
  }
};

async function runDailyReport(institution = dynamo.fallbackInstitution()) {
  const month = monthKey();
  const existing = await dynamo.getReport(institution, month);
  const saved = await saveSnapshot(institution, {
    month,
    totalAttendance: existing?.totalAttendance,
  });
  return { ok: true, month, ...saved };
}

exports.runDailyReport = runDailyReport;
exports.daily = async () => runDailyReport();
