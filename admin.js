export function createAdminViews({
  sb, app, $, esc, fmtDate, fmtShort, fmtTime, istDate, isSessionOverdue, pill, msg, cleanErr, getPosition,
  getMe, getEmail, accountView, getSites, getSelectedSiteId, setSelectedSiteId, setSites, sitePicker, bindSitePicker, bindPw
}) {
  const tabs = [["today", "Today"], ["schedule", "Schedule"], ["leaves", "Leaves"], ["report", "Report"], ["settings", "Branches"], ["account", "Account"]];
  let activeTab = "today";

  function renderAdmin() {
    app.innerHTML = `<section class="page-heading"><div><p class="eyebrow">ADMIN WORKSPACE</p><h2>Institute operations</h2><p class="mute">Attendance, leave requests, and branch settings</p></div>${sitePicker()}</section>
      <div class="tabs" id="tabs"></div><div id="panel"></div>`;
    bindSitePicker(() => showTab(activeTab));
    drawTabs(); showTab(activeTab);
    updateBadges();
  }

  function drawTabs(badges = {}) {
    $("#tabs").innerHTML = tabs.map(([key, label]) => `<button data-k="${key}" class="${key === activeTab ? "active" : ""}">${label}${badges[key] ? `<span class="badge">${badges[key]}</span>` : ""}</button>`).join("");
    $("#tabs").querySelectorAll("button").forEach((button) => (button.onclick = () => {
      activeTab = button.dataset.k; drawTabs(badges); showTab(activeTab);
    }));
  }

  async function updateBadges() {
    const { count } = await sb.from("leaves").select("id", { count: "exact", head: true }).eq("status", "pending");
    drawTabs({ leaves: count || 0 });
  }

  function showTab(key) {
    ({ today: tabToday, schedule: tabSchedule, leaves: tabLeaves, report: tabReport, settings: tabSettings, account: tabAccount })[key]();
  }

  function tabAccount() {
    $("#panel").innerHTML = accountView({ fullName: getMe().full_name, email: getEmail(), role: getMe().role, branches: [] });
    bindPw();
  }

  async function tabToday() {
    $("#panel").innerHTML = `<div class="card"><div class="section-heading"><div><p class="eyebrow">LECTURE ATTENDANCE</p><h3>Daily overview</h3></div><button class="secondary" id="r" type="button">Refresh</button></div><label>Date<input type="date" id="d" value="${istDate()}"></label><div id="out" class="scroll" style="margin-top:12px">Loading...</div></div>`;
    const load = async () => {
      const day = $("#d").value;
      let query = sb.from("lecture_sessions").select("id, title, session_date, start_time, end_time, late_grace_min, teacher_id, site_id, profiles!lecture_sessions_teacher_id_fkey(full_name), institute_sites(name), attendance(id, check_in, check_out, is_late, check_out_outside_geofence, check_out_admin)")
        .eq("session_date", day).eq("active", true).order("start_time");
      if (getSelectedSiteId()) query = query.eq("site_id", getSelectedSiteId());
      const [{ data, error }, { data: leaveData, error: leaveError }] = await Promise.all([
        query,
        sb.from("leaves").select("teacher_id").eq("status", "approved").lte("from_date", day).gte("to_date", day)
      ]);
      if (error) return ($("#out").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
      if (leaveError) return ($("#out").innerHTML = `<div class="msg err">${esc(cleanErr(leaveError))}</div>`);
      const onLeave = new Set((leaveData || []).map((leave) => leave.teacher_id));
      $("#out").innerHTML = data?.length
        ? `<table><tr><th>Lecture</th><th>Teacher</th><th>Branch</th><th>Time</th><th>Status</th><th>In</th><th>Out</th><th>Action</th></tr>${data.map((session) => {
          const record = session.attendance?.[0];
          let status = record?.check_out ? (record.check_out_outside_geofence ? "out of range" : record.check_out_admin ? "closed by admin" : "complete") : record?.check_in ? (record.is_late ? "open late" : "open") : "scheduled";
          if (!record && onLeave.has(session.teacher_id)) status = "on leave";
          else if (!record && isSessionOverdue(day, session.start_time, session.late_grace_min)) status = "absent";
          const time = session.start_time ? `${session.start_time.slice(0, 5)} - ${session.end_time.slice(0, 5)}` : "Flexible";
          return `<tr><td>${esc(session.title)}</td><td>${esc(session.profiles?.full_name || "")}</td><td>${esc(session.institute_sites?.name || "")}</td><td>${time}</td><td>${pill(status)}</td><td>${fmtTime(record?.check_in)}</td><td>${fmtTime(record?.check_out)}</td><td>${record?.check_in && !record.check_out ? `<button class="danger" data-close-session="${esc(session.id)}">Close open session</button><div id="close-${esc(session.id)}" class="msg hidden"></div>` : ""}</td></tr>`;
        }).join("")}</table>`
        : `<p class="mute">No lectures scheduled for this date and branch.</p>`;
      $("#out").querySelectorAll("button[data-close-session]").forEach((button) => {
        button.onclick = async () => {
          button.disabled = true; button.textContent = "Closing...";
          let location = { p_lat: null, p_lng: null, p_accuracy: null };
          try {
            const position = await getPosition();
            location = { p_lat: position.coords.latitude, p_lng: position.coords.longitude, p_accuracy: position.coords.accuracy };
          } catch {}
          const { error: closeError } = await sb.rpc("mark_attendance", { p_action: "out", p_session_id: button.dataset.closeSession, ...location });
          if (closeError) {
            button.disabled = false; button.textContent = "Close open session";
            return msg($(`#close-${button.dataset.closeSession}`), cleanErr(closeError));
          }
          load();
        };
      });
    };
    $("#d").onchange = load; $("#r").onclick = load; load();
  }

  async function tabSchedule() {
    const siteOptions = getSites().map((site) => `<option value="${esc(site.id)}" ${site.id === getSelectedSiteId() ? "selected" : ""}>${esc(site.name)}</option>`).join("");
    $("#panel").innerHTML = `<div class="two-column schedule-layout"><div class="card"><p class="eyebrow">LECTURE PLANNING</p><h3 id="sessionFormTitle">Assign a lecture</h3>
      <form id="sessionForm"><input type="hidden" id="sessionId">
        <label>Lecture or batch name<input id="sessionName" maxlength="120" required placeholder="e.g. Grade 8 mathematics"></label>
        <div class="row"><div><label>Branch<select id="sessionSite" required>${siteOptions}</select></label></div><div><label>Teacher<select id="sessionTeacher" required></select></label></div></div>
        <div class="row"><div><label>Lecture date<input id="sessionDate" type="date" value="${istDate()}" required></label></div><div><label>Start time<input id="sessionStart" type="time"></label></div><div><label>End time<input id="sessionEnd" type="time"></label></div></div>
        <label>Late grace (minutes)<input id="sessionGrace" type="number" min="0" value="10" required></label>
        <div id="sessionMessage" class="msg hidden"></div><div class="row"><button id="sessionSave">Save lecture</button><button id="sessionCancel" class="secondary hidden" type="button">Cancel edit</button></div>
      </form></div><div class="card"><p class="eyebrow">SCHEDULE</p><h3>Lectures on selected date</h3><label>Date<input id="sessionListDate" type="date" value="${istDate()}"></label><div id="sessionList" class="session-list">Loading...</div></div></div>`;
    const site = $("#sessionSite");
    const teacher = $("#sessionTeacher");
    const applySiteDefaults = () => {
      const branch = getSites().find((item) => item.id === site.value);
      $("#sessionStart").value = "";
      $("#sessionEnd").value = "";
      $("#sessionGrace").value = branch?.late_grace_min ?? 10;
    };
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
      $("#sessionSite").value = getSelectedSiteId() || getSites()[0]?.id || "";
      applySiteDefaults(); $("#sessionFormTitle").textContent = "Assign a lecture";
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
    site.onchange = () => { applySiteDefaults(); fillTeachers(); };
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
    applySiteDefaults();
    await fillTeachers();
    await loadSessions();
  }

  async function tabLeaves() {
    $("#panel").innerHTML = `<div class="card"><h2>Leave requests</h2><div id="out" class="scroll">Loading...</div></div>`;
    const { data, error } = await sb.from("leaves").select("id, from_date, to_date, leave_type, reason, status, profiles!leaves_teacher_id_fkey(full_name)").order("created_at", { ascending: false }).limit(50);
    if (error) return ($("#out").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
    $("#out").innerHTML = data.length ? data.map((leave) => `
      <div class="lv">
        <div class="lvhead"><b>${esc(leave.profiles?.full_name)}</b><span class="nw mute">${fmtShort(leave.from_date)}${leave.to_date !== leave.from_date ? " - " + fmtShort(leave.to_date) : ""}</span></div>
        <label>Leave type<select data-leave-type="${esc(leave.id)}" ${leave.status === "pending" ? "" : "disabled"}>${[["casual", "Casual"], ["sick", "Sick"], ["personal", "Personal"], ["unpaid", "Unpaid"], ["other", "Other"]].map(([value, label]) => `<option value="${value}" ${leave.leave_type === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        <div class="mute">${esc(leave.reason)}</div>
        <div class="lvact">${leave.status === "pending"
          ? `<button class="ok" data-id="${esc(leave.id)}" data-s="approved">Approve</button><button class="danger" data-id="${esc(leave.id)}" data-s="rejected">Reject</button>`
          : pill(leave.status)}</div>
      </div>`).join("") : `<p class="mute">No requests.</p>`;
    $("#out").querySelectorAll("button[data-id]").forEach((button) => (button.onclick = async () => {
      button.disabled = true;
      const leaveType = $(`[data-leave-type="${button.dataset.id}"]`).value;
      const { error: updateError } = await sb.from("leaves").update({ status: button.dataset.s, leave_type: leaveType, decided_by: getMe().id }).eq("id", button.dataset.id);
      if (updateError) alert(cleanErr(updateError));
      tabLeaves(); updateBadges();
    }));
  }

  async function tabReport() {
    const now = istDate().slice(0, 7);
    $("#panel").innerHTML = `<div class="card"><div class="section-heading"><div><p class="eyebrow">CONSOLIDATED ATTENDANCE</p><h3>Monthly report</h3></div><button id="csv" class="secondary" disabled>Download CSV</button></div><div class="row"><div><label>Month<input type="month" id="mo" value="${now}"></label></div><div><label>Branch<select id="reportSite"><option value="">All branches</option>${getSites().map((site) => `<option value="${esc(site.id)}">${esc(site.name)}</option>`).join("")}</select></label></div></div><div id="out" class="scroll" style="margin-top:12px">Loading...</div></div>`;
    let rows = [];
    const load = async () => {
      const [year, month] = $("#mo").value.split("-").map(Number);
      const { data, error } = await sb.rpc("admin_monthly_report", { p_year: year, p_month: month, p_site_id: $("#reportSite").value || null });
      if (error) return ($("#out").innerHTML = `<div class="msg err">${esc(cleanErr(error))}</div>`);
      rows = data || [];
      $("#csv").disabled = !rows.length;
      $("#out").innerHTML = rows.length
        ? `<table><tr><th>Teacher</th><th>Lectures</th><th>Attended</th><th>Late</th><th>Missed</th><th>Open</th><th>Leave days</th><th>Hours</th></tr>${rows.map((row) => `<tr><td>${esc(row.full_name)}</td><td>${row.lectures}</td><td>${row.attended}</td><td>${row.late}</td><td>${row.missed}</td><td>${row.open_sessions}</td><td>${row.leave_days}</td><td>${row.hours_worked}</td></tr>`).join("")}</table>`
        : `<p class="mute">No lectures scheduled this month.</p>`;
    };
    $("#mo").onchange = load; $("#reportSite").onchange = load;
    $("#csv").onclick = () => {
      const head = ["Teacher", "Lectures", "Attended", "Late", "Missed", "Open", "Leave days", "Hours"];
      const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
      const csv = [head, ...rows.map((row) => [row.full_name, row.lectures, row.attended, row.late, row.missed, row.open_sessions, row.leave_days, row.hours_worked])].map((line) => line.map(quote).join(",")).join("\n");
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); anchor.download = `attendance-${$("#mo").value}.csv`; anchor.click();
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
      const selectedBranch = forceNew ? null : branchSites.find((branch) => branch.id === getSelectedSiteId()) || branchSites[0] || null;
      const site = selectedBranch || { name: "", institute_lat: "", institute_lng: "", radius_m: 150, max_accuracy_m: 100, late_grace_min: 10, working_days: [1, 2, 3, 4, 5, 6], active: true };
      $("#panel").innerHTML = `<div class="branch-nav" aria-label="Branches">
        ${branchSites.map((branch) => `<button type="button" class="${branch.id === site.id ? "active" : "secondary"}" data-branch="${esc(branch.id)}">${esc(branch.name)}${branch.active ? "" : " (inactive)"}</button>`).join("")}
        <button type="button" class="secondary" id="newBranch">Add branch</button>
      </div>
      <div class="two-column branch-layout">
        <div class="card"><p class="eyebrow">LOCATION</p><h3>${site.id ? "Branch details" : "New branch"}</h3>
          <form id="sf"><div class="row"><div><label>Branch name</label><input name="name" maxlength="100" value="${esc(site.name)}" required></div><div class="active-field"><label><input type="checkbox" name="active" ${site.active ? "checked" : ""}> Branch active</label></div></div>
            <div class="row"><div><label>Latitude</label><input name="lat" type="number" min="-90" max="90" step="any" value="${esc(site.institute_lat)}" required></div><div><label>Longitude</label><input name="lng" type="number" min="-180" max="180" step="any" value="${esc(site.institute_lng)}" required></div></div>
            <button type="button" class="secondary" id="here" style="margin-top:8px">Use my current location</button>
            <div class="row"><div><label>Allowed radius (m)</label><input name="radius" type="number" min="30" value="${site.radius_m}" required></div><div><label>Max GPS error (m)</label><input name="acc" type="number" min="20" value="${site.max_accuracy_m}" required></div><div><label>Late grace (min)</label><input name="grace" type="number" min="0" value="${site.late_grace_min}" required></div></div>
            <label>Working days</label><div class="weekday-list">${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((day, index) => `<label><input type="checkbox" name="wd" value="${index + 1}" ${site.working_days.includes(index + 1) ? "checked" : ""}>${day}</label>`).join("")}</div>
            <div id="sm" class="msg hidden"></div><button style="margin-top:14px">Save branch</button>
          </form>
        </div>
        <div class="card"><p class="eyebrow">TEAM</p><h3>Assigned teachers</h3>
          ${site.id ? `<form id="assignmentForm"><div id="teacherAssignments" class="teacher-list">Loading assignments...</div><div id="assignmentMessage" class="msg hidden"></div><button style="margin-top:14px">Save assignments</button></form>` : `<p class="mute">Save this branch first, then assign its teachers.</p>`}
        </div>
      </div>
      <div class="card"><p class="eyebrow">TEAM ACCESS</p><h3>Invite a teacher</h3><p class="mute">Send a sign-in invitation. The teacher sets their own password.</p>
        <form id="createTeacherForm"><div class="row"><div><label>Full name</label><input name="full_name" maxlength="120" required></div><div><label>Email</label><input name="email" type="email" autocomplete="email" required></div></div>
          <label>Assign branches</label><div class="teacher-list">${branchSites.filter((branch) => branch.active).map((branch) => `<label class="teacher-option"><input type="checkbox" name="invite_site" value="${esc(branch.id)}" ${branch.id === getSelectedSiteId() ? "checked" : ""}><span>${esc(branch.name)}</span></label>`).join("")}</div>
          <div id="createTeacherMessage" class="msg hidden"></div><button>Send invitation</button>
        </form>
      </div>`;

      $("#panel").querySelectorAll("button[data-branch]").forEach((button) => {
        button.onclick = () => { setSelectedSiteId(button.dataset.branch); localStorage.setItem("attendance-site", button.dataset.branch); tabSettings(); };
      });
      $("#newBranch").onclick = () => tabSettings(true);
      if (site.id) {
        const { data: assignments, error: assignmentReadError } = await sb.from("site_assignments").select("teacher_id").eq("site_id", site.id);
        if (assignmentReadError) return ($("#teacherAssignments").innerHTML = `<div class="msg err">${esc(cleanErr(assignmentReadError))}</div>`);
        const assignedIds = new Set((assignments || []).map((row) => row.teacher_id));
        $("#teacherAssignments").innerHTML = branchTeachers.length
          ? branchTeachers.map((teacher) => `<label class="teacher-option"><input type="checkbox" name="teacher" value="${esc(teacher.id)}" ${assignedIds.has(teacher.id) ? "checked" : ""} ${teacher.active ? "" : "disabled"}><span>${esc(teacher.full_name)}</span>${teacher.active ? "" : `<small>Inactive</small>`}</label>`).join("")
          : `<p class="mute">No teacher accounts.</p>`;
        $("#assignmentForm").onsubmit = async (event) => {
          event.preventDefault();
          const teacherIds = [...event.target.querySelectorAll('input[name="teacher"]:checked')].map((checkbox) => checkbox.value);
          const { error } = await sb.rpc("save_site_assignments", { p_site_id: site.id, p_teacher_ids: teacherIds });
          if (error) return msg($("#assignmentMessage"), cleanErr(error));
          msg($("#assignmentMessage"), "Teacher assignments saved.", "good");
        };
      }
      $("#here").onclick = async () => {
        try {
          const position = await getPosition(); $("#sf").lat.value = position.coords.latitude.toFixed(6); $("#sf").lng.value = position.coords.longitude.toFixed(6);
          msg($("#sm"), `Captured (accuracy about ${Math.round(position.coords.accuracy)} m). Save to apply.`, "good");
        } catch (error) { msg($("#sm"), cleanErr(error)); }
      };
      $("#sf").onsubmit = async (event) => {
        event.preventDefault(); const form = event.target;
        const latitude = Number(form.lat.value), longitude = Number(form.lng.value);
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return msg($("#sm"), "Latitude must be between -90 and 90.");
        if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return msg($("#sm"), "Longitude must be between -180 and 180.");
        const patch = { name: form.elements.namedItem("name").value.trim(), active: form.active.checked, institute_lat: latitude, institute_lng: longitude,
          radius_m: Number(form.radius.value), max_accuracy_m: Number(form.acc.value), late_grace_min: Number(form.grace.value),
          working_days: [...form.querySelectorAll('input[name="wd"]:checked')].map((checkbox) => Number(checkbox.value)) };
        const result = site.id
          ? await sb.from("institute_sites").update(patch).eq("id", site.id).select().single()
          : await sb.from("institute_sites").insert(patch).select().single();
        if (result.error) return msg($("#sm"), cleanErr(result.error));
        setSelectedSiteId(result.data.id); localStorage.setItem("attendance-site", result.data.id);
        const { data: refreshedSites, error: refreshError } = await sb.from("institute_sites").select("*").order("name");
        if (refreshError) return msg($("#sm"), cleanErr(refreshError));
        setSites(refreshedSites || []);
        tabSettings();
      };
      $("#createTeacherForm").onsubmit = async (event) => {
        event.preventDefault();
        const form = event.target, message = $("#createTeacherMessage");
        const siteIds = [...form.querySelectorAll('input[name="invite_site"]:checked')].map((checkbox) => checkbox.value);
        if (!siteIds.length) return msg(message, "Select at least one branch.");
        const { error } = await sb.functions.invoke("create-teacher", { body: {
          full_name: form.elements.full_name.value.trim(), email: form.elements.email.value.trim(), site_ids: siteIds
        } });
        if (error) return msg(message, cleanErr(error));
        form.reset(); msg(message, "Invitation sent. The teacher can set a password from their email.", "good");
      };
  }

  return { renderAdmin };
}
