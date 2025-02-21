const puppeteer = require('puppeteer');
const fs = require('fs');
const axios = require('axios');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Utility Functions
function getCurrentDateTime() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const hours = String(today.getHours()).padStart(2, '0');
    const minutes = String(today.getMinutes()).padStart(2, '0');
    const seconds = String(today.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
}

function getLatestFile(prefix = 'annabelle-snapshot') {
    const files = fs.readdirSync('.')
        .filter(file => file.startsWith(prefix) && file.endsWith('.json'))
        .sort()
        .reverse();
    return files.length > 0 ? files[0] : null;
}

// Data Processing Functions
function sortServices(services) {
    return services.sort((a, b) => {
        const keyA = `${a.family}|${a.label}`;
        const keyB = `${b.family}|${b.label}`;
        return keyA.localeCompare(keyB);
    }).map(service => ({
        ...service,
        items: service.items.sort((a, b) => {
            const keyA = `${a.description}|${a.duration}|${a.price}`;
            const keyB = `${b.description}|${b.duration}|${b.price}`;
            return keyA.localeCompare(keyB);
        })
    }));
}

function detectChanges(oldServices, newServices) {
    const changes = { added: [], modified: [], removed: [] };
    const oldMap = new Map(oldServices.map(s => [`${s.family}|${s.label}`, s]));
    const newMap = new Map(newServices.map(s => [`${s.family}|${s.label}`, s]));

    newServices.forEach(newService => {
        const key = `${newService.family}|${newService.label}`;
        const oldService = oldMap.get(key);
        if (!oldService) {
            changes.added.push(newService);
        } else if (JSON.stringify(oldService.items) !== JSON.stringify(newService.items)) {
            changes.modified.push({ old: oldService, new: newService });
        }
    });

    oldServices.forEach(oldService => {
        const key = `${oldService.family}|${oldService.label}`;
        if (!newMap.has(key)) {
            changes.removed.push(oldService);
        }
    });

    return changes;
}

// Discord Notification Function
async function sendChangesToDiscord(changes, oldFile, newFile) {
    let message = `**Changes detected** between ${oldFile} and ${newFile}:\n`;
    if (changes.added.length > 0) {
        message += `\n**Additions**:\n` + changes.added.map(service =>
            `- ${service.family} : ${service.label} (${service.items.map(item => `${item.price}, ${item.duration}`).join(', ')})`
        ).join('\n');
    }
    if (changes.modified.length > 0) {
        message += `\n**Modifications**:\n` + changes.modified.map(change =>
            `- ${change.old.family} : ${change.old.label}\n  Old: ${change.old.items.map(item => `${item.price}, ${item.duration}`).join(', ')}\n  New: ${change.new.items.map(item => `${item.price}, ${item.duration}`).join(', ')}`
        ).join('\n');
    }
    if (changes.removed.length > 0) {
        message += `\n**Deletions**:\n` + changes.removed.map(service =>
            `- ${service.family} : ${service.label} (${service.items.map(item => `${item.price}, ${item.duration}`).join(', ')})`
        ).join('\n');
    }
    if (changes.added.length === 0 && changes.modified.length === 0 && changes.removed.length === 0) {
        message += "\nNo specific changes detected";
    }

    try {
        await axios.post(DISCORD_WEBHOOK_URL, { content: message });
        console.log('Changes successfully sent to Discord');
    } catch (error) {
        console.error('Error sending to Discord:', error.message);
    }
}

// Browser Setup Function
async function setupBrowser() {
    return await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        ]
    });
}

// Page Navigation Function
async function navigatePage(browser) {
    const page = await browser.newPage();
    console.log('Navigating to Planity page...');
    await page.goto('https://www.planity.com/anna-belle-institut-68000-colmar', {
        waitUntil: 'networkidle2',
        timeout: 60000
    });
    console.log('Page loaded successfully');
    return page;
}

