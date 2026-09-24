/**
 * Binds a note source, the settings and a transport into one object the plugin and the
 * CLI share: cached knowledge base and digest, tools, model list, and `ask`.
 */
import type { NextUpSettings } from "../settingsTypes.ts";
import { isoDate } from "../model.ts";
import { ask, type AskOptions } from "./agent.ts";
import { renderDigest } from "./digest.ts";
import { buildKb } from "./index.ts";
import { listModels, type ModelInfo } from "./ollama.ts";
import { systemPrompt } from "./prompt.ts";
import { TOOLS, runTool, toOllamaTools } from "./tools.ts";
import type { AskResult, Kb, NoteSource, Transport } from "./types.ts";

export class KbService {
  private source: NoteSource;
  private settings: () => NextUpSettings;
  private transport: Transport;
  private today: () => string;
  private cachedKb: Kb | null = null;
  private cachedDigest: { key: string; text: string } | null = null;

  constructor(source: NoteSource, settings: () => NextUpSettings, transport: Transport, today: () => string = () => isoDate(new Date())) {
    this.source = source;
    this.settings = settings;
    this.transport = transport;
    this.today = today;
  }

  /** Forget the cached knowledge base; the next call rebuilds it. */
  invalidate(): void {
    this.cachedKb = null;
    this.cachedDigest = null;
  }

  kb(): Kb {
    const today = this.today();
    if (!this.cachedKb || this.cachedKb.today !== today) {
      this.cachedKb = buildKb(this.source, this.settings(), this.settings().kb, today);
      this.cachedDigest = null;
    }
    return this.cachedKb;
  }

  async digest(): Promise<string> {
    const kb = this.kb();
    const s = this.settings();
    const key = `${kb.today}|${s.kb.digestBudget}|${s.kb.pinnedSections.join(";")}|${s.kb.quarterOrder.join(",")}`;
    if (this.cachedDigest && this.cachedDigest.key === key) return this.cachedDigest.text;
    const pinnedText = new Map<string, string>();
    for (const spec of s.kb.pinnedSections) {
      const path = spec.split("#")[0].trim();
      if (!path || !kb.byPath.has(path)) continue;
      try {
        pinnedText.set(path, await this.source.read(path));
      } catch {
        // unreadable: the digest says "note not available"
      }
    }
    const text = renderDigest({ kb, settings: s, cfg: s.kb, pinnedText });
    this.cachedDigest = { key, text };
    return text;
  }

  runTool(name: string, args: Record<string, unknown>): Promise<string> {
    const s = this.settings();
    return runTool(name, args, { kb: this.kb(), read: (p) => this.source.read(p), settings: s, cfg: s.kb });
  }

  listModels(): Promise<ModelInfo[]> {
    return listModels(this.transport, this.settings().kb.baseUrl);
  }

  async ask(question: string, opts: AskOptions = {}): Promise<AskResult> {
    const s = this.settings();
    const digest = await this.digest();
    return ask(
      question,
      {
        transport: this.transport,
        cfg: s.kb,
        systemPrompt: systemPrompt(digest, s.kb),
        tools: TOOLS,
        ollamaTools: toOllamaTools(TOOLS),
        runTool: (name, args) => this.runTool(name, args),
      },
      opts,
    );
  }
}
