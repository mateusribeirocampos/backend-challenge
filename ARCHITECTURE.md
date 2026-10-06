# Arquitetura

Este documento registra as decisões técnicas do processador de transações de apostas, com o contexto de cada uma, as alternativas descartadas e o custo aceito. Ele cresce junto com o código: cada parte entregue traz a sua seção.

Como executar e onde cada requisito é verificado: [README.md](README.md).

## Visão geral

O código é dividido em camadas, e a dependência aponta sempre para dentro:

```
interfaces (HTTP)  ─┐
                    ├──>  application (casos de uso e portas)  ──>  domain (regras puras)
infrastructure  ────┘
(PostgreSQL, SQS, config)
```

| Pasta | Responsabilidade | Pode depender de |
|---|---|---|
| `src/domain` | regras de negócio e invariantes, sem framework | nada além de `decimal.js` |
| `src/application` | casos de uso e portas (interfaces que a infraestrutura implementa) | `domain` |
| `src/infrastructure` | adaptadores: MikroORM, SQS, configuração | `application`, `domain` |
| `src/interfaces` | entrada HTTP (controllers) | `application` |

Exemplo do padrão porta e adaptador: o readiness depende da porta `DependencyCheck` (`src/application/health/check-readiness.ts`). `DatabaseCheck` e `SqsQueueCheck`, na infraestrutura, implementam essa porta. A camada de aplicação não sabe que existe PostgreSQL.

## Correção financeira

### Money

`Money` (`src/domain/money/money.ts`) é um objeto de valor imutável sobre `decimal.js`, como no esqueleto do enunciado. Dinheiro nunca passa por `number`.

- **Entrada:** a string precisa casar com `^(0|[1-9]\d*)(\.\d{1,2})?$` antes de virar `Decimal`. Isso recusa `NaN`, `Infinity`, notação científica, string vazia, mais de duas casas e negativos. O próprio `Decimal` aceitaria `"1e3"` e `"Infinity"`, por isso a validação vem antes.
- **Escala:** sempre duas casas na saída (`"25.00"`).
- **Arredondamento:** não existe no fluxo normal. A entrada tem no máximo duas casas e as operações são soma e subtração, que preservam a escala. Mais de duas casas é recusado, não arredondado: arredondar em silêncio mudaria o valor enviado pelo provedor.
- **Moeda:** somar ou comparar moedas diferentes lança erro de domínio. O desafio usa só BRL, mas o modelo é multimoeda e o conflito é testado.
- **Persistência:** colunas `numeric(20,2)`, que o driver devolve como string. O caminho do banco até o `Money` também não passa por `number`.
- **Limite:** no máximo 18 dígitos inteiros, para que um valor que não cabe na coluna seja erro de domínio e não estouro no banco.

Um teste (`test/unit/domain/no-number-for-money.test.ts`) falha se `parseFloat`, `Number(`, `.toNumber(` ou `Math.round(` aparecerem no domínio.

`bigint` em centavos foi considerado. É exato e não tem dependência, mas exigiria converter `"25.00"` para `2500n` à mão e escrever um serializador próprio (`JSON.stringify` não aceita `bigint`). O ganho de desempenho não importa aqui, porque o gargalo é o banco.

### Regras de negócio numa função pura

`applyWagerTransaction` (`src/domain/wager/apply-wager-transaction.ts`) recebe a wallet, a transação, a referência já resolvida e a informação de se essa referência já foi revertida. Ela devolve um de três resultados: processada (com o lançamento do ledger e o saldo final), rejeitada (com o `failureCode`, saldo inalterado) ou aguardando a referência. A função não acessa banco nem relógio. A camada de aplicação faz a busca, o lock e a gravação; o domínio só decide.

| Operação | Efeito | Regra |
|---|---|---|
| `BET` | débito | sem saldo: `INSUFFICIENT_FUNDS` |
| `WIN` | crédito | referência opcional; se houver, precisa ser uma `BET` |
| `LOSS` | nenhum | sem lançamento no ledger |
| `REFUND` | crédito | referência obrigatória a uma `BET` processada, com o mesmo valor |
| `ROLLBACK` | inverso da referência | `BET` vira crédito; `WIN` e `REFUND` viram débito. Sem saldo: `REVERSAL_WOULD_OVERDRAW`, distinto de `INSUFFICIENT_FUNDS` |

