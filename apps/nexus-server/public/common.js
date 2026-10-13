// Nexus 화면 공통 도우미
"use strict";
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "selected" || k === "disabled" || k === "value") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const opts = body === undefined
    ? { headers: { "X-Nexus": "1" } }
    : { method: "POST", headers: { "Content-Type": "application/json", "X-Nexus": "1" }, body: JSON.stringify(body) };
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    throw { error: "설정 화면 프로그램과 연결이 끊겼어요. 검은 창이 켜져 있는지 확인하고, 꺼져 있으면 다시 실행해 주세요.", problems: [] };
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* 빈 응답 */ }
  if (!res.ok || data.ok === false) throw { error: data.error || "문제가 생겼어요. 잠시 뒤 다시 해 주세요.", problems: data.problems || [] };
  return data;
}

function toast(text, kind) {
  const t = $("toast");
  t.textContent = text;
  t.className = "show " + (kind || "ok");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = ""; }, kind === "bad" ? 7000 : 4500);
}

function notice(kind, title, items) {
  const n = $("notice");
  n.replaceChildren();
  if (!title) { n.className = "notice"; return; }
  n.className = "notice " + kind;
  n.append(h("strong", {}, title));
  if (items && items.length) n.append(h("ul", {}, items.map((x) => h("li", {}, x))));
}

function showError(err) {
  const e = err && err.error ? err : { error: String((err && err.message) || err), problems: [] };
  notice("bad", e.error, e.problems);
  toast(e.error, "bad");
  $("notice").scrollIntoView({ behavior: "smooth", block: "center" });
}

