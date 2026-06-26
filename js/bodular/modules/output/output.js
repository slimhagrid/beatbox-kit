(function () {
  const { getAudioCtx, getRecordDestination, buildKnobDom, bindKnob, buildJackRow, fmtPct } = Bodular.lib;

  Bodular.registerModule('output', {
    name: 'Output', hp: 12,
    build(instance) {
      const ctx = getAudioCtx();
      const master = ctx.createGain();
      master.gain.value = 0.8;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      master.connect(analyser);
      master.connect(ctx.destination);
      master.connect(getRecordDestination()); // tapped by the session recorder, if running
      instance.inputs = { in: master };
      instance.outputs = {};

      const topControls = document.createElement('div');
      topControls.className = 'bodular-module-top';

      const vu = document.createElement('canvas');
      vu.className = 'bodular-vu';
      vu.width = 100;
      vu.height = 60;
      topControls.appendChild(vu);

      const centerControls = document.createElement('div');
      centerControls.className = 'bodular-module-center';
      const volKnob = buildKnobDom('Volume');
      centerControls.appendChild(volKnob);

      const jackRows = document.createElement('div');
      jackRows.className = 'bodular-jack-rows';
      const inRow = buildJackRow(instance.id, 'in', 'in', 'IN');
      jackRows.appendChild(inRow.row);

      instance.bodyEl.appendChild(topControls);
      instance.bodyEl.appendChild(centerControls);
      instance.bodyEl.appendChild(jackRows);
      instance.jacks = { in: { dir: 'in', el: inRow.jackEl } };

      bindKnob(volKnob, { min: 0, max: 1, initial: 0.8, format: fmtPct, onChange: (v) => { master.gain.value = v; } });

      const vuCtx = vu.getContext('2d');
      const data = new Uint8Array(analyser.fftSize);
      let stopped = false;
      function drawVu() {
        if (stopped) return;
        requestAnimationFrame(drawVu);
        analyser.getByteTimeDomainData(data);
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sumSq += v * v; }
        const rms = Math.sqrt(sumSq / data.length);
        vuCtx.clearRect(0, 0, vu.width, vu.height);
        const barW = vu.width * Math.min(1, rms * 3.2);
        vuCtx.fillStyle = '#b16cff';
        vuCtx.fillRect(0, 0, barW, vu.height);
      }
      requestAnimationFrame(drawVu);
      instance.cleanupExtra = () => { stopped = true; };
    },
    cleanup(instance) {
      if (instance.cleanupExtra) instance.cleanupExtra();
      try { instance.inputs.in.disconnect(); } catch (e) {}
    },
  });
})();
