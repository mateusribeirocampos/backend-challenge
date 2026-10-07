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
| `src/interfaces` | entrada HTTP (controllers, validação do contrato, mapeamento de erros) | `application`, e os tipos e erros de `domain` |

Exemplo do padrão porta e adaptador: o readiness depende da porta `DependencyCheck` (`src/application/health/check-readiness.ts`). `DatabaseCheck` e `SqsQueueCheck`, na infraestrutura, implementam essa porta. A camada de aplicação não sabe que existe PostgreSQL.

Os casos de uso (`src/application/wallets`, `src/application/wagering`) são classes comuns, sem decorator do Nest. Eles dependem de portas: `TransactionRunner` e os repositórios (`src/application/ports`), `Clock` e `IdGenerator`. O único lugar que liga cada porta ao seu adaptador é `src/wagering.module.ts`.

## Correção financeira

### Money

`Money` (`src/domain/money/money.ts`) é um objeto de valor imutável sobre `decimal.js`, como no esqueleto do enunciado. Dinheiro nunca passa por `number`.

- **Entrada:** a string precisa casar com `^(0|[1-9]\d*)(\.\d{1,2})?$` antes de virar `Decimal`. Isso recusa `NaN`, `Infinity`, notação científica, string vazia, mais de duas casas e negativos. O próprio `Decimal` aceitaria `"1e3"` e `"Infinity"`, por isso a validação vem antes.
- **Escala:** sempre duas casas na saída (`"25.00"`).
- **Arredondamento:** não existe no fluxo normal. A entrada tem no máximo duas casas e as operações são soma e subtração, que preservam a escala. Mais de duas casas é recusado, não arredondado: arredondar em silêncio mudaria o valor enviado pelo provedor.
- **Moeda:** somar ou comparar moedas diferentes lança erro de domínio. O desafio usa só BRL, mas o modelo é multimoeda e o conflito é testado.
- **Código de moeda:** precisa ter o formato ISO 4217 (três letras maiúsculas) **e** existir na tabela ISO 4217 do runtime (`Intl.supportedValuesOf('currency')`, ECMA-402). Assim, `ABC` é recusado. Essa tabela inclui códigos históricos (`HRK`), metais (`XAU`) e fundos (`USN`), que são aceitos. `XXX` ("sem moeda") e `XTS` (reservado para testes) são recusados, porque não são dinheiro que uma wallet possa guardar. A tabela vem dos dados ICU do runtime e pode mudar com a versão; a CI fixa a versão do Bun. O banco confere só o formato. Em produção, a lista seria um catálogo próprio, versionado a partir da publicação oficial da SIX, a agência que mantém a ISO 4217.
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
- **Saldo máximo:** a coluna `numeric(20,2)` guarda até 999999999999999999,99, o mesmo limite de 18 dígitos inteiros que `Money.from` aceita. Um crédito que passaria disso (WIN, REFUND ou ROLLBACK de aposta) é rejeitado com `BALANCE_LIMIT_EXCEEDED`, gravado e devolvido no replay como qualquer rejeição (`Wallet.canCredit`). Sem a regra, o banco recusaria com estouro numérico (`22003`) e o provedor receberia um 500 sem resultado gravado. O `22003` continua classificado como erro não transitório, como última barreira.

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
| `BALANCE_LIMIT_EXCEEDED` | o crédito passaria do maior saldo que a coluna guarda (999999999999999999,99) | desistir e acionar suporte |

## Concorrência

A unidade de concorrência é a wallet. Toda operação trava a linha da sua wallet com `SELECT ... FOR NO KEY UPDATE` dentro da transação SQL. Não existe lock global: wallets diferentes são processadas em paralelo.

**Por que `FOR NO KEY UPDATE` e não `FOR UPDATE`.** O fluxo grava a transação antes de travar a wallet (a gravação é o que garante a idempotência). A chave estrangeira dessa gravação faz o PostgreSQL pegar um lock `KEY SHARE` na wallet até o fim da transação. `FOR UPDATE` conflita com `KEY SHARE`. Com duas apostas diferentes na mesma wallet, cada transação esperaria o `KEY SHARE` da outra, e o PostgreSQL abortaria uma delas por deadlock. `FOR NO KEY UPDATE` é o lock de quem altera só colunas que não são chave (saldo e versão) e não conflita com `KEY SHARE`. A segunda transação apenas espera a primeira terminar e lê o saldo atualizado.

O `LockMode.PESSIMISTIC_WRITE` do MikroORM gera `FOR UPDATE`, por isso o lock é uma query explícita.

