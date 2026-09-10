const { json, parseBody, requireGymKey, pathId, method, institutionFrom } = require('./http');
const dynamo = require('./dynamo');
const { createSubscription, fetchSubscription, mapSubscriptionStatus, pauseSubscription, resumeSubscription } = require('./razorpay');
const { toMember, profileFromBody, paymentItem, newId, newOfflineId, addPlanDuration, today, applyAttendanceDays } = require('./map');
const { refreshStaleSubscriptionStatuses, syncPendingProfile } = require('./syncPay');

async function sendPayLink(profile, body) {
  const amount = Number(body.amount ?? profile.amount);
  const durationDays = Number(body.durationDays ?? profile.durationDays ?? 30);
  if (!amount) throw new Error('Plan amount is required to create the subscription');
  const paymentId = newId('pay');
  const startDate = body.startDate || body.joinDate || profile.joinDate;
  const gymPlanId = body.planId || profile.planId;
  const gymPlan = gymPlanId ? await dynamo.getPlan(profile.institution, gymPlanId) : null;
  const addonAmount = String(profile.paymentStatus || '').toUpperCase() === 'PAID'
    ? 0
    : Number(gymPlan?.addonAmount || 0);
  const link = await createSubscription({
    amount,
    addonAmount,
    name: profile.userName,
    phone: profile.phoneNumber,
    email: profile.emailId,
    description: `${profile.planName || 'Membership'} · Tekkzy Fit`,
    planId: gymPlanId,
    planName: body.planName || profile.planName,
    durationDays,
    period: gymPlan?.billingPeriod,
    interval: gymPlan?.billingInterval,
    startDate,
    notes: {
      institution: profile.institution,
      memberId: profile.memberId || profile.cognitoId,
      cognitoId: profile.cognitoId,
      paymentId,
      planId: String(body.planId || profile.planId || ''),
      durationDays: String(durationDays),
      startDate: String(startDate || ''),
    },
  });
  const payment = paymentItem({
    profile: { ...profile, joinDate: startDate || profile.joinDate },
    planId: body.planId || profile.planId,
    planName: body.planName || profile.planName,
    amount,
    durationDays,
    link,
    paymentId,
  });
  await dynamo.putPayment(payment);
  const next = {
    ...profile,
    paymentStatus: 'PENDING',
    paymentLinkUrl: link.paymentLinkUrl,
    paymentLinkId: link.paymentLinkId,
    razorpaySubscriptionId: link.subscriptionId,
    subscriptionStatus: mapSubscriptionStatus(link.status) || 'PENDING',
    subscriptionStatusAt: Date.now(),
    lastPaymentId: payment.paymentId,
    amount,
    durationDays,
    planId: body.planId || profile.planId,
    planName: body.planName || profile.planName,
    joinDate: startDate || profile.joinDate,
    renewDate: addPlanDuration(startDate || today(), durationDays),
    deviceStart: profile.deviceStart || startDate || profile.joinDate,
    deviceEnd: addPlanDuration(startDate || today(), durationDays),
  };
  await dynamo.putProfile(next);
  return { profile: next, payment };
}

async function resolveRenewalPlan(profile) {
  const institution = profile.institution;
  let planId = String(profile.planId || '').trim();
  let planName = String(profile.planName || '').trim() || 'Membership';
  let amount = Number(profile.amount);
  let durationDays = Number(profile.durationDays || 30);
  let gymPlan = planId ? await dynamo.getPlan(institution, planId).catch(() => null) : null;
  if (!gymPlan) {
    const plans = await dynamo.listPlans(institution);
    const needle = planName.toLowerCase();
    gymPlan = plans.find((row) => String(row.name || '').trim().toLowerCase() === needle)
      || (!(amount > 0) ? plans.find((row) => Number(row.price) > 0) : null);
  }
  if (gymPlan) {
    planId = gymPlan.planId || planId;
    planName = gymPlan.name || planName;
    if (!(amount > 0)) amount = Number(gymPlan.price || 0);
    durationDays = Number(gymPlan.durationDays || durationDays);
  }
  return { planId, planName, amount, durationDays, gymPlan };
}

