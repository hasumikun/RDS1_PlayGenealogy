/**
 * 유희계보 — app.js
 * 각 row를 SVG로 렌더링:
 * ────/텍스트/   ────/텍스트//텍스트/   ──── (수평선 연속, 아이템에서 사선 꺾임, 뒤에 gap)
 */

const SHEET_ID  = '1ic-5qIn_ysopph5C1H_5LifLIXRtxDOE-iefZ3HqQWQ';
const SHEET_GID = '49384097';
const CSV_URL   = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
const CATEGORY_ORDER_HINT = ['경쟁', '운', '모의', '현기증'];

// 레이아웃 상수
const CELL_W        = 80;
const CELL_W_EMPTY  = 10;
const CELL_GAP      = 4;
const TIMELINE_LEFT_PAD = 80; // 연표 시작 앞 여백 (붉은선 없이 수평선만)
// ROW_H는 렌더 시 동적으로 계산 (4개 row가 뷰포트에 들어오도록)
// 기본값은 fallback용
let ROW_H = 180;
let LINE_Y = ROW_H;
const FONT_SIZE     = 13;
const AFTER_GAP     = 20;   // 아이템 뒤 수평선 끊김 — 고정 너비
const TEXT_PAD      = -8;   // 텍스트를 사선 시작점 왼쪽으로 이동
const TEXT_VPAD     = 4;    // 텍스트를 위로 올리는 여백
const LINE_W        = 0.6;
const STACK_X_OFFSET = 18;

let allItems    = [];
let sortedYears = [];
let minYear = 0, maxYear = 0;
let allYears    = [];
let yearOffsets = {};
let trackTotalW = 0;
let collapsedRanges = []; // [{startX, endX}] — 압축된 구간들

/* ── CSV 파싱 ── */
function parseCSV(text) {
  const rows = [];
  let insideQuote = false, cur = '';
  const fields = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (insideQuote && text[i+1] === '"') { cur += '"'; i++; }
      else insideQuote = !insideQuote;
    } else if (ch === ',' && !insideQuote) {
      fields.push(cur); cur = '';
    } else if ((ch === '\n' || ch === '\r') && !insideQuote) {
      if (ch === '\r' && text[i+1] === '\n') i++;
      fields.push(cur); cur = '';
      rows.push([...fields]); fields.length = 0;
    } else cur += ch;
  }
  if (cur || fields.length) { fields.push(cur); rows.push([...fields]); }
  return rows;
}

function csvToObjects(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).filter(r => r.some(c => c.trim())).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
    return obj;
  });
}

async function fetchData() {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return csvToObjects(parseCSV(await res.text()));
}

/* ── 연도 오프셋 계산 ── */
function buildYearIndex(items) {
  const set = new Set();
  items.forEach(d => { const y = parseInt(d.year); if (!isNaN(y)) set.add(y); });
  sortedYears = [...set].sort((a, b) => a - b);
  minYear = sortedYears[0];
  maxYear = sortedYears[sortedYears.length - 1];
  allYears = [];
  for (let y = minYear; y <= maxYear; y++) allYears.push(y);

  // 연속 공백 묶음 처리
  const dataSet = new Set(sortedYears);
  const GAP_THRESHOLD   = 5;   // 연속 공백이 이 이상이면 묶음 (10년마다 40px 비례)

  collapsedRanges = [];
  let x = TIMELINE_LEFT_PAD; // 앞쪽 여백
  yearOffsets = {};
  let i = 0;
  const total = maxYear - minYear;

  while (i <= total) {
    const y = minYear + i;
    if (dataSet.has(y)) {
      yearOffsets[y] = x;
      x += CELL_W + CELL_GAP;
      i++;
    } else {
      let gapLen = 0;
      while (i + gapLen <= total && !dataSet.has(minYear + i + gapLen)) gapLen++;

      if (gapLen >= GAP_THRESHOLD) {
        const gapStartX = x;
        const collapsedW = Math.ceil(gapLen / 10) * 3; // 10년마다 3px
        for (let j = 0; j < gapLen; j++) {
          yearOffsets[minYear + i + j] = x + (j / gapLen) * collapsedW;
        }
        x += collapsedW + CELL_GAP;
        collapsedRanges.push({ startX: gapStartX, endX: x - CELL_GAP });
      } else {
        for (let j = 0; j < gapLen; j++) {
          yearOffsets[minYear + i + j] = x;
          x += CELL_W_EMPTY + CELL_GAP;
        }
      }
      i += gapLen;
    }
  }
  trackTotalW = x;
}

