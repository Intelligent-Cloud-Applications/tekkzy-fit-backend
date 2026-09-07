const { json, parseBody, rawBody, header, method } = require('./http');
const { verifyWebhook } = require('./razorpay');
const { idsFromPayload, markPaid, saveSubscriptionStatus } = require('./syncPay');

const PAID_EVENTS = new Set([
  'subscription.charged',
  'subscription.activated',
  'subscription.authenticated',
  'invoice.paid',
  'payment.captured',
  'payment_link.paid',
]);

const SUB_STATUS_EVENTS = new Set([
  'subscription.paused',
  'subscription.resumed',
  'subscription.cancelled',
  'subscription.halted',
  'subscription.activated',
  'subscription.pending',
  'subscription.completed',
  'subscription.expired',
  'subscription.updated',
  'subscription.authenticated',
]);

exports.handler = async (event) => {
  const verb = method(event);
  if (verb === 'OPTIONS' || verb === 'GET' || verb === 'HEAD') {
    return json(200, { ok: true, mode: 'test' });
  }
  const raw = rawBody(event);
  const signature = header(event, 'x-razorpay-signature');
  if (!verifyWebhook(raw, signature)) {
    return json(400, { error: 'Invalid webhook signature' });
  }

  try {
    const payload = parseBody(event);
    const eventName = String(payload.event || '');
    const ids = idsFromPayload(payload);
    const subStatus = payload.payload?.subscription?.entity?.status;
    const paidEvent = PAID_EVENTS.has(eventName) || eventName.includes('paid') || eventName.endsWith('.charged');
    const statusEvent = SUB_STATUS_EVENTS.has(eventName) || Boolean(subStatus);

    if (!paidEvent && !statusEvent) {
      return json(200, { ok: true, ignored: eventName });
    }

    let result = {};
    if (statusEvent) {
      const saved = await saveSubscriptionStatus({
        ...ids,
        status: subStatus,
        institution: ids.notesInstitution,
      });
      result = { subscriptionStatus: saved?.subscriptionStatus };
    }
    if (paidEvent) {
      result = { ...result, ...(await markPaid(ids)) };
    }
    return json(200, { ok: true, event: eventName, ...result });
  } catch (err) {
    console.error('webhook', err);
    return json(500, { error: err instanceof Error ? err.message : 'Webhook failed' });
  }
};
