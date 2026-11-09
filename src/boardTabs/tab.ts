/* A tab of the board: one use case each (Dive into everything, Plan the week…). */
import type NextUpPlugin from "../main.ts";
import type { BoardTabId } from "../settingsTypes.ts";
import type { Ctx } from "../query.ts";

/** What a tab gets from the board around it. */
export interface TabHost {
  plugin: NextUpPlugin;
  ctx(): Ctx;
  /** save the board prefs; redraw the whole tab unless told not to */
  save(redraw?: boolean): Promise<void>;
  /** refresh the open tab soon (typing in a search box) */
  scheduleRefresh(): void;
}

export interface BoardTab {
  id: BoardTabId;
  label: string;
  icon: string;
  /** draw everything: the bar and the body are empty */
  mount(bar: HTMLElement, body: HTMLElement): void;
  /** tasks changed: redraw the content, keep the bar (and the focus of its search box) */
  refresh(): void;
  /** a task note shown in the tab: its change redraws */
  isShown(path: string): boolean;
}