function splitProperties(propStr) {
  return (propStr || '').split(/[,\/;]+/).map(s => s.trim()).filter(Boolean);
}

function buildCategories(items) {
  const seen = new Set(), cats = [];
  CATEGORY_ORDER_HINT.forEach(c => { if (!seen.has(c)) { seen.add(c); cats.push(c); } });
  items.forEach(item => splitProperties(item.property).forEach(p => {
    if (!seen.has(p)) { seen.add(p); cats.push(p); }
  }));
  return cats.filter(c => items.some(item => splitProperties(item.property).includes(c)));
}

/* ── SVG 네임스페이스 ── */
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

/**
 * 한 row를 SVG로 그리기 — 2패스
 *
 * 1패스: 텍스트 엘리먼트만 DOM에 붙여 실제 텍스트 너비 측정
 * 2패스: 측정된 너비로 사선/수평선 정확히 그리기
 *
 * 45도 사선 → 텍스트 길이(수평) = 사선의 x 이동량 = 사선의 y 이동량
 * 구조: ────(수평선)────/텍스트/   ────(수평선)────
 *                       ↑사선      ↑gap
 */
function renderRowSVG(catItems, totalW, rowEl) {
  const positioned = [];
  const byYear = {};
  catItems.forEach(item => {
    const y = parseInt(item.year);
    if (isNaN(y)) return;
    if (!byYear[y]) byYear[y] = [];
    byYear[y].push(item);
  });
  sortedYears.forEach(y => {
    if (!byYear[y]) return;
    byYear[y].forEach((item, si) => {
      positioned.push({ item, x: (yearOffsets[y] ?? 0) + si * STACK_X_OFFSET });
    });
  });
  positioned.sort((a, b) => a.x - b.x);

  const hasKorean = (str) => /[\uAC00-\uD7A3\u3130-\u318F]/.test(str);

  function fontAttrsFor(str) {
    return {
      'font-family': "'AdobeMyungjoStd','Apple Myungjo','Noto Serif KR','Times New Roman',serif",
      'font-size': hasKorean(str) ? FONT_SIZE - 1 : FONT_SIZE,
      'font-style': 'normal',
      fill: '#1a1a1a',
    };
  }

  const svgH  = ROW_H * 2;
  const lineY = svgH;
  const svg = svgEl('svg', {
    width: totalW, height: svgH,
    viewBox: `0 0 ${totalW} ${svgH}`,
    style: `position:absolute;bottom:0;left:0;overflow:visible;display:block;pointer-events:none;`
  });
  rowEl.style.position = 'relative';
  rowEl.appendChild(svg);

  function measureText(str) {
    const t = svgEl('text', { ...fontAttrsFor(str), x: -99999, y: lineY });
    t.textContent = str;
    svg.appendChild(t);
    const w = t.getComputedTextLength() * 0.92;
    svg.removeChild(t);
    return w;
  }

  // ── 1패스: 텍스트 너비 측정 + 줄바꿈 계산 ──
  const MAX_DIAG = ROW_H;

  const measured = positioned.map(({ item, x: itemX }) => {
    const fullName = item.name || '—';
    const words = fullName.split(' ');
    const fullW = measureText(fullName);

    if (fullW <= MAX_DIAG || words.length <= 1) {
      return { item, itemX, lines: [fullName], diagLen: fullW };
    }

    // 단어 배열을 MAX_DIAG 이하로 줄 단위로 분리 (최대 3줄)
    function splitLines(wordArr) {
      if (wordArr.length <= 1) return [wordArr.join(' ')];
      let bestSplit = 1;
      for (let s = 1; s < wordArr.length; s++) {
        const w = measureText(wordArr.slice(0, s).join(' '));
        if (w <= MAX_DIAG) bestSplit = s;
      }
      const line1 = wordArr.slice(0, bestSplit).join(' ');
      const rest  = wordArr.slice(bestSplit);
      // rest가 MAX_DIAG 초과하면 한 번 더 분리 (최대 2번 재귀 → 3줄)
      if (rest.length > 1 && measureText(rest.join(' ')) > MAX_DIAG) {
        return [line1, ...splitLines(rest)];
      }
      return [line1, rest.join(' ')];
    }

    const lines = splitLines(words);
    // 사선 길이 = 마지막 줄 기준
    const diagLen = measureText(lines[lines.length - 1]);

    return { item, itemX, lines, diagLen };
  });

  // ── 2패스: 수평선 + 사선 + 텍스트 ──
  let curX = 0; // 수평선 재개 시작점

  measured.forEach(({ item, itemX, lines, diagLen }) => {
    const diagStartX = Math.max(curX, itemX);
    const diagEndX   = diagStartX + diagLen;
    const diagTopY   = lineY - diagLen;
    const gapEndX = diagStartX + AFTER_GAP; // 사선 시작점 기준 고정 gap

    // 수평선: curX → diagStartX
    if (diagStartX > curX) {
      svg.appendChild(svgEl('line', {
        x1: curX, y1: lineY, x2: diagStartX, y2: lineY,
        stroke: '#1a1a1a', 'stroke-width': LINE_W,
        style: 'pointer-events:none;'
      }));
    }

    // 사선
    svg.appendChild(svgEl('line', {
      x1: diagStartX, y1: lineY,
      x2: diagEndX,   y2: diagTopY,
      stroke: '#1a1a1a', 'stroke-width': LINE_W,
      style: 'pointer-events:none;'
    }));

    // 클릭/hover 핸들러 공유용 그룹
    const onCLick = () => openDetail(item);
    const onEnter = (e) => e.currentTarget.setAttribute('opacity', '0.4');
    const onLeave = (e) => e.currentTarget.setAttribute('opacity', '1');

    if (lines.length === 1) {
      const textEl = svgEl('text', {
        ...fontAttrsFor(lines[0]),
        x: diagStartX + TEXT_PAD, y: lineY - TEXT_VPAD,
        transform: `rotate(-45, ${diagStartX + TEXT_PAD}, ${lineY - TEXT_VPAD})`,
        style: 'cursor:pointer;pointer-events:all;'
      });
      textEl.textContent = lines[0];
      textEl.addEventListener('click', onCLick);
      textEl.addEventListener('mouseenter', onEnter);
      textEl.addEventListener('mouseleave', onLeave);
      svg.appendChild(textEl);
    } else {
      const txStart    = diagStartX + TEXT_PAD;
      const txY        = lineY - TEXT_VPAD;
      const lineHeight = FONT_SIZE + 3;

      // <g>로 묶어서 hover/click을 세트로 처리
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('style', 'cursor:pointer;pointer-events:all;');
      g.addEventListener('click', onCLick);
      g.addEventListener('mouseenter', () => g.setAttribute('opacity', '0.4'));
      g.addEventListener('mouseleave', () => g.setAttribute('opacity', '1'));

      lines.forEach((lineText, idx) => {
        const d = (lines.length - 1 - idx) * lineHeight;
        const el = svgEl('text', {
          ...fontAttrsFor(lineText),
          x: txStart - d, y: txY - d,
          transform: `rotate(-45, ${txStart}, ${txY})`,
          style: 'pointer-events:all;'
        });
        el.textContent = lineText;
        g.appendChild(el);
      });

      svg.appendChild(g);
    }

    curX = gapEndX; // 항상 AFTER_GAP만큼 끊긴 뒤 재개
  });

  // 마지막 수평선
  if (curX < totalW) {
    svg.appendChild(svgEl('line', {
      x1: curX, y1: lineY, x2: totalW, y2: lineY,
      stroke: '#1a1a1a', 'stroke-width': LINE_W,
      style: 'pointer-events:none;'
    }));
  }
}

