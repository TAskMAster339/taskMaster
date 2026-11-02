import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyboardCombination } from '../src/shortcuts.ts';
const event = (code, modifiers={}) => ({code, ctrlKey:false, altKey:false, shiftKey:false, metaKey:false, ...modifiers});
test('matches physical keys regardless of typing layout and exact modifiers', () => {
  assert.equal(keyboardCombination(event('KeyN',{ctrlKey:true})), 'Ctrl+N');
  assert.equal(keyboardCombination(event('KeyN',{ctrlKey:true,shiftKey:true})), 'Ctrl+Shift+N');
  assert.equal(keyboardCombination(event('Comma',{ctrlKey:true})), 'Ctrl+Comma');
  assert.equal(keyboardCombination(event('ArrowUp',{altKey:true})), 'Alt+ArrowUp');
  assert.equal(keyboardCombination(event('F2')), 'F2');
});
test('ignores modifier-only, unsupported and Windows key combinations', () => {
  for (const e of [event('ControlLeft',{ctrlKey:true}),event('KeyN'),event('KeyF'),event('KeyN',{metaKey:true}),event('Enter')]) assert.equal(keyboardCombination(e),null);
});
