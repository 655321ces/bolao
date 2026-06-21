config = {"exact":10,"winner":5,"goal_difference":3,
          "goal_bonus_home":1,"goal_bonus_away":1,"floor":0,"ceiling":10}
def sign(x): return (x>0)-(x<0)
def score(bet,res,cfg):
    if bet is None: return 0,False
    ph,pa=bet; rh,ra=res
    if ph==rh and pa==ra: return cfg["exact"],True
    pts=0
    if sign(ph-pa)==sign(rh-ra):
        pts+=cfg["winner"]
        if (ph-pa)==(rh-ra): pts+=cfg["goal_difference"]
    if ph==rh: pts+=cfg["goal_bonus_home"]
    if pa==ra: pts+=cfg["goal_bonus_away"]
    return max(cfg["floor"],min(cfg["ceiling"],pts)),False

# ===== BLOCO A: MOTOR (entrada->saida fixa, nao depende de dados reais) =====
motor_cases = [
    ([2,0],[2,0],10,True,  "placar exato"),
    ([1,0],[2,1], 8,False, "direcao + saldo"),
    ([2,0],[2,1], 6,False, "direcao + gol mandante"),
    ([1,1],[2,1], 1,False, "empate errado, +1 gol visitante"),
    ([1,2],[2,1], 0,False, "direcao errada, nenhum gol coincide"),
    (None ,[3,3], 0,False, "nao palpitou"),
    ([0,0],[0,0],10,True,  "empate exato"),
    ([1,1],[2,2], 8,False, "empate certo nao-exato: empate garante saldo (5+3)"),
    ([3,0],[1,0], 6,False, "vence mandante, saldo errado, +1 gol visitante(0)"),
    ([5,0],[5,0],10,True,  "exato trava em 10"),
    ([0,2],[3,2], 1,False, "direcao errada mas acerta gols do visitante = +1"),
]
print("=== BLOCO A: motor (11 casos) ===")
okA=all(score(b,r,config)==(p,e) for b,r,p,e,_ in motor_cases)
for b,r,p,e,d in motor_cases:
    g=score(b,r,config); print(f"  [{'ok' if g==(p,e) else 'FALHOU'}] {d}: {b} vs {r} -> {g[0]}/{g[1]}")
assert okA, "BLOCO A FALHOU"
print("BLOCO A: OK\n")

# ===== BLOCO B: FUNCAO DE ORDENACAO (testa a cascata diretamente) =====
# A funcao recebe metricas ja calculadas e ordena. Testamos a PRIORIDADE dos criterios
# dando metricas montadas, sem depender de pontuacao real.
# metrica = (pontos, exatos, tendencias, gols_vencedor)
def rank_key(name, m):
    pts,ex,te,gv = m
    return (-pts,-ex,-te,-gv,name)

def ordenar(participantes):  # participantes: dict nome->metrica
    return sorted(participantes, key=lambda n: rank_key(n, participantes[n]))

print("=== BLOCO B: cascata de ordenacao ===")
okB=True
def t(desc, parts, esperado):
    global okB
    got = ordenar(parts)
    ok = got==esperado
    okB = okB and ok
    print(f"  [{'ok' if ok else 'FALHOU'}] {desc}: {got}")

# 1) Pontos mandam acima de tudo
t("pontos dominam", {"X":(10,0,0,0),"Y":(9,9,9,9)}, ["X","Y"])
# 2) Empate em pontos -> exatos decidem
t("exatos desempatam", {"X":(20,1,0,0),"Y":(20,2,0,0)}, ["Y","X"])
# 3) Empate em pontos+exatos -> tendencias decidem
t("tendencias desempatam", {"X":(20,1,3,0),"Y":(20,1,2,5)}, ["X","Y"])
# 4) Empate em pontos+exatos+tendencias -> gols do vencedor decidem
t("golsVenc desempatam", {"X":(20,1,2,1),"Y":(20,1,2,2)}, ["Y","X"])
# 5) Identicos em tudo -> empate residual, ordem estavel por nome (mas MESMA posicao na exibicao)
t("empate residual ordena por nome (estavel)", {"Bravo":(11,1,1,1),"Alfa":(11,1,1,1)}, ["Alfa","Bravo"])
assert okB, "BLOCO B FALHOU"
print("BLOCO B: OK\n")

# ===== BLOCO C: AGRUPAMENTO DE POSICOES (padrao 1-2-2-4) =====
# Empate residual deve compartilhar posicao; proxima posicao pula.
def atribuir_posicoes(parts):
    ordenados = ordenar(parts)
    pos = {}
    posicao_atual = 0
    chave_anterior = None
    for i,n in enumerate(ordenados):
        m = parts[n]
        chave = m  # metrica sem o nome: empate real = mesma metrica
        if chave != chave_anterior:
            posicao_atual = i+1   # pula conforme indice
            chave_anterior = chave
        pos[n] = posicao_atual
    return pos

print("=== BLOCO C: posicoes compartilhadas (1-2-2-4) ===")
parts = {
    "P1":(18,1,2,1),
    "P2a":(11,1,1,2), "P2b":(11,1,1,2),   # empatam -> mesma posicao
    "P4":(10,1,1,1),
}
pos = atribuir_posicoes(parts)
print("  posicoes:", {k:pos[k] for k in ordenar(parts)})
okC = pos["P1"]==1 and pos["P2a"]==2 and pos["P2b"]==2 and pos["P4"]==4
print(f"  [{'ok' if okC else 'FALHOU'}] P1=1, P2a=P2b=2, P4=4 (pulou o 3)")
assert okC, "BLOCO C FALHOU"
print("BLOCO C: OK\n")

print("==== TODOS OS BLOCOS SINTETICOS PASSARAM ====")
