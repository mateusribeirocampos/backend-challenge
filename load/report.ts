import { analysisSection, limitationsSection, summarySection } from './report-analysis.js';
import { decimal, integer, latencyCells, NOT_AVAILABLE, seconds, table } from './report-format.js';
import type { CheckResult, Environment, LoadRunResult, ScenarioResult, StepResult } from './results.js';

/**
 * docs/teste-de-carga.md, rewritten on every run from the measured results. A pure
 * function of the result: the same JSON always gives the same report, and the unit test
 * checks it without running any load.
 */
export function renderReport(result: LoadRunResult): string {
  return [
    '# Teste de carga',
    '',
    `> Gerado por \`bun run test:load\` em ${result.finishedAt}. Não editar à mão: uma nova execução reescreve este arquivo. Os números valem para a máquina descrita em "Ambiente". Os dados brutos ficam em \`load-results/\` (fora do git).`,
    '',
    summarySection(result),
    environmentSection(result.environment),
    methodologySection(result),
    '## Resultados',
    '',
    ...result.scenarios.map((scenario, index) => scenarioSection(scenario, index + 1)),
    analysisSection(result),
    limitationsSection(result),
  ].join('\n');
}

function environmentSection(environment: Environment): string {
  const postgresSettings = Object.entries(environment.postgresSettings)
    .map(([name, value]) => `\`${name}\` ${value}`)
    .join(', ');
  const probe = environment.sqsSendProbe;
  return [
    '## Ambiente',
    '',
    table(
      ['Item', 'Valor'],
      [
        ['CPU', `${environment.cpuModel}, ${environment.logicalCores} núcleos lógicos`],
        ['Memória', `${decimal(environment.memoryGiB)} GiB`],
        ['Sistema', `${environment.os}, kernel ${environment.kernel}`],
        ['Bun', environment.bun],
        ['Banco', `${environment.postgres} (docker compose, sem limite de CPU); ${postgresSettings}`],
        [
          'SQS',
          `${environment.sqsEmulator} (docker compose, sem limite de CPU). \`SendMessage\` FIFO com ${probe.senders} remetentes: ${decimal(probe.firstPerSecond)}/s nas primeiras ${integer(probe.firstMessages)} mensagens, ${decimal(probe.laterPerSecond)}/s depois de ${integer(probe.laterAfterMessages)}`,
        ],
        ['Instâncias da aplicação', `${environment.appInstances} processos \`src/main.ts\`, cada um com HTTP, consumer SQS, publisher da outbox e worker de PENDING_REFERENCE`],
        ['Pool de conexões', `${environment.poolSizePerInstance} por instância (padrão do pg-pool), ${environment.poolSizePerInstance * environment.appInstances} no total`],
        ['`lock_timeout`', environment.lockTimeout],
        [
          'Consumer SQS',
          `visibility timeout ${environment.consumer.visibilityTimeoutSeconds} s, long poll ${environment.consumer.waitTimeSeconds} s, até ${environment.consumer.maxMessages} mensagens por receive`,
        ],
        [
          'Publisher da outbox',
          `lease ${environment.publisher.leaseSeconds} s, lote de ${environment.publisher.batchSize} eventos, pausa de ${environment.publisher.pollIntervalMs} ms quando não há o que publicar`,
        ],
      ],
    ),
    '',
    'Tudo roda na mesma máquina: as instâncias, o PostgreSQL, o MiniStack e o gerador de carga disputam os mesmos núcleos. A configuração das instâncias é a padrão do projeto; só o banco, as filas e a porta mudam.',
    '',
  ].join('\n');
}

