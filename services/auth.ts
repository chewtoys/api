import '../env'

import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import * as express from 'express'
import * as jwt from 'jsonwebtoken'

import { sql } from '../utils'
import { logger } from '../utils'
import { database, analytics, mail, oauth } from '.'

export class AuthService {
  constructor() {
    logger.verbose('Auth service loaded')
  }

  public verifyToken(
    req: ApiRequest,
    res: express.Response,
    next: express.NextFunction
  ) {
    const token = req.cookies.access_token

    try {
      if (!token) throw 403

      let pk: string
      if (process.env.CONNECT_PK) pk = process.env.CONNECT_PK
      else throw 500

      const decoded = jwt.verify(token, pk)
      if (decoded instanceof Object) req.jwt = decoded

      next()
    } catch (err) {
      const response: ApiResponse = {
        code: 403,
        ok: 0,
        message: 'The JWT token is not valid',
      }

      if (err.name === 'TokenExpiredError') {
        response.code = 403
        response.message = 'Session expired'
      }

      res.status(response.code).json(response)
    }
  }

  public isMentor(
    req: ApiRequest,
    res: express.Response,
    next: express.NextFunction
  ) {
    if (req.jwt && req.jwt.aud === 'mentor') next()
    else {
      const response: ApiResponse = {
        code: 403,
        ok: 0,
        message: "You're not a mentor",
      }

      res.status(response.code).json(response)
    }
  }

  public createToken(user: JWTpayload, accountType): string {
    if (process.env.CONNECT_PK) {
      return jwt.sign(user, process.env.CONNECT_PK, {
        expiresIn: 86400 * 15,
        audience: accountType,
      })
    } else return ''
  }

  public async login(req: ApiRequest, res: express.Response) {
    let response: ApiResponse = {
      ok: 1,
      code: 200,
    }
    let error: APIerror

    try {
      if (!req.body || !req.body.email || !req.body.password) {
        error = {
          api: true,
          code: 400,
          message: 'Unsufficient fields to perform a register request',
          friendlyMessage: 'There is a field missing in the request.',
        }

        throw error
      }

      const sqlQuery = 'SELECT * FROM users WHERE email = ?'
      const user = await database.query(sqlQuery, [req.body.email])

      if (Object.keys(user).length) {
        if (bcrypt.compareSync(req.body.password, user.password)) {
          response.token = this.createToken(
            {
              email: user.email,
              uid: user.uid,
            },
            user.type
          )

          res.cookie('access_token', response.token, {
            expires: new Date(Date.now() + 86400 * 15e3),
            httpOnly: true,
          })

          analytics.userLogin(user)
        } else {
          error = {
            api: true,
            code: 401,
            message: 'Wrong credentials',
            friendlyMessage: "The password and password didn't match",
          }

          throw error
        }
      }
    } catch (err) {
      response = {
        ok: 0,
        code: 500,
      }

      if (err.api) {
        response.code = err.code
        response.message = err.message
        response.friendlyMessage = err.friendlyMessage
      }
    }

    res.status(response.code).json(response)
  }

  public logout(req: ApiRequest, res: express.Response) {
    let response: ApiResponse = {
      ok: 1,
      code: 200,
    }

    try {
      res.clearCookie('access_token')
    } catch (err) {
      response = {
        ok: 0,
        code: 500,
      }
    }

    res.status(response.code).json(response)
  }

