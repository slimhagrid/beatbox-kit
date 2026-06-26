(function () {
  const { getAudioCtx, buildKnobDom, bindKnob, buildJackRow, fmtPct } = Bodular.lib;

  const NOISE_TYPES = ['white', 'pink', 'brown'];

  function generateNoiseBuffer(ctx, type) {
    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    if (type === 'pink') {
      // Paul Kellet's refined pink noise filter
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;
        data[i] = pink * 0.11;
      }
    } else if (type === 'brown') {
      // random walk integration, normalized to avoid runaway drift
      let lastOut = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        lastOut = (lastOut + 0.02 * white) / 1.02;
        data[i] = lastOut * 3.5;
      }
    } else {
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  Bodular.registerModule('noise', {
    name: 'Noise', hp: 16,
    build(instance) {
      const ctx = getAudioCtx();
      const buffers = {
        white: generateNoiseBuffer(ctx, 'white'),
        pink: generateNoiseBuffer(ctx, 'pink'),
        brown: generateNoiseBuffer(ctx, 'brown'),
      };
      const outGain = ctx.createGain();
      outGain.gain.value = 0.5;
      instance.inputs = {};
      instance.outputs = { out: outGain };
      instance.noiseSource = null;
      instance.noiseType = 'white';

      function startSource() {
        const src = ctx.createBufferSource();
        src.buffer = buffers[instance.noiseType];
        src.loop = true;
        src.connect(outGain);
        src.start(0);
        instance.noiseSource = src;
      }

      const topControls = document.createElement('div');
      topControls.className = 'bodular-module-top';

      const typeBtn = document.createElement('button');
      typeBtn.className = 'bodular-toggle-btn full';
      typeBtn.textContent = 'WHITE';
      let typeIdx = 0;
      typeBtn.addEventListener('click', () => {
        typeIdx = (typeIdx + 1) % NOISE_TYPES.length;
        instance.noiseType = NOISE_TYPES[typeIdx];
        typeBtn.textContent = instance.noiseType.toUpperCase();
        if (instance.noiseSource) {
          instance.noiseSource.stop();
          startSource();
        }
      });

      const enableBtn = document.createElement('button');
      enableBtn.className = 'bodular-play-btn';
      enableBtn.textContent = '▶';
      enableBtn.addEventListener('click', () => {
        if (instance.noiseSource) {
          instance.noiseSource.stop();
          instance.noiseSource = null;
          enableBtn.classList.remove('playing');
          enableBtn.textContent = '▶';
        } else {
          startSource();
          enableBtn.classList.add('playing');
          enableBtn.textContent = '■';
        }
      });

      const centerControls = document.createElement('div');
      centerControls.className = 'bodular-module-center';
      const levelKnob = buildKnobDom('Level');
      centerControls.appendChild(levelKnob);

      topControls.appendChild(typeBtn);
      topControls.appendChild(enableBtn);

      const jackRows = document.createElement('div');
      jackRows.className = 'bodular-jack-rows';
      const outRow = buildJackRow(instance.id, 'out', 'out', 'OUT');
      jackRows.appendChild(outRow.row);

      instance.bodyEl.appendChild(topControls);
      instance.bodyEl.appendChild(centerControls);
      instance.bodyEl.appendChild(jackRows);
      instance.jacks = { out: { dir: 'out', el: outRow.jackEl } };

      bindKnob(levelKnob, { min: 0, max: 1, initial: 0.5, format: fmtPct, onChange: (v) => { outGain.gain.value = v; } });
    },
    cleanup(instance) {
      if (instance.noiseSource) { try { instance.noiseSource.stop(); } catch (e) {} }
      try { instance.outputs.out.disconnect(); } catch (e) {}
    },
  });
})();
