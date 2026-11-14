const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const JSZip = require('jszip');
const { after, before, test } = require('node:test');

const weekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
let testRoot;
let baseUrl;
let server;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function paragraphXml(value) {
  if (!value) return '<w:p/>';
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p>`;
}

function scheduleTableXml({ monday = [], tuesday = [], thursday = [], friday = [], doubleMonday = false, doubleTuesday = false } = {}) {
  const header = [
    '',
    doubleMonday ? { text: weekdays[0], gridSpan: 2 } : weekdays[0],
    ...weekdays.slice(1).map((day, index) => (
      doubleTuesday && index === 0 ? { text: day, gridSpan: 2 } : day
    )),
  ];
  const lessonRow = doubleMonday
    ? ['1', monday, [], tuesday, [], thursday, friday, []]
    : doubleTuesday
      ? ['1', monday, tuesday, [], [], thursday, friday, []]
    : ['1', monday, tuesday, [], thursday, friday, []];
  const rows = [header.map((value) => (
    value && typeof value === 'object' && !Array.isArray(value) ? value : [value]
  )), lessonRow];
  return `<w:tbl>${rows.map((row) => `<w:tr>${row.map((cell) =>
    (() => {
      const config = cell && typeof cell === 'object' && !Array.isArray(cell) ? cell : null;
      const paragraphs = config ? [config.text || ''] : (Array.isArray(cell) ? cell : [cell]);
      const gridSpan = config?.gridSpan ? `<w:tcPr><w:gridSpan w:val="${config.gridSpan}"/></w:tcPr>` : '';
      return `<w:tc>${gridSpan}${paragraphs.map(paragraphXml).join('')}</w:tc>`;
    })(),
  ).join('')}</w:tr>`).join('')}</w:tbl>`;
}

async function writeDocx(fileName, schedules) {
  const zip = new JSZip();
  const body = schedules.map(({ group, date, lessons }) =>
    `<w:p><w:r><w:t>Расписаниеуроковдля${escapeXml(group)}с${escapeXml(date)}г.</w:t></w:r></w:p>${scheduleTableXml(lessons)}`,
  ).join('');
  zip.file('word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  await fs.writeFile(path.join(testRoot, fileName), await zip.generateAsync({ type: 'nodebuffer' }));
}

async function analyze(group, teacher = 'Девяткина') {
  const response = await fetch(`${baseUrl}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ group, teacher }),
  });
  return { response, data: await response.json() };
}

before(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-journal-tests-'));
  process.env.SCHEDULE_ROOT = testRoot;

  await writeDocx('Расписание №1 с 01.09.2026.docx', [
    {
      group: '1А группы',
      date: '01.09.2026',
      lessons: {
        monday: ['История', 'Девяткина М.О.', '120'],
        tuesday: ['МДК 02.01', 'Девяткина М.О.', '302', 'Петрова И.И.', '105'],
      },
    },
    {
      group: '1Б группы',
      date: '01.09.2026',
      lessons: { monday: ['Математика', 'Петрова И.И.', '101'] },
    },
  ]);
  await writeDocx('Расписание №2 с 14.09.2026.docx', [
    {
      group: '1А группы',
      date: '14.09.2026',
    lessons: { friday: ['История', 'Девяткина М.О.', '206'] },
    },
    {
      group: '2 ТД группы',
      date: '14.09.2026',
      lessons: {
        doubleMonday: true,
        thursday: ['История России', 'Девяткина М.О.', '206'],
      },
    },
    {
      group: '2ТГ-1 группы',
      date: '14.09.2026',
      lessons: {
        doubleTuesday: true,
        thursday: ['История России', 'Девяткина М.О.', '206'],
      },
    },
  ]);
  await fs.writeFile(path.join(testRoot, 'Поврежденный.docx'), Buffer.from('not a docx'));

  const { app } = require('../server');
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  delete process.env.SCHEDULE_ROOT;

  if (testRoot) {
    const resolvedRoot = path.resolve(testRoot);
    const resolvedTemp = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (!resolvedRoot.startsWith(resolvedTemp) || !path.basename(resolvedRoot).startsWith('schedule-journal-tests-')) {
      throw new Error(`Refusing to remove unexpected test directory: ${resolvedRoot}`);
    }
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  }
});

test('extracts group labels from compact DOCX headings', async () => {
  const response = await fetch(`${baseUrl}/api/files`);
  assert.equal(response.status, 200);
  const data = await response.json();

  assert.equal(data.files.length, 3);
  assert.equal(data.scheduleCount, 5);
  assert.ok(data.groups.includes('1А группы'));
  assert.ok(data.groups.includes('1Б группы'));
  assert.ok(data.groups.includes('2 ТД группы'));
  assert.ok(data.groups.includes('2ТГ-1 группы'));
  assert.equal(data.groups.some((group) => /с\s*\d{1,2}[./-]\d{1,2}/.test(group)), false);
  assert.deepEqual(data.skippedFiles, ['Поврежденный.docx']);
});

