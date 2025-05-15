import express from 'express';
import axios from 'axios';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
require('./setup');

const pdfjsLib = require('pdfjs-dist');
const app = express();
const PORT = 3001;

// Определяем диапазоны по оси X для каждого столбца
const COLUMN_X_RANGES = {
  group: [35, 70],     // Группа
  pair: [70, 95],      // Номер пары
  subject_original: [95, 250],  // Сузим диапазон для исходного предмета
  change: [250, 500],   // Расширим начало диапазона для изменений
  room: [500, 510]     // Аудитория
};

// Функция для определения столбца по x-координате элемента
function getColumnForItem(item) {
  const x = Math.round(item.transform[4]);
  for (const [column, [min, max]] of Object.entries(COLUMN_X_RANGES)) {
    if (x >= min && x < max) {
      return column;
    }
  }
  return null;
}

// Middleware для CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Эндпоинт для получения сырых данных
app.get('/api/replacements/:group', async (req, res) => {
  const { group } = req.params;
    
    if (!group) {
      return res.status(400).json({
        success: false,
        error: 'Не указана группа'
      });
    }

  try {
    const pdfUrl = `https://ttgt.org/images/pdf/zamena.pdf`;
    console.log('Загружаем файл с заменами...');
    const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
    if (!response || !response.data) {
      console.error('Ошибка: Файл пустой или не содержит данных');
      return res.status(500).json({
        success: false,
        error: 'Файл пустой или не содержит данных'
      });
    }
    console.log('Парсим PDF...');
    const dataBuffer = Buffer.from(response.data);
    const uint8Array = new Uint8Array(dataBuffer);
    const pdf = await getDocument(uint8Array).promise;
    console.log(`Количество страниц: ${pdf.numPages}`);
    const replacements = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      console.log(`Обрабатываем страницу ${pageNumber}...`);
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      // Передаем номер страницы и группу в функцию
      const rowData = parseTableData(textContent.items, pageNumber, group);
      if (rowData) {
        replacements.push(rowData); // Добавляем только если данные найдены
      }
    }
    console.log('Возвращаем структурированные данные...');
    res.json({
      success: true,
      replacements: replacements
    });
  } catch (error) {
    console.error('Ошибка:', error.message);
    res.status(500).json({
      success: false,
      error: 'Не удалось загрузить замены'
    });
  }
});

