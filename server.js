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
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

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
    ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT NULL;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS is_upsell BOOLEAN DEFAULT false;
    CREATE TABLE IF NOT EXISTS coupons (
      id            TEXT PRIMARY KEY,
      code          TEXT UNIQUE NOT NULL,
      discount_type TEXT NOT NULL,
      discount_value NUMERIC NOT NULL,
      active        BOOLEAN DEFAULT true,
      max_uses      INTEGER DEFAULT NULL,
      uses          INTEGER DEFAULT 0,
      expires_at    DATE DEFAULT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code TEXT DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC DEFAULT NULL;
    CREATE TABLE IF NOT EXISTS classes (
      id             TEXT PRIMARY KEY,
      title          TEXT NOT NULL,
      description    TEXT,
      class_date     DATE,
      class_time     TEXT,
      price          NUMERIC NOT NULL,
      capacity       INTEGER DEFAULT NULL,
      spots_left     INTEGER DEFAULT NULL,
      telegram_link  TEXT NOT NULL,
      active         BOOLEAN DEFAULT true,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE classes ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT NULL;
    ALTER TABLE classes ADD COLUMN IF NOT EXISTS early_bird_price NUMERIC DEFAULT NULL;
    ALTER TABLE classes ADD COLUMN IF NOT EXISTS early_bird_ends DATE DEFAULT NULL;
    ALTER TABLE classes ADD COLUMN IF NOT EXISTS registration_closes DATE DEFAULT NULL;
    ALTER TABLE classes ADD COLUMN IF NOT EXISTS show_spots BOOLEAN DEFAULT true;
    CREATE TABLE IF NOT EXISTS luxe_invoices (
      id             TEXT PRIMARY KEY,
      invoice_number TEXT NOT NULL,
      customer_name  TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      event_date     DATE,
      event_type     TEXT,
      num_guests     INTEGER,
      line_items     JSONB NOT NULL DEFAULT '[]',
      notes          TEXT,
      subtotal       NUMERIC DEFAULT 0,
      tax_rate       NUMERIC DEFAULT 0,
      discount       NUMERIC DEFAULT 0,
      total          NUMERIC DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS class_registrations (
      id                TEXT PRIMARY KEY,
      class_id          TEXT NOT NULL,
      customer_name     TEXT NOT NULL,
      customer_email    TEXT NOT NULL,
      customer_phone    TEXT,
      stripe_session_id TEXT,
      status            TEXT NOT NULL DEFAULT 'pending_payment',
      paid_at           TIMESTAMPTZ,
      reminder_sent     BOOLEAN DEFAULT false,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE class_registrations ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT false;
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

    CREATE TABLE IF NOT EXISTS luxe_items (
      id          TEXT PRIMARY KEY,
      section     TEXT NOT NULL,
      name        TEXT NOT NULL,
      price       TEXT,
      on_request  BOOLEAN DEFAULT false,
      sort_order  INTEGER DEFAULT 0,
      active      BOOLEAN DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS luxe_sections (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      archived   BOOLEAN DEFAULT false
    );
    ALTER TABLE luxe_sections ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false;

    CREATE TABLE IF NOT EXISTS deals (
      id             TEXT PRIMARY KEY,
      product_id     TEXT NOT NULL,
      discount_type  TEXT NOT NULL DEFAULT 'percent',
      discount_value NUMERIC(10,2) NOT NULL,
      active         BOOLEAN DEFAULT true,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS luxe_bookings (
      id                TEXT PRIMARY KEY,
      stripe_session_id TEXT,
      status            TEXT NOT NULL DEFAULT 'pending_payment',
      placed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at           TIMESTAMPTZ,
      customer_name     TEXT,
      customer_email    TEXT,
      customer_phone    TEXT,
      event_type        TEXT,
      guest_count       TEXT,
      event_date        TEXT,
      notes             TEXT
    );
  `);

  // Seed products if table is empty
  const { rowCount } = await pool.query('SELECT 1 FROM products LIMIT 1');
  if (rowCount === 0) await seedProducts();

  // Seed luxe_items if table is empty
  const { rowCount: luxeCount } = await pool.query('SELECT 1 FROM luxe_items LIMIT 1');
  if (luxeCount === 0) await seedLuxeItems();

  // Seed luxe_sections if empty
  const { rowCount: secCount } = await pool.query('SELECT 1 FROM luxe_sections LIMIT 1');
  if (secCount === 0) {
    const secs = [
      { id: 's1',  title: 'Small Chops & Pastries', sort_order: 1 },
      { id: 's2',  title: 'Appetizers',              sort_order: 2 },
      { id: 's3',  title: 'Salads',                  sort_order: 3 },
      { id: 's4',  title: 'Desserts',                sort_order: 4 },
      { id: 's5',  title: 'Mocktails',               sort_order: 5 },
      { id: 's6',  title: 'Breakfast',               sort_order: 6 },
      { id: 's6b', title: 'Breakfast Drinks',        sort_order: 7 },
    ];
    for (const s of secs) {
      await pool.query(
        'INSERT INTO luxe_sections (id,title,sort_order) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING',
        [s.id, s.title, s.sort_order]
      );
    }
  }

  // Migration: add size variants to Chapman Drink
  await pool.query(`
    UPDATE products
    SET variant_type='options',
        variants='[{"label":"8oz","price":3},{"label":"16oz","price":6}]',
        price=3
    WHERE name='Chapman Drink' AND variant_type='none'
  `);

  console.log('✅ DB ready');
}

const SEED_PRODUCTS = [
  // Drinks
  { name:'Chapman Drink', description:'A vibrant mocktail made with fruity sodas, orange juice, bitters, cucumber & orange slices. Sweet, tangy & refreshing.', category:'drinks', imageUrl:'https://www.jotform.com/uploads/holarwhaley2/form_files/img_0694_a92c3db89b559e91af51103cd9a5d408.jpg', emoji:'🍹', price:3, unitLabel:'', variantType:'options', variants:[{label:'8oz',price:3},{label:'16oz',price:6}], sortOrder:0 },
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

const SEED_LUXE_ITEMS = [
  // s1 – Small Chops & Pastries
  { section:'s1', name:'Puff Puff',               price:'$50',  onRequest:false, sortOrder:0 },
  { section:'s1', name:'Samosa',                  price:'$50',  onRequest:false, sortOrder:1 },
  { section:'s1', name:'Vegetable Spring Rolls',  price:'$50',  onRequest:false, sortOrder:2 },
  { section:'s1', name:'Chicken Spring Rolls',    price:'$75',  onRequest:false, sortOrder:3 },
  { section:'s1', name:'Meat Pies',               price:'$50',  onRequest:false, sortOrder:4 },
  { section:'s1', name:'Chicken Pies',            price:'$75',  onRequest:false, sortOrder:5 },
  { section:'s1', name:'Chin Chin',               price:'$75',  onRequest:false, sortOrder:6 },
  { section:'s1', name:'Beef Sausage Rolls',      price:'$50',  onRequest:false, sortOrder:7 },
  { section:'s1', name:'Fish Pies',               price:'$75',  onRequest:false, sortOrder:8 },
  // s2 – Appetizers
  { section:'s2', name:'Shawarma Bites',                   price:'$50',  onRequest:false, sortOrder:0 },
  { section:'s2', name:'Shrimp Spring Rolls',              price:'$75',  onRequest:false, sortOrder:1 },
  { section:'s2', name:'Shrimp Tempura',                   price:'$80',  onRequest:false, sortOrder:2 },
  { section:'s2', name:'Mini Beef / Chicken Tacos',        price:'$50',  onRequest:false, sortOrder:3 },
  { section:'s2', name:'Goat Meat Pepper Soup (Turkey)',   price:'$100', onRequest:false, sortOrder:4 },
  // s3 – Sides
  { section:'s3', name:'Pasta Salad',    price:'$70', onRequest:false, sortOrder:0 },
  { section:'s3', name:'Nigerian Salad', price:'$60', onRequest:false, sortOrder:1 },
  // s4 – Desserts (per dozen)
  { section:'s4', name:'Red Velvet',             price:'$55', onRequest:false, sortOrder:0 },
  { section:'s4', name:'Chocolate',              price:'$55', onRequest:false, sortOrder:1 },
  { section:'s4', name:'Oreo Cheesecake Shooter',price:'$55', onRequest:false, sortOrder:2 },
  { section:'s4', name:'Vanilla & Cream',        price:'$50', onRequest:false, sortOrder:3 },
  { section:'s4', name:'Lotus Biscoff Shooter',  price:'$60', onRequest:false, sortOrder:4 },
  // s5 – Mocktails (per dozen)
  { section:'s5', name:'Hurricane',       price:'$45', onRequest:false, sortOrder:0 },
  { section:'s5', name:'Piña Colada',     price:'$55', onRequest:false, sortOrder:1 },
  { section:'s5', name:'Virgin Mojito',   price:'$50', onRequest:false, sortOrder:2 },
  { section:'s5', name:'Strawberry Drink',price:'$60', onRequest:false, sortOrder:3 },
  { section:'s5', name:'Chapman',         price:'$55', onRequest:false, sortOrder:4 },
  // s6 – Breakfast
  { section:'s6', name:'Baked Potatoes & Fish Sauce',        price:null, onRequest:true, sortOrder:0 },
  { section:'s6', name:'Bread Rolls & Fried Eggs',           price:null, onRequest:true, sortOrder:1 },
  { section:'s6', name:'Bread Rolls & Bean Balls (Akara)',   price:null, onRequest:true, sortOrder:2 },
  // s6b – Breakfast Drinks
  { section:'s6b', name:'Hot Chocolate with Cream', price:null, onRequest:true, sortOrder:0 },
  { section:'s6b', name:'Hot Coffee with Cream',    price:null, onRequest:true, sortOrder:1 },
];

async function seedLuxeItems() {
  for (const item of SEED_LUXE_ITEMS) {
    await pool.query(
      `INSERT INTO luxe_items (id, section, name, price, on_request, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuidv4(), item.section, item.name, item.price || null, !!item.onRequest, item.sortOrder]
    );
  }
  console.log(`✅ Seeded ${SEED_LUXE_ITEMS.length} luxe items`);
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
    stock:       r.stock != null ? parseInt(r.stock) : null,
    isUpsell:    r.is_upsell || false,
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
        unit_label, variants, variant_type, sort_order, active, min_qty, max_qty, stock)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id, p.name, p.description || '', p.category, p.imageUrl || '',
      p.emoji || '🥧', p.price, p.unitLabel || '',
      p.variants ? JSON.stringify(p.variants) : null,
      p.variantType || 'none', p.sortOrder || 0,
      p.active !== false,
      p.minQty ?? 1,
      p.maxQty ?? null,
      p.stock ?? null,
    ]
  );
  return id;
}

