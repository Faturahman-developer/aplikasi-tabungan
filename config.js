/* =========================================================
   KONFIGURASI SUPABASE
   =========================================================
   Isi dua nilai di bawah dengan milik project Supabase Anda.
   Keduanya AMAN untuk ditaruh di frontend selama Row Level
   Security (RLS) sudah aktif (lihat supabase/schema.sql dan
   SETUP.md) — anon/publishable key TIDAK memberi akses ke data
   kecuali lewat policy RLS yang sudah dibatasi untuk user yang
   sudah login (authenticated).

   JANGAN PERNAH menaruh "service_role key" di sini atau di file
   manapun yang dikirim ke browser. Service role key membypass RLS
   sepenuhnya dan hanya boleh dipakai di server/back-end tepercaya.

   Cara mendapatkan nilai ini: lihat SETUP.md bagian
   "Cara mendapatkan Supabase URL & anon key".
   ========================================================= */
window.SUPABASE_CONFIG = {
  url: 'https://gdbgzfsoxxmfoiegeees.supabase.co',
  anonKey: 'sb_publishable_Rod9jczOLZpN2YIwakS9hw_YxyQCOlF',
};