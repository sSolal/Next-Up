import { test } from "node:test";
import assert from "node:assert/strict";
import { ask, parseInlineCall, withSources } from "../src/kb/agent.ts";
import { OllamaError, listModels } from "../src/kb/ollama.ts";
import { KbService } from "../src/kb/service.ts";
import { TOOLS, toOllamaTools } from "../src/kb/tools.ts";
import { NodeNoteSource, loadPluginData } from "../src/kb/node.ts";
import type { AskEvent, ChatMessage, Transport } from "../src/kb/types.ts";
import { FIXTURE } from "./kbHelpers.ts";

type Req = Parameters<Transport>[0];

function scripted(responses: unknown[]): { transport: Transport; requests: Req[] } {
  const requests: Req[] = [];
  const transport: Transport = async (req) => {
    requests.push(req);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next && typeof next === "object" && "status" in (next as object)) return next as { status: number; json: unknown };
    return { status: 200, json: next };
  };
  return { transport, requests };
}

const CFG = { baseUrl: "http://localhost:11434", model: "test-model", numCtx: 8192, maxRounds: 3, timeoutMs: 1000, think: false };

function deps(transport: Transport, calls: { name: string; args: Record<string, unknown> }[] = []) {
  return {
    transport,
    cfg: CFG,
    systemPrompt: "SYSTEM",
    tools: TOOLS,
    ollamaTools: toOllamaTools(TOOLS),
    runTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return `result of ${name}`;
    },
  };
}

test("ask runs a tool round then returns the answer, with the right request shape and events", async () => {
  const { transport, requests } = scripted([
    { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "roadmap", arguments: {} } }] } },
    { message: { role: "assistant", content: "<think>hmm</think>We are in **current**, see [[Acme/Strategy/Roadmap.md]]." } },
  ]);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const events: AskEvent[] = [];
  const r = await ask("Which step?", deps(transport, calls), { onEvent: (e) => events.push(e) });
  assert.equal(r.answer, "We are in **current**, see [[Acme/Strategy/Roadmap.md]].");
  assert.equal(r.rounds, 2);
  assert.deepEqual(calls, [{ name: "roadmap", args: {} }]);
  assert.deepEqual(r.trace, [{ name: "roadmap", args: {}, result: "result of roadmap" }]);
  const first = requests[0].body as { stream: boolean; think: boolean; options: { num_ctx: number }; tools: unknown[]; messages: ChatMessage[]; model: string };
  assert.equal(requests[0].url, "http://localhost:11434/api/chat");
  assert.equal(first.stream, false);
  assert.equal(first.think, false);
  assert.equal(first.options.num_ctx, 8192);
  assert.equal(first.model, "test-model");
  assert.equal(first.tools.length, 7);
  assert.deepEqual(first.messages.map((m) => m.role), ["system", "user"]);
  const second = requests[1].body as { messages: ChatMessage[] };
  assert.deepEqual(second.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(second.messages[3].tool_name, "roadmap");
  assert.equal(second.messages[3].content, "result of roadmap");
  assert.deepEqual(events.map((e) => e.type), ["status", "tool_call", "tool_result", "status", "answer"]);
  assert.deepEqual(r.history.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
});

test("ask stops calling tools after maxRounds and forces a final answer without tools", async () => {
  const call = { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "search", arguments: '{"query":"x"}' } }] } };
  const { transport, requests } = scripted([call, call, call, { message: { role: "assistant", content: "final" } }]);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const r = await ask("loop", deps(transport, calls), {});
  assert.equal(r.answer, "final");
  assert.equal(r.rounds, 4);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, { query: "x" }, "string arguments are parsed");
  assert.equal("tools" in (requests[3].body as object), false);
});

test("ask parses an inline JSON tool call and retries once on an empty answer", async () => {
  const { transport } = scripted([
    { message: { role: "assistant", content: '```json\n{"name":"count_notes","arguments":{"type":"interview"}}\n```' } },
    { message: { role: "assistant", content: "" } },
    { message: { role: "assistant", content: "two" } },
  ]);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const r = await ask("how many", deps(transport, calls), {});
  assert.deepEqual(calls, [{ name: "count_notes", args: { type: "interview" } }]);
  assert.equal(r.answer, "two");
  assert.equal(parseInlineCall("hello", new Set(["x"])), null);
  assert.equal(parseInlineCall('{"name":"nope"}', new Set(["x"])), null);
});

