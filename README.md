# backend-challenge

Processador distribuído de transações de apostas (desafio técnico Jungle Gaming).
Stack: Bun, TypeScript estrito, NestJS, MikroORM 7 com PostgreSQL, SQS emulado pelo MiniStack.

As decisões técnicas, os trade-offs e as limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Requisitos

- Bun 1.x (`curl -fsSL https://bun.sh/install | bash`)
- Docker com Docker Compose v2
- Portas livres no host: 5432 (PostgreSQL) e 4566 (SQS)

## Como executar a aplicação

Do zero até todos os testes rodando:

```bash
cp .env.example .env          # valores fictícios, só para os containers locais
docker compose up -d --wait   # PostgreSQL + emulador SQS, espera os healthchecks
bun install
bun run migration:up
bun run typecheck
bun test
```

O `docker compose up -d` cria:

- PostgreSQL 17 com dois bancos: `wagering` (desenvolvimento) e `wagering_test` (testes de integração).
- MiniStack com as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (DLQ, `maxReceiveCount=10`) e `wagering-events.fifo` (eventos publicados pela outbox).

Os testes de integração usam o PostgreSQL e o SQS reais dos containers. Nenhum dos dois é substituído por mock.

### Conferindo à mão

```bash
bun run start
curl -i localhost:3000/health/live
curl -i localhost:3000/health/ready

# abre uma wallet com 100,00 (guarde o "id" da resposta)
curl -i -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# aposta de 25,00; repetir o mesmo comando devolve 200 com "idempotentReplay": true
curl -i -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Para ver a aplicação com três instâncias:

```bash
docker compose --profile app up -d --build --scale app=3
docker compose ps app                      # as três ficam healthy
docker compose port --index 2 app 3000     # porta do host da instância 2
```

O serviço `migrate` roda as migrations uma vez antes das instâncias subirem. Cada instância roda também o consumer da fila `wager-transactions.fifo`. Os testes criam filas próprias, então as instâncias podem ficar de pé enquanto `bun test` roda.

### Consumer SQS

O consumer roda dentro do processo da aplicação, ligado por `SQS_CONSUMER_ENABLED` (padrão `true`). Com `bun run start` ou com o profile `app` do Compose ele já está consumindo. Para mandar uma mensagem à mão (troque os ids pelos da wallet criada antes):

```bash
docker compose exec -T sqs awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <id da wallet> --message-deduplication-id msg-1 \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-10-07T12:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"tx-1","idempotencyKey":"provider-a:tx-1","playerId":"<player>","walletId":"<id da wallet>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'

docker compose exec -T sqs awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --message-attribute-names All          # o que foi para a DLQ, com reason e errorCode
```

Os logs do consumer são uma linha JSON por evento (`wager_message.processed`, `wager_message.duplicate`, `wager_consumer.dead_lettered`...). `docker compose stop app` manda `SIGTERM`: o consumer termina o que está em andamento e devolve o resto para a fila.

| Variável | Padrão | Uso |
|---|---|---|
| `SQS_CONSUMER_ENABLED` | `true` | liga o consumer no processo da API |
| `SQS_WAGER_DLQ_NAME` | `wager-transactions-dlq.fifo` | DLQ para onde o consumer manda os erros permanentes |
| `SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS` | `30` | quanto tempo uma mensagem recebida fica invisível |
| `SQS_CONSUMER_WAIT_TIME_SECONDS` | `10` | long polling |
| `SQS_CONSUMER_SHUTDOWN_TIMEOUT_SECONDS` | `15` | espera máxima no `SIGTERM`; precisa ser maior que o long polling |
| `SQS_CONSUMER_RETRY_BASE_SECONDS`, `SQS_CONSUMER_RETRY_MAX_SECONDS` | `5`, `300` | backoff de erro transitório |

#### Reprocessar uma mensagem da DLQ

Depois de corrigir a causa (o produtor, o payload, um bug), a mensagem volta para a fila de origem:

```bash
# 1. ler a mensagem da DLQ: guarde o Body, o MessageGroupId e o ReceiptHandle
docker compose exec -T sqs awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --message-attribute-names All --attribute-names All

