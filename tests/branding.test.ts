import { describe, expect, it } from "vitest";
import { brandContrast, brandTheme, type BrandThemeInput } from "@loom/domain";

const brand: BrandThemeInput = {
  primaryColor: "#163d27",
  accentColor: "#c9f36b",
  font: "modern",
  corners: "rounded",
};

describe("company brand theme", () => {
  it.each([
    "#000000",
    "#ffffff",
    "#ffff00",
    "#00ff00",
    "#ff0066",
    "#777777",
    "#312e81",
  ])("keeps company color %s while selecting readable foregrounds", (color) => {
    const theme = brandTheme({
      ...brand,
      primaryColor: color,
      accentColor: color,
    });
    expect(theme["--brand-primary"]).toBe(color);
    expect(theme["--brand-accent"]).toBe(color);
    expect(
      brandContrast(theme["--brand-primary"], theme["--brand-on-primary"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      brandContrast(theme["--brand-accent"], theme["--brand-on-accent"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      brandContrast(
        theme["--brand-primary-hover"],
        theme["--brand-on-primary"],
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      brandContrast(theme["--brand-primary"], theme["--brand-sidebar-muted"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      brandContrast(theme["--brand-link"], theme["--soft"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      brandContrast(theme["--muted"], theme["--paper"]),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("applies typography and corner choices without accepting arbitrary CSS", () => {
    const technical = brandTheme({
      ...brand,
      font: "technical",
      corners: "square",
    });
    expect(technical["--brand-font-body"]).toBe("var(--font-mono), monospace");
    expect(technical["--brand-control-radius"]).toBe("2px");
    expect(technical["--brand-panel-radius"]).toBe("3px");
    const invalid = brandTheme({
      ...brand,
      primaryColor: "red; background:url(https://invalid.example)",
      accentColor: "#fff",
      font: "__proto__",
    } as unknown as BrandThemeInput);
    expect(invalid["--brand-primary"]).toBe("#19161e");
    expect(invalid["--brand-accent"]).toBe("#e1bdff");
    expect(invalid["--brand-font-body"]).toBe("var(--font-body), sans-serif");
    expect(
      Object.values(invalid).every(
        (value) => typeof value === "string" && !value.includes("url("),
      ),
    ).toBe(true);
  });

  it("derives a stable independent palette from every branding update", () => {
    const first = brandTheme(brand);
    const blue = brandTheme({
      ...brand,
      primaryColor: "#2563eb",
      accentColor: "#eab308",
    });
    expect(first).toEqual(brandTheme(brand));
    expect(blue["--paper"]).not.toBe(first["--paper"]);
    expect(blue["--line"]).not.toBe(first["--line"]);
    expect(blue["--brand-primary"]).toBe("#2563eb");
    for (const [key, value] of Object.entries(blue)) {
      if (!/font|radius/.test(key))
        expect(value).toMatch(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/);
    }
  });
});
