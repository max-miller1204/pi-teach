import { expect, it } from "vitest";
import { JsonObjectStream } from "../src/json-object-stream.ts";

it("reads packed and split objects with escaped strings and nested arrays", () => {
  const messages = [{ text: 'quoted " \\ } { é', nested: [{ id: 1 }] }, { id: 2 }];
  const text = messages.map((m) => JSON.stringify(m)).join("");
  for (const width of [1, 7, text.length]) {
    const stream = new JsonObjectStream();
    const read: unknown[] = [];
    for (let i = 0; i < text.length; i += width)
      stream.push(text.slice(i, i + width), (m) => read.push(m));
    stream.push("\r\n  \n", (m) => read.push(m));
    stream.finish();
    expect(read).toEqual(messages);
  }
});
it("accepts whitespace between objects and within an object", () => {
  const stream = new JsonObjectStream();
  const read: unknown[] = [];
  stream.push(' \n{\n"id": 1\n}\r\n{"id":2}', (m) => read.push(m));
  stream.finish();
  expect(read).toEqual([{ id: 1 }, { id: 2 }]);
});
it.each(['{"id":1}warning', "{bad}", '[{"id":1}]'])("rejects invalid stdout: %s", (text) => {
  expect(() => new JsonObjectStream().push(text, () => {})).toThrow();
});
it("rejects truncated and oversized objects", () => {
  const stream = new JsonObjectStream(20);
  stream.push('{"id":', () => {});
  expect(() => stream.finish()).toThrow("ended inside a JSON object");
  expect(() => stream.push('"01234567890123456789"}', () => {})).toThrow("size limit");
});