async function updateProductById(id, patch) {
  const colMap = {
    name:'name', description:'description', category:'category',
    imageUrl:'image_url', emoji:'emoji', price:'price',
    unitLabel:'unit_label', variants:'variants', variantType:'variant_type',
    sortOrder:'sort_order', active:'active', minQty:'min_qty', maxQty:'max_qty', stock:'stock',
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
        pickup_day, pickup_date, pickup_time, allergies, items,
        coupon_code, discount_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
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
      order.couponCode || null,
      order.discountAmount || null,
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
  if (patch.pickupDay  !== undefined) { sets.push(`pickup_day=$${i++}`);  vals.push(patch.pickupDay); }
  if (patch.pickupDate !== undefined) { sets.push(`pickup_date=$${i++}`); vals.push(patch.pickupDate); }
  if (patch.pickupTime !== undefined) { sets.push(`pickup_time=$${i++}`); vals.push(patch.pickupTime); }
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
    couponCode:           r.coupon_code || null,
    discountAmount:       r.discount_amount != null ? parseFloat(r.discount_amount) : null,
  };
}


// ── Email ─────────────────────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);

function buildEmailHtml(bodyHtml, itemRows, order) {
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
          ${order.discountAmount ? `
          <tr style="color:#16a34a;font-size:13px">
            <td colspan="2" style="padding:6px 12px">Coupon ${order.couponCode}</td>
            <td style="padding:6px 12px;text-align:right">−$${order.discountAmount.toFixed(2)}</td>
          </tr>` : ''}
          <tr style="background:#f8f8f8;font-weight:700">
            <td colspan="2" style="padding:10px 12px">Total Charged</td>
            <td style="padding:10px 12px;text-align:right">$${((order.items||[]).reduce((s,i)=>s+i.price*i.qty,0)-(order.discountAmount||0)).toFixed(2)}</td>
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
  const itemRows = (order.items || []).map(i =>
    `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0">${i.name}${i.variant ? ` <em style="color:#6b7280;font-size:12px">(${i.variant})</em>` : ''}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:center">${i.qty}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right">$${(i.price * i.qty).toFixed(2)}</td>
    </tr>`).join('');
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

  const shortId  = order.id.slice(0, 8).toUpperCase();
  const subtotal = (order.items || []).reduce((s, i) => s + i.price * i.qty, 0);
  const charged  = (subtotal - (order.discountAmount || 0)).toFixed(2);

  await Promise.all([
    resend.emails.send({
      from:     `CreamyBits <orders@${process.env.RESEND_FROM_DOMAIN}>`,
      reply_to: 'creamybitsllc@gmail.com',
      to:       order.customerEmail,
      subject:  `Order confirmed #${shortId} – CreamyBits 🥧`,
      html:     buildEmailHtml(customerBody, itemRows, order),
    }),
    resend.emails.send({
      from: `CreamyBits Orders <orders@${process.env.RESEND_FROM_DOMAIN}>`,
      to:   process.env.ADMIN_EMAIL,
      subject: `New paid order from ${order.customerName} – $${charged} (#${shortId})`,
      html: buildEmailHtml(adminBody, itemRows, order),
    }),
  ]);
}

