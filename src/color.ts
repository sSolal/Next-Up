/** A stable hue for a name, so each person and each project keeps its colour on every card. */
export function hue(name: string): number {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
