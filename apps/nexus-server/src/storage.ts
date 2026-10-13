// "저장 위치" 설명: Nexus가 파일을 어디에 두는지, 지워도 되는지를 화면에 보여 준다.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveDir, defaultWorktreeRoot, nexusHome } from "@nexus/shared";

export type Deletable = "yes" | "careful" | "no";

export interface StorageItem {
  key: string;
  title: string;
  /** 실제 폴더. 작업 폴더처럼 사용자가 정하는 곳은 null */
  path: string | null;
  exists: boolean;
  desc: string;
  deletable: Deletable;
  deleteNote: string;
}

export interface StorageDirs {
  configDir: string;
  stateDir: string;
  accountsDir: string;
}

/** Paperclip이 이슈·댓글(데이터베이스)을 두는 곳. Paperclip 기본값은 사용자 폴더의 .paperclip */
export function paperclipHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAPERCLIP_HOME || path.join(os.homedir(), ".paperclip");
}

export function storageItems(dirs: StorageDirs, env: NodeJS.ProcessEnv = process.env): StorageItem[] {
  const home = nexusHome(env);
  const item = (key: string, title: string, dir: string | null, desc: string, deletable: Deletable, deleteNote: string): StorageItem => ({
    key, title, path: dir, exists: dir ? existsSync(dir) : false, desc, deletable, deleteNote,
  });
  return [
    item("work", "작업 폴더 (최종 결과물)", null,
      "AI가 실제로 파일을 만들고 고치는 곳이에요. Paperclip에서 nexus_dispatch 에이전트를 만들 때 설정의 cwd에 적은 폴더(예: C:\\work\\my-project)이고, 에이전트마다 다르게 정할 수 있어요. git 저장소이면 결과가 nexus/이슈 브랜치에 커밋으로 남고, 확인을 통과하면 지금 브랜치에 합쳐져요.",
      "no", "내 작업물이에요. Nexus가 지우지 않아요."),
    item("archive", "작업 기록 (스튜디오 보관함)", archiveDir(dirs.stateDir),
      "작업이 끝날 때마다 결과 요약(result.md), 원래 요청(issue.md), 실행 정보(run.json), 만든 그림·소리·영상(media)이 모여요. 스튜디오에서 보는 내용이에요.",
      "yes", "지워도 돼요. 스튜디오의 '기록 지우기'와 같고, 작업 폴더의 파일과 Paperclip 이슈는 그대로예요."),
    item("worktrees", "임시 작업 사본", defaultWorktreeRoot(env),
      "작업을 나눠 동시에 실행할 때 하위 작업마다 만드는 git 작업 사본이에요. 작업이 끝나면 저절로 지워져요.",
      "careful", "작업이 돌고 있지 않을 때만 지우세요."),
    item("paperclipData", "Paperclip 데이터 (이슈·댓글)", paperclipHome(env),
      "Paperclip의 회사, 에이전트, 이슈, 댓글이 들어 있는 데이터베이스와 Paperclip 설정이에요.",
      "no", "지우면 Paperclip의 이슈 기록이 모두 사라져요."),
    item("config", "설정 파일", dirs.configDir,
      "models.yaml, routing.yaml, accounts.yaml이 있어요. 이 설정 화면에서 바꾸는 내용이에요.",
      "no", "지우면 설정이 처음 상태로 돌아가요."),
    item("accounts", "AI 계정 로그인 정보", dirs.accountsDir,
      "계정마다 Claude Code·Google 계정 로그인 정보가 들어 있어요.",
      "no", "지우면 AI 계정에 다시 로그인해야 해요."),
    item("state", "프로그램 상태", dirs.stateDir,
      "계정 한도, 사용량, 텔레그램 연결(telegram.json), 음성 비서 설정이 있어요. 작업 기록(archive)도 이 안에 있어요.",
      "no", "archive 말고는 지우지 마세요. 사용량 기록과 텔레그램 연결이 사라져요."),
    item("logs", "기록(로그)", path.join(home, "logs"),
      "켜기·업데이트·앱 창 기록이에요. 문제가 생겼을 때 원인을 찾는 데 써요.",
      "yes", "언제든 지워도 돼요. 새 기록은 다시 쌓여요."),
    item("paperclipApp", "Paperclip 프로그램", path.join(home, "paperclip"),
      "버전별로 설치해 둔 Paperclip 프로그램이에요. 데이터는 들어 있지 않아요.",
      "careful", "가장 새 버전 폴더 말고 예전 버전 폴더는 지워도 돼요. 다 지우면 다음에 켤 때 다시 설치해서 몇 분 걸려요."),
  ];
}

/** 화면에서 고른 항목의 폴더. 정해진 목록에 있는 폴더만 연다. */
export function storagePath(dirs: StorageDirs, key: unknown, env: NodeJS.ProcessEnv = process.env): StorageItem | null {
  return storageItems(dirs, env).find((i) => i.key === key && i.path) ?? null;
}
