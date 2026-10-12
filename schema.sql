-- Teacher Attendance: Supabase (free tier) schema
-- Run this whole file once in Supabase -> SQL Editor.

create extension if not exists pgcrypto;

-- ---------- Tables ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role text not null default 'teacher' check (role in ('teacher','admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  institute_lat double precision not null default 0,
  institute_lng double precision not null default 0,
  radius_m int not null default 150,
  max_accuracy_m int not null default 100,          -- reject very imprecise GPS fixes
  shift_start time not null default '09:00',
  shift_end time not null default '18:00',
  late_grace_min int not null default 10,
  working_days int[] not null default '{1,2,3,4,5,6}' -- ISO dow: 1=Mon ... 7=Sun
);
insert into public.settings (id) values (1) on conflict do nothing;

-- ---------- Institute branches ----------
create table if not exists public.institute_sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  institute_lat double precision not null default 0,
  institute_lng double precision not null default 0,
  radius_m int not null default 150,
  max_accuracy_m int not null default 100,
  shift_start time not null default '09:00',
  shift_end time not null default '18:00',
  late_grace_min int not null default 10,
  working_days int[] not null default '{1,2,3,4,5,6}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.institute_sites'::regclass and conname = 'institute_sites_latitude_range') then
    alter table public.institute_sites add constraint institute_sites_latitude_range check (institute_lat between -90 and 90);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.institute_sites'::regclass and conname = 'institute_sites_longitude_range') then
    alter table public.institute_sites add constraint institute_sites_longitude_range check (institute_lng between -180 and 180);
  end if;
end $$;

-- Preserve the existing single institute as the first branch.
insert into public.institute_sites (name, institute_lat, institute_lng, radius_m, max_accuracy_m,
                                    shift_start, shift_end, late_grace_min, working_days)
select 'Main institute', institute_lat, institute_lng, radius_m, max_accuracy_m,
       shift_start, shift_end, late_grace_min, working_days
from public.settings where id = 1
  and not exists (select 1 from public.institute_sites);

create table if not exists public.site_assignments (
  site_id uuid not null references public.institute_sites(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  primary key (site_id, teacher_id)
);

create table if not exists public.lecture_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  teacher_id uuid not null references public.profiles(id),
  site_id uuid not null references public.institute_sites(id),
  session_date date not null,
  start_time time,
  end_time time,
  late_grace_min int not null default 10 check (late_grace_min >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check ((start_time is null and end_time is null) or (start_time is not null and end_time > start_time))
);

create or replace function public.prevent_teacher_lecture_overlap() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.active and new.start_time is not null then
    perform pg_advisory_xact_lock(hashtext(new.teacher_id::text)::bigint);
    if exists (
      select 1 from public.lecture_sessions existing
      where existing.teacher_id = new.teacher_id and existing.session_date = new.session_date
        and existing.active and existing.start_time is not null and existing.id <> new.id
        and existing.start_time < new.end_time and existing.end_time > new.start_time
    ) then
      raise exception 'This teacher already has a lecture during that time.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists prevent_teacher_lecture_overlap on public.lecture_sessions;
create trigger prevent_teacher_lecture_overlap before insert or update of teacher_id, site_id, session_date, start_time, end_time, active
  on public.lecture_sessions for each row execute function public.prevent_teacher_lecture_overlap();

-- Existing teachers keep access to the initial branch after upgrading.
insert into public.site_assignments (site_id, teacher_id)
select (select id from public.institute_sites order by created_at limit 1), p.id
from public.profiles p
where p.role = 'teacher'
  and not exists (select 1 from public.site_assignments a where a.teacher_id = p.id);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid references public.lecture_sessions(id),
  site_id uuid references public.institute_sites(id),
  work_date date not null,
  check_in timestamptz,
  check_in_dist_m int,
  check_out timestamptz,
  check_out_dist_m int,
  check_out_outside_geofence boolean not null default false,
  check_out_admin boolean not null default false,
  is_late boolean not null default false
);