function parseTableData(items, pageNumber, group) {
  // Конвертируем формат группы
  let targetGroup = group;
  if (/^[A-Z]{1,2}\d{2}$/.test(group)) {
    const groupMap = {
      'A': 'А',
      'V': 'В',
      'D': 'Д',
      'KS': 'КС',
      'L': 'Л',
      'P': 'П',
      'PM': 'ПМ',
      'R': 'Р',
      'S': 'С',
      'SP': 'СП',
      'E': 'Э',
      'ES': 'ЭС',
    };
    const letters = group.match(/[A-Z]+/)[0];
    const numbers = group.match(/\d{2}/)[0];
    targetGroup = `${groupMap[letters]}-${numbers[0]}-${numbers[1]}`;
  }

  // Пытаемся извлечь заголовок
  const headerCandidates = items.filter(item => {
    const text = item.str;
    return /Лист\s+изменений|неделя|\d{1,2}\s*(Январ|Феврал|Март|Апрел|Ма[йя]|Июн|Июл|Август|Сентябр|Октябр|Ноябр|Декабр)|Понедельник|Вторник|Среда|Четверг|Пятница|Суббота|Воскресенье|\d{4}\s*г/i.test(text);
  });

  let headerData = {};
  if (headerCandidates.length) {
    headerData = parseHeaderInfo(headerCandidates);
  }

  // Фильтруем элементы столбца group
  const [groupStartX, groupEndX] = COLUMN_X_RANGES.group;
  const groupItems = items.filter(item => {
    const xCoord = Math.round(item.transform[4]);
    const text = item.str.trim();
    return (
      xCoord >= groupStartX &&
      xCoord < groupEndX &&
      text &&
      /^[А-ЯЁA-Z]{1,2}-\d+-\d+$/.test(text)
    );
  });

  if (!groupItems.length) {
    return { header: headerData, rows: [] };
  }

  // Сортировка элементов группы по Y
  const sortedGroupItems = groupItems.sort((a, b) => {
    const yA = Math.round(a.transform[5]);
    const yB = Math.round(b.transform[5]);
    return yA - yB;
  });

  // Поиск целевой группы
  const targetIndex = sortedGroupItems.findIndex(item => item.str.trim() === targetGroup);
  if (targetIndex === -1) {
    return { header: headerData, rows: [] };
  }

  const targetY = Math.round(sortedGroupItems[targetIndex].transform[5]);
  console.log(`\n=== Данные для группы ${targetGroup} ===`);

  // Вычисляем границы строки
  const boundaries = computeRowBoundaries(sortedGroupItems, targetIndex, pageNumber);

  // Фильтруем элементы в границах строки
  const rowItems = items.filter(item => {
    const yCoord = Math.round(item.transform[5]);
    return yCoord >= boundaries.upper && yCoord <= boundaries.lower;
  });

  // Выводим найденные элементы для группы
  console.log('\nНайденные элементы:');
  rowItems.forEach(item => {
    const column = getColumnForItem(item);
    if (column && column !== 'group') {
      console.log(`${column}: "${item.str.trim()}"`);
    }
  });

  // Собираем данные по столбцам
  let finalRows = [];
  const pairItems = rowItems.filter(item => getColumnForItem(item) === "pair" && /^\d+$/.test(item.str.trim()));
  
  if (pairItems.length > 1) {
    // Обработка нескольких пар
    for (const pairItem of pairItems) {
      const pairY = Math.round(pairItem.transform[5]);
      const pairItems = rowItems.filter(item => {
        const itemY = Math.round(item.transform[5]);
        return Math.abs(itemY - pairY) <= 5;
      });
      
      const rowData = buildRowData(pairItems);
      if (rowData.pair) {
        console.log(`\nИтоговые данные для пары ${rowData.pair}:`, rowData);
        finalRows.push(rowData);
      }
    }
  } else {
    const rowData = buildRowData(rowItems);
    if (rowData.pair) {
      console.log('\nИтоговые данные:', rowData);
      finalRows.push(rowData);
    }
  }

  return { header: headerData, rows: finalRows };
}

function buildRowData(elements) {
  const data = {};
  
  // Сначала собираем все элементы по столбцам
  const columnData = {};
  elements.forEach(item => {
    const column = getColumnForItem(item);
    if (column && column !== "group") {
      if (!columnData[column]) {
        columnData[column] = [];
      }
      columnData[column].push({
        text: item.str.trim(),
        x: Math.round(item.transform[4]),
        y: Math.round(item.transform[5])
      });
    }
  });

  // Сортируем элементы в каждом столбце
  for (const column in columnData) {
    // Группируем элементы по Y-координате с погрешностью в 5 единиц
    const yGroups = {};
    columnData[column].forEach(item => {
      const yKey = Object.keys(yGroups).find(y => Math.abs(item.y - parseInt(y)) <= 5) || item.y;
      if (!yGroups[yKey]) {
        yGroups[yKey] = [];
      }
      yGroups[yKey].push(item);
    });

    // Сортируем элементы внутри каждой Y-группы по X-координате
    Object.values(yGroups).forEach(group => {
      group.sort((a, b) => a.x - b.x);
    });

    // Собираем все группы в порядке Y-координат (сверху вниз)
    const sortedYKeys = Object.keys(yGroups).sort((a, b) => parseInt(b) - parseInt(a));
    const sortedElements = [];
    sortedYKeys.forEach(y => {
      sortedElements.push(...yGroups[y]);
    });

    // Объединяем текст
    data[column] = sortedElements.map(item => item.text).join(" ").trim();
  }

  // Очищаем номер пары от лишних пробелов
  if (data.pair) {
    data.pair = data.pair.trim();
  }

  // Обработка случая, когда предмет пустой, а замена содержит полное название предмета
  if (data.subject_original === "" && data.change) {
    data.subject_original = "";
    data.change = data.change.trim();
  }
  // Обработка случая, когда предмет указан, а замена содержит другой предмет
  else if (data.subject_original && data.change) {
    // Если в change есть пробелы (признак полного названия предмета)
    if (data.change.includes(" ")) {
      data.change = data.change.trim();
    }
    // Если это просто инициалы в change
    else {
      const subjectParts = data.subject_original.split(" ");
      const lastWord = subjectParts[subjectParts.length - 1];
      
      if (/^[А-ЯЁ][а-яё]+$/.test(lastWord)) {
        const changeMatch = data.change.match(/^([А-ЯЁ]\.[А-ЯЁ]\.)(.*)$/);
        if (changeMatch) {
          subjectParts[subjectParts.length - 1] = `${lastWord} ${changeMatch[1]}`;
          data.subject_original = subjectParts.join(" ");
          data.change = changeMatch[2] ? changeMatch[2].trim() : "";
        }
      }
    }
  }

  return data;
}

