import type { StepResult, TaskResult } from './runner.ts';

/**
 * A self-contained HTML report for one run: no external assets, so it
 * opens straight from disk. Screenshots are linked relative to the report,
 * which sits next to them in the artifacts directory.
 */
export function renderReport(result: TaskResult): string {
  const passed = result.steps.filter((step) => step.status === 'passed').length;
  const params = result.params
    ? `<dl class="params">${Object.entries(result.params)
        .map(([name, value]) => `<dt>${escape(name)}</dt><dd>${escape(value)}</dd>`)
        .join('')}</dl>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(result.task)} — NEXUS run</title>
<style>
  :root { --bg: #fff; --fg: #1b1b1f; --muted: #6b6b76; --line: #e4e4ea; --card: #f7f7fa;
          --pass: #137333; --fail: #b3261e; --skip: #8a8a94; --code: #f0f0f4; --warn: #9a6700; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #141417; --fg: #ececf1; --muted: #9a9aa6; --line: #2c2c33; --card: #1c1c21;
            --pass: #6dd58c; --fail: #ff8a80; --skip: #8a8a94; --code: #24242b; --warn: #e3b341; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px; background: var(--bg); color: var(--fg);
         font: 15px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .summary { color: var(--muted); margin-bottom: 16px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 600; font-size: 13px; }
  .badge.passed { background: color-mix(in srgb, var(--pass) 15%, transparent); color: var(--pass); }
  .badge.failed { background: color-mix(in srgb, var(--fail) 15%, transparent); color: var(--fail); }
  .params { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 20px; font-size: 14px; }
  .params dt { color: var(--muted); }
  .params dd { margin: 0; font-family: ui-monospace, monospace; }
  ol { list-style: none; padding: 0; margin: 0; }
  li { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; background: var(--card); }
  .head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .icon { font-weight: 700; width: 1.2em; }
  .passed .icon { color: var(--pass); }
  .failed .icon { color: var(--fail); }
  .skipped { opacity: .6; }
  .skipped .icon { color: var(--skip); }
  .repair { margin-top: 8px; padding: 8px 10px; border-radius: 6px; font-size: 13px;
            background: color-mix(in srgb, var(--warn) 12%, transparent); border-left: 3px solid var(--warn); }
  .repair code { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
  .notice { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; font-size: 14px;
            background: color-mix(in srgb, var(--warn) 12%, transparent); border-left: 3px solid var(--warn); }
  .desc { font-family: ui-monospace, monospace; font-size: 13.5px; overflow-wrap: anywhere; flex: 1; }
  .time { color: var(--muted); font-size: 13px; }
  .seen { color: var(--muted); font-size: 13px; margin-top: 4px; overflow-wrap: anywhere; }
  pre { background: var(--code); border-radius: 6px; padding: 8px 10px; margin: 8px 0 0; white-space: pre-wrap;
        overflow-wrap: anywhere; font-size: 13px; color: var(--fail); }
  img { display: block; max-width: 100%; margin-top: 10px; border: 1px solid var(--line); border-radius: 6px; }
</style>
</head>
<body>
<main>
  <h1>${escape(result.task)}</h1>
  <div class="summary">
    <span class="badge ${result.status}">${result.status.toUpperCase()}</span>
    ${passed}/${result.steps.length} steps · ${formatMs(result.durationMs)} · ${escape(new Date(result.startedAt).toLocaleString())}
  </div>
  ${params}
  ${result.private ? '<p class="notice">🔒 Private run: nothing from this run was sent to any AI model.</p>' : ''}
  ${result.repairs ? `<p class="notice">Self-healing found ${result.repairs.applied + result.repairs.suggested} replacement target(s): ${result.repairs.applied} applied, ${result.repairs.suggested} suggested.${result.repairs.file ? ` Review <code>${escape(result.repairs.file)}</code> before adopting it.` : ''}</p>` : ''}
  <ol>
${result.steps.map(renderStep).join('\n')}
  </ol>
</main>
</body>
</html>
`;
}

function renderStep(step: StepResult): string {
  const icon = { passed: '✔', failed: '✖', skipped: '○' }[step.status];
  const time = step.status === 'skipped' ? '' : `<span class="time">${formatMs(step.durationMs)}</span>`;
  const seen = step.observation
    ? `<div class="seen">${escape(step.observation.title || '(untitled)')} — ${escape(step.observation.url)}</div>`
    : '';
  const error = step.error ? `<pre>${escape(`${step.error.type}: ${step.error.message}`)}</pre>` : '';
  const shot = step.screenshot
    ? `<a href="${escape(encodeURI(step.screenshot))}"><img src="${escape(encodeURI(step.screenshot))}" alt="Screenshot after step ${step.index + 1}" loading="lazy"></a>`
    : '';
  return `    <li class="${step.status}">
      <div class="head"><span class="icon">${icon}</span><span class="desc">${step.index + 1}. ${escape(step.description)}</span>${time}</div>
      ${seen}${error}${renderRepair(step)}${shot}
    </li>`;
}

function renderRepair(step: StepResult): string {
  const repair = step.repair;
  if (!repair) return '';
  const label = repair.applied ? 'Repaired' : repair.to ? 'Suggested repair' : 'No repair found';
  const via = repair.source ? ` (${repair.source === 'ai' ? 'AI' : 'rule'})` : '';
  const change = repair.to
    ? `<br><code>${escape(JSON.stringify(repair.from))}</code> → <code>${escape(JSON.stringify(repair.to))}</code>`
    : '';
  return `<div class="repair"><strong>${label}${via}:</strong> ${escape(repair.reason)}${change}</div>`;
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