async function sendLuxeBookingEmails(booking) {
  const customerHtml = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
      <div style="background:linear-gradient(135deg,#1a1209,#2e1f0a);padding:2rem;border-radius:12px 12px 0 0;text-align:center">
        <img src="${BASE_URL}/logo.png" alt="CreamyBits" width="64" height="64" style="border-radius:50%;border:2px solid rgba(201,168,76,.4);margin-bottom:.9rem;display:block;margin-left:auto;margin-right:auto" />
        <h1 style="color:#f0d080;font-size:1.3rem;margin:0">✨ CreamyBits Luxe</h1>
        <p style="color:rgba(240,208,128,.7);font-size:.82rem;margin:.4rem 0 0">Consultation Booking Confirmed</p>
      </div>
      <div style="background:#fff;border:1px solid #e5dcc8;border-top:none;border-radius:0 0 12px 12px;padding:2rem">
        <h2 style="margin:0 0 .5rem;font-size:1.1rem">Hi ${booking.customer_name} 👋</h2>
        <p style="color:#4b4b4b;line-height:1.65;margin:0 0 1.25rem">
          Your $40 consultation deposit has been received. We'll reach out within 1–2 business days
          to schedule your consultation. Your deposit will be credited toward your total if you move forward with CreamyBits Luxe.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:.9rem;margin-bottom:1.25rem">
          <tr><td style="padding:.4rem .6rem;color:#6b7280;width:130px;font-weight:600">Event type</td><td style="padding:.4rem .6rem">${booking.event_type}</td></tr>
          ${booking.event_date ? `<tr style="background:#fdfaf3"><td style="padding:.4rem .6rem;color:#6b7280;font-weight:600">Event date</td><td style="padding:.4rem .6rem">${booking.event_date}</td></tr>` : ''}
          ${booking.guest_count ? `<tr><td style="padding:.4rem .6rem;color:#6b7280;font-weight:600">Est. guests</td><td style="padding:.4rem .6rem">${booking.guest_count}</td></tr>` : ''}
          <tr style="background:#fdfaf3"><td style="padding:.4rem .6rem;color:#6b7280;font-weight:600">Deposit paid</td><td style="padding:.4rem .6rem;color:#16a34a;font-weight:700">$40.00 ✓</td></tr>
        </table>
        <p style="font-size:.8rem;color:#9ca3af;margin:0">
          Note: The $40 consultation fee is non-refundable if you choose not to proceed with our services.
        </p>
      </div>
      <p style="text-align:center;color:#9ca3af;font-size:.75rem;margin-top:1rem">CreamyBits LLC · Albuquerque, NM · creamybitsllc@gmail.com</p>
    </div>`;

  const adminHtml = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
      <div style="background:linear-gradient(135deg,#1a1209,#2e1f0a);padding:1.5rem 2rem;border-radius:12px 12px 0 0">
        <h1 style="color:#f0d080;font-size:1.2rem;margin:0">✨ New Luxe Consultation Booking</h1>
      </div>
      <div style="background:#fff;border:1px solid #e5dcc8;border-top:none;border-radius:0 0 12px 12px;padding:2rem">
        <table style="width:100%;border-collapse:collapse;font-size:.9rem">
          <tr><td style="padding:.45rem .6rem;font-weight:700;color:#6b7280;width:130px">Name</td><td style="padding:.45rem .6rem">${booking.customer_name}</td></tr>
          <tr style="background:#fdfaf3"><td style="padding:.45rem .6rem;font-weight:700;color:#6b7280">Email</td><td style="padding:.45rem .6rem"><a href="mailto:${booking.customer_email}">${booking.customer_email}</a></td></tr>
          <tr><td style="padding:.45rem .6rem;font-weight:700;color:#6b7280">Phone</td><td style="padding:.45rem .6rem">${booking.customer_phone}</td></tr>
          <tr style="background:#fdfaf3"><td style="padding:.45rem .6rem;font-weight:700;color:#6b7280">Event type</td><td style="padding:.45rem .6rem">${booking.event_type}</td></tr>
          ${booking.event_date ? `<tr><td style="padding:.45rem .6rem;font-weight:700;color:#6b7280">Event date</td><td style="padding:.45rem .6rem">${booking.event_date}</td></tr>` : ''}
          ${booking.guest_count ? `<tr style="background:#fdfaf3"><td style="padding:.45rem .6rem;font-weight:700;color:#6b7280">Est. guests</td><td style="padding:.45rem .6rem">${booking.guest_count}</td></tr>` : ''}
          ${booking.notes ? `<tr><td style="padding:.45rem .6rem;font-weight:700;color:#6b7280;vertical-align:top">Notes</td><td style="padding:.45rem .6rem">${booking.notes}</td></tr>` : ''}
          <tr style="background:#fdfaf3"><td style="padding:.45rem .6rem;font-weight:700;color:#6b7280">Deposit</td><td style="padding:.45rem .6rem;color:#16a34a;font-weight:700">$40.00 PAID</td></tr>
        </table>
      </div>
    </div>`;

  await Promise.all([
    resend.emails.send({
      from:    `CreamyBits Luxe <orders@${process.env.RESEND_FROM_DOMAIN}>`,
      to:      booking.customer_email,
      subject: `Consultation booked – CreamyBits Luxe ✨`,
      html:    customerHtml,
    }),
    resend.emails.send({
      from:     `CreamyBits Luxe <orders@${process.env.RESEND_FROM_DOMAIN}>`,
      to:       process.env.ADMIN_EMAIL,
      reply_to: booking.customer_email,
      subject:  `New Luxe booking: ${booking.customer_name} · ${booking.event_type}`,
      html:     adminHtml,
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
    const s = event.data.object;

    // Luxe booking payment
    if (s.metadata && s.metadata.type === 'luxe_booking') {
      const bookingId = s.metadata.bookingId;
      try {
        const { rows } = await pool.query(
          `UPDATE luxe_bookings SET status='paid', paid_at=NOW(), stripe_session_id=$1
           WHERE id=$2 RETURNING *`,
          [s.id, bookingId]
        );
        if (rows[0]) {
          await sendLuxeBookingEmails(rows[0]).catch(e =>
            console.error('Luxe booking email failed:', e.message)
          );
        }
      } catch (e) { console.error('Luxe booking webhook error:', e.message); }
      return res.sendStatus(200);
    }

    // Class registration payment
    if (s.metadata && s.metadata.type === 'class_registration') {
      const regId = s.metadata.regId;
      try {
        await pool.query(
          `UPDATE class_registrations SET status='paid', paid_at=NOW(), stripe_session_id=$1 WHERE id=$2`,
          [s.id, regId]
        );
        const { rows: regRows } = await pool.query(
          'SELECT cr.*, c.title, c.class_date, c.class_time, c.telegram_link FROM class_registrations cr JOIN classes c ON c.id=cr.class_id WHERE cr.id=$1',
          [regId]
        );
        if (regRows[0]) {
          await pool.query(
            'UPDATE classes SET spots_left = GREATEST(spots_left - 1, 0) WHERE id=$1 AND spots_left IS NOT NULL',
            [regRows[0].class_id]
          );
          await sendClassConfirmationEmail(regRows[0]).catch(e =>
            console.error('Class email failed:', e.message)
          );
        }
      } catch(e) { console.error('Class registration webhook error:', e.message); }
      return res.sendStatus(200);
    }

    // Regular order payment
    const orderId = s.metadata && s.metadata.orderId;
    if (orderId) {
      const updated = await updateOrder(orderId, {
        status: 'paid',
        paidAt: new Date().toISOString(),
        stripePaymentIntent: s.payment_intent,
      });
      if (updated) {
        if (s.metadata.couponCode) {
          await pool.query('UPDATE coupons SET uses=uses+1 WHERE code=$1', [s.metadata.couponCode])
            .catch(e => console.error('Coupon increment failed:', e.message));
        }
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
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many checkout attempts. Please wait a few minutes and try again.' },
});

// ── Checkout session ──────────────────────────────────────────────────────────
app.post('/create-checkout-session', checkoutLimiter, async (req, res) => {
  const { items, customerName, customerEmail, customerPhone, pickupDay, pickupDate, pickupTime, allergies, couponCode } = req.body;

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'Cart is empty.' });

  for (const item of items) {
    if (typeof item.name  !== 'string' || item.name.trim() === '' ||
        typeof item.price !== 'number' || item.price <= 0 ||
        typeof item.qty   !== 'number' || item.qty < 1)
      return res.status(400).json({ error: 'Invalid cart item.' });
  }

  // Validate items against live DB: active status, price, qty bounds
  const { rows: productRows } = await pool.query(
    'SELECT name, price, variants, min_qty, max_qty FROM products WHERE active=true'
  );
  const productMap = new Map(productRows.map(p => [p.name, p]));
  for (const item of items) {
    const prod = productMap.get(item.name);
    if (!prod)
      return res.status(400).json({ error: `"${item.name}" is no longer available. Please remove it from your cart.` });
    // Resolve variant price if applicable, else fall back to base price
    let livePrice = parseFloat(prod.price);
    if (item.variant && Array.isArray(prod.variants)) {
      const v = prod.variants.find(v => v.label === item.variant);
      if (v) livePrice = parseFloat(v.price);
    }
    const sentPrice = parseFloat(item.price);
    if (Math.abs(livePrice - sentPrice) > 0.02)
      return res.status(400).json({ error: `The price for "${item.name}" has changed. Please refresh the page and update your cart.` });
    const min = prod.min_qty ?? 1;
    const max = prod.max_qty ?? null;
    if (item.qty < min)
      return res.status(400).json({ error: `Minimum order for "${item.name}" is ${min}.` });
    if (max !== null && item.qty > max)
      return res.status(400).json({ error: `Maximum order for "${item.name}" is ${max}.` });
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

  // Validate and apply coupon
  let appliedCoupon = null;
  let discountAmount = 0;
  const couponCodeUpper = couponCode ? couponCode.trim().toUpperCase() : '';
  if (couponCodeUpper) {
    const { rows: cRows } = await pool.query('SELECT * FROM coupons WHERE code=$1', [couponCodeUpper]);
    const c = cRows[0];
    if (!c || !c.active)
      return res.status(400).json({ error: 'Invalid or inactive coupon code.' });
    if (c.expires_at && new Date(c.expires_at) < new Date())
      return res.status(400).json({ error: 'This coupon has expired.' });
    if (c.max_uses !== null && c.uses >= c.max_uses)
      return res.status(400).json({ error: 'This coupon has reached its usage limit.' });
    appliedCoupon = c;
  }

  const orderId = uuidv4();
  const rawItems = items.map(item => ({ ...item, unit_amount: Math.round(item.price * 100) }));
  const subtotalCents = rawItems.reduce((s, i) => s + i.unit_amount * i.qty, 0);

  if (appliedCoupon) {
    const val = parseFloat(appliedCoupon.discount_value);
    if (appliedCoupon.discount_type === 'percent') {
      discountAmount = Math.round(subtotalCents * val) / 10000;
      const scale = 1 - val / 100;
      rawItems.forEach(i => { i.unit_amount = Math.max(1, Math.round(i.unit_amount * scale)); });
    } else {
      const discountCents = Math.min(Math.round(val * 100), subtotalCents - rawItems.length);
      discountAmount = discountCents / 100;
      const scale = (subtotalCents - discountCents) / subtotalCents;
      rawItems.forEach(i => { i.unit_amount = Math.max(1, Math.round(i.unit_amount * scale)); });
    }
  }

  const line_items = rawItems.map(item => ({
    price_data: {
      currency: 'usd',
      product_data: {
        name: item.name,
        ...(item.variant ? { description: item.variant } : {}),
      },
      unit_amount: item.unit_amount,
    },
    quantity: item.qty,
  }));

  const discountNote = appliedCoupon
    ? ` · Coupon ${appliedCoupon.code} applied (-$${discountAmount.toFixed(2)})`
    : '';

  try {
    const stripeSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items,
      success_url: `${BASE_URL}/success.html?order_id=${orderId}`,
      cancel_url:  `${BASE_URL}/cancel.html`,
      customer_email: customerEmail,
      metadata: { orderId, ...(appliedCoupon ? { couponCode: appliedCoupon.code } : {}) },
      custom_text: {
        submit: {
          message: `Pick-up: ${pickupDate || pickupDay} at ${pickupTime} · Albuquerque, NM. Confirmation sent to ${customerEmail}.${discountNote}`,
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
      couponCode: appliedCoupon ? appliedCoupon.code : null,
      discountAmount: discountAmount > 0 ? discountAmount : null,
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

// ── Public coupon validation ──────────────────────────────────────────────────
app.post('/validate-coupon', async (req, res) => {
  const code = (req.body.code || '').trim().toUpperCase();
  const subtotal = parseFloat(req.body.subtotal) || 0;
  if (!code) return res.status(400).json({ error: 'No coupon code provided.' });

  const { rows } = await pool.query('SELECT * FROM coupons WHERE code=$1', [code]);
  const coupon = rows[0];
  if (!coupon) return res.status(404).json({ error: 'Coupon code not found.' });
  if (!coupon.active) return res.status(400).json({ error: 'This coupon is no longer active.' });
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date())
    return res.status(400).json({ error: 'This coupon has expired.' });
  if (coupon.max_uses !== null && coupon.uses >= coupon.max_uses)
    return res.status(400).json({ error: 'This coupon has reached its usage limit.' });

  const value = parseFloat(coupon.discount_value);
  let savings = 0;
  if (coupon.discount_type === 'percent') {
    savings = Math.round(subtotal * value) / 100;
  } else {
    savings = Math.min(value, subtotal);
  }

  res.json({
    ok: true,
    code: coupon.code,
    discountType: coupon.discount_type,
    discountValue: value,
    savings: Math.round(savings * 100) / 100,
  });
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

// ── Image upload (Cloudflare R2) ─────────────────────────────────────────────
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed.'));
  },
});

app.post('/admin/upload-image', requireAdmin, imageUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  const ext = require('path').extname(req.file.originalname).toLowerCase() || '.jpg';
  const key = `products/${uuidv4()}${ext}`;
  try {
    await r2.send(new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET,
      Key:         key,
      Body:        req.file.buffer,
      ContentType: req.file.mimetype,
    }));
    const url = `${process.env.R2_PUBLIC_URL}/${key}`;
    res.json({ url });
  } catch (err) {
    console.error('R2 upload error:', err);
    res.status(500).json({ error: 'Image upload failed.' });
  }
});

app.get('/admin/products', requireAdmin, async (_req, res) => {
  res.json(await readProducts(true));
});

app.post('/admin/products', requireAdmin, async (req, res) => {
  const { name, description, category, imageUrl, emoji, price,
          unitLabel, variants, variantType, sortOrder, active, minQty, maxQty, stock } = req.body;
  if (!name || !category || price == null)
    return res.status(400).json({ error: 'name, category, price required.' });
  if (!/^[a-z0-9-]+$/.test(category))
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
    stock: stock != null && stock !== '' ? parseInt(stock) : null,
  });
  const { rows } = await pool.query('SELECT * FROM products WHERE id=$1', [id]);
  res.status(201).json(rowToProduct(rows[0]));
});

app.patch('/admin/products/:id', requireAdmin, async (req, res) => {
  const allowed = ['name','description','category','imageUrl','emoji','price',
                   'unitLabel','variants','variantType','sortOrder','active','minQty','maxQty','stock'];
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
  if (patch.stock !== undefined) patch.stock = patch.stock === null || patch.stock === '' ? null : parseInt(patch.stock);
  const updated = await updateProductById(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'Product not found.' });
  res.json(updated);
});

app.post('/admin/products/:id/set-upsell', requireAdmin, async (req, res) => {
  await pool.query('UPDATE products SET is_upsell=false');
  await pool.query('UPDATE products SET is_upsell=true WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.delete('/admin/products/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── Admin coupons ─────────────────────────────────────────────────────────────
app.get('/admin/coupons', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
  res.json(rows.map(r => ({
    id: r.id, code: r.code,
    discountType: r.discount_type, discountValue: parseFloat(r.discount_value),
    active: r.active, maxUses: r.max_uses, uses: r.uses,
    expiresAt: r.expires_at ? r.expires_at.toISOString().slice(0,10) : null,
    createdAt: r.created_at,
  })));
});

app.post('/admin/coupons', requireAdmin, async (req, res) => {
  const { code, discountType, discountValue, maxUses, expiresAt } = req.body;
  const cleanCode = (code || '').trim().toUpperCase();
  if (!cleanCode) return res.status(400).json({ error: 'Coupon code is required.' });
  if (!['percent', 'dollar'].includes(discountType))
    return res.status(400).json({ error: 'Discount type must be percent or dollar.' });
  const val = parseFloat(discountValue);
  if (isNaN(val) || val <= 0) return res.status(400).json({ error: 'Discount value must be positive.' });
  if (discountType === 'percent' && val > 100)
    return res.status(400).json({ error: 'Percent discount cannot exceed 100.' });
  const id = uuidv4();
  try {
    await pool.query(
      `INSERT INTO coupons (id, code, discount_type, discount_value, max_uses, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, cleanCode, discountType, val,
       maxUses ? parseInt(maxUses) : null,
       expiresAt || null]
    );
    const { rows } = await pool.query('SELECT * FROM coupons WHERE id=$1', [id]);
    const r = rows[0];
    res.status(201).json({ id: r.id, code: r.code, discountType: r.discount_type,
      discountValue: parseFloat(r.discount_value), active: r.active,
      maxUses: r.max_uses, uses: r.uses,
      expiresAt: r.expires_at ? r.expires_at.toISOString().slice(0,10) : null });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Coupon code already exists.' });
    throw e;
  }
});

app.patch('/admin/coupons/:id', requireAdmin, async (req, res) => {
  const { active } = req.body;
  if (active === undefined) return res.status(400).json({ error: 'Nothing to update.' });
  const { rows } = await pool.query(
    'UPDATE coupons SET active=$1 WHERE id=$2 RETURNING *', [!!active, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Coupon not found.' });
  const r = rows[0];
  res.json({ id: r.id, code: r.code, active: r.active });
});

app.delete('/admin/coupons/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM coupons WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── Classes (public) ─────────────────────────────────────────────────────────
const CLASS_COLS = 'id,title,description,class_date,class_time,price,capacity,spots_left,active,image_url,early_bird_price,early_bird_ends,registration_closes,show_spots';

function rowToClass(r) {
  const today = new Date().toISOString().slice(0,10);
  const ebEnds = r.early_bird_ends ? r.early_bird_ends.toISOString().slice(0,10) : null;
  const regCloses = r.registration_closes ? r.registration_closes.toISOString().slice(0,10) : null;
  const earlyBirdActive = r.early_bird_price != null && (ebEnds === null || today <= ebEnds);
  return {
    id: r.id, title: r.title, description: r.description,
    classDate: r.class_date ? r.class_date.toISOString().slice(0,10) : null,
    classTime: r.class_time,
    price: parseFloat(r.price),
    earlyBirdPrice: r.early_bird_price != null ? parseFloat(r.early_bird_price) : null,
    earlyBirdEnds: ebEnds,
    earlyBirdActive,
    registrationCloses: regCloses,
    registrationClosed: regCloses !== null && today > regCloses,
    capacity: r.capacity, spotsLeft: r.spots_left, showSpots: r.show_spots !== false, active: r.active,
    imageUrl: r.image_url || null,
  };
}

app.get('/classes/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${CLASS_COLS} FROM classes WHERE id=$1 AND active=true`, [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Class not found.' });
  res.json(rowToClass(rows[0]));
});

app.get('/classes', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT ${CLASS_COLS} FROM classes WHERE active=true ORDER BY class_date ASC, created_at ASC`
  );
  res.json(rows.map(rowToClass));
});

app.post('/create-class-session', async (req, res) => {
  const { classId, customerName, customerEmail, customerPhone } = req.body;
  if (!classId || !customerName || !customerEmail)
    return res.status(400).json({ error: 'Class, name and email are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))
    return res.status(400).json({ error: 'Please enter a valid email address.' });

  const { rows } = await pool.query('SELECT * FROM classes WHERE id=$1 AND active=true', [classId]);
  const cls = rows[0];
  if (!cls) return res.status(404).json({ error: 'Class not found or no longer available.' });
  if (cls.spots_left !== null && cls.spots_left <= 0)
    return res.status(400).json({ error: 'Sorry, this class is full.' });

  const today = new Date().toISOString().slice(0,10);
  if (cls.registration_closes) {
    const closes = cls.registration_closes.toISOString().slice(0,10);
    if (today > closes) return res.status(400).json({ error: 'Registration for this class is closed.' });
  }

  const ebEnds = cls.early_bird_ends ? cls.early_bird_ends.toISOString().slice(0,10) : null;
  const earlyBirdActive = cls.early_bird_price != null && (ebEnds === null || today <= ebEnds);
  const chargePrice = earlyBirdActive ? parseFloat(cls.early_bird_price) : parseFloat(cls.price);

  const regId = uuidv4();
  await pool.query(
    `INSERT INTO class_registrations (id, class_id, customer_name, customer_email, customer_phone, status)
     VALUES ($1,$2,$3,$4,$5,'pending_payment')`,
    [regId, classId, customerName.trim(), customerEmail.trim().toLowerCase(), (customerPhone||'').trim()]
  );

  const dateLabel = cls.class_date ? new Date(cls.class_date).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}) : 'TBD';
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: cls.title, description: `${dateLabel}${cls.class_time ? ' · ' + cls.class_time : ''}` },
          unit_amount: Math.round(chargePrice * 100),
        },
        quantity: 1,
      }],
      customer_email: customerEmail.trim().toLowerCase(),
      success_url: `${BASE_URL}/class-success.html?reg_id=${regId}`,
      cancel_url:  `${BASE_URL}/class-detail.html?id=${classId}`,
      metadata: { type: 'class_registration', regId, classId },
    });
    res.json({ url: session.url });
  } catch(e) {
    console.error('Stripe class error:', e.message);
    res.status(500).json({ error: 'Unable to start checkout. Please try again.' });
  }
});

app.get('/class-registration/:id/telegram', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cr.status, cr.customer_name, c.telegram_link, c.title, c.class_date, c.class_time
     FROM class_registrations cr JOIN classes c ON c.id=cr.class_id WHERE cr.id=$1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Registration not found.' });
  if (rows[0].status !== 'paid') return res.status(402).json({ error: 'Payment not confirmed yet.' });
  const r = rows[0];
  res.json({
    telegramLink: r.telegram_link,
    classTitle:   r.title,
    classDate:    r.class_date ? r.class_date.toISOString().slice(0,10) : null,
    classTime:    r.class_time,
    customerName: r.customer_name,
  });
});

// ── Admin classes ─────────────────────────────────────────────────────────────
function rowToClassAdmin(r) {
  return {
    id: r.id, title: r.title, description: r.description,
    classDate: r.class_date ? r.class_date.toISOString().slice(0,10) : null,
    classTime: r.class_time, price: parseFloat(r.price),
    earlyBirdPrice: r.early_bird_price != null ? parseFloat(r.early_bird_price) : null,
    earlyBirdEnds: r.early_bird_ends ? r.early_bird_ends.toISOString().slice(0,10) : null,
    registrationCloses: r.registration_closes ? r.registration_closes.toISOString().slice(0,10) : null,
    capacity: r.capacity, spotsLeft: r.spots_left, showSpots: r.show_spots !== false,
    telegramLink: r.telegram_link, active: r.active, createdAt: r.created_at,
    imageUrl: r.image_url || null,
  };
}

app.get('/admin/classes', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM classes ORDER BY class_date ASC, created_at ASC');
  res.json(rows.map(rowToClassAdmin));
});

app.post('/admin/classes', requireAdmin, async (req, res) => {
  const { title, description, classDate, classTime, price, capacity, telegramLink, imageUrl,
          earlyBirdPrice, earlyBirdEnds, registrationCloses, showSpots } = req.body;
  if (!title || !price || !telegramLink)
    return res.status(400).json({ error: 'Title, price and Telegram link are required.' });
  const id  = uuidv4();
  const cap = capacity ? parseInt(capacity) : null;
  await pool.query(
    `INSERT INTO classes (id,title,description,class_date,class_time,price,capacity,spots_left,telegram_link,image_url,early_bird_price,early_bird_ends,registration_closes,show_spots)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, title.trim(), description||null, classDate||null, classTime||null, parseFloat(price), cap, cap,
     telegramLink.trim(), imageUrl||null,
     earlyBirdPrice != null ? parseFloat(earlyBirdPrice) : null,
     earlyBirdEnds||null, registrationCloses||null, showSpots !== false]
  );
  const { rows } = await pool.query('SELECT * FROM classes WHERE id=$1', [id]);
  res.status(201).json(rowToClassAdmin(rows[0]));
});

app.patch('/admin/classes/:id', requireAdmin, async (req, res) => {
  const allowed = { title:'title', description:'description', classDate:'class_date', classTime:'class_time',
    price:'price', capacity:'capacity', spotsLeft:'spots_left', telegramLink:'telegram_link', active:'active',
    imageUrl:'image_url', earlyBirdPrice:'early_bird_price', earlyBirdEnds:'early_bird_ends',
    registrationCloses:'registration_closes', showSpots:'show_spots' };
  const sets=[]; const vals=[]; let i=1;
  for (const [key, col] of Object.entries(allowed)) {
    if (req.body[key] !== undefined) { sets.push(`${col}=$${i++}`); vals.push(req.body[key] === '' ? null : req.body[key]); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  vals.push(req.params.id);
  const { rows } = await pool.query(`UPDATE classes SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
  if (!rows.length) return res.status(404).json({ error: 'Class not found.' });
  res.json(rowToClassAdmin(rows[0]));
});

app.delete('/admin/classes/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM classes WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/admin/class-registrations', requireAdmin, async (req, res) => {
  const { classId } = req.query;
  const q = classId
    ? 'SELECT cr.*, c.title FROM class_registrations cr JOIN classes c ON c.id=cr.class_id WHERE cr.class_id=$1 ORDER BY cr.created_at DESC'
    : 'SELECT cr.*, c.title FROM class_registrations cr JOIN classes c ON c.id=cr.class_id ORDER BY cr.created_at DESC';
  const { rows } = await pool.query(q, classId ? [classId] : []);
  res.json(rows.map(r => ({
    id: r.id, classId: r.class_id, classTitle: r.title,
    customerName: r.customer_name, customerEmail: r.customer_email, customerPhone: r.customer_phone,
    status: r.status, paidAt: r.paid_at, createdAt: r.created_at,
  })));
});

function classEmailHeader() {
  return `<div style="background:#0f0f0f;padding:28px 32px;text-align:center">
    <span style="color:#fff;font-size:22px;font-weight:900;letter-spacing:1px">🥧 CreamyBits</span><br>
    <span style="color:#9ca3af;font-size:13px">Cooking Classes · Albuquerque, NM</span>
  </div>`;
}

function classEmailDetails(reg, dateLabel) {
  return `<table style="font-size:14px;margin-bottom:20px;width:100%;border-collapse:collapse" cellpadding="0" cellspacing="0">
    <tr><td style="color:#6b7280;width:130px;padding:5px 0;vertical-align:top">Class</td><td><strong>${reg.title}</strong></td></tr>
    <tr><td style="color:#6b7280;padding:5px 0">Date</td><td>${dateLabel}</td></tr>
    ${reg.class_time ? `<tr><td style="color:#6b7280;padding:5px 0">Time</td><td>${reg.class_time}</td></tr>` : ''}
    <tr><td style="color:#6b7280;padding:5px 0">Name</td><td>${reg.customer_name}</td></tr>
    <tr><td style="color:#6b7280;padding:5px 0">Email</td><td>${reg.customer_email}</td></tr>
    ${reg.customer_phone ? `<tr><td style="color:#6b7280;padding:5px 0">Phone</td><td>${reg.customer_phone}</td></tr>` : ''}
    <tr><td style="color:#6b7280;padding:5px 0">Ref #</td><td>${reg.id.slice(0,8).toUpperCase()}</td></tr>
  </table>`;
}

function telegramButton(link) {
  return `<div style="text-align:center;margin:24px 0">
    <a href="${link}" style="display:inline-block;background:#229ED9;color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:700;font-size:15px">
      ✈️ Join Telegram Group →
    </a>
  </div>
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin:0">Save this email — this link is your way into the group.</p>`;
}

async function sendClassConfirmationEmail(reg) {
  const dateLabel = reg.class_date
    ? new Date(reg.class_date).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})
    : 'TBD';

  const customerHtml = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #f0f0f0">
    ${classEmailHeader()}
    <div style="padding:32px">
      <h2 style="margin:0 0 8px;font-size:22px">You're in, ${reg.customer_name}! 🎉</h2>
      <p style="color:#6b7280;margin:0 0 24px;line-height:1.6">Your spot in <strong>${reg.title}</strong> is confirmed and payment received.</p>
      ${classEmailDetails(reg, dateLabel)}
      ${reg.telegram_link ? telegramButton(reg.telegram_link) : `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:14px 18px;margin-bottom:20px">
        <p style="margin:0;font-size:14px;color:#166534;line-height:1.6">
          ✅ <strong>Access your Telegram group link:</strong><br>
          <a href="${process.env.BASE_URL}/class-success.html?reg_id=${reg.id}" style="color:#166534">${process.env.BASE_URL}/class-success.html?reg_id=${reg.id}</a>
        </p>
      </div>`}
      <p style="font-size:12px;color:#9ca3af;margin-top:24px">Questions? Email creamybitsllc@gmail.com</p>
    </div>
  </div>`;

  const adminHtml = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #f0f0f0">
    ${classEmailHeader()}
    <div style="padding:32px">
      <h2 style="margin:0 0 8px;font-size:20px">New class registration 🎓</h2>
      <p style="color:#6b7280;margin:0 0 24px">Someone just paid and registered for a class.</p>
      ${classEmailDetails(reg, dateLabel)}
    </div>
  </div>`;

  await Promise.all([
    resend.emails.send({
      from: `CreamyBits <orders@${process.env.RESEND_FROM_DOMAIN}>`,
      to: reg.customer_email,
      subject: `You're registered for ${reg.title}! 🎓`,
      html: customerHtml,
    }),
    resend.emails.send({
      from: `CreamyBits <orders@${process.env.RESEND_FROM_DOMAIN}>`,
      to: process.env.ADMIN_EMAIL,
      reply_to: reg.customer_email,
      subject: `New class registration: ${reg.customer_name} → ${reg.title}`,
      html: adminHtml,
    }),
  ]);
}

async function sendClassReminderEmails() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowISO = tomorrow.toISOString().slice(0,10);
  try {
    const { rows } = await pool.query(
      `SELECT cr.id, cr.customer_name, cr.customer_email, cr.customer_phone,
              c.title, c.class_date, c.class_time, c.telegram_link
       FROM class_registrations cr
       JOIN classes c ON c.id = cr.class_id
       WHERE cr.status = 'paid'
         AND cr.reminder_sent = false
         AND c.class_date::date = $1`,
      [tomorrowISO]
    );
    for (const reg of rows) {
      const dateLabel = new Date(reg.class_date).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
      const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #f0f0f0">
        ${classEmailHeader()}
        <div style="padding:32px">
          <h2 style="margin:0 0 8px;font-size:22px">Your class is tomorrow! ⏰</h2>
          <p style="color:#6b7280;margin:0 0 24px;line-height:1.6">Just a reminder — <strong>${reg.title}</strong> is happening tomorrow. We can't wait to see you!</p>
          ${classEmailDetails(reg, dateLabel)}
          ${reg.telegram_link ? telegramButton(reg.telegram_link) : ''}
          <p style="font-size:12px;color:#9ca3af;margin-top:24px">Questions? Email creamybitsllc@gmail.com</p>
        </div>
      </div>`;
      await resend.emails.send({
        from: `CreamyBits <orders@${process.env.RESEND_FROM_DOMAIN}>`,
        to: reg.customer_email,
        subject: `Reminder: ${reg.title} is tomorrow 🎓`,
        html,
      });
      await pool.query('UPDATE class_registrations SET reminder_sent=true WHERE id=$1', [reg.id]);
      console.log(`Reminder sent to ${reg.customer_email} for ${reg.title}`);
    }
  } catch(e) {
    console.error('Class reminder error:', e.message);
  }
}

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
  const items = order.items || [];
  const total = items.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2);
  const shortId = order.id.slice(0, 8).toUpperCase();
  const itemRows = items.map(i =>
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
      from:     `CreamyBits <orders@${process.env.RESEND_FROM_DOMAIN}>`,
      reply_to: 'creamybitsllc@gmail.com',
      to:       order.customerEmail,
      subject:  `Thanks for picking up your order! – CreamyBits 🥧`,
      html:     buildEmailHtml(customerBody, itemRows, total, order),
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
  const { status, pickupStatus, pickupDay, pickupDate, pickupTime } = req.body;
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

  if (pickupDay !== undefined) {
    if (!['Saturday', 'Sunday'].includes(pickupDay))
      return res.status(400).json({ error: 'Pick-up day must be Saturday or Sunday.' });
    patch.pickupDay = pickupDay;
  }
  if (pickupDate !== undefined) patch.pickupDate = pickupDate || null;
  if (pickupTime !== undefined) {
    const validTimes = ['10:00 AM', '11:00 AM', '12:00 PM'];
    if (!validTimes.includes(pickupTime))
      return res.status(400).json({ error: 'Invalid pickup time.' });
    patch.pickupTime = pickupTime;
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

app.delete('/admin/orders/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT status FROM orders WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
  if (rows[0].status !== 'pending_payment')
    return res.status(400).json({ error: 'Only pending payment orders can be deleted.' });
  await pool.query('DELETE FROM orders WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── Luxe menu (public) ───────────────────────────────────────────────────────
app.get('/luxe-sections', async (_req, res) => {
  const { rows } = await pool.query('SELECT id,title,sort_order FROM luxe_sections WHERE archived=false ORDER BY sort_order, id');
  res.json(rows);
});

app.get('/luxe-items', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM luxe_items WHERE active=true ORDER BY section, sort_order, name'
  );
  res.json(rows);
});

// ── Luxe sections (admin) ────────────────────────────────────────────────────
app.get('/admin/luxe-sections', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM luxe_sections WHERE archived=false ORDER BY sort_order, id');
  res.json(rows);
});

app.get('/admin/luxe-sections/archived', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM luxe_sections WHERE archived=true ORDER BY sort_order, id');
  res.json(rows);
});

app.post('/admin/luxe-sections', requireAdmin, async (req, res) => {
  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
  const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20);
  const id = `${base}_${Date.now().toString(36)}`;
  const { rows: existing } = await pool.query('SELECT COALESCE(MAX(sort_order),0) AS max FROM luxe_sections');
  const sortOrder = (existing[0]?.max || 0) + 1;
  const { rows } = await pool.query(
    'INSERT INTO luxe_sections (id,title,sort_order,archived) VALUES ($1,$2,$3,false) RETURNING *',
    [id, title.trim(), sortOrder]
  );
  res.json(rows[0]);
});

// Move to trash (soft delete)
app.patch('/admin/luxe-sections/:id/archive', requireAdmin, async (req, res) => {
  await pool.query('UPDATE luxe_sections SET archived=true WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Restore from trash
app.patch('/admin/luxe-sections/:id/restore', requireAdmin, async (req, res) => {
  await pool.query('UPDATE luxe_sections SET archived=false WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Permanent delete (only from trash)
app.delete('/admin/luxe-sections/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM luxe_sections WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── Luxe menu items (admin CRUD) ──────────────────────────────────────────────
app.get('/admin/luxe-items', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM luxe_items ORDER BY section, sort_order, name');
  res.json(rows);
});

app.post('/admin/luxe-items', requireAdmin, async (req, res) => {
  const { section, name, price, onRequest, sortOrder } = req.body;
  if (!section || !name) return res.status(400).json({ error: 'section and name are required.' });
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO luxe_items (id, section, name, price, on_request, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, section, name.trim(), price || null, !!onRequest, parseInt(sortOrder) || 0]
  );
  res.status(201).json(rows[0]);
});

app.patch('/admin/luxe-items/:id', requireAdmin, async (req, res) => {
  const colMap = { name:'name', price:'price', onRequest:'on_request', sortOrder:'sort_order', active:'active' };
  const sets = [], vals = [];
  let i = 1;
  for (const [key, col] of Object.entries(colMap)) {
    if (req.body[key] !== undefined) {
      sets.push(`${col}=$${i++}`);
      if (key === 'onRequest' || key === 'active') vals.push(!!req.body[key]);
      else if (key === 'price') vals.push(req.body[key] || null);
      else if (key === 'sortOrder') vals.push(parseInt(req.body[key]) || 0);
      else vals.push(req.body[key]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  vals.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE luxe_items SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  res.json(rows[0]);
});

app.delete('/admin/luxe-items/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM luxe_items WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── Luxe invoices ─────────────────────────────────────────────────────────────
function rowToInvoice(r) {
  return {
    id: r.id, invoiceNumber: r.invoice_number,
    customerName: r.customer_name || null, customerEmail: r.customer_email || null,
    customerPhone: r.customer_phone || null,
    eventDate: r.event_date ? r.event_date.toISOString().slice(0,10) : null,
    eventType: r.event_type || null, numGuests: r.num_guests || null,
    lineItems: r.line_items || [], notes: r.notes || null,
    subtotal: parseFloat(r.subtotal||0), taxRate: parseFloat(r.tax_rate||0),
    discount: parseFloat(r.discount||0), total: parseFloat(r.total||0),
    createdAt: r.created_at,
  };
}

app.get('/admin/luxe-invoices', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM luxe_invoices ORDER BY created_at DESC');
  res.json(rows.map(rowToInvoice));
});

app.post('/admin/luxe-invoices', requireAdmin, async (req, res) => {
  const { invoiceNumber, customerName, customerEmail, customerPhone, eventDate, eventType,
          numGuests, lineItems, notes, subtotal, taxRate, discount, total } = req.body;
  if (!invoiceNumber) return res.status(400).json({ error: 'Invoice number required.' });
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO luxe_invoices (id,invoice_number,customer_name,customer_email,customer_phone,
      event_date,event_type,num_guests,line_items,notes,subtotal,tax_rate,discount,total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [id, invoiceNumber, customerName||null, customerEmail||null, customerPhone||null,
     eventDate||null, eventType||null, numGuests||null,
     JSON.stringify(lineItems||[]), notes||null,
     subtotal||0, taxRate||0, discount||0, total||0]
  );
  res.status(201).json(rowToInvoice(rows[0]));
});

app.patch('/admin/luxe-invoices/:id', requireAdmin, async (req, res) => {
  const { invoiceNumber, customerName, customerEmail, customerPhone, eventDate, eventType,
          numGuests, lineItems, notes, subtotal, taxRate, discount, total } = req.body;
  const { rows } = await pool.query(
    `UPDATE luxe_invoices SET invoice_number=$1,customer_name=$2,customer_email=$3,
      customer_phone=$4,event_date=$5,event_type=$6,num_guests=$7,line_items=$8,
      notes=$9,subtotal=$10,tax_rate=$11,discount=$12,total=$13
     WHERE id=$14 RETURNING *`,
    [invoiceNumber, customerName||null, customerEmail||null, customerPhone||null,
     eventDate||null, eventType||null, numGuests||null,
     JSON.stringify(lineItems||[]), notes||null,
     subtotal||0, taxRate||0, discount||0, total||0, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Invoice not found.' });
  res.json(rowToInvoice(rows[0]));
});

app.delete('/admin/luxe-invoices/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM luxe_invoices WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── Admin pages ───────────────────────────────────────────────────────────────
app.get('/admin', requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Full menu page
app.get('/menu', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

// Luxe menu
app.get('/luxe', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'luxe.html'));
});
// ── Deals (public) ───────────────────────────────────────────────────────────
app.get('/deals', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT d.id, d.discount_type, d.discount_value,
           p.id AS product_id, p.name, p.price, p.image_url, p.emoji,
           p.variant_type, p.variants, p.unit_label, p.description
    FROM deals d
    JOIN products p ON p.id = d.product_id
    WHERE d.active = true AND p.active = true
    ORDER BY d.created_at
  `);
  const result = rows.map(r => {
    const orig = parseFloat(r.price);
    const disc = parseFloat(r.discount_value);
    const sale = r.discount_type === 'percent'
      ? Math.max(0, orig * (1 - disc / 100))
      : Math.max(0, orig - disc);
    return { ...r, original_price: orig.toFixed(2), sale_price: sale.toFixed(2) };
  });
  res.json(result);
});

// ── Deals (admin CRUD) ────────────────────────────────────────────────────────
app.get('/admin/deals', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT d.*, p.name AS product_name, p.price AS product_price
    FROM deals d JOIN products p ON p.id = d.product_id
    ORDER BY d.created_at
  `);
  res.json(rows);
});

app.post('/admin/deals', requireAdmin, async (req, res) => {
  try {
    const { productId, discountType, discountValue, active } = req.body;
    if (!productId || !discountValue) return res.status(400).json({ error: 'Missing fields' });
    const id = uuidv4();
    const { rows } = await pool.query(
      'INSERT INTO deals (id,product_id,discount_type,discount_value,active) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [id, productId, discountType || 'percent', discountValue, active !== false]
    );
    res.json(rows[0]);
  } catch(e) {
    console.error('POST /admin/deals error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/admin/deals/:id', requireAdmin, async (req, res) => {
  const { active, discountType, discountValue } = req.body;
  const fields = [];
  const vals = [];
  if (active !== undefined) { fields.push(`active=$${vals.length+1}`); vals.push(active); }
  if (discountType)         { fields.push(`discount_type=$${vals.length+1}`); vals.push(discountType); }
  if (discountValue !== undefined) { fields.push(`discount_value=$${vals.length+1}`); vals.push(discountValue); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await pool.query(`UPDATE deals SET ${fields.join(',')} WHERE id=$${vals.length}`, vals);
  res.json({ ok: true });
});

app.delete('/admin/deals/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM deals WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/luxe-menu', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'luxe-menu.html'));
});

// Luxe catering inquiry form
app.get('/luxe-form', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'luxe-form.html'));
});

// Luxe consultation booking
app.get('/luxe-booking', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'luxe-booking.html'));
});
app.get('/luxe-booking-success', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'luxe-booking-success.html'));
});

app.post('/create-luxe-booking', express.json(), async (req, res) => {
  const { customerName, customerEmail, customerPhone, eventType, guestCount, eventDate, notes } = req.body;
  if (!customerName || !customerEmail || !customerPhone || !eventType)
    return res.status(400).json({ error: 'Name, email, phone and event type are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))
    return res.status(400).json({ error: 'Please enter a valid email address.' });

  const bookingId = uuidv4();
  await pool.query(
    `INSERT INTO luxe_bookings (id, status, customer_name, customer_email, customer_phone, event_type, guest_count, event_date, notes)
     VALUES ($1,'pending_payment',$2,$3,$4,$5,$6,$7,$8)`,
    [bookingId, customerName, customerEmail, customerPhone, eventType, guestCount || null, eventDate || null, notes || null]
  );

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'CreamyBits Luxe — Consultation Deposit',
          description: 'Non-refundable $40 deposit credited toward your total if you book our services.',
        },
        unit_amount: 4000,
      },
      quantity: 1,
    }],
    customer_email: customerEmail,
    metadata: { type: 'luxe_booking', bookingId },
    success_url: `${BASE_URL}/luxe-booking-success`,
    cancel_url:  `${BASE_URL}/luxe-booking`,
  });

  res.json({ url: session.url });
});

app.post('/luxe-inquiry', express.json(), async (req, res) => {
  const { firstName, lastName, email, phone, eventType, guests, eventDate, eventTime,
          city, state, zip, services, description } = req.body;

  if (!firstName || !lastName || !email || !phone || !eventType || !guests ||
      !eventDate || !eventTime || !city || !state || !zip ||
      !services || services.length === 0) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const fullName = `${firstName} ${lastName}`;
  const address  = [city, state, zip].filter(Boolean).join(', ');
  const servicesList = services.map(s => `<li>${s}</li>`).join('');

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
      <div style="background:linear-gradient(135deg,#1a1209,#2e1f0a);padding:2rem;border-radius:12px 12px 0 0;text-align:center">
        <h1 style="color:#f0d080;font-size:1.4rem;margin:0">✨ Luxe Catering Inquiry</h1>
      </div>
      <div style="background:#fff;border:1px solid #e5dcc8;border-top:none;border-radius:0 0 12px 12px;padding:2rem">
        <table style="width:100%;border-collapse:collapse;font-size:.93rem">
          <tr><td style="padding:.5rem .75rem;font-weight:700;width:160px;color:#6b7280">Name</td><td style="padding:.5rem .75rem">${fullName}</td></tr>
          <tr style="background:#fdfaf3"><td style="padding:.5rem .75rem;font-weight:700;color:#6b7280">Email</td><td style="padding:.5rem .75rem"><a href="mailto:${email}">${email}</a></td></tr>
          <tr><td style="padding:.5rem .75rem;font-weight:700;color:#6b7280">Phone</td><td style="padding:.5rem .75rem">${phone}</td></tr>
          <tr style="background:#fdfaf3"><td style="padding:.5rem .75rem;font-weight:700;color:#6b7280">Event Type</td><td style="padding:.5rem .75rem">${eventType}</td></tr>
          <tr><td style="padding:.5rem .75rem;font-weight:700;color:#6b7280">Date</td><td style="padding:.5rem .75rem">${eventDate}</td></tr>
          <tr style="background:#fdfaf3"><td style="padding:.5rem .75rem;font-weight:700;color:#6b7280">Time</td><td style="padding:.5rem .75rem">${eventTime}</td></tr>
          <tr><td style="padding:.5rem .75rem;font-weight:700;color:#6b7280">Location</td><td style="padding:.5rem .75rem">${address}</td></tr>
          <tr style="background:#fdfaf3"><td style="padding:.5rem .75rem;font-weight:700;color:#6b7280">Guests</td><td style="padding:.5rem .75rem">${guests}</td></tr>
          <tr><td style="padding:.5rem .75rem;font-weight:700;color:#6b7280;vertical-align:top">Services</td><td style="padding:.5rem .75rem"><ul style="margin:0;padding-left:1.2rem">${servicesList}</ul></td></tr>
          ${description ? `<tr style="background:#fdfaf3"><td style="padding:.5rem .75rem;font-weight:700;color:#6b7280;vertical-align:top">Details</td><td style="padding:.5rem .75rem">${description}</td></tr>` : ''}
        </table>
      </div>
      <p style="text-align:center;color:#9ca3af;font-size:.78rem;margin-top:1rem">CreamyBits LLC · Albuquerque, NM</p>
    </div>`;

  try {
    await resend.emails.send({
      from:     `CreamyBits <orders@${process.env.RESEND_FROM_DOMAIN}>`,
      to:       process.env.ADMIN_EMAIL,
      reply_to: email,
      subject:  `Luxe Catering Inquiry – ${fullName} · ${eventType} on ${eventDate}`,
      html,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Luxe inquiry email error:', err.message);
    res.status(500).json({ error: 'Failed to send inquiry.' });
  }
});

// Legal pages
app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});
app.get('/terms', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// Fallback SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server only when run directly (not when required by tests)
if (require.main === module) {
  app.listen(PORT, () => console.log(`✅  CreamyBits → http://localhost:${PORT}`));
  initDB().catch(err => console.error('DB init error:', err.message));
  // Run reminder check every hour; sends 24-hr emails to paid registrants when class is tomorrow
  setInterval(() => sendClassReminderEmails(), 60 * 60 * 1000);
  sendClassReminderEmails();
}

module.exports = app;