function computeRowBoundaries(sortedItems, targetIndex, pageNumber) {
  // Используем исходные значения Y для вычислений
  const yCoordinates = sortedItems.map(item => item.transform[5]);

  // Если элементов слишком мало, используем fallback-вычисление
  if (yCoordinates.length < 3) {
    if (yCoordinates.length === 2) {
      const diff = Math.abs(yCoordinates[1] - yCoordinates[0]) / 2;
      const targetY = yCoordinates[targetIndex];
      return { 
        upper: targetY - diff,
        lower: targetY + diff
      };
    }
    return { 
      upper: yCoordinates[0],
      lower: yCoordinates[0]
    };
  }

  // Находим пару соседних элементов с минимальной разницей по Y
  let minGap = Infinity, baseIndex = null;
  for (let i = 0; i < yCoordinates.length - 1; i++) {
    const gap = yCoordinates[i + 1] - yCoordinates[i];
    if (gap < minGap) {
      minGap = gap;
      baseIndex = i;
    }
  }

  // Опорная граница – среднее значение Y для найденной пары
  const baseBoundary = (yCoordinates[baseIndex] + yCoordinates[baseIndex + 1]) / 2;
  let upperBoundary, lowerBoundary;
  const targetY = yCoordinates[targetIndex];

  if (targetY < baseBoundary) {
    let B = baseBoundary;
    for (let i = baseIndex + 1; i > targetIndex; i--) {
      const gap = Math.abs(B - yCoordinates[i - 1]);
      B = yCoordinates[i - 1] - gap;
    }
    upperBoundary = B;
    const diff = targetY - upperBoundary;
    lowerBoundary = targetY + diff;
  } else if (targetY > baseBoundary) {
    let B = baseBoundary;
    for (let i = baseIndex; i < targetIndex; i++) {
      const gap = Math.abs(yCoordinates[i + 1] - B);
      B = yCoordinates[i + 1] + gap;
    }
    lowerBoundary = B;
    const diff = lowerBoundary - targetY;
    upperBoundary = targetY - diff;
  } else {
    upperBoundary = baseBoundary;
    lowerBoundary = baseBoundary;
  }

  return { upper: upperBoundary, lower: lowerBoundary };
}

function convertRussianDateToISO(dateStr) {
  // Карта соответствия русских названий месяцев в родительном падеже и их порядковых номеров
  const months = {
    "Января": 1,
    "Февраля": 2,
    "Марта": 3,
    "Апреля": 4,
    "Мая": 5,
    "Июня": 6,
    "Июля": 7,
    "Августа": 8,
    "Сентября": 9,
    "Октября": 10,
    "Ноября": 11,
    "Декабря": 12
  };

  // Регулярное выражение для разбора строки вида "15 Апреля 2025г."
  const match = dateStr.match(/(\d{1,2})\s+([А-Яа-я]+)[г\.]*/i);
  if (!match) return null;
  
  const day = match[1].padStart(2, '0');
  const monthName = match[2];
  const monthNumber = months[monthName];
  if (!monthNumber) return null;
  
  // Если год не указан, можно задать его по умолчанию; здесь год извлекается из даты
  // Для строки "15 Апреля 2025г." год берем из части dateStr:
  const yearMatch = dateStr.match(/(\d{4})/);
  const year = yearMatch ? yearMatch[1] : new Date().getFullYear();
  
  // Создаем дату в UTC (месяцы в Date начинаются с 0)
  const date = new Date(Date.UTC(year, monthNumber - 1, day));
  return date.toISOString();
}

