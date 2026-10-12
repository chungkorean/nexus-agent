// Paperclip을 켠다. 트레이 실행기가 부른다: node scripts/paperclip-run.mjs [paperclip 인자...] (기본 run)
//
// 예전에는 켤 때마다 'npx --yes paperclipai@latest run'을 돌려서, 켤 때마다 npm 저장소에 최신 버전을 묻고
// 새 버전이 나와 있으면 그 자리에서 통째로 내려받느라 켜는 데 몇 분씩 걸릴 때가 있었다.
// 이제는 %LOCALAPPDATA%\Nexus\paperclip\<버전> 에 한 번 설치해 두고 바로 켠다.
// 새 버전은 Paperclip이 켜진 뒤 뒤에서 다른 폴더에 받아 두었다가 다음에 켤 때 쓴다(켜는 시간에 영향 없음).
import { exec, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PKG = "paperclipai";
const READY = ".nexus-ready";

export function defaultRoot(env = process.env) {
  const base = env.NEXUS_HOME || (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Nexus") : path.join(os.homedir(), ".nexus"));
  return path.join(base, "paperclip");
}

// 2026.1005.0 같은 버전을 비교한다(정식 버전만 쓴다).
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// 설치를 끝낸(표시 파일이 있는) 버전 폴더 중 가장 새 것
export function newestInstall(root) {
  if (!existsSync(root)) return null;
  const done = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+(\.\d+)*$/.test(d.name) && existsSync(path.join(root, d.name, READY)))
    .map((d) => d.name)
    .sort(compareVersions);
  return done.length ? done[done.length - 1] : null;
}

// 설치된 paperclipai의 실행 파일(js) 경로
export function binPath(root, version) {
  const dir = path.join(root, version, "node_modules", PKG);
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[PKG] ?? Object.values(pkg.bin ?? {})[0];
  return path.join(dir, bin);
}

// npm 저장소에 올라온 최신 정식 버전. 알 수 없으면 null.
// Windows에서 npm은 npm.cmd라서 셸로 돌린다(인자는 고정 값뿐).
export function latestVersion() {
  return new Promise((resolve) => {
    exec(`npm view ${PKG} version`, { timeout: 30_000, encoding: "utf8" }, (err, stdout) => {
      const v = String(stdout || "").trim().split(/\s+/).pop();
      resolve(!err && /^\d+(\.\d+)*$/.test(v ?? "") ? v : null);
    });
  });
}

// 버전 폴더 하나에 설치한다. 끝까지 설치되면 표시 파일을 남긴다. 성공하면 true.
// 뒤에서 받을 때(quiet)는 Paperclip을 막지 않게 기다리지 않고 돌린다.
export async function install(root, version, { quiet = false } = {}) {
  const dir = path.join(root, version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "nexus-paperclip", private: true }) + "\n");
  const code = await new Promise((resolve) => {
    const child = spawn(`npm install ${PKG}@${version} --no-audit --no-fund --loglevel=error`, {
      shell: true,
      cwd: dir,
      stdio: quiet ? "ignore" : "inherit",
    });
    child.on("error", () => resolve(1));
    child.on("exit", (c) => resolve(c ?? 1));
  });
  if (code !== 0) return false;
  writeFileSync(path.join(dir, READY), new Date().toISOString() + "\n");
  return true;
}

// 쓰지 않는 예전 버전 폴더를 지운다(지금 켠 버전과 가장 새 버전은 남긴다).
export function prune(root, keep) {
  if (!existsSync(root)) return;
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || keep.includes(d.name)) continue;
    try { rmSync(path.join(root, d.name), { recursive: true, force: true }); } catch {}
  }
}

function writeStatus(root, text) {
  try { mkdirSync(root, { recursive: true }); writeFileSync(path.join(root, "status.txt"), text + "\n"); } catch {}
}

async function main() {
  const root = defaultRoot();
  const args = process.argv.slice(2);
  let version = newestInstall(root);
  if (!version) {
    // 처음 한 번만: 최신 버전을 받아 설치한다.
    writeStatus(root, "installing");
    const latest = await latestVersion();
    if (!latest) {
      console.error("[nexus] Paperclip 최신 버전을 알아내지 못했어요. 인터넷 연결을 확인해 주세요. npx로 대신 켭니다.");
      writeStatus(root, "npx");
      const child = spawn("npx --yes paperclipai@latest " + (args.length ? args.join(" ") : "run"), { shell: true, stdio: "inherit" });
      child.on("exit", (code) => process.exit(code ?? 1));
      return;
    }
    console.log(`[nexus] Paperclip ${latest} 을(를) 처음 설치하는 중이에요. 몇 분 걸릴 수 있어요.`);
    if (!(await install(root, latest))) {
      console.error("[nexus] Paperclip을 설치하지 못했어요. 위 오류를 확인해 주세요.");
      writeStatus(root, "failed");
      process.exit(1);
    }
    version = latest;
  }
  writeStatus(root, "starting " + version);
  console.log(`[nexus] Paperclip ${version} 을(를) 켭니다.`);
  const child = spawn(process.execPath, [binPath(root, version), ...(args.length ? args : ["run"])], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));

  // 켜진 뒤 잠깐 기다렸다가 새 버전이 있는지 보고, 있으면 다른 폴더에 받아 둔다(다음에 켤 때 씀).
  if (process.env.NEXUS_PAPERCLIP_NO_UPDATE === "1") return;
  setTimeout(async () => {
    const latest = await latestVersion();
    if (latest && compareVersions(latest, version) > 0) {
      console.log(`[nexus] Paperclip 새 버전 ${latest} 을(를) 뒤에서 받아 둡니다. 다음에 켤 때부터 써요.`);
      if (await install(root, latest, { quiet: true })) prune(root, [version, latest]);
    } else {
      prune(root, [version]);
    }
  }, 60_000);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
