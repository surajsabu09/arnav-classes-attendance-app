/* Teacher Attendance PWA. Plain JS, no build step. */
(() => {
  const cfg = window.APP_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const app = document.getElementById("app");
  const $ = (sel, root = document) => root.querySelector(sel);

  let me = null;        // {id, full_name, role}
  let settings = null;
  let sessionEmail = null;
  // Opened from a password-reset email link? Must be read before anything clears the URL hash.
  const isRecovery = /type=recovery/.test(location.hash);

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const istDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d); // YYYY-MM-DD
  const fmtTime = (iso) => iso ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(iso)) : "-";
  const fmtDate = (ymd) => new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(ymd + "T00:00:00Z"));
  const fmtShort = (ymd) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(ymd + "T00:00:00Z"));
  const pill = (s) => `<span class="pill ${esc(s)}">${esc(String(s).replace("_", " "))}</span>`;
  const msg = (el, text, kind = "err") => { el.className = "msg " + kind; el.textContent = text; el.classList.remove("hidden"); };
  const cleanErr = (e) => (e && e.message ? e.message : String(e));

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("This device does not support location."));
      navigator.geolocation.getCurrentPosition(resolve, (err) => {
        const m = { 1: "Location permission denied. Allow location for this site in your browser settings.",
                    2: "Could not determine location. Try near a window or turn on precise location.",
                    3: "Location request timed out. Try again." }[err.code] || err.message;
        reject(new Error(m));
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  // ---------- auth ----------
  function renderLogin() {
    $("#logout").classList.add("hidden"); $("#who").textContent = "";
    app.innerHTML = `
      <div class="card">
        <h2>Sign in</h2>
        <form id="f">
          <label>Email</label><input name="email" type="email" autocomplete="username" required>
          <label>Password</label><input name="password" type="password" autocomplete="current-password" required>
          <div id="m" class="msg hidden"></div>
          <button class="big" style="margin-top:12px">Sign in</button>
        </form>
        <p class="mute"><a href="#" id="fp">Forgot password?</a> Type your email above, then tap this link. Accounts are created by the admin.</p>
      </div>`;
    $("#fp").onclick = async (e) => {
      e.preventDefault();
      const email = $("#f").email.value.trim();
      if (!email) return msg($("#m"), "Type your email in the box above first, then tap Forgot password.");
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) return msg($("#m"), error.message);
      msg($("#m"), "If that email has an account, a reset link is on its way. Check spam too. If nothing arrives, ask the admin to reset it.", "good");
    };
    $("#f").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const { error } = await sb.auth.signInWithPassword({ email: fd.get("email").trim(), password: fd.get("password") });
      if (error) return msg($("#m"), error.message);
      boot();
    };
  }

  $("#logout").onclick = async () => { await sb.auth.signOut(); me = null; renderLogin(); };

  async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return renderLogin();
    sessionEmail = session.user.email;
    if (isRecovery) return renderSetPassword();
    const { data: prof, error } = await sb.from("profiles").select("id, full_name, role, active").eq("id", session.user.id).single();
    if (error || !prof) { await sb.auth.signOut(); return renderLogin(); }
    if (!prof.active) { app.innerHTML = `<div class="card"><div class="msg err">Your account is deactivated. Contact the admin.</div></div>`; $("#logout").classList.remove("hidden"); return; }
    me = prof;
    const { data: st } = await sb.from("settings").select("*").eq("id", 1).single();
    settings = st;
    $("#title").textContent = cfg.INSTITUTE_NAME || "Teacher Attendance";
    $("#who").textContent = me.full_name;
    $("#logout").classList.remove("hidden");
    me.role === "admin" ? renderAdmin() : renderTeacher();
  }

  // ---------- passwords ----------
  const PW_MIN = 8;

  // Logged-in "change password" card (used on the teacher page and the admin Account tab).
  function pwCard() {
    return `<div class="card"><h2>Change password</h2>
      <form id="pf">
        <label>Current password</label><input name="cur" type="password" autocomplete="current-password" required>
        <label>New password (min ${PW_MIN} characters)</label><input name="p1" type="password" autocomplete="new-password" minlength="${PW_MIN}" required>
        <label>Confirm new password</label><input name="p2" type="password" autocomplete="new-password" minlength="${PW_MIN}" required>
        <div id="pm" class="msg hidden"></div>
        <button style="margin-top:12px">Update password</button>
      </form></div>`;
  }
  function bindPw() {
    const f = $("#pf"); if (!f) return;
    f.onsubmit = async (e) => {
      e.preventDefault();
      const m = $("#pm"), btn = f.querySelector("button");
      if (f.p1.value.length < PW_MIN) return msg(m, `New password must be at least ${PW_MIN} characters.`);
      if (f.p1.value !== f.p2.value) return msg(m, "The two new passwords do not match.");
      if (f.p1.value === f.cur.value) return msg(m, "New password must be different from the current one.");
      btn.disabled = true;
      try {
        // Re-check the current password so a stranger holding an unlocked phone cannot change it.
        const { error: e1 } = await sb.auth.signInWithPassword({ email: sessionEmail, password: f.cur.value });
        if (e1) throw new Error("Current password is incorrect.");
        const { error: e2 } = await sb.auth.updateUser({ password: f.p1.value });
        if (e2) throw e2;
        f.reset(); msg(m, "Password updated.", "good");
      } catch (err) { msg(m, cleanErr(err)); }
      btn.disabled = false;
    };
  }

  // Shown after the user taps the link in a password-reset email.
  function renderSetPassword() {
    $("#logout").classList.remove("hidden");
    app.innerHTML = `<div class="card"><h2>Set a new password</h2>
      <p class="mute">${esc(sessionEmail || "")}</p>
      <form id="sp">
        <label>New password (min ${PW_MIN} characters)</label><input name="p1" type="password" autocomplete="new-password" minlength="${PW_MIN}" required>
        <label>Confirm new password</label><input name="p2" type="password" autocomplete="new-password" minlength="${PW_MIN}" required>
        <div id="sm2" class="msg hidden"></div>
        <button class="big" style="margin-top:12px">Save password</button>
      </form></div>`;
    $("#sp").onsubmit = async (e) => {
      e.preventDefault(); const f = e.target, m = $("#sm2");
      if (f.p1.value.length < PW_MIN) return msg(m, `Password must be at least ${PW_MIN} characters.`);
      if (f.p1.value !== f.p2.value) return msg(m, "The two passwords do not match.");
      const { error } = await sb.auth.updateUser({ password: f.p1.value });
      if (error) return msg(m, cleanErr(error));
      msg(m, "Password saved. Opening the app...", "good");
      history.replaceState(null, "", location.pathname + location.search);
      setTimeout(() => location.reload(), 900);
    };
  }

  // ---------- teacher ----------
  async function renderTeacher() {
    app.innerHTML = `
      <div class="card" id="today"><h2>Today</h2><div id="todayBody" class="mute">Loading...</div></div>
      <div class="card"><h2>Apply for leave</h2>
        <form id="lf">
          <div class="row"><div><label>From</label><input type="date" name="from" required></div><div><label>To</label><input type="date" name="to" required></div></div>
          <label>Reason</label><textarea name="reason" rows="2" maxlength="300" required></textarea>
          <div id="lm" class="msg hidden"></div>
          <button style="margin-top:10px">Submit request</button>
        </form>
        <div id="myLeaves" style="margin-top:14px"></div>
      </div>
      <div class="card"><h2>Last 30 days</h2><div class="scroll" id="hist"></div></div>
      ${pwCard()}`;
    $("#lf").onsubmit = submitLeave;
    bindPw();
    await refreshTeacher();
  }

  async function refreshTeacher() {
    const today = istDate();
    const since = istDate(new Date(Date.now() - 30 * 864e5));
    const [{ data: rows }, { data: leaves }] = await Promise.all([
      sb.from("attendance").select("*").eq("teacher_id", me.id).gte("work_date", since).order("work_date", { ascending: false }),
      sb.from("leaves").select("*").eq("teacher_id", me.id).order("created_at", { ascending: false }).limit(10)
    ]);
    const t = (rows || []).find((r) => r.work_date === today);
    const body = $("#todayBody");
    body.className = "";
    let html = `<div class="mute">${fmtDate(today)} &middot; shift ${esc(settings.shift_start.slice(0,5))}-${esc(settings.shift_end.slice(0,5))}</div>`;
    if (t) html += `<p>In: <b>${fmtTime(t.check_in)}</b> ${t.is_late ? pill("late") : pill("present")}<br>Out: <b>${fmtTime(t.check_out)}</b></p>`;
    else html += `<p>You have not checked in yet.</p>`;
    if (!t) html += `<button class="big ok" id="btnIn">Check in</button>`;
    else if (!t.check_out) html += `<button class="big danger" id="btnOut">Check out</button>`;
    else html += `<div class="msg good">Done for today.</div>`;
    html += `<div id="am" class="msg hidden"></div>`;
    body.innerHTML = html;
    if ($("#btnIn")) $("#btnIn").onclick = () => mark("in");
    if ($("#btnOut")) $("#btnOut").onclick = () => mark("out");

    $("#hist").innerHTML = (rows || []).length
      ? `<table><tr><th>Date</th><th>In</th><th>Out</th><th></th></tr>${rows.map((r) => `<tr><td>${fmtDate(r.work_date)}</td><td>${fmtTime(r.check_in)}</td><td>${fmtTime(r.check_out)}</td><td>${r.is_late ? pill("late") : ""}</td></tr>`).join("")}</table>`
      : `<p class="mute">No records yet.</p>`;
    $("#myLeaves").innerHTML = (leaves || []).length
      ? `<table><tr><th>Dates</th><th>Status</th></tr>${leaves.map((l) => `<tr><td>${fmtDate(l.from_date)} - ${fmtDate(l.to_date)}</td><td>${pill(l.status)}</td></tr>`).join("")}</table>` : "";
  }

  async function mark(action) {
    const btn = $(action === "in" ? "#btnIn" : "#btnOut"); const am = $("#am");
    btn.disabled = true; btn.textContent = "Getting location...";
    try {
      const pos = await getPosition();
      const { error } = await sb.rpc("mark_attendance", {
        p_action: action, p_lat: pos.coords.latitude, p_lng: pos.coords.longitude, p_accuracy: pos.coords.accuracy
      });
      if (error) throw error;
      await refreshTeacher();
    } catch (e) {
      btn.disabled = false; btn.textContent = action === "in" ? "Check in" : "Check out";
      msg(am, cleanErr(e));
    }
  }

  async function submitLeave(e) {
    e.preventDefault();
    const fd = new FormData(e.target); const m = $("#lm");
    const { error } = await sb.from("leaves").insert({ teacher_id: me.id, from_date: fd.get("from"), to_date: fd.get("to"), reason: fd.get("reason").trim() });
    if (error) return msg(m, cleanErr(error));
    e.target.reset(); msg(m, "Leave request sent.", "good"); refreshTeacher();
  }

  // ---------- admin ----------
  const TABS = [["today", "Today"], ["leaves", "Leaves"], ["report", "Report"], ["settings", "Settings"], ["account", "Account"]];
  let tab = "today";

  function renderAdmin() {
    app.innerHTML = `<div class="tabs" id="tabs"></div><div id="panel"></div>`;
    drawTabs(); showTab(tab);
    updateBadges();
  }
  function drawTabs(badges = {}) {
    $("#tabs").innerHTML = TABS.map(([k, v]) => `<button data-k="${k}" class="${k === tab ? "active" : ""}">${v}${badges[k] ? `<span class="badge">${badges[k]}</span>` : ""}</button>`).join("");
    $("#tabs").querySelectorAll("button").forEach((b) => (b.onclick = () => { tab = b.dataset.k; drawTabs(badges); showTab(tab); }));
  }
  async function updateBadges() {
    const { count } = await sb.from("leaves").select("id", { count: "exact", head: true }).eq("status", "pending");
    drawTabs({ leaves: count || 0 });
  }
  function showTab(k) { ({ today: tabToday, leaves: tabLeaves, report: tabReport, settings: tabSettings, account: tabAccount })[k](); }
  function tabAccount() { $("#panel").innerHTML = pwCard(); bindPw(); }

  async function tabToday() {
    const p = $("#panel");
    p.innerHTML = `<div class="card"><h2>Today</h2><div class="row"><input type="date" id="d" value="${istDate()}" style="flex:0 0 170px"><button class="secondary" id="r" style="flex:0 0 auto">Refresh</button></div><div id="out" class="scroll" style="margin-top:12px">Loading...</div></div>`;
    const load = async () => {
      const day = $("#d").value;
      const { data, error } = await sb.rpc("admin_day_status", { p_date: day });
      if (error) return ($("#out").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
      const flagged = data.filter((r) => r.status === "late" || r.status === "absent");
      $("#out").innerHTML =
        (flagged.length ? `<div class="msg err"><b>Needs attention:</b> ${flagged.map((r) => `${esc(r.full_name)} (${esc(r.status)})`).join(", ")}</div>` : "") +
        `<table><tr><th>Teacher</th><th>Status</th><th>In</th><th>Out</th></tr>${data.map((r) => `<tr><td>${esc(r.full_name)}</td><td>${pill(r.status)}</td><td>${fmtTime(r.check_in)}</td><td>${fmtTime(r.check_out)}</td></tr>`).join("")}</table>`;
    };
    $("#d").onchange = load; $("#r").onclick = load; load();
  }

  async function tabLeaves() {
    const p = $("#panel");
    p.innerHTML = `<div class="card"><h2>Leave requests</h2><div id="out" class="scroll">Loading...</div></div>`;
    const { data, error } = await sb.from("leaves").select("id, from_date, to_date, reason, status, profiles!leaves_teacher_id_fkey(full_name)").order("created_at", { ascending: false }).limit(50);
    if (error) return ($("#out").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
    $("#out").innerHTML = data.length ? data.map((l) => `
      <div class="lv">
        <div class="lvhead"><b>${esc(l.profiles?.full_name)}</b><span class="nw mute">${fmtShort(l.from_date)}${l.to_date !== l.from_date ? " - " + fmtShort(l.to_date) : ""}</span></div>
        <div class="mute">${esc(l.reason)}</div>
        <div class="lvact">${l.status === "pending"
          ? `<button class="ok" data-id="${esc(l.id)}" data-s="approved">Approve</button><button class="danger" data-id="${esc(l.id)}" data-s="rejected">Reject</button>`
          : pill(l.status)}</div>
      </div>`).join("") : `<p class="mute">No requests.</p>`;
    $("#out").querySelectorAll("button[data-id]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      const { error: e } = await sb.from("leaves").update({ status: b.dataset.s, decided_by: me.id }).eq("id", b.dataset.id);
      if (e) alert(cleanErr(e));
      tabLeaves(); updateBadges();
    }));
  }

  async function tabReport() {
    const p = $("#panel"); const now = istDate().slice(0, 7);
    p.innerHTML = `<div class="card"><h2>Monthly report</h2><div class="row"><input type="month" id="mo" value="${now}" style="flex:0 0 190px"><button id="csv" class="secondary" style="flex:0 0 auto" disabled>Download CSV</button></div><div id="out" class="scroll" style="margin-top:12px">Loading...</div><p class="mute">Absent = working day with no check-in and no approved leave. Counted up to today.</p></div>`;
    let rows = [];
    const load = async () => {
      const [y, m] = $("#mo").value.split("-").map(Number);
      const { data, error } = await sb.rpc("admin_monthly_report", { p_year: y, p_month: m });
      if (error) return ($("#out").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
      rows = data; $("#csv").disabled = !rows.length;
      $("#out").innerHTML = `<table><tr><th>Teacher</th><th title="Working days so far">Days</th><th>Pres.</th><th>Late</th><th>Leave</th><th>Abs.</th><th>Hrs</th></tr>${rows.map((r) => `<tr><td>${esc(r.full_name)}</td><td>${r.working_days}</td><td>${r.present}</td><td>${r.late}</td><td>${r.leave_days}</td><td>${r.absent}</td><td>${r.hours_worked}</td></tr>`).join("")}</table>`;
    };
    $("#mo").onchange = load;
    $("#csv").onclick = () => {
      const head = ["Teacher", "Working days", "Present", "Late", "Leave", "Absent", "Hours worked"];
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const csv = [head, ...rows.map((r) => [r.full_name, r.working_days, r.present, r.late, r.leave_days, r.absent, r.hours_worked])].map((r) => r.map(q).join(",")).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `attendance-${$("#mo").value}.csv`; a.click();
    };
    load();
  }

  async function tabSettings() {
    const s = settings;
    $("#panel").innerHTML = `<div class="card"><h2>Institute &amp; shift settings</h2>
      <form id="sf">
        <div class="row"><div><label>Latitude</label><input name="lat" type="number" step="any" value="${s.institute_lat}" required></div>
        <div><label>Longitude</label><input name="lng" type="number" step="any" value="${s.institute_lng}" required></div></div>
        <button type="button" class="secondary" id="here" style="margin-top:8px">Use my current location (stand inside the institute)</button>
        <div class="row"><div><label>Allowed radius (m)</label><input name="radius" type="number" min="30" value="${s.radius_m}" required></div>
        <div><label>Max GPS error allowed (m)</label><input name="acc" type="number" min="20" value="${s.max_accuracy_m}" required></div></div>
        <div class="row"><div><label>Shift start</label><input name="start" type="time" value="${esc(s.shift_start.slice(0,5))}" required></div>
        <div><label>Shift end</label><input name="end" type="time" value="${esc(s.shift_end.slice(0,5))}" required></div>
        <div><label>Late grace (min)</label><input name="grace" type="number" min="0" value="${s.late_grace_min}" required></div></div>
        <label>Working days</label>
        <div class="row">${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((n, i) => `<label style="display:flex;gap:6px;align-items:center;margin:0;flex:0 0 auto"><input type="checkbox" style="width:auto" name="wd" value="${i + 1}" ${s.working_days.includes(i + 1) ? "checked" : ""}>${n}</label>`).join("")}</div>
        <div id="sm" class="msg hidden"></div>
        <button style="margin-top:12px">Save settings</button>
      </form></div>
      <div class="card"><h2>Teachers</h2><p class="mute">Add or remove teachers in Supabase dashboard -> Authentication -> Users. Teachers change their own password under "Change password" on their home screen; if one is locked out, see "Resetting a teacher's password" in the README. Full name: put <code>{"full_name":"Name"}</code> in user metadata when adding, or edit it in the profiles table.</p></div>`;
    $("#here").onclick = async () => {
      try { const pos = await getPosition(); $("#sf").lat.value = pos.coords.latitude.toFixed(6); $("#sf").lng.value = pos.coords.longitude.toFixed(6); msg($("#sm"), `Captured (accuracy about ${Math.round(pos.coords.accuracy)} m). Save to apply.`, "good"); }
      catch (e) { msg($("#sm"), cleanErr(e)); }
    };
    $("#sf").onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      const wd = [...f.querySelectorAll('input[name="wd"]:checked')].map((c) => Number(c.value));
      const patch = { institute_lat: +f.lat.value, institute_lng: +f.lng.value, radius_m: +f.radius.value, max_accuracy_m: +f.acc.value,
                      shift_start: f.start.value, shift_end: f.end.value, late_grace_min: +f.grace.value, working_days: wd };
      const { data, error } = await sb.from("settings").update(patch).eq("id", 1).select().single();
      if (error) return msg($("#sm"), cleanErr(error));
      settings = data; msg($("#sm"), "Saved.", "good");
    };
  }

  // ---------- start ----------
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  boot();
})();
