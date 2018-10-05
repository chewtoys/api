const mysql = require('mysql2');

class database {
  constructor(app) {
    let pool = mysql.createPool({
      host : process.env.DB_HOST,
      user : process.env.DB_USER,
      password : process.env.DB_PASSWORD,
      database : process.env.DB_NAME
    })

    pool.getConnection((err) => {
      if (!err) {
        app.get('logger').info('Connected to the database successfully.')
      } else {
        app.get('logger').error('Error connecting to the database.')
        setTimeout(() => {
          process.exit(1)
        }, 2500)
      }
    });
    
    this.pool = pool.promise()
  }

  /**
   * @returns {connectionPool}
   */
  getPool() {
    return this.pool;
  }
}

module.exports = database 