import type { Socket, TCPSocketListener } from 'bun';

interface Pair {
  upstream: Socket<Pair> | undefined;
  /** Bytes the client sent before the upstream connection opened, or that did not fit yet. */
  toUpstream: Uint8Array[];
  /** Bytes the upstream sent that the client socket did not take yet. */
  toClient: Uint8Array[];
  client: Socket<Pair>;
}

/**
 * A TCP proxy between the application and PostgreSQL or the SQS emulator, so a test can
 * make the infrastructure fail in the middle of the work and come back, without stopping
 * the shared containers:
 *
 *   cut()      every open connection dies at once, as when the server goes down mid-query;
 *   refuse()   new connections are dropped as soon as they open (the server is still down);
 *   restore()  traffic flows again; the application has to recover on its own.
 *
 * The test keeps its own direct connection to check the outcome, so the proxy never
 * hides what really reached the database.
 */
export class TcpProxy {
  private readonly pairs = new Set<Pair>();
  private refusing = false;

  private constructor(
    private readonly listener: TCPSocketListener<Pair>,
    readonly targetHost: string,
    readonly targetPort: number,
  ) {}

  static start(targetHost: string, targetPort: number): TcpProxy {
    let proxy: TcpProxy | undefined;
    const listener = Bun.listen<Pair>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open: (client) => {
          if (proxy === undefined || proxy.refusing) {
            client.terminate();
            return;
          }
          proxy.connect(client);
        },
        data: (client, data) => {
          const pair = client.data;
          if (pair === undefined) return;
          pair.toUpstream.push(new Uint8Array(data));
          if (pair.upstream !== undefined) flush(pair.upstream, pair.toUpstream);
        },
        drain: (client) => {
          if (client.data !== undefined) flush(client, client.data.toClient);
        },
        close: (client) => proxy?.drop(client.data),
        error: (client) => proxy?.drop(client.data),
      },
    });
    proxy = new TcpProxy(listener, targetHost, targetPort);
    return proxy;
  }

  get port(): number {
    return this.listener.port;
  }

  /** Every connection open right now is killed (no graceful close), on both sides. */
  cut(): void {
    for (const pair of [...this.pairs]) {
      this.drop(pair);
    }
  }

  refuse(): void {
    this.refusing = true;
  }

  restore(): void {
    this.refusing = false;
  }

  /** cut() and refuse(): the service is down. */
  down(): void {
    this.refuse();
    this.cut();
  }

  stop(): void {
    this.cut();
    this.listener.stop(true);
  }

  private connect(client: Socket<Pair>): void {
    const pair: Pair = { client, upstream: undefined, toUpstream: [], toClient: [] };
    client.data = pair;
    this.pairs.add(pair);
    void Bun.connect<Pair>({
      hostname: this.targetHost,
      port: this.targetPort,
      data: pair,
      socket: {
        open: (upstream) => {
          if (!this.pairs.has(pair)) {
            upstream.terminate();
            return;
          }
          pair.upstream = upstream;
          flush(upstream, pair.toUpstream);
        },
        data: (_upstream, data) => {
          pair.toClient.push(new Uint8Array(data));
          flush(pair.client, pair.toClient);
        },
        drain: (upstream) => flush(upstream, pair.toUpstream),
        close: () => this.drop(pair),
        error: () => this.drop(pair),
      },
    }).catch(() => this.drop(pair));
  }

  private drop(pair: Pair | undefined): void {
    if (pair === undefined || !this.pairs.delete(pair)) return;
    pair.client.terminate();
    pair.upstream?.terminate();
  }
}

/** Writes what the socket takes now and keeps the rest for its next drain. */
function flush(socket: Socket<Pair>, queue: Uint8Array[]): void {
  while (queue.length > 0) {
    const chunk = queue[0] as Uint8Array;
    const written = socket.write(chunk);
    if (written < chunk.length) {
      queue[0] = chunk.subarray(Math.max(written, 0));
      return;
    }
    queue.shift();
  }
}
