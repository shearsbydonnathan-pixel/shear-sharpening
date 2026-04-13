/**
 * Shear Sharpening by Don Nathan
 * Backend Server - Twilio SMS + Appointment Management + Email
 *
 * Run:  node server.js
 * Requires: npm install express twilio cors dotenv nodemailer pg
 */

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors({ origin: "*" }));

// — Config ————————————————————————————————————————
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE       = process.env.TWILIO_PHONE;
const DON_PHONE          = process.env.DON_PHONE || "+14436947625";
const APP_URL            = process.env.APP_URL   || "https://empowering-surprise-production-d934.up.railway.app";
const PORT               = process.env.PORT      || 3001;
const ADMIN_KEY          = process.env.ADMIN_KEY;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// — Database ————————————————————————————————————————
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  // Create tables if they don't exist
  pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      name TEXT, phone TEXT, salon TEXT, salon_address TEXT,
      shears TEXT, notes TEXT, date TEXT, time TEXT,
      status TEXT DEFAULT 'pending',
      submitted_at TIMESTAMPTZ DEFAULT NOW(),
      approved_at TIMESTAMPTZ,
      declined_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS blocked_slots (
      date TEXT, time TEXT, manually_blocked BOOLEAN DEFAULT false,
      PRIMARY KEY (date, time)
    );
  `).catch(err => console.error("DB setup error:", err));
}

// — Data helpers (file fallback if no DB) ————————————————
const DATA_FILE = path.join(__dirname, "appointments.json");

function loadData() {
  if (pool) return null; // using DB
  if (!fs.existsSync(DATA_FILE)) return { appointments: [], blockedSlots: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { appointments: [], blockedSlots: [] }; }
}

function saveData(data) {
  if (pool) return; // using DB
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// — Email helper ————————————————————————————————————————
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendBookingEmail(appt) {
  try {
    await resend.emails.send({
  from: 'onboarding@resend.dev',
  to: process.env.GMAIL_USER,
  reply_to: appt.clientEmail,
 text: `NEW APPOINTMENT REQUEST\n\nClient: ${appt.name}\nEmail: ${appt.clientEmail}\nPhone: ${appt.phone}\nSalon: ${appt.salon}\nAddress: ${appt.salonAddress}\nDate: ${appt.date}\nTime: ${appt.time}`,
  
    console.log("📧 Booking email sent.");
  } catch (err) {
    console.error("❌ Email failed:", err.message);
  }
}

// — SMS helper ————————————————————————————————————————
async function sendSMS(to, body) {
  try {
    const msg = await client.messages.create({
      body,
      from: TWILIO_PHONE,
      to: to.startsWith("+") ? to : `+1${to.replace(/\D/g, "")}`,
    });
    console.log(`✅ SMS sent to ${to}: ${msg.sid}`);
    return { success: true, sid: msg.sid };
  } catch (err) {
    console.error(`❌ SMS failed to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

// — Routes ————————————————————————————————————————————

