const { chromium } = require('playwright');
const ical = require('ical-generator').default;
const fs = require('fs');
const { execSync } = require('child_process');

async function evaluateWithRetry(page, fn, args = undefined, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const label = options.label || 'evaluate';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await page.evaluate(fn, args);
    } catch (error) {
      const message = error?.message || String(error);
      console.log(`   ⚠️ ${label}: спроба ${attempt}/${maxRetries} - ${message}`);
      if (attempt === maxRetries) throw error;
      try {
        await page.waitForLoadState('networkidle', { timeout: 60000 });
      } catch (e) {
        // ignore
      }
      try {
        await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
      } catch (e) {
        // ignore
      }
      await page.waitForTimeout(1500);
    }
  }
}

// Читаємо конфіг
let config;
try {
  config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
} catch (error) {
  console.error('❌ Помилка при читанні config.json:', error.message);
  config = {
    addresses: [{
      id: 'default', name: 'Адреса', city: 'с. Гора', street: 'вул. Мостова', house: '21', filename: 'dtek.ics'
    }]
  };
}

const addresses = config.addresses || [{ id: 'default', name: 'Адреса', ...config.address, filename: 'dtek.ics' }];

console.log('📋 Знайдено ' + addresses.length + ' адрес(и):');
addresses.forEach((addr, i) => {
  console.log('   ' + (i + 1) + '. ' + addr.name + ': ' + addr.city + ', ' + addr.street + ', ' + addr.house + ' → ' + addr.filename);
});
console.log('');

// Отримуємо дані для адреси
async function fetchAddressData(page, address, sessionData) {
  const { city, street, house, queue: configQueue, forceQueue } = address;
  
  let apiResponse;
  let freshSessionData = sessionData;
  const maxRetries = 3;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Перевіряємо чи сторінка ще активна, якщо ні - перезавантажуємо
      try {
        await page.evaluate(() => document.readyState);
      } catch (e) {
        console.log('   🔄 Сторінка втрачена, перезавантажуємо...');
        await page.goto('https://www.dtek-krem.com.ua/ua/shutdowns', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(2000);
        // Оновлюємо sessionData після перезавантаження
        freshSessionData = await page.evaluate(() => ({
          fact: typeof DisconSchedule !== 'undefined' ? DisconSchedule.fact : null,
        }));
      }
      
      apiResponse = await page.evaluate(async (params) => {
        const formData = new URLSearchParams();
        formData.append('method', 'getHomeNum');
        formData.append('data[0][name]', 'city');
        formData.append('data[0][value]', params.city);
        formData.append('data[1][name]', 'street');
        formData.append('data[1][value]', params.street);
        formData.append('data[2][name]', 'house_num');
        formData.append('data[2][value]', params.house);
        
        const csrfMeta = document.querySelector('meta[name="csrf-token"]');
        const csrfParam = document.querySelector('meta[name="csrf-param"]');
        if (csrfMeta && csrfParam) {
          formData.append(csrfParam.content, csrfMeta.content);
        }
        
        const response = await fetch('/ua/ajax', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
          body: formData.toString()
        });
        
        return response.json();
      }, { city, street, house });
      
      break; // Успішно - виходимо з циклу
    } catch (error) {
      console.log('   ⚠️ Спроба ' + attempt + '/' + maxRetries + ' - ' + error.message);
      if (attempt === maxRetries) {
        console.log('   ❌ Всі спроби вичерпано');
        return { schedules: [], infoBlockType: null, infoBlockText: null, updateTime: null };
      }
      await page.waitForTimeout(2000);
    }
  }
  
  if (apiResponse.error) {
    console.log('   ❌ Помилка API:', apiResponse.error);
    return { schedules: [], infoBlockType: null, infoBlockText: null, updateTime: null, currentOutage: null };
  }
  
  let outageData = { schedules: [], infoBlockType: null, infoBlockText: null, updateTime: null, currentOutage: null };
  
  // Час оновлення
  if (apiResponse.updateTimestamp) {
    const match = apiResponse.updateTimestamp.match(/(\d{1,2}):(\d{2})/);
    if (match) {
      outageData.updateTime = String(match[1]).padStart(2, '0') + ':' + match[2];
    }
  }
  
  // Тип відключення та повний текст інфо-вікна
  if (apiResponse.data) {
    const houseData = apiResponse.data[house] || Object.values(apiResponse.data)[0];
    if (houseData?.sub_type) {
      // Збираємо повний текст як на сайті
      let fullText = 'Причина: ' + houseData.sub_type;
      if (houseData.start_date) {
        fullText += '\nЧас початку – ' + houseData.start_date;
      }
      if (houseData.end_date) {
        fullText += '\nОрієнтовний час відновлення – до ' + houseData.end_date;
      }
      if (houseData.sub_type_info) {
        fullText += '\n\n' + houseData.sub_type_info;
      }
      outageData.infoBlockText = fullText;
      
      // Зберігаємо поточне відключення з реальними часами
      if (houseData.start_date && houseData.end_date) {
        outageData.currentOutage = {
          startDate: houseData.start_date,
          endDate: houseData.end_date
        };
      }
      
      const subType = houseData.sub_type.toLowerCase();
      // Спочатку перевіряємо 'аварійн', бо текст може бути "Екстренні відключення (Аварійне...)"
      if (subType.includes('аварійн')) outageData.infoBlockType = 'accident';
      else if (subType.includes('екстрен')) outageData.infoBlockType = 'emergency';
      else outageData.infoBlockType = 'stabilization';
    }
  }
  
  // Графік
  const factData = freshSessionData.fact || apiResponse.fact;
  if (factData?.data) {
    let queueKey = null;
    
    if (forceQueue && configQueue) {
      queueKey = configQueue;
    } else {
      if (apiResponse.data) {
        const houseData = apiResponse.data[house] || Object.values(apiResponse.data)[0];
        queueKey = houseData?.sub_type_reason?.[0];
      }
      if (!queueKey && configQueue) queueKey = configQueue;
    }
    
    if (queueKey) {
      console.log('   ⚡ Черга: ' + queueKey);
      Object.entries(factData.data).forEach(([dayTimestamp, dayData]) => {
        if (dayData[queueKey]) {
          const schedule = [];
          Object.entries(dayData[queueKey]).forEach(([hour, status]) => {
            let cellStatus = 'light';
            if (status === 'no' || status === 'maybe') cellStatus = 'no-light';
            else if (status === 'first' || status === 'mfirst') cellStatus = 'no-light-first-half';
            else if (status === 'second' || status === 'msecond') cellStatus = 'no-light-second-half';
            schedule.push({ hour: parseInt(hour), status: cellStatus });
          });
          schedule.sort((a, b) => a.hour - b.hour);
          if (schedule.length > 0) outageData.schedules.push({ dayTimestamp: parseInt(dayTimestamp), schedule });
        }
      });
    }
  }
  
  return outageData;
}

