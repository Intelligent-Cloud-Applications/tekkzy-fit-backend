const dynamo = require('./dynamo');
const { fetchSubscription, fetchPayment, netFromRazorpayPayment, mapSubscriptionStatus, subscriptionIsPaid, subscriptionEndDate, ymdFromUnix } = require('./razorpay');
const { addPlanDuration, repairCycleEnd, today, newId } = require('./map');

function keepCurrentCycleEnd(existingEnd, nextEnd) {
  const current = String(existingEnd || '').slice(0, 10);
  const next = String(nextEnd || '').slice(0, 10);
  if (current && current > today() && next && next > current) return current;
  return next || current;
}

function notesFrom(payload) {
  const link = payload.payload?.payment_link?.entity || {};
  const payment = payload.payload?.payment?.entity || {};
  const sub = payload.payload?.subscription?.entity || {};
  const invoice = payload.payload?.invoice?.entity || {};
  return {
    ...(invoice.notes || {}),
    ...(payment.notes || {}),
    ...(link.notes || {}),
    ...(sub.notes || {}),
  };
}

function idsFromPayload(payload) {
  const notes = notesFrom(payload);
  const paymentEntity = payload.payload?.payment?.entity || {};
  const sub = payload.payload?.subscription?.entity || {};
  const invoice = payload.payload?.invoice?.entity || {};
  return {
    notes,
    cognitoId: notes.cognitoId || notes.memberId,
    paymentId: notes.paymentId,
    razorpayPaymentId: paymentEntity.id || invoice.payment_id,
    chargedPaise: paymentEntity.amount,
    feePaise: paymentEntity.fee,
    taxPaise: paymentEntity.tax,
    subscriptionId: sub.id || paymentEntity.subscription_id || invoice.subscription_id || notes.subscriptionId,
    durationDays: notes.durationDays,
    startDate: notes.startDate,
    currentEnd: sub.current_end || invoice.billing_end,
    chargeAt: sub.charge_at,
    billingEnd: invoice.billing_end,
    notesInstitution: notes.institution,
  };
}

async function findPayment({ cognitoId, paymentId, subscriptionId, institution }) {
  if (cognitoId && paymentId) {
    const row = await dynamo.getPayment(cognitoId, paymentId);
    if (row) return row;
  }
  if (cognitoId) {
    const rows = await dynamo.paymentsForMember(cognitoId);
    return rows.find((p) => subscriptionId && p.razorpaySubscriptionId === subscriptionId)
      || rows.find((p) => p.paymentId === paymentId)
      || rows.find((p) => String(p.paymentStatus) !== 'PAID')
      || rows[0]
      || null;
  }
  if (subscriptionId) {
    const all = await dynamo.listPayments(institution || dynamo.fallbackInstitution());
    return all.find((p) => p.razorpaySubscriptionId === subscriptionId) || null;
  }
  return null;
}

