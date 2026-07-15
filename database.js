const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'payment_reminder',
  waitForConnections: true,
  connectionLimit: 10,
  timezone: '+00:00',
});

function calcNextDue(fromDate, frequency, frequencyValue = 1) {
  const d = new Date(fromDate + 'T12:00:00Z');
  switch (frequency) {
    case 'monthly':       d.setMonth(d.getMonth() + 1); break;
    case 'bimonthly':    d.setMonth(d.getMonth() + 2); break;
    case 'quarterly':    d.setMonth(d.getMonth() + 3); break;
    case 'every4months': d.setMonth(d.getMonth() + 4); break;
    case 'every6months': d.setMonth(d.getMonth() + 6); break;
    case 'yearly':       d.setFullYear(d.getFullYear() + 1); break;
    case 'custom_days':  d.setDate(d.getDate() + parseInt(frequencyValue)); break;
    case 'custom_months':d.setMonth(d.getMonth() + parseInt(frequencyValue)); break;
    default:             d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString().split('T')[0];
}

// List billing-cycle due-date strings ('YYYY-MM-DD') from a start date up to and including today.
function computeDueCycles(nextDueDate, frequency, frequencyValue = 1, todayStr) {
  if (!nextDueDate) return [];
  const today = todayStr || new Date().toISOString().split('T')[0];
  const dates = [];
  let d = String(nextDueDate).split('T')[0];
  let guard = 0;
  while (d <= today && guard < 600) {
    dates.push(d);
    d = calcNextDue(d, frequency, frequencyValue || 1);
    guard++;
  }
  return dates;
}

async function initDb() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await conn.execute(`CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      company VARCHAR(255) DEFAULT '',
      phone VARCHAR(100) DEFAULT '',
      email VARCHAR(255) DEFAULT '',
      address TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      payment_frequency VARCHAR(50) DEFAULT 'monthly',
      frequency_value INT DEFAULT 1,
      payment_amount DECIMAL(12,2) DEFAULT 0,
      next_due_date DATE DEFAULT NULL,
      whatsapp_consent TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);

    await conn.execute(`CREATE TABLE IF NOT EXISTS payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      payment_date DATE NOT NULL,
      frequency VARCHAR(50) NOT NULL DEFAULT 'monthly',
      frequency_value INT DEFAULT 1,
      next_due_date DATE NOT NULL,
      status VARCHAR(50) DEFAULT 'paid',
      notes TEXT DEFAULT '',
      source VARCHAR(50) DEFAULT 'scheduled',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )`);

    await conn.execute(`CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type VARCHAR(100) NOT NULL,
      message TEXT NOT NULL,
      payment_id INT DEFAULT NULL,
      customer_id INT DEFAULT NULL,
      is_read TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await conn.execute(`CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(100) PRIMARY KEY,
      value TEXT
    )`);

    await conn.execute(`CREATE TABLE IF NOT EXISTS invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_id VARCHAR(50) NOT NULL UNIQUE,
      customer_id INT NOT NULL,
      content TEXT DEFAULT '',
      amount DECIMAL(12,2) DEFAULT 0,
      invoice_date DATE NOT NULL,
      due_date DATE DEFAULT NULL,
      status VARCHAR(50) DEFAULT 'Draft',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )`);

    await conn.execute(`CREATE TABLE IF NOT EXISTS billing_periods (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      period_date DATE NOT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      invoice_id INT DEFAULT NULL,
      paid_date DATE DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_customer_period (customer_id, period_date),
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL
    )`);

    await conn.execute(`CREATE TABLE IF NOT EXISTS expenses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100) DEFAULT 'General',
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      frequency VARCHAR(50) DEFAULT 'monthly',
      frequency_value INT DEFAULT 1,
      start_date DATE DEFAULT NULL,
      next_due_date DATE DEFAULT NULL,
      notes TEXT DEFAULT '',
      is_active TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);

    await conn.execute(`CREATE TABLE IF NOT EXISTS expense_records (
      id INT AUTO_INCREMENT PRIMARY KEY,
      expense_id INT NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      paid_date DATE NOT NULL,
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
    )`);

    // Add source column to payments if missing
    try {
      await conn.execute(`ALTER TABLE payments ADD COLUMN source VARCHAR(50) DEFAULT 'scheduled'`);
    } catch(e) { /* already exists */ }

    // Default admin user
    const [users] = await conn.execute('SELECT COUNT(*) as n FROM users');
    if (users[0].n === 0) {
      const hash = await bcrypt.hash('admin123', 10);
      await conn.execute(
        'INSERT INTO users (username, password, email, name) VALUES (?, ?, ?, ?)',
        ['admin', hash, 'admin@example.com', 'Admin']
      );
    }

    // Default settings
    const defaults = {
      reminder_days_before: '7', reminder_days_before_2: '1',
      email_enabled: 'false', smtp_host: '', smtp_port: '587',
      smtp_user: '', smtp_pass: '', owner_email: '',
      owner_name: 'Business Owner', business_name: 'COUNTX',
    };
    for (const [k, v] of Object.entries(defaults)) {
      await conn.execute('INSERT IGNORE INTO settings (`key`,value) VALUES (?,?)', [k, v]);
    }

    // Backfill billing periods for existing customers (idempotent via unique key).
    const [bpCustomers] = await conn.execute(
      `SELECT id, payment_frequency, frequency_value, payment_amount, DATE_FORMAT(next_due_date,'%Y-%m-%d') AS nd
       FROM customers WHERE payment_amount>0 AND next_due_date IS NOT NULL`
    );
    const bpToday = new Date().toISOString().split('T')[0];
    for (const c of bpCustomers) {
      for (const d of computeDueCycles(c.nd, c.payment_frequency, c.frequency_value || 1, bpToday)) {
        await conn.execute(
          "INSERT IGNORE INTO billing_periods (customer_id, period_date, amount, status) VALUES (?,?,?,'pending')",
          [c.id, d, c.payment_amount]
        );
      }
    }

    console.log('Database initialized');
  } finally {
    conn.release();
  }
}

/* === Users === */
async function getUserByUsername(u) {
  const [r] = await pool.execute('SELECT * FROM users WHERE username=?', [u]);
  return r[0] || null;
}
async function getUserById(id) {
  const [r] = await pool.execute('SELECT id,username,email,name,created_at FROM users WHERE id=?', [id]);
  return r[0] || null;
}
async function getPasswordHash(id) {
  const [r] = await pool.execute('SELECT password FROM users WHERE id=?', [id]);
  return r[0]?.password || null;
}
async function updateUser(name, email, id) {
  await pool.execute('UPDATE users SET name=?,email=? WHERE id=?', [name, email, id]);
}
async function updatePassword(hash, id) {
  await pool.execute('UPDATE users SET password=? WHERE id=?', [hash, id]);
}

/* === Customers === */
async function getAllCustomers(search = null) {
  let sql = `
    SELECT c.*,
      (SELECT COUNT(*) FROM payments p WHERE p.customer_id=c.id AND p.status='paid') AS payment_count,
      CASE
        WHEN c.payment_amount IS NULL OR c.payment_amount=0 THEN 'no_setup'
        WHEN c.next_due_date IS NULL THEN 'no_setup'
        WHEN c.next_due_date < CURDATE() THEN 'overdue'
        WHEN c.next_due_date = CURDATE() THEN 'due_today'
        WHEN c.next_due_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 'due_soon'
        ELSE 'on_track'
      END AS payment_status
    FROM customers c`;
  const params = [];
  if (search) {
    sql += ` WHERE c.name LIKE ? OR c.company LIKE ? OR c.phone LIKE ? OR c.email LIKE ?`;
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }
  sql += ' ORDER BY c.name ASC';
  const [rows] = await pool.execute(sql, params);
  return rows;
}
async function getCustomerById(id) {
  const [r] = await pool.execute('SELECT * FROM customers WHERE id=?', [id]);
  return r[0] || null;
}
async function createCustomer(d) {
  const [r] = await pool.execute(
    'INSERT INTO customers (name,company,phone,email,address,notes,payment_frequency,frequency_value,payment_amount,next_due_date,whatsapp_consent) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [d.name, d.company||'', d.phone||'', d.email||'', d.address||'', d.notes||'',
     d.payment_frequency||'monthly', parseInt(d.frequency_value)||1,
     parseFloat(d.payment_amount)||0, d.next_due_date||null, d.whatsapp_consent?1:0]
  );
  return r.insertId;
}
async function updateCustomer(id, d) {
  await pool.execute(
    'UPDATE customers SET name=?,company=?,phone=?,email=?,address=?,notes=?,payment_frequency=?,frequency_value=?,payment_amount=?,next_due_date=?,whatsapp_consent=?,updated_at=NOW() WHERE id=?',
    [d.name, d.company||'', d.phone||'', d.email||'', d.address||'', d.notes||'',
     d.payment_frequency||'monthly', parseInt(d.frequency_value)||1,
     parseFloat(d.payment_amount)||0, d.next_due_date||null, d.whatsapp_consent?1:0, id]
  );
}
async function updateCustomerNextDue(id, next_due_date) {
  await pool.execute('UPDATE customers SET next_due_date=?,updated_at=NOW() WHERE id=?', [next_due_date, id]);
}
async function deleteCustomer(id) {
  await pool.execute('DELETE FROM customers WHERE id=?', [id]);
}

/* === Dashboard === */
async function getDashboardStats() {
  const [r] = await pool.execute(`
    SELECT
      (SELECT COUNT(*) FROM customers) AS total_customers,
      (SELECT COUNT(*) FROM customers WHERE next_due_date=CURDATE() AND payment_amount>0) AS due_today,
      (SELECT COUNT(*) FROM customers WHERE next_due_date>CURDATE() AND next_due_date<=DATE_ADD(CURDATE(),INTERVAL 7 DAY) AND payment_amount>0) AS due_in_7,
      (SELECT COUNT(*) FROM customers WHERE next_due_date<CURDATE() AND payment_amount>0) AS overdue,
      COALESCE((SELECT SUM(payment_amount) FROM customers WHERE MONTH(next_due_date)=MONTH(CURDATE()) AND YEAR(next_due_date)=YEAR(CURDATE()) AND payment_amount>0),0) AS due_this_month_amount,
      COALESCE((SELECT SUM(amount) FROM payments WHERE MONTH(payment_date)=MONTH(CURDATE()) AND YEAR(payment_date)=YEAR(CURDATE()) AND status='paid'),0) AS received_this_month,
      COALESCE((SELECT SUM(amount) FROM invoices WHERE MONTH(invoice_date)=MONTH(CURDATE()) AND YEAR(invoice_date)=YEAR(CURDATE()) AND status='Paid'),0) AS invoice_received_this_month,
      COALESCE((SELECT SUM(payment_amount) FROM customers WHERE next_due_date<CURDATE() AND payment_amount>0),0) AS overdue_amount,
      COALESCE((SELECT SUM(amount) FROM expenses WHERE is_active=1 AND frequency='monthly'),0) AS monthly_expenses,
      COALESCE((SELECT SUM(amount) FROM expense_records WHERE MONTH(paid_date)=MONTH(CURDATE()) AND YEAR(paid_date)=YEAR(CURDATE())),0) AS expenses_paid_this_month
  `);
  return r[0];
}

async function getMonthlyChart() {
  const [income] = await pool.execute(`
    SELECT DATE_FORMAT(payment_date,'%Y-%m') AS month, SUM(amount) AS total
    FROM payments WHERE payment_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH) AND status='paid'
    GROUP BY DATE_FORMAT(payment_date,'%Y-%m') ORDER BY month ASC
  `);
  const [invIncome] = await pool.execute(`
    SELECT DATE_FORMAT(invoice_date,'%Y-%m') AS month, SUM(amount) AS total
    FROM invoices WHERE invoice_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH) AND status='Paid'
    GROUP BY DATE_FORMAT(invoice_date,'%Y-%m') ORDER BY month ASC
  `);
  const [expenses] = await pool.execute(`
    SELECT DATE_FORMAT(paid_date,'%Y-%m') AS month, SUM(amount) AS total
    FROM expense_records WHERE paid_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
    GROUP BY DATE_FORMAT(paid_date,'%Y-%m') ORDER BY month ASC
  `);
  return { income, invIncome, expenses };
}

async function getUpcomingPayments() {
  const [r] = await pool.execute(`
    SELECT id, name AS customer_name, company, phone, email,
      payment_amount AS amount, next_due_date, payment_frequency AS frequency,
      CASE WHEN next_due_date=CURDATE() THEN 'due_today'
           WHEN next_due_date<=DATE_ADD(CURDATE(),INTERVAL 7 DAY) THEN 'due_soon'
           ELSE 'on_track' END AS status
    FROM customers WHERE payment_amount>0 AND next_due_date IS NOT NULL AND next_due_date>=CURDATE()
    ORDER BY next_due_date ASC LIMIT 20
  `);
  return r;
}
async function getOverduePayments() {
  const [r] = await pool.execute(`
    SELECT id, name AS customer_name, company, phone, email,
      payment_amount AS amount, next_due_date, 'overdue' AS status,
      DATEDIFF(CURDATE(),next_due_date) AS days_overdue
    FROM customers WHERE payment_amount>0 AND next_due_date IS NOT NULL AND next_due_date<CURDATE()
    ORDER BY next_due_date ASC
  `);
  return r;
}
async function getDueCustomers() {
  const [r] = await pool.execute(`
    SELECT *, CASE WHEN next_due_date=CURDATE() THEN 'due_today' ELSE 'due_soon' END AS payment_status
    FROM customers WHERE payment_amount>0 AND next_due_date IS NOT NULL
      AND next_due_date>=CURDATE() AND next_due_date<=DATE_ADD(CURDATE(),INTERVAL 7 DAY)
    ORDER BY next_due_date ASC
  `);
  return r;
}
async function getOverdueCustomers() {
  const [r] = await pool.execute(`
    SELECT *, 'overdue' AS payment_status, DATEDIFF(CURDATE(),next_due_date) AS days_overdue
    FROM customers WHERE payment_amount>0 AND next_due_date IS NOT NULL AND next_due_date<CURDATE()
    ORDER BY next_due_date ASC
  `);
  return r;
}

/* === Payments === */
async function getAllPayments(filters = {}) {
  let sql = `
    SELECT p.*, c.name AS customer_name, c.company AS customer_company, c.phone AS customer_phone
    FROM payments p JOIN customers c ON p.customer_id=c.id WHERE p.status='paid'`;
  const params = [];
  if (filters.customer_id) { sql += ' AND p.customer_id=?'; params.push(filters.customer_id); }
  if (filters.frequency)   { sql += ' AND p.frequency=?';   params.push(filters.frequency); }
  if (filters.month)       { sql += ' AND DATE_FORMAT(p.payment_date,"%Y-%m")=?'; params.push(filters.month); }
  sql += ' ORDER BY p.payment_date DESC';
  const [r] = await pool.execute(sql, params);
  return r;
}
async function getPaymentsByCustomer(cid) {
  const [r] = await pool.execute(
    'SELECT * FROM payments WHERE customer_id=? AND status="paid" ORDER BY payment_date DESC', [cid]);
  return r;
}
async function getPaymentById(id) {
  const [r] = await pool.execute(
    'SELECT p.*,c.name AS customer_name FROM payments p JOIN customers c ON p.customer_id=c.id WHERE p.id=?', [id]);
  return r[0] || null;
}
async function createPayment(d) {
  const [r] = await pool.execute(
    'INSERT INTO payments (customer_id,amount,payment_date,frequency,frequency_value,next_due_date,status,notes,source) VALUES (?,?,?,?,?,?,?,?,?)',
    [d.customer_id, d.amount, d.payment_date, d.frequency||'monthly', d.frequency_value||1,
     d.next_due_date, d.status||'paid', d.notes||'', d.source||'scheduled']
  );
  return r.insertId;
}
async function updatePayment(id, d) {
  const next = d.next_due_date || calcNextDue(d.payment_date, d.frequency, d.frequency_value||1);
  await pool.execute(
    'UPDATE payments SET customer_id=?,amount=?,payment_date=?,frequency=?,frequency_value=?,next_due_date=?,notes=?,updated_at=NOW() WHERE id=?',
    [d.customer_id, d.amount, d.payment_date, d.frequency, d.frequency_value||1, next, d.notes||'', id]
  );
}
async function deletePayment(id) {
  await pool.execute('DELETE FROM payments WHERE id=?', [id]);
}
async function getPaymentsForCalendar(start, end) {
  const [r] = await pool.execute(`
    SELECT id, payment_amount AS amount, next_due_date,
      CASE WHEN next_due_date<CURDATE() THEN 'overdue'
           WHEN next_due_date=CURDATE() THEN 'due_today'
           WHEN next_due_date<=DATE_ADD(CURDATE(),INTERVAL 7 DAY) THEN 'due_soon'
           ELSE 'on_track' END AS status,
      payment_frequency AS frequency, name AS customer_name
    FROM customers WHERE payment_amount>0 AND next_due_date IS NOT NULL AND next_due_date BETWEEN ? AND ?
    ORDER BY next_due_date ASC
  `, [start, end]);
  return r;
}
async function getPaymentsForReminders(daysOffset) {
  const [r] = await pool.execute(
    `SELECT id, name AS customer_name, email AS customer_email, payment_amount AS amount, next_due_date
     FROM customers WHERE payment_amount>0 AND next_due_date=DATE_ADD(CURDATE(),INTERVAL ? DAY)`,
    [daysOffset]
  );
  return r;
}

/* === Invoices === */
async function getAllInvoices() {
  const [r] = await pool.execute(`
    SELECT i.*, c.name AS customer_name, c.phone AS customer_phone, c.whatsapp_consent
    FROM invoices i JOIN customers c ON i.customer_id=c.id ORDER BY i.created_at DESC
  `);
  return r;
}
async function getInvoiceById(id) {
  const [r] = await pool.execute(`
    SELECT i.*, c.name AS customer_name, c.phone AS customer_phone,
           c.email AS customer_email, c.company AS customer_company, c.whatsapp_consent
    FROM invoices i JOIN customers c ON i.customer_id=c.id WHERE i.id=?
  `, [id]);
  return r[0] || null;
}
async function getNextInvoiceNumber() {
  const [r] = await pool.execute(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_id,5) AS UNSIGNED)),0)+1 AS next_num FROM invoices`
  );
  return r[0].next_num;
}
async function createInvoice(d) {
  const [r] = await pool.execute(
    'INSERT INTO invoices (invoice_id,customer_id,content,amount,invoice_date,due_date,status) VALUES (?,?,?,?,?,?,?)',
    [d.invoice_id, d.customer_id, d.content||'', parseFloat(d.amount)||0,
     d.invoice_date, d.due_date||null, d.status||'Draft']
  );
  return r.insertId;
}
async function updateInvoice(id, d) {
  await pool.execute(
    'UPDATE invoices SET customer_id=?,content=?,amount=?,invoice_date=?,due_date=?,status=?,updated_at=NOW() WHERE id=?',
    [d.customer_id, d.content||'', parseFloat(d.amount)||0,
     d.invoice_date, d.due_date||null, d.status||'Draft', id]
  );
}
async function updateInvoiceStatus(id, status) {
  await pool.execute('UPDATE invoices SET status=?,updated_at=NOW() WHERE id=?', [status, id]);
}
async function deleteInvoice(id) {
  await pool.execute('DELETE FROM invoices WHERE id=?', [id]);
}

