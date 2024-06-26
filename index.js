import fs from 'fs'
import puppeteer from 'puppeteer-extra'
import { Logger } from './helpers/logger.js'

import StealthPlugin from 'puppeteer-extra-plugin-stealth'
puppeteer.use(StealthPlugin())

const AMAZON_CA_URL = 'https://www.amazon.ca'
const MOVERS_AND_SHAKERS_URL = `${AMAZON_CA_URL}/gp/movers-and-shakers`

const MAX_SEARCH_LINKS = 10

const PRODUCTS_LIST_ATTR = 'data-client-recs-list'
const BREADCRUMB_SELECTOR = '#wayfinding-breadcrumbs_feature_div li:last-of-type a'
const SEARCH_INPUT_SELECTOR = '#twotabsearchtextbox'
const SEARCH_SUBMIT_SELECTOR = '#nav-search-submit-button'
const DEPARTMENT_SELECTOR = '#departments ul li a'
const CAPTCHA_SELECTOR = '#captchacharacters'

const MUST_SUCCESS_AJAX_URLS = ['/*.amazon.com/ah/ajax/counter']
const REJECTED_URL_PATTERNS = [
  'googlesyndication.com',
  '/*.doubleclick.net',
  '/*.amazon-adsystem.com',
  '/*.adnxs.com',
]
const REJECTED_RESOURCE_TYPES = ['stylesheet', 'image', 'media', 'font']

const start = async () => {
  const searchLinks = []
  const categories = []

  let browser
  try {
    browser = await puppeteer.launch({
      headless: false,
    })

    const setPageRequestInterception = async (page, allowedResourceTypes = []) => {
      await page.setRequestInterception(true)
      page.on('request', async (req) => {
        const resourceType = req.resourceType()
        const url = req.url()

        const isUnnecessaryResourceType =
          !allowedResourceTypes.includes(resourceType) &&
          REJECTED_RESOURCE_TYPES.includes(resourceType)
        const isUnnecessaryUrl = REJECTED_URL_PATTERNS.find((pattern) => url.match(pattern))

        if (isUnnecessaryResourceType || isUnnecessaryUrl) {
          req.abort()
        } else {
          req.continue()
        }
      })
      page.on('response', async (res) => {
        const url = res.url()

        if (res.ok()) {
          try {
            await page.waitForSelector(CAPTCHA_SELECTOR, { timeout: 0 })
            Logger.error('Captcha')
            await page.reload(url)
          } catch (err) {}
        } else {
          const status = res.status()

          Logger.error(`${status}: "${url}"`)

          if (MUST_SUCCESS_AJAX_URLS.find((pattern) => url.match(pattern))) {
            await page.reload(url)
          } else if (status === 429) {
            await page.goto(url)
          }
        }
      })
    }
    const goto = (url, callback, allowedResourceTypes) => {
      return new Promise(async (resolve, reject) => {
        let page
        try {
          page = await browser.newPage()
          await setPageRequestInterception(page, allowedResourceTypes)

          Logger.info(url)
          await page.goto(url)
          await callback(page)
          resolve()
        } catch (err) {
          Logger.error(err)
          reject(err)
        }
        page?.close()
      })
    }

    const getCategorySearchLink = async (url, category) => {
      let searchUrl

      await goto(url, async (page) => {
        await page.waitForSelector(SEARCH_INPUT_SELECTOR)
        await page.type(SEARCH_INPUT_SELECTOR, category)

        await page.waitForSelector(SEARCH_SUBMIT_SELECTOR)
        await page.bringToFront()
        await Promise.all([page.click(SEARCH_SUBMIT_SELECTOR), page.waitForNavigation()])

        await page.waitForSelector(DEPARTMENT_SELECTOR)
        await page.bringToFront()
        await Promise.all([
          page.$eval(DEPARTMENT_SELECTOR, (el) => el.click()),
          page.waitForNavigation(),
        ])

        await page.waitForSelector(SEARCH_SUBMIT_SELECTOR)
        await page.bringToFront()
        await Promise.all([page.click(SEARCH_SUBMIT_SELECTOR), page.waitForNavigation()])

        searchUrl = page.url()
      })

      return searchUrl
    }

    const getProductCategorySearchLinks = async (productId) => {
      let category

      try {
        await goto(`${AMAZON_CA_URL}/dp/${productId}`, async (page) => {
          await page.waitForSelector(BREADCRUMB_SELECTOR)
          category = await page.$eval(BREADCRUMB_SELECTOR, (el) => el.textContent.trim())
        })
      } catch (err) {}

      if (category !== undefined && !categories.includes(category)) {
        Logger.info('Category', category)
        try {
          const amazonCaSearchLink = await getCategorySearchLink(AMAZON_CA_URL, category)
          if (searchLinks.length < MAX_SEARCH_LINKS) {
            searchLinks.push(amazonCaSearchLink)
          }
        } catch (err) {}
      }
    }

    const handleMoversAndShakers = async () => {
      let productsAsin = []

      try {
        await goto(
          MOVERS_AND_SHAKERS_URL,
          async (page) => {
            const selector = `[${PRODUCTS_LIST_ATTR}]`
            await page.waitForSelector(selector)

            console.time('Time')

            productsAsin = await page.$eval(
              selector,
              (el, attr) => JSON.parse(el.getAttribute(attr)).map(({ id }) => id),
              PRODUCTS_LIST_ATTR
            )
            Logger.info(`\nASIN: ${productsAsin}\n`)
          },
          ['stylesheet']
        )
      } catch (err) {}

      for (const productId of productsAsin) {
        await getProductCategorySearchLinks(productId)

        if (searchLinks.length >= MAX_SEARCH_LINKS) {
          break
        }
      }
    }

    await handleMoversAndShakers()

    console.timeEnd('Time')

    fs.writeFileSync('output.txt', searchLinks.join('\n'))
    Logger.success('DONE. Check output.txt.')
  } catch (err) {
    Logger.error(err)
  } finally {
    browser?.close()
    process.exit()
  }
}
start()
