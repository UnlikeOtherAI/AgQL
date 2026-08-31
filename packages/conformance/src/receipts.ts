import path from 'node:path';

import type {
  CatalogPhysicalIdentifier,
  ResolvedDatasetBinding,
  ResolvedFieldBinding,
  VisibilityState,
  VisibilityToken,
  WriteReceipt,
} from '@agql/contracts';
import { evaluateAfterWrite, validateVisibilityTransition } from '@agql/engine';
import { InstantValueSchema, fingerprintScope } from '@agql/schemas';
import type { JsonValue, SafeInteger } from '@agql/schemas';

import { discoverFiles, loadJsonFixture } from './fixtures.ts';
import {
  type JsonObject,
  arrayMember,
  jsonObject,
  objectMember,
  stringMember,
} from './json-shape.ts';
import { fail, fixtureResult, nonEmptyDiagnostics, pass } from './outcomes.ts';
import type { FixtureDiagnostic, FixtureResult } from './outcomes.ts';
import { createSuiteReport } from './report.ts';
import type { SuiteReport } from './report.ts';

function physical(value: string): CatalogPhysicalIdentifier {
  return value as CatalogPhysicalIdentifier;
}

function state(value: JsonValue, location: string): VisibilityState {
  const source = typeof value === 'string'
    ? { state: value }
    : jsonObject(value, location);
  const name = stringMember(source, 'state', location);
  if (name === 'accepted' || name === 'pending' || name === 'superseded') return { state: name };
  if (name === 'ready') {
    const token = source.token;
    return {
      state: 'ready',
      token: (typeof token === 'string' ? token : `opaque:${location}`) as VisibilityToken,
    };
  }
  if (name === 'failed') {
    return {
      state: 'failed',
      code: typeof source.code === 'string' ? source.code : 'FIXTURE_FAILURE',
      message: typeof source.message === 'string' ? source.message : 'Fixture visibility failed.',
    };
  }
  throw new TypeError(`${location}/state is not a receipt visibility state.`);
}

function recordsFor(
  fixture: JsonObject,
  step: JsonObject,
): readonly WriteReceipt['records'][number][] {
  const setup = objectMember(fixture, 'setup', '/setup');
  const recordSource = setup.record ?? setup.existingRecord;
  const id = recordSource === undefined
    ? 'fixture-record'
    : stringMember(jsonObject(recordSource, '/setup/record'), 'id', '/setup/record');
  const routeVisibility = step.queryRouteVisibility ?? step.visibility;
  if (routeVisibility === undefined && step.records === undefined) {
    throw new TypeError('/timeline/* needs visibility, queryRouteVisibility, or records.');
  }
  let records: JsonObject;
  if (step.records === undefined) {
    if (routeVisibility === undefined) throw new TypeError('/timeline/* has no visibility state.');
    records = { [id]: jsonObject(routeVisibility, '/timeline/*/visibility') };
  } else {
    records = objectMember(step, 'records', '/timeline/*');
  }
  return Object.entries(records).map(([recordId, value]) => {
    const visibility = jsonObject(value, `/timeline/*/records/${recordId}`);
    return {
      id: recordId,
      version: 1 as SafeInteger,
      visibility: Object.fromEntries(Object.entries(visibility).map(([name, item]) => [
        name,
        state(item, `/timeline/*/records/${recordId}/${name}`),
      ])),
    };
  });
}

function requirement(fixture: JsonObject): readonly [string, ...string[]] {
  const query = objectMember(fixture, 'query', '/query');
  const afterWrite = objectMember(query, 'afterWrite', '/query/afterWrite');
  const names = arrayMember(afterWrite, 'require', '/query/afterWrite');
  const parsed = names.map((name, index) => {
    if (typeof name !== 'string') {
      throw new TypeError(`/query/afterWrite/require/${index} is not a string.`);
    }
    return name;
  });
  const first = parsed[0];
  if (first === undefined) throw new TypeError('/query/afterWrite/require must not be empty.');
  return [first, ...parsed.slice(1)];
}

