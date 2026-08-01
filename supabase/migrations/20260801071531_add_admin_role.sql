-- Generated with Supabase CLI 2.111.0.
alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('customer', 'staff', 'admin'));

comment on column public.profiles.role is 'Application role: customer, staff, or admin';