// Page Content Verification Function
async function verifyPageContent(page) {
    try {
        console.log('Waiting for any content to confirm page load...');
        await page.waitForSelector('body', { timeout: 30000 });
        console.log('Body loaded, waiting for services...');
        await page.waitForSelector('[class*="service-module_name"]', { timeout: 30000 });
    } catch (error) {
        console.error('Failed to find service elements. Saving HTML for debugging...');
        const html = await page.content();
        fs.writeFileSync('error-page.html', html);
        throw error;
    }
}

// Data Extraction Function
async function extractServices(page) {
    fs.writeFileSync('debug-page-expanded.html', await page.content());
    console.log('Saved expanded page HTML to debug-page-expanded.html');

    return await page.evaluate(() => {
        const results = [];
        const showMoreButtons = document.querySelectorAll('[class*="service_set-module_showMore"]');

        if (showMoreButtons.length > 0) {
            console.log(`Found ${showMoreButtons.length} "Show More" buttons, clicking them once...`);
            showMoreButtons.forEach(button => {
                try {
                    button.click();
                    console.log('Clicked a "Show More" button');
                } catch (error) {
                    console.error('Error clicking "Show More" button:', error.message);
                }
            });
        }

        const categoryTitles = document.querySelectorAll('[class*="service_set-module_title"]');
        console.log(`Found ${categoryTitles.length} category titles`);

        const groupedData = new Map();

        categoryTitles.forEach(categoryTitle => {
            const family = categoryTitle.textContent.trim() || 'No category';
            const categoryContainer = categoryTitle.parentElement;
            const services = categoryContainer.querySelectorAll('[class*="service-module_businessService"]');

            console.log(`Found ${services.length} cards in category: ${family}`);
            services.forEach(service => {
                const label = service.querySelector('[class*="service-module_name"]')?.textContent.trim() || '';
                const description = service.querySelector('[class*="service-module_details"]')?.textContent.trim() || '';
                const duration = service.querySelector('[class*="service-module_duration"]')?.textContent.trim() || '';
                const price = service.querySelector('[class*="service-module_price"]')?.textContent.trim() || '';

                if (label) {
                    const key = `${family}|${label}`;
                    if (!groupedData.has(key)) {
                        groupedData.set(key, {
                            family,
                            label,
                            items: []
                        });
                    }
                    groupedData.get(key).items.push({ description, duration, price });
                }
            });
        });

        return Array.from(groupedData.values());
    });
}

// Data Saving Function
async function saveAndCompareData(servicesData) {
    const currentDateTime = getCurrentDateTime();
    const fileName = `annabelle-snapshot-${currentDateTime}.json`;
    const sortedNewData = sortServices(servicesData);
    const jsonData = JSON.stringify(sortedNewData, null, 2);
    const latestFile = getLatestFile();
    let shouldSave = true;

    if (latestFile) {
        const previousRawData = fs.readFileSync(latestFile, 'utf8');
        const previousData = JSON.parse(previousRawData);
        const sortedPreviousData = sortServices(previousData);

        if (JSON.stringify(sortedPreviousData) === JSON.stringify(sortedNewData)) {
            shouldSave = false;
            console.log('Data is identical to the previous file (order-independent), no save performed.');
        } else {
            const changes = detectChanges(previousData, servicesData);
            await sendChangesToDiscord(changes, latestFile, fileName);
        }
    }

    if (shouldSave) {
        fs.writeFileSync(fileName, jsonData);
        console.log(`Data has been saved to ${fileName}`);
    }
}

// Main Function
async function scrapePlanityAnnaBelle() {
    let browser;
    try {
        browser = await setupBrowser();
        const page = await navigatePage(browser);
        await verifyPageContent(page);
        const servicesData = await extractServices(page);
        console.log(`Extracted ${servicesData.length} unique family-label groups`);
        await saveAndCompareData(servicesData);
        console.log('Scraping completed successfully');
    } catch (error) {
        console.error('Error during scraping:', error);
    } finally {
        if (browser) await browser.close();
    }
}

// Execute
scrapePlanityAnnaBelle();