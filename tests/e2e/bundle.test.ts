import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// pnpm build로 만든 묶음 파일을 Paperclip처럼 불러와 계약(createServerAdapter)을 확인한다.
const pkg = path.resolve(import.meta.dirname, "../../packages/paperclip-adapter");
const FAKES = path.resolve(import.meta.dirname, "../fakes");

beforeAll(() => {
  execFileSync(process.execPath, [path.resolve(import.meta.dirname, "../../scripts/build-adapter.mjs")], { stdio: "ignore" });
});

describe("빌드된 어댑터 패키지", () => {
  it("루트와 ./server 진입점이 Paperclip 외부 어댑터 계약을 따른다", async () => {
    const root = await import(pathToFileURL(path.join(pkg, "dist", "index.js")).href);
    expect(root.type).toBe("nexus_dispatch");
    expect(typeof root.agentConfigurationDoc).toBe("string");
    expect(root.models[0].id).toBe("auto");
    const server = await import(pathToFileURL(path.join(pkg, "dist", "server", "index.js")).href);
    const adapter = server.createServerAdapter();
    expect(adapter.type).toBe("nexus_dispatch");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.testEnvironment).toBe("function");
    // Paperclip 화면이 설정 입력칸을 그릴 수 있게 작업 폴더 칸을 알려 준다
    const schema = await adapter.getConfigSchema();
    expect(schema.fields.find((f: { key: string }) => f.key === "cwd")).toMatchObject({ required: true, type: "text" });
  });

  it("사용자 설정 폴더가 없으면 패키지에 든 기본 설정으로 점검을 통과한다", async () => {
    const server = await import(pathToFileURL(path.join(pkg, "dist", "server", "index.js")).href);
    const cwd = mkdtempSync(path.join(os.tmpdir(), "nexus-bundle-"));
    const res = await server.createServerAdapter().testEnvironment({
      companyId: "co",
      adapterType: "nexus_dispatch",
      config: {
        cwd,
        configDir: path.join(cwd, "no-such-config"),
        nonCodingAgentId: "agent-hermes",
        opencodeCommand: [process.execPath, path.join(FAKES, "fake-opencode.mjs")],
        claudeCommand: [process.execPath, path.join(FAKES, "fake-claude.mjs")],
      },
    });
    expect(existsSync(path.join(pkg, "config", "models.yaml"))).toBe(true);
    expect(res.checks.find((c: { code: string }) => c.code === "config_ok")).toBeTruthy();
    expect(res.status).toBe("pass");
  });
});
