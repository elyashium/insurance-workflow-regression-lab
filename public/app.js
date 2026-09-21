/**
 * Workflow Quality & Regression Lab - Frontend
 * Apple Human Interface Design System
 */

const CONFIDENCE_FLOOR = 0.6;

const state = {
  /** @type {any} */ meta: null,
  ready: false,
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
 * API Client
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
 * Formatters & Helpers (Clean, Plain Language)
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

/** @param {number} n */
function ms(n) {
  return `${Number(n).toFixed(1)} ms`;
}

/**
 * Render extracted values with clean indicators
 * @param {any} v
 */
function value(v) {
  if (v === null || v === undefined || v === '') {
    return '<span class="val-null">Unspecified (Blank)</span>';
  }
  if (typeof v === 'number') return esc(v.toLocaleString('en-US'));
  return esc(v);
}

/** @param {number} c */
function confidenceClass(c) {
  if (c < CONFIDENCE_FLOOR) return 'low';
  if (c < 0.9) return 'mid';
  return 'high';
}

/**
 * Map raw technical edge cases to clean user-friendly labels
 * @param {string} edge
 */
function friendlyEdge(edge) {
  const map = {
    multiple_locations: 'Multi-Location',
    conflicting_tiv: 'Value Mismatch',
    clean_small_commercial: 'Standard Account',
    prior_loss_excluded: 'Prior Loss',
    non_standard_currency: 'Informal Currency',
    future_effective_date: 'Future Date',
    unreconciled_delta: 'Unreconciled',
    backfill_candidate: 'Inferred Data',
    stale_application: 'Stale Application',
  };
  return map[edge] || edge.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** @param {string} edge */
function edgeBadge(edge) {
  return `<span class="badge edge">${esc(friendlyEdge(edge))}</span>`;
}

/**
 * Human-friendly decision badges
 * @param {string} decision
 */
function decisionBadge(decision) {
  const map = {
    quote: 'Auto-Quote',
    decline: 'Auto-Decline',
    referred: 'Needs Review',
  };
  const label = map[decision] || decision;
  return `<span class="badge ${esc(decision)}">${esc(label)}</span>`;
}

/**
 * Human-friendly extraction methods
 * @param {string} method
 */
function friendlyMethod(method) {
  if (!method) return '—';
  if (method === 'context-backfill') return '<span class="badge badge-inferred">Inferred (Guessed)</span>';
  if (method === 'schedule-extract') return '<span class="badge badge-source">Property Schedule</span>';
  if (method === 'loss-extract') return '<span class="badge badge-source">Loss History</span>';
  if (method === 'app-extract') return '<span class="badge badge-source">Application Form</span>';
  return `<span class="badge badge-source">${esc(method)}</span>`;
}

/**
 * Friendly field names
 * @param {string} key
 */
function friendlyFieldName(key) {
  const map = {
    computedTiv: 'Total Insured Value (Reconciled)',
    statedTiv: 'Stated Property Value',
    insuredName: 'Insured Entity Name',
    effectiveDate: 'Policy Effective Date',
    constructionType: 'Construction Type',
    yearBuilt: 'Year Built',
    squareFeet: 'Total Area (Sq Ft)',
    address: 'Physical Address',
  };
  if (key.includes('.')) {
    const [prefix, field] = key.split('.');
    return `${prefix.toUpperCase()} &bull; ${map[field] || field}`;
  }
  return map[key] || key;
}

/**
 * Clean delta metric element
 * @param {number} delta
 * @param {(n: number) => string} format
 * @param {'up-good'|'down-good'} polarity
 */
function deltaEl(delta, format, polarity) {
  const flat = Math.abs(delta) < 1e-9;
  const better = polarity === 'up-good' ? delta > 0 : delta < 0;
  const cls = flat ? 'flat' : better ? 'up' : 'down';
  const sign = flat ? '' : delta > 0 ? '+' : '−';
  const icon = flat ? '' : better ? '▲ ' : '▼ ';
  return `<div class="metric-delta ${cls}">${icon}${sign}${esc(format(Math.abs(delta)))}${flat ? ' (no change)' : ''}</div>`;
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

  // Nothing corpus-backed runs before the user asks for it. The About page
  // is static and stays readable; every other view needs loaded data.
  if (!state.ready && state.view !== 'about') {
    renderShell();
    renderWelcome();
    return;
  }

  renderShell();
  render(`
    <div class="loading">
      <div class="spinner"></div>
      <span>Loading workflow data&hellip;</span>
    </div>
  `);

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
 * Shell & Navigation
 * ------------------------------------------------------------------ */

/** @param {string} html */
function render(html) {
  const mainEl = document.getElementById('main');
  if (mainEl) mainEl.innerHTML = html;
}

const CRUMB_LABELS = {
  compare: 'Scorecard',
  submissions: 'Submissions',
  packet: 'Submission detail',
  review: 'Review Queue',
  about: 'About',
};

function renderShell() {
  for (const a of document.querySelectorAll('#nav a')) {
    const view = a.getAttribute('data-view');
    a.classList.toggle('active', view === state.view || (view === 'submissions' && state.view === 'packet'));
  }
  const crumb = document.getElementById('crumb-view');
  if (crumb) crumb.textContent = CRUMB_LABELS[state.view] ?? 'Scorecard';
}

function renderView() {
  if (state.error) {
    render(`
      <div class="error">
        <strong>Unable to load view</strong><br />
        ${esc(state.error)}
      </div>
    `);
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
 * View: Welcome gate — the user loads the corpus explicitly
 * ------------------------------------------------------------------ */

function renderWelcome() {
  const crumb = document.getElementById('crumb-view');
  if (crumb) crumb.textContent = 'Overview';
  return render(`
    <div class="welcome">
      <div class="eyebrow">Regression lab</div>
      <h2>Ship workflow changes without silent regressions.</h2>
      <p>Replays the submission corpus through two workflow versions and diffs the runs field by field. A better average never buys back a field that used to be right.</p>
      <div class="welcome-actions">
        <button class="primary btn-big" data-action="load">Load evaluation data</button>
        <a class="welcome-link" href="#/about">How it works</a>
      </div>
      <div class="how-grid">
        <div class="how-card">
          <div class="how-num">01</div>
          <h4>Replay</h4>
          <p>Same packets, two versions. Every value cites its source.</p>
        </div>
        <div class="how-card">
          <div class="how-num">02</div>
          <h4>Diff</h4>
          <p>Blank means absent — inventing a value scores wrong.</p>
        </div>
        <div class="how-card">
          <div class="how-num">03</div>
          <h4>Gate</h4>
          <p>One lost field blocks the release. No exceptions.</p>
        </div>
      </div>
      <div class="welcome-note">Synthetic submissions &middot; Simulated cost &middot; Runs locally in milliseconds.</div>
    </div>
  `);
}

/* ------------------------------------------------------------------ *
 * View: Comparison / Scorecard
 * ------------------------------------------------------------------ */

function renderCompare() {
  const { baseline, candidate, diff } = state.data;
  const d = diff.summary.delta;
  const regressed = diff.verdict === 'regressed';

  const verdict = regressed
    ? `<div class="verdict regressed">
         <div class="verdict-icon">&#10033;</div>
         <div class="verdict-body">
            <div class="verdict-status">Regression Detected &bull; Release Blocked</div>
            <div class="verdict-title">${diff.regressions.length} field${diff.regressions.length === 1 ? '' : 's'} broke in ${esc(candidate.versionName)}.</div>
            <div class="verdict-desc">
              Accuracy moved ${d.accuracy >= 0 ? '+' : '−'}${pct(Math.abs(d.accuracy))}, but previously correct fields broke — the candidate is blocked.
            </div>
         </div>
       </div>`
    : `<div class="verdict clean">
         <div class="verdict-icon">&#10003;</div>
         <div class="verdict-body">
            <div class="verdict-status">Clean Release &bull; Ready to Deploy</div>
            <div class="verdict-title">No regressions detected.</div>
            <div class="verdict-desc">
              Everything previously correct held, and ${diff.improvements.length} field${diff.improvements.length === 1 ? '' : 's'} improved.
            </div>
         </div>
       </div>`;

  return render(`
    <div class="view-head">
      <div>
        <h2>Workflow Comparison</h2>
        <p>Same submissions, two versions — gains must not break what worked.</p>
      </div>
      <div class="controls">
        <label class="field">Baseline Version ${versionSelect(baseline.versionId, 'baseline')}</label>
        <label class="field">Candidate Version ${versionSelect(candidate.versionId, 'candidate')}</label>
      </div>
    </div>

    ${verdict}

    <div class="metrics">
      ${metric('Field Accuracy', pct(diff.summary.baseline.accuracy), pct(diff.summary.candidate.accuracy),
        deltaEl(d.accuracy, pct, 'up-good'),
        `${diff.summary.candidate.correct} of ${diff.summary.candidate.total} fields correct`)}

      ${metric('Human Review Rate', pct(diff.summary.baseline.abstentionRate), pct(diff.summary.candidate.abstentionRate),
        deltaEl(d.abstentionRate, pct, 'down-good'),
        `${diff.summary.candidate.abstained} of ${diff.summary.candidate.packets} submissions escalated`)}

      ${metric('Average Processing Time', ms(diff.summary.baseline.meanLatencyMs), ms(diff.summary.candidate.meanLatencyMs),
        deltaEl(d.meanLatencyMs, ms, 'down-good'),
        'Measured')}

      ${metric('Estimated Cost', cost(diff.summary.baseline.totalCostUsd), cost(diff.summary.candidate.totalCostUsd),
        deltaEl(d.totalCostUsd, cost, 'down-good'),
        'Simulated')}
    </div>

    ${diff.regressions.length ? regressionTable(diff.regressions, 'Regressions (Release Blockers)', 'regression-row',
      'Right before, wrong now.') : ''}

    ${diff.improvements.length ? regressionTable(diff.improvements, 'Improvements', 'improvement-row',
      'Fixed by the candidate.') : ''}

    <div class="card">
      <h3>Decisions</h3>
      <table>
        <thead>
          <tr>
            <th>Workflow Version</th>
            <th class="num">Auto-Quote</th>
            <th class="num">Auto-Decline</th>
            <th class="num">Human Review</th>
            <th class="num">Accuracy</th>
            <th class="num">Est. Cost</th>
          </tr>
        </thead>
        <tbody>
          ${decisionRow(baseline, diff.summary.baseline)}
          ${decisionRow(candidate, diff.summary.candidate)}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>Submissions</h3>
      <table>
        <thead>
          <tr>
            <th>Submission</th>
            <th>Baseline</th>
            <th>Candidate</th>
            <th class="num">Field Changes</th>
            <th>Flags</th>
            <th class="right">Action</th>
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
      <div>
        <div class="metric-label">${esc(label)}</div>
        <div class="metric-pair">
          <span class="metric-base">${base}</span>
          <span class="metric-arrow">&rarr;</span>
          <span class="metric-cand">${cand}</span>
        </div>
      </div>
      <div>
        ${delta}
        <div class="metric-foot">${foot}</div>
      </div>
    </div>`;
}

/** @param {any} suite @param {any} summary */
function decisionRow(suite, summary) {
  return `
    <tr>
      <td><strong>${esc(suite.versionName)}</strong></td>
      <td class="num">${summary.decisions.quote}</td>
      <td class="num">${summary.decisions.decline}</td>
      <td class="num">${summary.decisions.referred}</td>
      <td class="num"><strong>${pct(summary.accuracy)}</strong></td>
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
  if (!rows.length) return '';

  return `
    <div class="card">
      <h3>${esc(title)} <span class="badge ${rowClass.includes('regression') ? 'flag' : 'pass'}" style="margin-left:6px">${rows.length}</span></h3>
      <p class="card-note">${esc(note)}</p>
      <table>
        <thead>
          <tr>
            <th>Submission</th>
            <th>Field</th>
            <th>Expected (Ground Truth)</th>
            <th>Baseline</th>
            <th>Candidate</th>
            <th class="num">Confidence</th>
            <th>Source / Method</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr class="${rowClass}">
              <td class="nowrap"><a href="#/packet/${encodeURIComponent(state.candidate)}/${encodeURIComponent(r.packetId)}"><strong>${esc(r.packetId)}</strong></a></td>
              <td>${friendlyFieldName(r.key)}</td>
              <td><strong>${value(r.expected)}</strong></td>
              <td class="${r.baselineCorrect ? 'val-good' : 'val-bad'}">${value(r.baselineValue)}</td>
              <td class="${r.candidateCorrect ? 'val-good' : 'val-bad'}">${value(r.candidateValue)}</td>
              <td class="num conf ${confidenceClass(r.candidateConfidence)}">${(r.candidateConfidence * 100).toFixed(0)}%</td>
              <td>${friendlyMethod(r.candidateMethod)}</td>
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
    ...p.flagsRemoved.map((id) => `<span class="badge pass">&minus;${esc(id)}</span>`),
  ];

  const moved = p.movedFields.filter((f) => !f.candidateCorrect).length;
  const gained = p.movedFields.filter((f) => f.candidateCorrect).length;

  return `
    <tr class="clickable" data-href="#/packet/${encodeURIComponent(p.candidate.versionId)}/${encodeURIComponent(p.packetId)}">
      <td>
        <strong>${esc(p.packetId)}</strong><br />
        <span class="faint">${esc(p.packetLabel)}</span>
      </td>
      <td>${decisionBadge(p.baseline.decision)}</td>
      <td>${decisionBadge(p.candidate.decision)}${p.routingChanged ? ' <span class="badge edge" style="margin-left:4px">Changed</span>' : ''}</td>
      <td class="num">${gained ? `<span class="val-good">+${gained}</span>` : ''}${gained && moved ? ' / ' : ''}${moved ? `<span class="val-bad">&minus;${moved}</span>` : ''}${!gained && !moved ? '<span class="faint">—</span>' : ''}</td>
      <td><div class="inline-list">${flagChanges.join('') || '<span class="faint">—</span>'}</div></td>
      <td class="right nowrap">
        <a href="#/packet/${encodeURIComponent(p.candidate.versionId)}/${encodeURIComponent(p.packetId)}" style="font-weight:500">View Details &rarr;</a>
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
        <summary>Configuration Details</summary>
        <ul class="plain">
          ${suite.changes.map((c) => `<li>${esc(c)}</li>`).join('')}
        </ul>
        <ul class="plain" style="margin-top:10px">
          <li>Coverage appetite limit: <strong>${usd(suite.guidelines.tivCeiling)}</strong></li>
          <li>Max loss ratio ceiling: <strong>${esc(suite.guidelines.lossRatioCeilingPct)}%</strong></li>
          <li>Effective date lead window: <strong>${esc(suite.guidelines.maxMonthsAhead)} months</strong></li>
          <li>Address comparison mode: <strong>${esc(suite.guidelines.addressMatching)}</strong></li>
        </ul>
      </details>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * View: Submissions List
 * ------------------------------------------------------------------ */

function renderSubmissions() {
  const s = state.data;

  return render(`
    <div class="view-head">
      <div>
        <h2>Submissions</h2>
      </div>
      <div class="controls">
        <label class="field">Workflow Version ${versionSelect(s.versionId, 'version')}</label>
      </div>
    </div>

    <div class="metrics">
      ${simpleMetric('Total Submissions', String(s.summary.packets))}
      ${simpleMetric('Field Accuracy', pct(s.summary.accuracy), `${s.summary.correct} / ${s.summary.total} fields correct`)}
      ${simpleMetric('Human Review Rate', pct(s.summary.abstentionRate), `${s.summary.abstained} sent to review`)}
      ${simpleMetric('Average Latency', ms(s.summary.meanLatencyMs), 'Measured')}
      ${simpleMetric('Estimated Cost', cost(s.summary.totalCostUsd), 'Simulated')}
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Submission</th>
            <th>Characteristics</th>
            <th>Decision</th>
            <th class="num">Accuracy</th>
            <th class="num">Flags</th>
            <th class="num">Conflicts</th>
            <th class="num">Latency</th>
            <th class="num">Cost</th>
            <th>Review Status</th>
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
              <td class="num"><strong>${pct(p.accuracy)}</strong><br /><span class="faint">${p.correct}/${p.total}</span></td>
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
      <div>
        <div class="metric-label">${esc(label)}</div>
        <div class="metric-pair"><span class="metric-cand">${val}</span></div>
      </div>
      ${foot ? `<div class="metric-foot">${foot}</div>` : ''}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * View: Packet Detail
 * ------------------------------------------------------------------ */

function renderPacket() {
  const { run, score, groundTruth, packet } = state.data;

  const tabs = [
    ['evidence', 'Fields &amp; Evidence'],
    ['guidelines', 'Checks &amp; Conflicts'],
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
    <a class="back-link" href="#/submissions">&larr; Back to Submissions</a>

    <div class="view-head">
      <div>
        <h2>${esc(run.packetId)} &bull; ${esc(run.packetLabel)}</h2>
        <div class="inline-list" style="margin-top:6px">${run.edgeCases.map(edgeBadge).join('')}</div>
      </div>
      <div class="controls">
        <label class="field">Workflow Version ${versionSelect(run.versionId, 'version')}</label>
      </div>
    </div>

    <div class="metrics">
      ${simpleMetric('Routing Decision', decisionBadge(run.routing.decision), run.routing.abstained ? 'Escalated for human review' : 'Resolved automatically')}
      ${simpleMetric('Insured Property Value', usd(run.fields.computedTiv?.value), `Stated on form: ${usd(run.fields.statedTiv?.value)}`)}
      ${simpleMetric('Field Accuracy', pct(score.accuracy), `${score.correct} / ${score.total} items`)}
      ${simpleMetric('Latency', ms(run.durationMs), 'Measured')}
      ${simpleMetric('Cost', cost(run.cost.usd), `Simulated (${run.cost.passes} passes)`)}
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
        <td><strong>${friendlyFieldName(key)}</strong></td>
        <td>${value(f?.value)}</td>
        <td>${sc ? (sc.correct ? '<span class="val-good">✓ Accurate</span>' : `<span class="val-bad">✗ Expected ${value(sc.expected)}</span>`) : '<span class="faint">—</span>'}</td>
        <td class="num conf ${confidenceClass(f?.confidence ?? 0)}">${((f?.confidence ?? 0) * 100).toFixed(0)}%</td>
        <td>${friendlyMethod(f?.method)}</td>
      </tr>`;
  };

  const scalarRows = Object.entries(run.fields)
    .map(([name, f]) => fieldRow(name, f))
    .join('');

  const locationRows = run.resolution.locations
    .map(
      (loc) => `
      <tr><td colspan="5" class="subtle" style="background:rgba(255,255,255,0.03);padding:8px 12px"><strong>${esc(loc.locId.toUpperCase())}</strong> &bull; ${esc(loc.fields.address.value ?? 'Address not found')}</td></tr>
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
        <h3>Extracted Fields</h3>
        <p class="card-note">Select a row to see its source.</p>
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Value</th>
              <th>Accuracy</th>
              <th class="num">Confidence</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>${scalarRows}${locationRows}</tbody>
        </table>
      </div>

      <div class="card">
        <h3>Source</h3>
        <p class="evidence-hint">
          ${state.selectedSpan
            ? `Highlighting <strong>${friendlyFieldName(state.selectedKey)}</strong> in <em>${esc(state.selectedSpan.docName)}</em> at line ${state.selectedSpan.line}`
            : 'Select any extracted field on the left to highlight its source citation.'}
        </p>
        <div class="doc-tabs">${docTabs}</div>
        <div class="doc-pane"><pre>${highlighted(doc)}</pre></div>
      </div>
    </div>

    ${groundTruth?.notes ? `<div class="card"><h3>Submission Context</h3><p class="card-note">${esc(groundTruth.notes)}</p></div>` : ''}
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
      <table>
        <thead><tr><th>Rule</th><th>Description</th><th>Status</th><th>Result</th></tr></thead>
        <tbody>
          ${run.checks
            .map(
              (c) => `
            <tr>
              <td class="mono nowrap"><strong>${esc(c.id)}</strong></td>
              <td>${esc(c.title)}</td>
              <td><span class="badge ${esc(c.status)}">${esc(c.status === 'pass' ? 'Pass' : 'Flag')}</span></td>
              <td>${esc(c.detail)}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>Conflicts</h3>
      ${run.conflicts.length
        ? run.conflicts
            .map(
              (c) => `
          <div class="reason">
            <span class="reason-kind">${esc(c.id)} &bull; ${esc(c.severity.toUpperCase())}</span>
            <strong>${esc(c.title)}</strong><br />${esc(c.detail)}
          </div>`,
            )
            .join('')
        : '<div class="empty">All documents are consistent. No conflicting values found.</div>'}
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
        : '<div class="empty">No human review required. All fields read with high confidence and verified against guidelines.</div>'}
    </div>`;
}

/** @param {any} run */
function renderTraceTab(run) {
  const longest = Math.max(...run.trace.map((t) => t.durationMs), 0.001);

  return `
    <div class="card">
      <h3>Trace</h3>
      <p class="card-note">Total: <strong>${ms(run.durationMs)}</strong>, measured.</p>
      ${run.trace
        .map(
          (step) => `
        <div class="trace-step">
          <div class="trace-head">
            <h4>${esc(step.name)}</h4>
            <span class="trace-time">+${step.startMs.toFixed(2)} ms &bull; took ${step.durationMs.toFixed(2)} ms</span>
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
 * View: Review Queue
 * ------------------------------------------------------------------ */

function renderReview() {
  const q = state.data;

  return render(`
    <div class="view-head">
      <div>
        <h2>Review Queue</h2>
        <p>Packets the pipeline declined to decide alone.</p>
      </div>
      <div class="controls">
        <label class="field">Workflow Version ${versionSelect(q.versionId, 'version')}</label>
      </div>
    </div>

    <div class="metrics">
      ${simpleMetric('Awaiting review', String(q.items.length))}
      ${simpleMetric('Auto-decided', String(q.cleared))}
      ${simpleMetric('Reviewed', String(q.items.filter((i) => i.review).length))}
    </div>

    ${q.items.length ? q.items.map(queueItem).join('') : '<div class="card"><div class="empty">All submissions in this version were resolved automatically.</div></div>'}
  `);
}

/** @param {any} item */
function queueItem(item) {
  return `
    <div class="card queue-item ${item.review ? 'reviewed' : ''}">
      <div class="view-head" style="margin-bottom:12px">
        <div>
          <h3>${esc(item.packetId)} &bull; ${esc(item.packetLabel)}</h3>
          <div class="inline-list" style="margin-top:6px">${item.edgeCases.map(edgeBadge).join('')}</div>
        </div>
        <div class="right">
          <div class="faint">Total Property Value: <strong>${usd(item.computedTiv)}</strong></div>
          <a href="#/packet/${encodeURIComponent(item.versionId)}/${encodeURIComponent(item.packetId)}" style="font-weight:500">Open detail &rarr;</a>
        </div>
      </div>

      <h4 style="font-size:11px;color:var(--ink-faint);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Why escalated</h4>
      ${item.reasons.map((r) => `<div class="reason"><span class="reason-kind">${esc(r.kind)}</span>${esc(r.detail)}</div>`).join('')}

      ${item.flags.length
        ? `<h4 style="font-size:11px;color:var(--ink-faint);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 6px">Flags</h4>
           ${item.flags.map((f) => `<div class="reason"><span class="reason-kind">${esc(f.id)}</span><strong>${esc(f.title)}</strong><br />${esc(f.detail)}</div>`).join('')}`
        : ''}

      ${item.lowConfidence.length
        ? `<h4 style="font-size:11px;color:var(--ink-faint);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 6px">Verify</h4>
           <table>
             <thead><tr><th>Field</th><th>Extracted Value</th><th class="num">Confidence</th><th>Source</th></tr></thead>
             <tbody>${item.lowConfidence
               .map(
                 (f) => `<tr>
                   <td><strong>${friendlyFieldName(f.key)}</strong></td>
                   <td>${value(f.value)}</td>
                   <td class="num conf ${confidenceClass(f.confidence)}">${(f.confidence * 100).toFixed(0)}%</td>
                   <td>${friendlyMethod(f.method)}</td>
                 </tr>`,
               )
               .join('')}</tbody>
           </table>`
        : ''}

      ${item.review
        ? `<div class="review-recorded">
             <strong>${esc(item.review.decision.toUpperCase())}</strong> by <strong>${esc(item.review.reviewer)}</strong>
             on ${esc(new Date(item.review.recordedAt).toLocaleString())}
             ${item.review.note ? `<br />${esc(item.review.note)}` : ''}
           </div>`
        : ''}

      <form class="review-form" data-review="${esc(item.packetId)}" data-run="${esc(item.runId)}">
        <textarea name="note" placeholder="Rationale..."></textarea>
        <div class="review-actions">
          <input type="text" name="reviewer" placeholder="Your name" value="${esc(localStorage.getItem('iwrl-reviewer') ?? '')}" required />
          <button type="submit" class="primary" value="approve" name="decision">Approve</button>
          <button type="submit" class="danger" value="decline" name="decision">Decline</button>
          <button type="submit" value="needs-info" name="decision">Request info</button>
        </div>
      </form>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * View: About
 * ------------------------------------------------------------------ */

function renderAbout() {
  return render(`
    <div class="about-hero">
      <h2>Why Aggregate Accuracy Lies</h2>
      <p class="lead">
        A model or extraction pipeline can gain three points of average accuracy while quietly hallucinating values into fields that brokers deliberately left blank.
      </p>
    </div>

    <div class="about-quote-box">
      <blockquote>
        &ldquo;The release gate is not the average. It is whether any field that used to be right became wrong. A better average does not buy back a regression.&rdquo;
      </blockquote>
      <cite>Automated Pipeline Verification Principle</cite>
    </div>

    <div class="about-grid">
      <div class="about-card">
        <div class="about-card-number">01 / INTEGRITY</div>
        <h4>The Problem</h4>
        <p>
          Standard model evaluations rely on macro metrics like F1 or average accuracy. In automated insurance workflows, an invented value raises no syntax errors and triggers no exceptions &mdash; it silently distorts pricing and downstream underwriting.
        </p>
      </div>

      <div class="about-card">
        <div class="about-card-number">02 / REPLAY</div>
        <h4>Deterministic Replay</h4>
        <p>
          By evaluating candidate versions against the exact same submission packets and field-level ground truth, we isolate changes in heuristics, threshold tuning, and prompt revisions with zero confounding variance.
        </p>
      </div>

      <div class="about-card">
        <div class="about-card-number">03 / PROVENANCE</div>
        <h4>Character Citation</h4>
        <p>
          Every extracted value links directly to its source document coordinates and extraction method. A guess inferred from surrounding prose is never rendered like an explicit read from a table.
        </p>
      </div>
    </div>

    <div class="card">
      <h3>Automated Decision Architecture</h3>
      <p class="card-note">How workflows triage submissions into definitive actions or human review:</p>
      <div class="grid-2" style="margin-top:14px">
        <div class="reason">
          <span class="reason-kind">Auto-Quote</span>
          <strong>High Confidence &amp; Within Risk Appetite</strong><br />
          All required fields extracted with verified confidence and validated against risk guidelines.
        </div>
        <div class="reason">
          <span class="reason-kind">Auto-Decline</span>
          <strong>Explicit Guideline Disqualification</strong><br />
          Submission clearly exceeds policy limits (e.g. maximum insured value or historical loss ratio ceiling).
        </div>
        <div class="reason">
          <span class="reason-kind">Human Review</span>
          <strong>Unreadable Fields or Conflicting Documents</strong><br />
          Data was illegible or contradictory across documents, safely escalating to an underwriter.
        </div>
        <div class="reason">
          <span class="reason-kind">Synthetic Test Lab</span>
          <strong>Safe Demonstration Data</strong><br />
          All submissions, insured entities, loss histories, and rule thresholds are synthetic test assets.
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Where This Goes</h3>
      <p class="card-note">The harness is the product surface. Each step below slots in without changing the scorecard.</p>
      <div class="grid-2" style="margin-top:14px">
        <div class="reason">
          <span class="reason-kind">Step 01 — Real corpus</span>
          <strong>Swap synthetic packets for labelled production documents.</strong><br />
          The diff, the null scoring, and the gate carry over unchanged. Labelling is the real work — budget for it first.
        </div>
        <div class="reason">
          <span class="reason-kind">Step 02 — Model profile</span>
          <strong>Add a model-backed extractor as a fourth version.</strong><br />
          Versions are config, so the new profile diffs against the old ones on day one — including its invented-value rate.
        </div>
        <div class="reason">
          <span class="reason-kind">Step 03 — CI gate</span>
          <strong>Run the diff on every prompt, model, or rule change.</strong><br />
          A change that loses a previously correct field fails the build. That is the whole release policy.
        </div>
        <div class="reason">
          <span class="reason-kind">Step 04 — Close the loop</span>
          <strong>Feed reviewer overrides back into the guidelines.</strong><br />
          A rule overturned five times is a wrong rule. The review log already records the evidence.
        </div>
      </div>
    </div>
  `);
}

/* ------------------------------------------------------------------ *
 * Event Handling
 * ------------------------------------------------------------------ */

document.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);

  const loadBtn = target.closest('[data-action="load"]');
  if (loadBtn) {
    state.ready = true;
    (async () => {
      try {
        const packets = await api('/api/packets');
        const el = document.getElementById('sb-packets');
        if (el && Array.isArray(packets)) el.textContent = String(packets.length);
      } catch {
        /* Sidebar counts are decorative; the views load their own data. */
      }
      navigate();
    })();
    return;
  }

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

  render(`
    <div class="loading">
      <div class="spinner"></div>
      <span>Replaying submissions across pipeline&hellip;</span>
    </div>
  `);

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
 * Initialization
 * ------------------------------------------------------------------ */

(async function boot() {
  try {
    state.meta = await api('/api/meta');
  } catch (err) {
    render(`<div class="error">Could not connect to lab API: ${esc(/** @type {Error} */ (err).message)}</div>`);
    return;
  }

  state.baseline = state.meta.defaultComparison.baseline;
  state.candidate = state.meta.defaultComparison.candidate;
  state.versionId = state.meta.defaultComparison.candidate;

  const pricingEl = document.getElementById('footer-pricing');
  if (pricingEl) {
    pricingEl.textContent = state.meta.pricing.label;
  }

  const versionsEl = document.getElementById('sb-versions');
  if (versionsEl) versionsEl.textContent = String(state.meta.versions.length);

  if (!location.hash) location.hash = '#/compare';
  else await navigate();
})();
