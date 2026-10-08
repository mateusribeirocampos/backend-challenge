# Teste de carga

> Gerado por `bun run test:load` em 2026-10-08T12:00:03.891Z. Não editar à mão: uma nova execução reescreve este arquivo. Os números valem para a máquina descrita em "Ambiente". Os dados brutos ficam em `load-results/` (fora do git).

## Resumo

- **Correção:** as 35 verificações passaram nos 3 cenários: saldo igual ao ledger e ao esperado pelas respostas, nenhum saldo negativo, nenhum efeito duplicado, nada pendente, filas vazias, outbox drenada e todo evento entregue.
- **Wallets distintas:** de 208,7 aceitas/s com 1 cliente até 1.020,5/s com 64 clientes; com 64 clientes, p99 de 181,9 ms.
- **Hot wallet:** no máximo 307,8 aceitas/s (com 8 clientes); com 64 clientes, 192,0/s e p99 de 1.049,2 ms. O lock da linha serializa a wallet, como esperado.
- **Misto em taxa fixa:** 80,0 requisições HTTP aceitas/s com p99 de 9,9 ms; pelo SQS, do envio ao processamento, p99 de 102,0 ms; atraso da outbox p99 de 0,52 s.
- **Outbox:** no passo mais pesado do cenário 1 foram gravados 2.039,3 eventos/s e publicados 365,5/s, e a publicação levou 35,22 s para alcançar a escrita depois da carga. Neste ambiente a publicação é a parte mais lenta (análise abaixo).
- **Erros:** 0 respostas 503, 0 outros 5xx, 0 requisições sem resposta e 0 conflitos de lock em todo o teste. Os 422 são respostas de negócio esperadas (segundo REFUND da mesma aposta).

## Ambiente

| Item | Valor |
| --- | --- |
| CPU | AMD Ryzen 7 5825U with Radeon Graphics, 16 núcleos lógicos |
| Memória | 15,0 GiB |
| Sistema | Policorp OEM. (Debian GNU/Linux 12), kernel Linux 6.10.7-policorp-amd64 |
| Bun | 1.4.2 |
| Banco | PostgreSQL 17.11 (docker compose, sem limite de CPU); `fsync` on, `max_connections` 100, `shared_buffers` 128MB, `synchronous_commit` on, `wal_level` replica |
| SQS | MiniStack 1.5.22 (light) (docker compose, sem limite de CPU). `SendMessage` FIFO com 8 remetentes: 1.793,6/s nas primeiras 1.000 mensagens, 729,0/s depois de 6.000 |
| Instâncias da aplicação | 3 processos `src/main.ts`, cada um com HTTP, consumer SQS, publisher da outbox e worker de PENDING_REFERENCE |
| Pool de conexões | 10 por instância para HTTP e consumer (30 no total) e 3 para publisher e worker; espera máxima por conexão de 2.000 ms |
| `lock_timeout` | 2s |
| Consumer SQS | visibility timeout 30 s, long poll 10 s, até 10 mensagens por receive |
| Publisher da outbox | lease 30 s, lote de 20 eventos, pausa de 500 ms quando não há o que publicar |

Tudo roda na mesma máquina: as instâncias, o PostgreSQL, o MiniStack e o gerador de carga disputam os mesmos núcleos. A configuração das instâncias é a padrão do projeto; só o banco, as filas e a porta mudam.

## Metodologia

