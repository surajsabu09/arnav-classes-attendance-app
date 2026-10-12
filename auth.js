export function createAuthViews({ sb, app, $, esc, msg, cleanErr, getSessionEmail, boot }) {
  const passwordMinimum = 8;

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
    $("#fp").onclick = async (event) => {
      event.preventDefault();
      const email = $("#f").email.value.trim();
      if (!email) return msg($("#m"), "Type your email in the box above first, then tap Forgot password.");
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) return msg($("#m"), error.message);
      msg($("#m"), "If that email has an account, a reset link is on its way. Check spam too. If nothing arrives, ask the admin to reset it.", "good");
    };
    $("#f").onsubmit = async (event) => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const { error } = await sb.auth.signInWithPassword({ email: formData.get("email").trim(), password: formData.get("password") });
      if (error) return msg($("#m"), error.message);
      boot();
    };
  }

  function pwCard() {
    return `<form id="pf">
      <label>Current password</label><input name="cur" type="password" autocomplete="current-password" required>
      <label>New password</label><input name="p1" type="password" autocomplete="new-password" minlength="${passwordMinimum}" required>
      <label>Confirm new password</label><input name="p2" type="password" autocomplete="new-password" minlength="${passwordMinimum}" required>
      <div id="pm" class="msg hidden"></div>
      <button style="margin-top:12px">Update password</button>
    </form>`;
  }

  function accountView({ fullName, email, role, branches }) {
    const branchSummary = role === "admin" ? "All branches (administrator)" : branches.length ? branches.map(esc).join(", ") : "No branch assigned";
    return `<section class="account-view"><div class="card"><p class="eyebrow">ACCOUNT</p><h3>Employee details</h3>
      <dl class="account-details"><div><dt>Name</dt><dd>${esc(fullName || "")}</dd></div><div><dt>Email</dt><dd>${esc(email || "")}</dd></div><div><dt>Role</dt><dd>${esc(role || "")}</dd></div><div><dt>Branch access</dt><dd>${branchSummary}</dd></div></dl>
      </div><details class="account-password"><summary>Change password</summary>${pwCard()}</details></section>`;
  }

  function bindPw() {
    const form = $("#pf"); if (!form) return;
    form.onsubmit = async (event) => {
      event.preventDefault();
      const message = $("#pm"), button = form.querySelector("button");
      if (form.p1.value.length < passwordMinimum) return msg(message, `New password must be at least ${passwordMinimum} characters.`);
      if (form.p1.value !== form.p2.value) return msg(message, "The two new passwords do not match.");
      if (form.p1.value === form.cur.value) return msg(message, "New password must be different from the current one.");
      button.disabled = true;
      try {
        const { error: passwordError } = await sb.auth.signInWithPassword({ email: getSessionEmail(), password: form.cur.value });
        if (passwordError) throw new Error("Current password is incorrect.");
        const { error } = await sb.auth.updateUser({ password: form.p1.value });
        if (error) throw error;
        form.reset(); msg(message, "Password updated.", "good");
      } catch (error) { msg(message, cleanErr(error)); }
      button.disabled = false;
    };
  }

  function renderSetPassword() {
    $("#logout").classList.remove("hidden");
    app.innerHTML = `<div class="card"><h2>Set a new password</h2>
      <p class="mute">${esc(getSessionEmail() || "")}</p>
      <form id="sp">
        <label>New password (min ${passwordMinimum} characters)</label><input name="p1" type="password" autocomplete="new-password" minlength="${passwordMinimum}" required>
        <label>Confirm new password</label><input name="p2" type="password" autocomplete="new-password" minlength="${passwordMinimum}" required>
        <div id="sm2" class="msg hidden"></div>
        <button class="big" style="margin-top:12px">Save password</button>
      </form></div>`;
    $("#sp").onsubmit = async (event) => {
      event.preventDefault(); const form = event.target, message = $("#sm2");
      if (form.p1.value.length < passwordMinimum) return msg(message, `Password must be at least ${passwordMinimum} characters.`);
      if (form.p1.value !== form.p2.value) return msg(message, "The two passwords do not match.");
      const { error } = await sb.auth.updateUser({ password: form.p1.value });
      if (error) return msg(message, cleanErr(error));
      msg(message, "Password saved. Opening the app...", "good");
      history.replaceState(null, "", location.pathname + location.search);
      setTimeout(() => location.reload(), 900);
    };
  }

  return { renderLogin, pwCard, bindPw, renderSetPassword, accountView };
}
