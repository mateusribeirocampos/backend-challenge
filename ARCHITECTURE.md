# Arquitetura

Processador de transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) que recebe operações por HTTP e por SQS, mantém o saldo de cada wallet e um ledger auditável, e publica eventos. Como executar e onde cada requisito é verificado: [README.md](README.md).

Em três frases: toda operação roda numa única transação SQL que grava primeiro (idempotência por chave única), trava só a linha da wallet (`FOR NO KEY UPDATE`), aplica a regra numa função pura do domínio e grava saldo, ledger, resultado e eventos (outbox) juntos. O PostgreSQL confere no commit que o saldo é igual ao fim do ledger. A fila entrega pelo menos uma vez; a inbox e a chave de idempotência garantem um efeito só.

## 1. Decisões

| Decisão | Por quê | Alternativa descartada | Onde |
|---|---|---|---|
| `Money` sobre `decimal.js`, entrada só por string validada | dinheiro nunca passa por `number`; `"1e3"` e `"Infinity"` recusados antes do `Decimal` | `bigint` em centavos: parsing manual e serializador próprio | `src/domain/money/money.ts` |
| Código de moeda: formato + tabela ISO 4217 do runtime; `XXX` e `XTS` recusados | `ABC` passava só com regex | lista própria de moedas (manutenção) | `money.ts` |
| Moedas operadas em configuração (`SUPPORTED_CURRENCIES`, padrão `BRL`) | quais moedas a plataforma opera é negócio, não propriedade do valor | validar só ISO: aceitaria `XAU`, `HRK` | `src/application/wallets/open-wallet.ts` |
| Regras de negócio numa função pura | testável sem banco; a aplicação busca, trava e grava | regras espalhadas no caso de uso | `src/domain/wager/apply-wager-transaction.ts` |
| Lock pessimista por wallet com `FOR NO KEY UPDATE` | a FK do insert pega `KEY SHARE` na wallet; `FOR UPDATE` causava deadlock entre duas apostas | otimista com retry: tempestade de retries numa wallet disputada | `src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.ts` |
| `READ COMMITTED` + `lock_timeout` de 2 s | depois do lock, lê o saldo commitado; sem limite, requisições acumulam e esgotam o pool | `SERIALIZABLE`: troca espera por erros `40001` | `mikro-orm-transaction-runner.ts` |
| Espera por conexão no pool limitada a 2 s (`DATABASE_POOL_ACQUIRE_TIMEOUT_MS`), erro transitório | numa rodada de carga anterior a esse prazo, a espera pelo pool chegou a 2.185 ms sem virar `503`; com prazo, a sobrecarga vira `503` + `Retry-After` | sem prazo (latência sem limite) | `mikro-orm.config.ts`, `connection-pools.test.ts` |
| Publisher e worker com pool próprio (`DATABASE_BACKGROUND_POOL_SIZE`, 3) | na hot wallet as 10 conexões do pool ficavam no lock e a publicação caía para 4,3 eventos/s | pool único maior: só adia o problema | `src/background-workers.module.ts` |
| Idempotência por insert-first com `ON CONFLICT DO NOTHING` | a segunda requisição idêntica espera no índice e lê o resultado final; não existe estado "em andamento" | consultar antes de gravar: corrida entre a consulta e o insert | `src/application/wagering/process-wager-transaction.ts` |
| Resultado original gravado na transação | o replay devolve o saldo daquele momento | recalcular no replay | coluna `result_balance_amount` |
| Chave de idempotência única por provedor, em qualquer formato | dois provedores podem mandar a mesma chave sem um bloquear ou receber o replay do outro | chave única global com prefixo `{providerId}:` obrigatório (400 para qualquer outra chave) | migration `idempotency_key_per_provider` |
| Garantias no schema (CHECK, UNIQUE, triggers, constraint triggers diferidas) | se o código tiver bug, o banco recusa o commit | garantias só na aplicação | `src/infrastructure/persistence/migrations` |
| Ledger encadeado por `wallet_version` | saldo igual ao fim do ledger em todo commit e proteção contra lost update | coluna `seq` só para ordenar | migration `create_wallet_ledger_entries` |
| Transactional outbox | evento só existe se o commit existir | publicar no SQS dentro da transação | `src/domain/outbox/outbox-message.ts` |
| Publisher com lease: claim curto (`FOR UPDATE SKIP LOCKED`), envio fora da transação, depois marca ou agenda retry | nenhuma conexão nem lock preso enquanto o SQS responde; instância morta libera os eventos quando o lease vence | segurar a transação aberta durante o `SendMessage` (mais simples; prende conexão e linhas pelo tempo do SQS) | `src/application/outbox/publish-outbox.ts` |
| Ordem por wallet: o claim pega a wallet pelo evento mais antigo pendente (`sequence_number`) | um evento nunca sai antes do anterior da mesma wallet, nem com dois publishers nem com retry | confiar só na FIFO e no `eventId` (dois publishers ou um retry inverteriam a ordem) | `src/infrastructure/persistence/repositories/mikro-orm-outbox.repository.ts` |
| Worker de `PENDING_REFERENCE` pelo mesmo caminho do caso de uso, `FOR NO KEY UPDATE SKIP LOCKED` | um REFUND resolvido depois segue exatamente as regras de um REFUND que chegou na ordem | regras repetidas no worker | `src/application/wagering/apply-and-record.ts` |
| Ledger paginado por cursor opaco de `wallet_version`; reconciliação numa instrução SQL que só relata | o índice vai direto à posição, sem buraco nem repetição com lançamentos novos; um snapshot sem lock; corrigir esconderia o problema | `OFFSET` (lê e descarta as linhas anteriores); lock na wallet; corrigir o saldo | `src/interfaces/http/ledger-cursor.ts`, `src/application/wallets/reconcile-wallet.ts` |
| Inbox na mesma transação do efeito, ack depois do commit | crash entre commit e ack vira duplicata reconhecida | inbox em transação separada: perderia a operação | `src/interfaces/messaging/wager-message-handler.ts` |
| Erro permanente para a DLQ na hora, com o motivo | tentar de novo não muda o resultado e seguraria a wallet na FIFO | esperar a redrive policy | `src/interfaces/messaging/processing-failure.ts` |
| Retry no processo só para contenção (`55P03`, `40P01`, `40001`) | resolve em milissegundos; sem ele, uma wallet disputada mandava mensagens não tentadas para a DLQ | retry no processo para todo transitório | `src/application/retry-on-contention.ts` |
| No `SIGTERM`, esperar o long poll em vez de abortar | abortar no cliente não cancela o poll no servidor; a mensagem ficaria escondida | abortar a requisição | `src/interfaces/messaging/sqs-wager-consumer.ts` |
| MikroORM 7 com `defineEntity` fora do domínio; escritas imediatas na ordem das FKs | fronteira transacional explícita; domínio sem ORM; ordem visível no caso de uso | decorators nas entidades; `flush` da Unit of Work | `src/infrastructure/persistence` |
| Conexão perdida no meio da transação volta ao pool (`release-dead-connections.ts`) | o kysely 0.29 só devolve a conexão se o `ROLLBACK` der certo; com o banco fora ele falha e o pool esgotava para sempre (503 até reiniciar) | reiniciar o processo depois de uma queda | `test/integration/resilience/database-outage.test.ts` |
| Migrations escritas à mão, com `up` e `down` e teste de reversibilidade | CHECK, índice parcial e trigger não cabem no mapeamento | geração por diff | `test/integration/support/migration-reversibility.ts` |
| MiniStack no lugar do LocalStack | a imagem do LocalStack exige token pago; o enunciado aceita os dois | LocalStack | `docker-compose.yml` |
| Erro inesperado registrado só por classe, SQLSTATE e constraint | a mensagem do driver carrega o SQL com parâmetros (valores) | truncar a mensagem (o valor continua lá) | `src/application/error-summary.ts` |
| Teste de carga à parte (`bun run test:load`): 3 processos reais, banco e filas próprios, relatório escrito pelo próprio run; `test:load:summary` junta três rodadas | mede o lock por wallet e a outbox com números reais e confere saldo, ledger e filas depois da carga | k6: outra ferramenta e sem acesso ao banco para as verificações | `load/`, [docs/teste-de-carga.md](docs/teste-de-carga.md) |
| Autenticação como ponto de extensão (guard no-op) | não vale pontos; o tempo foi para o obrigatório | Keycloak (desenho na seção 6) | `src/interfaces/http/provider-auth.guard.ts` |

