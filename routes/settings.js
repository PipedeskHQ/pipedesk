require('dotenv').config();
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Get settings
router.get('/', async (req, res) => {
  const { userId } = req.user;
  try {
    const result = await pool.query(
      'SELECT google_review_link, follow_up_enabled, review_requests_enabled, business_name, owner_name, phone FROM users WHERE id = $1',
      [userId]
    );
    res.json({ settings: result.rows[0] });
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Update settings
router.put('/', async (req, res) => {
  const { userId } = req.user;
  const { google_review_link, follow_up_enabled, review_requests_enabled, business_name, owner_name, phone } = req.body;
  try {
    await pool.query(
      `UPDATE users SET 
        google_review_link = $1,
        follow_up_enabled = $2,
        review_requests_enabled = $3,
        business_name = COALESCE($4, business_name),
        owner_name = COALESCE($5, owner_name),
        phone = COALESCE($6, phone)
      WHERE id = $7`,
      [google_review_link, follow_up_enabled, review_requests_enabled, business_name, owner_name, phone, userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Update settings error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
