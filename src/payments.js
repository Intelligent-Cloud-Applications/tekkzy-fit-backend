const { json, parseBody, requireGymKey, pathId, method, institutionFrom } = require('./http');
const dynamo = require('./dynamo');
const { createSubscription, mapSubscriptionStatus } = require('./razorpay');
const { toPayment, paymentItem, newId } = require('./map');

exports.handler = async (event) => {
  if (method(event) === 'OPTIONS') return json(200, { ok: true });
  if (!requireGymKey(event)) return json(401, { error: 'Unauthorized' });

  try {
    const verb = method(event);
    const id = pathId(event);
    const body = verb === 'POST' ? parseBody(event) : {};
    const institution = institutionFrom(event, body);

    if (verb === 'GET' && !id) {
      const memberId = event.queryStringParameters?.memberId;
      const rows = memberId ? await dynamo.paymentsForMember(memberId) : await dynamo.listPayments(institution);
      return json(200, rows.map(toPayment));
    }

    if (verb === 'GET' && id) {
      const memberId = event.queryStringParameters?.memberId;
      if (memberId) {
        const row = await dynamo.getPayment(memberId, id);
        if (!row) return json(404, { error: 'Payment not found' });
        return json(200, toPayment(row));
      }
      const all = await dynamo.listPayments(institution);
      const row = all.find((p) =>
        p.paymentId === id
        || p.paymentCode === id
        || p.razorpayPaymentId === id
        || p.razorpaySubscriptionId === id
        || p.razorpayPaymentLinkId === id
      );
      if (!row) return json(404, { error: 'Payment not found' });
      return json(200, toPayment(row));
    }

    if (verb === 'POST') {
      const memberId = body.memberId || body.cognitoId;
      if (!memberId) return json(400, { error: 'memberId is required' });
      const profile = await dynamo.getProfile(memberId, institution);
      if (!profile) return json(404, { error: 'Member not found' });
      if (!profile.phoneNumber) return json(400, { error: 'Member phone is required to send the payment link' });
      if (!profile.emailId) return json(400, { error: 'Member email is required to send the payment link' });
      const amount = Number(body.amount ?? profile.amount);
      const durationDays = Number(body.durationDays ?? profile.durationDays ?? 30);
      const paymentId = newId('pay');
      const link = await createSubscription({
        amount,
        name: profile.userName,
        phone: profile.phoneNumber,
        email: profile.emailId,
        description: `${body.planName || profile.planName || 'Membership'} · Tekkzy Fit`,
        planId: body.planId || profile.planId,
        planName: body.planName || profile.planName,
        durationDays,
        startDate: body.startDate || profile.joinDate,
        notes: {
          institution,
          memberId: profile.memberId || profile.cognitoId,
          cognitoId: profile.cognitoId,
          paymentId,
          planId: String(body.planId || profile.planId || ''),
          durationDays: String(durationDays),
          startDate: String(body.startDate || profile.joinDate || ''),
        },
      });
      const payment = paymentItem({
        profile,
        planId: body.planId || profile.planId,
        planName: body.planName || profile.planName,
        amount,
        durationDays,
        link,
        paymentId,
      });
      await dynamo.putPayment(payment);
      await dynamo.putProfile({
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
      });
      return json(201, toPayment(payment));
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('payments', err);
    return json(500, { error: err instanceof Error ? err.message : 'Server error' });
  }
};
