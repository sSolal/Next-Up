import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type NextUpPlugin from "../main.ts";
import { OllamaError } from "./ollama.ts";
import { linkifyPaths } from "./linkify.ts";
import { DigestModal } from "./digestModal.ts";
import type { AskEvent, ChatMessage } from "./types.ts";

export const VIEW_TYPE_ASK = "next-up-ask";

/** Right-sidebar chat over the vault: question in, tool trace and answer out. */
export class AskVaultView extends ItemView {
  plugin: NextUpPlugin;
  private input!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  private transcript!: HTMLElement;
  private askBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private history: ChatMessage[] = [];
  private abort: AbortController | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: NextUpPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_ASK;
  }

  getDisplayText(): string {
    return "Ask the vault";
  }

  getIcon(): string {
    return "message-circle-question";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("next-up-ask");

    const bar = root.createDiv({ cls: "next-up-ask-bar" });
    bar.createSpan({ text: "Ask the vault", cls: "next-up-ask-title" });
    const right = bar.createDiv({ cls: "next-up-ask-bar-right" });
    this.iconButton(right, "file-text", "Show digest", () => this.showDigest());
    this.iconButton(right, "copy", "Copy digest", () => this.copyDigest());
    this.iconButton(right, "eraser", "Clear conversation", () => this.clear());

    this.input = root.createEl("textarea", { cls: "next-up-ask-input", attr: { rows: "3", placeholder: "Which step of the roadmap are we in?  ·  Combien d'entretiens ont eu lieu ?" } });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void this.submit();
      }
    });
    const actions = root.createDiv({ cls: "next-up-ask-actions" });
    this.askBtn = actions.createEl("button", { text: "Ask", cls: "next-up-btn mod-cta" });
    this.askBtn.addEventListener("click", () => void this.submit());
    this.stopBtn = actions.createEl("button", { text: "Stop", cls: "next-up-btn" });
    this.stopBtn.disabled = true;
    this.stopBtn.addEventListener("click", () => this.abort?.abort());
    actions.createSpan({ text: `${this.plugin.settings.kb.model}`, cls: "next-up-muted next-up-small next-up-ask-model" });
    this.statusEl = root.createDiv({ cls: "next-up-ask-status next-up-muted next-up-small" });
    this.transcript = root.createDiv({ cls: "next-up-ask-transcript" });
    this.plugin.onSettingsChange(this, () => {
      const m = root.querySelector(".next-up-ask-model");
      if (m) m.textContent = this.plugin.settings.kb.model;
    });
  }

  async onClose() {
    this.abort?.abort();
  }

  /** Ask from outside the view (command palette). */
  async askQuestion(q: string) {
    this.input.value = q;
    await this.submit();
  }

  private iconButton(parent: HTMLElement, icon: string, title: string, onClick: () => void) {
    const b = parent.createEl("button", { cls: "next-up-btn next-up-icon-btn", attr: { "aria-label": title, title } });
    setIcon(b, icon);
    b.addEventListener("click", onClick);
    return b;
  }

  private setBusy(busy: boolean) {
    this.askBtn.disabled = busy;
    this.stopBtn.disabled = !busy;
    this.input.disabled = busy;
  }

  private async submit() {
    const q = this.input.value.trim();
    if (!q || this.abort) return;
    this.input.value = "";
    const card = this.transcript.createDiv({ cls: "next-up-ask-exchange" });
    card.createDiv({ cls: "next-up-ask-q", text: q });
    const trace = card.createDiv({ cls: "next-up-ask-trace" });
    const answerEl = card.createDiv({ cls: "next-up-ask-answer" });
    card.scrollIntoView({ block: "end" });
    this.abort = new AbortController();
    this.setBusy(true);
    try {
      const r = await this.plugin.kb.ask(q, {
        history: this.history,
        signal: this.abort.signal,
        onEvent: (e) => this.onEvent(e, trace),
      });
      this.history = r.history;
      this.statusEl.setText(`${r.rounds} round${r.rounds > 1 ? "s" : ""} · ${r.trace.length} tool call${r.trace.length === 1 ? "" : "s"}`);
      await this.renderAnswer(answerEl, r.answer);
    } catch (e) {
      const msg = e instanceof OllamaError ? `${e.message}\n${e.hint}` : e instanceof Error ? e.message : String(e);
      answerEl.createDiv({ cls: "next-up-ask-error", text: msg });
      this.statusEl.setText(msg === "cancelled" ? "stopped" : "error");
      if (e instanceof OllamaError) new Notice(e.hint, 8000);
    } finally {
      this.abort = null;
      this.setBusy(false);
      card.scrollIntoView({ block: "end" });
    }
  }

  private onEvent(e: AskEvent, trace: HTMLElement) {
    if (e.type === "status") this.statusEl.setText(e.text);
    if (e.type === "tool_call") {
      const d = trace.createEl("details", { cls: "next-up-ask-call" });
      d.createEl("summary", { text: `${e.name}(${summarizeArgs(e.args)})` });
      d.createEl("pre", { text: "…" });
      this.statusEl.setText(`round ${e.round} · ${e.name}`);
    }
    if (e.type === "tool_result") {
      const last = trace.querySelector("details:last-of-type pre");
      if (last) last.textContent = e.text.length > 4000 ? e.text.slice(0, 4000) + "\n…" : e.text;
    }
  }

  private async renderAnswer(el: HTMLElement, answer: string) {
    const md = linkifyPaths(answer, this.plugin.kb.kb().byPath.keys());
    await MarkdownRenderer.render(this.app, md, el, "", this);
  }

  private clear() {
    this.history = [];
    this.transcript.empty();
    this.statusEl.setText("");
  }

  private async showDigest() {
    try {
      new DigestModal(this.app, await this.plugin.kb.digest()).open();
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
    }
  }

  private async copyDigest() {
    try {
      await navigator.clipboard.writeText(await this.plugin.kb.digest());
      new Notice("Digest copied");
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
    }
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
}