alter table public.attendance add column if not exists session_id uuid references public.lecture_sessions(id);
alter table public.attendance add column if not exists check_out_outside_geofence boolean not null default false;
alter table public.attendance add column if not exists check_out_admin boolean not null default false;
do $$
declare
  daily_unique record;
begin
  for daily_unique in
    select conname from pg_constraint
    where conrelid = 'public.attendance'::regclass and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (teacher_id, work_date)'
  loop
    execute format('alter table public.attendance drop constraint %I', daily_unique.conname);
  end loop;
end $$;
create unique index if not exists attendance_one_record_per_session
  on public.attendance(session_id) where session_id is not null;

alter table public.attendance add column if not exists site_id uuid references public.institute_sites(id);
update public.attendance
set site_id = (select id from public.institute_sites order by created_at limit 1)
where site_id is null;
alter table public.attendance alter column site_id set not null;

create table if not exists public.leaves (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  from_date date not null,
  to_date date not null,
  leave_type text not null default 'other' check (leave_type in ('casual','sick','personal','unpaid','other')),
  reason text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (to_date >= from_date)
);

alter table public.leaves add column if not exists leave_type text not null default 'other';
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.leaves'::regclass and conname = 'leaves_leave_type_valid') then
    alter table public.leaves add constraint leaves_leave_type_valid check (leave_type in ('casual','sick','personal','unpaid','other'));
  end if;
end $$;

-- ---------- Helpers ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin' and active);
$$;

