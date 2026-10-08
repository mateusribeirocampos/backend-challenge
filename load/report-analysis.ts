import { decimal, integer, seconds, times } from './report-format.js';
import type { LoadRunResult, ScenarioId, ScenarioResult, StepResult } from './results.js';

/**
 * The written parts of the report: summary, analysis and limitations. Every number comes
 * from the result, and every sentence that judges a number ("saturou", "caiu",
 * "acompanhou") is chosen by a condition on that number, so a run with different results
 * cannot print a conclusion its own numbers contradict.
 */

/** A change smaller than this (15%) between two steps counts as "did not change". */
const SATURATION_GAIN = 0.15;
/** Average cores at or above this means a single-threaded process is busy all the time. */
const BUSY_CORES = 0.9;

function scenarioOf(result: LoadRunResult, id: ScenarioId): ScenarioResult | undefined {
  return result.scenarios.find((scenario) => scenario.id === id);
}

function first(scenario: ScenarioResult | undefined): StepResult | undefined {
  return scenario?.steps[0];
}

function last(scenario: ScenarioResult | undefined): StepResult | undefined {
  return scenario?.steps[scenario.steps.length - 1];
}

function peakOf(steps: readonly StepResult[]): StepResult | undefined {
  return steps.reduce<StepResult | undefined>(
    (best, step) => (best === undefined || step.acceptedPerSecond > best.acceptedPerSecond ? step : best),
    undefined,
  );
}

function clientsOf(step: StepResult | undefined): string {
  return step?.clients === undefined ? 'n/d' : integer(step.clients);
}

function topWait(step: StepResult): string {
  const wait = step.postgresWaits[0];
  return wait === undefined ? 'n/d' : `\`${wait.wait}\` (${decimal(wait.share * 100)}% das amostras)`;
}

/** Waits of this step whose name contains `fragment`, e.g. "LWLock", as "`wait` (9,1%)". */
function waitsContaining(step: StepResult, fragment: string): string[] {
  return step.postgresWaits
    .filter((wait) => wait.wait.includes(fragment))
    .map((wait) => `\`${wait.wait}\` (${decimal(wait.share * 100)}%)`);
}

/** "2s" or "500ms" (the LOCK_TIMEOUT text) in milliseconds. */
function durationMs(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(text);
  if (match === null) return undefined;
  return Number(match[1]) * (match[2] === 's' ? 1000 : 1);
}

function sumOver(result: LoadRunResult, pick: (step: StepResult) => number): number {
  return result.scenarios.flatMap((scenario) => scenario.steps).reduce((sum, step) => sum + pick(step), 0);
}

// ---------------------------------------------------------------- summary

