(function () {
  const { getAudioCtx, buildJackRow } = Bodular.lib;

  Bodular.registerModule('mult', {
    name: 'Mult', hp: 8,
    build(instance) {
      const ctx = getAudioCtx();
      const pass = ctx.createGain();
      pass.gain.value = 1;
      instance.inputs = { in: pass };
      instance.outputs = { out1: pass, out2: pass, out3: pass };

      const hint = document.createElement('div');
      hint.className = 'bodular-module-hint';
      hint.textContent = 'Passive splitter — duplicates one signal to three jacks';

      const jackRows = document.createElement('div');
      jackRows.className = 'bodular-jack-rows';
      const inRow = buildJackRow(instance.id, 'in', 'in', 'IN');
      const o1 = buildJackRow(instance.id, 'out1', 'out', 'OUT 1');
      const o2 = buildJackRow(instance.id, 'out2', 'out', 'OUT 2');
      const o3 = buildJackRow(instance.id, 'out3', 'out', 'OUT 3');
      jackRows.appendChild(inRow.row);
      jackRows.appendChild(o1.row);
      jackRows.appendChild(o2.row);
      jackRows.appendChild(o3.row);

      instance.bodyEl.appendChild(hint);
      instance.bodyEl.appendChild(jackRows);
      instance.jacks = {
        in: { dir: 'in', el: inRow.jackEl },
        out1: { dir: 'out', el: o1.jackEl },
        out2: { dir: 'out', el: o2.jackEl },
        out3: { dir: 'out', el: o3.jackEl },
      };
    },
    cleanup(instance) { try { instance.outputs.out1.disconnect(); } catch (e) {} },
  });
})();
