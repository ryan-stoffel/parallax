import type { Answer } from "./loopback";

// The browser pages of Parallax sign-in (0037), which loopback.ts serves. Plain HTML, with styles
// and a script that run only with the response's nonce. They follow the system's light or dark.

const github = `<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="M12 0c6.63 0 12 5.276 12 11.79-.001 5.067-3.29 9.567-8.175 11.187-.6.118-.825-.25-.825-.56 0-.398.015-1.665.015-3.242 0-1.105-.375-1.813-.81-2.181 2.67-.295 5.475-1.297 5.475-5.822 0-1.297-.465-2.344-1.23-3.169.12-.295.54-1.503-.12-3.125 0 0-1.005-.324-3.3 1.209a11.32 11.32 0 00-3-.398c-1.02 0-2.04.133-3 .398-2.295-1.518-3.3-1.209-3.3-1.209-.66 1.622-.24 2.83-.12 3.125-.765.825-1.23 1.887-1.23 3.169 0 4.51 2.79 5.527 5.46 5.822-.345.294-.66.81-.765 1.577-.69.31-2.415.81-3.495-.973-.225-.354-.9-1.223-1.845-1.209-1.005.015-.405.56.015.781.51.28 1.095 1.327 1.23 1.666.24.663 1.02 1.93 4.035 1.385 0 .988.015 1.916.015 2.196 0 .31-.225.664-.825.56C3.303 21.374-.003 16.867 0 11.791 0 5.276 5.37 0 12 0z"/></svg>`;
const google = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>`;
const apple = `<svg viewBox="0 0 814 1000" fill="currentColor" aria-hidden="true"><path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/></svg>`;

const style = `
  :root { color-scheme: light dark; --bg: #f7f7f7; --surface: #fff; --fg: #181818; --muted: #4f4f4f;
    --border: rgb(0 0 0 / 9%); --hover: rgb(0 0 0 / 4.5%); --field: #fff; --primary: #181818;
    --primary-fg: #fff; --danger: #c42b2b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --surface: #181818; --fg: #ececec;
    --muted: #a3a3a3; --border: rgb(255 255 255 / 9%); --hover: rgb(255 255 255 / 5%);
    --field: #111; --primary: #ececec; --primary-fg: #111; --danger: #f87171; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg);
    color: var(--fg); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(400px, 100% - 32px); padding: 32px 0; }
  .brand { margin: 0 0 24px; font-weight: 600; color: var(--muted); }
  h1 { margin: 0 0 20px; font-size: 22px; font-weight: 600; }
  .card { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
  .card > * { padding: 20px; }
  .card > * + * { border-top: 1px solid var(--border); }
  .providers { display: grid; gap: 8px; }
  .button { display: flex; align-items: center; justify-content: center; gap: 8px; height: 38px;
    border: 1px solid var(--border); border-radius: 8px; color: inherit; background: none;
    text-decoration: none; font: inherit; cursor: pointer; }
  .button:hover { background: var(--hover); }
  .button svg { width: 18px; height: 18px; }
  form { display: grid; gap: 12px; }
  .names { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .names[hidden] { display: none; }
  label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
  input { height: 36px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--field); color: var(--fg); font: inherit; }
  input:focus { outline: 2px solid #2563eb; outline-offset: -1px; }
  .status { margin: 0; font-size: 13px; color: var(--muted); }
  .status:empty { display: none; }
  .error { color: var(--danger); }
  .actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .quiet { border: 0; background: none; color: var(--muted); font: inherit; cursor: pointer;
    padding: 6px 8px; border-radius: 8px; }
  .quiet:hover { background: var(--hover); color: var(--fg); }
  .primary { height: 34px; padding: 0 14px; border: 0; border-radius: 8px; font: inherit;
    font-weight: 500; background: var(--primary); color: var(--primary-fg); cursor: pointer; }
  .primary:disabled { opacity: .5; cursor: default; }
  .note { margin: 0; color: var(--muted); }
  a { color: inherit; }
`;

function layout(nonce: string, title: string, body: string, script = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style nonce="${nonce}">${style}</style>
</head>
<body>
<main>
<p class="brand">Parallax</p>
${body}
</main>
${script && `<script nonce="${nonce}">${script}</script>`}
</body>
</html>`;
}

/** The sign-in page: providers, then email and password. `?create` opens Create an account. */
export function signInPage(nonce: string): string {
  const provider = (id: string, name: string, logo: string) =>
    `<a class="button" href="/oauth/${id}">${logo}Continue with ${name}</a>`;
  return layout(
    nonce,
    "Sign in to Parallax",
    `<h1 id="title">Sign in to Parallax</h1>
<div class="card" id="card">
  <div class="providers">
    ${provider("github", "GitHub", github)}
    ${provider("google", "Google", google)}
    ${provider("apple", "Apple", apple)}
  </div>
  <form id="form">
    <div class="names" hidden>
      <label>First name<input name="firstName" autocomplete="given-name"></label>
      <label>Last name<input name="lastName" autocomplete="family-name"></label>
    </div>
    <label>Email<input name="email" type="email" required autocomplete="email"></label>
    <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
    <p class="status" id="status" role="status"></p>
    <div class="actions">
      <button type="button" class="quiet" id="switch">Create an account</button>
      <button type="submit" class="primary" id="submit">Sign in</button>
    </div>
  </form>
</div>`,
    `
const $ = (id) => document.getElementById(id);
const form = $("form"), status = $("status"), submit = $("submit");
let create = new URLSearchParams(location.search).has("create");
function show() {
  document.title = $("title").textContent = create ? "Create a Parallax account" : "Sign in to Parallax";
  form.querySelector(".names").hidden = !create;
  for (const input of form.querySelectorAll(".names input")) input.required = create;
  form.password.autocomplete = create ? "new-password" : "current-password";
  $("switch").textContent = create ? "I have an account" : "Create an account";
  submit.textContent = create ? "Create account" : "Sign in";
  status.textContent = "";
}
$("switch").onclick = () => { create = !create; show(); };
form.onsubmit = async (event) => {
  event.preventDefault();
  submit.disabled = true;
  status.textContent = "";
  let answer;
  try {
    const res = await fetch("/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ create, ...Object.fromEntries(new FormData(form)) }),
    });
    answer = await res.json();
  } catch {
    answer = { error: "Parallax isn't answering. Start again from the app." };
  }
  submit.disabled = false;
  if (answer.signedIn) {
    document.title = $("title").textContent = "Signed in to Parallax";
    $("card").innerHTML = '<p class="note">You can close this tab and go back to Parallax.</p>';
    return;
  }
  status.className = answer.error ? "status error" : "status";
  status.textContent = answer.error ?? answer.note;
};
show();
`,
  );
}

/** Where a provider or an email link comes back: signed in, or the error and Try again. */
export function resultPage(answer: Answer, nonce: string): string {
  if ("signedIn" in answer)
    return layout(
      nonce,
      "Signed in to Parallax",
      `<h1>Signed in to Parallax</h1>
<div class="card"><p class="note">You can close this tab and go back to Parallax.</p></div>`,
    );
  const message = "error" in answer ? answer.error : answer.note;
  return layout(
    nonce,
    "Couldn't sign in to Parallax",
    `<h1>Couldn't sign in to Parallax</h1>
<div class="card"><p class="note error">${escapeHtml(message)}</p><p class="note"><a href="/">Try again</a></p></div>`,
  );
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
