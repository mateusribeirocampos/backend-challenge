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
- MiniStack com as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (DLQ, `maxReceiveCount=5`) e `wagering-events.fifo` (eventos publicados pela outbox).

Os testes de integração usam o PostgreSQL e o SQS reais dos containers. Nenhum dos dois é substituído por mock.

### Onde cada requisito é verificado

| Requisito do enunciado | Como verificar | Onde está |
|---|---|---|
| Stack: Bun, TypeScript estrito, NestJS, PostgreSQL, SQS, Docker Compose | `bun run typecheck` | `tsconfig.json`, `docker-compose.yml` |
| Migrations versionadas e reversíveis | `bun test test/integration/migrations.test.ts` aplica e reverte cada migration no `wagering_test` e compara o schema | `src/infrastructure/persistence/migrations`, `test/integration/support/migration-reversibility.ts` |
| Health de liveness e readiness, sem autenticação | `bun test test/integration/health.test.ts` | `src/interfaces/http/health.controller.ts` |
| Readiness indica qual dependência caiu | mesmo teste: fila inexistente e endpoint sem resposta devolvem 503 com `failed: ["sqs"]` | `src/application/health/check-readiness.ts` |
| Configuração inválida impede o boot | `bun run test:unit` | `src/infrastructure/config/app-config.ts` |
| Dinheiro sem `number`, escala fixa de 2 casas, entradas inválidas recusadas, conflito de moeda | `bun test test/unit/domain/money` | `src/domain/money/money.ts` |
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

O serviço `migrate` roda as migrations uma vez antes das instâncias subirem. As instâncias ficam no profile `app` para não consumirem mensagens das filas enquanto `bun test` roda no host.

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

## Health checks

- `GET /health/live`: 200 se o processo responde. Não consulta dependências.
- `GET /health/ready`: 200 se PostgreSQL (`select 1`) e SQS (`GetQueueUrl` da fila principal) respondem; 503 com o nome da dependência que falhou.

## Por que MiniStack e não LocalStack

O enunciado aceita LocalStack ou MiniStack. A imagem `localstack/localstack:latest` (versão 2026.9.0) encerra com código 55 quando não recebe `LOCALSTACK_AUTH_TOKEN`. O MiniStack (`ministackorg/ministack`, licença MIT) não exige conta e suporta filas FIFO com `RedrivePolicy`.
