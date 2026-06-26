function lissajous(id, cfg) {
  const canvas = document.getElementById(id);
  if (!canvas) return;

  const PX = cfg.px ?? 72;
  const buf = Object.assign(document.createElement("canvas"), { width: PX, height: PX });
  const bx = buf.getContext("2d");
  const ctx = canvas.getContext("2d");
  const INTERVAL = 1000 / (cfg.fps ?? 30);

  let delta = 0, pulse = 0, visible = true, last = 0;

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (canvas.width === Math.floor(r.width) && canvas.height === Math.floor(r.height)) return;
    canvas.width = Math.floor(r.width);
    canvas.height = Math.floor(r.height);
    ctx.imageSmoothingEnabled = false;
  }

  function drawScanlines() {
    const rowH = Math.max(1, Math.floor(canvas.height / PX));
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = "#000";
    for (let y = 0; y < canvas.height; y += rowH * 2) ctx.fillRect(0, y + rowH, canvas.width, rowH);
    ctx.restore();
  }

  function draw(ts) {
    requestAnimationFrame(draw);
    if (!visible || document.hidden || ts - last < INTERVAL) return;
    last = ts;
    resize();
    if (!canvas.width || !canvas.height) return;

    bx.fillStyle = `rgba(0,0,0,${cfg.fade})`;
    bx.fillRect(0, 0, PX, PX);

    const range = PX - (cfg.margin ?? 4) * 2;
    const c = PX / 2;
    const br = cfg.breathing;
    if (br) pulse += br.rate;
    const scale = br ? 1 + Math.sin(pulse) * br.depth : 1;

    for (let i = 0; i < cfg.steps; i++) {
      const t = (i / cfg.steps) * Math.PI * 2;
      const bpx = Math.round(c + Math.sin(cfg.a * t + delta) * (range / 2) * scale);
      const bpy = Math.round(c + Math.sin(cfg.b * t + delta * (cfg.phaseY ?? 0)) * (range / 2) * scale);
      bx.fillStyle = i / cfg.steps > cfg.tailAt ? cfg.colors[1] : cfg.colors[0];
      bx.fillRect(bpx, bpy, 1, 1);
    }

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, PX, PX, 0, 0, canvas.width, canvas.height);
    drawScanlines();
    delta = (delta + cfg.speed) % (Math.PI * 2);
  }

  new IntersectionObserver(e => { visible = e[0].isIntersecting; }, { threshold: 0.1 }).observe(canvas);
  window.addEventListener("resize", resize, { passive: true });
  bx.fillStyle = "#000";
  bx.fillRect(0, 0, PX, PX);
  requestAnimationFrame(draw);
}

lissajous("baudit-lissajous", {
  a: 3, b: 2, steps: 800,
  colors: ["#b8e04a", "#e8ff80"],
  tailAt: 0.9, fade: 0.055, margin: 0, speed: 0.014,
});

lissajous("bampler-lissajous", {
  a: 2, b: 2, steps: 900,
  colors: ["#ff8c42", "#c95f10"],
  tailAt: 0.88, fade: 0.045, margin: 5, speed: 0.0018,
  breathing: { rate: 0.025, depth: 3.08 },
  phaseY: 99.35,
});

lissajous("branular-lissajous", {
  a: 48, b: 44, steps: 2900,
  colors: ["#4de8ff", "#1aa8c4"],
tailAt: 0.9, fade: 0.055, margin: 0, speed: 0.014,
});
