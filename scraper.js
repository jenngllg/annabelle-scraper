const puppeteer = require('puppeteer');
const fs = require('fs');
const axios = require('axios');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Utility Functions
function getCurrentDateTime() {
    const today = new Date();
    const year = today.getUTCFullYear();
    const month = String(today.getUTCMonth() + 1).padStart(2, '0');
    const day = String(today.getUTCDate()).padStart(2, '0');
    const hours = String(today.getUTCHours()).padStart(2, '0');
    const minutes = String(today.getUTCMinutes()).padStart(2, '0');
    const seconds = String(today.getUTCSeconds()).padStart(2, '0');
    return `${year}${month}${day}_${hours}${minutes}${seconds}`;
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

function detectChanges(previousServices, currentServices) {
    const changes = { added: [], modified: [], removed: [] };
    const previousMap = new Map(previousServices.map(s => [`${s.family}|${s.label}`, s]));
    const currentMap = new Map(currentServices.map(s => [`${s.family}|${s.label}`, s]));

    // Compare current vs previous for each family|label group
    currentServices.forEach(currentService => {
        const key = `${currentService.family}|${currentService.label}`;
        const previousService = previousMap.get(key);

        if (previousService) { // Family|label exists in both
            const previousItemsMap = new Map(previousService.items.map(item => [JSON.stringify(item), item]));
            const currentItemsMap = new Map(currentService.items.map(item => [JSON.stringify(item), item]));

            // Detect added items
            currentService.items.forEach(currentItem => {
                const currentItemKey = JSON.stringify(currentItem);
                if (!previousItemsMap.has(currentItemKey)) {
                    const matchingPreviousItem = previousService.items.find(prevItem => 
                        prevItem.duration === currentItem.duration || prevItem.price === currentItem.price
                    );
                    if (matchingPreviousItem) {
                        changes.modified.push({
                            family: currentService.family,
                            label: currentService.label,
                            items: [{ before: matchingPreviousItem, after: currentItem }]
                        });
                    } else {
                        changes.added.push({
                            family: currentService.family,
                            label: currentService.label,
                            item: currentItem
                        });
                    }
                }
            });

            // Detect removed items
            previousService.items.forEach(prevItem => {
                const prevItemKey = JSON.stringify(prevItem);
                if (!currentItemsMap.has(prevItemKey)) {
                    const matchingCurrentItem = currentService.items.find(currItem => 
                        currItem.duration === prevItem.duration || currItem.price === prevItem.price
                    );
                    if (!matchingCurrentItem) {
                        changes.removed.push({
                            family: previousService.family,
                            label: previousService.label,
                            item: prevItem
                        });
                    }
                }
            });
        }
    });

    return changes;
}

// Discord Notification Function
async function sendChangesToDiscord(changes, previousFile, currentFile) {
    let message = `**Changes detected between ${previousFile} and ${currentFile}:**\n`;

    if (changes.removed.length > 0) {
        message += `\n**Removed services**:\n`;
        message += `\`\`\`json\n${JSON.stringify(
            changes.removed.map(change => ({
                family: change.family,
                label: change.label,
                items: [change.item]
            })),
            null, 2
        )}\n\`\`\``;
    }

    if (changes.added.length > 0) {
        message += `\n**New services**:\n`;
        message += `\`\`\`json\n${JSON.stringify(
            changes.added.map(change => ({
                family: change.family,
                label: change.label,
                items: [change.item]
            })),
            null, 2
        )}\n\`\`\``;
    }

    if (changes.modified.length > 0) {
        message += `\n**Updated services**:\n`;
        message += `\`\`\`json\n${JSON.stringify(
            changes.modified.map(change => ({
                family: change.family,
                label: change.label,
                items: change.items
            })),
            null, 2
        )}\n\`\`\``;
    }

    if (changes.added.length === 0 && changes.modified.length === 0 && changes.removed.length === 0) {
        message += "\nNo specific changes detected";
    }

    try {
        const messages = [];
        let currentMessage = '';
        for (const line of message.split('\n')) {
            if (currentMessage.length + line.length + 1 > 2000) {
                messages.push(currentMessage);
                currentMessage = line;
            } else {
                currentMessage += (currentMessage ? '\n' : '') + line;
            }
        }
        if (currentMessage) messages.push(currentMessage);

        for (const msg of messages) {
            await axios.post(DISCORD_WEBHOOK_URL, { content: msg });
        }
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
    const currentFile = `annabelle-snapshot-${currentDateTime}.json`;
    const sortedCurrentData = sortServices(servicesData);
    const jsonData = JSON.stringify(sortedCurrentData, null, 2);
    const previousFile = getLatestFile();
    let shouldSave = true;

    if (previousFile) {
        const previousRawData = fs.readFileSync(previousFile, 'utf8');
        const previousData = JSON.parse(previousRawData);
        const sortedPreviousData = sortServices(previousData);

        if (JSON.stringify(sortedPreviousData) === JSON.stringify(sortedCurrentData)) {
            shouldSave = false;
            console.log('Data is identical to the previous file (order-independent), no save performed.');
        } else {
            const changes = detectChanges(previousData, servicesData);
            await sendChangesToDiscord(changes, previousFile, currentFile);
        }
    }

    if (shouldSave) {
        fs.writeFileSync(currentFile, jsonData);
        console.log(`Data has been saved to ${currentFile}`);
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