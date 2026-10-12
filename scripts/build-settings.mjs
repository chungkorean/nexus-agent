// 쉬운 설정 화면(apps/nexus-server)을 한 파일로 묶는다.
// 결과: apps/nexus-server/dist/main.mjs, dist/public/, apps/nexus-server/config/(기본 설정)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const app = path.join(root, "apps", "nexus-server");
rmSync(path.join(app, "dist"), { recursive: true, force: true });

await build({
  entryPoints: [path.join(app, "src", "main.ts")],
  outfile: path.join(app, "dist", "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // cross-spawn 같은 CommonJS 패키지가 require를 쓸 수 있게 한다.
  banner: { js: "import { createRequire as __nexusCreateRequire } from 'node:module'; const require = __nexusCreateRequire(import.meta.url);" },
  logLevel: "warning",
});

cpSync(path.join(app, "public"), path.join(app, "dist", "public"), { recursive: true });
// 트레이 실행기가 git pull 뒤에도 예전 서버가 떠 있는지 알아볼 수 있게 커밋을 남긴다.
let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {}
writeFileSync(path.join(app, "dist", "build.json"), JSON.stringify({ commit, builtAt: new Date().toISOString() }));
rmSync(path.join(app, "config"), { recursive: true, force: true });
cpSync(path.join(root, "config"), path.join(app, "config"), { recursive: true });
console.log("설정 화면 빌드 완료:", path.relative(root, path.join(app, "dist")));
