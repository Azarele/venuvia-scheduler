const START_HOUR = 8;
const END_HOUR = 20;
const HOUR_PX = 60;

const sessionId = crypto.randomUUID();
const state = { date: null, today: null, preview: null, info: null, lastChanged: false };

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const input = $("input");
const sendBtn = $("send");

// ---------- API ----------

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, ...body }) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.text) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- Chat ----------

function addMessage(role, text, { proposal, meta, done } = {}) {
  const el = document.createElement("div");
  el.className = `msg ${role}${done ? " done" : ""}`;
  el.textContent = text;
  if (proposal) {
    const options = document.createElement("div");
    options.className = "options";
    options.dataset.proposalId = proposal.id;
    for (const option of proposal.options) {
      const btn = document.createElement("button");
      btn.className = option.tone;
      btn.textContent = option.label;
      btn.addEventListener("click", () => choose(proposal.id, option, btn));
      options.append(btn);
    }
    el.append(options);
  }
  if (meta) {
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = meta;
    el.append(m);
  }
  messagesEl.append(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function closeOpenProposals(chosenBtn) {
  for (const btn of messagesEl.querySelectorAll(".options button:not(:disabled)")) {
    btn.disabled = true;
    if (btn === chosenBtn) btn.classList.add("chosen");
  }
}

async function handleReply(promise) {
  setBusy(true);
  const typing = addMessage("assistant", "Thinking…");
  typing.classList.add("typing");
  try {
    const reply = await promise;
    typing.remove();
    const meta = reply.interpreter ? `interpreted by ${reply.interpreter}` : undefined;
    addMessage("assistant", reply.text, { proposal: reply.proposal, meta, done: reply.changed });
    state.preview = reply.proposal?.preview ?? null;
    state.lastChanged = Boolean(reply.changed);
    if (reply.focusDate) state.date = reply.focusDate;
    await renderSchedule();
  } catch (error) {
    typing.remove();
    addMessage("assistant", `Sorry, I couldn't reach the server (${error.message}). Nothing was changed.`);
  } finally {
    setBusy(false);
    input.focus();
  }
}

function send(text) {
  if (!text.trim()) return;
  closeOpenProposals();
  addMessage("user", text);
  input.value = "";
  return handleReply(api("/api/chat", { message: text }));
}

function choose(proposalId, option, btn) {
  closeOpenProposals(btn);
  addMessage("user", option.label);
  return handleReply(api("/api/confirm", { proposalId, optionId: option.id }));
}

function setBusy(busy) {
  sendBtn.disabled = busy;
  input.disabled = busy;
}

// ---------- Schedule ----------

const minutesOfDay = (iso) => {
  const [h, m] = iso.slice(11, 16).split(":").map(Number);
  return h * 60 + m;
};
const hhmm = (iso) => iso.slice(11, 16);

function place(el, startIso, endIso) {
  const dayStart = START_HOUR * 60;
  // Items that cross midnight or start before the visible range are clipped to it.
  const start = startIso.slice(0, 10) < state.date ? 0 : minutesOfDay(startIso);
  const end = endIso.slice(0, 10) > state.date ? 24 * 60 : minutesOfDay(endIso);
  const top = Math.max(start - dayStart, 0);
  const bottom = Math.min(end - dayStart, (END_HOUR - START_HOUR) * 60);
  el.style.top = `${(top / 60) * HOUR_PX}px`;
  el.style.height = `${Math.max(((bottom - top) / 60) * HOUR_PX - 2, 18)}px`;
  return bottom > top || bottom === top;
}

async function renderSchedule() {
  const day = await api(`/api/schedule?date=${state.date}`);
  const date = new Date(`${state.date}T12:00:00`);
  const diff = Math.round((date - new Date(`${state.today}T12:00:00`)) / 86400000);
  $("date-label").textContent = date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  $("date-sub").textContent = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : state.date;

  const tl = $("timeline");
  tl.innerHTML = "";
  tl.style.height = `${(END_HOUR - START_HOUR) * HOUR_PX}px`;
  const { openTime, closeTime } = state.info.business;
  for (const [from, to] of [[`${START_HOUR}:00`, openTime], [closeTime, `${END_HOUR}:00`]]) {
    const closed = document.createElement("div");
    closed.className = "closed";
    const toMin = (t) => t.split(":").map(Number).reduce((h, m) => h * 60 + m);
    closed.style.top = `${((toMin(from) - START_HOUR * 60) / 60) * HOUR_PX}px`;
    closed.style.height = `${((toMin(to) - toMin(from)) / 60) * HOUR_PX}px`;
    tl.append(closed);
  }
  for (let h = START_HOUR; h <= END_HOUR; h++) {
    const line = document.createElement("div");
    line.className = "hour";
    line.style.top = `${(h - START_HOUR) * HOUR_PX}px`;
    line.innerHTML = `<span>${String(h).padStart(2, "0")}:00</span>`;
    tl.append(line);
  }

  const items = [
    ...day.blocks.map((b) => ({ kind: "block", startAt: b.startAt, endAt: b.endAt, title: `Blocked${b.reason ? ` · ${b.reason}` : ""}`, id: b.id })),
    ...day.appointments.map((a) => ({ kind: "appt", startAt: a.startAt, endAt: a.endAt, title: `${a.clientName} · ${a.serviceName}`, id: a.id })),
  ];
  const p = state.preview;
  if (p && (p.startAt.slice(0, 10) === state.date || p.endAt.slice(0, 10) === state.date))
    items.push({ kind: "preview", startAt: p.startAt, endAt: p.endAt, title: "Proposed change", id: "preview" });

  for (const item of items) {
    const el = document.createElement("div");
    el.className = `item ${item.kind}${state.lastChanged && item.kind !== "preview" ? " flash" : ""}`;
    el.title = `${item.title} (${item.id})`;
    el.innerHTML = `<div class="time"></div><div class="title"></div>`;
    el.querySelector(".time").textContent = `${hhmm(item.startAt)}–${hhmm(item.endAt)}`;
    el.querySelector(".title").textContent = item.title;
    if (minutesOfDay(item.endAt) - minutesOfDay(item.startAt) <= 30) el.classList.add("short");
    if (place(el, item.startAt, item.endAt)) tl.append(el);
  }
  state.lastChanged = false;

  if (state.date === state.today) {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    if (mins >= START_HOUR * 60 && mins <= END_HOUR * 60) {
      const line = document.createElement("div");
      line.className = "now-line";
      line.style.top = `${((mins - START_HOUR * 60) / 60) * HOUR_PX}px`;
      tl.append(line);
    }
  }
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing booked or blocked.";
    tl.prepend(empty);
  }
}

function shiftDate(days) {
  const d = new Date(`${state.date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  state.date = d.toISOString().slice(0, 10);
  renderSchedule();
}

// ---------- Init ----------

async function init() {
  state.info = await api("/api/info");
  state.today = state.info.today;
  shiftTo(1); // the seeded demo data is for tomorrow
  const mode = $("mode");
  if (state.info.interpreter === "mock") {
    mode.textContent = "Mock AI (rule-based)";
    mode.classList.add("mock");
    mode.title = "Set ANTHROPIC_API_KEY to use Claude";
  } else {
    mode.textContent = `Claude · ${state.info.model}`;
  }
  addMessage(
    "assistant",
    `Hi! I'm your scheduling assistant for ${state.info.business.name}. Tell me what you'd like to do — block time, reschedule or cancel an appointment, or see your schedule. I'll always check with you before changing anything.`,
  );
  await renderSchedule();
  input.focus();
}

function shiftTo(daysFromToday) {
  state.date = state.today;
  const d = new Date(`${state.today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  state.date = d.toISOString().slice(0, 10);
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});
$("suggestions").addEventListener("click", (e) => {
  if (e.target.tagName === "BUTTON" && !sendBtn.disabled) send(e.target.textContent);
});
$("prev").addEventListener("click", () => shiftDate(-1));
$("next").addEventListener("click", () => shiftDate(1));
$("today").addEventListener("click", () => { state.date = state.today; renderSchedule(); });
$("reset").addEventListener("click", async () => {
  if (!confirm("Restore the original demo data? All changes will be lost.")) return;
  await api("/api/reset", {});
  messagesEl.innerHTML = "";
  state.preview = null;
  await init();
});

init().catch((error) => addMessage("assistant", `Couldn't load the app: ${error.message}`));
