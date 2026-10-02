// Copies the website into ../docs (the GitHub Pages entrypoint).
// `--check` verifies docs/ is current without writing, for CI.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "..", "docs");
const entries = ["index.html", "src"];
const check = process.argv.includes("--check");

const list = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? list(join(dir, d.name)) : [join(dir, d.name)]);

if (check) {
  let stale = [];
  for (const e of entries) {
    const src = join(root, e);
    const files = statSync(src).isDirectory() ? list(src) : [src];
    for (const f of files) {
      const target = join(docs, relative(root, f));
      if (!existsSync(target) || !readFileSync(f).equals(readFileSync(target))) stale.push(relative(root, f));
    }
  }
  if (stale.length) {
    console.error(`docs/ is out of date for: ${stale.join(", ")}\nRun "npm run build" in website/ and commit docs/.`);
    process.exit(1);
  }
  console.log("docs/ is up to date.");
} else {
  mkdirSync(docs, { recursive: true });
  rmSync(join(docs, "src"), { recursive: true, force: true });
  for (const e of entries) cpSync(join(root, e), join(docs, e), { recursive: true });
  writeFileSync(join(docs, ".nojekyll"), "");
  console.log(`Built website into ${relative(process.cwd(), docs) || "docs"}`);
}
