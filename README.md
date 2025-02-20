# Anna Belle Scraper

This project is an automated scraping script that extracts service details from the Anna Belle Institut page on [Planity](https://www.planity.com/anna-belle-institut-68000-colmar) and saves them as JSON files. 
It detects changes (additions, modifications, deletions) compared to the previous scrape and sends those differences to a Discord channel via a webhook.

## Features
- Scrapes service families, labels, descriptions, durations, and prices.
- Saves data in timestamped JSON files (e.g., `anna-belle-services-2025-02-20-15-05-00.json`).
- Performs order-independent comparison with the previous file to detect changes.
- Sends only the changes (additions, modifications, deletions) to Discord.
- Automated execution via GitHub Actions.

## Prerequisites
- [Node.js](https://nodejs.org/) (version 20 or higher recommended).
- Dependencies: `puppeteer` and `axios` (installed via `npm install`).
- A Discord webhook URL for notifications.
