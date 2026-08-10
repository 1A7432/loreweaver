// 根线图 — self-contained tier-2 panel for 《安土》. Three views:
//   根线  — live six-ward rootline bars, updated by panel_event writes
//          ({writes:[{path,value}]}) from the room hooks.
//   叠映  — the measuring office's three-year overlay (baked public record;
//          read aloud every 丈量日, never looked at). One ward dips — the
//          chart does not say why.
//   测绘  — the ring-forest survey: six old sites' circles vs the 218 arc.
(function () {
  var WARDS = [
    ['rootline_menting', '门庭坊', 22],
    ['rootline_shiyi', '市易坊', 30],
    ['rootline_canglin', '仓廪坊', 41],
    ['rootline_shenjing', '深井坊', 35],
    ['rootline_panqu', '泮渠坊', 100],
    ['rootline_yuxu', '雨恤坊', 18]
  ];
  // Three measuring-day readings, oldest to this year (baked: public record).
  var YEARS = [
    { y: 298, c: '#6b4f2a55', v: [16, 23, 33, 28, 100, 15] },
    { y: 299, c: '#6b4f2a99', v: [19, 26, 37, 31, 100, 16] },
    { y: 300, c: '#4a7a6f', v: [22, 30, 41, 35, 100, 18] }
  ];
  // Ring-forest survey: six abandoned sites (tree counts per circle) and the
  // arc of the 218 exodus (count per arc). Baked.
  var SITES = [
    { n: '第一驻', trees: 47 }, { n: '第二驻', trees: 52 }, { n: '第三驻', trees: 39 },
    { n: '第四驻', trees: 61 }, { n: '第五驻', trees: 55 }, { n: '第六驻', trees: 48 }
  ];
  var ARC = { n: '八百弧', trees: 800 };

  // ---- view: live ward bars ------------------------------------------------
  var wardsEl = document.getElementById('wards');
  var fills = {}, vals = {};
  WARDS.forEach(function (w) {
    var row = document.createElement('div');
    row.className = 'ward' + (w[2] >= 100 ? ' full' : '');
    row.innerHTML = '<div class="nm">' + w[1] + '</div>' +
      '<div class="bar"><div class="fill" style="width:' + w[2] + '%"></div></div>' +
      '<div class="val">' + w[2] + '</div>';
    wardsEl.appendChild(row);
    fills[w[0]] = row.querySelector('.fill');
    vals[w[0]] = row.querySelector('.val');
  });
  var note = document.createElement('div');
  note.className = 'note';
  note.textContent = '丈量日宣读之数。仪表陈旧：读数只在丈量日动。';
  wardsEl.appendChild(note);

  function applyWrites(writes) {
    (writes || []).forEach(function (w) {
      var path = String((w && w.path) || '');
      WARDS.forEach(function (ward) {
        if (path.indexOf(ward[0]) >= 0) {
          var v = Math.max(0, Math.min(100, Number(w.value) || 0));
          fills[ward[0]].style.width = v + '%';
          vals[ward[0]].textContent = String(v);
        }
      });
    });
  }

  // ---- view: three-year overlay -------------------------------------------
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  var over = document.getElementById('oversvg');
  // axes: x = ward (6), y = rootline 0..100
  for (var g = 0; g <= 4; g++) {
    var gy = 230 - g * 50;
    over.appendChild(el('line', { x1: 40, y1: gy, x2: 500, y2: gy, stroke: '#6b4f2a33' }));
  }
  WARDS.forEach(function (w, i) {
    var x = 60 + i * 80;
    over.appendChild(el('text', { x: x, y: 250, 'font-size': 11, fill: '#4a3b26', 'text-anchor': 'middle' }))
      .textContent = w[1];
  });
  YEARS.forEach(function (yr) {
    var pts = yr.v.map(function (v, i) { return (60 + i * 80) + ',' + (230 - v * 2); }).join(' ');
    over.appendChild(el('polyline', { points: pts, fill: 'none', stroke: yr.c, 'stroke-width': yr.y === 300 ? 2.5 : 1.2 }));
    over.appendChild(el('text', { x: 505, y: 230 - yr.v[5] * 2 + 4, 'font-size': 10, fill: yr.c, 'text-anchor': 'end' }))
      .textContent = String(yr.y);
  });

  // ---- view: ring-forest survey -------------------------------------------
  var sur = document.getElementById('surveysvg');
  SITES.forEach(function (s, i) {
    var cx = 70 + i * 76, cy = 90;
    sur.appendChild(el('circle', { cx: cx, cy: cy, r: 26, fill: 'none', stroke: '#4a7a6f', 'stroke-width': 1.5 }));
    sur.appendChild(el('text', { x: cx, y: cy + 4, 'font-size': 11, fill: '#4a3b26', 'text-anchor': 'middle' }))
      .textContent = s.trees + ' 株';
    sur.appendChild(el('text', { x: cx, y: cy + 46, 'font-size': 11, fill: '#4a3b26', 'text-anchor': 'middle' }))
      .textContent = s.n;
  });
  // the 218 arc: a shallow arc under the circles, drawn thick in the fear color
  var arc = el('path', { d: 'M 40 190 Q 260 150 480 190', fill: 'none', stroke: '#c94f74', 'stroke-width': 3 });
  sur.appendChild(arc);
  sur.appendChild(el('text', { x: 260, y: 225, 'font-size': 12, fill: '#c94f74', 'text-anchor': 'middle', 'class': 'accent' }))
    .textContent = ARC.n + '：' + ARC.trees + ' 株，一线排开，没有圈';
  sur.appendChild(el('text', { x: 260, y: 245, 'font-size': 10, fill: '#4a3b26', 'text-anchor': 'middle' }))
    .textContent = '圈是七十年里独走者的数；弧是一个夜里八百人的数。';

  // ---- tabs + host bridge ---------------------------------------------------
  var tabs = document.querySelectorAll('.tabs button');
  tabs.forEach(function (b) {
    b.addEventListener('click', function () {
      tabs.forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('on'); });
      document.getElementById(b.getAttribute('data-v')).classList.add('on');
    });
  });
  function onEvent(payload) { applyWrites(payload && payload.writes); }
  // Host bridge: the rich-client tier-2 host delivers panel_event payloads via
  // postMessage; accept both a bare payload and a {panelEvent} envelope.
  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d) return;
    onEvent(d.panelEvent || d);
  });
})();
