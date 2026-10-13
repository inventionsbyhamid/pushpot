// Regenerates src/lib/abi.ts from the Foundry build. Run after changing the contract.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = JSON.parse(
  await readFile(join(root, "..", "contracts", "out", "PushPot.sol", "PushPot.json"), "utf8"),
);
const source = `export const pushPotAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`;
await writeFile(join(root, "src", "lib", "abi.ts"), source);
