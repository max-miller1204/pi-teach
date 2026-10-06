/** Opt-in, tailnet-only HTTPS route. Never reset Serve or enable Funnel. */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { servicePaths } from "./service-client.ts";
const exec = promisify(execFile);
export type TailscaleCommand = (args: string[]) => Promise<string>;
const command: TailscaleCommand = async (args) => {
  try {
    return (await exec("tailscale", args, { timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout;
  } catch (err) {
    throw new Error(`Tailscale command failed (${args.join(" ")}): ${(err as Error).message}`);
  }
};
interface Route {
  host: string;
  port: number;
  target: string;
}
export class PhoneAccess {
  private readonly run: TailscaleCommand;
  private readonly file: string;
  constructor(run: TailscaleCommand = command, file = path.join(servicePaths().dir, "phone.json")) {
    this.run = run;
    this.file = file;
  }
  private owner(): Route | null {
    try {
      const owner = JSON.parse(fs.readFileSync(this.file, "utf8")) as Route;
      if (
        !owner ||
        typeof owner.host !== "string" ||
        !/^[a-z0-9.-]+\.ts\.net$/.test(owner.host) ||
        !Number.isInteger(owner.port) ||
        owner.port < 1 ||
        owner.port > 65535 ||
        !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(owner.target)
      )
        throw new Error("Invalid phone route ownership file.");
      return owner;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
  private save(route: Route): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(route), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  private async inspect(): Promise<{ host: string; config: any }> {
    const status = JSON.parse(await this.run(["status", "--json"]));
    if (status.BackendState !== "Running" || !status.Self?.DNSName)
      throw new Error("Tailscale is not connected or has no DNS name.");
    return {
      host: status.Self.DNSName.replace(/\.$/, ""),
      config: JSON.parse(await this.run(["serve", "status", "--json"])),
    };
  }
  private handler(config: any, host: string, port: number): any {
    return config.Web?.[`${host}:${port}`]?.Handlers?.["/"];
  }
  async status(): Promise<unknown> {
    const { host, config } = await this.inspect(),
      owner = this.owner();
    if (!owner) return { enabled: false };
    const current = this.handler(config, owner.host, owner.port);
    return {
      enabled:
        host === owner.host &&
        current?.Proxy === owner.target &&
        config.AllowFunnel?.[`${owner.host}:${owner.port}`] !== true,
      owned: owner,
      url: `https://${owner.host}:${owner.port}`,
      conflict: current && current.Proxy !== owner.target ? "Owned route changed." : undefined,
    };
  }
  async start(target: string, port = 8443): Promise<string> {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Phone HTTPS port must be an integer from 1 to 65535.");
    const { host, config } = await this.inspect();
    const owner = this.owner(),
      key = `${host}:${port}`;
    if (config.AllowFunnel?.[key])
      throw new Error("This HTTPS port has Funnel enabled. Select a tailnet-only port explicitly.");
    const handlers = config.Web?.[key]?.Handlers;
    const current = this.handler(config, host, port);
    const ours = owner?.host === host && owner.port === port && owner.target === target;
    if (owner && !ours)
      throw new Error("Phone access owns a different route. Stop it before changing the port.");
    if (
      (handlers &&
        Object.keys(handlers).length > 0 &&
        (!ours || Object.keys(handlers).some((p) => p !== "/") || current?.Proxy !== target)) ||
      (config.TCP?.[String(port)] && !config.TCP[String(port)].HTTPS)
    )
      throw new Error(
        `Tailscale Serve port ${port} is in use. Select a free HTTPS port explicitly.`,
      );
    // Record intent before mutation. A failed verification remains visible and removable.
    this.save({ host, port, target });
    if (!current) await this.run(["serve", "--bg", `--https=${port}`, "--set-path=/", target]);
    const checked = await this.inspect();
    if (
      this.handler(checked.config, host, port)?.Proxy !== target ||
      checked.config.AllowFunnel?.[key]
    )
      throw new Error("Tailscale did not create the requested tailnet-only route.");
    return `https://${host}:${port}`;
  }
  async stop(): Promise<unknown> {
    const owner = this.owner();
    if (!owner) return { removed: false };
    const { config } = await this.inspect();
    const current = this.handler(config, owner.host, owner.port);
    if (current && current.Proxy !== owner.target)
      throw new Error("Owned Tailscale route changed. Refusing to remove another route.");
    if (current) await this.run(["serve", `--https=${owner.port}`, "--set-path=/", "off"]);
    const checked = await this.inspect();
    if (this.handler(checked.config, owner.host, owner.port))
      throw new Error("Tailscale route removal did not complete.");
    fs.unlinkSync(this.file);
    return { removed: !!current };
  }
}