  public async register(req: ApiRequest, res: express.Response) {
    // We wait 2 seconds for each register as a way to protect ourselves against
    // bruteforce attacks. Using extra time makes them virtually impossible.
    setTimeout(() => {
      const json = Object.assign({}, req.body)
      let response: ApiResponse = {
        code: 200,
        ok: 1,
      }
      let error: APIerror

      try {
        if (
          !json.email ||
          !json.password ||
          !json.name ||
          !json.developerPass ||
          !json.type
        ) {
          error = {
            api: true,
            code: 400,
            message: 'Unsufficient fields to perform a register request',
            friendlyMessage: 'There is a field missing in the request.',
          }

          throw error
        }

        if (json.developerPass !== process.env.SUPERSECRETDEVPASSWORD) {
          error = {
            api: true,
            code: 401,
            message: 'Wrong developer pass',
            friendlyMessage: 'Unauthorized access',
          }

          throw error
        }

        const removeKey = 'developerPass'
        delete json[removeKey]

        // hash password
        const salt = bcrypt.genSaltSync(10)
        json.password = bcrypt.hashSync(json.password, salt)
        // generate keycode
        json.keycode = json.name
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(new RegExp(' ', 'g'), '.')
          .toLowerCase()
        // generate unique account id
        json.uid = crypto.randomBytes(20).toString('hex')

        const [sqlQuery, params] = sql.createSQLqueryFromJSON(
          'INSERT',
          'users',
          json
        )
        database.query(sqlQuery, params)
      } catch (err) {
        response = {
          ok: 0,
          code: 500,
        }

        // check if it's a mysql error
        if (err.errno === 1062 && err.sqlState === '23000') {
          response.message = 'There is already an account using that email'
        }

        // check API errors
        if (err.api) {
          response.code = err.code
          ;(response.message = err.message),
            (response.friendlyMessage = err.friendlyMessage)
        }
      }

      res.status(response.code).json(response)
    }, 2000)
  }

  public async deleteAccount(req: ApiRequest, res: express.Response) {
    let response: ApiResponse = {
      ok: 1,
      code: 200,
    }

    try {
      if (!req.jwt || !req.jwt.uid || !req.body.password) throw { code: 403 }
      const user = await database.query(
        'SELECT password FROM users WHERE uid = ?',
        [req.jwt.uid]
      )
      if (!bcrypt.compareSync(req.body.password, user.password))
        throw { code: 403 }

      await database.query('DELETE FROM users where uid = ?', [req.jwt.uid])
    } catch (err) {
      response = {
        ok: 0,
        code: err.code || 500,
      }

      if (err.api) {
        response.code = err.code
        response.message = err.message
        response.friendlyMessage = err.friendlyMessage
      }
    }

    res.status(response.code).json(response)
  }

  public async resetPassword(req: ApiRequest, res: express.Response) {
    let response: ApiResponse = {
      ok: 1,
      code: 200,
    }
    let error: APIerror

    try {
      if (req.body.token) {
        let sqlQuery: string
        let params: string[]

          // verify if token is valid
        ;[sqlQuery, params] = sql.createSQLqueryFromJSON(
          'SELECT',
          'passwordReset',
          { token: req.body.token }
        )
        const passwordResetToken = await database.query(sqlQuery, params)
        if (!Object.keys(passwordResetToken).length) {
          error = {
            api: true,
            code: 404,
            message: 'Token not found',
            friendlyMessage:
              'The given token is invalid or has already been used.',
          }

          throw error
        }

        // create SQL query to set a new password
        ;[sqlQuery, params] = sql.createSQLqueryFromJSON(
          'UPDATE',
          'users',
          {
            password: req.body.password,
          },
          {
            email: passwordResetToken.email,
          }
        )

        const result = await database.query(sqlQuery, params)
        if (!result.affectedRows) {
          error = {
            api: true,
            code: 500,
            message: "Could not update user's password",
            friendlyMessage: "Could not update user's password",
          }

          throw error
        }
      } else {
        if (!req.body.email) {
          error = {
            api: true,
            code: 404,
            message: 'Email not found',
            friendlyMessage: 'The given email is not valid or unexistent',
          }
        } else {
          // result = 1 means email was sent
          // result = 0 means email was NOT sent
          const result = await mail.sendPasswordReset(req.body.email)

          if (result !== 0) {
            error = {
              api: true,
              code: 500,
              message: 'It was not possible to send the password reset email',
              friendlyMessage:
                'It was not possible to send the password reset email',
            }

            throw error
          }
        }
      }
    } catch (err) {
      response = {
        ok: 0,
        code: 500,
      }

      if (err.api) {
        response.code = err.code
        response.message = err.message
        response.friendlyMessage = err.friendlyMessage
      }
    }

    res.status(response.code).json(response)
  }

