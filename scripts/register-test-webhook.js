const fs = require('node:fs');
const path = require('node:path');
const Razorpay = require('razorpay');

const WEBHOOK_URL = 'https://g87iwuddyc.execute-api.us-east-2.amazonaws.com/dev/webhooks/razorpay';
const EVENTS = {
  'payment.captured': true,
  'payment.authorized': true,
  'payment_link.paid': true,
  'subscription.authenticated': true,
  'subscription.activated': true,
  'subscription.charged': true,
  'invoice.paid': true,
};

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

function publicWebhook(row) {
  return {
    id: row.id,
    url: row.url,
    active: row.active,
    events: row.events,
    created_at: row.created_at,
  };
}

async function main() {
  loadEnv();
  const key_id = String(process.env.RAZORPAY_TEST_KEY_ID || '').trim();
  const key_secret = String(process.env.RAZORPAY_TEST_SECRET_KEY || '').trim();
  const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  if (!key_id.startsWith('rzp_test_') || !key_secret || !secret) {
    throw new Error('Test key id, test secret, and webhook secret must be set in cloud/.env');
  }

  const rzp = new Razorpay({ key_id, key_secret });
  const listed = await rzp.webhooks.all({ count: 50 });
  const items = listed.items || listed.webhooks || (Array.isArray(listed) ? listed : []);
  const existing = items.find((row) => row.url === WEBHOOK_URL);

  const payload = {
    url: WEBHOOK_URL,
    alert_email: 'admin@gymaccess.in',
    secret,
    events: EVENTS,
  };

  const row = existing
    ? await rzp.webhooks.edit(payload, existing.id)
    : await rzp.webhooks.create(payload);

  console.log(existing ? 'updated' : 'created', JSON.stringify(publicWebhook(row)));
}

main().catch((err) => {
  const body = err?.error || err?.message || err;
  console.error(typeof body === 'string' ? body : JSON.stringify(body));
  process.exit(1);
});
