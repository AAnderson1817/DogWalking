// Pet-profile fallback used only when no truthful pet photo exists. The
// deterministic colorway uses Sanpo's supporting palette; it is excluded from
// schedule rows, Inbox, and other ambient product decoration.

const COLORWAYS: Array<{ face: string; ears: string }> = [
  { face: "#F4E4B8", ears: "#E5AB35" },
  { face: "#FEF6EA", ears: "#B84828" },
  { face: "#D8EAF0", ears: "#236F86" },
  { face: "#DEE8D8", ears: "#55724B" },
  { face: "#E7E0EF", ears: "#796397" },
  { face: "#F2D7CC", ears: "#B84828" },
  { face: "#CAD7DC", ears: "#5D7180" },
];

const INK = "#0C4774";
const BLUSH = "#F2D7CC";

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// oxlint-disable-next-line react/only-export-components
export function petColorway(name: string): { face: string; ears: string } {
  return COLORWAYS[hashName(name) % COLORWAYS.length] ?? { face: "#F4E4B8", ears: "#E5AB35" };
}

export function PetFace({ name, size = 34 }: { name: string; size?: number }) {
  const c = petColorway(name);
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} role="img" aria-label={name}>
      <path d="M9 15 L3 3 L17 7 Z" fill={c.ears} />
      <path d="M31 15 L37 3 L23 7 Z" fill={c.ears} />
      <circle cx="20" cy="23" r="14" fill={c.face} />
      <circle cx="15" cy="21" r="2.2" fill={INK} />
      <circle cx="25" cy="21" r="2.2" fill={INK} />
      <ellipse cx="20" cy="27" rx="3.2" ry="2.4" fill={INK} />
      <circle cx="10.5" cy="26" r="2" fill={BLUSH} opacity="0.7" />
      <circle cx="29.5" cy="26" r="2" fill={BLUSH} opacity="0.7" />
    </svg>
  );
}
