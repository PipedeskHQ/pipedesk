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

// Get all jobs (for calendar)
router.get('/', async (req, res) => {
  const { userId } = req.user;
  const { date } = req.query;
  try {
    let query, params;
    if (date) {
      query = `
        SELECT j.*, c.name as customer_name, c.phone as customer_phone
        FROM jobs j
        JOIN customers c ON c.id = j.customer_id
        WHERE j.user_id = $1 
          AND DATE(j.scheduled_date) = DATE($2)
        ORDER BY j.scheduled_date ASC
      `;
      params = [userId, date];
    } else {
      query = `
        SELECT j.*, c.name as customer_name, c.phone as customer_phone
        FROM jobs j
        JOIN customers c ON c.id = j.customer_id
        WHERE j.user_id = $1
          AND j.scheduled_date >= NOW()
        ORDER BY j.scheduled_date ASC
        LIMIT 50
      `;
      params = [userId];
    }
    const result = await pool.query(query, params);
    res.json({ jobs: result.rows });
  } catch (err) {
    console.error('Get jobs error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Check for double booking
router.get('/check-availability', async (req, res) => {
  const { userId } = req.user;
  const { date, time, job_id } = req.query;
  try {
    const scheduledDate = new Date(`${date}T${time}`);
    const startWindow = new Date(scheduledDate.getTime() - 60 * 60 * 1000);
    const endWindow = new Date(scheduledDate.getTime() + 60 * 60 * 1000);
    let query = `
      SELECT j.*, c.name as customer_name
      FROM jobs j
      JOIN customers c ON c.id = j.customer_id
      WHERE j.user_id = $1
        AND j.scheduled_date BETWEEN $2 AND $3
        AND j.status != 'cancelled'
    `;
    const params = [userId, startWindow, endWindow];
    if (job_id) {
      query += ` AND j.id != $4`;
      params.push(job_id);
    }
    const result = await pool.query(query, params);
    res.json({
      available: result.rows.length === 0,
      conflicts: result.rows
    });
  } catch (err) {
    console.error('Check availability error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Create job
router.post('/', async (req, res) => {
  const { userId } = req.user;
  const { customer_id, job_type, scheduled_date, notes } = req.body;
  try {
    // Check for double booking
    const bookingDate = new Date(scheduled_date);
    const startWindow = new Date(bookingDate.getTime() - 60 * 60 * 1000);
    const endWindow = new Date(bookingDate.getTime() + 60 * 60 * 1000);
    const conflicts = await pool.query(`
      SELECT j.*, c.name as customer_name
      FROM jobs j
      JOIN customers c ON c.id = j.customer_id
      WHERE j.user_id = $1
        AND j.scheduled_date BETWEEN $2 AND $3
        AND j.status != 'cancelled'
    `, [userId, startWindow, endWindow]);

    if (conflicts.rows.length > 0) {
      return res.status(409).json({
        error: `⚠️ Double booking! You already have a job with ${conflicts.rows[0].customer_name} around that time.`,
        conflict: conflicts.rows[0]
      });
    }

    // Create the job
    const result = await pool.query(`
      INSERT INTO jobs (user_id, customer_id, job_type, scheduled_date, notes, status)
      VALUES ($1, $2, $3, $4, $5, 'scheduled')
      RETURNING *
    `, [userId, customer_id, job_type, scheduled_date, notes]);

    const job = result.rows[0];

    // Update customer's last job date
    await pool.query(
      'UPDATE customers SET last_job_date = $1 WHERE id = $2',
      [scheduled_date, customer_id]
    );

    // Send SMS reminder if customer has phone
    const customerResult = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [customer_id]
    );
    const customer = customerResult.rows[0];

    // Get plumber info
    const userResult = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );
    const plumber = userResult.rows[0];

    if (customer.phone) {
      const jobDate = new Date(scheduled_date);
      const formattedDate = jobDate.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric'
      });
      const formattedTime = jobDate.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit'
      });

      const smsBody = `Hi ${customer.name.split(' ')[0]}! This is ${plumber.owner_name} from ${plumber.business_name}. Your appointment is confirmed for ${formattedDate} at ${formattedTime}. We'll send you a reminder the day before. Reply STOP to opt out.`;

      try {
        const message = await twilioClient.messages.create({
          body: smsBody,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customer.phone.startsWith('+') ? customer.phone : `+1${customer.phone.replace(/\D/g, '')}`
        });

        await pool.query(`
          INSERT INTO sms_log (user_id, customer_id, message_type, message_body, to_phone, status, twilio_sid)
          VALUES ($1, $2, 'booking_confirmation', $3, $4, 'sent', $5)
        `, [userId, customer_id, smsBody, customer.phone, message.sid]);
      } catch (smsErr) {
        console.error('SMS error:', smsErr.message);
      }
    }

    res.json({ success: true, job });
  } catch (err) {
    console.error('Create job error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Update job status
router.put('/:id', async (req, res) => {
  const { userId } = req.user;
  const { id } = req.params;
  const { status, notes, job_type, scheduled_date } = req.body;
  try {
    const result = await pool.query(`
      UPDATE jobs SET status=$1, notes=$2, job_type=$3, scheduled_date=$4
      WHERE id=$5 AND user_id=$6
      RETURNING *
    `, [status, notes, job_type, scheduled_date, id, userId]);
    res.json({ success: true, job: result.rows[0] });
  } catch (err) {
    console.error('Update job error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Cancel job
router.delete('/:id', async (req, res) => {
  const { userId } = req.user;
  const { id } = req.params;
  try {
    await pool.query(
      `UPDATE jobs SET status='cancelled' WHERE id=$1 AND user_id=$2`,
      [id, userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Cancel job error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
