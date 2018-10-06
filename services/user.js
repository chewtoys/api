const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

class User {

  constructor(app) {
    this.database = app.get('db').getPool()
    this.logger = app.get('logger')

    if(this.logger) this.logger.verbose('User service loaded')
  }

  create(req, res) {
    let sql = 'INSERT INTO users (email, password, keycode, name) VALUES(?, ?, ?, ?)',
      response = {
        code: 200,
        ok: 1
      },
      params = []
    
    for(let param in req.body) {
      if(param !== 'password') params.push(req.body[param])
      else {
        // create password
        let salt = bcrypt.genSaltSync(10)
        let hash = bcrypt.hashSync(req.body[param], salt)

        params.push(hash)
      }
    }
    
    this.database.getConnection((err, conn) => {
      conn.query(sql, params, (err) => {
        if(err) {
          // duplicate entry
          if(err.errno === 1062) {
            response.code = 400;
            response.message = 'Cannot insert duplicate entry'
          }

          res.status(response.code).json(response)
          return
        }

        res.status(response.code).json(response)
      })
    })
  }

  get(req, res) {
    let sql = 'SELECT * FROM users WHERE email = ?',
      response = {
        code: 200,
        ok: 1
      },
      token = jwt.decode(req.headers['authorization'].split('Bearer ')[1])

    this.database.getConnection((err, conn) => {
      conn.query(sql, token.email, (err, result) => {
        if(err) res.status(500)

        response.user = result[0]
        res.status(response.code).send(response)
      })

      this.database.releaseConnection(conn)
    })
  }

  update(req, res) {
    let sql = 'UPDATE users SET',
      email = jwt.decode(req.headers['authorization'].split('Bearer ')[1]).email,
      response = {
        code: 200,
        ok: 1
      }

    for(let prop in req.body) {
      sql += ` ${prop}="${req.body[prop]}",`
    }
    sql = sql.slice(0, -1)
    
    // get email/uid from JWT token
    sql += ' WHERE email = ?'

    this.database.getConnection((err, conn) => {
      if(err) res.status(500)
      
      conn.query(sql, email, (err, result) => {
        if(err) res.status(500)
        
        if(result.changedRows) response.code = 202
        else response.code = 409

        res.status(response.code).send(response)
        this.database.releaseConnection(conn)
      })
    })
  }

}

module.exports = User;