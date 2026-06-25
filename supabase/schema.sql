-- ============================================================
-- Bolão — schema + RLS do Supabase
-- Rodar UMA VEZ no SQL editor do projeto. Depois rode supabase/seed-games.sql
-- para popular a tabela games. Idempotente: pode rodar de novo sem quebrar.
--
-- Modelo de confiança: a trava de horário e a visibilidade dos palpites são
-- impostas pelo RLS usando now() (relógio do servidor) — o cliente não burla.
-- ============================================================

-- ---------- profiles: 1 login Google = 1 pessoa ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists profiles_select_authenticated on public.profiles;
create policy profiles_select_authenticated on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- cria o profile automaticamente quando alguém entra pela 1ª vez (nome vem do Google)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(coalesce(new.email, 'participante'), '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Auto-cura: o trigger acima só roda no 1º cadastro. Este RPC é chamado a cada
-- login (palpites.js) e recria o profile se ele faltar (ex.: linha apagada à mão),
-- restaurando o nome canônico já reivindicado no roster. Idempotente.
create or replace function public.ensure_profile()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    auth.uid(),
    coalesce(
      (select r.canonical_name from public.roster r where r.claimed_by = auth.uid()),
      (select coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name',
                       split_part(coalesce(u.email, 'participante'), '@', 1))
         from auth.users u where u.id = auth.uid())
    )
  )
  on conflict (id) do nothing;
end;
$$;

-- ---------- games: semeado de fixtures.json (ver seed-games.sql) ----------
create table if not exists public.games (
  id       int primary key,
  home     text not null,
  away     text not null,
  kickoff  timestamptz not null,
  locks_at timestamptz not null,  -- = kickoff por padrão; ajustável p/ antecedência
  round    int not null,
  grp      text not null
);

alter table public.games enable row level security;

drop policy if exists games_select_authenticated on public.games;
create policy games_select_authenticated on public.games
  for select to authenticated using (true);
-- escrita de games só via service role / SQL editor (sem policy de insert/update aqui)

-- ---------- bets: o palpite de cada pessoa por jogo ----------
-- Linha existente = palpitou. Sem linha = não palpitou (= null no engine).
create table if not exists public.bets (
  user_id    uuid not null references auth.users(id) on delete cascade,
  game_id    int  not null references public.games(id) on delete cascade,
  home       int  not null check (home between 0 and 99),
  away       int  not null check (away between 0 and 99),
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);

create index if not exists bets_game_idx on public.bets(game_id);

alter table public.bets enable row level security;

-- jogo ainda aberto p/ palpite? (relógio do servidor)
create or replace function public.game_open(p_game_id int)
returns boolean
language sql stable
as $$
  select now() < g.locks_at from public.games g where g.id = p_game_id;
$$;

-- SELECT: você sempre vê o seu; os dos outros só depois da trava (evita cópia)
drop policy if exists bets_select_visibility on public.bets;
create policy bets_select_visibility on public.bets
  for select to authenticated
  using (user_id = auth.uid() or not public.game_open(game_id));

-- INSERT: só o seu e só antes da trava
drop policy if exists bets_insert_own_open on public.bets;
create policy bets_insert_own_open on public.bets
  for insert to authenticated
  with check (user_id = auth.uid() and public.game_open(game_id));

-- UPDATE: só o seu e só antes da trava (não edita depois do apito)
drop policy if exists bets_update_own_open on public.bets;
create policy bets_update_own_open on public.bets
  for update to authenticated
  using (user_id = auth.uid() and public.game_open(game_id))
  with check (user_id = auth.uid() and public.game_open(game_id));

-- DELETE: só o seu e só antes da trava
drop policy if exists bets_delete_own_open on public.bets;
create policy bets_delete_own_open on public.bets
  for delete to authenticated
  using (user_id = auth.uid() and public.game_open(game_id));

-- updated_at sempre atual
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists bets_touch on public.bets;
create trigger bets_touch before update on public.bets
  for each row execute function public.touch_updated_at();

-- ---------- results: placares (ao vivo + final), escritos pelo Worker ----------
-- O Cloudflare Worker faz upsert aqui a partir da football-data.org (ver
-- tools/scheduler/worker.js). status: IN_PLAY/PAUSED enquanto rola; FINISHED no fim.
-- Diferente das demais, o SELECT é liberado para `anon`: o ranking público
-- (index.html) é SEM login e lê esta tabela direto. Placar é informação pública.
-- Escrita só via service_role (sem policy de insert/update aqui).
create table if not exists public.results (
  game_id    int  primary key references public.games(id) on delete cascade,
  home       int  not null check (home between 0 and 99),
  away       int  not null check (away between 0 and 99),
  status     text not null default 'FINISHED',  -- IN_PLAY | PAUSED | FINISHED
  minute     int,
  updated_at timestamptz not null default now()
);

alter table public.results enable row level security;

drop policy if exists results_select_public on public.results;
create policy results_select_public on public.results
  for select to anon, authenticated using (true);

-- ---------- roster: identidades canônicas (auto-reivindicação) ----------
-- Semeado com os participantes históricos (ver seed-roster.sql). No 1º login a
-- pessoa escolhe "sou eu = Fulano", o que liga a conta Google ao nome canônico
-- usado no ranking — assim história (bets.json) e futuro batem sob 1 identidade.
create table if not exists public.roster (
  canonical_name text primary key,
  claimed_by     uuid unique references auth.users(id) on delete set null
);

alter table public.roster enable row level security;

-- todos os autenticados leem o roster (para ver os nomes ainda livres)
drop policy if exists roster_select_authenticated on public.roster;
create policy roster_select_authenticated on public.roster
  for select to authenticated using (true);
-- escrita só via claim_identity() (RPC security definer); sem policy de update aqui

-- reivindica um nome canônico (atômico): solta o anterior, pega o novo se livre,
-- e aplica em profiles.display_name. Recusa nome inexistente ou já tomado.
create or replace function public.claim_identity(p_name text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  -- solta qualquer nome que esta pessoa já tivesse (permite trocar)
  update public.roster set claimed_by = null where claimed_by = auth.uid();
  -- pega o novo só se estiver livre
  update public.roster set claimed_by = auth.uid()
   where canonical_name = p_name and claimed_by is null;
  if not found then
    raise exception 'Nome "%" indisponível ou inexistente', p_name;
  end if;
  -- aplica o nome canônico no profile
  update public.profiles set display_name = p_name where id = auth.uid();
end;
$$;
