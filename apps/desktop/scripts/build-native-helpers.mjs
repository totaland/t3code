import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");

if (process.platform !== "darwin") {
  process.exit(0);
}

const sourcePath = resolve(desktopDir, "native/macos-push-to-talk-helper.swift");
const outputPath = resolve(desktopDir, "resources/native/t3code-push-to-talk-helper");

mkdirSync(dirname(outputPath), { recursive: true });

const result = spawnSync("xcrun", ["swiftc", sourcePath, "-O", "-o", outputPath], {
  cwd: desktopDir,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
