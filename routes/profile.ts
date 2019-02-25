import * as AWS from 'aws-sdk'
import * as express from 'express'

import { Services } from '../service'
import { APIerror, APIrequest, APIresponse } from '../types'

const router: express.Router = express.Router()

function setRouters(app: express.Application): void {
  const services: Services = app.get('services')

  router.get('/me', services.auth.verifyToken, (req: APIrequest , res: express.Response) => {
    services.user.get(req, res)
  })

  router.patch('/me', services.auth.verifyToken, (req: APIrequest, res: express.Response) => {
    services.user.update(req, res)
  })

  router.post('/image', services.auth.verifyToken, (req: APIrequest, res: express.Response) => {
    let response: APIresponse = {
      ok: 1,
      code: 200,
    }
    let error: APIerror
    try {
      if (!req.jwt || !req.jwt.uid) {
        error = {
          api: true,
          code: 403,
          message: 'Forbidden',
          friendlyMessage: 'There was a problem updating your timeslots',
        }

        throw error
      }

      req.pipe(req.busboy)
      req.busboy.on('file', (fieldname, file, filename) => {
        // console.log(`Upload of '${filename}' started`)

        uploadToS3UsingStream(
          services,
          req.jwt.uid + filename.slice(-5),
          file,
          req,
          res,
        )
      })
    } catch (err) {
      response = {
        ok: 0,
        code: 500,
      }

      if (err.api) {
        response.code = err.code
        response.message = err.messange
        response.friendlyMessage = err.friendlyMessage
      }
    }

    res.status(response.code).json(response)
  })
}

function uploadToS3UsingStream(services: any, filename: any, stream: any, req: APIrequest, res: express.Response) {
  try {
    if (!process.env.IAM_USER_KEY || !process.env.IAM_USER_SECRET || !process.env.BUCKET_NAME) throw 500

    const s3 = new AWS.S3({
      accessKeyId: process.env.IAM_USER_KEY,
      secretAccessKey: process.env.IAM_USER_SECRET,
    })
    const params = {
      ACL: 'public-read',
      Body: stream,
      Bucket: process.env.BUCKET_NAME,
      Key: filename,
    }
    s3.upload(params, (err, data) => {
      if (err) {
        res.status(404).send(err)
      } else {
        if (!req.jwt || !req.jwt.email) throw 403
        services.user.image(data.Location, req.jwt.email, res, data.Location)
      }
    })
    return 0
  } catch (err) {
    return 1
  }
}

export function init(app: express.Application): express.Router {
  try {
    setRouters(app)
    app.get('logger').verbose('Profile router loaded')
  } catch (err) {
    app.get('logger').error('Could not load profile router')
  }

  return router
}