## 2. Fluxo de uma transação

```
HTTP POST /wagering/transactions        SQS wager-transactions.fifo
  (zod)                                    (zod; inbox ON CONFLICT DO NOTHING)
        \                                  /
         ProcessWagerTransaction (mesmo caso de uso), numa transação SQL:
           1. INSERT wager_transaction ON CONFLICT DO NOTHING   -> replay | conflito
           2. SELECT wallet FOR NO KEY UPDATE (lock_timeout 2 s)
           3. lê a referência e se ela já foi revertida
           4. applyWagerTransaction (domínio puro)
           5. grava saldo, ledger, resultado e eventos (outbox)
           6. COMMIT  (o banco confere saldo == fim do ledger)
        /                                  \
  201 / 200 / 202 / 422                    ack (DeleteMessage) só depois do COMMIT
```

Camadas: `domain` (regras puras, só `decimal.js`) ← `application` (casos de uso e portas) ← `infrastructure` (MikroORM, SQS, config) e `interfaces` (HTTP, consumer SQS e os loops do publisher e do worker). A ligação entre portas e adaptadores fica em `src/wagering.module.ts`, `src/wager-consumer.module.ts` e `src/background-workers.module.ts`.

## 3. Os pontos avaliados

### Correção financeira
- `Money` imutável, escala fixa de duas casas, sem arredondamento: mais de duas casas é recusado. Moedas diferentes lançam erro. Até 18 dígitos inteiros, o limite da coluna `numeric(20,2)`, que volta do driver como string.
- `BET` debita (`INSUFFICIENT_FUNDS`); `WIN` e `REFUND` creditam; `LOSS` não move saldo; `ROLLBACK` inverte a referência (`REVERSAL_WOULD_OVERDRAW` quando faltaria saldo, distinto do anterior).
- A referência precisa ser do mesmo provider, player, wallet, moeda e rodada, e de mesmo valor. Interpretações na seção 5.
- Estados: `PENDING` vai para `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`; `PENDING_REFERENCE` vai para `PROCESSED` ou `REJECTED`; os terminais não mudam mais (`FAILED` existe no modelo, mas não é gravado, ver seção 7). A tabela está em `ALLOWED_TRANSITIONS` (`wager-transaction-status.ts`) e de novo no trigger `wager_transactions_guard`, que recusa qualquer outra transição.
- Um teste falha se `parseFloat`, `Number(` ou `Math.round(` aparecerem no domínio (`test/unit/domain/no-number-for-money.test.ts`).
- O PostgreSQL aceita `NaN` em `numeric` e o trata como maior que qualquer número, então `>= 0` não o barra. Toda coluna monetária tem `CHECK (coluna <> 'NaN')` (migration `monetary_not_nan`).

