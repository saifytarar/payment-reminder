const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const fs = require('fs');
const dataDir = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const DB_PATH = path.join(dataDir, 'payments.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  payment_date TEXT NOT NULL,
  frequency TEXT NOT NULL,
  frequency_value INTEGER DEFAULT 1,
  next_due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  payment_id INTEGER REFERENCES payments(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

const custCols = db.prepare("PRAGMA table_info(customers)").all().map(c => c.name);
if (!custCols.includes('payment_frequency')) {
  db.exec(`ALTER TABLE customers ADD COLUMN payment_frequency TEXT DEFAULT 'monthly'`);
  db.exec(`ALTER TABLE customers ADD COLUMN frequency_value INTEGER DEFAULT 1`);
  db.exec(`ALTER TABLE customers ADD COLUMN payment_amount REAL DEFAULT 0`);
  db.exec(`ALTER TABLE customers ADD COLUMN next_due_date TEXT`);
  db.exec(`UPDATE customers SET
    payment_frequency = COALESCE((SELECT frequency FROM payments WHERE customer_id = customers.id ORDER BY created_at DESC LIMIT 1),'monthly'),
    frequency_value = COALESCE((SELECT frequency_value FROM payments WHERE customer_id = customers.id ORDER BY created_at DESC LIMIT 1),1),
    payment_amount = COALESCE((SELECT amount FROM payments WHERE customer_id = customers.id ORDER BY created_at DESC LIMIT 1),0),
    next_due_date = (SELECT next_due_date FROM payments WHERE customer_id = customers.id ORDER BY next_due_date DESC LIMIT 1)
  `);
}

const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
if (userCount === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`INSERT INTO users (username, password, email, name) VALUES (?, ?, ?, ?)`)
    .run('admin', hash, 'admin@example.com', 'Admin');
}

const defaultSettings = {
  reminder_days_before: '7', reminder_days_before_2: '1', email_enabled: 'false',
  smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', owner_email: '', owner_name: 'Business Owner',
};
const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
for (const [key, value] of Object.entries(defaultSettings)) insertSetting.run(key, value);

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

const queries = {
  getUserByUsername: db.prepare(`SELECT * FROM users WHERE username = ?`),
  getUserById:       db.prepare(`SELECT id, username, email, name, created_at FROM users WHERE id = ?`),
  updateUser:        db.prepare(`UPDATE users SET name=?, email=? WHERE id=?`),
  updatePassword:    db.prepare(`UPDATE users SET password=? WHERE id=?`),
  getAllCustomers: db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM payments p WHERE p.customer_id = c.id AND p.status = 'paid') as payment_count,
      CASE
        WHEN c.payment_amount IS NULL OR c.payment_amount = 0 THEN 'no_setup'
        WHEN c.next_due_date IS NULL THEN 'no_setup'
        WHEN c.next_due_date < date('now') THEN 'overdue'
        WHEN c.next_due_date = date('now') THEN 'due_today'
        WHEN c.next_due_date <= date('now', '+7 days') THEN 'due_soon'
        ELSE 'on_track'
      END as payment_status
    FROM customers c ORDER BY c.name ASC
  `),
  getCustomerById: db.prepare(`SELECT * FROM customers WHERE id = ?`),
  createCustomer: db.prepare(`INSERT INTO customers (name,company,phone,email,address,notes,payment_frequency,frequency_value,payment_amount,next_due_date) VALUES (?,?,?,?,?,?,?,?,?,?)`),
  updateCustomer: db.prepare(`UPDATE customers SET name=?,company=?,phone=?,email=?,address=?,notes=?,payment_frequency=?,frequency_value=?,payment_amount=?,next_due_date=?,updated_at=datetime('now') WHERE id=?`),
  updateCustomerNextDue: db.prepare(`UPDATE customers SET next_due_date=?, updated_at=datetime('now') WHERE id=?`),
  deleteCustomer: db.prepare(`DELETE FROM customers WHERE id=?`),
  getDueCustomers: db.prepare(`
    SELECT *, CASE WHEN next_due_date = date('now') THEN 'due_today' ELSE 'due_soon' END as payment_status
    FROM customers WHERE payment_amount > 0 AND next_due_date IS NOT NULL
      AND next_due_date >= date('now') AND next_due_date <= date('now', '+7 days')
    ORDER BY next_due_date ASC
  `),
  getOverdueCustomers: db.prepare(`
    SELECT *, 'overdue' as payment_status,
      CAST(julianday('now') - julianday(next_due_date) AS INTEGER) as days_overdue
    FROM customers WHERE payment_amount > 0 AND next_due_date IS NOT NULL AND next_due_date < date('now')
    ORDER BY next_due_date ASC
  `),
  getAllPayments: db.prepare(`
    SELECT p.*, c.name as customer_name, c.company as customer_company, c.phone as customer_phone
    FROM payments p JOIN customers c ON p.customer_id = c.id
    WHERE p.status = 'paid' ORDER BY p.payment_date DESC
  `),
  getPaymentsByCustomer: db.prepare(`SELECT * FROM payments WHERE customer_id = ? AND status = 'paid' ORDER BY payment_date DESC`),
  getPaymentById: db.prepare(`SELECT p.*, c.name as customer_name FROM payments p JOIN customers c ON p.customer_id=c.id WHERE p.id=?`),
  createPayment: db.prepare(`INSERT INTO payments (customer_id,amount,payment_date,frequency,frequency_value,next_due_date,status,notes) VALUES (?,?,?,?,?,?,?,?)`),
  updatePayment: db.prepare(`UPDATE payments SET customer_id=?,amount=?,payment_date=?,frequency=?,frequency_value=?,next_due_date=?,status=?,notes=?,updated_at=datetime('now') WHERE id=?`),
  deletePayment: db.prepare(`DELETE FROM payments WHERE id=?`),
  markPaid: db.prepare(`UPDATE payments SET payment_date=?, next_due_date=?, status='paid', updated_at=datetime('now') WHERE id=?`),
  getDashboardStats: db.prepare(`SELECT
    (SELECT COUNT(*) FROM customers) as total_customers,
    (SELECT COUNT(*) FROM customers WHERE next_due_date = date('now') AND payment_amount > 0) as due_today,
    (SELECT COUNT(*) FROM customers WHERE next_due_date > date('now') AND next_due_date <= date('now','+7 days') AND payment_amount > 0) as due_in_7,
    (SELECT COUNT(*) FROM customers WHERE next_due_date < date('now') AND payment_amount > 0) as overdue
  `),
  getUpcomingPayments: db.prepare(`
    SELECT id, name as customer_name, company, phone, email,
      payment_amount as amount, next_due_date, payment_frequency as frequency,
      CASE WHEN next_due_date = date('now') THEN 'due_today' WHEN next_due_date <= date('now', '+7 days') THEN 'due_soon' ELSE 'on_track' END as status
    FROM customers WHERE payment_amount > 0 AND next_due_date IS NOT NULL AND next_due_date >= date('now')
    ORDER BY next_due_date ASC LIMIT 20
  `),
  getOverduePayments: db.prepare(`
    SELECT id, name as customer_name, company, phone, email,
      payment_amount as amount, next_due_date, 'overdue' as status,
      CAST(julianday('now') - julianday(next_due_date) AS INTEGER) as days_overdue
    FROM customers WHERE payment_amount > 0 AND next_due_date IS NOT NULL AND next_due_date < date('now')
    ORDER BY next_due_date ASC
  `),
  getPaymentsForCalendar: db.prepare(`
    SELECT id, payment_amount as amount, next_due_date,
      CASE WHEN next_due_date < date('now') THEN 'overdue' WHEN next_due_date = date('now') THEN 'due_today' WHEN next_due_date <= date('now', '+7 days') THEN 'due_soon' ELSE 'on_track' END as status,
      payment_frequency as frequency, name as customer_name
    FROM customers WHERE payment_amount > 0 AND next_due_date IS NOT NULL AND next_due_date BETWEEN ? AND ?
    ORDER BY next_due_date ASC
  `),
  getPaymentsForReminders: db.prepare(`
    SELECT id, name as customer_name, email as customer_email, payment_amount as amount, next_due_date
    FROM customers WHERE payment_amount > 0 AND next_due_date = date('now', ? || ' days')
  `),
  getNotifications:    db.prepare(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50`),
  getUnreadCount:      db.prepare(`SELECT COUNT(*) as n FROM notifications WHERE is_read=0`),
  markNotifRead:       db.prepare(`UPDATE notifications SET is_read=1 WHERE id=?`),
  markAllNotifsRead:   db.prepare(`UPDATE notifications SET is_read=1`),
  createNotification:  db.prepare(`INSERT INTO notifications (type,message,payment_id,customer_id) VALUES (?,?,?,?)`),
  getSetting:     db.prepare(`SELECT value FROM settings WHERE key=?`),
  getAllSettings: db.prepare(`SELECT key, value FROM settings`),
  setSetting:     db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`),
};

module.exports = { db, queries, calcNextDue };
