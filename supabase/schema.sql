-- =========================================================
-- Tabungan Nikah Bersama — Supabase schema & RLS
-- Jalankan di Supabase Dashboard > SQL Editor (satu kali).
-- Aman dijalankan ulang (idempotent) berkat IF NOT EXISTS / OR REPLACE.
-- =========================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- TABLE: transactions
-- ---------------------------------------------------------
create table if not exists public.transactions (
  id           uuid primary key default gen_random_uuid(),
  penabung     text not null check (penabung in ('pria', 'wanita')),
  jenis        text not null check (jenis in ('pendapatan', 'pengeluaran')),
  kategori     text not null check (char_length(trim(kategori)) > 0),
  nominal      numeric(14,2) not null check (nominal > 0),
  tanggal      date not null,
  keterangan   text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists transactions_tanggal_idx on public.transactions (tanggal desc);
create index if not exists transactions_penabung_idx on public.transactions (penabung);
create index if not exists transactions_jenis_idx on public.transactions (jenis);

-- ---------------------------------------------------------
-- TABLE: settings  (single-row config, id tetap = 1)
-- ---------------------------------------------------------
create table if not exists public.settings (
  id            smallint primary key default 1,
  target_amount numeric(14,2) not null default 0 check (target_amount >= 0),
  updated_at    timestamptz not null default now(),
  constraint settings_singleton check (id = 1)
);

insert into public.settings (id, target_amount)
values (1, 150000000)
on conflict (id) do nothing;

-- ---------------------------------------------------------
-- Trigger: auto-update updated_at
-- ---------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_transactions_updated_at on public.transactions;
create trigger trg_transactions_updated_at
  before update on public.transactions
  for each row execute function public.set_updated_at();

drop trigger if exists trg_settings_updated_at on public.settings;
create trigger trg_settings_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------
-- ROW LEVEL SECURITY
-- Hanya user yang sudah login (authenticated) di project Supabase
-- ini yang boleh membaca/menulis. Karena hanya Anda & pasangan yang
-- akan dibuatkan akun secara manual di Supabase Dashboard, kebijakan
-- "authenticated" sudah cukup untuk data bersama — tidak terbuka publik.
-- ---------------------------------------------------------
alter table public.transactions enable row level security;
alter table public.settings enable row level security;

drop policy if exists "transactions_select_authenticated" on public.transactions;
create policy "transactions_select_authenticated"
  on public.transactions for select
  to authenticated
  using (true);

drop policy if exists "transactions_insert_authenticated" on public.transactions;
create policy "transactions_insert_authenticated"
  on public.transactions for insert
  to authenticated
  with check (true);

drop policy if exists "transactions_update_authenticated" on public.transactions;
create policy "transactions_update_authenticated"
  on public.transactions for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "transactions_delete_authenticated" on public.transactions;
create policy "transactions_delete_authenticated"
  on public.transactions for delete
  to authenticated
  using (true);

drop policy if exists "settings_select_authenticated" on public.settings;
create policy "settings_select_authenticated"
  on public.settings for select
  to authenticated
  using (true);

drop policy if exists "settings_update_authenticated" on public.settings;
create policy "settings_update_authenticated"
  on public.settings for update
  to authenticated
  using (true)
  with check (true);

-- Catatan: tidak ada policy untuk role "anon" sama sekali, sehingga
-- siapa pun yang belum login (termasuk lewat anon key) tidak bisa
-- membaca maupun menulis data. Ini yang mencegah database "terbuka
-- untuk publik".

-- ---------------------------------------------------------
-- Realtime: pastikan tabel ini termasuk dalam publication supabase_realtime
-- (biasanya sudah default di project baru; baris di bawah aman dijalankan ulang)
-- ---------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'transactions'
  ) then
    execute 'alter publication supabase_realtime add table public.transactions';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'settings'
  ) then
    execute 'alter publication supabase_realtime add table public.settings';
  end if;
end $$;

-- ---------------------------------------------------------
-- SEED DATA CONTOH (OPSIONAL — TIDAK DIJALANKAN OTOMATIS OLEH APLIKASI)
-- Uncomment & jalankan manual di SQL Editor jika ingin data contoh.
-- ---------------------------------------------------------
-- insert into public.transactions (penabung, jenis, kategori, nominal, tanggal, keterangan)
-- values
--   ('pria',   'pendapatan', 'Gaji Bulanan', 5000000, current_date, 'Contoh data — silakan hapus'),
--   ('wanita', 'pendapatan', 'Bonus Kerja',  3500000, current_date, 'Contoh data — silakan hapus');