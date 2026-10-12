# Teacher Attendance (free-tier PWA)

GPS-verified, lecture-by-lecture check-in/check-out for teachers across multiple branches, with leave requests and consolidated reports.
Cost: Rs 0 (Supabase free + any free static host).

## Setup (about 20 minutes)

1. **Supabase**: create a free project at supabase.com.
  - SQL Editor -> paste all of `schema.sql` -> Run. It creates the lecture schedule and attendance tables. Existing attendance rows are preserved as legacy history; new records are attached to individual lectures.
   - Authentication -> Users -> **Add user** for yourself (admin) and each teacher (tick "auto confirm"). Put `{"full_name":"Teacher Name"}` in user metadata, or edit the name later in Table Editor -> `profiles`.
   - Make yourself admin (SQL Editor):
     `update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'YOU@EXAMPLE.COM');`
   - Authentication -> Providers -> Email: turn **off** "Allow new users to sign up" so only you can create accounts.
2. **Config**: edit `config.js` with the Project URL and anon key (Project Settings -> API) and the institute name.
3. **Host** the folder as a static site (HTTPS is required for GPS): Cloudflare Pages, Netlify or GitHub Pages, all free. Drag-and-drop the folder.
4. **Set up branches**: sign in as admin -> Branches -> edit the migrated "Main institute" or add a branch. Set its coordinates (use "Use my current location" while inside that institute), radius, shift and working days, then assign teachers and save. Repeat for each location. A teacher can be assigned to multiple branches.
5. **Schedule lectures**: open Schedule -> choose a lecture/batch name, branch, teacher, and date. The branch shift and grace values prefill the form; change or clear both times for flexible lectures. Overlapping fixed-time lectures for the same teacher are rejected.
6. Teachers open the site on their phone -> browser menu -> "Add to Home Screen".

## How it works
- The frontend is split into small ES modules for authentication, shared utilities, teacher screens, and admin screens. The cache version is maintained in `config.js`.
- Admins create individual dated lecture sessions. A session may have a fixed time or a flexible time.
- Check-in/out calls the `mark_attendance()` database function with a lecture ID. The server validates the teacher's lecture assignment, branch geofence, GPS accuracy and lateness; editing the JS does not bypass those checks. Out-of-geofence check-outs are allowed but flagged, and admins can close open sessions.
- Each lecture has its own attendance record, so a teacher can teach at multiple branches on the same day. Late status is calculated only for lectures with a scheduled start time.
- Approved leave is excluded from missed-lecture counts. Open sessions are reported separately and do not add completed hours.
- Monthly totals are calculated by a SQL function, avoiding the browser API's 1,000-row response limit. Branch-assignment replacement is transactional.
- Teacher screens: Today, Schedule, History, Leave, Account. Admin screens: Today, Schedule, Leaves, Report, Branches, Account. Monthly reports consolidate lecture counts and worked hours by teacher, across branches or for one branch.

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
- **GPS can be spoofed** with mock-location apps. Geofencing discourages casual proxy attendance but does not stop a determined user; consider a rotating QR code if stronger verification is needed.
- **Alerts are in the dashboard only.** There are no push, SMS or email alerts, since those need paid services or extra setup. Admins can review lecture attendance on the Today tab.
- Supabase free projects **pause after ~1 week of no activity**. Daily use prevents this.
- Free tier has no automatic backups. Export the monthly CSVs, or use Table Editor -> Export occasionally.
- The app has no UI to add teachers; use the Supabase dashboard (fine for 10 people).
- One check-in and one check-out are allowed per scheduled lecture. Corrections are made by the admin in Table Editor -> `attendance`.
- A lecture without scheduled times can still be tracked, but it cannot be automatically marked late.
