(function () {
  const { getAudioCtx, buildKnobDom, bindKnob, buildJackRow } = Bodular.lib;

  Bodular.registerModule('oscilloscope', {
    name: 'Oscilloscope', hp: 18,
    build(instance) {
      const ctx = getAudioCtx();

      // Passthrough node (same node serves as both in and out, like a VCA)
      // so the scope can be inserted in-line anywhere in a patch -- audio or
      // CV -- without breaking the signal chain. The analyser just taps it.
      const pass = ctx.createGain();
      pass.gain.value = 1;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      pass.connect(analyser);
      instance.inputs = { in: pass };
      instance.outputs = { out: pass };

      const topControls = document.createElement('div');
      topControls.className = 'bodular-module-top';

      const scope = document.createElement('canvas');
      scope.className = 'bodular-scope';
      scope.width = 150;
      scope.height = 80;
      topControls.appendChild(scope);

      const centerControls = document.createElement('div');
      centerControls.className = 'bodular-module-center';
      const scaleKnob = buildKnobDom('Scale');
      centerControls.appendChild(scaleKnob);

      const jackRows = document.createElement('div');
      jackRows.className = 'bodular-jack-rows';
      const inRow = buildJackRow(instance.id, 'in', 'in', 'IN');
      const outRow = buildJackRow(instance.id, 'out', 'out', 'OUT');
      jackRows.appendChild(inRow.row);
      jackRows.appendChild(outRow.row);

      instance.bodyEl.appendChild(topControls);
      instance.bodyEl.appendChild(centerControls);
      instance.bodyEl.appendChild(jackRows);
      instance.jacks = { in: { dir: 'in', el: inRow.jackEl }, out: { dir: 'out', el: outRow.jackEl } };

      let scale = 1;
      bindKnob(scaleKnob, { min: 0.5, max: 4, initial: 1, format: (v) => v.toFixed(1) + 'x', onChange: (v) => { scale = v; } });

      const sctx = scope.getContext('2d');
      const buf = new Float32Array(analyser.fftSize);
      let stopped = false;
      function draw() {
        if (stopped) return;
        requestAnimationFrame(draw);
        analyser.getFloatTimeDomainData(buf);
        sctx.clearRect(0, 0, scope.width, scope.height);
        const mid = scope.height / 2;
        sctx.strokeStyle = 'rgba(255,255,255,0.15)';
        sctx.lineWidth = 1;
        sctx.beginPath();
        sctx.moveTo(0, mid);
        sctx.lineTo(scope.width, mid);
        sctx.stroke();
        sctx.strokeStyle = '#b16cff';
        sctx.lineWidth = 1.5;
        sctx.beginPath();
        for (let i = 0; i < buf.length; i++) {
          const x = (i / (buf.length - 1)) * scope.width;
          const y = mid - buf[i] * scale * mid;
          if (i === 0) sctx.moveTo(x, y);
          else sctx.lineTo(x, y);
        }
        sctx.stroke();
      }
      requestAnimationFrame(draw);
      instance.cleanupExtra = () => { stopped = true; };
    },
    cleanup(instance) {
      if (instance.cleanupExtra) instance.cleanupExtra();
      try { instance.outputs.out.disconnect(); } catch (e) {}
    },
  });
})();
