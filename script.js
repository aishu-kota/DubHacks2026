const KEY = "safely-vanilla-v1";
const TEXTBEE = "https://api.textbee.dev/api/v1";

const INTERVALS = [
  { sec: 20, label: "20 seconds", hint: "Demo" },
  { sec: 60, label: "1 minute" },
  { sec: 300, label: "5 minutes" },
  { sec: 900, label: "15 minutes" },
  { sec: 1800, label: "30 minutes" },
  { sec: 3600, label: "1 hour" },
  { sec: 7200, label: "2 hours" },
];

const GRACES = [
  { sec: 20, label: "20 seconds", hint: "Demo" },
  { sec: 60, label: "1 minute" },
  { sec: 120, label: "2 minutes" },
  { sec: 300, label: "5 minutes" },
  { sec: 600, label: "10 minutes" },
];

const state = load();
let now = Date.now();
let flow = null;
let pinError = null;
let pinBusy = false;
let note = null;
let contactsOpen = false;
let soundOn = state.sound !== false;
let geoWatch = null;
let wakeLock = null;
let graceNotifiedFor = null;
let soonFor = null;
let alertLockFor = null;
let pinDigits = "";
let pinDraft = "";
let pinStep = "enter";
let shake = false;
let noteTimer = null;
let textbeeStatus = "idle";
let textbeeError = "";
let polling = false;

const $app = document.getElementById("app");

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      displayName: parsed.displayName || "",
      pin: parsed.pin || null,
      pinFails: parsed.pinFails || 0,
      pinLockUntil: parsed.pinLockUntil || 0,
      contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [],
      intervalSec: Number(parsed.intervalSec) || 20,
      graceSec: Number(parsed.graceSec) || 20,
      sound: parsed.sound !== false,
      session: parsed.session || null,
      location: parsed.location || null,
      locationStatus: parsed.locationStatus || "idle",
      textbeeKey: parsed.textbeeKey || "",
    };
  } catch {
    return blank();
  }
}

function blank() {
  return {
    displayName: "",
    pin: null,
    pinFails: 0,
    pinLockUntil: 0,
    contacts: [],
    intervalSec: 20,
    graceSec: 20,
    sound: true,
    session: null,
    location: null,
    locationStatus: "idle",
    textbeeKey: "",
  };
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

function clipName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").slice(0, 40);
}

