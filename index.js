const { chromium } = require('playwright');
const ical = require('ical-generator').default;
const fs = require('fs');

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
    let initialAlertType = null;
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
        
        // Визначаємо тип відключення з тексту вікна
        if (alertText.includes('екстрен') || alertText.includes('аварійн')) {
            initialAlertType = 'emergency';
            console.log('   ⚠️ Визначено: ЕКСТРЕНЕ ВІДКЛЮЧЕННЯ');
        } else if (alertText.includes('стабілізац')) {
            initialAlertType = 'stabilization';
            console.log('   ℹ️ Визначено: Стабілізаційне відключення');
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
    
    const allOutageData = await page.evaluate((alertType) => {
        const data = {
            currentOutage: null,
            schedules: [],
            isEmergency: false,
            updateTime: null
        };
        
        // 1. Шукаємо поточне/аварійне відключення
        const outageDiv = document.querySelector('#showCurOutage');
        if (outageDiv) {
            const text = outageDiv.innerText;
            
            // Перевіримо, чи це аварійне відключення
            // Спочатку перевіримо інформацію з спливного вікна (якщо вона передана)
            let isEmergency = alertType === 'emergency';
            
            // Якщо з вікна не було інформації, перевіримо текст на сторінці
            if (!isEmergency) {
                isEmergency = text.includes('аварійн') || text.includes('екстрен');
            }
            
            data.isEmergency = isEmergency;
            
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
                    reason: reasonMatch ? reasonMatch[1].trim() : 'Стабілізаційне відключення',
                    isEmergency: data.isEmergency
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
    }, initialAlertType);
    
    console.log('✅ Отримана інформація зі сторінки:');
    if (allOutageData.currentOutage) {
        console.log(`  🔴 Поточне відключення: ${allOutageData.currentOutage.startHour}:${String(allOutageData.currentOutage.startMinute).padStart(2, '0')} - ${allOutageData.currentOutage.endHour}:${String(allOutageData.currentOutage.endMinute).padStart(2, '0')}`);
        console.log(`     Причина: ${allOutageData.currentOutage.reason}`);
        if (allOutageData.currentOutage.isEmergency) {
            console.log('     ⚠️ АВАРІЙНЕ/ЕКСТРЕНЕ ВІДКЛЮЧЕННЯ!');
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

    // Генеруємо календар на основі отриманих даних
    console.log('\n📅 Генеруємо календар...');
    
    // Визначаємо тип відключення та опис
    let outageType = 'Плановое відключення за графіком';
    
    // Перевіримо чи є поточне відключення АБО чи в спливному вікні було екстрене
    if ((outageData.currentOutage && outageData.currentOutage.isEmergency) || outageData.isEmergency) {
        outageType = 'АВАРІЙНЕ/ЕКСТРЕНЕ ВІДКЛЮЧЕННЯ';
    }
    
    // Формуємо основний опис календаря
    let calendarDescription = `Розклад відключень електроенергії для адреси: ${city}, ${street}, ${house}\n\nТип: ${outageType}`;
    if (outageData.updateTime) {
        calendarDescription += `\nДанні оновлено: ${outageData.updateTime.hour}:${String(outageData.updateTime.minute).padStart(2, '0')} ${outageData.updateTime.day}.${outageData.updateTime.month}.${outageData.updateTime.year}`;
    }
    
    // Якщо це екстрене відключення, додамо попередження
    if (outageType.includes('АВАРІЙНЕ')) {
        calendarDescription = '⚠️ УВАГА: ' + calendarDescription;
    }
    
    if (outageData.schedules && outageData.schedules.length > 1) {
        calendarDescription += '\n\n📋 Графіки на:';
        outageData.schedules.forEach((sched) => {
            const date = new Date(sched.dayTimestamp * 1000);
            calendarDescription += `\n  • ${date.toLocaleDateString('uk-UA')}`;
        });
    }
    
    const calendar = ical({ 
        name: 'ДТЕК Гора',
        description: calendarDescription,
        url: 'https://www.dtek-krem.com.ua/ua/shutdowns',
        prodId: '//dtekical//Scheduler//UK',
        method: 'PUBLISH',
        timezone: 'Europe/Kyiv',
        calscale: 'GREGORIAN'
    });

    // 1. Додаємо поточне/аварійне відключення (якщо є)
    if (outageData.currentOutage) {
        const startDate = new Date(
            outageData.currentOutage.startYear,
            outageData.currentOutage.startMonth - 1,
            outageData.currentOutage.startDay,
            outageData.currentOutage.startHour,
            outageData.currentOutage.startMinute,
            0
        );

        const endDate = new Date(
            outageData.currentOutage.endYear,
            outageData.currentOutage.endMonth - 1,
            outageData.currentOutage.endDay,
            outageData.currentOutage.endHour,
            outageData.currentOutage.endMinute,
            0
        );

        let summary = '🚫 Відключення струму (ДТЕК)';
        if (outageData.currentOutage.isEmergency) {
            summary = '🚨 АВАРІЙНЕ ВІДКЛЮЧЕННЯ (ДТЕК)';
        }

        let description = `Тип: ${outageData.currentOutage.reason}\n`;
        description += `Початок: ${outageData.currentOutage.startHour}:${String(outageData.currentOutage.startMinute).padStart(2, '0')} ${outageData.currentOutage.startDay}.${outageData.currentOutage.startMonth}.${outageData.currentOutage.startYear}\n`;
        description += `Орієнтовне відновлення: ${outageData.currentOutage.endHour}:${String(outageData.currentOutage.endMinute).padStart(2, '0')}`;
        
        // Якщо аварійне відключення, дата може бути іншою
        if (outageData.currentOutage.isEmergency || 
            (outageData.currentOutage.endDay !== outageData.currentOutage.startDay ||
             outageData.currentOutage.endMonth !== outageData.currentOutage.startMonth ||
             outageData.currentOutage.endYear !== outageData.currentOutage.startYear)) {
            description += ` ${outageData.currentOutage.endDay}.${outageData.currentOutage.endMonth}.${outageData.currentOutage.endYear}`;
        }
        
        if (outageData.updateTime) {
            description += `\n\nДанні оновлено: ${outageData.updateTime.hour}:${String(outageData.updateTime.minute).padStart(2, '0')} ${outageData.updateTime.day}.${outageData.updateTime.month}.${outageData.updateTime.year}`;
        }

        calendar.createEvent({
            start: startDate,
            end: endDate,
            summary: summary,
            description: description,
            location: `${city}, ${street}, ${house}`,
            organizer: {
                name: 'ДТЕК',
                email: 'info@dtek.ua'
            },
            url: 'https://www.dtek-krem.com.ua/ua/shutdowns',
            status: outageData.currentOutage.isEmergency ? 'CONFIRMED' : 'CONFIRMED',
            transp: 'TRANSPARENT'
        });
        
        console.log('✅ Поточне/аварійне відключення додано');
    }

    // 2. Додаємо графіки відключень з таблиць (за графіком)
    if (outageData.schedules && outageData.schedules.length > 0) {
        let scheduleCount = 0;
        
        outageData.schedules.forEach((schedule, idx) => {
            const dayDate = new Date(schedule.dayTimestamp * 1000);
            const dayString = dayDate.toLocaleDateString('uk-UA');
            
            // Знаходимо періоди без світла в цей день
            const noLightPeriods = [];
            let currentPeriodStart = null;
            
            schedule.schedule.forEach((hour, hourIdx) => {
                const hasLight = hour.status === 'light';
                
                if (!hasLight && currentPeriodStart === null) {
                    // Почало періоду без світла
                    currentPeriodStart = hourIdx;
                } else if (hasLight && currentPeriodStart !== null) {
                    // Кінець періоду без світла
                    noLightPeriods.push({
                        startHour: currentPeriodStart,
                        endHour: hourIdx
                    });
                    currentPeriodStart = null;
                }
            });
            
            // Якщо період без світла закінчується в кінці дня
            if (currentPeriodStart !== null) {
                noLightPeriods.push({
                    startHour: currentPeriodStart,
                    endHour: 24
                });
            }
            
            // Знаходимо періоди коли СТРУМ Є (між відключеннями)
            const lightPeriods = [];
            let lastEndHour = 0;
            
            noLightPeriods.forEach((period) => {
                if (period.startHour > lastEndHour) {
                    lightPeriods.push({
                        startHour: lastEndHour,
                        endHour: period.startHour
                    });
                }
                lastEndHour = period.endHour;
            });
            
            // Якщо після останнього відключення ще є струм до кінця дня
            if (lastEndHour < 24 && noLightPeriods.length > 0) {
                lightPeriods.push({
                    startHour: lastEndHour,
                    endHour: 24
                });
            }
            
            // Додаємо кожен період як подію в календар ТІЛЬКИ якщо він має периоди без світла
            if (noLightPeriods.length > 0) {
                // Спочатку додаємо періоди коли СТРУМ Є
                lightPeriods.forEach((period) => {
                    const startDate = new Date(
                        dayDate.getFullYear(),
                        dayDate.getMonth(),
                        dayDate.getDate(),
                        period.startHour,
                        0,
                        0
                    );
                    
                    const endDate = new Date(
                        dayDate.getFullYear(),
                        dayDate.getMonth(),
                        dayDate.getDate(),
                        period.endHour,
                        0,
                        0
                    );
                    
                    calendar.createEvent({
                        start: startDate,
                        end: endDate,
                        summary: `⚡ Є струм (${period.startHour}:00 - ${period.endHour}:00)`,
                        description: `Електропостачання працює за графіком.\nЧас: ${period.startHour}:00 - ${period.endHour}:00`,
                        location: `${city}, ${street}, ${house}`,
                        status: 'CONFIRMED',
                        transp: 'TRANSPARENT'
                    });
                });
                
                // Потім додаємо періоди відключень
                noLightPeriods.forEach((period) => {
                    const startDate = new Date(
                        dayDate.getFullYear(),
                        dayDate.getMonth(),
                        dayDate.getDate(),
                        period.startHour,
                        0,
                        0
                    );
                    
                    const endDate = new Date(
                        dayDate.getFullYear(),
                        dayDate.getMonth(),
                        dayDate.getDate(),
                        period.endHour,
                        0,
                        0
                    );

                    let summary = `📊 Плановое відключення (${period.startHour}:00 - ${period.endHour}:00)`;
                    
                    // Якщо це екстрене, змінимо summary
                    if (outageData.isEmergency) {
                        summary = `🚨 ЕКСТРЕНЕ ВІДКЛЮЧЕННЯ (${period.startHour}:00 - ${period.endHour}:00)`;
                    }

                    let description = `Тип: ${outageData.isEmergency ? 'Екстрене відключення' : 'Плановое відключення за графіком'}\nЧас: ${period.startHour}:00 - ${period.endHour}:00`;
                    
                    // Додаємо інформацію про наступні дні з відключеннями
                    const nextSchedulesWithOutages = [];
                    for (let i = idx + 1; i < outageData.schedules.length; i++) {
                        const nextSchedule = outageData.schedules[i];
                        const nextDate = new Date(nextSchedule.dayTimestamp * 1000);

                        const nextHoursWithoutLight = nextSchedule.schedule.filter(s => s.status !== 'light').length;
                        if (nextHoursWithoutLight > 0) {
                            nextSchedulesWithOutages.push({
                                date: nextDate.toLocaleDateString('uk-UA'),
                                hours: nextHoursWithoutLight
                            });
                        }
                    }
                    
                    if (nextSchedulesWithOutages.length > 0) {
                        description += '\n\n📋 Графіки на наступні дні:';
                        nextSchedulesWithOutages.forEach((sched) => {
                            description += `\n  • ${sched.date} (${sched.hours} г.)`;
                        });
                    }
                    
                    if (outageData.updateTime) {
                        description += `\n\nДанні оновлено: ${outageData.updateTime.hour}:${String(outageData.updateTime.minute).padStart(2, '0')} ${outageData.updateTime.day}.${outageData.updateTime.month}.${outageData.updateTime.year}`;
                    }

                    calendar.createEvent({
                        start: startDate,
                        end: endDate,
                        summary: summary,
                        description: description,
                        location: `${city}, ${street}, ${house}`,
                        organizer: {
                            name: 'ДТЕК',
                            email: 'info@dtek.ua'
                        },
                        url: 'https://www.dtek-krem.com.ua/ua/shutdowns',
                        status: 'CONFIRMED',
                        transp: 'TRANSPARENT',
                        alarms: [
                            {
                                type: 'display',
                                trigger: { minutes: 60 },
                                description: `Розклад: ${summary}`
                            }
                        ]
                    });
                });
                
                console.log(`✅ Графік на ${dayString} додано (${noLightPeriods.length} період${noLightPeriods.length !== 1 ? 'ів' : ''})`);
                
                // Показуємо інформацію про наступні дні з відключеннями
                const nextSchedulesWithOutages = [];
                for (let i = idx + 1; i < outageData.schedules.length; i++) {
                    const nextSchedule = outageData.schedules[i];
                    const nextDate = new Date(nextSchedule.dayTimestamp * 1000);
                    const nextHoursWithoutLight = nextSchedule.schedule.filter(s => s.status !== 'light').length;
                    if (nextHoursWithoutLight > 0) {
                        nextSchedulesWithOutages.push({ date: nextDate, hours: nextHoursWithoutLight });
                    }
                }
                if (nextSchedulesWithOutages.length > 0) {
                    console.log(`   📋 Графіки на наступні дні:`);
                    nextSchedulesWithOutages.forEach(sched => {
                        console.log(`      • ${sched.date.toLocaleDateString('uk-UA')}: ${sched.hours} годин без світла`);
                    });
                }
                scheduleCount++;
            } else {
                console.log(`⏼ Графік на ${dayString}: світло цілий день (не додано)`);
            }
        });
        
        if (scheduleCount === 0) {
            console.log('⏼ Жодного графіку з відключеннями не додано');
        }
    }

    // 3. Якщо немає жодної інформації
    if (!outageData.currentOutage && (!outageData.schedules || outageData.schedules.length === 0)) {
        console.log('⚠️ Немає інформації про відключення для цієї адреси');
        console.log('   Можливі причини:');
        console.log('   • На цю адресу немає планованих відключень');
        console.log('   • Адреса введена неправильно');
        
        // Все одно збережемо календар з інформацією
        if (outageData.updateTime) {
            calendar.createEvent({
                start: new Date(),
                end: new Date(new Date().getTime() + 60*60*1000),
                summary: '📊 Немає даних про відключення',
                description: `На дату ${new Date().toLocaleDateString('uk-UA')} немає даних про планові відключення. Перевірте сайт ДТЕК.`,
                location: `${city}, ${street}, ${house}`,
                status: 'TENTATIVE',
                transp: 'TRANSPARENT'
            });
        }
    }
    
    // Збережемо календар у файл
    const calendarContent = calendar.toString();
    fs.writeFileSync('dtek.ics', calendarContent);
    const icsLines = calendarContent.split('\n').length;
    
    // Перевіримо чи є нові дані
    const oldCalendar = getPreviousCalendar();
    const hasNewData = checkForNewDates(oldCalendar, calendarContent);
    
    if (hasNewData) {
        console.log('\n🔔 ОНОВЛЕНА ІНФОРМАЦІЯ!');
        console.log('   • З\'явилися нові дати розкладу');
        console.log('   • АБО оновилась інформація про екстрене відключення');
        
        // Додаємо алерт-подію про оновлення
        const now = new Date();
        const alertEnd = new Date(now.getTime() + 5*60*1000); // 5 хвилин
        
        calendar.createEvent({
            start: now,
            end: alertEnd,
            summary: '🔔 ОНОВЛЕНО: Новий розклад відключень',
            description: 'На сайті ДТЕК з\'явилась оновлена інформація про розклад відключень для вашої адреси.',
            location: `${city}, ${street}, ${house}`,
            status: 'CONFIRMED',
            transp: 'TRANSPARENT',
            alarms: [
                {
                    type: 'display',
                    trigger: { minutes: 0 },
                    description: '🔔 ОНОВЛЕНО: Новий розклад відключень!'
                },
                {
                    type: 'audio',
                    trigger: { minutes: 0 }
                }
            ]
        });
        
        // Перезаписуємо календар з новою подією про оновлення
        const updatedCalendarContent = calendar.toString();
        fs.writeFileSync('dtek.ics', updatedCalendarContent);
    }
    
    console.log(`\n📄 Файл dtek.ics створено (${icsLines} рядків)`);
    console.log('🎉 Успіх!');

  } catch (error) {
    console.error('❌ Помилка:', error.message);
    console.error(error);
  } finally {
    await browser.close();
    console.log('👋 Браузер закрито');
  }
})();