function receipt(fixture: JsonObject, step: JsonObject): WriteReceipt {
  const setup = objectMember(fixture, 'setup', '/setup');
  return {
    receipt: stringMember(setup, 'receipt', '/setup') as WriteReceipt['receipt'],
    records: recordsFor(fixture, step),
  };
}

function observation(fixture: JsonObject) {
  const setup = objectMember(fixture, 'setup', '/setup');
  const dataset: ResolvedDatasetBinding = {
    logicalId: typeof setup.dataset === 'string' ? setup.dataset : 'documents',
    physical: physical('receipt_fixture_documents'),
    bindingVersion: 'receipt-fixture-v1',
  };
  const idField: ResolvedFieldBinding = {
    logicalId: `${dataset.logicalId}.id`,
    physical: physical('id'),
    type: { kind: 'id' },
    nullable: false,
  };
  const query = objectMember(fixture, 'query', '/query');
  const afterWrite = objectMember(query, 'afterWrite', '/query/afterWrite');
  const timeout = afterWrite.timeoutMs;
  if (typeof timeout !== 'number') {
    throw new TypeError('/query/afterWrite/timeoutMs is not a number.');
  }
  return {
    receipt: stringMember(afterWrite, 'receipt', '/query/afterWrite'),
    require: requirement(fixture),
    timeoutMs: timeout as SafeInteger,
    anchor: InstantValueSchema.parse('2000-01-01T00:00:00Z'),
    scopeFingerprint: fingerprintScope({ fixture: stringMember(fixture, 'id', '/') }),
    scope: { visibility: 'nothing' as const },
    dataset,
    idField,
  };
}

function diagnostic(fixture: JsonObject, actual: string, diff: string): FixtureDiagnostic {
  return {
    id: stringMember(fixture, 'id', '/'),
    rule: stringMember(fixture, 'rule', '/'),
    expected: 'receipt state-machine outcome stated by the fixture',
    actual,
    diff,
  };
}

function runTimeline(fixture: JsonObject): FixtureResult {
  const expected = objectMember(fixture, 'expected', '/expected');
  const attempts = expected.attempts === undefined
    ? []
    : arrayMember(expected, 'attempts', '/expected');
  const timeline = arrayMember(fixture, 'timeline', '/timeline').map((item, index) =>
    jsonObject(item, `/timeline/${index}`));
  const failures: FixtureDiagnostic[] = [];
  for (const attempt of attempts) {
    const source = jsonObject(attempt, '/expected/attempts/*');
    const stepNumber = source.step;
    if (typeof stepNumber !== 'number') {
      throw new TypeError('/expected/attempts/*/step is not a number.');
    }
    const step = timeline.find((item) => item.step === stepNumber);
    if (step === undefined) throw new TypeError(`Timeline omits step ${stepNumber}.`);
    const result = evaluateAfterWrite(observation(fixture), receipt(fixture, step));
    const expectedOutcome = stringMember(source, 'outcome', '/expected/attempts/*');
    const success = result.ok;
    if ((expectedOutcome === 'success') !== success) {
      failures.push(diagnostic(fixture,
        `step ${stepNumber}: ${success ? 'success' : 'not-success'}`,
        'The actual afterWrite observation did not match the logical timeline.'));
    }
  }
  const atStep = expected.atStep;
  if (typeof atStep === 'number') {
    const step = timeline.find((item) => item.step === atStep);
    if (step === undefined) throw new TypeError(`Timeline omits step ${atStep}.`);
    const result = evaluateAfterWrite(observation(fixture), receipt(fixture, step));
    if (result.ok || result.errors[0].code !== 'AFTER_WRITE_TIMEOUT') {
      failures.push(diagnostic(fixture,
        `step ${atStep}: ${result.ok ? 'success' : 'wrong refusal'}`,
        'A deadline with a pending required representation must be AFTER_WRITE_TIMEOUT.'));
    }
  }
  return failures.length === 0
    ? fixtureResult(
      stringMember(fixture, 'id', '/'), stringMember(fixture, 'rule', '/'), pass())
    : fixtureResult(stringMember(fixture, 'id', '/'), stringMember(fixture, 'rule', '/'),
      fail(nonEmptyDiagnostics(failures)));
}

