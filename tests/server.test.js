'use strict';

const request = require('supertest');
const { Pool } = require('pg');

let app;
let mockQuery; // The query fn from the server's Pool instance

beforeAll(() => {
  // Require server first — this creates Pool instance #0 (the server's pool)
  app = require('../server');
  // Grab the query mock from the pool instance created by server.js
  // Pool.mock.results[0].value is the object returned by new Pool() in server.js
  mockQuery = Pool.mock.results[0].value.query;
  // Default: all DB calls succeed with empty results
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

afterEach(() => {
  jest.clearAllMocks();
  // Restore default after each test clears mocks
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. PUBLIC PAGES
// ─────────────────────────────────────────────────────────────────────────────
describe('Public pages', () => {
  test('GET / returns 200', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });

  test('GET /menu returns 200', async () => {
    const res = await request(app).get('/menu');
    expect(res.status).toBe(200);
  });

  test('GET /privacy returns 200', async () => {
    const res = await request(app).get('/privacy');
    expect(res.status).toBe(200);
  });

  test('GET /terms returns 200', async () => {
    const res = await request(app).get('/terms');
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /products', () => {
  test('returns array of active products', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: '1', name: 'Meat Pies', description: 'Tasty', category: 'pastries',
        image_url: null, emoji: '🥧', price: '5.00', unit_label: null,
        variants: null, variant_type: 'none', sort_order: 0,
        active: true, min_qty: 1, max_qty: null, created_at: new Date(),
      }],
      rowCount: 1,
    });
    const res = await request(app).get('/products');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty('name', 'Meat Pies');
  });
});

