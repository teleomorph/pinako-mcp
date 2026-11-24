// Tauri v2 global API — available because withGlobalTauri: true in tauri.conf.json
const invoke = window.__TAURI__.core.invoke;

// ── State ─────────────────────────────────────────────────────────────────────

let step = 0;           // 0=welcome 1=apps 2=installing 3=done
let clients = [];       // ClientInfo[] from detect_clients command
let update = false;     // the Bridge is already here: refresh what is connected, tick nothing
let adding = false;     // "Connect more apps", after an update
let failed = false;     // the last install attempt failed (screen 2 offers Try again)

const SCREENS = ['s-welcome', 's-apps', 's-installing', 's-done'];

// ── Startup ───────────────────────────────────────────────────────────────────

async function init() {
  await detect();
  if (update) showUpdateWelcome();
  else buildAppList(clients.filter(c => c.detected), true);
  showStep(0);
}

async function detect() {
  try {
    const found = await invoke('detect_clients');
    clients = found.clients;
    update = update || found.update;
  } catch (e) {
    clients = [];
    console.error('detect_clients failed:', e);
  }
}

// An update never asks which apps: it names the connected ones and keeps them.
function showUpdateWelcome() {
  const connected = clients.filter(c => c.connected === 'yes').map(c => c.label);
  document.getElementById('welcome-install').classList.add('hidden');
  document.getElementById('welcome-update').classList.remove('hidden');
  document.getElementById('welcome-title').textContent = 'Update Pinako AI Bridge';
  document.getElementById('welcome-connected').textContent = connected.length
    ? `Connected AI apps: ${connected.join(', ')}.`
    : 'No AI apps are connected to Pinako.';
  document.getElementById('terms-button').textContent = 'Update';
  document.getElementById('dot-1').classList.add('hidden');
}

