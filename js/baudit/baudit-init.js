function setShellStatus(text) {
  const el = document.getElementById('shell-status');
  if (el) el.textContent = text;
}

const procObs = new MutationObserver(() => {
  const ind = document.getElementById('processing-indicator');
  const msg = document.getElementById('processing-msg');
  if (ind && ind.style.display !== 'none') {
    setShellStatus(msg ? msg.textContent.toUpperCase() : 'PROCESSING…');
  }
});
const procEl = document.getElementById('processing-indicator');
if (procEl) procObs.observe(procEl, { attributes: true, childList: true, subtree: true });

const statsObs = new MutationObserver(() => {
  const row = document.getElementById('stats-row');
  if (row && row.style.display !== 'none') setShellStatus('ANALYSIS COMPLETE');
});
const statsEl = document.getElementById('stats-row');
if (statsEl) statsObs.observe(statsEl, { attributes: true });

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Baudit.init());
} else {
  Baudit.init();
}
