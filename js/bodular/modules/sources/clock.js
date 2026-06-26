(function () {
  const { getAudioCtx, buildKnobDom, bindKnob, buildJackRow } = Bodular.lib;

  Bodular.registerModule('clock', {
    name: 'Clock', hp: 12,
    build(instance) {
      const ctx = getAudioCtx();
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 2;
      osc.start();
      instance.inputs = {};
      instance.outputs = { out: osc };

      const controls = document.createElement('div');
      controls.className = 'bodular-module-controls';
      controls.style.flexDirection = 'column';
      controls.style.width = '100%';
      controls.style.alignItems = 'center';

      const led = document.createElement('div');
      led.className = 'bodular-clock-led';
      const rateKnob = buildKnobDom('Rate');
      controls.appendChild(led);
      controls.appendChild(rateKnob);

      const jackRows = document.createElement('div');
      jackRows.className = 'bodular-jack-rows';
      const outRow = buildJackRow(instance.id, 'out', 'out', 'OUT', 'cv');
      jackRows.appendChild(outRow.row);

      instance.bodyEl.appendChild(controls);
      instance.bodyEl.appendChild(jackRows);
      instance.jacks = { out: { dir: 'out', el: outRow.jackEl } };

      let blinkTimer = null;
      function setRate(hz) {
        osc.frequency.value = hz;
        if (blinkTimer) clearInterval(blinkTimer);
        blinkTimer = setInterval(() => led.classList.toggle('on'), 1000 / hz / 2);
      }
      bindKnob(rateKnob, { min: 0.5, max: 10, initial: 2, format: (v) => v.toFixed(1) + 'Hz', onChange: setRate });
      setRate(2);
      instance.cleanupExtra = () => { if (blinkTimer) clearInterval(blinkTimer); try { osc.stop(); } catch (e) {} };
    },
    cleanup(instance) {
      if (instance.cleanupExtra) instance.cleanupExtra();
      try { instance.outputs.out.disconnect(); } catch (e) {}
    },
  });
})();
