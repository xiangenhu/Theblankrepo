#!/usr/bin/env node
'use strict';

/**
 * AssessBank — bug triage CLI.
 *
 * Single place where fetch + dedup + appId filter + categorization + severity
 * scoring happen, so the admin tab, this CLI, and the /team-bugfix skill all see
 * the same view. Reads from the dedicated BUG_LRS; writes the shared fix log
 * (GCS, with a local dev fallback) via the bugReporter module.
 *
 * Non-interactive (CI / agents):
 *   node scripts/bug-triage.js --since 24h          # fetch + write report + print
 *   node scripts/bug-triage.js --mark-fixed <id> "note"
 *   node scripts/bug-triage.js --dismiss   <id> "reason"
 *   node scripts/bug-triage.js --reset
 *
 * Interactive:
 *   npm run debugging        (or: node scripts/bug-triage.js)
 *
 * The `--since` form always writes bug-triage-report.md (the canonical
 * machine-readable view the skill parses) and prints a summary to stdout.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const bugReporter = require('../bugReporter');

const REPORT_PATH = path.join(__dirname, '..', 'bug-triage-report.md');
const SEVERITY_WEIGHT = { fatal: 4, error: 3, warning: 2, info: 1 };

function configWarn() {
  if (!bugReporter.enabled) {
    console.log(
      'BUG_LRS is not configured (BUG_LRS_ENDPOINT/USERNAME/PASSWORD). ' +
        'The pipeline silently no-ops in local dev — nothing to triage.'
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Report generation (canonical machine-readable view)
// ---------------------------------------------------------------------------
function groupByCategory(bugs) {
  const groups = {};
  for (const b of bugs) {
    (groups[b.category] = groups[b.category] || []).push(b);
  }
  // category total score -> ordering
  return Object.entries(groups)
    .map(([category, items]) => ({
      category,
      items: items.sort((a, b) => b.score - a.score),
      score: items.reduce((s, x) => s + x.score, 0),
    }))
    .sort((a, b) => b.score - a.score);
}

function md(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function buildReport(result) {
  const { since, bugs, summary } = result;
  const lines = [];
  lines.push('# Bug Triage Report');
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- App ID: \`${summary.appId}\``);
  lines.push(`- Since: ${since}`);
  lines.push(`- Unique bugs: ${summary.unique}  ·  Total occurrences: ${summary.total}`);
  lines.push(`- Status: open ${summary.open} · fixed ${summary.fixed} · dismissed ${summary.dismissed}`);
  lines.push(
    `- Severity: fatal ${summary.bySeverity.fatal} · error ${summary.bySeverity.error} · ` +
      `warning ${summary.bySeverity.warning} · info ${summary.bySeverity.info}`
  );
  lines.push(`- Source: server ${summary.bySource.server} · client ${summary.bySource.client}`);
  lines.push('');

  const open = bugs.filter((b) => b.status === 'open');
  lines.push(`## Open bugs by category (${open.length})`);
  lines.push('');

  if (!open.length) {
    lines.push('_No open bugs in this range._');
    lines.push('');
  }

  for (const group of groupByCategory(open)) {
    lines.push(`### ${group.category} (${group.items.length})`);
    lines.push('');
    lines.push('| errorId | severity | score | occ | source | route | status | message |');
    lines.push('|---------|----------|-------|-----|--------|-------|--------|---------|');
    for (const b of group.items) {
      lines.push(
        `| ${md(b.errorId)} | ${b.severity} | ${b.score} | ${b.occurrences} | ${b.source} | ` +
          `${md(b.route) || '—'} | ${b.status} | ${md(b.message).slice(0, 200)} |`
      );
    }
    lines.push('');
    // Stack details per bug, in a collapsible block (skill can read raw).
    for (const b of group.items) {
      if (!b.stack && !b.context) continue;
      lines.push(`<details><summary>${md(b.errorId)} — detail</summary>`);
      lines.push('');
      if (b.statusCode) lines.push(`- statusCode: ${md(b.statusCode)}  ·  method: ${md(b.method)}`);
      if (b.firstSeen) lines.push(`- firstSeen: ${b.firstSeen}  ·  lastSeen: ${b.lastSeen}`);
      if (b.stack) {
        lines.push('');
        lines.push('```');
        lines.push(String(b.stack).slice(0, 4000));
        lines.push('```');
      }
      if (b.context) {
        lines.push('');
        lines.push('Context:');
        lines.push('```');
        lines.push(String(b.context).slice(0, 2000));
        lines.push('```');
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  // Fixed / dismissed footer for completeness.
  const closed = bugs.filter((b) => b.status !== 'open');
  if (closed.length) {
    lines.push(`## Closed (${closed.length})`);
    lines.push('');
    lines.push('| errorId | status | note | message |');
    lines.push('|---------|--------|------|---------|');
    for (const b of closed) {
      lines.push(`| ${md(b.errorId)} | ${b.status} | ${md(b.fixNote)} | ${md(b.message).slice(0, 120)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function printSummary(result) {
  const { summary, bugs } = result;
  console.log(`\nApp: ${summary.appId}  ·  Since: ${result.since}`);
  console.log(
    `Unique: ${summary.unique}  ·  Open: ${summary.open}  ·  Fixed: ${summary.fixed}  ·  ` +
      `Dismissed: ${summary.dismissed}  ·  Total occ: ${summary.total}`
  );
  console.log(
    `Severity — fatal:${summary.bySeverity.fatal} error:${summary.bySeverity.error} ` +
      `warning:${summary.bySeverity.warning} info:${summary.bySeverity.info}`
  );
  const open = bugs.filter((b) => b.status === 'open').slice(0, 15);
  if (open.length) {
    console.log('\nTop open bugs:');
    for (const b of open) {
      console.log(
        `  [${b.severity}|${b.score}|x${b.occurrences}] ${b.category}  ${b.errorId}\n` +
          `      ${String(b.message).slice(0, 120)}`
      );
    }
  }
}

async function doFetch(since) {
  const result = await bugReporter.fetchBugReports({ since });
  const report = buildReport(result);
  fs.writeFileSync(REPORT_PATH, report);
  console.log(`Wrote ${path.relative(process.cwd(), REPORT_PATH)} (${result.bugs.length} unique bugs).`);
  printSummary(result);
  return result;
}

// ---------------------------------------------------------------------------
// Non-interactive flag handling
// ---------------------------------------------------------------------------
async function runNonInteractive(argv) {
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  if (argv.includes('--reset')) {
    const { where } = await bugReporter.resetFixLog();
    console.log(`Fix log reset (${where}).`);
    return true;
  }

  if (argv.includes('--mark-fixed')) {
    if (configWarn()) return true;
    const id = arg('--mark-fixed');
    const note = argv.slice(argv.indexOf('--mark-fixed') + 2).join(' ') || '';
    if (id === 'all') {
      const result = await bugReporter.fetchBugReports({ since: '90d' });
      let n = 0;
      for (const b of result.bugs.filter((x) => x.status === 'open')) {
        await bugReporter.markFixed(b.errorId, note);
        n += 1;
      }
      console.log(`Marked ${n} open bug(s) as fixed.`);
    } else if (id) {
      const { where } = await bugReporter.markFixed(id, note);
      console.log(`Marked ${id} as fixed (${where}): ${note}`);
    } else {
      console.error('Usage: --mark-fixed <errorId|all> "note"');
    }
    return true;
  }

  if (argv.includes('--dismiss')) {
    if (configWarn()) return true;
    const id = arg('--dismiss');
    const reason = argv.slice(argv.indexOf('--dismiss') + 2).join(' ') || '';
    if (!id) {
      console.error('Usage: --dismiss <errorId> "reason"');
    } else {
      const { where } = await bugReporter.markDismissed(id, reason);
      console.log(`Dismissed ${id} (${where}): ${reason}`);
    }
    return true;
  }

  if (argv.includes('--since')) {
    if (configWarn()) return true;
    await doFetch(arg('--since') || '7d');
    return true;
  }

  return false; // no recognized flag -> fall through to interactive
}

// ---------------------------------------------------------------------------
// Interactive menu
// ---------------------------------------------------------------------------
function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

async function runInteractive() {
  if (configWarn()) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let last = null;

  const menu =
    '\n=== AssessBank Bug Triage ===\n' +
    '1) Fetch last 7 days\n' +
    '2) Fetch custom range (e.g. 1h, 24h, 7d, 2w)\n' +
    '3) View open bugs by category\n' +
    '4) View bug detail (by errorId)\n' +
    '5) Mark fixed (id or "all")\n' +
    '6) Dismiss a bug\n' +
    '7) Generate Markdown report\n' +
    '8) View fix log\n' +
    '9) Reset fix log\n' +
    '0) Exit\n> ';

  for (;;) {
    const choice = (await ask(rl, menu)).trim();
    try {
      if (choice === '0') break;
      else if (choice === '1') last = await doFetch('7d');
      else if (choice === '2') last = await doFetch((await ask(rl, 'Range: ')).trim() || '7d');
      else if (choice === '3') {
        if (!last) last = await bugReporter.fetchBugReports({ since: '7d' });
        for (const g of groupByCategory(last.bugs.filter((b) => b.status === 'open'))) {
          console.log(`\n## ${g.category} (${g.items.length})`);
          for (const b of g.items) console.log(`  [${b.severity}|${b.score}] ${b.errorId}  ${String(b.message).slice(0, 100)}`);
        }
      } else if (choice === '4') {
        if (!last) last = await bugReporter.fetchBugReports({ since: '7d' });
        const id = (await ask(rl, 'errorId: ')).trim();
        const b = last.bugs.find((x) => x.errorId === id);
        console.log(b ? JSON.stringify(b, null, 2) : 'Not found.');
      } else if (choice === '5') {
        const id = (await ask(rl, 'errorId (or "all"): ')).trim();
        const note = (await ask(rl, 'note: ')).trim();
        if (id === 'all') {
          if (!last) last = await bugReporter.fetchBugReports({ since: '90d' });
          for (const b of last.bugs.filter((x) => x.status === 'open')) await bugReporter.markFixed(b.errorId, note);
          console.log('Marked all open as fixed.');
        } else {
          await bugReporter.markFixed(id, note);
          console.log('Marked fixed.');
        }
      } else if (choice === '6') {
        const id = (await ask(rl, 'errorId: ')).trim();
        const reason = (await ask(rl, 'reason: ')).trim();
        await bugReporter.markDismissed(id, reason);
        console.log('Dismissed.');
      } else if (choice === '7') {
        last = await doFetch('7d');
      } else if (choice === '8') {
        console.log(JSON.stringify(await bugReporter.readFixLog(), null, 2));
      } else if (choice === '9') {
        await bugReporter.resetFixLog();
        console.log('Fix log reset.');
      } else {
        console.log('Unknown choice.');
      }
    } catch (err) {
      console.error('Error:', err.message);
    }
  }
  rl.close();
}

(async function main() {
  const argv = process.argv.slice(2);
  try {
    const handled = await runNonInteractive(argv);
    if (!handled) await runInteractive();
  } catch (err) {
    console.error('bug-triage failed:', err.message);
    process.exit(1);
  }
})();
