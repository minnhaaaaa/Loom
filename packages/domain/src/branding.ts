export type BrandThemeInput = {
  primaryColor: string;
  accentColor: string;
  font: "modern" | "classic" | "technical";
  corners: "rounded" | "square";
};

type Rgb = [number, number, number];
const white = "#ffffff";
const black = "#000000";

function safeColor(value: string, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}
function rgb(hex: string): Rgb {
  return [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  ) as Rgb;
}
function mix(left: string, right: string, amount: number) {
  const a = rgb(left),
    b = rgb(right);
  return `#${a
    .map((value, index) =>
      Math.round(value + (b[index] - value) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
function luminance(color: string) {
  const channels = rgb(color).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

/** WCAG relative-luminance contrast, for two six-digit sRGB colors. */
export function brandContrast(first: string, second: string) {
  const a = luminance(safeColor(first, black));
  const b = luminance(safeColor(second, white));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function foreground(background: string) {
  return brandContrast(black, background) >= brandContrast(white, background)
    ? black
    : white;
}
function readable(color: string, background: string, minimum = 4.5) {
  const target = foreground(background);
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(color, target, step / 100);
    if (brandContrast(candidate, background) >= minimum) return candidate;
  }
  return target;
}

/** Fixed CSS roles only: no user-supplied CSS, fonts, or expressions are emitted. */
export function brandTheme(branding: BrandThemeInput): Record<string, string> {
  const primary = safeColor(branding.primaryColor, "#163d27");
  const accent = safeColor(branding.accentColor, "#c9f36b");
  const onPrimary = foreground(primary),
    onAccent = foreground(accent);
  const paper = mix(primary, white, 0.965);
  const surface = mix(primary, white, 0.995);
  const soft = mix(primary, white, 0.925);
  const ink = mix(primary, black, 0.87);
  const link = readable(primary, soft);
  const sidebarMuted = readable(mix(primary, onPrimary, 0.74), primary);
  const fonts = {
    modern: {
      body: "var(--font-body), sans-serif",
      display: "var(--font-display), sans-serif",
    },
    classic: {
      body: "Georgia, 'Times New Roman', serif",
      display: "Georgia, 'Times New Roman', serif",
    },
    technical: {
      body: "var(--font-mono), monospace",
      display: "var(--font-mono), monospace",
    },
  } as const;
  const font =
    branding.font === "classic"
      ? fonts.classic
      : branding.font === "technical"
        ? fonts.technical
        : fonts.modern;
  const square = branding.corners === "square";
  return {
    "--brand-primary": primary,
    "--brand-on-primary": onPrimary,
    "--brand-primary-hover": mix(
      primary,
      onPrimary === white ? black : white,
      0.12,
    ),
    "--brand-accent": accent,
    "--brand-on-accent": onAccent,
    "--brand-accent-hover": mix(
      accent,
      onAccent === white ? black : white,
      0.1,
    ),
    "--brand-link": link,
    "--brand-sidebar-muted": sidebarMuted,
    "--brand-sidebar-hover": mix(primary, onPrimary, 0.09),
    "--brand-sidebar-line": mix(primary, onPrimary, 0.23),
    "--brand-overlay": `${mix(primary, black, 0.7)}66`,
    "--brand-shadow": `${mix(primary, black, 0.7)}1f`,
    "--brand-font-body": font.body,
    "--brand-font-display": font.display,
    "--brand-control-radius": square ? "2px" : "8px",
    "--brand-panel-radius": square ? "3px" : "12px",
    "--brand-button-radius": square ? "3px" : "999px",
    "--paper": paper,
    "--surface": surface,
    "--ink": ink,
    "--forest": primary,
    "--accent": link,
    "--leaf": readable(mix(primary, accent, 0.3), paper, 3),
    "--lime": accent,
    "--soft": soft,
    "--muted": readable(mix(ink, white, 0.4), paper),
    "--line": mix(primary, white, 0.79),
    "--border": mix(primary, white, 0.79),
    "--radius": square ? "3px" : "12px",
  };
}
