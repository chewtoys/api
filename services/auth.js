// get local (folder) environment variables
require('dotenv').config()

const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')

class Auth {
  constructor(app) {
    // inject independent services
    this.database = app.get('db').getPool()
    this.logger = app.get('logger')
    this.mailer = app.get('mailer')

    if(this.logger) this.logger.verbose('Auth service loaded')
  }

  verifyToken(req, res, next) {
    let authHeader = req.headers['authorization']

    try {
      if(!authHeader) throw 403;

      jwt.verify(authHeader.split('Bearer ')[1], process.env.CONNECT_PK)
      
      next()
    } catch (err) {
      let response = {
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

  createToken(user) {
    return jwt.sign(user, process.env.CONNECT_PK, {expiresIn: 86400 * 15, audience: 'user'})
  }

  async login(req, res) {
    let sql = 'SELECT * FROM users WHERE email = ?',
      response = {
        ok: 1,
        code: 200
      }
    
    this.database.getConnection((err, conn) => {
      conn.query(sql, req.body.email, (err, result) => {
        try {
          if (!result.length) throw 404

          if (bcrypt.compareSync(req.body.password, result[0].password)) {
            let token = this.createToken({ email: result[0].email })

            response.token = token
          } else {
            response.code = 0
            response.code = 401
            response.message = 'Wrong username/password'
          }

          res.status(response.code).json(response)
        } catch (err) {
          response.ok = 0;
          response.code = 400

          if (err == 404) {
            response.code = 404
          }

          res.status(response.code).json(response)
          return
        }
      })
    })
  }

  async resetPassword(req, res) {
    let response = {
      ok: 1,
      code: 200
    }

    if(req.body.token) {
      try {
        // verify if token is valid
        let result = (await this.database.query('SELECT COUNT(*) FROM resetPassword WHERE token = ?', req.body.token))[0]
        if (!result[0]['COUNT(*)']) throw 403
        
        let params = [],
          sql = 'UPDATE users SET password = ? WHERE email = ?'
        params.push(bcrypt.hashSync(req.body.password, bcrypt.genSaltSync(10)), req.body.email)
        result = (await this.database.query(sql, params))[0]

        sql = 'DELETE FROM resetPassword WHERE token = ?'
        params = [req.body.token];
        result = (await this.database.query(sql, params))[0]

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
      let result = await this.mailer.sendPasswordReset(req.body.email)
      
      if(result != 0) {
        response.ok = 0
        response.code = 400
      }

      res.status(response.code).json(response)
    }
  }
}

module.exports = Auth