  /**
   * @description changes account's email
   */
  public async changeEmail(req: ApiRequest, res: express.Response) {
    let response: ApiResponse = {
      ok: 1,
      code: 200,
    }
    let error: APIerror

    if (req.body.token && req.body.email && process.env.CONNECT_PK) {
      try {
        // verify if token is valid by fetching it from the database
        const emailChangeRequest = await database.query(
          'SELECT * FROM emailChange WHERE token = ?',
          [req.body.token]
        )
        if (!emailChangeRequest) {
          error = {
            api: true,
            code: 404,
            message: 'Email change request not found',
            friendlyMessage: 'There is no email change request with this email',
          }

          throw error
        }

        let sqlQuery: string = 'UPDATE users SET email = ? WHERE email = ?'
        let params: string[] = [req.body.email, emailChangeRequest.email]
        await database.query(sqlQuery, params)

        // if user is logged in refresh access token
        // clear access token otherwise
        jwt.verify(
          req.cookies.access_token,
          process.env.CONNECT_PK,
          (err, decoded) => {
            if (decoded) {
              response.token = this.createToken(
                {
                  email: req.body.email,
                  uid: decoded.uid,
                },
                decoded.aud
              )

              res.cookie('access_token', response.token, {
                maxAge: 86400 * 15,
                httpOnly: true,
              })
            } else {
              // avoid cookie problems by deleting access_token cookie when it is not valid
              res.clearCookie('access_token')
            }
          }
        )

        sqlQuery = 'DELETE FROM emailChange WHERE token = ?'
        params = [req.body.token]
        await database.query(sqlQuery, params)
      } catch (err) {
        response = {
          ok: 0,
          code: 500,
        }

        if (err === 403) {
          response.code = err
          response.message = 'Token is invalid'
        }
      }
    } else {
      try {
        if (req.body.email) {
          // result = 1 means email was sent
          // result = 0 means email was NOT sent
          const result = await mail.sendEmailChange(req.body.email)

          if (result !== 0) throw result
        } else {
          throw 1
        }
      } catch (err) {
        response = {
          ok: 0,
          code: 500,
        }
      }
    }

    res.status(response.code).json(response)
  }

  public async getGoogleUrl(req: ApiRequest, res: express.Response) {
    let response: ApiResponse = {
      ok: 1,
      code: 200,
    }
    let error: APIerror

    try {
      const authorizeUrl = oauth.generateAuthUrl({
        access_type: 'offline',
        scope: 'profile email https://www.googleapis.com/auth/calendar',
        prompt: 'consent',
      })

      if (!authorizeUrl) {
        error = {
          api: true,
          code: 500,
          message: 'Error creating google sync URL',
          friendlyMessage:
            'There was a problem accesssing the Google OAuth URl',
        }
        throw error
      }

      response.url = authorizeUrl
    } catch (err) {
      response = {
        ok: 0,
        code: 500,
      }
    }

    res.status(response.code).json(response)
  }

  public async receiveOauthCode(req: ApiRequest, res: express.Response) {
    let response: ApiResponse = {
      ok: 1,
      code: 200,
    }
    let error: APIerror
    try {
      if (!req.query.code) {
        error = {
          api: true,
          code: 500,
          message: 'Needed parameter was missing from the request',
          friendlyMessage: "The parameter 'code' was missing in the query",
        }
        throw error
      }
      const tokens = (await oauth.getToken(req.query.code)).tokens

      if (!tokens || !tokens.access_token) {
        error = {
          api: true,
          code: 500,
          message:
            'Error parsing synchronization code from Google - access token and refresh token not generated',
          friendlyMessage:
            'We could not transform the Google code into an access token and refresh token',
        }
        throw error
      }

      response.token = tokens.access_token
      response.refreshToken = tokens.refresh_token as string
    } catch (err) {
      response = {
        ok: 0,
        code: 500,
      }
    }

    res.status(response.code).json(response)
  }

  public async unlinkGoogle(req: ApiRequest, res: express.Response) {
    let response: ApiResponse = {
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
          friendlyMessage: 'You are not logged in.',
        }

        throw error
      }

      let sqlQuery: string
      let params: string | string[]

        // fetch mentor info
      ;[sqlQuery, params] = sql.createSQLqueryFromJSON('SELECT', 'users', {
        uid: req.jwt.uid,
      })
      await database.query(sqlQuery, params)
    } catch (err) {
      response = {
        ok: 0,
        code: 500,
      }
    }

    res.status(response.code).json(response)
  }
}
