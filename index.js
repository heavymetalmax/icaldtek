const { chromium } = require('playwright');
const ical = require('ical-generator').default;
const fs = require('fs');
const { execSync } = require('child_process');

const STATE_FILE = 'last_run_state.json';

// Функція для читання стану попереднього запуску
function getPreviousState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('⚠️ Помилка читання файлу стану:', e.message);
  }
  return { lastInfoBlock: null, lastScheduledDays: [], lastModalAlert: null };
}

// Функція для збереження поточного стану
function saveCurrentState(infoBlock, scheduledDays, modalAlert) {
  const state = {
    lastInfoBlock: infoBlock,
    lastScheduledDays: scheduledDays,
    lastModalAlert: modalAlert,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Читаємо конфігурацію
let config;
try {
  const configData = fs.readFileSync('config.json', 'utf8');
  config = JSON.parse(configData);
} catch (error) {
  console.error('❌ Помилка при читанні config.json:', error.message);
  config = {
    address: { city: 'с. Гора', street: 'вул. Мостова', house: '21' }
  };
}

const { city, street, house } = config.address;

console.log('📋 Використовується адреса:');
console.log(`   Населений пункт: ${city}`);
console.log(`   Вулиця: ${street}`);
console.log(`   Будинок: ${house}\n`);

(async () => {
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const browser = await chromium.launch({ 
    headless: isCI ? true : false, 
    slowMo: 0 
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  console.log('🚀 Запуск... Відкриваємо сайт ДТЕК');

  try {
    // --- 1. ЗАВАНТАЖУЄМО СТОРІНКУ ТА ОТРИМУЄМО СЕСІЮ ---
    await page.goto('https://www.dtek-krem.com.ua/ua/shutdowns', { 
      waitUntil: 'networkidle',
      timeout: 60000 
    });
    
    console.log('⏳ Отримуємо дані сесії...');
    await page.waitForTimeout(1500);

    // Читаємо текст зі спливного вікна
    let isUkrEnergoAlert = false;
    let modalAlertType = null;
    const alertText = await page.evaluate(() => {
      const modal = document.querySelector('.modal, .popup, [role="dialog"], .alert, .notification');
      return modal ? modal.innerText : null;
    });
    
    if (alertText) {
      console.log('📢 Спливне вікно:', alertText.substring(0, 80) + '...');
      if (alertText.toLowerCase().includes('укренерго')) {
        isUkrEnergoAlert = true;
      }
      if (alertText.toLowerCase().includes('стабілізац')) {
        modalAlertType = 'stabilization';
      } else if (alertText.toLowerCase().includes('екстрен')) {
        modalAlertType = 'emergency';
      }
    }

    // Отримуємо CSRF токен та початкові дані
    const sessionData = await page.evaluate(() => {
      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      return {
        csrfToken: csrfMeta ? csrfMeta.content : null,
        ajaxUrl: '/ua/ajax',
        streets: typeof DisconSchedule !== 'undefined' ? DisconSchedule.streets : null,
        preset: typeof DisconSchedule !== 'undefined' ? DisconSchedule.preset : null,
        fact: typeof DisconSchedule !== 'undefined' ? DisconSchedule.fact : null,
        updateTimestamp: typeof DisconSchedule !== 'undefined' ? DisconSchedule.updateTimestamp : null,
        showCurOutage: typeof DisconSchedule !== 'undefined' ? DisconSchedule.showCurOutage : null,
      };
    });
    
    console.log('✅ Сесія отримана, CSRF токен:', sessionData.csrfToken?.substring(0, 20) + '...');

    // --- 2. РОБИМО API ЗАПИТ ДЛЯ ОТРИМАННЯ ДАНИХ ПО АДРЕСІ ---
    console.log(`📍 Запитуємо дані для адреси: ${city}, ${street}, ${house}`);
    
    // Виконуємо API запит через page.evaluate (щоб використати cookies та CSRF)
    const apiResponse = await page.evaluate(async (params) => {
      // Формуємо дані для POST запиту
      const formData = new URLSearchParams();
      formData.append('method', 'getHomeNum');
      formData.append('data[0][name]', 'city');
      formData.append('data[0][value]', params.city);
      formData.append('data[1][name]', 'street');
      formData.append('data[1][value]', params.street);
      formData.append('data[2][name]', 'house_num');
      formData.append('data[2][value]', params.house);
      
      // Додаємо CSRF токен
      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      const csrfParam = document.querySelector('meta[name="csrf-param"]');
      if (csrfMeta && csrfParam) {
        formData.append(csrfParam.content, csrfMeta.content);
      }
      
      const response = await fetch('/ua/ajax', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: formData.toString()
      });
      return response.json();
    }, { city, street, house });
    
    console.log('✅ API відповідь отримана');
    
    // --- 3. ОБРОБЛЯЄМО ВІДПОВІДЬ API ---
    let outageData = {
      currentOutage: null,
      schedules: [],
      infoBlockText: null,
      infoBlockType: null,
      updateTime: null
    };
    
    // Парсимо час оновлення
    if (apiResponse.updateTimestamp) {
      const match = apiResponse.updateTimestamp.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (match) {
        outageData.updateTime = {
          hour: parseInt(match[1]),
          minute: parseInt(match[2]),
          day: parseInt(match[3]),
          month: parseInt(match[4]),
          year: parseInt(match[5])
        };
      }
    }
    
    // Отримуємо дані про поточне відключення з відповіді
    if (apiResponse.data) {
      const houseData = apiResponse.data[house] || Object.values(apiResponse.data)[0];
      if (houseData) {
        // Визначаємо тип відключення
        if (houseData.sub_type) {
          const subTypeLower = houseData.sub_type.toLowerCase();
          if (subTypeLower.includes('екстрен')) {
            outageData.infoBlockType = 'emergency';
          } else if (subTypeLower.includes('аварійн')) {
            outageData.infoBlockType = 'accident';
          } else if (subTypeLower.includes('стабілізац') || subTypeLower.includes('планов')) {
            outageData.infoBlockType = 'stabilization';
          }
          outageData.infoBlockText = houseData.sub_type;
        }
        
        // Парсимо час відключення
        if (houseData.start_date && houseData.end_date) {
          const startMatch = houseData.start_date.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/);
          const endMatch = houseData.end_date.match(/(\d{1,2}):(\d{2})(?:\s+(\d{1,2})\.(\d{1,2})\.(\d{4}))?/);
          
          if (startMatch && endMatch) {
            outageData.currentOutage = {
              startHour: parseInt(startMatch[1]),
              startMinute: parseInt(startMatch[2]),
              startDay: parseInt(startMatch[3]),
              startMonth: parseInt(startMatch[4]),
              startYear: parseInt(startMatch[5]),
              endHour: parseInt(endMatch[1]),
              endMinute: parseInt(endMatch[2]),
              endDay: endMatch[3] ? parseInt(endMatch[3]) : parseInt(startMatch[3]),
              endMonth: endMatch[4] ? parseInt(endMatch[4]) : parseInt(startMatch[4]),
              endYear: endMatch[5] ? parseInt(endMatch[5]) : parseInt(startMatch[5]),
              reason: houseData.sub_type || ''
            };
          }
        }
      }
    }
    
    // Обробляємо графіки з fact/preset
    const factData = apiResponse.fact || sessionData.fact;
    const presetData = apiResponse.preset || sessionData.preset;
    
    if (factData && factData.data) {
      // Знаходимо чергу для нашої адреси
      let queueKey = null;
      if (apiResponse.data) {
        const houseData = apiResponse.data[house] || Object.values(apiResponse.data)[0];
        if (houseData && houseData.sub_type_reason && houseData.sub_type_reason.length > 0) {
          queueKey = houseData.sub_type_reason[0];
        }
      }
      
      if (queueKey && factData.data) {
        Object.entries(factData.data).forEach(([dayTimestamp, dayData]) => {
          if (dayData[queueKey]) {
            const schedule = [];
            Object.entries(dayData[queueKey]).forEach(([hour, status]) => {
              const hourNum = parseInt(hour);
              let cellStatus = 'light';
              if (status === 'no' || status === 'maybe') {
                cellStatus = 'no-light';
              } else if (status === 'first' || status === 'mfirst') {
                cellStatus = 'no-light-first-half';
              } else if (status === 'second' || status === 'msecond') {
                cellStatus = 'no-light-second-half';
              }
              schedule.push({ hour: hourNum, status: cellStatus });
            });
            
            // Сортуємо по годинах
            schedule.sort((a, b) => a.hour - b.hour);
            
            if (schedule.length > 0) {
              outageData.schedules.push({
                dayTimestamp: parseInt(dayTimestamp),
                schedule
              });
            }
          }
        });
      }
    }
    
    // Якщо немає даних з API, читаємо з DOM (fallback)
    if (outageData.schedules.length === 0) {
      console.log('⚠️ API не повернув графік, читаємо з DOM...');
      
      // Закриваємо модальне вікно
      try {
        await page.locator('button[data-micromodal-close]').first().click({ timeout: 2000 });
        await page.waitForTimeout(500);
      } catch (e) {}
      
      // Вводимо адресу через UI
      await page.fill('#city', city);
      await page.waitForTimeout(500);
      const cityBox = await page.locator('#city').boundingBox();
      if (cityBox) {
        await page.mouse.click(cityBox.x + cityBox.width / 2, cityBox.y + cityBox.height + 10);
        await page.waitForTimeout(1000);
      }
      
      await page.fill('#street', street);
      await page.waitForTimeout(500);
      const streetBox = await page.locator('#street').boundingBox();
      if (streetBox) {
        await page.mouse.click(streetBox.x + streetBox.width / 2, streetBox.y + streetBox.height + 10);
        await page.waitForTimeout(1000);
      }
      
      await page.fill('#house_num', house);
      await page.waitForTimeout(500);
      const houseBox = await page.locator('#house_num').boundingBox();
      if (houseBox) {
        await page.mouse.click(houseBox.x + houseBox.width / 2, houseBox.y + houseBox.height + 10);
        await page.waitForTimeout(2000);
      }
      
      // Читаємо дані з DOM
      outageData = await page.evaluate(() => {
        const data = {
          currentOutage: null,
          schedules: [],
          infoBlockText: null,
          infoBlockType: null,
          updateTime: null
        };
        
        const outageDiv = document.querySelector('#showCurOutage');
        if (outageDiv) {
          const text = outageDiv.innerText;
          data.infoBlockText = text;
          const textLower = text.toLowerCase();
          if (textLower.includes('екстрен')) {
            data.infoBlockType = 'emergency';
          } else if (textLower.includes('аварійн')) {
            data.infoBlockType = 'accident';
          } else if (textLower.includes('стабілізац')) {
            data.infoBlockType = 'stabilization';
          } else if (textLower.includes('струм має бути')) {
            data.infoBlockType = 'power_on';
          } else {
            data.infoBlockType = 'unknown';
          }
        }
        
        const updateMatch = document.body.innerText.match(/Дата оновлення інформації\s*–\s*(\d{1,2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (updateMatch) {
          data.updateTime = {
            hour: parseInt(updateMatch[1]),
            minute: parseInt(updateMatch[2]),
            day: parseInt(updateMatch[3]),
            month: parseInt(updateMatch[4]),
            year: parseInt(updateMatch[5])
          };
        }
        
        const tables = document.querySelectorAll('div.discon-fact-table');
        tables.forEach((table) => {
          const dayTimestamp = parseInt(table.getAttribute('rel'));
          if (!dayTimestamp) return;
          
          const cells = table.querySelectorAll('tbody tr td');
          const schedule = [];
          for (let i = 2; i < cells.length; i++) {
            const cellClass = cells[i].className;
            const hour = i - 2;
            let status = 'light';
            if (cellClass.includes('cell-scheduled')) {
              status = 'no-light';
            } else if (cellClass.includes('cell-first-half')) {
              status = 'no-light-first-half';
            } else if (cellClass.includes('cell-second-half')) {
              status = 'no-light-second-half';
            }
            schedule.push({ hour, status });
          }
          
          if (schedule.length > 0) {
            data.schedules.push({ dayTimestamp, schedule });
          }
        });
        
        return data;
      });
    }
    
    console.log('✅ Дані отримано:');
    if (outageData.infoBlockType) {
      console.log(`  📋 Тип: ${outageData.infoBlockType}`);
    }
    console.log(`  📅 Графіків: ${outageData.schedules.length}`);
    outageData.schedules.forEach((sched, idx) => {
      const date = new Date(sched.dayTimestamp * 1000);
      const hoursWithoutLight = sched.schedule.filter(s => s.status !== 'light').length;
      console.log(`     ${idx + 1}. ${date.toLocaleDateString('uk-UA')}: ${hoursWithoutLight} год без світла`);
    });

    // --- 4. ПЕРЕВІРКА ОНОВЛЕНЬ ДЛЯ АЛЕРТУ ---
    const previousState = getPreviousState();
    let showAlert = false;
    let alertSummary = '';
    let alertDescription = '';

    const currentInfoBlockType = outageData.infoBlockType;
    const currentInfoBlockText = outageData.infoBlockText;
    const currentModalAlert = isUkrEnergoAlert ? `ukrenegro_${modalAlertType || 'unknown'}` : (modalAlertType || null);
    
    const modalChanged = currentModalAlert !== previousState.lastModalAlert;
    const infoBlockChanged = currentInfoBlockType !== previousState.lastInfoBlock;
    
    let effectiveType = modalAlertType || currentInfoBlockType;
    
    if (modalChanged || infoBlockChanged) {
      showAlert = true;
      switch (effectiveType) {
        case 'emergency':
          alertSummary = isUkrEnergoAlert ? '📢 Діють екстрені відключення (Укренерго)' : '📢 Діють екстрені відключення';
          break;
        case 'stabilization':
          alertSummary = isUkrEnergoAlert ? '📢 Діють стабілізаційні відключення (Укренерго)' : '📢 Діють стабілізаційні відключення';
          break;
        case 'accident':
          alertSummary = '📢 Діють аварійні відключення';
          break;
        case 'power_on':
          alertSummary = '📢 Електропостачання відновлено';
          break;
        default:
          alertSummary = '📢 Змінився статус відключень';
      }
      alertDescription = currentInfoBlockText || 'Інформація про статус відключень оновлена.';
      console.log(`📢 Зміна статусу: ${alertSummary}`);
    }

    if (!showAlert) {
      const currentScheduledDays = outageData.schedules.map(s => s.dayTimestamp);
      const newDays = currentScheduledDays.filter(day => !previousState.lastScheduledDays.includes(day));
      
      if (newDays.length > 0) {
        showAlert = true;
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        
        const isTomorrowAdded = newDays.some(ts => {
          const newDate = new Date(ts * 1000);
          newDate.setHours(0, 0, 0, 0);
          return newDate.getTime() === tomorrow.getTime();
        });

        alertSummary = isTomorrowAdded 
          ? "📢 З'явився графік на завтра" 
          : `📢 З'явився графік на ${newDays.map(ts => new Date(ts * 1000).toLocaleDateString('uk-UA')).join(', ')}`;
        alertDescription = `Додано розклад відключень на нові дати.`;
        console.log(`📢 Новий графік: ${alertSummary}`);
      }
    }

    saveCurrentState(currentInfoBlockType, outageData.schedules.map(s => s.dayTimestamp), currentModalAlert);

    // --- 5. ГЕНЕРАЦІЯ КАЛЕНДАРЯ ---
    console.log('📅 Створюємо календар...');
    const cal = ical({ 
      name: '⚡️Відключення світла',
      timezone: 'Europe/Kyiv'
    });

    let updateTimeString = '';
    if (outageData.updateTime) {
      const { hour, minute } = outageData.updateTime;
      updateTimeString = ` ⟲ ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }

    let outageTypeName = 'Стабілізаційне відключення';
    const effectiveOutageType = modalAlertType || outageData.infoBlockType;
    
    switch (effectiveOutageType) {
      case 'emergency': outageTypeName = 'Екстрене відключення'; break;
      case 'accident': outageTypeName = 'Аварійне відключення'; break;
      case 'stabilization': outageTypeName = 'Стабілізаційне відключення'; break;
      case 'unknown': outageTypeName = 'Відключення'; break;
    }
    
    let ukrEnergoSuffix = '';
    if (isUkrEnergoAlert) {
      const ukrType = modalAlertType === 'emergency' ? 'екстрені' : 'стабілізаційні';
      ukrEnergoSuffix = ` (Укренерго: ${ukrType} відключення)`;
    }
    
    const allEvents = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();
    
    outageData.schedules.forEach(sched => {
      const date = new Date(sched.dayTimestamp * 1000);
      const year = date.getFullYear();
      const month = date.getMonth();
      const day = date.getDate();
      
      const eventDate = new Date(year, month, day);
      eventDate.setHours(0, 0, 0, 0);
      const isToday = eventDate.getTime() === todayTimestamp;
      
      const eventSummary = isToday 
        ? `${outageTypeName}${ukrEnergoSuffix}${updateTimeString}`
        : `Стабілізаційне відключення${updateTimeString}`;
      const eventDesc = isToday 
        ? (outageData.infoBlockText || `Планове відключення за графіком.`)
        : `Планове відключення за графіком.`;

      let startSlot = null;
      for (let i = 0; i < sched.schedule.length; i++) {
        const currentSlot = sched.schedule[i];
        const isOutage = currentSlot.status !== 'light';

        if (isOutage && startSlot === null) {
          startSlot = currentSlot;
        } else if (!isOutage && startSlot !== null) {
          allEvents.push({
            start: new Date(year, month, day, startSlot.hour, 0),
            end: new Date(year, month, day, currentSlot.hour, 0),
            summary: eventSummary,
            description: eventDesc
          });
          startSlot = null;
        }
      }
      if (startSlot !== null) {
        allEvents.push({
          start: new Date(year, month, day, startSlot.hour, 0),
          end: new Date(year, month, day, 24, 0),
          summary: eventSummary,
          description: eventDesc
        });
      }
    });

    allEvents.sort((a, b) => a.start - b.start);

    const powerOnEvents = [];
    for (let i = 0; i < allEvents.length - 1; i++) {
      const currentEventEnd = allEvents[i].end;
      const nextEventStart = allEvents[i + 1].start;

      if (nextEventStart > currentEventEnd) {
        const eventDate = new Date(currentEventEnd);
        eventDate.setHours(0, 0, 0, 0);
        const isToday = eventDate.getTime() === todayTimestamp;
        
        const powerOnSummary = isToday
          ? `Є струм${ukrEnergoSuffix}${updateTimeString}`
          : `Є струм${updateTimeString}`;
        
        powerOnEvents.push({
          start: currentEventEnd,
          end: nextEventStart,
          summary: powerOnSummary,
          description: `Електроенергія має бути в наявності.`
        });
      }
    }

    [...allEvents, ...powerOnEvents].forEach(event => {
      cal.createEvent(event);
    });
    
    console.log(`✅ Додано ${allEvents.length} відключень та ${powerOnEvents.length} періодів зі світлом`);

    if (showAlert) {
      cal.createEvent({
        start: new Date(),
        end: new Date(new Date().getTime() + 5 * 60000),
        summary: alertSummary,
        description: alertDescription,
        alarms: [
          { type: 'display', trigger: 1 },
          { type: 'audio', trigger: 1 }
        ]
      });
    }
    
    fs.writeFileSync('dtek.ics', cal.toString());
    console.log('✅ Календар збережено');

    // --- 6. GIT ---
    try {
      const gitStatus = execSync('git status --porcelain dtek.ics last_run_state.json').toString().trim();

      if (gitStatus) {
        console.log('🔄 Оновлюємо репозиторій...');
        execSync('git config user.name "GitHub Actions Bot"');
        execSync('git config user.email "actions@github.com"');
        execSync('git add dtek.ics last_run_state.json');
        execSync('git commit -m "📅 Оновлено календар відключень"');
        execSync('git pull --rebase');
        execSync('git push');
        console.log('✅ Репозиторій оновлено!');
      } else {
        console.log('🧘 Змін немає');
      }
    } catch (error) {
      console.error('❌ Git помилка:', error.message);
    }

    await browser.close();
    console.log('🎉 Готово!');

  } catch (error) {
    console.error('❌ Помилка:', error.message);
    console.error(error);
    await browser.close();
  }
})();
