document.addEventListener('DOMContentLoaded', () => {
  if (typeof Branular !== 'undefined') Branular.init();
});
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(() => { if (typeof Branular !== 'undefined') Branular.init(); }, 0);
}