A referência precisa ser do mesmo provider, player, wallet, moeda e rodada. Referência ainda inexistente ou não terminada deixa a transação em `PENDING_REFERENCE`.

### Interpretações onde o enunciado é omisso

- **Uma transação só pode ser revertida uma vez, por qualquer tipo de reversão.** A regra 4 do enunciado proíbe reverter duas vezes pelo mesmo tipo, mas não trata REFUND seguido de ROLLBACK. Com saldo 100: BET de 25 (75), REFUND (100), ROLLBACK da mesma BET (125). A aposta seria devolvida duas vezes, o que viola a invariante de não duplicar créditos. A segunda reversão é rejeitada com `REFERENCE_ALREADY_REVERSED`. Para desfazer um REFUND, o provedor faz o ROLLBACK do REFUND.
- **Aposta revertida não pode ser liquidada.** WIN ou LOSS referenciando uma BET já revertida é rejeitado. Sem isso, BET 25, REFUND e WIN 60 pagariam prêmio numa aposta cancelada.
- **REFUND de uma BET que já teve WIN é permitido.** O enunciado não define aposta liquidada. Para cancelar a rodada inteira, o provedor faz também o ROLLBACK do WIN.
- **Valores:** BET, WIN, REFUND e ROLLBACK precisam ser maiores que zero. Um WIN de zero é um LOSS. LOSS aceita zero e nunca move saldo.
- **OPENING:** só nasce na abertura da wallet. A factory pública recusa esse tipo, e o provider `internal` é reservado.
- **Wallet de outro player:** rejeitada com `WALLET_PLAYER_MISMATCH`, sem devolver o saldo daquela wallet.

### Códigos de falha

Os códigos ficam em dois grupos, porque pedem ações diferentes do provedor:

- **`FailureCode`** (`src/domain/wager/failure-code.ts`): a transação foi identificada e decidida, e fica gravada como `REJECTED` ou `FAILED` com o código. Reenviar devolve o mesmo resultado.
- **`ContractViolationCode`**: o payload nem vira transação (por exemplo, REFUND sem referência ou OPENING enviado de fora). Nada é gravado, e o provedor precisa corrigir o payload.

| failureCode | Quando | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | desistir |
| `REVERSAL_WOULD_OVERDRAW` | ROLLBACK que deixaria o saldo negativo | desistir e acionar suporte |
| `CURRENCY_MISMATCH` | moeda diferente da moeda da wallet | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | wallet de outro player | corrigir o payload |
| `REFERENCE_INVALID_KIND` | referência de um tipo não permitido | corrigir o payload |
| `REFERENCE_MISMATCH` | referência de outro provider, player, wallet, moeda ou rodada | corrigir o payload |
| `AMOUNT_MISMATCH` | valor da reversão diferente do valor da referência | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | referência terminou rejeitada ou com falha | desistir |
| `REFERENCE_ALREADY_REVERSED` | a referência já foi revertida | desistir: o dinheiro já voltou |
| `REFERENCE_NOT_FOUND` | a referência não chegou dentro do prazo | desistir ou investigar |

## Concorrência

A unidade de concorrência é a wallet. Toda operação trava a linha da sua wallet com `SELECT ... FOR NO KEY UPDATE` dentro da transação SQL. Não existe lock global: wallets diferentes são processadas em paralelo.

**Por que `FOR NO KEY UPDATE` e não `FOR UPDATE`.** O fluxo grava a transação antes de travar a wallet (a gravação é o que garante a idempotência). A chave estrangeira dessa gravação faz o PostgreSQL pegar um lock `KEY SHARE` na wallet até o fim da transação. `FOR UPDATE` conflita com `KEY SHARE`. Com duas apostas diferentes na mesma wallet, cada transação esperaria o `KEY SHARE` da outra, e o PostgreSQL abortaria uma delas por deadlock. `FOR NO KEY UPDATE` é o lock de quem altera só colunas que não são chave (saldo e versão) e não conflita com `KEY SHARE`. A segunda transação apenas espera a primeira terminar e lê o saldo atualizado.

O `LockMode.PESSIMISTIC_WRITE` do MikroORM gera `FOR UPDATE`, por isso o lock é uma query explícita.

O teste `test/integration/schema/wallet-lock-order.schema.test.ts` reproduz o cenário do enunciado (saldo 100, duas apostas de 80) com duas conexões reais. Com `FOR NO KEY UPDATE`, as duas transações terminam em série: uma processada, outra rejeitada por saldo insuficiente, saldo final 20,00 e um único débito. Com `FOR UPDATE`, uma das duas recebe `40P01`. A coordenação entre as conexões usa `pg_blocking_pids`, sem `sleep`.

