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
  return { lastInfoBlock: null, lastScheduledDays: [] };
}

// Функція для збереження поточного стану
function saveCurrentState(infoBlock, scheduledDays) {
  const state = {
    lastInfoBlock: infoBlock,
    lastScheduledDays: scheduledDays,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Функція для читання попереднього календаря
function getPreviousCalendar() {
  try {
    if (fs.existsSync('dtek.ics')) {
      return fs.readFileSync('dtek.ics', 'utf8');
    }
  } catch (e) {}
  return null;
}

// Функція для перевірки чи є нові дати в календарі
function checkForNewDates(oldCal, newCal) {
  if (!oldCal) return true;
  
  // Витягаємо дати з календарів
  const oldDates = (oldCal.match(/DTSTART:(\d{8})/g) || []).map(d => d.replace('DTSTART:', ''));
  const newDates = (newCal.match(/DTSTART:(\d{8})/g) || []).map(d => d.replace('DTSTART:', ''));
  
  // Перевіряємо чи є нові дати
  const newItems = newDates.filter(d => !oldDates.includes(d));
  return newItems.length > 0;
}

// Читаємо конфігурацію
let config;
try {
  const configData = fs.readFileSync('config.json', 'utf8');
  config = JSON.parse(configData);
} catch (error) {
  console.error('❌ Помилка при читанні config.json:', error.message);
  console.log('📝 Використовуємо дані за замовчуванням...');
  config = {
    address: {
      city: 'с. Гора',
      street: 'вул. Мостова',
      house: '21'
    }
  };
}

const { city, street, house } = config.address;

console.log('📋 Використовується адреса:');
console.log(`   Населений пункт: ${city}`);
console.log(`   Вулиця: ${street}`);
console.log(`   Будинок: ${house}\n`);

(async () => {
  // Для GitHub Actions використовуємо headless mode, для локального - з UI
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const browser = await chromium.launch({ 
    headless: isCI ? true : false, 
    slowMo: isCI ? 0 : 500 
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  console.log('🚀 Запуск... Відкриваємо сайт ДТЕК');

  try {
    await page.goto('https://www.dtek-krem.com.ua/ua/shutdowns', { 
      waitUntil: 'networkidle',
      timeout: 60000 
    });

    // --- 1. ЗАКРИВАЄМО ПОПЕРЕДЖЕННЯ (МОДАЛЬНЕ ВІКНО) ---
    console.log('🧐 Шукаємо вікно попередження...');
    await page.waitForTimeout(2000);
    
    // Спочатку читаємо текст зі спливного вікна (якщо є)
    let isUkrEnergoAlert = false;
    let modalAlertType = null;
    const alertText = await page.evaluate(() => {
        // Спробуємо знайти спливне вікно
        const modal = document.querySelector('.modal, .popup, [role="dialog"], .alert, .notification');
        if (modal) {
            return modal.innerText;
        }
        return null;
    });
    
    if (alertText) {
        console.log('📢 Знайдено спливне вікно з інформацією:');
        console.log(`   ${alertText.substring(0, 100)}...`);
        
        // Перевіряємо чи є згадка про Укренерго
        if (alertText.toLowerCase().includes('укренерго')) {
            isUkrEnergoAlert = true;
            console.log('   ⚠️ Виявлено: ЕКСТРЕНІ ВІДКЛЮЧЕННЯ УКРЕНЕРГО');
        }
        
        // Визначаємо тип відключення з тексту вікна
        if (alertText.toLowerCase().includes('екстрен')) {
            modalAlertType = 'emergency';
            console.log('   ⚠️ Тип: ЕКСТРЕНЕ ВІДКЛЮЧЕННЯ');
        } else if (alertText.toLowerCase().includes('стабілізац')) {
            modalAlertType = 'stabilization';
            console.log('   ℹ️ Тип: Стабілізаційне відключення');
        }
    }
    
    try {
        const micromodalButton = page.locator('button[data-micromodal-close=""].modal__close');
        if (await micromodalButton.isVisible({ timeout: 500 })) {
            console.log('✅ Знайдена MicroModal кнопка закриття');
            await micromodalButton.click({ timeout: 5000 });
            await page.waitForTimeout(1500);
            console.log('✅ Модальне вікно закрито через MicroModal');
        }
    } catch (e) {
        console.log('⚠️ MicroModal кнопка не знайдена, спробуємо інші селектори...');
    }

    const closeButtons = [
        'button[data-micromodal-close]',
        '.modal__close',
        'button:has-text("Зрозуміло")',
        'button:has-text("Закрити")',
        'button:has-text("OK")',
        'button:has-text("Ок")',
        '.close',
        '.btn-close',
        '.modal-close',
        'button.close',
        '[aria-label="Close"]',
        '[data-dismiss="modal"]'
    ];

    for (const selector of closeButtons) {
        try {
            const element = page.locator(selector).first();
            if (await element.isVisible({ timeout: 500 })) {
                console.log(`✅ Знайдена кнопка закриття: ${selector}`);
                await element.click({ timeout: 5000 });
                await page.waitForTimeout(1500);
                console.log('✅ Модальне вікно закрито');
                break;
            }
        } catch (e) {}
    }

    try {
        const dialogPresent = await page.locator('.modal, .popup, [role="dialog"]').first().isVisible({ timeout: 500 });
        if (dialogPresent) {
            console.log('⌨️ Натискаємо ESC для закриття модального вікна...');
            await page.press('Escape');
            await page.waitForTimeout(1000);
        }
    } catch (e) {}

    // --- 2. ВИБІР АДРЕСИ ---
    console.log(`📍 Вводимо адресу: ${city}, ${street}, ${house}`);

    // Населений пункт
    console.log('Обираємо населений пункт...');
    const cityInput = page.locator('form input[id="city"]').nth(0);
    await cityInput.focus();
    await page.waitForTimeout(300);
    await cityInput.clear();
    await cityInput.type(city, { delay: 50 });
    await page.waitForTimeout(2000);
    
    // Отримаємо координати поля і клікнемо під ним
    const cityBox = await cityInput.boundingBox();
    if (cityBox) {
        const dropdownX = cityBox.x + cityBox.width / 2;
        const dropdownY = cityBox.y + cityBox.height + 10; // клікаємо під полем
        console.log(`�️ Клікаємо на дропдаун на координатах: ${dropdownX}, ${dropdownY}`);
        await page.mouse.click(dropdownX, dropdownY);
        await page.waitForTimeout(1500);
    } else {
        console.log('⚠️ Не вдалося отримати координати поля');
    }
    
    const cityValue = await cityInput.inputValue();
    console.log(`📝 Значення поля міста: ${cityValue}`);
    console.log('✅ Населений пункт вибрано');

    // Вулиця
    console.log('Обираємо вулицю...');
    const streetInput = page.locator('form input[id="street"]').nth(0);
    await streetInput.focus();
    await page.waitForTimeout(300);
    await streetInput.clear();
    await streetInput.type(street, { delay: 50 });
    await page.waitForTimeout(2000);
    
    // Клікаємо під полем вулиці
    const streetBox = await streetInput.boundingBox();
    if (streetBox) {
        const streetDropdownX = streetBox.x + streetBox.width / 2;
        const streetDropdownY = streetBox.y + streetBox.height + 10;
        console.log(`🖱️ Клікаємо на дропдаун вулиці на координатах: ${streetDropdownX}, ${streetDropdownY}`);
        await page.mouse.click(streetDropdownX, streetDropdownY);
        await page.waitForTimeout(1500);
    }
    
    const streetValue = await streetInput.inputValue();
    console.log(`📝 Значення поля вулиці: ${streetValue}`);
    console.log('✅ Вулиця вибрана');

    // Будинок
    console.log('Обираємо номер будинку...');
    const houseInput = page.locator('form input[id="house_num"]').nth(0);
    await houseInput.focus();
    await page.waitForTimeout(300);
    await houseInput.clear();
    await houseInput.type(house, { delay: 50 });
    await page.waitForTimeout(2000);
    
    // Клікаємо під полем будинку
    const houseBox = await houseInput.boundingBox();
    if (houseBox) {
        const houseDropdownX = houseBox.x + houseBox.width / 2;
        const houseDropdownY = houseBox.y + houseBox.height + 10;
        console.log(`🖱️ Клікаємо на дропдаун будинку на координатах: ${houseDropdownX}, ${houseDropdownY}`);
        await page.mouse.click(houseDropdownX, houseDropdownY);
        await page.waitForTimeout(1500);
    }
    
    const houseValue = await houseInput.inputValue();
    console.log(`📝 Значення поля будинку: ${houseValue}`);
    console.log('✅ Будинок вибрано');

    // Отримуємо ВСЮ інформацію про відключення зі сторінки
    console.log('\n📊 Отримуємо інформацію про відключення...');
    
    const allOutageData = await page.evaluate(() => {
        const data = {
            currentOutage: null,
            schedules: [],
            infoBlockText: null,
            infoBlockType: null,
            updateTime: null
        };
        
        // 1. Шукаємо інформаційний блок перед таблицею
        const outageDiv = document.querySelector('#showCurOutage');
        if (outageDiv) {
            const text = outageDiv.innerText;
            data.infoBlockText = text;
            
            // Визначаємо тип відключення з інформаційного блоку
            const textLower = text.toLowerCase();
            if (textLower.includes('екстрен')) {
                data.infoBlockType = 'emergency';
            } else if (textLower.includes('аварійн')) {
                data.infoBlockType = 'accident';
            } else if (textLower.includes('стабілізац')) {
                data.infoBlockType = 'stabilization';
            } else if (textLower.includes('струм має бути') || textLower.includes('електропостачання здійснюється')) {
                data.infoBlockType = 'power_on';
            } else {
                data.infoBlockType = 'unknown';
            }
            
            // Парсимо час початку
            const startMatch = text.match(/Час початку\s*–\s*(\d{1,2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/);
            
            // Парсимо час завершення/відновлення
            // Для планових: "Орієнтовний час відновлення електроенергії – до 21:30"
            // Для аварійних: також може бути в форматі "до 14:30" або без дати
            const endMatch = text.match(/до\s+(\d{1,2}):(\d{2})(?:\s+(\d{1,2})\.(\d{1,2})\.(\d{4}))?/);
            
            // Парсимо причину
            const reasonMatch = text.match(/Причина:\s*(.+?)(?:\n|$)/);
            
            if (startMatch && endMatch) {
                // Якщо дати нема в часі завершення (аварійне), беремо дату початку
                const endDay = endMatch[3] ? parseInt(endMatch[3]) : parseInt(startMatch[3]);
                const endMonth = endMatch[4] ? parseInt(endMatch[4]) : parseInt(startMatch[4]);
                const endYear = endMatch[5] ? parseInt(endMatch[5]) : parseInt(startMatch[5]);
                
                data.currentOutage = {
                    startHour: parseInt(startMatch[1]),
                    startMinute: parseInt(startMatch[2]),
                    startDay: parseInt(startMatch[3]),
                    startMonth: parseInt(startMatch[4]),
                    startYear: parseInt(startMatch[5]),
                    endHour: parseInt(endMatch[1]),
                    endMinute: parseInt(endMatch[2]),
                    endDay: endDay,
                    endMonth: endMonth,
                    endYear: endYear,
                    reason: reasonMatch ? reasonMatch[1].trim() : ''
                };
            }
        }
        
        // 2. Парсимо дату оновлення
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
        
        // 3. Витягуємо графіки відключень з таблиці
        const tables = document.querySelectorAll('div.discon-fact-table');
        tables.forEach((table) => {
            const dayTimestamp = parseInt(table.getAttribute('rel'));
            if (!dayTimestamp) return;
            
            const cells = table.querySelectorAll('tbody tr td');
            const schedule = [];
            
            // Пропускаємо перші 2 клітинки (заголовок)
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
                data.schedules.push({
                    dayTimestamp,
                    schedule
                });
            }
        });
        
        return data;
    });
    
    console.log('✅ Отримана інформація зі сторінки:');
    if (allOutageData.infoBlockType) {
        console.log(`  📋 Тип інформаційного блоку: ${allOutageData.infoBlockType}`);
    }
    if (allOutageData.currentOutage) {
        console.log(`  🔴 Поточне відключення: ${allOutageData.currentOutage.startHour}:${String(allOutageData.currentOutage.startMinute).padStart(2, '0')} - ${allOutageData.currentOutage.endHour}:${String(allOutageData.currentOutage.endMinute).padStart(2, '0')}`);
        if (allOutageData.currentOutage.reason) {
            console.log(`     Причина: ${allOutageData.currentOutage.reason}`);
        }
    }
    console.log(`  📅 Графіки на окремі дні: ${allOutageData.schedules.length}`);
    allOutageData.schedules.forEach((sched, idx) => {
        const date = new Date(sched.dayTimestamp * 1000);
        const hoursWithoutLight = sched.schedule.filter(s => s.status !== 'light').length;
        if (hoursWithoutLight > 0) {
            console.log(`     ${idx + 1}. ${date.toLocaleDateString('uk-UA')}: ${hoursWithoutLight} годин без світла`);
        } else {
            console.log(`     ${idx + 1}. ${date.toLocaleDateString('uk-UA')}: світло цілий день`);
        }
    });
    
    const outageData = allOutageData;

    // --- 3. ПЕРЕВІРКА НАЯВНОСТІ ОНОВЛЕНЬ ДЛЯ АЛЕРТУ ---
    const previousState = getPreviousState();
    let showAlert = false;
    let alertSummary = '';
    let alertDescription = '';

    // 1. Перевірка зміни в інформаційному блоці
    const currentInfoBlockType = outageData.infoBlockType;
    const currentInfoBlockText = outageData.infoBlockText;
    
    if (currentInfoBlockType !== previousState.lastInfoBlock) {
        showAlert = true;
        switch (currentInfoBlockType) {
            case 'emergency':
                alertSummary = '📢 Діють екстрені відключення';
                break;
            case 'accident':
                alertSummary = '📢 Діють аварійні відключення';
                break;
            case 'stabilization':
                alertSummary = '📢 Діють стабілізаційні відключення';
                break;
            case 'power_on':
                alertSummary = '📢 Електропостачання відновлено';
                break;
            default:
                alertSummary = '📢 Змінився статус відключень';
        }
        // Якщо тип невідомий, додаємо весь текст блоку в опис
        if (currentInfoBlockType === 'unknown' && currentInfoBlockText) {
            alertDescription = currentInfoBlockText;
        } else {
            alertDescription = currentInfoBlockText || 'Інформація про статус відключень оновлена.';
        }
        console.log(`📢 Виявлено зміну статусу: ${alertSummary}`);
    }

    // 2. Перевірка появи нового дня в графіку
    if (!showAlert) { // Перевіряємо графік, тільки якщо статус не змінився, щоб уникнути дублювання
        const currentScheduledDays = outageData.schedules.map(s => s.dayTimestamp);
        const newDays = currentScheduledDays.filter(day => !previousState.lastScheduledDays.includes(day));
        
        if (newDays.length > 0) {
            showAlert = true;
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(0, 0, 0, 0);
            const tomorrowTimestamp = Math.floor(tomorrow.getTime() / 1000);

            // Перевіряємо, чи є серед нових днів завтрашній
            const isTomorrowAdded = newDays.some(ts => {
                const newDate = new Date(ts * 1000);
                newDate.setHours(0, 0, 0, 0);
                return newDate.getTime() === tomorrow.getTime();
            });

            if (isTomorrowAdded) {
                alertSummary = "📢 З'явився графік на завтра";
            } else {
                const newDates = newDays.map(ts => new Date(ts * 1000).toLocaleDateString('uk-UA')).join(', ');
                alertSummary = `📢 З'явився графік на ${newDates}`;
            }
            alertDescription = `Додано розклад відключень на нові дати.`;
            console.log(`📢 Виявлено новий графік: ${alertSummary}`);
        }
    }

    // Зберігаємо поточний стан для наступного запуску
    saveCurrentState(currentInfoBlockType, outageData.schedules.map(s => s.dayTimestamp));


    // --- 4. ГЕНЕРАЦІЯ КАЛЕНДАРЯ ---
    console.log('📅 Створюємо новий календар...');
    const cal = ical({ name: '⚡️Відключення світла' });

    // Форматуємо час оновлення, якщо він є
    let updateTimeString = '';
    if (outageData.updateTime) {
        const { hour, minute } = outageData.updateTime;
        updateTimeString = ` ⟲ ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }

    // Визначаємо назву типу відключення та суфікс Укренерго
    let outageTypeName = 'Стабілізаційне відключення';
    let eventDescription = '';
    
    switch (outageData.infoBlockType) {
        case 'emergency':
            outageTypeName = 'Екстрене відключення';
            break;
        case 'accident':
            outageTypeName = 'Аварійне відключення';
            break;
        case 'stabilization':
            outageTypeName = 'Стабілізаційне відключення';
            break;
        case 'unknown':
            outageTypeName = 'Відключення';
            eventDescription = outageData.infoBlockText || '';
            break;
        default:
            outageTypeName = 'Стабілізаційне відключення';
    }
    
    // Додаємо суфікс про Укренерго якщо є
    const ukrEnergoSuffix = isUkrEnergoAlert ? ' (Увага: діють екстрені відключення Укренерго)' : '';
    
    // Додаємо поточне відключення, якщо є
    if (outageData.currentOutage) {
        const { startYear, startMonth, startDay, startHour, startMinute, endYear, endMonth, endDay, endHour, endMinute, reason } = outageData.currentOutage;
        
        const summary = `${outageTypeName}${ukrEnergoSuffix}${updateTimeString}`;
        const description = eventDescription || reason || '';

        cal.createEvent({
            start: new Date(startYear, startMonth - 1, startDay, startHour, startMinute),
            end: new Date(endYear, endMonth - 1, endDay, endHour, endMinute),
            summary: summary,
            description: description,
        });
        console.log(`🔥 Додано поточне відключення: ${summary}`);
    }

    // Обробляємо графіки відключень
    const allEvents = [];
    outageData.schedules.forEach(sched => {
        const date = new Date(sched.dayTimestamp * 1000);
        const year = date.getFullYear();
        const month = date.getMonth();
        const day = date.getDate();

        let startSlot = null;
        for (let i = 0; i < sched.schedule.length; i++) {
            const currentSlot = sched.schedule[i];
            const isOutage = currentSlot.status !== 'light';

            if (isOutage && startSlot === null) {
                startSlot = currentSlot;
            } else if (!isOutage && startSlot !== null) {
                const endHour = currentSlot.hour;
                allEvents.push({
                    start: new Date(year, month, day, startSlot.hour, 0),
                    end: new Date(year, month, day, endHour, 0),
                    summary: `${outageTypeName}${ukrEnergoSuffix}${updateTimeString}`,
                    description: eventDescription || `Планове відключення за графіком.`
                });
                startSlot = null;
            }
        }
        // Якщо відключення триває до кінця дня
        if (startSlot !== null) {
            allEvents.push({
                start: new Date(year, month, day, startSlot.hour, 0),
                end: new Date(year, month, day, 24, 0),
                summary: `${outageTypeName}${ukrEnergoSuffix}${updateTimeString}`,
                description: eventDescription || `Планове відключення за графіком.`
            });
        }
    });

    // Сортуємо всі події "Немає струму" за часом початку
    allEvents.sort((a, b) => a.start - b.start);

    // Додаємо події "Є струм" між відключеннями
    const powerOnEvents = [];
    for (let i = 0; i < allEvents.length - 1; i++) {
        const currentEventEnd = allEvents[i].end;
        const nextEventStart = allEvents[i + 1].start;

        // Якщо є проміжок між відключеннями, додаємо подію "Є струм"
        if (nextEventStart > currentEventEnd) {
            powerOnEvents.push({
                start: currentEventEnd,
                end: nextEventStart,
                summary: `Є струм${ukrEnergoSuffix}${updateTimeString}`,
                description: `Електроенергія має бути в наявності.`
            });
        }
    }

    // Додаємо всі події в календар
    [...allEvents, ...powerOnEvents].forEach(event => {
        cal.createEvent(event);
    });
    
    console.log(`✅ Додано ${allEvents.length} відключень та ${powerOnEvents.length} періодів з електроенергією.`);

    // --- 5. ДОДАВАННЯ АЛЕРТУ (ЯКЩО ПОТРІБНО) ---
    if (showAlert) {
        console.log('✨ Створюємо алерт про оновлення...');
        cal.createEvent({
            start: new Date(),
            end: new Date(new Date().getTime() + 5 * 60000), // 5 хвилин
            summary: alertSummary,
            description: alertDescription,
            alarms: [
                { type: 'display', trigger: 1 },
                { type: 'audio', trigger: 1 }
            ]
        });
    }
    
    // Зберігаємо новий календар
    fs.writeFileSync('dtek.ics', cal.toString());
    console.log('✅ Календар збережено у файл dtek.ics');

    // --- 6. ОНОВЛЕННЯ GIT РЕПОЗИТОРІЮ ---
    try {
        console.log('🔄 Перевіряємо наявність змін у файлі календаря...');
        // Додаємо файл стану до відстеження
        const gitStatus = execSync('git status --porcelain dtek.ics last_run_state.json').toString().trim();

        if (gitStatus) {
            console.log('🎨 Зміни знайдено! Оновлюємо репозиторій...');
            execSync('git config user.name "GitHub Actions Bot"');
            execSync('git config user.email "actions@github.com"');
            execSync('git add dtek.ics last_run_state.json');
            execSync('git commit -m "📅 Оновлено календар відключень"');
            
            console.log('⏬ Синхронізуємо з віддаленим репозиторієм...');
            execSync('git pull --rebase'); // Rebase local commit on top of remote changes
            
            execSync('git push');
            console.log('✅ Репозиторій успішно оновлено!');
        } else {
            console.log('🧘 Змін у календарі не виявлено. Репозиторій актуальний.');
        }
    } catch (error) {
        console.error('❌ Помилка під час оновлення Git репозиторію:', error.message);
    }

    await browser.close();
    console.log('🎉 Готово!');

  } catch (error) {
    console.error('❌ Помилка:', error.message);
    console.error(error);
  } finally {
    await browser.close();
    console.log('👋 Браузер закрито');
  }
})();
