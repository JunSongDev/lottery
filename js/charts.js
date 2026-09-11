/* ============================================================
 * charts.js — 轻量图表渲染（DOM + SVG，无第三方依赖）
 * 全局命名空间：window.Charts
 * ============================================================ */
(function (root) {
  'use strict';

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function fmt(v, digits) {
    if (v == null || isNaN(v)) return '-';
    if (digits != null) return v.toFixed(digits);
    if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString();
    if (Math.abs(v) >= 10) return v.toFixed(1).replace(/\.0$/, '');
    return v.toFixed(2).replace(/\.?0+$/, '');
  }

  /* ---------------- 纵向柱状图 ---------------- */

  function vbars(container, items, opts) {
    opts = opts || {};
    clear(container);
    var wrap = el('div', 'ch-vbars');
    var max = opts.max || Math.max.apply(null, items.map(function (x) { return x.value; }).concat([1]));
    var showLabelEvery = opts.labelEvery || Math.ceil(items.length / 14);

    items.forEach(function (it, i) {
      var col = el('div', 'ch-vbar-col');
      var barWrap = el('div', 'ch-vbar-wrap');
      var bar = el('div', 'ch-vbar');
      var h = Math.max((it.value / max) * 100, it.value > 0 ? 1.5 : 0);
      bar.style.height = h + '%';
      if (it.color) bar.style.background = it.color;
      if (it.highlight) bar.classList.add('is-highlight');
      barWrap.appendChild(bar);
      barWrap.title = it.label + '：' + fmt(it.value) + (it.suffix || '');
      col.appendChild(barWrap);

      var lab = el('div', 'ch-vbar-label', i % showLabelEvery === 0 ? it.label : '');
      col.appendChild(lab);
      wrap.appendChild(col);

      if (it.expect != null) {
        var mark = el('div', 'ch-vbar-expect');
        var eh = Math.min((it.expect / max) * 100, 100);
        mark.style.bottom = eh + '%';
        barWrap.appendChild(mark);
      }
    });

    container.appendChild(wrap);
    if (opts.legend) {
      var lg = el('div', 'ch-legend');
      opts.legend.forEach(function (x) {
        lg.appendChild(el('span', 'ch-legend-item',
          '<i style="background:' + x.color + '"></i>' + x.label));
      });
      container.appendChild(lg);
    }
    return wrap;
  }

  /* ---------------- 横向条形图 ---------------- */

  function hbars(container, items, opts) {
    opts = opts || {};
    clear(container);
    var wrap = el('div', 'ch-hbars');
    var max = opts.max || Math.max.apply(null, items.map(function (x) { return Math.abs(x.value); }).concat([1]));

    items.forEach(function (it) {
      var row = el('div', 'ch-hbar-row');
      var left = el('div', 'ch-hbar-label', it.label);
      if (it.labelClass) left.classList.add(it.labelClass);
      var track = el('div', 'ch-hbar-track');
      var bar = el('div', 'ch-hbar-fill');
      bar.style.width = Math.max((Math.abs(it.value) / max) * 100, 1) + '%';
      if (it.color) bar.style.background = it.color;
      track.appendChild(bar);
      if (it.expectLine != null) {
        var mk = el('div', 'ch-hbar-expect');
        mk.style.left = Math.min((it.expectLine / max) * 100, 100) + '%';
        track.appendChild(mk);
      }
      var val = el('div', 'ch-hbar-value', it.display != null ? it.display : fmt(it.value, opts.digits));
      row.appendChild(left); row.appendChild(track); row.appendChild(val);
      wrap.appendChild(row);
    });

    container.appendChild(wrap);
    if (opts.legend) {
      var lg = el('div', 'ch-legend');
      opts.legend.forEach(function (x) {
        lg.appendChild(el('span', 'ch-legend-item',
          '<i style="background:' + x.color + '"></i>' + x.label));
      });
      container.appendChild(lg);
    }
    return wrap;
  }

  /* ---------------- SVG 折线图 ---------------- */

  function line(container, series, opts) {
    opts = opts || {};
    clear(container);
    var cw = container.clientWidth || 0;
    var W = opts.width || (cw > 40 ? cw : 640);
    var H = opts.height || 200;
    var pad = { l: 38, r: 12, t: 14, b: 24 };
    var all = [];
    series.forEach(function (s) { all = all.concat(s.values); });
    if (!all.length) return null;
    var min = opts.min != null ? opts.min : Math.min.apply(null, all);
    var max = opts.max != null ? opts.max : Math.max.apply(null, all);
    if (max === min) { max = min + 1; }
    var span = max - min;
    min -= span * 0.08; max += span * 0.08;
    span = max - min;

    var iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    var n = Math.max.apply(null, series.map(function (s) { return s.values.length; }));

    function X(i) { return pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw); }
    function Y(v) { return pad.t + ih - ((v - min) / span) * ih; }

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'ch-svg');

    // 网格与 Y 轴刻度
    var ticks = 4;
    for (var t = 0; t <= ticks; t++) {
      var v = min + (span * t / ticks);
      var y = Y(v);
      var gl = document.createElementNS(svg.namespaceURI, 'line');
      gl.setAttribute('x1', pad.l); gl.setAttribute('x2', W - pad.r);
      gl.setAttribute('y1', y); gl.setAttribute('y2', y);
      gl.setAttribute('class', 'ch-grid');
      svg.appendChild(gl);
      var tx = document.createElementNS(svg.namespaceURI, 'text');
      tx.setAttribute('x', pad.l - 6); tx.setAttribute('y', y + 3.5);
      tx.setAttribute('text-anchor', 'end');
      tx.setAttribute('class', 'ch-axis-text');
      tx.textContent = fmt(v, opts.digits);
      svg.appendChild(tx);
    }

    if (opts.baseline != null) {
      var bl = document.createElementNS(svg.namespaceURI, 'line');
      bl.setAttribute('x1', pad.l); bl.setAttribute('x2', W - pad.r);
      bl.setAttribute('y1', Y(opts.baseline)); bl.setAttribute('y2', Y(opts.baseline));
      bl.setAttribute('class', 'ch-baseline');
      svg.appendChild(bl);
      var bt = document.createElementNS(svg.namespaceURI, 'text');
      bt.setAttribute('x', W - pad.r); bt.setAttribute('y', Y(opts.baseline) - 4);
      bt.setAttribute('text-anchor', 'end');
      bt.setAttribute('class', 'ch-baseline-text');
      bt.textContent = opts.baselineLabel || '随机基线';
      svg.appendChild(bt);
    }

    series.forEach(function (s) {
      var d = '';
      s.values.forEach(function (v, i) {
        d += (i === 0 ? 'M' : 'L') + X(i).toFixed(2) + ' ' + Y(v).toFixed(2) + ' ';
      });
      var p = document.createElementNS(svg.namespaceURI, 'path');
      p.setAttribute('d', d.trim());
      p.setAttribute('class', 'ch-line');
      if (s.color) p.setAttribute('stroke', s.color);
      if (s.dash) p.setAttribute('stroke-dasharray', s.dash);
      svg.appendChild(p);
      if (opts.dots && s.values.length <= 120) {
        s.values.forEach(function (v, i) {
          var c = document.createElementNS(svg.namespaceURI, 'circle');
          c.setAttribute('cx', X(i)); c.setAttribute('cy', Y(v)); c.setAttribute('r', 2.2);
          c.setAttribute('class', 'ch-dot');
          if (s.color) c.setAttribute('fill', s.color);
          svg.appendChild(c);
        });
      }
    });

    if (opts.xLabels && opts.xLabels.length) {
      var step = Math.ceil(opts.xLabels.length / 6);
      opts.xLabels.forEach(function (lb, i) {
        if (i % step !== 0) return;
        var t2 = document.createElementNS(svg.namespaceURI, 'text');
        t2.setAttribute('x', X(i)); t2.setAttribute('y', H - 6);
        t2.setAttribute('text-anchor', 'middle');
        t2.setAttribute('class', 'ch-axis-text');
        t2.textContent = lb;
        svg.appendChild(t2);
      });
    }

    var box = el('div', 'ch-svg-box');
    box.appendChild(svg);
    container.appendChild(box);

    if (opts.legend !== false && series.length > 1) {
      var lg = el('div', 'ch-legend');
      series.forEach(function (s) {
        lg.appendChild(el('span', 'ch-legend-item',
          '<i style="background:' + (s.color || '#888') + '"></i>' + s.name));
      });
      container.appendChild(lg);
    }
    return svg;
  }

  /* ---------------- 号码热力网格 ---------------- */

  function heat(container, items, opts) {
    opts = opts || {};
    clear(container);
    var wrap = el('div', 'ch-heat');
    var vals = items.map(function (x) { return x.value; });
    var max = Math.max.apply(null, vals.concat([1]));
    var min = Math.min.apply(null, vals);

    items.forEach(function (it) {
      var cell = el('div', 'ch-heat-cell' + (it.ball === 'special' ? ' is-special' : ''));
      var norm = max === min ? 0.5 : (it.value - min) / (max - min);
      cell.style.setProperty('--heat', norm.toFixed(3));
      if (it.highlight) cell.classList.add('is-top');
      cell.innerHTML = '<b>' + it.label + '</b><span>' + fmt(it.value) + '</span>';
      cell.title = it.title || (it.label + '：' + fmt(it.value));
      wrap.appendChild(cell);
    });
    container.appendChild(wrap);
    if (opts.legend) {
      container.appendChild(el('div', 'ch-heat-legend',
        '<span>少</span><i class="ch-scale"></i><span>多</span>'));
    }
    return wrap;
  }

  root.Charts = { vbars: vbars, hbars: hbars, line: line, heat: heat, el: el, clear: clear, fmt: fmt };
})(window);