## Consistência entre saldo e ledger

O saldo da wallet é materializado (coluna `balance`) e o ledger guarda cada movimentação. Os dois são escritos na mesma transação SQL, e o PostgreSQL confere a consistência entre eles.

**No domínio:** `wallet.debit()` e `wallet.credit()` devolvem o lançamento que produzem. Não existe forma de mudar o saldo sem gerar o lançamento. `WalletLedgerEntry.create` confere `saldo antes ± valor = saldo depois`.

**No banco:** cada lançamento guarda `wallet_version`, a versão da wallet depois dele. O ledger de cada wallet forma uma cadeia:

- o primeiro lançamento começa em 0,00, na versão 1 se for o crédito de abertura ou na versão 2 se a wallet abriu com saldo zero;
- cada lançamento seguinte começa no saldo em que o anterior terminou, com a versão anterior mais um (trigger `wallet_ledger_entries_chain`);
- `UNIQUE (wallet_id, wallet_version)` impede dois lançamentos na mesma posição;
- no COMMIT, duas constraint triggers diferidas exigem que o saldo e a versão da wallet sejam iguais aos do último lançamento.

Juntas, essas regras garantem a invariante final do enunciado, `wallet.balance == saldo reconstruído pelo ledger`, em todo commit. Um código que atualizasse o saldo e esquecesse o lançamento teria o commit recusado. A checagem é diferida para o COMMIT porque, dentro da transação, a atualização da wallet e a gravação do lançamento são dois comandos, e entre eles o estado é inconsistente por um instante.

A cadeia também protege contra lost update:

- **Duas transações abertas ao mesmo tempo** que calculam a mesma próxima versão: a segunda espera no índice único e falha com `23505`.
- **Uma transação que leu um estado antigo e grava depois de outra já ter commitado:** o trigger da cadeia recusa com `23514`.

| Garantia no schema | Mecanismo |
|---|---|
| saldo nunca negativo | `CHECK` em `wallets.balance` e em `balance_after` |
| saldo e versão iguais ao último lançamento | constraint triggers diferidas |
| ledger contínuo, sem lacunas | trigger de cadeia e `UNIQUE (wallet_id, wallet_version)` |
| aritmética de cada lançamento | `CHECK` |
| lançamento com o valor, a moeda e a wallet da sua transação | chaves estrangeiras compostas |
| ledger imutável | triggers que recusam `UPDATE`, `DELETE` e `TRUNCATE` |
| transação em estado terminal imutável | trigger em `wager_transactions` |
| idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| reversão única, de qualquer tipo | índice único parcial em `reference_transaction_id` |
| uma wallet por player e moeda; uma abertura por wallet | `UNIQUE` e índice parcial |

**O que fica só no domínio, por escolha:** que o lançamento pertença a uma transação processada, que a direção bata com o tipo da operação, que LOSS e transações rejeitadas não tenham lançamento e as demais regras de negócio. Levar essas regras para o banco exigiria triggers lendo outras tabelas, com a mesma regra mantida em dois lugares. As falhas que movimentariam dinheiro em dobro (reversão dupla, débito duplicado, saldo divergente do ledger) já estão cobertas pelo schema.

Cada garantia tem um teste de integração que tenta violá-la com SQL direto e confere o código de erro e o nome da constraint (`test/integration/schema`).

## Stack e infraestrutura

### MikroORM 7 com mapeamento fora do domínio

O MikroORM é o ORM preferencial do enunciado. Usamos a versão 7, a estável atual, que é a do guia oficial.

O ponto que pesou na escolha é a fronteira transacional explícita. A Unit of Work e o `em.transactional()` deixam claro onde começa e termina cada transação, e é nesse ponto que o desafio é avaliado. O mapeamento das entidades usa `defineEntity` na infraestrutura, e não decorators nas classes de domínio. Assim o domínio fica sem nenhuma dependência do ORM, como o enunciado exige.

`allowGlobalContext: false` obriga cada requisição a usar o seu próprio `EntityManager`. Sem isso, duas requisições concorrentes compartilhariam o mesmo identity map, e uma poderia ver entidades carregadas pela outra.

### Migrations escritas à mão, versionadas e reversíveis

