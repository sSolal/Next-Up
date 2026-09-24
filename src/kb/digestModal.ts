import { App, Modal, Notice, Setting } from "obsidian";

/** Shows the digest the model receives, with its size, so users can tune the budget. */
export class DigestModal extends Modal {
  private text: string;

  constructor(app: App, text: string) {
    super(app);
    this.text = text;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("next-up-modal");
    contentEl.createEl("h3", { text: "Vault digest" });
    contentEl.createDiv({ cls: "next-up-muted next-up-small", text: `${this.text.length} characters ≈ ${Math.round(this.text.length / 4)} tokens. This text, plus the tool list, is what the model reads before every question.` });
    const pre = contentEl.createEl("pre", { cls: "next-up-digest" });
    pre.setText(this.text);
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Copy").setCta().onClick(async () => {
        await navigator.clipboard.writeText(this.text);
        new Notice("Digest copied");
      }),
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** One-line question prompt for the command palette. */
export class AskPromptModal extends Modal {
  private onSubmit: (q: string) => void;

  constructor(app: App, onSubmit: (q: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("next-up-modal");
    contentEl.createEl("h3", { text: "Ask the vault" });
    let value = "";
    new Setting(contentEl).addText((t) => {
      t.inputEl.addClass("next-up-wide");
      t.setPlaceholder("Which step of the roadmap are we in?").onChange((v) => (value = v));
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submit(value);
        }
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    new Setting(contentEl).addButton((b) => b.setButtonText("Ask").setCta().onClick(() => this.submit(value)));
  }

  private submit(q: string) {
    if (!q.trim()) return;
    this.close();
    this.onSubmit(q.trim());
  }

  onClose() {
    this.contentEl.empty();
  }
}
