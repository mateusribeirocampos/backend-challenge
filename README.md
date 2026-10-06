# backend-challenge

Processador distribuído de transações de apostas (desafio técnico Jungle Gaming).
Stack: Bun, TypeScript estrito, NestJS, MikroORM 7 com PostgreSQL, SQS emulado pelo MiniStack.

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

### Conferindo à mão

```bash
bun run start
curl -i localhost:3000/health/live
curl -i localhost:3000/health/ready
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
