import * as express from 'express'

import { Services } from '../service'

const router: express.Router = express.Router()

function setRouters(app: express.Application): void {
  const services: Services = app.get('services')

  router.post('/login', (req, res) => {
    services.auth.login(req, res)
  })

  router.post('/register', (req, res) => {
    services.auth.register(req, res)
  })

  router.post('/forgotmypassword', (req, res) => {
    services.auth.resetPassword(req, res)
  })

  router.post('/changemyemail', (req, res) => {
    services.auth.changeEmail(req, res)
  })
}

export function init(app: express.Application): express.Router {
  try {
    setRouters(app)
    app.get('logger').verbose('Authentication router loaded')
  } catch (err) {
    app.get('logger').error('Could not load authentication router')
  }

  return router
}