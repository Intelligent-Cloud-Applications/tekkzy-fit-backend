const Razorpay = require('razorpay');
const crypto = require('crypto');

const planCache = new Map();

function razorpayMode() {
  return String(process.env.RAZORPAY_MODE || 'test').toLowerCase() === 'live' ? 'live' : 'test';
}

function creds() {
  const live = razorpayMode() === 'live';
  const key_id = String(
    live
      ? (process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_LIVE_KEY_ID || '')
      : (process.env.RAZORPAY_TEST_KEY_ID || process.env.RAZORPAY_KEY_ID || ''),
  ).trim();
  const key_secret = String(
    live
      ? (process.env.RAZORPAY_SECRET_KEY || process.env.RAZORPAY_LIVE_SECRET_KEY || '')
      : (process.env.RAZORPAY_TEST_SECRET_KEY || process.env.RAZORPAY_SECRET_KEY || ''),
  ).trim();
  if (!key_id || !key_secret) throw new Error(live ? 'Razorpay live keys are not configured' : 'Razorpay test keys are not configured');
  if (live) {
    if (!key_id.startsWith('rzp_live_')) throw new Error('Live mode requires an rzp_live_ key');
  } else {
    if (key_id.startsWith('rzp_live_')) throw new Error('Live Razorpay keys are blocked on the test stage.');
    if (!key_id.startsWith('rzp_test_')) throw new Error('Razorpay test key id must start with rzp_test_');
  }
  return { key_id, key_secret };
}

function client() {
  return new Razorpay(creds());
}

function indiaPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (String(raw || '').startsWith('+') && digits.length >= 10) return `+${digits}`;
  return digits ? `+91${digits.slice(-10)}` : '';
}