test('matches group code and full group label, and counts split hours and dates', async () => {
  const shortQuery = await analyze('1А');
  const fullLabelQuery = await analyze('1А группы');

  assert.equal(shortQuery.response.status, 200);
  assert.equal(shortQuery.data.reports.length, 2);
  assert.equal(shortQuery.data.totalHours, 5);
  assert.deepEqual(shortQuery.data.subjectTotals, [
    { subject: 'История', hours: 4, lessons: 2 },
    { subject: 'МДК 02.01', hours: 1, lessons: 1 },
  ]);
  assert.equal(shortQuery.data.skipped.length, 1);
  assert.equal(shortQuery.data.skipped[0].reason, 'Неверный DOCX-файл');
  assert.deepEqual(
    fullLabelQuery.data.reports.map(({ fileName, hours }) => ({ fileName, hours })),
    shortQuery.data.reports.map(({ fileName, hours }) => ({ fileName, hours })),
  );

  const firstWeek = shortQuery.data.reports.find((report) => report.fileName.includes('№1'));
  assert.equal(firstWeek.hours, 3);
  assert.equal(firstWeek.weekRange, '31.08.2026 - 05.09.2026');
  assert.deepEqual(firstWeek.matches.map(({ weekday, date, hours, split }) => ({ weekday, date, hours, split })), [
    { weekday: 'Понедельник', date: '31.08.2026', hours: 2, split: false },
    { weekday: 'Вторник', date: '01.09.2026', hours: 1, split: true },
  ]);

  const secondWeek = shortQuery.data.reports.find((report) => report.fileName.includes('№2'));
  assert.equal(secondWeek.matches[0].date, '18.09.2026');
  assert.equal(secondWeek.hours, 2);

  const shiftedTableWeek = await analyze('2ТД', 'Девяткина');
  const shiftedTableReport = shiftedTableWeek.data.reports.find((report) => report.fileName.includes('№2'));
  assert.equal(shiftedTableReport.matches[0].date, '17.09.2026');
  assert.equal(shiftedTableReport.matches[0].weekday, 'Четверг');
  assert.equal(shiftedTableReport.matches[0].hours, 2);

  const otherMergedDayWeek = await analyze('2ТГ-1', 'Девяткина');
  const otherMergedDayReport = otherMergedDayWeek.data.reports.find((report) => report.fileName.includes('№2'));
  assert.equal(otherMergedDayReport.matches[0].date, '17.09.2026');
  assert.equal(otherMergedDayReport.matches[0].weekday, 'Четверг');
});

test('returns API validation and skipped-file reasons', async () => {
  const invalidRequest = await fetch(`${baseUrl}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ group: '', teacher: 'Девяткина' }),
  });
  assert.equal(invalidRequest.status, 400);

  const missingGroup = await analyze('Несуществующая группа');
  assert.equal(missingGroup.response.status, 200);
  assert.equal(missingGroup.data.reports.length, 0);
  assert.ok(missingGroup.data.skipped.some((item) => item.reason === 'Группа не найдена'));
  assert.ok(missingGroup.data.skipped.some((item) => item.reason === 'Неверный DOCX-файл'));
});

test('does not expose the removed FAM file generation endpoint', async () => {
  const response = await fetch(`${baseUrl}/api/create-fam`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ teacher: 'Девяткина' }),
  });
  assert.equal(response.status, 404);
});

test('reparses a DOCX after its file version changes', async () => {
  const target = path.join(testRoot, 'Расписание №2 с 14.09.2026.docx');
  const previousStats = await fs.stat(target);
  await writeDocx('Расписание №2 с 14.09.2026.docx', [{
    group: '1А группы',
    date: '14.09.2026',
    lessons: {
      monday: ['История', 'Девяткина М.О.', '206'],
      friday: ['История', 'Девяткина М.О.', '206'],
    },
  }]);
  await fs.utimes(target, new Date(), new Date(previousStats.mtimeMs + 5000));

  const updated = await analyze('1А');
  assert.equal(updated.data.totalHours, 7);
  const changedWeek = updated.data.reports.find((report) => report.fileName.includes('№2'));
  assert.equal(changedWeek.hours, 4);
  assert.equal(changedWeek.matches.length, 2);
  assert.equal(updated.data.subjectTotals.find(({ subject }) => subject === 'История').hours, 6);
});
