# Teste de carga

> Gerado por `bun run test:load` em 2026-10-08T10:53:11.748Z. Não editar à mão: uma nova execução reescreve este arquivo. Os números valem para a máquina descrita em "Ambiente". Os dados brutos ficam em `load-results/` (fora do git).

## Resumo

- **Correção:** as 35 verificações passaram nos 3 cenários: saldo igual ao ledger e ao esperado pelas respostas, nenhum saldo negativo, nenhum efeito duplicado, nada pendente, filas vazias, outbox drenada e todo evento entregue.
- **Wallets distintas:** de 185,8 aceitas/s com 1 cliente até 984,5/s com 64 clientes; com 64 clientes, p99 de 100,5 ms.
- **Hot wallet:** no máximo 280,5 aceitas/s (com 8 clientes); com 64 clientes, 163,2/s e p99 de 1.264,6 ms. O lock da linha serializa a wallet, como esperado.
- **Misto em taxa fixa:** 80,0 requisições HTTP aceitas/s com p99 de 12,4 ms; pelo SQS, do envio ao processamento, p99 de 113,0 ms; atraso da outbox p99 de 0,54 s.
- **Outbox:** no passo mais pesado do cenário 1 foram gravados 1.970,0 eventos/s e publicados 243,5/s, e a publicação levou 38,37 s para alcançar a escrita depois da carga. Neste ambiente a publicação é a parte mais lenta (análise abaixo).
- **Erros:** 0 respostas 503, 0 outros 5xx, 0 requisições sem resposta e 0 conflitos de lock em todo o teste. Os 422 são respostas de negócio esperadas (segundo REFUND da mesma aposta).

## Ambiente

| Item | Valor |
| --- | --- |
| CPU | AMD Ryzen 7 5825U with Radeon Graphics, 16 núcleos lógicos |
| Memória | 15,0 GiB |
| Sistema | Policorp OEM. (Debian GNU/Linux 12), kernel Linux 6.10.7-policorp-amd64 |
| Bun | 1.4.2 |
| Banco | PostgreSQL 17.11 (docker compose, sem limite de CPU); `fsync` on, `max_connections` 100, `shared_buffers` 128MB, `synchronous_commit` on, `wal_level` replica |
| SQS | MiniStack 1.5.22 (light) (docker compose, sem limite de CPU). `SendMessage` FIFO com 8 remetentes: 1.601,7/s nas primeiras 1.000 mensagens, 576,7/s depois de 6.000 |
| Instâncias da aplicação | 3 processos `src/main.ts`, cada um com HTTP, consumer SQS, publisher da outbox e worker de PENDING_REFERENCE |
| Pool de conexões | 10 por instância (padrão do pg-pool), 30 no total |
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
| 1 cliente | 185,8 | 5,2 | 6,8 | 8,2 | 12,1 | 3,0 / 8,6 / 9,7 |
| 8 clientes | 767,5 | 9,5 | 16,9 | 21,7 | 36,3 | 8,4 / 22,3 / 24,5 |
| 64 clientes | 984,5 | 64,1 | 88,9 | 100,5 | 115,9 | 67,5 / 97,0 / 99,6 |

**Respostas e conflitos**

| Carga | Requisições | 2xx | 422 (negócio) | 503 | outros 5xx | outros 4xx | sem resposta | Conflitos de lock (HTTP / SQS) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 cliente | 1.115 | 1.115 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 8 clientes | 4.605 | 4.605 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 64 clientes | 5.907 | 5.907 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |

**Outbox (atrasos em s) e CPU (núcleos médios)**

| Carga | Eventos gravados/s | Publicados/s | Atraso p50 / p99 / máx | Gauge máx | Drenagem | CPU instâncias | CPU PostgreSQL | CPU MiniStack | CPU gerador |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 cliente | 371,7 | 284,2 | 1,55 / 2,39 / 2,39 | 2,33 | 2,39 | 0,20 + 0,20 + 0,57 | 0,63 | 0,68 | 0,26 |
| 8 clientes | 1.534,7 | 328,7 | 12,38 / 23,11 / 23,44 | 23,06 | 23,45 | 1,08 + 1,09 + 1,01 | 3,23 | 1,11 | 0,38 |
| 64 clientes | 1.970,0 | 243,5 | 17,83 / 37,47 / 38,04 | 38,02 | 38,37 | 1,24 + 1,24 + 1,24 | 4,24 | 1,05 | 0,40 |

