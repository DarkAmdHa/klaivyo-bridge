// @ts-check
import { join } from 'path'
import { readFileSync } from 'fs'
import express from 'express'
import cookieParser from 'cookie-parser'
import { Shopify, LATEST_API_VERSION } from '@shopify/shopify-api'

import applyAuthMiddleware from './middleware/auth.js'
import verifyRequest from './middleware/verify-request.js'
import { setupGDPRWebHooks } from './gdpr.js'
import productCreator from './helpers/product-creator.js'
import redirectToAuth from './helpers/redirect-to-auth.js'
import { BillingInterval } from './helpers/ensure-billing.js'
import { AppInstallations } from './app_installations.js'
import { URLSearchParams } from 'url'
import fetch from 'node-fetch'
const encodedParams = new URLSearchParams()

const USE_ONLINE_TOKENS = false

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT, 10)

// TODO: There should be provided by env vars
const DEV_INDEX_PATH = `${process.cwd()}/frontend/`
const PROD_INDEX_PATH = `${process.cwd()}/frontend/dist/`

const DB_PATH = `${process.cwd()}/database.sqlite`
const scopes = process.env.SCOPES.split(',')

Shopify.Context.initialize({
  API_KEY: process.env.SHOPIFY_API_KEY,
  API_SECRET_KEY: process.env.SHOPIFY_API_SECRET,
  SCOPES: scopes,
  HOST_NAME: process.env.HOST.replace(/https?:\/\//, ''),
  HOST_SCHEME: process.env.HOST.split('://')[0],
  API_VERSION: LATEST_API_VERSION,
  IS_EMBEDDED_APP: true,
  SESSION_STORAGE: new Shopify.Session.SQLiteSessionStorage(DB_PATH),
  ...(process.env.SHOP_CUSTOM_DOMAIN && {
    CUSTOM_SHOP_DOMAINS: [process.env.SHOP_CUSTOM_DOMAIN],
  }),
})

Shopify.Webhooks.Registry.addHandler('APP_UNINSTALLED', {
  path: '/api/webhooks',
  webhookHandler: async (_topic, shop, _body) => {
    await AppInstallations.delete(shop)
  },
})

const sendDataToKlaivyo = async (_body, shop) => {
  const klaivyoObject = {
    token: 'RPtAty',
    event: 'Order Delivered',
    customer_properties: {
      $email: _body.email || '',
      $first_name: _body.destination.first_name || '',
      $last_name: _body.destination.last_name || '',
      $phone_number: _body.destination.phone || '',
      $city: _body.destination.city || '',
      $region: _body.destination.province || '',
      $country: _body.destination.country || '',
      $zip: _body.destination.zip || '',
      $adddress1: _body.destination.address1 || '',
      $adddress2: _body.destination.address2 || '',
      $company: _body.destination.company || '',
      $fullname: _body.destination.name || '',
      $orderId: _body.order_id,
    },

    properties: {
      $event_id: _body.order_id,
      $value: 0,
      CourierName: [_body.tracking_company],
      CurrentStatus: [_body.shipment_status],
      OriginAddress: [_body.origin_address],
      OriginalOrderPrice: 0,
      TotalAmountPaid: 0,
      ItemNames: [],
      DeliveredOn: [_body.updated_at],
      Items: [],
      City: [_body.destination.city],
      Province: [_body.destination.province],
      ProvinceCode: [_body.destination.province_code],
      Country: [_body.destination.country],
      ZipCode: [_body.destination.zip],
      CountryCode: [_body.destination.country_code],
      DiscountCodeApplied: [],
    },
  }
  //Push product names
  _body.line_items.forEach((item) => {
    klaivyoObject.properties.ItemNames.push(item.title)
    klaivyoObject.properties.OriginalOrderPrice =
      klaivyoObject.properties.OriginalOrderPrice +
      +(item.price * item.quantity)

    const itemObj = {
      Name: item.title,
      Quantity: item.quantity,
      SKU: item.sku,
      ProductId: item.product_id,
      Price: item.price,
    }

    klaivyoObject.properties.Items.push(itemObj)
  })

  //Get discount codes applied by sending a GraphQl request:
  try {
    const shopSessions =
      await Shopify.Context.SESSION_STORAGE.findSessionsByShop(shop)
    if (shopSessions.length > 0) {
      for (const session of shopSessions) {
        if (session.accessToken) {
          const client = new Shopify.Clients.Graphql(
            session.shop,
            session.accessToken
          )
          const orderDiscountCodes = await client.query({
            data: `query {
                order: order(id: "gid:\/\/shopify\/Order\/${_body.order_id}") {
                  id
                  ... on Order {
                    totalPriceSet { 
                      shopMoney{
                        amount
                      }
                     }   
                    discountCode
                  }
                }
              }`,
          })

          klaivyoObject.properties.TotalAmountPaid =
            +orderDiscountCodes.body.data.order?.totalPriceSet?.shopMoney
              ?.amount

          klaivyoObject.properties.DiscountCodeApplied.push(
            orderDiscountCodes.body.data.order?.discountCode
          )
        }
      }
    }
  } catch (error) {
    if (error?.response?.errors[0]?.message) {
      console.log(error.response.errors[0].message)
    } else {
      console.log(error)
    }
  }
  console.log(klaivyoObject)
  encodedParams.set('data', JSON.stringify(klaivyoObject))
  const url = 'https://a.klaviyo.com/api/track'
  const options = {
    method: 'POST',
    headers: {
      accept: 'text/html',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: encodedParams,
  }
  fetch(url, options)
    .then((res) => res.json())
    .then((json) => console.log(json))
    .catch((err) => console.error('error:' + err))
}

const checkSession = async () => {
  const shop = 'tinystuds.myshopify.com'
  const sessionObj = await Shopify.Context.SESSION_STORAGE.findSessionsByShop(
    shop
  )
  console.log(sessionObj)
}
checkSession()
Shopify.Webhooks.Registry.addHandler('FULFILLMENTS_CREATE', {
  path: '/api/fulfillment-create',
  webhookHandler: async (_topic, shop, _body) => {
    _body = JSON.parse(_body)
    console.log('Created @ ' + shop)
    if (_body.shipment_status === 'delivered') {
      sendDataToKlaivyo(_body, shop)
    }
  },
})
Shopify.Webhooks.Registry.addHandler('FULFILLMENTS_CREATE', {
  path: '//api/fulfillment-create',
  webhookHandler: async (_topic, shop, _body) => {
    console.log('Created @ ' + shop)

    _body = JSON.parse(_body)
    if (_body.shipment_status === 'delivered') {
      sendDataToKlaivyo(_body, shop)
    }
  },
})

Shopify.Webhooks.Registry.addHandler('FULFILLMENTS_UPDATE', {
  path: '/api/fulfillment-update',
  webhookHandler: async (_topic, shop, _body) => {
    _body = JSON.parse(_body)
    console.log('Updated @ ' + shop)
    console.log(_body.shipment_status)
    if (_body.shipment_status === 'delivered') {
      sendDataToKlaivyo(_body, shop)
    }
  },
})

Shopify.Webhooks.Registry.addHandler('FULFILLMENTS_UPDATE', {
  path: '//api/fulfillment-update',
  webhookHandler: async (_topic, shop, _body) => {
    _body = JSON.parse(_body)
    console.log('Updated @ ' + shop)
    console.log(_body.shipment_status)
    if (_body.shipment_status === 'delivered') {
      sendDataToKlaivyo(_body, shop)
    }
  },
})

// The transactions with Shopify will always be marked as test transactions, unless NODE_ENV is production.
// See the ensureBilling helper to learn more about billing in this template.
const BILLING_SETTINGS = {
  required: false,
  // This is an example configuration that would do a one-time charge for $5 (only USD is currently supported)
  // chargeName: "My Shopify One-Time Charge",
  // amount: 5.0,
  // currencyCode: "USD",
  // interval: BillingInterval.OneTime,
}

// This sets up the mandatory GDPR webhooks. You’ll need to fill in the endpoint
// in the “GDPR mandatory webhooks” section in the “App setup” tab, and customize
// the code when you store customer data.
//
// More details can be found on shopify.dev:
// https://shopify.dev/apps/webhooks/configuration/mandatory-webhooks
setupGDPRWebHooks('/api/webhooks')

// export for test use only
export async function createServer(
  root = process.cwd(),
  isProd = process.env.NODE_ENV === 'production',
  billingSettings = BILLING_SETTINGS
) {
  const app = express()

  app.set('use-online-tokens', USE_ONLINE_TOKENS)
  app.use(cookieParser(Shopify.Context.API_SECRET_KEY))

  applyAuthMiddleware(app, {
    billing: billingSettings,
  })

  // Do not call app.use(express.json()) before processing webhooks with
  // Shopify.Webhooks.Registry.process().
  // See https://github.com/Shopify/shopify-api-node/blob/main/docs/usage/webhooks.md#note-regarding-use-of-body-parsers
  // for more details.
  app.post('/api/webhooks', async (req, res) => {
    try {
      await Shopify.Webhooks.Registry.process(req, res)
      console.log(`Webhook processed, returned status code 200`)
    } catch (e) {
      console.log(`Failed to process webhook: ${e.message}`)
      if (!res.headersSent) {
        res.status(500).send(e.message)
      }
    }
  })
  app.post(
    '/:var(api/fulfillment-create|/api/fulfillment-create)',
    async (req, res) => {
      try {
        await Shopify.Webhooks.Registry.process(req, res)
        console.log(`Webhook processed, returned status code 200`)
      } catch (e) {
        console.log(`Failed to process webhook: ${e.message}`)
        if (!res.headersSent) {
          res.status(500).send(e.message)
        }
      }
    }
  )

  app.post(
    '/:var(api/fulfillment-update|/api/fulfillment-update)',
    async (req, res) => {
      try {
        await Shopify.Webhooks.Registry.process(req, res)
        console.log(`Webhook processed, returned status code 200`)
      } catch (e) {
        console.log(`Failed to process webhook: ${e.message}`)
        if (!res.headersSent) {
          res.status(500).send(e.message)
        }
      }
    }
  )

  // All endpoints after this point will require an active session
  app.use(
    '/api/*',
    verifyRequest(app, {
      billing: billingSettings,
    })
  )

  app.get('/api/products/count', async (req, res) => {
    const session = await Shopify.Utils.loadCurrentSession(
      req,
      res,
      app.get('use-online-tokens')
    )
    const { Product } = await import(
      `@shopify/shopify-api/dist/rest-resources/${Shopify.Context.API_VERSION}/index.js`
    )

    const countData = await Product.count({ session })
    res.status(200).send(countData)
  })

  app.get('/api/products/create', async (req, res) => {
    const session = await Shopify.Utils.loadCurrentSession(
      req,
      res,
      app.get('use-online-tokens')
    )
    let status = 200
    let error = null

    try {
      await productCreator(session)
    } catch (e) {
      console.log(`Failed to process products/create: ${e.message}`)
      status = 500
      error = e.message
    }
    res.status(status).send({ success: status === 200, error })
  })

  // All endpoints after this point will have access to a request.body
  // attribute, as a result of the express.json() middleware
  app.use(express.json())

  app.use((req, res, next) => {
    const shop = Shopify.Utils.sanitizeShop(req.query.shop)
    if (Shopify.Context.IS_EMBEDDED_APP && shop) {
      res.setHeader(
        'Content-Security-Policy',
        `frame-ancestors https://${encodeURIComponent(
          shop
        )} https://admin.shopify.com;`
      )
    } else {
      res.setHeader('Content-Security-Policy', `frame-ancestors 'none';`)
    }
    next()
  })

  if (isProd) {
    const compression = await import('compression').then(
      ({ default: fn }) => fn
    )
    const serveStatic = await import('serve-static').then(
      ({ default: fn }) => fn
    )
    app.use(compression())
    app.use(serveStatic(PROD_INDEX_PATH, { index: false }))
  }

  app.use('/*', async (req, res, next) => {
    if (typeof req.query.shop !== 'string') {
      res.status(500)
      return res.send('No shop provided')
    }

    const shop = Shopify.Utils.sanitizeShop(req.query.shop)
    const appInstalled = await AppInstallations.includes(shop)

    if (!appInstalled && !req.originalUrl.match(/^\/exitiframe/i)) {
      return redirectToAuth(req, res, app)
    }

    if (Shopify.Context.IS_EMBEDDED_APP && req.query.embedded !== '1') {
      const embeddedUrl = Shopify.Utils.getEmbeddedAppUrl(req)

      return res.redirect(embeddedUrl + req.path)
    }

    const htmlFile = join(
      isProd ? PROD_INDEX_PATH : DEV_INDEX_PATH,
      'index.html'
    )

    return res
      .status(200)
      .set('Content-Type', 'text/html')
      .send(readFileSync(htmlFile))
  })

  return { app }
}

createServer().then(({ app }) => app.listen(PORT))
