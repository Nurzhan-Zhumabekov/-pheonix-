// Компонент: плеер записи звонка.
// createAudioPlayer() -> { el, show(conversation), hide(), seek(sec) }
// audio_url организаторов ведёт на HTML-страницу плеера, а не на файл, поэтому в src идёт адрес нашего сервера:
// он достаёт файл со страницы и перенаправляет на него. Внешний адрес не логируется и не выводится в страницу.
import { API_BASE } from '../config.js';
import { clear, el } from '../dom.js';

export function createAudioPlayer() {
  const root = el('div', { class: 'player', hidden: true });
  let audio = null;

  function hide() {
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio = null;
    }
    clear(root);
    root.hidden = true;
  }

  function show(conversation) {
    hide();
    if (conversation.channel !== 'voice call') return;
    root.hidden = false;
    if (!conversation.audio_url) {
      root.append(el('div', { class: 'player__msg', text: 'Запись недоступна' }));
      return;
    }
    const status = el('div', { class: 'player__msg player__msg--err', hidden: true, text: 'Не удалось загрузить запись' });
    const node = el('audio', { class: 'player__audio', controls: true, preload: 'metadata' });
    node.addEventListener('error', () => {
      node.hidden = true;
      status.hidden = false;
    });
    node.setAttribute('src', `${API_BASE}/api/conversations/${encodeURIComponent(conversation.conversation_id)}/audio`);
    audio = node;
    root.append(node, status);
  }

  // Перемотка и запуск воспроизведения (если браузер разрешает).
  function seek(sec) {
    if (!audio || audio.hidden || !Number.isFinite(sec)) return false;
    audio.currentTime = sec;
    const p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return true;
  }

  return { el: root, show, hide, seek };
}