// 대화 상자. 버튼을 누르면 그 버튼의 값으로 끝난다.
function dialog(title, body, buttons) {
  return new Promise((resolve) => {
    const back = $("modalBack");
    const box = $("modal");
    const close = (v) => { back.classList.remove("show"); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    box.replaceChildren(
      h("h3", { id: "modalTitle" }, title),
      body,
      h("div", { class: "modal-buttons" }, buttons.map((b) => h("button", { type: "button", class: b.kind || "", onclick: () => close(b.value) }, b.text))),
    );
    back.classList.add("show");
    back.onclick = (e) => { if (e.target === back) close(null); };
    document.addEventListener("keydown", onKey);
    const focus = box.querySelector("button.primary") || box.querySelector("button");
    if (focus) focus.focus();
  });
}

function formatUntil(iso) {
  const d = new Date(iso);
  const now = new Date();
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return hm;
  return (d.getMonth() + 1) + "월 " + d.getDate() + "일 " + hm;
}

// ---------- 위쪽 메뉴 ----------
const NAV = [["/studio", "스튜디오", "studio"], ["/paperclip", "Paperclip", "paperclip"], ["/voice", "음성 비서", "voice"], ["/", "설정", "settings"]];
function renderNav(active) {
  const nav = h("nav", { class: "topnav", "aria-label": "Nexus 메뉴" },
    h("a", { class: "brand", href: "/studio" }, "Nexus"),
    NAV.map(([href, text, key]) => h("a", { class: "tab", href, "aria-current": key === active ? "page" : false }, text)),
    h("button", { type: "button", class: "storage-q", title: STORAGE_TIP, "aria-label": "저장 위치 설명 보기", onclick: showStorage },
      "저장 위치", h("span", { class: "q", "aria-hidden": "true" }, "?")));
  document.querySelector("main").prepend(nav);
  // 고정된 메뉴 높이만큼 다른 고정 요소(설정의 왼쪽 메뉴)와 바로 가기 위치를 내린다.
  const fit = () => document.documentElement.style.setProperty("--nav-h", nav.offsetHeight + "px");
  fit();
  window.addEventListener("resize", fit);
  const stuck = () => nav.classList.toggle("stuck", window.scrollY > 4);
  window.addEventListener("scroll", stuck, { passive: true });
  stuck();
  // 새 코드를 받았는데 예전 서버가 떠 있으면 알려 준다(화면이 바뀌지 않는 이유).
  api("/api/info").then((i) => {
    if (!i.stale) return;
    nav.after(h("div", { class: "notice warn", role: "status", style: "margin:0 0 10px" },
      "새 버전을 받았지만 아직 예전 화면이에요. 작업 표시줄의 N 아이콘을 오른쪽 클릭해 '모두 다시 시작'을 눌러 주세요."));
  }).catch(() => {});
  return nav;
}

// ---------- 저장 위치 설명 ----------
// 위쪽 메뉴의 "저장 위치 ?"에 마우스를 올리면 짧은 설명이, 누르면 폴더별 경로와 지워도 되는지가 보인다.
const STORAGE_TIP = "최종 결과물은 Paperclip 에이전트에 정한 작업 폴더(cwd)에 저장돼요. 작업 기록·설정·계정·로그는 내 PC의 Nexus 폴더에 있어요. 누르면 폴더별 위치와 지워도 되는지 보여 줘요.";
const DELETABLE = { yes: ["지워도 돼요", "ok"], careful: ["조건부", "warn"], no: ["지우면 안 돼요", "bad"] };

async function showStorage() {
  let back = $("storageBack");
  if (!back) {
    back = h("div", { id: "storageBack", class: "modal-back" }, h("div", { class: "modal storage", role: "dialog", "aria-modal": "true", "aria-labelledby": "storageTitle" }));
    document.body.append(back);
    back.addEventListener("click", (e) => { if (e.target === back) closeStorage(); });
  }
  const box = back.firstChild;
  box.replaceChildren(h("h3", { id: "storageTitle" }, "저장 위치"), h("p", { class: "loading" }, "불러오는 중이에요..."));
  back.classList.add("show");
  document.addEventListener("keydown", storageKey);
  let data;
  try { data = await api("/api/storage"); } catch (e) { box.replaceChildren(h("h3", { id: "storageTitle" }, "저장 위치"), h("p", {}, e.error || "불러오지 못했어요.")); return; }
  const win = data.platform === "win32";
  box.replaceChildren(
    h("h3", { id: "storageTitle" }, "저장 위치"),
    h("p", { class: "help" }, "AI가 만든 최종 결과물은 작업 폴더에, 나머지는 이 PC의 아래 폴더에 저장돼요. 모두 내 컴퓨터에만 있고, GitHub에 올리기를 켰을 때만 결과 브랜치가 원격 저장소로 올라가요."),
    h("ul", { class: "storage-list" }, data.items.map((it) => {
      const [label, kind] = DELETABLE[it.deletable] || DELETABLE.no;
      return h("li", {},
        h("div", { class: "storage-head" }, h("strong", {}, it.title), h("span", { class: "badge " + kind, title: it.deleteNote }, label)),
        h("p", { class: "small" }, it.desc),
        it.path ? h("div", { class: "storage-path" }, h("code", {}, it.path),
          h("button", { type: "button", class: "small-btn", disabled: !it.exists, title: it.exists ? "" : "아직 만들어지지 않은 폴더예요", onclick: async () => {
            try { toast((await api("/api/storage/open", { key: it.key })).message); } catch (e) { toast(e.error, "bad"); }
          } }, it.exists ? (win ? "폴더 열기" : "위치 보기") : "아직 없음")) : null,
        h("p", { class: "small delete-note" }, it.deleteNote));
    })),
    h("div", { class: "modal-buttons" }, h("button", { type: "button", class: "primary", onclick: closeStorage }, "닫기")),
  );
  box.querySelector("button.primary").focus({ preventScroll: true });
  box.scrollTop = 0;
}
function closeStorage() {
  const back = $("storageBack");
  if (back) back.classList.remove("show");
  document.removeEventListener("keydown", storageKey);
}
function storageKey(e) { if (e.key === "Escape") closeStorage(); }
