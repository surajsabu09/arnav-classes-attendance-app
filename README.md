# Teacher Attendance (free-tier PWA)

GPS-verified check-in/check-out for ~10 teachers, with leave requests, late/absent flags and a monthly report.
Cost: Rs 0 (Supabase free + any free static host).

## Setup (about 20 minutes)

1. **Supabase**: create a free project at supabase.com.
  - SQL Editor -> paste all of `schema.sql` -> Run. For an existing install, this adds a "Main institute" branch using your current location and migrates existing attendance into it; your existing attendance history is preserved.
   - Authentication -> Users -> **Add user** for yourself (admin) and each teacher (tick "auto confirm"). Put `{"full_name":"Teacher Name"}` in user metadata, or edit the name later in Table Editor -> `profiles`.
   - Make yourself admin (SQL Editor):
     `update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'YOU@EXAMPLE.COM');`
   - Authentication -> Providers -> Email: turn **off** "Allow new users to sign up" so only you can create accounts.
2. **Config**: edit `config.js` with the Project URL and anon key (Project Settings -> API) and the institute name.
3. **Host** the folder as a static site (HTTPS is required for GPS): Cloudflare Pages, Netlify or GitHub Pages, all free. Drag-and-drop the folder.
4. **Set up branches**: sign in as admin -> Branches -> edit the migrated "Main institute" or add a branch. Set its coordinates (use "Use my current location" while inside that institute), radius, shift and working days, then assign teachers and save. Repeat for each location. A teacher can be assigned to multiple branches; they choose the branch they are physically attending before check-in.
5. Teachers open the site on their phone -> browser menu -> "Add to Home Screen".

## How it works
- Check-in/out calls the `mark_attendance()` database function with a branch ID. The server validates the teacher's assignment, branch geofence, GPS accuracy and lateness; editing the JS does not bypass those checks.
- Attendance remains limited to one record per teacher per day. Each record stores its branch.
- Teacher screens: Today, History, Leave, Account. Admin screens: Today, Leaves, Report, Branches, Account. Admin attendance and monthly reports are scoped to the selected branch.

## Passwords
- **Change password:** every user can do it. Teachers and admins use the Account tab. The current password is re-checked first. Minimum 8 characters.
- **Forgot password link** (sign-in screen) emails a reset link. It only works if Supabase can actually send email:
  - Supabase's built-in email sender is very limited (a few emails per hour, and it may only deliver to your own team's addresses). For real teachers, set up free custom SMTP: Supabase -> Authentication -> Emails -> SMTP Settings (a free Brevo or Resend account, or a Gmail app password).
  - Add your hosted address under Authentication -> URL Configuration -> **Redirect URLs** (e.g. `https://USERNAME.github.io/teacher-attendance/`), or the reset link will not return to the app.
  - Until that is set up, treat the link as unreliable and use the admin reset below.
- **Resetting a teacher's password yourself** (no email needed). Supabase -> SQL Editor:
  ```sql
  update auth.users
  set encrypted_password = extensions.crypt('NewTempPass123', extensions.gen_salt('bf')), updated_at = now()
  where email = 'teacher@example.com';
  ```
  Tell the teacher the temporary password and ask them to change it after signing in. (If Supabase says the function `extensions.crypt` does not exist, remove the `extensions.` prefix from both function names.) Do not delete and recreate a user to reset a password: that also deletes their attendance history.

## Known limits (be upfront with the client)
- **GPS can be spoofed** with mock-location apps. This stops casual proxy attendance (marking from home), not a determined cheater. If that matters, add a daily rotating QR code later.
- **Alerts are in the dashboard only.** There are no push, SMS or email alerts, since those need paid services or extra setup. The admin sees late/absent on the Today tab.
- Supabase free projects **pause after ~1 week of no activity**. Daily use prevents this.
- Free tier has no automatic backups. Export the monthly CSVs, or use Table Editor -> Export occasionally.
- The app has no UI to add teachers; use the Supabase dashboard (fine for 10 people).
- One check-in and one check-out per day. Corrections are made by the admin in Table Editor -> `attendance`.
- Absent is computed, not stored: a working day with no check-in and no approved leave. Public holidays are not modelled, so mark them as leave or ignore them in the report for now.
