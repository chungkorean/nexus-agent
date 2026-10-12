import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error 자바스크립트 스크립트라 타입이 없다
import { binPath, compareVersions, newestInstall, prune } from "../../scripts/paperclip-run.mjs";

function fakeInstall(root: string, version: string, ready = true) {
  const dir = path.join(root, version, "node_modules", "paperclipai");
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "paperclipai", bin: { paperclipai: "dist/index.js" } }));
  if (ready) writeFileSync(path.join(root, version, ".nexus-ready"), "x");
}

describe("Paperclip 로컬 설치", () => {
  it("버전을 숫자로 비교한다", () => {
    expect(compareVersions("2026.1005.0", "2026.916.1")).toBeGreaterThan(0);
    expect(compareVersions("2026.916.1", "2026.1005.0")).toBeLessThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });

  it("설치를 끝낸 가장 새 버전을 고르고, 덜 받은 폴더는 쓰지 않는다", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pc-"));
    expect(newestInstall(root)).toBeNull();
    fakeInstall(root, "2026.916.1");
    fakeInstall(root, "2026.1005.0");
    fakeInstall(root, "2026.1101.0", false); // 받다가 끊긴 것
    expect(newestInstall(root)).toBe("2026.1005.0");
    expect(binPath(root, "2026.1005.0")).toBe(path.join(root, "2026.1005.0", "node_modules", "paperclipai", "dist", "index.js"));
    prune(root, ["2026.1005.0"]);
    expect(existsSync(path.join(root, "2026.916.1"))).toBe(false);
    expect(existsSync(path.join(root, "2026.1101.0"))).toBe(false);
    expect(newestInstall(root)).toBe("2026.1005.0");
  });
});
