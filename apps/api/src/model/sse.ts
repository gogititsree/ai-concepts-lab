import type { ServerResponse } from 'node:http';

/**
 * A minimal Server-Sent Events writer.
 *
 * SSE rather than a WebSocket because the traffic is one-directional (the server pushes
 * steps; the browser never sends anything back down this channel), it rides on the
 * session cookie and the existing HTTP stack with no new handshake or proxy config, and
 * `EventSource` reconnects on its own with `Last-Event-ID` — which is precisely the
 * resume mechanism this app wants, since a step index is a perfect cursor.
 *
 * The protocol is four line kinds and the pitfalls are all in the framing:
 *
 *  - `id: <n>` is what the browser echoes back as `Last-Event-ID` after a drop.
 *  - `event: <name>` names the listener; without it everything arrives as `message`.
 *  - `data:` **must be repeated per line**. A JSON payload with an embedded newline and
 *    a single `data:` prefix is silently truncated at the newline, which is a bug that
 *    only appears once a tool returns a multi-line result.
 *  - A line starting with `:` is a comment. That is the heartbeat: proxies and load
 *    balancers close idle connections after 30–60 s, and an agent run can spend two
 *    minutes inside one model call with nothing to say.
 */

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  // `no-transform` matters as much as `no-cache`: a compressing proxy will happily
  // buffer an event stream into uselessness.
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // nginx-specific, harmless elsewhere, and the difference between a live trace and a
  // trace that arrives all at once when the run ends.
  'x-accel-buffering': 'no',
} as const;

/** How often a comment line is written when nothing else is happening. */
export const HEARTBEAT_MS = 15_000;

export class SseStream {
  private closed = false;
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(private readonly raw: ServerResponse) {
    this.raw.writeHead(200, { ...SSE_HEADERS });
    // `unref` so a forgotten stream cannot hold the process open — which would turn a
    // leaked connection into a test suite that never exits.
    this.heartbeat = setInterval(() => this.comment('heartbeat'), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private write(chunk: string): void {
    if (this.closed) return;
    try {
      this.raw.write(chunk);
    } catch {
      // The client went away between our check and the write. Nothing to do and nothing
      // worth logging: this is the normal end of an SSE connection.
      this.closed = true;
    }
  }

  comment(text: string): void {
    this.write(`: ${text}\n\n`);
  }

  event(name: string, data: unknown, id?: number): void {
    const payload = JSON.stringify(data);
    const lines = payload.split('\n').map((line) => `data: ${line}`);
    this.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${name}\n${lines.join('\n')}\n\n`);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    try {
      this.raw.end();
    } catch {
      // Already torn down by the client.
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Parses `Last-Event-ID` (or the `?lastEventId=` fallback, for clients that cannot set
 * the header) into a step index. Anything unparseable means "start from the beginning",
 * because replaying a trace the browser already has is a cosmetic bug and skipping steps
 * it does not have is a wrong trace.
 */
export function parseLastEventId(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : -1;
}