async function ensureRenewalPayLink(profile) {
  const resolved = await resolveRenewalPlan(profile);
  if (!(resolved.amount > 0)) throw new Error('No plan amount to create a pay link');
  const paymentId = newId('pay');
  const cycleEnd = String(profile.renewDate || profile.deviceEnd || '').slice(0, 10);
  const nextDue = cycleEnd ? addPlanDuration(cycleEnd, resolved.durationDays) : '';
  const link = await createSubscription({
    amount: resolved.amount,
    addonAmount: resolved.amount,
    addonName: 'Membership renewal',
    addonDescription: `${resolved.planName || 'Membership'} renewal`,
    name: profile.userName,
    phone: profile.phoneNumber,
    email: profile.emailId,
    description: `${resolved.planName} · Tekkzy Fit`,
    planId: resolved.planId,
    planName: resolved.planName,
    durationDays: resolved.durationDays,
    period: resolved.gymPlan?.billingPeriod,
    interval: resolved.gymPlan?.billingInterval,
    startDate: nextDue,
    customerNotify: true,
    notes: {
      institution: profile.institution,
      memberId: profile.memberId || profile.cognitoId,
      cognitoId: profile.cognitoId,
      paymentId,
      planId: String(resolved.planId || ''),
      durationDays: String(resolved.durationDays),
      startDate: nextDue,
      reason: 'expiry-reminder',
    },
  });
  const payment = paymentItem({
    profile,
    planId: resolved.planId,
    planName: resolved.planName,
    amount: resolved.amount,
    durationDays: resolved.durationDays,
    link,
    paymentId,
  });
  await dynamo.putPayment(payment);
  const next = {
    ...profile,
    paymentLinkUrl: link.paymentLinkUrl,
    paymentLinkId: link.paymentLinkId,
    lastPaymentId: payment.paymentId,
    amount: resolved.amount,
    durationDays: resolved.durationDays,
    planId: resolved.planId || profile.planId,
    planName: resolved.planName || profile.planName,
    razorpaySubscriptionId: link.subscriptionId,
  };
  await dynamo.putProfile(next);
  return { profile: next, url: link.paymentLinkUrl, reused: false };
}

function deskMethod(body) {
  const method = String(body.paymentMethod || body.method || '').toUpperCase();
  return method === 'UPI' ? 'UPI' : method === 'CASH' ? 'CASH' : '';
}