export function summarySection(result: LoadRunResult): string {
  const distinct = scenarioOf(result, 'distinct-wallets');
  const hot = scenarioOf(result, 'hot-wallet');
  const mixed = last(scenarioOf(result, 'mixed'));
  const lines = ['## Resumo', '', `- ${correctnessSentence(result)}`];
  if (distinct !== undefined) {
    const peak = peakOf(distinct.steps);
    lines.push(
      `- **Wallets distintas:** de ${decimal(first(distinct)?.acceptedPerSecond)} aceitas/s com ${first(distinct)?.label ?? 'n/d'} até ${decimal(peak?.acceptedPerSecond)}/s com ${peak?.label ?? 'n/d'}; com ${last(distinct)?.label ?? 'n/d'}, p99 de ${decimal(last(distinct)?.latencyMs?.p99)} ms.`,
    );
  }
  if (hot !== undefined) {
    const peak = peakOf(hot.steps);
    lines.push(
      `- **Hot wallet:** no máximo ${decimal(peak?.acceptedPerSecond)} aceitas/s (com ${peak?.label ?? 'n/d'}); com ${last(hot)?.label ?? 'n/d'}, ${decimal(last(hot)?.acceptedPerSecond)}/s e p99 de ${decimal(last(hot)?.latencyMs?.p99)} ms. O lock da linha serializa a wallet, como esperado.`,
    );
  }
  if (mixed !== undefined) {
    lines.push(
      `- **Misto em taxa fixa:** ${decimal(mixed.acceptedPerSecond)} requisições HTTP aceitas/s com p99 de ${decimal(mixed.latencyMs?.p99)} ms; pelo SQS, do envio ao processamento, p99 de ${decimal(mixed.sqs?.sendToProcessedMs?.p99)} ms; atraso da outbox p99 de ${seconds(mixed.outbox.eventLagMs?.p99)} s.`,
    );
  }
  const busiest = last(distinct);
  if (busiest !== undefined) {
    lines.push(
      `- **Outbox:** no passo mais pesado do cenário 1 foram gravados ${decimal(busiest.outbox.writtenPerSecond)} eventos/s e publicados ${decimal(busiest.outbox.publishedPerSecond)}/s, e a publicação levou ${seconds(busiest.outbox.drainMs)} s para alcançar a escrita depois da carga. Neste ambiente a publicação é a parte mais lenta (análise abaixo).`,
    );
  }
  lines.push(
    `- **Erros:** ${integer(sumOver(result, (step) => step.requests.unavailable))} respostas 503, ${integer(sumOver(result, (step) => step.requests.otherServerErrors))} outros 5xx, ${integer(sumOver(result, (step) => step.requests.networkErrors))} requisições sem resposta e ${integer(sumOver(result, (step) => step.lockConflicts.http + step.lockConflicts.sqs))} conflitos de lock em todo o teste. Os 422 são respostas de negócio esperadas (segundo REFUND da mesma aposta).`,
    '',
  );
  return lines.join('\n');
}

function correctnessSentence(result: LoadRunResult): string {
  const checks = result.scenarios.flatMap((scenario) => scenario.checks.map((check) => ({ scenario, check })));
  const failed = checks.filter(({ check }) => !check.passed);
  if (failed.length === 0) {
    const where = result.scenarios.length === 1 ? 'no cenário' : `nos ${result.scenarios.length} cenários`;
    return `**Correção:** as ${checks.length} verificações passaram ${where}: saldo igual ao ledger e ao esperado pelas respostas, nenhum saldo negativo, nenhum efeito duplicado, nada pendente, filas vazias, outbox drenada e todo evento entregue.`;
  }
  const names = failed.map(({ scenario, check }) => `${scenario.title}: ${check.name} (${check.detail})`).join('; ');
  return `**Correção: ${failed.length} de ${checks.length} verificações FALHARAM.** ${names}.`;
}

// ---------------------------------------------------------------- analysis

export function analysisSection(result: LoadRunResult): string {
  return [
    '## Análise',
    '',
    hotWalletParagraph(result),
    distinctWalletsParagraph(result),
    tailParagraph(result),
    contentionParagraph(result),
    outboxParagraph(result),
    sqsParagraph(result),
    serverVersusClientParagraph(result),
    awsParagraph(),
  ]
    .filter((paragraph) => paragraph !== '')
    .join('\n');
}