**Onde as conexões ocupadas do PostgreSQL estavam (amostras de `pg_stat_activity` a cada 250 ms)**

| Carga | Estado / espera mais frequentes |
| --- | --- |
| 1 cliente | idle in transaction / Client:ClientRead 45,2%; active 29,0%; active / IO:WalSync 9,7%; idle in transaction 9,7%; active / Client:ClientRead 3,2% |
| 8 clientes | idle in transaction / Client:ClientRead 52,5%; active 28,4%; idle in transaction 10,4%; active / Client:ClientRead 4,4%; active / IO:WalSync 3,3% |
| 64 clientes | idle in transaction / Client:ClientRead 79,2%; active 11,0%; idle in transaction 4,5%; active / Client:ClientRead 4,2%; active / IO:WalSync 0,6% |

**Correção depois da carga**

| Verificação | Resultado | Detalhe |
| --- | --- | --- |
| Saldo de cada wallet = saldo reconstruído do ledger | ok | 64 wallets conferida(s) |
| Saldo = saldo esperado pelas respostas da API | ok | 64 wallets igual(is) ao calculado pelos clientes |
| Nenhum saldo negativo, em nenhuma versão do ledger | ok | menor balance_after 997646.00, menor saldo atual 997646.00 |
| Um lançamento por transação processada que move saldo (sem efeito duplicado) | ok | 15415 lançamentos, 15415 transações distintas no ledger, 15415 transações processadas que movem saldo |
| Transações PROCESSED no banco = operações aceitas pelas respostas | ok | banco 15351, respostas 15351 |
| Nenhuma operação gravada duas vezes (providerId + externalTransactionId) | ok | nenhuma |
| Nenhuma transação parada em PENDING_REFERENCE | ok | 0 pendentes |
| Outbox drenada (todo evento publicado) | ok | 0 eventos sem publicar |
| Todo evento da outbox chegou à fila de eventos (nenhum perdido) | ok | 30830 eventos, 0 não recebidos; cópias repetidas recebidas no run até aqui: 0 |
| Fila de entrada e DLQ vazias | ok | entrada: 0 visíveis, 0 em voo; DLQ: 0 |
| Reconciliação da API consistente em todas as wallets | ok | 64 wallets consistente(s) |

### 2. Hot wallet (alta disputa, uma wallet)

Só BET por HTTP. Todos os clientes apostam na mesma wallet, então cada transação espera o lock da linha (FOR NO KEY UPDATE) da anterior.

**Vazão e latência (ms)**

| Carga | Aceitas/s | p50 | p95 | p99 | máx | Servidor p50 / p95 / p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 cliente | 189,7 | 5,0 | 6,6 | 8,4 | 23,0 | 2,9 / 8,1 / 9,7 |
| 8 clientes | 280,5 | 18,6 | 86,1 | 136,3 | 267,8 | 19,1 / 93,0 / 207,4 |
| 64 clientes | 163,2 | 343,1 | 874,3 | 1.264,6 | 2.185,0 | 358,8 / 955,1 / 1.961,0 |

**Respostas e conflitos**

| Carga | Requisições | 2xx | 422 (negócio) | 503 | outros 5xx | outros 4xx | sem resposta | Conflitos de lock (HTTP / SQS) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 cliente | 1.138 | 1.138 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 8 clientes | 1.683 | 1.683 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 64 clientes | 979 | 979 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |

**Outbox (atrasos em s) e CPU (núcleos médios)**

| Carga | Eventos gravados/s | Publicados/s | Atraso p50 / p99 / máx | Gauge máx | Drenagem | CPU instâncias | CPU PostgreSQL | CPU MiniStack | CPU gerador |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 cliente | 379,3 | 282,8 | 1,93 / 2,69 / 2,69 | 2,66 | 2,70 | 0,48 + 0,20 + 0,21 | 0,62 | 0,71 | 0,26 |
| 8 clientes | 561,0 | 193,3 | 7,71 / 10,15 / 10,20 | 10,08 | 10,26 | 0,33 + 0,26 + 0,40 | 1,37 | 0,55 | 0,23 |
| 64 clientes | 326,3 | 4,3 | 9,06 / 9,34 / 9,34 | 10,18 | 8,82 | 0,14 + 0,14 + 0,15 | 1,50 | 0,13 | 0,06 |

**Onde as conexões ocupadas do PostgreSQL estavam (amostras de `pg_stat_activity` a cada 250 ms)**