// Генеруємо календар
function generateCalendar(address, outageData, modalInfo, urgentMark = null) {
  const cal = ical({ name: '⚡️' + address.name, timezone: 'Europe/Kyiv' });
  
  const updateTimeStr = outageData.updateTime ? '⟲ ' + outageData.updateTime : '';
  
  // Чи діють екстрені/аварійні відключення
  const isEmergency = outageData.infoBlockType === 'emergency' || modalInfo.modalAlertType === 'emergency';
  const isAccident = outageData.infoBlockType === 'accident' || modalInfo.modalAlertType === 'accident';
  let isUrgent = isEmergency || isAccident;
  // Якщо передано urgentMark (наприклад, ‼️), то замінюємо ⚠️ на нього, або прибираємо позначку
  // Використовуємо нові символи для подій: '○ off' та '● on'
  let urgentOffSummary = '○ off';
  let urgentOnSummary = '● on';
  if (typeof urgentMark !== 'undefined' && urgentMark !== null) {
    if (urgentMark === '‼️') {
      urgentOffSummary += ' ‼️';
      urgentOnSummary += ' ‼️';
      isUrgent = false;
    } else if (urgentMark === '') {
      // Без позначок: не додаємо ⚠️
      // нічого не додаємо
      isUrgent = false;
    }
  } else if (isUrgent) {
    urgentOffSummary += ' ⚠️';
    urgentOnSummary += ' ⚠️';
  }
  // Парсимо час відновлення з API (формат: "до 13:34 07.02")
  let recoveryTimeStr = null;
  if (outageData.currentOutage?.endDate) {
    const match = outageData.currentOutage.endDate.match(/(\d{1,2}):(\d{2})\s+(\d{2})\.(\d{2})/);
    if (match) {
      const [, hours, minutes, day, month] = match;
      recoveryTimeStr = 'до ' + String(hours).padStart(2, '0') + ':' + minutes + ' ' + day + '.' + month;
    }
  }
  if (recoveryTimeStr) urgentOffSummary += ' ● ' + recoveryTimeStr;
  // Не додаємо updateTimeStr до urgentOnSummary/urgentOffSummary — час оновлення лише з API (infoSuffix)
  
  // Текст інфовікна (без "Орієнтовний час відновлення" - це дублікат) - тільки для актуальної події
  let infoSuffix = '';
  if (outageData.infoBlockText) {
    let infoText = outageData.infoBlockText
      .replace(/\n/g, ' ')
      .replace(/\s*Орієнтовний час відновлення[^|]*/i, '');
    if (recoveryTimeStr) {
      infoSuffix = ' ● ' + recoveryTimeStr + infoSuffix;
    }
    infoSuffix += ' | ' + infoText.trim();
    // Remove duplicate update time if present in infoSuffix
    if (updateTimeStr && infoSuffix.includes(updateTimeStr)) {
      // Remove updateTimeStr from infoSuffix to avoid duplication
      infoSuffix = infoSuffix.replace(updateTimeStr, '').replace(/\s{2,}/g, ' ').trim();
    }
  }
  // Note: modal popup text is available in modalInfo.modalText but we prefer
  // the API-provided info window text (`outageData.infoBlockText`) for SUMMARY.
  
  // Опис події
  const defaultDescription = 'Електроенергія має бути в наявності.';
  const defaultOutageDescription = 'Відключення за графіком.';
  
  const allEvents = [];
  
  // Обробляємо графік з розділенням подій по 00:00
  outageData.schedules.forEach(sched => {
    const utcDate = new Date(sched.dayTimestamp * 1000);
    const kyivDateStr = utcDate.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' });
    const kyivDate = new Date(kyivDateStr);
    const year = kyivDate.getFullYear(), month = kyivDate.getMonth(), day = kyivDate.getDate();

    // Збираємо відрізки без світла
    const outageSegments = [];
    for (const slot of sched.schedule) {
      const hour = slot.hour;
      if (slot.status === 'no-light') {
        outageSegments.push({ start: (hour - 1) * 60, end: hour * 60 });
      } else if (slot.status === 'no-light-first-half') {
        outageSegments.push({ start: (hour - 1) * 60, end: (hour - 1) * 60 + 30 });
      } else if (slot.status === 'no-light-second-half') {
        outageSegments.push({ start: (hour - 1) * 60 + 30, end: hour * 60 });
      }
    }

    // Об'єднуємо сусідні відрізки
    const merged = [];
    for (const seg of outageSegments.sort((a, b) => a.start - b.start)) {
      if (merged.length === 0) {
        merged.push({ ...seg });
      } else {
        const last = merged[merged.length - 1];
        if (seg.start <= last.end) {
          last.end = Math.max(last.end, seg.end);
        } else {
          merged.push({ ...seg });
        }
      }
    }

    // Створюємо події з розділенням по 00:00
    for (const seg of merged) {
      let startH = Math.floor(seg.start / 60), startM = seg.start % 60;
      let endH = Math.floor(seg.end / 60), endM = seg.end % 60;
      let eventStart = new Date(year, month, day, startH, startM);
      let eventEnd = new Date(year, month, day, endH, endM);

      // Якщо подія закінчується після 00:00 наступного дня, розбиваємо її
      if (eventEnd.getDate() !== eventStart.getDate() || eventEnd.getHours() === 0 && eventEnd.getMinutes() === 0 && eventEnd > eventStart) {
        // Кінець події після 00:00 наступного дня або рівно о 00:00
        const midnight = new Date(eventStart.getFullYear(), eventStart.getMonth(), eventStart.getDate() + 1, 0, 0, 0);
        if (eventEnd > midnight) {
          // Перша частина: до 00:00
          allEvents.push({
            start: eventStart,
            end: midnight,
            summary: isUrgent ? urgentOffSummary + ' ⚠️' : urgentOffSummary,
            description: defaultOutageDescription,
            isOutage: true
          });
          // Друга частина: після 00:00
          allEvents.push({
            start: midnight,
            end: eventEnd,
            summary: isUrgent ? urgentOffSummary + ' ⚠️' : urgentOffSummary,
            description: defaultOutageDescription,
            isOutage: true
          });
        } else {
          // Якщо подія закінчується рівно о 00:00 наступного дня
          allEvents.push({
            start: eventStart,
            end: midnight,
            summary: isUrgent ? urgentOffSummary + ' ⚠️' : urgentOffSummary,
            description: defaultOutageDescription,
            isOutage: true
          });
        }
      } else {
        // Звичайна подія в межах дня
        allEvents.push({
          start: eventStart,
          end: eventEnd,
            summary: isUrgent ? urgentOffSummary + ' ⚠️' : urgentOffSummary,
          description: defaultOutageDescription,
          isOutage: true
        });
      }
    }

    // Створюємо події "on" між відключеннями
    const onSegments = [];
    let previousEnd = 0;
    for (const seg of merged) {
      if (seg.start > previousEnd) {
        onSegments.push({ start: previousEnd, end: seg.start });
      }
      previousEnd = seg.end;
    }
    if (previousEnd < 1440) {
      onSegments.push({ start: previousEnd, end: 1440 });
    }

    // Створюємо події on з розділенням по 00:00
    for (const seg of onSegments) {
      let startH = Math.floor(seg.start / 60), startM = seg.start % 60;
      let endH = Math.floor(seg.end / 60), endM = seg.end % 60;
      let eventStart = new Date(year, month, day, startH, startM);
      let eventEnd = new Date(year, month, day, endH, endM);

      // Якщо подія закінчується після 00:00 наступного дня, розбиваємо її
      if (eventEnd.getDate() !== eventStart.getDate() || eventEnd.getHours() === 0 && eventEnd.getMinutes() === 0 && eventEnd > eventStart) {
        const midnight = new Date(eventStart.getFullYear(), eventStart.getMonth(), eventStart.getDate() + 1, 0, 0, 0);
        if (eventEnd > midnight) {
          // Перша частина: до 00:00
          allEvents.push({
            start: eventStart,
            end: midnight,
            summary: isUrgent ? urgentOnSummary + ' ⚠️' : urgentOnSummary,
            description: defaultDescription,
            isOutage: false
          });
          // Друга частина: після 00:00
          allEvents.push({
            start: midnight,
            end: eventEnd,
            summary: isUrgent ? urgentOnSummary + ' ⚠️' : urgentOnSummary,
            description: defaultDescription,
            isOutage: false
          });
        } else {
          // Якщо подія закінчується рівно о 00:00 наступного дня
          allEvents.push({
            start: eventStart,
            end: midnight,
            summary: isUrgent ? urgentOnSummary + ' ⚠️' : urgentOnSummary,
            description: defaultDescription,
            isOutage: false
          });
        }
      } else {
        // Звичайна подія в межах дня
        allEvents.push({
          start: eventStart,
          end: eventEnd,
            summary: isUrgent ? urgentOnSummary + ' ⚠️' : urgentOnSummary,
          description: defaultDescription,
          isOutage: false
        });
      }
    }
  });
  
  // Сортуємо
  allEvents.sort((a, b) => a.start - b.start);
  
  // Видаляємо накладання подій (об'єднуємо перетинаючіся)
  const mergedEvents = [];
  for (const event of allEvents) {
    if (mergedEvents.length === 0) {
      mergedEvents.push({ ...event });
    } else {
      const last = mergedEvents[mergedEvents.length - 1];
      // Якщо події перетинаються або стикаються і того ж типу
      if (event.start <= last.end && event.isOutage === last.isOutage) {
        // Об'єднуємо: розширюємо кінець останньої події
        if (event.end > last.end) {
          last.end = event.end;
        }
        // Зберігаємо wasAdjusted якщо будь-яка з подій була скоригована
        if (event.wasAdjusted) last.wasAdjusted = true;
      } else {
        mergedEvents.push({ ...event });
      }
    }
  }
  
  // Замінюємо allEvents на об'єднані
  allEvents.length = 0;
  allEvents.push(...mergedEvents);
  
  // Видалено: Коригування часу відключення згідно start_date/end_date з API (події формуються виключно з outageData.schedules)
  
  // Додаємо всі події в календар з нагадуванням за 30 хв
  // Використовуємо київський час для порівняння
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  allEvents.forEach(event => {
    // Пропускаємо минулі події (не додаємо в календар)
    if (event.end <= now) {
      return;
    }
    
    // Визначаємо чи подія актуальна (зараз активна) чи майбутня
    const isCurrentEvent = event.start <= now && event.end > now;
    const isFutureEvent = event.start > now;
    
    // Для актуальної події - якщо є інфовікно, то для on беремо час з графіка (event.end)
    let infoSuffix = '';
    if (outageData.infoBlockText) {
      let infoText = outageData.infoBlockText
        .replace(/\n/g, ' ')
        .replace(/\s*Орієнтовний час відновлення[^|]*/i, '');
      infoSuffix = ' | ' + infoText.trim();
    }
    
    // Додаємо час оновлення (⟲ ...) у заголовок події
    let eventSummary = event.summary;
    let eventDescription = event.description;
    const updateTimeStr = outageData.updateTime ? '⟲ ' + outageData.updateTime : '';

    if (isCurrentEvent) {
      // Актуальна подія - тільки on/off, екстреність, час оновлення, інфо з модального (без часу відновлення)
      // Формуємо SUMMARY у чітко заданому порядку: алерт, подія, час, опис
      let warn = '';
      if (typeof urgentMark !== 'undefined' && urgentMark !== null && urgentMark !== '') {
        warn = urgentMark;
      } else if (isUrgent) {
        warn = '⚠️';
      }
      let onoff = event.isOutage ? '○ off' : '● on';
      let parts = [];
      if (warn) parts.push(warn);
      parts.push(onoff);
      if (updateTimeStr) parts.push(updateTimeStr);
      eventSummary = parts.join(' ');
      if (infoSuffix.trim()) {
        eventSummary += infoSuffix;
      }
      // `infoSuffix` already contains cleaned `outageData.infoBlockText` (from API)
      // and is appended above; do not append modal popup text here.
    } else {
      // Майбутня подія - використовуємо той самий порядок: алерт, подія, час, опис
      let warnF = '';
      if (typeof urgentMark !== 'undefined' && urgentMark !== null && urgentMark !== '') {
        warnF = urgentMark;
      } else if (isUrgent) {
        warnF = '⚠️';
      }
      let onoffF = event.isOutage ? '○ off' : '● on';
      let partsF = [];
      if (warnF) partsF.push(warnF);
      partsF.push(onoffF);
      if (updateTimeStr) partsF.push(updateTimeStr);
      eventSummary = partsF.join(' ');
      // Do NOT append modal/info window text to future events' SUMMARY
      // (modal info should appear only on the currently active event)
      eventDescription = event.description;
    }
    
    
    // Діагностика для SUMMARY/⚠️
    console.log('[DIAG]', address.filename, '{ isUrgent:', isUrgent, ', urgentMark:', urgentMark, ', eventSummary:', eventSummary, '}');
    cal.createEvent({
      start: event.start,
      end: event.end,
      summary: eventSummary,
      description: eventDescription,
      timezone: 'Europe/Kyiv',
      alarms: [{ type: 'display', trigger: 15 * 60 }]
    });
  });
  
  return { cal, outageCount: allEvents.length };
}