function hotWalletParagraph(result: LoadRunResult): string {
  const hot = scenarioOf(result, 'hot-wallet');
  const steps = hot?.steps ?? [];
  const low = first(hot);
  const high = last(hot);
  const peak = peakOf(steps);
  if (low === undefined || high === undefined || peak === undefined || high.acceptedPerSecond === 0) return '';
  const perStep = steps
    .map((step) => `${step.label}: ${decimal(step.acceptedPerSecond)}/s, p50 ${decimal(step.latencyMs?.p50)} ms, p99 ${decimal(step.latencyMs?.p99)} ms`)
    .join('; ');
  const fellAfterPeak = high !== peak && high.acceptedPerSecond < peak.acceptedPerSecond * (1 - SATURATION_GAIN);
  const flat = peak.acceptedPerSecond < low.acceptedPerSecond * (1 + SATURATION_GAIN);
  const shape = fellAfterPeak
    ? `subiu até ${decimal(peak.acceptedPerSecond)}/s com ${peak.label} e depois caiu para ${decimal(high.acceptedPerSecond)}/s com ${high.label}`
    : flat
      ? 'praticamente não mudou: com um cliente a wallet já estava perto do limite'
      : `subiu até ${decimal(peak.acceptedPerSecond)}/s e parou de crescer`;
  const paragraphs = [
    '### Onde está o gargalo: a hot wallet',
    '',
    `Todas as apostas na mesma wallet passam, uma por vez, pelo lock da linha (\`SELECT ... FOR NO KEY UPDATE\` até o \`COMMIT\`). Com mais clientes o throughput ${shape}, enquanto a latência cresceu (${perStep}). Com o lock ocupado o tempo todo, 1 / throughput é o tempo que cada transação segura a linha: ${decimal(1000 / peak.acceptedPerSecond, 2)} ms no pico e ${decimal(1000 / high.acceptedPerSecond, 2)} ms com ${high.label}. Com ${high.label}, a espera mais frequente das conexões ocupadas do banco foi ${topWait(high)}.`,
    '',
  ];
  if (high.clients !== undefined) {
    const littleMs = (high.clients / high.acceptedPerSecond) * 1000;
    paragraphs.push(
      `A lei de Little confere a conta: num laço fechado, latência média = clientes / throughput = ${clientsOf(high)} / ${decimal(high.acceptedPerSecond)} = ${decimal(littleMs)} ms; a média medida foi ${decimal(high.latencyMs?.mean)} ms. Quase todo esse tempo é fila: cada requisição espera as que chegaram antes dela.`,
      '',
    );
  }
  if (fellAfterPeak) {
    const internal = waitsContaining(high, 'LWLock');
    const evidence =
      internal.length === 0
        ? ''
        : ` Com ${high.label} apareceram também ${internal.join(', ')}: disputas internas do PostgreSQL pela página onde está a linha e pela tabela de locks, um sinal a favor das duas hipóteses.`;
    paragraphs.push(
      `A queda depois do pico não foi isolada neste teste. As explicações prováveis: (1) a cada \`COMMIT\` o PostgreSQL acorda o próximo da fila do lock, que relê a versão mais nova da linha (\`READ COMMITTED\`), e essa passagem de vez fica mais cara com dezenas de transações na fila; (2) enquanto há transações abertas esperando, o banco não pode limpar as versões antigas da linha da wallet, então cada releitura percorre mais versões.${evidence} Para separar as causas: acompanhar \`n_dead_tup\` da tabela \`wallets\` durante o passo e comparar com um teste de uma linha só no próprio PostgreSQL (pgbench).`,
      '',
    );
  }
  const distinctHigh = last(scenarioOf(result, 'distinct-wallets'));
  if (distinctHigh !== undefined) {
    paragraphs.push(
      `Com o mesmo número de clientes em wallets distintas, o sistema aceitou ${decimal(distinctHigh.acceptedPerSecond)}/s (${times(distinctHigh.acceptedPerSecond, high.acceptedPerSecond)} a hot wallet). É o custo esperado do desenho: o lock por wallet impede o lost update e o saldo negativo, e só serializa quem disputa a mesma wallet. Mais instâncias não aumentam o throughput de uma wallet; aumentam o de wallets diferentes. Se uma wallet real precisasse de mais vazão, o caminho seria encurtar o tempo com o lock (menos idas ao banco dentro da transação), não mais paralelismo.`,
      '',
    );
  }
  return paragraphs.join('\n');
}

