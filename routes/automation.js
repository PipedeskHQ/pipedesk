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

// Run 6-month follow-ups
async function runFollowUps() {
  try {
    console.log('Running 6-month follow-up check...');

    // Find customers whose last job was exactly 6 months ago
    const result = await pool.query(`
      SELECT 
        c.id as customer_id,
        c.name as customer_name,
        c.phone as customer_phone,
        c.follow_up_enabled,
        c.last_job_date,
        u.id as user_id,
        u.owner_name,
        u.business_name,
        u.follow_up_enabled as plumber_follow_up_enabled
      FROM customers c
      JOIN users u ON u.id = c.user_id
      WHERE 
        c.follow_up_enabled = true
        AND u.follow_up_enabled = true
        AND c.phone IS NOT NULL
        AND c.last_job_date IS NOT NULL
        AND c.last_job_date BETWEEN 
          NOW() - INTERVAL '6 months' - INTERVAL '1 day'
          AND NOW() - INTERVAL '6 months'
        AND NOT EXISTS (
          SELECT 1 FROM sms_log sl
          WHERE sl.customer_id = c.id
            AND sl.message_type = 'follow_up'
            AND sl.created_at > NOW() - INTERVAL '6 months'
        )
    `);

    console.log(`Found ${result.rows.length} customers due for follow-up`);

    for (const customer of result.rows) {
      try {
        const firstName = customer.customer_name.split(' ')[0];
        const smsBody = `Hi ${firstName}, this is ${customer.owner_name} from ${customer.business_name}. Just checking in — it's been 6 months since your last service. Need anything looked at? Reply YES and I'll get you scheduled.`;

        const message = await twilioClient.messages.create({
          body: smsBody,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customer.customer_phone.startsWith('+') 
            ? customer.customer_phone 
            : `+1${customer.customer_phone.replace(/\D/g, '')}`
        });

        await pool.query(`
          INSERT INTO sms_log 
            (user_id, customer_id, message_type, message_body, to_phone, status, twilio_sid)
          VALUES ($1, $2, 'follow_up', $3, $4, 'sent', $5)
        `, [customer.user_id, customer.customer_id, smsBody, customer.customer_phone, message.sid]);

        console.log(`Follow-up sent to ${customer.customer_name}`);
      } catch (smsErr) {
        console.error(`Failed to send follow-up to ${customer.customer_name}:`, smsErr.message);
      }
    }

    return { sent: result.rows.length };
  } catch (err) {
    console.error('Follow-up automation error:', err);
    throw err;
  }
}

// Run 24-hour SMS reminders
async function runJobReminders() {
  try {
    console.log('Running 24-hour job reminder check...');

    const result = await pool.query(`
      SELECT 
        j.id as job_id,
        j.job_type,
        j.scheduled_date,
        c.name as customer_name,
        c.phone as customer_phone,
        u.owner_name,
        u.business_name,
        u.id as user_id,
        j.customer_id
      FROM jobs j
      JOIN customers c ON c.id = j.customer_id
      JOIN users u ON u.id = j.user_id
      WHERE 
        j.status = 'scheduled'
        AND j.scheduled_date BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours'
        AND c.phone IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM sms_log sl
          WHERE sl.customer_id = j.customer_id
            AND sl.message_type = 'job_reminder'
            AND sl.created_at > NOW() - INTERVAL '1 day'
        )
    `);

    console.log(`Found ${result.rows.length} jobs due for reminder`);

    for (const job of result.rows) {
      try {
        const firstName = job.customer_name.split(' ')[0];
        const jobDate = new Date(job.scheduled_date);
        const formattedTime = jobDate.toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit'
        });

        const smsBody = `Hi ${firstName}! Reminder: ${job.owner_name} from ${job.business_name} will be at your place tomorrow at ${formattedTime} for ${job.job_type || 'your service appointment'}. Reply STOP to opt out.`;

        const message = await twilioClient.messages.create({
          body: smsBody,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: job.customer_phone.startsWith('+')
            ? job.customer_phone
            : `+1${job.customer_phone.replace(/\D/g, '')}`
        });

        await pool.query(`
          INSERT INTO sms_log
            (user_id, customer_id, message_type, message_body, to_phone, status, twilio_sid)
          VALUES ($1, $2, 'job_reminder', $3, $4, 'sent', $5)
        `, [job.user_id, job.customer_id, smsBody, job.customer_phone, message.sid]);

        console.log(`Reminder sent to ${job.customer_name}`);
      } catch (smsErr) {
        console.error(`Failed to send reminder to ${job.customer_name}:`, smsErr.message);
      }
    }

    return { sent: result.rows.length };
  } catch (err) {
    console.error('Reminder automation error:', err);
    throw err;
  }
}

// Manual trigger endpoints (for testing)
router.post('/run-followups', async (req, res) => {
  try {
    const result = await runFollowUps();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/run-reminders', async (req, res) => {
  try {
    const result = await runJobReminders();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, runFollowUps, runJobReminders };
