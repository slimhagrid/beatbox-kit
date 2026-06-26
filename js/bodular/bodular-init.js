document.addEventListener('DOMContentLoaded', () => {
  if (typeof Bodular !== 'undefined') Bodular.init();
});
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(() => { if (typeof Bodular !== 'undefined') Bodular.init(); }, 0);
}
