// The type axis is freeform (#28), so there is no fixed enum to pre-map to colors:
// each distinct type gets a badge color by its position in the sorted distinct set,
// walking a fixed palette and round-robining once types outnumber it. Sorted input
// keeps a type's color stable as the live set grows. Foreground is black/white by the
// swatch's WCAG relative luminance so the badge label stays legible (accessibility).
const PALETTE = [
  '#e5484d', // red
  '#f76b15', // orange
  '#ffca16', // amber
  '#99d52a', // lime
  '#30a46c', // green
  '#12a594', // teal
  '#00a2c7', // cyan
  '#0091ff', // blue
  '#3e63dd', // indigo
  '#8e4ec6', // purple
  '#e93d82', // pink
  '#a18072', // brown
];

export interface TypeColor {
  bg: string;
  fg: string;
}

// Relative luminance (WCAG 2.x) of a #rrggbb swatch, used only to choose a legible
// text color over it.
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function typeColor(index: number): TypeColor {
  // Modulo keeps the index in range; `?? PALETTE[0]` only satisfies
  // noUncheckedIndexedAccess and is otherwise unreachable.
  const bg = PALETTE[index % PALETTE.length] ?? PALETTE[0] ?? '#888';
  return { bg, fg: luminance(bg) > 0.5 ? '#000' : '#fff' };
}

// Map each distinct type (pass the sorted distinct set) to its badge color.
export function typeColors(types: string[]): Map<string, TypeColor> {
  return new Map(types.map((type, i) => [type, typeColor(i)]));
}
