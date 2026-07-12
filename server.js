const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { pool, queries, calcNextDue, computeDueCycles, initDb } = require('./database');

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

async function getTransporter() {
const s = {};
(await queries.getAllSettings()).forEach(r => { s[r.key] = r.value; });
if (s.email_enabled !== 'true') return null;
return nodemailer.createTransport({
host: s.smtp_host,
port: parseInt(s.smtp_port) || 587,
secure: parseInt(s.smtp_port) === 465,
auth: { user: s.smtp_user, pass: s.smtp_pass },
});
}

async function sendReminderEmail(subject, html) {
const transporter = await getTransporter();
if (!transporter) return;
const ownerEmailRow = await queries.getSetting('owner_email');
const ownerEmail = ownerEmailRow?.value;
if (!ownerEmail) return;
try {
const smtpUserRow = await queries.getSetting('smtp_user');
await transporter.sendMail({
from: smtpUserRow?.value,
to: ownerEmail,
subject,
html,
});
} catch (e) {
console.error('Email error:', e.message);
}
}

cron.schedule('0 8 * * *', async () => {
try {
const settings = {};
(await queries.getAllSettings()).forEach(r => { settings[r.key] = r.value; });
const days = [settings.reminder_days_before || '7', settings.reminder_days_before_2 || '1'];
for (const d of days) {
const customers = await queries.getPaymentsForReminders(parseInt(d));
for (const c of customers) {
const msg = `Payment of ${c.amount} from ${c.customer_name} is due in ${d} day(s) on ${c.next_due_date}`;
await queries.createNotification('reminder', msg, null, c.id);
await sendReminderEmail(
`Payment Reminder: ${c.customer_name} – Due in ${d} day(s)`,
`<h2>Payment Reminder</h2><p>${msg}</p><p><strong>Amount:</strong> ${c.amount}</p><p><strong>Due Date:</strong> ${c.next_due_date}</p>`
);
}
}
console.log('[cron] Daily reminders processed');
} catch (e) {
console.error('[cron] error:', e.message);
}
});