O teste `test/integration/schema/wallet-lock-order.schema.test.ts` reproduz o cenário do enunciado (saldo 100, duas apostas de 80) com duas conexões reais. Com `FOR NO KEY UPDATE`, as duas transações terminam em série: uma processada, outra rejeitada por saldo insuficiente, saldo final 20,00 e um único débito. Com `FOR UPDATE`, uma das duas recebe `40P01`. A coordenação entre as conexões usa `pg_blocking_pids`, sem `sleep`.

### O processamento de uma transação

`ProcessWagerTransaction` (`src/application/wagering/process-wager-transaction.ts`) é o caso de uso único de entrada de transações. Antes de abrir a transação SQL ele valida o contrato (`WagerTransaction.create`) e calcula o hash do payload. Depois, numa única transação SQL:

1. grava a transação como `PENDING` com `INSERT ... ON CONFLICT DO NOTHING` (idempotência, seção seguinte);
2. trava a wallet com `SELECT ... FOR NO KEY UPDATE`;
3. busca a referência por `(providerId, referenceExternalTransactionId)` e se ela já foi revertida;
4. chama `applyWagerTransaction`, a função pura do domínio;
5. grava o novo saldo, o resultado da transação, o lançamento do ledger e os eventos da outbox;
6. faz o COMMIT. Qualquer erro antes disso desfaz tudo.

A referência e a pergunta "já foi revertida?" são lidas depois do lock. Como uma reversão só é aceita se for da mesma wallet, duas reversões da mesma aposta disputam o mesmo lock e a segunda vê a primeira já commitada.

**Isolamento.** `READ COMMITTED`, o padrão do PostgreSQL, declarado no código (`src/infrastructure/persistence/mikro-orm-transaction-runner.ts`). O desenho depende dele: depois de esperar o lock, o próximo comando enxerga o que a outra transação commitou. Com saldo 100 e duas apostas de 80, a segunda espera, lê 20 e é rejeitada. `SERIALIZABLE` também seria correto, mas trocaria a espera por erros `40001` que exigem retry na aplicação.

**Tempo máximo de espera.** Cada transação começa com `SET LOCAL lock_timeout = '2s'`. Uma wallet travada por mais tempo (uma transação presa, um `UPDATE` manual) faz a requisição falhar com `55P03`, que vira HTTP 503 com `Retry-After`. Sem o limite, as requisições se acumulariam esperando e esgotariam o pool de conexões. O `SET LOCAL` vale só para a transação, então a conexão volta limpa para o pool.

**Erros transitórios.** `src/infrastructure/persistence/database-error-classifier.ts` decide o que pode dar certo numa nova tentativa: lock timeout (`55P03`), deadlock (`40P01`), falha de serialização (`40001`), banco reiniciando ou fora (`57P01`, `57P03`, `08000`, `08001`, `08003`, `08006`, `ECONNREFUSED`). Esses viram `TransientInfrastructureError` e HTTP 503. O que falharia de novo com o mesmo payload não é transitório: violação de constraint, estouro numérico (`22003`) e `08P01` (protocol violation). O `08P01` fica de fora da classe `08` de propósito: o PostgreSQL o devolve, por exemplo, para um byte NUL num parâmetro de texto. Classificado como transitório, ele dizia ao provedor para reenviar para sempre um payload que nunca vai passar (e, na fila, viraria retry infinito em vez de DLQ).

**Como é provado** (`test/integration/wagering/concurrency.test.ts`, requisições HTTP reais disparadas juntas com `Promise.all`, contra o PostgreSQL real):

| Cenário | Resultado verificado |
|---|---|
| a mesma aposta enviada 50 vezes em paralelo | uma resposta 201, 49 respostas 200 de replay, um único débito |
| saldo 100, duas apostas diferentes de 80 em paralelo | uma processada, uma rejeitada com `INSUFFICIENT_FUNDS`, saldo 20,00, um débito; reenviar as duas devolve as respostas originais |
| saldo 100, dez apostas de 15 em paralelo | exatamente seis débitos, saldo 10,00 |
| REFUND e ROLLBACK da mesma aposta em paralelo | uma reversão processada, a outra `REFERENCE_ALREADY_REVERSED` |
| cinco wallets com quatro apostas cada, todas em paralelo | cada wallet termina com o seu saldo correto |
| wallet A travada por outra sessão | uma aposta na wallet B é processada sem esperar |

Todo teste que movimenta uma wallet termina conferindo que o saldo dela é igual ao saldo reconstruído pelo ledger. Trocar o lock por `FOR UPDATE` faz o cenário das duas apostas de 80 falhar (deadlock, 503); remover o lock faz o banco recusar o segundo débito.

