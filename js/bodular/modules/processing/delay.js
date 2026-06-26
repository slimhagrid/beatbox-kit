(function () {
  const { getAudioCtx, buildKnobDom, bindKnob, buildJackRow, fmtPct } = Bodular.lib;

  Bodular.registerModule('delay', {
    name: 'Delay', hp: 16,
    build(instance) {
      const ctx = getAudioCtx();
      const input = ctx.createGain(); input.gain.value = 1;
      const dry = ctx.createGain(); dry.gain.value = 1;
      const delayNode = ctx.createDelay(2);
      delayNode.delayTime.value = 0.3;
      const feedback = ctx.createGain(); feedback.gain.value = 0.35;
      const wet = ctx.createGain(); wet.gain.value = 0.4;
      const output = ctx.createGain(); output.gain.value = 1;

      input.connect(dry); dry.connect(output);
      input.connect(delayNode); delayNode.connect(wet); wet.connect(output);
      delayNode.connect(feedback); feedback.connect(delayNode);

      instance.inputs = { in: input };
      instance.outputs = { out: output };

      const controls = document.createElement('div');
      controls.className = 'bodular-module-controls';
      const timeKnob = buildKnobDom('Time');
      const fbKnob = buildKnobDom('Feedback');
      const mixKnob = buildKnobDom('Mix');
      controls.appendChild(timeKnob);
      controls.appendChild(fbKnob);
      controls.appendChild(mixKnob);

      const jackRows = document.createElement('div');
      jackRows.className = 'bodular-jack-rows';
      const inRow = buildJackRow(instance.id, 'in', 'in', 'IN');
      const outRow = buildJackRow(instance.id, 'out', 'out', 'OUT');
      jackRows.appendChild(inRow.row);
      jackRows.appendChild(outRow.row);

      instance.bodyEl.appendChild(controls);
      instance.bodyEl.appendChild(jackRows);
      instance.jacks = { in: { dir: 'in', el: inRow.jackEl }, out: { dir: 'out', el: outRow.jackEl } };

      bindKnob(timeKnob, { min: 0.02, max: 1.5, initial: 0.3, format: (v) => v.toFixed(2) + 's', onChange: (v) => { delayNode.delayTime.value = v; } });
      bindKnob(fbKnob, { min: 0, max: 0.9, initial: 0.35, format: fmtPct, onChange: (v) => { feedback.gain.value = v; } });
      bindKnob(mixKnob, { min: 0, max: 1, initial: 0.4, format: fmtPct, onChange: (v) => { wet.gain.value = v; } });
    },
    cleanup(instance) { try { instance.outputs.out.disconnect(); } catch (e) {} },
  });
})();
