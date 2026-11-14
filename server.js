const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const app = express();
const PORT = process.env.PORT || 5177;
const HOST = process.env.HOST || '127.0.0.1';
const SCHEDULE_ROOT = path.resolve(process.env.SCHEDULE_ROOT || path.join(__dirname, 'schedules'));
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === 'true';

if (Boolean(AUTH_USER) !== Boolean(AUTH_PASSWORD)) {
  throw new Error('AUTH_USER and AUTH_PASSWORD must either both be set or both be empty.');
}

if (AUTH_REQUIRED && (!AUTH_USER || !AUTH_PASSWORD)) {
  throw new Error('AUTH_USER and AUTH_PASSWORD are required when AUTH_REQUIRED=true.');
}

const scheduleCache = new Map();
const scheduleParsesInFlight = new Map();
const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  textNodeName: '#text',
  attributeNamePrefix: '@_',
});
function matchesSecret(value, expected) {
  const valueHash = crypto.createHash('sha256').update(value).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(valueHash, expectedHash);
}

app.use((request, response, next) => {
  if (request.path === '/health' || (!AUTH_REQUIRED && !AUTH_USER && !AUTH_PASSWORD)) {
    next();
    return;
  }

  const authorization = request.get('authorization') || '';
  const credentialsMatch = authorization.match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);
  if (credentialsMatch) {
    const decoded = Buffer.from(credentialsMatch[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator >= 0) {
      const userMatches = matchesSecret(decoded.slice(0, separator), AUTH_USER);
      const passwordMatches = matchesSecret(decoded.slice(separator + 1), AUTH_PASSWORD);
      if (userMatches && passwordMatches) {
        next();
        return;
      }
    }
  }

  response.set('WWW-Authenticate', 'Basic realm="Расписание", charset="UTF-8"');
  response.status(401).send('Требуется авторизация.');
});

app.use(express.json({ limit: '16kb' }));
app.get('/health', (_request, response) => response.json({ status: 'ok' }));
app.use(express.static(path.join(__dirname, 'public')));

const asArray = (value) => {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
};

function textFromNode(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join('');
  if (typeof node === 'object') {
    let output = '';
    if (node['#text'] !== undefined) output += textFromNode(node['#text']);
    if (node.t !== undefined) output += textFromNode(node.t);
    if (node.tab !== undefined) output += '\t';
    if (node.br !== undefined) output += '\n';

    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('@_') || ['t', 'tab', 'br', '#text'].includes(key)) continue;
      output += textFromNode(value);
    }
    return output;
  }
  return '';
}

function collectParagraphTexts(node, values = []) {
  if (!node || typeof node !== 'object') return values;
  if (Array.isArray(node)) {
    node.forEach((item) => collectParagraphTexts(item, values));
    return values;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_')) continue;
    if (key === 'p') {
      for (const paragraph of asArray(value)) {
        const text = cleanText(textFromNode(paragraph));
        if (text) values.push(text);
      }
      continue;
    }
    collectParagraphTexts(value, values);
  }
  return values;
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\|/g, ' |')
    .replace(/\|\s+/g, '| ')
    .trim();
}

function normalizeGroup(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/групп(?:а|ы)[\s\S]*$/i, '')
    .replace(/[^0-9a-zа-я]/g, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTeacherSurname(value) {
  return cleanText(value).split(/\s+/)[0] || '';
}

function matchesTeacher(value, teacherQuery) {
  const surname = getTeacherSurname(teacherQuery);
  if (!surname) return false;
  const pattern = new RegExp(`(^|[^А-Яа-яЁё])${escapeRegExp(surname)}(?=([А-ЯЁ]\\.){1,2}|[^А-Яа-яЁё]|$)`, 'i');
  return pattern.test(cleanText(value));
}

function tableCellText(cell) {
  return asArray(cell.p)
    .map((paragraph) => cleanText(textFromNode(paragraph)))
    .filter(Boolean)
    .join(' | ');
}

function looksLikeTeacherLine(value) {
  return /[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ]\.){1,2}/.test(cleanText(value));
}

function isPartContinuation(value) {
  const text = cleanText(value);
  return /^\d{2,3}$/.test(text) || /^\(.+\)$/.test(text) || /^каб\.?\s*\d+/i.test(text);
}

