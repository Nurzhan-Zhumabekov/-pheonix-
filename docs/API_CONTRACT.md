# Контракт между ML и фронтендом

Форматы менять только по договорённости обоих. Пока judge не готов, `POST /api/evaluate` может отдавать заглушку с `"mock": true`.

## Чек-лист (конфигурация)

Хранится в `storage/`, меняется через интерфейс. Judge строит промпты только из этого конфига, поэтому заменённый критерий применяется без правки кода.

```json
{
  "version": 3,
  "sections": [
    { "id": "start", "name": "Начало и понимание запроса" },
    { "id": "safety", "name": "Безопасность и решение" },
    { "id": "flow", "name": "Ведение и завершение диалога" },
    { "id": "gross", "name": "Грубые нарушения" }
  ],
  "criteria": [
    {
      "id": "contact",
      "name": "Установление контакта",
      "description": "Да, если оператор в первом ответе поздоровался на языке клиента и представился.",
      "type": "binary",
      "weight": 10,
      "na_allowed": false,
      "na_condition": null,
      "section": "start"
    },
    {
      "id": "consult",
      "name": "Корректная и полная консультация",
      "description": "20: важные вопросы закрыты. 15: пропущена второстепенная деталь. 10: осталась важная часть. 5: общая подсказка. 0: нет ответа или рекомендация неверна.",
      "type": "scale",
      "scale": [0, 5, 10, 15, 20],
      "weight": 20,
      "na_allowed": true,
      "na_condition": "Чат закончился до того, как клиент сформулировал запрос.",
      "section": "safety"
    },
    {
      "id": "gross",
      "name": "Грубые ошибки",
      "description": "Оскорбление клиента, платная услуга в обход компании, раскрытие конфиденциальной информации.",
      "type": "flag",
      "weight": 0,
      "na_allowed": false,
      "na_condition": null,
      "section": "gross"
    }
  ]
}
```

Поля критерия:

| Поле | Значение |
|---|---|
| `type` | `binary` (Да/Нет), `scale` (ступени из `scale`), `flag` (отдельный флаг без веса) |
| `scale` | допустимые значения, максимум = наибольшее |
| `weight` | число ≥ 0, у `flag` равен 0 |
| `na_allowed` | можно ли ответить N/A |
| `na_condition` | текст условия N/A, подставляется в промпт |
| `section` | id секции или `null` |

## Результат оценки

```json
{
  "mock": false,
  "conversation_id": "…",
  "channel": "agent chat",
  "language": "RU",
  "checklist_version": 3,
  "criteria": [
    {
      "criterion_id": "consult",
      "answer": 15,
      "share": 0.75,
      "weight": 20,
      "points": 15,
      "explanation": "Основной вопрос решён, не названа комиссия.",
      "evidence": [
        { "turn_index": 12, "speaker": "operator", "timestamp": "03:41", "quote": "дословная цитата", "role": "supports" }
      ],
      "checked_range": { "from_turn": 4, "to_turn": 18 },
      "na_reason": null
    }
  ],
  "sections": [{ "id": "s1", "score": 82.5 }],
  "total": 71.18,
  "gross_error": { "flag": false, "explanation": null, "evidence": [] },
  "model": { "name": "…", "calls": 8, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0 }
}
```

Правила:

- `answer`: `"yes"`, `"no"`, `"na"`, число из `scale`. Для `flag` отдельный блок `gross_error`.
- `evidence`: непустой для Да/Нет/числа. `quote` дословная, на языке диалога. `timestamp` как в исходных данных, без преобразования. Подтверждением может быть и системное сообщение (`speaker`: `system`).
- `turn_index`: позиция в массиве `transcript`, с нуля. По нему фронтенд скроллит к реплике.
- Для пропущенного действия (например, не было приветствия) `evidence` указывает место, где действие ожидалось (`role`: `expected_location`), и заполнен `checked_range`: проверенный участок. В PDF: «укажите место, где оно ожидалось».
- Для `na`: заполнен `na_reason`, `share`, `points` равны `null`.
- `total` равен `null`, если нет применимых критериев с весом.
- Для звонка в реплике может быть `audio_offset_sec` (число или `null`). См. допущение в [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md).

## Эндпоинты

Ошибки: `{"error": {"code": "…", "message": "…"}}` с HTTP-статусом, в том числе для некорректного JSON в теле (`bad_json`, 400). Коды: `bad_group`, `no_source`, `no_conversation`, `invalid_checklist`, `no_evaluation`, `no_criterion`, `score_error`, `empty_comment`, `empty_reason`, `bad_action`, `no_answer`, `no_appeal`, `already_resolved` (409), `upstream_error` (502), `judge_error` (502), `storage_error` (500), `checklist_version_missing` (409: архивной версии нет, пересчёт по текущему чек-листу не делается), `no_checklist_version` (404), `open_appeal` (409), `no_label` (404), `bad_label` (400).

