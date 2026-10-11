/* Teacher Attendance PWA. Plain JS, no build step. */
(() => {
  const cfg = window.APP_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const app = document.getElementById("app");
  const $ = (sel, root = document) => root.querySelector(sel);

  let me = null;        // {id, full_name, role}
  let sites = [];
  let selectedSiteId = localStorage.getItem("attendance-site") || "";
  let sessionEmail = null;
  // Opened from a password-reset email link? Must be read before anything clears the URL hash.
  const isRecovery = /type=recovery/.test(location.hash);

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const istDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d); // YYYY-MM-DD
  const fmtTime = (iso) => iso ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(iso)) : "-";
  const fmtDate = (ymd) => new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(ymd + "T00:00:00Z"));
  const fmtShort = (ymd) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(ymd + "T00:00:00Z"));
  const isSessionOverdue = (date, start, grace = 0) => {
    const today = istDate();
    if (date < today) return true;
    if (date > today || !start) return false;
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
    const currentMinutes = Number(parts.find((part) => part.type === "hour").value) * 60 + Number(parts.find((part) => part.type === "minute").value);
    const [startHour, startMinute] = start.slice(0, 5).split(":").map(Number);
    return currentMinutes > startHour * 60 + startMinute + grace;
  };
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
    const { data: availableSites, error: siteError } = await sb.from("institute_sites").select("*")
      .eq("active", true).order("name");
    if (siteError) {
      app.innerHTML = `<div class="card"><div class="msg err">${esc(cleanErr(siteError))}. Ask the admin to update the database schema.</div></div>`;
      return;
    }
    sites = availableSites || [];
    if (!sites.some((s) => s.id === selectedSiteId)) selectedSiteId = sites[0]?.id || "";
    if (selectedSiteId) localStorage.setItem("attendance-site", selectedSiteId);
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
  const TEACHER_TABS = [["today", "Today"], ["schedule", "Schedule"], ["history", "History"], ["leave", "Leave"], ["account", "Account"]];
  let teacherTab = "today";

  async function renderTeacher() {
    app.innerHTML = `<section class="page-heading"><div><p class="eyebrow">TEACHER WORKSPACE</p><h2>Welcome back, ${esc(me.full_name)}</h2><p class="mute">Your lectures and attendance</p></div></section>
      <nav class="tabs" id="teacherTabs" aria-label="Teacher sections"></nav><div id="teacherPanel"></div>`;
    drawTeacherTabs();
    await showTeacherTab(teacherTab);
  }

  function sitePicker() {
    if (!sites.length) return `<div class="site-note">No branch access</div>`;
    return `<label class="site-control">Institute branch<select id="siteChoice">${sites.map((s) => `<option value="${esc(s.id)}" ${s.id === selectedSiteId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>`;
  }

  function bindSitePicker(onChange) {
    const select = $("#siteChoice");
    if (select) select.onchange = () => {
      selectedSiteId = select.value;
      localStorage.setItem("attendance-site", selectedSiteId);
      onChange();
    };
  }

  function drawTeacherTabs() {
    $("#teacherTabs").innerHTML = TEACHER_TABS.map(([key, label]) =>
      `<button data-k="${key}" class="${teacherTab === key ? "active" : ""}">${label}</button>`).join("");
    $("#teacherTabs").querySelectorAll("button").forEach((button) => (button.onclick = () => {
      teacherTab = button.dataset.k;
      drawTeacherTabs();
      showTeacherTab(teacherTab);
    }));
  }

  async function showTeacherTab(key) {
    const panel = $("#teacherPanel");
    if (key === "today") return loadTeacherToday();
    if (key === "schedule") return loadTeacherSchedule();
    if (key === "history") return loadTeacherHistory();
    if (key === "leave") return loadTeacherLeaves();
    panel.innerHTML = pwCard();
    bindPw();
  }

  async function loadTeacherToday() {
    const today = istDate();
    const panel = $("#teacherPanel");
    panel.innerHTML = `<div class="section-heading"><div><p class="eyebrow">${fmtDate(today)}</p><h3>Today's lectures</h3></div></div><div id="todaySessions" class="session-list">Loading...</div>`;
    await renderTeacherSessions(today, today, "#todaySessions");
  }

  async function loadTeacherSchedule() {
    const from = istDate();
    const until = new Date(new Date(`${from}T00:00:00Z`).getTime() + 30 * 864e5).toISOString().slice(0, 10);
    $("#teacherPanel").innerHTML = `<div class="section-heading"><div><p class="eyebrow">UPCOMING</p><h3>Lecture schedule</h3></div><span class="mute">Next 30 days</span></div><div id="scheduleSessions" class="session-list">Loading...</div>`;
    await renderTeacherSessions(from, until, "#scheduleSessions");
  }

  async function renderTeacherSessions(from, until, target) {
    const host = $(target);
    const { data, error } = await sb.from("lecture_sessions")
      .select("id, title, session_date, start_time, end_time, site_id, institute_sites(name), attendance(id, check_in, check_out, is_late)")
      .eq("teacher_id", me.id).eq("active", true).gte("session_date", from).lte("session_date", until)
      .order("session_date").order("start_time");
    if (error) return (host.innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
    if (!data?.length) return (host.innerHTML = `<div class="card"><p class="mute">No lectures assigned for these dates.</p></div>`);
    host.innerHTML = data.map((session) => {
      const record = session.attendance?.[0];
      const timing = session.start_time ? `${esc(session.start_time.slice(0, 5))} - ${esc(session.end_time.slice(0, 5))}` : "Time not fixed";
      const status = record?.check_out ? "complete" : record?.check_in ? "in progress" : "not checked in";
      return `<article class="session-card"><div class="session-info"><p class="eyebrow">${fmtDate(session.session_date)}</p><h4>${esc(session.title)}</h4><p class="mute">${esc(session.institute_sites?.name || "Branch unavailable")} · ${timing}</p>${record ? `<p class="session-times">In ${fmtTime(record.check_in)} <span>Out ${fmtTime(record.check_out)}</span></p>` : ""}</div><div class="session-action">${pill(record?.is_late ? "late" : status)}${!record ? `<button class="ok" data-attend="in" data-session="${esc(session.id)}">Check in</button>` : !record.check_out ? `<button class="danger" data-attend="out" data-session="${esc(session.id)}">Check out</button>` : ""}<div id="am-${esc(session.id)}" class="msg hidden"></div></div></article>`;
    }).join("");
    host.querySelectorAll("button[data-attend]").forEach((button) => {
      button.onclick = () => mark(button.dataset.attend, button.dataset.session);
    });
  }

  async function loadTeacherHistory() {
    const since = istDate(new Date(Date.now() - 30 * 864e5));
    const panel = $("#teacherPanel");
    panel.innerHTML = `<div class="card"><div class="section-heading"><div><p class="eyebrow">ATTENDANCE</p><h3>Recent history</h3></div><span class="mute">Last 30 days</span></div><div id="historyRows" class="scroll">Loading...</div></div>`;
    const { data, error } = await sb.from("attendance").select("*, lecture_sessions(title, session_date, institute_sites(name))").eq("teacher_id", me.id)
      .gte("work_date", since).order("work_date", { ascending: false });
    if (error) return ($("#historyRows").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
    $("#historyRows").innerHTML = (data || []).length
      ? `<table><tr><th>Date</th><th>Lecture</th><th>Branch</th><th>In</th><th>Out</th><th>Status</th></tr>${data.map((r) => `<tr><td>${fmtDate(r.work_date)}</td><td>${esc(r.lecture_sessions?.title || "Legacy attendance")}</td><td>${esc(r.lecture_sessions?.institute_sites?.name || "")}</td><td>${fmtTime(r.check_in)}</td><td>${fmtTime(r.check_out)}</td><td>${r.is_late ? pill("late") : pill("present")}</td></tr>`).join("")}</table>`
      : `<p class="mute">No attendance records in the last 30 days.</p>`;
  }

  async function loadTeacherLeaves() {
    const panel = $("#teacherPanel");
    panel.innerHTML = `<div class="two-column"><div class="card"><p class="eyebrow">TIME OFF</p><h3>Request leave</h3>
      <form id="lf"><div class="row"><div><label>From</label><input type="date" name="from" required></div><div><label>To</label><input type="date" name="to" required></div></div>
        <label>Reason</label><textarea name="reason" rows="3" maxlength="300" required></textarea>
        <div id="lm" class="msg hidden"></div><button style="margin-top:10px">Submit request</button></form></div>
      <div class="card"><p class="eyebrow">YOUR REQUESTS</p><h3>Leave status</h3><div id="myLeaves" class="scroll">Loading...</div></div></div>`;
    $("#lf").onsubmit = submitLeave;
    const { data, error } = await sb.from("leaves").select("*").eq("teacher_id", me.id).order("created_at", { ascending: false }).limit(20);
    if (error) return ($("#myLeaves").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
    $("#myLeaves").innerHTML = (data || []).length
      ? `<table><tr><th>Dates</th><th>Status</th></tr>${data.map((l) => `<tr><td>${fmtDate(l.from_date)}${l.to_date !== l.from_date ? ` - ${fmtDate(l.to_date)}` : ""}</td><td>${pill(l.status)}</td></tr>`).join("")}</table>`
      : `<p class="mute">No leave requests yet.</p>`;
  }

  async function mark(action, sessionId) {
    const btn = document.querySelector(`button[data-attend="${action}"][data-session="${sessionId}"]`);
    const am = $(`#am-${sessionId}`);
    if (!btn || !am) return;
    btn.disabled = true; btn.textContent = "Getting location...";
    try {
      const pos = await getPosition();
      const { error } = await sb.rpc("mark_attendance", {
        p_action: action, p_session_id: sessionId, p_lat: pos.coords.latitude, p_lng: pos.coords.longitude, p_accuracy: pos.coords.accuracy
      });
      if (error) throw error;
      await showTeacherTab(teacherTab);
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
    e.target.reset(); msg(m, "Leave request sent.", "good"); loadTeacherLeaves();
  }

  // ---------- admin ----------
  const TABS = [["today", "Today"], ["schedule", "Schedule"], ["leaves", "Leaves"], ["report", "Report"], ["settings", "Branches"], ["account", "Account"]];
  let tab = "today";

  function renderAdmin() {
    app.innerHTML = `<section class="page-heading"><div><p class="eyebrow">ADMIN WORKSPACE</p><h2>Institute operations</h2><p class="mute">Attendance, leave requests, and branch settings</p></div>${sitePicker()}</section>
      <div class="tabs" id="tabs"></div><div id="panel"></div>`;
    bindSitePicker(() => showTab(tab));
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
  function showTab(k) { ({ today: tabToday, schedule: tabSchedule, leaves: tabLeaves, report: tabReport, settings: tabSettings, account: tabAccount })[k](); }
  function tabAccount() { $("#panel").innerHTML = pwCard(); bindPw(); }

  async function tabToday() {
    const p = $("#panel");
    p.innerHTML = `<div class="card"><div class="section-heading"><div><p class="eyebrow">LECTURE ATTENDANCE</p><h3>Daily overview</h3></div><button class="secondary" id="r" type="button">Refresh</button></div><label>Date<input type="date" id="d" value="${istDate()}"></label><div id="out" class="scroll" style="margin-top:12px">Loading...</div></div>`;
    const load = async () => {
      const day = $("#d").value;
      let query = sb.from("lecture_sessions").select("id, title, session_date, start_time, end_time, late_grace_min, teacher_id, site_id, profiles!lecture_sessions_teacher_id_fkey(full_name), institute_sites(name), attendance(id, check_in, check_out, is_late)")
        .eq("session_date", day).eq("active", true).order("start_time");
      if (selectedSiteId) query = query.eq("site_id", selectedSiteId);
      const { data, error } = await query;
      if (error) return ($("#out").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
      $("#out").innerHTML = data?.length
        ? `<table><tr><th>Lecture</th><th>Teacher</th><th>Branch</th><th>Time</th><th>Status</th><th>In</th><th>Out</th></tr>${data.map((session) => {
          const record = session.attendance?.[0];
          let status = record?.check_out ? "complete" : record?.is_late ? "late" : record?.check_in ? "present" : "scheduled";
          if (!record && isSessionOverdue(day, session.start_time, session.late_grace_min)) status = "absent";
          const time = session.start_time ? `${session.start_time.slice(0, 5)} - ${session.end_time.slice(0, 5)}` : "Flexible";
          return `<tr><td>${esc(session.title)}</td><td>${esc(session.profiles?.full_name || "")}</td><td>${esc(session.institute_sites?.name || "")}</td><td>${time}</td><td>${pill(status)}</td><td>${fmtTime(record?.check_in)}</td><td>${fmtTime(record?.check_out)}</td></tr>`;
        }).join("")}</table>`
        : `<p class="mute">No lectures scheduled for this date and branch.</p>`;
    };
    $("#d").onchange = load; $("#r").onclick = load; load();
  }

  async function tabSchedule() {
    const siteOptions = sites.map((site) => `<option value="${esc(site.id)}" ${site.id === selectedSiteId ? "selected" : ""}>${esc(site.name)}</option>`).join("");
    $("#panel").innerHTML = `<div class="two-column schedule-layout"><div class="card"><p class="eyebrow">LECTURE PLANNING</p><h3 id="sessionFormTitle">Assign a lecture</h3>
      <form id="sessionForm"><input type="hidden" id="sessionId">
        <label>Lecture or batch name<input id="sessionName" maxlength="120" required placeholder="e.g. Grade 8 mathematics"></label>
        <div class="row"><div><label>Branch<select id="sessionSite" required>${siteOptions}</select></label></div><div><label>Teacher<select id="sessionTeacher" required></select></label></div></div>
        <div class="row"><div><label>Lecture date<input id="sessionDate" type="date" value="${istDate()}" required></label></div><div><label>Start time (optional)<input id="sessionStart" type="time"></label></div><div><label>End time (optional)<input id="sessionEnd" type="time"></label></div></div>
        <label>Late grace (minutes)<input id="sessionGrace" type="number" min="0" value="10" required></label>
        <div id="sessionMessage" class="msg hidden"></div><div class="row"><button id="sessionSave">Save lecture</button><button id="sessionCancel" class="secondary hidden" type="button">Cancel edit</button></div>
      </form></div><div class="card"><p class="eyebrow">SCHEDULE</p><h3>Lectures on selected date</h3><label>Date<input id="sessionListDate" type="date" value="${istDate()}"></label><div id="sessionList" class="session-list">Loading...</div></div></div>`;
    const site = $("#sessionSite");
    const teacher = $("#sessionTeacher");
    const fillTeachers = async (selectedTeacher = "") => {
      const { data, error } = await sb.from("site_assignments").select("teacher_id, profiles!site_assignments_teacher_id_fkey(full_name)").eq("site_id", site.value);
      if (error) {
        teacher.innerHTML = `<option value="">Could not load teachers</option>`;
        return msg($("#sessionMessage"), cleanErr(error));
      }
      teacher.innerHTML = data?.length
        ? data.map((row) => `<option value="${esc(row.teacher_id)}" ${row.teacher_id === selectedTeacher ? "selected" : ""}>${esc(row.profiles?.full_name || "Teacher")}</option>`).join("")
        : `<option value="">No teachers assigned to this branch</option>`;
    };
    const clearForm = () => {
      $("#sessionForm").reset(); $("#sessionId").value = ""; $("#sessionDate").value = istDate();
      $("#sessionSite").value = selectedSiteId || sites[0]?.id || "";
      $("#sessionGrace").value = "10"; $("#sessionFormTitle").textContent = "Assign a lecture";
      $("#sessionSave").textContent = "Save lecture"; $("#sessionCancel").classList.add("hidden");
      fillTeachers();
    };
    const loadSessions = async () => {
      const { data, error } = await sb.from("lecture_sessions").select("id, title, session_date, start_time, end_time, late_grace_min, teacher_id, site_id, active, profiles!lecture_sessions_teacher_id_fkey(full_name), institute_sites(name), attendance(id)")
        .eq("session_date", $("#sessionListDate").value).order("start_time");
      if (error) return ($("#sessionList").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
      $("#sessionList").innerHTML = data?.length ? data.map((session) => {
        const recorded = session.attendance?.length > 0;
        const timing = session.start_time ? `${session.start_time.slice(0, 5)} - ${session.end_time.slice(0, 5)}` : "Flexible time";
        return `<article class="session-card"><div class="session-info"><h4>${esc(session.title)}</h4><p class="mute">${esc(session.profiles?.full_name || "")} · ${esc(session.institute_sites?.name || "")} · ${timing}</p>${session.active ? "" : pill("cancelled")}</div><div class="session-action"><button class="secondary" data-edit-session="${esc(session.id)}" ${recorded ? "disabled title=\"Attendance already recorded\"" : ""}>Edit</button><button class="danger" data-delete-session="${esc(session.id)}" ${recorded ? "disabled title=\"Attendance already recorded\"" : ""}>Remove</button></div></article>`;
      }).join("") : `<p class="mute">No lectures on this date.</p>`;
      $("#sessionList").querySelectorAll("button[data-edit-session]").forEach((button) => {
        button.onclick = async () => {
          const session = data.find((item) => item.id === button.dataset.editSession);
          $("#sessionId").value = session.id; $("#sessionName").value = session.title;
          $("#sessionDate").value = session.session_date; $("#sessionStart").value = session.start_time?.slice(0, 5) || "";
          $("#sessionEnd").value = session.end_time?.slice(0, 5) || ""; $("#sessionGrace").value = session.late_grace_min;
          site.value = session.site_id; await fillTeachers(session.teacher_id);
          $("#sessionFormTitle").textContent = "Edit lecture"; $("#sessionSave").textContent = "Update lecture";
          $("#sessionCancel").classList.remove("hidden"); $("#sessionName").focus();
        };
      });
      $("#sessionList").querySelectorAll("button[data-delete-session]").forEach((button) => {
        button.onclick = async () => {
          if (!confirm("Remove this scheduled lecture?")) return;
          const { error: deleteError } = await sb.from("lecture_sessions").delete().eq("id", button.dataset.deleteSession);
          if (deleteError) return msg($("#sessionMessage"), cleanErr(deleteError));
          loadSessions();
        };
      });
    };
    site.onchange = () => fillTeachers();
    $("#sessionDate").onchange = () => { $("#sessionListDate").value = $("#sessionDate").value; loadSessions(); };
    $("#sessionListDate").onchange = loadSessions;
    $("#sessionCancel").onclick = clearForm;
    $("#sessionForm").onsubmit = async (event) => {
      event.preventDefault();
      const start = $("#sessionStart").value || null, end = $("#sessionEnd").value || null;
      if (!!start !== !!end) return msg($("#sessionMessage"), "Enter both start and end times, or leave both blank.");
      const payload = { title: $("#sessionName").value.trim(), teacher_id: teacher.value, site_id: site.value,
        session_date: $("#sessionDate").value, start_time: start, end_time: end, late_grace_min: Number($("#sessionGrace").value) };
      const id = $("#sessionId").value;
      const result = id
        ? await sb.from("lecture_sessions").update(payload).eq("id", id)
        : await sb.from("lecture_sessions").insert(payload);
      if (result.error) return msg($("#sessionMessage"), cleanErr(result.error));
      $("#sessionListDate").value = payload.session_date; clearForm(); loadSessions();
    };
    await fillTeachers();
    await loadSessions();
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
    p.innerHTML = `<div class="card"><div class="section-heading"><div><p class="eyebrow">CONSOLIDATED ATTENDANCE</p><h3>Monthly report</h3></div><button id="csv" class="secondary" disabled>Download CSV</button></div><div class="row"><div><label>Month<input type="month" id="mo" value="${now}"></label></div><div><label>Branch<select id="reportSite"><option value="">All branches</option>${sites.map((site) => `<option value="${esc(site.id)}">${esc(site.name)}</option>`).join("")}</select></label></div></div><div id="out" class="scroll" style="margin-top:12px">Loading...</div></div>`;
    let rows = [];
    const load = async () => {
      const [year, month] = $("#mo").value.split("-").map(Number);
      const first = `${year}-${String(month).padStart(2, "0")}-01`;
      const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
      let query = sb.from("lecture_sessions").select("teacher_id, profiles!lecture_sessions_teacher_id_fkey(full_name), session_date, start_time, late_grace_min, attendance(check_in, check_out, is_late)")
        .gte("session_date", first).lt("session_date", nextMonth).lte("session_date", istDate()).eq("active", true);
      if ($("#reportSite").value) query = query.eq("site_id", $("#reportSite").value);
      const { data, error } = await query;
      if (error) return ($("#out").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
      const totals = new Map();
      for (const session of data || []) {
        const teacherId = session.teacher_id;
        const row = totals.get(teacherId) || { name: session.profiles?.full_name || "", lectures: 0, attended: 0, late: 0, missed: 0, hours: 0 };
        row.lectures++;
        const record = session.attendance?.[0];
        if (record?.check_in) {
          row.attended++;
          if (record.is_late) row.late++;
          if (record.check_out) row.hours += Math.max(0, new Date(record.check_out) - new Date(record.check_in)) / 3600000;
        } else if (isSessionOverdue(session.session_date, session.start_time, session.late_grace_min)) row.missed++;
        totals.set(teacherId, row);
      }
      rows = [...totals.values()].sort((a, b) => a.name.localeCompare(b.name)).map((row) => ({ ...row, hours: Math.round(row.hours * 10) / 10 }));
      $("#csv").disabled = !rows.length;
      $("#out").innerHTML = rows.length
        ? `<table><tr><th>Teacher</th><th>Lectures</th><th>Attended</th><th>Late</th><th>Missed</th><th>Hours</th></tr>${rows.map((row) => `<tr><td>${esc(row.name)}</td><td>${row.lectures}</td><td>${row.attended}</td><td>${row.late}</td><td>${row.missed}</td><td>${row.hours}</td></tr>`).join("")}</table>`
        : `<p class="mute">No lectures scheduled this month.</p>`;
    };
    $("#mo").onchange = load; $("#reportSite").onchange = load;
    $("#csv").onclick = () => {
      const head = ["Teacher", "Lectures", "Attended", "Late", "Missed", "Hours"];
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const csv = [head, ...rows.map((row) => [row.name, row.lectures, row.attended, row.late, row.missed, row.hours])].map((r) => r.map(q).join(",")).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `attendance-${$("#mo").value}.csv`; a.click();
    };
    load();
  }

  async function tabSettings(forceNew = false) {
    const [{ data: allSites, error: sitesError }, { data: teachers, error: teachersError }] = await Promise.all([
      sb.from("institute_sites").select("*").order("name"),
      sb.from("profiles").select("id, full_name, active").eq("role", "teacher").order("full_name")
    ]);
    if (sitesError || teachersError) return ($("#panel").innerHTML = `<div class="card"><div class="msg err">${esc(cleanErr(sitesError || teachersError))}</div></div>`);
    const branchSites = allSites || [];
    const branchTeachers = teachers || [];
    const activeEditorSite = forceNew ? null : branchSites.find((site) => site.id === selectedSiteId) || branchSites[0] || null;
    const s = activeEditorSite || { name: "", institute_lat: "", institute_lng: "", radius_m: 150, max_accuracy_m: 100, shift_start: "09:00", shift_end: "18:00", late_grace_min: 10, working_days: [1, 2, 3, 4, 5, 6], active: true };
    $("#panel").innerHTML = `<div class="card"><div class="section-heading"><div><p class="eyebrow">LOCATIONS</p><h3>Branch settings</h3></div><button type="button" class="secondary" id="newBranch">Add branch</button></div>
      <label>Editing branch<select id="branchEdit"><option value="">New branch</option>${branchSites.map((site) => `<option value="${esc(site.id)}" ${site.id === s.id ? "selected" : ""}>${esc(site.name)}${site.active ? "" : " (inactive)"}</option>`).join("")}</select></label>
      <form id="sf"><div class="row"><div><label>Branch name</label><input name="name" maxlength="100" value="${esc(s.name)}" required></div><div class="active-field"><label><input type="checkbox" name="active" ${s.active ? "checked" : ""}> Branch active</label></div></div>
        <div class="row"><div><label>Latitude</label><input name="lat" type="number" step="any" value="${esc(s.institute_lat)}" required></div><div><label>Longitude</label><input name="lng" type="number" step="any" value="${esc(s.institute_lng)}" required></div></div>
        <button type="button" class="secondary" id="here" style="margin-top:8px">Use my current location</button>
        <div class="row"><div><label>Allowed radius (m)</label><input name="radius" type="number" min="30" value="${s.radius_m}" required></div><div><label>Max GPS error (m)</label><input name="acc" type="number" min="20" value="${s.max_accuracy_m}" required></div></div>
        <div class="row"><div><label>Shift start</label><input name="start" type="time" value="${esc(s.shift_start.slice(0,5))}" required></div><div><label>Shift end</label><input name="end" type="time" value="${esc(s.shift_end.slice(0,5))}" required></div><div><label>Late grace (min)</label><input name="grace" type="number" min="0" value="${s.late_grace_min}" required></div></div>
        <label>Working days</label><div class="weekday-list">${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((day, index) => `<label><input type="checkbox" name="wd" value="${index + 1}" ${s.working_days.includes(index + 1) ? "checked" : ""}>${day}</label>`).join("")}</div>
        <div class="assignment-heading"><h4>Teachers assigned to this branch</h4><span class="mute">${branchTeachers.length} accounts</span></div>
        <div id="teacherAssignments" class="teacher-list">Loading assignments...</div>
        <div id="sm" class="msg hidden"></div><button style="margin-top:14px">Save branch</button></form></div>
      <div class="card"><p class="eyebrow">TEAM</p><h3>Teacher accounts</h3><p class="mute">Create teacher accounts in Supabase Authentication. Add each teacher's full name in user metadata, then assign them to one or more branches above.</p></div>`;
    const renderAssignments = async (siteId) => {
      if (!siteId) {
        $("#teacherAssignments").innerHTML = branchTeachers.length
          ? branchTeachers.map((teacher) => `<label class="teacher-option"><input type="checkbox" name="teacher" value="${esc(teacher.id)}" ${teacher.active ? "" : "disabled"}><span>${esc(teacher.full_name)}</span>${teacher.active ? "" : `<small>Inactive</small>`}</label>`).join("")
          : `<p class="mute">No teacher accounts found.</p>`;
        return;
      }
      const { data, error } = await sb.from("site_assignments").select("teacher_id").eq("site_id", siteId);
      if (error) return ($("#teacherAssignments").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
      const assigned = new Set((data || []).map((row) => row.teacher_id));
      $("#teacherAssignments").innerHTML = branchTeachers.length
        ? branchTeachers.map((teacher) => `<label class="teacher-option"><input type="checkbox" name="teacher" value="${esc(teacher.id)}" ${assigned.has(teacher.id) ? "checked" : ""} ${teacher.active ? "" : "disabled"}><span>${esc(teacher.full_name)}</span>${teacher.active ? "" : `<small>Inactive</small>`}</label>`).join("")
        : `<p class="mute">No teacher accounts found.</p>`;
    };
    await renderAssignments(s.id);
    $("#branchEdit").onchange = () => {
      const id = $("#branchEdit").value;
      if (id) selectedSiteId = id;
      if (id) localStorage.setItem("attendance-site", id);
      tabSettings(!id);
    };
    $("#newBranch").onclick = () => { $("#branchEdit").value = ""; tabSettings(true); };
    $("#here").onclick = async () => {
      try { const position = await getPosition(); $("#sf").lat.value = position.coords.latitude.toFixed(6); $("#sf").lng.value = position.coords.longitude.toFixed(6); msg($("#sm"), `Captured (accuracy about ${Math.round(position.coords.accuracy)} m). Save to apply.`, "good"); }
      catch (error) { msg($("#sm"), cleanErr(error)); }
    };
    $("#sf").onsubmit = async (event) => {
      event.preventDefault(); const form = event.target;
      const patch = { name: form.elements.namedItem("name").value.trim(), active: form.active.checked, institute_lat: +form.lat.value, institute_lng: +form.lng.value,
        radius_m: +form.radius.value, max_accuracy_m: +form.acc.value, shift_start: form.start.value, shift_end: form.end.value,
        late_grace_min: +form.grace.value, working_days: [...form.querySelectorAll('input[name="wd"]:checked')].map((checkbox) => Number(checkbox.value)) };
      const save = s.id
        ? await sb.from("institute_sites").update(patch).eq("id", s.id).select().single()
        : await sb.from("institute_sites").insert(patch).select().single();
      if (save.error) return msg($("#sm"), cleanErr(save.error));
      const siteId = save.data.id;
      const { error: clearError } = await sb.from("site_assignments").delete().eq("site_id", siteId);
      if (clearError) return msg($("#sm"), cleanErr(clearError));
      const teacherIds = [...form.querySelectorAll('input[name="teacher"]:checked')].map((checkbox) => checkbox.value);
      if (teacherIds.length) {
        const { error: assignError } = await sb.from("site_assignments").insert(teacherIds.map((teacherId) => ({ site_id: siteId, teacher_id: teacherId })));
        if (assignError) return msg($("#sm"), cleanErr(assignError));
      }
      selectedSiteId = siteId;
      localStorage.setItem("attendance-site", siteId);
      msg($("#sm"), "Branch and teacher assignments saved.", "good");
      const { data: refreshedSites } = await sb.from("institute_sites").select("*").eq("active", true).order("name");
      sites = refreshedSites || [];
      if (!sites.some((site) => site.id === selectedSiteId)) selectedSiteId = sites[0]?.id || siteId;
      localStorage.setItem("attendance-site", selectedSiteId);
      bindSitePicker(() => showTab(tab));
      renderAdmin();
    };
  }

  // ---------- start ----------
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js?v=3").catch(() => {});
  boot();
})();
