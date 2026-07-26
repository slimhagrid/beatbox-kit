(function () {
  const canvas = document.getElementById('upload-icon-canvas');
  if (!canvas) return;

  const PX = 36;
  const buf = Object.assign(document.createElement('canvas'), { width: PX, height: PX });
  const bx = buf.getContext('2d');
  const ctx = canvas.getContext('2d');

  const cfg = {
    a: 58, b: 92, steps: 100,
    colors: ['#4d8bff', '#1f5fc4'],
    tailAt: 9.92, fade: 0.19, margin: 0, speed: 0.09,
    breathing: { rate: 1.05, depth: 1.12 },
  };
  const INTERVAL = 1000 / 24;

  let delta = 0, pulse = 0, last = 0;

  function draw(ts) {
    requestAnimationFrame(draw);
    if (ts - last < INTERVAL) return;
    last = ts;
    if (!canvas.width || !canvas.height) return;

    bx.fillStyle = `rgba(0,0,0,${cfg.fade})`;
    bx.fillRect(0, 0, PX, PX);

    const range = PX - cfg.margin * 2;
    const c = PX / 2;
    const br = cfg.breathing;
    pulse += br.rate;
    const scale = 1 + Math.sin(pulse) * br.depth;

    for (let i = 0; i < cfg.steps; i++) {
      const t = (i / cfg.steps) * Math.PI * 2;
      const px = Math.round(c + Math.sin(cfg.a * t + delta) * (range / 2) * scale);
      const py = Math.round(c + Math.sin(cfg.b * t) * (range / 2) * scale);
      bx.fillStyle = i / cfg.steps > cfg.tailAt ? cfg.colors[1] : cfg.colors[0];
      bx.fillRect(px, py, 1, 1);
    }

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, PX, PX, 0, 0, canvas.width, canvas.height);
    delta = (delta + cfg.speed) % (Math.PI * 2);
  }

  bx.fillStyle = '#000';
  bx.fillRect(0, 0, PX, PX);
  requestAnimationFrame(draw);
})();
