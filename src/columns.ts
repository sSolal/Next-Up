/* Which board column a task belongs to, for each way of splitting the board. Pure. */
import type { NextUpSettings } from "./settingsTypes.ts";
import { type TaskData, type TaskIndex, isDone, isParked } from "./model.ts";
import { effectivePlanned, effectiveProject } from "./plan.ts";

export type BoardMode = "when" | "status" | "project" | "person";
export const BOARD_MODES: BoardMode[] = ["when", "status", "project", "person"];

/** Open and behind: planned (or inherited a day) before today, or past its due date with no day planned. */
export function isLate(t: TaskData, idx: TaskIndex, s: NextUpSettings, today: string): boolean {
  if (isDone(t, s)) return false;
  const d = effectivePlanned(t, idx);
  if (d) return d < today;
  return !!t.due && t.due < today;
}

/** Done tasks go to `done` (or `dropped`, which no column shows); open ones to the column of `mode`. */
export function columnOf(t: TaskData, mode: BoardMode, idx: TaskIndex, s: NextUpSettings, today: string): string {
  if (isDone(t, s)) return t.status === s.doneStatuses[0] ? "done" : "dropped";
  switch (mode) {
    case "when": {
      if (isLate(t, idx, s, today)) return "late";
      const d = effectivePlanned(t, idx);
      if (!d) return "none";
      return d === today ? "today" : "later";
    }
    case "status":
      if (isParked(t, s)) return "ideas";
      return t.status === s.doingStatus ? "open" : "todo";
    case "project": {
      const p = effectiveProject(t, idx);
      return p ? `p:${p.toLowerCase()}` : "none";
    }
    case "person":
      return t.owner ? `o:${t.owner.toLowerCase()}` : "none";
  }
}
