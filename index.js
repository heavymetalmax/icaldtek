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
      if (subType.includes('екстрен')) outageData.infoBlockType = 'emergency';
      else if (subType.includes('аварійн')) outageData.infoBlockType = 'accident';
      else outageData.infoBlockType = 'stabilization';
    }
  }
  
  // Графік
  const factData = apiResponse.fact || freshSessionData.fact;
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
function generateCalendar(address, outageData, modalInfo) {
  const cal = ical({ name: '⚡️' + address.name, timezone: 'Europe/Kyiv' });
  
  const updateTimeStr = outageData.updateTime ? ' ⟲ ' + outageData.updateTime : '';
  
  // Визначаємо тип відключення з емодзі
  let outageReason = 'Стабілізаційне відключення';
  let outageEmoji = '🔴';
  const effectiveType = modalInfo.modalAlertType || outageData.infoBlockType;
  if (effectiveType === 'emergency') {
    outageReason = 'Екстренне відключення';
    outageEmoji = '⚠️';
  } else if (effectiveType === 'accident') {
    outageReason = 'Аварійне відключення';
    outageEmoji = '‼️';
  }
  
  // Чи діють екстрені відключення
  const isEmergency = effectiveType === 'emergency';
  
  // Опис події з інфо-блоку (для актуальних подій)
  const infoBlockDescription = outageData.infoBlockText;
  const defaultDescription = 'Електроенергія має бути в наявності.';
  const defaultOutageDescription = outageReason + ' за графіком.';
  
  const allEvents = [];
  
  // Обробляємо графік
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
    
    // Створюємо події
    for (const seg of merged) {
      const startH = Math.floor(seg.start / 60), startM = seg.start % 60;
      const endH = Math.floor(seg.end / 60), endM = seg.end % 60;
      
      allEvents.push({
        start: new Date(year, month, day, startH, startM),
        end: new Date(year, month, day, endH, endM),
        summary: outageEmoji + ' Немає струму (' + outageReason + ')' + updateTimeStr,
        description: defaultOutageDescription,
        isOutage: true
      });
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
      // Якщо події перетинаються або стикаються
      if (event.start <= last.end) {
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
  
  // Коригуємо час відключення згідно start_date/end_date з API (якщо є)
  let wasAdjusted = false;
  let adjustedEndTime = null;
  if (outageData.currentOutage?.startDate && outageData.currentOutage?.endDate && allEvents.length > 0) {
    // Парсимо start_date і end_date формату "16:30 01.02.2026"
    const parseDateTime = (str) => {
      const match = str.match(/(\d{1,2}):(\d{2})\s+(\d{2})\.(\d{2})\.(\d{4})/);
      if (match) {
        const [, hours, minutes, day, month, year] = match;
        return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hours), parseInt(minutes));
      }
      return null;
    };
    
    const apiStartTime = parseDateTime(outageData.currentOutage.startDate);
    const apiEndTime = parseDateTime(outageData.currentOutage.endDate);
    
    if (apiStartTime && apiEndTime) {
      // Шукаємо подію, яка перетинається з часовим проміжком з API
      for (const event of allEvents) {
        // Подія перетинається якщо: event.start < apiEndTime AND event.end > apiStartTime
        const overlaps = event.start < apiEndTime && event.end > apiStartTime;
        if (overlaps && apiEndTime > event.end) {
          console.log('   📝 Коригуємо час: ' + event.end.toLocaleTimeString('uk-UA', {hour: '2-digit', minute: '2-digit'}) + ' → ' + apiEndTime.toLocaleTimeString('uk-UA', {hour: '2-digit', minute: '2-digit'}));
          event.end = apiEndTime;
          event.wasAdjusted = true; // Позначаємо подію як скориговану
          wasAdjusted = true;
          adjustedEndTime = apiEndTime;
          break; // Коригуємо лише першу відповідну подію
        }
      }
    }
  }
  
  // Додаємо періоди зі світлом
  const powerOnEvents = [];
  
  // Групуємо події по днях
  const eventsByDay = {};
  allEvents.forEach(event => {
    const dayKey = event.start.toDateString();
    if (!eventsByDay[dayKey]) eventsByDay[dayKey] = [];
    eventsByDay[dayKey].push(event);
  });
  
  // Для кожного дня додаємо періоди зі світлом
  Object.values(eventsByDay).forEach(dayEvents => {
    // Між відключеннями
    for (let i = 0; i < dayEvents.length - 1; i++) {
      if (dayEvents[i + 1].start > dayEvents[i].end) {
        const emoji = isEmergency ? '📢' : '🟢';
        const emergencyWarning = isEmergency ? ' (Увага, діють екстрені відключення!)' : '';
        powerOnEvents.push({
          start: dayEvents[i].end,
          end: dayEvents[i + 1].start,
          summary: emoji + ' Є струм' + emergencyWarning + updateTimeStr,
          description: defaultDescription,
          isOutage: false
        });
      }
    }
    
    // Після останнього відключення дня до 00:00 наступного дня
    const lastEvent = dayEvents[dayEvents.length - 1];
    const endOfDay = new Date(lastEvent.end.getFullYear(), lastEvent.end.getMonth(), lastEvent.end.getDate() + 1, 0, 0);
    
    // Не створюємо "Є струм" якщо це кінець відключення що перейшло з попереднього дня
    // і в цей день немає власних подій (лише продовження)
    const dayHasOwnStart = dayEvents.some(e => {
      const eventDay = e.start.toDateString();
      return eventDay === lastEvent.end.toDateString();
    });
    
    if (lastEvent.end < endOfDay && dayHasOwnStart) {
      const emoji = isEmergency ? '📢' : '🟢';
      const emergencyWarning = isEmergency ? ' (Увага, діють екстрені відключення!)' : '';
      powerOnEvents.push({
        start: lastEvent.end,
        end: endOfDay,
        summary: emoji + ' Є струм' + emergencyWarning + updateTimeStr,
        description: defaultDescription,
        isOutage: false
      });
    }
    
    // Перед першим відключенням дня від 00:00
    const firstEvent = dayEvents[0];
    const startOfDay = new Date(firstEvent.start.getFullYear(), firstEvent.start.getMonth(), firstEvent.start.getDate(), 0, 0);
    if (firstEvent.start > startOfDay) {
      const emoji = isEmergency ? '📢' : '🟢';
      const emergencyWarning = isEmergency ? ' (Увага, діють екстрені відключення!)' : '';
      powerOnEvents.push({
        start: startOfDay,
        end: firstEvent.start,
        summary: emoji + ' Є струм' + emergencyWarning + updateTimeStr,
        description: defaultDescription,
        isOutage: false
      });
    }
  });
  
  // Додаємо всі події в календар з нагадуванням за 30 хв
  // Використовуємо київський час для порівняння
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  [...allEvents, ...powerOnEvents].forEach(event => {
    // Пропускаємо минулі події (не додаємо в календар)
    if (event.end <= now) {
      return;
    }
    
    // Визначаємо чи подія актуальна (зараз активна) чи майбутня
    const isCurrentEvent = event.start <= now && event.end > now;
    const isFutureEvent = event.start > now;
    
    // Для актуальних подій - повний формат з деталями
    // Для майбутніх - простий формат без деталей
    let eventSummary;
    let eventDescription;
    
    if (isCurrentEvent) {
      // Актуальна подія - повний формат
      eventSummary = event.wasAdjusted ? event.summary + ' (скориговано)' : event.summary;
      eventDescription = infoBlockDescription || event.description;
    } else {
      // Майбутня подія - простий формат
      if (event.isOutage) {
        eventSummary = '🔴 Немає струму' + updateTimeStr;
      } else {
        eventSummary = '🟢 Є струм' + updateTimeStr;
      }
      eventDescription = event.description;
    }
    
    cal.createEvent({
      start: event.start,
      end: event.end,
      summary: eventSummary,
      description: eventDescription,
      timezone: 'Europe/Kyiv',
      alarms: [{ type: 'display', trigger: 30 * 60 }]
    });
  });
  
  return { cal, outageCount: allEvents.length, powerOnCount: powerOnEvents.length };
}

