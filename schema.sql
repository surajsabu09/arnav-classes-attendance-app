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

-- Existing teachers keep access to the initial branch after upgrading.
insert into public.site_assignments (site_id, teacher_id)
select (select id from public.institute_sites order by created_at limit 1), p.id
from public.profiles p
where p.role = 'teacher'
  and not exists (select 1 from public.site_assignments a where a.teacher_id = p.id);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  site_id uuid references public.institute_sites(id),
  work_date date not null,
  check_in timestamptz,
  check_in_dist_m int,
  check_out timestamptz,
  check_out_dist_m int,
  is_late boolean not null default false,
  unique (teacher_id, work_date)
);

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
  reason text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (to_date >= from_date)
);

-- ---------- Helpers ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin' and active);
$$;

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
-- The geofence and teacher's branch assignment are enforced on the server.
drop function if exists public.mark_attendance(text, double precision, double precision, double precision);
create or replace function public.mark_attendance(p_action text, p_site_id uuid, p_lat double precision,
                                                  p_lng double precision, p_accuracy double precision)
returns json language plpgsql security definer set search_path = public as $$
declare
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
  select * into s from institute_sites where id = p_site_id and (active or p_action = 'out');
  if not found then raise exception 'Institute branch is unavailable.'; end if;
  if me.role <> 'admin' and not exists (
    select 1 from site_assignments where site_id = s.id and teacher_id = me.id
  ) then raise exception 'You are not assigned to this institute branch.'; end if;

  if s.institute_lat = 0 and s.institute_lng = 0 then
    raise exception 'This branch location is not configured yet. Ask the admin.';
  end if;
  if p_lat is null or p_lng is null then raise exception 'Location missing'; end if;
  if p_accuracy is null or p_accuracy > s.max_accuracy_m then
    raise exception 'GPS accuracy too low (% m). Move near a window or enable precise location.', round(coalesce(p_accuracy,-1));
  end if;

  d := round(dist_m(p_lat, p_lng, s.institute_lat, s.institute_lng));
  if d > s.radius_m then
    raise exception 'You are % m from the institute (limit % m).', d, s.radius_m;
  end if;

  if p_action = 'in' then
    late := now_ist::time > (s.shift_start + make_interval(mins => s.late_grace_min));
    insert into attendance (teacher_id, site_id, work_date, check_in, check_in_dist_m, is_late)
    values (me.id, s.id, today, now(), d, late)
    on conflict do nothing
    returning * into rec;
    if not found then raise exception 'Already checked in today.'; end if;
  elsif p_action = 'out' then
    update attendance set check_out = now(), check_out_dist_m = d
    where teacher_id = me.id and site_id = s.id and work_date = today and check_in is not null and check_out is null
    returning * into rec;
    if not found then raise exception 'No open check-in for today.'; end if;
  else
    raise exception 'Invalid action';
  end if;

  return row_to_json(rec);
end $$;

-- ---------- Admin reports ----------
-- One row per active teacher for a given day: present / late / on_leave / absent / off_day / pending
drop function if exists public.admin_day_status(date);
create or replace function public.admin_day_status(p_date date, p_site_id uuid)
returns table (teacher_id uuid, full_name text, status text, check_in timestamptz, check_out timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  s institute_sites%rowtype;
  now_ist timestamp := (now() at time zone 'Asia/Kolkata');
  is_working boolean;
  cutoff timestamp;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  select * into s from institute_sites where id = p_site_id and active;
  if not found then raise exception 'Institute branch is unavailable.'; end if;
  is_working := extract(isodow from p_date)::int = any (s.working_days);
  cutoff := p_date + s.shift_start + make_interval(mins => s.late_grace_min);

  return query
  select p.id, p.full_name,
    case
      when a.check_in is not null and a.is_late then 'late'
      when a.check_in is not null then 'present'
      when exists (select 1 from leaves l where l.teacher_id = p.id and l.status = 'approved'
                   and p_date between l.from_date and l.to_date) then 'on_leave'
      when not is_working then 'off_day'
      when p_date = now_ist::date and now_ist <= cutoff then 'pending'
      else 'absent'
    end,
    a.check_in, a.check_out
  from profiles p
  join site_assignments sa on sa.teacher_id = p.id and sa.site_id = s.id
  left join attendance a on a.teacher_id = p.id and a.site_id = s.id and a.work_date = p_date
  where p.role = 'teacher' and p.active
  order by p.full_name;
end $$;

-- Monthly summary per teacher.
drop function if exists public.admin_monthly_report(int, int);
create or replace function public.admin_monthly_report(p_year int, p_month int, p_site_id uuid)
returns table (teacher_id uuid, full_name text, working_days int, present int, late int,
               leave_days int, absent int, hours_worked numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  s institute_sites%rowtype;
  first_day date := make_date(p_year, p_month, 1);
  last_day date := least((make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date,
                         (now() at time zone 'Asia/Kolkata')::date);
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  select * into s from institute_sites where id = p_site_id and active;
  if not found then raise exception 'Institute branch is unavailable.'; end if;

  return query
  with days as (
    select g::date as d from generate_series(first_day, last_day, interval '1 day') g
    where extract(isodow from g)::int = any (s.working_days)
  ),
  t as (
    select p.id, p.full_name as nm from profiles p
    join site_assignments sa on sa.teacher_id = p.id and sa.site_id = s.id
    where p.role = 'teacher' and p.active
  ),
  grid as (
    select t.id, t.nm, days.d,
      a.check_in, a.check_out, a.is_late,
      exists (select 1 from leaves l where l.teacher_id = t.id and l.status = 'approved'
              and days.d between l.from_date and l.to_date) as on_leave
    from t cross join days
    left join attendance a on a.teacher_id = t.id and a.site_id = s.id and a.work_date = days.d
  )
  select g.id, g.nm,
    count(*)::int,
    count(*) filter (where g.check_in is not null)::int,
    count(*) filter (where g.is_late)::int,
    count(*) filter (where g.check_in is null and g.on_leave)::int,
    count(*) filter (where g.check_in is null and not g.on_leave)::int,
    coalesce(round(sum(extract(epoch from (g.check_out - g.check_in)) / 3600.0)::numeric, 1), 0)
  from grid g group by g.id, g.nm order by g.nm;
end $$;

-- ---------- Row Level Security ----------
alter table profiles   enable row level security;
alter table settings   enable row level security;
alter table institute_sites enable row level security;
alter table site_assignments enable row level security;
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
grant execute on function public.admin_day_status(date, uuid) to authenticated;
grant execute on function public.admin_monthly_report(int, int, uuid) to authenticated;

-- ---------- After creating your own account in Auth -> Users, make yourself admin: ----------
-- update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'ADMIN_EMAIL_HERE');
-- Assign teachers to branches in the admin screen, then set each branch's location there.
