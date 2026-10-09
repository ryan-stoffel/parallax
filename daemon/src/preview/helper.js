// Loaded into an agent's browser tab before each action (PLX-639): finds the one element a
// locator names, and snapshots the page with refs for `aria-ref=` locators.
window.__plx ||= (() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const tags = {
    button: "button", summary: "button", select: "combobox", textarea: "textbox", img: "img",
    nav: "navigation", main: "main", ul: "list", ol: "list", li: "listitem", table: "table",
    form: "form", dialog: "dialog", header: "banner", footer: "contentinfo",
  };
  const inputs = {
    checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button",
    image: "button", range: "slider", search: "searchbox", hidden: null,
  };
  const role = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return type in inputs ? inputs[type] : "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (el.isContentEditable) return "textbox";
    return tags[tag] ?? null;
  };
  const name = (el) => {
    const by = el.getAttribute("aria-labelledby");
    const label =
      el.getAttribute("aria-label") ||
      (by && by.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" ")) ||
      (el.labels && el.labels[0]?.innerText) ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      (["button", "submit", "reset"].includes(el.type) ? el.value : "") ||
      el.getAttribute("placeholder") ||
      el.innerText ||
      el.textContent ||
      "";
    return label.replace(/\s+/g, " ").trim().slice(0, 100);
  };
  const unquote = (text) => text.replace(/^(["'])([\s\S]*)\1$/, "$2");
  const all = () => [...document.querySelectorAll("*")].filter(visible);
  const find = (locator, selector) => {
    const what = locator ?? selector;
    let found;
    if (selector != null) found = [...document.querySelectorAll(selector)];
    else if (locator.startsWith("aria-ref=")) {
      found = [...document.querySelectorAll(`[data-plx-ref="${CSS.escape(locator.slice(9))}"]`)];
      if (found.length === 0)
        throw new Error(`No element has ${locator}: refs expire on navigation or a new snapshot. Take a new preview_snapshot.`);
    } else if (locator.startsWith("role=")) {
      const m = /^role=([\w-]+)(?:\[name=([\s\S]+)\])?$/.exec(locator);
      if (!m) throw new Error("Write a role locator as role=button[name='Send'].");
      const want = m[2] && unquote(m[2]).toLowerCase();
      found = all().filter((el) => role(el) === m[1] && (!want || name(el).toLowerCase().includes(want)));
      const exact = want ? found.filter((el) => name(el).toLowerCase() === want) : [];
      if (exact.length) found = exact;
    } else if (locator.startsWith("text=")) {
      const want = unquote(locator.slice(5)).toLowerCase();
      found = all().filter((el) => (el.innerText || "").toLowerCase().includes(want));
      found = found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
    } else found = [...document.querySelectorAll(locator.startsWith("css=") ? locator.slice(4) : locator)];
    if (found.length === 0) throw new Error(`Nothing matches ${what}.`);
    if (found.length > 1)
      throw new Error(`${found.length} elements match ${what}; use a more specific locator, such as an aria-ref from preview_snapshot.`);
    return found[0];
  };
  const point = (el) => {
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const interactive =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"]),[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[role=slider]';
  const snapshot = () => {
    for (const el of document.querySelectorAll("[data-plx-ref]")) el.removeAttribute("data-plx-ref");
    const elements = [...document.querySelectorAll(interactive)].filter(visible).slice(0, 200).map((el, i) => {
      const ref = `e${i + 1}`;
      el.setAttribute("data-plx-ref", ref);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(), role: role(el), name: name(el), selector: `[data-plx-ref="${ref}"]`,
        x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height),
      };
    });
    const outline = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[data-plx-ref]")].filter(visible).map((el) => {
      const ref = el.getAttribute("data-plx-ref");
      const level = /^H(\d)$/.exec(el.tagName);
      const value = "value" in el && el.tagName !== "BUTTON" && el.value ? ` value="${String(el.value).slice(0, 60)}"` : "";
      const checked = el.checked ? " [checked]" : "";
      return `- ${role(el) ?? el.tagName.toLowerCase()} "${name(el)}"${level ? ` [level=${level[1]}]` : ""}${ref ? ` [ref=${ref}]` : ""}${value}${checked}`;
    });
    return {
      url: location.href, title: document.title, loading: document.readyState !== "complete",
      visibleText: (document.body?.innerText ?? "").slice(0, 16000), interactiveElements: elements,
      accessibilityTree: outline.join("\n"),
    };
  };
  return { find, point, snapshot };
})();
