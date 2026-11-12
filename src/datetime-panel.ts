import SunCalc from 'suncalc';
import type { LngLat } from './geojson';

const MINUTES_PER_DAY = 1440;
/** Minutes of twilight blended around sunrise/sunset on the slider track. */
const TWILIGHT_BLEND = 35;
/** How often the live clock checks whether the minute rolled over. */
const LIVE_POLL_MS = 1000;

const MONTHS_NOMINATIVE = [
  'Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень',
  'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень',
];

const MONTHS_GENITIVE = [
  'січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
  'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня',
];

export type DateTimeSource = 'init' | 'user' | 'tick';

export interface DateTimePanelElements {
  dateTrigger: HTMLButtonElement;
  dateLabel: HTMLElement;
  calendar: HTMLElement;
  calendarTitle: HTMLElement;
  calendarGrid: HTMLElement;
  previousMonth: HTMLButtonElement;
  nextMonth: HTMLButtonElement;
  todayButton: HTMLButtonElement;
  timeSlider: HTMLInputElement;
  /** Manual `HH:MM` entry, kept in sync with the slider. */
  timeInput: HTMLInputElement;
  timeTrack: HTMLElement;
  sunTimes: HTMLElement;
  liveToggle: HTMLInputElement;
  liveHint: HTMLElement;
  /** Play/pause button for auto-advancing time. */
  playToggle: HTMLButtonElement;
  /** Selector for how many minutes to advance per real second. */
  playStep: HTMLSelectElement;
}

