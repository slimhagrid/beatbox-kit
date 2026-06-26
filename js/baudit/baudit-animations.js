// baudit-animations.js — Canvas polyfill + Baudit init
// Nav and GSAP hero animations are now handled per-page.
// This file is loaded only on the Baudit tool page.

// ── ROUNDRECT POLYFILL ──
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x,y,w,h,r) {
    r = Math.min(r, w/2, h/2);
    this.beginPath();
    this.moveTo(x+r,y);
    this.arcTo(x+w,y, x+w,y+h, r);
    this.arcTo(x+w,y+h, x,y+h, r);
    this.arcTo(x,y+h, x,y, r);
    this.arcTo(x,y, x+w,y, r);
    this.closePath();
    return this;
  };
}

// ── INIT BAUDIT ──
// Called here so baudit-engine.js doesn't need to self-init.
// Guards against double-init if the page also calls it inline.
(function initWhenReady() {
  if (typeof Baudit !== 'undefined') {
    if (!Baudit._initialised) { Baudit._initialised = true; Baudit.init(); }
    return;
  }
  setTimeout(initWhenReady, 20);
})();
