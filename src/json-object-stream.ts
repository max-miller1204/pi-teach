/** Read complete JSON objects across chunks and message separators. */
export class JsonObjectStream {
  private buffer = "";
  private offset = 0;
  private start = -1;
  private depth = 0;
  private quoted = false;
  private escaped = false;

  constructor(limit = 16 * 1024 * 1024) {
    this.limit = limit;
  }
  private readonly limit: number;

  push(chunk: string, receive: (value: unknown) => void): void {
    this.buffer += chunk;
    let consumed = 0;
    for (; this.offset < this.buffer.length; this.offset++) {
      const c = this.buffer[this.offset];
      if (this.start === -1) {
        if (/\s/.test(c)) {
          consumed = this.offset + 1;
          continue;
        }
        if (c !== "{") throw new Error(`Expected a JSON object. Received ${JSON.stringify(c)}.`);
        this.start = this.offset;
        this.depth = 1;
        continue;
      }
      if (this.offset - this.start >= this.limit)
        throw new Error("JSON object exceeds the size limit.");
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') this.quoted = false;
      } else if (c === '"') this.quoted = true;
      else if (c === "{" || c === "[") this.depth++;
      else if (c === "}" || c === "]") {
        this.depth--;
        if (this.depth === 0) {
          const value: unknown = JSON.parse(this.buffer.slice(this.start, this.offset + 1));
          this.start = -1;
          consumed = this.offset + 1;
          receive(value);
        }
      }
    }
    this.buffer = this.buffer.slice(consumed);
    this.offset -= consumed;
    if (this.start !== -1) this.start -= consumed;
  }

  finish(): void {
    if (this.start !== -1) throw new Error("Codex stdout ended inside a JSON object.");
  }
}