async function markPaid({
  cognitoId,
  paymentId,
  razorpayPaymentId,
  subscriptionId,
  durationDays,
  startDate,
  currentEnd,
  chargeAt,
  billingEnd,
  notesInstitution,
  chargedPaise,
  feePaise,
  taxPaise,
}) {
  let notes = {};
  let live = null;
  if (subscriptionId) {
    live = await fetchSubscription(subscriptionId);
    if (live?.notes) notes = live.notes;
    cognitoId = notes.cognitoId || notes.memberId || cognitoId;
    paymentId = paymentId || notes.paymentId;
    durationDays = durationDays || notes.durationDays;
    startDate = startDate || notes.startDate;
    notesInstitution = notesInstitution || notes.institution;
  }

  const existing = await findPayment({
    cognitoId,
    paymentId,
    subscriptionId,
    institution: notesInstitution,
  });
  const memberId = cognitoId || existing?.cognitoId;
  if (!memberId) return null;

  if (existing?.razorpayPaymentId && existing.razorpayPaymentId === razorpayPaymentId) {
    return { renewDate: existing.renewDate, paymentId: existing.paymentId };
  }

  const profile = await dynamo.getProfile(memberId, existing?.institution || notesInstitution);
  const days = Number(durationDays || existing?.durationDays || profile?.durationDays || 30);
  const cycleStart = startDate || notes.startDate || existing?.startDate || existing?.joinDate || profile?.joinDate || today();
  const alreadyPaid = existing && String(existing.paymentStatus) === 'PAID';
  const razorpayEnd = subscriptionEndDate(live, { currentEnd, chargeAt, billingEnd })
    || ymdFromUnix(currentEnd)
    || ymdFromUnix(billingEnd)
    || ymdFromUnix(chargeAt);
  const computedEnd = razorpayEnd
    || (alreadyPaid
      ? addPlanDuration(profile?.renewDate && profile.renewDate >= today() ? profile.renewDate : today(), days)
      : addPlanDuration(cycleStart, days));
  const paidRupees = Number(chargedPaise || 0) / 100;
  const reminderPay = String(notes.reason || '') === 'expiry-reminder';
  const prepaidStart = String(notes.prepaidStart || '') === '1';
  const fullRenewal = paidRupees >= 100 || reminderPay;
  const nextCycle = addPlanDuration(
    profile?.renewDate && profile.renewDate >= today() ? profile.renewDate : today(),
    days,
  );
  const membershipEnd = addPlanDuration(cycleStart, days);
  const renewDate = prepaidStart
    ? membershipEnd
    : reminderPay || (fullRenewal && !(razorpayEnd && razorpayEnd > today()))
      ? nextCycle
      : fullRenewal
        ? razorpayEnd
        : keepCurrentCycleEnd(profile?.renewDate, computedEnd);
  const renewDateSource = prepaidStart ? 'plan' : (razorpayEnd ? 'razorpay' : 'plan');
  const now = Date.now();
  const newCycle = existing && String(existing.paymentStatus) === 'PAID';
  const nextPayment = {
    ...(existing || {
      cognitoId: memberId,
      institution: notesInstitution || profile?.institution,
      memberId,
      paymentType: 'subscription',
      paymentMode: 'RAZORPAY',
      amount: Number(profile?.amount || existing?.amount || 0),
    }),
    paymentId: newCycle || !existing ? newId('pay') : existing.paymentId,
    paymentStatus: 'PAID',
    status: 'PAID',
    isVerified: true,
    razorpayPaymentId: razorpayPaymentId || existing?.razorpayPaymentId,
    razorpaySubscriptionId: subscriptionId || existing?.razorpaySubscriptionId,
    renewDate,
    renewDateSource,
    paidAt: now,
    paymentDate: now,
    updatedAt: now,
  };
  const payId = razorpayPaymentId || existing?.razorpayPaymentId;
  let livePay = null;
  if (payId && (chargedPaise == null || feePaise == null)) {
    livePay = await fetchPayment(payId);
  }
  const payNet = netFromRazorpayPayment(
    livePay || { amount: chargedPaise, fee: feePaise, tax: taxPaise },
    Number(nextPayment.amount || profile?.amount || 0),
  );
  if (payNet.grossAmount) {
    nextPayment.grossAmount = payNet.grossAmount;
    nextPayment.feeAmount = payNet.feeAmount;
    nextPayment.netAmount = payNet.netAmount;
    nextPayment.amount = payNet.netAmount;
  }
  await dynamo.putPayment(nextPayment);

  if (profile) {
    await dynamo.putProfile({
      ...profile,
      paymentStatus: 'PAID',
      paymentLinkUrl: '',
      paymentLinkId: '',
      renewDate,
      rePaymentDate: renewDate,
      renewDateSource,
      lastPaidAt: now,
      lastPaymentId: nextPayment.paymentId,
      razorpaySubscriptionId: subscriptionId || profile.razorpaySubscriptionId,
      subscriptionStatus: live ? (mapSubscriptionStatus(live.status) || profile.subscriptionStatus) : profile.subscriptionStatus,
      subscriptionStatusAt: Date.now(),
      billingResumeAt: '',
      deviceStart: profile.deviceStart || cycleStart,
      deviceEnd: renewDate,
      deviceEndPending: true,
      updatedAt: now,
      updatedAtIso: new Date(now).toISOString(),
    });
  }
  return { renewDate, paymentId: nextPayment.paymentId };
}

async function applySubscriptionStatus(profile, live) {
  if (!profile || !live) return profile;
  const status = mapSubscriptionStatus(live.status);
  if (!status) return profile;
  if (status === profile.subscriptionStatus && Date.now() - Number(profile.subscriptionStatusAt || 0) < 90_000) {
    return profile;
  }
  const next = {
    ...profile,
    subscriptionStatus: status,
    subscriptionStatusAt: Date.now(),
    razorpaySubscriptionId: live.id || profile.razorpaySubscriptionId,
  };
  const holdUntil = String(profile.billingResumeAt || '').slice(0, 10);
  if (status === 'PAUSED' && holdUntil && holdUntil >= today()) {
    next.subscriptionStatus = profile.subscriptionStatus === 'PAUSED' ? 'ACTIVE' : (profile.subscriptionStatus || 'ACTIVE');
    next.status = 'ACTIVE';
  }
  await dynamo.putProfile(next);
  return next;
}

