import fs from 'fs'
import puppeteer from 'puppeteer-extra'
import { Logger } from './helpers/logger.js'

import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

const AMAZON_URL = 'https://www.amazon.ca'

const MAX_SEARCH_LINKS = 10

const ASIN_LIST_ATTR = 'data-client-recs-list'
const BREADCRUMB_SELECTOR = '#wayfinding-breadcrumbs_feature_div li:last-of-type a'
const SEARCH_INPUT_SELECTOR = '#twotabsearchtextbox'
const SEARCH_SUBMIT_SELECTOR = '#nav-search-submit-button'
const DEPARTMENT_SELECTOR = '#departments ul li a'
const CAPTCHA_SELECTOR = '#captchacharacters'
const PAGINATION_SELECTOR = '.a-pagination .a-last'
const PAGINATION_SELECTOR_DISABLED_CLASS = 'a-disabled'

class Scraper {
  constructor() {
    this.browser = null
    this.page = null
    this.searchUrls = []
    this.categories = []
  }

  async start() {
    try {
      this.browser = await puppeteer.launch({ headless: false })
      await this.setPage()
      await this.handleParse()
      fs.writeFileSync('output.txt', this.searchUrls.join('\n'))
      Logger.success('DONE. Check output.txt.')
    } catch (err) {
      Logger.error(`Scraper failed: ${err.message}`)
    } finally {
      await this.browser?.close()
      process.exit()
    }
  }

  async setPage() {
    const [page] = await this.browser.pages()
    this.page = page
    await this.page.setViewport({ width: 1920, height: 1080 })
  }

  async setPageInterceptions() {
    await this.page.setRequestInterception(true)
    this.page.on('request', (req) => {
      const blockedResourceTypes = ['image', 'stylesheet', 'font']
      if (blockedResourceTypes.includes(req.resourceType())) {
        return req.abort()
      }

      req.continue()
    })
  }

  async goto(url) {
    const response = await this.page.goto(url, { waitUntil: 'networkidle2' })

    if (response.status() === 429) {
      Logger.error(`429 Too Many Requests error detected: ${url}`)
      return await this.goto(url)
    }

    const isCaptchaVisible = await this.page.$(CAPTCHA_SELECTOR)
    if (isCaptchaVisible) {
      await this.goto(url)
    }
  }

  async getCategorySearchUrl(category) {
    await this.page.waitForSelector(SEARCH_INPUT_SELECTOR)
    await this.page.type(SEARCH_INPUT_SELECTOR, category)

    await this.page.waitForSelector(SEARCH_SUBMIT_SELECTOR)
    await Promise.all([this.page.waitForNavigation(), this.page.click(SEARCH_SUBMIT_SELECTOR)])

    await this.page.waitForSelector(DEPARTMENT_SELECTOR)
    await Promise.all([this.page.waitForNavigation(), this.page.click(DEPARTMENT_SELECTOR)])

    return this.page.url()
  }

  async handleCategorySearch(asin) {
    await this.goto(`${AMAZON_URL}/dp/${asin}`)

    await this.page.waitForSelector(BREADCRUMB_SELECTOR)
    const category = await this.page.$eval(BREADCRUMB_SELECTOR, (el) => el.textContent.trim())

    if (!this.categories.includes(category)) {
      Logger.info(`Category: ${category}`)
      this.categories.push(category)

      const searchUrl = await this.getCategorySearchUrl(category)
      this.searchUrls.push(searchUrl)
    }
  }

  async handleParse() {
    await this.goto(AMAZON_URL)

    const allAsinList = []

    let firstAsinListFound = false
    while (true) {
      const asinListSelector = `[${ASIN_LIST_ATTR}]`
      await this.page.waitForSelector(asinListSelector)

      if (!firstAsinListFound) {
        await this.setPageInterceptions()
        firstAsinListFound = true
      }

      const asinList = await this.page.$eval(
        asinListSelector,
        (el, attr) => JSON.parse(el.getAttribute(attr)).map(({ id }) => id),
        ASIN_LIST_ATTR
      )
      allAsinList.push(...asinList)
      Logger.info(`ASINs on current page: ${asinList.join(', ')}`)

      try {
        await this.page.waitForSelector(PAGINATION_SELECTOR, { timeout: 3000 })

        const isLastPage = await this.page.$eval(
          PAGINATION_SELECTOR,
          (el, className) => el.classList.contains(className),
          PAGINATION_SELECTOR_DISABLED_CLASS
        )
        if (isLastPage) {
          Logger.info('Reached the last page.')
          break
        }

        await Promise.all([this.page.waitForNavigation(), this.page.click(PAGINATION_SELECTOR)])
      } catch (err) {
        Logger.info(
          'Pagination element not found or timeout reached. Likely the last or only page.'
        )
        break
      }
    }

    Logger.info(`Total ${allAsinList.length.toLocaleString('en')} ASINs: ${allAsinList.join(', ')}`)

    console.time('Time')
    for (const asin of allAsinList) {
      if (this.searchUrls.length >= MAX_SEARCH_LINKS) {
        break
      }

      try {
        await this.handleCategorySearch(asin)
      } catch (e) {
        Logger.error(`Error processing ASIN ${asin}: ${e.message}`)
      }
    }
    console.timeEnd('Time')
  }
}

const scraper = new Scraper()
scraper.start()
