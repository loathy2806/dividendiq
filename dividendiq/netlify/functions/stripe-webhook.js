/**
 * DividendIQ — Stripe Webhook Handler
 * Verarbeitet: checkout.session.completed, customer.subscription.deleted
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// Update user plan in Supabase Auth
async function updateUserPlan(email, plan) {
  // Find user by email
  const searchRes = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  const searchData = await searchRes.json();
  const user = searchData?.users?.[0];
  if (!user) {
    console.error('User not found for email:', email);
    return false;
  }

  // Update user metadata
  const updateRes = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users/${user.id}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
      body: JSON.stringify({
        user_metadata: { ...user.user_metadata, plan },
      }),
    }
  );
  return updateRes.ok;
}

// Verify Stripe webhook signature
async function verifyStripeSignature(body, signature, secret) {
  const encoder = new TextEncoder();
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const v1 = parts.find(p => p.startsWith('v1='))?.slice(3);
  if (!timestamp || !v1) return false;

  const payload = `${timestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === v1;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  // ── CHECKOUT SESSION — create Stripe Checkout URL ──────
  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}

    if (body.action === 'create-checkout') {
      const { priceId: rawPriceId, email, userId, successUrl, cancelUrl } = body;

      // Resolve price ID from env if placeholder used
      let priceId = rawPriceId;
      if (rawPriceId === '__STRIPE_PRICE_MONTHLY__') priceId = process.env.STRIPE_PRICE_MONTHLY;
      if (rawPriceId === '__STRIPE_PRICE_YEARLY__')  priceId = process.env.STRIPE_PRICE_YEARLY;

      if (!priceId || !email) {
        return { statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: 'priceId und email erforderlich' }) };
      }

      const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          'payment_method_types[]': 'card',
          'mode': 'subscription',
          'customer_email': email,
          'line_items[0][price]': priceId,
          'line_items[0][quantity]': '1',
          'success_url': successUrl || 'https://dividendiq-app.netlify.app?upgraded=true',
          'cancel_url':  cancelUrl  || 'https://dividendiq-app.netlify.app',
          'metadata[user_id]': userId || '',
          'metadata[email]': email,
          'allow_promotion_codes': 'true',
        }).toString(),
      });

      const session = await res.json();
      if (!res.ok) {
        return { statusCode: 500, headers: CORS,
          body: JSON.stringify({ error: session.error?.message || 'Checkout fehlgeschlagen' }) };
      }
      return { statusCode: 200, headers: CORS,
        body: JSON.stringify({ url: session.url }) };
    }
    const signature = event.headers['stripe-signature'];
    if (!signature) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No signature' }) };
    }

    // Verify webhook signature
    const valid = await verifyStripeSignature(event.body, signature, STRIPE_WEBHOOK_SECRET);
    if (!valid) {
      console.error('Invalid Stripe signature');
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid signature' }) };
    }

    let stripeEvent;
    try { stripeEvent = JSON.parse(event.body); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    console.log('Stripe event:', stripeEvent.type);

    // ── checkout.session.completed → upgrade to Pro ──────
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const email = session.customer_email || session.metadata?.email;
      if (email) {
        const ok = await updateUserPlan(email, 'pro');
        console.log(`Upgraded ${email} to pro:`, ok);
      }
    }

    // ── customer.subscription.deleted → downgrade to free ─
    if (stripeEvent.type === 'customer.subscription.deleted') {
      const subscription = stripeEvent.data.object;
      // Get customer email from Stripe
      const custRes = await fetch(
        `https://api.stripe.com/v1/customers/${subscription.customer}`,
        { headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` } }
      );
      const customer = await custRes.json();
      if (customer.email) {
        const ok = await updateUserPlan(customer.email, 'free');
        console.log(`Downgraded ${customer.email} to free:`, ok);
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ received: true }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