## Idempotência

A fonte da verdade é a tabela `wager_transactions`. Não existe cache: a deduplicação vale entre instâncias e depois de um restart.

**Gravar primeiro.** O caso de uso tenta gravar a transação antes de qualquer outra coisa:

```sql
insert into wager_transactions (...)
select ...
 where exists (select 1 from wallets where id = $wallet)
on conflict do nothing
returning id
```

- Gravou: esta requisição é a dona da operação e segue para o processamento.
- Não gravou: a operação já existe (ou a wallet não existe). O `ON CONFLICT` sem alvo cobre as duas chaves únicas, `idempotency_key` e `(provider_id, external_transaction_id)`.

Quando duas requisições com a mesma chave chegam juntas, a segunda espera no índice único até a primeira terminar. Se a primeira commitou, a segunda não grava e lê a linha já com o resultado final. Por isso não existe o estado "em andamento" visível para outra requisição, e não foi preciso um código de resposta para ele.

**Replay ou conflito.** Se a linha com a mesma chave existe:

- mesmo `payload_hash`: replay. A resposta é montada só com o que está gravado (status, `failure_code`, `result_balance_amount`), então o corpo é idêntico ao da primeira resposta, com `idempotentReplay: true`. O saldo devolvido é o daquele momento: uma aposta de 25 com saldo 100 devolve 75 no replay, mesmo que a wallet esteja em 45 agora;
- `payload_hash` diferente: `409 IDEMPOTENCY_KEY_CONFLICT`, sem alterar nada.

Se a chave não existe, mas o par `(providerId, externalTransactionId)` já existe com outra chave, a resposta é `409 EXTERNAL_TRANSACTION_ID_CONFLICT`. Se nenhum dos dois existe, o insert foi pulado porque a wallet não existe: `404 WALLET_NOT_FOUND`, e nada é gravado (`wallet_id` é chave estrangeira).

**Hash do payload** (`src/application/wagering/payload-hash.ts`): `sha256` em hexadecimal do JSON canônico dos campos de negócio.