// Головна функція
(async () => {
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const browser = await chromium.launch({ headless: isCI, slowMo: 0 });
  const page = await browser.newPage();

  console.log('🚀 Запуск...');

  try {
    await page.goto('https://www.dtek-krem.com.ua/ua/shutdowns', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1500);

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
      console.log('📢 Попап:', alertText.substring(0, 60) + '...');
      if (alertText.toLowerCase().includes('укренерго')) isUkrEnergoAlert = true;
      if (alertText.toLowerCase().includes('екстрен')) modalAlertType = 'emergency';
      else if (alertText.toLowerCase().includes('стабілізац')) modalAlertType = 'stabilization';
    }

    const modalInfo = { isUkrEnergoAlert, modalAlertType };
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
      });

      const { cal, outageCount, powerOnCount } = generateCalendar(address, outageData, modalInfo);
      
      // Не записуємо порожній календар
      if (outageCount === 0 && powerOnCount === 0) {
        console.log('   ⚠️ Порожній календар - пропускаємо запис ' + address.filename + '\n');
        continue;
      }
      
      fs.writeFileSync(address.filename, cal.toString());
      generatedFiles.push(address.filename);
      console.log('   ✅ ' + address.filename + ' (' + outageCount + ' відкл., ' + powerOnCount + ' світла)\n');
    }

    // Git push
    try {
      const gitStatus = execSync('git status --porcelain ' + generatedFiles.join(' ')).toString().trim();
      if (gitStatus) {
        console.log('🔄 Оновлюємо репозиторій...');
        execSync('git config user.name "GitHub Actions Bot"');
        execSync('git config user.email "actions@github.com"');
        execSync('git add ' + generatedFiles.join(' '));
        execSync('git commit -m "📅 Оновлено календарі"');
        execSync('git pull --rebase origin main');
        execSync('git push');
        console.log('✅ Готово!');
      } else {
        console.log('🧘 Без змін');
      }
    } catch (error) {
      console.error('❌ Git:', error.message);
    }

    await browser.close();
  } catch (error) {
    console.error('❌ Помилка:', error.message);
    await browser.close();
  }
})();