/* === Expenses === */
async function getAllExpenses() {
  const [r] = await pool.execute(`
    SELECT e.*,
      COALESCE((SELECT COUNT(*) FROM expense_records er WHERE er.expense_id=e.id),0) AS record_count,
      COALESCE((SELECT SUM(er.amount) FROM expense_records er WHERE er.expense_id=e.id),0) AS total_paid,
      CASE
        WHEN e.next_due_date IS NULL THEN 'no_due'
        WHEN e.next_due_date < CURDATE() THEN 'overdue'
        WHEN e.next_due_date = CURDATE() THEN 'due_today'
        WHEN e.next_due_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 'due_soon'
        ELSE 'on_track'
      END AS expense_status
    FROM expenses e WHERE e.is_active=1 ORDER BY e.name ASC
  `);
  return r;
}
async function getExpenseById(id) {
  const [r] = await pool.execute('SELECT * FROM expenses WHERE id=?', [id]);
  return r[0] || null;
}
async function createExpense(d) {
  const [r] = await pool.execute(
    'INSERT INTO expenses (name,category,amount,frequency,frequency_value,start_date,next_due_date,notes) VALUES (?,?,?,?,?,?,?,?)',
    [d.name, d.category||'General', parseFloat(d.amount)||0,
     d.frequency||'monthly', parseInt(d.frequency_value)||1,
     d.start_date||null, d.next_due_date||null, d.notes||'']
  );
  return r.insertId;
}
async function updateExpense(id, d) {
  await pool.execute(
    'UPDATE expenses SET name=?,category=?,amount=?,frequency=?,frequency_value=?,next_due_date=?,notes=?,updated_at=NOW() WHERE id=?',
    [d.name, d.category||'General', parseFloat(d.amount)||0,
     d.frequency||'monthly', parseInt(d.frequency_value)||1,
     d.next_due_date||null, d.notes||'', id]
  );
}
async function deleteExpense(id) {
  await pool.execute('UPDATE expenses SET is_active=0 WHERE id=?', [id]);
}
async function markExpensePaid(expenseId, amount, paid_date, notes) {
  const [r] = await pool.execute(
    'INSERT INTO expense_records (expense_id,amount,paid_date,notes) VALUES (?,?,?,?)',
    [expenseId, amount, paid_date, notes||'']
  );
  const exp = await getExpenseById(expenseId);
  if (exp) {
    const next = calcNextDue(paid_date, exp.frequency, exp.frequency_value);
    await pool.execute('UPDATE expenses SET next_due_date=?,updated_at=NOW() WHERE id=?', [next, expenseId]);
  }
  return r.insertId;
}
async function getExpenseRecords(expenseId) {
  const [r] = await pool.execute(
    'SELECT * FROM expense_records WHERE expense_id=? ORDER BY paid_date DESC', [expenseId]);
  return r;
}

