const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

// Use Railway persistent volume if available, otherwise local data folder
const fs = require('fs');
const dataDir = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const DB_PATH = path.join(dataDir, 'payments.db');

const db = new Database(DB_PATH);

// Enable WAL for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    username  TEXT    NOT NULL UNIQUE,
    password  TEXT    NOT NULL,
    email     TEXT    NOT NULL,
    name      TEXT    NOT NULL,
    created_at TEXT   DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    company      TEXT,
    phone        TEXT,
    email        TEXT,
    address      TEXT,
    notes        TEXT,
    created_at   TEXT    DEFAULT (datetime('now')),
    updated_at   TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    amount          REAL    NOT NULL,
    payment_date    TEXT    NOT NULL,
    frequency       TEXT    NOT NULL,
    frequency_value INTEGER DEFAULT 1,
    next_due_date   TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'paid',
    notes           TEXT,
    created_at      TEXT    DEFAULT (datetime('now')),
    updated_at      TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT    NOT NULL,
    message     TEXT    NOT NULL,
    payment_id  INTEGER REFERENCES payments(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    is_read     INTEGER DEFAULT 0,
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ─────────────────────────────────────────────
// Seed default admin user if none exists
// ─────────────────────────────────────────────
const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
if (userCount === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`INSERT INTO users (username, password, email, name) VALUES (?, ?, ?, ?)`)
    .run('admin', hash, 'admin@example.com', 'Admin');
}

// ─────────────────────────────────────────────
// Default settings
// ─────────────────────────────────────────────
const defaultSettings = {
  reminder_days_before: '7',
  reminder_days_before_2: '1',
  email_enabled: 'false',
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_pass: '',
  owner_email: '',
  owner_name: 'Business Owner',
};
const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
for (const [key, value] of Object.entries(defaultSettings)) {
  insertSetting.run(key, value);
}

