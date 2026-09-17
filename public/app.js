/**
 * Insurance Workflow Regression Lab - frontend.
 *
 * Vanilla ES modules, no build step, no dependencies. Views render to HTML
 * strings and events are handled by delegation, which is enough for an app with
 * four screens and keeps the whole client readable in one sitting.
 *
 * Two presentational rules are load-bearing rather than cosmetic:
 *
 *   1. A simulated number is always labelled simulated, everywhere it appears.
 *      Latency is measured; cost is modelled. The UI is not allowed to blur
 *      that line, because the entire argument of the scorecard depends on
 *      knowing which figures are evidence and which are illustration.
 *
 *   2. An inferred value never looks like a read one. Confidence and extraction
 *      method are shown next to every field, and anything below the abstention
 *      floor is coloured. The regression this lab is built to catch is
 *      invisible precisely because a guess renders the same as a fact.
 */

/** Below this, the pipeline treats a value as not confidently read. Mirrors abstain.js. */
const CONFIDENCE_FLOOR = 0.6;

const state = {
  /** @type {any} */ meta: null,
  view: 'compare',
  versionId: null,
  packetId: null,
  packetTab: 'evidence',
  docId: null,
  /** @type {any} */ selectedSpan: null,
  selectedKey: null,
  baseline: null,
  candidate: null,
  /** @type {any} */ data: null,
  error: null,
  busy: false,
};

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function api(path, init) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body;
}

/* ------------------------------------------------------------------ *
 * Escaping and small formatters
 * ------------------------------------------------------------------ */

/** @param {any} value */
function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** @param {number|null|undefined} n */
function usd(n) {
  if (n == null) return '—';
  return `$${Number(n).toLocaleString('en-US')}`;
}

/** @param {number} n */
function cost(n) {
  return `$${Number(n).toFixed(4)}`;
}

/** @param {number} n */
function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

/** @param {number} ms */
function ms(n) {
  return `${Number(n).toFixed(1)} ms`;
}

/**
 * Render an extracted value the way the scorecard reasons about it: an absence
 * is a claim, not a blank, so it is shown as one.
 *
 * @param {any} v
 */
function value(v) {
  if (v === null || v === undefined) return '<span class="val-null">null</span>';
  if (typeof v === 'number') return esc(v.toLocaleString('en-US'));
  return esc(v);
}

/** @param {number} c */
function confidenceClass(c) {
  if (c < CONFIDENCE_FLOOR) return 'low';
  if (c < 0.9) return 'mid';
  return 'high';
}

/** @param {string} edge */
function edgeBadge(edge) {
  return `<span class="badge edge">${esc(edge.replaceAll('_', ' ').toLowerCase())}</span>`;
}

/** @param {string} decision */
function decisionBadge(decision) {
  return `<span class="badge ${esc(decision)}">${esc(decision)}</span>`;
}

/**
 * Deltas are shown with an explicit direction, and "better" is not always "up":
 * accuracy rising is good, cost rising is not.
 *
 * @param {number} delta
 * @param {(n: number) => string} format
 * @param {'up-good'|'down-good'} polarity
 */
function deltaEl(delta, format, polarity) {
  const flat = Math.abs(delta) < 1e-9;
  const better = polarity === 'up-good' ? delta > 0 : delta < 0;
  const cls = flat ? 'flat' : better ? 'up' : 'down';
  const sign = flat ? '' : delta > 0 ? '+' : '−';
  return `<div class="metric-delta ${cls}">${sign}${esc(format(Math.abs(delta)))}${flat ? ' no change' : ''}</div>`;
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

function readHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [view = 'compare', ...rest] = raw.split('/').filter(Boolean);
  return { view, rest };
}

async function navigate() {
  const { view, rest } = readHash();
  state.error = null;
  state.view = ['compare', 'submissions', 'packet', 'review', 'about'].includes(view)
    ? view
    : 'compare';

  if (state.view === 'packet') {
    const [versionId, packetId] = rest;
    if (versionId) state.versionId = decodeURIComponent(versionId);
    if (packetId) state.packetId = decodeURIComponent(packetId);
  }

  renderShell();
  render(`<div class="loading">Running the corpus&hellip;</div>`);

  try {
    await loadViewData();
  } catch (err) {
    state.error = /** @type {Error} */ (err).message;
  }
  renderView();
}

