// CJS stub for uuid (v13 is ESM-only, incompatible with Jest's CJS transform)
let counter = 0;
module.exports = {
  v4: () => `test-uuid-${++counter}`,
};