- **Sistema sob teste:** um banco só do teste (`wagering_load`), apagado e recriado com as migrations a cada execução, e filas FIFO próprias (entrada, DLQ e eventos). As requisições HTTP vão para as instâncias em rodízio.
- **Aquecimento:** antes do primeiro cenário, 4 s de apostas não medidas. Cada passo tem ainda 2 s de aquecimento, descartados, antes da janela medida.
- **Cenários 1 e 2 (laço fechado):** passos de 1, 8, 64 clientes, 6 s medidos por passo. Cada cliente manda uma BET de 1,00, espera a resposta e manda a próxima, então a carga oferecida é o número de clientes. No cenário 1 cada cliente tem a sua wallet; no 2, todos usam a mesma wallet.
- **Cenário 3 (laço aberto, taxa fixa):** 40 rodadas HTTP e 10 rodadas SQS iniciadas por segundo, por 15 s medidos, sobre 20 wallets. Uma rodada começa no seu horário mesmo que a anterior não tenha terminado: lentidão não reduz a carga oferecida.
- **Cliente:** um provedor bem comportado. Em `503` espera o `Retry-After` e reenvia o mesmo corpo com a mesma `Idempotency-Key`; em erro de conexão tenta a próxima instância. Cada tentativa conta como uma requisição.
- **Latência do cliente:** de `fetch()` até o fim do corpo da resposta (`performance.now()`), para toda requisição iniciada na janela medida. Percentil pelo posto mais próximo: o p99 é a latência de uma requisição que existiu, sem interpolação.
- **Latência do servidor:** estimada pelo histograma `wager_processing_duration_seconds{source="http"}` do `/metrics` (diferença entre o início e o fim da janela, somando as instâncias, interpolação linear como a do `histogram_quantile`). Serve para conferir a ordem de grandeza: dentro de um bucket o valor real é desconhecido.
- **Throughput:** respostas `2xx` (operações aceitas) iniciadas na janela, divididas pela duração da janela. `422` é resposta de negócio e aparece à parte.
- **Conflitos de concorrência:** `wager_lock_conflicts_total` do `/metrics` (lock timeout, deadlock ou falha de serialização) e o número de `503`.
- **Outbox:** o gauge `wager_outbox_lag_seconds` lido a cada 500 ms em todas as instâncias (vale o maior); o atraso de cada evento gravado na janela (`published_at - occurred_at`, do banco); eventos gravados e publicados por segundo; e a drenagem, do fim da carga até não sobrar evento sem publicar. Cada passo começa com a outbox vazia.
- **Leitor da fila de eventos:** o gerador de carga faz o papel do consumidor dos eventos (recebe e apaga), como haveria em produção, e confere que todo evento publicado chegou à fila.
- **CPU:** núcleos médios na janela, de `/proc/<pid>/stat` (instâncias) e do cgroup de cada container (PostgreSQL, MiniStack).
- **Esperas no banco:** a cada 250 ms, o estado e o evento de espera de cada conexão não ociosa (`pg_stat_activity`). `active` sem evento é CPU; `Lock:transactionid` é esperar o `COMMIT` de quem segura a linha; `idle in transaction / Client:ClientRead` é o banco esperando a aplicação mandar a próxima instrução no meio de uma transação.
- **Correção:** ao fim de cada cenário, verificações direto no banco e no SQS (tabela de cada cenário). O saldo esperado de cada wallet é calculado pelo gerador a partir das respostas, com o mesmo `Money` do domínio.
- **O que o emulador implica:** o MiniStack 1.5.22 refaz o cache de deduplicação inteiro de uma fila FIFO a cada `SendMessage` (`services/sqs.py`, `_prune_dedup`), e esse cache guarda toda mensagem dos últimos 5 minutos: cada envio fica mais caro conforme a fila recebe mensagens (medição na linha "SQS" do ambiente). Por isso a fila de eventos é recriada, com o mesmo nome e a mesma URL, antes de cada passo, com a outbox vazia e todo evento já recebido. O SQS da AWS não tem esse custo.

## Resultados

### 1. Wallets distintas (baixa disputa)

Só BET por HTTP. Cada cliente usa uma wallet só dele, então nenhuma requisição espera o lock de outra. As requisições vão para as instâncias em rodízio.

**Vazão e latência (ms)**

| Carga | Aceitas/s | p50 | p95 | p99 | máx | Servidor p50 / p95 / p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 cliente | 208,7 | 4,6 | 5,9 | 7,2 | 17,8 | 2,6 / 5,0 / 8,9 |
| 8 clientes | 844,3 | 8,6 | 14,9 | 19,8 | 55,3 | 8,1 / 21,0 / 24,4 |
| 64 clientes | 1.020,5 | 35,2 | 149,6 | 181,9 | 212,0 | 36,4 / 225,0 / 245,0 |

**Respostas e conflitos**

| Carga | Requisições | 2xx | 422 (negócio) | 503 | outros 5xx | outros 4xx | sem resposta | Conflitos de lock (HTTP / SQS) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 cliente | 1.252 | 1.252 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 8 clientes | 5.066 | 5.066 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 64 clientes | 6.123 | 6.123 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |

**Outbox (atrasos em s) e CPU (núcleos médios)**

| Carga | Eventos gravados/s | Publicados/s | Atraso p50 / p99 / máx | Gauge máx | Drenagem | CPU instâncias | CPU PostgreSQL | CPU MiniStack | CPU gerador |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 cliente | 417,7 | 310,5 | 1,64 / 2,61 / 2,63 | 2,59 | 2,64 | 0,34 + 0,18 + 0,37 | 0,64 | 0,76 | 0,26 |
| 8 clientes | 1.688,3 | 326,2 | 15,56 / 28,83 / 29,16 | 29,00 | 29,21 | 1,02 + 1,11 + 1,00 | 3,45 | 1,19 | 0,41 |
| 64 clientes | 2.039,3 | 365,5 | 16,14 / 34,40 / 34,89 | 34,91 | 35,22 | 1,19 + 1,23 + 1,17 | 3,82 | 1,31 | 0,36 |

