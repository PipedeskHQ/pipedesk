require('dotenv').config();
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Get all customers (with search)
router.get('/', async (req, res) => {
  const { userId } = req.user;
  const { search } = req.query;
  try {
    let query, params;
    if (search) {
      query = `
        SELECT c.*, 
          COUNT(j.id) as job_count,
          MAX(j.scheduled_date) as last_job_date
        FROM customers c
        LEFT JOIN jobs j ON j.customer_id = c.id
        WHERE c.user_id = $1 
          AND (
            LOWER(c.name) LIKE LOWER($2) OR 
            c.phone LIKE $2 OR 
            LOWER(c.address) LIKE LOWER($2)
          )
        GROUP BY c.id
        ORDER BY c.name ASC
      `;
      params = [userId, `%${search}%`];
    } else {
      query = `
        SELECT c.*, 
          COUNT(j.id) as job_count,
          MAX(j.scheduled_date) as last_job_date
        FROM customers c
        LEFT JOIN jobs j ON j.customer_id = c.id
        WHERE c.user_id = $1
        GROUP BY c.id
        ORDER BY c.name ASC
      `;
      params = [userId];
    }
    const result = await pool.query(query, params);
    res.json({ customers: result.rows });
  } catch (err) {
    console.error('Get customers error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get single customer with full job history
router.get('/:id', async (req, res) => {
  const { userId } = req.user;
  const { id } = req.params;
  try {
    const customerResult = await pool.query(
      'SELECT * FROM customers WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (customerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found.' });
    }
    const jobsResult = await pool.query(
      `SELECT j.*, i.amount, i.status as invoice_status, i.id as invoice_id
       FROM jobs j
       LEFT JOIN invoices i ON i.job_id = j.id
       WHERE j.customer_id = $1
       ORDER BY j.scheduled_date DESC`,
      [id]
    );
    res.json({
      customer: customerResult.rows[0],
      jobs: jobsResult.rows
    });
  } catch (err) {
    console.error('Get customer error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Create customer
router.post('/', async (req, res) => {
  const { userId } = req.user;
  const { name, phone, email, address, notes } = req.body;
  try {
    if (!name) {
      return res.status(400).json({ error: 'Customer name is required.' });
    }
    const result = await pool.query(
      `INSERT INTO customers (user_id, name, phone, email, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, name, phone, email, address, notes]
    );
    res.json({ success: true, customer: result.rows[0] });
  } catch (err) {
    console.error('Create customer error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Update customer
router.put('/:id', async (req, res) => {
  const { userId } = req.user;
  const { id } = req.params;
  const { name, phone, email, address, notes, follow_up_enabled } = req.body;
  try {
    const result = await pool.query(
      `UPDATE customers 
       SET name=$1, phone=$2, email=$3, address=$4, notes=$5, follow_up_enabled=$6
       WHERE id=$7 AND user_id=$8
       RETURNING *`,
      [name, phone, email, address, notes, follow_up_enabled, id, userId]
    );
    res.json({ success: true, customer: result.rows[0] });
  } catch (err) {
    console.error('Update customer error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Delete customer
router.delete('/:id', async (req, res) => {
  const { userId } = req.user;
  const { id } = req.params;
  try {
    await pool.query(
      'DELETE FROM customers WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Delete customer error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