/* === Notifications === */
async function getNotifications() {
  const [r] = await pool.execute('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50');
  return r;
}
async function getUnreadCount() {
  const [r] = await pool.execute('SELECT COUNT(*) AS n FROM notifications WHERE is_read=0');
  return r[0].n;
}
async function createNotification(type, message, payment_id, customer_id) {
  await pool.execute(
    'INSERT INTO notifications (type,message,payment_id,customer_id) VALUES (?,?,?,?)',
    [type, message, payment_id||null, customer_id||null]
  );
}
async function markNotifRead(id) {
  await pool.execute('UPDATE notifications SET is_read=1 WHERE id=?', [id]);
}
async function markAllNotifsRead() {
  await pool.execute('UPDATE notifications SET is_read=1');
}

/* === Settings === */
async function getAllSettings() {
  const [r] = await pool.execute('SELECT `key`,value FROM settings');
  return r;
}
async function getSetting(key) {
  const [r] = await pool.execute('SELECT value FROM settings WHERE `key`=?', [key]);
  return r[0]?.value || null;
}
async function setSetting(key, value) {
  await pool.execute(
    'INSERT INTO settings (`key`,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=?',
    [key, value, value]
  );
}

/* === Billing periods (per-cycle tracking) === */
async function syncCustomerPeriods(customerId) {
  const [rows] = await pool.execute(
    `SELECT id, payment_frequency, frequency_value, payment_amount, DATE_FORMAT(next_due_date,'%Y-%m-%d') AS nd
     FROM customers WHERE id=?`, [customerId]);
  const c = rows[0];
  if (!c || !(parseFloat(c.payment_amount) > 0) || !c.nd) return;
  const today = new Date().toISOString().split('T')[0];
  for (const d of computeDueCycles(c.nd, c.payment_frequency, c.frequency_value || 1, today)) {
    await pool.execute(
      "INSERT IGNORE INTO billing_periods (customer_id, period_date, amount, status) VALUES (?,?,?,'pending')",
      [c.id, d, c.payment_amount]);
  }
}
async function syncAllCustomerPeriods() {
  const [rows] = await pool.execute('SELECT id FROM customers WHERE payment_amount>0 AND next_due_date IS NOT NULL');
  for (const r of rows) await syncCustomerPeriods(r.id);
}
async function updateUnpaidPeriodAmounts(customerId, amount) {
  await pool.execute("UPDATE billing_periods SET amount=? WHERE customer_id=? AND status='pending'", [amount, customerId]);
}
async function getInvoiceablePeriods(customerId) {
  const [r] = await pool.execute(
    `SELECT id, DATE_FORMAT(period_date,'%Y-%m-%d') AS period_date, amount
     FROM billing_periods WHERE customer_id=? AND status='pending' AND invoice_id IS NULL AND period_date<=CURDATE()
     ORDER BY period_date ASC`, [customerId]);
  return r;
}
async function getPendingPeriodsDue(customerId) {
  const [r] = await pool.execute(
    `SELECT id, DATE_FORMAT(period_date,'%Y-%m-%d') AS period_date, amount
     FROM billing_periods WHERE customer_id=? AND status='pending' AND period_date<=CURDATE()
     ORDER BY period_date ASC`, [customerId]);
  return r;
}
async function getPeriodsByIds(ids) {
  const list = (ids || []).map(Number).filter(Number.isInteger);
  if (!list.length) return [];
  const [r] = await pool.execute(
    `SELECT id, DATE_FORMAT(period_date,'%Y-%m-%d') AS period_date, amount, status, invoice_id
     FROM billing_periods WHERE id IN (${list.map(() => '?').join(',')})`, list);
  return r;
}
async function getPeriodsByInvoice(invoiceId) {
  const [r] = await pool.execute(
    `SELECT id, DATE_FORMAT(period_date,'%Y-%m-%d') AS period_date, amount
     FROM billing_periods WHERE invoice_id=? ORDER BY period_date ASC`, [invoiceId]);
  return r;
}
async function linkPeriodsToInvoice(invoiceId, ids) {
  const list = (ids || []).map(Number).filter(Number.isInteger);
  if (!list.length) return;
  await pool.execute(
    `UPDATE billing_periods SET invoice_id=? WHERE id IN (${list.map(() => '?').join(',')}) AND status='pending'`,
    [invoiceId, ...list]);
}
async function unlinkInvoice(invoiceId) {
  await pool.execute("UPDATE billing_periods SET invoice_id=NULL, status='pending', paid_date=NULL WHERE invoice_id=?", [invoiceId]);
}
async function reopenInvoicePeriods(invoiceId) {
  await pool.execute("UPDATE billing_periods SET status='pending', paid_date=NULL WHERE invoice_id=?", [invoiceId]);
}
async function markInvoicePeriodsPaid(invoiceId, paidDate) {
  await pool.execute("UPDATE billing_periods SET status='paid', paid_date=? WHERE invoice_id=?", [paidDate, invoiceId]);
}
async function markPeriodsPaid(ids, paidDate) {
  const list = (ids || []).map(Number).filter(Number.isInteger);
  if (!list.length) return;
  await pool.execute(
    `UPDATE billing_periods SET status='paid', paid_date=? WHERE id IN (${list.map(() => '?').join(',')})`,
    [paidDate, ...list]);
}
async function resyncNextDueDate(customerId) {
  const [p] = await pool.execute(
    "SELECT DATE_FORMAT(MIN(period_date),'%Y-%m-%d') AS d FROM billing_periods WHERE customer_id=? AND status='pending'", [customerId]);
  if (p[0] && p[0].d) {
    await pool.execute('UPDATE customers SET next_due_date=?,updated_at=NOW() WHERE id=?', [p[0].d, customerId]);
    return p[0].d;
  }
  const [cust] = await pool.execute(
    "SELECT payment_frequency, frequency_value, DATE_FORMAT(next_due_date,'%Y-%m-%d') AS nd FROM customers WHERE id=?", [customerId]);
  const [mx] = await pool.execute(
    "SELECT DATE_FORMAT(MAX(period_date),'%Y-%m-%d') AS d FROM billing_periods WHERE customer_id=?", [customerId]);
  const anchor = (mx[0] && mx[0].d) ? mx[0].d : (cust[0] ? cust[0].nd : null);
  if (!cust[0] || !anchor) return null;
  const next = calcNextDue(anchor, cust[0].payment_frequency, cust[0].frequency_value || 1);
  await pool.execute('UPDATE customers SET next_due_date=?,updated_at=NOW() WHERE id=?', [next, customerId]);
  return next;
}
async function getOverduePeriodsByCustomer() {
  const [r] = await pool.execute(`
    SELECT c.*,
      COUNT(bp.id) AS cycles_overdue,
      SUM(bp.amount) AS total_due,
      GROUP_CONCAT(DATE_FORMAT(bp.period_date,'%Y-%m-%d') ORDER BY bp.period_date ASC) AS due_dates_csv,
      DATEDIFF(CURDATE(), MIN(bp.period_date)) AS days_overdue,
      (SELECT COUNT(*) FROM billing_periods bpi
        WHERE bpi.customer_id=c.id AND bpi.status='pending' AND bpi.invoice_id IS NULL AND bpi.period_date<=CURDATE()) AS invoiceable_count
    FROM customers c
    JOIN billing_periods bp ON bp.customer_id=c.id AND bp.status='pending' AND bp.period_date<=CURDATE()
    GROUP BY c.id
    ORDER BY MIN(bp.period_date) ASC
  `);
  return r.map(row => ({
    ...row,
    customer_name: row.name,
    amount: row.payment_amount,
    total_due: +((parseFloat(row.total_due) || 0)).toFixed(2),
    due_dates: row.due_dates_csv ? String(row.due_dates_csv).split(',') : [],
    payment_status: 'overdue',
  }));
}
async function getOverdueAmount() {
  const [r] = await pool.execute(
    "SELECT COALESCE(SUM(amount),0) AS total FROM billing_periods WHERE status='pending' AND period_date<=CURDATE()");
  return +((parseFloat(r[0].total) || 0)).toFixed(2);
}

