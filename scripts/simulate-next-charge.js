const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Razorpay = require('razorpay');

const WEBHOOK_URL = 'https://g87iwuddyc.execute-api.us-east-2.amazonaws.com/dev/webhooks/razorpay';

function loadEnv() {
  const file = path.join(__dirname, '..', '.env');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

async function main() {
  loadEnv();
  const subscriptionId = String(process.argv[2] || '').trim();
  if (!subscriptionId.startsWith('sub_')) {
    throw new Error('Usage: node scripts/simulate-next-charge.js sub_XXXXXXXX');
  }

  const key_id = String(process.env.RAZORPAY_TEST_KEY_ID || '').trim();
  const key_secret = String(process.env.RAZORPAY_TEST_SECRET_KEY || '').trim();
  const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  if (!key_id.startsWith('rzp_test_') || !key_secret || !secret) {
    throw new Error('Test key id, test secret, and webhook secret must be set in cloud/.env');
  }

  const rzp = new Razorpay({ key_id, key_secret });
  const sub = await rzp.subscriptions.fetch(subscriptionId);
  const notes = sub.notes || {};
  if (!notes.memberId && !notes.cognitoId) {
    throw new Error('Subscription has no member notes. The gym record would not update.');
  }

  const paymentId = `pay_sim_${Date.now().toString(36)}`;
  const payload = {
    entity: 'event',
    event: 'subscription.charged',
    payload: {
      subscription: {
        entity: {
          id: sub.id,
          entity: 'subscription',
          status: sub.status,
          plan_id: sub.plan_id,
          paid_count: Number(sub.paid_count || 0) + 1,
          total_count: sub.total_count,
          remaining_count: Math.max(0, Number(sub.remaining_count || 0) - 1),
          notes,
        },
      },
      payment: {
        entity: {
          id: paymentId,
          entity: 'payment',
          status: 'captured',
          amount: Number(sub.plan_id ? 0 : 0),
          currency: 'INR',
          method: 'card',
          subscription_id: sub.id,
          notes,
        },
      },
    },
  };

  const raw = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': signature,
    },
    body: raw,
  });
  const body = await res.text();
  console.log(JSON.stringify({
    http: res.status,
    subscriptionId: sub.id,
    memberId: notes.memberId || notes.cognitoId,
    simulatedPaymentId: paymentId,
    webhook: (() => {
      try { return JSON.parse(body); } catch { return body; }
    })(),
  }));
}

main().catch((err) => {
  const body = err?.error || err?.message || err;
  console.error(typeof body === 'string' ? body : JSON.stringify(body));
  process.exit(1);
});
