// 灯阵图 — self-contained tier-2 panel. Renders the nine-lantern array and
// listens for panel events ({writes:[{path,value}]}) from the room hooks:
// a write to `信物` lights that many ring lanterns (visual progress echo).
(function () {
  const NAMES = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const root = document.getElementById('array');
  const cells = NAMES.map((n, i) => {
    const div = document.createElement('div');
    div.className = 'lantern';
    div.innerHTML = '<div class="num">' + n + '</div><div>潮纹</div>';
    root.appendChild(div);
    return div;
  });
  function applyWrites(writes) {
    for (const w of writes || []) {
      const path = String((w && w.path) || '');
      if (path.endsWith('信物')) {
        const lit = Math.max(0, Math.min(9, Number(w.value) || 0));
        cells.forEach((c, i) => c.classList.toggle('lit', i < lit));
      }
    }
  }
  function onEvent(payload) { applyWrites(payload && payload.writes); }
  // Host bridge: the rich-client tier-2 host delivers panel_event payloads via
  // postMessage; accept both a bare payload and a {panelEvent} envelope.
  window.addEventListener('message', (ev) => {
    const d = ev && ev.data;
    if (!d) return;
    onEvent(d.panelEvent || d);
  });
})();
