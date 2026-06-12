const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { db, queries, calcNextDue } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'payment-reminder-secret-2024';

app.use(cors());
app.use(express.json());

function auth(req, res, next) {
const header = req.headers.authorization;
if (!header) return res.status(401).json({ error: 'No token' });
try {
req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
next();
} catch {
res.status(401).json({ error: 'Invalid token' });
}
}

function getTransporter() {
const s = {};
queries.getAllSettings.all().forEach(r => { s[r.key] = r.value; });
if (s.email_enabled !== 'true') return null;
return nodemailer.createTransport({
host: s.smtp_host,
port: parseInt(s.smtp_port) || 587,
secure: parseInt(s.smtp_port) === 465,
auth: { user: s.smtp_user, pass: s.smtp_pass },
});
}

async function sendReminderEmail(subject, html) {
const transporter = getTransporter();
if (!transporter) return;
const ownerEmail = queries.getSetting.get('owner_email')?.value;
if (!ownerEmail) return;
try {
await transporter.sendMail({
from: queries.getSetting.get('smtp_user')?.value,
to: ownerEmail,
subject,
html,
});
} catch (e) {
console.error('Email error:', e.message);
}
}

cron.schedule('0 8 * * *', async () => {
const settings = {};
queries.getAllSettings.all().forEach(r => { settings[r.key] = r.value; });
const days = [settings.reminder_days_before || '7', settings.reminder_days_before_2 || '1'];
for (const d of days) {
const customers = queries.getPaymentsForReminders.all(`+${d}`);
for (const c of customers) {
const msg = `Payment of ${c.amount} from ${c.customer_name} is due in ${d} day(s) on ${c.next_due_date}`;
queries.createNotification.run('reminder', msg, null, c.id);
await sendReminderEmail(
`Payment Reminder: ${c.customer_name} – Due in ${d} day(s)`,
`<h2>Payment Reminder</h2><p>${msg}</p><p><strong>Amount:</strong> ${c.amount}</p><p><strong>Due Date:</strong> ${c.next_due_date}</p>`
);
}
}
console.log('[cron] Daily reminders processed');
});

app.post('/api/auth/login', (req, res) => {
const { username, password } = req.body;
const user = queries.getUserByUsername.get(username);
if (!user || !bcrypt.compareSync(password, user.password))
return res.status(401).json({ error: 'Invalid credentials' });
const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
res.json({ token, user: { id: user.id, username: user.username, name: user.name, email: user.email } });
});

app.get('/api/auth/me', auth, (req, res) => {
res.json(queries.getUserById.get(req.user.id));
});

app.put('/api/auth/profile', auth, (req, res) => {
const { name, email } = req.body;
queries.updateUser.run(name, email, req.user.id);
res.json({ success: true });
});

app.put('/api/auth/password', auth, (req, res) => {
const { current, newPassword } = req.body;
const full = db.prepare('SELECT password FROM users WHERE id=?').get(req.user.id);
if (!bcrypt.compareSync(current, full.password))
return res.status(400).json({ error: 'Current password is incorrect' });
queries.updatePassword.run(bcrypt.hashSync(newPassword, 10), req.user.id);
res.json({ success: true });
});

app.get('/api/dashboard', auth, (req, res) => {
res.json({
stats: queries.getDashboardStats.get(),
upcoming: queries.getUpcomingPayments.all(),
overdue: queries.getOverduePayments.all(),
});
});

app.get('/api/customers', auth, (req, res) => {
let list = queries.getAllCustomers.all();
if (req.query.search) {
const q = req.query.search.toLowerCase();
list = list.filter(c =>
c.name.toLowerCase().includes(q) ||
(c.company||'').toLowerCase().includes(q) ||
(c.phone||'').includes(q) ||
(c.email||'').toLowerCase().includes(q)
);
}
res.json(list);
});

app.get('/api/customers/:id', auth, (req, res) => {
const c = queries.getCustomerById.get(req.params.id);
if (!c) return res.status(404).json({ error: 'Not found' });
res.json({ ...c, payments: queries.getPaymentsByCustomer.all(req.params.id) });
});

