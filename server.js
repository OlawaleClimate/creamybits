'use strict';
require('dotenv').config();

const express        = require('express');
const path           = require('path');
const fs             = require('fs');
const session        = require('express-session');
const { Resend }     = require('resend');
const { v4: uuidv4 } = require('uuid');
const stripe         = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app      = express();
app.set('trust proxy', 1); // Required for secure cookies behind Render/Railway proxy
const PORT     = process.env.PORT     || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Order storage ─────────────────────────────────────────────────────────────
const ORDERS_FILE = path.join(__dirname, 'orders.json');
function readOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { return []; }
}
function saveOrder(order) {
  const orders = readOrders();
  orders.unshift(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}
function updateOrder(orderId, patch) {
  const orders = readOrders();
  const idx = orders.findIndex(o => o.id === orderId);
  if (idx !== -1) {
    Object.assign(orders[idx], patch);
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
    return orders[idx];
  }
  return null;
}

// ── Email ─────────────────────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);

function buildEmailHtml(bodyHtml, itemRows, total, order) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #f0f0f0">
    <div style="background:#0f0f0f;padding:28px 32px;text-align:center">
      <span style="color:#fff;font-size:22px;font-weight:900;letter-spacing:1px">🥧 CreamyBits</span><br>
      <span style="color:#9ca3af;font-size:13px">African Pastries · Albuquerque, NM</span>
    </div>
    <div style="padding:32px">
      ${bodyHtml}
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border-radius:12px;overflow:hidden;border:1px solid #f0f0f0;font-size:14px">
        <thead>
          <tr style="background:#f8f8f8">
            <th style="padding:10px 12px;text-align:left">Item</th>
            <th style="padding:10px 12px;text-align:center">Qty</th>
            <th style="padding:10px 12px;text-align:right">Price</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
        <tfoot>
          <tr style="background:#f8f8f8;font-weight:700">
            <td colspan="2" style="padding:10px 12px">Total</td>
            <td style="padding:10px 12px;text-align:right">$${total}</td>
          </tr>
        </tfoot>
      </table>
      <p style="font-size:13px;margin:8px 0"><strong>📅 Pick-up:</strong> ${order.pickupDate ? order.pickupDate : order.pickupDay}, ${order.pickupTime}</p>
      ${order.allergies && order.allergies.toLowerCase() !== 'none' && order.allergies.toLowerCase() !== 'n/a'
        ? `<p style="font-size:13px;margin:8px 0;color:#dc2626"><strong>⚠️ Allergies / Notes:</strong> ${order.allergies}</p>`
        : ''}
      <p style="font-size:12px;color:#9ca3af;margin-top:20px">Order ID: ${order.id}</p>
    </div>
    <div style="background:#f8f8f8;padding:16px 32px;text-align:center;font-size:12px;color:#9ca3af">
      © 2026 CreamyBits LLC · creamybitsllc@gmail.com
    </div>
  </div>`;
}

async function sendEmails(order) {
  const itemRows = order.items.map(i =>
    `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0">${i.name}${i.variant ? ` <em style="color:#6b7280;font-size:12px">(${i.variant})</em>` : ''}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:center">${i.qty}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right">$${(i.price * i.qty).toFixed(2)}</td>
    </tr>`).join('');
  const total = order.items.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2);

  const customerBody = `
    <h2 style="margin:0 0 10px;font-size:22px">Hi ${order.customerName}, your order is confirmed! 🎉</h2>
    <p style="color:#6b7280;margin:0 0 18px;line-height:1.6">
      Thank you for ordering from CreamyBits! Your payment has been received.
      We'll be in touch with the exact pick-up address 24 hours before your pick-up day.
    </p>
    <table style="font-size:14px;margin-bottom:16px" cellpadding="0" cellspacing="0">
      <tr><td style="color:#6b7280;width:120px;padding:3px 0">Name</td><td><strong>${order.customerName}</strong></td></tr>
      <tr><td style="color:#6b7280;padding:3px 0">Phone</td><td>${order.customerPhone}</td></tr>
    </table>`;

  const adminBody = `
    <h2 style="margin:0 0 10px;font-size:22px">New Order Received 🛍️</h2>
    <p style="color:#6b7280;margin:0 0 18px">A customer just paid — here are the details.</p>
    <table style="font-size:14px;margin-bottom:8px;width:100%" cellpadding="0" cellspacing="0">
      <tr><td style="color:#6b7280;width:130px;padding:4px 0">Customer</td><td><strong>${order.customerName}</strong></td></tr>
      <tr><td style="color:#6b7280;padding:4px 0">Email</td><td>${order.customerEmail}</td></tr>
      <tr><td style="color:#6b7280;padding:4px 0">Phone</td><td>${order.customerPhone}</td></tr>
      <tr><td style="color:#6b7280;padding:4px 0">Pick-up</td><td><strong>${order.pickupDate ? order.pickupDate : order.pickupDay}, ${order.pickupTime}</strong></td></tr>
      ${order.allergies ? `<tr><td style="color:#dc2626;padding:4px 0">Allergies</td><td style="color:#dc2626"><strong>${order.allergies}</strong></td></tr>` : ''}
    </table>`;

  const shortId = order.id.slice(0, 8).toUpperCase();
  const total2  = order.items.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2);

  await Promise.all([
    resend.emails.send({
      from: `CreamyBits <orders@${process.env.RESEND_FROM_DOMAIN}>`,
      to:   order.customerEmail,
      subject: `Order confirmed #${shortId} – CreamyBits 🥧`,
      html: buildEmailHtml(customerBody, itemRows, total2, order),
    }),
    resend.emails.send({
      from: `CreamyBits Orders <orders@${process.env.RESEND_FROM_DOMAIN}>`,
      to:   process.env.ADMIN_EMAIL,
      subject: `New paid order from ${order.customerName} – $${total2} (#${shortId})`,
      html: buildEmailHtml(adminBody, itemRows, total2, order),
    }),
  ]);
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Webhook route must get raw body — register BEFORE json middleware catches it
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(500).send('Webhook secret not configured');
    }
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const s       = event.data.object;
    const orderId = s.metadata && s.metadata.orderId;
    if (orderId) {
      const updated = updateOrder(orderId, {
        status: 'paid',
        paidAt: new Date().toISOString(),
        stripePaymentIntent: s.payment_intent,
      });
      if (updated) {
        try { await sendEmails(updated); }
        catch (e) { console.error('Email send failed:', e.message); }
      }
    }
  }
  res.sendStatus(200);
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'creamybits_dev_secret_changeme',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production' },
}));