function parseHeaderInfo(items) {
  console.log('Начало parseHeaderInfo, количество элементов:', items.length);
  console.log('Исходные элементы:', items.map(item => ({
    text: item.str,
    x: Math.round(item.transform[4]),
    y: Math.round(item.transform[5])
  })));

  // Сначала группируем элементы по Y-координате с увеличенной погрешностью
  const yGroups = {};
  items.forEach(item => {
    const y = Math.round(item.transform[5]);
    // Увеличиваем погрешность до 10 единиц
    const existingY = Object.keys(yGroups).find(key => Math.abs(y - parseFloat(key)) < 10);
    const targetY = existingY || y;
    if (!yGroups[targetY]) {
      yGroups[targetY] = [];
    }
    yGroups[targetY].push(item);
  });

  console.log('Сгруппированные элементы по Y:', yGroups);

  // Сортируем группы по Y-координате (от большей к меньшей)
  const sortedYs = Object.keys(yGroups).sort((a, b) => b - a);
  console.log('Отсортированные Y-координаты:', sortedYs);

  // В каждой группе сортируем элементы по X-координате и объединяем их
  const lines = sortedYs.map(y => {
    const lineElements = yGroups[y]
      .sort((a, b) => a.transform[4] - b.transform[4])
      .map(item => item.str.trim());
    const line = lineElements.join(" ").trim();
    console.log(`Строка для Y=${y}:`, lineElements, ' -> ', line);
    return line;
  });

  // Объединяем все строки
  const combinedHeader = lines.join(" ").replace(/\s+/g, " ").trim();
  console.log('Объединенный заголовок:', combinedHeader);

  // Извлечение номера недели
  const weekMatch = combinedHeader.match(/(\d+)\s*неделя/i);
  const weekNumber = weekMatch ? parseInt(weekMatch[1], 10) : null;
  console.log('Номер недели:', weekNumber);

  // Улучшенное регулярное выражение для извлечения даты с более гибким форматом
  const dateRegex = /(\d{1,2})\s*(Январ[ья]|Феврал[ья]|Март[а]?|Апрел[ья]|Ма[йя]|Июн[ья]|Июл[ья]|Август[а]|Сентябр[ья]|Октябр[ья]|Ноябр[ья]|Декабр[ья])\s*(\d{4})(?:г\.?)?/i;
  const dateMatch = combinedHeader.match(dateRegex);
  console.log('Результат поиска даты:', dateMatch);

  let dateStr = null;
  if (dateMatch) {
    dateStr = `${dateMatch[1]} ${dateMatch[2]} ${dateMatch[3]}г.`;
    console.log('Сформированная строка даты:', dateStr);
  }

  // Преобразуем извлечённую дату в ISO‑формат
  const isoDate = dateStr ? convertRussianDateToISO(dateStr) : null;
  console.log('ISO дата:', isoDate);

  // Извлечение дня недели с учётом возможных подчёркиваний
  const cleanedHeader = combinedHeader.replace(/[_]+/g, "").trim();
  const dayMatch = cleanedHeader.match(/(Понедельник|Вторник|Среда|Четверг|Пятница|Суббота|Воскресенье)/i);
  const dayOfWeek = dayMatch ? dayMatch[1].trim() : null;
  console.log('День недели:', dayOfWeek);

  const result = {
    combinedHeader: combinedHeader,
    weekNumber: weekNumber,
    date: dateStr,
    isoDate: isoDate,
    dayOfWeek: dayOfWeek,
    timestamp: isoDate || new Date().toISOString()
  };

  console.log('Итоговый результат:', result);
  return result;
}

// Пример использования (если items уже доступны):
// const rowItems = displayRowRange(items);