export interface DateTimePanelOptions {
  elements: DateTimePanelElements;
  location: LngLat;
  initial: Date;
  onChange: (date: Date, source: DateTimeSource) => void;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toIsoDay(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${`${hours}`.padStart(2, '0')}:${`${rest}`.padStart(2, '0')}`;
}

/** Monday-first weekday index (0 = Monday). */
function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/**
 * Parses manual time entry as 24-hour minutes from midnight: `18:30`, `1830`, `18.30`,
 * and — once the entry is committed — a bare `18`. Returns null when the text is not a
 * complete, in-range time.
 */
function parseClock(raw: string, allowBareHour: boolean): number | null {
  const text = raw.trim();
  const separated = /^(\d{1,2})\s*[:.\-\s]\s*(\d{1,2})$/.exec(text);
  const compact = /^(\d{3,4})$/.exec(text);
  const bareHour = /^(\d{1,2})$/.exec(text);

  let hours: number;
  let minutes: number;
  if (separated) {
    hours = Number(separated[1]);
    minutes = Number(separated[2]);
  } else if (compact) {
    hours = Number(compact[1].slice(0, -2));
    minutes = Number(compact[1].slice(-2));
  } else if (allowBareHour && bareHour) {
    hours = Number(bareHour[1]);
    minutes = 0;
  } else {
    return null;
  }

  if (hours > 23 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

/**
 * Date and time controls for the shadow map: a month calendar popover, a minute
 * slider tinted with the day/night curve of the selected date, and a live toggle
 * that follows the system clock minute by minute.
 */
export class DateTimePanel {
  private readonly elements: DateTimePanelElements;
  private readonly onChange: (date: Date, source: DateTimeSource) => void;
  private location: LngLat;

  private selectedDay: Date;
  private minutes: number;
  private visibleMonth: Date;
  private liveTimer: number | null = null;
  private lastLiveMinute = -1;
  /** requestAnimationFrame id while playback runs, or null when paused. */
  private playTimer: number | null = null;
  /** Timestamp (ms) of the previous playback frame, for elapsed-time advance. */
  private lastFrameTime = 0;

  constructor(options: DateTimePanelOptions) {
    this.elements = options.elements;
    this.onChange = options.onChange;
    this.location = options.location;

    this.selectedDay = startOfDay(options.initial);
    this.minutes = options.initial.getHours() * 60 + options.initial.getMinutes();
    this.visibleMonth = startOfDay(options.initial);

    this.bindEvents();
    this.renderAll();
    this.onChange(this.value, 'init');
  }

  /**
   * The selected date and time. `minutes` may be fractional during smooth
   * playback, so the fractional part is carried into seconds (and milliseconds)
   * — this is what lets the sun/shadows move continuously between whole-minute
   * marks instead of jumping once per step.
   */
  get value(): Date {
    const wholeMinutes = Math.floor(this.minutes);
    const fractionSeconds = (this.minutes - wholeMinutes) * 60;
    const seconds = Math.floor(fractionSeconds);
    const milliseconds = Math.round((fractionSeconds - seconds) * 1000);
    return new Date(
      this.selectedDay.getFullYear(),
      this.selectedDay.getMonth(),
      this.selectedDay.getDate(),
      Math.floor(wholeMinutes / 60),
      wholeMinutes % 60,
      seconds,
      milliseconds,
    );
  }

  get isLive(): boolean {
    return this.elements.liveToggle.checked;
  }

  /** Sunrise/sunset shown on the slider follow the map's current location. */
  setLocation(location: LngLat): void {
    this.location = location;
    this.renderSunCurve();
  }

  destroy(): void {
    this.stopLive();
    this.pausePlayback();
    document.removeEventListener('pointerdown', this.handleDocumentPointerDown, true);
  }

  private bindEvents(): void {
    const {
      dateTrigger, calendar, calendarGrid, previousMonth, nextMonth,
      todayButton, timeSlider, timeInput, liveToggle,
    } = this.elements;

    dateTrigger.addEventListener('click', () => {
      if (calendar.hidden) {
        this.openCalendar();
      } else {
        this.closeCalendar();
      }
    });

    previousMonth.addEventListener('click', () => this.shiftMonth(-1));
    nextMonth.addEventListener('click', () => this.shiftMonth(1));

    calendarGrid.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-day]');
      if (target?.dataset.day) {
        this.selectDay(new Date(`${target.dataset.day}T00:00:00`), true);
      }
    });

    calendarGrid.addEventListener('keydown', (event) => this.handleGridKeydown(event));

    calendar.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.closeCalendar();
        dateTrigger.focus();
      }
    });

    todayButton.addEventListener('click', () => {
      this.selectDay(new Date(), false);
      this.visibleMonth = startOfDay(new Date());
      this.renderCalendar();
    });

    timeSlider.addEventListener('input', () => {
      const parsed = Number(timeSlider.value);
      if (!Number.isFinite(parsed)) {
        return;
      }
      // Touching the slider pauses any running playback.
      this.pausePlayback();
      this.minutes = Math.min(Math.max(Math.round(parsed), 0), MINUTES_PER_DAY - 1);
      this.renderTime();
      this.onChange(this.value, 'user');
    });

    // Manual entry: apply every keystroke that already forms a complete time, and
    // normalise or restore the field once the entry is committed. Typing a time
    // pauses playback.
    timeInput.addEventListener('input', () => {
      this.pausePlayback();
      this.applyTypedTime(false);
    });
    timeInput.addEventListener('change', () => this.commitTypedTime());
    timeInput.addEventListener('blur', () => this.commitTypedTime());
    timeInput.addEventListener('keydown', (event) => {
      const steps: Record<string, number> = {
        ArrowUp: 1,
        ArrowDown: -1,
        PageUp: 60,
        PageDown: -60,
      };
      const step = steps[event.key];
      if (step !== undefined) {
        event.preventDefault();
        this.pausePlayback();
        this.stepMinutes(event.shiftKey ? step * 60 : step);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitTypedTime();
      }
    });

    liveToggle.addEventListener('change', () => {
      if (liveToggle.checked) {
        // Live mode and manual playback are mutually exclusive.
        this.pausePlayback();
        this.startLive();
      } else {
        this.stopLive();
      }
      this.renderPlaybackState();
    });

    this.elements.playToggle.addEventListener('click', () => this.togglePlayback());
    // Changing the step while playing takes effect on the next tick automatically
    // (the interval reads the select each tick); no restart needed.

    document.addEventListener('pointerdown', this.handleDocumentPointerDown, true);
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
    const { calendar, dateTrigger } = this.elements;
    if (calendar.hidden) {
      return;
    }
    const target = event.target as Node;
    if (!calendar.contains(target) && !dateTrigger.contains(target)) {
      this.closeCalendar();
    }
  };

  private openCalendar(): void {
    if (this.isLive) {
      return;
    }
    this.visibleMonth = startOfDay(this.selectedDay);
    this.elements.calendar.hidden = false;
    this.elements.dateTrigger.setAttribute('aria-expanded', 'true');
    this.renderCalendar();
    this.elements.calendarGrid
      .querySelector<HTMLButtonElement>('[tabindex="0"]')
      ?.focus();
  }

  private closeCalendar(): void {
    this.elements.calendar.hidden = true;
    this.elements.dateTrigger.setAttribute('aria-expanded', 'false');
  }

  private shiftMonth(delta: number): void {
    this.visibleMonth = new Date(
      this.visibleMonth.getFullYear(),
      this.visibleMonth.getMonth() + delta,
      1,
    );
    this.renderCalendar();
  }

  private selectDay(day: Date, closeAfterwards: boolean): void {
    if (Number.isNaN(day.getTime())) {
      return;
    }

    this.selectedDay = startOfDay(day);
    this.visibleMonth = startOfDay(day);
    this.renderDate();
    this.renderSunCurve();
    this.renderCalendar();
    if (closeAfterwards) {
      this.closeCalendar();
      this.elements.dateTrigger.focus();
    }
    this.onChange(this.value, 'user');
  }

  private handleGridKeydown(event: KeyboardEvent): void {
    const focused = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-day]');
    if (!focused?.dataset.day) {
      return;
    }

    const current = new Date(`${focused.dataset.day}T00:00:00`);
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
      PageUp: -28,
      PageDown: 28,
    };

    const delta = moves[event.key];
    if (delta === undefined) {
      return;
    }

    event.preventDefault();
    const next = new Date(current.getFullYear(), current.getMonth(), current.getDate() + delta);
    this.visibleMonth = startOfDay(next);
    this.renderCalendar();
    this.elements.calendarGrid
      .querySelector<HTMLButtonElement>(`[data-day="${toIsoDay(next)}"]`)
      ?.focus();
  }

  private startLive(): void {
    this.stopLive();
    this.closeCalendar();
    this.applyNow();
    this.liveTimer = window.setInterval(() => {
      const minute = Math.floor(Date.now() / 60_000);
      if (minute !== this.lastLiveMinute) {
        this.applyNow();
      }
    }, LIVE_POLL_MS);
    this.renderLiveState();
  }

  private stopLive(): void {
    if (this.liveTimer !== null) {
      window.clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
    this.renderLiveState();
  }

  private applyNow(): void {
    const now = new Date();
    this.lastLiveMinute = Math.floor(now.getTime() / 60_000);
    const dayChanged = !sameDay(now, this.selectedDay);
    this.selectedDay = startOfDay(now);
    this.minutes = now.getHours() * 60 + now.getMinutes();
    this.visibleMonth = startOfDay(now);

    this.renderDate();
    this.renderTime();
    if (dayChanged) {
      this.renderSunCurve();
    }
    this.onChange(this.value, 'tick');
  }

  private renderAll(): void {
    this.renderDate();
    this.renderTime();
    this.renderSunCurve();
    this.renderCalendar();
    this.renderLiveState();
    this.renderPlaybackState();
  }

  private renderDate(): void {
    const day = this.selectedDay;
    this.elements.dateLabel.textContent =
      `${day.getDate()} ${MONTHS_GENITIVE[day.getMonth()]} ${day.getFullYear()}`;
  }

  private renderTime(): void {
    // `minutes` can be fractional during smooth playback; the slider and clock
    // show whole minutes.
    const whole = Math.floor(this.minutes);
    const clock = formatClock(whole);
    this.elements.timeSlider.value = `${whole}`;
    this.elements.timeSlider.setAttribute('aria-valuetext', clock);
    this.elements.timeInput.value = clock;
  }

  /**
   * Reads the manual time field. Returns false while the entry is not a complete,
   * in-range 24-hour time, so the caller can decide whether to restore the old value.
   */
  private applyTypedTime(commit: boolean): boolean {
    const total = parseClock(this.elements.timeInput.value, commit);
    if (total === null) {
      return false;
    }

    if (total !== this.minutes) {
      this.minutes = total;
      // The field is not rewritten here: that would fight the caret while typing.
      this.elements.timeSlider.value = `${total}`;
      this.elements.timeSlider.setAttribute('aria-valuetext', formatClock(total));
      this.onChange(this.value, 'user');
    }

    return true;
  }

  /** Normalises the field to `HH:MM`, or puts the current time back when it is unusable. */
  private commitTypedTime(): void {
    this.applyTypedTime(true);
    this.renderTime();
  }

  private stepMinutes(delta: number): void {
    this.minutes = (this.minutes + delta + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    this.renderTime();
    this.onChange(this.value, 'user');
  }

  /** True while playback is auto-advancing time. */
  get isPlaying(): boolean {
    return this.playTimer !== null;
  }

  /** Starts or stops playback; disabled while live mode is on. */
  private togglePlayback(): void {
    if (this.isLive) {
      return;
    }
    if (this.isPlaying) {
      this.pausePlayback();
    } else {
      this.startPlayback();
    }
  }

  /**
   * Begins smooth playback. Rather than jumping the full step once per second
   * (which snaps the shadows), it advances on every animation frame by the
   * fraction of the step that corresponds to the real time elapsed since the
   * last frame. The net rate is identical — `playStepMinutes` simulated minutes
   * per real second — but subdivided into ~60 tiny increments, so the sun and
   * shadows glide continuously.
   */
  private startPlayback(): void {
    if (this.isPlaying || this.isLive) {
      return;
    }
    this.closeCalendar();
    this.lastFrameTime = performance.now();
    this.playTimer = requestAnimationFrame(this.playFrame);
    this.renderPlaybackState();
  }

  /** Stops playback if running; safe to call at any time. */
  private pausePlayback(): void {
    if (this.playTimer === null) {
      return;
    }
    cancelAnimationFrame(this.playTimer);
    this.playTimer = null;
    this.renderPlaybackState();
  }

  /** The currently selected minutes-per-second step, defaulting to 15. */
  private get playStepMinutes(): number {
    const value = Number(this.elements.playStep.value);
    return Number.isFinite(value) && value > 0 ? value : 15;
  }

  /** One animation frame of playback: advance by the elapsed-time fraction. */
  private readonly playFrame = (now: number): void => {
    if (this.playTimer === null) {
      return;
    }
    const elapsedSeconds = Math.max(0, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    // Guard against a huge jump after a tab was backgrounded (rAF pauses there).
    const cappedSeconds = Math.min(elapsedSeconds, 1);
    this.advanceByMinutes(this.playStepMinutes * cappedSeconds);
    this.playTimer = requestAnimationFrame(this.playFrame);
  };

  /**
   * Advances the simulated time by `deltaMinutes` (may be fractional), rolling
   * over to the next calendar day (and redrawing the day/sun curve) when it
   * passes 23:59.
   */
  private advanceByMinutes(deltaMinutes: number): void {
    const total = this.minutes + deltaMinutes;
    const dayOffset = Math.floor(total / MINUTES_PER_DAY);
    this.minutes = total - dayOffset * MINUTES_PER_DAY;

    if (dayOffset > 0) {
      this.selectedDay = new Date(
        this.selectedDay.getFullYear(),
        this.selectedDay.getMonth(),
        this.selectedDay.getDate() + dayOffset,
      );
      this.visibleMonth = startOfDay(this.selectedDay);
      this.renderDate();
      this.renderSunCurve();
    }

    this.renderTime();
    this.onChange(this.value, 'tick');
  }

  /** Reflects play/pause state on the button and disables it while live. */
  private renderPlaybackState(): void {
    const { playToggle, playStep } = this.elements;
    const playing = this.isPlaying;
    playToggle.disabled = this.isLive;
    playStep.disabled = this.isLive;
    playToggle.setAttribute('aria-pressed', `${playing}`);
    playToggle.setAttribute('aria-label', playing ? 'Призупинити' : 'Відтворити');
    // One icon that swaps shape: pause bars while playing, play triangle when paused.
    const iconPath = playToggle.querySelector<SVGPathElement>('.playback__icon-path');
    iconPath?.setAttribute(
      'd',
      playing ? 'M7 5.5h3.2v13H7zM13.8 5.5H17v13h-3.2z' : 'M8 5.5v13l11-6.5z',
    );
  }

  private renderLiveState(): void {
    const live = this.isLive;
    this.elements.timeSlider.disabled = live;
    this.elements.timeInput.disabled = live;
    this.elements.dateTrigger.disabled = live;
    this.elements.todayButton.disabled = live;
    this.elements.liveHint.textContent = live
      ? 'Синхронізовано з годинником'
      : 'Оновлення щохвилини';
  }

  /** Paints the day/night bands on the slider and prints sunrise/sunset. */
  private renderSunCurve(): void {
    // Anchor at noon of the selected day: SunCalc resolves the sunrise/sunset for
    // the solar day containing the given moment, so a near-midnight time (e.g.
    // just after a playback rollover) would otherwise return the previous day's
    // events and hide the curve. Noon always maps to the correct day.
    const noon = new Date(
      this.selectedDay.getFullYear(),
      this.selectedDay.getMonth(),
      this.selectedDay.getDate(),
      12,
    );
    const times = SunCalc.getTimes(noon, this.location[1], this.location[0]);
    const sunrise = this.dayMinutes(times.sunrise);
    const sunset = this.dayMinutes(times.sunset);

    if (sunrise === null || sunset === null || sunset <= sunrise) {
      const polarDay = sunrise === null && sunset === null && this.isSunUpAtNoon();
      this.elements.timeTrack.style.background = polarDay
        ? 'var(--track-day)'
        : 'var(--track-night)';
      this.elements.sunTimes.textContent = polarDay
        ? 'Сонце не заходить'
        : 'Сонце не сходить';
      return;
    }

    const stop = (minutes: number): string =>
      `${(Math.min(Math.max(minutes, 0), MINUTES_PER_DAY) / MINUTES_PER_DAY * 100).toFixed(2)}%`;

    this.elements.timeTrack.style.background = [
      'linear-gradient(90deg',
      'var(--track-night) 0%',
      `var(--track-night) ${stop(sunrise - TWILIGHT_BLEND)}`,
      `var(--track-twilight) ${stop(sunrise)}`,
      `var(--track-day) ${stop(sunrise + TWILIGHT_BLEND)}`,
      `var(--track-day) ${stop(sunset - TWILIGHT_BLEND)}`,
      `var(--track-twilight) ${stop(sunset)}`,
      `var(--track-night) ${stop(sunset + TWILIGHT_BLEND)}`,
      'var(--track-night) 100%)',
    ].join(', ');

    this.elements.sunTimes.textContent =
      `Схід ${formatClock(Math.round(sunrise))} · Захід ${formatClock(Math.round(sunset))}`;
  }

  private isSunUpAtNoon(): boolean {
    const noon = new Date(
      this.selectedDay.getFullYear(),
      this.selectedDay.getMonth(),
      this.selectedDay.getDate(),
      12,
    );
    return SunCalc.getPosition(noon, this.location[1], this.location[0]).altitude > 0;
  }

  /** Minutes from midnight for an event on the selected day, or null when it never happens. */
  private dayMinutes(date: Date | undefined): number | null {
    if (!date || Number.isNaN(date.getTime())) {
      return null;
    }
    if (!sameDay(date, this.selectedDay)) {
      return date.getTime() < this.selectedDay.getTime() ? 0 : MINUTES_PER_DAY;
    }
    return date.getHours() * 60 + date.getMinutes();
  }

  private renderCalendar(): void {
    const { calendarGrid, calendarTitle } = this.elements;
    const year = this.visibleMonth.getFullYear();
    const month = this.visibleMonth.getMonth();
    calendarTitle.textContent = `${MONTHS_NOMINATIVE[month]} ${year}`;

    const firstOfMonth = new Date(year, month, 1);
    const gridStart = new Date(year, month, 1 - weekdayIndex(firstOfMonth));
    const today = new Date();
    const rows: HTMLElement[] = [];

    for (let week = 0; week < 6; week += 1) {
      const row = document.createElement('div');
      row.className = 'calendar__row';
      row.setAttribute('role', 'row');

      for (let weekday = 0; weekday < 7; weekday += 1) {
        const day = new Date(
          gridStart.getFullYear(),
          gridStart.getMonth(),
          gridStart.getDate() + week * 7 + weekday,
        );
        const isSelected = sameDay(day, this.selectedDay);
        const isToday = sameDay(day, today);
        const isOutside = day.getMonth() !== month;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'calendar__day';
        button.dataset.day = toIsoDay(day);
        button.textContent = `${day.getDate()}`;
        button.setAttribute('role', 'gridcell');
        button.setAttribute('aria-selected', `${isSelected}`);
        button.setAttribute(
          'aria-label',
          `${day.getDate()} ${MONTHS_GENITIVE[day.getMonth()]} ${day.getFullYear()}`,
        );
        button.tabIndex = isSelected ? 0 : -1;
        button.classList.toggle('is-selected', isSelected);
        button.classList.toggle('is-today', isToday);
        button.classList.toggle('is-outside', isOutside);
        if (isToday) {
          button.setAttribute('aria-current', 'date');
        }

        row.appendChild(button);
      }

      rows.push(row);
    }

    calendarGrid.replaceChildren(...rows);

    // Keep one focusable day even when the selected day is in another month.
    if (!calendarGrid.querySelector('[tabindex="0"]')) {
      const fallback =
        calendarGrid.querySelector<HTMLButtonElement>('.calendar__day.is-today:not(.is-outside)') ??
        calendarGrid.querySelector<HTMLButtonElement>('.calendar__day:not(.is-outside)');
      if (fallback) {
        fallback.tabIndex = 0;
      }
    }
  }
}