async function loadViewData() {
  switch (state.view) {
    case 'compare':
      state.data = await api(
        `/api/compare?baseline=${encodeURIComponent(state.baseline)}&candidate=${encodeURIComponent(state.candidate)}`,
      );
      break;
    case 'submissions':
      state.data = await api(`/api/suites/${encodeURIComponent(state.versionId)}`);
      break;
    case 'review':
      state.data = await api(`/api/review-queue/${encodeURIComponent(state.versionId)}`);
      break;
    case 'packet': {
      const [detail, packet] = await Promise.all([
        api(`/api/runs/${encodeURIComponent(state.versionId)}/${encodeURIComponent(state.packetId)}`),
        api(`/api/packets/${encodeURIComponent(state.packetId)}`),
      ]);
      state.data = { ...detail, packet };
      state.docId = packet.documents[0]?.docId ?? null;
      state.selectedSpan = null;
      state.selectedKey = null;
      break;
    }
    default:
      state.data = null;
  }
}

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

/** @param {string} html */
function render(html) {
  document.getElementById('main').innerHTML = html;
}

function renderShell() {
  for (const a of document.querySelectorAll('#nav a')) {
    const view = a.getAttribute('data-view');
    a.classList.toggle('active', view === state.view || (view === 'submissions' && state.view === 'packet'));
  }
}

function renderView() {
  if (state.error) {
    render(`<div class="error"><strong>Something went wrong.</strong><br />${esc(state.error)}</div>`);
    return;
  }

  switch (state.view) {
    case 'compare': return renderCompare();
    case 'submissions': return renderSubmissions();
    case 'packet': return renderPacket();
    case 'review': return renderReview();
    case 'about': return renderAbout();
    default: return renderCompare();
  }
}

/** @param {string} [selected] @param {string} [name] */
function versionSelect(selected, name) {
  const options = state.meta.versions
    .map((v) => `<option value="${esc(v.id)}"${v.id === selected ? ' selected' : ''}>${esc(v.name)}</option>`)
    .join('');
  return `<select data-select="${esc(name ?? 'version')}">${options}</select>`;
}

/* ------------------------------------------------------------------ *
 * Scorecard (the centrepiece)
 * ------------------------------------------------------------------ */

function renderCompare() {
  const { baseline, candidate, diff } = state.data;
  const d = diff.summary.delta;
  const regressed = diff.verdict === 'regressed';

  const verdict = regressed
    ? `<div class="verdict regressed">
         <span class="verdict-mark">REGRESSED</span>
         <div class="verdict-text">
           <strong>${diff.regressions.length} field${diff.regressions.length === 1 ? '' : 's'} that ${esc(baseline.versionName)} got right, ${esc(candidate.versionName)} gets wrong.</strong>
           Overall accuracy is ${d.accuracy >= 0 ? 'up' : 'down'} ${pct(Math.abs(d.accuracy))}, and the release still does not pass.
           A better average does not buy back a field that used to be correct.
         </div>
       </div>`
    : `<div class="verdict clean">
         <span class="verdict-mark">CLEAN</span>
         <div class="verdict-text">
           <strong>No previously-correct field became incorrect.</strong>
           ${diff.improvements.length} field${diff.improvements.length === 1 ? '' : 's'} moved from wrong to right, and nothing moved the other way.
         </div>
       </div>`;

  return render(`
    <div class="view-head">
      <div>
        <h2>Version scorecard</h2>
        <p>
          The same eight synthetic packets, replayed through two workflow versions, scored
          field by field against hand-labelled ground truth. The gate is not the average -
          it is whether any field regressed.
        </p>
      </div>
      <div class="controls">
        <label class="field">Baseline ${versionSelect(baseline.versionId, 'baseline')}</label>
        <label class="field">Candidate ${versionSelect(candidate.versionId, 'candidate')}</label>
      </div>
    </div>

    ${verdict}

    <div class="metrics">
      ${metric('Field accuracy', pct(diff.summary.baseline.accuracy), pct(diff.summary.candidate.accuracy),
        deltaEl(d.accuracy, pct, 'up-good'),
        `${diff.summary.candidate.correct} of ${diff.summary.candidate.total} items`)}

      ${metric('Abstention rate', pct(diff.summary.baseline.abstentionRate), pct(diff.summary.candidate.abstentionRate),
        deltaEl(d.abstentionRate, pct, 'down-good'),
        `${diff.summary.candidate.abstained} of ${diff.summary.candidate.packets} referred to a human`)}

      ${metric('Mean latency', ms(diff.summary.baseline.meanLatencyMs), ms(diff.summary.candidate.meanLatencyMs),
        deltaEl(d.meanLatencyMs, ms, 'down-good'),
        'Measured on a real clock')}

      ${metric('Total cost', cost(diff.summary.baseline.totalCostUsd), cost(diff.summary.candidate.totalCostUsd),
        deltaEl(d.totalCostUsd, cost, 'down-good'),
        '<span class="badge sim">SIMULATED</span> token-equivalent, invented rate')}
    </div>

    <div class="card">
      <h3>Decisions</h3>
      <p class="card-note">
        Identical aggregate numbers can hide completely different behaviour. Two versions can abstain
        at the same rate on entirely different packets, which is why this table is per-decision and the
        one below it is per-packet.
      </p>
      <table>
        <thead><tr><th>Version</th><th class="num">Quote</th><th class="num">Decline</th><th class="num">Referred</th><th class="num">Accuracy</th><th class="num">Cost <span class="badge sim">SIM</span></th></tr></thead>
        <tbody>
          ${decisionRow(baseline, diff.summary.baseline)}
          ${decisionRow(candidate, diff.summary.candidate)}
        </tbody>
      </table>
    </div>

    ${regressionTable(diff.regressions, 'Regressions', 'regression-row',
      'Fields the baseline read correctly and the candidate does not. This list is the release gate: it must be empty.')}

    ${regressionTable(diff.improvements, 'Improvements', 'improvement-row',
      'Fields the candidate fixed. Real gains - and on their own, not a reason to ship.')}

    <div class="card">
      <h3>Per-packet movement</h3>
      <p class="card-note">
        A routing change is not the same as an extraction change. Some rows moved because a
        threshold was edited; some moved because the reading changed. Open a packet to see which.
      </p>
      <table>
        <thead>
          <tr>
            <th>Packet</th>
            <th>${esc(baseline.versionName)}</th>
            <th>${esc(candidate.versionName)}</th>
            <th class="num">Fields</th>
            <th>Flags</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${diff.packets.map(packetDiffRow).join('')}
        </tbody>
      </table>
    </div>

    <div class="grid-2">
      ${versionCard(baseline)}
      ${versionCard(candidate)}
    </div>
  `);
}

