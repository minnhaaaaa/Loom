import type { Locator } from "@playwright/test";

export async function selectOption(
  control: Locator,
  value: string | { index: number },
) {
  await control.click();
  const menu = control.page().locator(".loom-select-popup");
  const option =
    typeof value === "string"
      ? menu.locator(`[role="option"][data-value=${JSON.stringify(value)}]`)
      : menu.getByRole("option").nth(value.index);
  await option.click();
}
