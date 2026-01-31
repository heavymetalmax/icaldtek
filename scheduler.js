const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'scheduler.log');
const CHECK_INTERVAL = 15 * 60 * 1000; // 15 хвилин в мілісекундах

function log(message) {
    const timestamp = new Date().toLocaleString('uk-UA');
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    
    // Додаємо до лог-файлу
    fs.appendFileSync(LOG_FILE, logMessage + '\n');
}

function runScript() {
    log('🚀 Запускаємо перевірку оновлень...');
    
    const child = spawn('node', ['index.js'], {
        cwd: __dirname,
        stdio: 'pipe'
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        process.stdout.write(chunk);
    });

    child.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        process.stderr.write(chunk);
    });

    child.on('close', (code) => {
        if (code === 0) {
            log('✅ Перевірка завершена успішно');
            
            // Перевіримо чи було оновлено календар
            const icsPath = path.join(__dirname, 'dtek.ics');
            if (fs.existsSync(icsPath)) {
                const stats = fs.statSync(icsPath);
                log(`📅 Календар оновлено: ${stats.size} байтів`);
            }
        } else {
            log(`❌ Помилка при виконанні скрипту (код: ${code})`);
        }
        
        // Наступна перевірка через 15 хвилин
        scheduleNextCheck();
    });
}

function scheduleNextCheck() {
    const nextCheck = new Date(Date.now() + CHECK_INTERVAL);
    log(`⏰ Наступна перевірка: ${nextCheck.toLocaleString('uk-UA')}`);
    
    setTimeout(() => {
        runScript();
    }, CHECK_INTERVAL);
}

// Запуск при старті
log('═══════════════════════════════════════════════════════════');
log('🌐 ДТЕК Календар - Автоматична система перевірки оновлень');
log('═══════════════════════════════════════════════════════════');
log(`Інтервал перевірки: ${CHECK_INTERVAL / 60000} хвилин`);
log('');

// Початковий запуск
runScript();

// Обробка сигналів для корректного завершення
process.on('SIGINT', () => {
    log('\n⛔ Завершення програми...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('\n⛔ Сигнал завершення отримано');
    process.exit(0);
});
