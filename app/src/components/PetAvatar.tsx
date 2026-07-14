// v2 "Biscuit" dog-face avatar (design mock 2a–2d): ears + face + eyes +
// muzzle + blush, colorway picked deterministically from the pet's name so
// the same dog always gets the same face. Pure SVG, no assets.

const COLORWAYS: Array<{ face: string; ears: string }> = [
  { face: "#F7B733", ears: "#E08E1B" }, // golden
  { face: "#F5D9A8", ears: "#D9A85F" }, // cream
  { face: "#B8C4D9", ears: "#8E9DBB" }, // blue-grey
  { face: "#C68958", ears: "#A06A3E" }, // brown
  { face: "#9587B8", ears: "#6B5B8C" }, // purple
  { face: "#E9967A", ears: "#C4645A" }, // salmon
  { face: "#93A8B8", ears: "#6E7F8D" }, // slate
];

const INK = "#3B2A20";
const BLUSH = "#FF9BB3";

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function petColorway(name: string): { face: string; ears: string } {
  return COLORWAYS[hashName(name) % COLORWAYS.length] ?? { face: "#F7B733", ears: "#E08E1B" };
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

/** Brand paw mark (4 circles), inherits color via fill=currentColor. */
export function PawIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden fill="currentColor">
      <circle cx="20" cy="24" r="9" />
      <circle cx="9" cy="14" r="4.5" />
      <circle cx="20" cy="10" r="4.5" />
      <circle cx="31" cy="14" r="4.5" />
    </svg>
  );
}
