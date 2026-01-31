const { chromium } = require('playwright');
const ical = require('ical-generator').default;
const fs = require('fs');
const { execSync } = require('child_process');

const STATE_FILE = 'last_run_state.json';

function getPreviousState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('⚠️ Помилка читання файлу стану:', e.message);
  }
  return {};
}

function saveCurrentState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let config;
try {
  const configData = fs.readFileSync('config.json', 'utf8');
  config = JSON.parse(configData);
} catch (error) {
  console.error('❌ Помилка при читанні config.json:', error.message);
  config = {
    addresses: [{
      id: 'default', name: 'Адреса', city: 'с. Гора', street: 'вул. Мостова', house: '21', filename: 'dtek.ics'
    }]
  };
}

const addresses = config.addresses || [{
  id: 'default', name: 'Адреса', ...config.address, filename: 'dtek.ics'
}];

console.log('📋 Знайдено ' + addresses.length + ' адрес(и):');
addresses.forEach((addr, i) => {
  console.log('   ' + (i + 1) + '. ' + addr.name + ': ' + addr.city + ', ' + addr.street + ', ' + addr.house + ' → ' + addr.filename);
});
console.log('');

async function fetchAddressData(page, address, sessionData) {
  const { city, street, house, queue: configQueue, forceQueue } = address;
  
  let apiResponse;
  let htmlQueue = null; // Черга з HTML (div#group-name)
  
  try {
    // Виконуємо API запит
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
      
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        return { error: text.substring(0, 100) };
      }
    }, { city, street, house });
    
    // Парсимо чергу з HTML (div#group-name містить "Черга X.X")
    // Чекаємо трохи, щоб DOM оновився після API виклику
    await page.waitForTimeout(500);
    htmlQueue = await page.evaluate(() => {
      const groupNameEl = document.querySelector('#group-name span, #group-name');
      if (groupNameEl) {
        const text = groupNameEl.textContent || '';
        // Черга 5.1 -> GPV5.1
        const match = text.match(/[Чч]ерга\s*(\d+\.?\d*)/);
        if (match) {
          return 'GPV' + match[1];
        }
      }
      return null;
    });
    
    if (htmlQueue) {
      console.log('   🔍 Черга з HTML: ' + htmlQueue);
    }
    
  } catch (error) {
    console.log('   ❌ Помилка запиту:', error.message);
    return { currentOutage: null, schedules: [], infoBlockText: null, infoBlockType: null, updateTime: null };
  }
  
  if (apiResponse.error) {
    console.log('   ❌ Помилка API:', apiResponse.error);
    return { currentOutage: null, schedules: [], infoBlockText: null, infoBlockType: null, updateTime: null };
  }
  
  let outageData = { currentOutage: null, schedules: [], infoBlockText: null, infoBlockType: null, updateTime: null };
  
  if (apiResponse.updateTimestamp) {
    const match = apiResponse.updateTimestamp.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (match) {
      outageData.updateTime = { hour: parseInt(match[1]), minute: parseInt(match[2]), day: parseInt(match[3]), month: parseInt(match[4]), year: parseInt(match[5]) };
    }
  }
  
  if (apiResponse.data) {
    const houseData = apiResponse.data[house] || Object.values(apiResponse.data)[0];
    if (houseData && houseData.sub_type) {
      const subTypeLower = houseData.sub_type.toLowerCase();
      if (subTypeLower.includes('екстрен')) outageData.infoBlockType = 'emergency';
      else if (subTypeLower.includes('аварійн')) outageData.infoBlockType = 'accident';
      else if (subTypeLower.includes('стабілізац') || subTypeLower.includes('планов')) outageData.infoBlockType = 'stabilization';
      outageData.infoBlockText = houseData.sub_type;
      
      // Парсимо реальний час відключення з start_date/end_date
      if (houseData.start_date && houseData.end_date) {
        const parseDateTime = (str) => {
          const match = str.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/);
          if (match) {
            return new Date(parseInt(match[5]), parseInt(match[4]) - 1, parseInt(match[3]), parseInt(match[1]), parseInt(match[2]));
          }
          return null;
        };
        const startTime = parseDateTime(houseData.start_date);
        const endTime = parseDateTime(houseData.end_date);
        if (startTime && endTime) {
          outageData.currentOutage = { start: startTime, end: endTime };
        }
      }
    }
  }
  
  // Також парсимо графік черг для майбутніх днів
  const factData = apiResponse.fact || sessionData.fact;
  if (factData && factData.data) {
    // Пріоритет черги: forceQueue з конфігу → API (sub_type_reason) → HTML (div#group-name) → config.json
    let queueKey = null;
    let queueSource = null;
    
    // Якщо forceQueue - використовуємо тільки з конфігу
    if (forceQueue && configQueue) {
      queueKey = configQueue;
      queueSource = 'config (forced)';
    } else {
      if (apiResponse.data) {
        const houseData = apiResponse.data[house] || Object.values(apiResponse.data)[0];
        queueKey = houseData?.sub_type_reason?.[0];
        if (queueKey) queueSource = 'API';
      }
      // Fallback на чергу з HTML
      if (!queueKey && htmlQueue) {
        queueKey = htmlQueue;
        queueSource = 'HTML';
      }
      // Fallback на чергу з конфігу
      if (!queueKey && configQueue) {
        queueKey = configQueue;
        queueSource = 'config';
      }
    }
    
    if (queueKey) {
      console.log('   ⚡ Використовую чергу: ' + queueKey + ' (джерело: ' + queueSource + ')');
    }
    
    if (queueKey && factData.data) {
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

function generateCalendar(address, outageData, modalInfo) {
  const { isUkrEnergoAlert, modalAlertType, alertText } = modalInfo;
  const cal = ical({ name: '⚡️' + address.name, timezone: 'Europe/Kyiv' });

  let updateTimeString = '';
  if (outageData.updateTime) {
    const { hour, minute } = outageData.updateTime;
    updateTimeString = ' ⟲ ' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
  }

  let outageTypeName = 'Стабілізаційне відключення';
  const effectiveOutageType = modalAlertType || outageData.infoBlockType;
  if (effectiveOutageType === 'emergency') outageTypeName = 'Екстрене відключення';
  else if (effectiveOutageType === 'accident') outageTypeName = 'Аварійне відключення';
  
  let ukrEnergoSuffix = '';
  if (isUkrEnergoAlert) {
    ukrEnergoSuffix = ' (Укренерго: ' + (modalAlertType === 'emergency' ? 'екстрені' : 'стабілізаційні') + ' відключення)';
  }
  
  const allEvents = [];
  const now = new Date();
  
  // Визначаємо "сьогодні" в Київському часі (важливо для GitHub Actions який працює в UTC)
  const kyivNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  const today = new Date(kyivNow.getFullYear(), kyivNow.getMonth(), kyivNow.getDate());
  const todayTimestamp = today.getTime();
  
  // Формуємо опис з інфовікна та попапу Укренерго
  let eventDesc = outageData.infoBlockText || 'Планове відключення за графіком.';
  if (alertText) {
    eventDesc = alertText.trim();
  }
  
  // Функція для визначення чи подія є поточною (зараз в цьому проміжку)
  const isCurrentEvent = (start, end) => now >= start && now < end;
  
  // Якщо є поточне відключення з точним часом - використовуємо його
  if (outageData.currentOutage) {
    const { start, end } = outageData.currentOutage;
    allEvents.push({
      start: start,
      end: end,
      summary: '🔴 ' + outageTypeName + ukrEnergoSuffix + updateTimeString,
      description: eventDesc
    });
  }
  
  // Також додаємо графік черг для майбутніх відключень (завжди стабілізаційні)
  // Функція для додавання події з урахуванням перетину з currentOutage
  const addScheduleEvent = (eventStart, eventEnd, isToday) => {
    if (isToday && outageData.currentOutage) {
      const coStart = outageData.currentOutage.start.getTime();
      const coEnd = outageData.currentOutage.end.getTime();
      const evStart = eventStart.getTime();
      const evEnd = eventEnd.getTime();
      
      // Якщо повністю всередині currentOutage - пропускаємо
      if (evStart >= coStart && evEnd <= coEnd) {
        return;
      }
      
      // Якщо не перетинається - додаємо як є
      if (evEnd <= coStart || evStart >= coEnd) {
        const isCurrent = isCurrentEvent(eventStart, eventEnd);
        const eventSummary = (isCurrent && isUkrEnergoAlert)
          ? '🔴 ' + outageTypeName + ukrEnergoSuffix + updateTimeString
          : '🔴 Стабілізаційне відключення' + updateTimeString;
        allEvents.push({ start: eventStart, end: eventEnd, summary: eventSummary, description: eventDesc });
        return;
      }
      
      // Якщо перетинається частково - вирізаємо currentOutage
      // Частина ДО currentOutage
      if (evStart < coStart) {
        const partEnd = new Date(coStart);
        const isCurrent = isCurrentEvent(eventStart, partEnd);
        const eventSummary = (isCurrent && isUkrEnergoAlert)
          ? '🔴 ' + outageTypeName + ukrEnergoSuffix + updateTimeString
          : '🔴 Стабілізаційне відключення' + updateTimeString;
        allEvents.push({ start: eventStart, end: partEnd, summary: eventSummary, description: eventDesc });
      }
      // Частина ПІСЛЯ currentOutage
      if (evEnd > coEnd) {
        const partStart = new Date(coEnd);
        const isCurrent = isCurrentEvent(partStart, eventEnd);
        const eventSummary = (isCurrent && isUkrEnergoAlert)
          ? '🔴 ' + outageTypeName + ukrEnergoSuffix + updateTimeString
          : '🔴 Стабілізаційне відключення' + updateTimeString;
        allEvents.push({ start: partStart, end: eventEnd, summary: eventSummary, description: eventDesc });
      }
    } else {
      // Не сьогодні або немає currentOutage - просто додаємо
      const isCurrent = isCurrentEvent(eventStart, eventEnd);
      const eventSummary = (isCurrent && isUkrEnergoAlert)
        ? '🔴 ' + outageTypeName + ukrEnergoSuffix + updateTimeString
        : '🔴 Стабілізаційне відключення' + updateTimeString;
      allEvents.push({ start: eventStart, end: eventEnd, summary: eventSummary, description: eventDesc });
    }
  };
  
  outageData.schedules.forEach(sched => {
    // Timestamp з API - це початок дня в Київському часі
    // Конвертуємо правильно для створення подій
    const utcDate = new Date(sched.dayTimestamp * 1000);
    const kyivDateStr = utcDate.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' });
    const kyivDate = new Date(kyivDateStr);
    const year = kyivDate.getFullYear(), month = kyivDate.getMonth(), day = kyivDate.getDate();
    const eventDate = new Date(year, month, day); eventDate.setHours(0, 0, 0, 0);
    const isToday = eventDate.getTime() === todayTimestamp;

    // Перетворюємо графік на масив відрізків без світла
    // DTEK логіка: ключ години N означає проміжок (N-1):00 - N:00
    // "first" = перші 30 хв проміжку: (N-1):00 - (N-1):30
    // "second" = другі 30 хв проміжку: (N-1):30 - N:00
    const outageSegments = [];
    for (const slot of sched.schedule) {
      const hour = slot.hour; // ключ з API = кінець проміжку
      if (slot.status === 'no-light') {
        // Вся година без світла: (hour-1):00 - hour:00
        outageSegments.push({ start: (hour - 1) * 60, end: hour * 60 });
      } else if (slot.status === 'no-light-first-half') {
        // "first" = перші 30 хв проміжку: (hour-1):00 - (hour-1):30
        outageSegments.push({ start: (hour - 1) * 60, end: (hour - 1) * 60 + 30 });
      } else if (slot.status === 'no-light-second-half') {
        // "second" = другі 30 хв проміжку: (hour-1):30 - hour:00
        outageSegments.push({ start: (hour - 1) * 60 + 30, end: hour * 60 });
      }
    }
    
    // Об'єднуємо сусідні відрізки
    const mergedSegments = [];
    for (const seg of outageSegments.sort((a, b) => a.start - b.start)) {
      if (mergedSegments.length === 0) {
        mergedSegments.push({ ...seg });
      } else {
        const last = mergedSegments[mergedSegments.length - 1];
        if (seg.start <= last.end) {
          last.end = Math.max(last.end, seg.end);
        } else {
          mergedSegments.push({ ...seg });
        }
      }
    }
    
    // Створюємо події для кожного відрізка
    for (const seg of mergedSegments) {
      const startHour = Math.floor(seg.start / 60);
      const startMin = seg.start % 60;
      const endHour = Math.floor(seg.end / 60);
      const endMin = seg.end % 60;
      
      const eventStart = new Date(year, month, day, startHour, startMin);
      const eventEnd = new Date(year, month, day, endHour, endMin);
      addScheduleEvent(eventStart, eventEnd, isToday);
    }
  });

  allEvents.sort((a, b) => a.start - b.start);

  const powerOnEvents = [];
  for (let i = 0; i < allEvents.length - 1; i++) {
    if (allEvents[i + 1].start > allEvents[i].end) {
      const powerStart = allEvents[i].end;
      const powerEnd = allEvents[i + 1].start;
      // Статус екстрених показуємо тільки для ПОТОЧНОГО проміжку часу
      const isCurrent = isCurrentEvent(powerStart, powerEnd);
      const powerSummary = (isCurrent && isUkrEnergoAlert)
        ? '🟢 Є струм (діють екстрені відключення)' + updateTimeString
        : '🟢 Є струм' + updateTimeString;
      powerOnEvents.push({
        start: powerStart, end: powerEnd,
        summary: powerSummary,
        description: 'Електроенергія має бути в наявності.'
      });
    }
  }

  [...allEvents, ...powerOnEvents].forEach(event => cal.createEvent({ ...event, timezone: 'Europe/Kyiv' }));
  return { cal, outageCount: allEvents.length, powerOnCount: powerOnEvents.length };
}

(async () => {
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const browser = await chromium.launch({ headless: isCI, slowMo: 0 });
  const page = await browser.newPage();

  console.log('🚀 Запуск... Відкриваємо сайт ДТЕК');

  try {
    await page.goto('https://www.dtek-krem.com.ua/ua/shutdowns', { waitUntil: 'networkidle', timeout: 60000 });
    console.log('⏳ Отримуємо дані сесії...');
    await page.waitForTimeout(1500);

    let isUkrEnergoAlert = false, modalAlertType = null;
    const alertText = await page.evaluate(() => {
      const modal = document.querySelector('.modal, .popup, [role="dialog"], .alert, .notification');
      return modal ? modal.innerText : null;
    });
    
    if (alertText) {
      console.log('📢 Спливне вікно:', alertText.substring(0, 80) + '...');
      if (alertText.toLowerCase().includes('укренерго')) isUkrEnergoAlert = true;
      if (alertText.toLowerCase().includes('стабілізац')) modalAlertType = 'stabilization';
      else if (alertText.toLowerCase().includes('екстрен')) modalAlertType = 'emergency';
    }

    const modalInfo = { isUkrEnergoAlert, modalAlertType, alertText };
    const sessionData = await page.evaluate(() => ({
      fact: typeof DisconSchedule !== 'undefined' ? DisconSchedule.fact : null,
    }));
    console.log('✅ Сесія отримана\n');

    const previousState = getPreviousState();
    const newState = {};
    const generatedFiles = [];

    for (const address of addresses) {
      console.log('\n📍 Обробляємо: ' + address.name + ' (' + address.city + ', ' + address.street + ', ' + address.house + ')');
      
      // Затримка між адресами щоб уникнути rate limiting
      await page.waitForTimeout(2000);
      
      const outageData = await fetchAddressData(page, address, sessionData);
      
      console.log('   📋 Тип: ' + (outageData.infoBlockType || 'невідомо'));
      console.log('   📅 Графіків: ' + outageData.schedules.length);
      outageData.schedules.forEach((sched, idx) => {
        const date = new Date(sched.dayTimestamp * 1000);
        const hoursWithoutLight = sched.schedule.filter(s => s.status !== 'light').length;
        console.log('      ' + (idx + 1) + '. ' + date.toLocaleDateString('uk-UA') + ': ' + hoursWithoutLight + ' год без світла');
      });

      const addrPrevState = previousState[address.id] || {};
      let showAlert = false, alertSummary = '', alertDescription = '';
      const currentInfoBlockType = outageData.infoBlockType;
      const currentModalAlert = isUkrEnergoAlert ? 'ukrenegro_' + (modalAlertType || 'unknown') : modalAlertType;
      
      if (currentModalAlert !== addrPrevState.lastModalAlert || currentInfoBlockType !== addrPrevState.lastInfoBlock) {
        showAlert = true;
        const effectiveType = modalAlertType || currentInfoBlockType;
        if (effectiveType === 'emergency') alertSummary = isUkrEnergoAlert ? '📢 Діють екстрені відключення (Укренерго)' : '📢 Діють екстрені відключення';
        else if (effectiveType === 'stabilization') alertSummary = isUkrEnergoAlert ? '📢 Діють стабілізаційні відключення (Укренерго)' : '📢 Діють стабілізаційні відключення';
        else if (effectiveType === 'accident') alertSummary = '📢 Діють аварійні відключення';
        else alertSummary = '📢 Змінився статус відключень';
        alertDescription = outageData.infoBlockText || 'Інформація оновлена.';
        console.log('   📢 Алерт: ' + alertSummary);
      }

      if (!showAlert) {
        const currentDays = outageData.schedules.map(s => s.dayTimestamp);
        const prevDays = addrPrevState.lastScheduledDays || [];
        const newDays = currentDays.filter(d => !prevDays.includes(d));
        if (newDays.length > 0) {
          showAlert = true;
          const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 0, 0, 0);
          const isTomorrow = newDays.some(ts => { const d = new Date(ts * 1000); d.setHours(0, 0, 0, 0); return d.getTime() === tomorrow.getTime(); });
          alertSummary = isTomorrow ? "📢 З'явився графік на завтра" : "📢 З'явився новий графік";
          alertDescription = 'Додано розклад на нові дати.';
          console.log('   📢 Алерт: ' + alertSummary);
        }
      }

      newState[address.id] = { lastInfoBlock: currentInfoBlockType, lastScheduledDays: outageData.schedules.map(s => s.dayTimestamp), lastModalAlert: currentModalAlert };

      const { cal, outageCount, powerOnCount } = generateCalendar(address, outageData, modalInfo);
      if (showAlert) {
        cal.createEvent({ start: new Date(), end: new Date(Date.now() + 5 * 60000), summary: alertSummary, description: alertDescription, alarms: [{ type: 'display', trigger: 1 }] });
      }
      
      fs.writeFileSync(address.filename, cal.toString());
      generatedFiles.push(address.filename);
      console.log('   ✅ Збережено: ' + address.filename + ' (' + outageCount + ' відкл., ' + powerOnCount + ' світла)');
    }

    saveCurrentState(newState);

    try {
      const filesToCheck = [...generatedFiles, 'last_run_state.json'].join(' ');
      const gitStatus = execSync('git status --porcelain ' + filesToCheck).toString().trim();
      if (gitStatus) {
        console.log('\n🔄 Оновлюємо репозиторій...');
        execSync('git config user.name "GitHub Actions Bot"');
        execSync('git config user.email "actions@github.com"');
        execSync('git add ' + filesToCheck);
        execSync('git commit -m "📅 Оновлено календарі відключень"');
        execSync('git pull --rebase origin main');
        execSync('git push');
        console.log('✅ Репозиторій оновлено!');
      } else {
        console.log('\n🧘 Змін немає');
      }
    } catch (error) {
      console.error('❌ Git помилка:', error.message);
    }

    await browser.close();
    console.log('\n🎉 Готово!');
  } catch (error) {
    console.error('❌ Помилка:', error.message);
    await browser.close();
  }
})();
