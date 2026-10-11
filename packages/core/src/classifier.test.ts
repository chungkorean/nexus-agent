import { describe, expect, it } from "vitest";
import { classify } from "./classifier.ts";

const opts = { defaultWhenUnsure: "execute" as const };

describe("classify", () => {
  it("기획서 시나리오: 키오스크 결제 데이터 분석은 실행 작업(ops)으로 본다", () => {
    const c = classify({ title: "스터디카페 지난주 시간대별 키오스크 결제 데이터를 분석해 줘", description: "엑셀 파일을 파이썬 스크립트로 파싱해서 정리" }, opts);
    expect(c.decision).toBe("execute");
    expect(c.taskType).toBe("ops");
  });

  it("기획서 시나리오: APK 디컴파일은 실행 작업으로 본다", () => {
    const c = classify({ title: "app.apk 디컴파일하고 핵심 구조 요약", description: "JADX로 분석" }, opts);
    expect(c.decision).toBe("execute");
  });

  it("기획서 시나리오: 웹툰 세계관 기획은 비코딩으로 넘긴다", () => {
    const c = classify({ title: "어반 판타지 세계관과 주요 캐릭터 설정 검수", description: "스토리 설정 충돌을 찾아 교정" }, opts);
    expect(c.decision).toBe("delegate");
  });

  it("홍보 문구 작성은 비코딩", () => {
    expect(classify({ title: "새 요금제 홍보 문구 세 가지 써 줘" }, opts).decision).toBe("delegate");
  });

  it("라벨이 키워드보다 우선한다", () => {
    const c = classify({ title: "세계관 데이터를 JSON으로 만드는 스크립트", labels: ["비코딩"] }, opts);
    expect(c.decision).toBe("delegate");
    expect(c.reasons[0]).toContain("라벨");
    expect(classify({ title: "홍보 문구", labels: ["Code"] }, opts).decision).toBe("execute");
  });

  it("신호가 없으면 기본값을 따른다", () => {
    expect(classify({ title: "이거 좀 부탁해" }, opts).decision).toBe("execute");
    expect(classify({ title: "이거 좀 부탁해" }, { defaultWhenUnsure: "delegate" }).decision).toBe("delegate");
  });

  it("코드 블록과 파일 이름은 강한 실행 신호", () => {
    expect(classify({ title: "이 부분 고쳐 줘", description: "```\nfoo()\n```" }, opts).decision).toBe("execute");
    expect(classify({ title: "src/app.ts 마케팅 문구 위치 변경" }, opts).decision).toBe("execute");
  });

  it("작업 종류와 위험도를 판정한다", () => {
    expect(classify({ title: "로그인 모듈 리팩터링" }, opts)).toMatchObject({ taskType: "refactor", risk: "high" });
    expect(classify({ title: "결제 함수에 단위 테스트 추가" }, opts)).toMatchObject({ taskType: "test", risk: "high" });
    expect(classify({ title: "버그 수정: 목록이 비어 보임" }, opts)).toMatchObject({ taskType: "implement", risk: "low" });
    expect(classify({ title: "Fix the README typo" }, opts).taskType).toBe("docs");
  });
});