**Onde as conexões ocupadas do PostgreSQL estavam (amostras de `pg_stat_activity` a cada 250 ms)**

| Carga | Estado / espera mais frequentes |
| --- | --- |
| 1 cliente | active 47,2%; idle in transaction / Client:ClientRead 33,3%; idle in transaction 13,9%; idle in transaction / IO:WalSync 2,8%; active / IO:WalSync 2,8% |
| 8 clientes | idle in transaction / Client:ClientRead 47,5%; active 32,6%; active / Client:ClientRead 7,7%; idle in transaction 7,2%; active / IO:WalSync 3,9% |
| 64 clientes | idle in transaction / Client:ClientRead 80,4%; active 9,8%; idle in transaction 5,2%; active / Client:ClientRead 2,9%; active / IO:WalSync 1,0% |

**Correção depois da carga**

| Verificação | Resultado | Detalhe |
| --- | --- | --- |
| Saldo de cada wallet = saldo reconstruído do ledger | ok | 64 wallets conferida(s) |
| Saldo = saldo esperado pelas respostas da API | ok | 64 wallets igual(is) ao calculado pelos clientes |
| Nenhum saldo negativo, em nenhuma versão do ledger | ok | menor balance_after 997343.00, menor saldo atual 997343.00 |
| Um lançamento por transação processada que move saldo (sem efeito duplicado) | ok | 16738 lançamentos, 16738 transações distintas no ledger, 16738 transações processadas que movem saldo |
| Transações PROCESSED no banco = operações aceitas pelas respostas | ok | banco 16674, respostas 16674 |
| Nenhuma operação gravada duas vezes (providerId + externalTransactionId) | ok | nenhuma |
| Nenhuma transação parada em PENDING_REFERENCE | ok | 0 pendentes |
| Outbox drenada (todo evento publicado) | ok | 0 eventos sem publicar |
| Todo evento da outbox chegou à fila de eventos (nenhum perdido) | ok | 33476 eventos, 0 não recebidos; cópias repetidas recebidas no run até aqui: 0 |
| Fila de entrada e DLQ vazias | ok | entrada: 0 visíveis, 0 em voo; DLQ: 0 |
| Reconciliação da API consistente em todas as wallets | ok | 64 wallets consistente(s) |

### 2. Hot wallet (alta disputa, uma wallet)

Só BET por HTTP. Todos os clientes apostam na mesma wallet, então cada transação espera o lock da linha (FOR NO KEY UPDATE) da anterior.

**Vazão e latência (ms)**

| Carga | Aceitas/s | p50 | p95 | p99 | máx | Servidor p50 / p95 / p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 cliente | 221,8 | 4,4 | 5,3 | 6,5 | 11,2 | 2,5 / 4,8 / 7,4 |
| 8 clientes | 307,8 | 17,6 | 74,9 | 128,5 | 205,2 | 18,1 / 87,1 / 178,7 |
| 64 clientes | 192,0 | 298,7 | 718,6 | 1.049,2 | 1.779,3 | 311,6 / 906,7 / 1.360,0 |

**Respostas e conflitos**

| Carga | Requisições | 2xx | 422 (negócio) | 503 | outros 5xx | outros 4xx | sem resposta | Conflitos de lock (HTTP / SQS) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 cliente | 1.331 | 1.331 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 8 clientes | 1.847 | 1.847 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 64 clientes | 1.152 | 1.152 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |

**Outbox (atrasos em s) e CPU (núcleos médios)**

| Carga | Eventos gravados/s | Publicados/s | Atraso p50 / p99 / máx | Gauge máx | Drenagem | CPU instâncias | CPU PostgreSQL | CPU MiniStack | CPU gerador |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 cliente | 444,0 | 331,5 | 1,52 / 2,31 / 2,32 | 2,28 | 2,34 | 0,25 + 0,40 + 0,18 | 0,60 | 0,74 | 0,20 |
| 8 clientes | 615,7 | 225,7 | 6,54 / 9,19 / 9,23 | 9,12 | 9,26 | 0,45 + 0,26 + 0,27 | 1,42 | 0,62 | 0,20 |
| 64 clientes | 384,0 | 139,3 | 5,58 / 5,92 / 5,92 | 5,92 | 5,87 | 0,30 + 0,18 + 0,17 | 2,32 | 0,44 | 0,13 |

**Onde as conexões ocupadas do PostgreSQL estavam (amostras de `pg_stat_activity` a cada 250 ms)**