function methodologySection(result: LoadRunResult): string {
  const { settings } = result;
  const wallets = settings.hotWallets === 1 ? 'a mesma wallet' : `${settings.hotWallets} wallets`;
  return [
    '## Metodologia',
    '',
    '- **Sistema sob teste:** um banco só do teste (`wagering_load`), apagado e recriado com as migrations a cada execução, e filas FIFO próprias (entrada, DLQ e eventos). As requisições HTTP vão para as instâncias em rodízio.',
    `- **Aquecimento:** antes do primeiro cenário, ${settings.warmupSeconds * 2} s de apostas não medidas. Cada passo tem ainda ${settings.warmupSeconds} s de aquecimento, descartados, antes da janela medida.`,
    `- **Cenários 1 e 2 (laço fechado):** passos de ${settings.clientSteps.join(', ')} clientes, ${settings.stepSeconds} s medidos por passo. Cada cliente manda uma BET de 1,00, espera a resposta e manda a próxima, então a carga oferecida é o número de clientes. No cenário 1 cada cliente tem a sua wallet; no 2, todos usam ${wallets}.`,
    `- **Cenário 3 (laço aberto, taxa fixa):** ${settings.mixedHttpRoundsPerSecond} rodadas HTTP e ${settings.mixedSqsRoundsPerSecond} rodadas SQS iniciadas por segundo, por ${settings.mixedSeconds} s medidos, sobre ${settings.mixedWallets} wallets. Uma rodada começa no seu horário mesmo que a anterior não tenha terminado: lentidão não reduz a carga oferecida.`,
    '- **Cliente:** um provedor bem comportado. Em `503` espera o `Retry-After` e reenvia o mesmo corpo com a mesma `Idempotency-Key`; em erro de conexão tenta a próxima instância. Cada tentativa conta como uma requisição.',
    '- **Latência do cliente:** de `fetch()` até o fim do corpo da resposta (`performance.now()`), para toda requisição iniciada na janela medida. Percentil pelo posto mais próximo: o p99 é a latência de uma requisição que existiu, sem interpolação.',
    '- **Latência do servidor:** estimada pelo histograma `wager_processing_duration_seconds{source="http"}` do `/metrics` (diferença entre o início e o fim da janela, somando as instâncias, interpolação linear como a do `histogram_quantile`). Serve para conferir a ordem de grandeza: dentro de um bucket o valor real é desconhecido.',
    '- **Throughput:** respostas `2xx` (operações aceitas) iniciadas na janela, divididas pela duração da janela. `422` é resposta de negócio e aparece à parte.',
    '- **Conflitos de concorrência:** `wager_lock_conflicts_total` do `/metrics` (lock timeout, deadlock ou falha de serialização) e o número de `503`.',
    '- **Outbox:** o gauge `wager_outbox_lag_seconds` lido a cada 500 ms em todas as instâncias (vale o maior); o atraso de cada evento gravado na janela (`published_at - occurred_at`, do banco); eventos gravados e publicados por segundo; e a drenagem, do fim da carga até não sobrar evento sem publicar. Cada passo começa com a outbox vazia.',
    '- **Leitor da fila de eventos:** o gerador de carga faz o papel do consumidor dos eventos (recebe e apaga), como haveria em produção, e confere que todo evento publicado chegou à fila.',
    '- **CPU:** núcleos médios na janela, de `/proc/<pid>/stat` (instâncias) e do cgroup de cada container (PostgreSQL, MiniStack).',
    '- **Esperas no banco:** a cada 250 ms, o estado e o evento de espera de cada conexão não ociosa (`pg_stat_activity`). `active` sem evento é CPU; `Lock:transactionid` é esperar o `COMMIT` de quem segura a linha; `idle in transaction / Client:ClientRead` é o banco esperando a aplicação mandar a próxima instrução no meio de uma transação.',
    '- **Correção:** ao fim de cada cenário, verificações direto no banco e no SQS (tabela de cada cenário). O saldo esperado de cada wallet é calculado pelo gerador a partir das respostas, com o mesmo `Money` do domínio.',
    '- **O que o emulador implica:** o MiniStack 1.5.22 refaz o cache de deduplicação inteiro de uma fila FIFO a cada `SendMessage` (`services/sqs.py`, `_prune_dedup`), e esse cache guarda toda mensagem dos últimos 5 minutos: cada envio fica mais caro conforme a fila recebe mensagens (medição na linha "SQS" do ambiente). Por isso a fila de eventos é recriada, com o mesmo nome e a mesma URL, antes de cada passo, com a outbox vazia e todo evento já recebido. O SQS da AWS não tem esse custo.',
    '',
  ].join('\n');
}