/* ── 메인 렌더 ── */
function render(items) {
  const headerH  = document.querySelector('.site-header')?.offsetHeight ?? 52;
  const minimapH = 44;
  const availH   = window.innerHeight - headerH - minimapH;
  // 절반 크기: 4개 row가 전체 높이의 절반만 차지
  ROW_H  = Math.floor(availH / 8);
  LINE_Y = ROW_H;

  buildYearIndex(items);
  const container = document.getElementById('timeline-container');
  container.innerHTML = '';

  const categories = buildCategories(items);
  const totalGridH = ROW_H * categories.length;
  // 수직 가운데 배치를 위한 상단 여백
  const topOffset  = Math.floor((availH - totalGridH) / 2);

  const LABEL_PAD = 100;

  const scroller = document.createElement('div');
  scroller.id = 'timeline-scroller';
  scroller.style.cssText = `overflow-x:auto;overflow-y:hidden;width:100%;height:100%;padding-left:${LABEL_PAD}px;padding-top:${topOffset}px;`;
  container.appendChild(scroller);

  const grid = document.createElement('div');
  grid.className = 'timeline-grid';
  grid.style.cssText = `width:${trackTotalW}px;position:relative;`;
  scroller.appendChild(grid);

  categories.forEach((cat, catIdx) => {
    const row = document.createElement('div');
    row.className = 'timeline-row';
    row.style.cssText = `width:${trackTotalW}px;height:${ROW_H}px;position:relative;overflow:visible;`;

    // 먼저 DOM에 붙이고 renderRowSVG 호출 — getComputedTextLength가 DOM 부착 후에만 동작
    grid.appendChild(row);

    const catItems = items.filter(item => splitProperties(item.property).includes(cat));
    renderRowSVG(catItems, trackTotalW, row);
  });

  // ── 속성 레이블 (fixed, 화면 왼쪽 고정) ──
  buildCategoryLabels(categories, container, LABEL_PAD, topOffset);

  // ── 세로선 오버레이 (100년 기준 + 압축 구간 촘촘한 선) ──
  buildVerticalLines(grid, categories.length, topOffset);

  buildMinimap(scroller, allYears);
}

