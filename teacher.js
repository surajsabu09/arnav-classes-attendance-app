export function createTeacherViews({ sb, app, $, esc, fmtDate, fmtTime, fmtShort, istDate, pill, msg, cleanErr, getPosition, getMe, getEmail, getSites, accountView, bindPw }) {
  const tabs = [["today", "Today"], ["schedule", "Schedule"], ["history", "History"], ["leave", "Leave"], ["account", "Account"]];
  let activeTab = "today";

  async function renderTeacher() {
    app.innerHTML = `<section class="page-heading"><div><p class="eyebrow">TEACHER WORKSPACE</p><h2>Welcome back, ${esc(getMe().full_name)}</h2><p class="mute">Your lectures and attendance</p></div></section>
      <nav class="tabs" id="teacherTabs" aria-label="Teacher sections"></nav><div id="teacherPanel"></div>`;
    drawTabs();
    await showTab(activeTab);
  }

  function drawTabs() {
    $("#teacherTabs").innerHTML = tabs.map(([key, label]) =>
      `<button data-k="${key}" class="${activeTab === key ? "active" : ""}">${label}</button>`).join("");
    $("#teacherTabs").querySelectorAll("button").forEach((button) => (button.onclick = () => {
      activeTab = button.dataset.k;
      drawTabs();
      showTab(activeTab);
    }));
  }

  async function showTab(key) {
    const panel = $("#teacherPanel");
    if (key === "today") return loadToday();
    if (key === "schedule") return loadSchedule();
    if (key === "history") return loadHistory();
    if (key === "leave") return loadLeaves();
    panel.innerHTML = accountView({ fullName: getMe().full_name, email: getEmail(), role: getMe().role, branches: getSites().map((site) => site.name) });
    bindPw();
  }

  async function loadToday() {
    const today = istDate();
    const panel = $("#teacherPanel");
    panel.innerHTML = `<div class="section-heading"><div><p class="eyebrow">${fmtDate(today)}</p><h3>Today's lectures</h3></div></div><div id="todaySessions" class="session-list">Loading...</div>`;
    await renderSessions(today, today, "#todaySessions");
  }

  async function loadSchedule() {
    const from = istDate();
    const until = new Date(new Date(`${from}T00:00:00Z`).getTime() + 30 * 864e5).toISOString().slice(0, 10);
    $("#teacherPanel").innerHTML = `<div class="section-heading"><div><p class="eyebrow">UPCOMING</p><h3>Lecture schedule</h3></div><span class="mute">Next 30 days</span></div><div id="scheduleSessions" class="session-list">Loading...</div>`;
    await renderSessions(from, until, "#scheduleSessions");
  }

  async function renderSessions(from, until, target) {
    const host = $(target);
    const { data, error } = await sb.from("lecture_sessions")
      .select("id, title, session_date, start_time, end_time, site_id, institute_sites(name), attendance(id, check_in, check_out, is_late, check_out_outside_geofence, check_out_admin)")
      .eq("teacher_id", getMe().id).eq("active", true).gte("session_date", from).lte("session_date", until)
      .order("session_date").order("start_time");
    if (error) return (host.innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
    if (!data?.length) return (host.innerHTML = `<div class="card"><p class="mute">No lectures assigned for these dates.</p></div>`);
    host.innerHTML = data.map((session) => {
      const record = session.attendance?.[0];
      const timing = session.start_time ? `${esc(session.start_time.slice(0, 5))} - ${esc(session.end_time.slice(0, 5))}` : "Time not fixed";
      const status = record?.check_out ? (record.check_out_outside_geofence ? "out of range" : record.check_out_admin ? "closed by admin" : "complete") : record?.check_in ? (record.is_late ? "open late" : "open") : "scheduled";
      return `<article class="session-card"><div class="session-info"><p class="eyebrow">${fmtDate(session.session_date)}</p><h4>${esc(session.title)}</h4><p class="mute">${esc(session.institute_sites?.name || "Branch unavailable")} · ${timing}</p>${record ? `<p class="session-times">In ${fmtTime(record.check_in)} <span>Out ${fmtTime(record.check_out)}</span></p>` : ""}</div><div class="session-action">${pill(status)}${!record ? `<button class="ok" data-attend="in" data-session="${esc(session.id)}">Check in</button>` : !record.check_out ? `<button class="danger" data-attend="out" data-session="${esc(session.id)}">Check out</button>` : ""}<div id="am-${esc(session.id)}" class="msg hidden"></div></div></article>`;
    }).join("");
    host.querySelectorAll("button[data-attend]").forEach((button) => {
      button.onclick = () => mark(button.dataset.attend, button.dataset.session);
    });
  }

  async function loadHistory() {
    const since = istDate(new Date(Date.now() - 30 * 864e5));
    const panel = $("#teacherPanel");
    panel.innerHTML = `<div class="card"><div class="section-heading"><div><p class="eyebrow">ATTENDANCE</p><h3>Recent history</h3></div><span class="mute">Last 30 days</span></div><div id="historyRows" class="scroll">Loading...</div></div>`;
    const { data, error } = await sb.from("attendance").select("*, lecture_sessions(id, title, session_date, institute_sites(name))").eq("teacher_id", getMe().id)
      .gte("work_date", since).order("work_date", { ascending: false });
    if (error) return ($("#historyRows").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
    $("#historyRows").innerHTML = (data || []).length
      ? `<table><tr><th>Date</th><th>Lecture</th><th>Branch</th><th>In</th><th>Out</th><th>Status</th><th>Action</th></tr>${data.map((record) => `<tr><td>${fmtDate(record.work_date)}</td><td>${esc(record.lecture_sessions?.title || "Legacy attendance")}</td><td>${esc(record.lecture_sessions?.institute_sites?.name || "")}</td><td>${fmtTime(record.check_in)}</td><td>${fmtTime(record.check_out)}</td><td>${record.check_out ? (record.check_out_outside_geofence ? pill("out of range") : record.check_out_admin ? pill("closed by admin") : record.is_late ? pill("late") : pill("complete")) : pill("open")}</td><td>${!record.check_out && record.session_id ? `<button class="danger" data-attend="out" data-session="${esc(record.session_id)}">Check out</button><div id="am-${esc(record.session_id)}" class="msg hidden"></div>` : ""}</td></tr>`).join("")}</table>`
      : `<p class="mute">No attendance records in the last 30 days.</p>`;
    $("#historyRows").querySelectorAll("button[data-attend='out']").forEach((button) => {
      button.onclick = () => mark("out", button.dataset.session);
    });
  }

  async function loadLeaves() {
    const panel = $("#teacherPanel");
    panel.innerHTML = `<div class="two-column"><div class="card"><p class="eyebrow">TIME OFF</p><h3>Request leave</h3>
      <form id="lf"><div class="row"><div><label>From</label><input type="date" name="from" required></div><div><label>To</label><input type="date" name="to" required></div></div>
        <label>Leave type<select name="leave_type" required><option value="casual">Casual</option><option value="sick">Sick</option><option value="personal">Personal</option><option value="unpaid">Unpaid</option><option value="other">Other</option></select></label>
        <label>Reason</label><textarea name="reason" rows="3" maxlength="300" required></textarea>
        <div id="lm" class="msg hidden"></div><button style="margin-top:10px">Submit request</button></form></div>
      <div class="card"><p class="eyebrow">YOUR REQUESTS</p><h3>Leave status</h3><div id="myLeaves" class="scroll">Loading...</div></div></div>`;
    $("#lf").onsubmit = submitLeave;
    const { data, error } = await sb.from("leaves").select("*").eq("teacher_id", getMe().id).order("created_at", { ascending: false }).limit(20);
    if (error) return ($("#myLeaves").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
    $("#myLeaves").innerHTML = (data || []).length
      ? `<table><tr><th>Dates</th><th>Type</th><th>Status</th></tr>${data.map((leave) => `<tr><td>${fmtDate(leave.from_date)}${leave.to_date !== leave.from_date ? ` - ${fmtDate(leave.to_date)}` : ""}</td><td>${esc(leave.leave_type)}</td><td>${pill(leave.status)}</td></tr>`).join("")}</table>`
      : `<p class="mute">No leave requests yet.</p>`;
  }

  async function mark(action, sessionId) {
    const button = document.querySelector(`button[data-attend="${action}"][data-session="${sessionId}"]`);
    const message = $(`#am-${sessionId}`);
    if (!button || !message) return;
    button.disabled = true; button.textContent = "Getting location...";
    try {
      const position = await getPosition();
      const { error } = await sb.rpc("mark_attendance", {
        p_action: action, p_session_id: sessionId, p_lat: position.coords.latitude, p_lng: position.coords.longitude, p_accuracy: position.coords.accuracy
      });
      if (error) throw error;
      await showTab(activeTab);
    } catch (error) {
      button.disabled = false; button.textContent = action === "in" ? "Check in" : "Check out";
      msg(message, cleanErr(error));
    }
  }

  async function submitLeave(event) {
    event.preventDefault();
    const formData = new FormData(event.target), message = $("#lm");
    const { error } = await sb.from("leaves").insert({ teacher_id: getMe().id, from_date: formData.get("from"), to_date: formData.get("to"), leave_type: formData.get("leave_type"), reason: formData.get("reason").trim() });
    if (error) return msg(message, cleanErr(error));
    event.target.reset(); msg(message, "Leave request sent.", "good"); loadLeaves();
  }

  return { renderTeacher };
}
