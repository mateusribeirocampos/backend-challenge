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
| Idempotência por insert-first com `ON CONFLICT DO NOTHING` | a segunda requisição idêntica espera no índice e lê o resultado final; não existe estado "em andamento" | consultar antes de gravar: corrida entre a consulta e o insert | `src/application/wagering/process-wager-transaction.ts` |
| Resultado original gravado na transação | o replay devolve o saldo daquele momento | recalcular no replay | coluna `result_balance_amount` |
| Chave de idempotência começa com `{providerId}:` | a chave única é global; sem prefixo, um provedor ocuparia a chave de outro | aceitar qualquer chave | `src/domain/wager/wager-transaction.ts` |
| Garantias no schema (CHECK, UNIQUE, triggers, constraint triggers diferidas) | se o código tiver bug, o banco recusa o commit | garantias só na aplicação | `src/infrastructure/persistence/migrations` |
| Ledger encadeado por `wallet_version` | saldo igual ao fim do ledger em todo commit e proteção contra lost update | coluna `seq` só para ordenar | migration `create_wallet_ledger_entries` |
| Transactional outbox | evento só existe se o commit existir | publicar no SQS dentro da transação | `src/domain/outbox/outbox-message.ts` |
| Inbox na mesma transação do efeito, ack depois do commit | crash entre commit e ack vira duplicata reconhecida | inbox em transação separada: perderia a operação | `src/interfaces/messaging/wager-message-handler.ts` |
| Erro permanente para a DLQ na hora, com o motivo | tentar de novo não muda o resultado e seguraria a wallet na FIFO | esperar a redrive policy | `src/interfaces/messaging/processing-failure.ts` |
| Retry no processo só para contenção (`55P03`, `40P01`, `40001`) | resolve em milissegundos; sem ele, uma wallet disputada mandava mensagens não tentadas para a DLQ | retry no processo para todo transitório | `src/application/retry-on-contention.ts` |
| No `SIGTERM`, esperar o long poll em vez de abortar | abortar no cliente não cancela o poll no servidor; a mensagem ficaria escondida | abortar a requisição | `src/interfaces/messaging/sqs-wager-consumer.ts` |
| MikroORM 7 com `defineEntity` fora do domínio; escritas imediatas na ordem das FKs | fronteira transacional explícita; domínio sem ORM; ordem visível no caso de uso | decorators nas entidades; `flush` da Unit of Work | `src/infrastructure/persistence` |
| Migrations escritas à mão, com `up` e `down` e teste de reversibilidade | CHECK, índice parcial e trigger não cabem no mapeamento | geração por diff | `test/integration/support/migration-reversibility.ts` |
| MiniStack no lugar do LocalStack | a imagem do LocalStack exige token pago; o enunciado aceita os dois | LocalStack | `docker-compose.yml` |
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

Camadas: `domain` (regras puras, só `decimal.js`) ← `application` (casos de uso e portas) ← `infrastructure` (MikroORM, SQS, config) e `interfaces` (HTTP e consumer SQS). A ligação entre portas e adaptadores fica em `src/wagering.module.ts` e `src/wager-consumer.module.ts`.

## 3. Os pontos avaliados

### Correção financeira
- `Money` imutável, escala fixa de duas casas, sem arredondamento: mais de duas casas é recusado. Moedas diferentes lançam erro. Até 18 dígitos inteiros, o limite da coluna `numeric(20,2)`, que volta do driver como string.
- `BET` debita (`INSUFFICIENT_FUNDS`); `WIN` e `REFUND` creditam; `LOSS` não move saldo; `ROLLBACK` inverte a referência (`REVERSAL_WOULD_OVERDRAW` quando faltaria saldo, distinto do anterior).
- A referência precisa ser do mesmo provider, player, wallet, moeda e rodada, e de mesmo valor. Interpretações na seção 5.
- Um teste falha se `parseFloat`, `Number(` ou `Math.round(` aparecerem no domínio (`test/unit/domain/no-number-for-money.test.ts`).

### Concorrência entre instâncias
- A unidade de concorrência é a wallet; não há lock global nem estado em memória.
- Cenário do enunciado (saldo 100, duas apostas de 80 em paralelo): uma processada, outra `INSUFFICIENT_FUNDS`, saldo 20,00, um débito.
- Prova: `test/integration/wagering/concurrency.test.ts` (HTTP real, `Promise.all`) e `test/integration/schema/wallet-lock-order.schema.test.ts` (duas conexões; com `FOR UPDATE` dá deadlock, com `FOR NO KEY UPDATE` não). Trocar o lock ou removê-lo faz os testes falharem.

