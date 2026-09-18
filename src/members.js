const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { json, parseBody, requireGymKey, pathId, method, institutionFrom } = require('./http');
const dynamo = require('./dynamo');
const { createSubscription, fetchSubscription, mapSubscriptionStatus, pauseSubscription, resumeSubscription, deferSubscriptionCharge, hostedPayUrl, indiaPhone } = require('./razorpay');

const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const { toMember, profileFromBody, paymentItem, newId, newOfflineId, addPlanDuration, prepaidCharge, today, applyAttendanceDays, addCalendarDays, dueAfterPause, diffDays } = require('./map');
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
  const charge = prepaidCharge({ amount, addonAmount, startDate, durationDays });
  const link = await createSubscription({
    amount,
    addonAmount: charge.addonAmount,
    addonName: charge.addonName,
    addonDescription: charge.addonDescription,
    name: profile.userName,
    phone: profile.phoneNumber,
    email: profile.emailId,
    description: `${profile.planName || 'Membership'} · Tekkzy Fit`,
    planId: gymPlanId,
    planName: body.planName || profile.planName,
    durationDays,
    period: gymPlan?.billingPeriod,
    interval: gymPlan?.billingInterval,
    startDate: charge.razorpayStartDate,
    notes: {
      institution: profile.institution,
      memberId: profile.memberId || profile.cognitoId,
      cognitoId: profile.cognitoId,
      paymentId,
      planId: String(body.planId || profile.planId || ''),
      durationDays: String(durationDays),
      startDate: String(charge.membershipStart || ''),
      ...(charge.futureStart ? { prepaidStart: '1' } : {}),
    },
  });
  const payment = paymentItem({
    profile: { ...profile, joinDate: charge.membershipStart || profile.joinDate },
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
    razorpaySubscriptionId: link.subscriptionId,
    subscriptionStatus: mapSubscriptionStatus(link.status) || 'PENDING',
    subscriptionStatusAt: Date.now(),
    lastPaymentId: payment.paymentId,
    amount,
    durationDays,
    planId: body.planId || profile.planId,
    planName: body.planName || profile.planName,
    joinDate: charge.membershipStart || profile.joinDate,
    renewDate: charge.cycleEnd,
    deviceStart: profile.deviceStart || charge.membershipStart || profile.joinDate,
    deviceEnd: charge.cycleEnd,
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
    gymPlan = plans.find((row) => String(row.name || row.heading || '').trim().toLowerCase() === needle)
      || (!(amount > 0) ? plans.find((row) => Number(row.price || row.amount) > 0) : null);
  }
  if (gymPlan) {
    planId = gymPlan.productId || planId;
    planName = gymPlan.name || gymPlan.heading || planName;
    if (!(amount > 0)) amount = Number(gymPlan.price != null ? gymPlan.price : Number(gymPlan.amount || 0) / 100);
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

function prettyDue(ymd) {
  const [year, month, day] = String(ymd || '').split('-').map(Number);
  if (!year || !month || !day) return ymd || '';
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

async function sendPayLinkSms(profile, url, dueYmd) {
  const phone = indiaPhone(profile.phoneNumber || profile.phone);
  const link = String(url || '').trim();
  if (!phone || !link) return false;
  const name = String(profile.firstName || profile.userName || 'Member').trim().split(/\s+/)[0] || 'Member';
  try {
    await sns.send(new PublishCommand({
      PhoneNumber: phone,
      Message: `Dear ${name}, greetings from Tekkzy Fit. Your membership due date is now ${prettyDue(dueYmd)}. Authorize UPI here: ${link} Thank you, Tekkzy Fit.`,
      MessageAttributes: {
        'AWS.SNS.SMS.SMSType': {
          DataType: 'String',
          StringValue: 'Transactional',
        },
      },
    }));
    return true;
  } catch (err) {
    console.error('pay link sms failed', err);
    return false;
  }
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

async function applyDueDateExtend(existing, profile, body) {
  if (!existing) return profile;
  const nextEnd = String(body.renewDate || body.deviceEnd || existing.renewDate || profile.renewDate || '').slice(0, 10);
  const prevEnd = String(existing.renewDate || existing.deviceEnd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextEnd)) return profile;
  const cancelled = ['CANCELLED', 'CANCELED', 'COMPLETED', 'EXPIRED'].includes(String(existing.subscriptionStatus || '').toUpperCase());
  const extending = Boolean(body.extendDueDate) || (prevEnd && nextEnd > prevEnd) || cancelled;
  if (!extending || (nextEnd === prevEnd && !cancelled)) return profile;

  const subId = existing.razorpaySubscriptionId || profile.razorpaySubscriptionId;
  let deferred = false;
  let live = null;
  if (subId) {
    const shifted = await deferSubscriptionCharge(subId, nextEnd, {
      phone: profile.phoneNumber,
      email: profile.emailId,
      amount: profile.amount,
      planName: profile.planName,
    });
    live = shifted.live;
    deferred = Boolean(shifted.deferred);
  }
  const nextSubId = live?.id || subId;
  const link = hostedPayUrl(live);
  const liveStatus = String(live?.status || '').toLowerCase();
  const needsAuth = Boolean(link) && ['created', 'pending'].includes(liveStatus);
  let lastPaymentId = profile.lastPaymentId;
  if (needsAuth) {
    const paymentId = newId('pay');
    lastPaymentId = paymentId;
    await dynamo.putPayment(paymentItem({
      profile,
      planId: profile.planId,
      planName: profile.planName,
      amount: profile.amount,
      durationDays: profile.durationDays,
      link: {
        paymentLinkUrl: link,
        subscriptionId: nextSubId,
        razorpayPlanId: live?.plan_id,
      },
      paymentId,
    }));
    await sendPayLinkSms(profile, link, nextEnd);
  }
  return {
    ...profile,
    razorpaySubscriptionId: nextSubId,
    lastPaymentId,
    renewDate: nextEnd,
    rePaymentDate: nextEnd,
    deviceEnd: nextEnd,
    deviceEndPending: true,
    renewDateSource: subId ? 'extended' : 'manual',
    billingResumeAt: deferred ? nextEnd : '',
    paymentLinkUrl: needsAuth ? link : hostedPayUrl(profile.paymentLinkUrl),
    status: 'ACTIVE',
    subscriptionStatus: needsAuth
      ? 'PENDING'
      : (mapSubscriptionStatus(live?.status) === 'PAUSED' ? 'ACTIVE' : mapSubscriptionStatus(live?.status) || profile.subscriptionStatus || 'ACTIVE'),
    subscriptionStatusAt: Date.now(),
  };
}

async function resumeDueDateHolds(institution) {
  const rows = await dynamo.listProfiles(institution);
  const todayIst = today();
  let resumed = 0;
  for (const row of rows) {
    const due = String(row.billingResumeAt || '').slice(0, 10);
    if (!due || due > todayIst) continue;
    const subId = row.razorpaySubscriptionId;
    if (!subId) {
      await dynamo.putProfile({ ...row, billingResumeAt: '' });
      continue;
    }
    try {
      const live = await fetchSubscription(subId);
      const status = String(live?.status || '').toLowerCase();
      if (['paused', 'halted'].includes(status)) await resumeSubscription(subId);
      await dynamo.putProfile({
        ...row,
        billingResumeAt: '',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        subscriptionStatusAt: Date.now(),
        updatedAt: Date.now(),
        updatedAtIso: new Date().toISOString(),
      });
      resumed += 1;
    } catch (err) {
      console.error('resume due date hold', row.cognitoId, err);
    }
  }
  return resumed;
}

async function applySubscriptionAction(existing, profile, body) {
  const action = String(body.subscriptionAction || '').toLowerCase();
  if (action !== 'pause' && action !== 'resume') return profile;
  const subId = existing?.razorpaySubscriptionId || profile.razorpaySubscriptionId;
  const currentDue = String(existing?.renewDate || existing?.deviceEnd || profile.renewDate || '').slice(0, 10);
  if (!subId) {
    if (action === 'pause') {
      const pausedAt = today();
      return {
        ...profile,
        status: 'SUSPENDED',
        pausedAt,
        pausedRenewDate: currentDue,
        deviceEnd: addCalendarDays(pausedAt, -1),
        deviceEndPending: true,
      };
    }
    const newDue = dueAfterPause({
      pausedAt: existing?.pausedAt || profile.pausedAt,
      oldDue: existing?.pausedRenewDate || currentDue,
      resumedAt: today(),
    });
    return {
      ...profile,
      status: 'ACTIVE',
      pausedAt: '',
      pausedRenewDate: '',
      renewDate: newDue,
      rePaymentDate: newDue,
      deviceEnd: newDue,
      deviceEndPending: true,
      renewDateSource: 'manual',
    };
  }
  const live = await fetchSubscription(subId);
  const liveStatus = String(live?.status || '').toLowerCase();
  if (action === 'pause') {
    const pausedAt = today();
    const nextLive = ['paused', 'halted'].includes(liveStatus)
      ? live
      : liveStatus === 'active'
        ? await pauseSubscription(subId)
        : live;
    return {
      ...profile,
      status: 'SUSPENDED',
      pausedAt,
      pausedRenewDate: currentDue,
      deviceEnd: addCalendarDays(pausedAt, -1),
      deviceEndPending: true,
      subscriptionStatus: 'PAUSED',
      subscriptionStatusAt: Date.now(),
      razorpaySubscriptionId: nextLive?.id || subId,
    };
  }
  const pausedAt = String(existing?.pausedAt || profile.pausedAt || today()).slice(0, 10);
  const oldDue = String(existing?.pausedRenewDate || currentDue).slice(0, 10);
  const resumedAt = today();
  const newDue = dueAfterPause({ pausedAt, oldDue, resumedAt });
  const remaining = oldDue ? Math.max(0, diffDays(oldDue, pausedAt)) : 0;
  let nextLive = live;
  let deferred = false;
  if (remaining > 0) {
    if (['paused', 'halted'].includes(liveStatus)) {
      deferred = true;
    } else {
      const shifted = await deferSubscriptionCharge(subId, newDue, {
        phone: profile.phoneNumber,
        email: profile.emailId,
        amount: profile.amount,
        planName: profile.planName,
      });
      nextLive = shifted.live || live;
      deferred = true;
    }
  } else if (['paused', 'halted'].includes(liveStatus)) {
    nextLive = await resumeSubscription(subId);
  }
  return {
    ...profile,
    status: 'ACTIVE',
    pausedAt: '',
    pausedRenewDate: '',
    renewDate: remaining > 0 ? newDue : addPlanDuration(resumedAt, profile.durationDays || existing?.durationDays || 30),
    rePaymentDate: remaining > 0 ? newDue : addPlanDuration(resumedAt, profile.durationDays || existing?.durationDays || 30),
    deviceEnd: remaining > 0 ? newDue : addPlanDuration(resumedAt, profile.durationDays || existing?.durationDays || 30),
    deviceEndPending: true,
    renewDateSource: 'extended',
    billingResumeAt: deferred && remaining > 0 ? newDue : '',
    razorpaySubscriptionId: nextLive?.id || subId,
    subscriptionStatus: mapSubscriptionStatus(nextLive?.status) === 'PAUSED' ? 'ACTIVE' : (mapSubscriptionStatus(nextLive?.status) || 'ACTIVE'),
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
exports.resumeDueDateHolds = resumeDueDateHolds;

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
      const extended = await applyDueDateExtend(existing, profile, body);
      const held = await applySubscriptionAction(existing, extended, body);
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