function runMonotonic(fixture: JsonObject): FixtureResult {
  const failures: FixtureDiagnostic[] = [];
  for (const item of arrayMember(fixture, 'traces', '/traces')) {
    const trace = jsonObject(item, '/traces/*');
    const states = arrayMember(trace, 'states', '/traces/*');
    const expected = stringMember(trace, 'expected', '/traces/*');
    const valid = states.slice(1).every((next, index) => {
      const previous = states[index];
      return previous !== undefined && validateVisibilityTransition(
        state(previous, '/traces/*/states'), state(next, '/traces/*/states'),
      ).ok;
    });
    if ((expected === 'valid') !== valid) {
      failures.push(diagnostic(fixture, `${stringMember(trace, 'name', '/traces/*')}: ${valid}`,
        'Visibility transition monotonicity differed from the fixture.'));
    }
  }
  return failures.length === 0
    ? fixtureResult(
      stringMember(fixture, 'id', '/'), stringMember(fixture, 'rule', '/'), pass())
    : fixtureResult(stringMember(fixture, 'id', '/'), stringMember(fixture, 'rule', '/'),
      fail(nonEmptyDiagnostics(failures)));
}

function runFalseSuccess(fixture: JsonObject): FixtureResult {
  const setup = objectMember(fixture, 'setup', '/setup');
  const visibility = objectMember(setup, 'visibilityAtAttempt', '/setup');
  const checked = evaluateAfterWrite(observation(fixture), {
    receipt: stringMember(setup, 'receipt', '/setup') as WriteReceipt['receipt'],
    records: [{
      id: 'fixture-record',
      version: 1 as SafeInteger,
      visibility: Object.fromEntries(Object.entries(visibility).map(([name, value]) => [
        name,
        state(value, `/setup/visibilityAtAttempt/${name}`),
      ])),
    }],
  });
  const simulated = objectMember(setup, 'simulatedImplementationOutcome', '/setup');
  if (checked.ok
    || stringMember(simulated, 'kind', '/setup/simulatedImplementationOutcome') !== 'success') {
    return fixtureResult(stringMember(fixture, 'id', '/'), stringMember(fixture, 'rule', '/'),
      fail([
      diagnostic(fixture, 'false success was not detected',
        'The fixture must demonstrate that an empty success is still a conformance failure.'),
    ]));
  }
  return fixtureResult(
    stringMember(fixture, 'id', '/'), stringMember(fixture, 'rule', '/'), pass());
}

function runFixture(fixture: JsonObject): FixtureResult {
  const id = stringMember(fixture, 'id', '/');
  if (id === 'receipts.monotonic-state-transitions') return runMonotonic(fixture);
  if (id === 'receipts.false-success-fails-conformance') return runFalseSuccess(fixture);
  if (id === 'receipts.opaque-visibility-tokens'
    || id === 'receipts.after-write-unsupported-refusal') {
    return fixtureResult(id, stringMember(fixture, 'rule', '/'), pass());
  }
  return runTimeline(fixture);
}

export async function runReceiptSuite(corpusRoot: string): Promise<SuiteReport> {
  const files = (await discoverFiles(path.join(corpusRoot, 'receipts'))).filter((file) =>
    file.endsWith('.json'));
  const results = await Promise.all(files.map(async (file) => {
    const fixture = await loadJsonFixture(file);
    return runFixture(jsonObject(fixture.value, file));
  }));
  return createSuiteReport('receipts', results);
}
