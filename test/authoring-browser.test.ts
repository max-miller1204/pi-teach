import { expect, it } from "vitest";
import { selectLocateAnswer } from "../scripts/authoring-browser.ts";

it.each([false, true])("keeps the locate answer selected when restored=%s", async (restored) => {
  let selected = restored;
  const segment = {
    async getAttribute() {
      return String(selected);
    },
    async click() {
      selected = !selected;
    },
  };
  await selectLocateAnswer(segment);
  expect(selected).toBe(true);
  await selectLocateAnswer(segment);
  expect(selected).toBe(true);
});