test("Ollama errors are classified with hints", async () => {
  const missing = scripted([{ status: 404, json: { error: "model 'x' not found" } }]);
  await assert.rejects(ask("q", deps(missing.transport), {}), (e: unknown) => e instanceof OllamaError && e.kind === "model-missing" && /ollama pull test-model/.test(e.hint));
  const down = scripted([new Error("ECONNREFUSED")]);
  await assert.rejects(ask("q", deps(down.transport), {}), (e: unknown) => e instanceof OllamaError && e.kind === "unreachable");
  const noTools = scripted([{ status: 400, json: { error: "registry.ollama.ai/library/x does not support tools" } }]);
  await assert.rejects(ask("q", deps(noTools.transport), {}), (e: unknown) => e instanceof OllamaError && e.kind === "no-tools");
  const timeout = scripted([new Error("This operation was aborted (timeout)")]);
  await assert.rejects(ask("q", deps(timeout.transport), {}), (e: unknown) => e instanceof OllamaError && e.kind === "timeout");
});

test("listModels reads /api/tags and /api/show", async () => {
  const { transport, requests } = scripted([
    { models: [{ name: "b:latest", size: 10, details: { family: "qwen3", parameter_size: "8B" } }, { name: "a:latest", size: 5, details: {} }] },
    { capabilities: ["completion", "tools"] },
    { capabilities: ["completion"] },
  ]);
  const models = await listModels(transport, "http://h:1/");
  assert.equal(requests[0].url, "http://h:1/api/tags");
  assert.deepEqual(models.map((m) => `${m.name} ${m.tools}`), ["a:latest false", "b:latest true"]);
});

test("KbService caches the knowledge base, invalidates, and asks with the digest as system prompt", async () => {
  const settings = await loadPluginData(FIXTURE);
  const source = await NodeNoteSource.load(FIXTURE, settings.kb);
  const { transport, requests } = scripted([{ message: { role: "assistant", content: "ok" } }]);
  const svc = new KbService(source, () => settings, transport, () => "2026-09-15");
  assert.equal(svc.kb(), svc.kb(), "cached");
  const d1 = await svc.digest();
  assert.equal(await svc.digest(), d1);
  svc.invalidate();
  assert.equal(await svc.digest(), d1, "same input, same digest after invalidation");
  assert.match(await svc.runTool("count_notes", { type: "project" }), /type=project: 2 notes/);
  const r = await svc.ask("q");
  assert.equal(r.answer, "ok");
  const sys = (requests[0].body as { messages: ChatMessage[] }).messages[0];
  assert.equal(sys.role, "system");
  assert.match(sys.content, /Names that mean the same thing: Acme = Rocket/);
  assert.match(sys.content, /# Vault digest — 2026-09-15/);
});

test("withSources appends consulted paths when the answer cites none", () => {
  const trace = [
    { name: "count_notes", args: {}, result: 'type=interview: 0 notes\nDone tasks mentioning "interview": Find 2 interviews (done 2026-08-25) — Acme/Execution/Tasks/Find 2 interviews.md; Other (done) — Acme/Execution/Tasks/Other.md' },
    { name: "read_note", args: {}, result: "# Acme/Strategy/Roadmap.md\ntype: index" },
  ];
  const out = withSources("Two interviews happened (task Find 2 interviews).", trace);
  assert.equal(out, "Two interviews happened (task Find 2 interviews).\n\nSources: [[Acme/Execution/Tasks/Find 2 interviews]], [[Acme/Execution/Tasks/Other]], [[Acme/Strategy/Roadmap]]");
  assert.equal(withSources("See [[Acme/Strategy/Roadmap]].", trace), "See [[Acme/Strategy/Roadmap]].");
  assert.equal(withSources("nothing", []), "nothing");
});