| Carga | Estado / espera mais frequentes |
| --- | --- |
| 1 cliente | active 44,4%; idle in transaction / Client:ClientRead 29,6%; idle in transaction 11,1%; active / IO:WalSync 7,4%; active / Client:ClientRead 7,4% |
| 8 clientes | active / Lock:transactionid 74,4%; active 12,8%; idle in transaction / Client:ClientRead 3,4%; active / IO:WalSync 3,0%; idle in transaction 2,5% |
| 64 clientes | active / Lock:transactionid 86,5%; active / LWLock:BufferContent 7,3%; active 3,2%; idle in transaction / Client:ClientRead 1,2%; active / LWLock:LockManager 1,1% |

**Correção depois da carga**

| Verificação | Resultado | Detalhe |
| --- | --- | --- |
| Saldo de cada wallet = saldo reconstruído do ledger | ok | 1 wallet conferida(s) |
| Saldo = saldo esperado pelas respostas da API | ok | 1 wallet igual(is) ao calculado pelos clientes |
| Nenhum saldo negativo, em nenhuma versão do ledger | ok | menor balance_after 994769.00, menor saldo atual 994769.00 |
| Um lançamento por transação processada que move saldo (sem efeito duplicado) | ok | 5232 lançamentos, 5232 transações distintas no ledger, 5232 transações processadas que movem saldo |
| Transações PROCESSED no banco = operações aceitas pelas respostas | ok | banco 5231, respostas 5231 |
| Nenhuma operação gravada duas vezes (providerId + externalTransactionId) | ok | nenhuma |
| Nenhuma transação parada em PENDING_REFERENCE | ok | 0 pendentes |
| Outbox drenada (todo evento publicado) | ok | 0 eventos sem publicar |
| Todo evento da outbox chegou à fila de eventos (nenhum perdido) | ok | 10464 eventos, 0 não recebidos; cópias repetidas recebidas no run até aqui: 0 |
| Fila de entrada e DLQ vazias | ok | entrada: 0 visíveis, 0 em voo; DLQ: 0 |
| Reconciliação da API consistente em todas as wallets | ok | 1 wallet consistente(s) |

### 3. Misto: HTTP e SQS em taxa fixa

Rodadas de BET seguidas de WIN, LOSS ou REFUND, por HTTP e por SQS ao mesmo tempo, nas mesmas wallets, em taxa fixa (laço aberto: uma rodada começa a cada intervalo, sem esperar a anterior). Uma em cada quatro rodadas HTTP manda um segundo REFUND da mesma BET, que deve ser recusado com 422.

**Vazão e latência (ms)**

| Carga | Aceitas/s | p50 | p95 | p99 | máx | Servidor p50 / p95 / p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 40 rodadas/s HTTP + 10 rodadas/s SQS | 80,0 | 6,3 | 9,9 | 12,4 | 17,7 | 6,2 / 9,8 / 18,7 |

**Respostas e conflitos**

| Carga | Requisições | 2xx | 422 (negócio) | 503 | outros 5xx | outros 4xx | sem resposta | Conflitos de lock (HTTP / SQS) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 40 rodadas/s HTTP + 10 rodadas/s SQS | 1.350 | 1.200 | 150 | 0 | 0 | 0 | 0 | 0 / 0 |

**Outbox (atrasos em s) e CPU (núcleos médios)**

| Carga | Eventos gravados/s | Publicados/s | Atraso p50 / p99 / máx | Gauge máx | Drenagem | CPU instâncias | CPU PostgreSQL | CPU MiniStack | CPU gerador |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 40 rodadas/s HTTP + 10 rodadas/s SQS | 196,7 | 201,2 | 0,25 / 0,54 / 0,61 | 0,54 | 0,42 | 0,22 + 0,24 + 0,25 | 0,45 | 0,49 | 0,10 |

**Onde as conexões ocupadas do PostgreSQL estavam (amostras de `pg_stat_activity` a cada 250 ms)**

| Carga | Estado / espera mais frequentes |
| --- | --- |
| 40 rodadas/s HTTP + 10 rodadas/s SQS | idle in transaction / Client:ClientRead 36,6%; active 32,9%; idle in transaction 12,2%; active / IO:WalSync 9,8%; active / Client:ClientRead 8,5% |

**Caminho assíncrono (SQS): do `SendMessage` até a linha da inbox processada, em ms**

