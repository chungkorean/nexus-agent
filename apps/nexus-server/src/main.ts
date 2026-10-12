// pnpm settings 로 실행하는 쉬운 설정 화면.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAccountsDir, defaultConfigDir, defaultStateDir } from "@nexus/shared";
import { createSettingsServer } from "./server.ts";

/** 저장소 또는 빌드에 함께 들어 있는 기본 설정 폴더 */
function bundledConfigDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "..", "..", "..", "config"), path.join(here, "..", "config")]) {
    if (existsSync(path.join(candidate, "models.yaml"))) return candidate;
  }
  return undefined;
}

/** packages/paperclip-adapter 폴더 (src/main.ts와 dist/main.mjs 모두 세 단계 위가 저장소) */
function adapterDir(): string | undefined {
  if (process.env.NEXUS_NO_ADAPTER_SYNC === "1") return undefined;
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "paperclip-adapter");
  return existsSync(path.join(dir, "package.json")) ? dir : undefined;
}

function openBrowser(url: string): void {
  if (process.platform !== "win32" || process.env.NEXUS_NO_BROWSER === "1") return;
  try {
    // 빈 제목 "" 이 그대로 넘어가야 하므로 인자를 손대지 않고 넘긴다.
    spawn("cmd", ["/c", "start", '""', url], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
  } catch {
    /* 브라우저를 못 열어도 주소는 화면에 나와 있다 */
  }
}

const port = Number(process.env.NEXUS_SETTINGS_PORT) || 3200;
const configDir = defaultConfigDir();
let settings: ReturnType<typeof createSettingsServer>;
try {
  settings = createSettingsServer({
    configDir,
    fallbackDir: bundledConfigDir(),
    stateDir: defaultStateDir(),
    accountsDir: defaultAccountsDir(),
    port,
    telegram: {},
    // 저장소에서 돌릴 때만(빌드 결과 옆에 어댑터 폴더가 있을 때) Paperclip에 어댑터를 저절로 설치한다.
    adapterDir: adapterDir(),
  });
  const url = await settings.listen();
  console.log("");
  console.log("  Nexus 설정 화면을 열었어요.");
  console.log(`  브라우저에서 이 주소로 들어가세요: ${url}`);
  console.log(`  설정 파일 위치: ${configDir}`);
  console.log("  다 쓰셨으면 이 창을 닫으면 돼요.");
  console.log("");
  openBrowser(url);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`  설정 화면이 이미 켜져 있는 것 같아요. 브라우저에서 ${url} 로 들어가 보세요.`);
    console.log("  다른 프로그램이 이 번호를 쓰고 있다면 NEXUS_SETTINGS_PORT 로 다른 번호를 정해 주세요.");
    openBrowser(url);
    process.exit(0);
  }
  console.error("  설정 화면을 열지 못했어요:", (err as Error).message);
  process.exit(1);
}

const stop = () => {
  void settings!.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