function buildAppList(shown, ticked) {
  if (shown.length === 0) {
    document.getElementById('apps-detected').classList.add('hidden');
    document.getElementById('apps-none').classList.remove('hidden');
    return;
  }

  const list = document.getElementById('app-list');
  list.innerHTML = '';
  for (const c of shown) {
    const item = document.createElement('label');
    item.className = 'app-item';
    item.innerHTML = `
      <input type="checkbox" id="chk-${c.id}"${ticked ? ' checked' : ''}>
      <div class="app-body">
        <div class="app-name">${c.label}</div>
        ${c.note ? `<div class="app-note">${c.note}</div>` : ''}
      </div>
    `;
    list.appendChild(item);
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

function showStep(s) {
  step = s;

  SCREENS.forEach((id, i) => {
    document.getElementById(id).classList.toggle('active', i === s);
  });

  document.querySelector('main').scrollTop = 0;

  const btnBack = document.getElementById('btn-back');
  const btnNext = document.getElementById('btn-next');

  // Dots: steps 0,1,3 map to dot indices 0,1,2
  const dotIndex = s === 3 ? 2 : s === 2 ? 1 : s;
  document.querySelectorAll('.dot').forEach((d, i) => {
    d.classList.toggle('active', i <= dotIndex && s !== 2);
  });

  switch (s) {
    case 0:
      btnBack.classList.add('hidden');
      btnNext.classList.remove('hidden');
      btnNext.textContent = update ? 'Update' : 'Next';
      btnNext.disabled = false;
      break;
    case 1:
      btnBack.classList.remove('hidden');
      btnBack.textContent = 'Back';
      btnNext.classList.remove('hidden');
      btnNext.textContent = adding ? 'Connect' : 'Install';
      btnNext.disabled = false;
      break;
    case 2:
      btnBack.classList.add('hidden');
      btnNext.classList.add('hidden');
      break;
    case 3:
      // Down here it is always in view; the screen above it scrolls.
      btnBack.classList.toggle('hidden', !update || notConnected().length === 0);
      btnBack.textContent = 'Connect more apps';
      btnNext.classList.remove('hidden');
      btnNext.textContent = 'Finish';
      btnNext.disabled = false;
      break;
  }
}

async function back() {
  if (step === 1 && adding) showStep(3);
  else if (step === 1) showStep(0);
  else if (step === 3) connectMore();
  else if (step === 2 && failed) await invoke('quit');
}

async function next() {
  if (step === 0 && !update) {
    showStep(1);
  } else if (step === 1 && adding) {
    await runConnect();
  } else if (step <= 1 || (step === 2 && failed)) {
    await runInstall();
  } else if (step === 3) {
    await invoke('quit');
  }
}

// ── Installation ──────────────────────────────────────────────────────────────

// A failed install stays on its own screen: moving on to "Installation
// Complete" told people the update had worked when nothing had changed.
function showFailure(err) {
  failed = true;
  const message = err && err.message ? err.message : String(err);
  const hadPrevious = !!(err && err.had_previous);
  document.getElementById('installing-title').textContent = hadPrevious ? 'Not updated' : 'Not installed';
  document.getElementById('install-log').classList.add('hidden');
  document.getElementById('install-failed-text').textContent = hadPrevious
    ? 'The AI Bridge was not updated. Your current version is still in place. Try again after your next system reboot, or close your browsers and AI apps, then press Try again.'
    : 'The AI Bridge was not installed. Try again after your next system reboot, or close your browsers and AI apps, then press Try again.';
  document.getElementById('install-failed-details').textContent = message;
  document.getElementById('install-failed').hidden = false;
  const btnBack = document.getElementById('btn-back');
  const btnNext = document.getElementById('btn-next');
  btnBack.textContent = 'Close';
  btnBack.classList.remove('hidden');
  btnNext.textContent = 'Try again';
  btnNext.classList.remove('hidden');
}

function tickedIds() {
  return clients
    .filter(c => c.detected)
    .filter(c => {
      const chk = document.getElementById(`chk-${c.id}`);
      return chk ? chk.checked : false;
    })
    .map(c => c.id);
}

function startWork(title) {
  failed = false;
  document.getElementById('installing-title').textContent = title;
  document.getElementById('install-failed').hidden = true;
  document.getElementById('install-log').classList.remove('hidden');
  document.getElementById('btn-back').textContent = 'Back';
  showStep(2);
  const logBox = document.getElementById('install-log');
  logBox.innerHTML = '';
  return logBox;
}

// The done screen repeats what did not go well: the log is gone in a moment.
function showNotices(lines) {
  const box = document.getElementById('done-notices');
  const notices = lines.filter(l => l.startsWith('⚠'));
  box.innerHTML = '';
  for (const line of notices) appendLog(box, line);
  box.hidden = notices.length === 0;
}

function notConnected() {
  return clients.filter(c => c.detected && c.connected === 'no');
}

async function runInstall() {
  const logBox = startWork(update ? 'Updating…' : 'Installing…');

  let lines;
  try {
    lines = await invoke('install', { update, selectedIds: update ? [] : tickedIds() });
    for (const line of lines) {
      appendLog(logBox, line);
    }
  } catch (err) {
    showFailure(err);
    return;
  }

  if (update) {
    document.getElementById('done-title').textContent = 'Update Complete';
    document.getElementById('done-lead').textContent = 'Pinako AI Bridge has been updated.';
    await detect();
  }
  showNotices(lines);

  // #67: fill in the REAL server URL before showing the done screen. It used
  // to be hardcoded as the bare URL in index.html, which is the read-only
  // form — while the release notes tell hand-configuring users to copy the
  // URL from exactly this screen.
  try {
    const { url, tokenless } = await invoke('mcp_url');
    const urlEl = document.querySelector('#s-done .mcp-url');
    if (urlEl) urlEl.textContent = url;
    const warnEl = document.getElementById('mcp-url-warning');
    if (warnEl) {
      // An update without the key changed no app: its own notice says so.
      warnEl.hidden = !tokenless || update;
      if (tokenless && !update) {
        appendLog(logBox, '⚠ Could not create the access token — apps were configured with read-only access.');
      }
    }
  } catch (err) {
    console.error(err);
  }

  // Brief pause so the user can read the log, then advance to done screen.
  setTimeout(() => showStep(3), 900);
}

// ── Connect more apps (after an update) ───────────────────────────────────────

function connectMore() {
  adding = true;
  buildAppList(notConnected(), false);
  document.getElementById('apps-title').textContent = 'Connect more apps';
  document.getElementById('apps-lead').textContent = 'Select the apps to connect to Pinako:';
  showStep(1);
}

async function runConnect() {
  const selectedIds = tickedIds();
  if (selectedIds.length === 0) {
    showStep(3);
    return;
  }
  const logBox = startWork('Connecting…');
  let lines;
  try {
    lines = await invoke('connect', { selectedIds });
  } catch (err) {
    lines = [`⚠  ${err && err.message ? err.message : String(err)}`];
  }
  for (const line of lines) appendLog(logBox, line);
  await detect();
  showNotices(lines);
  setTimeout(() => showStep(3), 900);
}

function appendLog(box, text) {
  const el = document.createElement('div');
  el.className = 'log-line' +
    (text.startsWith('✓') ? ' success' : text.startsWith('⚠') ? ' warn' : '');
  el.textContent = text;
  box.appendChild(el);
}

// ── Copy button on the MCP URL ────────────────────────────────────────────────
// The URL is the one string users are told to take somewhere else, so it gets a
// copy button per the house idiom (CLAUDE.md): a U+29C9 glyph that flips to a
// check for 1.2s. navigator.clipboard can be unavailable or rejected inside a
// webview depending on the origin's secure-context status, so fall back to the
// execCommand path rather than failing silently on the one action that matters.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

function wireCopyButton() {
  const btn = document.getElementById('mcp-copy-btn');
  const urlEl = document.querySelector('#s-done .mcp-url');
  if (!btn || !urlEl) return;
  let revertTimer = null;
  btn.addEventListener('click', async () => {
    const ok = await copyText(urlEl.textContent.trim());
    // Icon state is a CLASS toggle over two inline SVGs, not textContent —
    // swapping text would blow away the markup the stylesheet centers.
    btn.classList.toggle('copied', ok);
    btn.title = ok ? 'Copied' : 'Copy failed — select the text and copy manually';
    clearTimeout(revertTimer);
    revertTimer = setTimeout(() => {
      btn.classList.remove('copied');
      btn.title = 'Copy to clipboard';
    }, 1200);
  });
}

// ── External links ────────────────────────────────────────────────────────────

function openLink(url) {
  invoke('open_url', { url }).catch(console.error);
}

// ── Wordmark animation ───────────────────────────────────────────────────────
// Auto-looping version of the animated wordmark (see pinako.js ~15873-15915).
// Timing: 1s delay → glow ramp (2x slower) → streak line + dot (same speed)
//         → glow fade (2x slower) → repeat.

function initWordmarkAnimation() {
  const wordmark   = document.getElementById('wordmark');
  const streakLine = document.getElementById('streak-line');
  const streakDot  = document.getElementById('streak-dot');

  const GLOW_FULL = 'drop-shadow(0 0 4px rgba(165,44,221,0.9)) '
    + 'drop-shadow(0 0 12px rgba(165,44,221,0.8)) '
    + 'drop-shadow(0 0 24px rgba(165,44,221,0.65)) '
    + 'drop-shadow(0 0 40px rgba(165,44,221,0.45))';
  const GLOW_OFF = 'drop-shadow(0 0 0 rgba(165,44,221,0))';

  function runCycle() {
    // Phase 1: after 1000ms delay, start glow ramp (10400ms = 2600ms × 4)
    setTimeout(() => {
      wordmark.style.transitionDuration = '10400ms';
      wordmark.style.filter = GLOW_FULL;

      // Phase 2: at +6400ms (4× original 1600ms), show streak line and animate streak dot
      setTimeout(() => {
        streakLine.style.opacity = '1';

        const w = wordmark.offsetWidth;
        const anim = streakDot.animate([
          { opacity: 0, transform: 'translate(-115%, -50%) scale(1)' },
          { opacity: 1, transform: 'translate(-115%, -50%) scale(1)', offset: 0.10 },
          { opacity: 1, transform: `translate(${w + 18}px, -50%) scale(1)`, offset: 0.82 },
          { opacity: 1, transform: `translate(${w + 24}px, -50%) scale(2.8)`, offset: 0.92 },
          { opacity: 0, transform: `translate(${w + 24}px, -50%) scale(7)` }
        ], {
          duration: 820,
          easing: 'cubic-bezier(0.45, 0, 0.95, 0.35)',
          fill: 'none'
        });

        // Phase 3: after dot finishes, begin glow fade (1300ms = original speed)
        anim.onfinish = () => {
          wordmark.style.transitionDuration = '1300ms';
          wordmark.style.filter = GLOW_OFF;
          streakLine.style.opacity = '0';

          // Phase 4: after fade completes, restart cycle (includes 1s delay)
          setTimeout(runCycle, 1300);
        };
      }, 6400);
    }, 1000);
  }

  runCycle();
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init();
  initWordmarkAnimation();
  wireCopyButton();

  // Show platform-correct install path on welcome screen
  const pathEl = document.getElementById('install-path');
  if (pathEl) {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('linux')) {
      pathEl.textContent = '~/.local/share/pinako/';
    } else if (ua.includes('mac')) {
      pathEl.textContent = '~/Library/Application Support/Pinako/';
    }
    // Windows keeps the default %APPDATA%\Pinako\
  }
});