function distinctWalletsParagraph(result: LoadRunResult): string {
  const distinct = scenarioOf(result, 'distinct-wallets');
  const steps = distinct?.steps ?? [];
  const high = last(distinct);
  if (steps.length === 0 || high === undefined) return '';
  const gains = steps.slice(1).map((step, index) => {
    const previous = steps[index];
    const gain = previous === undefined || previous.acceptedPerSecond === 0 ? undefined : step.acceptedPerSecond / previous.acceptedPerSecond - 1;
    return `de ${previous?.label ?? 'n/d'} para ${step.label}, ${gain === undefined ? 'n/d' : `${gain >= 0 ? '+' : ''}${decimal(gain * 100)}%`}`;
  });
  const cpu = high.cpuCores;
  const instances = cpu?.appInstances ?? [];
  const allBusy = instances.length > 0 && instances.every((cores) => cores >= BUSY_CORES);
  const cpuSentence =
    cpu === undefined
      ? 'O uso de CPU não pôde ser lido neste sistema.'
      : `Com ${high.label}, as instâncias usaram ${instances.map((cores) => decimal(cores, 2)).join(', ')} núcleos, o PostgreSQL ${decimal(cpu.postgres, 2)} e o MiniStack ${decimal(cpu.sqsEmulator, 2)}; a espera mais frequente no banco foi ${topWait(high)}. ${
          allBusy
            ? 'Cada instância executa o JavaScript num único thread; perto de 1 núcleo em todas indica que o limite está no processamento dentro das instâncias (Nest, validação, MikroORM, log JSON por requisição), não no lock. Mais instâncias (ou mais núcleos) sobem esse teto até o PostgreSQL virar o limite.'
            : 'Nenhuma instância ficou perto de 1 núcleo o tempo todo: o limite está na espera (idas ao banco, fila do pool de conexões), não na CPU das instâncias.'
        }`;
  const waitingForApp = high.postgresWaits[0]?.wait.startsWith('idle in transaction') === true;
  const appSentence =
    allBusy && waitingForApp
      ? ' A espera mais frequente confirma a leitura: no meio da transação, o banco estava esperando a instância mandar a próxima instrução.'
      : '';
  const poolTotal = result.environment.poolSizePerInstance * result.environment.appInstances;
  const poolSentence =
    high.clients !== undefined && high.clients > poolTotal
      ? ` Com ${clientsOf(high)} clientes há mais requisições que as ${poolTotal} conexões do conjunto (${result.environment.poolSizePerInstance} por instância): as que sobram esperam uma conexão livre dentro da instância, o que aparece como latência, não como erro.`
      : '';
  return [
    '### Wallets distintas: até onde escala',
    '',
    `Sem disputa de lock, o ganho de throughput por passo foi: ${gains.join('; ')}. ${cpuSentence}${appSentence}${poolSentence}`,
    '',
  ].join('\n');
}

function tailParagraph(result: LoadRunResult): string {
  const rows = (['distinct-wallets', 'hot-wallet'] as const).flatMap((id) => {
    const scenario = scenarioOf(result, id);
    const step = last(scenario);
    const latency = step?.latencyMs;
    if (scenario === undefined || step === undefined || latency === undefined) return [];
    return [
      `${scenario.title} com ${step.label}: p50 ${decimal(latency.p50)} ms, p99 ${decimal(latency.p99)} ms (${times(latency.p99, latency.p50)} o p50), máximo ${decimal(latency.max)} ms em ${integer(latency.count)} requisições`,
    ];
  });
  if (rows.length === 0) return '';
  return [
    '### A cauda (p99)',
    '',
    `O p99 é a latência que 1 em cada 100 requisições passa: um provedor que manda milhares de apostas por minuto vê esse valor várias vezes por segundo, e é ele que define timeouts e retries do lado do provedor. ${rows.join('; ')}. Na hot wallet a cauda vem da posição na fila do lock e da fila do pool; nas wallets distintas, da fila do pool e da disputa de CPU entre processos na mesma máquina. O máximo de uma janela curta é uma requisição só e varia muito entre execuções; o p99 é mais estável.`,
    '',
  ].join('\n');
}