function subjectBeforeTeacher(paragraphs, teacherPosition) {
  const subjectLines = paragraphs
    .slice(0, teacherPosition)
    .filter((line) => !isPartContinuation(line));
  if (subjectLines.length) return cleanText(subjectLines.join(' '));

  const teacherLine = paragraphs[teacherPosition] || '';
  const teacherMatch = teacherLine.match(/[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ]\.){1,2}/);
  if (!teacherMatch) return '';
  return cleanText(teacherLine.slice(0, teacherMatch.index).replace(/[|·,;:–—-]+$/, ''));
}

function splitCellParts(paragraphs) {
  const teacherPositions = paragraphs
    .map((paragraph, index) => (looksLikeTeacherLine(paragraph) ? index : -1))
    .filter((index) => index >= 0);
  const subject = teacherPositions.length ? subjectBeforeTeacher(paragraphs, teacherPositions[0]) : '';

  if (teacherPositions.length < 2) {
    return [{ text: paragraphs.join(' | '), subject, hours: 2, split: false }];
  }

  const parts = [];
  let start = 0;

  for (let index = 0; index < teacherPositions.length; index += 1) {
    const teacherPosition = teacherPositions[index];
    const nextTeacherPosition = teacherPositions[index + 1] ?? paragraphs.length;
    let end = teacherPosition + 1;

    while (end < nextTeacherPosition && isPartContinuation(paragraphs[end])) end += 1;

    const partText = paragraphs.slice(start, end).join(' | ');
    if (partText) parts.push({ text: partText, subject, hours: 1, split: true });
    start = end;
  }

  if (start < paragraphs.length && parts.length) {
    parts[parts.length - 1].text = `${parts[parts.length - 1].text} | ${paragraphs.slice(start).join(' | ')}`;
  }

  return parts.length ? parts : [{ text: paragraphs.join(' | '), subject, hours: 2, split: false }];
}

function tableCellData(cell) {
  const paragraphs = asArray(cell.p)
    .map((paragraph) => cleanText(textFromNode(paragraph)))
    .filter(Boolean);

  return {
    text: paragraphs.join(' | '),
    parts: splitCellParts(paragraphs),
  };
}

function cellText(cell) {
  return typeof cell === 'string' ? cell : cell?.text || '';
}

function collectWordTables(node, tables = []) {
  if (!node || typeof node !== 'object') return tables;
  if (Array.isArray(node)) {
    node.forEach((item) => collectWordTables(item, tables));
    return tables;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_')) continue;
    if (key === 'tbl') {
      for (const table of asArray(value)) {
        tables.push(table);
        collectWordTables(table, tables);
      }
      continue;
    }
    collectWordTables(value, tables);
  }
  return tables;
}

function extractTables(document) {
  return collectWordTables(document).map((table) =>
    asArray(table.tr).map((row) => asArray(row.tc).map(tableCellData)),
  );
}

function isScheduleTable(rows) {
  const header = rows[0] || [];
  const headerText = header.map(cellText).join(' ');
  return WEEKDAYS.slice(0, 5).every((day) => headerText.includes(day));
}

function extractGroupLabel(value) {
  const text = cleanText(value);
  const groupMatch = text.match(/^(.+?групп(?:а|ы))/i);
  if (groupMatch) return cleanText(groupMatch[1]);
  return text.replace(/\s*с\s*\d{1,2}[./_-].*$/i, '').trim();
}

function extractGroupNames(document) {
  const paragraphs = collectParagraphTexts(document);
  const groups = [];

  for (let index = 0; index < paragraphs.length; index += 1) {
    const heading = paragraphs[index].match(/расписание\s*уроков\s*для\s*(.*)/i);
    if (heading) {
      const inlineGroup = extractGroupLabel(heading[1] || '');
      const group = inlineGroup || extractGroupLabel(paragraphs[index + 1] || '');
      if (group) groups.push(group);
    }
  }

  return groups;
}

