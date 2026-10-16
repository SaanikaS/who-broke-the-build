const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/wbtb',
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  // Apply schema on boot (idempotent). Retries while Postgres is starting.
  async init() {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    for (let i = 0; i < 20; i++) {
      try { await pool.query(sql); return; }
      catch (e) {
        if (i === 19) throw e;
        console.log('waiting for database...', e.code || e.message);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  },
};
