const fs = require('node:fs');
const path = require('node:path');
const Razorpay = require('razorpay');

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
  const key_id = String(process.env.RAZORPAY_TEST_KEY_ID || '').trim();
  const key_secret = String(process.env.RAZORPAY_TEST_SECRET_KEY || '').trim();
  if (!key_id.startsWith('rzp_test_') || !key_secret) {
    throw new Error('Test keys missing');
  }
  const rzp = new Razorpay({ key_id, key_secret });
  const listed = await rzp.subscriptions.all({ count: 20 });
  const items = listed.items || [];
  for (const s of items) {
    console.log(JSON.stringify({
      id: s.id,
      status: s.status,
      paid_count: s.paid_count,
      charge_at: s.charge_at ? new Date(s.charge_at * 1000).toISOString() : null,
      created_at: s.created_at ? new Date(s.created_at * 1000).toISOString() : null,
      notes: s.notes || {},
    }));
  }
  console.log('count', items.length);
}

main().catch((err) => {
  const body = err?.error || err?.message || err;
  console.error(typeof body === 'string' ? body : JSON.stringify(body));
  process.exit(1);
});
