(function () {
  const cv = document.getElementById("upload-icon-canvas");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const PX = 30;
  const buf = document.createElement("canvas");
  buf.width = buf.height = PX;
  const bx = buf.getContext("2d");
  bx.fillStyle = "#000";
  bx.fillRect(0, 0, PX, PX);
  const PINK = "#ff4d8d",
    STEPS = 700,
    a = 77,
    b = 99;
  let delta = 0,
    last = 0;
  const STEP = 1000 / 24;
  function draw(ts) {
    requestAnimationFrame(draw);
    if (ts - last < STEP) return;
    last = ts;
    bx.fillStyle = "rgba(0,0,0,0.055)";
    bx.fillRect(0, 0, PX, PX);
    const half = PX / 2 - 1.5 + 22;
    for (let i = 0; i < STEPS; i++) {
      const t = (i / STEPS) * Math.PI * 2;
      const px = Math.round(PX / 2 + Math.sin(a * t + delta) * half);
      const py = Math.round(PX / 2 + Math.sin(b * t) * half );
      bx.fillStyle = i / STEPS > 0.92 ? "#ffd1e3" : PINK;
      bx.fillRect(px, py, 1, 1);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, PX, PX, 0, 0, cv.width, cv.height);
    delta = (delta + 0.016) % (Math.PI * 2);
  }
  requestAnimationFrame(draw);
})();