- Campos: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId` quando existe.
- Fora do hash: o header `Idempotency-Key` e qualquer metadado de transporte.
- Normalização: o valor passa por `Money` (`"25"` vira `"25.00"`) e os UUIDs ficam em minúsculas.
- JSON canônico: chaves ordenadas em todos os níveis e sem espaços.

O teste unitário fixa o hash de um payload de exemplo, calculado fora do código com `sha256sum`. Mudar o algoritmo faria todo replay antigo virar conflito, então o teste falha se isso acontecer.

**A chave pertence ao provedor.** O header `Idempotency-Key` é obrigatório e precisa começar com `{providerId}:` (`WagerTransaction.create`). Sem essa regra, o provedor B poderia enviar `provider-a:transaction-123` e ocupar a chave do provedor A, que receberia conflito na sua própria operação. A mesma regra protege o espaço `internal:` das aberturas de wallet. Pelo mesmo motivo, `providerId` não pode conter `:`.

**Como é provado:** `test/integration/wagering/idempotency.test.ts` (replay com o saldo original depois de outras operações, `"25"` e `"25.00"` como a mesma operação, conflito sem efeito, conflito de `externalTransactionId`, wallet inexistente sem linha gravada, replay de rejeição) e `test/unit/application/wagering/payload-hash.test.ts`.

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

### Ordem das escritas e atomicidade

Dentro da transação SQL, as escritas seguem as chaves estrangeiras: wallet, transação, lançamento do ledger e, por último, outbox. Os repositórios executam cada comando na hora (`em.insert`, `em.nativeUpdate` ou SQL explícito), sem depender da ordem que a Unit of Work do MikroORM escolheria num `flush`. Assim a ordem que o banco vê é a ordem escrita no caso de uso.

A coluna `version` da wallet é mapeada como inteiro comum, e não como `version: true` do MikroORM. O ORM incrementaria a versão sozinho a cada `flush`, e o schema exige que ela ande junto com o ledger.

O teste `test/integration/wagering/atomicity-and-outbox.test.ts` cria um trigger temporário que faz a gravação da outbox falhar, mas só depois de o lançamento do ledger daquela transação existir. A requisição recebe 500, e depois disso o saldo, a versão, o ledger, a outbox e a tabela de transações estão como antes. Reenviar a mesma requisição, sem o trigger, processa normalmente: a chave não ficou ocupada.

## Eventos e outbox

Os eventos de integração são gravados na tabela `outbox_messages` dentro da mesma transação SQL que muda o saldo. Nada é enviado ao SQS de dentro da transação. Se a transação faz rollback, os eventos somem junto; se faz commit, eles ficam gravados mesmo que o processo morra logo depois.

Publicar direto no SQS dentro da transação teria dois problemas. Se o commit falhar depois da publicação, o evento descreve algo que não aconteceu. Se o processo morrer entre o commit e a publicação, o evento se perde. A outbox troca esses dois problemas por uma entrega "pelo menos uma vez", que o consumidor resolve deduplicando pelo `eventId`.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | toda transação aplicada, inclusive LOSS e a abertura da wallet |
| `WalletBalanceChanged` | só quando existe lançamento no ledger; LOSS e rejeições não geram |
| `WagerTransactionRejected` | rejeição por regra de negócio |
| `WagerTransactionPendingReference` | referência ainda não chegou ou não terminou |

- **Envelope** (`src/domain/events/integration-event.ts`): classe abstrata com `eventId`, `aggregateId`, `correlationId`, `causationId`, `occurredAt` e `data`. `eventType` e `version` ficam declarados em cada subclasse (`src/domain/events/wagering-events.ts`). `data` leva valores como `{ "amount": "25.00", "currency": "BRL" }`, nunca o objeto `Money`, para que o JSON gravado seja estável.
- **`aggregateId` é a wallet**, em todos os eventos. Na publicação ele vira o `MessageGroupId` da fila FIFO: os eventos de uma wallet ficam em ordem, e wallets diferentes andam em paralelo.
- **`OutboxMessage`** (`src/domain/outbox/outbox-message.ts`): o id da mensagem é o id do evento. Ela nasce pendente e disponível na hora (`next_attempt_at = occurred_at`). `scheduleRetry` aplica backoff exponencial com jitter: a tentativa n espera entre metade e o total de `min(5 min, 1 s × 2^(n-1))`. O jitter evita que várias instâncias que falharam juntas tentem de novo no mesmo instante. A fonte aleatória é injetável, então o teste confere os atrasos exatos.
- **`correlationId`** vem do header `X-Correlation-Id` da requisição (ou é gerado) e vai para todos os eventos que ela produz.

## API HTTP

| Método e rota | Uso |
|---|---|
| `POST /wallets` | abre a wallet; com saldo inicial, grava também a transação `OPENING`, o lançamento de crédito e os eventos, na mesma transação SQL |
| `GET /wallets/:walletId` | saldo e versão |
| `POST /wagering/transactions` | submete uma transação; header `Idempotency-Key` obrigatório |
| `GET /wagering/transactions/:transactionId` | transação pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor |

### Mapeamento de status

O provedor precisa decidir pelo código, sem ler a mensagem, se reenvia, corrige o payload ou desiste. Cada situação tem um código, e o mesmo código em todos os endpoints.

| Situação | Status | O provedor deve |
|---|---|---|
| transação processada | `201` | nada |
| replay de transação processada | `200`, `idempotentReplay: true` | nada |
| aguardando a referência | `202` | não reenviar; consultar depois |
| rejeitada por regra de negócio | `422` com `failureCode` (também no replay, com `idempotentReplay: true`) | não reenviar igual |
| falha permanente de infraestrutura (`FAILED`) | `422` com `failureCode` | não reenviar igual |
| payload inválido, header ausente ou chave fora do espaço do provedor | `400 VALIDATION_ERROR` | corrigir o payload |
| mesma chave com payload diferente | `409 IDEMPOTENCY_KEY_CONFLICT` | não reenviar com essa chave |
| `externalTransactionId` já usado com outra chave | `409 EXTERNAL_TRANSACTION_ID_CONFLICT` | não reenviar |
| wallet duplicada para o mesmo player e moeda | `409 WALLET_ALREADY_EXISTS` | não reenviar |
| wallet ou transação inexistente | `404` | corrigir o id |
| corpo maior que o limite do parser | `413 PAYLOAD_TOO_LARGE` | reduzir o corpo |
| falha transitória (lock timeout, deadlock, banco fora) | `503 TRANSIENT_FAILURE` com `Retry-After` | reenviar com a mesma chave |

O replay devolve o estado gravado da transação, com o código desse estado. Para `PROCESSED` e `REJECTED` esse estado é final e igual ao da primeira resposta. Uma transação em `PENDING_REFERENCE` ainda pode mudar: quando a referência for resolvida, o replay passa a devolver `200` (processada) ou `422` (rejeitada).

`FAILED` só aparece no HTTP num replay: ninguém grava `FAILED` durante uma requisição, porque um erro de infraestrutura durante a requisição faz rollback e vira `503` ou `500`. Ele é terminal como `REJECTED`, então também é `422`: um código `5xx` convidaria o provedor a reenviar algo que vai receber a mesma resposta para sempre.

O replay de uma rejeição volta como `422`, e não como `200`. O código diz o que aconteceu com a operação, e a operação foi rejeitada. Se o replay voltasse `200`, um provedor que só olha o código trataria a aposta como aceita.

`WALLET_NOT_FOUND` num `POST` é `404`, e não `422`, porque nada é gravado: não existe uma transação rejeitada para consultar depois. Corrigido o `walletId`, a mesma chave funciona.

### Erros e validação

- **Envelope único** em todo erro: `{ errorCode, message, details?, correlationId }`. Um único filtro (`src/interfaces/http/api-exception.filter.ts`) traduz exceções em status. Controllers e casos de uso só lançam.
- **Respostas de transação não usam o envelope de erro.** `201`, `200`, `202` e `422` devolvem o resultado da transação. Assim o replay tem o mesmo corpo da primeira resposta, o que não aconteceria se o corpo tivesse o `correlationId` de cada requisição.
- **Validação com zod** (`src/interfaces/http/wager-transaction.request.ts`): formato de UUID, texto obrigatório sem caracteres de controle (U+0000 a U+001F e U+007F, nem no corpo nem nos parâmetros de rota), lista de tipos (OPENING recusado) e `Money` validado pelo próprio `Money.from`, para a API e o domínio nunca discordarem sobre um valor. `"referenceExternalTransactionId": null` vale o mesmo que o campo ausente, inclusive no hash. Cada problema vem em `details` com um `ContractViolationCode` (`MISSING_FIELD`, `INVALID_FORMAT`, `INVALID_MONEY`, `UNKNOWN_KIND`, `INTERNAL_KIND_NOT_ALLOWED`, `IDEMPOTENCY_KEY_INVALID`...). Header e corpo são validados juntos, então um único 400 lista todos os problemas.
- **Regras que envolvem mais de um campo** (REFUND exige referência, BET não pode ter, valor zero, chave no espaço do provedor) ficam em `WagerTransaction.create`. A entrada pelo SQS vai passar pela mesma regra.
- **Erros do Express** que trazem um status 4xx (por exemplo o corpo grande demais do body parser, `413`) passam pelo mesmo envelope, em vez de virar 500.
- **`X-Correlation-Id`**: aceito se tiver até 128 caracteres seguros; senão é gerado um UUID. Volta no header da resposta e no corpo de todo erro.
- **Health fora do envelope.** O `503` de `/health/ready` é um relatório das dependências, não um erro da API, e mantém o seu próprio corpo.

## Autenticação

Autenticação não vale pontos no desafio e não foi implementada. O ponto de extensão existe no código:

- `ProviderAuthGuard` (`src/interfaces/http/provider-auth.guard.ts`) está registrado nos controllers de wallet e de transações. Os endpoints de health ficam abertos.
- O guard chama a porta `ProviderIdentityPort` (`src/application/ports/provider-identity.ts`). O adaptador atual, `NoopProviderIdentity`, devolve um chamador anônimo e deixa tudo passar.

O desenho que eu adotaria: Keycloak no Docker Compose, um client por provedor com o fluxo client credentials do OAuth2. O adaptador validaria o JWT pela JWKS do Keycloak (assinatura, `aud`, `exp`) e devolveria o `providerId` do token. O guard responderia 401 sem token válido e 403 quando o `providerId` do corpo fosse diferente do token. Trocar o adaptador não muda caso de uso nem domínio.

A regra de que a chave de idempotência começa com `{providerId}:` mantém um chamador honesto dentro do seu próprio espaço e fora do `internal:` das aberturas. Ela não impede um provedor mal-intencionado: sem autenticação, o provedor B pode mandar `providerId: "provider-a"` com a chave `provider-a:...` e ocupar a chave do A. Quem impede isso é o adaptador de JWT, ao exigir que o `providerId` do corpo seja o do token.

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

- Os eventos ficam gravados na outbox, mas ainda não existe o worker que os publica no SQS.
- Transações em `PENDING_REFERENCE` ficam gravadas e agendadas (`next_reference_check_at`), mas ainda não existe o worker que as reprocessa quando a referência chega.
- Sem autenticação, qualquer chamador consulta qualquer transação pelos endpoints `GET` e pode se apresentar com o `providerId` de outro provedor.
- A configuração local usa credenciais fictícias (`test`/`test`) aceitas pelo emulador. Em produção, as credenciais da AWS viriam da cadeia padrão do SDK (por exemplo, uma role de IAM), e o código já trata `SQS_ENDPOINT` e as chaves vazias dessa forma.
