# Changelog

## 1.1.4

### Code review fixes without UX changes

- Socketlib handlers больше не теряют transport-provided identity из-за `.bind(this)`: входящие запросы связываются с фактическим `socketdata.userId`, а сессия не может быть выдана или использована от имени другого пользователя. Это не требует WebCrypto/HTTPS и сохраняет работу в локальной HTTP-сети.
- Library writes от нескольких GM проходят через единый authority-GM и сериализованную очередь; optimistic revision check теперь действительно защищает от параллельной записи между клиентами.
- Импорт библиотеки сначала инициирует скачивание backup текущего состояния и только затем выполняет замену.
- Права игроков сохраняются как sparse overrides относительно строки по умолчанию; изменение default теперь применяется к пользователям без индивидуального override, а интерфейс автоматически обновляет наследуемые checkbox без изменения внешнего UX.
- Pointer drag/resize/calibration/volume используют pointer capture, `pointercancel` и симметричную очистку глобальных listeners, поэтому чужой `pointerup` больше не может оставить `pointermove` активным.
- Неизвестный режим доступа кассеты fail-closed в `locked`; список режимов доступа централизован.
- Lookup аудиоэффектов переведён на immutable null-prototype preset table, исключая inherited-key lookup.
- Protocol-relative и UNC-подобные audio paths (`//host/...`, `\\host\...`) отклоняются до нормализации локального пути.
- Same-track sync считается non-mutating только если текущий audio handle действительно играет, что исключает перекрывающиеся startup/play операции после паузы.
- Публичный API больше не выдаёт игрокам полную скрытую библиотеку; import preview и полная inspection/diagnostics остаются GM-only.
- Preload исправляет synchronous cached-metadata TDZ, всегда использует стабильную форму summary и при ограниченном cache сначала прогревает текущую и следующую дорожки.

### Tests

- Добавлены регрессии для caller-bound socket sessions без secure-context crypto, sparse permissions inheritance, authority write serialization, protocol-relative paths, preset prototype safety, synchronous metadata preload и current/next preload priority.
- Автоматический набор: 44 теста.

## 1.1.3

### Performance without UX changes

- Периодический sync-pulse при активном multiplayer playback передаётся как authenticated ephemeral command через уже выданные socketlib-сессии и в нормальном случае больше не переписывает `deckState`; при отсутствии валидной сессии или ошибке доставки автоматически используется прежний committed world-state fallback. При неактивном playback и без удалённых клиентов pulse не выполняет лишнюю работу.
- Natural-end timer больше не пересоздаётся на sync/update, если фактическое расписание окончания трека не изменилось.
- Моментальное нажатие transport-кнопок обновляет только класс и изображение самой кнопки вместо полного ApplicationV2 render; явный render отменяет уже запланированный дублирующий render.
- Закрытая библиотека кассет больше не клонируется и не материализуется в DOM; при открытии используется lightweight summary вместо полных объектов кассет.
- Progress timer больше не клонирует выбранную кассету и не ищет time-slot DOM заново на каждом 200 ms tick; неизменившиеся подписи не мутируют DOM.
- Title fitting сведён к одному rAF, canvas measurement и максимум одной verification/correction паре вместо цикла forced layout.
- Drag и resize coalesce'ятся через requestAnimationFrame; ApplicationV2 position/size commit выполняется по окончании операции.
- Action-кнопки виджета используют один delegated click listener вместо listener на каждый DOM node.
- Visible preload ограничивается `preloadMaxEntries` ещё при сборе lightweight track summaries и перестаёт обходить библиотеку после достижения лимита.
- Завершённый metadata preload освобождает временный `HTMLAudioElement`, `src`, promise и cancel closure, сохраняя только metadata/cache state.
- Диагностика coalesce'ит частые hook-driven render и больше не повторно нормализует библиотеку для inspection.
- Актуальная migrationVersion завершает world migration early, без повторной нормализации всей библиотеки на каждом GM ready.
- Library editor использует один snapshot на render, минимальный sidebar projection и кеширует расчёт raw JSON size по revision.
- Library save больше не читает/нормализует текущую библиотеку повторно только ради optimistic revision check; validation не делает второй normalize pass.
- No-op transport больше не вызывает полный render виджета. Persistent command оставлен намеренно, чтобы не менять общий SFX и существующую authenticated socket semantics.

### Tests

