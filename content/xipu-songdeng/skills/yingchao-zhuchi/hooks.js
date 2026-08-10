// 迎潮节主持 hooks: a slow-rising "tide sense" meter for the whole table, and a
// visible omen badge whenever the dice turn against someone.
//
// F20 (2026-08-07): this counter used to live in `globalThis.__xipuTurns`, which reset
// every single turn — the sandbox is rebuilt per turn — so the meter read 1/40 for a
// whole six-hour session without ever erroring. Durable state belongs to the engine:
// `incvar` goes out through the effect buffer, gets validated and clamped, and persists.
// See docs/plugins.md, Layer C.1 ("globalThis lives for ONE turn").
on('turn_start', () => {
  incvar('潮感', 1);
  const t = Math.min(Number(getvar('潮感')) || 0, 40);
  emitUI([{ kind: 'meter', label: '潮感', value: t, min: 0, max: 40 }], { panel: 'sidebar', id: 'xipu-tide-sense' });
});
on('dice_rolled', (e) => {
  const rolls = (e && e.rolls) || [];
  for (const r of rolls) {
    const text = String((r && r.result) || '');
    if (text.indexOf('大失败') >= 0 || text.indexOf('逆潮') >= 0 || text.indexOf('Fumble') >= 0) {
      emitUI([{ kind: 'badge', label: '海在听', tone: 'danger' }], { panel: 'inline' });
      return;
    }
  }
});
