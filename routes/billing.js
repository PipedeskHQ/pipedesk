require('dotenv').config();
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create Stripe checkout session for $39/month subscription
router.post('/subscribe', async (req, res) => {
  const { userId } = req.user;
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];

    // Create or get Stripe customer
    let stripeCustomerId = user.stripe_customer_id;
    if (!stripeCustomerId) {
      const stripeCustomer = await stripe.customers.create({
        email: user.email,
        name: user.business_name,
        metadata: { pipedesk_user_id: userId }
      });
      stripeCustomerId = stripeCustomer.id;
      await pool.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [stripeCustomerId, userId]
      );
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'PipeDesk Monthly Subscription',
            description: 'Full access to PipeDesk CRM for solo plumbers'
          },
          unit_amount: 3900,
          recurring: { interval: 'month' }
        },
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `${process.env.APP_URL || 'https://pipedesk-production.up.railway.app'}/dashboard.html?subscribed=true`,
      cancel_url: `${process.env.APP_URL || 'https://pipedesk-production.up.railway.app'}/dashboard.html?cancelled=true`,
      metadata: { pipedesk_user_id: userId }
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: err.message || 'Server error.' });
  }
});

// Create Stripe Connect onboarding link for plumbers
router.post('/connect-stripe', async (req, res) => {
  const { userId } = req.user;
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];

    let connectId = user.stripe_connect_id;

    if (!connectId) {
      // Create Stripe Connect account
      const account = await stripe.accounts.create({
        type: 'express',
        email: user.email,
        metadata: { pipedesk_user_id: userId }
      });
      connectId = account.id;
      await pool.query(
        'UPDATE users SET stripe_connect_id = $1 WHERE id = $2',
        [connectId, userId]
      );
    }

    // Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: connectId,
      refresh_url: `${process.env.APP_URL || 'https://pipedesk-production.up.railway.app'}/dashboard.html?stripe=refresh`,
      return_url: `${process.env.APP_URL || 'https://pipedesk-production.up.railway.app'}/dashboard.html?stripe=connected`,
      type: 'account_onboarding'
    });

    res.json({ success: true, url: accountLink.url });
  } catch (err) {
    console.error('Connect Stripe error:', err);
    res.status(500).json({ error: err.message || 'Server error.' });
  }
});

// Get billing status
router.get('/status', async (req, res) => {
  const { userId } = req.user;
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];

    let stripeConnected = false;
    if (user.stripe_connect_id) {
      try {
        const account = await stripe.accounts.retrieve(user.stripe_connect_id);
        stripeConnected = account.details_submitted;
      } catch (e) {
        stripeConnected = false;
      }
    }

    const trialEnd = new Date(user.trial_ends_at);
    const now = new Date();
    const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));

    res.json({
      plan: user.plan,
      trial_ends_at: user.trial_ends_at,
      days_left: daysLeft,
      stripe_customer_id: user.stripe_customer_id,
      stripe_connected: stripeConnected,
      stripe_connect_id: user.stripe_connect_id
    });
  } catch (err) {
    console.error('Billing status error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Stripe webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.pipedesk_user_id;
    if (userId) {
      await pool.query(`
        UPDATE users SET 
          plan = 'paid',
          stripe_subscription_id = $1,
          subscription_ends_at = NOW() + INTERVAL '1 month'
        WHERE id = $2
      `, [session.subscription, userId]);
    }
  }

  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    await pool.query(`
      UPDATE users SET
        plan = 'paid',
        subscription_ends_at = NOW() + INTERVAL '1 month'
      WHERE stripe_subscription_id = $1
    `, [invoice.subscription]);
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    await pool.query(`
      UPDATE users SET plan = 'cancelled'
      WHERE stripe_subscription_id = $1
    `, [subscription.id]);
  }

  res.json({ received: true });
});

module.exports = router;
