require('dotenv').config();
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const twilio = require('twilio');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Get all invoices
router.get('/', async (req, res) => {
  const { userId } = req.user;
  try {
    const result = await pool.query(`
      SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.email as customer_email
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE i.user_id = $1
      ORDER BY i.created_at DESC
    `, [userId]);
    res.json({ invoices: result.rows });
  } catch (err) {
    console.error('Get invoices error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Create invoice and payment link
router.post('/', async (req, res) => {
  const { userId } = req.user;
  const { customer_id, job_id, description, line_items, amount } = req.body;
  try {
    // Get plumber info
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const plumber = userResult.rows[0];

    // Get customer info
    const customerResult = await pool.query('SELECT * FROM customers WHERE id = $1', [customer_id]);
    const customer = customerResult.rows[0];

    if (!plumber.stripe_connect_id) {
      return res.status(400).json({ 
        error: 'Please connect your Stripe account in Settings before creating invoices.' 
      });
    }

    // Create Stripe payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      description: description,
      metadata: {
        customer_name: customer.name,
        plumber_business: plumber.business_name
      }
    }, {
      stripeAccount: plumber.stripe_connect_id
    });

    // Create payment link URL
    const paymentLink = `${process.env.APP_URL || 'https://pipedesk-production.up.railway.app'}/pay/${paymentIntent.id}`;

    // Save invoice
    const invoiceResult = await pool.query(`
      INSERT INTO invoices 
        (user_id, customer_id, job_id, amount, description, line_items, status, stripe_payment_intent_id, payment_link)
      VALUES ($1, $2, $3, $4, $5, $6, 'unpaid', $7, $8)
      RETURNING *
    `, [userId, customer_id, job_id, amount, description, JSON.stringify(line_items), paymentIntent.id, paymentLink]);

    const invoice = invoiceResult.rows[0];

    res.json({ success: true, invoice, paymentLink });
  } catch (err) {
    console.error('Create invoice error:', err);
    res.status(500).json({ error: err.message || 'Server error.' });
  }
});

// Send invoice via SMS
router.post('/:id/send-sms', async (req, res) => {
  const { userId } = req.user;
  const { id } = req.params;
  try {
    const result = await pool.query(`
      SELECT i.*, c.name as customer_name, c.phone as customer_phone,
             u.business_name, u.owner_name
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      JOIN users u ON u.id = i.user_id
      WHERE i.id = $1 AND i.user_id = $2
    `, [id, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    const invoice = result.rows[0];
    if (!invoice.customer_phone) {
      return res.status(400).json({ error: 'Customer has no phone number.' });
    }

    const smsBody = `Hi ${invoice.customer_name.split(' ')[0]}! Your invoice from ${invoice.business_name} is ready. Amount: $${parseFloat(invoice.amount).toFixed(2)}. Pay securely here: ${invoice.payment_link} Thank you!`;

    const message = await twilioClient.messages.create({
      body: smsBody,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: invoice.customer_phone.startsWith('+') ? invoice.customer_phone : `+1${invoice.customer_phone.replace(/\D/g, '')}`
    });

    await pool.query(`
      INSERT INTO sms_log (user_id, customer_id, message_type, message_body, to_phone, status, twilio_sid)
      VALUES ($1, $2, 'invoice', $3, $4, 'sent', $5)
    `, [userId, invoice.customer_id, smsBody, invoice.customer_phone, message.sid]);

    res.json({ success: true });
  } catch (err) {
    console.error('Send invoice SMS error:', err);
    res.status(500).json({ error: err.message || 'Server error.' });
  }
});

// Mark invoice as paid manually
router.put('/:id/mark-paid', async (req, res) => {
  const { userId } = req.user;
  const { id } = req.params;
  try {
    const result = await pool.query(`
      UPDATE invoices SET status='paid', paid_at=NOW()
      WHERE id=$1 AND user_id=$2
      RETURNING *
    `, [id, userId]);

    const invoice = result.rows[0];

    // Get plumber settings
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const plumber = userResult.rows[0];

    // Get customer
    const customerResult = await pool.query('SELECT * FROM customers WHERE id = $1', [invoice.customer_id]);
    const customer = customerResult.rows[0];

    // Send Google review request if enabled
    if (plumber.review_requests_enabled && plumber.google_review_link && customer.phone && !invoice.review_request_sent) {
      const smsBody = `Thanks for choosing ${plumber.business_name}! If we did a good job, we'd really appreciate a quick Google review — it helps a lot. ${plumber.google_review_link}`;
      try {
        await twilioClient.messages.create({
          body: smsBody,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customer.phone.startsWith('+') ? customer.phone : `+1${customer.phone.replace(/\D/g, '')}`
        });
        await pool.query('UPDATE invoices SET review_request_sent=true WHERE id=$1', [id]);
        await pool.query(`
          INSERT INTO sms_log (user_id, customer_id, message_type, message_body, to_phone, status)
          VALUES ($1, $2, 'review_request', $3, $4, 'sent')
        `, [userId, invoice.customer_id, smsBody, customer.phone]);
      } catch (smsErr) {
        console.error('Review SMS error:', smsErr.message);
      }
    }

    res.json({ success: true, invoice });
  } catch (err) {
    console.error('Mark paid error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
