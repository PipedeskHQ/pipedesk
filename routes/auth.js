const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../database/db');

// Validate coupon code
router.post('/validate-coupon', async (req, res) => {
  const { code } = req.body;
  try {
    const result = await pool.query(
      `SELECT * FROM coupons WHERE code = $1 AND is_active = true`,
      [code.toUpperCase()]
    );
    if (result.rows.length === 0) {
      return res.json({ valid: false, message: 'Invalid or expired coupon code.' });
    }
    const coupon = result.rows[0];
    if (coupon.max_uses && coupon.current_uses >= coupon.max_uses) {
      return res.json({ valid: false, message: 'This coupon has reached its maximum uses.' });
    }
    res.json({
      valid: true,
      message: `✓ Code applied! ${coupon.free_months} months free.`,
      free_months: coupon.free_months
    });
  } catch (err) {
    res.status(500).json({ valid: false, message: 'Server error.' });
  }
});

// Sign up
router.post('/signup', async (req, res) => {
  const { email, password, business_name, owner_name, phone, coupon_code } = req.body;
  try {
    // Check if user exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Handle coupon
    let trial_ends_at = new Date();
    trial_ends_at.setDate(trial_ends_at.getDate() + 14);
    let applied_coupon = null;

    if (coupon_code) {
      const couponResult = await pool.query(
        `SELECT * FROM coupons WHERE code = $1 AND is_active = true`,
        [coupon_code.toUpperCase()]
      );
      if (couponResult.rows.length > 0) {
        const coupon = couponResult.rows[0];
        if (!coupon.max_uses || coupon.current_uses < coupon.max_uses) {
          // Add free months
          trial_ends_at = new Date();
          trial_ends_at.setMonth(trial_ends_at.getMonth() + coupon.free_months);
          applied_coupon = coupon_code.toUpperCase();

          // Update coupon usage
          await pool.query(
            'UPDATE coupons SET current_uses = current_uses + 1 WHERE code = $1',
            [applied_coupon]
          );

          // Deactivate if single use
          if (coupon.is_single_use) {
            await pool.query(
              'UPDATE coupons SET is_active = false WHERE code = $1',
              [applied_coupon]
            );
          }

          // Deactivate if max uses reached
          if (coupon.max_uses && (coupon.current_uses + 1) >= coupon.max_uses) {
            await pool.query(
              'UPDATE coupons SET is_active = false WHERE code = $1',
              [applied_coupon]
            );
          }
        }
      }
    }

    // Create user
    const newUser = await pool.query(
      `INSERT INTO users 
        (email, password_hash, business_name, owner_name, phone, coupon_code, trial_ends_at, plan)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'trial')
       RETURNING id, email, business_name, owner_name, plan, trial_ends_at`,
      [email, password_hash, business_name, owner_name, phone, applied_coupon, trial_ends_at]
    );

    const user = newUser.rows[0];

    // Create JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.SESSION_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        business_name: user.business_name,
        owner_name: user.owner_name,
        plan: user.plan,
        trial_ends_at: user.trial_ends_at
      }
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error during signup.' });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    // Update last login
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.SESSION_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        business_name: user.business_name,
        owner_name: user.owner_name,
        plan: user.plan,
        trial_ends_at: user.trial_ends_at
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

module.exports = router;
