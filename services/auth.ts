// get local (folder) environment variables
require('dotenv').config()

import * as express from 'express'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import * as jwt from 'jsonwebtoken'

import { service } from '../service'
import { APIresponse, APIrequest, JWTpayload } from '../types'
import { sql } from '../utils'

export class AuthService extends service {
  constructor(app: express.Application) {
    super(app)

    if(this.logger) this.logger.verbose('Auth service loaded')
  }

  verifyToken(req: APIrequest, res: express.Response, next: express.NextFunction) {
    let token = req.cookies['access_token']

    try {
      if(!token) throw 403;

      let pk: string
      if(process.env.CONNECT_PK) pk = process.env.CONNECT_PK
      else throw 500

      let decoded = jwt.verify(token, pk)
      if(decoded instanceof Object) req.jwt = decoded

      next()
    } catch (err) {
      let response: APIresponse = {
        ok: 0,
        code: 403,
        message: 'The JWT token is not valid'
      }

      if(err.name === 'TokenExpiredError') {
        response.code = 403
        response.message = 'Session expired'
      }

      res.status(response.code).json(response)
    }
  }


  isMentor(req: APIrequest, res: express.Response, next: express.NextFunction) {
    if(req.jwt && req.jwt.aud === 'mentor') next()
    else {
      let response: APIresponse = {
        ok: 0,
        code: 403,
        message: 'You\'re not a mentor'
      }
      res.status(response.code).json(response)
    }
  }

  createToken(user: JWTpayload , accountType): string {
    if(process.env.CONNECT_PK) {
      return jwt.sign(user, process.env.CONNECT_PK, {expiresIn: (86400 * 15) , audience: accountType})
    } else return ''
  }

  async login(req: express.Request, res: express.Response) {
    let sql = 'SELECT * FROM users WHERE email = ?',
      response: APIresponse = {
        ok: 1,
        code: 200
      }

    let [rows] = await this.database.query(sql, req.body.email)
    if(rows.length) {
      try {
        if(bcrypt.compareSync(req.body.password, rows[0].password)) {
          response.token = this.createToken({
            email: rows[0].email,
            uid: rows[0].uid
          }, rows[0].type)

          res.cookie('access_token', response.token, {expires: new Date(Date.now() + 86400 * 15e3), httpOnly: true})
        } else throw 401
      } catch (err) {
        response.ok = 0
        response.code = 400

        if(err === 401) response.message = 'The email or password didn\'t match'
      }
    } else {
      response.ok = 0
      response.code = 404
    }

    res.status(response.code).json(response)
  }

  async register(req: express.Request, res: express.Response) {
    let response: APIresponse = {
        code: 200,
        ok: 1
      },
      json = Object.assign({}, req.body)
    try {
      // hash password
      let salt = bcrypt.genSaltSync(10)
      json.password = bcrypt.hashSync(req.body.password, salt)
      // generate keycode
      json.keycode = json.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(new RegExp(' ', 'g'), '.').toLowerCase()
      // generate unique account id
      json.uid = crypto.randomBytes(20).toString('hex')

      let [sqlQuery, params] = sql.createSQLqueryFromJSON('INSERT', 'users', json)
      await this.database.query(sqlQuery, params)
    } catch (err) {
      response.ok = 0
      response.code = 400

      if(err.errno == 1062 && err.sqlState == 23000) {
        response.message = 'There is already an account using that email'
      }
    }

    res.status(response.code).json(response)
  }

  async resetPassword(req: express.Request, res: express.Response) {
    let response: APIresponse = {
      ok: 1,
      code: 200
    }

    if(req.body.token) {
      try {
        // verify if token is valid
        let [sqlQuery, params] = sql.createSQLqueryFromJSON('SELECT', 'passwordReset', { token: req.body.token })
        let result = (await this.database.query(sqlQuery, params))[0]
        if(!result.length) throw { APIerr: false, errorCode: 404, errorMessage: 'Token was not found or has already been used' }
        else result = result[0]

        let whereJson = { email: result.email }

        let [sqlQuery2, params2] = sql.createSQLqueryFromJSON('UPDATE', 'users', { password: req.body.password }, whereJson)
        result = (await this.database.query(sqlQuery2, params2))[0]
        if(!result.affectedRows) throw 404 

        sqlQuery = 'DELETE FROM passwordReset WHERE token = ?'
        params = [req.body.token];
        result = (await this.database.query(sqlQuery, params))[0]

        res.status(response.code).json(response)
      } catch (err) {
        response.ok = 0
        response.code = 400

        if(err == 403) {
          response.code = err
          response.message = 'Token is invalid'
        }

        res.status(response.code).json(response)
      }
    } else {
      // result = 1 means email was sent
      // result = 0 means email was NOT sent
      let result = await this.mail.sendPasswordReset(req.body.email)
      
      if(result != 0) {
        response.ok = 0
        response.code = 400
      }

      res.status(response.code).json(response)
    }
  }
  
  /**
   * @description changes account's email
   */
  async changeEmail(req: APIrequest, res: express.Response) {
    let response: APIresponse = {
      ok: 1,
      code: 200
    }

    if(req.body.token && req.body.email && process.env.CONNECT_PK) {
      try {
        // verify if token is valid by fetching it from the database
        let [rows] = (await this.database.query('SELECT * FROM emailChange WHERE token = ?', req.body.token))
        if (!rows.length) throw 403

        let params: string[] = [],
          sqlQuery: string = 'UPDATE users SET email = ? WHERE email = ?'
        
        params.push(req.body.email, rows[0].email)
        await this.database.query(sqlQuery, params)

        // if user is logged in refresh access token
        // clear access token otherwise
        jwt.verify(req.cookies['access_token'], process.env.CONNECT_PK, (err, decoded) => {
          if(decoded) {
            response.token = this.createToken({
              email: req.body.email,
              uid: decoded.uid
            }, decoded.aud)
  
            res.cookie('access_token', response.token, {maxAge: 86400 * 15, httpOnly: true})
          } else {
            // avoid cookie problems by deleting access_token cookie when it is not valid
            res.clearCookie('access_token')
          }
        })

        sqlQuery = 'DELETE FROM emailChange WHERE token = ?'
        params = [req.body.token];
        await this.database.query(sqlQuery, params)
      } catch (err) {
        response.ok = 0
        response.code = 400

        if(err == 403) {
          response.code = err
          response.message = 'Token is invalid'
        }
      }
    } else {
      try {
        if(req.body.email) {
          // result = 1 means email was sent
          // result = 0 means email was NOT sent
          let result = await this.mail.sendEmailChange(req.body.email)
          
          if(result != 0) throw result
        } else {
          throw 1
        }
      } catch(err) {
        response.ok = 0
        response.code = 400
      }
    }

    res.status(response.code).json(response)
  }
}