- Добавлена проверка bounded lightweight library projections и player visibility.
- Расширена проверка transport button assets для targeted press-state update.
- Автоматический набор: 36 тестов.

## 1.1.2

### Shuttle audio

- Ускоренный звук перемотки усилен отдельным коэффициентом `1.65` с ограничением до допустимого уровня.
- SFX кнопок REW/FWD получили дополнительное ограниченное усиление.
- Исправлена утечка личного mute: нулевая громкость больше не заменяется fallback-значением во время перемотки.
- Общая громкость музыки и остальные транспортные звуки не изменены.

### Safe performance optimization

- Native и Foundry audio engines используют общий код audible shuttle preview.
- Media-элемент перемотки переиспользуется в пределах активного аудиохэндла вместо создания нового `Audio` на каждый seek.
- Progress display переведён с постоянно активного RAF-цикла на таймер 5 Гц, работающий только при воспроизведении и видимой вкладке.
- Нормализованная и отсортированная библиотека кешируется по revision/updatedAt; публичные методы сохраняют copy-on-read семантику.
- Кривые saturation кешируются с ограничением размера кеша.
- Исправлена очистка metadata timeout и освобождение временных media-элементов транспортных SFX.

### Tests

- Добавлены проверки усиления перемотки, сохранения mute и copy-on-read кеша библиотеки.
- Автоматический набор расширен до 35 тестов.

## 1.1.1

### Widget interaction

- Физическая кнопка `OPEN` снова управляет крышкой плеера.
- Успешное открытие крышки автоматически открывает библиотеку кассет.
- Добавлена отдельная кнопка библиотеки в левом верхнем углу шапки виджета.
- Библиотека открывается и закрывается независимо от физической крышки.
- Закрытие крышки из библиотеки больше не закрывает саму библиотеку.
- Индикатор физической кнопки `OPEN` теперь отражает только состояние крышки.
- Уточнено название SFX действия открытия крышки.

## 1.1.0

### Security and authority

- Удалён небезопасный raw socket transport.
- Добавлен единый детерминированный authority-GM.
- Добавлены короткоживущие socketlib-сессии, привязанные к конкретному пользователю.
- Клиентские команды принимаются только при полном совпадении с командой, атомарно сохранённой в world deck state.
- Sync-пульсы также фиксируются в world state до исполнения.
- Добавлены authority epoch, revision, command id и heartbeat.
- Локальное управление authority-GM сохраняется при временной недоступности socketlib; удалённые клиенты получают явную ошибку.

### Playback and synchronization

- Расчёт offset и expected end учитывает playback rate.
- Исправлены fade-in и fade-out.
- Разделены базовая скорость, wow/flutter и временная sync-коррекция.
- Случайные кассетные дефекты получают общий seed и воспроизводятся детерминированно.
- Natural end проверяется по playback sequence, authority epoch, треку, пути, длительности и ожидаемому времени окончания.
- Добавлен authority-таймер окончания трека на случай отсутствия клиентского ended event.
- Исправлен жизненный цикл Web Audio graph и закрытие общего AudioContext.
- Ограничен повтор одинаковых аудиоуведомлений.

### Library and migrations

- Добавлены revision и optimistic conflict detection библиотеки.
- Редактор защищает несохранённые изменения.
- Импорт получил diff, backup и rollback API.
- Усилена проверка структуры и аудиопутей.
- Миграции world settings выполняет только authority-GM и предварительно сохраняет backup.
- Hooks синхронизации и reconciliation изолированы на время миграционной транзакции.
- Убран неявный переход на первую дорожку при ошибочном `trackId`.

### UI, UX and performance

- Браузер кассет отделён от физической крышки.
- Добавлены отдельные кнопки открытия и закрытия физической крышки.
- Добавлена личная громкость и локальный mute.
- Регулятор громкости поддерживает клавиатуру.
- Progress DOM обновляется только во время playback, при видимой вкладке и без полной перерисовки.
- Полные перерисовки виджета пакетируются.
- Устранены повторные Application V2 listeners.
- Стили окна SFX вынесены из `library.css` в собственный owner-файл.
- Удалены неиспользуемый CSS и дублирующий арт крышки.
- Обновлена диагностика authority и socket-сессий.

### Tests

- Обновлены проверки natural end.
- Добавлены тесты playback rate, expected end, command ordering и безопасности аудиопутей.
