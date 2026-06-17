const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'payment_reminder',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
});

async function initDb() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        company VARCHAR(255),
        phone VARCHAR(50),
        email VARCHAR(255),
        address TEXT,
        notes TEXT,
        payment_frequency VARCHAR(50) DEFAULT 'monthly',
        frequency_value INT DEFAULT 1,
        payment_amount DECIMAL(12,2) DEFAULT 0,
        next_due_date DATE NULL,
        whatsapp_consent TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_id INT NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        payment_date DATE NOT NULL,
        frequency VARCHAR(50) NOT NULL,
        frequency_value INT DEFAULT 1,
        next_due_date DATE NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'paid',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_payments_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        payment_id INT NULL,
        customer_id INT NULL,
        is_read TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_notif_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
        CONSTRAINT fk_notif_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS settings (
        \`key\` VARCHAR(100) PRIMARY KEY,
        value TEXT
      ) ENGINE=InnoDB
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id INT AUTO_INCREMENT PRIMARY KEY,
        invoice_id VARCHAR(50) NOT NULL UNIQUE,
        customer_id INT NOT NULL,
        content MEDIUMTEXT,
        amount DECIMAL(12,2) DEFAULT 0,
        invoice_date DATE NOT NULL,
        due_date DATE NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'Draft',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_invoices_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    const [userRows] = await conn.query('SELECT COUNT(*) as n FROM users');
    if (userRows[0].n === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      await conn.query(
        'INSERT INTO users (username, password, email, name) VALUES (?, ?, ?, ?)',
        ['admin', hash, 'admin@example.com', 'Admin']
      );
    }

    const defaultSettings = {
      reminder_days_before: '7', reminder_days_before_2: '1', email_enabled: 'false',
      smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', owner_email: '', owner_name: 'Business Owner',
    };
    for (const [key, value] of Object.entries(defaultSettings)) {
      await conn.query('INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)', [key, value]);
    }
  } finally {
    conn.release();
  }
}

function calcNextDue(fromDate, frequency, frequencyValue = 1) {
  const d = new Date(fromDate);
  switch (frequency) {
    case 'monthly': d.setMonth(d.getMonth() + 1); break;
    case 'bimonthly': d.setMonth(d.getMonth() + 2); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'every4months': d.setMonth(d.getMonth() + 4); break;
    case 'every6months': d.setMonth(d.getMonth() + 6); break;
    case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
    case 'custom_days': d.setDate(d.getDate() + frequencyValue); break;
    case 'custom_months': d.setMonth(d.getMonth() + frequencyValue); break;
    default: d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString().split('T')[0];
}

const queries = {
  async getUserByUsername(username) {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    return rows[0];
  },
  async getUserById(id) {
    const [rows] = await pool.query('SELECT id, username, email, name, created_at FROM users WHERE id = ?', [id]);
    return rows[0];
  },
  async getFullUser(id) {
    const [rows] = await pool.query('SELECT password FROM users WHERE id=?', [id]);
    return rows[0];
  },
  async updateUser(name, email, id) {
    await pool.query('UPDATE users SET name=?, email=? WHERE id=?', [name, email, id]);
  },
  async updatePassword(password, id) {
    await pool.query('UPDATE users SET password=? WHERE id=?', [password, id]);
  },

  async getAllCustomers() {
    const [rows] = await pool.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM payments p WHERE p.customer_id = c.id AND p.status = 'paid') as payment_count,
        CASE
          WHEN c.payment_amount IS NULL OR c.payment_amount = 0 THEN 'no_setup'
          WHEN c.next_due_date IS NULL THEN 'no_setup'
          WHEN c.next_due_date < CURDATE() THEN 'overdue'
          WHEN c.next_due_date = CURDATE() THEN 'due_today'
          WHEN c.next_due_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 'due_soon'
          ELSE 'on_track'
        END as payment_status
      FROM customers c ORDER BY c.name ASC
    `);
    return rows;
  },
  async getCustomerById(id) {
    const [rows] = await pool.query('SELECT * FROM customers WHERE id = ?', [id]);
    return rows[0];
  },
  async createCustomer(name, company, phone, email, address, notes, payment_frequency, frequency_value, payment_amount, next_due_date, whatsapp_consent) {
    const [result] = await pool.query(
      `INSERT INTO customers (name,company,phone,email,address,notes,payment_frequency,frequency_value,payment_amount,next_due_date,whatsapp_consent) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [name, company, phone, email, address, notes, payment_frequency, frequency_value, payment_amount, next_due_date, whatsapp_consent]
    );
    return result;
  },
  async updateCustomer(name, company, phone, email, address, notes, payment_frequency, frequency_value, payment_amount, next_due_date, whatsapp_consent, id) {
    await pool.query(
      `UPDATE customers SET name=?,company=?,phone=?,email=?,address=?,notes=?,payment_frequency=?,frequency_value=?,payment_amount=?,next_due_date=?,whatsapp_consent=? WHERE id=?`,
      [name, company, phone, email, address, notes, payment_frequency, frequency_value, payment_amount, next_due_date, whatsapp_consent, id]
    );
  },
  async updateCustomerNextDue(next_due_date, id) {
    await pool.query('UPDATE customers SET next_due_date=? WHERE id=?', [next_due_date, id]);
  },
  async deleteCustomer(id) {
    await pool.query('DELETE FROM customers WHERE id=?', [id]);
  },
  async getDueCustomers() {
    const [rows] = await pool.query(`
      SELECT *, CASE WHEN next_due_date = CURDATE() THEN 'due_today' ELSE 'due_soon' END as payment_status
      FROM customers WHERE payment_amount > 0 AND next_due_date IS NOT NULL
      AND next_due_date >= CURDATE() AND next_due_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
      ORDER BY next_due_date ASC
    `);
    return rows;
  },
  async getOverdueCustomers() {
    const [rows] = await pool.query(`
      SELECT *, 'overdue' as payment_status,
        DATEDIFF(CURDATE(), next_due_date) as days_overdue
      FROM customers WHERE payment_amount > 0 AND next_due_date IS NOT NULL AND next_due_date < CURDATE()
      ORDER BY next_due_date ASC
    `);
    return rows;
  },

  async getAllPayments() {
    const [rows] = await pool.query(`
      SELECT p.*, c.name as customer_name, c.company as customer_company, c.phone as customer_phone
      FROM payments p JOIN customers c ON p.customer_id = c.id
      WHERE p.status = 'paid' ORDER BY p.payment_date DESC
    `);
    return rows;
  },
  async getPaymentsByCustomer(customerId) {
    const [rows] = await pool.query("SELECT * FROM payments WHERE customer_id = ? AND status = 'paid' ORDER BY payment_date DESC", [customerId]);
    return rows;
  },
  async getPaymentById(id) {
    const [rows] = await pool.query('SELECT p.*, c.name as customer_name FROM payments p JOIN customers c ON p.customer_id=c.id WHERE p.id=?', [id]);
    return rows[0];
  },
  async createPayment(customer_id, amount, payment_date, frequency, frequency_value, next_due_date, status, notes) {
    const [result] = await pool.query(
      `INSERT INTO payments (customer_id,amount,payment_date,frequency,frequency_value,next_due_date,status,notes) VALUES (?,?,?,?,?,?,?,?)`,
      [customer_id, amount, payment_date, frequency, frequency_value, next_due_date, status, notes]
    );
    return result;
  },
  async updatePayment(customer_id, amount, payment_date, frequency, frequency_value, next_due_date, status, notes, id) {
    await pool.query(
      `UPDATE payments SET customer_id=?,amount=?,payment_date=?,frequency=?,frequency_value=?,next_due_date=?,status=?,notes=? WHERE id=?`,
      [customer_id, amount, payment_date, frequency, frequency_value, next_due_date, status, notes, id]
    );
  },
  async deletePayment(id) {
    await pool.query('DELETE FROM payments WHERE id=?', [id]);
  },
  async markPaid(payment_date, next_due_date, id) {
    await pool.query("UPDATE payments SET payment_date=?, next_due_date=?, status='paid' WHERE id=?", [payment_date, next_due_date, id]);
  },

  async getDashboardStats() {
    const [rows] = await pool.query(`SELECT
      (SELECT COUNT(*) FROM customers) as total_customers,
      (SELECT COUNT(*) FROM customers WHERE next_due_date = CURDATE() AND payment_amount > 0) as due_today,
      (SELECT COUNT(*) FROM customers WHERE next_due_date > CURDATE() AND next_due_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) AND payment_amount > 0) as due_in_7,
      (SELECT COUNT(*) FROM customers WHERE next_due_date < CURDATE() AND payment_amount > 0) as overdue
    `);
    return rows[0];
  },
  async getUpcomingPayments() {
    const [rows] = await pool.query(`
      SELECT id, name as customer_name, company, phone, email,
        payment_amount as amount, next_due_date, payment_frequency as frequency,
        CASE WHEN next_due_date = CURDATE() THEN 'due_today' WHEN next_due_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 'due_soon' ELSE 'on_track' END as status
      FROM customers WHERE payment_amount > 0 AND next_due_date IS NOT NULL AND next_due_date >= CURDATE()
      ORDER BY next_due_date ASC LIMIT 20
    `);
    return rows;
  },
  async getOverduePayments() {
    const [rows] = await pool.query(`
      SELECT id, name as customer_name, company, phone, email,
        payment_amount as amount, next_due_date, 'overdue' as status,
        DATEDIFF(CURDATE(), next_due_date) as days_overdue
      FROM customers WHERE payment_amount > 0 AND next_due_date IS NOT NULL AND next_due_date < CURDATE()
      ORDER BY next_due_date ASC
    `);
    return rows;
  },
  async getPaymentsForCalendar(start, end) {
    const [rows] = await pool.query(`
      SELECT id, payment_amount as amount, next_due_date,
        CASE WHEN next_due_date < CURDATE() THEN 'overdue' WHEN next_due_date = CURDATE() THEN 'due_today' WHEN next_due_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 'due_soon' ELSE 'on_track' END as status,
        payment_frequency as frequency, name as customer_name
      FROM customers WHERE payment_amount > 0 AND next_due_date IS NOT NULL AND next_due_date BETWEEN ? AND ?
      ORDER BY next_due_date ASC
    `, [start, end]);
    return rows;
  },
  async getPaymentsForReminders(daysAhead) {
    const [rows] = await pool.query(`
      SELECT id, name as customer_name, email as customer_email, payment_amount as amount, next_due_date
      FROM customers WHERE payment_amount > 0 AND next_due_date = DATE_ADD(CURDATE(), INTERVAL ? DAY)
    `, [daysAhead]);
    return rows;
  },

  async getNotifications() {
    const [rows] = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50');
    return rows;
  },
  async getUnreadCount() {
    const [rows] = await pool.query('SELECT COUNT(*) as n FROM notifications WHERE is_read=0');
    return rows[0];
  },
  async markNotifRead(id) {
    await pool.query('UPDATE notifications SET is_read=1 WHERE id=?', [id]);
  },
  async markAllNotifsRead() {
    await pool.query('UPDATE notifications SET is_read=1');
  },
  async createNotification(type, message, payment_id, customer_id) {
    await pool.query('INSERT INTO notifications (type,message,payment_id,customer_id) VALUES (?,?,?,?)', [type, message, payment_id, customer_id]);
  },

  async getSetting(key) {
    const [rows] = await pool.query('SELECT value FROM settings WHERE `key`=?', [key]);
    return rows[0];
  },
  async getAllSettings() {
    const [rows] = await pool.query('SELECT `key`, value FROM settings');
    return rows;
  },
  async setSetting(key, value) {
    await pool.query('INSERT INTO settings (`key`,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=?', [key, value, value]);
  },

  async getAllInvoices() {
    const [rows] = await pool.query(`SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.whatsapp_consent FROM invoices i JOIN customers c ON i.customer_id = c.id ORDER BY i.created_at DESC`);
    return rows;
  },
  async getInvoiceById(id) {
    const [rows] = await pool.query(`SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.email as customer_email, c.company as customer_company, c.whatsapp_consent FROM invoices i JOIN customers c ON i.customer_id = c.id WHERE i.id = ?`, [id]);
    return rows[0];
  },
  async createInvoice(invoice_id, customer_id, content, amount, invoice_date, due_date, status) {
    const [result] = await pool.query(
      `INSERT INTO invoices (invoice_id, customer_id, content, amount, invoice_date, due_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [invoice_id, customer_id, content, amount, invoice_date, due_date, status]
    );
    return result;
  },
  async updateInvoice(customer_id, content, amount, invoice_date, due_date, status, id) {
    await pool.query(
      `UPDATE invoices SET customer_id=?, content=?, amount=?, invoice_date=?, due_date=?, status=? WHERE id=?`,
      [customer_id, content, amount, invoice_date, due_date, status, id]
    );
  },
  async deleteInvoice(id) {
    await pool.query('DELETE FROM invoices WHERE id=?', [id]);
  },
  async updateInvoiceStatus(status, id) {
    await pool.query('UPDATE invoices SET status=? WHERE id=?', [status, id]);
  },
  async getNextInvoiceNumber() {
    const [rows] = await pool.query(`SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_id, 5) AS UNSIGNED)), 0) + 1 as next_num FROM invoices`);
    return rows[0];
  },
};

module.exports = { pool, queries, calcNextDue, initDb };