| Enviadas | Processadas | Oferecidas/s | Processadas/s | p50 | p95 | p99 | máx | Retries | DLQ | Drenagem (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 340 | 340 | 20,0 | 20,0 | 50,0 | 99,0 | 113,0 | 126,0 | 0 | 0 | 0,00 |

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

Todas as apostas na mesma wallet passam, uma por vez, pelo lock da linha (`SELECT ... FOR NO KEY UPDATE` até o `COMMIT`). Com mais clientes o throughput subiu até 280,5/s com 8 clientes e depois caiu para 163,2/s com 64 clientes, enquanto a latência cresceu (1 cliente: 189,7/s, p50 5,0 ms, p99 8,4 ms; 8 clientes: 280,5/s, p50 18,6 ms, p99 136,3 ms; 64 clientes: 163,2/s, p50 343,1 ms, p99 1.264,6 ms). Com o lock ocupado o tempo todo, 1 / throughput é o tempo que cada transação segura a linha: 3,57 ms no pico e 6,13 ms com 64 clientes. Com 64 clientes, a espera mais frequente das conexões ocupadas do banco foi `active / Lock:transactionid` (86,5% das amostras).

A lei de Little confere a conta: num laço fechado, latência média = clientes / throughput = 64 / 163,2 = 392,2 ms; a média medida foi 396,5 ms. Quase todo esse tempo é fila: cada requisição espera as que chegaram antes dela.

A queda depois do pico não foi isolada neste teste. As explicações prováveis: (1) a cada `COMMIT` o PostgreSQL acorda o próximo da fila do lock, que relê a versão mais nova da linha (`READ COMMITTED`), e essa passagem de vez fica mais cara com dezenas de transações na fila; (2) enquanto há transações abertas esperando, o banco não pode limpar as versões antigas da linha da wallet, então cada releitura percorre mais versões. Com 64 clientes apareceram também `active / LWLock:BufferContent` (7,3%), `active / LWLock:LockManager` (1,1%): disputas internas do PostgreSQL pela página onde está a linha e pela tabela de locks, um sinal a favor das duas hipóteses. Para separar as causas: acompanhar `n_dead_tup` da tabela `wallets` durante o passo e comparar com um teste de uma linha só no próprio PostgreSQL (pgbench).

Com o mesmo número de clientes em wallets distintas, o sistema aceitou 984,5/s (6,0x a hot wallet). É o custo esperado do desenho: o lock por wallet impede o lost update e o saldo negativo, e só serializa quem disputa a mesma wallet. Mais instâncias não aumentam o throughput de uma wallet; aumentam o de wallets diferentes. Se uma wallet real precisasse de mais vazão, o caminho seria encurtar o tempo com o lock (menos idas ao banco dentro da transação), não mais paralelismo.

### Wallets distintas: até onde escala

Sem disputa de lock, o ganho de throughput por passo foi: de 1 cliente para 8 clientes, +313,0%; de 8 clientes para 64 clientes, +28,3%. Com 64 clientes, as instâncias usaram 1,24, 1,24, 1,24 núcleos, o PostgreSQL 4,24 e o MiniStack 1,05; a espera mais frequente no banco foi `idle in transaction / Client:ClientRead` (79,2% das amostras). Cada instância executa o JavaScript num único thread; perto de 1 núcleo em todas indica que o limite está no processamento dentro das instâncias (Nest, validação, MikroORM, log JSON por requisição), não no lock. Mais instâncias (ou mais núcleos) sobem esse teto até o PostgreSQL virar o limite. A espera mais frequente confirma a leitura: no meio da transação, o banco estava esperando a instância mandar a próxima instrução. Com 64 clientes há mais requisições que as 30 conexões do conjunto (10 por instância): as que sobram esperam uma conexão livre dentro da instância, o que aparece como latência, não como erro.

### A cauda (p99)

O p99 é a latência que 1 em cada 100 requisições passa: um provedor que manda milhares de apostas por minuto vê esse valor várias vezes por segundo, e é ele que define timeouts e retries do lado do provedor. Wallets distintas (baixa disputa) com 64 clientes: p50 64,1 ms, p99 100,5 ms (1,6x o p50), máximo 115,9 ms em 5.907 requisições; Hot wallet (alta disputa, uma wallet) com 64 clientes: p50 343,1 ms, p99 1.264,6 ms (3,7x o p50), máximo 2.185,0 ms em 979 requisições. Na hot wallet a cauda vem da posição na fila do lock e da fila do pool; nas wallets distintas, da fila do pool e da disputa de CPU entre processos na mesma máquina. O máximo de uma janela curta é uma requisição só e varia muito entre execuções; o p99 é mais estável.

### Conflitos de concorrência e o `lock_timeout`

Nenhum `503` e nenhum conflito de lock na hot wallet, mesmo com 64 clientes. O motivo é o pool: no máximo 30 transações (3 instâncias × 10 conexões) esperam o lock ao mesmo tempo. Com 6,13 ms por transação, a última da fila espera cerca de 30 × 6,13 = 183,9 ms, abaixo do `lock_timeout` de 2s. As demais requisições esperam uma conexão dentro da instância, no pool, que não tem prazo de espera (o projeto não define `connectionTimeoutMillis` do pg-pool): com sobrecarga maior a latência continuaria crescendo em vez de virar `503`. O máximo medido com 64 clientes, 2.185,0 ms, passou do `lock_timeout` sem nenhum `503`: o que passou de 2s foi espera por conexão, não pelo lock. Um prazo de espera no pool seria o ajuste para falhar rápido.

### Outbox: o atraso de entrega dos eventos

Cada evento publicado custa um `SendMessage` e uma transação curta que o marca como publicado, e os eventos de uma mesma wallet saem um de cada vez, para manter a ordem. O emulador sozinho, com 8 remetentes, aceitou 1.601,7 envios/s numa fila FIFO vazia e 576,7/s depois de 6.000 mensagens.

Sob a carga máxima do cenário 1 (64 clientes) foram gravados 1.970,0 eventos/s e publicados 243,5/s. A publicação não acompanhou: o atraso cresceu durante a janela (p99 de 37,47 s, máximo de 38,04 s) e os publishers levaram 38,37 s depois do fim da carga para zerar a fila. A vazão de publicação ficou abaixo até do que o emulador aceitou sozinho depois de algumas mil mensagens, então o emulador não explica tudo. Somam-se: o custo por envio do emulador, que cresce durante o passo (a fila de eventos recebe milhares de mensagens); a transação que marca cada evento, que espera conexão no mesmo pool das requisições HTTP; e o lote, que só termina quando a wallet com mais eventos termina. Este teste não separa quanto vem de cada parte.

Na hot wallet todos os eventos são da mesma wallet e saem em série: com 1 cliente, 282,8 publicados/s contra 379,3 gravados/s. Com 64 clientes a publicação caiu para 4,3/s, com o MiniStack em 0,13 núcleo e as instâncias quase paradas. O mais provável é falta de conexão: o publisher usa o mesmo pool (10 por instância) das requisições HTTP, essas conexões ficam presas esperando o lock da wallet, e o publisher espera na fila do pool atrás delas. Um pool separado para os loops de fundo evitaria isso.

Em taxa fixa (cenário 3) foram gravados 196,7 eventos/s e publicados 201,2/s (a publicação acompanhou), com atraso p50 de 0,25 s e p99 de 0,54 s. Parte do atraso, com a outbox quase vazia, é a pausa de 500 ms do publisher quando não encontra nada para publicar.

O atraso não afeta a correção: o evento é gravado na mesma transação do saldo e sai depois, uma vez ou mais (a deduplicação usa o `eventId`). O que cresce sob sobrecarga é o tempo até um consumidor saber da transação. Para publicar mais rápido: `SendMessageBatch` (até 10 mensagens por chamada) e marcar como publicados os eventos de uma wallet numa única instrução, com o custo de reenviar mais eventos se o processo morrer no meio de um lote.

### Caminho assíncrono (SQS)

Foram oferecidas 20,0 mensagens/s e processadas 20,0/s na janela (os consumers acompanharam a taxa). Do `SendMessage` até a linha da inbox processada: p50 de 50,0 ms, p99 de 113,0 ms. Esse tempo inclui o long poll (o receive volta assim que há mensagem), o lote de até 10 mensagens por receive (o próximo receive só sai depois do lote) e a transação. Houve 0 retries, 0 mensagens na DLQ e 0 conflitos de lock no consumer, com HTTP e SQS disputando as mesmas wallets.

### Cliente x servidor

Com 64 clientes no cenário 1, o cliente mediu p50 de 64,1 ms e o histograma do servidor estima 67,5 ms; no p99, 100,5 contra 99,6 ms. O servidor mede o caso de uso (com a espera por conexão e pelo lock); o cliente soma HTTP, JSON e a fila do event loop da instância. A estimativa do histograma é grosseira: entre os buckets de 25, 50 e 100 ms a interpolação pode errar dezenas de ms.

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