// ─────────────────────────────────────────────
// Helper: calculate next due date
// ─────────────────────────────────────────────
function calcNextDue(fromDate, frequency, frequencyValue = 1) {
  const d = new Date(fromDate);
  switch (frequency) {
    case 'monthly':       d.setMonth(d.getMonth() + 1); break;
    case 'bimonthly':     d.setMonth(d.getMonth() + 2); break;
    case 'quarterly':     d.setMonth(d.getMonth() + 3); break;
    case 'every4months':  d.setMonth(d.getMonth() + 4); break;
    case 'every6months':  d.setMonth(d.getMonth() + 6); break;
    case 'yearly':        d.setFullYear(d.getFullYear() + 1); break;
    case 'custom_days':   d.setDate(d.getDate() + frequencyValue); break;
    case 'custom_months': d.setMonth(d.getMonth() + frequencyValue); break;
    default:              d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString().split('T')[0];
}

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────
const queries = {
  getUserByUsername: db.prepare(`SELECT * FROM users WHERE username = ?`),
  getUserById:       db.prepare(`SELECT id, username, email, name, created_at FROM users WHERE id = ?`),
  updateUser:        db.prepare(`UPDATE users SET name=?, email=? WHERE id=?`),
  updatePassword:    db.prepare(`UPDATE users SET password=? WHERE id=?`),

  getAllCustomers: db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM payments p WHERE p.customer_id = c.id) as payment_count,
      (SELECT p.next_due_date FROM payments p WHERE p.customer_id = c.id ORDER BY p.next_due_date ASC LIMIT 1) as next_due_date,
      (SELECT p.status FROM payments p WHERE p.customer_id = c.id ORDER BY p.next_due_date ASC LIMIT 1) as payment_status,
      (SELECT p.amount FROM payments p WHERE p.customer_id = c.id ORDER BY p.next_due_date ASC LIMIT 1) as next_amount
    FROM customers c ORDER BY c.name ASC
  `),
  getCustomerById:  db.prepare(`SELECT * FROM customers WHERE id = ?`),
  createCustomer:   db.prepare(`INSERT INTO customers (name,company,phone,email,address,notes) VALUES (?,?,?,?,?,?)`),
  updateCustomer:   db.prepare(`UPDATE customers SET name=?,company=?,phone=?,email=?,address=?,notes=?,updated_at=datetime('now') WHERE id=?`),
  deleteCustomer:   db.prepare(`DELETE FROM customers WHERE id=?`),

  getAllPayments: db.prepare(`
    SELECT p.*, c.name as customer_name, c.company as customer_company, c.phone as customer_phone
    FROM payments p JOIN customers c ON p.customer_id = c.id
    ORDER BY p.next_due_date ASC
  `),
  getPaymentsByCustomer: db.prepare(`SELECT * FROM payments WHERE customer_id = ? ORDER BY next_due_date ASC`),
  getPaymentById: db.prepare(`SELECT p.*, c.name as customer_name FROM payments p JOIN customers c ON p.customer_id=c.id WHERE p.id=?`),
  createPayment:  db.prepare(`INSERT INTO payments (customer_id,amount,payment_date,frequency,frequency_value,next_due_date,status,notes) VALUES (?,?,?,?,?,?,?,?)`),
  updatePayment:  db.prepare(`UPDATE payments SET customer_id=?,amount=?,payment_date=?,frequency=?,frequency_value=?,next_due_date=?,status=?,notes=?,updated_at=datetime('now') WHERE id=?`),
  deletePayment:  db.prepare(`DELETE FROM payments WHERE id=?`),
  markPaid:       db.prepare(`UPDATE payments SET payment_date=?, next_due_date=?, status='paid', updated_at=datetime('now') WHERE id=?`),

  getDashboardStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM customers) as total_customers,
      (SELECT COUNT(*) FROM payments WHERE next_due_date = date('now')) as due_today,
      (SELECT COUNT(*) FROM payments WHERE next_due_date > date('now') AND next_due_date <= date('now','+7 days')) as due_in_7,
      (SELECT COUNT(*) FROM payments WHERE next_due_date < date('now') AND status != 'paid') as overdue
  `),
  getUpcomingPayments: db.prepare(`
    SELECT p.*, c.name as customer_name, c.company, c.phone, c.email
    FROM payments p JOIN customers c ON p.customer_id=c.id
    WHERE p.next_due_date >= date('now')
    ORDER BY p.next_due_date ASC LIMIT 20
  `),
  getOverduePayments: db.prepare(`
    SELECT p.*, c.name as customer_name, c.company, c.phone, c.email
    FROM payments p JOIN customers c ON p.customer_id=c.id
    WHERE p.next_due_date < date('now') AND p.status != 'paid'
    ORDER BY p.next_due_date ASC
  `),
  getPaymentsForCalendar: db.prepare(`
    SELECT p.id, p.amount, p.next_due_date, p.status, p.frequency, c.name as customer_name
    FROM payments p JOIN customers c ON p.customer_id=c.id
    WHERE p.next_due_date BETWEEN ? AND ?
    ORDER BY p.next_due_date ASC
  `),
  getPaymentsForReminders: db.prepare(`
    SELECT p.*, c.name as customer_name, c.email as customer_email
    FROM payments p JOIN customers c ON p.customer_id=c.id
    WHERE p.next_due_date = date('now', ? || ' days') AND p.status != 'paid'
  `),

  getNotifications:   db.prepare(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50`),
  getUnreadCount:     db.prepare(`SELECT COUNT(*) as n FROM notifications WHERE is_read=0`),
  markNotifRead:      db.prepare(`UPDATE notifications SET is_read=1 WHERE id=?`),
  markAllNotifsRead:  db.prepare(`UPDATE notifications SET is_read=1`),
  createNotification: db.prepare(`INSERT INTO notifications (type,message,payment_id,customer_id) VALUES (?,?,?,?)`),

  getSetting:     db.prepare(`SELECT value FROM settings WHERE key=?`),
  getAllSettings: db.prepare(`SELECT key, value FROM settings`),
  setSetting:     db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`),
};

module.exports = { db, queries, calcNextDue };