async function saveSubscriptionStatus({ cognitoId, subscriptionId, institution, status }) {
  const mapped = mapSubscriptionStatus(status);
  let profile = cognitoId ? await dynamo.getProfile(cognitoId, institution) : null;
  if (!profile && subscriptionId) {
    const rows = await dynamo.listProfiles(institution || dynamo.fallbackInstitution());
    profile = rows.find((row) => row.razorpaySubscriptionId === subscriptionId) || null;
  }
  if (!profile) return null;
  if (!mapped) {
    const live = subscriptionId ? await fetchSubscription(subscriptionId) : null;
    return applySubscriptionStatus(profile, live);
  }
  const next = {
    ...profile,
    subscriptionStatus: mapped,
    subscriptionStatusAt: Date.now(),
    razorpaySubscriptionId: subscriptionId || profile.razorpaySubscriptionId,
  };
  const holdUntil = String(profile.billingResumeAt || '').slice(0, 10);
  if (mapped === 'PAUSED' && holdUntil && holdUntil >= today()) {
    next.subscriptionStatus = profile.subscriptionStatus === 'PAUSED' ? 'ACTIVE' : (profile.subscriptionStatus || 'ACTIVE');
    next.status = 'ACTIVE';
  }
  await dynamo.putProfile(next);
  return next;
}

async function refreshStaleSubscriptionStatuses(rows) {
  const stale = rows.filter((row) => {
    if (!row.razorpaySubscriptionId) return false;
    return Date.now() - Number(row.subscriptionStatusAt || 0) > 90_000;
  }).slice(0, 8);
  if (!stale.length) return rows;
  const updates = await Promise.all(stale.map(async (row) => {
    const live = await fetchSubscription(row.razorpaySubscriptionId);
    if (!live) return row;
    return applySubscriptionStatus(row, live);
  }));
  const byId = new Map(updates.filter(Boolean).map((row) => [row.cognitoId, row]));
  return rows.map((row) => byId.get(row.cognitoId) || row);
}

async function syncPendingProfile(profile) {
  const paid = String(profile?.paymentStatus || '').toUpperCase() === 'PAID';
  if (paid && profile?.renewDateSource === 'razorpay' && profile.renewDate) {
    if (!profile.razorpaySubscriptionId) return profile;
    const live = await fetchSubscription(profile.razorpaySubscriptionId);
    return applySubscriptionStatus(profile, live);
  }

  if (profile?.razorpaySubscriptionId) {
    const live = await fetchSubscription(profile.razorpaySubscriptionId);
    if (live && subscriptionIsPaid(live.status) && String(profile.paymentStatus || '').toUpperCase() !== 'PAID') {
      await markPaid({
        cognitoId: profile.cognitoId,
        paymentId: profile.lastPaymentId,
        subscriptionId: profile.razorpaySubscriptionId,
        durationDays: profile.durationDays || live.notes?.durationDays,
        startDate: profile.joinDate || live.notes?.startDate,
        notesInstitution: profile.institution,
        razorpayPaymentId: live.id,
      });
      profile = (await dynamo.getProfile(profile.cognitoId, profile.institution)) || profile;
    }
    profile = await applySubscriptionStatus(profile, live);
    const held = profile?.renewDateSource === 'extended' || profile?.billingResumeAt;
    const razorpayEnd = keepCurrentCycleEnd(profile?.renewDate, subscriptionEndDate(live));
    if (profile && !held && razorpayEnd && razorpayEnd !== profile.renewDate) {
      const now = Date.now();
      const next = {
        ...profile,
        renewDate: razorpayEnd,
        rePaymentDate: razorpayEnd,
        renewDateSource: 'razorpay',
        deviceEnd: razorpayEnd,
        deviceEndPending: true,
        updatedAt: now,
        updatedAtIso: new Date(now).toISOString(),
      };
      await dynamo.putProfile(next);
      return next;
    }
    return profile;
  }

  const repaired = repairCycleEnd(profile?.joinDate, profile?.renewDate || profile?.rePaymentDate, profile?.durationDays);
  if (profile && repaired && repaired !== profile.renewDate) {
    const now = Date.now();
    const next = {
      ...profile,
      renewDate: repaired,
      rePaymentDate: repaired,
      updatedAt: now,
      updatedAtIso: new Date(now).toISOString(),
    };
    await dynamo.putProfile(next);
    return next;
  }
  return profile;
}

async function syncPendingProfiles(rows) {
  return Promise.all(rows.map((row) => syncPendingProfile(row)));
}

module.exports = {
  notesFrom,
  idsFromPayload,
  markPaid,
  saveSubscriptionStatus,
  refreshStaleSubscriptionStatuses,
  syncPendingProfile,
  syncPendingProfiles,
};
