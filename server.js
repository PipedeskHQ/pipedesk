require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
  try {
    console.log('Initializing database...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        business_name VARCHAR(255),
        owner_name VARCHAR(255),
        phone VARCHAR(20),
        google_review_link VARCHAR(500),
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        stripe_connect_id VARCHAR(255),
        plan VARCHAR(50) DEFAULT 'trial',
        trial_ends_at TIMESTAMP DEFAULT (NOW() + INTERVAL '14 days'),
        subscription_ends_at TIMESTAMP,
        coupon_code VARCHAR(50),
        follow_up_enabled BOOLEAN DEFAULT true,
        review_requests_enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        last_login_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS coupons (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        discount_percent INTEGER DEFAULT 100,
        free_months INTEGER DEFAULT 3,
        max_uses INTEGER,
        current_uses INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        is_single_use BOOLEAN DEFAULT false,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        email VARCHAR(255),
        address TEXT,
        notes TEXT,
        follow_up_enabled BOOLEAN DEFAULT true,
        last_job_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        job_type VARCHAR(255),
        scheduled_date TIMESTAMP,
        notes TEXT,
        status VARCHAR(50) DEFAULT 'scheduled',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        job_id INTEGER REFERENCES jobs(id),
        amount DECIMAL(10,2),
        description TEXT,
        line_items JSONB,
        status VARCHAR(50) DEFAULT 'unpaid',
        stripe_payment_intent_id VARCHAR(255),
        payment_link VARCHAR(500),
        review_request_sent BOOLEAN DEFAULT false,
        review_link_clicked BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        paid_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sms_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        message_type VARCHAR(100),
        message_body TEXT,
        to_phone VARCHAR(20),
        status VARCHAR(50),
        twilio_sid VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );

      INSERT INTO coupons (code, discount_percent, free_months, max_uses, is_active)
      VALUES ('BETA2026', 100, 3, 10, true)
      ON CONFLICT (code) DO NOTHING;

      INSERT INTO coupons (code, discount_percent, free_months, max_uses, is_single_use, is_active)
      VALUES
        ('PIPE001', 100, 3, 1, true, true),
        ('PIPE002', 100, 3, 1, true, true),
        ('PIPE003', 100, 3, 1, true, true),
        ('PIPE004', 100, 3, 1, true, true),
        ('PIPE005', 100, 3, 1, true, true),
        ('PIPE006', 100, 3, 1, true, true),
        ('PIPE007', 100, 3, 1, true, true),
        ('PIPE008', 100, 3, 1, true, true),
        ('PIPE009', 100, 3, 1, true, true),
        ('PIPE010', 100, 3, 1, true, true)
      ON CONFLICT (code) DO NOTHING;
    `);
    console.log('Database ready!');
  } catch (err) {
    console.error('Database init error:', err.message);
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/signup.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'PipeDesk is running' });
});

app.get('/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM users');
    const coupons = await pool.query('SELECT COUNT(*) FROM coupons');
    res.json({
      status: 'ok',
      users: result.rows[0].count,
      coupons: coupons.rows[0].count
    });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  }
});

// Auth routes
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`PipeDesk v1.1 running on port ${PORT}`);
  });
});

module.exports = { pool };