| Метод и путь | Назначение |
|---|---|
| `GET /api/health` | проверка, `{"ok": true}` |
| `GET /api/conversations?group=dev\|control` | `{"group", "count", "items": [{"conversation_id", "channel", "language", "turns", "turns_count", "evaluated", "has_evaluation"}]}`. Поля `turns_count` и `has_evaluation` дублируют `turns` и `evaluated` (их ждёт интерфейс Дарии). Первый запрос загружает набор из API организаторов и кэширует в `storage/`, параметр `refresh=true` загружает заново |
| `GET /api/conversations/{id}` | диалог целиком: `transcript`, `audio_url` для звонка |
| `GET /api/checklist` | текущий чек-лист |
| `PUT /api/checklist` | сохранить чек-лист, версия растёт на 1. Каждая версия хранится отдельно. Валидация: уникальные id, вес не меньше 0, у шкалы непустой набор значений, у флага вес 0, секции объявлены |
| `GET /api/checklists/{version}` | чек-лист указанной версии из архива (404 `no_checklist_version`, если её нет) |
| `GET /api/labels` | все разметки: объект `conversation_id → метка` |
| `GET /api/labels/{conversation_id}` | разметка диалога (404 `no_label`) |
| `PUT /api/labels/{conversation_id}` | полная замена разметки. Тело: `{"checklist_version"?, "answers", "gross", "labeler", "note"}`. Версия по умолчанию текущая. 400 `bad_label` или `no_checklist_version`, 404 `no_conversation`. Ответ: сохранённая метка с `updated_at` |
| `GET /api/report` | согласие модели с разметкой (структура в разделе ниже) |
| `POST /api/evaluate` | тело `{"conversation_id": "…"}`, ответ: результат оценки. 409 `open_appeal`, если по диалогу есть нерассмотренная апелляция: сначала нужно принять решение |
| `GET /api/evaluations/{conversation_id}` | последняя сохранённая оценка |
| `POST /api/appeals` | тело `{"conversation_id", "criterion_id", "comment"}` |
| `GET /api/appeals?conversation_id=…` | список апелляций |
| `POST /api/appeals/{id}/resolve` | тело `{"action": "confirm"\|"change", "new_answer": …, "reason": "…"}` |

`audio_url` в ответах отдаём как есть из данных организаторов. В репозиторий такие ссылки не пишем.

Фронтенд обращается только к нашему `/api`, не к API организаторов напрямую: по FAQ в guide ошибку CORS обходят через серверную часть или локальный адаптер. Заодно подписанная ссылка не попадает в браузер.

## Апелляция

```json
{
  "id": "ap_1",
  "conversation_id": "…",
  "criterion_id": "consult",
  "comment": "Комиссия названа в реплике 14.",
  "fragment": { "from_turn": 12, "to_turn": 15 },
  "status": "resolved",
  "created_at": "…",
  "original": { "answer": 15, "points": 15 },
  "decision": { "action": "change", "new_answer": 20, "reason": "…", "decided_at": "…" },
  "final": { "answer": 20, "points": 20 },
  "total_before": 71.18,
  "total_after": 77.06
}
```

- `status`: `open` или `resolved`.
- `fragment`: участок диалога вокруг спорной оценки. Проверяющий видит спорную оценку, комментарий и этот фрагмент (требование guide). По умолчанию берётся из `evidence` критерия.
- Подача апелляции и решение проверяющего это два отдельных действия в интерфейсе, авторизации нет.
- При `confirm` `final` равен `original`, итог не меняется.
- При `change` итог пересчитывается функцией `scoring` по чек-листу той версии, по которой выставлена оценка (`checklist_version`), а не по текущему. Результат записывается в оценку, исходная оценка остаётся в `original`.
- `new_answer`: `"yes"`, `"no"`, `"na"` или число из шкалы. Недопустимый ответ (например, N/A там, где он запрещён) даёт 400 `score_error`.

## Разметка и отчёт согласия

Метка (формат утверждён Claude и Codex):

```json
{
  "checklist_version": 3,
  "answers": { "contact": "yes", "consultation": 20 },
  "gross": false,
  "labeler": "имя",
  "note": "",
  "updated_at": "2026-11-07T20:00:00Z"
}
```

- Нет ключа в `answers` значит «не размечено», `"na"` явный N/A, число ступень шкалы, `gross: null` не размечено. Флаг в `answers` нельзя, только через `gross`.
- Допустимость ответов проверяется по версии чек-листа метки: неизвестный критерий, N/A там, где он запрещён, значение вне шкалы дают 400 `bad_label`. Пустые `answers` допустимы (черновик).
- Метка привязана к версии чек-листа. Отчёт сравнивает только оценки той же версии.

`GET /api/report`:

```json
{
  "conversations": {
    "labeled": 15,
    "evaluated_and_labeled": 14,
    "compared": 13,
    "skipped_no_evaluation": ["id-1"],
    "skipped_version_mismatch": ["id-2"]
  },
  "criteria": [
    {
      "criterion_id": "consultation",
      "compared": 13,
      "exact": 8,
      "exact_rate": 0.615,
      "scale_compared": 13,
      "within_one_step": 12,
      "within_one_step_rate": 0.923
    }
  ],
  "na": { "both_na": 4, "label_only_na": 1, "model_only_na": 2 },
  "gross": { "compared": 13, "agree": 13, "label_yes_model_no": 0, "label_no_model_yes": 0 },
  "total": { "compared": 6, "unavailable": 7, "mean_abs_diff": 3.82, "max_abs_diff": 9.1 }
}
```

- Сравниваются только размеченные поля. `criteria` идут в порядке чек-листа.
- `within_one_step` считается только для шкальных критериев: N/A и число соседними ступенями не считаются.
- `total` сравнивается, только если размечены все критерии кроме флага (иначе итог разметки не определён и диалог попадает в `unavailable`).
- Значения `*_rate` округлены до трёх знаков, `null`, если сравнивать нечего.