| Carga | Estado / espera mais frequentes |
| --- | --- |
| 1 cliente | idle in transaction / Client:ClientRead 35,5%; active 25,8%; active / Client:ClientRead 16,1%; active / IO:WalSync 16,1%; idle in transaction 3,2% |
| 8 clientes | active / Lock:transactionid 74,2%; active 10,6%; idle in transaction / Client:ClientRead 9,6%; idle in transaction 3,5%; active / Client:ClientRead 1,0% |
| 64 clientes | active / Lock:transactionid 85,0%; active 7,1%; active / LWLock:BufferContent 3,2%; active / LWLock:LockManager 2,7%; idle in transaction / Client:ClientRead 1,1% |

**Correção depois da carga**

| Verificação | Resultado | Detalhe |
| --- | --- | --- |
| Saldo de cada wallet = saldo reconstruído do ledger | ok | 1 wallet conferida(s) |
| Saldo = saldo esperado pelas respostas da API | ok | 1 wallet igual(is) ao calculado pelos clientes |
| Nenhum saldo negativo, em nenhuma versão do ledger | ok | menor balance_after 994101.00, menor saldo atual 994101.00 |
| Um lançamento por transação processada que move saldo (sem efeito duplicado) | ok | 5900 lançamentos, 5900 transações distintas no ledger, 5900 transações processadas que movem saldo |
| Transações PROCESSED no banco = operações aceitas pelas respostas | ok | banco 5899, respostas 5899 |
| Nenhuma operação gravada duas vezes (providerId + externalTransactionId) | ok | nenhuma |
| Nenhuma transação parada em PENDING_REFERENCE | ok | 0 pendentes |
| Outbox drenada (todo evento publicado) | ok | 0 eventos sem publicar |
| Todo evento da outbox chegou à fila de eventos (nenhum perdido) | ok | 11800 eventos, 0 não recebidos; cópias repetidas recebidas no run até aqui: 0 |
| Fila de entrada e DLQ vazias | ok | entrada: 0 visíveis, 0 em voo; DLQ: 0 |
| Reconciliação da API consistente em todas as wallets | ok | 1 wallet consistente(s) |

### 3. Misto: HTTP e SQS em taxa fixa

Rodadas de BET seguidas de WIN, LOSS ou REFUND, por HTTP e por SQS ao mesmo tempo, nas mesmas wallets, em taxa fixa (laço aberto: uma rodada começa a cada intervalo, sem esperar a anterior). Uma em cada quatro rodadas HTTP manda um segundo REFUND da mesma BET, que deve ser recusado com 422.

**Vazão e latência (ms)**

| Carga | Aceitas/s | p50 | p95 | p99 | máx | Servidor p50 / p95 / p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 40 rodadas/s HTTP + 10 rodadas/s SQS | 80,0 | 5,2 | 7,8 | 9,9 | 18,2 | 3,6 / 9,2 / 9,9 |

**Respostas e conflitos**

| Carga | Requisições | 2xx | 422 (negócio) | 503 | outros 5xx | outros 4xx | sem resposta | Conflitos de lock (HTTP / SQS) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 40 rodadas/s HTTP + 10 rodadas/s SQS | 1.350 | 1.200 | 150 | 0 | 0 | 0 | 0 | 0 / 0 |

**Outbox (atrasos em s) e CPU (núcleos médios)**

| Carga | Eventos gravados/s | Publicados/s | Atraso p50 / p99 / máx | Gauge máx | Drenagem | CPU instâncias | CPU PostgreSQL | CPU MiniStack | CPU gerador |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 40 rodadas/s HTTP + 10 rodadas/s SQS | 196,7 | 195,3 | 0,24 / 0,52 / 0,57 | 0,50 | 0,16 | 0,20 + 0,21 + 0,20 | 0,34 | 0,41 | 0,09 |

**Onde as conexões ocupadas do PostgreSQL estavam (amostras de `pg_stat_activity` a cada 250 ms)**

| Carga | Estado / espera mais frequentes |
| --- | --- |
| 40 rodadas/s HTTP + 10 rodadas/s SQS | idle in transaction / Client:ClientRead 47,1%; active 36,8%; idle in transaction 8,8%; active / IO:WalSync 4,4%; idle in transaction / IO:WalWrite 1,5% |

**Caminho assíncrono (SQS): do `SendMessage` até a linha da inbox processada, em ms**

