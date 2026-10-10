const assert = require('node:assert/strict');
const { test } = require('node:test');
const { double } = require('../index');

test('doubles numbers and numeric strings', () => {
  assert.equal(double(2), 4);
  assert.equal(double('21'), 42);
});

test('refuses things that are not numbers', () => {
  assert.throws(() => double('abc'), TypeError);
});
