/* ============================================================
   Bolão — configuração pública do Supabase
   ------------------------------------------------------------
   PREENCHA os dois valores abaixo com os do SEU projeto:
   Painel do Supabase → Project Settings → Data API (ou API).
     - Project URL      → SUPABASE_URL
     - Project API keys → anon / public  → SUPABASE_ANON_KEY

   A anon key é PÚBLICA por design e pode ser commitada: ela só permite o que
   as policies de RLS deixarem (ver supabase/schema.sql). Quem protege os dados
   é o RLS, não o segredo da chave. NUNCA coloque aqui a chave service_role.
   ============================================================ */
window.SUPABASE_CONFIG = {
  url: 'https://hcdyimqnrkxtjwvptwgy.supabase.co',
  anonKey: 'CeyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhjZHlpbXFucmt4dGp3dnB0d2d5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzUwMDgsImV4cCI6MjA5NzY1MTAwOH0.taJgZdUpeenyAEliMCKJbn9eNvAgximdwcR70uosgYo',
};
