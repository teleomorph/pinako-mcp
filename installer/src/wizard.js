// Tauri v2 global API — available because withGlobalTauri: true in tauri.conf.json
const invoke = window.__TAURI__.core.invoke;

// ── State ─────────────────────────────────────────────────────────────────────

let step = 0;           // 0=welcome 1=apps 2=installing 3=done
let clients = [];       // ClientInfo[] from detect_clients command

const SCREENS = ['s-welcome', 's-apps', 's-installing', 's-done'];

// ── Startup ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    clients = await invoke('detect_clients');
  } catch (e) {
    clients = [];
    console.error('detect_clients failed:', e);
  }
  buildAppList();
  showStep(0);
}

function buildAppList() {
  const detected = clients.filter(c => c.detected);

  if (detected.length === 0) {
    document.getElementById('apps-detected').classList.add('hidden');
    document.getElementById('apps-none').classList.remove('hidden');
    return;
  }

  const list = document.getElementById('app-list');
  for (const c of detected) {
    const item = document.createElement('label');
    item.className = 'app-item';
    item.innerHTML = `
      <input type="checkbox" id="chk-${c.id}" checked>
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
      btnNext.textContent = 'Next';
      btnNext.disabled = false;
      break;
    case 1:
      btnBack.classList.remove('hidden');
      btnNext.classList.remove('hidden');
      btnNext.textContent = 'Install';
      btnNext.disabled = false;
      break;
    case 2:
      btnBack.classList.add('hidden');
      btnNext.classList.add('hidden');
      break;
    case 3:
      btnBack.classList.add('hidden');
      btnNext.classList.remove('hidden');
      btnNext.textContent = 'Finish';
      btnNext.disabled = false;
      break;
  }
}

function back() {
  if (step === 1) showStep(0);
}

async function next() {
  if (step === 0) {
    showStep(1);
  } else if (step === 1) {
    await runInstall();
  } else if (step === 3) {
    await invoke('quit');
  }
}

// ── Installation ──────────────────────────────────────────────────────────────

async function runInstall() {
  showStep(2);

  const selectedIds = clients
    .filter(c => c.detected)
    .filter(c => {
      const chk = document.getElementById(`chk-${c.id}`);
      return chk ? chk.checked : false;
    })
    .map(c => c.id);

  const logBox = document.getElementById('install-log');
  logBox.innerHTML = '';

  try {
    const lines = await invoke('install', { selectedIds });
    for (const line of lines) {
      appendLog(logBox, line);
    }
  } catch (err) {
    appendLog(logBox, `Error: ${err}`);
  }

  // Brief pause so the user can read the log, then advance to done screen.
  setTimeout(() => showStep(3), 900);
}

function appendLog(box, text) {
  const el = document.createElement('div');
  el.className = 'log-line' +
    (text.startsWith('✓') ? ' success' : text.startsWith('⚠') ? ' warn' : '');
  el.textContent = text;
  box.appendChild(el);
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