As migrations são a fonte da verdade do schema. CHECKs, índices únicos parciais e triggers, que carregam boa parte das garantias do sistema, não são expressáveis no mapeamento das entidades. Um diff gerado a partir das entidades proporia removê-los. Por isso:

- toda migration é escrita à mão, com `up()` e `down()`;
- o snapshot e a geração por diff estão desligados (`snapshot: false`);
- não existe comando de `schema:update` no projeto;
- cada migration roda em transação, então uma falha no meio não deixa o schema pela metade;
- uma migration já aplicada nunca é editada; uma correção vira uma migration nova.

A reversibilidade é provada por teste. `test/integration/support/migration-reversibility.ts` aplica uma migration por vez no banco de teste, reverte uma por vez e compara o catálogo do PostgreSQL (colunas, constraints, índices, triggers, funções) antes e depois de cada passo. O próprio helper tem um teste com um `down()` incompleto de propósito, para provar que ele detecta a falha.

As migrations rodam por um script próprio (`scripts/migrate.ts`), que usa a mesma configuração da aplicação. Não existe uma segunda configuração para manter.

Limitação conhecida: reverter o schema não recupera dados. O `down()` de uma tabela que já recebeu registros apaga esses registros.

### MiniStack no lugar do LocalStack

O enunciado aceita LocalStack ou MiniStack. A imagem atual do LocalStack (`localstack/localstack:latest`, versão 2026.9.0) encerra com código 55 quando não recebe um token de licença (`LOCALSTACK_AUTH_TOKEN`). O MiniStack tem licença MIT, não exige conta e suporta o que o desafio precisa: filas FIFO, `RedrivePolicy` e scripts de inicialização. As filas são criadas por `docker/ministack/init-queues.sh`, que faz localmente o papel que o Terraform ou o CloudFormation teriam na AWS.

Filas:

| Fila | Uso |
|---|---|
| `wager-transactions.fifo` | entrada de transações; após 5 recebimentos sem sucesso, a mensagem vai para a DLQ |
| `wager-transactions-dlq.fifo` | mensagens que esgotaram as tentativas |
| `wagering-events.fifo` | eventos publicados pela outbox |

O enunciado só nomeia as duas primeiras. A fila de eventos é uma interpretação: a outbox precisa de um destino para publicar.

### Health checks separados

- `GET /health/live` responde se o processo está vivo e não consulta nenhuma dependência.
- `GET /health/ready` verifica o PostgreSQL (`select 1`) e o SQS (`GetQueueUrl` da fila principal), cada um com timeout de 2 segundos. Quando algo falha, responde 503 com o nome da dependência.

A separação existe por causa do que um orquestrador faz com cada resposta. Falha de liveness reinicia o container. Falha de readiness só tira a instância do balanceamento. Se o liveness consultasse o banco, uma queda de 30 segundos do PostgreSQL faria todas as instâncias reiniciarem ao mesmo tempo, sem resolver nada, porque o problema não está no processo.

O motivo detalhado da falha vai para o log e não para a resposta, porque os endpoints de health são públicos.

### Configuração validada no boot

As variáveis de ambiente são validadas com zod antes de qualquer conexão (`src/infrastructure/config/app-config.ts`). Com uma configuração inválida o processo não sobe, e a mensagem lista todas as variáveis com problema de uma vez. A alternativa seria descobrir o erro minutos depois, na primeira query, com uma mensagem do driver que não diz qual variável está errada.

### Várias instâncias no Docker Compose

`docker compose --profile app up -d --build --scale app=3` sobe três instâncias da aplicação. Decisões envolvidas:

- **Um serviço `migrate` roda as migrations uma vez**, e as instâncias só sobem depois que ele termina. Três instâncias aplicando migrations ao mesmo tempo disputariam a tabela de histórico.
- **As instâncias não fixam porta no host.** O Docker escolhe uma porta livre para cada réplica, então o `--scale` não colide.
- **A aplicação fica num profile separado** (`app`). Assim, `docker compose up -d` sobe só a infraestrutura, e as instâncias não consomem as mensagens que os testes de integração colocam na fila.

## Limitações conhecidas

- A configuração local usa credenciais fictícias (`test`/`test`) aceitas pelo emulador. Em produção, as credenciais da AWS viriam da cadeia padrão do SDK (por exemplo, uma role de IAM), e o código já trata `SQS_ENDPOINT` e as chaves vazias dessa forma.
