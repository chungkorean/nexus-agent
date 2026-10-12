// Windows 실행 파일 Nexus.exe를 만든다(apps/launcher의 Go 런처). Go 1.22 이상이 필요하다.
// 아이콘·매니페스트 리소스(rsrc_windows_amd64.syso)는 저장소에 들어 있어서,
// 아이콘을 바꿀 때만 rsrc가 필요하다: go install github.com/akavel/rsrc@v0.10.2
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "apps", "launcher");
const syso = path.join(dir, "rsrc_windows_amd64.syso");
const out = path.join(root, "Nexus.exe");

const newer = (a, b) => statSync(a).mtimeMs > statSync(b).mtimeMs;
const icon = path.join(dir, "nexus.ico");
const manifest = path.join(dir, "nexus.manifest");
if (!existsSync(syso) || newer(icon, syso) || newer(manifest, syso)) {
  execFileSync("rsrc", ["-arch", "amd64", "-ico", icon, "-manifest", manifest, "-o", syso], { stdio: "inherit" });
}

execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w -H=windowsgui", "-o", out, "."], {
  cwd: dir,
  stdio: "inherit",
  env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
});
console.log("실행 파일 빌드 완료:", path.relative(root, out), `(${(statSync(out).size / 1e6).toFixed(1)}MB)`);
