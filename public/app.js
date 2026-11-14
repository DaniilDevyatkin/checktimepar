const form = document.querySelector('#searchForm');
const groupInput = document.querySelector('#groupInput');
const teacherInput = document.querySelector('#teacherInput');
const groupsList = document.querySelector('#groupsList');
const fileCount = document.querySelector('#fileCount');
const resultPanel = document.querySelector('#resultPanel');
const emptyState = document.querySelector('#emptyState');
const reportGroup = document.querySelector('#reportGroup');
const reportTeacher = document.querySelector('#reportTeacher');
const totalHours = document.querySelector('#totalHours');
const skippedNotice = document.querySelector('#skippedNotice');
const weekList = document.querySelector('#weekList');
const subjectSummary = document.querySelector('#subjectSummary');
const subjectList = document.querySelector('#subjectList');

const weekdays = [
  { short: 'ПН', full: 'Понедельник' },
  { short: 'ВТ', full: 'Вторник' },
  { short: 'СР', full: 'Среда' },
  { short: 'ЧТ', full: 'Четверг' },
  { short: 'ПТ', full: 'Пятница' },
  { short: 'СБ', full: 'Суббота' },
];

function pluralHours(count) {
  const last = count % 10;
  const lastTwo = count % 100;
  if (last === 1 && lastTwo !== 11) return 'час';
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return 'часа';
  return 'часов';
}

