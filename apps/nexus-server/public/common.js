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
    NAV.map(([href, text, key]) => h("a", { class: "tab", href, "aria-current": key === active ? "page" : false }, text)));
  document.querySelector("main").prepend(nav);
  return nav;
}
