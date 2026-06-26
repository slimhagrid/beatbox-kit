(function () {
  const { getAudioCtx, buildKnobDom, bindKnob, buildJackRow, fmtPct } = Bodular.lib;

  Bodular.registerModule('mixer', {
    name: 'Mixer', hp: 30,
    build(instance) {
      const ctx = getAudioCtx();
      const master = ctx.createGain();
      master.gain.value = 1;
      instance.inputs = {};
      instance.outputs = { out: master };

      const controls = document.createElement('div');
      controls.className = 'bodular-module-controls';

      const jackRows = document.createElement('div');
      jackRows.className = 'bodular-jack-rows';
      jackRows.style.flexDirection = 'row';
      jackRows.style.justifyContent = 'space-between';

      instance.jacks = {};
      for (let i = 1; i <= 4; i++) {
        const chGain = ctx.createGain();
        chGain.gain.value = 1;
        chGain.connect(master);
        instance.inputs[`ch${i}`] = chGain;

        const knob = buildKnobDom(`CH${i}`);
        controls.appendChild(knob);
        bindKnob(knob, { min: 0, max: 1.5, initial: 1, format: fmtPct, onChange: (v) => { chGain.gain.value = v; } });

        const { row, jackEl } = buildJackRow(instance.id, `ch${i}`, 'in', `${i}`);
        row.style.flexDirection = 'column';
        jackRows.appendChild(row);
        instance.jacks[`ch${i}`] = { dir: 'in', el: jackEl };
      }
      const outRow = buildJackRow(instance.id, 'out', 'out', 'OUT');
      outRow.row.style.flexDirection = 'column';
      jackRows.appendChild(outRow.row);
      instance.jacks.out = { dir: 'out', el: outRow.jackEl };

      instance.bodyEl.appendChild(controls);
      instance.bodyEl.appendChild(jackRows);
    },
    cleanup(instance) {
      Object.values(instance.inputs).forEach(n => { try { n.disconnect(); } catch (e) {} });
      try { instance.outputs.out.disconnect(); } catch (e) {}
    },
  });
})();