### Concorrência entre instâncias
- A unidade de concorrência é a wallet; não há lock global nem estado em memória.
- Cenário do enunciado (saldo 100, duas apostas de 80 em paralelo): uma processada, outra `INSUFFICIENT_FUNDS`, saldo 20,00, um débito.
- Prova: `test/integration/wagering/concurrency.test.ts` (HTTP real, `Promise.all`) e `test/integration/schema/wallet-lock-order.schema.test.ts` (duas conexões; com `FOR UPDATE` dá deadlock, com `FOR NO KEY UPDATE` não). Trocar o lock ou removê-lo faz os testes falharem.
- Teste de carga com 3 instâncias nesta máquina, 3 rodadas, mediana de cada métrica (tabela de repetibilidade em [docs/teste-de-carga.md](docs/teste-de-carga.md); o detalhe do relatório é o da rodada 1): wallets distintas chegam a 1.020,5 aceitas/s com 64 clientes (p99 de 137,1 ms); a hot wallet chega a 307,8/s com 8 clientes e cai para 182,0/s com 64 (p99 de 1.162,4 ms), sem nenhum 503, e as 35 verificações de correção passam nas 3 rodadas.
- Três processos reais de `src/main.ts` (HTTP, consumer, publisher e worker em cada um) sobre o mesmo banco e as mesmas filas: `test/integration/multi-instance`. Uma instância morre com `SIGKILL` segurando uma mensagem e uma requisição; o provedor reenvia com a mesma chave, a mensagem volta depois do visibility timeout, e no fim cada wallet bate com o ledger.