function parseDateFromFileName(fileName) {
  const match = fileName.match(/(\d{2})[._-](\d{2})[._-](\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfWeek(date) {
  const daysSinceMonday = (date.getDay() + 6) % 7;
  return addDays(date, -daysSinceMonday);
}

function formatDate(date) {
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

function formatLongDate(date) {
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

function formatRange(startDate) {
  if (!startDate) return 'дата не найдена';
  const endDate = addDays(startDate, 5);
  return `${formatDate(startDate)} - ${formatDate(endDate)}`;
}

function formatDateList(dates) {
  const unique = [...new Map(dates.map((date) => [formatDate(date), date])).values()]
    .sort((a, b) => a.getTime() - b.getTime());
  if (!unique.length) return 'не найдено';
  return unique.map(formatLongDate).join(', ');
}

async function parseDocx(fileName) {
  const filePath = path.join(SCHEDULE_ROOT, fileName);
  const buffer = await fs.readFile(filePath);
  let zip;

  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw new Error(`Invalid DOCX "${fileName}": ${error.message}`);
  }

  const documentXml = await zip.file('word/document.xml').async('text');
  const document = parser.parse(documentXml);
  const groups = extractGroupNames(document);
  const scheduleTables = extractTables(document).filter(isScheduleTable);
  const fileDate = parseDateFromFileName(fileName);
  const weekStart = fileDate ? startOfWeek(fileDate) : null;

  return scheduleTables.map((rows, index) => ({
    fileName,
    group: groups[index] || `Таблица ${index + 1}`,
    weekStart,
    rows,
  }));
}

function fileVersion(stats) {
  return `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

async function getParsedSchedules(fileName) {
  const filePath = path.join(SCHEDULE_ROOT, fileName);
  const initialStats = await fs.stat(filePath);
  const version = fileVersion(initialStats);
  const cached = scheduleCache.get(fileName);
  if (cached?.version === version) return cached.schedules;

  const inFlight = scheduleParsesInFlight.get(fileName);
  if (inFlight?.version === version) return inFlight.promise;

  const promise = (async () => {
    const schedules = await parseDocx(fileName);
    const latestStats = await fs.stat(filePath);
    if (fileVersion(latestStats) === version) {
      scheduleCache.set(fileName, { version, schedules });
    }
    return schedules;
  })();

  scheduleParsesInFlight.set(fileName, { version, promise });
  try {
    return await promise;
  } finally {
    if (scheduleParsesInFlight.get(fileName)?.promise === promise) {
      scheduleParsesInFlight.delete(fileName);
    }
  }
}

async function getDocxFiles() {
  const entries = await fs.readdir(SCHEDULE_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.docx'))
    .filter((entry) => !entry.name.startsWith('~$'))
    .map((entry) => entry.name)
    .sort((a, b) => {
      const dateA = parseDateFromFileName(a)?.getTime() || 0;
      const dateB = parseDateFromFileName(b)?.getTime() || 0;
      return dateA - dateB || a.localeCompare(b, 'ru');
    });
}

function analyzeSchedule(schedule, teacherQuery) {
  const matches = [];
  const header = (schedule.rows[0] || []).map(cellText);

  for (let rowIndex = 1; rowIndex < schedule.rows.length; rowIndex += 1) {
    const row = schedule.rows[rowIndex];
    const lesson = cleanText(cellText(row[0]) || '');
    const previousLesson = findPreviousLesson(schedule.rows, rowIndex);

    for (let columnIndex = 1; columnIndex < row.length; columnIndex += 1) {
      const cell = row[columnIndex];
      const parts = cell?.parts?.length ? cell.parts : [{ text: cellText(cell), hours: 2, split: false }];
      const splitByAdjacentRow = isSplitByAdjacentRow(schedule.rows, rowIndex, columnIndex, lesson);

      for (const part of parts) {
        const text = cleanText(part.text);
        if (!text || !matchesTeacher(text, teacherQuery)) continue;

        const weekday = header[columnIndex] || WEEKDAYS[columnIndex - 1] || `День ${columnIndex}`;
        const date = schedule.weekStart ? addDays(schedule.weekStart, columnIndex - 1) : null;
        const hours = splitByAdjacentRow ? 1 : part.hours;
        matches.push({
          lesson: lesson || previousLesson,
          subject: part.subject || 'Предмет не распознан',
          weekday,
          date: date ? formatDate(date) : '',
          longDate: date ? formatLongDate(date) : weekday,
          text,
          hours,
          split: part.split || splitByAdjacentRow,
        });
      }
    }
  }

  return matches.sort((a, b) => {
    const dateCompare = dateSortValue(a.date) - dateSortValue(b.date);
    if (dateCompare) return dateCompare;
    return lessonSortValue(a.lesson) - lessonSortValue(b.lesson);
  });
}

function dateSortValue(value) {
  const [day, month, year] = String(value || '').split('.').map(Number);
  if (!day || !month || !year) return Number.MAX_SAFE_INTEGER;
  return new Date(year, month - 1, day).getTime();
}

function lessonSortValue(value) {
  const match = String(value || '').match(/\d+/);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

function findPreviousLesson(rows, rowIndex) {
  for (let index = rowIndex - 1; index > 0; index -= 1) {
    const lesson = cleanText(cellText(rows[index]?.[0]) || '');
    if (lesson) return lesson;
  }
  return '';
}

function isSplitByAdjacentRow(rows, rowIndex, columnIndex, lesson) {
  if (!lesson) return true;

  const nextRow = rows[rowIndex + 1];
  if (!nextRow) return false;

  const nextLesson = cleanText(cellText(nextRow[0]) || '');
  const nextCellText = cleanText(cellText(nextRow[columnIndex]) || '');
  return !nextLesson && Boolean(nextCellText);
}

app.get('/api/files', async (request, response) => {
  try {
    const files = await getDocxFiles();
    const schedules = [];
    const skippedFiles = [];

    for (const file of files) {
      try {
        schedules.push(...await getParsedSchedules(file));
      } catch (error) {
        console.warn(`Skipping invalid DOCX file: ${file}`, error.message);
        skippedFiles.push(file);
      }
    }

    const groups = [...new Set(schedules.map((schedule) => schedule.group))]
      .filter((group) => !/^Таблица\s+\d+$/i.test(group))
      .sort((a, b) => normalizeGroup(a).localeCompare(normalizeGroup(b), 'ru'));

    response.json({ files, groups, scheduleCount: schedules.length, skippedFiles });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze', async (request, response) => {
  try {
    const groupQuery = cleanText(request.body.group || '');
    const teacherQuery = cleanText(request.body.teacher || '');

    if (!groupQuery || !teacherQuery) {
      response.status(400).json({ error: 'Укажите группу и преподавателя.' });
      return;
    }

    const groupNeedle = normalizeGroup(groupQuery);
    const files = await getDocxFiles();
    const reports = [];
    const skipped = [];

    for (const file of files) {
      let schedules;
      try {
        schedules = await getParsedSchedules(file);
      } catch (error) {
        console.warn(`Skipping invalid DOCX file during analyze: ${file}`, error.message);
        skipped.push({ fileName: file, reason: 'Неверный DOCX-файл' });
        continue;
      }

      const matchingSchedules = schedules.filter((item) => normalizeGroup(item.group) === groupNeedle);

      if (!matchingSchedules.length) {
        skipped.push({ fileName: file, reason: 'Группа не найдена' });
        continue;
      }

      for (const schedule of matchingSchedules) {
        const matches = analyzeSchedule(schedule, teacherQuery);
        const hours = matches.reduce((sum, match) => sum + match.hours, 0);
        const dates = matches
          .map((match) => match.date ? new Date(match.date.split('.').reverse().join('-')) : null)
          .filter(Boolean);

        reports.push({
          fileName: file,
          group: schedule.group,
          weekRange: formatRange(schedule.weekStart),
          weekStart: schedule.weekStart ? formatDate(schedule.weekStart) : '',
          weekEnd: schedule.weekStart ? formatDate(addDays(schedule.weekStart, 5)) : '',
          hours,
          datesText: formatDateList(dates),
          matches,
          summary: hours
            ? `По расписанию с ${formatRange(schedule.weekStart)} у вас было ${hours} ч.; занятия были: ${formatDateList(dates)}.`
            : `По расписанию с ${formatRange(schedule.weekStart)} занятий у выбранного преподавателя не найдено.`,
        });
      }
    }

    const totalHours = reports.reduce((sum, item) => sum + item.hours, 0);
    const subjectTotalsByKey = new Map();
    for (const report of reports) {
      for (const match of report.matches) {
        const subject = match.subject || 'Предмет не распознан';
        const key = cleanText(subject).toLocaleLowerCase('ru').replace(/ё/g, 'е');
        const total = subjectTotalsByKey.get(key) || { subject, hours: 0, lessons: 0 };
        total.hours += match.hours;
        total.lessons += 1;
        subjectTotalsByKey.set(key, total);
      }
    }
    const subjectTotals = [...subjectTotalsByKey.values()]
      .sort((a, b) => b.hours - a.hours || a.subject.localeCompare(b.subject, 'ru'));
    response.json({
      group: groupQuery,
      teacher: teacherQuery,
      totalHours,
      subjectTotals,
      reports,
      skipped,
    });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Schedule journal helper: http://${HOST}:${PORT}`);
  });
}

module.exports = { app };
