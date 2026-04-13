/**
 * Shear Sharpening by Don Nathan
 * Backend Server — Twilio SMS + Appointment Management
 * 
 * Run:  node server.js
 * Requires: npm install express twilio cors dotenv
 */

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

// ─── Config ───────────────────────────────────────────────────────────────────
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE       = process.env.TWILIO_PHONE;       // Your Twilio number e.g. +15551234567
const DON_PHONE          = process.env.DON_PHONE || "+14436947625";
const APP_URL            = process.env.APP_URL ||  "https://empowering-surprise-production-d934.up.railway.app"
const DATA_FILE          = path.join(__dirname, "appointments.json");
const PORT               = process.env.PORT || 3001;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── Data helpers ─────────────────────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { appointments: [], blockedSlots: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { appointments: [], blockedSlots: [] }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── SMS helper ───────────────────────────────────────────────────────────────
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

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
// ── POST /appointments — Client submits a booking request ────────────────────
app.post("/appointments", async (req, res) => {
 const { clientName: name, clientPhone: phone, salonName: salon, salonAddress, shearCount: shears, notes, date, time } = req.body;

  if (!name || !phone || !date || !time) {
    return res.status(400).json({ error: "Missing required fields: name, phone, date, time" });
  }

  const data = loadData();

  // Check if slot is already taken or blocked
  const slotTaken = data.appointments.some(
    (a) => a.date === date && a.time === time && a.status === "approved"
  );
  const slotBlocked = data.blockedSlots.some(
    (s) => s.date === date && s.time === time
  );
  if (slotTaken || slotBlocked) {
    return res.status(409).json({ error: "This time slot is no longer available. Please choose another." });
  }

  const id = `APT-${Date.now()}`;
  const appointment = {
    id, name, phone, salon, salonAddress,
    shears: shears || "Not specified",
    notes: notes || "",
    date, time,
    status: "pending",
    submittedAt: new Date().toISOString(),
  };

  data.appointments.push(appointment);
  saveData(data);

  // 1️⃣ Text Don Nathan with appointment details + approve/decline links
  const approveUrl = `${APP_URL}/appointments/${id}/approve`;
  const declineUrl = `${APP_URL}/appointments/${id}/decline`;

  const donMsg =
    `✂️ NEW APPOINTMENT REQUEST\n` +
    `───────────────────\n` +
    `Client: ${name}\n` +
    `Phone:  ${phone}\n` +
    `Salon:  ${salon || "Not given"}\n` +
    `Date:   ${date}\n` +
    `Time:   ${time} (ET)\n` +
    `Shears: ${shears || "Not specified"}\n` +
    `Notes:  ${notes || "None"}\n` +
    `───────────────────\n` +
    `✅ APPROVE: ${approveUrl}\n` +
    `❌ DECLINE: ${declineUrl}`;

  await sendSMS(DON_PHONE, donMsg);

  // 2️⃣ Text client to confirm receipt
  const clientMsg =
    `Hi ${name}! Your shear sharpening request has been received.\n\n` +
    `📅 ${date} at ${time} (Eastern)\n` +
    `💰 $40.00 per shear\n\n` +
    `Don Nathan will confirm shortly. You'll receive another text with your confirmation.\n\n` +
    `Questions? Call/text Don: 443-694-7625\n` +
    `— Shear Sharpening by Don Nathan`;

  await sendSMS(phone, clientMsg);

  res.json({ success: true, id, message: "Appointment request submitted. Texts sent!" });
});

// ── GET /appointments/:id/approve — Don taps link to approve ─────────────────
app.get("/appointments/:id/approve", async (req, res) => {
  const data = loadData();
  const apt = data.appointments.find((a) => a.id === req.params.id);

  if (!apt) return res.status(404).send("Appointment not found.");
  if (apt.status !== "pending") return res.send(`Appointment already ${apt.status}.`);

  apt.status = "approved";
  apt.approvedAt = new Date().toISOString();

  // Block the slot so no one else can book it
  data.blockedSlots.push({ date: apt.date, time: apt.time });
  saveData(data);

  // Text client — confirmed + calendar reminder
  const clientMsg =
    `✅ CONFIRMED! Hi ${apt.name}, your shear sharpening appointment is confirmed!\n\n` +
    `📅 ${apt.date}\n` +
    `🕐 ${apt.time} (Eastern)\n` +
    `💰 $40.00 per shear\n\n` +
    `📲 This appointment has been added to your phone's calendar as a reminder.\n\n` +
    `Thank you for choosing Shear Sharpening by Don Nathan!\n` +
    `Questions? 443-694-7625`;

  await sendSMS(apt.phone, clientMsg);

  // Text Don — confirmation receipt
  await sendSMS(DON_PHONE,
    `✅ You approved ${apt.name}'s appointment.\n📅 ${apt.date} at ${apt.time}\n📞 ${apt.phone}`
  );

  res.send(`
    <html><body style="font-family:sans-serif;background:#000;color:#00e5cc;text-align:center;padding:40px">
      <h2>✅ Appointment Approved!</h2>
      <p><strong>${apt.name}</strong> — ${apt.date} at ${apt.time}</p>
      <p>Confirmation text sent to ${apt.phone}</p>
      <p style="color:#007a6e">Slot has been blocked for other clients.</p>
    </body></html>
  `);
});

// ── GET /appointments/:id/decline — Don taps link to decline ─────────────────
app.get("/appointments/:id/decline", async (req, res) => {
  const data = loadData();
  const apt = data.appointments.find((a) => a.id === req.params.id);

  if (!apt) return res.status(404).send("Appointment not found.");
  if (apt.status !== "pending") return res.send(`Appointment already ${apt.status}.`);

  apt.status = "declined";
  apt.declinedAt = new Date().toISOString();
  saveData(data);

  // Text client — politely ask to rebook
  const clientMsg =
    `Hi ${apt.name}, we're sorry — that time is unavailable.\n\n` +
    `Please select a different date or time to book your shear sharpening appointment.\n\n` +
    `Need an alternative time? Call or text Don directly at 443-694-7625.\n\n` +
    `— Shear Sharpening by Don Nathan`;

  await sendSMS(apt.phone, clientMsg);

  res.send(`
    <html><body style="font-family:sans-serif;background:#000;color:#00e5cc;text-align:center;padding:40px">
      <h2>❌ Appointment Declined</h2>
      <p><strong>${apt.name}</strong> — ${apt.date} at ${apt.time}</p>
      <p>Client has been notified to choose another time.</p>
    </body></html>
  `);
});

// ── GET /appointments — Admin: view all appointments ─────────────────────────
app.get("/appointments", (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const data = loadData();
  res.json(data.appointments);
});

// ── GET /blocked-slots — Fetch blocked slots for the app ─────────────────────
app.get("/blocked-slots", (req, res) => {
  const data = loadData();
  res.json(data.blockedSlots);
});

// ── POST /block-slot — Admin: manually block a slot ──────────────────────────
app.post("/block-slot", (req, res) => {
  const { adminKey, date, time } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const data = loadData();
  if (!data.blockedSlots.some((s) => s.date === date && s.time === time)) {
    data.blockedSlots.push({ date, time, manuallyBlocked: true });
    saveData(data);
  }
  res.json({ success: true });
});

// ── DELETE /block-slot — Admin: unblock a slot ───────────────────────────────
app.delete("/block-slot", (req, res) => {
  const { adminKey, date, time } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const data = loadData();
  data.blockedSlots = data.blockedSlots.filter(
    (s) => !(s.date === date && s.time === time)
  );
  saveData(data);
  res.json({ success: true });
});

// ── POST /twilio-webhook — Incoming SMS from clients (optional) ──────────────
app.post("/twilio-webhook", (req, res) => {
  const { From, Body } = req.body;
  console.log(`📩 Incoming SMS from ${From}: ${Body}`);
  // Forward to Don
  sendSMS(DON_PHONE, `📩 SMS from ${From}:\n"${Body}"`);
  const twiml = new twilio.twiml.MessagingResponse();
  res.type("text/xml").send(twiml.toString());
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✂️  Shear Sharpening backend running on port ${PORT}`);
  console.log(`📱 Don's phone: ${DON_PHONE}`);
  console.log(`🌐 App URL: ${APP_URL}`);
});