# 2. enviar o mesmo Body para a fila de origem, no mesmo grupo, com um id de deduplicação novo
docker compose exec -T sqs awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <MessageGroupId> --message-deduplication-id redrive-<algo único> \
  --message-body '<Body>'

# 3. apagar da DLQ
docker compose exec -T sqs awslocal sqs delete-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --receipt-handle '<ReceiptHandle>'
```

Na AWS, o mesmo é feito em lote com `StartMessageMoveTask` (ou pelo console, "Start DLQ redrive").

É seguro reenviar sem saber se a mensagem já teve efeito: o envelope mantém o `messageId`. Se ela já tinha sido aplicada (por exemplo, foi para a DLQ pela redrive depois de um commit cujo ack se perdeu), a inbox reconhece o `messageId` e o consumer só confirma. Se nunca foi aplicada, é processada normalmente.

### Eventos publicados, referências pendentes, ledger e reconciliação

Cada instância também roda o publisher da outbox (`OUTBOX_PUBLISHER_ENABLED`) e o worker de `PENDING_REFERENCE` (`PENDING_REFERENCE_WORKER_ENABLED`), os dois ligados por padrão; as outras variáveis estão no `.env.example`. Com a aplicação de pé:

```bash
# eventos publicados (WagerTransactionProcessed, WalletBalanceChanged...), um por linha
docker compose exec -T sqs awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wagering-events.fifo \
  --max-number-of-messages 10 --attribute-names All --query 'Messages[].Body'

# ledger da wallet, 2 por página; repita com ?cursor=<nextCursor> até ele vir null
curl -s 'localhost:3000/wallets/<id da wallet>/ledger?limit=2'

