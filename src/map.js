const { fallbackInstitution } = require('./dynamo');

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newOfflineId() {
  return `off_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function isCashItem(item) {
  const mode = String(item.paymentMode || item.method || '').toUpperCase();
  return mode === 'CASH' || mode === 'UPI';
}

function publicMethod(item) {
  const mode = String(item.paymentMode || item.method || 'RAZORPAY').toUpperCase();
  if (mode === 'CASH' || mode === 'UPI') return mode;
  return 'RAZORPAY';
}

function publicPayUrl(url) {
  const value = String(url || '').trim();
  if (/^https?:\/\//i.test(value) && !/api\.razorpay\.com/i.test(value)) return value;
  return '';
}

function publicPaymentId(item) {
  if (isCashItem(item)) {
    const stored = String(item.paymentId || item.paymentCode || '');
    if (stored.startsWith('off_')) return stored;
    return stored ? `off_${stored.replace(/^pay-?/i, '')}` : stored;
  }
  return item.razorpayPaymentId
    || item.razorpaySubscriptionId
    || item.razorpayPaymentLinkId
    || item.paymentCode
    || item.paymentId;
}

function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function parseYmd(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) };
}

function formatYmd(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addCalendarDays(start, days) {
  const parsed = parseYmd(start);
  if (!parsed) return addCalendarDays(today(), days);
  const date = new Date(parsed.y, parsed.m, parsed.d + Number(days || 0));
  return formatYmd(date.getFullYear(), date.getMonth(), date.getDate());
}

function addCalendarMonths(start, months) {
  const parsed = parseYmd(start);
  if (!parsed) return addCalendarMonths(today(), months);
  const last = new Date(parsed.y, parsed.m + Number(months || 0) + 1, 0).getDate();
  const day = Math.min(parsed.d, last);
  const date = new Date(parsed.y, parsed.m + Number(months || 0), day);
  return formatYmd(date.getFullYear(), date.getMonth(), date.getDate());
}

function monthsFromPlanDays(days) {
  const n = Number(days || 0);
  if (n === 365 || n === 366) return 12;
  if (n === 180) return 6;
  if (n === 90) return 3;
  if (n === 28 || n === 29 || n === 30 || n === 31) return 1;
  return null;
}

function addPlanDuration(start, days) {
  const months = monthsFromPlanDays(days);
  return months != null ? addCalendarMonths(start, months) : addCalendarDays(start, days);
}

function prepaidCharge({ amount, addonAmount, startDate, durationDays }) {
  const membershipStart = String(startDate || today()).slice(0, 10);
  const admission = Math.max(0, Number(addonAmount || 0) || 0);
  const plan = Math.max(0, Number(amount || 0) || 0);
  const days = Number(durationDays || 30);
  const cycleEnd = addPlanDuration(membershipStart || today(), days);
  const futureStart = /^\d{4}-\d{2}-\d{2}$/.test(membershipStart) && membershipStart > today();
  if (!futureStart) {
    return {
      futureStart: false,
      membershipStart,
      cycleEnd,
      razorpayStartDate: membershipStart,
      addonAmount: admission,
      addonName: admission > 0 ? 'Admission fee' : undefined,
      addonDescription: admission > 0 ? 'One-time admission / joining fee' : undefined,
    };
  }
  return {
    futureStart: true,
    membershipStart,
    cycleEnd,
    razorpayStartDate: cycleEnd,
    addonAmount: admission + plan,
    addonName: admission > 0 ? 'First cycle + admission' : 'First cycle',
    addonDescription: admission > 0
      ? `Plan ₹${plan} + admission ₹${admission} charged today`
      : `Plan ₹${plan} charged today`,
  };
}

function addDays(days) {
  return addPlanDuration(today(), days);
}

function addDaysFrom(start, days) {
  return addPlanDuration(start || today(), days);
}

function ymdDay(value) {
  return parseYmd(value)?.d || 0;
}

function deviceDay(value) {
  const match = String(value || '').match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function formatDeviceEnd(day, previous) {
  if (!day) return previous || '';
  return /\d{2}:\d{2}/.test(String(previous || '')) ? `${day} 23:59:59` : day;
}

function diffDays(a, b) {
  const left = parseYmd(a);
  const right = parseYmd(b);
  if (!left || !right) return 0;
  return Math.round(
    (Date.UTC(left.y, left.m, left.d) - Date.UTC(right.y, right.m, right.d)) / 86400000,
  );
}

function dueAfterPause({ pausedAt, oldDue, resumedAt }) {
  const from = String(pausedAt || resumedAt || today()).slice(0, 10);
  const due = String(oldDue || '').slice(0, 10);
  const now = String(resumedAt || today()).slice(0, 10);
  const remaining = due ? Math.max(0, diffDays(due, from)) : 0;
  return remaining > 0 ? addCalendarDays(now, remaining) : now;
}

function repairCycleEnd(start, stored, days) {
  const duration = Number(days || 30);
  if (!start) return stored || '';
  const intended = addPlanDuration(start, duration);
  if (!stored) return intended;
  if (ymdDay(stored) === ymdDay(start)) return stored;
  if (Math.abs(diffDays(stored, intended)) <= 4) return intended;
  return stored;
}

function toMember(item) {
  const firstName = item.firstName || String(item.userName || '').split(' ')[0] || '';
  const lastName = item.lastName || String(item.userName || '').split(' ').slice(1).join(' ');
  const name = item.name || `${firstName} ${lastName}`.trim() || item.userName || 'Member';
  const paid = String(item.paymentStatus || '').toUpperCase() === 'PAID';
  const held = item.renewDateSource === 'extended' || item.renewDateSource === 'manual';
  const fromRazorpay = item.renewDateSource === 'razorpay'
    || (Boolean(item.razorpaySubscriptionId && paid) && !held);
  const cash = ['CASH', 'UPI'].includes(String(item.paymentMethod || '').toUpperCase())
    || held
    || String(item.subscriptionStatus || '').toUpperCase() === 'OFFLINE';
  const storedRenew = item.renewDate || item.rePaymentDate || '';
  const renewDate = fromRazorpay || cash
    ? storedRenew
    : repairCycleEnd(item.joinDate, storedRenew, item.durationDays);
  const suspended = String(item.status || '').toUpperCase() === 'SUSPENDED';
  const expired = !suspended && renewDate && renewDate < today();
  return {
    id: item.memberId || item.cognitoId,
    memberCode: item.memberCode || `MEM-${String(item.cognitoId || '').slice(-6).toUpperCase()}`,
    firstName,
    lastName,
    name,
    phone: item.phoneNumber || item.phone || '',
    email: item.emailId || item.email || '',
    gender: item.gender || 'Male',
    dateOfBirth: item.dateOfBirth || '',
    address: item.address || '',
    city: item.city || '',
    emergencyContactName: item.emergencyContactName || '',
    emergencyContactPhone: item.emergencyContactPhone || '',
    joinDate: item.joinDate || (item.createdAt ? new Date(item.createdAt).toISOString().slice(0, 10) : today()),
    status: expired ? 'INACTIVE' : item.status || 'ACTIVE',
    faceRegistered: Boolean(item.faceRegistered),
    deviceEnrollId: item.deviceEnrollId || '',
    devicePhotoUrl: item.devicePhotoUrl || '',
    deviceFingerprint: item.deviceFingerprint || '',
    deviceStart: item.deviceStart || item.joinDate || '',
    deviceEnd: item.deviceEnd || renewDate || '',
    deviceEndPending: Boolean(item.deviceEndPending),
    notes: item.notes || '',
    createdAt: item.createdAtIso || (item.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString()),
    updatedAt: item.updatedAtIso || (item.updatedAt ? new Date(item.updatedAt).toISOString() : new Date().toISOString()),
    paymentStatus: paid ? 'PAID' : item.paymentStatus || 'PENDING',
    renewDate: renewDate || null,
    renewDateSource: held ? item.renewDateSource : (fromRazorpay ? 'razorpay' : item.renewDateSource || null),
    subscriptionId: item.razorpaySubscriptionId || '',
    paymentMethod: item.paymentMethod || '',
    subscriptionStatus: ['CASH', 'UPI'].includes(String(item.paymentMethod || '').toUpperCase())
      || (!item.razorpaySubscriptionId && !fromRazorpay && paid && !item.paymentLinkUrl)
      ? 'OFFLINE'
      : item.subscriptionStatus || '',
    durationDays: item.durationDays ?? null,
    planId: item.planId || '',
    planName: item.planName || '',
    attendance: item.attendance && typeof item.attendance === 'object' ? item.attendance : {},
    attendanceDays: item.attendanceDays && typeof item.attendanceDays === 'object' ? item.attendanceDays : {},
    amount: item.amount ?? null,
    paymentLinkUrl: paid ? '' : publicPayUrl(item.paymentLinkUrl),
    cognitoId: item.cognitoId,
    membership: renewDate
      ? {
          id: item.membershipId || `ms-${item.cognitoId}`,
          memberId: item.memberId || item.cognitoId,
          planId: item.planId || '',
          startDate: item.joinDate || today(),
          expiryDate: renewDate,
          price: Number(item.amount || 0),
          discount: 0,
          paymentStatus: paid ? 'PAID' : 'PENDING',
          autoRenewal: Boolean(item.razorpaySubscriptionId),
          status: expired ? 'EXPIRED' : (String(item.status || '').toUpperCase() === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE'),
          accessStatus: paid && !expired && String(item.status || '').toUpperCase() !== 'SUSPENDED' ? 'ACTIVE' : 'BLOCKED',
          createdAt: item.createdAtIso || new Date().toISOString(),
          updatedAt: item.updatedAtIso || new Date().toISOString(),
        }
      : undefined,
  };
}

function toPayment(item) {
  const status = String(item.paymentStatus || item.status || 'PENDING').toUpperCase();
  const dateNum = Number(item.paymentDate || item.createdAt || Date.now());
  const paymentCode = publicPaymentId(item);
  return {
    id: item.paymentId,
    paymentCode,
    memberId: item.memberId || item.cognitoId,
    memberName: item.client || item.userName || '',
    phone: item.phone || item.phoneNumber || '',
    planId: item.planId || '',
    amount: Number(
      item.netAmount != null && String(item.paymentStatus || item.status || '').toUpperCase() === 'PAID'
        && !['CASH', 'UPI'].includes(String(item.paymentMode || item.method || '').toUpperCase())
        ? item.netAmount
        : (item.amount || item.netAmount || 0),
    ),
    grossAmount: Number(item.grossAmount || item.amount || item.netAmount || 0),
    feeAmount: Number(item.feeAmount || 0),
    netAmount: Number(item.netAmount != null ? item.netAmount : (item.amount || 0)),
    date: new Date(dateNum).toISOString().slice(0, 10),
    method: publicMethod(item),
    status: status === 'PAID' || status === 'CAPTURED' ? 'PAID' : status === 'FAILED' ? 'FAILED' : 'PENDING',
    invoiceNumber: item.invoiceNumber || '',
    notes: item.notes || publicPayUrl(item.paymentLinkUrl) || '',
    paymentLinkUrl: publicPayUrl(item.paymentLinkUrl),
    paymentLinkId: item.razorpayPaymentLinkId || item.razorpaySubscriptionId || '',
    subscriptionId: item.razorpaySubscriptionId || '',
    razorpayPaymentId: item.razorpayPaymentId || '',
    renewDate: item.renewDate || item.rePaymentDate || (item.durationDays
      ? addPlanDuration(item.joinDate || item.startDate || today(), item.durationDays)
      : null),
    createdAt: item.createdAtIso || new Date(dateNum).toISOString(),
  };
}

function profileFromBody(body, existing, institution = fallbackInstitution()) {
  const firstName = body.firstName || existing?.firstName || '';
  const lastName = body.lastName || existing?.lastName || '';
  const userName = body.name || `${firstName} ${lastName}`.trim() || existing?.userName || 'Member';
  const now = Date.now();
  const cognitoId = existing?.cognitoId || body.id || newId('gym');
  return {
    ...(existing || {}),
    institution,
    cognitoId,
    memberId: existing?.memberId || cognitoId,
    memberCode: body.memberCode || existing?.memberCode || `MEM-${cognitoId.slice(-6).toUpperCase()}`,
    firstName,
    lastName,
    userName,
    name: userName,
    emailId: (body.email || existing?.emailId || '').trim() || `noreply.${cognitoId}@tekkzy.fit`,
    phoneNumber: body.phone || existing?.phoneNumber || '',
    gender: body.gender || existing?.gender || 'Male',
    dateOfBirth: body.dateOfBirth && body.dateOfBirth !== '1995-01-15'
      ? body.dateOfBirth
      : existing?.dateOfBirth && existing.dateOfBirth !== '1995-01-15'
        ? existing.dateOfBirth
        : undefined,
    deviceEnrollId: body.deviceEnrollId || existing?.deviceEnrollId || '',
    devicePhotoUrl: body.devicePhotoUrl || existing?.devicePhotoUrl || '',
    deviceFingerprint: body.deviceFingerprint || existing?.deviceFingerprint || '',
    faceRegistered: body.faceRegistered != null ? Boolean(body.faceRegistered) : Boolean(existing?.faceRegistered),
    deviceStart: body.deviceStart || existing?.deviceStart || body.startDate || body.joinDate || existing?.joinDate || '',
    deviceEnd: body.deviceEnd || existing?.deviceEnd || '',
    deviceEndPending: body.deviceEndPending != null ? Boolean(body.deviceEndPending) : Boolean(existing?.deviceEndPending),
    renewDate: body.renewDate || body.deviceEnd || existing?.renewDate || '',
    renewDateSource: body.renewDateSource || existing?.renewDateSource || '',
    notes: body.notes || existing?.notes || undefined,
    status: body.status || existing?.status || 'ACTIVE',
    userType: 'member',
    planId: body.planId || existing?.planId || '',
    planName: body.planName || existing?.planName || '',
    amount: body.amount != null ? Number(body.amount) : existing?.amount,
    durationDays: body.durationDays != null ? Number(body.durationDays) : existing?.durationDays,
    paymentStatus: existing?.paymentStatus || 'PENDING',
    joinDate: body.startDate || body.joinDate || existing?.joinDate || today(),
    createdAt: existing?.createdAt || now,
    createdAtIso: existing?.createdAtIso || new Date(existing?.createdAt || now).toISOString(),
    updatedAt: now,
    updatedAtIso: new Date(now).toISOString(),
  };
}

function attendanceMonthKey(day) {
  const raw = String(day || '').slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T12:00:00+05:30`)
    : new Date();
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).replace(' ', '-');
}