create or replace function public.save_site_assignments(p_site_id uuid, p_teacher_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if not exists (select 1 from public.institute_sites where id = p_site_id) then raise exception 'Branch not found'; end if;
  if exists (
    select 1 from unnest(coalesce(p_teacher_ids, '{}'::uuid[])) selected(teacher_id)
    left join public.profiles p on p.id = selected.teacher_id and p.role = 'teacher' and p.active
    where p.id is null
  ) then raise exception 'A selected teacher account is unavailable'; end if;
  delete from public.site_assignments
  where site_id = p_site_id and not (teacher_id = any(coalesce(p_teacher_ids, '{}'::uuid[])));
  insert into public.site_assignments (site_id, teacher_id)
  select p_site_id, selected.teacher_id from unnest(coalesce(p_teacher_ids, '{}'::uuid[])) selected(teacher_id)
  on conflict do nothing;
end $$;

-- Auto-create a profile whenever a user is added in Supabase Auth.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Haversine distance in metres.
create or replace function public.dist_m(lat1 double precision, lng1 double precision,
                                         lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- ---------- Check-in / check-out (the ONLY way to write attendance) ----------
-- The lecture assignment and branch geofence are enforced on the server.
drop function if exists public.mark_attendance(text, double precision, double precision, double precision);
drop function if exists public.mark_attendance(text, uuid, double precision, double precision, double precision);
create or replace function public.mark_attendance(p_action text, p_session_id uuid, p_lat double precision,
                                                  p_lng double precision, p_accuracy double precision)
returns json language plpgsql security definer set search_path = public as $$
declare
  meeting lecture_sessions%rowtype;
  s institute_sites%rowtype;
  me profiles%rowtype;
  now_ist timestamp := (now() at time zone 'Asia/Kolkata');
  today date := now_ist::date;
  d int;
  rec attendance%rowtype;
  late boolean;
begin
  select * into me from profiles where id = auth.uid() and active;
  if not found then raise exception 'Account not active'; end if;
  if p_action not in ('in', 'out') then raise exception 'Invalid action'; end if;
  select * into meeting from lecture_sessions where id = p_session_id and (active or p_action = 'out');
  if not found then raise exception 'This lecture is unavailable.'; end if;
  if me.role <> 'admin' and meeting.teacher_id <> me.id then raise exception 'This lecture is not assigned to you.'; end if;
  if p_action = 'in' and me.role <> 'admin' and not exists (
    select 1 from site_assignments where site_id = meeting.site_id and teacher_id = me.id
  ) then raise exception 'You are not assigned to this institute branch.'; end if;
  if p_action = 'in' and meeting.session_date <> today then raise exception 'Check-in is only available on the lecture date.'; end if;
  select * into s from institute_sites where id = meeting.site_id and (active or p_action = 'out');
  if not found then raise exception 'Institute branch is unavailable.'; end if;

  if s.institute_lat = 0 and s.institute_lng = 0 then
    raise exception 'This branch location is not configured yet. Ask the admin.';
  end if;
  if (p_lat is null) <> (p_lng is null) then raise exception 'Incomplete location'; end if;
  if p_lat is not null and (p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180) then
    raise exception 'Invalid location coordinates';
  end if;
  if p_lat is not null then d := round(dist_m(p_lat, p_lng, s.institute_lat, s.institute_lng)); end if;

  if p_action = 'in' then
    if d is null then raise exception 'Location missing'; end if;
    if p_accuracy is null or p_accuracy > s.max_accuracy_m then
      raise exception 'GPS accuracy too low (% m). Move near a window or enable precise location.', round(coalesce(p_accuracy,-1));
    end if;
    if d > s.radius_m then
      raise exception 'You are % m from the institute (limit % m).', d, s.radius_m;
    end if;
  elsif p_action = 'out' and me.role <> 'admin' and (d is null or p_accuracy is null) then
    raise exception 'Location missing';
  end if;

  if p_action = 'in' then
    late := meeting.start_time is not null and now_ist::time > (meeting.start_time + make_interval(mins => meeting.late_grace_min));
    insert into attendance (teacher_id, session_id, site_id, work_date, check_in, check_in_dist_m, is_late)
    values (meeting.teacher_id, meeting.id, s.id, today, now(), d, late)
    on conflict do nothing
    returning * into rec;
    if not found then raise exception 'Attendance is already recorded for this lecture.'; end if;
  else
    update attendance set check_out = now(), check_out_dist_m = d,
      check_out_outside_geofence = d is null or d > s.radius_m or coalesce(p_accuracy > s.max_accuracy_m, true),
      check_out_admin = me.role = 'admin'
    where session_id = meeting.id and teacher_id = meeting.teacher_id and check_in is not null and check_out is null
    returning * into rec;
    if not found then raise exception 'No open check-in for today.'; end if;
  end if;

  return row_to_json(rec);
end $$;

drop function if exists public.admin_day_status(date);
drop function if exists public.admin_day_status(date, uuid);
drop function if exists public.admin_monthly_report(int, int);
drop function if exists public.admin_monthly_report(int, int, uuid);

create or replace function public.admin_monthly_report(p_year int, p_month int, p_site_id uuid default null)
returns table (teacher_id uuid, full_name text, lectures int, attended int, late int, missed int,
               open_sessions int, leave_days int, hours_worked numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  month_start date;
  month_end date;
  report_today date := (now() at time zone 'Asia/Kolkata')::date;
  now_ist timestamp := now() at time zone 'Asia/Kolkata';
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_month < 1 or p_month > 12 then raise exception 'Invalid report month'; end if;
  month_start := make_date(p_year, p_month, 1);
  month_end := (month_start + interval '1 month')::date;

  return query
  with session_rows as (
    select ls.teacher_id, p.full_name, ls.session_date, ls.start_time, ls.late_grace_min,
      a.check_in, a.check_out, a.is_late,
      exists (select 1 from public.leaves l where l.teacher_id = ls.teacher_id and l.status = 'approved'
              and ls.session_date between l.from_date and l.to_date) as on_leave
    from public.lecture_sessions ls
    join public.profiles p on p.id = ls.teacher_id
    left join public.attendance a on a.session_id = ls.id
    where ls.active and ls.session_date >= month_start and ls.session_date < month_end
      and ls.session_date <= report_today and (p_site_id is null or ls.site_id = p_site_id)
  )
  select sr.teacher_id, sr.full_name, count(*)::int,
    count(*) filter (where sr.check_in is not null)::int,
    count(*) filter (where sr.is_late)::int,
    count(*) filter (where sr.check_in is null and not sr.on_leave and
      (sr.session_date < report_today or (sr.session_date = report_today and sr.start_time is not null and
       now_ist::time > sr.start_time + make_interval(mins => sr.late_grace_min))))::int,
    count(*) filter (where sr.check_in is not null and sr.check_out is null)::int,
    count(distinct sr.session_date) filter (where sr.on_leave)::int,
    round(coalesce(sum(extract(epoch from (sr.check_out - sr.check_in)) / 3600.0)
      filter (where sr.check_in is not null and sr.check_out is not null), 0)::numeric, 1)
  from session_rows sr
  group by sr.teacher_id, sr.full_name
  order by sr.full_name;
end $$;

-- ---------- Row Level Security ----------
alter table profiles   enable row level security;
alter table settings   enable row level security;
alter table institute_sites enable row level security;
alter table site_assignments enable row level security;
alter table lecture_sessions enable row level security;
alter table attendance enable row level security;
alter table leaves     enable row level security;

-- profiles
drop policy if exists "read own or admin" on profiles;
drop policy if exists "admin updates" on profiles;
create policy "read own or admin"  on profiles for select using (id = auth.uid() or is_admin());
create policy "admin updates"      on profiles for update using (is_admin());

-- settings (everyone signed in can read; only admin edits)
drop policy if exists "read settings" on settings;
drop policy if exists "admin edits settings" on settings;
create policy "read settings"      on settings for select using (auth.uid() is not null);
create policy "admin edits settings" on settings for update using (is_admin());

-- Branches and teacher-to-branch assignments.
drop policy if exists "read assigned sites or admin" on institute_sites;
drop policy if exists "admin manages sites" on institute_sites;
create policy "read assigned sites or admin" on institute_sites for select using (
  is_admin() or (active and exists (
    select 1 from site_assignments a where a.site_id = institute_sites.id and a.teacher_id = auth.uid()
  ))
);
create policy "admin manages sites" on institute_sites for all using (is_admin()) with check (is_admin());
drop policy if exists "read own site assignments or admin" on site_assignments;
drop policy if exists "admin manages site assignments" on site_assignments;
create policy "read own site assignments or admin" on site_assignments for select using (
  teacher_id = auth.uid() or is_admin()
);
create policy "admin manages site assignments" on site_assignments for all using (is_admin()) with check (is_admin());

drop policy if exists "teachers read assigned lectures or admin" on lecture_sessions;
drop policy if exists "admin manages lectures" on lecture_sessions;
create policy "teachers read assigned lectures or admin" on lecture_sessions for select using (
  is_admin() or teacher_id = auth.uid()
);
create policy "admin manages lectures" on lecture_sessions for all using (is_admin()) with check (is_admin());

-- attendance: read-only from the client; writes go through mark_attendance()
drop policy if exists "own or admin read" on attendance;
drop policy if exists "admin corrects" on attendance;
drop policy if exists "admin inserts" on attendance;
create policy "own or admin read"  on attendance for select using (teacher_id = auth.uid() or is_admin());
create policy "admin corrects"     on attendance for update using (is_admin());
create policy "admin inserts"      on attendance for insert with check (is_admin());

-- leaves
drop policy if exists "own or admin read" on leaves;
drop policy if exists "teacher applies" on leaves;
drop policy if exists "admin decides" on leaves;
create policy "own or admin read"  on leaves for select using (teacher_id = auth.uid() or is_admin());
create policy "teacher applies"    on leaves for insert with check (teacher_id = auth.uid() and status = 'pending');
create policy "admin decides"      on leaves for update using (is_admin());

grant execute on function public.mark_attendance(text, uuid, double precision, double precision, double precision) to authenticated;
revoke all on function public.save_site_assignments(uuid, uuid[]) from public;
grant execute on function public.save_site_assignments(uuid, uuid[]) to authenticated;
revoke all on function public.admin_monthly_report(int, int, uuid) from public;
grant execute on function public.admin_monthly_report(int, int, uuid) to authenticated;

-- ---------- After creating your own account in Auth -> Users, make yourself admin: ----------
-- update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'ADMIN_EMAIL_HERE');
-- Assign teachers to branches in the admin screen, then set each branch's location there.

notify pgrst, 'reload schema';
