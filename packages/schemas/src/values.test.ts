import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanonicalDecimalSchema,
  CurrencyCodeSchema,
  DateValueSchema,
  InstantValueSchema,
  MoneyValueSchema,
  NormalizedTextSchema,
  addDecimal,
  addMoney,
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
  subtractDecimal,
} from './values.ts';

function decimal(value: string) {
  const parsed = CanonicalDecimalSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid test decimal: ${value}`);
  return parsed.data;
}

test('decimal boundaries reject binary floats and normalize textual spellings', () => {
  assert.equal(CanonicalDecimalSchema.safeParse(0.1).success, false);
  for (const value of ['.5', '1e39']) {
    assert.equal(CanonicalDecimalSchema.safeParse(value).success, false, value);
  }
  assert.equal(CanonicalDecimalSchema.parse('01'), '1');
  assert.equal(CanonicalDecimalSchema.parse('+1'), '1');
  assert.equal(CanonicalDecimalSchema.parse('1.0'), '1');
  assert.equal(CanonicalDecimalSchema.parse('1e3'), '1000');
  assert.equal(CanonicalDecimalSchema.parse('-0'), '0');
  for (const value of ['0', '-12', '12.34', '-0.001']) {
    assert.equal(CanonicalDecimalSchema.safeParse(value).success, true, value);
  }
});

test('decimal arithmetic never takes a JavaScript number value path', () => {
  assert.equal(addDecimal(decimal('0.1'), decimal('0.2')), '0.3');
  assert.equal(
    addDecimal(decimal('999999999999999999999999.9'), decimal('0.1')),
    '1000000000000000000000000',
  );
  assert.equal(subtractDecimal(decimal('1'), decimal('1.25')), '-0.25');
  assert.equal(multiplyDecimal(decimal('-12.5'), decimal('0.08')), '-1');
  assert.equal(compareDecimal(decimal('2.0001'), decimal('2')), 1);
  const exact = divideDecimal(decimal('1'), decimal('8'), {
    decimalPlaces: 3,
    rounding: 'halfEven',
  });
  assert.deepEqual(exact, { ok: true, value: '0.125' });
  const rounded = divideDecimal(decimal('1'), decimal('3'), {
    decimalPlaces: 4,
    rounding: 'halfEven',
  });
  assert.deepEqual(rounded, { ok: true, value: '0.3333' });
});

test('money carries currency and cross-currency arithmetic is a typed refusal', () => {
  const gbp = MoneyValueSchema.safeParse({ amount: '12.50', currency: 'GBP' });
  assert.equal(gbp.success, true, 'money amount is normalized at the boundary');
  const left = MoneyValueSchema.parse({ amount: '12.5', currency: 'GBP' });
  const right = MoneyValueSchema.parse({ amount: '0.5', currency: 'GBP' });
  assert.deepEqual(addMoney(left, right), {
    ok: true,
    value: { amount: '13', currency: 'GBP' },
  });
  const usd = MoneyValueSchema.parse({ amount: '1', currency: 'USD' });
  const refused = addMoney(left, usd);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, 'CROSS_CURRENCY_AGGREGATION');
  assert.equal(CurrencyCodeSchema.safeParse('ZZZ').success, false);
});

test('text, dates, and instants enforce their canonical forms', () => {
  assert.equal(NormalizedTextSchema.safeParse('é').success, true);
  assert.equal(NormalizedTextSchema.safeParse('e\u0301').success, true);
  assert.equal(NormalizedTextSchema.parse('e\u0301'), 'é');
  assert.equal(DateValueSchema.safeParse('2024-02-29').success, true);
  assert.equal(DateValueSchema.safeParse('2023-02-29').success, false);
  assert.equal(InstantValueSchema.safeParse('2024-02-29T23:59:59.123456789Z').success, true);
  assert.equal(InstantValueSchema.safeParse('2024-02-29T23:59:59+00:00').success, false);
});
