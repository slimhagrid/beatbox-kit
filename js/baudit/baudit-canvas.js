// baudit-canvas.js — Background particle canvas + hero waveform animation
// No external dependencies.

// ══════════════════════════════════════════════════════════
//  BACKGROUND CANVAS — single rAF, 30fps cap, hidden-tab pause
// ══════════════════════════════════════════════════════════
(function() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H;
  const particles = Array.from({length:40}, () => ({
    x:Math.random(), y:Math.random(),
    r:Math.random()*1.5+0.5,
    speed:Math.random()*0.0003+0.0001,
    alpha:Math.random()*0.35+0.08,
    hue:Math.random()>0.5?'0,245,212':'255,51,102'
  }));
  function resize() { W=canvas.width=window.innerWidth; H=canvas.height=window.innerHeight; }
  resize();
  window.addEventListener('resize', resize, {passive:true});
  let last=0;
  const STEP = 1000/30;
  function draw(ts) {
    requestAnimationFrame(draw);
    if (document.hidden || ts-last < STEP) return;
    last = ts;
    ctx.clearRect(0,0,W,H);
    ctx.strokeStyle='rgba(255,255,255,0.02)'; ctx.lineWidth=1;
    ctx.beginPath();
    for (let x=0;x<W;x+=80){ctx.moveTo(x,0);ctx.lineTo(x,H);}
    for (let y=0;y<H;y+=80){ctx.moveTo(0,y);ctx.lineTo(W,y);}
    ctx.stroke();
    const now=ts/1000;
    particles.forEach(p=>{
      const x=((p.x+now*p.speed)%1)*W, y=((p.y+now*p.speed*0.3)%1)*H;
      ctx.beginPath(); ctx.arc(x,y,p.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(${p.hue},${p.alpha})`; ctx.fill();
    });
  }
  requestAnimationFrame(draw);
})();

// ══════════════════════════════════════════════════════════
//  HERO WAVEFORM — single rAF, 24fps, IntersectionObserver
// ══════════════════════════════════════════════════════════
(function() {
  const canvas = document.getElementById('hero-wave-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const DPR = Math.min(window.devicePixelRatio||1, 2);
  let W=0, H=0, visible=true;
  function resize() {
    const r=canvas.getBoundingClientRect();
    if (!r.width) return;
    W=canvas.width=Math.floor(r.width*DPR);
    H=canvas.height=Math.floor(r.height*DPR);
  }
  resize();
  window.addEventListener('resize', resize, {passive:true});
  new IntersectionObserver(e=>{visible=e[0].isIntersecting;},{threshold:0.1}).observe(canvas);
  const pat=[0.9,0.4,0.6,0.2,0.85,0.3,0.5,0.15,0.95,0.45,0.7,0.2,0.8,0.35,0.6,0.1,
             0.75,0.5,0.65,0.25,0.88,0.4,0.55,0.2,0.92,0.3,0.7,0.15,0.85,0.45,0.6,0.2];
  let last=0;
  const STEP=1000/24;
  function draw(ts) {
    requestAnimationFrame(draw);
    if (!visible||document.hidden||ts-last<STEP) return;
    last=ts;
    if (!W||!H){resize();return;}
    const dW=W/DPR, dH=H/DPR;
    ctx.clearRect(0,0,W,H);
    ctx.save(); ctx.scale(DPR,DPR);
    const t=ts/1000, bW=3, bG=2, n=Math.floor(dW/(bW+bG)), mid=dH/2;
    // Batch all bars into one path per draw (they share the same color here)
    ctx.fillStyle='rgba(0,245,212,0.55)';
    ctx.beginPath();
    for (let i=0;i<n;i++) {
      const x=i/n;
      const amp=Math.max(0.05,pat[Math.floor(x*pat.length)]+Math.sin(t*2+x*20)*0.05);
      const bH=amp*dH*0.85;
      // Use rect instead of roundRect for the batched path (roundRect can't be batched across fills)
      ctx.rect(i*(bW+bG), mid-bH/2, bW, bH);
    }
    ctx.fill();
    ctx.restore();
  }
  requestAnimationFrame(draw);
})();
