// Компонент: плеер записи звонка.
// createAudioPlayer() -> { el, show(conversation), hide(), seek(sec) }
// Адрес записи попадает только в атрибут src: не логируется и не выводится в страницу.
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
    node.setAttribute('src', conversation.audio_url);
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
