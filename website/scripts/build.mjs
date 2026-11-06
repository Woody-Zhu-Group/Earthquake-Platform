// Copies the website (and shared/regions.json) into ../docs, the GitHub Pages entrypoint.
// docs/data/ holds detector results and is never touched. `--check` verifies docs/ is current without writing (CI).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "..", "docs");
// [source, destination relative to docs/]
const entries = [[join(root, "index.html"), "index.html"], [join(root, "src"), "src"], [join(root, "..", "shared", "regions.json"), "regions.json"]];
const check = process.argv.includes("--check");

const list = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? list(join(dir, d.name)) : [join(dir, d.name)]));
const filesOf = ([src, dest]) =>
  (statSync(src).isDirectory() ? list(src) : [src]).map((f) => [f, join(dest, statSync(src).isDirectory() ? relative(src, f) : "")]);

if (check) {
  const stale = [];
  for (const entry of entries) {
    for (const [file, dest] of filesOf(entry)) {
      const target = join(docs, dest);
      if (!existsSync(target) || !readFileSync(file).equals(readFileSync(target))) stale.push(dest);
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
  for (const [src, dest] of entries) cpSync(src, join(docs, dest), { recursive: true });
  writeFileSync(join(docs, ".nojekyll"), "");
  console.log(`Built website into ${relative(process.cwd(), docs) || "docs"}`);
}
