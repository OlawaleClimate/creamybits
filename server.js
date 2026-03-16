'use strict';
require('dotenv').config();

const express        = require('express');
const path           = require('path');
const session        = require('express-session');
const pgSession      = require('connect-pg-simple')(session);
const { rateLimit }  = require('express-rate-limit');
const { Resend }     = require('resend');
const { v4: uuidv4 } = require('uuid');
const stripe         = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Pool }       = require('pg');
const multer         = require('multer');
const fs             = require('fs');

const app      = express();
app.set('trust proxy', 1);
const PORT     = process.env.PORT     || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Supabase / PostgreSQL ─────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL env var is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id               TEXT PRIMARY KEY,
      stripe_session_id TEXT,
      stripe_id        TEXT,
      status           TEXT NOT NULL DEFAULT 'pending_payment',
      pickup_status    TEXT NOT NULL DEFAULT 'pending',
      placed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at          TIMESTAMPTZ,
      customer_name    TEXT,
      customer_email   TEXT,
      customer_phone   TEXT,
      pickup_day       TEXT,
      pickup_date      TEXT,
      pickup_time      TEXT,
      allergies        TEXT,
      items            JSONB
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_status TEXT NOT NULL DEFAULT 'pending';

    CREATE TABLE IF NOT EXISTS products (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      description  TEXT,
      category     TEXT NOT NULL,
      image_url    TEXT,
      emoji        TEXT DEFAULT '🥧',
      price        NUMERIC(10,2) NOT NULL,
      unit_label   TEXT,
      variants     JSONB,
      variant_type TEXT NOT NULL DEFAULT 'none',
      sort_order   INTEGER DEFAULT 0,
      active       BOOLEAN DEFAULT true,
      min_qty      INTEGER DEFAULT 1,
      max_qty      INTEGER DEFAULT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE products ADD COLUMN IF NOT EXISTS min_qty INTEGER DEFAULT 1;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS max_qty INTEGER DEFAULT NULL;
    CREATE TABLE IF NOT EXISTS blocked_dates (
      id         TEXT PRIMARY KEY,
      date       DATE NOT NULL UNIQUE,
      reason     TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS session (
      sid    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
      sess   JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);
  `);

  // Seed products if table is empty
  const { rowCount } = await pool.query('SELECT 1 FROM products LIMIT 1');
  if (rowCount === 0) await seedProducts();

  console.log('✅ DB ready');
}

const SEED_PRODUCTS = [
  // Drinks
  { name:'Chapman Drink', description:'A vibrant mocktail made with fruity sodas, orange juice, bitters, cucumber & orange slices. Sweet, tangy & refreshing.', category:'drinks', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_0694_a92c3db89b559e91af51103cd9a5d408.jpg', emoji:'🍹', price:2, unitLabel:'', variantType:'none', sortOrder:0 },
  // Puff Puff
  { name:'Puff Puff – Plain', description:'Soft, golden, lightly sweet fried dough bites. Like donuts but better.', category:'puffpuff', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_0825_cb8e3a3adcb8a5085cd030e6a7fcf663.jpg', emoji:'🍡', price:25, unitLabel:'Box of 20', variantType:'none', sortOrder:0 },
  { name:'Puff Puff – Glazed', description:'Choose your glazes and toppings for a custom box of 25.', category:'puffpuff', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_0755_2_96f845450cddf102a09c28a87f7b1167.jpg', emoji:'🍡', price:30, unitLabel:'Box of 25', variantType:'glazed', sortOrder:1 },
  // Pastries
  { name:'Meat Pies', description:'Buttery, flaky pastry with a rich filling of seasoned ground meat and vegetables.', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_3285_c87d40489ab3711ac2b16a5a4df89245.jpg', emoji:'🥧', price:18, unitLabel:'', variantType:'options', variants:[{label:'Half Dozen',price:18},{label:'One Dozen',price:32}], sortOrder:0 },
  { name:'Chicken Pies', description:'Made with chicken breast/thighs and vegetables (diced carrot & Irish potatoes).', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_9879_78e76b0f366f72abacbd9c46b054fc04.jpg', emoji:'🍗', price:20, unitLabel:'', variantType:'options', variants:[{label:'Half Dozen',price:20},{label:'One Dozen',price:38}], sortOrder:1 },
  { name:'Fish Pies', description:'Buttery dough filled with mackerel fish and vegetables (carrots & bell peppers).', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_0698_f4de2dd83e8d89f4ae9efe6ddb426950.jpg', emoji:'🐟', price:20, unitLabel:'', variantType:'options', variants:[{label:'Half Dozen',price:20},{label:'One Dozen',price:40}], sortOrder:2 },
  { name:'Vegetable Spring Roll', description:'Light crispy rolls filled with a tasty blend of fresh vegetables.', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_0697_d7d65768d88b2f3b1edab07c47f32575.jpg', emoji:'🥢', price:15, unitLabel:'', variantType:'options', variants:[{label:'Half Dozen',price:15},{label:'One Dozen',price:30}], sortOrder:3 },
  { name:'Chicken Spring Rolls', description:'Light crispy rolls filled with seasoned chicken and vegetables.', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_0696_a70f39a37847bbb7937d7501703007a5.jpg', emoji:'🥢', price:20, unitLabel:'', variantType:'options', variants:[{label:'Half Dozen',price:20},{label:'One Dozen',price:35}], sortOrder:4 },
  { name:'Beef Samosa', description:'Crispy fried pastry filled with a savory blend of meat and vegetables.', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_9228_854dccf3d9c58f76304c3f7e8de92efe.jpg', emoji:'🥟', price:30, unitLabel:'Box of 12', variantType:'none', sortOrder:5 },
  { name:'Sausage Rolls', description:'Buttery flaky pastry wrapped around a rich, savory sausage filling.', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_0685_jpg_d0b8e3c6c077caa5b670c96cd1f0c0f3.jpg', emoji:'🌭', price:18, unitLabel:'', variantType:'options', variants:[{label:'Half Dozen',price:18},{label:'One Dozen',price:32}], sortOrder:6 },
  { name:'Egg Rolls', description:'A whole boiled egg wrapped in lightly sweet dough, fried golden and fluffy.', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_6948_41b239fec49a0df547678e64b7bda15f.jpg', emoji:'🥚', price:20, unitLabel:'', variantType:'options', variants:[{label:'Half Dozen',price:20},{label:'One Dozen',price:40}], sortOrder:7 },
  { name:'Shrimp Roll', description:'Crispy shrimp rolls — a crowd favourite for any occasion.', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_0699_3ac264c9da4876dce7b1ba8fc91ba9ef.jpg', emoji:'🍤', price:38, unitLabel:'Box of 12', variantType:'none', sortOrder:8 },
  { name:'Small Chops Pack – Mini', description:'3 Puff Puff · 1 Mini Meatpie · 1 Chicken Wing · 1 Spring Roll. Min. order: 10 packs.', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/c11257d6_100d_4f73_8f2c_e813caa3c1c3_f8ad95a2cef6ad0373839df9fe5ebb29.jpg', emoji:'🍽️', price:9, unitLabel:'per pack', variantType:'none', sortOrder:9 },
  { name:'Small Chops Platter', description:'30 puff puffs · 10 spring rolls · 10 beef samosas or mini meat pies · 10 chicken wings · 6 shrimp rolls.', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_8996_e9f5c980d465bf4cc90154fb85eebf53.jpg', emoji:'🍽️', price:100, unitLabel:'', variantType:'none', sortOrder:10 },
  { name:'Chin-Chin', description:'Best for snacking individually and when you have guests over.', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_7004_7c6f14c8bc6cfd373128876a10ac1af8.jpg', emoji:'🍬', price:20, unitLabel:'', variantType:'options', variants:[{label:'48oz',price:20},{label:'68oz',price:30}], sortOrder:11 },
  { name:'Shawarma', description:'Flavourful wraps made fresh to order.', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_0627_cc6f0100301efffcc0d4a0c1ba637e57.jpg', emoji:'🌯', price:10, unitLabel:'', variantType:'options', variants:[{label:'Chicken Shawarma',price:10},{label:'Chicken + Sausage',price:12}], sortOrder:12 },
  { name:'Pastry Variety Box', description:'Includes 4 Meat Pies, 4 Chicken Pies, 4 Sausage Rolls & Puff Puff.', category:'pastries', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_9879_46fc71c086ab007798ab73dcea6906ce.jpg', emoji:'🎁', price:40, unitLabel:'', variantType:'none', sortOrder:13 },
  // Catering
  { name:'Catering: Mini Meatpies', description:'Perfect for events. Available in bulk trays.', category:'catering', imageUrl:'', emoji:'🥧', price:40, unitLabel:'', variantType:'options', variants:[{label:'Mini Box (25 pcs)',price:40},{label:'Half Tray (50 pcs)',price:75},{label:'Full Tray (100 pcs)',price:150}], sortOrder:0 },
  { name:'Catering: Vegetable Spring Rolls', description:'Crispy veggie rolls in half or full tray quantities.', category:'catering', imageUrl:'', emoji:'🥢', price:50, unitLabel:'', variantType:'options', variants:[{label:'Half Tray (20 pcs)',price:50},{label:'Full Tray (45 pcs)',price:100}], sortOrder:1 },
  { name:'Catering: Beef Samosa', description:'Catering-size orders of crispy beef samosas.', category:'catering', imageUrl:'', emoji:'🥟', price:50, unitLabel:'', variantType:'options', variants:[{label:'Half Tray (20 pcs)',price:50},{label:'Full Tray (45 pcs)',price:100}], sortOrder:2 },
  { name:'Catering: Puff Puff', description:'Large-batch puff puff for events and gatherings.', category:'catering', imageUrl:'', emoji:'🍡', price:50, unitLabel:'', variantType:'options', variants:[{label:'Half Tray',price:50},{label:'Full Tray',price:100}], sortOrder:3 },
  { name:'Catering: Chicken Wings', description:'Juicy, seasoned chicken wings in bulk quantities.', category:'catering', imageUrl:'', emoji:'🍗', price:40, unitLabel:'', variantType:'options', variants:[{label:'25 pcs',price:40},{label:'50 pcs',price:70},{label:'100 pcs',price:140}], sortOrder:4 },
  { name:'Catering: Peppered Gizzard', description:'Bold, spicy peppered gizzard — a party staple.', category:'catering', imageUrl:'', emoji:'🌶️', price:40, unitLabel:'', variantType:'options', variants:[{label:'Mini Tray',price:40},{label:'Half Tray',price:80},{label:'Full Tray',price:160}], sortOrder:5 },
];

async function seedProducts() {
  for (const p of SEED_PRODUCTS) {
    await saveProduct(p);
  }
  console.log(`✅ Seeded ${SEED_PRODUCTS.length} products`);
}

function rowToProduct(r) {
  return {
    id:          r.id,
    name:        r.name,
    description: r.description,
    category:    r.category,
    imageUrl:    r.image_url,
    emoji:       r.emoji,
    price:       parseFloat(r.price),
    unitLabel:   r.unit_label,
    variants:    r.variants,
    variantType: r.variant_type,
    sortOrder:   r.sort_order,
    active:      r.active,
    minQty:      r.min_qty ?? 1,
    maxQty:      r.max_qty ?? null,
    createdAt:   r.created_at,
  };
}

async function readProducts(adminMode = false) {
  const q = adminMode
    ? 'SELECT * FROM products ORDER BY sort_order, created_at'
    : 'SELECT * FROM products WHERE active=true ORDER BY sort_order, created_at';
  const { rows } = await pool.query(q);
  return rows.map(rowToProduct);
}

async function saveProduct(p) {
  const id = p.id || uuidv4();
  await pool.query(
    `INSERT INTO products
       (id, name, description, category, image_url, emoji, price,
        unit_label, variants, variant_type, sort_order, active, min_qty, max_qty)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id, p.name, p.description || '', p.category, p.imageUrl || '',
      p.emoji || '🥧', p.price, p.unitLabel || '',
      p.variants ? JSON.stringify(p.variants) : null,
      p.variantType || 'none', p.sortOrder || 0,
      p.active !== false,
      p.minQty ?? 1,
      p.maxQty ?? null,
    ]
  );
  return id;
}

