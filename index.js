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
  const { city, street, house } = address;
  
  const apiResponse = await page.evaluate(async (params) => {
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
  if (factData && factData.data && apiResponse.data) {
    const houseData = apiResponse.data[house] || Object.values(apiResponse.data)[0];
    const queueKey = houseData?.sub_type_reason?.[0];
    
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
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTimestamp = today.getTime();
  
  // Формуємо опис з інфовікна та попапу Укренерго
  let eventDesc = outageData.infoBlockText || 'Планове відключення за графіком.';
  if (alertText) {
    eventDesc = alertText.trim();
  }
  
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
  
  // Також додаємо графік черг для майбутніх відключень
  outageData.schedules.forEach(sched => {
    const date = new Date(sched.dayTimestamp * 1000);
    const year = date.getFullYear(), month = date.getMonth(), day = date.getDate();
    const eventDate = new Date(year, month, day); eventDate.setHours(0, 0, 0, 0);
    const isToday = eventDate.getTime() === todayTimestamp;
    
    const eventSummary = '🔴 ' + (isToday ? outageTypeName + ukrEnergoSuffix + updateTimeString : 'Стабілізаційне відключення' + updateTimeString);

    let startSlot = null;
    for (let i = 0; i < sched.schedule.length; i++) {
      const currentSlot = sched.schedule[i];
      const isOutage = currentSlot.status !== 'light';
      if (isOutage && startSlot === null) startSlot = currentSlot;
      else if (!isOutage && startSlot !== null) {
        const eventStart = new Date(year, month, day, startSlot.hour, 0);
        const eventEnd = new Date(year, month, day, currentSlot.hour, 0);
        
        // Якщо сьогодні і є currentOutage - пропускаємо події що перетинаються з поточним відключенням
        if (isToday && outageData.currentOutage) {
          const coStart = outageData.currentOutage.start.getTime();
          const coEnd = outageData.currentOutage.end.getTime();
          // Пропускаємо якщо перетинається
          if (!(eventEnd.getTime() <= coStart || eventStart.getTime() >= coEnd)) {
            startSlot = null;
            continue;
          }
        }
        
        allEvents.push({ start: eventStart, end: eventEnd, summary: eventSummary, description: eventDesc });
        startSlot = null;
      }
    }
    if (startSlot !== null) {
      const eventStart = new Date(year, month, day, startSlot.hour, 0);
      const eventEnd = new Date(year, month, day, 24, 0);
      
      // Перевіряємо перетин з currentOutage
      let skip = false;
      if (isToday && outageData.currentOutage) {
        const coStart = outageData.currentOutage.start.getTime();
        const coEnd = outageData.currentOutage.end.getTime();
        if (!(eventEnd.getTime() <= coStart || eventStart.getTime() >= coEnd)) {
          skip = true;
        }
      }
      if (!skip) {
        allEvents.push({ start: eventStart, end: eventEnd, summary: eventSummary, description: eventDesc });
      }
    }
  });

  allEvents.sort((a, b) => a.start - b.start);

  const powerOnEvents = [];
  for (let i = 0; i < allEvents.length - 1; i++) {
    if (allEvents[i + 1].start > allEvents[i].end) {
      const eventDate = new Date(allEvents[i].end); eventDate.setHours(0, 0, 0, 0);
      const isToday = eventDate.getTime() === todayTimestamp;
      powerOnEvents.push({
        start: allEvents[i].end, end: allEvents[i + 1].start,
        summary: '🟢 ' + (isToday ? 'Є струм' + ukrEnergoSuffix : 'Є струм') + updateTimeString,
        description: 'Електроенергія має бути в наявності.'
      });
    }
  }

  [...allEvents, ...powerOnEvents].forEach(event => cal.createEvent(event));
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