app.post('/api/customers', auth, (req, res) => {
const { name, company, phone, email, address, notes,
payment_frequency, frequency_value, payment_amount, next_due_date, whatsapp_consent } = req.body;
if (!name) return res.status(400).json({ error: 'Name is required' });
const r = queries.createCustomer.run(
name, company||'', phone||'', email||'', address||'', notes||'',
payment_frequency||'monthly', parseInt(frequency_value)||1,
parseFloat(payment_amount)||0, next_due_date||null,
whatsapp_consent ? 1 : 0
);
res.json({ id: r.lastInsertRowid, success: true });
});

app.put('/api/customers/:id', auth, (req, res) => {
const { name, company, phone, email, address, notes,
payment_frequency, frequency_value, payment_amount, next_due_date, whatsapp_consent } = req.body;
queries.updateCustomer.run(
name, company||'', phone||'', email||'', address||'', notes||'',
payment_frequency||'monthly', parseInt(frequency_value)||1,
parseFloat(payment_amount)||0, next_due_date||null,
whatsapp_consent ? 1 : 0,
req.params.id
);
res.json({ success: true });
});

app.delete('/api/customers/:id', auth, (req, res) => {
queries.deleteCustomer.run(req.params.id);
res.json({ success: true });
});

app.post('/api/customers/:id/mark-paid', auth, (req, res) => {
const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
if (!customer) return res.status(404).json({ error: 'Not found' });
const paymentDate = req.body.payment_date || new Date().toISOString().split('T')[0];
const amount = parseFloat(req.body.amount) || customer.payment_amount;
const next = calcNextDue(paymentDate, customer.payment_frequency, customer.frequency_value || 1);
const r = queries.createPayment.run(
customer.id, amount, paymentDate,
customer.payment_frequency, customer.frequency_value || 1,
next, 'paid', req.body.notes || ''
);
queries.updateCustomerNextDue.run(next, customer.id);
queries.createNotification.run(
'payment_received',
`Payment of ${amount} received from ${customer.name}. Next due: ${next}`,
r.lastInsertRowid, customer.id
);
res.json({ success: true, next_due_date: next });
});

app.get('/api/due-payments', auth, (req, res) => {
res.json(queries.getDueCustomers.all());
});

app.get('/api/overdue-payments', auth, (req, res) => {
res.json(queries.getOverdueCustomers.all());
});

app.get('/api/payments', auth, (req, res) => {
let list = queries.getAllPayments.all();
if (req.query.frequency) list = list.filter(p => p.frequency === req.query.frequency);
if (req.query.customer_id) list = list.filter(p => p.customer_id == req.query.customer_id);
res.json(list);
});

app.get('/api/payments/:id', auth, (req, res) => {
const p = queries.getPaymentById.get(req.params.id);
if (!p) return res.status(404).json({ error: 'Not found' });
res.json(p);
});

app.post('/api/payments', auth, (req, res) => {
const { customer_id, amount, payment_date, frequency, frequency_value, notes } = req.body;
if (!customer_id || !amount || !payment_date || !frequency)
return res.status(400).json({ error: 'Missing required fields' });
const next = calcNextDue(payment_date, frequency, frequency_value || 1);
const r = queries.createPayment.run(customer_id, amount, payment_date, frequency, frequency_value||1, next, 'paid', notes||'');
res.json({ id: r.lastInsertRowid, next_due_date: next, success: true });
});

app.put('/api/payments/:id', auth, (req, res) => {
const { customer_id, amount, payment_date, frequency, frequency_value, next_due_date, notes } = req.body;
const next = next_due_date || calcNextDue(payment_date, frequency, frequency_value || 1);
queries.updatePayment.run(customer_id, amount, payment_date, frequency, frequency_value||1, next, 'paid', notes||'', req.params.id);
res.json({ success: true });
});

app.delete('/api/payments/:id', auth, (req, res) => {
queries.deletePayment.run(req.params.id);
res.json({ success: true });
});

app.post('/api/payments/:id/mark-paid', auth, (req, res) => {
const payment = queries.getPaymentById.get(req.params.id);
if (!payment) return res.status(404).json({ error: 'Not found' });
const today = new Date().toISOString().split('T')[0];
const next = calcNextDue(today, payment.frequency, payment.frequency_value);
queries.markPaid.run(today, next, req.params.id);
queries.createNotification.run('payment_received',
`Payment received from ${payment.customer_name}. Next due: ${next}`,
payment.id, payment.customer_id
);
res.json({ success: true, next_due_date: next });
});