### Idempotência persistente
- Fonte da verdade: `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. Sem cache. `{providerId}:{externalTransactionId}` é só o formato recomendado; qualquer chave vale.
- Mesmo payload: replay com `idempotentReplay: true` e o saldo da época. Payload diferente: `409`, sem efeito.
- `payloadHash`: `sha256` do JSON canônico (chaves ordenadas, sem espaços) dos campos de negócio, com o valor normalizado (`"25"` = `"25.00"`) e UUIDs em minúsculas. O header e metadados de transporte ficam fora.
- Se a conexão cair durante o COMMIT, o reenvio com a mesma chave processa (nada gravado) ou vira replay (gravado): nunca efeito duplo.
- Prova: 50 envios da mesma aposta em paralelo resultam em um débito (`concurrency.test.ts`); `idempotency.test.ts`; `payload-hash.test.ts`.

### Consistência entre saldo e ledger
- `wallet.debit()` e `wallet.credit()` devolvem o lançamento que produzem; não há como mudar o saldo sem ledger.
- No banco, cada lançamento guarda `wallet_version` e começa onde o anterior terminou (trigger de cadeia, `UNIQUE (wallet_id, wallet_version)`). No COMMIT, constraint triggers diferidas exigem saldo e versão iguais aos do último lançamento. Ledger e transação terminal são imutáveis (triggers).
- O que fica só no domínio, por escolha: direção do lançamento por tipo e lançamento apenas de transação processada. Levar isso ao banco duplicaria a regra em PL/pgSQL.
- `POST /wallets/:id/reconciliation` compara saldo e créditos menos débitos numa só instrução (um snapshot, sem lock). Divergência: log `wallet.reconciliation_divergence`, métrica e `consistent: false`; nada é corrigido. As somas são lidas com `Money.fromLedgerTotal`, sem o limite de 18 dígitos de um valor: a wallet pode movimentar na vida mais do que um saldo comporta. `GET /wallets/:id/ledger` pagina por cursor de `wallet_version`.
- Prova: `test/integration/schema` tenta violar cada garantia com SQL direto; todo teste que movimenta uma wallet termina com saldo igual ao ledger reconstruído; `reconciliation.test.ts` corrompe o saldo com os triggers desligados só naquela sessão.

### Processamento assíncrono e recuperação de falhas
- Consumer dentro do processo da API (`SQS_CONSUMER_ENABLED`), mesmo caso de uso do HTTP. Wallets em paralelo, cada wallet em ordem (`MessageGroupId = walletId`).
- Duas camadas: a inbox `(consumer_name, message_id)` pega a mesma mensagem; a chave de idempotência pega a mesma operação vinda de outra mensagem ou do HTTP.
- Negócio: ack. Contenção: até 3 tentativas no processo. Banco fora ou wallet ainda inexistente: `ChangeMessageVisibility` com backoff exponencial e jitter; a redrive policy (`maxReceiveCount` 10) leva à DLQ. Permanente (JSON, schema, contrato, conflitos, erro inesperado): DLQ na hora, com `reason` nos atributos.
- `SIGTERM`: para de receber, espera o long poll (até 10 s), termina o que está em andamento e devolve o resto. Se o prazo vence, as não iniciadas voltam na hora; a que segue rodando ainda faz ack se commitar, e a inbox impede efeito duplo se ela for reentregue.
- Toda chamada SQS tem prazo (conexão 3 s, requisição 5 s; o receive tem o long poll mais 5 s): um endpoint que aceita a conexão e não responde não trava o consumer. Falhas de rota ou DNS do banco (`ENETUNREACH`, `EHOSTDOWN`, `ENOTFOUND`) são transitórias; um host errado de verdade chega à DLQ pela redrive.
- Eventos gravados na outbox na mesma transação (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` só quando o saldo muda, `WagerTransactionPendingReference`), envelope com `eventType` e `version` por subclasse.
- Publisher em toda instância (`OUTBOX_PUBLISHER_ENABLED`): lease de 30 s com dono (`lease_token`), envio para `wagering-events.fifo` com `MessageGroupId` = wallet e `MessageDeduplicationId` = `eventId`, retry com backoff e jitter; a falha de um evento segura só a sua wallet. Reenvio depois de lease vencido é contado e descartado pela deduplicação.
- Worker de `PENDING_REFERENCE` em toda instância: confere na hora e depois de 1, 2, 4 s... até 60 s, com jitter; na 15ª conferência com a referência inexistente, `REJECTED` com `REFERENCE_NOT_FOUND` e `WagerTransactionRejected`. Uma linha que falha, também no COMMIT, é pulada no lote e não trava as outras; nenhuma linha é conferida duas vezes no mesmo lote.
- Prova: `test/integration/messaging`, com filas próprias por teste, processo filho morto com `SIGKILL` entre o commit e o ack e entre o claim e o envio, e `SIGTERM` no `src/main.ts` real.
- Queda no meio do trabalho, sem reiniciar o processo (`test/integration/resilience`, com um proxy TCP entre a aplicação e o serviço): com o PostgreSQL fora, as transações interrompidas voltam 503, nada fica gravado e o reenvio com a mesma chave tem um efeito só, e consumer, publisher e worker terminam o que esperava quando ele volta, sem nada na DLQ; com o SQS fora, o HTTP segue respondendo 201, e na volta o publisher envia o acumulado e o consumer processa o que esperava, uma vez cada.

