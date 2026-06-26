(function () {
  const { getAudioCtx, buildKnobDom, bindKnob, buildJackRow } = Bodular.lib;

  Bodular.registerModule('vcf', {
    name: 'VCF', hp: 12,
    build(instance) {
      const ctx = getAudioCtx();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1000;
      filter.Q.value = 1;

      // The cv jack can't feed filter.frequency directly: an LFO/Clock swings
      // +/-1, which is a huge relative change for a VCA's gain (~1) but
      // inaudible against a 20-20000Hz cutoff. Scale CV up before it lands
      // on the AudioParam, with a knob controlling how many Hz per volt.
      const cvScale = ctx.createGain();
      cvScale.gain.value = 2000;
      cvScale.connect(filter.frequency);

      instance.inputs = { in: filter, cv: cvScale };
      instance.outputs = { out: filter };

      const controls = document.createElement('div');
      controls.className = 'bodular-module-controls';
      const cutoffKnob = buildKnobDom('Cutoff');
      const resKnob = buildKnobDom('Res');
      const cvAmtKnob = buildKnobDom('CV Amt');
      controls.appendChild(cutoffKnob);
      controls.appendChild(resKnob);
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

      bindKnob(cutoffKnob, {
        min: 0, max: 1, initial: 0.5,
        format: (norm) => Math.round(20 * Math.pow(1000, norm)) + 'Hz',
        onChange: (norm) => { filter.frequency.value = 20 * Math.pow(1000, norm); },
      });
      bindKnob(resKnob, { min: 0, max: 20, initial: 1, format: (v) => v.toFixed(1), onChange: (v) => { filter.Q.value = v; } });
      bindKnob(cvAmtKnob, { min: 0, max: 8000, initial: 2000, format: (v) => Math.round(v) + 'Hz/V', onChange: (v) => { cvScale.gain.value = v; } });
    },
    cleanup(instance) { try { instance.outputs.out.disconnect(); } catch (e) {} },
  });
})();
