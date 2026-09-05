import {constants} from "node:fs";
import {access, stat} from "node:fs/promises";
import path from "node:path";
import type {PluginContext} from "telebox/sdk";

// -E retains user site installations but ignores PYTHON* settings. Exclude the
// implicit current directory before importing modules, for both probe and request.
const prelude = `
import sys
sys.path = [entry for entry in sys.path if entry]
import json
`;

// Embedded source is bundled with the plugin; no helper asset or installation step is required.
const script = prelude + `
from curl_cffi import requests

payload = json.load(sys.stdin)
headers = {key: value for key, value in payload["headers"].items() if key.lower() != "user-agent"}
response = requests.post(
    payload["url"], headers=headers, json={}, impersonate="chrome",
    timeout=25, allow_redirects=False, stream=True,
)
try:
    body = bytearray()
    for chunk in response.iter_content(chunk_size=8192):
        if len(chunk) > 65536 - len(body):
            raise ValueError("Response exceeds byte limit")
        body.extend(chunk)
    json.dump({"status": response.status_code, "server": response.headers.get("server", ""),
               "text": body.decode("utf-8", errors="replace")}, sys.stdout)
finally:
    response.close()
`;

const probeScript = prelude + `
try:
    from curl_cffi import requests
except ModuleNotFoundError as error:
    state = "unavailable" if error.name == "curl_cffi" else "failed"
except Exception:
    state = "failed"
else:
    state = "available"
json.dump({"state": state}, sys.stdout)
`;

class PythonUnavailable extends Error {}

export function validatePythonPath(value: unknown): void {
  if (typeof value !== "string" || (value !== "" && !path.isAbsolute(value)) || value.includes("\0")) {
    throw new Error("Python path must be absolute");
  }
}

async function python(ctx: PluginContext, configured: unknown, signal: AbortSignal): Promise<string> {
  return ctx.tasks.run("nodeseek:python-path", async scopeSignal => {
    const check = () => { scopeSignal.throwIfAborted(); signal.throwIfAborted(); };
    check();
    if (configured !== undefined && configured !== "") {
      validatePythonPath(configured);
      return configured as string;
    }
    const exists = async (candidate: string): Promise<boolean> => {
      check();
      try {
        await access(candidate, constants.X_OK);
        const info = await stat(candidate);
        check();
        return info.isFile();
      } catch (error) {
        check();
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (!["ENOENT", "EACCES", "ENOTDIR"].includes(String(code))) throw error;
        return false;
      }
    };
    // dataPath is resolution-only: checking an absent legacy venv never creates data directories.
    const legacy = process.platform === "win32" ?
      ["curl_cffi_venv/Scripts/python.exe", "curl_cffi_venv/bin/python"] : ["curl_cffi_venv/bin/python"];
    for (const relative of legacy) {
      const candidate = ctx.files.dataPath(relative);
      if (await exists(candidate)) return candidate;
    }
    // Resolve executable metadata only for a requested probe or WAF fallback.
    for (const directory of (process.env.PATH || "").split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      for (const name of process.platform === "win32" ? ["python3.exe", "python.exe"] : ["python3", "python"]) {
        const candidate = path.join(directory, name);
        if (await exists(candidate)) return candidate;
      }
    }
    throw new PythonUnavailable("Python executable unavailable");
  });
}

export async function probeCurlCffi(ctx: PluginContext, signal: AbortSignal): Promise<string> {
  try {
    const config = await ctx.storage.json<Record<string, unknown>>("config.json", {}).read(signal);
    const executable = await python(ctx, config.pythonPath, signal);
    signal.throwIfAborted();
    const output = await ctx.processes.run(executable, ["-E", "-c", probeScript], {
      signal, timeoutMs: 5000, maxOutputBytes: 4096,
    });
    signal.throwIfAborted();
    if (output.exitCode !== 0 || output.stdout.byteLength + output.stderr.byteLength > 4096) throw new Error("Invalid probe result");
    const result: unknown = JSON.parse(output.stdout.toString("utf8"));
    if (result && typeof result === "object" && "state" in result) {
      if (result.state === "available") return "可用（仅本地依赖导入检查）";
      if (result.state === "unavailable") return "不可用（未安装 curl_cffi）";
    }
    throw new Error("Dependency check failed");
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof PythonUnavailable || (error instanceof Error && "code" in error && error.code === "SPAWN_FAILED")) {
      return "不可用（Python 不可执行）";
    }
    ctx.log.error("nodeseek.probe.failed");
    return "检查失败";
  }
}

export async function curlCffi(ctx: PluginContext, url: string, headers: Record<string, string>, signal: AbortSignal) {
  const config = await ctx.storage.json<Record<string, unknown>>("config.json", {}).read(signal);
  const executable = await python(ctx, config.pythonPath, signal);
  signal.throwIfAborted();
  const output = await ctx.processes.run(executable, ["-E", "-c", script], {
    input: JSON.stringify({url, headers}), signal, timeoutMs: 30000, maxOutputBytes: 1024 * 1024,
  });
  signal.throwIfAborted();
  if (output.exitCode !== 0 || output.stdout.byteLength + output.stderr.byteLength > 1024 * 1024) {
    throw new Error("Invalid curl_cffi process result");
  }
  const parsed: unknown = JSON.parse(output.stdout.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid curl_cffi response");
  const result = parsed as Record<string, unknown>;
  if (!Number.isInteger(result.status) || Number(result.status) < 100 || Number(result.status) > 599 ||
      typeof result.server !== "string" || typeof result.text !== "string" || Buffer.byteLength(result.text) > 65536) {
    throw new Error("Invalid curl_cffi response");
  }
  return {status: result.status as number, server: result.server, body: result.text};
}
