// Self-hosts the MediaPipe runtime and pose model so the app never loads them from a CDN.
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "mediapipe");

const MODEL = {
  file: "pose_landmarker_lite.task",
  url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  sha256: "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a",
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

await mkdir(join(outDir, "wasm"), { recursive: true });
await cp(join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm"), join(outDir, "wasm"), {
  recursive: true,
});

const modelPath = join(outDir, MODEL.file);
if (!(await exists(modelPath)) || sha256(await readFile(modelPath)) !== MODEL.sha256) {
  const res = await fetch(MODEL.url);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== MODEL.sha256) throw new Error("model checksum mismatch");
  await writeFile(modelPath, buf);
  console.log(`downloaded ${MODEL.file}`);
}
