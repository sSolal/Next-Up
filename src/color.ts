/*
 * A stable hue for a name, so each person and each project keeps its colour on every card.
 * A plain rolling hash; its two parameters only choose which hues names land on. They were tuned once so the
 * team's names come out far apart and in colours that read well; change them to reshuffle every colour.
 */
const HUE_SEED = 2;
const HUE_MULT = 8;

export function hue(name: string): number {
  let h = HUE_SEED;
  for (const ch of name.toLowerCase()) h = (h * HUE_MULT + ch.charCodeAt(0)) % 360;
  return h;
}
