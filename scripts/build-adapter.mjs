// Paperclip이 그대로 불러올 수 있도록 어댑터를 의존성까지 묶어 dist/에 만든다.
// 결과: packages/paperclip-adapter/dist/index.js, dist/server/index.js, config/(기본 설정)
import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = path.join(root, "packages", "paperclip-adapter");
rmSync(path.join(pkg, "dist"), { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // cross-spawn 같은 CommonJS 패키지가 require를 쓸 수 있게 한다.
  banner: { js: "import { createRequire as __nexusCreateRequire } from 'node:module'; const require = __nexusCreateRequire(import.meta.url);" },
  logLevel: "info",
};

await build({ ...common, entryPoints: [path.join(pkg, "src", "index.ts")], outfile: path.join(pkg, "dist", "index.js") });
await build({ ...common, entryPoints: [path.join(pkg, "src", "server", "index.ts")], outfile: path.join(pkg, "dist", "server", "index.js") });

rmSync(path.join(pkg, "config"), { recursive: true, force: true });
cpSync(path.join(root, "config"), path.join(pkg, "config"), { recursive: true });
console.log("어댑터 빌드 완료:", path.relative(root, path.join(pkg, "dist")));
