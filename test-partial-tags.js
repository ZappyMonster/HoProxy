// Test the current (buggy) constants
const FUNCTION_CALLS_START_TAG = '<function_calls';
const ANTML_FUNCTION_CALLS_START_TAG = '<function_calls';  // BUG: same as above

// Simulate a chunk that ends with partial antml: prefix
const testCases = [
  '<antml',
  '<',
  '<f',
  '<func',
  '<function_calls',
  '<',
  '<f',
  '<func',
  '<function_calls'
];

console.log('Testing with BUGGY constants (both are "<function_calls"):');
for (const possibleTag of testCases) {
  const match1 = FUNCTION_CALLS_START_TAG.startsWith(possibleTag);
  const match2 = ANTML_FUNCTION_CALLS_START_TAG.startsWith(possibleTag);
  console.log(`  ${JSON.stringify(possibleTag).padEnd(30)} -> FUNCTION_CALLS: ${match1}, ANTML: ${match2}, Would buffer: ${match1 || match2}`);
}

console.log('\n--- WITH FIXED CONSTANT ("<' + 'antml:function_calls") ---');
const FIXED = '<' + 'antml:function_calls';
for (const possibleTag of testCases) {
  const match1 = FUNCTION_CALLS_START_TAG.startsWith(possibleTag);
  const match2 = FIXED.startsWith(possibleTag);
  console.log(`  ${JSON.stringify(possibleTag).padEnd(30)} -> FUNCTION_CALLS: ${match1}, ANTML_FIXED: ${match2}, Would buffer: ${match1 || match2}`);
}
