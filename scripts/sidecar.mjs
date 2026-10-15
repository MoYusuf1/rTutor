// Builds rtutor-mcp (the small tool server agents start) and puts it where Tauri bundles it next to the app:
// src-tauri/binaries/rtutor-mcp-<target triple>. Tauri runs this before every build (beforeBuildCommand).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))[1];
const debug = process.env.TAURI_ENV_DEBUG === "true";
const exe = triple.includes("windows") ? ".exe" : "";
execFileSync("cargo", ["build", "-p", "rtutor-mcp", "--locked", "--target", triple, ...(debug ? [] : ["--release"])], { cwd: "src-tauri", stdio: "inherit" });
mkdirSync("src-tauri/binaries", { recursive: true });
copyFileSync(`src-tauri/target/${triple}/${debug ? "debug" : "release"}/rtutor-mcp${exe}`, `src-tauri/binaries/rtutor-mcp-${triple}${exe}`);
console.log(`rtutor-mcp for ${triple} ready`);
