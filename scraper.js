const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const fsSync = require('fs');
const axios = require('axios');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    PLANITY_URL: 'https://www.planity.com/anna-belle-institut-68000-colmar',
    SNAPSHOT_PREFIX: 'annabelle-snapshot',
    SELECTORS: {
        body: 'body',
        categoryTitle: '[class*="service_set-module_title"]',
        showMoreButton: '[class*="service_set-module_showMore"]',
        serviceCard: '[class*="service-module_businessService"]',
        serviceName: '[class*="service-module_name"]',
        serviceDetails: '[class*="service-module_details"]',
        serviceDuration: '[class*="service-module_duration"]',
        servicePrice: '[class*="service-module_price"]'
    },
    TIMEOUTS: {
        navigation: 60000,
        elementWait: 30000
    },
    DISCORD_MESSAGE_LIMIT: 2000
};

// ============================================================================
// UTILITY CLASSES
// ============================================================================

class DateTimeHelper {
    /**
     * Génère un timestamp formaté pour les noms de fichiers
     * @returns {string} Format: YYYYMMDD_HHMMSS
     */
    static getCurrentDateTime() {
        const now = new Date();
        return [
            now.getUTCFullYear(),
            String(now.getUTCMonth() + 1).padStart(2, '0'),
            String(now.getUTCDate()).padStart(2, '0')
        ].join('') + '_' + [
            String(now.getUTCHours()).padStart(2, '0'),
            String(now.getUTCMinutes()).padStart(2, '0'),
            String(now.getUTCSeconds()).padStart(2, '0')
        ].join('');
    }
}

class FileManager {
    /**
     * Récupère le dernier fichier snapshot
     * @param {string} prefix - Préfixe du fichier
     * @returns {string|null} Nom du fichier ou null
     */
    static getLatestSnapshot(prefix = CONFIG.SNAPSHOT_PREFIX) {
        try {
            const files = fsSync.readdirSync('.')
                .filter(file => file.startsWith(prefix) && file.endsWith('.json'))
                .sort()
                .reverse();
            
            return files.length > 0 ? files[0] : null;
        } catch (error) {
            console.error('Erreur lors de la lecture des fichiers:', error.message);
            return null;
        }
    }

    /**
     * Lit et parse un fichier JSON
     * @param {string} filename - Nom du fichier
     * @returns {Promise<object|null>} Données parsées ou null
     */
    static async readJsonFile(filename) {
        try {
            const content = await fs.readFile(filename, 'utf8');
            return JSON.parse(content);
        } catch (error) {
            console.error(`Erreur lors de la lecture de ${filename}:`, error.message);
            return null;
        }
    }

    /**
     * Sauvegarde des données en JSON
     * @param {string} filename - Nom du fichier
     * @param {object} data - Données à sauvegarder
     */
    static async saveJsonFile(filename, data) {
        await fs.writeFile(filename, JSON.stringify(data, null, 2));
    }

    /**
     * Sauvegarde du HTML pour debug
     * @param {string} filename - Nom du fichier
     * @param {string} html - Contenu HTML
     */
    static async saveDebugHtml(filename, html) {
        await fs.writeFile(filename, html);
        console.log(`HTML de debug sauvegardé dans ${filename}`);
    }
}

// ============================================================================
// SERVICE DATA PROCESSING
// ============================================================================

class ServiceDataProcessor {
    /**
     * Trie les services par famille et label
     * @param {Array} services - Liste des services
     * @returns {Array} Services triés
     */
    static sortServices(services) {
        return services
            .sort((a, b) => this._compareServiceKeys(a, b))
            .map(service => ({
                ...service,
                items: this._sortServiceItems(service.items)
            }));
    }

    static _compareServiceKeys(a, b) {
        const keyA = `${a.family}|${a.label}`;
        const keyB = `${b.family}|${b.label}`;
        return keyA.localeCompare(keyB);
    }

    static _sortServiceItems(items) {
        return items.sort((a, b) => {
            const keyA = `${a.description}|${a.duration}|${a.price}`;
            const keyB = `${b.description}|${b.duration}|${b.price}`;
            return keyA.localeCompare(keyB);
        });
    }

    /**
     * Crée une clé unique pour un service
     * @param {string} family - Famille du service
     * @param {string} label - Label du service
     * @returns {string} Clé unique
     */
    static createServiceKey(family, label) {
        return `${family}|${label}`;
    }
}

// ============================================================================
// CHANGE DETECTION
// ============================================================================