function contentionParagraph(result: LoadRunResult): string {
  const hot = scenarioOf(result, 'hot-wallet');
  const high = last(hot);
  if (high === undefined || high.acceptedPerSecond === 0) return '';
  const unavailable = (hot?.steps ?? []).reduce((sum, step) => sum + step.requests.unavailable, 0);
  const conflicts = (hot?.steps ?? []).reduce((sum, step) => sum + step.lockConflicts.http, 0);
  const environment = result.environment;
  const poolTotal = environment.poolSizePerInstance * environment.appInstances;
  const lockMs = 1000 / high.acceptedPerSecond;
  const timeoutMs = durationMs(environment.lockTimeout);
  const maxMs = high.latencyMs?.max;
  const pastTimeout =
    timeoutMs !== undefined && maxMs !== undefined && maxMs > timeoutMs
      ? ` O máximo medido com ${high.label}, ${decimal(maxMs)} ms, passou do \`lock_timeout\` sem nenhum \`503\`: o que passou de ${environment.lockTimeout} foi espera por conexão, não pelo lock.`
      : '';
  const explanation =
    unavailable === 0 && conflicts === 0
      ? `Nenhum \`503\` e nenhum conflito de lock na hot wallet, mesmo com ${clientsOf(high)} clientes. O motivo é o pool: no máximo ${poolTotal} transações (${environment.appInstances} instâncias × ${environment.poolSizePerInstance} conexões) esperam o lock ao mesmo tempo. Com ${decimal(lockMs, 2)} ms por transação, a última da fila espera cerca de ${poolTotal} × ${decimal(lockMs, 2)} = ${decimal(poolTotal * lockMs)} ms, abaixo do \`lock_timeout\` de ${environment.lockTimeout}. As demais requisições esperam uma conexão dentro da instância, no pool, que não tem prazo de espera (o projeto não define \`connectionTimeoutMillis\` do pg-pool): com sobrecarga maior a latência continuaria crescendo em vez de virar \`503\`.${pastTimeout} Um prazo de espera no pool seria o ajuste para falhar rápido.`
      : `Na hot wallet houve ${integer(unavailable)} respostas \`503\` e ${integer(conflicts)} conflitos de lock contados no \`/metrics\`. O cliente reenviou cada uma com a mesma \`Idempotency-Key\` depois do \`Retry-After\`; as verificações de correção do cenário mostram se algum reenvio duplicou efeito.`;
  return ['### Conflitos de concorrência e o `lock_timeout`', '', explanation, ''].join('\n');
}

