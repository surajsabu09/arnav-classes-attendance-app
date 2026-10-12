import { createAuthViews } from "./auth.js";
import { createAdminViews } from "./admin.js";
import { cleanErr, esc, fmtDate, fmtShort, fmtTime, getPosition, isSessionOverdue, istDate, msg, pill } from "./app-utils.js";
import { createTeacherViews } from "./teacher.js";

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

  // ---------- auth ----------
  const { renderLogin, bindPw, renderSetPassword, accountView } = createAuthViews({
    sb, app, $, esc, msg, cleanErr, getSessionEmail: () => sessionEmail, boot: () => boot()
  });
  const teacherViews = createTeacherViews({ sb, app, $, esc, fmtDate, fmtTime, fmtShort, istDate, pill, msg, cleanErr, getPosition,
    getMe: () => me, getEmail: () => sessionEmail, getSites: () => sites, accountView, bindPw });

  $("#logout").onclick = async () => { await sb.auth.signOut(); me = null; renderLogin(); };

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT" && me) {
      me = null;
      renderLogin();
    } else if (event === "PASSWORD_RECOVERY") {
      sessionEmail = session?.user?.email || null;
      renderSetPassword();
    }
  });

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
    me.role === "admin" ? adminViews.renderAdmin() : teacherViews.renderTeacher();
  }

  // ---------- teacher ----------
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

  const adminViews = createAdminViews({
    sb, app, $, esc, fmtDate, fmtShort, fmtTime, istDate, isSessionOverdue, pill, msg, cleanErr, getPosition,
    getMe: () => me, getEmail: () => sessionEmail, accountView, getSites: () => sites, getSelectedSiteId: () => selectedSiteId,
    setSelectedSiteId: (id) => { selectedSiteId = id; }, setSites: (items) => { sites = items; },
    sitePicker, bindSitePicker, bindPw
  });

  // ---------- start ----------
  if ("serviceWorker" in navigator) navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(cfg.ASSET_VERSION)}`).catch(() => {});
  boot();
})();
