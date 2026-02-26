import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");

const adjectives: string[] = JSON.parse(
  readFileSync(join(dataDir, "adjectives.json"), "utf-8")
);
const animals: string[] = JSON.parse(
  readFileSync(join(dataDir, "animals.json"), "utf-8")
);

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateName(existingNames: Set<string>): string {
  // Try random combos first
  for (let i = 0; i < 100; i++) {
    const name = `${pick(adjectives)}-${pick(animals)}`;
    if (!existingNames.has(name)) return name;
  }
  // Fallback: append a number
  for (let n = 2; n < 1000; n++) {
    const name = `${pick(adjectives)}-${pick(animals)}-${n}`;
    if (!existingNames.has(name)) return name;
  }
  throw new Error("Could not generate a unique name");
}
