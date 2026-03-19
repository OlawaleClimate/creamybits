'use strict';

// ── Set dummy env vars so server.js doesn't process.exit ─────────────────────
process.env.NODE_ENV        = 'test';
process.env.DATABASE_URL    = 'postgresql://test:test@localhost/test';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.ADMIN_PASSWORD  = 'testpassword';
process.env.SESSION_SECRET  = 'test-session-secret';
process.env.BASE_URL        = 'http://localhost:3000';
process.env.RESEND_API_KEY  = 're_test_dummy';
process.env.R2_ACCOUNT_ID   = 'test';
process.env.R2_ACCESS_KEY_ID     = 'test';
process.env.R2_SECRET_ACCESS_KEY = 'test';
process.env.R2_BUCKET       = 'test';
process.env.R2_PUBLIC_URL   = 'https://images.example.com';

// ── Mock pg Pool ──────────────────────────────────────────────────────────────
jest.mock('pg', () => {
  const mQuery = jest.fn();
  const mPool  = jest.fn().mockImplementation(() => ({
    query:   mQuery,
    connect: jest.fn().mockResolvedValue({
      query:   mQuery,
      release: jest.fn(),
    }),
    on: jest.fn(),
  }));
  mPool._mockQuery = mQuery;
  return { Pool: mPool };
});

// ── Mock connect-pg-simple ────────────────────────────────────────────────────
jest.mock('connect-pg-simple', () => () => {
  const { EventEmitter } = require('events');
  return class PgStore extends EventEmitter {
    constructor() { super(); }
    get(sid, cb)    { cb(null, null); }
    set(sid, s, cb) { cb && cb(); }
    destroy(sid, cb){ cb && cb(); }
    touch(sid, s, cb){ cb && cb(); }
  };
});

// ── Mock Stripe ───────────────────────────────────────────────────────────────
jest.mock('stripe', () => {
  return jest.fn().mockReturnValue({
    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({
          id:  'cs_test_session',
          url: 'https://checkout.stripe.com/pay/cs_test_session',
        }),
      },
    },
    webhooks: {
      constructEvent: jest.fn(),
    },
  });
});

// ── Mock Resend ───────────────────────────────────────────────────────────────
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: jest.fn().mockResolvedValue({ id: 'mock-email-id' }) },
  })),
}));

// ── Mock AWS S3 ───────────────────────────────────────────────────────────────
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client:         jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(),
}));
