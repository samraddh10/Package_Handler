const isNumber = require('is-number');

function double(value) {
  if (!isNumber(value)) {
    throw new TypeError(`not a number: ${value}`);
  }
  return Number(value) * 2;
}

module.exports = { double };