// Эндпоинт для получения данных о расписании
app.get('/api/schedule/:group', async (req, res) => {
  try {
    const { group } = req.params;
    
    if (!group) {
      return res.status(400).json({
        success: false,
        error: 'Не указана группа'
      });
    }

    const pdfUrl = `https://ttgt.org/images/raspisanie/ochno/${group}.pdf`;

    console.log('Загружаем файл с заменами...');
    const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });

    if (!response || !response.data) {
      console.error('Ошибка: Файл пустой или не содержит данных');
      return res.status(500).json({
        success: false,
        error: 'Файл пустой или не содержит данных'
      });
    }

    console.log('Парсим PDF...');
    const dataBuffer = Buffer.from(response.data);
    const uint8Array = new Uint8Array(dataBuffer);

    const pdf = await getDocument(uint8Array).promise;

    console.log(`Количество страниц: ${pdf.numPages}`);

    const structuredData = []; 

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      console.log(`Обрабатываем страницу ${pageNumber}...`);
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();  

      const parsedData = parseSchedulePDF(textContent.items);
      if (parsedData) {
        structuredData.push(parsedData);
      }
    }

    const moscowTime = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    
    console.log('Возвращаем структурированные данные...');
    res.json({
      success: true,
      structuredData: structuredData,
      timestamp: moscowTime
    });
  } catch (error) {
    console.error('Ошибка:', error.message);
    res.status(500).json({
      success: false,
      error: 'Не удалось загрузить замены'
    });
  }
});
function parseSchedulePDF(items) {
  const targetGroups = ['Пнд', 'Втр', 'Срд', 'Чтв', 'Птн', 'Сбт'];
  const COLUMN_X_RANGE = {
    day: [43 - 45, 43 + 45],
    p1: [135 - 45, 135 + 45],
    p2: [215 - 45, 215 + 45],
    p3: [295 - 45, 295 + 45],
    p4: [375 - 45, 375 + 45],
    p5: [455 - 45, 455 + 45]
  };

  // Объект соответствий для дней недели
  const dayMapping = {
    'Пнд': 'Понедельник',
    'Втр': 'Вторник',
    'Срд': 'Среда',
    'Чтв': 'Четверг',
    'Птн': 'Пятница',
    'Сбт': 'Суббота'
  };

  function normalizeText(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/^\s+|\s+$/g, '')
      .replace(/[^\S\r\n]+/g, ' ')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/([А-ЯЁ])\s*\.\s*([А-ЯЁ])\s*\./g, '$1.$2.')
      .replace(/([А-ЯЁ])\.([А-ЯЁ])\s?\.?/g, '$1.$2.')
      .replace(/(\d+)\s*п\s*\/\s*г/ig, '$1 п/г')
      .replace(/\s*\/\s*/g, '/')
      .replace(/(\d)\s+(?!п\/г)([А-Яа-яЁё])/gi, '$1$2');
  }

  // Обновлённая функция разбора пары
  function parseLesson(text) {
    if (!text) return null;
    const normalized = normalizeText(text);
    if (normalized === '') return null;

    console.log('Парсинг строки:', normalized);

    // Специальная обработка для "Физическая культура"
    if (normalized.includes('Физическая культура')) {
        // Ищем паттерн "Фамилия И.О." в оставшейся части
        const teacherMatch = normalized.match(/(?:Физическая культура\s+)?([А-ЯЁ][а-яё]+)\s+([А-ЯЁ])\s*\.\s*([А-ЯЁ])\s*\./);
        
        if (teacherMatch) {
            const surname = teacherMatch[1];
            const initials = `${teacherMatch[2]}.${teacherMatch[3]}.`;
            const fullTeacher = `${surname} ${initials}`;
            
            // Получаем всё, что после ФИО как аудиторию
            const roomMatch = normalized.substring(normalized.indexOf(fullTeacher) + fullTeacher.length).trim();
            
            console.log('Разбор Физической культуры:', {
                subject: 'Физическая культура',
                teacher: fullTeacher,
                room: roomMatch
            });

            return {
                subject: 'Физическая культура',
                teacher: fullTeacher,
                room: roomMatch
            };
        }
    }

    // Обработка подгруппы в упрощённом формате
    const subgroupMatch = normalized.match(/(\d+)\s*п\/г\s*(.+)/i);
    if (subgroupMatch) {
        console.log('Найдена подгруппа:', subgroupMatch[1], 'данные:', subgroupMatch[2]);
        return {
            subject: '',
            teacher: subgroupMatch[2].trim(),
            room: ''
        };
    }

    // Стандартная обработка: разбиваем строку на три части: subject, teacher и room
    const partsMatch = normalized.match(/^(.*?)\s+([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ]\.[А-ЯЁ]\.)?)\s*([\d\w\/\-]*)?$/);
    if (partsMatch) {
        const [, subject, teacher, room = ''] = partsMatch;
        console.log('Стандартный разбор:', {
            subject: subject.trim(),
            teacher: teacher.trim(),
            room: room.trim()
        });
        return {
            subject: subject.trim(),
            teacher: teacher.trim(),
            room: room.trim()
        };
    }

    console.warn('Не удалось распарсить текст пары:', normalized);
    return {
        subject: normalized,
        teacher: '',
        room: ''
    };
  }

  const allScheduleData = [];
  let currentWeek = null;
  let weekData = null;
  const groupYCoordinates = [];
  const dayColumnElements = [];

  for (const item of items) {
    const text = item.str.trim();
    const xCoord = Math.round(item.transform[4]);
    const yCoord = Math.round(item.transform[5]);
    if (!text) continue;
    for (const [columnName, [startX, endX]] of Object.entries(COLUMN_X_RANGE)) {
      if (xCoord >= startX && xCoord < endX) {
        if (columnName === 'day') {
          if (text.includes('1-') || text.includes('2-')) {
            currentWeek = parseInt(text.match(/\d+/)[0]);
            weekData = { week: currentWeek, days: [] };
            allScheduleData.push(weekData);
          } else {
            dayColumnElements.push({ text, yCoord, week: currentWeek });
            groupYCoordinates.push(yCoord);
          }
        }
        break;
      }
    }
  }

  for (const weekData of allScheduleData) {
    const weekDayElements = dayColumnElements.filter(el => el.week === weekData.week);
    for (const targetGroup of targetGroups) {
      const targetElement = weekDayElements.find(el => el.text === targetGroup);
      if (!targetElement) continue;
      const targetGroupY = targetElement.yCoord;
      let nextElement = null;
      const currentIndex = weekDayElements.findIndex(el => el.yCoord === targetGroupY);
      if (currentIndex !== -1 && currentIndex < weekDayElements.length - 1) {
        nextElement = weekDayElements[currentIndex + 1];
      }
      const sortedYCoordinates = [...new Set(groupYCoordinates)].sort((a, b) => b - a);
      let upperBoundary = Infinity;
      let lowerBoundary = -Infinity;
      for (let i = 0; i < sortedYCoordinates.length; i++) {
        const currentY = sortedYCoordinates[i];
        if (currentY === targetGroupY) {
          upperBoundary = currentY + 5;
          lowerBoundary = nextElement ? nextElement.yCoord + 5 : currentY - 20;
        }
      }
      // Собираем данные по столбцам из текущей группы:
      const scheduleData = {
        day: [],
        p1: [],
        p2: [],
        p3: [],
        p4: [],
        p5: []
      };
      for (const item of items) {
        const text = item.str.trim();
        const xCoord = Math.round(item.transform[4]);
        const yCoord = Math.round(item.transform[5]);
        if (yCoord <= upperBoundary && yCoord >= lowerBoundary) {
          for (const [columnName, [startX, endX]] of Object.entries(COLUMN_X_RANGE)) {
            if (xCoord >= startX && xCoord < endX) {
              scheduleData[columnName].push(text);
              break;
            }
          }
        }
      }
      // Обрабатываем данные для дня и пар:
      let dayValue = normalizeText(scheduleData.day.join(' '));
      dayValue = dayMapping[dayValue] || dayValue;

      // Формируем массив пар для p1–p5
      let pairs = [];
      for (let i = 1; i <= 5; i++) {
        pairs.push(parseLesson(scheduleData['p' + i].join(' ')));
      }
      // Оборачиваем каждую пару, добавляя ключ "pair" со строковым номером.
      // Если значение null, возвращаем объект с пустыми значениями за исключением pair.
      pairs = pairs.map((pairData, index) => {
        if (pairData) {
          return { pair: String(index + 1), ...pairData };
        }
        return { pair: String(index + 1), subject: "", teacher: "", room: "" };
      });

      const finalScheduleData = {
        day: dayValue,
        pairs: pairs
      };

      weekData.days.push(finalScheduleData);
    }
  }
  return allScheduleData;
}

app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});