module.exports = {
  pool, initDb, calcNextDue,
  getUserByUsername, getUserById, getPasswordHash, updateUser, updatePassword,
  getAllCustomers, getCustomerById, createCustomer, updateCustomer, updateCustomerNextDue, deleteCustomer,
  getDashboardStats, getMonthlyChart, getUpcomingPayments, getOverduePayments, getDueCustomers, getOverdueCustomers,
  getAllPayments, getPaymentsByCustomer, getPaymentById, createPayment, updatePayment, deletePayment,
  getPaymentsForCalendar, getPaymentsForReminders,
  getAllInvoices, getInvoiceById, getNextInvoiceNumber, createInvoice, updateInvoice, updateInvoiceStatus, deleteInvoice,
  getAllExpenses, getExpenseById, createExpense, updateExpense, deleteExpense, markExpensePaid, getExpenseRecords,
  getNotifications, getUnreadCount, createNotification, markNotifRead, markAllNotifsRead,
  getAllSettings, getSetting, setSetting,
  computeDueCycles, syncCustomerPeriods, syncAllCustomerPeriods, updateUnpaidPeriodAmounts,
  getInvoiceablePeriods, getPendingPeriodsDue, getPeriodsByIds, getPeriodsByInvoice,
  linkPeriodsToInvoice, unlinkInvoice, reopenInvoicePeriods, markInvoicePeriodsPaid, markPeriodsPaid,
  resyncNextDueDate, getOverduePeriodsByCustomer, getOverdueAmount,
};