function applyAttendanceDays(profile, days) {
  const nextDays = { ...(profile.attendanceDays && typeof profile.attendanceDays === 'object' ? profile.attendanceDays : {}) };
  const attendance = { ...(profile.attendance && typeof profile.attendance === 'object' ? profile.attendance : {}) };
  const start = String(profile.joinDate || profile.deviceStart || '').slice(0, 10);
  let changed = false;
  for (const value of days || []) {
    const ymd = String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || nextDays[ymd]) continue;
    if (start && ymd < start) continue;
    nextDays[ymd] = true;
    const key = attendanceMonthKey(ymd);
    attendance[key] = Number(attendance[key] || 0) + 1;
    changed = true;
  }
  if (!changed) return profile;
  return {
    ...profile,
    attendance,
    attendanceDays: nextDays,
    updatedAt: Date.now(),
    updatedAtIso: new Date().toISOString(),
  };
}

function paymentItem({ profile, planId, planName, amount, durationDays, link, paymentId: givenId }) {
  const now = Date.now();
  const paymentId = givenId || newId('pay');
  return {
    cognitoId: profile.cognitoId,
    paymentId,
    institution: profile.institution || fallbackInstitution(),
    memberId: profile.memberId || profile.cognitoId,
    client: profile.userName,
    userName: profile.userName,
    phone: profile.phoneNumber,
    amount: Number(amount),
    netAmount: Number(amount),
    currency: 'INR',
    planId: planId || profile.planId || '',
    planName: planName || profile.planName || '',
    durationDays: Number(durationDays || profile.durationDays || 30),
    paymentType: 'subscription',
    paymentMode: 'RAZORPAY',
    paymentStatus: 'PENDING',
    status: 'PENDING',
    active: true,
    isVerified: false,
    razorpayPaymentLinkId: String(link.paymentLinkId || '').startsWith('plink_') ? link.paymentLinkId : undefined,
    razorpaySubscriptionId: link.subscriptionId || '',
    razorpayPlanId: link.razorpayPlanId || '',
    razorpayCustomerId: link.razorpayCustomerId || '',
    paymentLinkUrl: link.paymentLinkUrl,
    paymentDate: now,
    joinDate: profile.joinDate || today(),
    startDate: profile.joinDate || today(),
    renewDate: addPlanDuration(profile.joinDate || today(), durationDays || profile.durationDays || 30),
    rePaymentDate: addPlanDuration(profile.joinDate || today(), durationDays || profile.durationDays || 30),
    createdAt: now,
    createdAtIso: new Date(now).toISOString(),
    source: profile.institution || fallbackInstitution(),
  };
}

module.exports = {
  newId,
  newOfflineId,
  publicPaymentId,
  deviceDay,
  formatDeviceEnd,
  addDays,
  addDaysFrom,
  addPlanDuration,
  prepaidCharge,
  addCalendarDays,
  diffDays,
  dueAfterPause,
  repairCycleEnd,
  today,
  toMember,
  toPayment,
  profileFromBody,
  paymentItem,
  applyAttendanceDays,
  attendanceMonthKey,
};
