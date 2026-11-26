import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function resolveCodeToolEntry(): string {
  const candidates = [
    path.join(
      os.homedir(),
      ".local/share/pi-local-extensions/node_modules/pi-code-tool/dist/pi/extension.js",
    ),
    path.join(
      process.cwd(),
      "node_modules/pi-code-tool/dist/pi/extension.js",
    ),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  throw new Error(
    "pi-code-tool is not installed. Run ./scripts/install-local-extensions.sh first.",
  );
}

export default async function localCodeToolExtension(pi: ExtensionAPI): Promise<void> {
  const entryHref = pathToFileURL(resolveCodeToolEntry()).href;
  const mod = (await import(entryHref)) as {
    createPythonExtension: (opts: Record<string, unknown>) => (api: ExtensionAPI) => Promise<void>;
  };
  const init = mod.createPythonExtension({
    toolName: "code",
    root: process.cwd(),
    mountWorkspace: true,
    bridgePiTools: true,
    noBuiltins: true,
    toolStore: false,
    autoApprove: true,
    typeCheck: true,
    limits: {
      maxDurationSecs: 10,
      maxMemory: 128 * 1024 * 1024,
    },
  });
  await init(pi);
}