/* ── 속성 레이블 (화면 왼쪽 fixed 고정, 연표 시작점 왼쪽 여백에 배치) ── */
function buildCategoryLabels(categories, container, labelPad, topOffset) {
  document.getElementById('cat-labels')?.remove();

  const headerH = document.querySelector('.site-header')?.offsetHeight ?? 52;
  const wrapper = document.createElement('div');
  wrapper.id = 'cat-labels';
  wrapper.style.cssText = `
    position:fixed; left:0; top:${headerH}px;
    width:${labelPad}px;
    z-index:50; pointer-events:none;
  `;

  categories.forEach((cat, i) => {
    const label = document.createElement('div');
    label.style.cssText = `
      position:absolute;
      top:${topOffset + i * ROW_H + ROW_H - 10}px;
      right:8px;
      font-family:'AdobeMyungjoStd','Apple Myungjo','Noto Serif KR','Times New Roman',serif;
      font-size:13px;
      font-style:normal;
      color:#1a1a1a;
      white-space:nowrap;
      line-height:1;
      background:#ffffff;
      padding:0 0 0 4px;
    `;
    label.textContent = cat;
    wrapper.appendChild(label);
  });

  document.body.appendChild(wrapper);
}

/* ── 세로선 오버레이 ── */
function buildVerticalLines(grid, rowCount, topOffset) {
  const totalH   = rowCount * ROW_H;
  const extendUp = topOffset + 100;
  const extendDn = topOffset + window.innerHeight; // 아래로 화면 높이만큼 연장
  const svgH     = totalH + extendUp + extendDn;

  const svg = svgEl('svg', {
    width:  trackTotalW,
    height: svgH,
    viewBox: `0 0 ${trackTotalW} ${svgH}`,
    style: `position:absolute;top:${-extendUp}px;left:0;pointer-events:none;overflow:visible;z-index:10;`
  });
  grid.appendChild(svg);

  const firstCentury = Math.ceil(minYear / 100) * 100;
  const MIN_LABEL_GAP = 30;
  let lastLabelX = -Infinity;
  let labelCount = 0;

  // 수평선 그룹의 수직 중심 (SVG 좌표 기준)
  const centerY      = extendUp + totalH / 2;
  const LABEL_OFFSET = centerY - extendUp + 40; // 중심에서 위아래로 벌어지는 거리
  const labelYTop    = centerY - LABEL_OFFSET;
  const labelYBottom = centerY + LABEL_OFFSET;

  for (let y = firstCentury; y <= maxYear; y += 100) {
    if (yearOffsets[y] == null) continue;
    const xPos = yearOffsets[y];

    svg.appendChild(svgEl('line', {
      x1: xPos, y1: 0, x2: xPos, y2: svgH,
      stroke: '#c0392b', 'stroke-width': 0.5,
      'stroke-dasharray': '3,4', opacity: 0.7
    }));

    if (xPos - lastLabelX >= MIN_LABEL_GAP) {
      const isTop = labelCount % 2 === 0;
      const labelY = isTop ? labelYTop : labelYBottom;
      const label = svgEl('text', {
        x: xPos + 2, y: labelY,
        'font-family': '"DM Mono",monospace',
        'font-size': 7,
        fill: '#c0392b', opacity: 0.7
      });
      label.textContent = y < 0 ? `BC ${Math.abs(y)}` : String(y);
      svg.appendChild(label);
      lastLabelX = xPos;
      labelCount++;
    }
  }
}