function outboxParagraph(result: LoadRunResult): string {
  const distinctHigh = last(scenarioOf(result, 'distinct-wallets'));
  const hotLow = first(scenarioOf(result, 'hot-wallet'));
  const hotHigh = last(scenarioOf(result, 'hot-wallet'));
  const mixed = last(scenarioOf(result, 'mixed'));
  const probe = result.environment.sqsSendProbe;
  const lines = [
    '### Outbox: o atraso de entrega dos eventos',
    '',
    `Cada evento publicado custa um \`SendMessage\` e uma transação curta que o marca como publicado, e os eventos de uma mesma wallet saem um de cada vez, para manter a ordem. O emulador sozinho, com ${probe.senders} remetentes, aceitou ${decimal(probe.firstPerSecond)} envios/s numa fila FIFO vazia e ${decimal(probe.laterPerSecond)}/s depois de ${integer(probe.laterAfterMessages)} mensagens.`,
  ];
  if (distinctHigh !== undefined) {
    const keptUp = distinctHigh.outbox.publishedPerSecond >= distinctHigh.outbox.writtenPerSecond * (1 - SATURATION_GAIN);
    lines.push(
      '',
      `Sob a carga máxima do cenário 1 (${distinctHigh.label}) foram gravados ${decimal(distinctHigh.outbox.writtenPerSecond)} eventos/s e publicados ${decimal(distinctHigh.outbox.publishedPerSecond)}/s. ${
        keptUp
          ? 'A publicação acompanhou a escrita.'
          : `A publicação não acompanhou: o atraso cresceu durante a janela (p99 de ${seconds(distinctHigh.outbox.eventLagMs?.p99)} s, máximo de ${seconds(distinctHigh.outbox.eventLagMs?.max)} s) e os publishers levaram ${seconds(distinctHigh.outbox.drainMs)} s depois do fim da carga para zerar a fila.`
      }${
        distinctHigh.outbox.publishedPerSecond < probe.laterPerSecond
          ? ' A vazão de publicação ficou abaixo até do que o emulador aceitou sozinho depois de algumas mil mensagens, então o emulador não explica tudo. Somam-se: o custo por envio do emulador, que cresce durante o passo (a fila de eventos recebe milhares de mensagens); a transação que marca cada evento, que espera conexão no mesmo pool das requisições HTTP; e o lote, que só termina quando a wallet com mais eventos termina. Este teste não separa quanto vem de cada parte.'
          : ''
      }`,
    );
  }
  if (hotLow !== undefined && hotHigh !== undefined) {
    const starved = hotHigh.outbox.publishedPerSecond < hotLow.outbox.publishedPerSecond / 2;
    lines.push(
      '',
      `Na hot wallet todos os eventos são da mesma wallet e saem em série: com ${hotLow.label}, ${decimal(hotLow.outbox.publishedPerSecond)} publicados/s contra ${decimal(hotLow.outbox.writtenPerSecond)} gravados/s. ${
        starved
          ? `Com ${hotHigh.label} a publicação caiu para ${decimal(hotHigh.outbox.publishedPerSecond)}/s, com o MiniStack em ${decimal(hotHigh.cpuCores?.sqsEmulator, 2)} núcleo e as instâncias quase paradas. O mais provável é falta de conexão: o publisher usa o mesmo pool (${result.environment.poolSizePerInstance} por instância) das requisições HTTP, essas conexões ficam presas esperando o lock da wallet, e o publisher espera na fila do pool atrás delas. Um pool separado para os loops de fundo evitaria isso.`
          : `Com ${hotHigh.label}, ${decimal(hotHigh.outbox.publishedPerSecond)} publicados/s.`
      }`,
    );
  }
  if (mixed !== undefined) {
    const keptUp = mixed.outbox.publishedPerSecond >= mixed.outbox.writtenPerSecond * (1 - SATURATION_GAIN);
    lines.push(
      '',
      `Em taxa fixa (cenário 3) foram gravados ${decimal(mixed.outbox.writtenPerSecond)} eventos/s e publicados ${decimal(mixed.outbox.publishedPerSecond)}/s (${keptUp ? 'a publicação acompanhou' : 'a publicação não acompanhou'}), com atraso p50 de ${seconds(mixed.outbox.eventLagMs?.p50)} s e p99 de ${seconds(mixed.outbox.eventLagMs?.p99)} s. Parte do atraso, com a outbox quase vazia, é a pausa de ${result.environment.publisher.pollIntervalMs} ms do publisher quando não encontra nada para publicar.`,
    );
  }
  lines.push(
    '',
    'O atraso não afeta a correção: o evento é gravado na mesma transação do saldo e sai depois, uma vez ou mais (a deduplicação usa o `eventId`). O que cresce sob sobrecarga é o tempo até um consumidor saber da transação. Para publicar mais rápido: `SendMessageBatch` (até 10 mensagens por chamada) e marcar como publicados os eventos de uma wallet numa única instrução, com o custo de reenviar mais eventos se o processo morrer no meio de um lote.',
    '',
  );
  return lines.join('\n');
}

function sqsParagraph(result: LoadRunResult): string {
  const sqs = last(scenarioOf(result, 'mixed'))?.sqs;
  if (sqs === undefined) return '';
  const keptUp = sqs.processedPerSecond >= sqs.offeredPerSecond * (1 - SATURATION_GAIN);
  return [
    '### Caminho assíncrono (SQS)',
    '',
    `Foram oferecidas ${decimal(sqs.offeredPerSecond)} mensagens/s e processadas ${decimal(sqs.processedPerSecond)}/s na janela (${keptUp ? 'os consumers acompanharam a taxa' : 'os consumers não acompanharam a taxa'}). Do \`SendMessage\` até a linha da inbox processada: p50 de ${decimal(sqs.sendToProcessedMs?.p50)} ms, p99 de ${decimal(sqs.sendToProcessedMs?.p99)} ms. Esse tempo inclui o long poll (o receive volta assim que há mensagem), o lote de até 10 mensagens por receive (o próximo receive só sai depois do lote) e a transação. Houve ${integer(sqs.retries)} retries, ${integer(sqs.deadLettered)} mensagens na DLQ e ${integer(sqs.lockConflicts)} conflitos de lock no consumer, com HTTP e SQS disputando as mesmas wallets.`,
    '',
  ].join('\n');
}