async function updateProductById(id, patch) {
  const colMap = {
    name:'name', description:'description', category:'category',
    imageUrl:'image_url', emoji:'emoji', price:'price',
    unitLabel:'unit_label', variants:'variants', variantType:'variant_type',
    sortOrder:'sort_order', active:'active', minQty:'min_qty', maxQty:'max_qty',
  };
  const sets = [], vals = [];
  let i = 1;
  for (const [key, col] of Object.entries(colMap)) {
    if (patch[key] !== undefined) {
      sets.push(`${col}=$${i++}`);
      vals.push(key === 'variants' ? JSON.stringify(patch[key]) : patch[key]);
    }
  }
  if (!sets.length) return null;
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE products SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals
  );
  return rows[0] ? rowToProduct(rows[0]) : null;
}

async function readOrders() {
  const { rows } = await pool.query(
    `SELECT * FROM orders ORDER BY placed_at DESC`
  );
  return rows.map(rowToOrder);
}

async function saveOrder(order) {
  await pool.query(
    `INSERT INTO orders
       (id, stripe_session_id, status, pickup_status, placed_at,
        customer_name, customer_email, customer_phone,
        pickup_day, pickup_date, pickup_time, allergies, items)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      order.id,
      order.stripeSessionId,
      order.status,
      'pending',
      order.placedAt,
      order.customerName,
      order.customerEmail,
      order.customerPhone,
      order.pickupDay,
      order.pickupDate,
      order.pickupTime,
      order.allergies,
      JSON.stringify(order.items),
    ]
  );
}

async function updateOrder(orderId, patch) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (patch.status)               { sets.push(`status=$${i++}`);         vals.push(patch.status); }
  if (patch.pickupStatus)         { sets.push(`pickup_status=$${i++}`);  vals.push(patch.pickupStatus); }
  if (patch.paidAt)               { sets.push(`paid_at=$${i++}`);        vals.push(patch.paidAt); }
  if (patch.stripePaymentIntent)  { sets.push(`stripe_id=$${i++}`);      vals.push(patch.stripePaymentIntent); }
  if (!sets.length) return null;
  vals.push(orderId);
  const { rows } = await pool.query(
    `UPDATE orders SET ${sets.join(',')} WHERE id=$${i} RETURNING *`,
    vals
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
}

function rowToOrder(r) {
  return {
    id:                   r.id,
    stripeSessionId:      r.stripe_session_id,
    stripePaymentIntent:  r.stripe_id,
    status:               r.status,
    pickupStatus:         r.pickup_status || 'pending',
    placedAt:             r.placed_at,
    paidAt:               r.paid_at,
    customerName:         r.customer_name,
    customerEmail:        r.customer_email,
    customerPhone:        r.customer_phone,
    pickupDay:            r.pickup_day,
    pickupDate:           r.pickup_date,
    pickupTime:           r.pickup_time,
    allergies:            r.allergies,
    items:                r.items,
  };
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
      const updated = await updateOrder(orderId, {
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: false }),
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

// ── Rate limiter ──────────────────────────────────────────────────────────────
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout attempts. Please wait a few minutes and try again.' },
});

// ── Checkout session ──────────────────────────────────────────────────────────
app.post('/create-checkout-session', checkoutLimiter, async (req, res) => {
  const { items, customerName, customerEmail, customerPhone, pickupDay, pickupDate, pickupTime, allergies } = req.body;

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'Cart is empty.' });

  for (const item of items) {
    if (typeof item.name  !== 'string' || item.name.trim() === '' ||
        typeof item.price !== 'number' || item.price <= 0 ||
        typeof item.qty   !== 'number' || item.qty < 1)
      return res.status(400).json({ error: 'Invalid cart item.' });
  }

  // Validate min/max qty against DB
  const { rows: productRows } = await pool.query('SELECT name, min_qty, max_qty FROM products WHERE active=true');
  const productMap = new Map(productRows.map(p => [p.name, p]));
  for (const item of items) {
    const prod = productMap.get(item.name);
    if (prod) {
      const min = prod.min_qty ?? 1;
      const max = prod.max_qty ?? null;
      if (item.qty < min)
        return res.status(400).json({ error: `Minimum order for "${item.name}" is ${min}.` });
      if (max !== null && item.qty > max)
        return res.status(400).json({ error: `Maximum order for "${item.name}" is ${max}.` });
    }
  }

  // Validate pickup date is not blocked
  if (pickupDate) {
    const dateStr = new Date(pickupDate).toISOString().slice(0,10);
    const { rowCount } = await pool.query('SELECT 1 FROM blocked_dates WHERE date=$1', [dateStr]);
    if (rowCount > 0)
      return res.status(400).json({ error: 'Sorry, that pick-up date is not available. Please choose another date.' });
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

    await saveOrder({
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

// ── Public products API ───────────────────────────────────────────────────────
app.get('/products', async (_req, res) => {
  res.json(await readProducts(false));
});

app.get('/blocked-dates', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM blocked_dates ORDER BY date');
  res.json(rows.map(r => ({ id: r.id, date: r.date.toISOString().slice(0,10), reason: r.reason })));
});

app.get('/orders/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  const o = rowToOrder(rows[0]);
  // Only expose safe fields to the public (no email/phone)
  res.json({
    id: o.id, status: o.status, pickupStatus: o.pickupStatus,
    customerName: o.customerName, pickupDay: o.pickupDay,
    pickupDate: o.pickupDate, pickupTime: o.pickupTime,
    items: o.items, placedAt: o.placedAt,
  });
});

// ── Admin API ─────────────────────────────────────────────────────────────────
app.get('/admin/orders', requireAdmin, async (_req, res) => {
  res.json(await readOrders());
});

app.get('/admin/orders/export.csv', requireAdmin, async (_req, res) => {
  const orders = await readOrders();
  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Order ID','Placed At','Customer Name','Email','Phone',
                  'Pickup Day','Pickup Date','Pickup Time','Allergies',
                  'Items','Total','Payment Status','Pickup Status'];
  const rows = orders.map(o => {
    const total = (o.items || []).reduce((s,i) => s + i.price * i.qty, 0).toFixed(2);
    const items = (o.items || []).map(i => `${i.qty}x ${i.name}${i.variant ? ' ('+i.variant+')' : ''}`).join('; ');
    return [o.id, o.placedAt, o.customerName, o.customerEmail, o.customerPhone,
            o.pickupDay, o.pickupDate, o.pickupTime, o.allergies,
            items, total, o.status, o.pickupStatus].map(escape).join(',');
  });
  const csv = [header.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="creamybits-orders.csv"');
  res.send(csv);
});

// ── Image upload ──────────────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const imageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});
const imageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed.'));
  },
});

app.post('/admin/upload-image', requireAdmin, imageUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.get('/admin/products', requireAdmin, async (_req, res) => {
  res.json(await readProducts(true));
});

app.post('/admin/products', requireAdmin, async (req, res) => {
  const { name, description, category, imageUrl, emoji, price,
          unitLabel, variants, variantType, sortOrder, active, minQty, maxQty } = req.body;
  if (!name || !category || price == null)
    return res.status(400).json({ error: 'name, category, price required.' });
  if (!['drinks','puffpuff','pastries','catering'].includes(category))
    return res.status(400).json({ error: 'Invalid category.' });
  if (!['none','options','glazed'].includes(variantType || 'none'))
    return res.status(400).json({ error: 'Invalid variantType.' });
  const id = await saveProduct({
    name: name.trim(), description, category, imageUrl, emoji,
    price: parseFloat(price), unitLabel, variants,
    variantType: variantType || 'none',
    sortOrder: parseInt(sortOrder) || 0,
    active: active !== false,
    minQty: parseInt(minQty) || 1,
    maxQty: maxQty != null && maxQty !== '' ? parseInt(maxQty) : null,
  });
  const { rows } = await pool.query('SELECT * FROM products WHERE id=$1', [id]);
  res.status(201).json(rowToProduct(rows[0]));
});

app.patch('/admin/products/:id', requireAdmin, async (req, res) => {
  const allowed = ['name','description','category','imageUrl','emoji','price',
                   'unitLabel','variants','variantType','sortOrder','active','minQty','maxQty'];
  const patch = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  if (!Object.keys(patch).length)
    return res.status(400).json({ error: 'Nothing to update.' });
  if (patch.price !== undefined) patch.price = parseFloat(patch.price);
  if (patch.sortOrder !== undefined) patch.sortOrder = parseInt(patch.sortOrder) || 0;
  if (patch.minQty !== undefined) patch.minQty = parseInt(patch.minQty) || 1;
  if (patch.maxQty !== undefined) patch.maxQty = patch.maxQty === null || patch.maxQty === '' ? null : parseInt(patch.maxQty);
  const updated = await updateProductById(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'Product not found.' });
  res.json(updated);
});

app.delete('/admin/products/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── Admin blocked dates ───────────────────────────────────────────────────────
app.get('/admin/blocked-dates', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM blocked_dates ORDER BY date');
  res.json(rows.map(r => ({ id: r.id, date: r.date.toISOString().slice(0,10), reason: r.reason })));
});

app.post('/admin/blocked-dates', requireAdmin, async (req, res) => {
  const { date, reason } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Valid date (YYYY-MM-DD) required.' });
  const id = uuidv4();
  await pool.query(
    'INSERT INTO blocked_dates (id, date, reason) VALUES ($1,$2,$3) ON CONFLICT (date) DO UPDATE SET reason=$3',
    [id, date, reason || '']
  );
  const { rows } = await pool.query('SELECT * FROM blocked_dates WHERE date=$1', [date]);
  res.status(201).json({ id: rows[0].id, date: rows[0].date.toISOString().slice(0,10), reason: rows[0].reason });
});

app.delete('/admin/blocked-dates/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM blocked_dates WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

async function sendPickupEmail(order) {
  const total = order.items.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2);
  const shortId = order.id.slice(0, 8).toUpperCase();
  const itemRows = order.items.map(i =>
    `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0">${i.name}${i.variant ? ` <em style="color:#6b7280;font-size:12px">(${i.variant})</em>` : ''}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:center">${i.qty}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right">$${(i.price * i.qty).toFixed(2)}</td>
    </tr>`).join('');

  const customerBody = `
    <h2 style="margin:0 0 10px;font-size:22px">Your order has been picked up! 🎉</h2>
    <p style="color:#6b7280;margin:0 0 18px;line-height:1.6">
      Hi ${order.customerName}, thank you for picking up your order from CreamyBits!
      We hope you enjoy every bite. See you again soon! 🥧
    </p>`;

  const adminBody = `
    <h2 style="margin:0 0 10px;font-size:22px">Order Picked Up ✅</h2>
    <p style="color:#6b7280;margin:0 0 18px">${order.customerName} has picked up order #${shortId}.</p>`;

  await Promise.all([
    resend.emails.send({
      from: `CreamyBits <orders@${process.env.RESEND_FROM_DOMAIN}>`,
      to:   order.customerEmail,
      subject: `Thanks for picking up your order! – CreamyBits 🥧`,
      html: buildEmailHtml(customerBody, itemRows, total, order),
    }),
    resend.emails.send({
      from: `CreamyBits Orders <orders@${process.env.RESEND_FROM_DOMAIN}>`,
      to:   process.env.ADMIN_EMAIL,
      subject: `Order picked up: ${order.customerName} (#${shortId})`,
      html: buildEmailHtml(adminBody, itemRows, total, order),
    }),
  ]);
}

app.patch('/admin/orders/:id', requireAdmin, async (req, res) => {
  const { status, pickupStatus } = req.body;
  const patch = {};

  if (status !== undefined) {
    if (!['pending_payment','paid','cancelled'].includes(status))
      return res.status(400).json({ error: 'Invalid payment status.' });
    patch.status = status;
  }

  if (pickupStatus !== undefined) {
    if (!['pending','ready','picked_up'].includes(pickupStatus))
      return res.status(400).json({ error: 'Invalid pickup status.' });
    patch.pickupStatus = pickupStatus;
  }

  if (!Object.keys(patch).length)
    return res.status(400).json({ error: 'Nothing to update.' });

  const updated = await updateOrder(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'Order not found.' });

  if (pickupStatus === 'picked_up') {
    try { await sendPickupEmail(updated); }
    catch (e) { console.error('Pickup email failed:', e.message); }
  }
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

// Start server immediately so Render marks deploy as live,
// then init DB in the background
app.listen(PORT, () => console.log(`✅  CreamyBits → http://localhost:${PORT}`));
initDB().catch(err => console.error('DB init error:', err.message));
