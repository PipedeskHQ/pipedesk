require('dotenv').config();
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Admin login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }
  const token = jwt.sign(
    { email, isAdmin: true },
    process.env.SESSION_SECRET,
    { expiresIn: '24h' }
  );
  res.json({ success: true, token });
});

// Middleware to verify admin
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied.' });
  try {
    const verified = jwt.verify(token, process.env.SESSION_SECRET);
    if (!verified.isAdmin) return res.status(403).json({ error: 'Admin only.' });
    req.admin = verified;
    next();
  } catch (err) {
    res.status(403).json({ error: 'Invalid or expired session.' });
  }
}

// Get dashboard stats
router.get('/stats', adminAuth, async (req, res) => {
  try {
    // Total users
    const totalUsers = await pool.query('SELECT COUNT(*) FROM users');

    // Trial users
    const trialUsers = await pool.query(
      `SELECT COUNT(*) FROM users WHERE plan = 'trial' AND trial_ends_at > NOW()`
    );

    // Paid users
    const paidUsers = await pool.query(
      `SELECT COUNT(*) FROM users WHERE plan = 'paid'`
    );

    // Cancelled users
    const cancelledUsers = await pool.query(
      `SELECT COUNT(*) FROM users WHERE plan = 'cancelled'`
    );

    // New signups this month
    const newSignups = await pool.query(
      `SELECT COUNT(*) FROM users WHERE created_at > DATE_TRUNC('month', NOW())`
    );

    // Churn this month
    const churn = await pool.query(
      `SELECT COUNT(*) FROM users 
       WHERE plan = 'cancelled' 
       AND updated_at > DATE_TRUNC('month', NOW())`
    );

    // MRR
    const mrr = parseInt(paidUsers.rows[0].count) * 39;

    // MRR history (last 6 months)
    const mrrHistory = await pool.query(`
      SELECT 
        DATE_TRUNC('month', created_at) as month,
        COUNT(*) FILTER (WHERE plan = 'paid') * 39 as mrr
      FROM users
      WHERE created_at > NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month ASC
    `);

    res.json({
      total_users: parseInt(totalUsers.rows[0].count),
      trial_users: parseInt(trialUsers.rows[0].count),
      paid_users: parseInt(paidUsers.rows[0].count),
      cancelled_users: parseInt(cancelledUsers.rows[0].count),
      new_signups: parseInt(newSignups.rows[0].count),
      churn: parseInt(churn.rows[0].count),
      mrr,
      mrr_history: mrrHistory.rows
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get all users
router.get('/users', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, email, business_name, owner_name, phone,
        plan, trial_ends_at, subscription_ends_at,
        coupon_code, created_at, last_login_at,
        stripe_customer_id, stripe_connect_id
      FROM users
      ORDER BY created_at DESC
    `);
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get all coupons
router.get('/coupons', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM coupons ORDER BY created_at DESC'
    );
    res.json({ coupons: result.rows });
  } catch (err) {
    console.error('Admin coupons error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Create coupon
router.post('/coupons', adminAuth, async (req, res) => {
  const { code, free_months, max_uses, is_single_use } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO coupons (code, discount_percent, free_months, max_uses, is_single_use, is_active)
      VALUES ($1, 100, $2, $3, $4, true)
      RETURNING *
    `, [code.toUpperCase(), free_months, max_uses, is_single_use]);
    res.json({ success: true, coupon: result.rows[0] });
  } catch (err) {
    console.error('Create coupon error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Toggle coupon active/inactive
router.put('/coupons/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;
  try {
    const result = await pool.query(
      'UPDATE coupons SET is_active = $1 WHERE id = $2 RETURNING *',
      [is_active, id]
    );
    res.json({ success: true, coupon: result.rows[0] });
  } catch (err) {
    console.error('Toggle coupon error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Extend user trial
router.put('/users/:id/extend', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { days } = req.body;
  try {
    const result = await pool.query(`
      UPDATE users 
      SET trial_ends_at = trial_ends_at + ($1 || ' days')::INTERVAL
      WHERE id = $2
      RETURNING *
    `, [days, id]);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Extend trial error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Cancel user subscription
router.put('/users/:id/cancel', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`
      UPDATE users SET plan = 'cancelled' WHERE id = $1 RETURNING *
    `, [id]);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Cancel user error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = { router, adminAuth };
