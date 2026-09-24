import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { OllamaError } from "./kb/ollama.ts";
import type NextUpPlugin from "./main.ts";
import { DEFAULT_FIELDS, type FieldNames } from "./settingsTypes.ts";
import { formatCaptureKinds, parseCaptureKinds } from "./model.ts";

export class NextUpSettingTab extends PluginSettingTab {
  plugin: NextUpPlugin;
  /** not persisted: the tab opens simple every time */
  private showAdvanced = false;

  constructor(app: App, plugin: NextUpPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName("I am")
      .setDesc("Your name as it appears in the `owner` field of tasks. Stored on this device only.")
      .addText((t) =>
        t.setPlaceholder("Your name").setValue(s.me).onChange(async (v) => {
          s.me = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    this.text(containerEl, "Home note", "The page opened by the ribbon icon.", s.homeNote, (v) => (s.homeNote = v));
    this.text(containerEl, "Default task folder", "Where new tasks go when a block has no `folder:`. Tasks can live anywhere: any note with `type: task` is one.", s.tasksFolder, (v) => (s.tasksFolder = v));
    this.text(containerEl, "Board tags", "Comma-separated tags that act as columns (today, this-week…). A task with none of them, on itself or its parents, is “One day” (`tags: none`).", s.boardTags.join(", "), (v) => (s.boardTags = list(v).map((x) => x.replace(/^#/, ""))));
    this.text(containerEl, "Statuses", "Comma-separated, in the order a click on the status cycles through them.", s.statuses.join(", "), (v) => (s.statuses = list(v).length ? list(v) : ["todo", "doing", "review", "done", "dropped"]));
    this.text(containerEl, "Done statuses", "Comma-separated. These count as finished (checked box).", s.doneStatuses.join(", "), (v) => (s.doneStatuses = list(v).length ? list(v) : ["done"]));
    this.text(containerEl, "Team note", "Note whose `team:` list names the team members (optional).", s.teamNote, (v) => (s.teamNote = v));
    this.text(containerEl, "Task template", "Note used as the body of new tasks (optional). Its frontmatter is replaced.", s.taskTemplate, (v) => (s.taskTemplate = v));

    new Setting(containerEl)
      .setName("Capture kinds")
      .setDesc("Other notes Capture can create besides tasks, one per line: `Label | folder | template path | name pattern`. The name pattern supports {{title}} and {{date}}. Example: `Meeting | Meetings | Templates/Meeting.md | {{date}} {{title}}`")
      .addTextArea((t) => {
        t.inputEl.rows = 4;
        t.inputEl.addClass("next-up-kinds-input");
        t.setPlaceholder("Meeting | Meetings | Templates/Meeting.md | {{date}} {{title}}");
        t.setValue(formatCaptureKinds(s.captureKinds)).onChange(async (v) => {
          s.captureKinds = parseCaptureKinds(v);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("People").setDesc("For `next-up-crm` blocks: any note with `type: person` is a person.").setHeading();
    this.text(containerEl, "Default people folder", "Where the add row of a `next-up-crm` block creates people when the block has no `folder:`.", s.peopleFolder, (v) => (s.peopleFolder = v));
    this.text(containerEl, "Person template", "Note copied for new people (optional). Its frontmatter is kept; the block's tags and fields are added.", s.personTemplate, (v) => (s.personTemplate = v));
    this.number(containerEl, "Cold after (days)", "A last contact older than this shows in orange (and matches `last: stale`).", s.staleDays, (v) => (s.staleDays = Math.max(1, Math.round(v))));

    new Setting(containerEl).setName("Show advanced settings").addToggle((t) =>
      t.setValue(this.showAdvanced).onChange((v) => {
        this.showAdvanced = v;
        this.display();
      }),
    );
    if (!this.showAdvanced) return;

    new Setting(containerEl).setName("Behaviour").setHeading();
    this.number(containerEl, "Due soon (days)", "A due date within this many days shows in orange (and matches `due: soon`).", s.dueSoonDays, (v) => (s.dueSoonDays = v));
    this.text(containerEl, "Todo status", "Status of new tasks, and of a task unchecked.", s.todoStatus, (v) => (s.todoStatus = v || "todo"));
    this.text(containerEl, "Doing status", "", s.doingStatus, (v) => (s.doingStatus = v || "doing"));
    this.text(containerEl, "Task type value", "Value of the `type` field that marks a task note.", s.taskType, (v) => (s.taskType = v || "task"));

    this.text(containerEl, "Person type value", "Value of the `type` field that marks a person note.", s.personType, (v) => (s.personType = v || "person"));
    this.text(containerEl, "Contact fields", "Comma-separated keys of dated notes (meetings, interviews) that link people. Such a note with a past `date` counts as a contact.", s.interactionFields.join(", "), (v) => (s.interactionFields = list(v)));

    new Setting(containerEl)
      .setName("Field names")
      .setDesc("Frontmatter keys read and written by the plugin. Change them to fit an existing schema.")
      .setHeading();
    for (const k of Object.keys(DEFAULT_FIELDS) as (keyof FieldNames)[]) {
      this.text(containerEl, k, "", s.fields[k], (v) => (s.fields[k] = v || DEFAULT_FIELDS[k]));
    }

    this.kbSection(containerEl);
  }

  /** "Ask the vault": local model, digest and privacy settings. */
  private kbSection(containerEl: HTMLElement) {
    const s = this.plugin.settings;
    const kb = s.kb;
    new Setting(containerEl).setName("Ask the vault").setDesc("A local model (Ollama) answers questions from an automatic digest of the vault plus a few read-only tools.").setHeading();

    this.text(containerEl, "Ollama URL", "Where Ollama listens. Default http://localhost:11434.", kb.baseUrl, (v) => (kb.baseUrl = v || "http://localhost:11434"));

    const modelSetting = new Setting(containerEl).setName("Model").setDesc("Installed models are listed from Ollama; pick one that supports tools. Smaller models suit lighter laptops.");
    let dropdown: import("obsidian").DropdownComponent | null = null;
    const fill = async () => {
      if (!dropdown) return;
      const d = dropdown;
      d.selectEl.empty();
      d.addOption("", "loading…");
      try {
        const models = await this.plugin.kb.listModels();
        d.selectEl.empty();
        if (!models.length) d.addOption("", "— no model installed —");
        for (const m of models) d.addOption(m.name, `${m.name} · ${(m.size / 1e9).toFixed(1)} GB${m.tools === false ? " · no tools" : m.tools ? " · tools" : ""}`);
        if (kb.model && !models.some((m) => m.name === kb.model)) d.addOption(kb.model, `${kb.model} (not installed)`);
        d.setValue(kb.model);
      } catch (e) {
        d.selectEl.empty();
        d.addOption(kb.model, kb.model);
        d.setValue(kb.model);
        new Notice(e instanceof OllamaError ? `${e.message}\n${e.hint}` : String(e), 8000);
      }
    };
    modelSetting
      .addDropdown((d) => {
        dropdown = d;
        d.onChange(async (v) => {
          if (!v) return;
          kb.model = v;
          await this.plugin.saveSettings();
        });
        void fill();
      })
      .addExtraButton((b) => b.setIcon("refresh-cw").setTooltip("Refresh the list from Ollama").onClick(() => void fill()))
      .addText((t) =>
        t.setPlaceholder("or type a model name").onChange(async (v) => {
          if (v.trim()) {
            kb.model = v.trim();
            await this.plugin.saveSettings();
          }
        }),
      );

    this.number(containerEl, "Context window (tokens)", "Passed to Ollama as num_ctx. The digest needs more than Ollama's 4096 default; lower it on small machines together with the digest budget.", kb.numCtx, (v) => (kb.numCtx = Math.max(2048, Math.round(v))), 1024);
    this.number(containerEl, "Digest budget (characters)", "Size of the automatic summary handed to the model before each question. Show it with the “Ask the vault: show the digest” command.", kb.digestBudget, (v) => (kb.digestBudget = Math.max(2000, Math.round(v))), 1000);
    this.number(containerEl, "Max tool rounds", "After this many rounds the model must answer.", kb.maxRounds, (v) => (kb.maxRounds = Math.max(1, Math.round(v))));
    this.number(containerEl, "Timeout (ms)", "Per model call.", kb.timeoutMs, (v) => (kb.timeoutMs = Math.max(5000, Math.round(v))), 5000);
    new Setting(containerEl)
      .setName("Let the model think")
      .setDesc("Thinking models (qwen3…) reason before answering: better tool choice, slower answers.")
      .addToggle((t) =>
        t.setValue(kb.think).onChange(async (v) => {
          kb.think = v;
          await this.plugin.saveSettings();
        }),
      );
    this.text(containerEl, "Private folders", "Comma-separated folder prefixes the model never sees (not listed, searched or read).", kb.privateFolders.join(", "), (v) => (kb.privateFolders = list(v)));
    this.text(containerEl, "Template folders", "Comma-separated. Excluded from every count.", kb.templateFolders.join(", "), (v) => (kb.templateFolders = list(v)));
    this.text(containerEl, "Pinned sections", "Semicolon-separated `path#Heading` quoted verbatim in the digest (hand-written tables the model should know).", kb.pinnedSections.join("; "), (v) => (kb.pinnedSections = v.split(";").map((x) => x.trim()).filter(Boolean)));
    this.text(containerEl, "Aliases", "Words that mean the same thing in search, e.g. `old name=new name; client=customer`.", kb.aliases.map((g) => g.join("=")).join("; "), (v) => (kb.aliases = v.split(";").map((g) => g.split("=").map((x) => x.trim()).filter(Boolean)).filter((g) => g.length > 1)));
    this.text(containerEl, "Quarter order", "Comma-separated values of the `quarter` field on tasks, first to last.", kb.quarterOrder.join(", "), (v) => (kb.quarterOrder = list(v)));
  }

  private text(el: HTMLElement, name: string, desc: string, value: string, set: (v: string) => void) {
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addText((t) =>
        t.setValue(value).onChange(async (v) => {
          set(v.trim());
          await this.plugin.saveSettings();
        }),
      );
  }

  private number(el: HTMLElement, name: string, desc: string, value: number, set: (v: number) => void, step = 1) {
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.step = String(step);
        t.setValue(String(value)).onChange(async (v) => {
          const n = parseFloat(v);
          if (!isNaN(n)) {
            set(n);
            await this.plugin.saveSettings();
          }
        });
      });
  }
}

function list(v: string): string[] {
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}
