require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
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
    const schema = fs.readFileSync(
      path.join(__dirname, 'database', 'database', 'schema.sql'),
      'utf8'
    );
    await pool.query(schema);
    console.log('Database ready!');
  } catch (err) {
    console.error('Database init error:', err.message);
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`PipeDesk running on port ${PORT}`);
  });
});

module.exports = { pool };
