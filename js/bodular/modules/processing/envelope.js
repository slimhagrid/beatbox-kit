(function () {
  const { getAudioCtx, buildKnobDom, bindKnob, buildJackRow, makeTriggerInput } = Bodular.lib;

  Bodular.registerModule('envelope', {
    name: 'Envelope (ADSR)', hp: 16,
    build(instance) {
      const ctx = getAudioCtx();
      const envSource = ctx.createConstantSource();
      envSource.offset.value = 0;
      envSource.start();
      instance.attack = 0.02;
      instance.decay = 0.3;
      instance.sustain = 0.5;
      instance.release = 0.4;
      instance.outputs = { out: envSource };

      // One-shot, trigger-fired shape (no separate gate-off): decay lands on
      // the sustain level, then release immediately tails it back to 0.
      function fire() {
        const now = ctx.currentTime;
        const p = envSource.offset;
        p.cancelScheduledValues(now);
        p.setValueAtTime(p.value, now);
        p.linearRampToValueAtTime(1, now + instance.attack);
        p.linearRampToValueAtTime(instance.sustain, now + instance.attack + instance.decay);
        p.linearRampToValueAtTime(0, now + instance.attack + instance.decay + instance.release);
      }

      const trigDetector = makeTriggerInput(fire);
      instance.inputs = { trig: trigDetector.node };
      instance.cleanupExtra = () => { trigDetector.stop(); try { envSource.stop(); } catch (e) {} };

      const topControls = document.createElement('div');
      topControls.className = 'bodular-module-top';

      const fireBtn = document.createElement('button');
      fireBtn.className = 'bodular-play-btn';
      fireBtn.textContent = '▶ FIRE';
      fireBtn.addEventListener('click', fire);
      topControls.appendChild(fireBtn);

      const centerControls = document.createElement('div');
      centerControls.className = 'bodular-module-center';

      const knobGrid = document.createElement('div');
      knobGrid.style.display = 'grid';
      knobGrid.style.gridTemplateColumns = '1fr 1fr';
      knobGrid.style.gap = '8px';
      knobGrid.style.justifyItems = 'center';

      const atkKnob = buildKnobDom('Attack');
      const decKnob = buildKnobDom('Decay');
      const susKnob = buildKnobDom('Sustain');
      const relKnob = buildKnobDom('Release');
      knobGrid.appendChild(atkKnob);
      knobGrid.appendChild(decKnob);
      knobGrid.appendChild(susKnob);
      knobGrid.appendChild(relKnob);
      centerControls.appendChild(knobGrid);

      const jackRows = document.createElement('div');
      jackRows.className = 'bodular-jack-rows';
      const trigRow = buildJackRow(instance.id, 'trig', 'in', 'TRIG', 'cv');
      const outRow = buildJackRow(instance.id, 'out', 'out', 'OUT', 'cv');
      jackRows.appendChild(trigRow.row);
      jackRows.appendChild(outRow.row);

      instance.bodyEl.appendChild(topControls);
      instance.bodyEl.appendChild(centerControls);
      instance.bodyEl.appendChild(jackRows);
      instance.jacks = { trig: { dir: 'in', el: trigRow.jackEl }, out: { dir: 'out', el: outRow.jackEl } };

      bindKnob(atkKnob, { min: 0.002, max: 1, initial: 0.02, format: (v) => v.toFixed(2) + 's', onChange: (v) => { instance.attack = v; } });
      bindKnob(decKnob, { min: 0.02, max: 2, initial: 0.3, format: (v) => v.toFixed(2) + 's', onChange: (v) => { instance.decay = v; } });
      bindKnob(susKnob, { min: 0, max: 1, initial: 0.5, format: (v) => Math.round(v * 100) + '%', onChange: (v) => { instance.sustain = v; } });
      bindKnob(relKnob, { min: 0.02, max: 3, initial: 0.4, format: (v) => v.toFixed(2) + 's', onChange: (v) => { instance.release = v; } });
    },
    cleanup(instance) {
      if (instance.cleanupExtra) instance.cleanupExtra();
      try { instance.outputs.out.disconnect(); } catch (e) {}
    },
  });
})();
