const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.dtek-kem.com.ua/ua/shutdowns', { waitUntil: 'networkidle' });
  
  const globalFact = await page.evaluate(() => {
    return typeof DisconSchedule !== 'undefined' && DisconSchedule.fact ? DisconSchedule.fact : null;
  });
  
  if (globalFact && globalFact.data) {
    console.log('=== Графік для черги GPV5.1 ===');
    Object.entries(globalFact.data).forEach(([ts, dayData]) => {
      const date = new Date(parseInt(ts) * 1000);
      console.log('\n📅', date.toLocaleDateString('uk-UA'));
      if (dayData['GPV5.1']) {
        const schedule = dayData['GPV5.1'];
        const hours = Object.keys(schedule).map(Number).sort((a,b) => a-b);
        hours.forEach(h => {
          console.log(`  ${String(h).padStart(2, '0')}:00 - ${schedule[h]}`);
        });
      } else {
        console.log('  Немає даних');
      }
    });
  }
  
  await browser.close();
})();