| Enviadas | Processadas | Oferecidas/s | Processadas/s | p50 | p95 | p99 | máx | Retries | DLQ | Drenagem (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 340 | 340 | 20,0 | 20,1 | 46,0 | 96,0 | 102,0 | 110,0 | 0 | 0 | 0,00 |

**Correção depois da carga**

| Verificação | Resultado | Detalhe |
| --- | --- | --- |
| Saldo de cada wallet = saldo reconstruído do ledger | ok | 20 wallets conferida(s) |
| Saldo = saldo esperado pelas respostas da API | ok | 20 wallets igual(is) ao calculado pelos clientes |
| Nenhum saldo negativo, em nenhuma versão do ledger | ok | menor balance_after 999965.00, menor saldo atual 999965.00 |
| Um lançamento por transação processada que move saldo (sem efeito duplicado) | ok | 1493 lançamentos, 1493 transações distintas no ledger, 1493 transações processadas que movem saldo |
| Transações PROCESSED no banco = operações aceitas pelas respostas | ok | banco 1700, respostas 1700 |
| Nenhuma operação gravada duas vezes (providerId + externalTransactionId) | ok | nenhuma |
| Nenhuma transação parada em PENDING_REFERENCE | ok | 0 pendentes |
| Outbox drenada (todo evento publicado) | ok | 0 eventos sem publicar |
| Todo evento da outbox chegou à fila de eventos (nenhum perdido) | ok | 3383 eventos, 0 não recebidos; cópias repetidas recebidas no run até aqui: 0 |
| Fila de entrada e DLQ vazias | ok | entrada: 0 visíveis, 0 em voo; DLQ: 0 |
| Reconciliação da API consistente em todas as wallets | ok | 20 wallets consistente(s) |
| Toda operação enviada por SQS foi processada uma vez | ok | 340 enviadas, 340 gravadas ({"PROCESSED":340}) |
| Segundo REFUND da mesma BET recusado (REFERENCE_ALREADY_REVERSED) | ok | 170 de 170 recusados |

## Análise
### Onde está o gargalo: a hot wallet

Todas as apostas na mesma wallet passam, uma por vez, pelo lock da linha (`SELECT ... FOR NO KEY UPDATE` até o `COMMIT`). Com mais clientes o throughput subiu até 307,8/s com 8 clientes e depois caiu para 192,0/s com 64 clientes, enquanto a latência cresceu (1 cliente: 221,8/s, p50 4,4 ms, p99 6,5 ms; 8 clientes: 307,8/s, p50 17,6 ms, p99 128,5 ms; 64 clientes: 192,0/s, p50 298,7 ms, p99 1.049,2 ms). Com o lock ocupado o tempo todo, 1 / throughput é o tempo que cada transação segura a linha: 3,25 ms no pico e 5,21 ms com 64 clientes. Com 64 clientes, a espera mais frequente das conexões ocupadas do banco foi `active / Lock:transactionid` (85,0% das amostras).

A lei de Little confere a conta: num laço fechado, latência média = clientes / throughput = 64 / 192,0 = 333,3 ms; a média medida foi 330,7 ms. Quase todo esse tempo é fila: cada requisição espera as que chegaram antes dela.

A queda depois do pico não foi isolada neste teste. As explicações prováveis: (1) a cada `COMMIT` o PostgreSQL acorda o próximo da fila do lock, que relê a versão mais nova da linha (`READ COMMITTED`), e essa passagem de vez fica mais cara com dezenas de transações na fila; (2) enquanto há transações abertas esperando, o banco não pode limpar as versões antigas da linha da wallet, então cada releitura percorre mais versões. Com 64 clientes apareceram também `active / LWLock:BufferContent` (3,2%), `active / LWLock:LockManager` (2,7%): disputas internas do PostgreSQL pela página onde está a linha e pela tabela de locks, um sinal a favor das duas hipóteses. Para separar as causas: acompanhar `n_dead_tup` da tabela `wallets` durante o passo e comparar com um teste de uma linha só no próprio PostgreSQL (pgbench).

Com o mesmo número de clientes em wallets distintas, o sistema aceitou 1.020,5/s (5,3x a hot wallet). É o custo esperado do desenho: o lock por wallet impede o lost update e o saldo negativo, e só serializa quem disputa a mesma wallet. Mais instâncias não aumentam o throughput de uma wallet; aumentam o de wallets diferentes. Se uma wallet real precisasse de mais vazão, o caminho seria encurtar o tempo com o lock (menos idas ao banco dentro da transação), não mais paralelismo.

### Wallets distintas: até onde escala

Sem disputa de lock, o ganho de throughput por passo foi: de 1 cliente para 8 clientes, +304,6%; de 8 clientes para 64 clientes, +20,9%. Com 64 clientes, as instâncias usaram 1,19, 1,23, 1,17 núcleos, o PostgreSQL 3,82 e o MiniStack 1,31; a espera mais frequente no banco foi `idle in transaction / Client:ClientRead` (80,4% das amostras). Cada instância executa o JavaScript num único thread; perto de 1 núcleo em todas indica que o limite está no processamento dentro das instâncias (Nest, validação, MikroORM, log JSON por requisição), não no lock. Mais instâncias (ou mais núcleos) sobem esse teto até o PostgreSQL virar o limite. A espera mais frequente confirma a leitura: no meio da transação, o banco estava esperando a instância mandar a próxima instrução. Com 64 clientes há mais requisições que as 30 conexões do conjunto (10 por instância): as que sobram esperam uma conexão livre dentro da instância, o que aparece como latência, não como erro.

### A cauda (p99)

O p99 é a latência que 1 em cada 100 requisições passa: um provedor que manda milhares de apostas por minuto vê esse valor várias vezes por segundo, e é ele que define timeouts e retries do lado do provedor. Wallets distintas (baixa disputa) com 64 clientes: p50 35,2 ms, p99 181,9 ms (5,2x o p50), máximo 212,0 ms em 6.123 requisições; Hot wallet (alta disputa, uma wallet) com 64 clientes: p50 298,7 ms, p99 1.049,2 ms (3,5x o p50), máximo 1.779,3 ms em 1.152 requisições. Na hot wallet a cauda vem da posição na fila do lock e da fila do pool; nas wallets distintas, da fila do pool e da disputa de CPU entre processos na mesma máquina. O máximo de uma janela curta é uma requisição só e varia muito entre execuções; o p99 é mais estável.

### Conflitos de concorrência e o `lock_timeout`

Nenhum `503` e nenhum conflito de lock na hot wallet, mesmo com 64 clientes. O motivo é o pool: no máximo 30 transações (3 instâncias × 10 conexões) esperam o lock ao mesmo tempo. Com 5,21 ms por transação, a última da fila espera cerca de 30 × 5,21 = 156,3 ms, abaixo do `lock_timeout` de 2s. As demais requisições esperam uma conexão livre dentro da instância por até 2.000 ms; depois disso recebem `503` com `Retry-After`.

### Outbox: o atraso de entrega dos eventos

Cada evento publicado custa um `SendMessage` e uma transação curta que o marca como publicado, e os eventos de uma mesma wallet saem um de cada vez, para manter a ordem. O emulador sozinho, com 8 remetentes, aceitou 1.793,6 envios/s numa fila FIFO vazia e 729,0/s depois de 6.000 mensagens.

Sob a carga máxima do cenário 1 (64 clientes) foram gravados 2.039,3 eventos/s e publicados 365,5/s. A publicação não acompanhou: o atraso cresceu durante a janela (p99 de 34,40 s, máximo de 34,89 s) e os publishers levaram 35,22 s depois do fim da carga para zerar a fila. A vazão de publicação ficou abaixo até do que o emulador aceitou sozinho depois de algumas mil mensagens, então o emulador não explica tudo. Somam-se: o custo por envio do emulador, que cresce durante o passo (a fila de eventos recebe milhares de mensagens); a transação que marca cada evento; e o lote, que só termina quando a wallet com mais eventos termina. Este teste não separa quanto vem de cada parte.

Na hot wallet todos os eventos são da mesma wallet e saem em série: com 1 cliente, 331,5 publicados/s contra 444,0 gravados/s. Com 64 clientes a publicação caiu para 139,3/s, com o MiniStack em 0,44 núcleo e as instâncias quase paradas. O publisher usa um pool próprio (3 conexões por instância), separado das requisições presas no lock da wallet; a causa desta queda não foi isolada neste teste.

Em taxa fixa (cenário 3) foram gravados 196,7 eventos/s e publicados 195,3/s (a publicação acompanhou), com atraso p50 de 0,24 s e p99 de 0,52 s. Parte do atraso, com a outbox quase vazia, é a pausa de 500 ms do publisher quando não encontra nada para publicar.

O atraso não afeta a correção: o evento é gravado na mesma transação do saldo e sai depois, uma vez ou mais (a deduplicação usa o `eventId`). O que cresce sob sobrecarga é o tempo até um consumidor saber da transação. Para publicar mais rápido: `SendMessageBatch` (até 10 mensagens por chamada) e marcar como publicados os eventos de uma wallet numa única instrução, com o custo de reenviar mais eventos se o processo morrer no meio de um lote.

### Caminho assíncrono (SQS)

Foram oferecidas 20,0 mensagens/s e processadas 20,1/s na janela (os consumers acompanharam a taxa). Do `SendMessage` até a linha da inbox processada: p50 de 46,0 ms, p99 de 102,0 ms. Esse tempo inclui o long poll (o receive volta assim que há mensagem), o lote de até 10 mensagens por receive (o próximo receive só sai depois do lote) e a transação. Houve 0 retries, 0 mensagens na DLQ e 0 conflitos de lock no consumer, com HTTP e SQS disputando as mesmas wallets.

### Cliente x servidor

Com 64 clientes no cenário 1, o cliente mediu p50 de 35,2 ms e o histograma do servidor estima 36,4 ms; no p99, 181,9 contra 245,0 ms. O servidor mede o caso de uso (com a espera por conexão e pelo lock); o cliente soma HTTP, JSON e a fila do event loop da instância. A estimativa do histograma é grosseira: entre os buckets de 25, 50 e 100 ms a interpolação pode errar dezenas de ms.

### O que mudaria na AWS e em hardware de produção

- **SQS de verdade:** não tem o custo de deduplicação que cresce com a fila. Em compensação cada `SendMessage` cruza a rede, e como os eventos de uma wallet saem um por vez, a vazão de publicação por wallet fica limitada pelo tempo de ida e volta. A fila FIFO também tem cota de vazão por fila (maior no modo de alta vazão), que precisaria ser conferida para a taxa esperada.
- **Banco em outra máquina:** cada instrução da transação passa a custar uma ida e volta de rede enquanto o lock da wallet está preso. O tempo por transação na hot wallet sobe, e o throughput de uma wallet cai na mesma proporção. Wallets distintas sofrem menos, porque as transações correm em paralelo.
- **Hardware dedicado:** aqui o gerador, as três instâncias, o PostgreSQL e o MiniStack dividem os mesmos núcleos. Em produção cada parte teria a sua CPU, e o pool e o número de instâncias seriam dimensionados junto com o `max_connections` do banco.
- **O que não muda:** a hot wallet continua serializada (é a garantia de correção), e o throughput total cresce com instâncias enquanto a carga se espalha por wallets diferentes e o banco aguenta.

## Limitações

- Uma máquina só: gerador, instâncias, banco e emulador competem pela CPU, e a rede é a interface local. Os números servem para comparar cenários entre si, não para prever a capacidade em produção.
- MiniStack não é SQS: o custo de deduplicação por envio é do emulador, e a fila de eventos é recriada a cada passo para que um passo não pague pelo anterior.
- Janelas curtas (6 s por passo, 15 s no misto): o p99 se apoia em centenas ou milhares de requisições (coluna "Requisições"), e o máximo é uma requisição só. `LOAD_STEP_SECONDS` maior dá caudas mais estáveis; `LOAD_CLIENTS=1,4,16,64` dá uma curva com mais pontos.
- Banco novo a cada execução: tabelas e índices pequenos. Um sistema com meses de ledger e outbox teria índices maiores e o autovacuum trabalhando.
- Os cenários 1 e 2 usam laço fechado: sob saturação os clientes esperam e a carga oferecida cai, o que esconde parte da latência. O cenário 3 usa taxa fixa justamente para medir sem esse efeito.
- Só apostas de 1,00 numa moeda, e sem autenticação (o projeto usa um guard no-op).
- As causas prováveis da queda da hot wallet e da publicação mais lenta são hipóteses apoiadas nas esperas do banco e na CPU; não foram isoladas uma a uma.
- CPU lida de `/proc` e do cgroup v2 do Docker: só em Linux; em outro sistema aparece "n/d".
- O gauge de atraso da outbox é atualizado por cada publisher ao fim de um lote e lido a cada 500 ms; o atraso por evento, do banco, é a medida exata.

## Repetibilidade (3 rodadas)

O mesmo experimento rodou 3 vezes seguidas, na mesma máquina, com os mesmos parâmetros e sem outros programas abertos (rodada 1 às 2026-10-08T11:57:16.404Z, rodada 2 às 2026-10-08T12:01:58.894Z, rodada 3 às 2026-10-08T12:08:30.570Z).
O relatório acima é o da **rodada 1**, a de vazão mediana com o maior número de clientes em wallets distintas.
A tabela usa a **mediana** e não a média: com poucas rodadas, uma rodada atípica puxa a média e não mexe na mediana. A variação é (máximo − mínimo) / mediana.

Verificações de correção, por rodada: rodada 1: 35/35; rodada 2: 35/35; rodada 3: 35/35.

| Cenário | Passo | Métrica | Rodada 1 | Rodada 2 | Rodada 3 | Mediana | Variação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Wallets distintas (baixa disputa) | 1 cliente | aceitas/s | 208,7 | 206,8 | 211,3 | 208,7 | 2 % |
| Wallets distintas (baixa disputa) | 1 cliente | p50 (ms) | 4,6 | 4,6 | 4,6 | 4,6 | 2 % |
| Wallets distintas (baixa disputa) | 1 cliente | p99 (ms) | 7,2 | 7,8 | 7,6 | 7,6 | 8 % |
| Wallets distintas (baixa disputa) | 1 cliente | eventos publicados/s | 310,5 | 306,7 | 322,3 | 310,5 | 5 % |
| Wallets distintas (baixa disputa) | 8 clientes | aceitas/s | 844,3 | 857,8 | 858,7 | 857,8 | 2 % |
| Wallets distintas (baixa disputa) | 8 clientes | p50 (ms) | 8,6 | 8,6 | 8,4 | 8,6 | 2 % |
| Wallets distintas (baixa disputa) | 8 clientes | p99 (ms) | 19,8 | 19,0 | 19,8 | 19,8 | 4 % |
| Wallets distintas (baixa disputa) | 8 clientes | eventos publicados/s | 326,2 | 326,5 | 327,7 | 326,5 | 0 % |
| Wallets distintas (baixa disputa) | 64 clientes | aceitas/s | 1.020,5 | 997,2 | 1.074,5 | 1.020,5 | 8 % |
| Wallets distintas (baixa disputa) | 64 clientes | p50 (ms) | 35,2 | 50,8 | 53,5 | 50,8 | 36 % |
| Wallets distintas (baixa disputa) | 64 clientes | p99 (ms) | 181,9 | 137,1 | 136,4 | 137,1 | 33 % |
| Wallets distintas (baixa disputa) | 64 clientes | eventos publicados/s | 365,5 | 348,3 | 343,5 | 348,3 | 6 % |
| Hot wallet (alta disputa, uma wallet) | 1 cliente | aceitas/s | 221,8 | 198,8 | 208,8 | 208,8 | 11 % |
| Hot wallet (alta disputa, uma wallet) | 1 cliente | p50 (ms) | 4,4 | 4,9 | 4,6 | 4,6 | 10 % |
| Hot wallet (alta disputa, uma wallet) | 1 cliente | p99 (ms) | 6,5 | 7,5 | 7,4 | 7,4 | 13 % |
| Hot wallet (alta disputa, uma wallet) | 1 cliente | eventos publicados/s | 331,5 | 315,0 | 320,2 | 320,2 | 5 % |
| Hot wallet (alta disputa, uma wallet) | 8 clientes | aceitas/s | 307,8 | 278,8 | 310,8 | 307,8 | 10 % |
| Hot wallet (alta disputa, uma wallet) | 8 clientes | p50 (ms) | 17,6 | 19,2 | 16,9 | 17,6 | 13 % |
| Hot wallet (alta disputa, uma wallet) | 8 clientes | p99 (ms) | 128,5 | 126,7 | 121,5 | 126,7 | 6 % |
| Hot wallet (alta disputa, uma wallet) | 8 clientes | eventos publicados/s | 225,7 | 214,8 | 189,7 | 214,8 | 17 % |
| Hot wallet (alta disputa, uma wallet) | 64 clientes | aceitas/s | 192,0 | 182,0 | 155,2 | 182,0 | 20 % |
| Hot wallet (alta disputa, uma wallet) | 64 clientes | p50 (ms) | 298,7 | 294,8 | 348,1 | 298,7 | 18 % |
| Hot wallet (alta disputa, uma wallet) | 64 clientes | p99 (ms) | 1.049,2 | 1.162,4 | 1.411,9 | 1.162,4 | 31 % |
| Hot wallet (alta disputa, uma wallet) | 64 clientes | eventos publicados/s | 139,3 | 130,0 | 144,7 | 139,3 | 11 % |
| Misto: HTTP e SQS em taxa fixa | 40 rodadas/s HTTP + 10 rodadas/s SQS | aceitas/s | 80,0 | 80,0 | 80,0 | 80,0 | 0 % |
| Misto: HTTP e SQS em taxa fixa | 40 rodadas/s HTTP + 10 rodadas/s SQS | p50 (ms) | 5,2 | 5,7 | 5,2 | 5,2 | 9 % |
| Misto: HTTP e SQS em taxa fixa | 40 rodadas/s HTTP + 10 rodadas/s SQS | p99 (ms) | 9,9 | 11,0 | 10,9 | 10,9 | 10 % |
| Misto: HTTP e SQS em taxa fixa | 40 rodadas/s HTTP + 10 rodadas/s SQS | eventos publicados/s | 195,3 | 198,3 | 195,9 | 195,9 | 2 % |
| Misto: HTTP e SQS em taxa fixa | 40 rodadas/s HTTP + 10 rodadas/s SQS | SQS, do envio ao processamento, p99 (ms) | 102,0 | 106,0 | 105,0 | 105,0 | 4 % |