### Idempotência persistente
- Fonte da verdade: `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. Sem cache.
- Mesmo payload: replay com `idempotentReplay: true` e o saldo da época. Payload diferente: `409`, sem efeito.
- `payloadHash`: `sha256` do JSON canônico (chaves ordenadas, sem espaços) dos campos de negócio, com o valor normalizado (`"25"` = `"25.00"`) e UUIDs em minúsculas. O header e metadados de transporte ficam fora.
- Se a conexão cair durante o COMMIT, o reenvio com a mesma chave processa (nada gravado) ou vira replay (gravado): nunca efeito duplo.
- Prova: 50 envios da mesma aposta em paralelo resultam em um débito (`concurrency.test.ts`); `idempotency.test.ts`; `payload-hash.test.ts`.

### Consistência entre saldo e ledger
- `wallet.debit()` e `wallet.credit()` devolvem o lançamento que produzem; não há como mudar o saldo sem ledger.
- No banco, cada lançamento guarda `wallet_version` e começa onde o anterior terminou (trigger de cadeia, `UNIQUE (wallet_id, wallet_version)`). No COMMIT, constraint triggers diferidas exigem saldo e versão iguais aos do último lançamento. Ledger e transação terminal são imutáveis (triggers).
- O que fica só no domínio, por escolha: direção do lançamento por tipo e lançamento apenas de transação processada. Levar isso ao banco duplicaria a regra em PL/pgSQL.
- Prova: `test/integration/schema` tenta violar cada garantia com SQL direto; todo teste que movimenta uma wallet termina com saldo igual ao ledger reconstruído.

### Processamento assíncrono e recuperação de falhas
- Consumer dentro do processo da API (`SQS_CONSUMER_ENABLED`), mesmo caso de uso do HTTP. Wallets em paralelo, cada wallet em ordem (`MessageGroupId = walletId`).
- Duas camadas: a inbox `(consumer_name, message_id)` pega a mesma mensagem; a chave de idempotência pega a mesma operação vinda de outra mensagem ou do HTTP.
- Negócio: ack. Contenção: até 3 tentativas no processo. Banco fora ou wallet ainda inexistente: `ChangeMessageVisibility` com backoff exponencial e jitter; a redrive policy (`maxReceiveCount` 10) leva à DLQ. Permanente (JSON, schema, contrato, conflitos, erro inesperado): DLQ na hora, com `reason` nos atributos.
- `SIGTERM`: para de receber, espera o long poll (até 10 s), termina o que está em andamento e devolve o resto.
- Eventos gravados na outbox na mesma transação (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` só quando o saldo muda, `WagerTransactionPendingReference`), envelope com `eventType` e `version` por subclasse.
- Prova: `test/integration/messaging`, com filas próprias por teste, processo filho morto com `SIGKILL` entre o commit e o ack, e `SIGTERM` no `src/main.ts` real.

## 4. Testes obrigatórios (seção 13)

| Item | Status | Onde |
|---|---|---|
| Unidade: `Money`, wallet, regras, conflito de moeda, payload divergente | ✅ | `test/unit` |
| Migrations e constraints | ✅ | `test/integration/migrations.test.ts`, `test/integration/schema` |
| Atomicidade wallet, ledger, inbox e outbox | ✅ | `atomicity-and-outbox.test.ts`, `consumer-processing.test.ts` |
| Inbox e redelivery; retry e DLQ | ✅ | `test/integration/messaging` |
| Publishers concorrentes na mesma outbox | ⏳ pendente | |
| Recuperação após reinicialização | ⏳ pendente | |
| 1. Mesma aposta 50 vezes em paralelo | ✅ | `concurrency.test.ts` |
| 2. Disputa de saldo (2 × 80) | ✅ | `concurrency.test.ts`, `wallet-lock-order.schema.test.ts` |
| 3. Wallets distintas em paralelo | ✅ | `concurrency.test.ts`, `consumer-message-groups.test.ts` |
| 4. Três ou mais processos simultâneos | ⏳ pendente | |
| 5. Worker morto depois do commit e antes do ack | ✅ | `consumer-crash-before-ack.test.ts` |
| 6. Dois publishers na mesma outbox | ⏳ pendente | |
| 7. REFUND ou ROLLBACK antes da referência | 🟨 grava `PENDING_REFERENCE`; worker pendente | `http-status-mapping.test.ts` |
| 8. Reinício com consistência final | ⏳ pendente | |

## 5. Interpretações do enunciado

| Situação | Decisão | Motivo |
|---|---|---|
| REFUND e depois ROLLBACK da mesma aposta | a segunda reversão é `REFERENCE_ALREADY_REVERSED` | saldo 100, BET 25, REFUND, ROLLBACK daria 125: crédito duplicado |
| WIN ou LOSS numa aposta já revertida | rejeitado | pagaria prêmio de aposta cancelada |
| REFUND de aposta que já teve WIN | permitido | o enunciado não define liquidação; o provedor faz também o ROLLBACK do WIN |
| Valor zero | só LOSS aceita; WIN zero é erro de contrato | operação que afeta saldo precisa movê-lo |
| Crédito acima do limite da coluna | `BALANCE_LIMIT_EXCEEDED`, gravado | sem isso, `22003` e 500 sem resultado |
| Referência existe mas não terminou | a dependente espera em `PENDING_REFERENCE` | rejeitar seria prematuro |
| Wallet inexistente | HTTP: `404`, nada gravado; SQS: transitório | a wallet pode ser criada pelo HTTP logo depois |
| Fila de eventos | `wagering-events.fifo` | o enunciado só nomeia a de entrada e a DLQ |

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

Erros usam um envelope único `{ errorCode, message, details?, correlationId }`. Respostas de transação não usam o envelope, para o corpo do replay ser idêntico ao original. Os códigos de falha (`failureCode`) estão em `src/domain/wager/failure-code.ts`.

Autenticação: `ProviderAuthGuard` chama a porta `ProviderIdentityPort`, hoje um adaptador no-op. O desenho previsto: Keycloak com client credentials por provedor, JWT validado pela JWKS, `401` sem token e `403` quando o `providerId` do corpo for diferente do token. Sem isso, um provedor pode se apresentar com o `providerId` de outro.

## 7. Limitações

- O worker que publica a outbox no SQS e o worker de `PENDING_REFERENCE` ainda não existem; a reconciliação e o ledger paginado também não.
- Nenhuma transação é gravada como `FAILED`: gravar exigiria uma segunda transação depois do rollback e congelaria a chave num possível bug. A DLQ, com o motivo, é o registro auditável.
- O reprocessamento da DLQ é manual (README). As métricas ficam em memória e ainda não são expostas.
- A tabela ISO 4217 vem dos dados ICU do runtime e pode mudar com a versão (a CI fixa o Bun). Em produção seria um catálogo próprio.
- Reverter uma migration não recupera dados. A configuração local usa credenciais fictícias do emulador.