function validEmail(raw) {
  const email = String(raw || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function hostedPayUrl(sub) {
  const url = String(typeof sub === 'string' ? sub : (sub?.short_url || '')).trim();
  if (/^https?:\/\//i.test(url) && !/api\.razorpay\.com/i.test(url)) return url;
  return '';
}

function sanitizeNotes(notes) {
  const safeNotes = {};
  for (const [key, value] of Object.entries({ ...(notes || {}), env: razorpayMode() })) {
    if (value == null || value === '') continue;
    safeNotes[String(key).slice(0, 15)] = String(value).slice(0, 256);
  }
  return safeNotes;
}

async function notifySubscriptionLink(subId) {
  if (!subId) return;
  try {
    const listed = await client().invoices.all({ subscription_id: subId, count: 5 });
    const invoice = (listed.items || []).find((row) => row?.id);
    if (!invoice?.id) return;
    await Promise.allSettled([
      client().invoices.notifyBy(invoice.id, 'sms'),
      client().invoices.notifyBy(invoice.id, 'email'),
    ]);
  } catch (err) {
    console.error('razorpay notify failed', razorpayMessage(err));
  }
}

async function createHostedSubscriptionLink({
  planId,
  totalCount,
  quantity = 1,
  startAt,
  expireBy,
  notes,
  phone,
  email,
  addons,
}) {
  const contact = indiaPhone(phone);
  const mail = validEmail(email);
  if (!contact) throw new Error('A valid phone number is required to send the subscription link');
  if (!mail) throw new Error('A valid email is required to send the subscription link');
  const now = Math.floor(Date.now() / 1000);
  const authUntil = Math.max(now + 30 * 24 * 60 * 60, Number(startAt || 0) + 24 * 60 * 60);
  let created = await client().subscriptions.create({
    plan_id: planId,
    total_count: Math.max(1, Number(totalCount || 24)),
    quantity: Math.max(1, Number(quantity || 1)),
    customer_notify: true,
    expire_by: expireBy || authUntil,
    notes: sanitizeNotes(notes),
    notify_info: {
      notify_phone: contact,
      notify_email: mail,
    },
    ...(startAt ? { start_at: startAt } : {}),
    ...(addons ? { addons } : {}),
  });
  if (!hostedPayUrl(created) && created?.id) {
    created = await fetchSubscription(created.id) || created;
  }
  const url = hostedPayUrl(created);
  if (!url) throw new Error('Razorpay did not return a hosted pay page');
  created.short_url = url;
  await notifySubscriptionLink(created.id);
  return created;
}

function periodFromDays(days) {
  const n = Number(days || 30);
  if (n >= 330) return { period: 'yearly', interval: 1, totalCount: 5 };
  if (n >= 150) return { period: 'monthly', interval: 6, totalCount: 8 };
  if (n >= 75) return { period: 'monthly', interval: 3, totalCount: 12 };
  return { period: 'monthly', interval: 1, totalCount: 24 };
}

function cycleFromPlan({ durationDays, period, interval }) {
  if (period && interval) {
    const n = Math.max(1, Number(interval) || 1);
    const totalCount = period === 'yearly' ? 5 : period === 'monthly' && n >= 6 ? 8 : period === 'monthly' && n >= 3 ? 12 : 24;
    return { period, interval: n, totalCount };
  }
  return periodFromDays(durationDays);
}

async function ensureRazorpayPlan({ gymPlanId, name, amount, durationDays, period, interval }) {
  const rupees = Number(amount);
  const paise = Math.round(rupees * 100);
  const cycle = cycleFromPlan({ durationDays, period, interval });
  const cacheKey = `${gymPlanId || name}:${paise}:${cycle.period}:${cycle.interval}`;
  if (planCache.has(cacheKey)) return { planId: planCache.get(cacheKey), ...cycle };

  const rzp = client();
  const listed = await rzp.plans.all({ count: 100 }).catch(() => ({ items: [] }));
  const match = (listed.items || []).find((row) => {
    const notes = row.notes || {};
    const itemAmount = Number(row.item?.amount);
    return (
      itemAmount === paise
      && row.period === cycle.period
      && Number(row.interval) === cycle.interval
      && (notes.gymPlanId === gymPlanId || notes.name === name)
    );
  });
  if (match?.id) {
    planCache.set(cacheKey, match.id);
    return { planId: match.id, ...cycle };
  }

  try {
    const created = await rzp.plans.create({
      period: cycle.period,
      interval: cycle.interval,
      item: {
        name: `Tekkzy Fit · ${name || 'Membership'}`,
        amount: paise,
        currency: 'INR',
        description: `${name || 'Membership'} gym subscription (${razorpayMode()})`,
      },
      notes: {
        gymPlanId: String(gymPlanId || ''),
        name: String(name || ''),
        env: razorpayMode(),
      },
    });
    planCache.set(cacheKey, created.id);
    return { planId: created.id, ...cycle };
  } catch (err) {
    throw new Error(razorpayMessage(err));
  }
}

async function ensureCustomer({ name, phone, email }) {
  const rzp = client();
  return rzp.customers.create({
    name: name || 'Member',
    contact: phone,
    email,
    fail_existing: 0,
    notes: { env: razorpayMode() },
  });
}

function startAtUnix(startDate) {
  const day = String(startDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const start = new Date(`${day}T10:00:00+05:30`);
  if (Number.isNaN(start.getTime())) return undefined;
  const earliest = Date.now() + 20 * 60 * 1000;
  // Razorpay only accepts start_at ~20 minutes ahead. If 10:00 IST on that
  // day is already too soon (typical when start date is today), omit start_at
  // so the member can pay now instead of blocking Add member.
  if (start.getTime() <= earliest) return undefined;
  return Math.floor(start.getTime() / 1000);
}

function futureChargeUnix(startDate) {
  const day = String(startDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const start = new Date(`${day}T10:00:00+05:30`);
  if (Number.isNaN(start.getTime())) return undefined;
  const earliest = Date.now() + 21 * 60 * 1000;
  return Math.floor(Math.max(start.getTime(), earliest) / 1000);
}

function isUpiLockedError(err) {
  return /upi|emandate|payment mode/i.test(String(err?.message || err || ''));
}

async function updateSubscriptionStart(id, ymd) {
  const startAt = futureChargeUnix(ymd);
  if (!startAt) throw new Error('New due date must be a valid future date');
  try {
    return await client().subscriptions.update(id, {
      start_at: startAt,
      schedule_change_at: 'now',
      customer_notify: true,
    });
  } catch (err) {
    throw new Error(razorpayMessage(err));
  }
}

async function cancelSubscription(id, live) {
  if (!id) return null;
  const status = String(live?.status || '').toLowerCase();
  const ended = (row) => ['cancelled', 'canceled', 'completed', 'expired'].includes(String(row?.status || '').toLowerCase());
  async function send(params) {
    return params
      ? client().subscriptions.cancel(id, params)
      : client().subscriptions.cancel(id);
  }
  try {
    if (status === 'active') return await send({ cancel_at_cycle_end: 0 });
    return await send();
  } catch (err) {
    const now = await fetchSubscription(id);
    if (ended(now)) return now;
    try {
      const retry = await send();
      if (ended(retry) || retry) return retry;
    } catch {
      /* fall through */
    }
    throw new Error(razorpayMessage(err));
  }
}

async function firstCycleAddon(live, notify = {}) {
  let rupees = Number(notify.amount || 0);
  if (!(rupees > 0) && live?.plan_id) {
    try {
      const plan = await client().plans.fetch(live.plan_id);
      rupees = Number(plan.item?.amount || 0) / 100;
    } catch {
      rupees = 0;
    }
  }
  if (!(rupees > 0)) return undefined;
  return [{
    item: {
      name: notify.planName || 'First cycle',
      amount: Math.round(rupees * 100),
      currency: 'INR',
      description: `Plan ₹${rupees} charged today`,
    },
  }];
}

async function recreateSubscriptionAt(live, ymd, notify = {}) {
  const startAt = futureChargeUnix(ymd);
  if (!startAt) throw new Error('New due date must be a valid future date');
  if (!live?.plan_id) throw new Error('Razorpay plan is missing on this subscription');
  const remaining = Math.max(1, Number(live.remaining_count || live.total_count || 24));
  const notes = live.notes && typeof live.notes === 'object' ? live.notes : {};
  const status = String(live.status || '').toLowerCase();
  const ended = ['cancelled', 'canceled', 'completed', 'expired'].includes(status);
  const created = await createHostedSubscriptionLink({
    planId: live.plan_id,
    totalCount: remaining,
    quantity: live.quantity,
    startAt,
    notes,
    phone: notify.phone,
    email: notify.email,
    addons: await firstCycleAddon(live, notify),
  });
  if (!ended && created?.id && created.id !== live.id) {
    try {
      if (['authenticated', 'created', 'pending'].includes(status)) {
        try {
          await pauseSubscription(live.id);
        } catch {
          await cancelSubscription(live.id, live);
        }
      } else {
        await cancelSubscription(live.id, live);
      }
    } catch (err) {
      console.error('old subscription still live after replace', live.id, razorpayMessage(err));
    }
  }
  return created;
}

async function deferUpiCharge(live, ymd, notify) {
  const status = String(live.status || '').toLowerCase();
  if (status === 'paused') return { live, deferred: true };
  if (status === 'active') {
    try {
      const paused = await pauseSubscription(live.id);
      return { live: paused || await fetchSubscription(live.id), deferred: true };
    } catch (err) {
      console.error('upi pause failed, recreating subscription', razorpayMessage(err));
    }
  }
  try {
    const created = await recreateSubscriptionAt(live, ymd, notify);
    return { live: created, deferred: false, replaced: true };
  } catch (err) {
    throw new Error(
      `Could not move the UPI auto-pay date. ${razorpayMessage(err)}`,
    );
  }
}

async function deferSubscriptionCharge(id, ymd, notify) {
  const live = await fetchSubscription(id);
  if (!live) throw new Error('No Razorpay subscription on this member');
  const status = String(live.status || '').toLowerCase();
  if (['created', 'pending'].includes(status)) {
    return deferUpiCharge(live, ymd, notify);
  }
  const method = String(live.payment_method || live.method || '').toLowerCase();
  if (method.includes('upi') || method.includes('emandate') || ['cancelled', 'canceled', 'completed', 'expired'].includes(status)) {
    return deferUpiCharge(live, ymd, notify);
  }
  try {
    return { live: await updateSubscriptionStart(id, ymd), deferred: false };
  } catch (err) {
    if (isUpiLockedError(err) || status === 'active' || status === 'paused' || status === 'authenticated') {
      return deferUpiCharge(live, ymd, notify);
    }
    throw err instanceof Error ? err : new Error('Razorpay could not move the next charge date');
  }
}

async function createSubscription({
  amount,
  addonAmount,
  name,
  phone,
  email,
  description,
  notes,
  planId: gymPlanId,
  planName,
  durationDays,
  period,
  interval,
  startDate,
  customerNotify = true,
  addonName,
  addonDescription,
}) {
  const contact = indiaPhone(phone);
  const mail = validEmail(email);
  if (!contact) throw new Error('A valid phone number is required to send the subscription link');
  if (!mail) throw new Error('A valid email is required to send the subscription link');
  const rupees = Number(amount);
  if (!Number.isFinite(rupees) || rupees <= 0) throw new Error('Amount must be greater than 0');

  const plan = await ensureRazorpayPlan({
    gymPlanId,
    name: planName || description || 'Membership',
    amount: rupees,
    durationDays,
    period,
    interval,
  });
  const startAt = startAtUnix(startDate);
  const expireBy = Math.max(
    Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    (startAt || 0) + 24 * 60 * 60,
  );
  const addonRupees = Number(addonAmount || 0);
  const addons = addonRupees > 0
    ? [{
        item: {
          name: addonName || 'Admission fee',
          amount: Math.round(addonRupees * 100),
          currency: 'INR',
          description: addonDescription || 'One-time admission / joining fee',
        },
      }]
    : undefined;
  const sub = await createHostedSubscriptionLink({
    planId: plan.planId,
    totalCount: plan.totalCount,
    quantity: 1,
    startAt,
    expireBy,
    notes,
    phone,
    email,
    addons,
  });
  const url = hostedPayUrl(sub);
  if (startAt && !sub.start_at && !sub.charge_at) {
    throw new Error('Razorpay did not schedule the next due date');
  }

  return {
    paymentLinkUrl: url,
    subscriptionId: sub.id,
    razorpayPlanId: plan.planId,
    razorpayCustomerId: '',
    status: String(sub.status || 'created').toUpperCase(),
    startAt: sub.start_at || startAt,
    chargeAt: sub.charge_at || startAt,
  };
}

function mapSubscriptionStatus(status) {
  const s = String(status || '').toLowerCase();
  if (['paused', 'halted'].includes(s)) return 'PAUSED';
  if (['cancelled', 'canceled', 'completed', 'expired'].includes(s)) return 'CANCELLED';
  if (['active', 'authenticated'].includes(s)) return 'ACTIVE';
  if (['created', 'pending'].includes(s)) return 'PENDING';
  return '';
}

function subscriptionIsPaid(status) {
  return ['active', 'authenticated', 'completed', 'charged'].includes(String(status || '').toLowerCase());
}

function ymdFromUnix(unix) {
  const n = Number(unix);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(n * 1000));
}

function subscriptionEndDate(sub, extra = {}) {
  return ymdFromUnix(sub?.current_end)
    || ymdFromUnix(extra.currentEnd)
    || ymdFromUnix(extra.billingEnd)
    || ymdFromUnix(sub?.charge_at)
    || ymdFromUnix(extra.chargeAt)
    || ymdFromUnix(sub?.end_at)
    || '';
}

async function fetchSubscription(id) {
  if (!id) return null;
  try {
    return await client().subscriptions.fetch(id);
  } catch {
    return null;
  }
}

async function fetchPayment(id) {
  if (!id) return null;
  try {
    return await client().payments.fetch(id);
  } catch {
    return null;
  }
}

function netFromRazorpayPayment(pay, fallbackRupees = 0) {
  const amountPaise = Number(pay?.amount ?? Math.round(Number(fallbackRupees || 0) * 100));
  const fee = Number(pay?.fee || 0);
  const tax = Number(pay?.tax || 0);
  const netPaise = Math.max(0, amountPaise - fee - tax);
  return {
    grossAmount: amountPaise / 100,
    feeAmount: (fee + tax) / 100,
    netAmount: netPaise / 100,
  };
}

function razorpayMessage(err) {
  if (!err) return 'Razorpay request failed';
  if (typeof err === 'string') return err;
  return err.error?.description || err.error?.reason || err.description || err.message || 'Razorpay request failed';
}

async function pauseSubscription(id) {
  if (!id) throw new Error('No Razorpay subscription on this member');
  try {
    return await client().subscriptions.pause(id, { pause_at: 'now' });
  } catch (err) {
    const live = await fetchSubscription(id);
    if (['paused', 'halted'].includes(String(live?.status || '').toLowerCase())) return live;
    throw new Error(razorpayMessage(err));
  }
}

async function resumeSubscription(id) {
  if (!id) throw new Error('No Razorpay subscription on this member');
  try {
    return await client().subscriptions.resume(id, { resume_at: 'now' });
  } catch (err) {
    const live = await fetchSubscription(id);
    if (['active', 'authenticated'].includes(String(live?.status || '').toLowerCase())) return live;
    throw new Error(razorpayMessage(err));
  }
}

function verifyWebhook(raw, signature) {
  const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  if (!secret || !signature) return false;
  const digest = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

module.exports = {
  client,
  creds,
  indiaPhone,
  createSubscription,
  createPaymentLink: createSubscription,
  ensureRazorpayPlan,
  fetchSubscription,
  fetchPayment,
  netFromRazorpayPayment,
  pauseSubscription,
  resumeSubscription,
  deferSubscriptionCharge,
  hostedPayUrl,
  mapSubscriptionStatus,
  subscriptionIsPaid,
  subscriptionEndDate,
  ymdFromUnix,
  verifyWebhook,
};