function scenarioSection(scenario: ScenarioResult, number: number): string {
  const hasSqs = scenario.steps.some((step) => step.sqs !== undefined);
  return [
    `### ${number}. ${scenario.title}`,
    '',
    scenario.description,
    '',
    '**Vazão e latência (ms)**',
    '',
    table(
      ['Carga', 'Aceitas/s', 'p50', 'p95', 'p99', 'máx', 'Servidor p50 / p95 / p99'],
      scenario.steps.map((step) => [step.label, decimal(step.acceptedPerSecond), ...latencyCells(step.latencyMs), serverCell(step)]),
    ),
    '',
    '**Respostas e conflitos**',
    '',
    table(
      ['Carga', 'Requisições', '2xx', '422 (negócio)', '503', 'outros 5xx', 'outros 4xx', 'sem resposta', 'Conflitos de lock (HTTP / SQS)'],
      scenario.steps.map((step) => [
        step.label,
        integer(step.requests.total),
        integer(step.requests.accepted),
        integer(step.requests.businessRejections),
        integer(step.requests.unavailable),
        integer(step.requests.otherServerErrors),
        integer(step.requests.otherClientErrors),
        integer(step.requests.networkErrors),
        `${integer(step.lockConflicts.http)} / ${integer(step.lockConflicts.sqs)}`,
      ]),
    ),
    '',
    '**Outbox (atrasos em s) e CPU (núcleos médios)**',
    '',
    table(
      ['Carga', 'Eventos gravados/s', 'Publicados/s', 'Atraso p50 / p99 / máx', 'Gauge máx', 'Drenagem', 'CPU instâncias', 'CPU PostgreSQL', 'CPU MiniStack', 'CPU gerador'],
      scenario.steps.map((step) => [
        step.label,
        decimal(step.outbox.writtenPerSecond),
        decimal(step.outbox.publishedPerSecond),
        lagCell(step),
        step.outbox.gaugeMaxSeconds === undefined ? NOT_AVAILABLE : decimal(step.outbox.gaugeMaxSeconds, 2),
        seconds(step.outbox.drainMs),
        step.cpuCores === undefined ? NOT_AVAILABLE : step.cpuCores.appInstances.map((cores) => decimal(cores, 2)).join(' + '),
        decimal(step.cpuCores?.postgres, 2),
        decimal(step.cpuCores?.sqsEmulator, 2),
        decimal(step.cpuCores?.loadGenerator, 2),
      ]),
    ),
    '',
    '**Onde as conexões ocupadas do PostgreSQL estavam (amostras de `pg_stat_activity` a cada 250 ms)**',
    '',
    table(['Carga', 'Estado / espera mais frequentes'], scenario.steps.map((step) => [step.label, waitsCell(step)])),
    '',
    ...(hasSqs ? [sqsTable(scenario.steps), ''] : []),
    '**Correção depois da carga**',
    '',
    checksTable(scenario.checks),
    '',
  ].join('\n');
}

function serverCell(step: StepResult): string {
  const server = step.serverLatencyMs;
  return server === undefined ? NOT_AVAILABLE : `${decimal(server.p50)} / ${decimal(server.p95)} / ${decimal(server.p99)}`;
}

/** "active / Lock:transactionid 80,1%; active 10,2%; ..." */
export function waitsCell(step: StepResult): string {
  if (step.postgresWaits.length === 0) return NOT_AVAILABLE;
  return step.postgresWaits.map((wait) => `${wait.wait} ${decimal(wait.share * 100)}%`).join('; ');
}

function lagCell(step: StepResult): string {
  const lag = step.outbox.eventLagMs;
  return lag === undefined ? NOT_AVAILABLE : `${seconds(lag.p50)} / ${seconds(lag.p99)} / ${seconds(lag.max)}`;
}

function sqsTable(steps: readonly StepResult[]): string {
  const rows = steps.flatMap((step) => {
    const sqs = step.sqs;
    if (sqs === undefined) return [];
    return [
      [
        integer(sqs.sent),
        integer(sqs.processed),
        decimal(sqs.offeredPerSecond),
        decimal(sqs.processedPerSecond),
        ...latencyCells(sqs.sendToProcessedMs),
        integer(sqs.retries),
        integer(sqs.deadLettered),
        seconds(sqs.drainMs),
      ],
    ];
  });
  return [
    '**Caminho assíncrono (SQS): do `SendMessage` até a linha da inbox processada, em ms**',
    '',
    table(['Enviadas', 'Processadas', 'Oferecidas/s', 'Processadas/s', 'p50', 'p95', 'p99', 'máx', 'Retries', 'DLQ', 'Drenagem (s)'], rows),
  ].join('\n');
}

function checksTable(checks: readonly CheckResult[]): string {
  return table(
    ['Verificação', 'Resultado', 'Detalhe'],
    checks.map((check) => [check.name, check.passed ? 'ok' : '**FALHOU**', check.detail]),
  );
}
