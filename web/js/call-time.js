// Время звонков. Метки реплик звонка: ISO 8601 с поясом.
// Допущение A2 (docs Нуржана): позиция реплики в аудио = время реплики минус время первой реплики диалога.

// Смещения (в секундах) для каждой реплики; null, если метку не удалось разобрать или смещение отрицательное.
export function computeOffsets(transcript) {
  const turns = Array.isArray(transcript) ? transcript : [];
  const first = turns.length ? Date.parse(turns[0].timestamp) : NaN;
  return turns.map((t) => {
    const at = Date.parse(t.timestamp);
    if (!Number.isFinite(first) || !Number.isFinite(at) || at < first) return null;
    return (at - first) / 1000;
  });
}

// 75 секунд -> «01:15» (минуты не обрезаются на 59: 3725 с -> «62:05»)
export function formatMMSS(sec) {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
