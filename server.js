const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'changeme_secret';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

/* ── Auth middleware ── */
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  const token = h.startsWith('Bearer ') ? h.slice(7) : h;
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

/* ── Login ── */
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.getUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, name: user.name, email: user.email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Profile ── */
app.get('/api/profile', auth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/profile', auth, async (req, res) => {
  try {
    const { name, email, currentPassword, newPassword } = req.body;
    await db.updateUser(name, email, req.user.id);
    if (newPassword) {
      const hash = await db.getPasswordHash(req.user.id);
      const ok = await bcrypt.compare(currentPassword, hash);
      if (!ok) return res.status(400).json({ error: 'Current password incorrect' });
      const newHash = await bcrypt.hash(newPassword, 10);
      await db.updatePassword(newHash, req.user.id);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Dashboard ── */
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    await db.syncAllCustomerPeriods();
    const stats = await db.getDashboardStats();
    stats.overdue_amount = await db.getOverdueAmount();
    const upcoming = await db.getUpcomingPayments();
    const overdue = await db.getOverduePeriodsByCustomer();
    res.json({ stats, upcoming, overdue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/financial-summary', auth, async (req, res) => {
  try {
    const stats = await db.getDashboardStats();
    stats.overdue_amount = await db.getOverdueAmount();
    const chart = await db.getMonthlyChart();

    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      months.push(d.toISOString().slice(0, 7));
    }

    const toMap = (arr) => {
      const m = {};
      arr.forEach(r => { m[r.month] = parseFloat(r.total) || 0; });
      return m;
    };

    const incomeMap = toMap(chart.income);
    const invMap = toMap(chart.invIncome);
    const expMap = toMap(chart.expenses);

    const chartData = months.map(m => ({
      month: m,
      income: (incomeMap[m] || 0) + (invMap[m] || 0),
      expenses: expMap[m] || 0,
    }));

    res.json({ stats, chartData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Customers ── */
app.get('/api/customers', auth, async (req, res) => {
  try {
    const rows = await db.getAllCustomers(req.query.search || null);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/customers/:id', auth, async (req, res) => {
  try {
    const c = await db.getCustomerById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const payments = await db.getPaymentsByCustomer(req.params.id);
    const allInv = await db.getAllInvoices();
    const invoices = allInv.filter(i => i.customer_id == req.params.id);
    res.json({ ...c, payments, invoices });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/customers', auth, async (req, res) => {
  try {
    const id = await db.createCustomer(req.body);
    await db.syncCustomerPeriods(id);
    res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/customers/:id', auth, async (req, res) => {
  try {
    await db.updateCustomer(req.params.id, req.body);
    await db.updateUnpaidPeriodAmounts(req.params.id, parseFloat(req.body.payment_amount) || 0);
    await db.syncCustomerPeriods(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/customers/:id', auth, async (req, res) => {
  try {
    await db.deleteCustomer(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Mark scheduled payment received */
app.post('/api/customers/:id/mark-paid', auth, async (req, res) => {
  try {
    const cust = await db.getCustomerById(req.params.id);
    if (!cust) return res.status(404).json({ error: 'Not found' });
    const today = new Date().toISOString().split('T')[0];
    await db.syncCustomerPeriods(cust.id);
    const settleAll = req.body.all === true || req.body.all === 'true';
    const due = await db.getPendingPeriodsDue(cust.id);
    const toSettle = settleAll ? due : due.slice(0, 1);
    if (!toSettle.length) return res.json({ success: true, next_due_date: cust.next_due_date, cycles_paid: 0 });
    for (const p of toSettle) {
      const next = db.calcNextDue(p.period_date, cust.payment_frequency, cust.frequency_value);
      const amount = (!settleAll && req.body.amount) ? req.body.amount : p.amount;
      const payDate = settleAll ? p.period_date : (req.body.payment_date || today);
      await db.createPayment({
        customer_id: cust.id, amount, payment_date: payDate,
        frequency: cust.payment_frequency, frequency_value: cust.frequency_value,
        next_due_date: next, status: 'paid',
        notes: req.body.notes || `Cycle due ${p.period_date}`, source: 'scheduled',
      });
    }
    await db.markPeriodsPaid(toSettle.map(p => p.id), today);
    const nextDue = await db.resyncNextDueDate(cust.id);
    res.json({ success: true, next_due_date: nextDue, cycles_paid: toSettle.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Pending (invoiceable) billing months for a customer — feeds the invoice month-picker */
app.get('/api/customers/:id/pending-periods', auth, async (req, res) => {
  try {
    await db.syncCustomerPeriods(req.params.id);
    res.json(await db.getInvoiceablePeriods(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Payments ── */
app.get('/api/payments', auth, async (req, res) => {
  try {
    const rows = await db.getAllPayments({
      customer_id: req.query.customer_id || null,
      frequency: req.query.frequency || null,
      month: req.query.month || null,
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/payments/upcoming', auth, async (req, res) => {
  try { res.json(await db.getUpcomingPayments()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/payments/overdue', auth, async (req, res) => {
  try { await db.syncAllCustomerPeriods(); res.json(await db.getOverduePeriodsByCustomer()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/payments/due', auth, async (req, res) => {
  try { res.json(await db.getDueCustomers()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/payments/calendar', auth, async (req, res) => {
  try {
    const { start, end } = req.query;
    res.json(await db.getPaymentsForCalendar(start, end));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payments', auth, async (req, res) => {
  try {
    const d = req.body;
    if (!d.next_due_date) {
      d.next_due_date = db.calcNextDue(d.payment_date, d.frequency, d.frequency_value);
    }
    const id = await db.createPayment(d);
    res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/payments/:id', auth, async (req, res) => {
  try {
    await db.updatePayment(req.params.id, req.body);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/payments/:id', auth, async (req, res) => {
  try {
    await db.deletePayment(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Invoices ── */
app.get('/api/invoices', auth, async (req, res) => {
  try { res.json(await db.getAllInvoices()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/:id', auth, async (req, res) => {
  try {
    const inv = await db.getInvoiceById(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Not found' });
    res.json(inv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Settle the billing periods an invoice covers: log a payment per period, mark them paid,
// resync the customer's next_due_date. Falls back to a single payment log when the invoice
// has no linked periods (ad-hoc / quick invoices), preserving prior behavior.
async function settleInvoicePeriods(invoiceId, customerId, invObj) {
  const today = new Date().toISOString().split('T')[0];
  const periods = await db.getPeriodsByInvoice(invoiceId);
  const cust = customerId ? await db.getCustomerById(customerId) : null;
  if (periods.length && cust) {
    for (const p of periods) {
      const next = db.calcNextDue(p.period_date, cust.payment_frequency, cust.frequency_value);
      await db.createPayment({
        customer_id: cust.id, amount: p.amount, payment_date: p.period_date,
        frequency: cust.payment_frequency, frequency_value: cust.frequency_value,
        next_due_date: next, status: 'paid', notes: `Invoice cycle due ${p.period_date}`, source: 'invoice',
      });
    }
    await db.markInvoicePeriodsPaid(invoiceId, today);
    await db.resyncNextDueDate(cust.id);
  } else {
    const inv = invObj || await db.getInvoiceById(invoiceId);
    if (inv && parseFloat(inv.amount) > 0) {
      const c = cust || await db.getCustomerById(inv.customer_id);
      await db.createPayment({
        customer_id: inv.customer_id, amount: inv.amount, payment_date: today,
        frequency: c?.payment_frequency || 'monthly', frequency_value: c?.frequency_value || 1,
        next_due_date: today, status: 'paid', notes: `Invoice ${inv.invoice_id} paid`, source: 'invoice',
      });
    }
  }
}

app.post('/api/invoices', auth, async (req, res) => {
  try {
    const d = req.body;
    if (!d.invoice_id) {
      const n = await db.getNextInvoiceNumber();
      d.invoice_id = 'INV-' + String(n).padStart(4, '0');
    }
    if (!d.invoice_date) d.invoice_date = new Date().toISOString().split('T')[0];
    const id = await db.createInvoice(d);
    const ids = Array.isArray(d.period_ids) ? d.period_ids : [];
    if (ids.length) await db.linkPeriodsToInvoice(id, ids);
    if (d.status === 'Paid') await settleInvoicePeriods(id, d.customer_id);
    res.json({ id, invoice_id: d.invoice_id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/invoices/:id', auth, async (req, res) => {
  try {
    await db.updateInvoice(req.params.id, req.body);
    if (Array.isArray(req.body.period_ids)) {
      const inv = await db.getInvoiceById(req.params.id);
      if (inv && inv.status !== 'Paid') {
        await db.unlinkInvoice(req.params.id);
        await db.linkPeriodsToInvoice(req.params.id, req.body.period_ids);
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Marking an invoice Paid settles the billing periods it covers (or logs one payment
   if it has none); un-marking a paid invoice re-opens its periods. */
app.put('/api/invoices/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    const inv = await db.getInvoiceById(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Not found' });
    const prev = inv.status;
    await db.updateInvoiceStatus(req.params.id, status);
    if (status === 'Paid' && prev !== 'Paid') {
      await settleInvoicePeriods(inv.id, inv.customer_id, inv);
    } else if (status !== 'Paid' && prev === 'Paid') {
      await db.reopenInvoicePeriods(inv.id);
      await db.resyncNextDueDate(inv.customer_id);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/invoices/:id', auth, async (req, res) => {
  try {
    await db.deleteInvoice(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Expenses ── */
app.get('/api/expenses', auth, async (req, res) => {
  try { res.json(await db.getAllExpenses()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/expenses/:id', auth, async (req, res) => {
  try {
    const exp = await db.getExpenseById(req.params.id);
    if (!exp) return res.status(404).json({ error: 'Not found' });
    const records = await db.getExpenseRecords(req.params.id);
    res.json({ ...exp, records });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/expenses', auth, async (req, res) => {
  try {
    const id = await db.createExpense(req.body);
    res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/expenses/:id', auth, async (req, res) => {
  try {
    await db.updateExpense(req.params.id, req.body);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/expenses/:id', auth, async (req, res) => {
  try {
    await db.deleteExpense(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/expenses/:id/mark-paid', auth, async (req, res) => {
  try {
    const exp = await db.getExpenseById(req.params.id);
    if (!exp) return res.status(404).json({ error: 'Not found' });
    const today = new Date().toISOString().split('T')[0];
    const recordId = await db.markExpensePaid(
      req.params.id,
      req.body.amount || exp.amount,
      req.body.paid_date || today,
      req.body.notes || ''
    );
    res.json({ success: true, record_id: recordId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/expenses/:id/records', auth, async (req, res) => {
  try { res.json(await db.getExpenseRecords(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Notifications ── */
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const notifs = await db.getNotifications();
    const unread = await db.getUnreadCount();
    res.json({ notifications: notifs, unread_count: unread });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notifications/:id/read', auth, async (req, res) => {
  try {
    await db.markNotifRead(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notifications/read-all', auth, async (req, res) => {
  try {
    await db.markAllNotifsRead();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Signature ── */
app.get('/api/signature', auth, (req, res) => {
  try {
    const sigPath = path.join(__dirname, 'sig_clean.txt');
    if (fs.existsSync(sigPath)) {
      const base64 = fs.readFileSync(sigPath, 'utf8').trim();
      res.json({ signature: `data:image/jpeg;base64,${base64}` });
    } else {
      res.json({ signature: null });
    }
  } catch (e) { res.json({ signature: null }); }
});

/* ── Settings ── */
app.get('/api/settings', auth, async (req, res) => {
  try {
    const rows = await db.getAllSettings();
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    obj.wa_token_set = obj.wa_access_token ? 'true' : 'false';
    delete obj.wa_access_token;   // never expose the token to the browser
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', auth, async (req, res) => {
  try {
    for (const [k, v] of Object.entries(req.body)) {
      await db.setSetting(k, v);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── WhatsApp (Meta Cloud API) ── */
// Upload a PNG to WhatsApp media, then send the approved template with an image header + body vars.
async function waUploadAndSend(s, phone, imgBuf, filename, bodyTexts) {
  const base = `https://graph.facebook.com/${s.wa_api_version || 'v21.0'}`;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([imgBuf], { type: 'image/png' }), filename);
  const upRes = await fetch(`${base}/${s.wa_phone_number_id}/media`, {
    method: 'POST', headers: { Authorization: `Bearer ${s.wa_access_token}` }, body: form,
  });
  const upJson = await upRes.json();
  if (!upRes.ok || !upJson.id) return { ok: false, error: 'Media upload failed: ' + JSON.stringify(upJson.error || upJson) };
  const payload = {
    messaging_product: 'whatsapp', to: phone, type: 'template',
    template: {
      name: s.wa_template_name || 'invoice_notification',
      language: { code: s.wa_template_lang || 'en' },
      components: [
        { type: 'header', parameters: [{ type: 'image', image: { id: upJson.id } }] },
        { type: 'body', parameters: bodyTexts.map(t => ({ type: 'text', text: String(t) })) },
      ],
    },
  };
  const msgRes = await fetch(`${base}/${s.wa_phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.wa_access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const msgJson = await msgRes.json();
  if (!msgRes.ok) return { ok: false, error: 'Send failed: ' + JSON.stringify(msgJson.error || msgJson) };
  return { ok: true, message_id: msgJson.messages && msgJson.messages[0] && msgJson.messages[0].id };
}

function waSettings(rows) { const s = {}; rows.forEach(r => { s[r.key] = r.value; }); return s; }

app.post('/api/invoices/:id/send-whatsapp', auth, async (req, res) => {
  try {
    const s = waSettings(await db.getAllSettings());
    if (s.wa_api_enabled !== 'true') return res.status(400).json({ error: 'WhatsApp API is not enabled in Settings.' });
    if (!s.wa_phone_number_id || !s.wa_access_token) return res.status(400).json({ error: 'WhatsApp API is not configured (Phone Number ID / token missing).' });
    const inv = await db.getInvoiceById(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    let phone = String(inv.customer_phone || '').replace(/[^0-9]/g, '');
    if (!phone) return res.status(400).json({ error: 'No phone number saved for this customer.' });
    if (phone.startsWith('0')) phone = '92' + phone.slice(1);
    const { image_base64 } = req.body;
    if (!image_base64) return res.status(400).json({ error: 'Missing invoice image.' });
    const buf = Buffer.from(String(image_base64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const amountStr = 'Rs ' + Number(inv.amount || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 });
    const r = await waUploadAndSend(s, phone, buf, `${inv.invoice_id}.png`, [inv.customer_name || '', inv.invoice_id || '', amountStr, inv.due_date || '-']);
    if (!r.ok) return res.status(502).json({ error: r.error });
    if (inv.status === 'Draft') await db.updateInvoiceStatus(inv.id, 'Sent');
    await db.createNotification('info', `Invoice ${inv.invoice_id} sent to ${inv.customer_name} via WhatsApp`, null, inv.customer_id);
    res.json({ success: true, message_id: r.message_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/test-whatsapp', auth, async (req, res) => {
  try {
    const s = waSettings(await db.getAllSettings());
    if (s.wa_api_enabled !== 'true') return res.status(400).json({ error: 'WhatsApp API is not enabled. Turn it on and Save first.' });
    if (!s.wa_phone_number_id || !s.wa_access_token) return res.status(400).json({ error: 'WhatsApp API is not configured (Phone Number ID / token missing). Save your settings first.' });
    let phone = String(req.body.to || '').replace(/[^0-9]/g, '');
    if (!phone) return res.status(400).json({ error: 'Enter a test phone number (your own WhatsApp).' });
    if (phone.startsWith('0')) phone = '92' + phone.slice(1);
    const buf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const today = new Date().toISOString().split('T')[0];
    const r = await waUploadAndSend(s, phone, buf, 'test.png', ['Test Customer', 'INV-TEST', 'Rs 0', today]);
    if (!r.ok) return res.status(502).json({ error: r.error });
    res.json({ success: true, message_id: r.message_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Reminder job ── */
async function sendReminders() {
  try {
    const rows = await db.getAllSettings();
    const sMap = {};
    rows.forEach(r => { sMap[r.key] = r.value; });

    const days1 = parseInt(sMap.reminder_days_before) || 7;
    const days2 = parseInt(sMap.reminder_days_before_2) || 1;

    for (const offset of [days1, days2]) {
      const customers = await db.getPaymentsForReminders(offset);
      for (const c of customers) {
        await db.createNotification(
          'payment_due',
          `Payment of PKR ${Number(c.amount).toLocaleString()} due from ${c.customer_name} in ${offset} day(s) (${c.next_due_date})`,
          null, c.id
        );
      }
    }
  } catch (e) {
    console.error('Reminder error:', e.message);
  }
}

/* ── SPA fallback: serve the git-tracked index.html for non-API GET routes.
   (Version-safe middleware form; keeps the served frontend in sync with `git pull`.) */
app.use((req, res) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ── Start ── */
db.initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    setInterval(sendReminders, 60 * 60 * 1000);
    sendReminders();
  });
}).catch(e => {
  console.error('DB init failed:', e);
  process.exit(1);
});
