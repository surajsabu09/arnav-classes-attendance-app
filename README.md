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
2. **Teacher invitations**: install the Supabase CLI and run these from the project folder:
  ```sh
  supabase login
  supabase link --project-ref YOUR_PROJECT_REF
  supabase functions deploy create-teacher
  ```
  The function uses Supabase's server-provided service-role secret; never put that key in `config.js` or browser code. Configure Supabase Auth email/SMTP so invitation links can be delivered.
3. **Config**: edit `config.js` with the Project URL and anon key (Project Settings -> API) and the institute name.
4. **Host** the folder as a static site (HTTPS is required for GPS): Cloudflare Pages, Netlify or GitHub Pages, all free. Drag-and-drop the folder.
5. **Set up branches**: sign in as admin -> Branches -> choose a branch or Add branch. Set its coordinates (use "Use my current location" while inside that institute), radius and working days, then save. Assign teachers in the separate team section. Teacher invitations are sent from the Team Access section.
6. **Schedule lectures**: open Schedule -> choose a lecture/batch name, branch, teacher, and date. Enter start/end times only when fixed; leave both blank for flexible lectures. Overlapping fixed-time lectures for the same teacher are rejected.
7. Teachers open the site on their phone -> browser menu -> "Add to Home Screen".

## How it works
- The frontend is split into small ES modules for authentication, shared utilities, teacher screens, and admin screens. The cache version is maintained in `config.js`.
- Admins create individual dated lecture sessions. A session may have a fixed time or a flexible time.
- Check-in/out calls the `mark_attendance()` database function with a lecture ID. The server validates the teacher's lecture assignment, branch geofence, GPS accuracy and lateness; editing the JS does not bypass those checks. Out-of-geofence check-outs are allowed but flagged, and admins can close open sessions.
- Each lecture has its own attendance record, so a teacher can teach at multiple branches on the same day. Late status is calculated only for lectures with a scheduled start time.
- Approved leave is excluded from missed-lecture counts. Open sessions are reported separately and do not add completed hours.
- Leave requests use Casual, Sick, Personal, Unpaid or Other; an admin can adjust the type when reviewing a request.
- Monthly totals are calculated by a SQL function, avoiding the browser API's 1,000-row response limit. Branch-assignment replacement is transactional.
- Teacher screens: Today, Schedule, History, Leave, Account. Admin screens: Today, Schedule, Leaves, Report, Branches, Account. Monthly reports consolidate lecture counts and worked hours by teacher, across branches or for one branch.
- Account displays read-only name, email, role and branch access. Password fields are tucked under a Change password disclosure.

## Passwords
- **Account:** shows the signed-in employee's name, email, role and branch access. Change password is collapsed until opened; the current password is re-checked first. Minimum 8 characters.
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
- Admins invite teacher accounts from Branches; teachers set their own password through the emailed invitation.
- One check-in and one check-out are allowed per scheduled lecture. Corrections are made by the admin in Table Editor -> `attendance`.
- A lecture without scheduled times can still be tracked, but it cannot be automatically marked late.
