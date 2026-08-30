/**
 * A minimal MCP client over Streamable HTTP.
 *
 * THE POINT OF THIS FILE IS THE TOKEN. The agent connects to the MCP server
 * with the SESSION'S OWN token — the same one the human authenticated with.
 * There is no service credential, no elevated agent identity, and therefore no
 * way for the agent to reach an account the person who asked cannot reach.
 *
 * An agent that holds broader credentials than its caller is the standard way
 * this class of system becomes a privilege-escalation surface: the human is
 * scoped, the agent is not, and the model is one injected instruction away from
 * being the confused deputy.
 *
 * (The official SDK client works here too; this is deliberately small so the
 * transport has no surprises and the auth path is one readable function.)
 */

const PROTOCOL_VERSION = '2025-06-18';

/**
 * Streamable HTTP answers a request with either a JSON body or an SSE stream,
 * at the server's discretion. Both carry the same JSON-RPC payload.
 *
 * WHY THIS READS INCREMENTALLY INSTEAD OF CALLING res.text():
 *
 * The server MAY hold the SSE stream open after sending the response message —
 * that is the whole point of Streamable HTTP, since it lets the server push
 * later messages down the same connection. `res.text()` waits for the stream to
 * END, so against a server that keeps it open it never resolves. The request
 * then sits there forever and the Workers runtime eventually reports
 * "your Worker's code had hung and would never generate a response".
 *
 * It is a confusing failure to look at, because wrangler logs `POST /mcp 200
 * OK` as soon as the response HEADERS arrive — so the request looks finished
 * while its body is still open.
 *
 * This client is request/response only: it wants the first JSON-RPC message and
 * nothing after it. So take that message and CANCEL the stream, which releases
 * the request immediately.
 */
async function readMessage(res: Response): Promise<any> {
  const isSse = (res.headers.get('content-type') ?? '').includes('text/event-stream');

  if (!isSse) {
    const body = await res.text();
    return body ? JSON.parse(body) : null;
  }
  if (!res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload) return JSON.parse(payload);   // finally{} cancels the rest
        }
      }
    }
    return null;
  } finally {
    // Releases the request whether we got a message, hit the end, or threw.
    await reader.cancel().catch(() => {});
  }
}

export class McpToolClient {
  #id = 0;
  #session: Promise<string> | null = null;

  constructor(private readonly url: string, private readonly token: string) {}

  #headers(sessionId?: string): Record<string, string> {
    const h: Record<string, string> = {
      // The session token. Scope travels here, never in `args`.
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (sessionId) {
      h['mcp-session-id'] = sessionId;
      h['mcp-protocol-version'] = PROTOCOL_VERSION;
    }
    return h;
  }

  /**
   * The transport rejects any request that arrives without a session id, so the
   * handshake is not optional: initialize, keep the id the server assigns, then
   * send the initialized notification the spec requires before the first call.
   *
   * The token goes on the handshake too — the server resolves the principal and
   * builds this session's manifest from it, so an unauthenticated handshake
   * would produce a session with no tools rather than a session with all of them.
   */
  async #handshake(): Promise<string> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++this.#id,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'billing-explainer-agent', version: '0.1.0' },
        },
      }),
    });

    if (!res.ok) throw new Error(`mcp initialize failed ${res.status}`);
    const sessionId = res.headers.get('mcp-session-id');
    const payload = await readMessage(res);
    if (payload?.error) throw new Error(`mcp error: ${payload.error.message}`);
    if (!sessionId) throw new Error('mcp initialize returned no session id');

    // The server answers this notification with a body we do not need — but an
    // UNCONSUMED response body keeps the request alive in workerd, and the
    // runtime eventually reports "your Worker's code had hung and would never
    // generate a response". Draining it is the whole fix.
    const ack = await fetch(this.url, {
      method: 'POST',
      headers: this.#headers(sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    await ack.body?.cancel().catch(() => {});

    return sessionId;
  }

  /** Memoised, so concurrent calls share one handshake instead of racing. */
  #open(): Promise<string> {
    if (!this.#session) {
      const pending = this.#handshake();
      this.#session = pending;
      // A failed handshake must not be cached, or every later call inherits it.
      pending.catch(() => { if (this.#session === pending) this.#session = null; });
    }
    return this.#session;
  }

  #post(sessionId: string, method: string, params: unknown, id?: number) {
    return fetch(this.url, {
      method: 'POST',
      headers: this.#headers(sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
  }

  async #rpc(method: string, params: unknown): Promise<any> {
    let sessionId = await this.#open();
    let res = await this.#post(sessionId, method, params, ++this.#id);

    // 404 means the server no longer knows this session — it can be evicted
    // between two durable Workflow steps. Re-handshake once; the token is the
    // authority, so the new session has exactly the same scope as the old one.
    if (res.status === 404) {
      await res.body?.cancel();
      this.#session = null;
      sessionId = await this.#open();
      res = await this.#post(sessionId, method, params, ++this.#id);
    }

    if (!res.ok) throw new Error(`mcp transport error ${res.status} on ${method}`);
    const payload = await readMessage(res);
    if (payload?.error) throw new Error(`mcp error: ${payload.error.message}`);
    return payload?.result;
  }

  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.#rpc('tools/call', { name, arguments: args });

    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') throw new Error(`unexpected tool result for ${name}`);
    // A tool that failed reports it in-band, as content with isError set. Say
    // what the server said; JSON.parse on an error string only hides it.
    if (result.isError) throw new Error(`mcp tool error: ${name}: ${text}`);
    return JSON.parse(text) as T;
  }

  /** The manifest the SERVER decides this token may see. Rendered in the UI. */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    const result = await this.#rpc('tools/list', {});
    return result?.tools ?? [];
  }
}
