import { LLMError, toLLMError } from "../providers/base/errors";

/**
 * Minimal streaming HTTP abstraction.
 *
 * Desktop Obsidian runs in Electron with Node available, so the Node transport is used by
 * default: it is not subject to CORS (many LLM gateways don't send CORS headers) and it
 * streams. `fetch` is the fallback (mobile) and can be forced in settings, e.g. when the
 * system proxy must be honoured.
 */
export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Idle timeout in ms (time without receiving any bytes). */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Decoded UTF-8 body chunks. Must be consumed (or `text()` called) exactly once. */
  body: AsyncIterable<string>;
  text(): Promise<string>;
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

async function collect(body: AsyncIterable<string>): Promise<string> {
  let s = "";
  for await (const c of body) s += c;
  return s;
}

/* ----------------------------- Node transport ----------------------------- */

type NodeHttpModule = typeof import("node:http");
type NodeHttpsModule = typeof import("node:https");

export function createNodeTransport(mods: { http: NodeHttpModule; https: NodeHttpsModule }): HttpTransport {
  return (req) =>
    new Promise<HttpResponse>((resolve, reject) => {
      if (req.signal?.aborted) {
        reject(new LLMError("aborted"));
        return;
      }
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        reject(new LLMError("config", { detail: `无效的 URL：${req.url}` }));
        return;
      }
      const lib = url.protocol === "http:" ? mods.http : mods.https;
      const headers: Record<string, string | number> = { ...req.headers };
      if (req.body !== undefined) headers["Content-Length"] = Buffer.byteLength(req.body);

      const clientReq = lib.request(url, { method: req.method, headers });
      let settled = false;

      const onAbort = () => clientReq.destroy(new LLMError("aborted"));
      req.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => req.signal?.removeEventListener("abort", onAbort);

      if (req.timeoutMs && req.timeoutMs > 0) {
        clientReq.setTimeout(req.timeoutMs, () =>
          clientReq.destroy(new LLMError("timeout", { detail: `${Math.round(req.timeoutMs! / 1000)} 秒内未收到数据` })),
        );
      }

      const mapErr = (err: unknown) => (req.signal?.aborted ? new LLMError("aborted") : toLLMError(err));

      clientReq.on("error", (err) => {
        cleanup();
        if (!settled) {
          settled = true;
          reject(mapErr(err));
        }
      });

      clientReq.on("response", (res) => {
        settled = true;
        res.setEncoding("utf8");
        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) respHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
        }
        const body: AsyncIterable<string> = {
          async *[Symbol.asyncIterator]() {
            try {
              for await (const chunk of res) yield chunk as string;
              if (req.signal?.aborted) throw new LLMError("aborted");
            } catch (err) {
              throw mapErr(err);
            } finally {
              cleanup();
              if (!res.complete) clientReq.destroy();
            }
          },
        };
        resolve({ status: res.statusCode ?? 0, headers: respHeaders, body, text: () => collect(body) });
      });

      if (req.body !== undefined) clientReq.write(req.body);
      clientReq.end();
    });
}

/* ----------------------------- fetch transport ---------------------------- */

export function createFetchTransport(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): HttpTransport {
  return async (req) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (req.signal?.aborted) throw new LLMError("aborted");
    req.signal?.addEventListener("abort", onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const arm = () => {
      if (!req.timeoutMs) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, req.timeoutMs);
    };
    const done = () => {
      if (timer) clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    };
    const mapErr = (err: unknown) => {
      if (timedOut) return new LLMError("timeout", { detail: `${Math.round((req.timeoutMs ?? 0) / 1000)} 秒内未收到数据` });
      if (req.signal?.aborted) return new LLMError("aborted");
      return toLLMError(err);
    };

    arm();
    let res: Response;
    try {
      res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: controller.signal });
    } catch (err) {
      done();
      throw mapErr(err);
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));

    const body: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        try {
          if (!res.body) {
            yield await res.text();
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder("utf-8");
          while (true) {
            arm();
            const { done: end, value } = await reader.read();
            if (end) break;
            yield decoder.decode(value, { stream: true });
          }
          const tail = decoder.decode();
          if (tail) yield tail;
        } catch (err) {
          throw mapErr(err);
        } finally {
          done();
        }
      },
    };
    return { status: res.status, headers, body, text: () => collect(body) };
  };
}