function pluralLessons(count) {
  const last = count % 10;
  const lastTwo = count % 100;
  if (last === 1 && lastTwo !== 11) return 'занятие';
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return 'занятия';
  return 'занятий';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseLocalDate(value) {
  const match = String(value || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date, count) {
  const next = new Date(date);
  next.setDate(next.getDate() + count);
  return next;
}

function formatDayDate(date) {
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(date);
}

function formatWeekHeading(start, end) {
  if (!start || !end) return null;
  const startDay = new Intl.DateTimeFormat('ru-RU', { day: '2-digit' }).format(start);
  const endDay = new Intl.DateTimeFormat('ru-RU', { day: '2-digit' }).format(end);
  const startMonth = new Intl.DateTimeFormat('ru-RU', { month: 'long' }).format(start);
  const endMonth = new Intl.DateTimeFormat('ru-RU', { month: 'long' }).format(end);
  const year = new Intl.DateTimeFormat('ru-RU', { year: 'numeric' }).format(end);

  if (start.getMonth() === end.getMonth()) {
    return { days: `${startDay}—${endDay}`, month: startMonth, year };
  }
  return { days: `${startDay} ${startMonth} — ${endDay} ${endMonth}`, month: '', year };
}

function weekdayIndex(match, weekStart) {
  const matchDate = parseLocalDate(match.date);
  if (matchDate && weekStart) {
    const dayOffset = Math.round((matchDate.getTime() - weekStart.getTime()) / 86400000);
    if (dayOffset >= 0 && dayOffset < weekdays.length) return dayOffset;
  }
  const weekday = String(match.weekday || '').toLocaleLowerCase('ru');
  return weekdays.findIndex(({ full }) => weekday.startsWith(full.toLocaleLowerCase('ru')));
}

function pairIndex(match) {
  const number = String(match.lesson || '').match(/\d+/);
  if (!number) return 0;
  const sourceNumber = Number(number[0]);
  return Math.min(5, Math.max(0, sourceNumber > 0 ? sourceNumber - 1 : 0));
}

function getSubjectTotals(data) {
  if (Array.isArray(data.subjectTotals)) return data.subjectTotals;

  const totals = new Map();
  for (const report of data.reports || []) {
    for (const match of report.matches || []) {
      const subject = match.subject || 'Предмет не распознан';
      const key = subject.toLocaleLowerCase('ru').replace(/ё/g, 'е');
      const value = totals.get(key) || { subject, hours: 0 };
      value.hours += Number(match.hours) || 0;
      totals.set(key, value);
    }
  }
  return [...totals.values()].sort((a, b) => b.hours - a.hours || a.subject.localeCompare(b.subject, 'ru'));
}

function renderHit(match) {
  const subject = match.subject || 'Предмет не распознан';
  return `
    <article class="lesson-hit" title="${escapeHtml(match.longDate || match.weekday)} · ${escapeHtml(subject)} · ${match.hours} ${pluralHours(match.hours)}">
      <strong>${escapeHtml(subject)}</strong>
      <span class="hit-hours">${match.hours} ч</span>
    </article>
  `;
}

function renderWeek(report, index) {
  const start = parseLocalDate(report.weekStart);
  const end = parseLocalDate(report.weekEnd) || (start ? addDays(start, 5) : null);
  const heading = formatWeekHeading(start, end);
  const matches = Array.isArray(report.matches) ? report.matches : [];
  const dayMatches = new Map();

  for (const match of matches) {
    const day = weekdayIndex(match, start);
    if (day < 0 || day >= weekdays.length) continue;
    const key = `${day}:${pairIndex(match)}`;
    if (!dayMatches.has(key)) dayMatches.set(key, []);
    dayMatches.get(key).push(match);
  }

  const headers = weekdays.map((day, dayIndex) => {
    const date = start ? addDays(start, dayIndex) : null;
    const matchCount = matches.filter((match) => weekdayIndex(match, start) === dayIndex).length;
    return `
      <div class="day-head ${matchCount ? 'has-day-match' : ''}">
        <strong>${day.short}</strong>
        <span>${date ? formatDayDate(date) : '—'}</span>
      </div>
    `;
  }).join('');

  const rows = Array.from({ length: 6 }, (_, pair) => {
    const cells = weekdays.map((_, dayIndex) => {
      const cellMatches = dayMatches.get(`${dayIndex}:${pair}`) || [];
      return `<div class="schedule-cell ${cellMatches.length ? 'has-match' : ''}" role="cell">${cellMatches.map(renderHit).join('')}</div>`;
    }).join('');
    return `
      <div class="pair-head" role="rowheader"><strong>${pair}</strong><span>пара</span></div>
      ${cells}
    `;
  }).join('');

  const weekTitle = heading
    ? `<span class="week-days">${escapeHtml(heading.days)}</span><span class="week-month">${escapeHtml(heading.month)}</span><span class="week-year">${escapeHtml(heading.year)}</span>`
    : `<span class="week-days">${escapeHtml(report.weekRange || 'Неделя')}</span>`;

  return `
    <article class="week-board">
      <aside class="week-aside">
        <p class="week-index"><span>${String(index + 1).padStart(2, '0')}</span> НЕДЕЛЯ</p>
        <h3>${weekTitle}</h3>
        <div class="week-source">
          <span>ИСТОЧНИК</span>
          <strong>${escapeHtml(report.fileName)}</strong>
          <small>${escapeHtml(report.group)}</small>
        </div>
        <div class="week-total"><strong>${report.hours}</strong><span>${pluralHours(report.hours)} · ${matches.length} ${pluralLessons(matches.length)}</span></div>
      </aside>
      <div class="week-grid-scroll">
        <div class="timetable-grid" role="table" aria-label="Расписание за ${escapeHtml(report.weekRange || '')}">
          <div class="grid-corner" role="columnheader"><span>№</span><small>ПАРЫ</small></div>
          ${headers}
          ${rows}
        </div>
      </div>
    </article>
  `;
}

function renderSubjectTotals(totals) {
  subjectList.innerHTML = totals.map((item) => `
    <div class="subject-row">
      <strong class="subject-name">${escapeHtml(item.subject)}</strong>
      <strong class="subject-total">${item.hours}<small> ч</small></strong>
    </div>
  `).join('');
  subjectSummary.classList.toggle('hidden', totals.length === 0);
}

function renderResults(data) {
  const reports = Array.isArray(data.reports) ? data.reports : [];
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];

  resultPanel.classList.remove('hidden');
  emptyState.classList.add('hidden');
  reportGroup.textContent = data.group || groupInput.value;
  reportTeacher.textContent = data.teacher || teacherInput.value;
  totalHours.textContent = String(data.totalHours || 0);
  skippedNotice.innerHTML = skipped.length
    ? `<div class="notice-symbol" aria-hidden="true">!</div><div><strong>Проверены не все источники: ${skipped.length} файлов</strong><ul>${skipped.map((item) => `<li><strong>${escapeHtml(item.fileName || 'Файл без имени')}</strong><span>${escapeHtml(item.reason || 'Причина не указана')}</span></li>`).join('')}</ul></div>`
    : '';
  skippedNotice.classList.toggle('hidden', skipped.length === 0);

  weekList.innerHTML = reports.length
    ? reports.map(renderWeek).join('')
    : '<div class="no-results"><strong>Совпадений по этой группе нет</strong><span>Попробуйте выбрать группу из списка подсказок.</span></div>';
  renderSubjectTotals(getSubjectTotals(data));
}

async function loadMeta() {
  const response = await fetch('/api/files');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось прочитать файлы.');

  fileCount.textContent = `Загружено ${data.files.length} файлов с расписанием`;
  groupsList.innerHTML = data.groups.map((group) => `<option value="${escapeHtml(group)}"></option>`).join('');

  if (data.groups.length && !groupInput.value) {
    groupInput.value = data.groups.find((group) => group.includes('ИС')) || data.groups[0];
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('.button-primary');
  button.disabled = true;
  button.innerHTML = 'Сверяю расписания <span aria-hidden="true">…</span>';

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: groupInput.value, teacher: teacherInput.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ошибка анализа.');
    renderResults(data);
  } catch (error) {
    resultPanel.classList.remove('hidden');
    emptyState.classList.add('hidden');
    reportGroup.textContent = groupInput.value;
    reportTeacher.textContent = teacherInput.value;
    totalHours.textContent = '—';
    skippedNotice.innerHTML = `<div class="notice-symbol" aria-hidden="true">!</div><div><strong>${escapeHtml(error.message)}</strong></div>`;
    skippedNotice.classList.remove('hidden');
    weekList.innerHTML = '';
    subjectSummary.classList.add('hidden');
  } finally {
    button.disabled = false;
    button.innerHTML = 'Посчитать часы <span aria-hidden="true">↗</span>';
  }
});

loadMeta().catch((error) => {
  fileCount.textContent = 'Ошибка чтения файлов';
  fileCount.title = error.message;
});