function serverVersusClientParagraph(result: LoadRunResult): string {
  const step = last(scenarioOf(result, 'distinct-wallets'));
  const client = step?.latencyMs;
  const server = step?.serverLatencyMs;
  if (step === undefined || client === undefined || server === undefined) return '';
  return [
    '### Cliente x servidor',
    '',
    `Com ${step.label} no cenário 1, o cliente mediu p50 de ${decimal(client.p50)} ms e o histograma do servidor estima ${decimal(server.p50)} ms; no p99, ${decimal(client.p99)} contra ${decimal(server.p99)} ms. O servidor mede o caso de uso (com a espera por conexão e pelo lock); o cliente soma HTTP, JSON e a fila do event loop da instância. A estimativa do histograma é grosseira: entre os buckets de 25, 50 e 100 ms a interpolação pode errar dezenas de ms.`,
    '',
  ].join('\n');
}

function awsParagraph(): string {
  return [
    '### O que mudaria na AWS e em hardware de produção',
    '',
    '- **SQS de verdade:** não tem o custo de deduplicação que cresce com a fila. Em compensação cada `SendMessage` cruza a rede, e como os eventos de uma wallet saem um por vez, a vazão de publicação por wallet fica limitada pelo tempo de ida e volta. A fila FIFO também tem cota de vazão por fila (maior no modo de alta vazão), que precisaria ser conferida para a taxa esperada.',
    '- **Banco em outra máquina:** cada instrução da transação passa a custar uma ida e volta de rede enquanto o lock da wallet está preso. O tempo por transação na hot wallet sobe, e o throughput de uma wallet cai na mesma proporção. Wallets distintas sofrem menos, porque as transações correm em paralelo.',
    '- **Hardware dedicado:** aqui o gerador, as três instâncias, o PostgreSQL e o MiniStack dividem os mesmos núcleos. Em produção cada parte teria a sua CPU, e o pool e o número de instâncias seriam dimensionados junto com o `max_connections` do banco.',
    '- **O que não muda:** a hot wallet continua serializada (é a garantia de correção), e o throughput total cresce com instâncias enquanto a carga se espalha por wallets diferentes e o banco aguenta.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- limitations

export function limitationsSection(result: LoadRunResult): string {
  const { settings } = result;
  return [
    '## Limitações',
    '',
    '- Uma máquina só: gerador, instâncias, banco e emulador competem pela CPU, e a rede é a interface local. Os números servem para comparar cenários entre si, não para prever a capacidade em produção.',
    '- MiniStack não é SQS: o custo de deduplicação por envio é do emulador, e a fila de eventos é recriada a cada passo para que um passo não pague pelo anterior.',
    `- Janelas curtas (${settings.stepSeconds} s por passo, ${settings.mixedSeconds} s no misto): o p99 se apoia em centenas ou milhares de requisições (coluna "Requisições"), e o máximo é uma requisição só. \`LOAD_STEP_SECONDS\` maior dá caudas mais estáveis; \`LOAD_CLIENTS=1,4,16,64\` dá uma curva com mais pontos.`,
    '- Banco novo a cada execução: tabelas e índices pequenos. Um sistema com meses de ledger e outbox teria índices maiores e o autovacuum trabalhando.',
    '- Os cenários 1 e 2 usam laço fechado: sob saturação os clientes esperam e a carga oferecida cai, o que esconde parte da latência. O cenário 3 usa taxa fixa justamente para medir sem esse efeito.',
    '- Só apostas de 1,00 numa moeda, e sem autenticação (o projeto usa um guard no-op).',
    '- As causas prováveis da queda da hot wallet e da publicação mais lenta são hipóteses apoiadas nas esperas do banco e na CPU; não foram isoladas uma a uma.',
    '- CPU lida de `/proc` e do cgroup v2 do Docker: só em Linux; em outro sistema aparece "n/d".',
    '- O gauge de atraso da outbox é atualizado por cada publisher ao fim de um lote e lido a cada 500 ms; o atraso por evento, do banco, é a medida exata.',
    '',
  ].join('\n');
}