function normalizePhone(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  let e164 = hasPlus ? `+${digits}` : digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

function formatPhone(e164) {
  const digits = e164.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  return e164;
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function mapsLink(point) {
  return `https://maps.google.com/?q=${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
}

function consentMessage(userName) {
  return `${userName} added you as an emergency contact on Safely. Do you consent to having your contact info here? Reply YES or NO.`;
}

function alertMessage(userName, when, point) {
  const where = point ? `Last location: ${mapsLink(point)}` : "Location was unavailable.";
  return `Safely alert: ${userName} missed a check-in at ${when}. ${where} Please try to reach them.`;
}

function allClearMessage(userName) {
  return `Safely update: ${userName} is safe and canceled the missed check-in alert. You can stand down.`;
}

function formatWhen() {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }).format(new Date());
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pinMatches(pin, salt, hash) {
  return (await hashPin(pin, salt)) === hash;
}

function isPinShape(value) {
  return /^\d{4,6}$/.test(value);
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function classifyReply(body) {
  const token = String(body || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (!token) return "other";
  if (["stop", "stopall", "unsubscribe", "cancel", "quit"].includes(token)) return "no";
  if (token.startsWith("yes") || ["y", "yeah", "yep", "yup", "ok", "okay", "confirm", "confirmed", "agree", "iagree"].includes(token)) return "yes";
  if (token.startsWith("no") || ["n", "nope", "nah", "decline", "declined"].includes(token)) return "no";
  return "other";
}

function live() {
  return Boolean(state.textbeeKey && textbeeStatus === "ok");
}

async function textbee(path, options = {}) {
  const response = await fetch(TEXTBEE + path, {
    ...options,
    headers: {
      "x-api-key": state.textbeeKey,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data.message || data.error || ("TextBee " + response.status);
    throw new Error(msg);
  }
  return data;
}

async function testTextbee() {
  if (!state.textbeeKey) {
    textbeeStatus = "idle";
    textbeeError = "";
    return;
  }
  textbeeStatus = "checking";
  textbeeError = "";
  render();
  try {
    await textbee("/gateway/stats");
    textbeeStatus = "ok";
    textbeeError = "";
    toast("TextBee connected. Texts will send from your phone.");
  } catch (err) {
    textbeeStatus = "error";
    textbeeError = err.message || "Couldn't reach TextBee.";
  }
  render();
}

async function sendSms(recipients, message) {
  if (!live() || !recipients.length) return null;
  return textbee("/gateway/send-sms", {
    method: "POST",
    body: JSON.stringify({ recipients, message }),
  });
}

async function pollReplies() {
  if (!live() || polling) return;
  const pending = state.contacts.filter((c) => c.consent === "pending");
  if (!pending.length) return;
  polling = true;
  try {
    const res = await textbee("/gateway/messages?direction=received&limit=30");
    const rows = Array.isArray(res.data) ? res.data : [];
    let changed = false;
    for (const contact of pending) {
      const since = contact.consentRequestedAt || 0;
      const match = rows.find((row) => {
        const sender = normalizePhone(row.sender || "") || row.sender;
        const at = Date.parse(row.receivedAt || row.createdAt || 0);
        return sender === contact.phone && (!since || !at || at >= since - 5000);
      });
      if (!match) continue;
      const verdict = classifyReply(match.message || "");
      if (verdict === "yes" || verdict === "no") {
        contact.consent = verdict;
        changed = true;
      }
    }
    if (changed) save();
  } catch {
    /* keep waiting */
  } finally {
    polling = false;
  }
}

function toast(text) {
  note = text;
  render();
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    note = null;
    render();
  }, 4200);
}

function consented(contacts) {
  return contacts.filter((c) => c.consent === "yes");
}

function mark(svg) {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>`;
}

const ICONS = {
  shield: mark('<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  volume: mark('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 7a7 7 0 0 1 0 10"/>'),
  mute: mark('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>'),
  del: mark('<path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><path d="m18 9-6 6"/><path d="m12 9 6 6"/>'),
};

function render() {
  const name = clipName(state.displayName);
  const isLive = live();
  const recipients = consented(state.contacts);
  const lockSeconds = Math.max(0, Math.ceil((state.pinLockUntil - now) / 1000));
  const canStart = Boolean(name && state.pin && state.contacts.length);

  document.title = titleFor(state.session, now);

  $app.innerHTML = `
    <div class="app">
      <header class="header">
        <div class="brand">${ICONS.shield}<span>Safely</span></div>
        <div class="header-actions">
          <button class="icon-btn" id="sound-btn" aria-label="${soundOn ? "Turn chime off" : "Turn chime on"}">${soundOn ? ICONS.volume : ICONS.mute}</button>
          <span class="pill"><span class="dot ${isLive ? "live" : ""}"></span>${isLive ? "TextBee" : textbeeStatus === "checking" ? "Checking" : "Rehearsal"}</span>
        </div>
      </header>
      <main class="main">
        ${state.session ? sessionView(state.session, name || "there", recipients, isLive) : homeView(canStart, isLive)}
        <footer class="footer-note">
          <p><strong>Safely doesn't call emergency services.</strong> If you are in immediate danger, contact local emergency services when you can. Silence is not proof someone is hurt.</p>
          <p class="faint" style="margin-top:12px">Safely · DubHacks · pure HTML / CSS / JS</p>
        </footer>
      </main>
      ${flow ? pinModal(lockSeconds) : ""}
      ${contactsOpen ? contactsModal(isLive) : ""}
      ${note ? `<p class="toast" role="status">${esc(note)}</p>` : ""}
    </div>
  `;
  bind();
}

function titleFor(session, clock) {
  if (!session) return "Safely";
  if (session.phase === "active" || session.phase === "grace") {
    const deadline = session.phase === "grace" ? session.graceDeadline || clock : session.checkInDeadline;
    const label = session.phase === "grace" ? "to check in" : "left";
    return `${formatRemaining(deadline - clock)} ${label} · Safely`;
  }
  return "Safely";
}

function homeView(canStart, isLive) {
  const consentedCount = consented(state.contacts).length;
  let blocker = "";
  if (!clipName(state.displayName)) blocker = "Add your name to start.";
  else if (!state.pin) blocker = "Create a PIN so a stolen phone can't cancel this.";
  else if (!state.contacts.length) blocker = "Add at least one contact.";
  else if (!consentedCount) blocker = isLive
    ? "You can start, but texts wait until someone replies YES."
    : "Record a YES on a contact if you want the rehearsal alert to name someone.";

  return `
    <section class="hero">
      <p class="eyebrow">A little peace of mind</p>
      <h1>Check in.<span>Or we reach out.</span></h1>
      <p>Set a timer. Confirm it's you with a PIN. If you don't, Safely texts the people who agreed to be your emergency contacts — and shares where you are.</p>
    </section>
    <div class="grid-2">
      <section class="card">
        <p class="eyebrow">Your check-in</p>
        <h2>Set the clock</h2>
        <form id="setup" class="stack">
          <label for="display-name">What should we call you?</label>
          <input id="display-name" class="field" maxlength="40" value="${esc(state.displayName)}" placeholder="Alex" autocomplete="nickname">
          <div class="pin-row">
            <div>
              <p>PIN</p>
              <p>${state.pin ? "Saved on this device" : "4 to 6 digits, not stored in plain text"}</p>
            </div>
            <button type="button" class="btn secondary small" id="pin-btn">${state.pin ? "Change" : "Create"}</button>
          </div>
          <label for="interval">Check in every</label>
          <select id="interval" class="field">${INTERVALS.map((item) => `<option value="${item.sec}" ${item.sec === state.intervalSec ? "selected" : ""}>${item.label}${item.hint ? ` — ${item.hint}` : ""}</option>`).join("")}</select>
          <label for="grace">Then wait this long before texting contacts</label>
          <select id="grace" class="field">${GRACES.map((item) => `<option value="${item.sec}" ${item.sec === state.graceSec ? "selected" : ""}>${item.label}${item.hint ? ` — ${item.hint}` : ""}</option>`).join("")}</select>
          <p class="hint">Use the demo lengths to walk the whole flow in under a minute.</p>
          <button class="btn primary full" type="submit" ${canStart ? "" : "disabled"}>Start check-in</button>
          ${blocker ? `<p class="hint">${esc(blocker)}</p>` : ""}
        </form>
      </section>
      <section class="card">
        <p class="eyebrow">Your circle</p>
        <h2>People who can be texted</h2>
        <p class="hint" style="margin:8px 0 12px">${isLive
          ? "Adding someone texts them an ask from your TextBee phone. Safely only alerts numbers that reply YES."
          : "Paste a TextBee API key below to send real texts from your Android phone. Or record YES / NO yourself in rehearsal."}</p>
        ${textbeeCard()}
        ${contactsForm()}
        ${contactList()}
        <details style="margin-top:16px">
          <summary>How TextBee works</summary>
          <p class="hint">Create a free account at textbee.dev, install the Android app on a phone with a SIM, and create an API key. Paste it here. It stays in this browser only — don't publish a page that has a key saved. Turn on Receive SMS in the TextBee app so YES / NO replies come back.</p>
        </details>
      </section>
    </div>
    <section class="steps">
      <article class="step"><p class="eyebrow">01</p><h3>Set a timer</h3><p>Choose how long you have, and how long Safely waits before texting anyone.</p></article>
      <article class="step"><p class="eyebrow">02</p><h3>Confirm it's you</h3><p>A PIN stops someone who has your phone from clearing the timer.</p></article>
      <article class="step"><p class="eyebrow">03</p><h3>Or we reach out</h3><p>Miss both windows and consented contacts get a text with your last location.</p></article>
    </section>
  `;
}


function textbeeCard() {
  const masked = state.textbeeKey ? state.textbeeKey.slice(0, 4) + "…" + state.textbeeKey.slice(-4) : "";
  return `
    <form id="textbee-form" class="stack-tight" style="margin-bottom:14px">
      <label for="textbee-key">TextBee API key</label>
      <input id="textbee-key" class="field" type="password" autocomplete="off" placeholder="${state.textbeeKey ? "Saved (" + masked + ")" : "Paste key from the TextBee dashboard"}">
      <div class="row">
        <button class="btn secondary" type="submit">${state.textbeeKey ? "Update key" : "Connect"}</button>
        ${state.textbeeKey ? `<button class="btn quiet" type="button" id="clear-key">Disconnect</button>` : ""}
      </div>
      <p class="faint">${textbeeStatus === "ok" ? "Connected. Texts send from your registered phone." : textbeeStatus === "error" ? esc(textbeeError) : "Key is stored in this browser only."}</p>
    </form>
  `;
}

function contactsForm() {
  return `
    <form id="add-contact" class="stack-tight">
      <label for="contact-name">Name</label>
      <input id="contact-name" class="field" maxlength="70" placeholder="Maya Chen" autocomplete="off">
      <label for="contact-phone">Mobile number</label>
      <input id="contact-phone" class="field" inputmode="tel" placeholder="+1 206 555 0100" autocomplete="off">
      <button class="btn primary" type="submit">Add and ask</button>
      <p class="faint" id="contact-error"></p>
    </form>
  `;
}

function contactList() {
  if (!state.contacts.length) return `<p class="hint" style="margin-top:12px">No one in your circle yet.</p>`;
  return state.contacts.map((c) => `
    <div class="contact">
      <div>
        <h3>${esc(c.name)}</h3>
        <p class="hint">${esc(formatPhone(c.phone))}</p>
        <span class="badge ${c.consent}">${c.consent === "yes" ? "Consented" : c.consent === "no" ? "Declined" : c.consent === "pending" ? "Waiting" : "Not asked"}</span>
      </div>
      <div class="contact-actions">
        ${c.consent === "pending" || c.consent === "unsent" ? `<button class="btn secondary small" data-yes="${c.id}">YES</button><button class="btn secondary small" data-no="${c.id}">NO</button>` : ""}
        <button class="btn quiet small" data-del="${c.id}">Remove</button>
      </div>
    </div>
    ${c.consent === "pending" ? `<div class="msg">${esc(consentMessage(clipName(state.displayName) || "Someone"))}</div>` : ""}
  `).join("");
}

function sessionView(session, name, recipients, isLive) {
  const deadline = session.phase === "grace" ? session.graceDeadline || now : session.checkInDeadline;
  const total = (session.phase === "grace" ? session.graceSec : session.intervalSec) * 1000;
  const remaining = deadline - now;
  const progress = Math.max(0, Math.min(1, remaining / total));
  const warn = session.phase === "grace";
  const phaseLabel = session.phase === "grace" ? "Check in now" : session.phase === "alerted" ? "Alert" : session.phase === "resolved" ? "You're safe" : session.phase === "sending" ? "Sending" : "Session active";
  const point = session.alert?.point || state.location;
  const message = session.phase === "resolved"
    ? allClearMessage(name)
    : session.phase === "alerted"
      ? alertMessage(name, session.alert?.when || formatWhen(), point)
      : "";

  return `
    <section class="card session">
      <div class="session-top">
        <div>
          <p class="eyebrow">${phaseLabel}</p>
          <h2>${session.phase === "resolved" ? "Glad you're safe" : session.phase === "alerted" ? "Contacts were notified" : `Hi, ${esc(name)}`}</h2>
        </div>
        <button class="btn quiet small" id="open-contacts">Circle</button>
      </div>
      ${session.phase === "active" || session.phase === "grace" ? ring(progress, warn, formatRemaining(remaining), warn ? "to check in" : "left") : ""}
      ${session.phase === "active" ? `<p class="hint" style="text-align:center;margin-top:8px">Keep this tab open. When the timer ends you'll get a check-in prompt.</p>` : ""}
      ${session.phase === "grace" ? `<div class="alert-box">Enter your PIN now. If you don't, ${recipients.length ? recipients.map((c) => esc(c.name)).join(", ") : "your consented contacts"} will be texted.</div>` : ""}
      ${session.phase === "alerted" ? `<div class="alert-box">${isLive
        ? (recipients.length ? `Texted ${recipients.map((c) => esc(c.name)).join(", ")}.` : "No consented contacts to text.")
        : (recipients.length ? `Rehearsal. Would text ${recipients.map((c) => esc(c.name)).join(", ")}.` : "No one has replied YES yet.")}</div>` : ""}
      ${message ? `<div class="msg">${esc(message)}</div>` : ""}
      ${session.phase === "resolved" ? `<div class="ok-box">${isLive ? "All-clear texted to consented contacts." : "All-clear ready. In rehearsal, nothing was texted."}</div>` : ""}
      <div class="actions">
        ${session.phase === "active" || session.phase === "grace" ? `<button class="btn primary full" id="check-in">I'm safe</button><button class="btn secondary full" id="end-session">End check-in</button>` : ""}
        ${session.phase === "alerted" ? `<button class="btn primary full" id="all-clear">I'm safe — send all-clear</button><button class="btn secondary full" id="dismiss">Close without update</button>` : ""}
        ${session.phase === "resolved" ? `<button class="btn primary full" id="done">Done</button>` : ""}
      </div>
    </section>
  `;
}

function ring(progress, warn, time, caption) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - progress);
  const color = warn ? "var(--amber)" : "var(--primary)";
  return `
    <div class="ring-wrap">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--line)" stroke-width="5"></circle>
        <circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset}"></circle>
      </svg>
      <div class="ring-center">
        <div class="timer">${time}</div>
        <p class="hint">${caption}</p>
      </div>
    </div>
  `;
}

function pinModal(lockSeconds) {
  const mode = flow.kind === "set" || (flow.kind === "change" && flow.step === "create") ? "set" : "verify";
  const choice = flow.kind === "checkin" && flow.step === "choice";
  const title = choice ? "It's you." : pinStep === "confirm" ? "Enter it again" : pinTitle(flow);
  const detail = choice ? "Restart the timer, or end the check-in. Ending now won't text anyone." : pinStep === "confirm" ? "Same PIN once more, so a typo doesn't lock you out later." : pinDetail(flow);
  const locked = lockSeconds > 0 && mode !== "set";
  return `
    <div class="modal-backdrop" id="pin-backdrop">
      <div class="modal ${shake ? "shake" : ""}" role="dialog" aria-modal="true" aria-labelledby="pin-title" tabindex="-1" id="pin-panel">
        <div class="modal-head">
          <div>
            <p class="eyebrow">PIN</p>
            <h2 id="pin-title">${esc(title)}</h2>
          </div>
          <button class="btn quiet" id="pin-close">Close</button>
        </div>
        <p class="hint">${esc(detail)}</p>
        ${choice ? `
          <div class="actions">
            <button class="btn primary full" id="restart">Restart timer</button>
            <button class="btn secondary full" id="end-from-pin">End check-in</button>
          </div>
        ` : `
          <div class="dots">${[0, 1, 2, 3, 4, 5].map((i) => `<span class="${i < pinDigits.length ? "on" : ""}"></span>`).join("")}</div>
          <p class="error">${locked ? `Too many tries. Wait ${lockSeconds}s.` : esc(pinError || "")}</p>
          <div class="pad">
            ${["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"].map((n) => n === "" ? `<span></span>` : `<button type="button" data-key="${n}" ${locked || pinBusy ? "disabled" : ""}>${n === "del" ? ICONS.del : n}</button>`).join("")}
          </div>
          <button class="btn primary full" id="pin-submit" style="margin-top:12px" ${locked || pinBusy ? "disabled" : ""}>${mode === "set" && pinStep === "enter" ? "Continue" : "Confirm"}</button>
        `}
      </div>
    </div>
  `;
}

function pinTitle(f) {
  if (f.kind === "set") return "Create your PIN";
  if (f.kind === "change") return f.step === "verify" ? "Enter your current PIN" : "Choose a new PIN";
  if (f.kind === "all-clear") return "Confirm it's you";
  if (f.kind === "end" || f.kind === "dismiss") return "Confirm it's you";
  return "Enter your PIN";
}

function pinDetail(f) {
  if (f.kind === "set") return "4 to 6 digits. Stored hashed on this device.";
  if (f.kind === "all-clear") return "This sends the all-clear to contacts who agreed.";
  if (f.kind === "end") return "Ending now won't text anyone.";
  return "This confirms it's you, not someone who has your phone.";
}

function contactsModal() {
  return `
    <div class="modal-backdrop" id="contacts-backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <p class="eyebrow">Your circle</p>
            <h2>Trusted contacts</h2>
          </div>
          <button class="btn quiet" id="contacts-close">Close</button>
        </div>
        ${contactsForm()}
        ${contactList()}
      </div>
    </div>
  `;
}

function bind() {
  document.getElementById("textbee-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = document.getElementById("textbee-key").value.trim();
    if (!value && !state.textbeeKey) return;
    if (value) state.textbeeKey = value;
    save();
    await testTextbee();
  });
  document.getElementById("clear-key")?.addEventListener("click", () => {
    state.textbeeKey = "";
    textbeeStatus = "idle";
    textbeeError = "";
    save();
    toast("TextBee disconnected. Rehearsal mode.");
  });

  document.getElementById("sound-btn")?.addEventListener("click", () => {
    soundOn = !soundOn;
    state.sound = soundOn;
    save();
    render();
  });

  const setup = document.getElementById("setup");
  setup?.addEventListener("submit", (e) => {
    e.preventDefault();
    start();
  });
  document.getElementById("display-name")?.addEventListener("input", (e) => {
    state.displayName = e.target.value;
    save();
  });
  document.getElementById("interval")?.addEventListener("change", (e) => {
    state.intervalSec = Number(e.target.value);
    save();
    render();
  });
  document.getElementById("grace")?.addEventListener("change", (e) => {
    state.graceSec = Number(e.target.value);
    save();
    render();
  });
  document.getElementById("pin-btn")?.addEventListener("click", () => openFlow(state.pin ? { kind: "change", step: "verify" } : { kind: "set" }));
  document.getElementById("check-in")?.addEventListener("click", () => openFlow({ kind: "checkin", step: "verify" }));
  document.getElementById("end-session")?.addEventListener("click", () => openFlow({ kind: "end" }));
  document.getElementById("all-clear")?.addEventListener("click", () => openFlow({ kind: "all-clear" }));
  document.getElementById("dismiss")?.addEventListener("click", () => openFlow({ kind: "dismiss" }));
  document.getElementById("done")?.addEventListener("click", () => {
    state.session = null;
    save();
    document.title = "Safely";
    render();
  });
  document.getElementById("open-contacts")?.addEventListener("click", () => {
    contactsOpen = true;
    render();
  });
  document.getElementById("contacts-close")?.addEventListener("click", () => {
    contactsOpen = false;
    render();
  });
  document.getElementById("contacts-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "contacts-backdrop") {
      contactsOpen = false;
      render();
    }
  });

  document.getElementById("add-contact")?.addEventListener("submit", onAddContact);
  document.querySelectorAll("[data-yes]").forEach((btn) => btn.addEventListener("click", () => setConsent(btn.dataset.yes, "yes")));
  document.querySelectorAll("[data-no]").forEach((btn) => btn.addEventListener("click", () => setConsent(btn.dataset.no, "no")));
  document.querySelectorAll("[data-del]").forEach((btn) => btn.addEventListener("click", () => {
    state.contacts = state.contacts.filter((c) => c.id !== btn.dataset.del);
    save();
    render();
  }));

  document.getElementById("pin-close")?.addEventListener("click", closeFlow);
  document.getElementById("pin-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "pin-backdrop" && !pinBusy) closeFlow();
  });
  document.querySelectorAll("[data-key]").forEach((btn) => btn.addEventListener("click", () => {
    const key = btn.dataset.key;
    if (key === "del") pinDigits = pinDigits.slice(0, -1);
    else pushDigit(key);
    pinError = null;
    render();
    document.getElementById("pin-panel")?.focus();
  }));
  document.getElementById("pin-submit")?.addEventListener("click", () => submitPin(pinDigits));
  document.getElementById("restart")?.addEventListener("click", () => {
    restartTimer();
    closeFlow();
    toast("Timer restarted.");
  });
  document.getElementById("end-from-pin")?.addEventListener("click", () => {
    state.session = null;
    save();
    closeFlow();
    toast("Check-in ended. Nobody was texted.");
  });
  document.getElementById("pin-panel")?.focus();
}

function openFlow(next) {
  flow = next;
  pinError = null;
  pinDigits = "";
  pinDraft = "";
  pinStep = "enter";
  render();
}

function closeFlow() {
  if (pinBusy) return;
  flow = null;
  pinDigits = "";
  pinError = null;
  render();
}

function pushDigit(n) {
  if (pinDigits.length >= 6) return;
  pinDigits += n;
  if (pinDigits.length === 6) setTimeout(() => submitPin(pinDigits), 40);
}

async function onAddContact(event) {
  event.preventDefault();
  const name = clipName(document.getElementById("contact-name").value);
  const phone = normalizePhone(document.getElementById("contact-phone").value);
  const err = document.getElementById("contact-error");
  if (!name) return setErr(err, "Add their name.");
  if (!phone) return setErr(err, "Use a real mobile number, with country code if it's outside the US.");
  if (state.contacts.some((c) => c.phone === phone)) return setErr(err, "That number is already in your circle.");
  if (state.contacts.length >= 5) return setErr(err, "Safely texts up to five people.");
  const contact = {
    id: crypto.randomUUID(),
    name,
    phone,
    consent: "pending",
    consentRequestedAt: Date.now(),
  };
  state.contacts.push(contact);
  save();
  if (live()) {
    try {
      await sendSms([phone], consentMessage(clipName(state.displayName) || "Someone"));
      toast("Consent text sent. Waiting for YES or NO.");
    } catch (err) {
      contact.consent = "unsent";
      save();
      toast(err.message || "Couldn't send the ask.");
    }
  } else {
    toast("Consent ask ready. Record YES or NO.");
  }
  render();
}

function setErr(node, text) {
  if (node) node.textContent = text;
}

function setConsent(id, value) {
  const c = state.contacts.find((item) => item.id === id);
  if (!c) return;
  c.consent = value;
  save();
  toast(value === "yes" ? `${c.name} consented.` : `${c.name} declined.`);
  render();
}

async function start() {
  if (!clipName(state.displayName) || !state.pin || !state.contacts.length) return;
  if ("Notification" in window && Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { /* ignore */ }
  }
  graceNotifiedFor = null;
  soonFor = null;
  alertLockFor = null;
  const clock = Date.now();
  state.session = {
    phase: "active",
    intervalSec: state.intervalSec,
    graceSec: state.graceSec,
    checkInDeadline: clock + state.intervalSec * 1000,
    graceDeadline: null,
    alert: null,
  };
  save();
  watchLocation(true);
  requestWake();
  render();
}

function restartTimer() {
  if (!state.session) return;
  const clock = Date.now();
  state.session = {
    ...state.session,
    phase: "active",
    checkInDeadline: clock + state.session.intervalSec * 1000,
    graceDeadline: null,
    alert: null,
  };
  graceNotifiedFor = null;
  soonFor = null;
  alertLockFor = null;
  save();
  render();
}

async function submitPin(value) {
  if (pinBusy) return;
  const mode = flow?.kind === "set" || (flow?.kind === "change" && flow.step === "create") ? "set" : "verify";
  if (state.pinLockUntil > Date.now() && mode !== "set") {
    pinError = "Too many tries. Wait a moment.";
    render();
    return;
  }
  if (!isPinShape(value)) {
    pinError = "Use 4 to 6 digits.";
    render();
    return;
  }
  if (mode === "set" && pinStep === "enter") {
    pinDraft = value;
    pinDigits = "";
    pinStep = "confirm";
    pinError = null;
    render();
    return;
  }
  if (mode === "set" && value !== pinDraft) {
    pinError = "Those PINs don't match. Start again.";
    pinDraft = "";
    pinDigits = "";
    pinStep = "enter";
    shake = true;
    render();
    setTimeout(() => { shake = false; render(); }, 280);
    return;
  }
  if (mode === "set") {
    const salt = randomSalt();
    const hash = await hashPin(value, salt);
    state.pin = { salt, hash };
    state.pinFails = 0;
    state.pinLockUntil = 0;
    save();
    const wasChange = flow?.kind === "change";
    closeFlow();
    toast(wasChange ? "PIN updated." : "PIN saved on this device.");
    return;
  }
  const ok = await pinMatches(value, state.pin.salt, state.pin.hash);
  if (!ok) {
    state.pinFails += 1;
    if (state.pinFails >= 5) {
      state.pinLockUntil = Date.now() + 30_000;
      state.pinFails = 0;
    }
    save();
    pinError = "That PIN doesn't match.";
    pinDigits = "";
    shake = true;
    render();
    setTimeout(() => { shake = false; render(); }, 280);
    return;
  }
  state.pinFails = 0;
  state.pinLockUntil = 0;
  save();
  if (flow.kind === "change") {
    flow = { kind: "change", step: "create" };
    pinDigits = "";
    pinStep = "enter";
    pinError = null;
    render();
    return;
  }
  if (flow.kind === "checkin") {
    flow = { kind: "checkin", step: "choice" };
    pinDigits = "";
    render();
    return;
  }
  if (flow.kind === "end" || flow.kind === "dismiss") {
    state.session = null;
    save();
    closeFlow();
    toast(flow?.kind === "end" ? "Check-in ended. Nobody was texted." : "Closed without sending an update.");
    return;
  }
  if (flow.kind === "all-clear") {
    const people = consented(state.contacts);
    state.session = { ...state.session, phase: "resolved", allClear: { at: Date.now(), count: people.length } };
    save();
    if (live() && people.length) {
      try {
        await sendSms(people.map((c) => c.phone), allClearMessage(clipName(state.displayName) || "Someone"));
        closeFlow();
        toast("All-clear texted.");
      } catch (err) {
        closeFlow();
        toast(err.message || "All-clear text failed.");
      }
    } else {
      closeFlow();
      toast(people.length ? "All-clear ready for consented contacts." : "Marked safe. No consented contacts to update.");
    }
  }
}

function tick() {
  now = Date.now();
  if (now % 8000 < 300) void pollReplies();
  const session = state.session;
  if (session && (session.phase === "active" || session.phase === "grace")) {
    const clock = now;
    if (session.phase === "active" && clock >= session.checkInDeadline) {
      const graceEnd = session.checkInDeadline + session.graceSec * 1000;
      if (clock >= graceEnd) fireAlert();
      else if (graceNotifiedFor !== session.checkInDeadline) {
        graceNotifiedFor = session.checkInDeadline;
        session.phase = "grace";
        session.graceDeadline = graceEnd;
        save();
        ping("Time to check in", "Enter your PIN on Safely. If you don't, your contacts will be texted.");
      }
    } else if (session.phase === "grace" && session.graceDeadline && clock >= session.graceDeadline) {
      fireAlert();
    } else if (session.phase === "grace" && session.graceDeadline && session.graceSec >= 45 && session.graceDeadline - clock <= 15_000 && soonFor !== session.graceDeadline) {
      soonFor = session.graceDeadline;
      ping("Contacts will be texted in a few seconds", "Enter your PIN now if you're safe.");
    }
  }
  if (state.session || flow) render();
}

function fireAlert() {
  const session = state.session;
  if (!session || alertLockFor === session.checkInDeadline) return;
  if (session.phase === "alerted" || session.phase === "resolved") return;
  alertLockFor = session.checkInDeadline;
  const people = consented(state.contacts);
  session.phase = "alerted";
  session.alert = {
    at: Date.now(),
    when: formatWhen(),
    point: state.location,
    count: people.length,
  };
  save();
  const msg = alertMessage(clipName(state.displayName) || "Someone", session.alert.when, state.location);
  if (live() && people.length) {
    sendSms(people.map((c) => c.phone), msg)
      .then(() => toast("Alert texted to consented contacts."))
      .catch((err) => toast(err.message || "Alert text failed."));
    ping("Alert sent", `Texted ${people.length} contact${people.length === 1 ? "" : "s"}.`);
  } else {
    ping("Alert ready", people.length ? `Would text ${people.length} consented contact${people.length === 1 ? "" : "s"}.` : "No consented contacts yet.");
  }
  render();
}

function ping(title, body) {
  if (soundOn) chime();
  if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification(title, { body }); } catch { /* ignore */ }
  }
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 660;
    g.gain.value = 0.04;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.18);
  } catch { /* ignore */ }
}

function watchLocation(on) {
  if (geoWatch != null) {
    navigator.geolocation?.clearWatch(geoWatch);
    geoWatch = null;
  }
  if (!on || !navigator.geolocation) {
    if (on) state.locationStatus = "unavailable";
    return;
  }
  geoWatch = navigator.geolocation.watchPosition(
    (pos) => {
      state.location = {
        lat: Math.round(pos.coords.latitude * 1e5) / 1e5,
        lng: Math.round(pos.coords.longitude * 1e5) / 1e5,
        accuracy: pos.coords.accuracy,
        at: pos.timestamp,
      };
      state.locationStatus = "ok";
      save();
    },
    (err) => {
      state.locationStatus = err.code === err.PERMISSION_DENIED ? "denied" : "unavailable";
      save();
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 12000 },
  );
}

async function requestWake() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch { /* ignore */ }
}

document.addEventListener("visibilitychange", () => {
  now = Date.now();
  if (document.visibilityState === "visible" && state.session && (state.session.phase === "active" || state.session.phase === "grace")) {
    requestWake();
    watchLocation(true);
  }
});

window.addEventListener("keydown", (event) => {
  if (!flow || (flow.kind === "checkin" && flow.step === "choice")) return;
  if (event.key >= "0" && event.key <= "9") {
    event.preventDefault();
    pushDigit(event.key);
    pinError = null;
    render();
  } else if (event.key === "Backspace") {
    event.preventDefault();
    pinDigits = pinDigits.slice(0, -1);
    render();
  } else if (event.key === "Enter") {
    event.preventDefault();
    submitPin(pinDigits);
  } else if (event.key === "Escape") {
    closeFlow();
  }
}, true);

if (state.session && (state.session.phase === "active" || state.session.phase === "grace")) {
  watchLocation(true);
  requestWake();
}

if (state.textbeeKey) void testTextbee();
else render();
setInterval(tick, 250);
