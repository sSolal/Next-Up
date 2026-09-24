/**
 * Ollama client over an injected `Transport`, so the same code runs under Node (`fetch`)
 * and inside Obsidian (`requestUrl`). Errors are classified with a hint for the user.
 */
import type { ChatMessage, Transport } from "./types.ts";

export type OllamaErrorKind = "unreachable" | "model-missing" | "no-tools" | "timeout" | "http";

export class OllamaError extends Error {
  kind: OllamaErrorKind;
  hint: string;
  constructor(kind: OllamaErrorKind, message: string, hint: string) {
    super(message);
    this.name = "OllamaError";
    this.kind = kind;
    this.hint = hint;
  }
}

export interface ModelInfo {
  name: string;
  /** Bytes on disk. */
  size: number;
  family: string;
  parameterSize: string;
  /** Whether the model advertises tool calling; undefined when unknown. */
  tools?: boolean;
}

export interface ChatOptions {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  numCtx: number;
  think: boolean;
  timeoutMs: number;
}

export interface ChatResponse {
  message: ChatMessage;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

function base(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Installed models, with their tool-calling capability when the server reports it. */
export async function listModels(t: Transport, baseUrl: string, timeoutMs = 10000): Promise<ModelInfo[]> {
  const res = await call(t, { url: `${base(baseUrl)}/api/tags`, method: "GET", timeoutMs }, baseUrl);
  const models = ((res as { models?: unknown[] }).models ?? []) as { name: string; size?: number; details?: { family?: string; parameter_size?: string } }[];
  const out: ModelInfo[] = [];
  for (const m of models) {
    let tools: boolean | undefined;
    try {
      const show = (await call(t, { url: `${base(baseUrl)}/api/show`, method: "POST", body: { model: m.name }, timeoutMs }, baseUrl)) as { capabilities?: string[] };
      if (Array.isArray(show.capabilities)) tools = show.capabilities.includes("tools");
    } catch {
      tools = undefined;
    }
    out.push({ name: m.name, size: m.size ?? 0, family: m.details?.family ?? "", parameterSize: m.details?.parameter_size ?? "", tools });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export async function chat(t: Transport, o: ChatOptions): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: o.model,
    messages: o.messages,
    stream: false,
    think: o.think,
    keep_alive: "10m",
    options: { num_ctx: o.numCtx, temperature: 0.2 },
  };
  if (o.tools && o.tools.length) body.tools = o.tools;
  const res = (await call(t, { url: `${base(o.baseUrl)}/api/chat`, method: "POST", body, timeoutMs: o.timeoutMs }, o.baseUrl, o.model)) as ChatResponse;
  if (!res || typeof res !== "object" || !("message" in res)) throw new OllamaError("http", "Unexpected response from Ollama", "Check the base URL points at an Ollama server.");
  return res;
}

async function call(t: Transport, req: Parameters<Transport>[0], baseUrl: string, model?: string): Promise<unknown> {
  let res: { status: number; json: unknown };
  try {
    res = await t(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort|timeout/i.test(msg)) throw new OllamaError("timeout", `Ollama did not answer within ${req.timeoutMs ?? 0} ms`, "Raise the timeout in settings or pick a smaller model.");
    throw new OllamaError("unreachable", `Cannot reach Ollama at ${baseUrl}: ${msg}`, "Start Ollama (`ollama serve`) or fix the base URL in settings.");
  }
  if (res.status >= 200 && res.status < 300) return res.json;
  const err = errorText(res.json);
  if (res.status === 404 || /not found/i.test(err)) {
    throw new OllamaError("model-missing", `Model "${model ?? ""}" is not installed: ${err}`, `Run \`ollama pull ${model ?? "<model>"}\` or pick an installed model in settings.`);
  }
  if (/does not support tools/i.test(err)) {
    throw new OllamaError("no-tools", `Model "${model ?? ""}" does not support tool calling`, "Pick a model with tool support (qwen3, qwen2.5, llama3.1, mistral).");
  }
  throw new OllamaError("http", `Ollama answered ${res.status}: ${err}`, "See the Ollama server log.");
}

function errorText(json: unknown): string {
  if (json && typeof json === "object" && "error" in json) return String((json as { error: unknown }).error);
  return typeof json === "string" ? json : JSON.stringify(json ?? "");
}

/** Remove a `<think>…</think>` block a model may emit despite `think: false`. */
export function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Transport over the global `fetch` (Node 22, Electron). */
export const fetchTransport: Transport = async (req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), req.timeoutMs ?? 120000);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
};
