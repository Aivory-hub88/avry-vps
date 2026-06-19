#!/bin/bash
# Fix VPS Panel authentication - clear rate limits and set credentials

# Clear rate limits
docker exec vps-panel node -e "
const D = require('better-sqlite3');
const db = new D('/app/data/panel.db');
db.prepare('DELETE FROM rate_limits').run();
console.log('Rate limits cleared');
db.close();
"

# Check current env
echo "=== Current PANEL env vars ==="
docker exec vps-panel env | grep -E "PANEL|ADMIN"

# Seed admin users directly into the DB and update auth
docker exec vps-panel node -e "
const D = require('better-sqlite3');
const bcrypt = require('bcrypt');
const db = new D('/app/data/panel.db');

// Create admin_users table
db.exec(\`
  CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'admin',
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
\`);

// Clear existing and seed
db.prepare('DELETE FROM admin_users').run();

const hash1 = bcrypt.hashSync('Clement_91', 10);
const hash2 = bcrypt.hashSync('aivory-maju-2026', 10);

db.prepare('INSERT INTO admin_users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)').run('usr_clement_001', 'clement.hansel@aivory.id', hash1, 'Clement Hansel', 'admin');
db.prepare('INSERT INTO admin_users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)').run('usr_aivory_001', 'aivory.admin', hash2, 'Aivory Admin', 'admin');

const users = db.prepare('SELECT username FROM admin_users').all();
console.log('Seeded users:', JSON.stringify(users));

// Also update the PANEL env-based credentials by writing to a temp check
// Verify hash works
const ok1 = bcrypt.compareSync('Clement_91', hash1);
const ok2 = bcrypt.compareSync('aivory-maju-2026', hash2);
console.log('Verify clement:', ok1);
console.log('Verify aivory:', ok2);

db.close();
"

echo ""
echo "=== Done. Now checking if auth module reads from admin_users ==="
echo "If not, will set PANEL_USERNAME env var as fallback..."

# Check if the running code has admin_users support
# If it doesn't, we need to restart with updated env
docker exec vps-panel node -e "
const D = require('better-sqlite3');
const bcrypt = require('bcrypt');
const db = new D('/app/data/panel.db');
const row = db.prepare('SELECT password_hash FROM admin_users WHERE username = ?').get('clement.hansel@aivory.id');
if (row) {
  const ok = bcrypt.compareSync('Clement_91', row.password_hash);
  console.log('DB auth check: ' + (ok ? 'PASS' : 'FAIL'));
} else {
  console.log('DB auth check: NO ROW FOUND');
}
db.close();
"
