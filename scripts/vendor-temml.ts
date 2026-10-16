/**
 * Copy one Temml release into assets/runtime/vendor/temml/.
 *
 * Run: node scripts/vendor-temml.ts <version>
 *
 * The browser and the server share the ES module build: the page draws lesson math
 * with it, and src/markdown.ts renders math in answers and feedback with it. One
 * vendored copy keeps both on the same version. Temml-Local.css uses the math fonts
 * the device has. Temml.woff2 is its small script-letter font.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: node scripts/vendor-temml.ts <version>, for example 0.14.0");
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "assets/runtime/vendor/temml");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teach-temml-"));
try {
  const tarball = execFileSync("npm", ["pack", `temml@${version}`, "--silent"], {
    cwd: work,
    encoding: "utf8",
  }).trim();
  execFileSync("tar", ["xzf", tarball], { cwd: work });
  const unpacked = path.join(work, "package");
  const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, "package.json"), "utf8"));
  if (manifest.version !== version) {
    throw new Error(`npm returned temml ${manifest.version}, not ${version}`);
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const copies: [string, string][] = [
    ["dist/temml.mjs", "temml.mjs"],
    ["dist/temml.d.ts", "temml.d.mts"],
    ["dist/Temml-Local.css", "Temml-Local.css"],
    ["dist/Temml.woff2", "Temml.woff2"],
    ["LICENSE", "LICENSE"],
  ];
  for (const [from, to] of copies) {
    fs.copyFileSync(path.join(unpacked, from), path.join(target, to));
  }
  fs.writeFileSync(path.join(target, "VERSION"), `${version}\n`);
  console.log(`Vendored temml ${version} into ${path.relative(root, target)}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
