-- Gerado de data/bets.json (nomes canonicos, aliases resolvidos) -- regenerar se entrar gente nova.
-- Semeia os participantes para a auto-reivindicacao de identidade (palpites.html).
insert into public.roster (canonical_name) values
  ('Alexandre Nassif'),
  ('Andres Vera'),
  ('Bruno Henrique'),
  ('Camilo Thomas'),
  ('Carolina Argento'),
  ('Cesar Santos'),
  ('David'),
  ('Drinho'),
  ('Fabio Scaringella'),
  ('Gabriel Portella'),
  ('Igor Bammesberger'),
  ('Joao Ajaj'),
  ('Juliana ajaj'),
  ('Pepo Costa'),
  ('Polvo Fernando')
on conflict (canonical_name) do nothing;