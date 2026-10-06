/**
 * Copy one Mermaid release into assets/runtime/vendor/mermaid/.
 *
 * Run: node scripts/vendor-mermaid.ts <version>
 *
 * The browser needs only the self-contained dist/mermaid.min.js. The npm package
 * would install about 200 MB of Node dependencies that nothing here uses, so the
 * file is vendored instead of declared as a dependency.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: node scripts/vendor-mermaid.ts <version>, for example 12.1.0");
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "assets/runtime/vendor/mermaid");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teach-mermaid-"));
try {
  const tarball = execFileSync("npm", ["pack", `mermaid@${version}`, "--silent"], {
    cwd: work,
    encoding: "utf8",
  }).trim();
  execFileSync("tar", ["xzf", tarball], { cwd: work });
  const unpacked = path.join(work, "package");
  const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, "package.json"), "utf8"));
  if (manifest.version !== version) {
    throw new Error(`npm returned mermaid ${manifest.version}, not ${version}`);
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(unpacked, "dist/mermaid.min.js"), path.join(target, "mermaid.min.js"));
  fs.copyFileSync(path.join(unpacked, "LICENSE"), path.join(target, "LICENSE"));
  fs.writeFileSync(path.join(target, "VERSION"), `${version}\n`);
  console.log(`Vendored mermaid ${version} into ${path.relative(root, target)}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
