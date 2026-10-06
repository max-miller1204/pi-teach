/** Keep a restored locate answer selected during the authoring evaluation. */
export async function selectLocateAnswer(segment: {
  getAttribute(name: string): Promise<string | null>;
  click(): Promise<void>;
}): Promise<void> {
  if ((await segment.getAttribute("aria-pressed")) !== "true") await segment.click();
}