# saldo guardado x saldo recalculado pelo ledger
curl -s -X POST localhost:3000/wallets/<id da wallet>/reconciliation
```

Um REFUND enviado antes da sua BET responde `202` com `PENDING_REFERENCE`. O worker confere de novo com intervalos que dobram (1, 2, 4 s...) até o teto de 60 s, então depois que a BET chega a próxima conferência pode levar até 60 s. Exemplo: REFUND em t = 0 e BET em t = 70 s; a conferência seguinte acontece entre cerca de 93 s e 123 s. Depois disso, reenviar o REFUND com a mesma chave devolve `200` com o resultado final. Se a referência não existir em 15 conferências (cerca de 4,5 a 9 min), o REFUND é rejeitado com `REFERENCE_NOT_FOUND`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | sobe a API na porta `PORT` (padrão 3000) |
| `bun run dev` | mesma coisa, reiniciando a cada alteração |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | todos os testes (unitários e de integração) |
| `bun run test:unit` | só os unitários, sem containers |
| `bun run test:integration` | só os de integração, precisam do `docker compose up -d` |
| `bun run migration:create <nome>` | cria uma migration vazia com `up()` e `down()` |
| `bun run migration:up` | aplica as migrations pendentes |
| `bun run migration:down` | reverte só a última migration aplicada |
| `bun run migration:pending` | lista as pendentes |
| `bun run migration:list` | lista as aplicadas |

As migrations usam o banco das variáveis de ambiente. Para rodar no banco de testes:
`DATABASE_NAME=wagering_test bun run migration:up`.

## Onde cada requisito é verificado

Tabela completa, requisito por requisito, com o teste que prova cada um. O resumo por item da seção 13 está no [ARCHITECTURE.md](ARCHITECTURE.md#4-testes-obrigatórios-seção-13).

<details>
<summary>Abrir a tabela</summary>


| Requisito do enunciado | Como verificar | Onde está |
|---|---|---|
| Stack: Bun, TypeScript estrito, NestJS, PostgreSQL, SQS, Docker Compose | `bun run typecheck` | `tsconfig.json`, `docker-compose.yml` |
| Migrations versionadas e reversíveis | `bun test test/integration/migrations.test.ts` aplica e reverte cada migration no `wagering_test` e compara o schema | `src/infrastructure/persistence/migrations`, `test/integration/support/migration-reversibility.ts` |
| Health de liveness e readiness, sem autenticação | `bun test test/integration/health.test.ts` | `src/interfaces/http/health.controller.ts` |
| Readiness indica qual dependência caiu | mesmo teste: fila inexistente e endpoint sem resposta devolvem 503 com `failed: ["sqs"]` | `src/application/health/check-readiness.ts` |
| Configuração inválida impede o boot | `bun run test:unit` | `src/infrastructure/config/app-config.ts` |
| Dinheiro sem `number`, escala fixa de 2 casas, entradas inválidas recusadas, conflito de moeda | `bun test test/unit/domain/money` | `src/domain/money/money.ts` |
| Wallet só nas moedas que a plataforma opera (`SUPPORTED_CURRENCIES`, padrão `BRL`) | `bun test test/integration/wagering/supported-currencies.test.ts` | `src/application/wallets/open-wallet.ts` |
| Regras de BET, WIN, LOSS, REFUND e ROLLBACK | `bun test test/unit/domain/wager` | `src/domain/wager/apply-wager-transaction.ts` |
| Invariantes da wallet (saldo nunca negativo, versão, moeda) | `bun test test/unit/domain/wallet` | `src/domain/wallet/wallet.ts` |
| Unicidade, imutabilidade e não negatividade no schema do banco | `bun test test/integration/schema` tenta violar cada garantia com SQL direto | `src/infrastructure/persistence/migrations` |
| Saldo da wallet igual ao saldo reconstruído pelo ledger | mesmos testes: o banco recusa o commit em que os dois divergem | migration `create_wallet_ledger_entries` |
| Lock por wallet sem deadlock no cenário de duas apostas de 80 com saldo 100 | `bun test test/integration/schema/wallet-lock-order.schema.test.ts` | `ARCHITECTURE.md`, seção Concorrência |
| A mesma aposta enviada 50 vezes em paralelo gera um único débito | `bun test test/integration/wagering/concurrency.test.ts` (HTTP real, `Promise.all`) | `src/application/wagering/process-wager-transaction.ts` |
| Saldo 100 e duas apostas de 80 em paralelo: uma processada, uma rejeitada por saldo insuficiente, saldo final 20,00, um débito | mesmo teste | `src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.ts` (`lockById`) |
| Wallets diferentes em paralelo, sem lock global | mesmo teste, incluindo uma wallet processada enquanto outra está travada | idem |
| Saldo da wallet igual ao saldo reconstruído pelo ledger ao fim de cada teste | todo teste de `test/integration/wagering` que movimenta uma wallet | `test/integration/wagering/support/wagering-api.ts` (`expectBalanceMatchesLedger`) |
| Idempotência persistente: replay devolve o resultado original com `idempotentReplay` e o saldo da época | `bun test test/integration/wagering/idempotency.test.ts` | `src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.ts` (`insertIfAbsent`) |
| Mesma chave com payload diferente é conflito (409) e não altera nada | mesmo teste | `src/application/wagering/process-wager-transaction.ts` |
| Hash do payload sobre JSON canônico, sem o header | `bun test test/unit/application/wagering` | `src/application/wagering/payload-hash.ts` |
| Chave de idempotência no espaço do provedor (`{providerId}:`) | `bun test test/unit/domain/wager` e `test/integration/wagering/http-status-mapping.test.ts` | `src/domain/wager/wager-transaction.ts` |
| Wallet, transação, ledger e outbox na mesma transação SQL (tudo ou nada) | `bun test test/integration/wagering/atomicity-and-outbox.test.ts` força uma falha depois do lançamento do ledger | `src/application/wagering/process-wager-transaction.ts` |
| Criar wallet grava a transação `OPENING` e o crédito na mesma transação; wallet duplicada é conflito | mesmo teste e `http-status-mapping.test.ts` | `src/application/wallets/open-wallet.ts` |
| Eventos na outbox: `WalletBalanceChanged` só quando o saldo muda (LOSS não gera) | `atomicity-and-outbox.test.ts` | `src/domain/events/wagering-events.ts` |
| Envelope dos eventos e backoff com jitter da outbox | `bun test test/unit/domain/events test/unit/domain/outbox` | `src/domain/events/integration-event.ts`, `src/domain/outbox/outbox-message.ts` |
| Status HTTP distintos para payload inválido, conflito, rejeição, pendente e falha transitória; envelope de erro único; caracteres de controle e corpo grande demais são 400 e 413, nunca 503 ou 500 | `bun test test/integration/wagering/http-status-mapping.test.ts` | `src/interfaces/http/api-exception.filter.ts`, `src/interfaces/http/wager-response-status.ts` |
| Falhas transitórias do banco viram 503 com `Retry-After`; violação de constraint, estouro numérico e `08P01` não | `bun test test/unit/infrastructure` e o teste de lock timeout em `http-status-mapping.test.ts` | `src/infrastructure/persistence/database-error-classifier.ts` |
| Crédito acima do maior saldo que a coluna guarda vira rejeição `BALANCE_LIMIT_EXCEEDED`, não erro 500 | `bun test test/unit/domain` e `http-status-mapping.test.ts` | `src/domain/wallet/wallet.ts` (`canCredit`) |
| Ponto de extensão de autenticação | leitura do código | `src/interfaces/http/provider-auth.guard.ts`, `src/application/ports/provider-identity.ts` |
| Consumer SQS reutiliza o mesmo caso de uso do HTTP; mensagem processada uma vez, com saldo, um lançamento e linha na inbox | `bun test test/integration/messaging/consumer-processing.test.ts` | `src/application/wagering/process-wager-transaction.ts` (`executeDelivery`), `src/interfaces/messaging/wager-message-handler.ts` |
| Inbox persistente por `(consumerName, messageId)`: o mesmo `messageId` duas vezes, em sequência ou em paralelo, tem um efeito só | mesmo teste | `src/infrastructure/persistence/repositories/mikro-orm-inbox.repository.ts`, `src/domain/inbox/inbox-message.ts` |
| A mesma operação por HTTP e por SQS (outro `messageId`, mesma chave) tem um efeito só | mesmo teste | chave de idempotência, seção Idempotência do `ARCHITECTURE.md` |
| Envelope da mensagem (seção 10) validado com as mesmas regras do HTTP; hash do `data` para a inbox | `bun test test/unit/interfaces/messaging` | `src/interfaces/messaging/wager-transaction-message.ts` |
| Erro de negócio com ack; transitório com retry e backoff; permanente (inclusive conflitos de chave, de `externalTransactionId` e de `messageId`) direto para a DLQ com o motivo | `bun test test/unit/interfaces/messaging` (tabela) e `consumer-processing.test.ts`, `consumer-transient-failure.test.ts` | `src/interfaces/messaging/processing-failure.ts`, `src/interfaces/messaging/retry-backoff.ts` |
| Lock timeout, deadlock e falha de serialização repetidos no próprio processo, sem devolver as mensagens seguintes da wallet para a fila | `bun test test/unit/application/retry-on-contention.test.ts` e o teste da wallet disputada em `consumer-message-groups.test.ts` | `src/application/retry-on-contention.ts` |
| Mensagem de uma wallet criada depois dela: retry até a wallet existir | `consumer-transient-failure.test.ts` | `src/interfaces/messaging/processing-failure.ts` |
| Caracteres de controle recusados no domínio, para qualquer entrada | `bun test test/unit/domain/wager` | `src/domain/wager/wager-transaction.ts` |
| Ack só depois do commit; processo morto depois do commit e antes do ack não duplica nada | `bun test test/integration/messaging/consumer-crash-before-ack.test.ts` (processo filho real com `SIGKILL`) | `src/interfaces/messaging/sqs-wager-consumer.ts` |
| `SIGTERM`: mensagens em andamento terminam, as não iniciadas voltam para a fila | `bun test test/integration/messaging/consumer-shutdown.test.ts` (roda `src/main.ts` num processo filho) | `src/wager-consumer.module.ts`, `src/interfaces/messaging/sqs-wager-consumer.ts` (`stop`) |
| Wallets diferentes em paralelo, a mesma wallet em ordem (FIFO por `MessageGroupId`) | `bun test test/integration/messaging/consumer-message-groups.test.ts` | `src/interfaces/messaging/sqs-wager-consumer.ts` |
| Limite de tentativas antes da DLQ (`maxReceiveCount = 10`) | `bun test test/integration/messaging/consumer-transient-failure.test.ts`: com o banco inacessível e `maxReceiveCount` 2, a redrive move a mensagem para a DLQ, sem os atributos do consumer | `docker/ministack/init-queues.sh` |
| Publishers concorrentes na mesma outbox: todo evento publicado, nenhum perdido, nenhum enviado duas vezes, ordem por wallet | `bun test test/integration/messaging/outbox-publisher.test.ts` (dois apps, 48 eventos de 6 wallets) | `src/application/outbox/publish-outbox.ts`, `src/infrastructure/persistence/repositories/mikro-orm-outbox.repository.ts` (`claimBatch`) |
| Publisher morto depois do claim (antes ou depois do envio): outra instância publica quando o lease vence, a cópia é descartada pela deduplicação | `bun test test/integration/messaging/outbox-publisher-crash.test.ts` (processo filho real com `SIGKILL`) | `src/infrastructure/messaging/sqs-event-publisher.ts` |
| Falha do SQS na publicação: retry com backoff, a wallet espera o evento que falhou, publicado depois | `outbox-publisher.test.ts` (fila de eventos criada só depois da primeira falha) | `src/domain/outbox/outbox-message.ts` (`scheduleRetry`) |
| Um evento publicado não muda, e um não publicado não pode ser apagado | `bun test test/integration/schema/inbox-outbox.schema.test.ts` | migration `outbox_publication` |
| REFUND ou ROLLBACK antes da referência, por HTTP e por SQS: `202`, a BET chega, o worker processa, o replay devolve o resultado final | `bun test test/integration/wagering/pending-reference-worker.test.ts test/integration/messaging/consumer-reference-before-bet.test.ts` | `src/application/wagering/resolve-pending-references.ts`, `src/application/wagering/apply-and-record.ts` |
| Referência que nunca chega: `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`; referência que existe e ainda espera mantém a dependente esperando (cadeia ROLLBACK, REFUND, BET atrasada); dois workers na mesma linha resolvem uma vez; uma linha que falha (lock ou COMMIT) não segura as outras | `pending-reference-worker.test.ts` e `bun test test/unit/domain/wager/reference-wait-policy.test.ts` | `src/domain/wager/reference-wait-policy.ts` |
| Ledger paginado por cursor estável e opaco, sem buraco nem repetição com lançamentos novos; cursor ou limite inválido é `400` | `bun test test/integration/wagering/ledger-pagination.test.ts test/unit/interfaces/http` | `src/interfaces/http/ledger-cursor.ts`, `src/application/wallets/get-wallet-ledger.ts` |
| Reconciliação: divergência logada, contada e sinalizada, nunca corrigida | `bun test test/integration/wagering/reconciliation.test.ts test/unit/domain/wallet/wallet-reconciliation.test.ts` | `src/application/wallets/reconcile-wallet.ts`, `src/domain/wallet/wallet-reconciliation.ts` |
| Três processos reais (`src/main.ts`) ao mesmo tempo, com HTTP em round-robin e SQS: wallet disputada (30 apostas de 10,00 contra 100,00, exatamente 10 débitos), a mesma aposta em três instâncias e dois canais, pares REFUND/ROLLBACK, REFUND antes da BET; no fim saldo igual ao ledger, nunca negativo, um efeito por operação, filas vazias, todo evento publicado | `bun test test/integration/multi-instance/three-instances.test.ts` | `test/integration/multi-instance/support/cluster.ts` |
| Instância morta com `SIGKILL` segurando uma mensagem SQS e uma requisição HTTP: reenvio com a mesma chave, redelivery para outra instância, processo substituto; depois `SIGTERM` em todas e processos novos terminam a mensagem, a referência pendente e a outbox deixadas para trás | `bun test test/integration/multi-instance/restart.test.ts` | `src/interfaces/messaging/sqs-wager-consumer.ts`, `src/application/wagering/resolve-pending-references.ts`, `src/application/outbox/publish-outbox.ts` |

</details>

## Health checks

- `GET /health/live`: 200 se o processo responde. Não consulta dependências.
- `GET /health/ready`: 200 se PostgreSQL (`select 1`) e SQS (`GetQueueUrl` da fila principal) respondem; 503 com o nome da dependência que falhou.

## Por que MiniStack e não LocalStack

O enunciado aceita LocalStack ou MiniStack. A imagem `localstack/localstack:latest` (versão 2026.9.0) encerra com código 55 quando não recebe `LOCALSTACK_AUTH_TOKEN`. O MiniStack (`ministackorg/ministack`, licença MIT) não exige conta e suporta filas FIFO com `RedrivePolicy`.