app.use(express.static(path.join(__dirname, 'public')));

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin-login.html');
}

// ── Checkout session ──────────────────────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  const { items, customerName, customerEmail, customerPhone, pickupDay, pickupDate, pickupTime, allergies } = req.body;

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'Cart is empty.' });

  for (const item of items) {
    if (typeof item.name  !== 'string' || item.name.trim() === '' ||
        typeof item.price !== 'number' || item.price <= 0 ||
        typeof item.qty   !== 'number' || item.qty < 1)
      return res.status(400).json({ error: 'Invalid cart item.' });
  }

  if (!customerName || !customerEmail || !customerPhone || !pickupDay || !pickupTime || !allergies)
    return res.status(400).json({ error: 'All fields including allergy info are required.' });

  if (!['Saturday', 'Sunday'].includes(pickupDay))
    return res.status(400).json({ error: 'Pick-up must be Saturday or Sunday.' });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))
    return res.status(400).json({ error: 'Please enter a valid email address.' });

  const orderId    = uuidv4();
  const line_items = items.map(item => ({
    price_data: {
      currency: 'usd',
      product_data: {
        name: item.name,
        ...(item.variant ? { description: item.variant } : {}),
      },
      unit_amount: Math.round(item.price * 100),
    },
    quantity: item.qty,
  }));

  try {
    const stripeSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items,
      success_url: `${BASE_URL}/success.html?order_id=${orderId}`,
      cancel_url:  `${BASE_URL}/cancel.html`,
      customer_email: customerEmail,
      metadata: { orderId },
      custom_text: {
        submit: {
          message: `Pick-up: ${pickupDate || pickupDay} at ${pickupTime} · Albuquerque, NM. Confirmation sent to ${customerEmail}.`,
        },
      },
    });

    saveOrder({
      id: orderId,
      stripeSessionId: stripeSession.id,
      status: 'pending_payment',
      placedAt: new Date().toISOString(),
      customerName:  customerName.trim(),
      customerEmail: customerEmail.trim().toLowerCase(),
      customerPhone: customerPhone.trim(),
      pickupDay,
      pickupDate: pickupDate || '',
      pickupTime,
      allergies: allergies.trim(),
      items,
    });

    res.json({ url: stripeSession.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Unable to start checkout. Please try again.' });
  }
});

// ── Admin auth routes ─────────────────────────────────────────────────────────
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.redirect('/admin-login.html?error=1');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin-login.html');
});

// ── Admin API ─────────────────────────────────────────────────────────────────
app.get('/admin/orders', requireAdmin, (_req, res) => {
  res.json(readOrders());
});

app.patch('/admin/orders/:id', requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!['pending_payment','paid','ready','completed','cancelled'].includes(status))
    return res.status(400).json({ error: 'Invalid status.' });
  const updated = updateOrder(req.params.id, { status });
  if (!updated) return res.status(404).json({ error: 'Order not found.' });
  res.json(updated);
});

// ── Admin pages ───────────────────────────────────────────────────────────────
app.get('/admin', requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Fallback SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅  CreamyBits → http://localhost:${PORT}`);
});
