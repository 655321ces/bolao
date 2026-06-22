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