/* ── MINIMAP ── */
function buildMinimap(scroller, years) {
  const bar = document.createElement('div');
  bar.id = 'minimap';
  bar.style.cssText = `
    position:fixed; bottom:0; left:0; right:0; height:44px;
    background:#fff; border-top:0.5px solid #ccc;
    display:flex; align-items:center;
    padding:0 32px; gap:12px; z-index:200;
  `;

  const labelLeft = document.createElement('span');
  labelLeft.style.cssText = 'font-family:"DM Mono",monospace;font-size:0.58rem;color:#999;white-space:nowrap;flex-shrink:0;';
  labelLeft.textContent = years[0] < 0 ? `BC ${Math.abs(years[0])}` : String(years[0]);

  const track = document.createElement('div');
  track.style.cssText = 'flex:1;height:20px;position:relative;cursor:pointer;user-select:none;';

  const thumb = document.createElement('div');
  thumb.style.cssText = `
    position:absolute;top:0;height:100%;
    background:rgba(0,0,0,0.07);border:0.5px solid #ccc;
    cursor:grab;box-sizing:border-box;min-width:16px;
  `;
  track.appendChild(thumb);

  const tooltip = document.createElement('span');
  tooltip.style.cssText = `
    position:absolute;top:-18px;transform:translateX(-50%);
    font-family:"DM Mono",monospace;font-size:0.55rem;color:#1a1a1a;
    background:#fff;border:0.5px solid #ccc;padding:1px 4px;
    pointer-events:none;opacity:0;transition:opacity 0.1s;white-space:nowrap;z-index:10;
  `;
  track.appendChild(tooltip);

  const labelRight = document.createElement('span');
  labelRight.style.cssText = 'font-family:"DM Mono",monospace;font-size:0.58rem;color:#999;white-space:nowrap;flex-shrink:0;';
  labelRight.textContent = years[years.length-1] < 0 ? `BC ${Math.abs(years[years.length-1])}` : String(years[years.length-1]);

  bar.appendChild(labelLeft);
  bar.appendChild(track);
  bar.appendChild(labelRight);
  document.getElementById('timeline-container').appendChild(bar);
  scroller.style.paddingBottom = '52px';

  function updateThumb() {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const scrollMax = scroller.scrollWidth - scroller.clientWidth;
    const ratio     = scrollMax > 0 ? scroller.scrollLeft / scrollMax : 0;
    const viewRatio = Math.min(1, scroller.clientWidth / scroller.scrollWidth);
    const thumbW    = Math.max(16, viewRatio * rect.width);
    thumb.style.width = thumbW + 'px';
    thumb.style.left  = (ratio * (rect.width - thumbW)) + 'px';
  }

  function scrollFromRatio(clientX) {
    const rect  = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    scroller.scrollLeft = ratio * (scroller.scrollWidth - scroller.clientWidth);
  }

  let dragging = false;
  track.addEventListener('mousedown', e => { dragging = true; thumb.style.cursor = 'grabbing'; scrollFromRatio(e.clientX); });
  window.addEventListener('mousemove', e => {
    if (dragging) { scrollFromRatio(e.clientX); return; }
    const rect = track.getBoundingClientRect();
    if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
      const ratio = (e.clientX - rect.left) / rect.width;
      const y = Math.round(minYear + ratio * (maxYear - minYear));
      tooltip.textContent = y < 0 ? `BC ${Math.abs(y)}` : String(y);
      tooltip.style.left    = (e.clientX - rect.left) + 'px';
      tooltip.style.opacity = '1';
    } else {
      tooltip.style.opacity = '0';
    }
  });
  window.addEventListener('mouseup', () => { dragging = false; thumb.style.cursor = 'grab'; });
  track.addEventListener('touchstart', e => { dragging = true; scrollFromRatio(e.touches[0].clientX); }, { passive: true });
  window.addEventListener('touchmove', e => { if (dragging) scrollFromRatio(e.touches[0].clientX); }, { passive: true });
  window.addEventListener('touchend', () => { dragging = false; });

  scroller.addEventListener('scroll', updateThumb);
  window.addEventListener('resize', updateThumb);
  requestAnimationFrame(updateThumb);
}

