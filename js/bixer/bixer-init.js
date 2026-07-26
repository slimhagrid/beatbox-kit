document.addEventListener('DOMContentLoaded', () => {
  if (typeof Bixer !== 'undefined') Bixer.init();
});
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(() => { if (typeof Bixer !== 'undefined') Bixer.init(); }, 0);
}
