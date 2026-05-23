require('dotenv').config();
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const twilio = require('twilio');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Twilio webhook — receives incoming SMS replies
router.post('/sms', async (req, res) => {
  try {
    const { From, Body } = req.body;
    const reply = (Body || '').trim().toUpperCase();
    const fromPhone = From.replace(/\D/g, '');

    console.log(`Incoming SMS from ${From}: ${Body}`);

    // Find customer by phone number
    const customerResult = await pool.query(`
      SELECT c.*, u.phone as plumber_phone, u.owner_name, u.business_name, u.id as user_id
      FROM customers c
      JOIN users u ON u.id = c.user_id
      WHERE REGEXP_REPLACE(c.phone, '[^0-9]', '', 'g') = $1
      LIMIT 1
    `, [fromPhone]);

    if (customerResult.rows.length === 0) {
      console.log('No customer found for phone:', fromPhone);
      res.set('Content-Type', 'text/xml');
      res.send('<Response></Response>');
      return;
    }

    const customer = customerResult.rows[0];

    // Log the incoming message
    await pool.query(`
      INSERT INTO sms_log
        (user_id, customer_id, message_type, message_body, to_phone, status)
      VALUES ($1, $2, 'incoming_reply', $3, $4, 'received')
    `, [customer.user_id, customer.id, Body, From]);

    // If customer replied YES to follow-up
    if (reply === 'YES' || reply === 'Y') {
      // Notify the plumber
      if (customer.plumber_phone) {
        const notifyMsg = `📲 PipeDesk Alert: ${customer.name} replied YES to your follow-up text! They want to schedule a job. Call them at ${customer.phone}.`;
        
        try {
          await twilioClient.messages.create({
            body: notifyMsg,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: customer.plumber_phone.startsWith('+')
              ? customer.plumber_phone
              : `+1${customer.plumber_phone.replace(/\D/g, '')}`
          });

          await pool.query(`
            INSERT INTO sms_log
              (user_id, customer_id, message_type, message_body, to_phone, status)
            VALUES ($1, $2, 'plumber_notification', $3, $4, 'sent')
          `, [customer.user_id, customer.id, notifyMsg, customer.plumber_phone]);
        } catch (smsErr) {
          console.error('Plumber notification error:', smsErr.message);
        }
      }

      // Reply to customer
      res.set('Content-Type', 'text/xml');
      res.send(`<Response><Message>Great! ${customer.owner_name} from ${customer.business_name} will be in touch shortly to get you scheduled. Talk soon!</Message></Response>`);
    } else {
      // Generic reply for other messages
      res.set('Content-Type', 'text/xml');
      res.send(`<Response><Message>Thanks for your message! ${customer.owner_name} from ${customer.business_name} will get back to you soon.</Message></Response>`);
    }
  } catch (err) {
    console.error('SMS webhook error:', err);
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  }
});

module.exports = router;
