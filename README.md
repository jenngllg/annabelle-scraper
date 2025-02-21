# Planity Annabelle Scraper

This is a Node.js script that scrapes service data from the Annabelle Institut page on Planity.com and tracks changes over time, sending updates to a Discord webhook.

## Features
- Scrapes service information including category, name, description, duration, and price
- Compares new data with previous scrape to detect changes (additions, modifications, deletions)
- Sends detailed change notifications to Discord
- Saves snapshots as timestamped JSON files

## Prerequisites
- Node.js (v20 or higher recommended)
- npm (Node Package Manager)