(function () {
  const { getAudioCtx, buildKnobDom, bindKnob, buildJackRow } = Bodular.lib;

  Bodular.registerModule('attenuverter', {
    name: 'Attenuverter', hp: 8,
    build(instance) {
      const ctx = getAudioCtx();
      const amount = ctx.createGain();
      amount.gain.value = 1;
      const offsetSrc = ctx.createConstantSource();
      offsetSrc.offset.value = 0;
      offsetSrc.start();
      const sum = ctx.createGain();
      sum.gain.value = 1;
      amount.connect(sum);
      offsetSrc.connect(sum);
      instance.inputs = { in: amount };
      instance.outputs = { out: sum };
      instance.cleanupExtra = () => { try { offsetSrc.stop(); } catch (e) {} };

      const controls = document.createElement('div');
      controls.className = 'bodular-module-controls';
      controls.style.flexDirection = 'column';
      controls.style.alignItems = 'center';
      const amtKnob = buildKnobDom('Amount');
      const offKnob = buildKnobDom('Offset');
      controls.appendChild(amtKnob);
      controls.appendChild(offKnob);

      const jackRows = document.createElement('div');
      jackRows.className = 'bodular-jack-rows';
      const inRow = buildJackRow(instance.id, 'in', 'in', 'IN', 'cv');
      const outRow = buildJackRow(instance.id, 'out', 'out', 'OUT', 'cv');
      jackRows.appendChild(inRow.row);
      jackRows.appendChild(outRow.row);

      instance.bodyEl.appendChild(controls);
      instance.bodyEl.appendChild(jackRows);
      instance.jacks = { in: { dir: 'in', el: inRow.jackEl }, out: { dir: 'out', el: outRow.jackEl } };

      bindKnob(amtKnob, { min: -1, max: 1, initial: 1, format: (v) => v.toFixed(2), onChange: (v) => { amount.gain.value = v; } });
      bindKnob(offKnob, { min: -1, max: 1, initial: 0, format: (v) => v.toFixed(2), onChange: (v) => { offsetSrc.offset.value = v; } });
    },
    cleanup(instance) {
      if (instance.cleanupExtra) instance.cleanupExtra();
      try { instance.outputs.out.disconnect(); } catch (e) {}
    },
  });
})();
