// 安土主持 hooks: keep the module's day/window counters in lockstep with the
// game clock (clock_advanced), warn the table when the dormancy window runs
// down or the belt nears saturation, and show a dread badge when the dice
// turn against someone (决口/大失败).
on('clock_advanced', (e) => {
  const m = /(\d+)\s*(?:天|日|day|days|d)/i.exec(String((e && e.delta) || ''));
  if (!m) return;
  const n = parseInt(m[1], 10);
  if (!(n > 0)) return;
  incvar('day', n);
  const w = Number(getvar('window_days'));
  if (!isNaN(w)) setvar('window_days', Math.max(0, w - n));
});
on('variables_changed', (e) => {
  const writes = (e && e.writes) || [];
  for (const w of writes) {
    const path = String((w && w.path) || '');
    if (path.endsWith('window_days')) {
      const v = Number(w.value);
      if (v > 0 && v <= 10) {
        emitUI([{ kind: 'badge', label: '窗口将闭', tone: 'warn' }], { panel: 'inline' });
      }
    }
    if (path.endsWith('belt_load')) {
      const v = Number(w.value);
      if (v >= 10) {
        emitUI([{ kind: 'badge', label: '环带将溢', tone: 'danger' }], { panel: 'inline' });
      }
    }
  }
});
on('dice_rolled', (e) => {
  const rolls = (e && e.rolls) || [];
  for (const r of rolls) {
    const text = String((r && r.result) || '');
    if (text.indexOf('大失败') >= 0 || text.indexOf('决口') >= 0 || text.indexOf('Fumble') >= 0) {
      emitUI([{ kind: 'badge', label: '环带在收', tone: 'danger' }], { panel: 'inline' });
      return;
    }
  }
});