### Observabilidade
- Logs JSON, uma linha por evento, com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` onde existem (HTTP, consumer, publisher, worker). Nenhum valor monetário nem payload.
- Erro inesperado vira classe, código (SQLSTATE) e constraint, nos logs, no `500` e no atributo `detail` da DLQ. A mensagem do driver traz o SQL com os parâmetros e a linha recusada, valores incluídos (`src/application/error-summary.ts`).
- `GET /metrics` (aberto, como o health) no formato texto do Prometheus, gerado à mão a partir dos contadores em memória: transações por status (`wager_http_transactions_total`, `wager_messages_processed_total`), duplicatas por camada e origem, retries, DLQ, conflitos de lock, `wager_outbox_lag_seconds` e os histogramas `wager_processing_duration_seconds{source}`, com buckets de 5 ms a 5 s (uma transação leva milissegundos; quem esperou o `lock_timeout` de 2 s cai entre 1 e 2,5 s) e `wager_wallet_lock_wait_seconds`. `wager_lock_conflicts_total` conta só o lock perdido (`55P03`, `40P01`, `40001`); a espera que termina bem, como a segunda aposta de 80 na fila da primeira, aparece no histograma de espera.
- Prova: `test/integration/observability` (métricas depois de operações HTTP; erro real do PostgreSQL com um valor marcador que não aparece em log, corpo nem DLQ).

## 4. Testes obrigatórios (seção 13)

| Item | Onde |
|---|---|
| Unidade: `Money`, wallet, regras, conflito de moeda, payload divergente | `test/unit` |
| Migrations e constraints | `test/integration/migrations.test.ts`, `test/integration/schema` |
| Atomicidade wallet, ledger, inbox e outbox | `atomicity-and-outbox.test.ts`, `consumer-processing.test.ts` |
| Inbox e redelivery; retry e DLQ | `test/integration/messaging` |
| Publishers concorrentes na mesma outbox | `outbox-publisher.test.ts`, `outbox-publisher-crash.test.ts` |
| Recuperação após reinicialização | `multi-instance/restart.test.ts` (`SIGTERM` em todas, processos novos terminam outbox e referência pendente) |
| 1. Mesma aposta 50 vezes em paralelo | `concurrency.test.ts` |
| 2. Disputa de saldo (2 × 80) | `concurrency.test.ts`, `wallet-lock-order.schema.test.ts` |
| 3. Wallets distintas em paralelo | `concurrency.test.ts`, `consumer-message-groups.test.ts` |
| 4. Três ou mais processos simultâneos | `multi-instance/three-instances.test.ts` |
| 5. Worker morto depois do commit e antes do ack | `consumer-crash-before-ack.test.ts` |
| 6. Dois publishers na mesma outbox | `outbox-publisher.test.ts` |
| 7. REFUND ou ROLLBACK antes da referência | `pending-reference-worker.test.ts`, `consumer-reference-before-bet.test.ts` |
| 8. Reinício com consistência final | `multi-instance/restart.test.ts` (`SIGKILL` com trabalho em mãos, processo substituto) |

## 5. Interpretações do enunciado

| Situação | Decisão | Motivo |
|---|---|---|
| REFUND e depois ROLLBACK da mesma aposta | a segunda reversão é `REFERENCE_ALREADY_REVERSED` | saldo 100, BET 25, REFUND, ROLLBACK daria 125: crédito duplicado |
| WIN ou LOSS numa aposta já revertida | rejeitado | pagaria prêmio de aposta cancelada |
| REFUND de aposta que já teve WIN | permitido | o enunciado não define liquidação; o provedor faz também o ROLLBACK do WIN |
| Valor zero | só LOSS aceita; WIN zero é erro de contrato | operação que afeta saldo precisa movê-lo |
| Crédito acima do limite da coluna | `BALANCE_LIMIT_EXCEEDED`, gravado | sem isso, `22003` e 500 sem resultado |
| Referência existe mas não terminou | a dependente espera em `PENDING_REFERENCE` | rejeitar seria prematuro |
| Referência não chega em 15 conferências (~4,5 a 9 min); se existe mas não terminou, a espera continua | `REJECTED` com `REFERENCE_NOT_FOUND` só quando ela não existe | rejeitar cedo perderia um REFUND; um ROLLBACK rejeitado enquanto o seu REFUND credita depois deixaria o crédito sem reversão |
| Wallet inexistente | HTTP: `404`, nada gravado; SQS: transitório | a wallet pode ser criada pelo HTTP logo depois |
| Fila de eventos | `wagering-events.fifo` | o enunciado só nomeia a de entrada e a DLQ |
| WIN ou LOSS que aponta para uma BET que ainda não chegou | espera em `PENDING_REFERENCE`, como REFUND e ROLLBACK | pagar sem a aposta creditaria algo que talvez nunca existiu |
| `playerId`, `walletId` e `data.idempotencyKey` (SQS) | UUID nos ids; a chave é obrigatória na mensagem | como nos exemplos do enunciado; sem a chave a mensagem vai para a DLQ |

## 6. API e autenticação

| Situação | Status |
|---|---|
| processada / replay | `201` / `200` com `idempotentReplay: true` |
| aguardando referência | `202` |
| rejeição de negócio ou `FAILED` (também no replay) | `422` com `failureCode` |
| moeda válida que a plataforma não opera | `422 CURRENCY_NOT_SUPPORTED` |
| payload ou header inválido | `400 VALIDATION_ERROR`, com `ContractViolationCode` em `details` |
| conflito de chave, de `externalTransactionId`, wallet duplicada | `409` |
| não encontrado / corpo grande demais | `404` / `413` |
| transitório (lock, deadlock, banco fora) | `503` com `Retry-After`: reenviar com a mesma chave |

Erros usam um envelope único `{ errorCode, message, details?, correlationId }`. Respostas de transação não usam o envelope, para o corpo do replay ser idêntico ao original.

O que o provedor faz com cada `failureCode` (`src/domain/wager/failure-code.ts`); a rejeição é gravada, então reenviar devolve a mesma resposta:

| `failureCode` | Ação do provedor |
|---|---|
| `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `BALANCE_LIMIT_EXCEEDED` | desistir: a regra de saldo não muda com o reenvio |
| `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH`, `REFERENCE_INVALID_KIND`, `REFERENCE_MISMATCH`, `AMOUNT_MISMATCH` | corrigir o payload e enviar com **outra** chave |
| `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED` | desistir: a referência foi rejeitada ou já revertida |
| `REFERENCE_NOT_FOUND` | enviar a referência e depois a dependente, com outra chave |
| `400` (`ContractViolationCode` em `details`) | corrigir o payload; nada foi gravado, a mesma chave pode ser usada |
| `503` | reenviar igual, com a mesma chave |

