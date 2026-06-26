(function () {
  const { getAudioCtx, buildKnobDom, bindKnob, buildJackRow, makeTriggerInput } = Bodular.lib;

  Bodular.registerModule('arp', {
    name: 'Arpeggiator', hp: 24,
    build(instance) {
      const ctx = getAudioCtx();
      const output = ctx.createGain();
      output.gain.value = 1;
      const inGains = [0, 1, 2, 3].map(() => {
        const g = ctx.createGain();
        g.gain.value = 0;
        g.connect(output);
        return g;
      });
      instance.outputs = { out: output };
      instance.steps = 4;
      instance.mode = 'up';
      instance.currentStep = 0;
      instance.pingDir = 1;

      const leds = [];
      function applyStep() {
        inGains.forEach((g, i) => { g.gain.value = (i === instance.currentStep) ? 1 : 0; });
        leds.forEach((led, i) => led.classList.toggle('on', i === instance.currentStep));
      }
      function advance() {
        const n = Math.max(1, Math.min(4, Math.round(instance.steps)));
        if (n <= 1) { instance.currentStep = 0; applyStep(); return; }
        if (instance.mode === 'up') {
          instance.currentStep = (instance.currentStep + 1) % n;
        } else if (instance.mode === 'down') {
          instance.currentStep = (instance.currentStep - 1 + n) % n;
        } else if (instance.mode === 'ping') {
          let next = instance.currentStep + instance.pingDir;
          if (next >= n) { instance.pingDir = -1; next = n > 1 ? n - 2 : 0; }
          else if (next < 0) { instance.pingDir = 1; next = n > 1 ? 1 : 0; }
          instance.currentStep = next;
        } else {
          instance.currentStep = Math.floor(Math.random() * n);
        }
        applyStep();
      }

      const trigDetector = makeTriggerInput(advance);
      const forceDetector = makeTriggerInput(advance);
      instance.inputs = {
        trig: trigDetector.node, force: forceDetector.node,
        in1: inGains[0], in2: inGains[1], in3: inGains[2], in4: inGains[3],
      };
      instance.cleanupExtra = () => { trigDetector.stop(); forceDetector.stop(); };

      const topControls = document.createElement('div');
      topControls.className = 'bodular-module-top';

      const btnRow = document.createElement('div');
      btnRow.style.display = 'flex';
      btnRow.style.gap = '8px';
      btnRow.style.width = '100%';

      const modeBtn = document.createElement('button');
      modeBtn.className = 'bodular-toggle-btn';
      modeBtn.style.width = 'auto';
      modeBtn.style.flex = '1';
      modeBtn.textContent = 'UP';
      const modes = ['up', 'down', 'ping', 'rand'];
      let modeIdx = 0;
      modeBtn.addEventListener('click', () => {
        modeIdx = (modeIdx + 1) % modes.length;
        instance.mode = modes[modeIdx];
        modeBtn.textContent = modes[modeIdx].toUpperCase();
      });

      const stepBtn = document.createElement('button');
      stepBtn.className = 'bodular-toggle-btn';
      stepBtn.style.width = 'auto';
      stepBtn.style.flex = '1';
      stepBtn.textContent = 'STEP ▸';
      stepBtn.addEventListener('click', advance);

      btnRow.appendChild(modeBtn);
      btnRow.appendChild(stepBtn);
      topControls.appendChild(btnRow);

      const centerControls = document.createElement('div');
      centerControls.className = 'bodular-module-center';

      const ledRow = document.createElement('div');
      ledRow.className = 'bodular-arp-leds';
      ledRow.style.marginBottom = '0';
      for (let i = 0; i < 4; i++) {
        const led = document.createElement('div');
        led.className = 'bodular-clock-led';
        led.style.marginBottom = '0';
        ledRow.appendChild(led);
        leds.push(led);
      }
      applyStep();

      const stepsKnob = buildKnobDom('Steps');
      centerControls.appendChild(ledRow);
      centerControls.appendChild(stepsKnob);

      const jackRows = document.createElement('div');
      jackRows.className = 'bodular-jack-rows';
      const trigRow = buildJackRow(instance.id, 'trig', 'in', 'TRIG', 'cv');
      const forceRow = buildJackRow(instance.id, 'force', 'in', 'FORCE', 'cv');
      jackRows.appendChild(trigRow.row);
      jackRows.appendChild(forceRow.row);

      const ioRow = document.createElement('div');
      ioRow.className = 'bodular-jack-rows';
      ioRow.style.flexDirection = 'row';
      ioRow.style.justifyContent = 'space-between';
      const inRows = [1, 2, 3, 4].map((n) => {
        const r = buildJackRow(instance.id, `in${n}`, 'in', `${n}`);
        r.row.style.flexDirection = 'column';
        ioRow.appendChild(r.row);
        return r;
      });
      const outRow = buildJackRow(instance.id, 'out', 'out', 'OUT');
      outRow.row.style.flexDirection = 'column';
      ioRow.appendChild(outRow.row);

      instance.bodyEl.appendChild(topControls);
      instance.bodyEl.appendChild(centerControls);
      instance.bodyEl.appendChild(jackRows);
      instance.bodyEl.appendChild(ioRow);
      instance.jacks = {
        trig: { dir: 'in', el: trigRow.jackEl },
        force: { dir: 'in', el: forceRow.jackEl },
        in1: { dir: 'in', el: inRows[0].jackEl },
        in2: { dir: 'in', el: inRows[1].jackEl },
        in3: { dir: 'in', el: inRows[2].jackEl },
        in4: { dir: 'in', el: inRows[3].jackEl },
        out: { dir: 'out', el: outRow.jackEl },
      };

      bindKnob(stepsKnob, { min: 1, max: 4, initial: 4, format: (v) => String(Math.round(v)), onChange: (v) => { instance.steps = Math.round(v); } });
    },
    cleanup(instance) {
      if (instance.cleanupExtra) instance.cleanupExtra();
      try { instance.outputs.out.disconnect(); } catch (e) {}
    },
  });
})();
