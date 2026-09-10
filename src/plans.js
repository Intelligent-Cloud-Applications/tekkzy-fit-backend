const { json, parseBody, requireGymKey, pathId, method, institutionFrom } = require('./http');
const dynamo = require('./dynamo');
const { ensureRazorpayPlan } = require('./razorpay');

function toPlan(row) {
  const durationDays = Number(row.durationDays || 30);
  return {
    id: row.planId || String(row.cognitoId || '').replace(/^__plan_/, ''),
    name: row.name || '',
    durationDays,
    durationLabel: row.durationLabel || `${durationDays} days`,
    price: Number(row.price || 0),
    addonAmount: Number(row.addonAmount || 0),
    description: row.description || '',
    accessType: row.accessType || 'ALL_HOURS',
    status: row.status || 'ACTIVE',
    billingPeriod: row.billingPeriod || '',
    billingInterval: Number(row.billingInterval || 0) || undefined,
    razorpayPlanId: row.razorpayPlanId || '',
    createdAt: row.createdAt || new Date().toISOString(),
  };
}

async function attachRazorpayPlan(row) {
  if (Number(row.price) <= 0) {
    throw new Error('Plan price must be greater than 0 to create it in Razorpay.');
  }
  const rzp = await ensureRazorpayPlan({
    gymPlanId: row.planId,
    name: row.name,
    amount: row.price,
    durationDays: row.durationDays,
    period: row.billingPeriod,
    interval: row.billingInterval,
  });
  return { ...row, razorpayPlanId: rzp.planId };
}

function fromPlan(institution, body, existing) {
  const id = String(body.id || existing?.planId || '').trim();
  if (!id) throw new Error('Plan id is required');
  const name = String(body.name ?? existing?.name ?? '').trim();
  if (!name) throw new Error('Plan name is required');
  const durationDays = Number(body.durationDays ?? existing?.durationDays ?? 30);
  return {
    institution,
    cognitoId: `${dynamo.PLAN_PREFIX}${id}`,
    userType: 'plan',
    planId: id,
    name,
    durationDays,
    durationLabel: body.durationLabel || existing?.durationLabel || `${durationDays} days`,
    price: Number(body.price ?? existing?.price ?? 0),
    addonAmount: Number(body.addonAmount ?? existing?.addonAmount ?? 0),
    description: String(body.description ?? existing?.description ?? ''),
    accessType: body.accessType || existing?.accessType || 'ALL_HOURS',
    status: body.status || existing?.status || 'ACTIVE',
    billingPeriod: body.billingPeriod || existing?.billingPeriod || '',
    billingInterval: Number(body.billingInterval ?? existing?.billingInterval ?? 0) || undefined,
    razorpayPlanId: body.razorpayPlanId || existing?.razorpayPlanId || '',
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