app.post('/api/auth/login', async (req, res) => {
try {
const { username, password } = req.body;
const user = await queries.getUserByUsername(username);
if (!user || !bcrypt.compareSync(password, user.password))
return res.status(401).json({ error: 'Invalid credentials' });
const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
res.json({ token, user: { id: user.id, username: user.username, name: user.name, email: user.email } });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
try {
res.json(await queries.getUserById(req.user.id));
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/auth/profile', auth, async (req, res) => {
try {
const { name, email } = req.body;
await queries.updateUser(name, email, req.user.id);
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/auth/password', auth, async (req, res) => {
try {
const { current, newPassword } = req.body;
const full = await queries.getFullUser(req.user.id);
if (!full || !bcrypt.compareSync(current, full.password))
return res.status(400).json({ error: 'Current password is incorrect' });
await queries.updatePassword(bcrypt.hashSync(newPassword, 10), req.user.id);
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard', auth, async (req, res) => {
try {
const today = new Date().toISOString().split('T')[0];
const stats = await queries.getDashboardStats();
const upcoming = await queries.getUpcomingPayments();
let totalOverdue = 0;
const overdue = (await queries.getOverduePayments()).map(c => {
const { cycles } = computeDueCycles(c.next_due_date, c.payment_frequency, c.frequency_value, today);
const n = Math.max(cycles, 1);
const total = (parseFloat(c.amount) || 0) * n;
totalOverdue += total;
return { ...c, cycles_overdue: n, total_due: +total.toFixed(2) };
});
stats.total_overdue_amount = +totalOverdue.toFixed(2);
res.json({ stats, upcoming, overdue });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/customers', auth, async (req, res) => {
try {
let list = await queries.getAllCustomers();
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
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/customers/:id', auth, async (req, res) => {
try {
const c = await queries.getCustomerById(req.params.id);
if (!c) return res.status(404).json({ error: 'Not found' });
res.json({ ...c, payments: await queries.getPaymentsByCustomer(req.params.id) });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/customers', auth, async (req, res) => {
try {
const { name, company, phone, email, address, notes,
payment_frequency, frequency_value, payment_amount, next_due_date, whatsapp_consent } = req.body;
if (!name) return res.status(400).json({ error: 'Name is required' });
const r = await queries.createCustomer(
name, company||'', phone||'', email||'', address||'', notes||'',
payment_frequency||'monthly', parseInt(frequency_value)||1,
parseFloat(payment_amount)||0, next_due_date||null,
whatsapp_consent ? 1 : 0
);
res.json({ id: r.insertId, success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/customers/:id', auth, async (req, res) => {
try {
const { name, company, phone, email, address, notes,
payment_frequency, frequency_value, payment_amount, next_due_date, whatsapp_consent } = req.body;
await queries.updateCustomer(
name, company||'', phone||'', email||'', address||'', notes||'',
payment_frequency||'monthly', parseInt(frequency_value)||1,
parseFloat(payment_amount)||0, next_due_date||null,
whatsapp_consent ? 1 : 0,
req.params.id
);
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/customers/:id', auth, async (req, res) => {
try {
await queries.deleteCustomer(req.params.id);
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/customers/:id/mark-paid', auth, async (req, res) => {
try {
const customer = await queries.getCustomerById(req.params.id);
if (!customer) return res.status(404).json({ error: 'Not found' });
const today = new Date().toISOString().split('T')[0];
const freq = customer.payment_frequency;
const val = customer.frequency_value || 1;
const settleAll = req.body.all === true || req.body.all === 'true';

// How many scheduled cycles to clear. The due date advances along the schedule
// (e.g. the 10th of each month) — NOT from the date the button is clicked.
let cyclesToClear = 1;
if (settleAll) {
const { cycles } = computeDueCycles(customer.next_due_date, freq, val, today);
cyclesToClear = Math.max(cycles, 1);
}

let dueDate = customer.next_due_date;
let lastInsertId = null;
for (let i = 0; i < cyclesToClear; i++) {
const next = calcNextDue(dueDate, freq, val);
const amount = (!settleAll && req.body.amount) ? parseFloat(req.body.amount) : (parseFloat(customer.payment_amount) || 0);
const payDate = settleAll ? dueDate : (req.body.payment_date || today);
const r = await queries.createPayment(
customer.id, amount, payDate, freq, val, next, 'paid',
req.body.notes || (settleAll ? `Cycle due ${dueDate}` : '')
);
lastInsertId = r.insertId;
dueDate = next; // advance one cycle along the schedule
}
await queries.updateCustomerNextDue(dueDate, customer.id);
await queries.createNotification(
'payment_received',
cyclesToClear > 1
? `${cyclesToClear} payments settled for ${customer.name}. Next due: ${dueDate}`
: `Payment received from ${customer.name}. Next due: ${dueDate}`,
lastInsertId, customer.id
);
res.json({ success: true, next_due_date: dueDate, cycles_paid: cyclesToClear });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/due-payments', auth, async (req, res) => {
try {
res.json(await queries.getDueCustomers());
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/overdue-payments', auth, async (req, res) => {
try {
const today = new Date().toISOString().split('T')[0];
const list = await queries.getOverdueCustomers();
res.json(list.map(c => {
const { cycles, dueDates } = computeDueCycles(c.next_due_date, c.payment_frequency, c.frequency_value, today);
const n = Math.max(cycles, 1);
return { ...c, cycles_overdue: n, total_due: +(((parseFloat(c.payment_amount) || 0) * n)).toFixed(2), due_dates: dueDates };
}));
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/payments', auth, async (req, res) => {
try {
let list = await queries.getAllPayments();
if (req.query.frequency) list = list.filter(p => p.frequency === req.query.frequency);
if (req.query.customer_id) list = list.filter(p => p.customer_id == req.query.customer_id);
res.json(list);
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/payments/:id', auth, async (req, res) => {
try {
const p = await queries.getPaymentById(req.params.id);
if (!p) return res.status(404).json({ error: 'Not found' });
res.json(p);
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payments', auth, async (req, res) => {
try {
const { customer_id, amount, payment_date, frequency, frequency_value, notes } = req.body;
if (!customer_id || !amount || !payment_date || !frequency)
return res.status(400).json({ error: 'Missing required fields' });
const next = calcNextDue(payment_date, frequency, frequency_value || 1);
const r = await queries.createPayment(customer_id, amount, payment_date, frequency, frequency_value||1, next, 'paid', notes||'');
res.json({ id: r.insertId, next_due_date: next, success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/payments/:id', auth, async (req, res) => {
try {
const { customer_id, amount, payment_date, frequency, frequency_value, next_due_date, notes } = req.body;
const next = next_due_date || calcNextDue(payment_date, frequency, frequency_value || 1);
await queries.updatePayment(customer_id, amount, payment_date, frequency, frequency_value||1, next, 'paid', notes||'', req.params.id);
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/payments/:id', auth, async (req, res) => {
try {
await queries.deletePayment(req.params.id);
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payments/:id/mark-paid', auth, async (req, res) => {
try {
const payment = await queries.getPaymentById(req.params.id);
if (!payment) return res.status(404).json({ error: 'Not found' });
const today = new Date().toISOString().split('T')[0];
const next = calcNextDue(today, payment.frequency, payment.frequency_value);
await queries.markPaid(today, next, req.params.id);
await queries.createNotification('payment_received',
`Payment received from ${payment.customer_name}. Next due: ${next}`,
payment.id, payment.customer_id
);
res.json({ success: true, next_due_date: next });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices', auth, async (req, res) => {
try {
res.json(await queries.getAllInvoices());
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/:id', auth, async (req, res) => {
try {
const inv = await queries.getInvoiceById(req.params.id);
if (!inv) return res.status(404).json({ error: 'Not found' });
res.json(inv);
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/invoices', auth, async (req, res) => {
try {
const { customer_id, content, amount, invoice_date, due_date, status } = req.body;
if (!customer_id) return res.status(400).json({ error: 'Customer is required' });
const nextNumRow = await queries.getNextInvoiceNumber();
const nextNum = nextNumRow.next_num;
const invoice_id = 'INV-' + String(nextNum).padStart(4, '0');
const r = await queries.createInvoice(
invoice_id, customer_id, content||'',
parseFloat(amount)||0,
invoice_date || new Date().toISOString().split('T')[0],
due_date||null, status||'Draft'
);
res.json({ id: r.insertId, invoice_id, success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/invoices/:id', auth, async (req, res) => {
try {
const { customer_id, content, amount, invoice_date, due_date, status } = req.body;
await queries.updateInvoice(
customer_id, content||'',
parseFloat(amount)||0,
invoice_date, due_date||null, status||'Draft',
req.params.id
);
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/invoices/:id', auth, async (req, res) => {
try {
await queries.deleteInvoice(req.params.id);
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/invoices/:id/status', auth, async (req, res) => {
try {
const { status } = req.body;
if (!['Draft','Sent','Paid'].includes(status))
return res.status(400).json({ error: 'Invalid status' });
await queries.updateInvoiceStatus(status, req.params.id);
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/invoices/:id/send-whatsapp', auth, async (req, res) => {
try {
const s = {};
(await queries.getAllSettings()).forEach(r => { s[r.key] = r.value; });
if (s.wa_api_enabled !== 'true') return res.status(400).json({ error: 'WhatsApp API is not enabled in Settings.' });
if (!s.wa_phone_number_id || !s.wa_access_token) return res.status(400).json({ error: 'WhatsApp API is not configured (Phone Number ID / token missing).' });

const inv = await queries.getInvoiceById(req.params.id);
if (!inv) return res.status(404).json({ error: 'Invoice not found' });
let phone = String(inv.customer_phone || '').replace(/[^0-9]/g, '');
if (!phone) return res.status(400).json({ error: 'No phone number saved for this customer.' });
if (phone.startsWith('0')) phone = '92' + phone.slice(1);

const { image_base64 } = req.body;
if (!image_base64) return res.status(400).json({ error: 'Missing invoice image.' });

const version = s.wa_api_version || 'v21.0';
const base = `https://graph.facebook.com/${version}`;

// 1) Upload the invoice image to WhatsApp media
const b64 = String(image_base64).replace(/^data:image\/\w+;base64,/, '');
const buf = Buffer.from(b64, 'base64');
const form = new FormData();
form.append('messaging_product', 'whatsapp');
form.append('file', new Blob([buf], { type: 'image/png' }), `${inv.invoice_id}.png`);
const upRes = await fetch(`${base}/${s.wa_phone_number_id}/media`, {
method: 'POST',
headers: { Authorization: `Bearer ${s.wa_access_token}` },
body: form,
});
const upJson = await upRes.json();
if (!upRes.ok || !upJson.id) return res.status(502).json({ error: 'Media upload failed: ' + JSON.stringify(upJson.error || upJson) });

// 2) Send the approved template with the image header + body variables
const amountStr = 'Rs ' + Number(inv.amount || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 });
const payload = {
messaging_product: 'whatsapp',
to: phone,
type: 'template',
template: {
name: s.wa_template_name || 'invoice_notification',
language: { code: s.wa_template_lang || 'en' },
components: [
{ type: 'header', parameters: [{ type: 'image', image: { id: upJson.id } }] },
{ type: 'body', parameters: [
{ type: 'text', text: String(inv.customer_name || '') },
{ type: 'text', text: String(inv.invoice_id || '') },
{ type: 'text', text: amountStr },
{ type: 'text', text: String(inv.due_date || '-') },
] },
],
},
};
const msgRes = await fetch(`${base}/${s.wa_phone_number_id}/messages`, {
method: 'POST',
headers: { Authorization: `Bearer ${s.wa_access_token}`, 'Content-Type': 'application/json' },
body: JSON.stringify(payload),
});
const msgJson = await msgRes.json();
if (!msgRes.ok) return res.status(502).json({ error: 'Send failed: ' + JSON.stringify(msgJson.error || msgJson) });

if (inv.status === 'Draft') await queries.updateInvoiceStatus('Sent', inv.id);
await queries.createNotification('info', `Invoice ${inv.invoice_id} sent to ${inv.customer_name} via WhatsApp`, null, inv.customer_id);
res.json({ success: true, message_id: msgJson.messages && msgJson.messages[0] && msgJson.messages[0].id });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/calendar', auth, async (req, res) => {
try {
const { start, end } = req.query;
if (!start || !end) return res.status(400).json({ error: 'start and end required' });
res.json(await queries.getPaymentsForCalendar(start, end));
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notifications', auth, async (req, res) => {
try {
const unreadRow = await queries.getUnreadCount();
res.json({ notifications: await queries.getNotifications(), unread: unreadRow.n });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notifications/:id/read', auth, async (req, res) => {
try {
await queries.markNotifRead(req.params.id);
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notifications/read-all', auth, async (req, res) => {
try {
await queries.markAllNotifsRead();
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/settings', auth, async (req, res) => {
try {
const rows = await queries.getAllSettings();
const s = {};
rows.forEach(r => { s[r.key] = r.value; });
delete s.smtp_pass;
delete s.wa_access_token;
res.json(s);
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', auth, async (req, res) => {
try {
for (const [key, value] of Object.entries(req.body))
await queries.setSetting(key, String(value));
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/test-email', auth, async (req, res) => {
try {
const transporter = await getTransporter();
if (!transporter) return res.status(400).json({ error: 'Email not configured or disabled' });
const smtpUserRow = await queries.getSetting('smtp_user');
const ownerEmailRow = await queries.getSetting('owner_email');
await transporter.sendMail({
from: smtpUserRow?.value,
to: ownerEmailRow?.value,
subject: 'Test Email – Payment Reminder System',
html: '<h2>Email is working!</h2><p>Your payment reminder email is configured correctly.</p>',
});
res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reminders/trigger', auth, async (req, res) => {
try {
const settings = {};
(await queries.getAllSettings()).forEach(r => { settings[r.key] = r.value; });
const days = [settings.reminder_days_before || '7', settings.reminder_days_before_2 || '1'];
let count = 0;
for (const d of days) {
const customers = await queries.getPaymentsForReminders(parseInt(d));
for (const c of customers) {
const msg = `Payment of ${c.amount} from ${c.customer_name} is due in ${d} day(s) on ${c.next_due_date}`;
await queries.createNotification('reminder', msg, null, c.id);
count++;
}
}
res.json({ success: true, reminders_created: count });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => {
const htmlPath = path.join(__dirname, 'index.html');
if (fs.existsSync(htmlPath)) res.sendFile(htmlPath);
else res.status(404).send('index.html not found.');
});

initDb()
.then(() => {
app.listen(PORT, () => {
console.log(`\n🚀 Payment Reminder System running at http://localhost:${PORT}`);
console.log(` Default login: admin / admin123\n`);
});
})
.catch(err => {
console.error('Failed to initialize database:', err);
process.exit(1);
});