// Health check
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// POST /appointments — Client submits a booking request
app.post("/appointments", async (req, res) => {
const { clientName: name, clientPhone: phone, salonName: salon, salonAddress, clientEmail, shearCount: shears, notes, date, time } = req.body;

  if (!name || !phone || !date || !time) {
    return res.status(400).json({ error: "Missing required fields: name, phone, date, time" });
  }

  const id = `APT-${Date.now()}`;

  // Check if slot is taken or blocked
  let slotTaken = false;
  let slotBlocked = false;

  if (pool) {
    const taken = await pool.query(
      "SELECT id FROM appointments WHERE date=$1 AND time=$2 AND status='approved'",
      [date, time]
    );
    const blocked = await pool.query(
      "SELECT date FROM blocked_slots WHERE date=$1 AND time=$2",
      [date, time]
    );
    slotTaken = taken.rows.length > 0;
    slotBlocked = blocked.rows.length > 0;
  } else {
    const data = loadData();
    slotTaken = data.appointments.some(a => a.date === date && a.time === time && a.status === "approved");
    slotBlocked = data.blockedSlots.some(s => s.date === date && s.time === time);
  }

  if (slotTaken || slotBlocked) {
    return res.status(409).json({ error: "This time slot is no longer available. Please choose another." });
  }

  const appointment = { id, name, phone, salon, salonAddress, shears: shears || "Not specified", notes: notes || "", date, time, status: "pending", submittedAt: new Date().toISOString() };

  if (pool) {
    await pool.query(
      "INSERT INTO appointments (id,name,phone,salon,salon_address,shears,notes,date,time,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [id, name, phone, salon, salonAddress, shears || "Not specified", notes || "", date, time, "pending"]
    );
  } else {
    const data = loadData();
    data.appointments.push(appointment);
    saveData(data);
  }

  const approveUrl = `${APP_URL}/appointments/${id}/approve`;
  const declineUrl = `${APP_URL}/appointments/${id}/decline`;

  // Email Don
  await sendBookingEmail({ ...appointment, approveUrl, declineUrl });

  // SMS Don
  const donMsg =
    `🔔 NEW APPOINTMENT REQUEST\n` +
    `——————————\n` +
    `Client: ${name}\n` +
    `Phone:  ${phone}\n` +
    `Salon:  ${salon || "Not given"}\n` +
    `Date:   ${date}\n` +
    `Time:   ${time} (ET)\n` +
    `Shears: ${shears || "Not specified"}\n` +
    `Notes:  ${notes || "None"}\n` +
    `——————————\n` +
    `✅ APPROVE: ${approveUrl}\n` +
    `❌ DECLINE: ${declineUrl}`;

  await sendSMS(DON_PHONE, donMsg);

  // SMS client
  const clientMsg =
    `Hi ${name}! Your shear sharpening request has been received.\n\n` +
    `📅 ${date} at ${time} (Eastern)\n` +
    `✂ $40.00 per shear\n\n` +
    `Don Nathan will confirm shortly. You'll receive another text with your confirmation.\n\n` +
    `Questions? Call/text Don: 443-694-7625\n` +
    `— Shear Sharpening by Don Nathan`;

  await sendSMS(phone, clientMsg);

  res.json({ success: true, id, message: "Appointment request submitted!" });
});

// GET /appointments/:id/approve
app.get("/appointments/:id/approve", async (req, res) => {
  let apt;
  if (pool) {
    const result = await pool.query("SELECT * FROM appointments WHERE id=$1", [req.params.id]);
    apt = result.rows[0];
  } else {
    const data = loadData();
    apt = data.appointments.find(a => a.id === req.params.id);
  }

  if (!apt) return res.status(404).send("Appointment not found.");
  if (apt.status !== "pending") return res.send(`Appointment already ${apt.status}.`);

  if (pool) {
    await pool.query("UPDATE appointments SET status='approved', approved_at=NOW() WHERE id=$1", [req.params.id]);
    await pool.query("INSERT INTO blocked_slots (date,time) VALUES ($1,$2) ON CONFLICT DO NOTHING", [apt.date, apt.time]);
  } else {
    const data = loadData();
    const a = data.appointments.find(a => a.id === req.params.id);
    a.status = "approved";
    a.approvedAt = new Date().toISOString();
    if (!data.blockedSlots.some(s => s.date === a.date && s.time === a.time)) {
      data.blockedSlots.push({ date: a.date, time: a.time });
    }
    saveData(data);
    apt = a;
  }

  const clientMsg =
    `CONFIRMED! Hi ${apt.name}, your shear sharpening appointment is confirmed!\n\n` +
    `📅 ${apt.date}\n` +
    `⏰ ${apt.time} (Eastern)\n` +
    `✂ $40.00 per shear\n\n` +
    `This appointment has been added to your phone's calendar as a reminder.\n\n` +
    `Thank you for choosing Shear Sharpening by Don Nathan!\n` +
    `Questions? 443-694-7625`;

  await sendSMS(apt.phone, clientMsg);
  await sendSMS(DON_PHONE, `✅ You approved ${apt.name}'s appointment.\n📅 ${apt.date} at ${apt.time}\n📱 ${apt.phone}`);

  res.send(`
    <html><body style="font-family:sans-serif;background:#000;color:#00e5cc;text-align:center;padding:40px">
    <h2>✅ Appointment Approved!</h2>
    <p><strong>${apt.name}</strong> – ${apt.date} at ${apt.time}</p>
    <p>Confirmation text sent to client.</p>
    <p style="color:#007a6e">Slot has been blocked for other clients.</p>
    </body></html>
  `);
});

