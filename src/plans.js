const { json, parseBody, requireGymKey, pathId, method, institutionFrom } = require('./http');
const dynamo = require('./dynamo');
const { ensureRazorpayPlan } = require('./razorpay');

function rupeesFrom(row) {
  if (row?.price != null && row.price !== '') return Number(row.price);
  if (row?.amount != null && row.amount !== '') return Number(row.amount) / 100;
  return 0;
}

function daysFrom(row) {
  if (row?.durationDays != null && row.durationDays !== '') return Number(row.durationDays);
  const ms = Number(row?.duration || 0);
  if (ms > 0) return Math.max(1, Math.round(ms / 86_400_000));
  return 30;
}

function razorpayIdFrom(row) {
  if (row?.razorpayPlanId) return String(row.razorpayPlanId);
  const id = String(row?.planId || '');
  return id.startsWith('plan_') ? id : '';
}

function toPlan(row) {
  const durationDays = daysFrom(row);
  return {
    id: row.productId || row.gymPlanId || String(row.cognitoId || '').replace(/^__plan_/, '') || row.planId,
    name: row.name || row.heading || '',
    durationDays,
    durationLabel: row.durationLabel || row.durationText || `${durationDays} days`,
    price: rupeesFrom(row),
    addonAmount: Number(row.addonAmount || 0),
    description: row.description || '',
    accessType: row.accessType || 'ALL_HOURS',
    status: row.status || (row.planStatus === false ? 'INACTIVE' : 'ACTIVE'),
    billingPeriod: row.billingPeriod || row.subscriptionType || '',
    billingInterval: Number(row.billingInterval || row.interval || 0) || undefined,
    razorpayPlanId: razorpayIdFrom(row),
    createdAt: row.createdAt || new Date().toISOString(),
  };
}

async function attachRazorpayPlan(row) {
  if (Number(row.price) <= 0) {
    throw new Error('Plan price must be greater than 0 to create it in Razorpay.');
  }
  const rzp = await ensureRazorpayPlan({
    gymPlanId: row.productId,
    name: row.name || row.heading,
    amount: row.price,
    durationDays: row.durationDays,
    period: row.billingPeriod,
    interval: row.billingInterval,
  });
  return { ...row, razorpayPlanId: rzp.planId, planId: rzp.planId };
}

function fromPlan(institution, body, existing) {
  const id = String(body.id || existing?.productId || '').trim();
  if (!id) throw new Error('Plan id is required');
  const name = String(body.name ?? existing?.name ?? existing?.heading ?? '').trim();
  if (!name) throw new Error('Plan name is required');
  const durationDays = Number(body.durationDays ?? existing?.durationDays ?? daysFrom(existing) ?? 30);
  const price = Number(body.price ?? existing?.price ?? rupeesFrom(existing) ?? 0);
  const label = body.durationLabel || existing?.durationLabel || existing?.durationText || `${durationDays} days`;
  const status = body.status || existing?.status || 'ACTIVE';
  const billingPeriod = body.billingPeriod || existing?.billingPeriod || existing?.subscriptionType || '';
  const billingInterval = Number(body.billingInterval ?? existing?.billingInterval ?? existing?.interval ?? 0) || undefined;
  const razorpayPlanId = body.razorpayPlanId || razorpayIdFrom(existing);
  return {
    institution,
    productId: id,
    heading: name,
    name,
    amount: Math.round(price * 100),
    price,
    currency: existing?.currency || 'INR',
    country: existing?.country || 'IN',
    india: existing?.india != null ? existing.india : true,
    duration: durationDays * 86_400_000,
    durationDays,
    durationText: label,
    durationLabel: label,
    addonAmount: Number(body.addonAmount ?? existing?.addonAmount ?? 0),
    description: String(body.description ?? existing?.description ?? ''),
    accessType: body.accessType || existing?.accessType || 'ALL_HOURS',
    status,
    planStatus: status === 'ACTIVE',
    billingPeriod,
    subscriptionType: billingPeriod || 'monthly',
    billingInterval,
    interval: billingInterval || 1,
    razorpayPlanId,
    planId: razorpayPlanId || existing?.planId || '',
    institutionType: existing?.institutionType || 'gym',
    createdAt: existing?.createdAt || body.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

exports.handler = async (event) => {
  if (method(event) === 'OPTIONS') return json(200, { ok: true });
  if (!requireGymKey(event)) return json(401, { error: 'Unauthorized' });

  try {
    const verb = method(event);
    const id = pathId(event);
    const body = verb === 'GET' || verb === 'DELETE' ? {} : parseBody(event);
    const institution = institutionFrom(event, body);

    if (verb === 'GET' && !id) {
      const rows = await dynamo.listPlans(institution);
      return json(200, rows.map(toPlan).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
    }

    if (verb === 'GET' && id) {
      const row = await dynamo.getPlan(institution, id);
      if (!row) return json(404, { error: 'Plan not found' });
      return json(200, toPlan(row));
    }

    if (verb === 'POST' || ((verb === 'PUT' || verb === 'PATCH') && id)) {
      const existing = id ? await dynamo.getPlan(institution, id) : await dynamo.getPlan(institution, body.id);
      const drafted = fromPlan(institution, { ...body, id: id || body.id }, existing);
      const saved = await dynamo.putPlan(await attachRazorpayPlan(drafted));
      return json(existing ? 200 : 201, toPlan(saved));
    }

    if (verb === 'DELETE' && id) {
      await dynamo.deletePlan(institution, id);
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('plans', err);
    return json(500, { error: err instanceof Error ? err.message : 'Server error' });
  }
};
