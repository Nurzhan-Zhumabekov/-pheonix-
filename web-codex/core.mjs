const isoWithZone = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i;

export function audioOffset(turns, index) {
  const turn = turns[index];
  if (!turn) return null;
  if (Number.isFinite(turn.audio_offset_sec) && turn.audio_offset_sec >= 0) {
    return { seconds: turn.audio_offset_sec, approximate: false };
  }
  const stamp = turn.timestamp;
  const relative = /^(?:(\d+):)?(\d+):([0-5]\d)(\.\d+)?$/.exec(stamp);
  if (relative && (!relative[1] || Number(relative[2]) < 60)) {
    return { seconds: Number(relative[1] || 0) * 3600 + Number(relative[2]) * 60 + Number(relative[3] + (relative[4] || '')), approximate: false };
  }
  const initial = turns[0]?.timestamp;
  if (!isoWithZone.test(stamp) || !isoWithZone.test(initial)) return null;
  const seconds = (Date.parse(stamp) - Date.parse(initial)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? { seconds, approximate: true } : null;
}

export function answerValues(criterion) {
  const options = criterion.type === 'scale' ? [...criterion.scale] : ['yes', 'no'];
  if (criterion.na_allowed && criterion.type !== 'flag') options.push('na');
  return options;
}

export function buildLabel(checklist, selections, gross, labeler, note) {
  const answers = [];
  for (const criterion of checklist.criteria) {
    if (criterion.type === 'flag') continue;
    const selected = selections.get(criterion.id);
    const answer = answerValues(criterion).find(value => String(value) === selected);
    if (answer !== undefined) answers.push([criterion.id, answer]);
  }
  return {
    checklist_version: checklist.version,
    answers: Object.fromEntries(answers),
    gross: gross === '' ? null : gross === 'true',
    labeler: labeler.trim(),
    note,
  };
}

export function labelCompletion(checklist, label) {
  const criteria = checklist.criteria.filter(criterion => criterion.type !== 'flag');
  const answers = label?.answers ?? {};
  const filled = criteria.filter(criterion => answerValues(criterion).includes(answers[criterion.id])).length;
  return { filled: filled + Number(typeof label?.gross === 'boolean'), total: criteria.length + 1 };
}

export function validateChecklist(checklist) {
  if (!checklist.criteria.length) return 'Добавьте хотя бы один критерий.';
  const seen = new Set();
  const sections = new Set(checklist.sections.map(section => section.id));
  for (const item of checklist.criteria) {
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(item.id)) return 'ID должен содержать 1–60 латинских букв, цифр, дефисов или подчёркиваний.';
    if (seen.has(item.id)) return `ID «${item.id}» повторяется.`;
    seen.add(item.id);
    if (!item.name.trim() || !item.description.trim()) return `Заполните название и формулировку критерия «${item.id}».`;
    if (!['binary', 'scale', 'flag'].includes(item.type)) return `Неизвестный тип у критерия «${item.id}».`;
    if (!Number.isFinite(item.weight) || item.weight < 0 || (item.type === 'flag' && item.weight !== 0)) return `Проверьте вес критерия «${item.id}».`;
    if (item.section !== null && !sections.has(item.section)) return `Проверьте секцию критерия «${item.id}».`;
    if (item.type === 'scale') {
      const steps = item.scale;
      if (steps.length < 2 || steps.some(n => !Number.isFinite(n) || n < 0) || new Set(steps).size !== steps.length || Math.max(...steps) <= 0) {
        return `В шкале «${item.id}» нужны минимум две разные неотрицательные ступени.`;
      }
    }
    if (item.na_allowed && !item.na_condition?.trim()) return `Укажите условие N/A для «${item.id}».`;
  }
  return '';
}
