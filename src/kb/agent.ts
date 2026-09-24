/**
 * The question → tool calls → answer loop. Pure: the model is reached through a
 * `Transport`, tools through a callback, so a scripted transport tests the whole loop.
 */
import type { KbConfig } from "../settingsTypes.ts";
import { chat, stripThink } from "./ollama.ts";
import type { AskEvent, AskResult, ChatMessage, ToolCall, ToolSpec, Transport } from "./types.ts";

export interface AskDeps {
  transport: Transport;
  cfg: Pick<KbConfig, "baseUrl" | "model" | "numCtx" | "maxRounds" | "timeoutMs" | "think">;
  systemPrompt: string;
  tools: ToolSpec[];
  ollamaTools: unknown[];
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export interface AskOptions {
  onEvent?: (e: AskEvent) => void;
  /** Previous exchanges (user/assistant/tool messages, no system message). */
  history?: ChatMessage[];
  signal?: AbortSignal;
}

export async function ask(question: string, deps: AskDeps, opts: AskOptions = {}): Promise<AskResult> {
  const emit = (e: AskEvent) => opts.onEvent?.(e);
  const history = opts.history ?? [];
  const messages: ChatMessage[] = [{ role: "system", content: deps.systemPrompt }, ...history, { role: "user", content: question }];
  const trace: AskResult["trace"] = [];
  const known = new Set(deps.tools.map((t) => t.name));
  let rounds = 0;
  let retriedEmpty = false;

  const finish = (raw: string): AskResult => {
    const answer = withSources(raw, trace);
    messages.push({ role: "assistant", content: answer });
    emit({ type: "answer", text: answer });
    return { answer, rounds, trace, history: messages.slice(1) };
  };

  while (true) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    const withTools = rounds < deps.cfg.maxRounds;
    rounds++;
    emit({ type: "status", text: withTools ? `round ${rounds}: asking ${deps.cfg.model}` : "asking for the final answer" });
    const res = await chat(deps.transport, {
      baseUrl: deps.cfg.baseUrl,
      model: deps.cfg.model,
      messages: [...messages],
      tools: withTools ? deps.ollamaTools : undefined,
      numCtx: deps.cfg.numCtx,
      think: deps.cfg.think,
      timeoutMs: deps.cfg.timeoutMs,
    });
    const msg = res.message ?? { role: "assistant", content: "" };
    const content = stripThink(msg.content ?? "");
    let calls: ToolCall[] = withTools ? (msg.tool_calls ?? []) : [];
    if (!calls.length && withTools) {
      const parsed = parseInlineCall(content, known);
      if (parsed) calls = [parsed];
    }
    if (calls.length) {
      messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls?.length ? msg.tool_calls : calls });
      for (const c of calls) {
        const name = c.function?.name ?? "";
        const args = normalizeArgs(c.function?.arguments);
        emit({ type: "tool_call", round: rounds, name, args });
        const result = await deps.runTool(name, args);
        trace.push({ name, args, result });
        emit({ type: "tool_result", round: rounds, name, text: result });
        messages.push({ role: "tool", content: result, tool_name: name });
      }
      continue;
    }
    if (!content && !retriedEmpty) {
      retriedEmpty = true;
      messages.push({ role: "user", content: "Please answer the question now, in one short paragraph, citing note paths." });
      continue;
    }
    return finish(content || "(the model returned an empty answer)");
  }
}

/** Some small models print the call as JSON text instead of using the tool channel. */
export function parseInlineCall(content: string, known: Set<string>): ToolCall | null {
  const s = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (!s.startsWith("{") || !s.endsWith("}")) return null;
  try {
    const j = JSON.parse(s) as { name?: string; arguments?: unknown; parameters?: unknown; function?: { name?: string; arguments?: unknown } };
    const name = j.name ?? j.function?.name;
    if (!name || !known.has(name)) return null;
    return { function: { name, arguments: normalizeArgs(j.arguments ?? j.parameters ?? j.function?.arguments) } };
  } catch {
    return null;
  }
}

export function normalizeArgs(a: unknown): Record<string, unknown> {
  if (a == null) return {};
  if (typeof a === "string") {
    try {
      const j = JSON.parse(a);
      return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
}

/**
 * Small models often skip citations. When the answer holds no [[path]] but tools returned
 * some, append the paths that were consulted, those named in the answer first.
 */
export function withSources(answer: string, trace: AskResult["trace"], max = 5): string {
  if (/\[\[[^\]]+\]\]/.test(answer) || !trace.length) return answer;
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const t of trace) {
    for (const m of t.result.matchAll(/(?:— |^# |^)([^\n—#]*?\.md)(?=$|\n| · |; | §)/gm)) {
      const p = m[1].trim();
      if (p.includes("/") && !seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
  }
  if (!paths.length) return answer;
  const lower = answer.toLowerCase();
  const named = paths.filter((p) => lower.includes(p.replace(/\.md$/, "").split("/").pop()!.toLowerCase()));
  const chosen = [...named, ...paths.filter((p) => !named.includes(p))].slice(0, max);
  return `${answer.trim()}\n\nSources: ${chosen.map((p) => `[[${p.replace(/\.md$/, "")}]]`).join(", ")}`;
}
