import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blocked,
  fail,
  fixtureResult,
  pass,
  undetermined,
} from './outcomes.ts';
import {
  createConformanceReport,
  createSuiteReport,
  renderJsonReport,
  renderTextReport,
} from './report.ts';

const rule = 'RFC §11 fixture result must be reported with exact outcome state.';

function diagnostic(id: string, suffix: string) {
  return {
    id,
    rule,
    expected: `expected ${suffix}`,
    actual: `actual ${suffix}`,
    diff: `diff ${suffix}`,
  };
}

test('aggregate reports count all four outcomes and preserve every non-pass diagnostic', () => {
  const alpha = createSuiteReport('alpha', [
    fixtureResult('alpha/pass', rule, pass()),
    fixtureResult('alpha/fail', rule, fail([diagnostic('alpha/fail', 'a')])),
  ]);
  const zeta = createSuiteReport('zeta', [
    fixtureResult(
      'zeta/blocked',
      rule,
      blocked('receipt-visibility', [diagnostic('zeta/blocked', 'b')]),
    ),
    fixtureResult(
      'zeta/undetermined',
      rule,
      undetermined([diagnostic('zeta/undetermined', 'c')]),
    ),
  ]);
  const report = createConformanceReport([zeta, alpha]);

  assert.deepEqual(report.totals, {
    total: 4,
    pass: 1,
    fail: 1,
    blocked: 1,
    undetermined: 1,
  });
  assert.deepEqual(report.suites.map((suite) => suite.name), ['alpha', 'zeta']);

  const text = renderTextReport(report);
  assert.match(text, /totals total=4 pass=1 fail=1 blocked=1 undetermined=1/u);
  assert.match(text, /FAIL alpha\/fail/u);
  assert.match(text, /BLOCKED zeta\/blocked/u);
  assert.match(text, /capability: receipt-visibility/u);
  assert.match(text, /UNDETERMINED zeta\/undetermined/u);
  assert.match(text, /expected: expected a/u);
  assert.match(text, /actual: actual b/u);
  assert.match(text, /diff: diff c/u);

  const json = renderJsonReport(report);
  assert.match(json, /"nonPass"/u);
  assert.match(json, /"alpha\/fail"/u);
  assert.match(json, /"zeta\/blocked"/u);
  assert.match(json, /"zeta\/undetermined"/u);
  assert.doesNotMatch(json, /"alpha\/pass"/u);
});

test('renderers are deterministic across input and diagnostic order', () => {
  const first = fixtureResult('suite/b', rule, fail([
    diagnostic('suite/b', 'second'),
    diagnostic('suite/b', 'first'),
  ]));
  const second = fixtureResult('suite/a', rule, pass());
  const reportLeft = createConformanceReport([createSuiteReport('suite', [first, second])]);
  const reportRight = {
    totals: reportLeft.totals,
    suites: [...reportLeft.suites].reverse(),
  };

  assert.equal(renderTextReport(reportLeft), renderTextReport(reportRight));
  assert.equal(renderJsonReport(reportLeft), renderJsonReport(reportRight));
});
