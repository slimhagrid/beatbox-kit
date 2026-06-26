(function () {
  const { getAudioCtx, buildKnobDom, bindKnob, buildJackRow, fmtPct } = Bodular.lib;

  Bodular.registerModule('lfo', {
    name: 'LFO', hp: 10,
    build(instance) {
      const ctx = getAudioCtx();
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 2;
      const depth = ctx.createGain();
      depth.gain.value = 1;
      osc.connect(depth);
      osc.start();
      instance.inputs = {};
      instance.outputs = { out: depth };
      instance.cleanupExtra = () => { try { osc.stop(); } catch (e) {} };

      const topControls = document.createElement('div');
      topControls.className = 'bodular-module-top';
      const shapeBtn = document.createElement('button');
      shapeBtn.className = 'bodular-toggle-btn full';
      shapeBtn.textContent = 'SINE';
      const shapes = ['sine', 'square', 'sawtooth', 'triangle'];
      let shapeIdx = 0;
      shapeBtn.addEventListener('click', () => {
        shapeIdx = (shapeIdx + 1) % shapes.length;
        osc.type = shapes[shapeIdx];
        shapeBtn.textContent = shapes[shapeIdx].toUpperCase();
      });
      topControls.appendChild(shapeBtn);

      const centerControls = document.createElement('div');
      centerControls.className = 'bodular-module-center';
      const rateKnob = buildKnobDom('Rate');
      const depthKnob = buildKnobDom('Depth');
      centerControls.appendChild(rateKnob);
      centerControls.appendChild(depthKnob);

      const jackRows = document.createElement('div');
      jackRows.className = 'bodular-jack-rows';
      const outRow = buildJackRow(instance.id, 'out', 'out', 'OUT', 'cv');
      jackRows.appendChild(outRow.row);

      instance.bodyEl.appendChild(topControls);
      instance.bodyEl.appendChild(centerControls);
      instance.bodyEl.appendChild(jackRows);
      instance.jacks = { out: { dir: 'out', el: outRow.jackEl } };

      bindKnob(rateKnob, { min: 0.1, max: 20, initial: 2, format: (v) => v.toFixed(1) + 'Hz', onChange: (v) => { osc.frequency.value = v; } });
      bindKnob(depthKnob, { min: 0, max: 1, initial: 1, format: fmtPct, onChange: (v) => { depth.gain.value = v; } });
    },
    cleanup(instance) {
      if (instance.cleanupExtra) instance.cleanupExtra();
      try { instance.outputs.out.disconnect(); } catch (e) {}
    },
  });
})();
