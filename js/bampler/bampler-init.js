document.addEventListener('DOMContentLoaded', () => {
  if (typeof Bampler !== 'undefined') Bampler.init();
});
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(() => { if (typeof Bampler !== 'undefined') Bampler.init(); }, 0);
}