/* ── DETAIL OVERLAY ── */
function openDetail(item) {
  const overlay = document.getElementById('detail-overlay');
  const imgEl   = document.getElementById('detail-img');
  const imgSrc  = item.image || item['image url'] || item['imageurl'] || item['img'] || '';
  if (imgSrc) { imgEl.src = imgSrc; imgEl.style.display = 'block'; }
  else        { imgEl.style.display = 'none'; }

  document.getElementById('detail-year').textContent     = item.year     || '';
  document.getElementById('detail-location').textContent = item.location || '';
  document.getElementById('detail-name').textContent     = item.name     || '—';
  document.getElementById('detail-desc').textContent     = item.description || '';
  document.getElementById('detail-source').textContent   = item.source ? `출처: ${item.source}` : '';

  const propsEl = document.getElementById('detail-props');
  propsEl.innerHTML = '';
  splitProperties(item.property).forEach(p => {
    const tag = document.createElement('span');
    tag.className = 'prop-tag'; tag.textContent = p;
    propsEl.appendChild(tag);
  });

  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  document.getElementById('detail-overlay').classList.add('hidden');
  document.body.style.overflow = '';
}

document.getElementById('close-btn').addEventListener('click', closeDetail);
document.getElementById('detail-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('detail-overlay')) closeDetail();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });

function showError(message) {
  document.getElementById('timeline-container').innerHTML = `
    <div class="error-state">
      <p>⚠ 데이터를 불러오지 못했습니다.</p>
      <p style="margin-top:8px">${message}</p>
      <p style="margin-top:16px">
        스프레드시트 공유: <strong>링크가 있는 모든 사용자 → 뷰어</strong><br>
        <a href="https://docs.google.com/spreadsheets/d/${SHEET_ID}" target="_blank">스프레드시트 열기 →</a>
      </p>
    </div>`;
}

(async () => {
  try {
    const raw = await fetchData();
    allItems = raw;
    if (!allItems.length) throw new Error('시트에 데이터가 없거나 컬럼 구조를 확인해 주세요.');
    render(allItems);
  } catch (err) {
    console.error(err);
    showError(err.message);
  }
})();