app.get('/api/invoices', auth, (req, res) => {
res.json(queries.getAllInvoices.all());
});

app.get('/api/invoices/:id', auth, (req, res) => {
const inv = queries.getInvoiceById.get(req.params.id);
if (!inv) return res.status(404).json({ error: 'Not found' });
res.json(inv);
});

app.post('/api/invoices', auth, (req, res) => {
const { customer_id, content, amount, invoice_date, due_date, status } = req.body;
if (!customer_id) return res.status(400).json({ error: 'Customer is required' });
const nextNum = queries.getNextInvoiceNumber.get().next_num;
const invoice_id = 'INV-' + String(nextNum).padStart(4, '0');
const r = queries.createInvoice.run(
invoice_id, customer_id, content||'',
parseFloat(amount)||0,
invoice_date || new Date().toISOString().split('T')[0],
due_date||null, status||'Draft'
);
res.json({ id: r.lastInsertRowid, invoice_id, success: true });
});

app.put('/api/invoices/:id', auth, (req, res) => {
const { customer_id, content, amount, invoice_date, due_date, status } = req.body;
queries.updateInvoice.run(
customer_id, content||'',
parseFloat(amount)||0,
invoice_date, due_date||null, status||'Draft',
req.params.id
);
res.json({ success: true });
});

app.delete('/api/invoices/:id', auth, (req, res) => {
queries.deleteInvoice.run(req.params.id);
res.json({ success: true });
});

app.put('/api/invoices/:id/status', auth, (req, res) => {
const { status } = req.body;
if (!['Draft','Sent','Paid'].includes(status))
return res.status(400).json({ error: 'Invalid status' });
queries.updateInvoiceStatus.run(status, req.params.id);
res.json({ success: true });
});

app.get('/api/calendar', auth, (req, res) => {
const { start, end } = req.query;
if (!start || !end) return res.status(400).json({ error: 'start and end required' });
res.json(queries.getPaymentsForCalendar.all(start, end));
});

app.get('/api/notifications', auth, (req, res) => {
res.json({ notifications: queries.getNotifications.all(), unread: queries.getUnreadCount.get().n });
});

app.put('/api/notifications/:id/read', auth, (req, res) => {
queries.markNotifRead.run(req.params.id);
res.json({ success: true });
});

app.put('/api/notifications/read-all', auth, (req, res) => {
queries.markAllNotifsRead.run();
res.json({ success: true });
});

app.get('/api/settings', auth, (req, res) => {
const rows = queries.getAllSettings.all();
const s = {};
rows.forEach(r => { s[r.key] = r.value; });
delete s.smtp_pass;
res.json(s);
});

app.put('/api/settings', auth, (req, res) => {
for (const [key, value] of Object.entries(req.body))
queries.setSetting.run(key, String(value));
res.json({ success: true });
});

app.post('/api/settings/test-email', auth, async (req, res) => {
const transporter = getTransporter();
if (!transporter) return res.status(400).json({ error: 'Email not configured or disabled' });
try {
await transporter.sendMail({
from: queries.getSetting.get('smtp_user')?.value,
to: queries.getSetting.get('owner_email')?.value,
subject: 'Test Email – Payment Reminder System',
html: '<h2>Email is working!</h2><p>Your payment reminder email is configured correctly.</p>',
});
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reminders/trigger', auth, async (req, res) => {
const settings = {};
queries.getAllSettings.all().forEach(r => { settings[r.key] = r.value; });
const days = [settings.reminder_days_before || '7', settings.reminder_days_before_2 || '1'];
let count = 0;
for (const d of days) {
const customers = queries.getPaymentsForReminders.all(`+${d}`);
for (const c of customers) {
const msg = `Payment of ${c.amount} from ${c.customer_name} is due in ${d} day(s) on ${c.next_due_date}`;
queries.createNotification.run('reminder', msg, null, c.id);
count++;
}
}
res.json({ success: true, reminders_created: count });
});

app.get('*', (req, res) => {
const htmlPath = path.join(__dirname, 'index.html');
if (fs.existsSync(htmlPath)) res.sendFile(htmlPath);
else res.status(404).send('index.html not found.');
});

app.listen(PORT, () => {
console.log(`\n🚀 Payment Reminder System running at http://localhost:${PORT}`);
console.log(` Default login: admin / admin123\n`);
});
