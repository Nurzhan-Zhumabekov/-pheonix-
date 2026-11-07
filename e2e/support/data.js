// Синтетические диалоги (формат Conversation из backend/src/model.rs).
// Сервер читает их из STORAGE_DIR/conversations_dev.json: обычный JSON-массив.
// Реплики нарочно подобраны так, чтобы первая реплика оператора была под разными номерами:
// mock-judge ставит доказательством первую реплику оператора, и по ней видно сквозную нумерацию.

export const CHAT_1 = {
  conversation_id: 'e2e-ru-chat-001',
  channel: 'agent chat',
  language: 'RU',
  audio_url: null,
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Здравствуйте! Не могу войти в личный кабинет, пишет, что пароль неверный.' },
    { timestamp: '00:12', speaker: 'operator', text: 'Здравствуйте! Меня зовут Айгерим, компания Тест. Подскажите, пожалуйста, ваш логин.' },
    { timestamp: '00:25', speaker: 'client', text: 'Логин ivan.petrov, пароль точно правильный.' },
    { timestamp: '00:41', speaker: 'operator', text: 'Спасибо. Для проверки личности назовите номер договора.' },
    { timestamp: '00:55', speaker: 'client', text: 'Договор 12345.' },
    { timestamp: '01:20', speaker: 'operator', text: 'Проверка пройдена. Я сбросил пароль, ссылка для нового придёт на почту в течение пяти минут.' },
    { timestamp: '01:31', speaker: 'operator', text: 'Могу ещё чем-то помочь? Всего доброго!' },
  ],
};

export const CHAT_2 = {
  conversation_id: 'e2e-ru-chat-002',
  channel: 'agent chat',
  language: 'RU',
  audio_url: null,
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Добрый день.' },
    { timestamp: '00:05', speaker: 'client', text: 'У меня списали комиссию за перевод, хочу понять, за что.' },
    { timestamp: '00:20', speaker: 'operator', text: 'Добрый день! Меня зовут Данияр. Сейчас уточню по вашему переводу.' },
    { timestamp: '00:31', speaker: 'client', text: 'Жду.' },
    { timestamp: '01:02', speaker: 'operator', text: 'Комиссия составила один процент по тарифу. Что-нибудь ещё подсказать?' },
    { timestamp: '01:10', speaker: 'client', text: 'Нет, спасибо.' },
  ],
};

// Звонок без записи: метки времени ISO 8601 с поясом, как у реальных звонков.
export const CALL_3 = {
  conversation_id: 'e2e-ru-call-003',
  channel: 'voice call',
  language: 'RU',
  audio_url: null,
  transcript: [
    { timestamp: '2026-11-01T10:00:00+05:00', speaker: 'operator', text: 'Добрый день, служба поддержки, меня зовут Асем. Чем могу помочь?' },
    { timestamp: '2026-11-01T10:00:09+05:00', speaker: 'client', text: 'Хочу узнать статус моей заявки на карту.' },
    { timestamp: '2026-11-01T10:00:20+05:00', speaker: 'operator', text: 'Назовите, пожалуйста, кодовое слово для проверки личности.' },
    { timestamp: '2026-11-01T10:00:27+05:00', speaker: 'client', text: 'Роза.' },
    { timestamp: '2026-11-01T10:00:41+05:00', speaker: 'operator', text: 'Спасибо, заявка на выпуск карты одобрена, карту доставят в течение трёх дней. Всего доброго!' },
  ],
};

export const CONVERSATIONS = [CHAT_1, CHAT_2, CALL_3];

// Названия из config/checklist.default.json (версия 1).
export const CRITERIA_V1 = [
  'Установление контакта',
  'Выявление потребности',
  'Идентификация',
  'Корректная и полная консультация',
  'Эмпатия и клиентоориентированность',
  'Управление диалогом, скорость и грамотность',
  'Завершение',
];
export const SECTION_NAMES = [
  'Начало и понимание запроса',
  'Безопасность и решение',
  'Ведение и завершение диалога',
  'Грубые нарушения',
];
export const CONSULTATION = 'Корректная и полная консультация';
