/** Select lesson text with mouse actions. DOM reads provide the text coordinates. */
export async function highlightText(page: any, selector: string, phrase: string): Promise<void> {
  await page.locator(selector).scrollIntoViewIfNeeded();
  const box = await page.locator(selector).evaluate((element: Element, text: string) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent!.indexOf(text);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    throw new Error(`No lesson text matches ${text}.`);
  }, phrase);
  await page.mouse.move(box.x + 0.5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 0.5, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  if ((await page.evaluate(() => getSelection()!.toString())) !== phrase)
    throw new Error(`Mouse selection did not select ${phrase}.`);
}