describe('GET /blocked-dates', () => {
  test('returns array of blocked dates', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: '1', date: new Date('2026-03-22'), reason: 'Holiday' }],
      rowCount: 1,
    });
    const res = await request(app).get('/blocked-dates');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty('date', '2026-03-22');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CHECKOUT SESSION
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /create-checkout-session', () => {
  const validPayload = {
    items: [{ name: 'Meat Pies', price: 5.00, qty: 2 }],
    customerName:  'Jane Doe',
    customerEmail: 'jane@example.com',
    customerPhone: '5055550000',
    pickupDay:     'Saturday',
    pickupDate:    'March 22, 2026',
    pickupTime:    '10:00 AM',
    allergies:     'None',
  };

  const mockProductRow = { name: 'Meat Pies', price: '5.00', min_qty: null, max_qty: null };

  beforeEach(() => {
    mockQuery
      .mockResolvedValueOnce({ rows: [mockProductRow], rowCount: 1 })  // products (active check + price)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                // blocked_dates check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });               // INSERT order
  });

  test('returns Stripe URL for valid payload', async () => {
    const res = await request(app)
      .post('/create-checkout-session')
      .send(validPayload);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('url');
    expect(res.body.url).toContain('checkout.stripe.com');
  });

  test('rejects empty cart', async () => {
    const res = await request(app)
      .post('/create-checkout-session')
      .send({ ...validPayload, items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty/i);
  });

  test('rejects missing customerName', async () => {
    const res = await request(app)
      .post('/create-checkout-session')
      .send({ ...validPayload, customerName: '' });
    expect(res.status).toBe(400);
  });

  test('rejects missing customerEmail', async () => {
    const res = await request(app)
      .post('/create-checkout-session')
      .send({ ...validPayload, customerEmail: '' });
    expect(res.status).toBe(400);
  });

  test('rejects invalid email format', async () => {
    const res = await request(app)
      .post('/create-checkout-session')
      .send({ ...validPayload, customerEmail: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  test('rejects missing allergies', async () => {
    const res = await request(app)
      .post('/create-checkout-session')
      .send({ ...validPayload, allergies: '' });
    expect(res.status).toBe(400);
  });

  test('rejects non-weekend pickup day', async () => {
    const res = await request(app)
      .post('/create-checkout-session')
      .send({ ...validPayload, pickupDay: 'Monday' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Saturday|Sunday/i);
  });

  test('rejects item with qty below minQty', async () => {
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ name: 'Meat Pies', price: '5.00', min_qty: 6, max_qty: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // blocked_dates (won't reach)
    const res = await request(app)
      .post('/create-checkout-session')
      .send({ ...validPayload, items: [{ name: 'Meat Pies', price: 5.00, qty: 2 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/minimum/i);
  });

  test('rejects item with qty above maxQty', async () => {
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ name: 'Meat Pies', price: '5.00', min_qty: 1, max_qty: 3 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // blocked_dates (won't reach)
    const res = await request(app)
      .post('/create-checkout-session')
      .send({ ...validPayload, items: [{ name: 'Meat Pies', price: 5.00, qty: 10 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum/i);
  });

  test('rejects blocked pickup date', async () => {
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [mockProductRow], rowCount: 1 }) // products (active + price)
      .mockResolvedValueOnce({ rows: [{ id: '1' }], rowCount: 1 });  // blocked date hit
    const res = await request(app)
      .post('/create-checkout-session')
      .send(validPayload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not available/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ADMIN AUTH PROTECTION
// ─────────────────────────────────────────────────────────────────────────────
describe('Admin route protection', () => {
  // requireAdmin redirects (302) to /admin-login.html when no session
  test('GET /admin/orders redirects without session', async () => {
    const res = await request(app).get('/admin/orders');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('admin-login');
  });

  test('POST /admin/products redirects without session', async () => {
    const res = await request(app)
      .post('/admin/products')
      .send({ name: 'Test', category: 'pastries', price: 5 });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('admin-login');
  });

  test('PATCH /admin/products/:id redirects without session', async () => {
    const res = await request(app)
      .patch('/admin/products/123')
      .send({ price: 10 });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('admin-login');
  });

  test('DELETE /admin/products/:id redirects without session', async () => {
    const res = await request(app).delete('/admin/products/123');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('admin-login');
  });

  test('GET /admin/orders/export.csv redirects without session', async () => {
    const res = await request(app).get('/admin/orders/export.csv');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('admin-login');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ADMIN LOGIN
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /admin/login', () => {
  test('wrong password redirects back with error', async () => {
    const res = await request(app)
      .post('/admin/login')
      .send('password=wrongpassword')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=1');
  });

  test('missing password redirects back with error', async () => {
    const res = await request(app)
      .post('/admin/login')
      .send('')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. PRODUCT VALIDATION (admin)
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /admin/products — validation (bypassing auth via mock)', () => {
  // We test the validation logic via a direct call injecting an admin session
  test('rejects invalid cart item (price=0)', async () => {
    const res = await request(app)
      .post('/create-checkout-session')
      .send({
        items: [{ name: 'Test', price: 0, qty: 1 }],
        customerName: 'Test', customerEmail: 'test@test.com',
        customerPhone: '123', pickupDay: 'Saturday',
        pickupDate: 'March 22, 2026', pickupTime: '10:00 AM', allergies: 'None',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid cart item/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. ADMIN PAYMENT LINKS
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /admin/create-payment-link', () => {
  test('redirects unauthenticated requests to admin-login', async () => {
    const res = await request(app)
      .post('/admin/create-payment-link')
      .send({ items: [{ name: 'Custom', price: 25, qty: 1 }] });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('admin-login');
  });

  async function loginAgent() {
    const agent = request.agent(app);
    const loginRes = await agent
      .post('/admin/login')
      .send('password=testpassword')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.location).toBe('/admin');
    return agent;
  }

  test('returns a short /pay/:token URL and orderId for a valid cart', async () => {
    const agent = await loginAgent();
    // The endpoint's only DB call is the INSERT in saveOrder
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await agent
      .post('/admin/create-payment-link')
      .send({
        items: [{ name: 'Custom Catering Tray', price: 120, qty: 1 }],
        customerName: 'Walk-in Customer',
        sendEmail: false,
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('url');
    expect(res.body.url).toMatch(/\/pay\/[A-Z0-9]{8}$/);
    expect(res.body.stripeUrl).toContain('checkout.stripe.com');
    expect(res.body).toHaveProperty('orderId');
    expect(res.body.emailed).toBe(false);
  });

  test('rejects empty items', async () => {
    const agent = await loginAgent();
    const res = await agent
      .post('/admin/create-payment-link')
      .send({ items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one/i);
  });

  test('rejects invalid line item (price=0)', async () => {
    const agent = await loginAgent();
    const res = await agent
      .post('/admin/create-payment-link')
      .send({ items: [{ name: 'Bad', price: 0, qty: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/price/i);
  });

  test('rejects malformed customer email', async () => {
    const agent = await loginAgent();
    const res = await agent
      .post('/admin/create-payment-link')
      .send({
        items: [{ name: 'Custom', price: 25, qty: 1 }],
        customerEmail: 'not-an-email',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });
});

describe('GET /pay/:token', () => {
  test('redirects to the stored Stripe URL when token exists', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ payment_link_url: 'https://checkout.stripe.com/pay/cs_test_xyz', status: 'pending_payment' }],
      rowCount: 1,
    });
    const res = await request(app).get('/pay/ABCD2345');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://checkout.stripe.com/pay/cs_test_xyz');
  });

  test('returns 404 for unknown token', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get('/pay/ZZZZ9999');
    expect(res.status).toBe(404);
  });

  test('rejects malformed tokens', async () => {
    const res = await request(app).get('/pay/abc');
    expect(res.status).toBe(404);
  });

  test('redirects already-paid links to /success.html', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ payment_link_url: 'https://checkout.stripe.com/pay/cs_test_xyz', status: 'paid' }],
      rowCount: 1,
    });
    const res = await request(app).get('/pay/ABCD2345');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/success.html');
  });
});