Autenticação: `ProviderAuthGuard` chama a porta `ProviderIdentityPort`, hoje um adaptador no-op. O desenho previsto: Keycloak com client credentials por provedor, JWT validado pela JWKS, `401` sem token e `403` quando o `providerId` do corpo for diferente do token. Sem isso, um provedor pode se apresentar com o `providerId` de outro.

## 7. Limitações

- Se o SQS recusasse para sempre um evento, a wallet dele pararia de publicar (as outras seguem). Isso aparece nos logs `outbox.publish_failed` e `outbox.wallet_stalled` (a partir de 10 tentativas) e em `wager_outbox_lag_seconds`.
- No teste de carga a publicação da outbox não acompanha a escrita saturada: com 64 clientes em wallets distintas são gravados cerca de 2.000 eventos/s e publicados 348,3/s (mediana das 3 rodadas). Com o pool próprio, a publicação na hot wallet com 64 clientes subiu de 4,3 para 139,3 eventos/s. Próximos passos: `SendMessageBatch` e marcação em lote.
- Os eventos gerados pelo worker de `PENDING_REFERENCE` usam o id da transação como `correlationId`: o da requisição original não é gravado.
- Nenhuma transação é gravada como `FAILED`: gravar exigiria uma segunda transação depois do rollback e congelaria a chave num possível bug. A DLQ, com o motivo, é o registro auditável.
- O reprocessamento da DLQ é manual (README). `wager_messages_dead_lettered_total` conta só o que o consumer envia; o que a redrive policy move aparece na profundidade da DLQ no SQS.
- As métricas são por instância e voltam a zero no restart: o Prometheus soma as instâncias e trata o reinício do contador.
- A tabela ISO 4217 vem dos dados ICU do runtime e pode mudar com a versão (a CI fixa o Bun). Em produção seria um catálogo próprio.
- Reverter uma migration não recupera dados. A configuração local usa credenciais fictícias do emulador.
