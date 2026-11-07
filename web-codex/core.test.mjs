import assert from 'node:assert/strict';
import test from 'node:test';
import { audioOffset, answerValues, buildLabel, labelCompletion, validateChecklist } from './core.mjs';

test('audio links prefer an explicit offset and mark ISO estimates', () => {
  const iso = [{ timestamp: '2026-11-07T13:15:31+05:00' }, { timestamp: '2026-11-07T13:15:38+05:00' }];
  assert.deepEqual(audioOffset(iso, 1), { seconds: 7, approximate: true });
  iso[1].audio_offset_sec = 9.5;
  assert.deepEqual(audioOffset(iso, 1), { seconds: 9.5, approximate: false });
  assert.deepEqual(audioOffset([{ timestamp: '03:12' }], 0), { seconds: 192, approximate: false });
  assert.equal(audioOffset([{ timestamp: '12:79' }], 0), null);
  assert.equal(audioOffset([{ timestamp: '2026-11-07T13:15:38' }], 0), null);
});

test('appeal choices preserve numeric scores and limit N/A to allowed criteria', () => {
  assert.deepEqual(answerValues({ type: 'scale', scale: [0, 4, 7, 10], na_allowed: true }), [0, 4, 7, 10, 'na']);
  assert.deepEqual(answerValues({ type: 'flag', na_allowed: true }), ['yes', 'no']);
});

test('editor rejects duplicate IDs, unusable scales, and absent N/A rule', () => {
  const item = { id: 'custom', name: 'Новый критерий', description: 'Условие', type: 'scale', scale: [0, 7, 10], weight: 5, na_allowed: false, section: null };
  assert.equal(validateChecklist({ sections: [], criteria: [item] }), '');
  assert.match(validateChecklist({ sections: [], criteria: [item, item] }), /повторяется/);
  assert.match(validateChecklist({ sections: [], criteria: [{ ...item, scale: [0, 0] }] }), /шкал/);
  assert.match(validateChecklist({ sections: [], criteria: [{ ...item, na_allowed: true }] }), /N\/A/);
});

test('manual labels preserve zero, explicit N/A and false while omitting unanswered criteria', () => {
  const checklist = { version: 3, criteria: [
    { id: 'needs', type: 'binary', na_allowed: true },
    { id: 'consultation', type: 'scale', scale: [0, 5, 10] },
    { id: 'contact', type: 'binary' },
    { id: 'gross', type: 'flag' },
  ] };
  const selected = new Map([['needs', 'na'], ['consultation', '0'], ['contact', ''], ['gross', 'yes']]);
  const label = buildLabel(checklist, selected, 'false', '  Нуржан  ', 'Черновик');
  assert.deepEqual(label, {
    checklist_version: 3, answers: { needs: 'na', consultation: 0 }, gross: false,
    labeler: 'Нуржан', note: 'Черновик',
  });
  assert.deepEqual(labelCompletion(checklist, label), { filled: 3, total: 4 });
  assert.deepEqual(buildLabel(checklist, new Map(), '', '', '').answers, {});
  assert.equal(buildLabel(checklist, new Map(), '', '', '').gross, null);
});