/**
 * @param {string} label
 * @param {string} base
 * @param {string} cand
 * @param {string} delta
 * @param {string} foot
 */
function metric(label, base, cand, delta, foot) {
  return `
    <div class="metric">
      <div class="metric-label">${esc(label)}</div>
      <div class="metric-pair">
        <span class="metric-base">${base}</span>
        <span class="metric-arrow">→</span>
        <span class="metric-cand">${cand}</span>
      </div>
      ${delta}
      <div class="metric-foot">${foot}</div>
    </div>`;
}

/** @param {any} suite @param {any} summary */
function decisionRow(suite, summary) {
  return `
    <tr>
      <td>${esc(suite.versionName)}</td>
      <td class="num">${summary.decisions.quote}</td>
      <td class="num">${summary.decisions.decline}</td>
      <td class="num">${summary.decisions.referred}</td>
      <td class="num">${pct(summary.accuracy)}</td>
      <td class="num">${cost(summary.totalCostUsd)}</td>
    </tr>`;
}

/**
 * @param {any[]} rows
 * @param {string} title
 * @param {string} rowClass
 * @param {string} note
 */
function regressionTable(rows, title, rowClass, note) {
  if (!rows.length) {
    return `<div class="card"><h3>${esc(title)}</h3><p class="card-note">${esc(note)}</p><div class="empty">None.</div></div>`;
  }

  return `
    <div class="card">
      <h3>${esc(title)} <span class="faint">(${rows.length})</span></h3>
      <p class="card-note">${esc(note)}</p>
      <table>
        <thead>
          <tr><th>Packet</th><th>Field</th><th>Ground truth</th><th>Baseline</th><th>Candidate</th><th class="num">Conf.</th><th>Method</th></tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr class="${rowClass}">
              <td class="nowrap"><a href="#/packet/${encodeURIComponent(state.candidate)}/${encodeURIComponent(r.packetId)}">${esc(r.packetId)}</a></td>
              <td class="mono">${esc(r.key)}</td>
              <td>${value(r.expected)}</td>
              <td class="${r.baselineCorrect ? 'val-good' : 'val-bad'}">${value(r.baselineValue)}</td>
              <td class="${r.candidateCorrect ? 'val-good' : 'val-bad'}">${value(r.candidateValue)}</td>
              <td class="num conf ${confidenceClass(r.candidateConfidence)}">${r.candidateConfidence.toFixed(2)}</td>
              <td class="method ${r.candidateMethod === 'context-backfill' ? 'inferred' : ''}">${esc(r.candidateMethod)}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

/** @param {any} p */
function packetDiffRow(p) {
  const flagChanges = [
    ...p.flagsAdded.map((id) => `<span class="badge flag">+${esc(id)}</span>`),
    ...p.flagsRemoved.map((id) => `<span class="badge pass">−${esc(id)}</span>`),
  ];

  const moved = p.movedFields.filter((f) => !f.candidateCorrect).length;
  const gained = p.movedFields.filter((f) => f.candidateCorrect).length;

  return `
    <tr>
      <td>
        <strong>${esc(p.packetId)}</strong><br />
        <span class="faint">${esc(p.packetLabel)}</span>
      </td>
      <td>${decisionBadge(p.baseline.decision)}</td>
      <td>${decisionBadge(p.candidate.decision)}${p.routingChanged ? ' <span class="faint">changed</span>' : ''}</td>
      <td class="num">${gained ? `<span class="val-good">+${gained}</span>` : ''}${gained && moved ? ' / ' : ''}${moved ? `<span class="val-bad">−${moved}</span>` : ''}${!gained && !moved ? '<span class="faint">—</span>' : ''}</td>
      <td><div class="inline-list">${flagChanges.join('') || '<span class="faint">—</span>'}</div></td>
      <td class="right nowrap">
        <a href="#/packet/${encodeURIComponent(p.candidate.versionId)}/${encodeURIComponent(p.packetId)}">Open →</a>
      </td>
    </tr>`;
}

/** @param {any} suite */
function versionCard(suite) {
  return `
    <div class="card">
      <h3>${esc(suite.versionName)}</h3>
      <p class="card-note">${esc(suite.versionSummary)}</p>
      <details class="changes">
        <summary>Configuration and changes</summary>
        <ul class="plain">
          ${suite.changes.map((c) => `<li>${esc(c)}</li>`).join('')}
        </ul>
        <ul class="plain">
          <li>Appetite ceiling: ${usd(suite.guidelines.tivCeiling)} <span class="faint">(invented)</span></li>
          <li>Loss ratio ceiling: ${esc(suite.guidelines.lossRatioCeilingPct)}% <span class="faint">(invented)</span></li>
          <li>Effective date horizon: ${esc(suite.guidelines.maxMonthsAhead)} months</li>
          <li>Address matching: ${esc(suite.guidelines.addressMatching)}</li>
        </ul>
      </details>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Submissions
 * ------------------------------------------------------------------ */

function renderSubmissions() {
  const s = state.data;

  return render(`
    <div class="view-head">
      <div>
        <h2>Submissions</h2>
        <p>${esc(s.versionSummary)}</p>
      </div>
      <div class="controls">
        <label class="field">Workflow version ${versionSelect(s.versionId, 'version')}</label>
      </div>
    </div>

    <div class="metrics">
      ${simpleMetric('Packets', String(s.summary.packets))}
      ${simpleMetric('Field accuracy', pct(s.summary.accuracy), `${s.summary.correct} / ${s.summary.total} items`)}
      ${simpleMetric('Abstention rate', pct(s.summary.abstentionRate), `${s.summary.abstained} referred to a human`)}
      ${simpleMetric('Mean latency', ms(s.summary.meanLatencyMs), 'Measured')}
      ${simpleMetric('Total cost', cost(s.summary.totalCostUsd), '<span class="badge sim">SIMULATED</span>')}
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Packet</th><th>Edge cases</th><th>Decision</th>
            <th class="num">Accuracy</th><th class="num">Flags</th><th class="num">Conflicts</th>
            <th class="num">Latency</th><th class="num">Cost <span class="badge sim">SIM</span></th><th>Review</th>
          </tr>
        </thead>
        <tbody>
          ${s.packets
            .map(
              (p) => `
            <tr class="clickable" data-href="#/packet/${encodeURIComponent(s.versionId)}/${encodeURIComponent(p.packetId)}">
              <td><strong>${esc(p.packetId)}</strong><br /><span class="faint">${esc(p.packetLabel)}</span></td>
              <td><div class="inline-list">${p.edgeCases.map(edgeBadge).join('')}</div></td>
              <td>${decisionBadge(p.decision)}</td>
              <td class="num">${pct(p.accuracy)}<br /><span class="faint">${p.correct}/${p.total}</span></td>
              <td class="num">${p.flagCount || '<span class="faint">—</span>'}</td>
              <td class="num">${p.conflictCount || '<span class="faint">—</span>'}</td>
              <td class="num">${ms(p.durationMs)}</td>
              <td class="num">${cost(p.costUsd)}</td>
              <td>${p.review ? `<span class="badge pass">${esc(p.review.decision)}</span>` : '<span class="faint">—</span>'}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `);
}

/** @param {string} label @param {string} val @param {string} [foot] */
function simpleMetric(label, val, foot) {
  return `
    <div class="metric">
      <div class="metric-label">${esc(label)}</div>
      <div class="metric-pair"><span class="metric-cand">${val}</span></div>
      ${foot ? `<div class="metric-foot">${foot}</div>` : ''}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Packet detail
 * ------------------------------------------------------------------ */

function renderPacket() {
  const { run, score, groundTruth, packet } = state.data;

  const tabs = [
    ['evidence', 'Extraction &amp; evidence'],
    ['guidelines', 'Guidelines &amp; conflicts'],
    ['trace', 'Trace'],
  ]
    .map(
      ([id, label]) =>
        `<button data-tab="${id}" class="${state.packetTab === id ? 'active' : ''}">${label}</button>`,
    )
    .join('');

  let body;
  if (state.packetTab === 'guidelines') body = renderGuidelinesTab(run);
  else if (state.packetTab === 'trace') body = renderTraceTab(run);
  else body = renderEvidenceTab(run, score, groundTruth, packet);

  return render(`
    <a class="back-link" href="#/submissions">← All submissions</a>

    <div class="view-head">
      <div>
        <h2>${esc(run.packetId)} · ${esc(run.packetLabel)}</h2>
        <div class="inline-list" style="margin-top:6px">${run.edgeCases.map(edgeBadge).join('')}</div>
      </div>
      <div class="controls">
        <label class="field">Workflow version ${versionSelect(run.versionId, 'version')}</label>
      </div>
    </div>

    <div class="metrics">
      ${simpleMetric('Decision', decisionBadge(run.routing.decision), run.routing.abstained ? 'Referred to human review' : 'Answered without a human')}
      ${simpleMetric('Reconciled insured value', usd(run.fields.computedTiv?.value), `Stated: ${usd(run.fields.statedTiv?.value)}`)}
      ${simpleMetric('Field accuracy', pct(score.accuracy), `${score.correct} / ${score.total} items`)}
      ${simpleMetric('Latency', ms(run.durationMs), 'Measured')}
      ${simpleMetric('Cost', cost(run.cost.usd), `<span class="badge sim">SIMULATED</span> ${run.cost.passes} pass(es)`)}
    </div>

    <div class="doc-tabs">${tabs}</div>
    ${body}
  `);
}

/**
 * @param {any} run
 * @param {any} score
 * @param {any} groundTruth
 * @param {any} packet
 */
function renderEvidenceTab(run, score, groundTruth, packet) {
  const scoreByKey = new Map(score.fields.map((f) => [f.key, f]));

  /** @param {string} key @param {any} f */
  const fieldRow = (key, f) => {
    const sc = scoreByKey.get(key);
    const hasEvidence = Boolean(f?.evidence);
    return `
      <tr class="field-row ${state.selectedKey === key ? 'selected' : ''} ${hasEvidence ? 'clickable' : ''}"
          ${hasEvidence ? `data-evidence="${esc(JSON.stringify(f.evidence))}" data-key="${esc(key)}"` : ''}>
        <td class="mono">${esc(key)}</td>
        <td>${value(f?.value)}</td>
        <td>${sc ? (sc.correct ? '<span class="val-good">✓</span>' : `<span class="val-bad">✗ ${value(sc.expected)}</span>`) : '<span class="faint">—</span>'}</td>
        <td class="num conf ${confidenceClass(f?.confidence ?? 0)}">${(f?.confidence ?? 0).toFixed(2)}</td>
        <td class="method ${f?.method === 'context-backfill' ? 'inferred' : ''}">${esc(f?.method ?? 'not-extracted')}</td>
        <td class="faint">${esc(f?.note ?? '')}</td>
      </tr>`;
  };

  const scalarRows = Object.entries(run.fields)
    .map(([name, f]) => fieldRow(name, f))
    .join('');

  const locationRows = run.resolution.locations
    .map(
      (loc) => `
      <tr><td colspan="6" class="subtle"><strong>${esc(loc.locId)}</strong> · ${esc(loc.fields.address.value ?? 'address not read')}</td></tr>
      ${Object.entries(loc.fields).map(([name, f]) => fieldRow(`${loc.locId}.${name}`, f)).join('')}`,
    )
    .join('');

  const docTabs = packet.documents
    .map(
      (d) =>
        `<button data-doc="${esc(d.docId)}" class="${state.docId === d.docId ? 'active' : ''}">${esc(d.label ?? d.docId)}</button>`,
    )
    .join('');

  const doc = packet.documents.find((d) => d.docId === state.docId) ?? packet.documents[0];

  return `
    <div class="grid-2">
      <div class="card">
        <h3>Extracted values</h3>
        <p class="card-note">
          Click any row to highlight the characters it came from. Confidence and method are shown for
          every field, including the ones reported as <span class="val-null">null</span> - because
          "the form left this blank" and "I could not read this" are different claims, and the
          pipeline records them differently.
        </p>
        <table>
          <thead><tr><th>Field</th><th>Value</th><th>vs truth</th><th class="num">Conf.</th><th>Method</th><th>Note</th></tr></thead>
          <tbody>${scalarRows}${locationRows}</tbody>
        </table>
      </div>

      <div class="card">
        <h3>Source documents</h3>
        <p class="evidence-hint">
          ${state.selectedSpan
            ? `Showing <span class="mono">${esc(state.selectedKey)}</span> at ${esc(state.selectedSpan.docName)} line ${state.selectedSpan.line}.`
            : 'Select a field to highlight its evidence.'}
        </p>
        <div class="doc-tabs">${docTabs}</div>
        <div class="doc-pane"><pre>${highlighted(doc)}</pre></div>
      </div>
    </div>

    ${groundTruth?.notes ? `<div class="card"><h3>Why this packet is in the corpus</h3><p class="card-note">${esc(groundTruth.notes)}</p></div>` : ''}
  `;
}

/** @param {any} doc */
function highlighted(doc) {
  if (!doc) return '';
  const span = state.selectedSpan;
  if (!span || span.docId !== doc.docId) return esc(doc.text);

  return (
    esc(doc.text.slice(0, span.start)) +
    `<mark class="evidence">${esc(doc.text.slice(span.start, span.end))}</mark>` +
    esc(doc.text.slice(span.end))
  );
}

/** @param {any} run */
function renderGuidelinesTab(run) {
  return `
    <div class="card">
      <h3>Guideline checks</h3>
      <p class="card-note">
        Deterministic rules, evaluated in code rather than by a model, so the same packet always
        produces the same result. Every threshold below is invented for this demonstration.
      </p>
      <table>
        <thead><tr><th>ID</th><th>Check</th><th>Status</th><th>Detail</th></tr></thead>
        <tbody>
          ${run.checks
            .map(
              (c) => `
            <tr>
              <td class="mono nowrap">${esc(c.id)}</td>
              <td>${esc(c.title)}</td>
              <td><span class="badge ${esc(c.status)}">${esc(c.status.replace('_', ' '))}</span></td>
              <td>${esc(c.detail)}<div class="disclaimer">${esc(c.disclaimer)}</div></td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>Conflicts</h3>
      <p class="card-note">
        A failed check is an answer. A conflict is a reason not to trust any answer yet: the
        documents disagree with each other, and nothing in this run reconciles them.
      </p>
      ${run.conflicts.length
        ? run.conflicts
            .map(
              (c) => `
          <div class="reason">
            <span class="reason-kind">${esc(c.id)} · <span class="badge ${esc(c.severity)}">${esc(c.severity)}</span></span>
            <strong>${esc(c.title)}</strong><br />${esc(c.detail)}
          </div>`,
            )
            .join('')
        : '<div class="empty">The application, the schedule and the loss run agree with each other.</div>'}
    </div>

    <div class="card">
      <h3>Routing</h3>
      <p class="card-note">Decision: ${decisionBadge(run.routing.decision)}</p>
      ${run.routing.reasons.length
        ? run.routing.reasons
            .map(
              (r) => `
          <div class="reason">
            <span class="reason-kind">${esc(r.kind)}</span>
            ${esc(r.detail)}
          </div>`,
            )
            .join('')
        : '<div class="empty">Nothing required a human: every required value was read confidently, the documents agreed, and the outcome did not hinge on this run&rsquo;s own adjustments.</div>'}
    </div>`;
}

/** @param {any} run */
function renderTraceTab(run) {
  const longest = Math.max(...run.trace.map((t) => t.durationMs), 0.001);

  return `
    <div class="card">
      <h3>Trace</h3>
      <p class="card-note">
        Five stages, each timed on a real clock. The trace is the product, not the logging: an answer
        that cannot show which document, which line and which rule produced it is not reviewable.
        Total ${ms(run.durationMs)} · run <span class="mono">${esc(run.runId)}</span>
      </p>
      ${run.trace
        .map(
          (step) => `
        <div class="trace-step">
          <div class="trace-head">
            <h4>${esc(step.name)}</h4>
            <span class="trace-time">+${step.startMs.toFixed(2)} ms · took ${step.durationMs.toFixed(2)} ms</span>
          </div>
          <div class="trace-bar" style="width:${Math.max(2, (step.durationMs / longest) * 100).toFixed(1)}%"></div>
          <p class="trace-summary">${esc(step.summary)}</p>
          <ul class="trace-detail">${step.detail.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
        </div>`,
        )
        .join('')}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Review queue
 * ------------------------------------------------------------------ */

function renderReview() {
  const q = state.data;

  return render(`
    <div class="view-head">
      <div>
        <h2>Human review queue</h2>
        <p>
          The submissions this version refused to decide on its own. This screen deliberately shows
          no accuracy figures and no ground truth: a reviewer working a real queue has the documents
          and the machine&rsquo;s reasoning, not an answer key.
        </p>
      </div>
      <div class="controls">
        <label class="field">Workflow version ${versionSelect(q.versionId, 'version')}</label>
      </div>
    </div>

    <div class="metrics">
      ${simpleMetric('Awaiting review', String(q.items.length))}
      ${simpleMetric('Cleared automatically', String(q.cleared))}
      ${simpleMetric('Decided by a human', String(q.items.filter((i) => i.review).length))}
    </div>

    ${q.items.length ? q.items.map(queueItem).join('') : '<div class="card"><div class="empty">This version decided every packet on its own.</div></div>'}
  `);
}

/** @param {any} item */
function queueItem(item) {
  return `
    <div class="card queue-item ${item.review ? 'reviewed' : ''}">
      <div class="view-head" style="margin-bottom:10px">
        <div>
          <h3>${esc(item.packetId)} · ${esc(item.packetLabel)}</h3>
          <div class="inline-list" style="margin-top:5px">${item.edgeCases.map(edgeBadge).join('')}</div>
        </div>
        <div class="right">
          <div class="faint">Reconciled ${usd(item.computedTiv)} · stated ${usd(item.statedTiv)}</div>
          <a href="#/packet/${encodeURIComponent(item.versionId)}/${encodeURIComponent(item.packetId)}">Open documents and trace →</a>
        </div>
      </div>

      <h4 style="font-size:12px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.5px">Why it stopped</h4>
      ${item.reasons.map((r) => `<div class="reason"><span class="reason-kind">${esc(r.kind)}</span>${esc(r.detail)}</div>`).join('')}

      ${item.flags.length
        ? `<h4 style="font-size:12px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.5px;margin-top:12px">Guideline flags</h4>
           ${item.flags.map((f) => `<div class="reason"><span class="reason-kind">${esc(f.id)}</span><strong>${esc(f.title)}</strong><br />${esc(f.detail)}<div class="disclaimer">${esc(f.disclaimer)}</div></div>`).join('')}`
        : ''}

      ${item.lowConfidence.length
        ? `<h4 style="font-size:12px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.5px;margin-top:12px">Values the extractor was unsure about</h4>
           <table>
             <thead><tr><th>Field</th><th>Value</th><th class="num">Conf.</th><th>Method</th><th>Note</th></tr></thead>
             <tbody>${item.lowConfidence
               .map(
                 (f) => `<tr>
                   <td class="mono">${esc(f.key)}</td>
                   <td>${value(f.value)}</td>
                   <td class="num conf ${confidenceClass(f.confidence)}">${f.confidence.toFixed(2)}</td>
                   <td class="method">${esc(f.method)}</td>
                   <td class="faint">${esc(f.note ?? '')}</td>
                 </tr>`,
               )
               .join('')}</tbody>
           </table>`
        : ''}

      ${item.review
        ? `<div class="review-recorded">
             <strong>${esc(item.review.decision)}</strong> by ${esc(item.review.reviewer)}
             on ${esc(new Date(item.review.recordedAt).toLocaleString())}
             ${item.review.note ? `<br />${esc(item.review.note)}` : ''}
             <br /><span class="faint">Recorded against ${esc(item.review.versionId)}. Re-deciding appends to the log rather than overwriting it.</span>
           </div>`
        : ''}

      <form class="review-form" data-review="${esc(item.packetId)}" data-run="${esc(item.runId)}">
        <textarea name="note" placeholder="What did you conclude, and what did you rely on? (required when asking for more information)"></textarea>
        <div class="review-actions">
          <input type="text" name="reviewer" placeholder="Your name" value="${esc(localStorage.getItem('iwrl-reviewer') ?? '')}" />
          <button type="submit" class="primary" value="approve" name="decision">Approve</button>
          <button type="submit" class="danger" value="decline" name="decision">Decline</button>
          <button type="submit" value="needs-info" name="decision">Needs info</button>
        </div>
      </form>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * About
 * ------------------------------------------------------------------ */

function renderAbout() {
  return render(`
    <div class="view-head"><div><h2>About this lab</h2></div></div>

    <div class="card prose">
      <p>
        This is a small, self-contained demonstration of one problem: when you change an
        extraction pipeline, how do you know what you broke? Aggregate accuracy will not tell you.
        A version can gain three points of average accuracy while quietly inventing values in the
        fields a broker deliberately left blank - raising no errors, breaking no checks, and
        changing no decision.
      </p>

      <h3>What is real and what is not</h3>
      <ul class="plain">
        <li><strong>Every document is synthetic.</strong> The insureds, addresses, brokers, losses and figures are invented for this project. No real submission is represented.</li>
        <li><strong>The forms are not ACORD forms.</strong> They are simplified equivalents with the same kinds of fields, written from scratch.</li>
        <li><strong>Every guideline threshold is invented.</strong> Nothing here is underwriting guidance and none of it should be treated as authoritative.</li>
        <li><strong>Latency is measured.</strong> The trace times each stage on a real clock.</li>
        <li><strong>Cost is simulated.</strong> Both extractors are deterministic local code and cost nothing to run; the dollar figures are a token-equivalent model at an invented rate, shown so the accuracy/cost trade-off is visible. They are not any vendor&rsquo;s pricing.</li>
      </ul>

      <h3>What this is not</h3>
      <ul class="plain">
        <li>Not production software, and not a product.</li>
        <li>Not integrated with any policy system, form vendor or data provider.</li>
        <li>Not a claim about anyone else&rsquo;s product. It is one person&rsquo;s small version of a reliability problem worth caring about.</li>
        <li>Not evidence of production insurance-domain experience.</li>
      </ul>

      <h3>The three kinds of abstention</h3>
      <ul class="plain">
        <li><span class="mono">NOT_READABLE</span> - a required value could not be read confidently. The extractor&rsquo;s fault.</li>
        <li><span class="mono">UNRECONCILED</span> - the documents contradict each other and nothing in the run explains the gap. The packet&rsquo;s fault.</li>
        <li><span class="mono">ADJUSTMENT_DECISIVE</span> - the run&rsquo;s own reconciliation decided the outcome: remove the duplicate or apply the endorsement and the answer flips. Nobody&rsquo;s fault, and the most important of the three.</li>
      </ul>
    </div>
  `);
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

document.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);

  const row = target.closest('tr[data-href]');
  if (row) {
    location.hash = /** @type {HTMLElement} */ (row).dataset.href;
    return;
  }

  const evidenceRow = target.closest('tr[data-evidence]');
  if (evidenceRow) {
    const el = /** @type {HTMLElement} */ (evidenceRow);
    state.selectedSpan = JSON.parse(el.dataset.evidence);
    state.selectedKey = el.dataset.key;
    state.docId = state.selectedSpan.docId;
    renderView();
    return;
  }

  const tab = target.closest('button[data-tab]');
  if (tab) {
    state.packetTab = /** @type {HTMLElement} */ (tab).dataset.tab;
    renderView();
    return;
  }

  const docTab = target.closest('button[data-doc]');
  if (docTab) {
    state.docId = /** @type {HTMLElement} */ (docTab).dataset.doc;
    renderView();
  }
});

document.addEventListener('change', async (event) => {
  const select = /** @type {HTMLSelectElement} */ (event.target);
  if (!select.dataset?.select) return;

  const which = select.dataset.select;
  if (which === 'baseline') state.baseline = select.value;
  else if (which === 'candidate') state.candidate = select.value;
  else state.versionId = select.value;

  if (state.view === 'packet') {
    location.hash = `#/packet/${encodeURIComponent(state.versionId)}/${encodeURIComponent(state.packetId)}`;
    return;
  }

  render(`<div class="loading">Replaying&hellip;</div>`);
  try {
    await loadViewData();
  } catch (err) {
    state.error = /** @type {Error} */ (err).message;
  }
  renderView();
});

document.addEventListener('submit', async (event) => {
  const form = /** @type {HTMLFormElement} */ (event.target);
  if (!form.dataset?.review) return;
  event.preventDefault();

  const decision = /** @type {HTMLButtonElement} */ (event.submitter)?.value;
  if (!decision) return;

  const reviewer = /** @type {HTMLInputElement} */ (form.elements.namedItem('reviewer')).value;
  const note = /** @type {HTMLTextAreaElement} */ (form.elements.namedItem('note')).value;
  localStorage.setItem('iwrl-reviewer', reviewer);

  try {
    await api('/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        packetId: form.dataset.review,
        versionId: state.versionId,
        runId: form.dataset.run,
        decision,
        reviewer,
        note,
      }),
    });
    state.data = await api(`/api/review-queue/${encodeURIComponent(state.versionId)}`);
    renderView();
  } catch (err) {
    alert(/** @type {Error} */ (err).message);
  }
});

window.addEventListener('hashchange', navigate);

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

(async function boot() {
  try {
    state.meta = await api('/api/meta');
  } catch (err) {
    render(`<div class="error">Could not reach the API: ${esc(/** @type {Error} */ (err).message)}</div>`);
    return;
  }

  state.baseline = state.meta.defaultComparison.baseline;
  state.candidate = state.meta.defaultComparison.candidate;
  state.versionId = state.meta.defaultComparison.candidate;

  document.getElementById('footer-pricing').textContent = state.meta.pricing.label;

  if (!location.hash) location.hash = '#/compare';
  else await navigate();
})();
