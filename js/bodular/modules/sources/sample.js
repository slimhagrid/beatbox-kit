(function () {
  const { getAudioCtx, buildKnobDom, bindKnob, buildJackRow, makeTriggerInput, fmtPct, fmtX } = Bodular.lib;

  Bodular.registerModule('sample', {
    name: 'Sample Player', hp: 20,
    build(instance) {
      const ctx = getAudioCtx();
      const trimGain = ctx.createGain();
      trimGain.gain.value = 1;
      instance.inputs = {};
      instance.outputs = { out: trimGain };
      instance.buffer = null;
      instance.speed = 1;
      instance.loop = false;
      instance.currentLoopSource = null;

      const controls = document.createElement('div');
      controls.className = 'bodular-module-controls';
      controls.style.flexDirection = 'column';
      controls.style.width = '100%';

      const uploadId = `bodular-file-${instance.id}`;
      const upload = document.createElement('div');
      upload.className = 'bodular-sample-upload';
      upload.innerHTML = `<div class="bodular-sample-filename">Drop or click to load sample</div>`;
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'audio/*';
      fileInput.style.display = 'none';
      fileInput.id = uploadId;

      const filenameEl = upload.querySelector('.bodular-sample-filename');

      function loadFile(file) {
        const reader = new FileReader();
        reader.onload = () => {
          getAudioCtx().decodeAudioData(reader.result).then((buf) => {
            instance.buffer = buf;
            filenameEl.textContent = file.name;
            playBtn.disabled = false;
          }).catch(() => { filenameEl.textContent = 'Could not decode file'; });
        };
        reader.readAsArrayBuffer(file);
      }

      upload.addEventListener('click', () => fileInput.click());
      upload.addEventListener('dragover', (e) => { e.preventDefault(); upload.classList.add('dragging'); });
      upload.addEventListener('dragleave', () => upload.classList.remove('dragging'));
      upload.addEventListener('drop', (e) => {
        e.preventDefault();
        upload.classList.remove('dragging');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('audio/')) loadFile(file);
      });
      fileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) loadFile(e.target.files[0]);
        e.target.value = '';
      });

      const playBtn = document.createElement('button');
      playBtn.className = 'bodular-play-btn';
      playBtn.textContent = '▶ PLAY';
      playBtn.disabled = true;

      function trigger() {
        if (!instance.buffer) return;
        const ac = getAudioCtx();
        if (instance.loop) {
          if (instance.currentLoopSource) {
            instance.currentLoopSource.stop();
            instance.currentLoopSource = null;
            playBtn.classList.remove('playing');
            playBtn.textContent = '▶ PLAY';
            return;
          }
          const src = ac.createBufferSource();
          src.buffer = instance.buffer;
          src.loop = true;
          src.playbackRate.value = instance.speed;
          src.connect(trimGain);
          src.start(0);
          instance.currentLoopSource = src;
          playBtn.classList.add('playing');
          playBtn.textContent = '■ STOP';
        } else {
          const src = ac.createBufferSource();
          src.buffer = instance.buffer;
          src.playbackRate.value = instance.speed;
          src.connect(trimGain);
          src.start(0);
          src.onended = () => { try { src.disconnect(); } catch (e) {} };
        }
      }
      playBtn.addEventListener('click', trigger);
      const trigDetector = makeTriggerInput(() => trigger());
      instance.cleanupExtra = () => {
        if (instance.currentLoopSource) { try { instance.currentLoopSource.stop(); } catch (e) {} }
        trigDetector.stop();
      };

      const loopRow = document.createElement('label');
      loopRow.className = 'bodular-loop-toggle';
      loopRow.innerHTML = `<input type="checkbox"> Loop`;
      loopRow.querySelector('input').addEventListener('change', (e) => {
        instance.loop = e.target.checked;
        if (!instance.loop && instance.currentLoopSource) {
          instance.currentLoopSource.stop();
          instance.currentLoopSource = null;
          playBtn.classList.remove('playing');
          playBtn.textContent = '▶ PLAY';
        }
      });

      const knobRow = document.createElement('div');
      knobRow.style.display = 'flex';
      knobRow.style.justifyContent = 'center';
      knobRow.style.width = '100%';
      knobRow.style.gap = '10px';
      const speedKnob = buildKnobDom('Speed');
      const levelKnob = buildKnobDom('Level');
      knobRow.appendChild(speedKnob);
      knobRow.appendChild(levelKnob);

      controls.appendChild(upload);
      controls.appendChild(playBtn);
      controls.appendChild(loopRow);
      controls.appendChild(knobRow);

      const jackRows = document.createElement('div');
      jackRows.className = 'bodular-jack-rows';
      const trigRow = buildJackRow(instance.id, 'trig', 'in', 'TRIG', 'cv');
      const { row, jackEl } = buildJackRow(instance.id, 'out', 'out', 'OUT');
      jackRows.appendChild(trigRow.row);
      jackRows.appendChild(row);

      instance.bodyEl.appendChild(controls);
      instance.bodyEl.appendChild(jackRows);
      instance.el.appendChild(fileInput);
      instance.inputs = { trig: trigDetector.node };
      instance.jacks = { trig: { dir: 'in', el: trigRow.jackEl }, out: { dir: 'out', el: jackEl } };

      bindKnob(speedKnob, { min: 0.5, max: 2, initial: 1, format: fmtX, onChange: (v) => { instance.speed = v; } });
      bindKnob(levelKnob, { min: 0, max: 1.5, initial: 1, format: fmtPct, onChange: (v) => { trimGain.gain.value = v; } });
    },
    cleanup(instance) {
      if (instance.cleanupExtra) instance.cleanupExtra();
      try { instance.outputs.out.disconnect(); } catch (e) {}
    },
  });
})();