// Головна функція
(async () => {
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const browser = await chromium.launch({ headless: isCI, slowMo: 0 });
  const page = await browser.newPage();

  console.log('🚀 Запуск...');

  try {
    await page.goto('https://www.dtek-krem.com.ua/ua/shutdowns', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(5000);

    // Перевіряємо спливне вікно
    let isUkrEnergoAlert = false, modalAlertType = null;
    const alertText = await evaluateWithRetry(
      page,
      () => {
        const modal = document.querySelector('.modal, .popup, [role="dialog"], .alert, .notification');
        return modal ? modal.innerText : null;
      },
      undefined,
      { label: 'modal evaluate' }
    );
    
    if (alertText) {
      // Діагностичний вивід: показати повний текст попапу
      console.log('📢 Попап (повний):', alertText);
      console.log('📢 Попап (120):', alertText.substring(0, 120) + '...');
      if (alertText.toLowerCase().includes('укренерго')) isUkrEnergoAlert = true;
      // Визначаємо тип за ключовими фразами (нормалізуємо пробіли та переноси)
      const lowerText = alertText.toLowerCase().replace(/\s+/g, ' ');
      if (lowerText.includes('екстрені відключення') || lowerText.includes('екстренні відключення')) {
        modalAlertType = 'emergency';
      } else if (lowerText.includes('стабілізаційні відключення') || lowerText.includes('стабілізаційні графіки')) {
        modalAlertType = 'stabilization';
      } else if (lowerText.includes('аварійн')) {
        modalAlertType = 'accident';
      }
      console.log('   📋 Тип попапу:', modalAlertType || 'не визначено');
    }

    const modalInfo = { isUkrEnergoAlert, modalAlertType, modalText: alertText };
    const sessionData = await evaluateWithRetry(
      page,
      () => ({
        fact: typeof DisconSchedule !== 'undefined' ? DisconSchedule.fact : null,
      }),
      undefined,
      { label: 'session evaluate' }
    );
    console.log('✅ Сесія отримана\n');

    const generatedFiles = [];

    for (const address of addresses) {
      console.log('📍 ' + address.name + ' (' + address.city + ', ' + address.street + ', ' + address.house + ')');
      
      await page.waitForTimeout(1000);
      const outageData = await fetchAddressData(page, address, sessionData);
      
      console.log('   📋 Тип: ' + (outageData.infoBlockType || 'невідомо'));
      console.log('   📅 Графіків: ' + outageData.schedules.length);
      outageData.schedules.forEach((sched, idx) => {
        const date = new Date(sched.dayTimestamp * 1000);
        const hoursOff = sched.schedule.filter(s => s.status !== 'light').length;
        console.log('      ' + (idx + 1) + '. ' + date.toLocaleDateString('uk-UA') + ': ' + hoursOff + ' год без світла');
        console.log('         Слоти:', sched.schedule.map(s => `${s.hour}: ${s.status}`).join(', '));
      });

      // Визначаємо, чи потрібно ставити спеціальний знак для цієї адреси
      let urgentMark = null;
      const isEmergency = modalInfo.modalAlertType === 'emergency';
      // Максимально гнучка перевірка
      const lowerAlert = (alertText || '').toLowerCase();
      const hasEmergency = lowerAlert.includes('екстрен');
      const hasBoryspil = /бориспіль/i.test(lowerAlert);
      if (hasEmergency && hasBoryspil) {
        urgentMark = (address.filename === 'dtek.ics') ? '‼️' : '';
      } else if (hasEmergency) {
        urgentMark = null; // стандартна логіка (⚠️)
      }
      // Діагностичний вивід значення urgentMark
      console.log('   🛠️ urgentMark для', address.filename, ':', urgentMark);
      const { cal, outageCount } = generateCalendar(address, outageData, modalInfo, urgentMark);
      
      // Не записуємо порожній календар
      if (outageCount === 0) {
        console.log('   ⚠️ Порожній календар - пропускаємо запис ' + address.filename + '\n');
        continue;
      }
      
      fs.writeFileSync(address.filename, cal.toString());
      generatedFiles.push(address.filename);
      console.log('   ✅ ' + address.filename + ' (' + outageCount + ' відкл.)\n');
    }

    // Автоматичний коміт/пуш згенерованих файлів (запускається тільки коли
    // скрипт працює в CI або якщо встановлено змінну оточення AUTO_PUSH=true).
    // Коміт містить [skip ci], щоб уникнути циклів повторного тригеру workflow.
    const shouldAutoPush = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true' || process.env.AUTO_PUSH === 'true';
    if (shouldAutoPush) {
      try {
        if (generatedFiles.length === 0) {
          console.log('🧾 Немає згенерованих файлів для запису в git.');
        } else {
          console.log('🗂️  Підготовка до git commit/push для файлів:', generatedFiles.join(', '));
          try {
            execSync('git add ' + generatedFiles.join(' '), { stdio: 'inherit' });
          } catch (e) {
            console.log('   ⚠️ Помилка при git add (ігноруємо):', e.message);
          }

          let hasChanges = false;
          try {
            execSync('git diff --staged --quiet');
            hasChanges = false;
          } catch (e) {
            hasChanges = true;
          }

          if (hasChanges) {
            try {
              execSync('git config user.name "github-actions[bot]"');
              execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');
              execSync('git commit -m "chore(ci): update generated calendars [skip ci]"', { stdio: 'inherit' });

              if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
                const remoteUrl = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
                execSync(`git remote set-url origin "${remoteUrl}"`);
                execSync('git push origin HEAD:main', { stdio: 'inherit' });
              } else {
                execSync('git push', { stdio: 'inherit' });
              }
              console.log('✅ Зміни в календарях закомічені та запушені.');
            } catch (e) {
              console.error('❌ Помилка при commit/push:', e.message);
            }
          } else {
            console.log('🧘 Немає змін для коміту.');
          }
        }
      } catch (e) {
        console.error('❌ Непередбачена помилка при автопуші:', e.message);
      }
    } else {
      console.log('🧘 Автопуш вимкнено (щоб увімкнути, встановіть AUTO_PUSH=true або запускайте в CI).');
    }

    await browser.close();
  } catch (error) {
    console.error('❌ Помилка:', error.message);
    await browser.close();
  }
})();