class ChangeDetector {
    /**
     * Détecte les changements entre deux ensembles de services
     * @param {Array} previousServices - Services précédents
     * @param {Array} currentServices - Services actuels
     * @returns {object} Changements détectés
     */
    static detectChanges(previousServices, currentServices) {
        const changes = {
            added: [],
            modified: [],
            removed: []
        };

        const previousMap = this._createServiceMap(previousServices);
        const currentMap = this._createServiceMap(currentServices);

        this._detectAddedAndModified(currentServices, previousMap, changes);
        this._detectRemoved(previousServices, currentMap, changes);

        return changes;
    }

    static _createServiceMap(services) {
        return new Map(
            services.map(s => [
                ServiceDataProcessor.createServiceKey(s.family, s.label),
                s
            ])
        );
    }

    static _detectAddedAndModified(currentServices, previousMap, changes) {
        currentServices.forEach(currentService => {
            const key = ServiceDataProcessor.createServiceKey(
                currentService.family,
                currentService.label
            );
            const previousService = previousMap.get(key);

            if (!previousService) {
                // Nouvelle famille/label complète
                currentService.items.forEach(item => {
                    changes.added.push({
                        family: currentService.family,
                        label: currentService.label,
                        item
                    });
                });
                return;
            }

            const previousItemsSet = new Set(
                previousService.items.map(item => JSON.stringify(item))
            );

            currentService.items.forEach(currentItem => {
                const itemKey = JSON.stringify(currentItem);

                if (!previousItemsSet.has(itemKey)) {
                    const matchingPreviousItem = this._findMatchingItem(
                        previousService.items,
                        currentItem
                    );

                    if (matchingPreviousItem) {
                        changes.modified.push({
                            family: currentService.family,
                            label: currentService.label,
                            items: [{
                                before: matchingPreviousItem,
                                after: currentItem
                            }]
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
        });
    }

    static _detectRemoved(previousServices, currentMap, changes) {
        previousServices.forEach(previousService => {
            const key = ServiceDataProcessor.createServiceKey(
                previousService.family,
                previousService.label
            );
            const currentService = currentMap.get(key);

            if (!currentService) {
                // Famille/label complète supprimée
                previousService.items.forEach(item => {
                    changes.removed.push({
                        family: previousService.family,
                        label: previousService.label,
                        item
                    });
                });
                return;
            }

            const currentItemsSet = new Set(
                currentService.items.map(item => JSON.stringify(item))
            );

            previousService.items.forEach(prevItem => {
                const itemKey = JSON.stringify(prevItem);

                if (!currentItemsSet.has(itemKey)) {
                    const matchingCurrentItem = this._findMatchingItem(
                        currentService.items,
                        prevItem
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
        });
    }

    static _findMatchingItem(items, targetItem) {
        return items.find(item =>
            item.duration === targetItem.duration ||
            item.price === targetItem.price
        );
    }
}

// ============================================================================
// DISCORD NOTIFICATIONS
// ============================================================================

class DiscordNotifier {
    /**
     * Envoie les changements vers Discord
     * @param {object} changes - Changements détectés
     * @param {string} previousFile - Nom du fichier précédent
     * @param {string} currentFile - Nom du fichier actuel
     */
    static async sendChanges(changes, previousFile, currentFile) {
        if (!CONFIG.DISCORD_WEBHOOK_URL) {
            console.warn('⚠️  DISCORD_WEBHOOK_URL non configuré, notification ignorée');
            return;
        }

        const message = this._formatChangeMessage(changes, previousFile, currentFile);
        await this._sendToDiscord(message);
    }

    static _formatChangeMessage(changes, previousFile, currentFile) {
        const sections = [];

        sections.push(`**🔍 Changements détectés**`);
        sections.push(`📁 Comparaison: \`${previousFile}\` → \`${currentFile}\``);

        if (changes.removed.length > 0) {
            sections.push(''); // Saut de ligne
            sections.push(this._formatRemovedSection(changes.removed));
        }

        if (changes.added.length > 0) {
            sections.push(''); // Saut de ligne
            sections.push(this._formatAddedSection(changes.added));
        }

        if (changes.modified.length > 0) {
            sections.push(''); // Saut de ligne
            sections.push(this._formatModifiedSection(changes.modified));
        }

        if (changes.added.length === 0 && 
            changes.modified.length === 0 && 
            changes.removed.length === 0) {
            sections.push('');
            sections.push('ℹ️  Aucun changement spécifique détecté');
        }

        return sections.join('\n');
    }

    static _formatRemovedSection(removed) {
        const lines = [`**❌ Services supprimés (${removed.length}):**`];
        
        removed.forEach((change, index) => {
            const item = change.item;
            lines.push(`\`${index + 1}.\` **${change.family}** › ${change.label}`);
            lines.push(`   └ ${item.description || 'Sans description'} • ${item.duration} • ${item.price}`);
        });

        return lines.join('\n');
    }

    static _formatAddedSection(added) {
        const lines = [`**✅ Nouveaux services (${added.length}):**`];
        
        added.forEach((change, index) => {
            const item = change.item;
            lines.push(`\`${index + 1}.\` **${change.family}** › ${change.label}`);
            lines.push(`   └ ${item.description || 'Sans description'} • ${item.duration} • ${item.price}`);
        });

        return lines.join('\n');
    }

    static _formatModifiedSection(modified) {
        const lines = [`**🔄 Services modifiés (${modified.length}):**`];
        
        modified.forEach((change, index) => {
            lines.push(`\`${index + 1}.\` **${change.family}** › ${change.label}`);
            
            change.items.forEach(itemChange => {
                const before = itemChange.before;
                const after = itemChange.after;
                
                // Détection du type de modification
                const changes = [];
                
                if (before.description !== after.description) {
                    changes.push(`Description: "${before.description}" → "${after.description}"`);
                }
                if (before.duration !== after.duration) {
                    changes.push(`Durée: ~~${before.duration}~~ → ${after.duration}`);
                }
                if (before.price !== after.price) {
                    changes.push(`Prix: ~~${before.price}~~ → ${after.price}`);
                }
                
                changes.forEach(c => lines.push(`   └ ${c}`));
            });
        });

        return lines.join('\n');
    }

    static async _sendToDiscord(message) {
        const messages = this._splitMessage(message);

        try {
            for (const msg of messages) {
                await axios.post(CONFIG.DISCORD_WEBHOOK_URL, { content: msg });
                // Petit délai pour éviter le rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            console.log('✅ Changements envoyés à Discord avec succès');
        } catch (error) {
            console.error('❌ Erreur lors de l\'envoi à Discord:', error.message);
            throw error;
        }
    }

    static _splitMessage(message) {
        const messages = [];
        let currentMessage = '';

        for (const line of message.split('\n')) {
            if (currentMessage.length + line.length + 1 > CONFIG.DISCORD_MESSAGE_LIMIT) {
                if (currentMessage) messages.push(currentMessage);
                currentMessage = line;
            } else {
                currentMessage += (currentMessage ? '\n' : '') + line;
            }
        }

        if (currentMessage) messages.push(currentMessage);
        return messages;
    }
}

// ============================================================================
// WEB SCRAPING
// ============================================================================

class PlanityScraper {
    constructor() {
        this.browser = null;
        this.page = null;
    }

    /**
     * Lance le navigateur Puppeteer
     */
    async launchBrowser() {
        console.log('🚀 Lancement du navigateur...');
        this.browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ]
        });
    }

    /**
     * Navigue vers la page Planity
     */
    async navigateToPage() {
        this.page = await this.browser.newPage();
        
        console.log('📄 Navigation vers la page Planity...');
        await this.page.goto(CONFIG.PLANITY_URL, {
            waitUntil: 'networkidle2',
            timeout: CONFIG.TIMEOUTS.navigation
        });
        
        console.log('✅ Page chargée avec succès');
    }

    /**
     * Vérifie que le contenu de la page est bien chargé
     */
    async verifyPageContent() {
        try {
            console.log('⏳ Vérification du chargement du contenu...');
            
            await this.page.waitForSelector(CONFIG.SELECTORS.body, {
                timeout: CONFIG.TIMEOUTS.elementWait
            });
            
            await this.page.waitForSelector(CONFIG.SELECTORS.serviceName, {
                timeout: CONFIG.TIMEOUTS.elementWait
            });
            
            console.log('✅ Contenu vérifié avec succès');
        } catch (error) {
            console.error('❌ Échec de la vérification du contenu');
            const html = await this.page.content();
            await FileManager.saveDebugHtml('error-page.html', html);
            throw new Error('Impossible de trouver les éléments de service sur la page');
        }
    }

    /**
     * Extrait les données des services depuis la page
     * @returns {Promise<Array>} Liste des services
     */
    async extractServices() {
        console.log('🔍 Extraction des services...');

        // Sauvegarde du HTML pour debug
        const html = await this.page.content();
        await FileManager.saveDebugHtml('debug-page.html', html);

        const services = await this.page.evaluate((selectors) => {
            // Clic sur tous les boutons "Voir plus"
            const showMoreButtons = document.querySelectorAll(selectors.showMoreButton);
            if (showMoreButtons.length > 0) {
                console.log(`Clic sur ${showMoreButtons.length} boutons "Voir plus"`);
                showMoreButtons.forEach(button => {
                    try {
                        button.click();
                    } catch (error) {
                        console.error('Erreur lors du clic:', error.message);
                    }
                });
            }

            // Extraction des données
            const groupedData = new Map();
            const categoryTitles = document.querySelectorAll(selectors.categoryTitle);
            
            console.log(`Trouvé ${categoryTitles.length} catégories`);

            categoryTitles.forEach(categoryTitle => {
                const family = categoryTitle.textContent.trim() || 'Sans catégorie';
                const categoryContainer = categoryTitle.parentElement;
                const serviceCards = categoryContainer.querySelectorAll(selectors.serviceCard);

                console.log(`${serviceCards.length} services dans la catégorie: ${family}`);

                serviceCards.forEach(card => {
                    const label = card.querySelector(selectors.serviceName)?.textContent.trim() || '';
                    const description = card.querySelector(selectors.serviceDetails)?.textContent.trim() || '';
                    const duration = card.querySelector(selectors.serviceDuration)?.textContent.trim() || '';
                    const price = card.querySelector(selectors.servicePrice)?.textContent.trim() || '';

                    if (label) {
                        const key = `${family}|${label}`;
                        
                        if (!groupedData.has(key)) {
                            groupedData.set(key, {
                                family,
                                label,
                                items: []
                            });
                        }

                        groupedData.get(key).items.push({
                            description,
                            duration,
                            price
                        });
                    }
                });
            });

            return Array.from(groupedData.values());
        }, CONFIG.SELECTORS);

        console.log(`✅ ${services.length} groupes famille-label extraits`);
        return services;
    }

    /**
     * Ferme le navigateur
     */
    async close() {
        if (this.browser) {
            await this.browser.close();
            console.log('🔒 Navigateur fermé');
        }
    }
}

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

class PlanityMonitor {
    /**
     * Exécute le processus complet de scraping et de comparaison
     */
    static async run() {
        const scraper = new PlanityScraper();

        try {
            // Phase 1: Scraping
            await scraper.launchBrowser();
            await scraper.navigateToPage();
            await scraper.verifyPageContent();
            const servicesData = await scraper.extractServices();

            // Phase 2: Traitement et sauvegarde
            await this._processAndSaveData(servicesData);

            console.log('🎉 Scraping terminé avec succès');
        } catch (error) {
            console.error('❌ Erreur durant le scraping:', error.message);
            console.error(error.stack);
            throw error;
        } finally {
            await scraper.close();
        }
    }

    /**
     * Traite et sauvegarde les données extraites
     * @param {Array} servicesData - Données des services
     */
    static async _processAndSaveData(servicesData) {
        const currentDateTime = DateTimeHelper.getCurrentDateTime();
        const currentFile = `${CONFIG.SNAPSHOT_PREFIX}-${currentDateTime}.json`;
        const sortedCurrentData = ServiceDataProcessor.sortServices(servicesData);
        const previousFile = FileManager.getLatestSnapshot();

        let shouldSave = true;

        if (previousFile) {
            console.log(`📊 Comparaison avec ${previousFile}...`);
            
            const previousData = await FileManager.readJsonFile(previousFile);
            
            if (previousData) {
                const sortedPreviousData = ServiceDataProcessor.sortServices(previousData);

                if (JSON.stringify(sortedPreviousData) === JSON.stringify(sortedCurrentData)) {
                    shouldSave = false;
                    console.log('ℹ️  Données identiques au fichier précédent, pas de sauvegarde');
                } else {
                    console.log('🔄 Changements détectés, analyse en cours...');
                    const changes = ChangeDetector.detectChanges(previousData, servicesData);
                    await DiscordNotifier.sendChanges(changes, previousFile, currentFile);
                }
            }
        } else {
            console.log('ℹ️  Premier snapshot, aucune comparaison possible');
        }

        if (shouldSave) {
            await FileManager.saveJsonFile(currentFile, sortedCurrentData);
            console.log(`💾 Données sauvegardées dans ${currentFile}`);
        }
    }
}

// ============================================================================
// EXECUTION
// ============================================================================

if (require.main === module) {
    PlanityMonitor.run()
        .then(() => {
            console.log('✨ Programme terminé');
            process.exit(0);
        })
        .catch(error => {
            console.error('💥 Erreur fatale:', error);
            process.exit(1);
        });
}

module.exports = {
    PlanityMonitor,
    ChangeDetector,
    ServiceDataProcessor,
    DiscordNotifier
};