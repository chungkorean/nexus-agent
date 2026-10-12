// Nexus가 Paperclip 화면에 넣는 스크립트: 왼쪽 메뉴에 한국어 이름을 붙이고,
// 작은 ? 아이콘에 마우스를 올리면 그 메뉴가 무엇인지 알려 준다.
// Paperclip의 글자는 그대로 두고 옆에 덧붙이기만 한다.
(() => {
  "use strict";
  if (window.__nexusKo) return;
  window.__nexusKo = true;

  // 메뉴 이름: [한국어, 설명]
  const MENU = {
    "New Task": ["새 작업", "새 이슈(할 일)를 만들어 에이전트에게 맡겨요. Nexus 스튜디오의 입력칸과 같은 일을 해요."],
    "Search": ["검색", "이슈, 프로젝트, 에이전트를 이름이나 내용으로 찾아요."],
    "Dashboard": ["대시보드", "회사 전체 현황이에요. 지금 돌고 있는 에이전트, 진행 중인 일, 최근 비용을 한눈에 봐요."],
    "Inbox": ["받은 편지함", "내가 확인해야 할 것만 모아요. 에이전트의 질문, 승인 요청, 실패한 실행이 여기에 와요."],
    "Chat": ["채팅", "에이전트와 직접 대화해요. 이슈를 만들지 않고 짧게 묻고 답할 때 써요."],
    "Conference Room": ["회의실", "여러 에이전트와 한 대화방에서 함께 이야기해요."],
    "Decisions": ["결정 사항", "에이전트가 사람의 결정을 기다리는 일과 지금까지 내린 결정을 모아요."],
    "Tasks": ["작업(이슈)", "모든 이슈 목록이에요. 상태별로 걸러 보고, 누구에게 맡겼는지와 진행 상황을 확인해요."],
    "Projects": ["프로젝트", "이슈를 묶는 큰 단위예요. 프로젝트마다 작업 폴더와 목표를 정해요."],
    "Routines": ["반복 작업", "정해진 시간마다 저절로 만들어지는 이슈예요. 예: 매일 아침 오류 기록 점검."],
    "Pipelines": ["파이프라인", "여러 단계를 차례로 거치는 작업 흐름이에요. 한 단계가 끝나면 다음 에이전트가 이어받아요."],
    "Goals": ["목표", "회사와 프로젝트의 목표예요. 이슈를 목표에 연결하면 왜 하는 일인지 에이전트가 알아요."],
    "Artifacts": ["결과물", "에이전트가 만든 문서, 파일 같은 결과물을 모아 봐요."],
    "Cases": ["케이스", "고객 문의처럼 바깥에서 들어온 일을 다루는 곳이에요(시험 기능)."],
    "Workspaces": ["작업 공간", "에이전트가 실제로 코드를 고치는 폴더(작업 공간)를 관리해요."],
    "Agents": ["에이전트", "일하는 AI 직원 목록이에요. Nexus 에이전트도 여기 있어요. 눌러서 지시문, 예산, 실행 기록을 봐요."],
    "Skills": ["스킬", "에이전트가 쓸 수 있는 기술 묶음(사용법 문서와 도구)을 관리해요."],
    "Connectors": ["연결 앱", "Slack, Gmail 같은 바깥 서비스를 연결해 에이전트가 쓰게 해요."],
    "Browse": ["앱 둘러보기", "연결할 수 있는 앱을 찾아봐요."],
    "Connections": ["연결된 앱", "이미 연결한 앱과 계정을 봐요."],
    "Review": ["검토", "앱이 보내려는 내용을 사람이 먼저 확인하고 허락해요."],
    "Audit": ["감사 기록", "누가 언제 무엇을 했는지 모든 기록을 봐요."],
    "Org": ["조직도", "에이전트들의 상하 관계(누가 누구에게 보고하는지)를 그림으로 봐요."],
    "Timeline": ["타임라인", "시간 순서로 회사에서 일어난 일을 봐요."],
    "Costs": ["비용", "에이전트와 모델별로 쓴 돈을 봐요. Nexus의 구독 계정 사용분은 Nexus 설정 화면에서 더 자세히 봐요."],
    "Activity": ["활동 기록", "에이전트 실행, 이슈 변경 같은 최근 활동을 봐요."],
    "Status": ["상태", "Paperclip 서버와 연결 상태를 확인해요."],
    "Settings": ["설정", "회사 이름, 구성원, 비밀 값 같은 회사 설정을 바꿔요."],
    "General": ["일반", "회사 이름과 기본 정보를 바꿔요."],
    "Members": ["구성원", "이 회사를 함께 쓰는 사람을 관리해요."],
    "Invites": ["초대", "다른 사람을 초대하는 링크를 만들어요."],
    "Secrets": ["비밀 값", "API 키처럼 에이전트에게 몰래 넘길 값을 저장해요."],
    "Export": ["내보내기", "회사 설정과 에이전트를 파일로 내보내요."],
    "Import": ["가져오기", "내보낸 파일로 회사를 다시 만들어요."],
    "Back to app": ["돌아가기", "설정을 닫고 대시보드로 돌아가요."],
    "Profile": ["프로필", "내 이름과 표시 방식을 바꿔요."],
    "Access": ["접근 권한", "누가 이 Paperclip에 들어올 수 있는지 정해요."],
    "Adapters": ["어댑터", "에이전트가 일하는 방식(Claude Code, Nexus 같은 어댑터)을 관리해요."],
    "Environments": ["실행 환경", "에이전트가 돌아가는 환경을 정해요."],
    "Heartbeats": ["하트비트", "에이전트가 스스로 깨어나 할 일을 확인하는 주기를 정해요."],
    "Plugins": ["플러그인", "Paperclip에 기능을 더하는 플러그인을 관리해요."],
    "Experimental": ["실험 기능", "아직 시험 중인 기능을 켜고 꺼요."],
  };
  // 묶음 제목
  const SECTION = { "Work": "작업", "Projects": "프로젝트", "Org": "조직", "Organization": "조직", "Company": "회사", "Agents": "에이전트", "Recent Tasks": "최근 작업" };

  const css = document.createElement("style");
  css.textContent = `
.nx-ko { margin-left: .35em; font-size: .86em; opacity: .62; font-weight: 500; text-transform: none; letter-spacing: 0; font-family: "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif; }
.nx-help { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; margin-left: auto; border-radius: 50%; border: 1px solid currentColor; font: 600 10px/1 system-ui, sans-serif; opacity: .35; cursor: help; }
.nx-help:hover, .nx-help:focus-visible { opacity: 1; outline: none; }
a:hover > .nx-help, button:hover > .nx-help { opacity: .7; }
.nx-tip { position: fixed; z-index: 2147483647; max-width: 260px; padding: 8px 11px; border-radius: 8px; background: #1f2430; color: #fff; font: 13px/1.5 "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.25); pointer-events: none; display: none; }
.nx-tip b { display: block; margin-bottom: 2px; }
`;
  document.head.append(css);

  const tip = document.createElement("div");
  tip.className = "nx-tip";
  tip.setAttribute("role", "tooltip");
  document.body.append(tip);

  function showTip(icon) {
    const item = MENU[icon.dataset.key];
    if (!item) return;
    tip.replaceChildren();
    const title = document.createElement("b");
    title.textContent = `${item[0]} (${icon.dataset.key})`;
    tip.append(title, item[1]);
    tip.style.display = "block";
    const r = icon.getBoundingClientRect();
    const left = Math.min(r.right + 10, window.innerWidth - tip.offsetWidth - 8);
    const top = Math.max(8, Math.min(r.top + r.height / 2 - tip.offsetHeight / 2, window.innerHeight - tip.offsetHeight - 8));
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${top}px`;
  }
  const hideTip = () => { tip.style.display = "none"; };
  const isHelp = (t) => t instanceof Element && t.classList.contains("nx-help");
  document.addEventListener("mouseover", (e) => { if (isHelp(e.target)) showTip(e.target); });
  document.addEventListener("mouseout", (e) => { if (isHelp(e.target)) hideTip(); });
  document.addEventListener("focusin", (e) => { if (isHelp(e.target)) showTip(e.target); });
  document.addEventListener("focusout", (e) => { if (isHelp(e.target)) hideTip(); });
  // ?를 눌러도 메뉴로 이동하지 않게 한다.
  document.addEventListener("click", (e) => { if (isHelp(e.target)) { e.preventDefault(); e.stopPropagation(); showTip(e.target); } }, true);
  window.addEventListener("scroll", hideTip, true);

  function apply() {
    for (const aside of document.querySelectorAll("aside")) {
      const walker = document.createTreeWalker(aside, NodeFilter.SHOW_TEXT);
      const found = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const key = n.nodeValue.trim();
        if (key && (MENU[key] || SECTION[key])) found.push([n, key]);
      }
      for (const [text, key] of found) {
        const label = text.parentElement;
        if (!label || label.closest(".nx-ko, .nx-help")) continue;
        // 묶음 제목(대문자 작은 글씨)은 접는 버튼 안에 있어도 제목으로 본다.
        const control = label.classList.contains("uppercase") ? null : label.closest("a, button");
        const ko = control ? MENU[key]?.[0] : SECTION[key] ?? MENU[key]?.[0];
        if (!ko) continue;
        if (!label.querySelector(":scope > .nx-ko")) {
          const span = document.createElement("span");
          span.className = "nx-ko";
          span.textContent = ko;
          label.append(span);
        }
        if (!control || !MENU[key]) continue;
        // 사이드바를 접어 이름이 숨겨지면 ?도 숨긴다.
        const hidden = label.getBoundingClientRect().width < 2;
        let help = control.querySelector(":scope > .nx-help");
        if (!help && !hidden) {
          help = document.createElement("span");
          help.className = "nx-help";
          help.textContent = "?";
          help.tabIndex = 0;
          help.dataset.key = key;
          help.setAttribute("aria-label", `${MENU[key][0]}: ${MENU[key][1]}`);
          control.append(help);
        }
        if (help) help.style.display = hidden ? "none" : "";
      }
    }
  }

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; apply(); });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  schedule();
})();
