/**
 * Headless entry point: the same core the plugin uses, over a vault on disk.
 *
 *   kb digest [--vault P] [--json]
 *   kb ask "<question>" [--vault P] [--model M] [--url U] [--ctx N] [--think] [--trace] [--json]
 *   kb tool <name> '<json args>' [--vault P]
 *   kb models [--url U]
 *
 * `--vault` defaults to $KB_VAULT, then the current directory. Settings come from the
 * vault's `.obsidian/plugins/next-up/data.json`, flags override the model parameters.
 * Nothing is ever written under the vault.
 */
import process from "node:process";
import { NodeNoteSource, loadPluginData } from "./node.ts";
import { OllamaError, fetchTransport } from "./ollama.ts";
import { KbService } from "./service.ts";
import type { AskEvent } from "./types.ts";

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !["json", "trace", "help", "think"].includes(key)) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  const [command = "help", ...rest] = positional;
  return { command, positional: rest, flags };
}

const USAGE = `usage:
  kb digest [--vault P] [--json]
  kb ask "<question>" [--vault P] [--model M] [--url U] [--ctx N] [--think] [--trace] [--json]
  kb tool <name> '<json args>' [--vault P]
  kb models [--url U]`;

async function main(argv: string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  if (command === "help" || flags.help) {
    console.log(USAGE);
    return command === "help" && !flags.help && argv.length ? 1 : 0;
  }
  const vault = String(flags.vault ?? process.env.KB_VAULT ?? process.cwd());
  const settings = await loadPluginData(vault);
  if (typeof flags.model === "string") settings.kb.model = flags.model;
  if (typeof flags.url === "string") settings.kb.baseUrl = flags.url;
  if (typeof flags.ctx === "string") settings.kb.numCtx = parseInt(flags.ctx, 10) || settings.kb.numCtx;
  if (flags.think === true) settings.kb.think = true;
  const json = flags.json === true;

  if (command === "models") {
    const svc = new KbService({ root: vault, list: () => [], read: async () => "" }, () => settings, fetchTransport);
    const models = await svc.listModels();
    if (json) console.log(JSON.stringify(models, null, 2));
    else for (const m of models) console.log(`${m.name}\t${(m.size / 1e9).toFixed(1)} GB\t${m.parameterSize || m.family}\t${m.tools === undefined ? "tools?" : m.tools ? "tools" : "no tools"}`);
    return 0;
  }

  const source = await NodeNoteSource.load(vault, settings.kb);
  const svc = new KbService(source, () => settings, fetchTransport);

  if (command === "digest") {
    const text = await svc.digest();
    if (json) console.log(JSON.stringify({ vault: source.root, chars: text.length, digest: text }, null, 2));
    else console.log(text);
    return 0;
  }
  if (command === "tool") {
    const [name, rawArgs] = positional;
    if (!name) {
      console.error(USAGE);
      return 1;
    }
    let args: Record<string, unknown> = {};
    if (rawArgs) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        console.error(`arguments must be JSON, got: ${rawArgs}`);
        return 1;
      }
    }
    console.log(await svc.runTool(name, args));
    return 0;
  }
  if (command === "ask") {
    const question = positional.join(" ").trim();
    if (!question) {
      console.error(USAGE);
      return 1;
    }
    const trace = flags.trace === true;
    const onEvent = (e: AskEvent) => {
      if (!trace) return;
      if (e.type === "status") console.error(`… ${e.text}`);
      if (e.type === "tool_call") console.error(`→ ${e.name}(${JSON.stringify(e.args)})`);
      if (e.type === "tool_result") console.error(`← ${e.text.split("\n").slice(0, 3).join(" | ").slice(0, 200)}`);
    };
    const r = await svc.ask(question, { onEvent });
    if (json) console.log(JSON.stringify({ question, answer: r.answer, rounds: r.rounds, trace: r.trace }, null, 2));
    else console.log(r.answer);
    return 0;
  }
  console.error(USAGE);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof OllamaError) {
      console.error(`${e.message}\n${e.hint}`);
      process.exit(2);
    }
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  },
);