function wantsOnlineLink(body) {
  const method = String(body.paymentMethod || body.method || '').toUpperCase();
  if (method === 'CASH' || method === 'UPI' || body.skipPayment) return false;
  if (method === 'ONLINE' || method === 'RAZORPAY' || body.sendPayLink) return true;
  return false;
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function realPhone(value) {
  const d = digits(value);
  return d.length >= 10 && !d.startsWith('99') ? d : '';
}

function profileEnroll(item) {
  return String(item?.deviceEnrollId || '').trim();
}

function richerProfile(a, b) {
  const score = (p) =>
    (realPhone(p.phoneNumber || p.phone) ? 8 : 0)
    + (p.userName && !/^device user/i.test(String(p.userName)) ? 2 : 0)
    + (p.razorpaySubscriptionId ? 1 : 0)
    + (p.planId ? 1 : 0)
    + ((Number(p.updatedAt) || 0) / 1e13);
  return score(a) >= score(b)
    ? { ...b, ...a, deviceEnrollId: a.deviceEnrollId || b.deviceEnrollId }
    : { ...a, ...b, deviceEnrollId: b.deviceEnrollId || a.deviceEnrollId };
}

function collapseProfiles(rows) {
  const byEnroll = new Map();
  const leftover = [];
  for (const row of rows) {
    const enroll = profileEnroll(row);
    if (!enroll) {
      leftover.push(row);
      continue;
    }
    const prev = byEnroll.get(enroll);
    byEnroll.set(enroll, prev ? richerProfile(prev, row) : row);
  }
  const byPhone = new Map();
  const rest = [];
  for (const row of leftover) {
    const phone = realPhone(row.phoneNumber || row.phone);
    if (!phone) {
      rest.push(row);
      continue;
    }
    const prev = byPhone.get(phone);
    byPhone.set(phone, prev ? richerProfile(prev, row) : row);
  }
  return [...byEnroll.values(), ...byPhone.values(), ...rest];
}

async function findExistingProfile(body, institution) {
  if (body.id) {
    const byId = await dynamo.getProfile(body.id, institution);
    if (byId) return byId;
  }
  const rows = await dynamo.listProfiles(institution);
  const enroll = String(body.deviceEnrollId || '').trim();
  if (enroll) {
    const hit = rows.find((item) => profileEnroll(item) === enroll);
    if (hit) return hit;
  }
  const phone = realPhone(body.phone || body.phoneNumber);
  if (phone) {
    const hit = rows.find((item) => realPhone(item.phoneNumber || item.phone) === phone);
    if (hit) return hit;
  }
  if (body.id) {
    return rows.find((item) => item.cognitoId === body.id || item.memberId === body.id || item.memberCode === body.id) || null;
  }
  return null;
}

async function applySubscriptionAction(existing, profile, body) {
  const action = String(body.subscriptionAction || '').toLowerCase();
  if (action !== 'pause' && action !== 'resume') return profile;
  const subId = existing?.razorpaySubscriptionId || profile.razorpaySubscriptionId;
  if (!subId) {
    return {
      ...profile,
      status: action === 'pause' ? 'SUSPENDED' : 'ACTIVE',
    };
  }
  const live = await fetchSubscription(subId);
  const liveStatus = String(live?.status || '').toLowerCase();
  if (action === 'pause') {
    const nextLive = ['paused', 'halted'].includes(liveStatus)
      ? live
      : ['created', 'pending'].includes(liveStatus)
        ? live
        : await pauseSubscription(subId);
    return {
      ...profile,
      status: 'SUSPENDED',
      subscriptionStatus: mapSubscriptionStatus(nextLive?.status) || (['created', 'pending'].includes(liveStatus) ? 'PENDING' : 'PAUSED'),
      subscriptionStatusAt: Date.now(),
    };
  }
  const nextLive = ['active', 'authenticated'].includes(liveStatus)
    ? live
    : ['cancelled', 'canceled', 'completed', 'expired'].includes(liveStatus)
      ? live
      : await resumeSubscription(subId);
  return {
    ...profile,
    status: 'ACTIVE',
    subscriptionStatus: mapSubscriptionStatus(nextLive?.status) || profile.subscriptionStatus,
    subscriptionStatusAt: Date.now(),
  };
}

async function applyPayment(profile, body) {
  if (wantsOnlineLink(body)) return sendPayLink(profile, body);
  if (deskMethod(body)) return recordCash(profile, body);
  await dynamo.putProfile(profile);
  const end = String(body.deviceEnd || body.renewDate || '').slice(0, 10);
  if (body.renewDateSource === 'manual' && /^\d{4}-\d{2}-\d{2}$/.test(end) && profile.lastPaymentId) {
    try {
      const pay = await dynamo.getPayment(profile.cognitoId, profile.lastPaymentId);
      const mode = String(pay.paymentMode || '').toUpperCase();
      if (pay && (mode === 'CASH' || mode === 'UPI')) {
        await dynamo.putPayment({ ...pay, renewDate: end });
      }
    } catch (_err) {
      /* keep the member save even if the last cash receipt cannot be patched */
    }
  }
  return { profile, payment: null };
}

function paymentPayload(sent) {
  return sent.payment
    ? {
        id: sent.payment.paymentId,
        status: sent.payment.paymentStatus || sent.payment.status || 'PENDING',
        paymentLinkUrl: sent.payment.paymentLinkUrl || '',
        paymentLinkId: sent.payment.razorpayPaymentLinkId || '',
      }
    : null;
}

function cashEndDate(body, profile, durationDays) {
  const given = String(body.deviceEnd || body.renewDate || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(given)) return given;
  return addPlanDuration(body.startDate || body.joinDate || profile.joinDate || today(), durationDays);
}

async function recordCash(profile, body) {
  const mode = deskMethod(body) || 'CASH';
  const gymPlanId = body.planId || profile.planId;
  const gymPlan = gymPlanId ? await dynamo.getPlan(profile.institution, gymPlanId) : null;
  const recurring = Number(body.amount ?? gymPlan?.price ?? profile.amount ?? 0);
  const addonAmount = String(profile.paymentStatus || '').toUpperCase() === 'PAID'
    ? 0
    : Number(gymPlan?.addonAmount || 0);
  const amount = recurring + addonAmount;
  const durationDays = Number(body.durationDays ?? profile.durationDays ?? 30);
  const paymentId = newOfflineId();
  const now = Date.now();
  const label = mode === 'UPI' ? 'UPI' : 'cash';
  const payment = {
    cognitoId: profile.cognitoId,
    paymentId,
    paymentCode: paymentId,
    institution: profile.institution,
    memberId: profile.memberId || profile.cognitoId,
    client: profile.userName,
    userName: profile.userName,
    phone: profile.phoneNumber,
    amount,
    netAmount: amount,
    currency: 'INR',
    planId: body.planId || profile.planId || '',
    planName: body.planName || profile.planName || '',
    durationDays,
    paymentType: 'membership',
    paymentMode: mode,
    paymentStatus: 'PAID',
    status: 'PAID',
    active: true,
    isVerified: true,
    paymentLinkUrl: '',
    renewDate: cashEndDate(body, profile, durationDays),
    paymentDate: now,
    createdAt: now,
    createdAtIso: new Date(now).toISOString(),
    source: profile.institution,
    notes: addonAmount > 0
      ? `Paid by ${label} at the desk (₹${recurring} + ₹${addonAmount} admission)`
      : `Paid by ${label} at the desk`,
  };
  await dynamo.putPayment(payment);
  const next = {
    ...profile,
    paymentStatus: 'PAID',
    paymentMethod: mode,
    subscriptionStatus: 'OFFLINE',
    paymentLinkUrl: '',
    paymentLinkId: '',
    lastPaymentId: paymentId,
    amount: recurring,
    durationDays,
    planId: body.planId || profile.planId,
    planName: body.planName || profile.planName,
    joinDate: body.startDate || body.joinDate || profile.joinDate,
    renewDate: cashEndDate(body, profile, durationDays),
    renewDateSource: 'manual',
    deviceStart: profile.deviceStart || body.startDate || body.joinDate || profile.joinDate,
    deviceEnd: cashEndDate(body, profile, durationDays),
    deviceEndPending: true,
  };
  await dynamo.putProfile(next);
  return { profile: next, payment };
}

exports.ensureRenewalPayLink = ensureRenewalPayLink;

exports.handler = async (event) => {
  if (method(event) === 'OPTIONS') return json(200, { ok: true });
  if (!requireGymKey(event)) return json(401, { error: 'Unauthorized' });

  try {
    const verb = method(event);
    const id = pathId(event);
    const body = verb === 'GET' || verb === 'DELETE' ? {} : parseBody(event);
    const institution = institutionFrom(event, body);

    if (verb === 'GET' && !id) {
      const rows = await dynamo.listProfiles(institution);
      const refreshed = await refreshStaleSubscriptionStatuses(collapseProfiles(rows));
      return json(200, refreshed.map(toMember));
    }

    if (verb === 'GET' && id) {
      let found = await dynamo.getProfile(id, institution);
      if (!found) found = await findExistingProfile({ id }, institution);
      if (!found) return json(404, { error: 'Member not found' });
      const row = await syncPendingProfile(found);
      return json(200, toMember(row));
    }

    if (verb === 'POST') {
      if (!body.phone && !body.phoneNumber) return json(400, { error: 'Phone is required' });
      const online = wantsOnlineLink(body);
      if (online && !body.email && !body.emailId) return json(400, { error: 'Email is required to send the subscription link' });
      const existing = body.id ? await dynamo.getProfile(body.id, institution) : null;
      const profile = profileFromBody(body, existing, institution);
      const sent = await applyPayment(profile, body);
      return json(existing ? 200 : 201, {
        member: toMember(sent.profile),
        payment: paymentPayload(sent),
      });
    }

    if ((verb === 'PUT' || verb === 'PATCH') && id && body.recordAttendance) {
      const existing = await findExistingProfile({ ...body, id }, institution);
      if (!existing) return json(404, { error: 'Member not found' });
      const days = Array.isArray(body.attendanceDays)
        ? body.attendanceDays
        : [body.attendanceDay || today()];
      const saved = await dynamo.putProfile(applyAttendanceDays(existing, days));
      return json(200, { member: toMember(saved) });
    }

    if ((verb === 'PUT' || verb === 'PATCH') && id) {
      const existing = await findExistingProfile({ ...body, id }, institution);
      if (body.subscriptionAction && !existing) return json(404, { error: 'Member not found' });
      const profile = profileFromBody(body, existing, institution);
      const held = await applySubscriptionAction(existing, profile, body);
      const sent = await applyPayment(held, body);
      return json(200, {
        member: toMember(sent.profile),
        payment: paymentPayload(sent),
      });
    }

    if (verb === 'DELETE' && id) {
      const enroll = String(event.queryStringParameters?.enroll || '').trim();
      const rows = await dynamo.listProfiles(institution);
      const matches = rows.filter((item) =>
        item.cognitoId === id
        || item.memberId === id
        || item.memberCode === id
        || (enroll && profileEnroll(item) === enroll),
      );
      const byKey = await dynamo.getProfile(id, institution);
      if (byKey && !matches.some((item) => item.cognitoId === byKey.cognitoId)) matches.push(byKey);
      await Promise.all(matches.map((row) => dynamo.deleteProfile(row.cognitoId, institution)));
      return json(200, { ok: true, deleted: matches.length });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('members', err);
    return json(500, { error: err instanceof Error ? err.message : 'Server error' });
  }
};
