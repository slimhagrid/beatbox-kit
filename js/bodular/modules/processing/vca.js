(function () {
  const { getAudioCtx, buildKnobDom, bindKnob, buildJackRow, fmtPct } = Bodular.lib;

  Bodular.registerModule('vca', {
    name: 'VCA', hp: 10,
    build(instance) {
      const ctx = getAudioCtx();
      const gain = ctx.createGain();
      gain.gain.value = 1;

      // Same fix as the VCF: scale incoming CV before it lands on the
      // AudioParam so modulation depth is adjustable instead of always full-strength.
      const cvScale = ctx.createGain();
      cvScale.gain.value = 1;
      cvScale.connect(gain.gain);

      instance.inputs = { in: gain, cv: cvScale };
      instance.outputs = { out: gain };

      const controls = document.createElement('div');
      controls.className = 'bodular-module-controls';
      controls.style.flexDirection = 'column';
      controls.style.alignItems = 'center';
      const levelKnob = buildKnobDom('Level');
      const cvAmtKnob = buildKnobDom('CV Amt');
      controls.appendChild(levelKnob);
      controls.appendChild(cvAmtKnob);

      const jackRows = document.createElement('div');
      jackRows.className = 'bodular-jack-rows';
      const inRow = buildJackRow(instance.id, 'in', 'in', 'IN');
      const cvRow = buildJackRow(instance.id, 'cv', 'in', 'CV', 'cv');
      const outRow = buildJackRow(instance.id, 'out', 'out', 'OUT');
      jackRows.appendChild(inRow.row);
      jackRows.appendChild(cvRow.row);
      jackRows.appendChild(outRow.row);

      instance.bodyEl.appendChild(controls);
      instance.bodyEl.appendChild(jackRows);
      instance.jacks = { in: { dir: 'in', el: inRow.jackEl }, cv: { dir: 'in', el: cvRow.jackEl }, out: { dir: 'out', el: outRow.jackEl } };

      bindKnob(levelKnob, { min: 0, max: 1.5, initial: 1, format: fmtPct, onChange: (v) => { gain.gain.value = v; } });
      bindKnob(cvAmtKnob, { min: 0, max: 2, initial: 1, format: fmtPct, onChange: (v) => { cvScale.gain.value = v; } });
    },
    cleanup(instance) {
      try { instance.outputs.out.disconnect(); } catch (e) {}
    },
  });
})();