// GET /appointments/:id/decline
app.get("/appointments/:id/decline", async (req, res) => {
  let apt;
  if (pool) {
    const result = await pool.query("SELECT * FROM appointments WHERE id=$1", [req.params.id]);
    apt = result.rows[0];
  } else {
    const data = loadData();
    apt = data.appointments.find(a => a.id === req.params.id);
  }

  if (!apt) return res.status(404).send("Appointment not found.");
  if (apt.status !== "pending") return res.send(`Appointment already ${apt.status}.`);

  if (pool) {
    await pool.query("UPDATE appointments SET status='declined', declined_at=NOW() WHERE id=$1", [req.params.id]);
  } else {
    const data = loadData();
    const a = data.appointments.find(a => a.id === req.params.id);
    a.status = "declined";
    a.declinedAt = new Date().toISOString();
    saveData(data);
    apt = a;
  }

  const clientMsg =
    `Hi ${apt.name}, we're sorry — that time is unavailable.\n\n` +
    `Please select a different date or time to book your shear sharpening appointment.\n\n` +
    `Need an alternative time? Call or text Don directly at 443-694-7625.\n` +
    `— Shear Sharpening by Don Nathan`;

  await sendSMS(apt.phone, clientMsg);

  res.send(`
    <html><body style="font-family:sans-serif;background:#000;color:#00e5cc;text-align:center;padding:40px">
    <h2>❌ Appointment Declined</h2>
    <p><strong>${apt.name}</strong> – ${apt.date} at ${apt.time}</p>
    <p>Client has been notified to choose another time.</p>
    </body></html>
  `);
});

// GET /appointments — Admin view
app.get("/appointments", (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  if (pool) {
    pool.query("SELECT * FROM appointments ORDER BY submitted_at DESC")
      .then(r => res.json(r.rows))
      .catch(err => res.status(500).json({ error: err.message }));
  } else {
    const data = loadData();
    res.json(data.appointments);
  }
});

// GET /blocked-slots
app.get("/blocked-slots", (req, res) => {
  if (pool) {
    pool.query("SELECT * FROM blocked_slots")
      .then(r => res.json(r.rows))
      .catch(err => res.status(500).json({ error: err.message }));
  } else {
    const data = loadData();
    res.json(data.blockedSlots);
  }
});

// POST /block-slot — Admin manually block a slot
app.post("/block-slot", (req, res) => {
  const { adminKey, date, time } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  if (pool) {
    pool.query("INSERT INTO blocked_slots (date,time,manually_blocked) VALUES ($1,$2,true) ON CONFLICT DO NOTHING", [date, time])
      .then(() => res.json({ success: true }))
      .catch(err => res.status(500).json({ error: err.message }));
  } else {
    const data = loadData();
    if (!data.blockedSlots.some(s => s.date === date && s.time === time)) {
      data.blockedSlots.push({ date, time, manuallyBlocked: true });
      saveData(data);
    }
    res.json({ success: true });
  }
});

// DELETE /block-slot — Admin unblock a slot
app.delete("/block-slot", (req, res) => {
  const { adminKey, date, time } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  if (pool) {
    pool.query("DELETE FROM blocked_slots WHERE date=$1 AND time=$2", [date, time])
      .then(() => res.json({ success: true }))
      .catch(err => res.status(500).json({ error: err.message }));
  } else {
    const data = loadData();
    data.blockedSlots = data.blockedSlots.filter(s => !(s.date === date && s.time === time));
    saveData(data);
    res.json({ success: true });
  }
});

// POST /twilio-webhook — Incoming SMS
app.post("/twilio-webhook", (req, res) => {
  const { From, Body } = req.body;
  console.log(`📱 Incoming SMS from ${From}: ${Body}`);
  sendSMS(DON_PHONE, `📱 SMS from ${From}:\n"${Body}"`);
  const twiml = new twilio.twiml.MessagingResponse();
  res.type("text/xml").send(twiml.toString());
});

// — Start ————————————————————————————————————————————
app.listen(PORT, () => {
  console.log(`✂ Shear Sharpening backend running on port ${PORT}`);
  console.log(`📱 Don's phone: ${DON_PHONE}`);
  console.log(`🌐 App URL: ${APP_URL}`);
});